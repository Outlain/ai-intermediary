import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { MediaStore } from './media-store.js';
import { ComfyBackend, validateComfyWorkflow } from './comfy-backend.js';
import { createJob } from './scheduler.js';
import { memoryBlock } from './memory-guard.js';

const terminal = new Set(['completed', 'failed', 'interrupted']);
const problem = (code, statusCode = 503) => Object.assign(new Error(code.replaceAll('_', ' ')), { code, statusCode });

/** Durable media uses the SAME scheduler and operation gate as Ollama. There
 * is deliberately no second worker that could race an LLM or maintenance. */
export class MediaBroker {
  constructor(service, options = {}) {
    this.service = service;
    this.config = service.config;
    this.settings = this.config.media;
    this.store = options.store || new MediaStore(this.settings);
    this.adapters = options.adapters || new Map(Object.entries(this.config.backends || {})
      .filter(([, backend]) => backend.type === 'comfyui' && backend.enabled)
      .map(([id, backend]) => [id, new ComfyBackend({ ...backend, token: this.settings.auth_token,
        allowed_node_types: this.settings.allowed_node_types,
        maxArtifactBytes: this.settings.max_output_bytes,
        maxRequestBytes: this.settings.max_workflow_bytes + 1024 * 1024 + 65_536 })]));
    this.loaded = false;
    this.fault = null;
    this.verified = false;
    this.scheduled = new Map();
    this.listeners = new Set();
    this.reconciling = null;
  }

  get enabled() { return this.settings.enabled; }
  get blocked() {
    return Boolean(this.fault || (this.loaded && this.store.unresolved().some((job) =>
      job.state === 'uncertain' || job.id !== this.service.scheduler.active?.mediaId)));
  }

  async init() {
    // Disabling media must not hide a previously uncertain GPU operation.
    if (!this.enabled && !fs.existsSync(this.settings.state_path)) return;
    try {
      await this.store.init();
      this.loaded = true;
      if (this.enabled) {
        this.restoreQueued();
        this.cleanupTimer = setInterval(() => {
          this.store.cleanup().catch(() => { this.fault = 'media_state_unavailable'; });
        }, 60_000);
        this.cleanupTimer.unref?.();
      }
    } catch { this.fault = 'media_state_unavailable'; }
  }

  close() { clearInterval(this.cleanupTimer); }

  snapshot() {
    return { enabled: this.enabled, blocked: this.blocked, error: this.fault,
      unresolved: this.loaded ? this.store.unresolved().map((job) => job.id) : [],
      jobs: this.loaded ? this.store.list() : [],
      recovery: 'Reconcile completed jobs, or pause and verify the ComfyUI service before manual acknowledgment. No automatic ComfyUI restart is enabled.' };
  }

  emit(type, job, detail = {}) {
    this.service.observability.record(`media_${type}`, { job_id: job.id, backend: job.backend, client: job.source, ...detail });
    for (const listener of this.listeners) listener(type, job, detail);
    this.service.scheduler.wake();
  }

  assertAdmission(source, backend) {
    if (!this.enabled || !this.loaded) throw problem('media_disabled');
    if (!this.service.running || this.service.settingsRestartPending) throw problem('shutting_down');
    if (this.blocked || this.service.backend.recoveryRequired) throw problem('gpu_recovery_required');
    this.service.registry.resolve(source, backend, 'comfyui');
    const blocked = this.service.scheduler.pauseReason({ client: source, trafficClass: 'live' });
    if (blocked && !this.config.clients[source].queue_while_paused) throw problem(blocked.reason);
  }

  async submit({ source, backend, workflow, clientId, idempotencyKey, extraData = {} }) {
    this.assertAdmission(source, backend);
    clientId ||= 'ai-intermediary';
    if (typeof clientId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(clientId)) throw problem('invalid_client_id', 400);
    const adapter = this.adapters.get(backend);
    if (!adapter) throw problem('backend_disabled');
    validateComfyWorkflow(workflow, { allowedNodeTypes: this.settings.allowed_node_types,
      maxBytes: this.settings.max_workflow_bytes });
    // Admission is serialized with persistence so simultaneous callers cannot
    // overrun the per-source queue limit before scheduler.enqueue sees them.
    const previous = this.admitting || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      this.assertAdmission(source, backend);
      const result = await this.store.create({ id: randomUUID(), source, backend, workflow,
        client_id: clientId, extraData, idempotencyKey, enqueuedAt: Date.now() }, { admit: () => {
        const pending = this.store.list().filter((job) => job.source === source
          && ['queued', 'dispatching', 'running', 'uncertain'].includes(job.state));
        if (pending.length >= this.config.clients[source].queue_limit) throw problem('queue_full', 429);
      } });
      if (result.created) this.enqueue(this.store.getInternal(result.job.id));
      this.emit('queued', result.job);
      return result.job;
    });
    this.admitting = operation;
    return operation;
  }

  enqueue(record) {
    if (this.scheduled.has(record.id) || record.state !== 'queued') return;
    // A removed/disabled mapping leaves durable jobs visible and paused, never
    // silently routes them to another engine after a settings change.
    try { this.service.registry.resolve(record.source, record.backend, 'comfyui'); } catch { return; }
    const controller = new AbortController();
    const job = createJob({ id: record.id, mediaId: record.id, durable: true, restoredDurable: true,
      backend: record.backend, backendType: 'comfyui', client: record.source, trafficClass: 'live',
      sequence: ++this.service.sequence, model: `comfyui:${record.backend}`, pathname: '/prompt',
      method: 'POST', requestType: 'media_workflow', streaming: false, body: Buffer.alloc(0),
      requestSummary: { body_bytes: 0 }, identificationMethod: 'media_gateway',
      enqueuedAt: record.enqueuedAt ?? record.enqueued_at ?? Date.now(),
      signal: controller.signal, abortController: controller });
    const admitted = this.service.scheduler.enqueue(job);
    if (!admitted.accepted) return; // persisted queue is retried, never replayed upstream
    this.scheduled.set(record.id, job);
    job.result.then(() => { if (job.state !== 'active') this.scheduled.delete(record.id); });
  }

  restoreQueued() {
    if (this.enabled && this.loaded && this.service.scheduler.accepting) {
      for (const record of this.store.queued()) this.enqueue(record);
    }
  }

  async bridge(adapter, signal) {
    const info = await adapter.bridgeStatus({ signal });
    if (info.protocol !== 'ai-intermediary-comfy-v1' || info.local_only !== true) throw problem('comfy_bridge_required');
    return info;
  }

  async releaseComfy(signal) {
    for (const adapter of this.adapters.values()) {
      await this.bridge(adapter, signal);
      const queue = await adapter.queue({ signal });
      if (queue.queue_running.length || queue.queue_pending.length) throw problem('comfy_external_or_unfinished_work');
      await adapter.requestFree({ signal });
      const deadline = Date.now() + this.config.gpu_safety.unloadTimeoutMs;
      let released = false;
      while (Date.now() < deadline && !signal?.aborted) {
        const evidence = await adapter.releaseEvidence({ signal });
        if (evidence.idle && evidence.released) { released = true; break; }
        await delay(Math.min(500, this.settings.pollIntervalMs), undefined, { signal });
      }
      if (!released) throw problem('comfy_release_unconfirmed');
    }
  }

  async releaseOllama(signal) {
    const client = this.service.backendClient;
    for (const model of await client.loadedModels(signal, this.config.ollama.healthTimeoutMs)) {
      await client.unloadModel(model, { signal, timeoutMs: this.config.gpu_safety.unloadTimeoutMs });
    }
    if ((await client.loadedModels(signal, this.config.ollama.healthTimeoutMs)).length) throw problem('ollama_release_unconfirmed');
    this.service.backend.loadedModels = [];
  }

  async verifyPhysicalRelease(signal) {
    const deadline = Date.now() + this.config.gpu_safety.unloadTimeoutMs;
    let samples = 0;
    let lastSample = null;
    while (Date.now() < deadline && !signal?.aborted) {
      await this.service.hostHelper.refresh();
      const host = this.service.hostHelper.snapshot();
      const safe = host.available && host.bound && host.gpus.length === 1 && host.gpus.every((gpu) =>
        gpu.processes_known && Number.isFinite(gpu.vram_used_bytes)
        && gpu.vram_used_bytes <= this.settings.max_idle_vram_mb * 1024 * 1024
        && Number.isFinite(gpu.utilization_percent) && gpu.utilization_percent <= this.settings.max_idle_utilization_percent
        && gpu.processes.every((process) => process.is_ollama || process.is_comfyui));
      if (safe && host.sampled_at !== lastSample) samples += 1;
      if (!safe) samples = 0;
      lastSample = host.sampled_at;
      if (samples >= this.settings.stable_samples) return;
      await delay(Math.min(1000, this.settings.pollIntervalMs), undefined, { signal });
    }
    throw problem('physical_gpu_release_unconfirmed');
  }

  async quiesce(signal) {
    if (!this.enabled) {
      if (this.blocked) throw problem('media_recovery_required');
      return;
    }
    if (this.blocked) throw problem('media_recovery_required');
    await this.releaseOllama(signal);
    await this.releaseComfy(signal);
    await this.verifyPhysicalRelease(signal);
    this.verified = true;
  }

  async prepareOllama(signal) {
    if (this.blocked) throw problem('media_recovery_required');
    if (!this.enabled) return;
    if (!this.verified) await this.quiesce(signal);
    // A raw backend queue that appeared outside this broker is not ours to
    // clear or interrupt. Refuse dispatch instead of guessing it is harmless.
    for (const adapter of this.adapters.values()) {
      await this.bridge(adapter, signal);
      const evidence = await adapter.releaseEvidence({ signal });
      if (!evidence.idle || !evidence.released) throw problem('comfy_external_or_unfinished_work');
    }
  }

  async run(job) {
    const record = this.store.getInternal(job.mediaId);
    const adapter = this.adapters.get(record.backend);
    let dispatched = false;
    let accepted = false;
    try {
      this.service.registry.resolve(record.source, record.backend, 'comfyui');
      if (this.service.scheduler.pauseReason(job)) return; // durable queued job remains
      job.phase = 'preparing_gpu';
      await this.quiesce(job.signal);
      const memoryReason = memoryBlock(this.service.hostHelper.snapshot(), this.config.host_helper.memory_guard);
      if (memoryReason) throw problem(memoryReason);
      // Recheck pause after potentially slow unloads. Do not submit at a
      // schedule boundary or while a settings restart is draining.
      if (this.service.scheduler.pauseReason(job) || this.service.settingsRestartPending) return;
      validateComfyWorkflow(record.workflow, { allowedNodeTypes: this.settings.allowed_node_types,
        objectInfo: await adapter.objectInfo({ signal: job.signal }), maxBytes: this.settings.max_workflow_bytes });
      await this.store.update(record.id, { state: 'dispatching' });
      dispatched = true;
      job.phase = 'media_running';
      this.verified = false;
      await adapter.submit(record.workflow, { promptId: record.id, clientId: record.client_id || 'ai-intermediary',
        extraData: record.extraData || {}, signal: job.signal,
        beforeDispatch: () => {
          if (!this.service.running || this.service.settingsRestartPending || this.service.scheduler.pauseReason(job)
            || this.service.backend.recoveryRequired || this.fault || job.signal.aborted) {
            throw Object.assign(problem('media_dispatch_deferred'), { beforeDispatch: true });
          }
        } });
      accepted = true;
      await this.store.update(record.id, { state: 'running' });
      this.emit('running', record);
      const deadline = Date.now() + this.settings.jobTimeoutMs;
      let result;
      while (Date.now() < deadline) {
        job.signal.throwIfAborted();
        result = await adapter.inspect(record.id, { signal: job.signal });
        if (result.terminal && terminal.has(result.state)) break;
        await delay(this.settings.pollIntervalMs, undefined, { signal: job.signal });
      }
      if (!result?.terminal) throw problem('media_completion_uncertain');
      await this.finish(record, result, job.signal);
    } catch (error) {
      if (!dispatched && this.store.get(record.id)?.state === 'cancelled') {
        this.verified = false; // next owner must repeat any interrupted eviction checks
        return;
      }
      const invalid = ['node_not_allowed', 'unknown_node', 'invalid_workflow', 'cloud_node_forbidden',
        'remote_workflow_input', 'invalid_workflow_path', 'invalid_client_id', 'invalid_metadata'].includes(error.code);
      if (!accepted && error.beforeDispatch && error.code === 'media_dispatch_deferred') {
        if (dispatched) await this.store.requeueUndispatched(record.id);
        this.emit('deferred', record, { reason: 'paused_before_dispatch' });
        return;
      }
      if (!accepted && (invalid || error.definiteRejection)) {
        // Validation/auth refusal before enqueue is a failed job, not an
        // indefinitely uncertain GPU operation. 409 duplicate-ID responses
        // intentionally do NOT have definiteRejection set.
        await this.store.update(record.id, { state: 'failed', reason: error.code || 'media_submission_rejected' });
        this.emit('failed', record, { reason: error.code || 'media_submission_rejected' });
        return;
      }
      if (!accepted && error.beforeDispatch) {
        // A preflight timeout or shutdown abort proves no workflow was sent,
        // not that the accepted workflow is invalid. Preserve it for a later
        // dispatch after fresh release checks, including across restarts.
        if (dispatched) await this.store.requeueUndispatched(record.id);
        this.verified = false;
        if (this.service.running && !this.service.settingsRestartPending && !job.signal.aborted) {
          this.fault = error.code || 'media_preflight_unavailable';
        }
        this.emit('deferred', record, { reason: error.code || 'media_preflight_unavailable' });
        return;
      }
      if (dispatched) {
        try { await this.store.update(record.id, { state: 'uncertain', error: error.code || 'media_completion_uncertain' }); }
        catch { this.fault = 'media_state_unavailable'; }
      } else {
        // Preparation failure may have left memory release in flight. Keep
        // the job queued but block dispatch until a gated verification passes.
        this.fault = error.code || 'media_preparation_failed';
      }
      this.emit('blocked', record, { reason: error.code || 'media_completion_uncertain' });
    } finally {
      this.scheduled.delete(record.id);
      this.service.scheduler.currentBackendType = 'comfyui';
      job.settle({ type: 'media_finished' });
      job.finish({});
    }
  }

  async finish(record, result, signal, reconciled = false) {
    const adapter = this.adapters.get(record.backend);
    // Terminal history proves this workflow ended; now evict its models and
    // prove physical release before allowing any other GPU work.
    await this.releaseComfy(signal);
    await this.verifyPhysicalRelease(signal);
    this.verified = true;
    if (result.state === 'completed') {
      try {
        const history = (await adapter.history(record.id, { signal }))[record.id];
        if (this.store.setComfyHistory) await this.store.setComfyHistory(record.id, history);
        for (const artifact of result.artifacts || []) {
          const response = await adapter.artifactResponse(artifact, { maxBytes: this.settings.max_output_bytes, signal });
          try { await this.store.saveArtifact(record.id, { name: artifact.filename, key: JSON.stringify(artifact),
            contentType: response.headers.get('content-type'), stream: Readable.fromWeb(response.body) }); }
          finally { response.cleanup?.(); }
        }
      } catch {
        // GPU work is certainly complete even if disk/download fails. Never
        // repeat a costly generation just because copying its result failed.
        await this.store.update(record.id, { state: 'failed', error: 'media_output_copy_failed' }, { reconciled });
        this.emit('failed', record, { reason: 'media_output_copy_failed' });
        return;
      }
      await this.store.update(record.id, { state: 'completed' }, { reconciled });
      // Delete ONLY bridge-registered, owned output copies after successful
      // import. The broker copy is retained according to its disk policy.
      try { await adapter.deleteArtifacts(record.id, result.artifacts || []); }
      catch { this.emit('cleanup_deferred', record); }
    } else {
      await this.store.update(record.id, { state: result.state === 'interrupted' ? 'cancelled' : 'failed',
        error: result.state === 'interrupted' ? 'media_interrupted' : 'media_workflow_failed' }, { reconciled });
    }
    await this.store.cleanup();
    this.emit(result.state, record);
  }

  async reconcile(signal) {
    if (!this.enabled || !this.loaded || this.reconciling) return;
    this.reconciling = (async () => {
      for (const record of this.store.unresolved()) {
        const adapter = this.adapters.get(record.backend);
        if (!adapter) continue;
        const result = await adapter.inspect(record.id, { signal });
        if (result.terminal && terminal.has(result.state)) await this.finish(record, result, signal, true);
      }
      if (this.fault && this.fault !== 'media_state_unavailable' && !this.store.unresolved().length) {
        // Read-only/eviction verification is safe to retry; generation is not.
        await this.releaseOllama(signal);
        await this.releaseComfy(signal);
        await this.verifyPhysicalRelease(signal);
        this.fault = null;
        this.verified = true;
      }
    })().finally(() => { this.reconciling = null; });
    return this.reconciling;
  }

  async cancel(id) {
    const record = this.store.getInternal(id);
    if (!record) throw problem('media_job_not_found', 404);
    if (record.state === 'queued') {
      await this.store.cancel(id);
      const scheduled = this.scheduled.get(id);
      if (scheduled) {
        if (this.service.scheduler.active === scheduled) scheduled.abortController.abort(problem('media_job_cancelled'));
        else this.service.scheduler.cancel(scheduled);
      }
      this.scheduled.delete(id);
      this.emit('cancelled', record);
      return;
    }
    // Cancel targets only the broker's currently running prompt. A lost
    // connection or interrupt acknowledgment never releases the GPU gate.
    if (record.state === 'running' && this.service.scheduler.active?.mediaId === id) {
      await this.adapters.get(record.backend).interrupt(id, { ownedPromptId: id });
      return;
    }
    throw problem('media_job_not_cancellable', 409);
  }

  async acknowledge(signal, beforeAcknowledge = () => {}) {
    // Caller separately requires maintenance auth + explicit host verification.
    if (!this.enabled) throw problem('enable_media_to_verify_recovery', 409);
    await this.releaseOllama(signal);
    await this.releaseComfy(signal);
    await this.verifyPhysicalRelease(signal);
    beforeAcknowledge();
    for (const record of this.store.unresolved()) {
      beforeAcknowledge();
      await this.store.update(record.id, { state: 'failed', error: 'operator_verified_service_stopped' }, { reconciled: true });
    }
    beforeAcknowledge();
    this.fault = null;
    this.verified = true;
  }
}
