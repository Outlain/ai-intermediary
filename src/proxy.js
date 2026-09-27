import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { BackendClient, BackendState, OperationGate, RECOVERY_REASONS } from './backend.js';
import { HostHelperClient } from './host-helper.js';
import { AutomaticRecovery } from './auto-recovery.js';
import { Classifier, classifyEndpoint, isSafeMetadataEndpoint, isStreaming } from './classifier.js';
import { copyRequestHeaders, copyResponseHeaders, readBody, ResponseOutcomeCollector, sendJson, streamBody } from './http-utils.js';
import { Logger, requestId } from './logger.js';
import { Metrics } from './metrics.js';
import {
  authorized, minimalRequestSummary, Observability, requestType, ResponseStatsCollector, safeDisplay,
  summarizeRequest,
} from './observability.js';
import { createJob, Scheduler } from './scheduler.js';
import { MaintenanceState, parsePauseDuration } from './maintenance.js';
import { WorkPolicy } from './work-policy.js';
import { parseListen } from './config.js';
import { DASHBOARD_CSS, DASHBOARD_HTML, DASHBOARD_JS } from './dashboard.js';
import { FrigateCatchup } from './frigate-catchup.js';
import { FrigateController } from './frigate-controller.js';
import { BUILD_INFO } from './build-info.js';
import { DEFERRAL_REASONS, contextOverflow, contextRequest, rescueHardwareBlock } from './context-rescue.js';
import { memoryBlock } from './memory-guard.js';
import { BackendRegistry } from './backend-registry.js';
import { MediaBroker } from './media-broker.js';
import { MediaGateway } from './media-gateway.js';

function contentHeaders(headers, body) {
  const result = { ...headers };
  result['content-length'] = String(body.length);
  delete result['transfer-encoding'];
  return result;
}

function parseJson(body) {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch (error) {
    const wrapped = new Error('invalid JSON request body');
    wrapped.statusCode = 400;
    throw wrapped;
  }
}

function applyKeepAlive(pathname, parsed, policy) {
  if (!policy?.keep_alive || pathname.startsWith('/v1/')) return { parsed, changed: false };
  // Explicit unload directives must not become load/retention requests simply
  // because the client has an idle-hold policy. Other requests retain the
  // administrator's configured retention policy.
  if (parsed.keep_alive === 0 || /^0(?:ms|s|m|h)?$/.test(String(parsed.keep_alive))) return { parsed, changed: false };
  if (parsed.keep_alive === policy.keep_alive) return { parsed, changed: false };
  return { parsed: { ...parsed, keep_alive: policy.keep_alive }, changed: true };
}

async function waitWithTimeout(promise, timeoutMs) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class ProxyService {
  constructor(config, options = {}) {
    this.config = config;
    this.clock = options.clock ?? (() => Date.now());
    this.logger = options.logger ?? new Logger();
    this.settingsController = options.settingsController ?? null;
    this.settingsRestartPending = false;
    this.reservedBodyBytes = 0;
    this.incomingRequests = 0;
    this.metrics = options.metrics ?? new Metrics();
    this.observability = options.observability ?? new Observability(config, { clock: this.clock });
    this.classifier = new Classifier(config);
    this.registry = new BackendRegistry(config);
    this.workPolicy = new WorkPolicy(config, { clock: this.clock });
    this.scheduler = new Scheduler(config, {
      logger: this.logger,
      metrics: this.metrics,
      observability: this.observability,
      clock: this.clock,
      pauseCheck: (client, traffic) => this.workPolicy.block(client, traffic)
        ?? (this.releasePaused ? { reason: 'maintenance_paused' } : null),
    });
    this.backendClient = new BackendClient(config);
    this.gate = new OperationGate(() => this.scheduler.wake());
    this.backend = new BackendState(config, {
      logger: this.logger,
      metrics: this.metrics,
      onModel: (model) => this.scheduler.reconcile(model),
      onChange: () => {
        this.scheduler.wake();
        this.recordBackendTransition();
        if (this.releasePaused) this.kickMaintenanceQuiescence();
      },
      clock: this.clock,
    });
    this.backendSignature = null;
    this.backendObservation = null;
    this.servers = [];
    this.listenerFailures = [];
    this.sequence = 0;
    this.workerController = new AbortController();
    this.running = false;
    this.workerPromise = null;
    this.expiryTimer = null;
    this.eventStreams = new Set();
    this.maintenanceTask = null;
    this.maintenanceRetryTimer = null;
    this.maintenance = options.maintenance ?? new MaintenanceState(config, {
      clock: this.clock,
      logger: this.logger,
      onChange: () => this.scheduler.wake(),
      onAutoResume: () => this.resumeMaintenance('timer'),
    });
    if (this.maintenance.paused) this.scheduler.pause();
    this.scheduledMaintenance = new MaintenanceState({ ...config, maintenance: {
      ...config.maintenance, enabled: true, state_path: `${config.maintenance.state_path}.scheduled`,
    } }, { clock: this.clock, logger: this.logger, onChange: () => this.scheduler.wake() });
    const service = this;
    const recoveryPause = {
      get paused() { return service.releasePaused; },
      get revision() { return `${service.maintenance.revision}:${service.scheduledMaintenance.revision}`; },
    };
    this.catchup = options.catchup ?? new FrigateCatchup(config, {
      logger: this.logger,
      clock: this.clock,
      canRun: () => this.backgroundReadiness(),
      onChange: () => this.scheduler.wake(),
    });
    this.frigateController = new FrigateController({
      catchup: this.catchup,
      readToken: config.observability.auth_token,
      controlToken: config.security?.admin_token || options.settingsToken || this.settingsController?.token || '',
    });
    this.hostHelper = options.hostHelper ?? new HostHelperClient(config, {
      clock: this.clock, onChange: () => this.scheduler.wake(),
    });
    this.automaticRecovery = new AutomaticRecovery(config, {
      clock: this.clock, helper: this.hostHelper, backend: this.backend, backendClient: this.backendClient,
      gate: this.gate, scheduler: this.scheduler, catchup: this.catchup, maintenance: recoveryPause,
      isStopping: () => !this.running || this.settingsRestartPending,
      mediaBlocked: () => Boolean(this.media?.blocked),
      onChange: () => this.scheduler.wake(),
      onEvent: (event, fields) => this.observability.record(event, fields),
    });
    this.media = new MediaBroker(this, options.media || {});
    this.mediaGateway = new MediaGateway(this);
  }

  async start({ listen = true } = {}) {
    if (this.running) return this.addresses();
    this.running = true;
    await this.media.init();
    await this.syncWorkPolicy();
    this.backend.start();
    this.catchup.start();
    if (this.catchup.requiresRecovery) {
      this.backend.requireRecovery('A restored catch-up inference has unknown completion; verify Ollama and GPU idle state before resuming', { code: 'restored_attempt_uncertain' });
    }
    this.hostHelper.start();
    this.automaticRecovery.start();
    this.workerPromise = this.dispatchLoop();
    this.expiryTimer = setInterval(() => {
      this.scheduler.enforcePauses();
      void this.syncWorkPolicy();
    }, Math.min(1_000, this.config.ollama.healthIntervalMs));
    this.expiryTimer.unref?.();
    if (this.maintenance.paused) {
      this.observability.record('maintenance_pause_restored', this.maintenance.status());
      this.kickMaintenanceQuiescence();
    }
    if (listen) {
      await this.startServer(this.config.server.listen, null);
      for (const listener of this.config.server.dedicated_listeners) {
        if (!this.config.clients[listener.client]) throw new Error(`dedicated listener references unknown client ${listener.client}`);
        await this.startServer(listener.listen, listener.client);
      }
      for (const [client, policy] of Object.entries(this.config.clients)) {
        if (!policy.listener_port) continue;
        try { await this.startServer(`0.0.0.0:${policy.listener_port}`, client); }
        catch (error) {
          if (!['EADDRINUSE', 'EACCES', 'EPERM'].includes(error.code)) throw error;
          // Keep the main settings listener reachable so an optional port can
          // be repaired instead of trapping the service in a restart loop.
          this.listenerFailures.push({ port: policy.listener_port, source: client, state: 'unavailable', reason: error.code, publication: 'unverified' });
          this.logger.error('source listener unavailable; correct its port in Settings', { client, port: policy.listener_port, code: error.code });
          this.observability.record('source_listener_failed', { client, port: policy.listener_port, reason: error.code });
        }
      }
    }
    return this.addresses();
  }

  async startServer(listen, forcedClient) {
    const { host, port } = parseListen(listen);
    const server = http.createServer((request, response) => {
      this.handle(request, response, forcedClient).catch((error) => {
        this.logger.error('unhandled proxy request error', { error: error.stack ?? error.message });
        sendJson(response, error.statusCode ?? 500, { error: error.message, code: 'proxy_error' }, requestId(request.headers));
      });
    });
    server.requestTimeout = 0;
    server.headersTimeout = Math.max(60_000, this.config.ollama.requestTimeoutMs + 10_000);
    server.keepAliveTimeout = 65_000;
    server.on('upgrade', (request, socket, head) => this.mediaGateway.upgrade(request, socket, head, forcedClient));
    server.listen(port, host);
    await once(server, 'listening');
    this.servers.push({ server, forcedClient });
    const address = server.address();
    this.logger.info('proxy listener started', { address, forced_client: forcedClient });
  }

  addresses() {
    return this.servers.map(({ server, forcedClient }) => ({ address: server.address(), forcedClient }));
  }

  get releasePaused() {
    return Boolean(this.maintenance?.paused || this.scheduledMaintenance?.paused || this.workPolicy.releaseRequested());
  }

  get releaseState() { return this.maintenance.paused ? this.maintenance : this.scheduledMaintenance; }

  async syncWorkPolicy() {
    if (this.policySync) return this.policySync;
    this.policySync = (async () => {
      const requested = this.workPolicy.releaseRequested();
      if (requested && !this.scheduledMaintenance.paused) {
        await this.scheduledMaintenance.begin({ reason: 'Scheduled GPU reservation' });
      } else if (!requested && this.scheduledMaintenance.paused) {
        // Let any bounded model unload finish instead of aborting it at the
        // window boundary and losing proof that it stopped.
        await this.maintenanceTask;
        if (!this.running) return;
        await this.scheduledMaintenance.resume('schedule_ended');
      }
      this.scheduler.enforcePauses();
      if (this.releasePaused) this.kickMaintenanceQuiescence();
    })().catch((error) => {
      this.workPolicy.error = 'Scheduled pause state could not be persisted; admission is blocked.';
      this.scheduler.enforcePauses();
      this.logger.error('scheduled pause failed closed', { error: error.message });
    }).finally(() => { this.policySync = null; });
    return this.policySync;
  }

  async handle(request, response, forcedClient = null) {
    const id = requestId(request.headers);
    response.setHeader('x-request-id', id);
    const url = new URL(request.url, 'http://proxy.local');
    if (this.mediaGateway.handles(url, forcedClient)) {
      return this.withBodyBudget(request, response, id,
        () => this.mediaGateway.handle(request, response, url, id, forcedClient));
    }
    if (this.settingsController?.handles(url.pathname)) {
      return this.settingsController.handle(request, response, url, id);
    }
    if (this.frigateController.handles(url.pathname)) {
      if (this.settingsRestartPending && request.method !== 'GET' && url.pathname !== '/_intermediary/v1/frigate/attempt') {
        return sendJson(response, 503, { error: 'Settings restart pending.' }, id);
      }
      return this.frigateController.handle(request, response, url, id);
    }
    if (url.pathname === '/_intermediary/v1/recovery/acknowledge') {
      return this.handleRecoveryAcknowledgment(request, response, id);
    }
    if (url.pathname === '/_intermediary/v1/recovery/check') {
      return this.handleRecoveryCheck(request, response, id);
    }
    if ((url.pathname === '/debug' || url.pathname === '/debug/') && request.method !== 'GET') {
      response.setHeader('allow', 'GET');
      return sendJson(response, 405, { error: 'debug dashboard only supports GET', code: 'method_not_allowed' }, id);
    }
    if (request.method === 'GET' && (url.pathname === '/debug' || url.pathname === '/debug/')) {
      return this.handleDashboard(response, id);
    }
    if (request.method === 'GET' && url.pathname === '/_intermediary/ui/dashboard.css') {
      return this.handleDashboardAsset(response, id, 'text/css; charset=utf-8', DASHBOARD_CSS);
    }
    if (request.method === 'GET' && url.pathname === '/_intermediary/ui/dashboard.js') {
      return this.handleDashboardAsset(response, id, 'text/javascript; charset=utf-8', DASHBOARD_JS);
    }
    if (url.pathname.startsWith('/_intermediary/v1/maintenance/')) {
      return this.handleMaintenanceControl(request, response, url, id);
    }
    if (url.pathname.startsWith('/_intermediary/')) return this.handleObservability(request, response, url, id);
    if (request.method === 'GET' && url.pathname === this.config.server.status_path) {
      if (!this.authorizeDiagnostics(request, response, id)) return;
      return this.handleStatus(response, id);
    }
    if (request.method === 'GET' && url.pathname === this.config.server.metrics_path) {
      if (!this.authorizeDiagnostics(request, response, id)) return;
      return this.handleMetrics(response);
    }
    if (request.method === 'GET' && url.pathname === '/healthz') return sendJson(response, 200, { status: 'ok' }, id);
    if (request.method === 'GET' && url.pathname === '/readyz') {
      const ready = !this.settingsRestartPending && !this.releasePaused && !this.workPolicy.error && !this.media.blocked && this.backend.canDispatch()
        && Object.keys(this.config.clients).some((client) => !this.scheduler.pauseReason({ client, trafficClass: 'live' }));
      const permitted = authorized(request, this.config.observability.auth_token);
      const snapshot = permitted ? this.observabilitySnapshot() : null;
      return sendJson(response, ready ? 200 : 503, {
        status: ready ? 'ready' : 'not_ready',
        ...(permitted ? { backend: snapshot.backend, maintenance: snapshot.maintenance } : {}),
      }, id);
    }

    const endpointClass = classifyEndpoint(request.method, url.pathname);
    if (this.settingsRestartPending && endpointClass !== 'metadata') {
      return sendJson(response, 503, {
        error: 'The intermediary is draining active work before applying validated settings.',
        code: 'settings_restart_pending',
      }, id);
    }
    if (endpointClass === 'generation') return this.withBodyBudget(request, response, id, () => this.handleGeneration(request, response, url, id, forcedClient));
    if (endpointClass === 'management') return this.withBodyBudget(request, response, id, () => this.handleManagement(request, response, url, id));
    if (this.releasePaused && !isSafeMetadataEndpoint(request.method, url.pathname)) {
      return this.sendMaintenancePaused(response, id);
    }
    if (endpointClass !== 'metadata') {
      return sendJson(response, 404, { error: 'Unsupported Ollama endpoint; it cannot bypass GPU scheduling', code: 'unsupported_endpoint' }, id);
    }
    return this.withBodyBudget(request, response, id, () => this.handlePassthrough(request, response, url, id));
  }

  async withBodyBudget(request, response, id, operation) {
    const length = request.headers['content-length'];
    const bytes = length !== undefined ? Number(length)
      : request.headers['transfer-encoding'] ? this.config.server.body_limit_bytes : 0;
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.config.server.body_limit_bytes) {
      return sendJson(response, 413, { error: 'Request body exceeds the configured limit.', code: 'body_limit' }, id);
    }
    if (this.reservedBodyBytes + bytes > this.config.scheduler.max_queue_bytes) {
      return sendJson(response, 429, { error: 'Request memory budget is full; retry later.', code: 'request_memory_full' }, id);
    }
    // Reserve before buffering, including chunked bodies. Keep the reservation
    // through the full queued/active/draining lifetime, not only admission.
    this.reservedBodyBytes += bytes;
    const reservation = { bytes };
    request.bodyReservation = reservation;
    this.incomingRequests += 1;
    try { return await operation(); }
    finally { this.reservedBodyBytes -= reservation.bytes; this.incomingRequests -= 1; this.scheduler.wake(); }
  }

  backgroundReadiness() {
    const readiness = this.scheduler.backgroundReadiness();
    if (!this.running || this.settingsRestartPending) return { allowed: false, reason: 'service_stopping' };
    if (this.incomingRequests) return { allowed: false, reason: 'live_requests_pending' };
    if (this.releasePaused) return { allowed: false, reason: 'maintenance_paused' };
    if (this.media.blocked) return { allowed: false, reason: 'media_recovery_required' };
    if (!this.backend.canDispatch()) return { allowed: false, reason: this.backend.recoveryRequired ? 'recovery_required' : 'backend_unavailable' };
    if (this.gate.active || this.gate.managementPending || this.gate.maintenancePending) return { allowed: false, reason: 'backend_operation' };
    const memoryReason = this.config.host_helper.enabled
      ? memoryBlock(this.hostHelper.snapshot(), this.config.host_helper.memory_guard) : null;
    if (memoryReason) return { allowed: false, reason: memoryReason };
    return { allowed: readiness.ready, reason: readiness.reason, wait_seconds: readiness.wait_seconds };
  }

  async handleRecoveryCheck(request, response, id) {
    response.setHeader('cache-control', 'no-store');
    const token = this.config.maintenance.auth_token;
    if (!token) return sendJson(response, 503, { error: 'Configure ADMIN_TOKEN to use recovery controls.' }, id);
    if (!authorized(request, token)) return sendJson(response, 401, { error: 'Administrator password required.' }, id);
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      return sendJson(response, 405, { error: 'Use POST.' }, id);
    }
    if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      return sendJson(response, 415, { error: 'Use application/json.' }, id);
    }
    let body;
    try { body = JSON.parse((await readBody(request, 4096)).toString('utf8')); }
    catch { return sendJson(response, 400, { error: 'Provide a JSON confirmation.' }, id); }
    if (body?.confirm !== true) return sendJson(response, 400, { error: 'Set confirm:true. Recovery may restart only Ollama.' }, id);
    if (this.settingsRestartPending || !this.running) return sendJson(response, 409, { error: 'The intermediary is stopping.' }, id);
    try {
      const recovery = this.automaticRecovery.checkNow();
      return sendJson(response, 202, { accepted: true, recovery,
        message: 'Recovery check scheduled. It may restart Ollama; manual pauses remain unchanged.' }, id);
    } catch (error) {
      const codes = new Set(['automatic_recovery_disabled', 'automatic_recovery_state_unreadable', 'automatic_recovery_state_unwritable']);
      const code = codes.has(error.code) ? error.code : 'recovery_unavailable';
      return sendJson(response, code === 'automatic_recovery_disabled' ? 409 : 503,
        { error: 'Enable and configure host-assisted recovery, or resolve its state error first.', code }, id);
    }
  }

  async handleRecoveryAcknowledgment(request, response, id) {
    response.setHeader('cache-control', 'no-store');
    const token = this.config.maintenance.auth_token;
    if (!token) return sendJson(response, 503, { error: 'Configure ADMIN_TOKEN before acknowledging recovery.' }, id);
    if (!authorized(request, token)) return sendJson(response, 401, { error: 'Administrator password required.' }, id);
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      return sendJson(response, 405, { error: 'Use POST.' }, id);
    }
    let body;
    try { body = JSON.parse((await readBody(request, 4096)).toString('utf8')); }
    catch { return sendJson(response, 400, { error: 'Provide a JSON confirmation.' }, id); }
    if (body?.confirm_gpu_recovered !== true) {
      return sendJson(response, 400, { error: 'Verify the real GPU on the host, then set confirm_gpu_recovered:true. API health alone is insufficient.' }, id);
    }
    if (!this.maintenance.paused) return sendJson(response, 409, { error: 'Pause inference before acknowledging GPU recovery.', code: 'pause_required' }, id);
    if (this.settingsRestartPending || this.scheduler.active || this.gate.active) {
      return sendJson(response, 409, { error: 'Wait for active work and maintenance operations to finish.', code: 'busy' }, id);
    }
    const pauseRevision = this.maintenance.revision;
    const release = await this.gate.acquire('maintenance', this.workerController.signal);
    try {
      const models = await this.backendClient.loadedModels(this.workerController.signal, this.config.ollama.healthTimeoutMs);
      if (this.media.blocked) return sendJson(response, 409, { error: 'Resolve media recovery separately; an Ollama acknowledgment cannot clear ComfyUI work.', code: 'media_recovery_required' }, id);
      if (models.length) return sendJson(response, 409, { error: 'Ollama still reports loaded models. Recovery was not cleared.', code: 'models_loaded' }, id);
      if (!this.maintenance.paused || this.maintenance.revision !== pauseRevision || this.settingsRestartPending) {
        return sendJson(response, 409, { error: 'Pause or settings state changed during verification. Recovery was not cleared; pause and verify again.', code: 'recovery_state_changed' }, id);
      }
      if (this.catchup.requiresRecovery) this.catchup.acknowledgeRecovery();
      this.backend.clearRecovery();
      this.scheduler.reconcile(null);
      this.observability.record('gpu_recovery_acknowledged', { reason: 'operator_verified_gpu_and_empty_ollama' });
      return sendJson(response, 200, { acknowledged: true, paused: true, message: 'Recovery latch cleared. Inference remains paused until resumed.' }, id);
    } catch {
      return sendJson(response, 503, { error: 'Recovery verification or persistence failed. The latch remains set.', code: 'recovery_verification_failed' }, id);
    } finally { release(); }
  }

  handleStatus(response, id) {
    const scheduler = this.scheduler.status();
    const snapshot = this.observabilitySnapshot();
    sendJson(response, 200, { build: BUILD_INFO, backend: snapshot.backend, maintenance: snapshot.maintenance, frigate: snapshot.frigate, ...scheduler }, id);
  }

  authorizeDiagnostics(request, response, id) {
    response.setHeader('cache-control', 'no-store');
    if (authorized(request, this.config.observability.auth_token)) return true;
    response.setHeader('www-authenticate', 'Bearer realm="ai-intermediary"');
    sendJson(response, 401, { error: 'Administrator password required.', code: 'unauthorized' }, id);
    return false;
  }

  recordBackendTransition() {
    if (!this.backend) return;
    const status = this.backend.status(this.clock());
    const signature = JSON.stringify({
      state: status.state,
      reachable: status.reachable,
      recovery_required: status.recovery_required,
      circuit_open: status.circuit_open,
      loaded_models: status.loaded_models,
    });
    if (signature === this.backendSignature) return;
    const previous = this.backendObservation;
    this.backendSignature = signature;
    this.backendObservation = {
      state: status.state,
      reachable: status.reachable,
      recovery_required: status.recovery_required,
      circuit_open: status.circuit_open,
    };
    if (status.recovery_required && !previous?.recovery_required) {
      this.observability.record('gpu_recovery_required', {
        state: status.state,
        reason: RECOVERY_REASONS[status.recovery_code] ?? RECOVERY_REASONS.unknown,
        recovery_code: status.recovery_code,
      });
    }
    if (status.circuit_open && !previous?.circuit_open) {
      this.observability.record('circuit_opened', { state: status.state });
    } else if (!status.circuit_open && previous?.circuit_open) {
      this.observability.record('circuit_closed', { state: status.state });
    }
    this.observability.record('backend_state_changed', {
      state: status.state,
      reachable: status.reachable,
      recovery_required: status.recovery_required,
      circuit_open: status.circuit_open,
      loaded_models: status.loaded_models,
    });
  }

  observabilitySnapshot(now = this.clock()) {
    const backendRaw = this.backend.status(now);
    const backend = {
      ...backendRaw,
      recovery_reason: backendRaw.recovery_required
        ? `${RECOVERY_REASONS[backendRaw.recovery_code] ?? RECOVERY_REASONS.unknown} Host recovery verification is required.`
        : null,
      last_error: backendRaw.last_error ? 'Ollama backend error; inspect intermediary logs for details.' : null,
      last_inference_error: backendRaw.last_inference_error ? 'Ollama inference failed; inspect intermediary logs for details.' : null,
      recovery_storage_error: backendRaw.recovery_storage_error ? 'GPU recovery state could not be persisted or read; inspect intermediary logs.' : null,
    };
    const scheduler = this.scheduler.details(now);
    const { service: hostService, bound: hostBound, restart_policy: hostPolicy, ...hostGpu } = this.hostHelper.snapshot();
    const maintenance = this.maintenance.status(now);
    const allSourcesPaused = Object.keys(this.config.clients).every((client) => this.scheduler.pauseReason({ client, trafficClass: 'live' }));
    const ready = !this.releasePaused && !this.workPolicy.error && !allSourcesPaused && scheduler.accepting && !this.media.blocked && this.backend.canDispatch(now);
    let schedulerState = 'idle';
    if (!scheduler.accepting) schedulerState = 'shutting_down';
    if (maintenance.paused) schedulerState = `maintenance_${maintenance.state}`;
    else if (backend.recovery_required) schedulerState = 'recovery_required';
    else if (this.media.blocked) schedulerState = 'media_recovery_required';
    else if (!backend.reachable || backend.circuit_open) schedulerState = 'unavailable';
    else if (scheduler.upstream_draining) schedulerState = 'draining';
    else if (scheduler.active_request) schedulerState = 'busy';
    else if (scheduler.queue.total) schedulerState = 'queued';
    else if (this.releasePaused || allSourcesPaused) schedulerState = 'source_paused';
    return {
      schema_version: 1,
      build: BUILD_INFO,
      generated_at: new Date(now).toISOString(),
      service: {
        state: ready ? 'ready' : 'not_ready',
        ready,
        instance_id: this.observability.instanceId,
        uptime_seconds: this.observability.uptimeSeconds(now),
        accepting: scheduler.accepting,
        event_clients: this.observability.listeners.size,
      },
      backend,
      authentication: { mode: this.config.security?.auth_mode || 'legacy' },
      backends: this.registry.snapshot(),
      media: this.media.snapshot(),
      host_gpu: hostGpu,
      recovery: this.automaticRecovery.status(),
      maintenance,
      work_policy: this.workPolicy.status(now),
      scheduled_maintenance: this.scheduledMaintenance.status(now),
      listeners: [...this.addresses().map(({ address, forcedClient }) => ({ port: address?.port, source: forcedClient, state: 'listening', publication: 'unverified' })), ...this.listenerFailures],
      frigate: this.catchup.status(),
      scheduler: {
        state: schedulerState,
        mode: this.config.scheduler.mode,
        reserved_body_bytes: this.reservedBodyBytes,
        background: this.backgroundReadiness(),
        current_model: scheduler.current_model,
        current_model_group: scheduler.current_model_group,
        model_lease_remaining: scheduler.model_lease_remaining,
        model_switches: scheduler.model_switches,
        upstream_draining: scheduler.upstream_draining,
        last_activity: scheduler.last_activity,
        management_pending: this.gate.managementPending,
        management_active: this.gate.managementActive,
      },
      active_request: scheduler.active_request,
      queue: scheduler.queue,
      recent_events: this.observability.recent(),
    };
  }

  handleDashboard(response, id) {
    if (!this.config.observability.enabled || !this.config.observability.ui_enabled) {
      return sendJson(response, 404, { error: 'debug dashboard is disabled', code: 'not_found' }, id);
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(DASHBOARD_HTML),
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'x-request-id': id,
    });
    response.end(DASHBOARD_HTML);
  }

  handleDashboardAsset(response, id, contentType, body) {
    if (!this.config.observability.enabled || !this.config.observability.ui_enabled) {
      return sendJson(response, 404, { error: 'debug dashboard is disabled', code: 'not_found' }, id);
    }
    response.writeHead(200, {
      'content-type': contentType,
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-request-id': id,
    });
    response.end(body);
  }

  handleObservability(request, response, url, id) {
    if (!this.config.observability.enabled) {
      return sendJson(response, 404, { error: 'observability API is disabled', code: 'not_found' }, id);
    }
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    if (!authorized(request, this.config.observability.auth_token)) {
      response.setHeader('www-authenticate', 'Bearer realm="ai-intermediary"');
      return sendJson(response, 401, { error: 'Administrator password required.', code: 'unauthorized' }, id);
    }
    if (request.method !== 'GET') {
      response.setHeader('allow', 'GET');
      return sendJson(response, 405, { error: 'observability endpoints only support GET', code: 'method_not_allowed' }, id);
    }
    if (request.method === 'GET' && url.pathname === '/_intermediary/v1/status') {
      return sendJson(response, 200, this.observabilitySnapshot(), id);
    }
    if (request.method === 'GET' && url.pathname === '/_intermediary/v1/history') {
      const requested = Number(url.searchParams.get('limit') ?? this.config.observability.history_limit);
      const limit = Number.isInteger(requested) && requested > 0
        ? Math.min(requested, this.config.observability.history_limit)
        : this.config.observability.history_limit;
      return sendJson(response, 200, {
        schema_version: 1,
        generated_at: new Date(this.clock()).toISOString(),
        events: this.observability.recent(limit),
      }, id);
    }
    if (request.method === 'GET' && url.pathname === '/_intermediary/v1/events') {
      return this.handleEventStream(request, response, id);
    }
    return sendJson(response, 404, { error: 'observability endpoint not found', code: 'not_found' }, id);
  }

  async handleMaintenanceControl(request, response, url, id) {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    if (!this.config.maintenance.enabled) {
      return sendJson(response, 404, { error: 'maintenance controls are disabled', code: 'not_found' }, id);
    }
    if (!this.config.maintenance.auth_token) {
      return sendJson(response, 503, {
        error: 'Configure ADMIN_TOKEN before using state-changing maintenance controls.',
        code: 'maintenance_auth_not_configured',
      }, id);
    }
    if (!authorized(request, this.config.maintenance.auth_token)) {
      response.setHeader('www-authenticate', 'Bearer realm="ai-intermediary-maintenance"');
      return sendJson(response, 401, { error: 'Administrator password required.', code: 'unauthorized' }, id);
    }
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      return sendJson(response, 405, { error: 'maintenance controls only support POST', code: 'method_not_allowed' }, id);
    }

    if (['/_intermediary/v1/maintenance/scopes/pause', '/_intermediary/v1/maintenance/scopes/resume'].includes(url.pathname)) {
      try {
        const body = parseJson(await readBody(request, 4_096));
        if (url.pathname.endsWith('/pause')) {
          const duration = parsePauseDuration(body.duration, this.config.maintenance.maxPauseMs);
          this.workPolicy.pause({ sources: body.sources, traffic: body.traffic, until: duration === null ? null : this.clock() + duration });
        } else {
          if (typeof body.id !== 'string' || !this.workPolicy.manual.some((item) => item.id === body.id)) {
            return sendJson(response, 404, { error: 'Scoped pause not found.' }, id);
          }
          this.workPolicy.resume(body.id);
        }
        this.scheduler.enforcePauses();
        this.observability.record('source_pause_changed', {});
        return sendJson(response, 200, { work_policy: this.workPolicy.status() }, id);
      } catch (error) {
        return sendJson(response, this.workPolicy.error ? 503 : 400, { error: this.workPolicy.error ?? error.message }, id);
      }
    }
    if (url.pathname === '/_intermediary/v1/maintenance/pause') {
      let body;
      try {
        const raw = await readBody(request, 4_096);
        body = raw.length ? parseJson(raw) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          const error = new Error('maintenance pause body must be a JSON object');
          error.statusCode = 400;
          throw error;
        }
        const status = await this.pauseMaintenance({ duration: body.duration, reason: body.reason }, 'api');
        return sendJson(response, 202, { maintenance: status }, id);
      } catch (error) {
        return sendJson(response, error.statusCode ?? 500, {
          error: error.statusCode ? error.message : 'maintenance pause could not be persisted',
          code: error.statusCode ? 'invalid_maintenance_request' : 'maintenance_state_error',
        }, id);
      }
    }
    if (url.pathname === '/_intermediary/v1/maintenance/resume') {
      try {
        const status = await this.resumeMaintenance('api');
        return sendJson(response, 200, { maintenance: status }, id);
      } catch (error) {
        return sendJson(response, 500, {
          error: 'maintenance resume could not be persisted; inference remains paused',
          code: 'maintenance_state_error',
        }, id);
      }
    }
    return sendJson(response, 404, { error: 'maintenance endpoint not found', code: 'not_found' }, id);
  }

  sendMaintenancePaused(response, id) {
    const maintenance = this.releaseState.status();
    if (maintenance.remaining_seconds !== null) {
      response.setHeader('retry-after', String(Math.max(1, Math.ceil(maintenance.remaining_seconds))));
    }
    return sendJson(response, 503, {
      error: 'Ollama inference is paused for exclusive GPU maintenance',
      code: 'maintenance_paused',
      state: maintenance.state,
      reason: maintenance.reason,
      resume_at: maintenance.resume_at,
      remaining_seconds: maintenance.remaining_seconds,
      gpu_released: maintenance.gpu_released,
    }, id);
  }

  async pauseMaintenance(options = {}, source = 'api') {
    let admission = { changed: false, queuedDropped: 0 };
    const result = await this.maintenance.begin(options, {
      onPersisted: () => { admission = this.scheduler.pause(); },
    });
    this.metrics.increment('proxy_maintenance_pauses_total', { source });
    this.logger.warn('maintenance pause requested; inference admission stopped', {
      source,
      reason: result.status.reason,
      duration_seconds: result.status.remaining_seconds,
      queued_requests_failed: admission.queuedDropped,
      active_request_draining: Boolean(this.scheduler.active),
    });
    this.observability.record('maintenance_pause_requested', {
      source,
      reason: result.status.reason,
      timed: options.duration !== undefined && options.duration !== null && options.duration !== '',
      queued_requests_failed: admission.queuedDropped,
      active_request_draining: Boolean(this.scheduler.active),
    });
    this.kickMaintenanceQuiescence();
    return result.status;
  }

  async resumeMaintenance(source = 'manual') {
    const previous = this.maintenance.status();
    const result = await this.maintenance.resume(source);
    this.clearMaintenanceRetry();
    this.scheduler.resume();
    if (result.changed) {
      this.metrics.increment('proxy_maintenance_resumes_total', { source });
      this.logger.info('maintenance pause ended; inference admission resumed', { source });
      this.observability.record('maintenance_resumed', {
        source,
        paused_seconds: previous.requested_at
          ? Math.max(0, this.clock() - Date.parse(previous.requested_at)) / 1000
          : null,
      });
    }
    return result.status;
  }

  kickMaintenanceQuiescence() {
    if (!this.running || !this.releasePaused || this.maintenanceTask) return;
    const state = this.releaseState;
    if (!state?.paused) return;
    const status = state.status();
    if (status.gpu_released && this.backend.loadedModels.length === 0) return;
    const revision = state.currentRevision;
    const signal = state.signal;
    this.maintenanceTask = this.runMaintenanceQuiescence(revision, signal, state)
      .catch((error) => {
        if (!signal?.aborted) this.logger.error('maintenance GPU release task failed', { error: error.message });
      })
      .finally(() => {
        this.maintenanceTask = null;
        const latest = this.releaseState.status();
        if (this.running && latest.paused && !latest.gpu_released) this.scheduleMaintenanceRetry();
      });
  }

  async runMaintenanceQuiescence(revision, signal, state = this.maintenance) {
    let release;
    try {
      await state.markReleasing(revision);
      if (signal?.aborted || !state.paused || revision !== state.currentRevision) return;
      const active = this.scheduler.active;
      if (active) {
        this.logger.warn('maintenance pause is waiting for the active Ollama request to drain', {
          request_id: active.id,
          detected_client: active.client,
          requested_model: active.model,
        });
        this.observability.record('maintenance_waiting_for_active_request', this.scheduler.eventFields(active));
        while (this.scheduler.active === active && !signal?.aborted) {
          await this.scheduler.waitForChange(100, signal);
        }
      }
      if (signal?.aborted || !state.paused || revision !== state.currentRevision) return;

      release = await this.gate.acquire('maintenance', signal);
      if (signal?.aborted || !state.paused || revision !== state.currentRevision) return;
      this.observability.record('maintenance_gpu_release_started', {});
      if (this.media.enabled || this.media.blocked) await this.media.quiesce(signal);
      const models = [...new Set(await this.backendClient.loadedModels(
        signal,
        this.config.gpu_safety.unloadTimeoutMs,
      ))];
      for (const model of models) {
        if (signal?.aborted) return;
        this.logger.info('unloading Ollama model for maintenance pause', { model });
        this.observability.record('maintenance_model_unload_started', { model: safeDisplay(model) });
        await this.backendClient.unloadModel(model, {
          signal,
          timeoutMs: this.config.gpu_safety.unloadTimeoutMs,
        });
        this.observability.record('maintenance_model_unloaded', { model: safeDisplay(model) });
      }
      const remaining = await this.backendClient.loadedModels(signal, this.config.gpu_safety.unloadTimeoutMs);
      if (remaining.length) {
        const error = new Error(`Ollama still reports ${remaining.length} loaded model(s) after maintenance unload`);
        error.code = 'maintenance_unload_unconfirmed';
        throw error;
      }
      this.backend.loadedModels = [];
      this.scheduler.reconcile(null);
      const result = await state.markReleased(revision);
      if (!result.changed) return;
      this.metrics.increment('proxy_maintenance_gpu_releases_total');
      this.logger.info('maintenance pause is quiescent; Ollama reports no loaded models', {
        resume_at: result.status.resume_at,
      });
      this.observability.record('maintenance_gpu_released', {
        models_unloaded: models.length,
        resume_at: result.status.resume_at,
      });
    } catch (error) {
      if (signal?.aborted || !state.paused || revision !== state.currentRevision) return;
      try {
        await state.markError(revision, error);
      } catch (stateError) {
        state.failClosed(`cannot persist maintenance failure: ${stateError.message}`);
      }
      this.logger.error('maintenance pause could not confirm GPU release; inference remains blocked', {
        error: error.message,
      });
      this.observability.record('maintenance_gpu_release_failed', {
        reason: 'model_unload_unconfirmed',
      });
    } finally {
      release?.();
    }
  }

  scheduleMaintenanceRetry() {
    if (this.maintenanceRetryTimer || !this.running) return;
    this.maintenanceRetryTimer = setTimeout(() => {
      this.maintenanceRetryTimer = null;
      this.kickMaintenanceQuiescence();
    }, this.config.ollama.healthIntervalMs);
    this.maintenanceRetryTimer.unref?.();
  }

  clearMaintenanceRetry() {
    if (this.maintenanceRetryTimer) clearTimeout(this.maintenanceRetryTimer);
    this.maintenanceRetryTimer = null;
  }

  handleEventStream(request, response, id) {
    let closed = false;
    let heartbeat;
    let unsubscribe;
    const close = (force = false) => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
      this.eventStreams.delete(close);
      if (force) {
        if (!response.destroyed) response.destroy();
      } else if (!response.destroyed && !response.writableEnded) response.end();
    };
    const send = (eventName, data, eventId = null) => {
      if (closed || response.destroyed || response.writableEnded) return false;
      const lines = [];
      if (eventId !== null) lines.push(`id: ${eventId}`);
      lines.push(`event: ${eventName}`, `data: ${JSON.stringify(data)}`, '', '');
      let writable;
      try {
        writable = response.write(lines.join('\n'));
      } catch {
        close(true);
        return false;
      }
      if (!writable) close(true);
      return writable;
    };
    unsubscribe = this.observability.subscribe((event) => send('update', event, event.id));
    if (!unsubscribe) {
      return sendJson(response, 503, { error: 'too many live dashboard connections', code: 'event_clients_full' }, id);
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
      'x-request-id': id,
    });
    response.flushHeaders();
    this.eventStreams.add(close);
    if (!send('snapshot', {
      schema_version: 1,
      generated_at: new Date(this.clock()).toISOString(),
      instance_id: this.observability.instanceId,
    })) return undefined;
    heartbeat = setInterval(() => {
      if (closed) return;
      try {
        if (!response.write(': keepalive\n\n')) close(true);
      } catch {
        close(true);
      }
    }, 15_000);
    heartbeat.unref?.();
    request.once('aborted', close);
    response.once('close', close);
    return undefined;
  }

  handleMetrics(response) {
    const now = this.clock();
    const status = this.scheduler.status(now);
    const details = this.scheduler.details(now);
    const backend = this.backend.status(now);
    const body = this.metrics.render({
      queueDepth: status.queues,
      oldestWait: status.oldest_wait_seconds,
      backendHealthy: this.backend.canDispatch(),
      recoveryRequired: this.backend.recoveryRequired,
      upstreamDraining: status.upstream_draining,
      currentModel: status.current_model,
      activeRequest: details.active_request,
      loadedModels: backend.loaded_models,
      maintenance: this.maintenance.status(now),
    });
    response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    response.end(body);
  }

  async handleGeneration(request, response, url, id, forcedClient) {
    if (!this.scheduler.accepting) return sendJson(response, 503, { error: 'proxy is shutting down', code: 'shutting_down' }, id);
    if (this.media.blocked) return sendJson(response, 503, { error: 'Media recovery must be verified before GPU work resumes.', code: 'media_recovery_required' }, id);
    if (this.backend.recoveryRequired) {
      return sendJson(response, 503, {
        error: 'GPU recovery is required before inference can resume',
        code: 'gpu_recovery_required',
      }, id);
    }
    if (this.config.circuit_breaker.queue_behavior === 'reject_new' && !this.backend.canDispatch()) {
      return sendJson(response, 503, { error: 'Ollama backend is unavailable', code: 'backend_unavailable' }, id);
    }
    let body;
    let parsed;
    try {
      body = await readBody(request, this.config.server.body_limit_bytes);
      parsed = parseJson(body);
    } catch (error) {
      return sendJson(response, error.statusCode ?? 400, { error: error.message, code: 'invalid_request' }, id);
    }
    if (!parsed.model || typeof parsed.model !== 'string') {
      return sendJson(response, 400, { error: 'generation request must contain a string model field', code: 'model_required' }, id);
    }
    if (!Object.hasOwn(this.config.models, parsed.model) && this.config.scheduler.unknown_model_policy === 'reject') {
      return sendJson(response, 400, { error: `model ${parsed.model} is not configured`, code: 'unknown_model' }, id);
    }

    const ticket = request.headers['x-ollama-intermediary-attempt'];
    const identification = ticket !== undefined
      ? { client: 'frigate', method: 'catchup_attempt' }
      : this.classifier.identify(request, parsed, forcedClient);
    const client = identification.client;
    if (ticket !== undefined && !Object.hasOwn(this.config.clients, 'frigate')) {
      return sendJson(response, 503, { error: 'Configure a Frigate client scheduling policy before using correlated catch-up.', code: 'catchup_policy_missing' }, id);
    }
    try { this.registry.resolve(client, null, 'ollama'); }
    catch (error) { return sendJson(response, error.statusCode || 422, { error: error.message, code: error.code }, id); }
    const streaming = isStreaming(url.pathname, parsed);
    const originalBodyBytes = body.length;
    let normalized = applyKeepAlive(url.pathname, parsed, this.scheduler.modelPolicy(parsed.model, client));
    if (normalized.changed) body = Buffer.from(JSON.stringify(normalized.parsed));
    let requestSummary;
    try {
      requestSummary = summarizeRequest(url.pathname, parsed, originalBodyBytes);
    } catch {
      requestSummary = minimalRequestSummary(originalBodyBytes);
    }

    let attemptRef = null;
    const attemptRequestId = ticket !== undefined ? randomUUID() : null;
    if (ticket !== undefined) {
      try {
        if (!Object.hasOwn(this.config.clients, 'frigate')) {
          return sendJson(response, 503, { error: 'Configure a Frigate client scheduling policy before using correlated catch-up.', code: 'catchup_policy_missing' }, id);
        }
        if (typeof ticket !== 'string' || !/^[a-f0-9]{64}$/.test(ticket) || !this.catchup.claimInference) {
          return sendJson(response, 401, { error: 'A valid current catch-up attempt is required.', code: 'invalid_attempt_ticket' }, id);
        }
        const context = this.config.frigate.context_rescue.enabled
          && parsed.model === this.config.frigate.context_rescue.model
          ? contextRequest(url.pathname, body, normalized.parsed, this.config.ollama.url) : null;
        attemptRef = this.catchup.claimInference(ticket, attemptRequestId, context);
      } catch (error) {
        return sendJson(response, [401, 409, 503].includes(error.statusCode) ? error.statusCode : 503, {
          error: 'Catch-up attempt is unknown, expired, or unavailable.', code: 'catchup_attempt_rejected',
        }, id);
      }
    }

    const upstreamController = new AbortController();
    const job = createJob({
      id,
      sequence: ++this.sequence,
      client,
      backend: this.config.primaryBackend,
      backendType: 'ollama',
      trafficClass: attemptRef ? 'catchup' : 'live',
      attemptRef,
      attemptRequestId,
      identificationMethod: identification.method,
      model: parsed.model,
      pathname: url.pathname,
      path: `${url.pathname}${url.search}`,
      method: request.method,
      body,
      bodyReservation: request.bodyReservation,
      headers: contentHeaders(copyRequestHeaders(request.headers, this.config.ollama.url, id), body),
      streaming,
      requestType: requestType(url.pathname),
      requestSummary,
      signal: upstreamController.signal,
      abortController: upstreamController,
      downstreamDisconnected: false,
      dedupeKey: attemptRef ? null : this.classifier.dedupeKey(client, request, parsed),
    });
    // Only the serialized body needs to survive a potentially long queue wait.
    // Do not retain a second object tree of prompts/base64 images in this frame.
    parsed = null;
    normalized = null;
    body = null;
    const disconnect = () => {
      if (response.writableEnded || job.downstreamDisconnected) return;
      job.downstreamDisconnected = true;
      if (job.state === 'queued') {
        this.scheduler.cancel(job);
        return;
      }
      if (job.state !== 'active') return;
      job.disconnectedAt = Date.now();
      this.metrics.increment('proxy_active_disconnects_total', { client: job.client, model: job.model });
      this.observability.record('active_client_disconnected', this.scheduler.eventFields(job, {
        draining: this.config.gpu_safety.drain_active_disconnects,
      }));
      if (this.config.gpu_safety.drain_active_disconnects) {
        this.logger.warn('active client disconnected; draining upstream Ollama request', {
          request_id: job.id,
          detected_client: job.client,
          requested_model: job.model,
        });
      } else {
        this.logger.warn('active client disconnected; aborting upstream Ollama request', {
          request_id: job.id,
          detected_client: job.client,
          requested_model: job.model,
        });
        upstreamController.abort(new Error('client disconnected'));
      }
      this.scheduler.wake();
    };
    request.once('aborted', disconnect);
    response.once('close', disconnect);
    const removeDisconnectListeners = () => {
      request.removeListener('aborted', disconnect);
      response.removeListener('close', disconnect);
    };
    const admission = this.scheduler.enqueue(job);
    if (!admission.accepted) {
      removeDisconnectListeners();
      this.finishCatchupInference(job, { certain: true, status: admission.status, deferred: admission.code });
      if (admission.code === 'maintenance_paused') return this.sendMaintenancePaused(response, id);
      return sendJson(response, admission.status, { error: admission.message, code: admission.code }, id);
    }
    if (request.aborted || response.destroyed) disconnect();

    const result = await job.result;
    if (result.type === 'local_error') {
      removeDisconnectListeners();
      // Dispatched jobs are reported by dispatchLoop only after the physical
      // gate is released. Queue rejections/cancellations never touched Ollama.
      if (!job.dispatchedAt) this.finishCatchupInference(job, { certain: true, status: result.status, deferred: result.code });
      return sendJson(response, result.status, { error: result.message, code: result.code }, id);
    }

    let streamError = null;
    let status = 499;
    let responseBody = Buffer.alloc(0);
    const responseStats = new ResponseStatsCollector();
    const responseOutcome = new ResponseOutcomeCollector(this.config.gpu_safety.error_body_limit_bytes);
    try {
      const upstream = result.upstream;
      status = upstream.statusCode ?? 502;
      if (!job.downstreamDisconnected && !response.destroyed) {
        copyResponseHeaders(upstream.headers, response);
        response.statusCode = status;
        response.flushHeaders();
      }
      const transfer = await streamBody(upstream, response, {
        flush: streaming,
        drainOnClose: this.config.gpu_safety.drain_active_disconnects,
        captureLimit: status >= 400 ? this.config.gpu_safety.error_body_limit_bytes : 0,
        onChunk: (chunk) => { responseStats.push(chunk); responseOutcome.push(chunk); },
      });
      responseBody = transfer.captured;
      job.downstreamDisconnected ||= transfer.downstreamClosed;
      if (job.downstreamDisconnected && this.config.gpu_safety.drain_active_disconnects) {
        this.metrics.observe('proxy_upstream_drain_duration_seconds', (Date.now() - (job.disconnectedAt ?? job.dispatchedAt)) / 1000, {
          client: job.client,
          model: job.model,
        });
        this.logger.info('upstream Ollama request drained after client disconnect', {
          request_id: job.id,
          detected_client: job.client,
          requested_model: job.model,
        });
        this.observability.record('upstream_request_drained', this.scheduler.eventFields(job, {
          drain_duration_seconds: (Date.now() - (job.disconnectedAt ?? job.dispatchedAt)) / 1000,
        }));
      }
    } catch (error) {
      streamError = error;
      if (!upstreamController.signal.aborted) this.logger.warn('response stream failed', { request_id: id, error: error.message });
    } finally {
      removeDisconnectListeners();
      result.cleanup?.();
      job.finish({
        status,
        error: streamError,
        inferenceError: responseOutcome.finish(),
        completionUncertain: Boolean(streamError),
        clientDisconnected: job.downstreamDisconnected,
        responseBody,
        responseStats: responseStats.finish(),
      });
    }
  }

  async handlePassthrough(request, response, url, id, release = null, beforeDispatch = null) {
    let body;
    try {
      body = await readBody(request, this.config.server.body_limit_bytes);
    } catch (error) {
      release?.();
      return sendJson(response, error.statusCode ?? 400, { error: error.message, code: 'invalid_request' }, id);
    }
    const controller = new AbortController();
    const abort = () => controller.abort(new Error('client disconnected'));
    request.once('aborted', abort);
    response.once('close', abort);
    try {
      if (beforeDispatch && !beforeDispatch()) return;
      if (request.aborted || response.destroyed) return;
      const headers = contentHeaders(copyRequestHeaders(request.headers, this.config.ollama.url, id), body);
      const { response: upstream, cleanup } = await this.backendClient.request({
        method: request.method, path: `${url.pathname}${url.search}`, headers, body, signal: controller.signal,
      });
      copyResponseHeaders(upstream.headers, response);
      response.statusCode = upstream.statusCode ?? 502;
      response.flushHeaders();
      await streamBody(upstream, response, { flush: true });
      cleanup();
    } catch (error) {
      if (!controller.signal.aborted) {
        this.logger.warn('passthrough request failed', { request_id: id, path: url.pathname, error: error.message });
        sendJson(response, 502, { error: 'Ollama backend request failed', code: 'backend_error', detail: error.message }, id);
      }
    } finally {
      response.removeListener('close', abort);
      release?.();
    }
  }

  async handleManagement(request, response, url, id) {
    if (this.media.blocked) return sendJson(response, 503, { error: 'Media recovery is required.', code: 'media_recovery_required' }, id);
    if (this.releasePaused) return this.sendMaintenancePaused(response, id);
    if (this.backend.recoveryRequired) {
      return sendJson(response, 503, { error: 'GPU recovery verification is required before model operations can resume', code: 'gpu_recovery_required' }, id);
    }
    if (!this.config.model_management.enabled) {
      return sendJson(response, 403, { error: 'model-management endpoints are disabled', code: 'management_disabled' }, id);
    }
    const controller = new AbortController();
    const abort = () => controller.abort(new Error('client disconnected'));
    response.once('close', abort);
    let release;
    try {
      release = await this.gate.acquire('management', controller.signal);
    } catch {
      return;
    }
    response.removeListener('close', abort);
    if (this.releasePaused) {
      release();
      return this.sendMaintenancePaused(response, id);
    }
    if (this.backend.recoveryRequired) {
      release();
      return sendJson(response, 503, { error: 'GPU recovery verification is required before model operations can resume', code: 'gpu_recovery_required' }, id);
    }
    if (this.settingsRestartPending || !this.scheduler.accepting) {
      release();
      return sendJson(response, 503, { error: 'Intermediary is stopping or restarting; model operation was not started.', code: 'shutting_down' }, id);
    }
    try { await this.media.prepareOllama(controller.signal); }
    catch (error) {
      this.media.fault = error.code || 'media_release_unconfirmed';
      release();
      return sendJson(response, 503, { error: 'Media GPU release could not be verified.', code: 'media_recovery_required' }, id);
    }
    // The media release checks and request body read are asynchronous. Policy
    // can change while either is pending; check again immediately before the
    // backend mutation, with the same exclusive gate still held.
    const beforeDispatch = () => {
      if (this.media.blocked) {
        sendJson(response, 503, { error: 'Media recovery is required.', code: 'media_recovery_required' }, id);
      } else if (this.releasePaused) {
        this.sendMaintenancePaused(response, id);
      } else if (this.backend.recoveryRequired) {
        sendJson(response, 503, { error: 'GPU recovery verification is required before model operations can resume', code: 'gpu_recovery_required' }, id);
      } else if (this.settingsRestartPending || !this.running || !this.scheduler.accepting) {
        sendJson(response, 503, { error: 'Intermediary is stopping or restarting; model operation was not started.', code: 'shutting_down' }, id);
      } else return true;
      return false;
    };
    if (!beforeDispatch()) { release(); return; }
    return this.handlePassthrough(request, response, url, id, release, beforeDispatch);
  }

  finishCatchupInference(job, outcome) {
    if (!job.attemptRef || job.attemptReported) return;
    job.attemptReported = true;
    try {
      this.catchup.inferenceFinished(job.attemptRef, job.attemptRequestId, outcome);
    } catch {
      // Never let a bookkeeping error break the dispatch loop or expose a
      // ticket. Fail closed: an unrecorded terminal boundary needs recovery.
      this.backend.requireRecovery('Catch-up inference completion could not be persisted');
      this.scheduler.failQueued(503, 'gpu_recovery_required', 'GPU recovery verification is required before inference can resume');
    }
  }

  async prepareContextRescue(job) {
    if (!job.attemptRef) return;
    const plan = this.catchup.contextRescuePlan?.(job.attemptRef, job.attemptRequestId);
    if (!plan) return;
    job.phase = 'context_rescue_preflight';
    const block = (reason) => {
      this.catchup.recordContextRescue(job.attemptRef, job.attemptRequestId, { blocked: reason });
      const error = new Error('Context rescue was not dispatched; see the catch-up job for its safety check.');
      error.code = 'context_rescue_blocked';
      error.reason = reason;
      throw error;
    };
    if (plan.blocked) block(plan.blocked);
    // Metadata/telemetry only. The existing inference gate is held throughout
    // this check and dispatch; neither probe loads a model or runs inference.
    let modelLimit;
    try { modelLimit = await this.backendClient.modelContextLength(job.model, job.signal); }
    catch { block('rescue_model_unknown'); }
    if (!modelLimit) block('rescue_model_unknown');
    if (plan.context > modelLimit) block('rescue_model_limit');
    let host;
    try { host = await this.hostHelper.refresh(); }
    catch { block('rescue_telemetry_unavailable'); }
    // GPU counters can lag a just-finished request. Allow a bounded settling
    // window under the same gate; never reinterpret nonzero/unknown as idle.
    for (let probe = 0; probe < 3 && rescueHardwareBlock(host) === 'rescue_gpu_busy'; probe++) {
      this.assertRescueDispatchAllowed(job);
      if (this.scheduler.jobs.some((queued) => queued.trafficClass !== 'catchup' && !this.scheduler.pauseReason(queued))) break;
      await delay(350, undefined, { signal: job.signal });
      try { host = await this.hostHelper.refresh(); }
      catch { block('rescue_telemetry_unavailable'); }
    }
    const hardwareBlock = rescueHardwareBlock(host);
    if (hardwareBlock) block(hardwareBlock);
    // Rescue always requires system RAM evidence, even if the ordinary
    // catch-up guard is explicitly disabled. More VRAM is not more host RAM.
    const ramBlock = memoryBlock(host, { ...this.config.host_helper.memory_guard, enabled: true }, { rescue: true });
    if (ramBlock) block(`rescue_${ramBlock}`);

    const parsed = parseJson(job.body);
    parsed.options.num_ctx = plan.context;
    const body = Buffer.from(JSON.stringify(parsed));
    const extra = Math.max(0, body.length - (job.bodyReservation?.bytes ?? job.body.length));
    if (body.length > this.config.server.body_limit_bytes
      || this.scheduler.memoryUsage().total - job.body.length + body.length > this.config.scheduler.max_queue_bytes
      || this.reservedBodyBytes + extra > this.config.scheduler.max_queue_bytes) block('rescue_body_limit');
    // Pause/shutdown/recovery may have arrived during either read-only probe.
    // A skipped preflight must not consume the one enlarged attempt.
    this.assertRescueDispatchAllowed(job);
    job.rescueContext = plan.context;
    if (job.bodyReservation) {
      this.reservedBodyBytes += extra;
      job.bodyReservation.bytes += extra;
    }
    job.body = body;
    job.headers = contentHeaders(job.headers, body);
    this.observability.record('context_rescue_reserved', this.scheduler.eventFields(job, { context: plan.context }));
  }

  assertRescueDispatchAllowed(job) {
    if (job.signal.aborted) throw job.signal.reason;
    if (this.scheduler.pauseReason(job) || !this.running || !this.scheduler.accepting || this.settingsRestartPending
      || !this.backend.canDispatch()) {
      const error = new Error('Context rescue stopped before dispatch because inference admission changed.');
      error.code = 'context_rescue_interrupted';
      throw error;
    }
  }

  async prepareCatchupMemory(job) {
    if (!job.attemptRef || !this.config.host_helper.enabled || !this.config.host_helper.memory_guard.enabled) return;
    job.phase = 'host_memory_preflight';
    let host;
    try { host = await this.hostHelper.refresh(); } catch { /* missing is unsafe, not zero */ }
    const reason = memoryBlock(host, this.config.host_helper.memory_guard);
    if (reason) {
      const error = new Error('Catch-up deferred before Ollama dispatch; host RAM is low or unavailable.');
      error.code = 'host_memory_blocked'; error.reason = reason;
      throw error;
    }
    this.assertRescueDispatchAllowed(job);
  }

  async dispatchLoop() {
    const signal = this.workerController.signal;
    while (!signal.aborted) {
      this.media.restoreQueued();
      if (this.media.blocked) {
        if (!this.scheduler.active && !this.gate.active) {
          const release = await this.gate.acquire('maintenance', signal);
          try { await this.media.reconcile(signal); } catch { /* uncertainty remains fenced */ }
          finally { release(); }
        }
        await this.scheduler.waitForChange(Math.max(1000, this.config.media.pollIntervalMs), signal);
        continue;
      }
      if (!this.backend.canDispatch()) {
        await this.scheduler.waitForChange(Math.min(1_000, this.config.ollama.healthIntervalMs), signal);
        continue;
      }
      if (this.gate.managementPending || this.gate.managementActive
        || this.gate.maintenancePending || this.gate.maintenanceActive) {
        await this.scheduler.waitForChange(100, signal);
        continue;
      }
      const selection = this.scheduler.take();
      if (!selection.job) {
        await this.scheduler.waitForChange(selection.delayMs, signal);
        continue;
      }
      const job = selection.job;
      job.phase = 'waiting_for_gate';
      let release;
      let finalEvent = null;
      let catchupOutcome = null;
      const startedAt = Date.now();
      try {
        release = await this.gate.acquire('inference', job.signal);
        while (!this.backend.canDispatch() && !job.signal.aborted) {
          await this.scheduler.waitForChange(Math.min(1_000, this.config.ollama.healthIntervalMs), job.signal);
        }
        if (job.signal.aborted) throw job.signal.reason;
        if (job.mediaId) {
          await this.media.run(job);
          continue;
        }
        try { await this.media.prepareOllama(job.signal); }
        catch (error) {
          this.media.fault = error.code || 'media_release_unconfirmed';
          throw Object.assign(error, { code: 'media_recovery_required' });
        }
        // A synthetic media model is never an Ollama model to unload.
        if (job.previousModel?.startsWith('comfyui:')) job.previousModel = null;
        this.scheduler.currentBackendType = 'ollama';
        this.assertRescueDispatchAllowed(job);
        if (job.attemptRef) this.catchup.inferenceStarted?.(job.attemptRef, job.attemptRequestId);
        if (job.switching && job.previousModel && this.config.gpu_safety.unload_on_model_switch) {
          job.phase = 'unloading_model';
          const unloadStartedAt = Date.now();
          this.logger.info('unloading previous Ollama model before switch', {
            request_id: job.id,
            from_model: job.previousModel,
            to_model: job.model,
          });
          this.observability.record('model_unload_started', this.scheduler.eventFields(job, {
            from_model: safeDisplay(job.previousModel),
            to_model: safeDisplay(job.model),
          }));
          try {
            await this.backendClient.unloadModel(job.previousModel, {
              signal: job.signal,
              timeoutMs: this.config.gpu_safety.unloadTimeoutMs,
            });
          } catch (error) {
            if (job.signal.aborted) throw error;
            const wrapped = new Error(`failed to unload ${job.previousModel} before switching to ${job.model}: ${error.message}`, { cause: error });
            wrapped.code = error.code === 'model_unload_timeout' ? error.code : 'model_unload_failed';
            throw wrapped;
          }
          const unloadDuration = (Date.now() - unloadStartedAt) / 1000;
          this.metrics.observe('proxy_model_unload_duration_seconds', unloadDuration, {
            from: job.previousModel,
            to: job.model,
          });
          this.logger.info('previous Ollama model unload confirmed', {
            request_id: job.id,
            from_model: job.previousModel,
            to_model: job.model,
            unload_duration: unloadDuration,
          });
          this.observability.record('model_unloaded', this.scheduler.eventFields(job, {
            from_model: safeDisplay(job.previousModel),
            to_model: safeDisplay(job.model),
            duration_seconds: unloadDuration,
          }));
        }
        await this.prepareCatchupMemory(job);
        await this.prepareContextRescue(job);
        this.assertRescueDispatchAllowed(job);
        if (job.rescueContext) this.catchup.recordContextRescue(job.attemptRef, job.attemptRequestId, { context: job.rescueContext });
        job.phase = 'connecting';
        const { response, cleanup } = await this.backendClient.request({
          method: job.method, path: job.path, headers: job.headers, body: job.body, signal: job.signal,
        });
        if (job.modelLoadExpected) {
          this.metrics.observe('proxy_model_load_duration_seconds', (Date.now() - startedAt) / 1000, { model: job.model });
        }
        job.phase = job.streaming ? 'streaming' : 'running';
        job.settle({ type: 'upstream', upstream: response, cleanup });
        const outcome = await job.finished;
        if (outcome.completionUncertain) {
          this.backend.requireRecovery('Upstream inference ended without a complete response; verify Ollama and GPU idle state before resuming', {
            request_id: job.id,
            error: outcome.error?.message,
            client_disconnected: outcome.clientDisconnected,
          });
        }
        const backendResult = this.backend.recordGenerationResult(
          outcome.status,
          outcome.responseBody,
          outcome.inferenceError ?? outcome.error,
        );
        if (backendResult.recoveryRequired || this.backend.recoveryRequired) {
          this.scheduler.failQueued(503, 'gpu_recovery_required', 'GPU recovery is required before inference can resume');
        }
        const duration = (Date.now() - job.dispatchedAt) / 1000;
        this.metrics.observe('proxy_request_duration_seconds', duration, { client: job.client, model: job.model });
        this.metrics.observe('proxy_response_body_bytes', outcome.responseStats?.response_bytes ?? 0, {
          client: job.client, endpoint: job.pathname,
        });
        if (Number.isFinite(outcome.responseStats?.prompt_tokens)) {
          this.metrics.observe('proxy_prompt_tokens', outcome.responseStats.prompt_tokens, {
            client: job.client, endpoint: job.pathname,
          });
        }
        if (Number.isFinite(outcome.responseStats?.output_tokens)) {
          this.metrics.observe('proxy_output_tokens', outcome.responseStats.output_tokens, {
            client: job.client, endpoint: job.pathname,
          });
        }
        const failed = outcome.status >= 400 || Boolean(outcome.inferenceError || outcome.error);
        const finalStatus = failed && outcome.status < 400 ? 502 : outcome.status;
        const overflow = job.attemptRef && this.config.frigate.context_rescue.enabled
          ? contextOverflow(outcome.status, outcome.responseBody,
            !outcome.completionUncertain && outcome.responseStats?.response_bytes === outcome.responseBody?.length) : null;
        catchupOutcome = { certain: !outcome.completionUncertain, status: finalStatus,
          ...(overflow ? { contextOverflow: overflow } : {}) };
        const failureReason = outcome.completionUncertain ? 'upstream_completion_uncertain'
          : outcome.inferenceError ? 'upstream_inference_error' : 'upstream_http_error';
        this.logger[failed ? 'error' : 'info'](failed ? 'request failed' : 'request completed', {
          request_id: job.id, detected_client: job.client, requested_model: job.model,
          queue_wait: (job.dispatchedAt - job.enqueuedAt) / 1000,
          completion_time: new Date().toISOString(), request_duration: duration,
          http_status: finalStatus, upstream_http_status: outcome.status, streaming: job.streaming,
          ...(failed ? { reason: failureReason, error: outcome.inferenceError?.message ?? outcome.error?.message } : {}),
        });
        finalEvent = [failed ? 'request_failed' : 'request_completed', this.scheduler.eventFields(job, {
          status: finalStatus,
          upstream_http_status: outcome.status,
          outcome: failed ? 'failed' : 'completed',
          ...(failed ? { reason: failureReason } : {}),
          queue_wait_seconds: (job.dispatchedAt - job.enqueuedAt) / 1000,
          duration_seconds: duration,
          client_disconnected: outcome.clientDisconnected,
          response: outcome.responseStats,
        })];
      } catch (error) {
        catchupOutcome = {
          certain: !['connecting', 'running', 'streaming'].includes(job.phase),
          status: 502,
        };
        // A transport failure after sending the request does not establish that
        // Ollama stopped working. Even an abandoned client must hold admission
        // closed until recovery has been explicitly verified.
        if (job.phase === 'connecting') {
          this.backend.requireRecovery('Ollama request failed after dispatch; upstream completion is unknown', { error: error.message, request_id: job.id });
          this.scheduler.failQueued(503, 'gpu_recovery_required', 'GPU recovery verification is required before inference can resume');
        }
        const disconnected = job.signal?.aborted;
        if (disconnected) {
          job.settle({ type: 'local_error', status: 499, code: 'client_closed', message: 'client disconnected' });
          finalEvent = ['request_cancelled', this.scheduler.eventFields(job, {
            status: 499,
            reason: 'active_client_disconnect',
            duration_seconds: (Date.now() - job.dispatchedAt) / 1000,
          })];
        } else if (['context_rescue_blocked', 'context_rescue_interrupted', 'host_memory_blocked', 'media_recovery_required'].includes(error.code)) {
          // A local safety refusal is not an Ollama failure and must not open
          // the circuit breaker or trigger a host-service restart.
          const status = error.code === 'context_rescue_blocked' ? 422 : 503;
          const deferred = DEFERRAL_REASONS.has(error.reason ?? error.code) ? error.reason ?? error.code : null;
          catchupOutcome = { certain: true, status, deferred };
          job.settle({ type: 'local_error', status, code: error.code, message: error.message });
          finalEvent = [deferred ? 'request_deferred' : 'request_failed', this.scheduler.eventFields(job, {
            status, reason: error.reason ?? error.code,
            duration_seconds: (Date.now() - job.dispatchedAt) / 1000,
          })];
        } else {
          if (error.code === 'model_unload_failed' || error.code === 'model_unload_timeout') {
            this.backend.requireRecovery(error, {
              from_model: job.previousModel,
              to_model: job.model,
            });
            this.scheduler.failQueued(503, 'gpu_recovery_required', 'GPU recovery is required before inference can resume');
          } else {
            this.backend.recordFailure(error);
          }
          const timedOut = /timeout/i.test(`${error.message ?? ''} ${error.cause?.message ?? ''}`);
          job.settle({
            type: 'local_error', status: this.backend.recoveryRequired ? 503 : timedOut ? 504 : 502,
            code: this.backend.recoveryRequired ? 'gpu_recovery_required' : timedOut ? 'backend_timeout' : 'backend_error',
            message: this.backend.recoveryRequired
              ? 'GPU recovery is required before inference can resume'
              : timedOut ? 'Ollama request exceeded the configured hard runtime' : 'Ollama backend request failed',
          });
          this.logger.error('generation dispatch failed', {
            request_id: job.id, detected_client: job.client, requested_model: job.model, error: error.message,
          });
          finalEvent = ['request_failed', this.scheduler.eventFields(job, {
            status: this.backend.recoveryRequired ? 503 : timedOut ? 504 : 502,
            reason: this.backend.recoveryRequired
              ? 'gpu_recovery_required'
              : timedOut ? 'backend_timeout' : 'backend_error',
            duration_seconds: (Date.now() - job.dispatchedAt) / 1000,
          })];
        }
      } finally {
        release?.();
        this.scheduler.complete(job);
        this.finishCatchupInference(job, catchupOutcome ?? { certain: false, status: 502 });
        if (finalEvent) this.observability.record(finalEvent[0], finalEvent[1]);
      }
    }
  }

  async stop(graceMs = this.config.server.shutdownGraceMs) {
    if (!this.running) return;
    this.running = false;
    this.scheduler.stop();
    this.mediaGateway.close();
    this.media.close();
    await this.automaticRecovery.stop();
    await this.catchup.stop();
    this.backend.stop();
    this.maintenance.stop();
    this.scheduledMaintenance.stop();
    this.clearMaintenanceRetry();
    for (const close of [...this.eventStreams]) close();
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    const closes = this.servers.map(({ server }) => once(server, 'close').catch(() => {}));
    for (const { server } of this.servers) server.close();
    const activeFinished = this.scheduler.active?.finished ?? Promise.resolve();
    await waitWithTimeout(activeFinished, graceMs);
    this.scheduler.active?.abortController?.abort(new Error('shutdown grace period expired'));
    this.workerController.abort(new Error('proxy shutdown'));
    this.scheduler.wake();
    for (const { server } of this.servers) server.closeAllConnections?.();
    await Promise.allSettled(closes);
    await waitWithTimeout(this.workerPromise, 1_000);
    // Active media must still verify physical GPU release while it drains.
    // Stop telemetry only after completion or the bounded worker-abort wait;
    // aborting its client earlier turns a successful generation into uncertainty.
    this.hostHelper.stop();
    this.backendClient.close();
    this.logger.info('proxy stopped');
  }

  beginSettingsRestart() {
    // The new configuration is already durable at this point. Stop admitting
    // work immediately so no request starts under values that are about to be
    // replaced, while allowing the active upstream request to drain in stop().
    this.settingsRestartPending = true;
    this.scheduler.stop();
  }

  async waitForIdle(signal) {
    // No grace-period cutoff here: a settings update must not kill inference
    // that legitimately runs longer than the ordinary process shutdown grace.
    while (this.scheduler.active || this.gate.active || this.maintenanceTask) {
      if (signal?.aborted) throw signal.reason ?? new Error('idle wait cancelled');
      await this.scheduler.waitForChange(100, signal);
    }
  }
}
