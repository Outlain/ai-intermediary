import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const RECOVERABLE = new Set(['upstream_disconnected', 'upstream_completion_uncertain',
  'model_unload_failed', 'gpu_memory_fault', 'restored_attempt_uncertain']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const safeCode = (value) => typeof value === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(value) ? value : 'recovery_check_failed';
const identity = (value) => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value);

/** Only a proven service replacement can automatically resolve ambiguous
 * inference. Idle VRAM, a 200 probe, or a native failure callback alone cannot.
 * This controller never changes the operator's maintenance pause state. */
export class AutomaticRecovery {
  constructor(config, dependencies) {
    Object.assign(this, dependencies);
    this.settings = config.auto_recovery;
    this.healthTimeoutMs = config.ollama.healthTimeoutMs;
    this.clock ??= () => Date.now();
    this.state = 'disabled';
    this.reason = null;
    this.lastError = null;
    this.lastCheckAt = null;
    this.manualRequested = false;
    this.busy = null;
    this.timer = null;
    this.controller = new AbortController();
    this.saved = { schema_version: 1, history: [], episode: null, current: null };
    this.storageError = null;
    if (this.settings.enabled) { this.restore(); this.state = this.storageError ? 'needs_attention' : 'idle'; }
  }

  restore() {
    try {
      if (fs.statSync(this.settings.state_path).size > 65_536) throw new Error('large_state');
      const data = JSON.parse(fs.readFileSync(this.settings.state_path, 'utf8'));
      if (data.schema_version !== 1 || !Array.isArray(data.history) || data.history.length > 128
        || data.history.some((entry) => !UUID.test(entry.id) || !Number.isFinite(entry.at))) throw new Error('invalid_state');
      if (data.episode && (typeof data.episode.key !== 'string' || data.episode.key.length > 128
        || !Number.isSafeInteger(data.episode.attempts) || data.episode.attempts < 0
        || (data.episode.failed_replacement !== undefined && !identity(data.episode.failed_replacement)))) throw new Error('invalid_episode');
      if (data.current && (!UUID.test(data.current.id) || !identity(data.current.before)
        || !['pending', 'verifying', 'failed', 'uncertain', 'completed'].includes(data.current.phase)
        || !Number.isFinite(data.current.started_at)
        || typeof data.current.episode !== 'string'
        || (data.current.recheckable !== undefined && typeof data.current.recheckable !== 'boolean')
        || (data.current.recheckable === true && !Number.isFinite(data.current.reconciliation_deadline))
        || (data.current.source !== undefined && data.current.source !== 'external')
        || (['verifying', 'completed'].includes(data.current.phase) && (!identity(data.current.after)
          || data.current.before === data.current.after || !Number.isFinite(data.current.deadline))))) throw new Error('invalid_operation');
      this.saved = { schema_version: 1, history: data.history, episode: data.episode ?? null, current: data.current ?? null };
      // Stable observations are deliberately not trusted across a restart.
      if (this.saved.current) { this.saved.current.samples = 0; this.saved.current.last_sample_at = null; }
    } catch (error) {
      if (error.code !== 'ENOENT') this.storageError = 'automatic_recovery_state_unreadable';
    }
  }

  persist() {
    const target = this.settings.state_path;
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(this.saved)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, target);
      const directory = fs.openSync(path.dirname(target), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch {
      try { fs.unlinkSync(temporary); } catch { /* not created */ }
      this.storageError = 'automatic_recovery_state_unwritable';
      throw Object.assign(new Error(this.storageError), { code: this.storageError });
    }
  }

  episodeKey() { return `${this.backend.recoverySince}:${this.backend.recoveryCode}`; }
  manualAuthorized() { return this.manualRequested && this.manualRevision === (this.maintenance.revision ?? 0); }
  recent() { return this.saved.history.filter((entry) => entry.at > this.clock() - this.settings.windowMs); }
  cooldownMs() {
    const latest = this.saved.history.at(-1)?.at;
    return latest === undefined ? 0 : Math.max(0, latest + this.settings.cooldownMs - this.clock());
  }

  status() {
    const failure = this.helper.snapshot().last_service_failure;
    return {
      enabled: this.settings.enabled, state: this.state, reason: this.reason,
      last_error: this.storageError ?? this.lastError,
      attempts_in_window: this.recent().length, max_restarts: this.settings.max_restarts,
      window_seconds: this.settings.windowMs / 1000,
      episode_attempts: this.saved.episode?.attempts ?? 0,
      cooldown_remaining_seconds: Math.ceil(this.cooldownMs() / 1000),
      host_available: this.helper.snapshot().available,
      last_check_at: this.lastCheckAt === null ? null : new Date(this.lastCheckAt).toISOString(),
      requires_attention: this.state === 'needs_attention' || Boolean(this.storageError),
      host_failure: this.backend.recoveryRequired && failure?.code === 'ollama_host_oom'
        && Date.parse(failure.observed_at) >= this.backend.recoverySince - 5000 ? failure.code : null,
    };
  }

  transition(state, reason = null) {
    const changed = this.state !== state || this.reason !== reason;
    this.state = state;
    this.reason = reason;
    if (changed) this.onEvent?.('automatic_recovery_state_changed', { state, reason });
    this.onChange?.();
  }

  start() {
    if (!this.settings.enabled) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.settings.checkIntervalMs);
    this.timer.unref?.();
  }

  async stop() {
    clearInterval(this.timer);
    this.controller.abort();
    if (this.busy) await this.busy;
  }

  checkNow() {
    if (!this.settings.enabled) throw Object.assign(new Error('automatic_recovery_disabled'), { code: 'automatic_recovery_disabled', statusCode: 409 });
    if (this.storageError) throw Object.assign(new Error(this.storageError), { code: this.storageError, statusCode: 503 });
    this.manualRequested = true;
    this.manualRevision = this.maintenance.revision ?? 0;
    // The HTTP request acknowledges scheduling, not recovery completion.
    this.tick();
    return this.status();
  }

  tick() {
    if (this.busy) return this.busy;
    if (!this.settings.enabled || this.controller.signal.aborted) return Promise.resolve();
    this.busy = this.runStep().catch((error) => {
      if (this.controller.signal.aborted) return;
      this.lastError = safeCode(error.code);
      this.transition('needs_attention', this.lastError);
    }).finally(() => { this.busy = null; });
    return this.busy;
  }

  async runStep() {
    this.lastCheckAt = this.clock();
    if (this.manualRequested && !this.manualAuthorized()) this.manualRequested = false;
    if (this.storageError) { this.transition('needs_attention', this.storageError); return; }
    if (this.backend.recoveryStorageError) { this.transition('needs_attention', 'recovery_state_error'); return; }
    if (this.blockedByServiceOrMedia()) return;
    if (!this.backend.recoveryRequired) {
      this.manualRequested = false;
      if (this.saved.current || this.saved.episode) {
        this.saved.current = null; this.saved.episode = null; this.persist();
      }
      if (this.state !== 'recovered') this.transition('idle');
      return;
    }
    if (!RECOVERABLE.has(this.backend.recoveryCode)) {
      this.transition('needs_attention', 'manual_recovery_required'); return;
    }
    const key = this.episodeKey();
    if (this.saved.episode?.key !== key) {
      this.saved.episode = { key, attempts: 0 };
      this.saved.current = null;
      this.persist();
    }
    const current = this.saved.current;
    const verifying = current && (['verifying', 'completed'].includes(current.phase) || current.recheckable === true);
    // A persisted pending ID may never have reached the helper before a crash.
    // Replaying its POST is not necessarily read-only. Require fresh explicit
    // operator consent while paused, even though idempotency prevents repeats.
    if (this.maintenance.paused && !this.manualAuthorized() && !verifying) {
      this.transition('waiting', 'manual_pause'); return;
    }
    if (this.scheduler.active || this.gate.active || this.gate.managementPending || this.gate.maintenancePending) {
      this.transition('waiting', 'active_operation'); return;
    }
    const release = await this.gate.acquire('maintenance', this.controller.signal);
    try {
      if (this.blockedByServiceOrMedia() || this.scheduler.active || !this.backend.recoveryRequired || this.episodeKey() !== key) return;
      if (['verifying', 'completed'].includes(current?.phase)) return await this.verify(current, key);
      if (current && ['pending', 'uncertain'].includes(current.phase)) {
        if (current.recheckable === true) return await this.reconcileRestart(current);
        if (current.phase === 'uncertain' && !this.manualAuthorized()) {
          this.transition('needs_attention', 'restart_outcome_unknown'); return;
        }
        return await this.performRestart(current);
      }
      await this.helper.refresh();
      const host = this.helper.snapshot();
      if (!host.available || !host.bound) { this.transition('needs_attention', host.error || 'host_telemetry_unavailable'); return; }
      if (host.capabilities?.external_replacement && await this.adoptReplacement(key)) return;
      if (this.saved.episode.attempts >= this.settings.max_restarts) {
        this.transition('needs_attention', 'restart_limit_reached'); return;
      }
      if (this.recent().length >= this.settings.max_restarts) {
        this.transition('cooldown', 'restart_window_limit'); return;
      }
      if (this.cooldownMs() > 0) { this.transition('cooldown', 'restart_cooldown'); return; }
      if (host.service?.kill_mode !== 'control-group' || !identity(host.service?.invocation_id)) {
        this.transition('needs_attention', 'service_boundary_unavailable'); return;
      }
      if (!host.gpus.every((gpu) => gpu.processes_known && gpu.processes.every((process) => process.pid && process.is_ollama))) {
        this.transition('needs_attention', 'other_gpu_work_or_unknown_processes'); return;
      }
      if (host.restart_policy?.available === false) {
        this.transition(host.restart_policy.cooldown_remaining_seconds > 0 ? 'cooldown' : 'needs_attention',
          safeCode(host.restart_policy.error || 'host_restart_unavailable'));
        return;
      }
      // Recheck immediately before asking for a host mutation. A manual pause
      // that arrived during telemetry collection must not trigger a restart.
      if (this.blockedByServiceOrMedia() || !this.backend.recoveryRequired || this.episodeKey() !== key
        || (this.maintenance.paused && !this.manualAuthorized())) return;
      const operation = { id: randomUUID(), episode: key, before: host.service.invocation_id,
        phase: 'pending', started_at: this.clock(), samples: 0, last_sample_at: null,
        reconciliation_deadline: this.clock() + this.settings.restartTimeoutMs + this.settings.verificationTimeoutMs };
      this.saved.current = operation;
      this.saved.episode.attempts += 1;
      this.saved.history = [...this.recent(), { id: operation.id, at: operation.started_at }].slice(-128);
      // Persist BEFORE POST: timeouts and intermediary restarts reuse this ID.
      this.persist();
      await this.performRestart(operation);
    } finally { release(); }
  }

  async performRestart(operation) {
    // Even an idempotent replay may be the first delivery after a crash. Check
    // the current configured backend before every potentially mutating POST.
    await this.helper.refresh();
    const host = this.helper.snapshot();
    if (!host.bound || !host.available) {
      this.transition('needs_attention', host.error || 'host_telemetry_unavailable'); return;
    }
    if (this.blockedByServiceOrMedia()) return;
    if (this.maintenance.paused && !this.manualAuthorized()) {
      this.transition('waiting', 'manual_pause'); return;
    }
    this.transition('restarting', 'restarting_ollama_only');
    let result;
    try {
      result = await this.helper.restart(operation.id, operation.before, {
        timeoutMs: this.settings.restartTimeoutMs, signal: this.controller.signal,
      });
    } catch (error) {
      if (this.controller.signal.aborted) return; // retain durable pending ID
      this.lastError = safeCode(error.code);
      if (this.clock() - operation.started_at > this.settings.restartTimeoutMs + this.settings.verificationTimeoutMs) {
        operation.phase = 'uncertain'; this.manualRequested = false; this.persist();
        this.transition('needs_attention', 'restart_outcome_unknown');
      } else this.transition('waiting', 'checking_restart_outcome');
      return;
    }
    this.acceptRestartResult(operation, result);
  }

  acceptRestartResult(operation, result) {
    if (result?.operation_id !== operation.id) {
      operation.phase = 'uncertain'; this.manualRequested = false; this.persist();
      this.transition('needs_attention', 'restart_response_invalid'); return;
    }
    if (result.state === 'completed' && result.restarted === true
      && result.before_invocation_id === operation.before && identity(result.after_invocation_id)
      && result.after_invocation_id !== operation.before) {
      operation.after = result.after_invocation_id;
      operation.phase = 'verifying';
      operation.deadline = this.clock() + this.settings.verificationTimeoutMs;
      operation.samples = 0; operation.last_sample_at = null;
      operation.recheckable = false;
      this.persist();
      this.transition('verifying', 'checking_gpu_and_ollama');
      return;
    }
    this.lastError = safeCode(result.error || 'host_restart_failed');
    operation.phase = result.state === 'failed' ? 'failed' : 'uncertain';
    operation.recheckable = result.state === 'uncertain' && result.recheckable === true;
    operation.reconciliation_deadline ??= this.clock() + this.settings.verificationTimeoutMs;
    this.manualRequested = false;
    this.persist();
    this.transition(operation.recheckable ? 'verifying' : operation.phase === 'failed' && this.saved.episode.attempts < this.settings.max_restarts
      ? 'cooldown' : 'needs_attention', operation.recheckable ? 'waiting_for_restart_settle' : this.lastError);
  }

  async reconcileRestart(operation) {
    // A GET cannot dispatch another restart, including while manually paused.
    // Old records without worker proof still require operator verification.
    if (!Number.isFinite(operation.reconciliation_deadline)) {
      this.transition('needs_attention', 'restart_outcome_unknown'); return;
    }
    if (this.manualAuthorized()) {
      operation.reconciliation_deadline = this.clock() + this.settings.verificationTimeoutMs;
      this.manualRequested = false; this.persist();
    }
    if (this.clock() >= operation.reconciliation_deadline) {
      this.transition('needs_attention', 'restart_verification_timeout'); return;
    }
    await this.helper.refresh();
    const host = this.helper.snapshot();
    if (!host.bound || !host.available) { this.transition('waiting', host.error || 'host_telemetry_unavailable'); return; }
    try {
      const result = await this.helper.reconcile(operation.id, { signal: this.controller.signal,
        timeoutMs: Math.max(1, Math.min(this.healthTimeoutMs, operation.reconciliation_deadline - this.clock())) });
      if (this.clock() >= operation.reconciliation_deadline) { this.transition('needs_attention', 'restart_verification_timeout'); return; }
      this.acceptRestartResult(operation, result);
    } catch (error) {
      this.lastError = safeCode(error.code);
      this.transition('waiting', 'checking_restart_outcome');
    }
  }

  async adoptReplacement(key) {
    try {
      const proof = await this.helper.replacement(this.backend.recoverySince, {
        timeoutMs: this.healthTimeoutMs, signal: this.controller.signal });
      if (proof?.state !== 'completed' || proof.service_replaced !== true
        || proof.started_after !== this.backend.recoverySince / 1000 || !identity(proof.before_invocation_id)
        || !identity(proof.after_invocation_id) || proof.before_invocation_id === proof.after_invocation_id) return false;
      // Do not give the same already-failed replacement an endless fresh
      // verification window. A different service epoch may still qualify.
      if (this.saved.episode.failed_replacement === proof.after_invocation_id
        || (this.saved.current?.phase === 'failed' && this.saved.current.after === proof.after_invocation_id)) return false;
      if (this.blockedByServiceOrMedia() || this.episodeKey() !== key || !this.backend.recoveryRequired) return true;
      this.saved.current = { id: randomUUID(), episode: key, source: 'external', phase: 'verifying',
        before: proof.before_invocation_id, after: proof.after_invocation_id,
        started_at: this.backend.recoverySince, deadline: this.clock() + this.settings.verificationTimeoutMs,
        samples: 0, last_sample_at: null };
      this.persist();
      this.transition('verifying', 'verifying_existing_service_restart');
      return true;
    } catch (error) {
      if (this.storageError) throw error;
      // A known new service may just be discovering the GPU. Give it time;
      // absence of a replacement/proof falls back to the bounded restart path.
      if (['gpu_processes_after_restart', 'gpu_active_after_restart', 'gpu_vram_after_restart',
        'gpu_utilization_unknown', 'old_ollama_workers_present', 'service_changed_during_sample'].includes(error.code)
        && this.clock() < this.backend.recoverySince + this.settings.verificationTimeoutMs) {
        this.transition('waiting', 'waiting_for_restart_settle'); return true;
      }
      return false;
    }
  }

  async verify(operation, key) {
    this.transition('verifying', 'checking_gpu_and_ollama');
    if (this.clock() >= operation.deadline) return this.verificationFailed(operation, 'verification_timeout');
    await this.helper.refresh({ timeoutMs: Math.max(1, operation.deadline - this.clock()) });
    if (this.clock() >= operation.deadline) return this.verificationFailed(operation, 'verification_timeout');
    const host = this.helper.snapshot();
    const stableHardware = host.available && host.bound && host.service?.active === true
      && host.service.invocation_id === operation.after && host.service.kill_mode === 'control-group'
      && host.gpus.every((gpu) => gpu.processes_known && gpu.processes.length === 0
        && Number.isFinite(gpu.vram_used_bytes) && Number.isFinite(gpu.vram_total_bytes)
        && gpu.vram_total_bytes > 0 && gpu.vram_used_bytes <= gpu.vram_total_bytes
        && gpu.vram_used_bytes <= this.settings.max_idle_vram_mb * 1024 * 1024
        && Number.isFinite(gpu.utilization_percent) && gpu.utilization_percent <= 1);
    let empty = false;
    if (stableHardware) {
      try { empty = (await this.backendClient.loadedModels(this.controller.signal,
        Math.max(1, Math.min(this.healthTimeoutMs, operation.deadline - this.clock())))).length === 0; }
      catch { this.lastError = 'ollama_verification_unavailable'; }
    }
    const sampleAt = Date.parse(host.sampled_at);
    if (stableHardware && empty && sampleAt >= operation.started_at
      && (operation.last_sample_at === null || sampleAt - operation.last_sample_at >= this.settings.checkIntervalMs)) {
      operation.samples += 1;
      operation.last_sample_at = sampleAt;
    } else if (!stableHardware || !empty) {
      operation.samples = 0;
      operation.last_sample_at = null;
    }
    if (this.clock() >= operation.deadline) return this.verificationFailed(operation, 'verification_timeout');
    if (operation.samples >= this.settings.stable_samples) {
      if (this.blockedByServiceOrMedia() || !this.backend.recoveryRequired || this.episodeKey() !== key) return;
      // Recovery state is not a substitute for a healthy backend API.
      await this.backend.probe();
      if (this.blockedByServiceOrMedia() || !this.backend.reachable || this.episodeKey() !== key) return;
      operation.phase = 'completed';
      this.persist();
      if (this.catchup.requiresRecovery) this.catchup.acknowledgeRecovery();
      this.backend.clearRecovery();
      this.scheduler.reconcile(null);
      this.lastError = null;
      this.manualRequested = false;
      this.onEvent?.('automatic_recovery_completed', { reason: 'service_replaced_and_gpu_verified', paused: this.maintenance.paused });
      this.transition('recovered', this.maintenance.paused ? 'manual_pause_preserved' : 'inference_reenabled');
      this.scheduler.wake();
    }
  }

  blockedByServiceOrMedia() {
    if (this.isStopping()) { this.transition('waiting', 'service_stopping'); return true; }
    if (this.mediaBlocked?.()) { this.transition('needs_attention', 'media_recovery_required'); return true; }
    return false;
  }

  verificationFailed(operation, reason) {
    if (operation.after) this.saved.episode.failed_replacement = operation.after;
    operation.phase = 'failed'; this.manualRequested = false; this.persist();
    this.lastError = reason;
    this.transition(this.saved.episode.attempts < this.settings.max_restarts ? 'cooldown' : 'needs_attention', reason);
  }
}
