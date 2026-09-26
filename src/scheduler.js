import { safeDisplay } from './observability.js';

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

export function createJob(fields) {
  const result = deferred();
  const finished = deferred();
  return {
    ...fields,
    enqueuedAt: fields.enqueuedAt ?? Date.now(),
    state: 'new',
    result: result.promise,
    settle: result.resolve,
    finished: finished.promise,
    finish: finished.resolve,
  };
}

export class Scheduler {
  constructor(config, { logger, metrics, observability = null, clock = () => Date.now(), pauseCheck = () => null }) {
    this.config = config;
    this.logger = logger;
    this.metrics = metrics;
    this.observability = observability;
    this.clock = clock;
    this.pauseCheck = pauseCheck;
    this.jobs = [];
    this.active = null;
    this.currentModel = null;
    this.currentModelGroup = null;
    this.currentClient = null;
    this.leaseClient = null;
    this.lastActivity = null;
    this.leaseUntil = 0;
    this.batchModel = null;
    this.batchPolicy = null;
    this.batchStartedAt = 0;
    this.batchCount = 0;
    this.switches = 0;
    this.accepting = true;
    this.paused = false;
    this.waiters = new Set();
  }

  modelPolicy(model, client = null) {
    return (Object.hasOwn(this.config.models, model) ? this.config.models[model] : null)
      ?? (client ? this.config.clients[client]?.model_policy : null)
      ?? this.config.clients.default.model_policy;
  }

  get strictPriority() {
    return this.config.scheduler.mode !== 'balanced';
  }

  requestBytes(job) {
    if (!job) return 0;
    if (typeof job.body === 'string') return Buffer.byteLength(job.body);
    return job.body?.byteLength ?? job.requestSummary?.body_bytes ?? 0;
  }

  memoryUsage() {
    const queued = this.jobs.reduce((total, job) => total + (job.state === 'queued' ? this.requestBytes(job) : 0), 0);
    const active = this.requestBytes(this.active);
    return { queued, active, total: queued + active, limit: this.config.scheduler.max_queue_bytes ?? 128 * 1024 * 1024 };
  }

  enqueue(job) {
    if (!this.accepting) return { accepted: false, status: 503, code: 'shutting_down', message: 'proxy is shutting down' };
    const blocked = this.pauseReason(job);
    if (blocked && !job.restoredDurable && !this.mayQueuePaused(job, blocked)) return { accepted: false, status: 503, code: blocked.reason, message: 'This source is paused; retry after it resumes.' };
    this.expire();
    const clientPolicy = this.config.clients[job.client];
    let sameClient = this.jobs.filter((item) => item.client === job.client && item.state === 'queued');
    const replacements = [];

    if (job.dedupeKey) {
      const duplicate = sameClient.find((item) => item.dedupeKey === job.dedupeKey
        && (item.trafficClass === 'catchup') === (job.trafficClass === 'catchup'));
      if (duplicate) {
        replacements.push({ job: duplicate, code: 'superseded', message: 'request was superseded by a newer equivalent request' });
        sameClient = sameClient.filter((item) => item !== duplicate);
      }
    }

    if (sameClient.length >= clientPolicy.queue_limit) {
      const victim = sameClient.find((item) => !item.durable && item.trafficClass === 'catchup')
        ?? (job.trafficClass === 'catchup' || job.durable ? null : sameClient.find((item) => !item.durable));
      if (clientPolicy.overflow_policy === 'drop_oldest' && victim) {
        replacements.push({ job: victim, code: 'queue_overflow_drop_oldest', message: 'request was dropped to admit newer work' });
      } else {
        const code = clientPolicy.overflow_policy === 'drop_newest' ? 'queue_overflow_drop_newest' : 'queue_full';
        this.metrics.increment('proxy_requests_dropped_total', { client: job.client, reason: code });
        return { accepted: false, status: 429, code, message: `queue for ${job.client} is full` };
      }
    }

    const memory = this.memoryUsage();
    const replacedBytes = replacements.reduce((total, replacement) => total + this.requestBytes(replacement.job), 0);
    if (memory.total - replacedBytes + this.requestBytes(job) > memory.limit) {
      this.metrics.increment('proxy_requests_dropped_total', { client: job.client, reason: 'queue_bytes_exceeded' });
      return { accepted: false, status: 429, code: 'queue_bytes_exceeded', message: 'aggregate request body memory limit reached; retry later' };
    }
    for (const replacement of replacements) this.drop(replacement.job, 429, replacement.code, replacement.message);

    job.state = 'queued';
    // Accepted media is a durable task, not a waiting HTTP connection. Its
    // execution timeout starts at dispatch; pauses do not discard it.
    job.deadline = job.durable ? Infinity : job.enqueuedAt + clientPolicy.requestTtlMs;
    job.maxWaitAt = clientPolicy.maxWaitMs > 0 ? job.enqueuedAt + clientPolicy.maxWaitMs : Infinity;
    this.jobs.push(job);
    this.metrics.increment('proxy_requests_total', { client: job.client, endpoint: job.pathname });
    this.logger.info('request queued', {
      request_id: job.id, detected_client: job.client, identification_method: job.identificationMethod,
      requested_model: job.model, endpoint: job.pathname, request_type: job.requestType,
      request_bytes: job.requestSummary?.body_bytes,
      queue_entry_time: new Date(job.enqueuedAt).toISOString(), streaming: job.streaming,
    });
    this.metrics.observe('proxy_request_body_bytes', job.requestSummary?.body_bytes ?? job.body?.length ?? 0, {
      client: job.client, endpoint: job.pathname,
    });
    this.metrics.observe('proxy_request_input_characters', job.requestSummary?.input_characters ?? 0, {
      client: job.client, endpoint: job.pathname,
    });
    this.observability?.record('request_queued', this.eventFields(job, {
      queued_at: new Date(job.enqueuedAt).toISOString(),
    }));
    this.wake();
    return { accepted: true };
  }

  drop(job, status, code, message) {
    if (job.state !== 'queued') return false;
    const index = this.jobs.indexOf(job);
    if (index >= 0) this.jobs.splice(index, 1);
    job.state = 'dropped';
    this.metrics.increment('proxy_requests_dropped_total', { client: job.client, reason: code });
    job.settle({ type: 'local_error', status, code, message });
    this.logger.warn('queued request dropped', {
      request_id: job.id, detected_client: job.client, requested_model: job.model, reason: code,
      queue_wait: (this.clock() - job.enqueuedAt) / 1000,
    });
    this.observability?.record('request_dropped', this.eventFields(job, {
      status, reason: code, queue_wait_seconds: (this.clock() - job.enqueuedAt) / 1000,
    }));
    return true;
  }

  cancel(job) {
    if (job.state !== 'queued') return false;
    const index = this.jobs.indexOf(job);
    if (index >= 0) this.jobs.splice(index, 1);
    job.state = 'cancelled';
    job.settle({ type: 'local_error', status: 499, code: 'client_closed', message: 'client disconnected while queued' });
    this.metrics.increment('proxy_requests_dropped_total', { client: job.client, reason: 'client_disconnect' });
    this.logger.info('queued request cancelled', {
      request_id: job.id, detected_client: job.client, requested_model: job.model,
      queue_wait: (this.clock() - job.enqueuedAt) / 1000,
    });
    this.observability?.record('request_cancelled', this.eventFields(job, {
      status: 499, reason: 'client_disconnect', queue_wait_seconds: (this.clock() - job.enqueuedAt) / 1000,
    }));
    this.wake();
    return true;
  }

  expire(now = this.clock()) {
    for (const job of [...this.jobs]) {
      if (job.state === 'queued' && job.deadline <= now) {
        this.drop(job, 408, 'queue_ttl_expired', 'request expired while waiting in the scheduling queue');
      }
    }
  }

  failQueued(status, code, message) {
    for (const job of [...this.jobs]) if (!job.durable) this.drop(job, status, code, message);
  }

  effectivePriority(job, now) {
    const client = this.config.clients[job.client];
    if (this.strictPriority || !this.config.scheduler.priority_aging) return client.priority;
    const intervals = Math.floor((now - job.enqueuedAt) / this.config.scheduler.agingIntervalMs);
    return client.priority + intervals * this.config.scheduler.aging_bonus;
  }

  pauseReason(job) {
    return this.pauseCheck(job.client, job.trafficClass ?? 'live')
      ?? (this.paused ? { reason: 'maintenance_paused' } : null);
  }

  mayQueuePaused(job, blocked) {
    return job.trafficClass !== 'catchup' && this.config.clients[job.client]?.queue_while_paused === true
      && !['source_disabled', 'pause_state_error'].includes(blocked.reason);
  }

  enforcePauses() {
    for (const job of [...this.jobs]) {
      const blocked = this.pauseReason(job);
      if (blocked && !job.durable && !this.mayQueuePaused(job, blocked)) this.drop(job, 503, blocked.reason, 'This source is paused; retry after it resumes.');
    }
    this.expire();
    this.wake();
  }

  candidates() {
    const seen = new Set();
    const result = [];
    for (const job of this.jobs) {
      if (job.state !== 'queued' || job.signal?.aborted || this.pauseReason(job)) continue;
      const key = `${job.client}\u0000${job.backend ?? ''}\u0000${job.model}\u0000${job.trafficClass === 'catchup' ? 'catchup' : 'live'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(job);
    }
    // Native catch-up may arrive after a live request was admitted. Do not let
    // model affinity, aging, or an older same-model job hide live work.
    const live = result.filter((job) => job.trafficClass !== 'catchup');
    return live.length ? live : result;
  }

  best(candidates, now) {
    return [...candidates].sort((left, right) => {
      const priority = this.effectivePriority(right, now) - this.effectivePriority(left, now);
      return priority || left.enqueuedAt - right.enqueuedAt || left.sequence - right.sequence;
    })[0];
  }

  lowerPriorityThanLease(job) {
    if (!this.leaseClient || job.client === this.leaseClient) return false;
    if (this.pauseReason({ client: this.leaseClient, trafficClass: 'live' })) return false;
    return this.config.clients[job.client].priority < this.config.clients[this.leaseClient].priority;
  }

  backgroundReadiness(now = this.clock()) {
    if (!this.accepting) return { ready: false, reason: 'shutting_down', wait_seconds: null };
    if (this.paused) return { ready: false, reason: 'maintenance_paused', wait_seconds: null };
    const blocked = this.pauseCheck('frigate', 'catchup');
    if (blocked) return { ready: false, reason: blocked.reason, wait_seconds: null };
    if (this.active) return { ready: false, reason: 'active_request', wait_seconds: null };
    if (this.jobs.some((job) => job.state === 'queued' && !job.signal?.aborted && job.deadline > now && !this.pauseReason(job))) {
      return { ready: false, reason: 'live_requests_queued', wait_seconds: null };
    }
    if (this.leaseClient && now < this.leaseUntil && !this.pauseReason({ client: this.leaseClient, trafficClass: 'live' })) return { ready: false, reason: 'model_lease', wait_seconds: (this.leaseUntil - now) / 1000 };
    return { ready: true, reason: 'idle', wait_seconds: 0 };
  }

  canRunBackground(now = this.clock()) {
    return this.backgroundReadiness(now).ready;
  }

  take(now = this.clock()) {
    if (this.active || !this.accepting || this.paused) return { job: null, delayMs: null };
    this.expire(now);
    const candidates = this.candidates();
    if (!candidates.length) return { job: null, delayMs: null };
    if (candidates.every((job) => job.trafficClass === 'catchup') && now < this.leaseUntil
      && this.leaseClient && !this.pauseReason({ client: this.leaseClient, trafficClass: 'live' })) {
      return { job: null, delayMs: Math.max(1, this.leaseUntil - now), reason: 'model_lease' };
    }

    const forced = candidates.filter((job) => job.maxWaitAt <= now);
    const forcedOther = forced.filter((job) => job.model !== this.currentModel);
    let chosen;
    let reason;

    if (this.strictPriority) {
      chosen = this.best(candidates, now);
      if (now < this.leaseUntil && this.lowerPriorityThanLease(chosen)) {
        return { job: null, delayMs: Math.max(1, this.leaseUntil - now), reason: 'model_lease' };
      }
      reason = 'strict_priority';
    } else if (forcedOther.length) {
      chosen = forcedOther.sort((a, b) => a.maxWaitAt - b.maxWaitAt || a.sequence - b.sequence)[0];
      reason = 'max_wait_exceeded';
    } else {
      const current = candidates.filter((job) => job.model === this.currentModel);
      const other = candidates.filter((job) => job.model !== this.currentModel);
      const policy = this.batchPolicy ?? this.modelPolicy(this.currentModel, current[0]?.client);
      const batchAvailable = this.batchModel === this.currentModel
        && this.batchCount < policy.max_batch_requests
        && now - this.batchStartedAt < policy.maxBatchTimeMs;

      if (current.length && (batchAvailable || !other.length)) {
        chosen = this.best(current, now);
        reason = other.length ? 'model_affinity' : 'only_model_waiting';
      } else if (!current.length && this.currentModel && now < this.leaseUntil && !forced.length) {
        return { job: null, delayMs: Math.max(1, this.leaseUntil - now), reason: 'model_lease' };
      } else {
        const pool = current.length && other.length && !batchAvailable ? other : candidates;
        chosen = this.best(pool, now);
        reason = current.length && other.length && !batchAvailable ? 'batch_limit' : 'effective_priority';
      }
    }

    const previousModel = this.currentModel;
    const switching = Boolean(previousModel && previousModel !== chosen.model);
    const modelLoadExpected = previousModel !== chosen.model;
    if (chosen.model !== this.batchModel) {
      this.batchModel = chosen.model;
      this.batchStartedAt = now;
      this.batchCount = 0;
      this.batchPolicy = this.modelPolicy(chosen.model, chosen.client);
    } else if (!this.batchPolicy) {
      this.batchPolicy = this.modelPolicy(chosen.model, chosen.client);
    }
    if (switching) {
      this.switches += 1;
      this.metrics.increment('proxy_model_switches_total', { from: previousModel, to: chosen.model, reason });
      this.logger.info('model switch selected', {
        request_id: chosen.id, from_model: previousModel, to_model: chosen.model, reason,
      });
      this.observability?.record('model_switch_selected', this.eventFields(chosen, {
        from_model: safeDisplay(previousModel), to_model: safeDisplay(chosen.model), reason,
      }));
    }
    this.currentModel = chosen.model;
    this.currentModelGroup = this.modelPolicy(chosen.model, chosen.client).group;
    this.currentClient = chosen.client;
    this.leaseUntil = 0;
    this.leaseClient = null;
    this.batchCount += 1;
    this.jobs.splice(this.jobs.indexOf(chosen), 1);
    chosen.state = 'active';
    chosen.phase = 'selected';
    chosen.dispatchedAt = now;
    chosen.switching = switching;
    chosen.previousModel = switching ? previousModel : null;
    chosen.modelLoadExpected = modelLoadExpected;
    chosen.scheduleReason = reason;
    this.active = chosen;
    const queueWait = (now - chosen.enqueuedAt) / 1000;
    this.metrics.observe('proxy_queue_wait_seconds', queueWait, { client: chosen.client, model: chosen.model });
    this.logger.info('request dispatched', {
      request_id: chosen.id, detected_client: chosen.client, requested_model: chosen.model,
      queue_wait: queueWait, dispatch_time: new Date(now).toISOString(), streaming: chosen.streaming,
      model_switch_decision: reason,
    });
    this.observability?.record('request_dispatched', this.eventFields(chosen, {
      queue_wait_seconds: queueWait,
      dispatched_at: new Date(now).toISOString(),
      reason,
    }));
    return { job: chosen, delayMs: 0, reason };
  }

  complete(job) {
    if (this.active !== job) return;
    const now = this.clock();
    this.active = null;
    this.lastActivity = now;
    // An idle hold protects follow-up live work, not a background batch from
    // itself. Ollama keep_alive remains unchanged and keeps the model warm.
    this.leaseUntil = now + (job.trafficClass === 'catchup' ? 0 : this.modelPolicy(job.model, job.client).idleHoldMs);
    this.leaseClient = job.client;
    this.wake();
  }

  reconcile(model) {
    if (this.active || this.currentBackendType === 'comfyui') return;
    const normalized = model || null;
    if (normalized === this.currentModel) return;
    this.logger.info('scheduler model state reconciled', { previous_model: this.currentModel, backend_model: normalized });
    this.observability?.record('model_reconciled', {
      previous_model: safeDisplay(this.currentModel),
      current_model: safeDisplay(normalized),
    });
    this.currentModel = normalized;
    this.currentModelGroup = normalized ? this.modelPolicy(normalized).group : null;
    this.currentClient = null;
    this.batchModel = normalized;
    this.batchPolicy = null;
    this.batchStartedAt = this.clock();
    this.batchCount = 0;
    this.leaseUntil = 0;
    this.leaseClient = null;
    this.wake();
  }

  status(now = this.clock()) {
    const memory = this.memoryUsage();
    const queues = {};
    const oldestWait = {};
    const modelQueues = Object.create(null);
    const oldestModelWait = Object.create(null);
    for (const client of Object.keys(this.config.clients)) {
      const jobs = this.jobs.filter((job) => job.client === client && job.state === 'queued');
      queues[client] = jobs.length;
      oldestWait[client] = jobs.length ? (now - Math.min(...jobs.map((job) => job.enqueuedAt))) / 1000 : 0;
    }
    for (const job of this.jobs) {
      if (job.state !== 'queued') continue;
      modelQueues[job.model] = (modelQueues[job.model] ?? 0) + 1;
      const age = (now - job.enqueuedAt) / 1000;
      oldestModelWait[job.model] = Math.max(oldestModelWait[job.model] ?? 0, age);
    }
    return {
      current_model: this.currentModel,
      current_model_group: this.currentModelGroup,
      current_client: this.currentClient,
      scheduling_mode: this.strictPriority ? 'strict_priority' : 'balanced',
      active_client: this.active?.client ?? null,
      active_request_id: this.active ? `r-${this.active.sequence}` : null,
      active_request_duration: this.active ? (now - this.active.dispatchedAt) / 1000 : 0,
      active_request_abandoned: this.active?.downstreamDisconnected ?? false,
      upstream_draining: this.active?.downstreamDisconnected ?? false,
      queues,
      oldest_wait_seconds: oldestWait,
      model_queues: modelQueues,
      oldest_model_wait_seconds: oldestModelWait,
      queue_bytes: memory.queued,
      active_bytes: memory.active,
      total_request_bytes: memory.total,
      max_queue_bytes: memory.limit,
      background: this.backgroundReadiness(now),
      last_activity: this.lastActivity ? new Date(this.lastActivity).toISOString() : null,
      model_lease_remaining: Math.max(0, this.leaseUntil - now) / 1000,
      model_switches: this.switches,
      accepting: this.accepting && !this.paused,
      paused: this.paused,
    };
  }

  eventFields(job, extra = {}) {
    return {
      request_id: `r-${job.sequence}`,
      client: job.client,
      model: safeDisplay(job.model),
      endpoint: job.pathname,
      request_type: job.requestType,
      streaming: job.streaming,
      request: job.requestSummary,
      ...extra,
    };
  }

  requestDetails(job, now = this.clock()) {
    const active = job.state === 'active';
    const blocked = this.pauseReason(job);
    const waitReason = active ? null : blocked?.reason ?? (this.active ? 'active_request'
      : now < this.leaseUntil && this.lowerPriorityThanLease(job) ? 'follow_up_hold'
        : this.jobs.some((other) => other !== job && !this.pauseReason(other)
          && this.config.clients[other.client].priority > this.config.clients[job.client].priority) ? 'higher_priority'
          : 'arrival_order_or_backend');
    return {
      id: `r-${job.sequence}`,
      client: job.client,
      classification_method: job.identificationMethod,
      backend: job.backend ?? null,
      durable: Boolean(job.durable),
      blocked_by: active ? null : this.pauseReason(job),
      wait_reason: waitReason,
      model: safeDisplay(job.model),
      type: job.requestType,
      endpoint: job.pathname,
      streaming: job.streaming,
      state: active && job.downstreamDisconnected ? 'draining' : active ? (job.phase ?? 'active') : job.state,
      queued_at: new Date(job.enqueuedAt).toISOString(),
      dispatched_at: job.dispatchedAt ? new Date(job.dispatchedAt).toISOString() : null,
      queue_wait_seconds: job.dispatchedAt ? (job.dispatchedAt - job.enqueuedAt) / 1000 : null,
      running_seconds: active ? Math.max(0, now - job.dispatchedAt) / 1000 : null,
      waiting_seconds: active ? null : Math.max(0, now - job.enqueuedAt) / 1000,
      ttl_remaining_seconds: active ? null : Math.max(0, job.deadline - now) / 1000,
      max_wait_remaining_seconds: active || this.strictPriority || !Number.isFinite(job.maxWaitAt) ? null : Math.max(0, job.maxWaitAt - now) / 1000,
      effective_priority: active ? null : this.effectivePriority(job, now),
      schedule_reason: job.scheduleReason ?? null,
      model_switch_expected: Boolean(job.switching),
      downstream_connected: !job.downstreamDisconnected,
      request: job.requestSummary,
    };
  }

  details(now = this.clock()) {
    const status = this.status(now);
    const queued = this.jobs.filter((job) => job.state === 'queued');
    const byModel = Object.create(null);
    const oldestByModel = Object.create(null);
    for (const [model, depth] of Object.entries(status.model_queues)) {
      const safeModel = safeDisplay(model);
      byModel[safeModel] = (byModel[safeModel] ?? 0) + depth;
      oldestByModel[safeModel] = Math.max(oldestByModel[safeModel] ?? 0, status.oldest_model_wait_seconds[model] ?? 0);
    }
    return {
      current_model: safeDisplay(status.current_model),
      current_model_group: safeDisplay(status.current_model_group),
      scheduling_mode: status.scheduling_mode,
      background: status.background,
      model_lease_remaining: status.model_lease_remaining,
      model_switches: status.model_switches,
      upstream_draining: status.upstream_draining,
      last_activity: status.last_activity,
      accepting: status.accepting,
      active_request: this.active ? this.requestDetails(this.active, now) : null,
      queue: {
        total: queued.length,
        body_bytes: status.queue_bytes,
        active_body_bytes: status.active_bytes,
        total_request_bytes: status.total_request_bytes,
        max_bytes: status.max_queue_bytes,
        by_client: status.queues,
        by_model: byModel,
        oldest_wait_seconds: Math.max(0, ...Object.values(status.oldest_wait_seconds)),
        oldest_wait_by_client: status.oldest_wait_seconds,
        oldest_wait_by_model: oldestByModel,
        items: queued.slice(0, this.config.observability.queue_items_limit)
          .map((job) => this.requestDetails(job, now)),
        items_truncated: queued.length > this.config.observability.queue_items_limit,
      },
    };
  }

  stop() {
    this.accepting = false;
    for (const job of [...this.jobs]) this.drop(job, 503, 'shutting_down', 'proxy is shutting down');
    this.wake();
  }

  pause() {
    const changed = !this.paused;
    this.paused = true;
    const queued = this.jobs.filter((job) => job.state === 'queued').length;
    this.enforcePauses();
    this.wake();
    return { changed, queuedDropped: queued - this.jobs.filter((job) => job.state === 'queued').length };
  }

  resume() {
    const changed = this.paused;
    this.paused = false;
    this.wake();
    return changed;
  }

  wake() {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  waitForChange(timeoutMs = null, signal = null) {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      let timer;
      const done = () => {
        if (timer) clearTimeout(timer);
        this.waiters.delete(done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      this.waiters.add(done);
      signal?.addEventListener('abort', done, { once: true });
      if (timeoutMs !== null) timer = setTimeout(done, Math.max(1, timeoutMs));
    });
  }
}
