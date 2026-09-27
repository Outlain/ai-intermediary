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
const MiB = 1024 * 1024;
const cleanupRetryDelays = [5_000, 15_000, 60_000];
const bridgeReleaseErrors = new Set(['release_evidence_changed', 'release_flag_request_failed', 'release_flag_read_failed',
  'release_flags_incomplete', 'release_sequence_incomplete', 'release_worker_mismatch', 'release_unload_failed',
  'release_unload_unconfirmed', 'release_cache_failed', 'release_cleanup_unverified', 'release_invalidated_by_submission']);

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
    this.releaseProofs = new Map();
    this.releaseStatus = null;
    this.cleanupAttempts = 0;
    this.nextCleanupRetry = 0;
    this.nextObservationRetry = 0;
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
      release: this.releaseStatus ? { ...this.releaseStatus, attempts: this.cleanupAttempts,
        automatic_retry_exhausted: this.cleanupAttempts >= cleanupRetryDelays.length,
        next_retry_at: this.nextCleanupRetry ? new Date(this.nextCleanupRetry).toISOString() : null } : null,
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
    for (const [backend, adapter] of this.adapters) {
      this.releaseProofs.delete(backend);
      this.releaseStatus = { phase: 'comfy', backend, reason: 'comfy_unload_pending' };
      try {
        const initial = await this.bridge(adapter, signal);
        const queue = await adapter.queue({ signal });
        if (queue.queue_running.length || queue.queue_pending.length) throw problem('comfy_external_or_unfinished_work');
        const supportsProof = initial.release_proof?.supported === true;
        // Rejoin an in-flight native cleanup after a timeout instead of
        // endlessly issuing new unloads (or abandoning its completion proof).
        const pendingId = initial.release_proof?.request_id;
        const requestId = supportsProof ? (!initial.release_proof.completed && !initial.release_proof.error
          && typeof pendingId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(pendingId)
          ? pendingId : randomUUID()) : null;
        // Old bridges never receive a relaxed allocator limit. HTTP /free
        // acknowledgment, low utilization and an empty queue are not proof.
        const maxReservedBytes = supportsProof ? (this.settings.max_idle_torch_vram_mb ?? 0) * MiB : 0;
        if (supportsProof) await adapter.requestRelease({ requestId, signal });
        else await adapter.requestFree({ signal });
        const deadline = Date.now() + this.config.gpu_safety.unloadTimeoutMs;
        while (Date.now() < deadline && !signal?.aborted) {
          const evidence = await adapter.releaseEvidence({ maxReservedBytes, signal });
          const current = supportsProof ? await this.bridge(adapter, signal) : null;
          if (supportsProof && (current.instance_id !== initial.instance_id || current.release_proof?.supported !== true
            || current.release_proof.request_id !== requestId)) throw problem('comfy_release_proof_changed');
          if (current?.release_proof?.error) throw problem(bridgeReleaseErrors.has(current.release_proof.error)
            ? current.release_proof.error : 'comfy_release_proof_invalid');
          const proved = !supportsProof || this.validReleaseProof(current, { instanceId: initial.instance_id, requestId });
          this.releaseStatus = { phase: 'comfy', backend,
            reason: !proved ? 'comfy_unload_pending' : evidence.reason || (evidence.released ? null : 'comfy_release_unconfirmed'),
            reserved_bytes: evidence.memory?.reserved_bytes ?? null,
            active_bytes: evidence.memory?.active_bytes ?? null, max_reserved_bytes: maxReservedBytes };
          if (evidence.idle && evidence.released && proved) {
            this.releaseProofs.set(backend, supportsProof ? { instanceId: initial.instance_id, requestId } : null);
            break;
          }
          await delay(Math.min(500, this.settings.pollIntervalMs), undefined, { signal });
        }
        if (!this.releaseProofs.has(backend)) throw problem(this.releaseStatus.reason || 'comfy_release_unconfirmed');
      } catch (error) {
        this.releaseStatus.reason = error.code || 'comfy_release_unconfirmed';
        this.deferCleanupRetry();
        throw error;
      }
    }
  }

  validReleaseProof(info, expected) {
    const proof = info?.release_proof;
    return typeof expected?.instanceId === 'string' && info?.instance_id === expected.instanceId
      && proof?.supported === true && proof.request_id === expected.requestId
      && proof.completed === true && proof.loaded_models === 0 && proof.error === null;
  }

  clearReleaseFailure() {
    this.releaseStatus = null;
    this.cleanupAttempts = 0;
    this.nextCleanupRetry = 0;
    this.nextObservationRetry = 0;
  }

  deferCleanupRetry() {
    if (!this.cleanupAttempts && !this.nextCleanupRetry) this.nextCleanupRetry = Date.now() + cleanupRetryDelays[0];
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
      let reason = null;
      if (!host.available || !host.bound || host.stale || host.sampled_at == null || host.gpus.length !== 1) reason = 'host_gpu_evidence_unavailable';
      else if (host.gpus.some((gpu) => !gpu.processes_known || !Array.isArray(gpu.processes)
        || gpu.processes.some((process) => !process.is_ollama && !process.is_comfyui))) reason = 'gpu_process_ownership_unconfirmed';
      else if (host.gpus.some((gpu) => !Number.isFinite(gpu.vram_used_bytes) || gpu.vram_used_bytes < 0
        || gpu.vram_used_bytes > this.settings.max_idle_vram_mb * MiB)) reason = 'physical_vram_above_idle_limit';
      else if (host.gpus.some((gpu) => !Number.isFinite(gpu.utilization_percent) || gpu.utilization_percent < 0
        || gpu.utilization_percent > this.settings.max_idle_utilization_percent)) reason = 'gpu_activity_above_idle_limit';
      const safe = reason === null;
      this.releaseStatus = { ...this.releaseStatus, phase: 'physical', reason: reason || 'gpu_idle_samples_pending',
        physical_vram_bytes: host.gpus[0]?.vram_used_bytes ?? null,
        max_physical_vram_bytes: this.settings.max_idle_vram_mb * MiB, sampled_at: host.sampled_at };
      if (safe && host.sampled_at !== lastSample) samples += 1;
      if (!safe) samples = 0;
      lastSample = host.sampled_at;
      if (samples >= this.settings.stable_samples) return;
      await delay(Math.min(1000, this.settings.pollIntervalMs), undefined, { signal });
    }
    this.deferCleanupRetry();
    throw problem(this.releaseStatus?.reason || 'physical_gpu_release_unconfirmed');
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
    this.clearReleaseFailure();
  }

  async prepareOllama(signal) {
    if (this.blocked) throw problem('media_recovery_required');
    if (!this.enabled) return;
    if (!this.verified) await this.quiesce(signal);
    // A raw backend queue that appeared outside this broker is not ours to
    // clear or interrupt. Refuse dispatch instead of guessing it is harmless.
    for (const [backend, adapter] of this.adapters) {
      const info = await this.bridge(adapter, signal);
      const proof = this.releaseProofs.get(backend);
      if (proof && !this.validReleaseProof(info, proof)) throw problem('comfy_release_proof_changed');
      const maxReservedBytes = proof ? (this.settings.max_idle_torch_vram_mb ?? 0) * MiB : 0;
      const evidence = await adapter.releaseEvidence({ maxReservedBytes, signal });
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
      this.releaseProofs.clear();
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

  async finish(record, result, signal, reconciled = false, { allowCleanup = true, beforeCleanup = () => {} } = {}) {
    const adapter = this.adapters.get(record.backend);
    // Persist terminal evidence and rescue output bytes BEFORE any unload.
    // Execution completion is not GPU release: the unresolved durable state
    // and shared operation gate remain in place throughout this work.
    let saved = this.store.getInternal(record.id);
    if (!saved.execution) {
      const history = result.history ?? (await adapter.history(record.id, { signal }))[record.id];
      await this.store.setComfyHistory(record.id, history, {
        state: result.state, artifacts: result.artifacts || [],
      });
      saved = this.store.getInternal(record.id);
    }
    const execution = saved.execution;
    let copyFailed = false;
    if (execution.state === 'completed' && !saved.outputsImported) {
      try {
        for (const artifact of execution.artifacts) {
          const response = await adapter.artifactResponse(artifact, { maxBytes: this.settings.max_output_bytes, signal });
          try { await this.store.saveArtifact(record.id, { name: artifact.filename, key: JSON.stringify(artifact),
            contentType: response.headers.get('content-type'), stream: Readable.fromWeb(response.body) }); }
          finally { response.cleanup?.(); }
        }
        await this.store.update(record.id, { outputsImported: true });
        this.emit('outputs_ready', this.store.get(record.id));
      } catch {
        copyFailed = true;
      }
    }
    // Even when cleanup retries are exhausted, keep discovering and importing
    // completed results. A read/transport problem must not consume the cleanup
    // budget or leave a later successful video undiscoverable.
    if (!allowCleanup) return;
    beforeCleanup();
    // Neither an imported output nor a terminal execution record authorizes
    // another GPU dispatch. This verification is deliberately still mandatory.
    await this.releaseComfy(signal);
    await this.verifyPhysicalRelease(signal);
    this.verified = true;
    if (copyFailed) {
      await this.store.update(record.id, { state: 'failed', error: 'media_output_copy_failed' }, { reconciled });
      this.emit('failed', record, { reason: 'media_output_copy_failed' });
      if (!reconciled) this.clearReleaseFailure();
      return;
    }
    if (execution.state === 'completed') {
      await this.store.update(record.id, { state: 'completed', error: null }, { reconciled });
      // Delete ONLY bridge-registered, owned output copies after successful
      // import. The broker copy is retained according to its disk policy.
      try { await adapter.deleteArtifacts(record.id, execution.artifacts); }
      catch { this.emit('cleanup_deferred', record); }
    } else {
      await this.store.update(record.id, { state: execution.state === 'interrupted' ? 'cancelled' : 'failed',
        error: execution.state === 'interrupted' ? 'media_interrupted' : 'media_workflow_failed' }, { reconciled });
    }
    await this.store.cleanup();
    this.emit(execution.state, record);
    if (!reconciled) this.clearReleaseFailure();
  }

  async reconcile(signal, { automatic = false } = {}) {
    if (!this.enabled || !this.loaded || this.reconciling) return;
    if (automatic && Date.now() < this.nextObservationRetry) return;
    const allowCleanup = !automatic || (this.cleanupAttempts < cleanupRetryDelays.length && Date.now() >= this.nextCleanupRetry);
    let cleanupAttempted = false;
    this.reconciling = (async () => {
      for (const record of this.store.unresolved()) {
        const adapter = this.adapters.get(record.backend);
        if (!adapter) continue;
        // ComfyUI's in-memory history may be gone after an OOM/restart. Use
        // only previously persisted terminal evidence, never an empty queue.
        const saved = this.store.getInternal(record.id);
        const result = saved.execution ? { ...saved.execution, terminal: true }
          : await adapter.inspect(record.id, { signal });
        if (result.terminal && terminal.has(result.state)) await this.finish(record, result, signal, true,
          { allowCleanup, beforeCleanup: () => { cleanupAttempted = true; } });
      }
      if (allowCleanup && this.fault && this.fault !== 'media_state_unavailable' && !this.store.unresolved().length) {
        // Read-only/eviction verification is safe to retry; generation is not.
        cleanupAttempted = true;
        await this.releaseOllama(signal);
        await this.releaseComfy(signal);
        await this.verifyPhysicalRelease(signal);
        this.fault = null;
        this.verified = true;
      }
      if (!this.blocked) this.clearReleaseFailure();
    })().catch((error) => {
      if (!signal?.aborted) {
        if (cleanupAttempted) {
          this.cleanupAttempts += 1;
          this.nextCleanupRetry = this.cleanupAttempts < cleanupRetryDelays.length
            ? Date.now() + cleanupRetryDelays[this.cleanupAttempts] : 0;
          this.releaseStatus = { ...this.releaseStatus, phase: this.releaseStatus?.phase || 'comfy',
            reason: error.code || 'media_reconciliation_unavailable' };
        } else {
          // Keep read-only completion observation alive after transient history
          // failures; it never authorizes another generation or GPU handoff.
          this.nextObservationRetry = Date.now() + 5_000;
        }
        this.service.scheduler.wake();
      }
      throw error;
    }).finally(() => { this.reconciling = null; });
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
      const completed = record.execution_state === 'completed' && record.outputsImported;
      await this.store.update(record.id, { state: completed ? 'completed' : 'failed',
        error: completed ? null : 'operator_verified_service_stopped' }, { reconciled: true });
    }
    beforeAcknowledge();
    this.fault = null;
    this.verified = true;
    this.clearReleaseFailure();
  }
}
