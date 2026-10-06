import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaBroker } from '../src/media-broker.js';

const MiB = 1024 ** 2;
const instanceId = 'comfy-process-instance';

function fixture() {
  let sample = 0;
  const adapter = {
    proof: { supported: true, request_id: null, completed: false, loaded_models: 0, error: null },
    requests: [], reserved: 76 * MiB, queueBusy: false,
    async bridgeStatus() { return { protocol: 'ai-intermediary-comfy-v1', local_only: true,
      instance_id: instanceId, release_proof: { ...this.proof } }; },
    async queue() { return { queue_running: this.queueBusy ? [[0, 'external']] : [], queue_pending: [] }; },
    async requestRelease({ requestId }) {
      this.requests.push(requestId);
      this.proof = { supported: true, request_id: requestId, completed: true, loaded_models: 0, error: null };
    },
    async requestFree() { this.requests.push('legacy-free'); },
    async releaseEvidence({ maxReservedBytes }) {
      return { idle: !this.queueBusy, released: this.reserved <= maxReservedBytes,
        reason: this.reserved > maxReservedBytes ? 'comfy_reserved_memory_above_limit' : null,
        memory: { valid: true, reserved_bytes: this.reserved, active_bytes: this.reserved, max_reserved_bytes: maxReservedBytes } };
    },
  };
  const host = { available: true, bound: true, stale: false, sampled_at: 0,
    gpus: [{ processes_known: true, processes: [{ is_comfyui: true }], vram_used_bytes: 676 * MiB, utilization_percent: 3 }] };
  const service = {
    config: { media: { enabled: true, max_idle_torch_vram_mb: 128, max_idle_vram_mb: 1024,
      max_idle_utilization_percent: 5, stable_samples: 3, pollIntervalMs: 1 }, gpu_safety: { unloadTimeoutMs: 25 },
    ollama: { healthTimeoutMs: 25 } },
    hostHelper: { async refresh() { host.sampled_at = ++sample; }, snapshot() { return host; } },
    backend: { loadedModels: [] }, backendClient: { async loadedModels() { return []; } },
    scheduler: { wake() {} },
  };
  const store = { unresolved: () => [], list: () => [] };
  const broker = new MediaBroker(service, { store, adapters: new Map([['comfy', adapter]]) });
  broker.loaded = true;
  return { broker, adapter, host, service };
}

test('measured 76 MiB allocator / 676 MiB physical baseline requires proven unload AND stable owned GPU checks', async () => {
  const { broker, adapter, host } = fixture();
  await broker.quiesce();
  assert.equal(broker.verified, true);
  assert.ok(host.sampled_at >= 3);
  assert.equal(adapter.requests.length, 1);
  assert.equal(broker.snapshot().release, null);
  await broker.prepareOllama();
  assert.equal(adapter.requests.length, 1, 'a verified resident baseline needs no new cleanup before every chat');
});

test('old bridge remains strict zero even when a bounded residual allowance is configured', async () => {
  const { broker, adapter } = fixture();
  adapter.proof = undefined;
  await assert.rejects(broker.quiesce(), { code: 'comfy_reserved_memory_above_limit' });
  assert.equal(broker.verified, false);
  assert.deepEqual(adapter.requests, ['legacy-free']);
  assert.equal(broker.snapshot().release.max_reserved_bytes, 0);
  adapter.reserved = 0;
  await broker.quiesce();
  assert.equal(broker.verified, true);
});

test('explicit strict zero, excessive allocator use and loaded model registry all fail closed', async () => {
  for (const scenario of ['strict', 'excess', 'loaded', 'pending', 'mismatched']) {
    const { broker, adapter } = fixture();
    if (scenario === 'strict') broker.settings.max_idle_torch_vram_mb = 0;
    if (scenario === 'excess') adapter.reserved = 129 * MiB;
    const original = adapter.requestRelease.bind(adapter);
    adapter.requestRelease = async (options) => {
      await original(options);
      if (scenario === 'loaded') adapter.proof.loaded_models = 1;
      if (scenario === 'pending') adapter.proof.completed = false;
      if (scenario === 'mismatched') adapter.proof.request_id = 'different-cleanup';
    };
    await assert.rejects(broker.quiesce(), { code: ['strict', 'excess'].includes(scenario)
      ? 'comfy_reserved_memory_above_limit' : scenario === 'mismatched' ? 'comfy_release_proof_changed' : 'comfy_unload_pending' });
    assert.equal(broker.verified, false, scenario);
  }
});

test('busy backend is not unloaded and changing bridge proof blocks the next Ollama handoff', async () => {
  const { broker, adapter } = fixture();
  adapter.queueBusy = true;
  await assert.rejects(broker.quiesce(), { code: 'comfy_external_or_unfinished_work' });
  assert.deepEqual(adapter.requests, []);
  adapter.queueBusy = false;
  await broker.quiesce();
  adapter.proof.completed = false;
  await assert.rejects(broker.prepareOllama(), { code: 'comfy_release_proof_changed' });
  adapter.proof.completed = true;
  adapter.proof.error = 'release_evidence_changed';
  await assert.rejects(broker.prepareOllama(), { code: 'comfy_release_proof_changed' });
  adapter.proof.error = null;
  const originalStatus = adapter.bridgeStatus.bind(adapter);
  adapter.bridgeStatus = async () => ({ ...await originalStatus(), instance_id: 'restarted' });
  await assert.rejects(broker.prepareOllama(), { code: 'comfy_release_proof_changed' });
});

test('rescue allowance reuses current proven release without unloading again', async () => {
  const { broker, adapter } = fixture();
  assert.equal(await broker.contextRescueIdleAllowance(), null, 'initialization is not proof');
  await broker.quiesce();
  assert.deepEqual(await broker.contextRescueIdleAllowance(), {
    max_utilization_percent: 5, max_residual_vram_bytes: 1024 * MiB,
  });
  assert.equal(adapter.requests.length, 1);
  broker.settings.enabled = false;
  assert.equal(await broker.contextRescueIdleAllowance(), null);
  broker.settings.enabled = true;
  broker.fault = 'media_recovery_required';
  await assert.rejects(broker.contextRescueIdleAllowance(), { code: 'media_recovery_required' });
  broker.fault = null;
  broker.releaseProofs.set('comfy', null);
  adapter.reserved = 0;
  assert.equal(await broker.contextRescueIdleAllowance(), null, 'legacy bridge gets no relaxed rescue');
  broker.adapters.clear();
  assert.equal(await broker.contextRescueIdleAllowance(), null, 'no adapters cannot grant an allowance');
});

test('rescue refuses changed queue, allocator, or worker proof including a change during evidence reads', async () => {
  for (const scenario of ['queue', 'memory', 'proof', 'during-read', 'transport']) {
    const { broker, adapter } = fixture();
    await broker.quiesce();
    if (scenario === 'queue') adapter.queueBusy = true;
    if (scenario === 'memory') adapter.reserved = 129 * MiB;
    if (scenario === 'proof') adapter.proof.completed = false;
    if (scenario === 'transport') adapter.bridgeStatus = async () => { throw new Error('disconnected'); };
    if (scenario === 'during-read') {
      const read = adapter.releaseEvidence.bind(adapter);
      adapter.releaseEvidence = async (options) => {
        const evidence = await read(options);
        adapter.proof.completed = false;
        return evidence;
      };
    }
    await assert.rejects(broker.contextRescueIdleAllowance(), undefined, scenario);
    assert.equal(adapter.requests.length, 1, scenario);
  }
});

test('a timed-out cleanup is rejoined with the same id rather than submitted again under a new id', async () => {
  const { broker, adapter } = fixture();
  const pending = '24336f85-ef91-4c97-8b90-91819e8c9c47';
  adapter.proof.request_id = pending;
  await broker.quiesce();
  assert.deepEqual(adapter.requests, [pending]);
});

test('physical limit is never implicitly raised; unknown processes, stale samples and GPU activity still block', async () => {
  for (const scenario of ['limit', 'unknown', 'unavailable', 'stale', 'repeated', 'active']) {
    const { broker, host, service } = fixture();
    let code;
    if (scenario === 'limit') { broker.settings.max_idle_vram_mb = 512; code = 'physical_vram_above_idle_limit'; }
    if (scenario === 'unknown') { host.gpus[0].processes = [{}]; code = 'gpu_process_ownership_unconfirmed'; }
    if (scenario === 'unavailable') { host.available = false; code = 'host_gpu_evidence_unavailable'; }
    if (scenario === 'stale') { host.stale = true; code = 'host_gpu_evidence_unavailable'; }
    if (scenario === 'repeated') { service.hostHelper.refresh = async () => {}; code = 'gpu_idle_samples_pending'; }
    if (scenario === 'active') { host.gpus[0].utilization_percent = 6; code = 'gpu_activity_above_idle_limit'; }
    await assert.rejects(broker.quiesce(), { code });
    assert.equal(broker.verified, false, scenario);
    assert.equal(broker.snapshot().release.reason, code);
    assert.ok(broker.snapshot().release.next_retry_at);
  }
});

test('automatic cleanup retries back off, stop after three failures, and expose the latest cause without generation', async () => {
  const { broker, adapter } = fixture();
  broker.fault = 'original_transport_error';
  let calls = 0;
  adapter.bridgeStatus = async () => {
    calls += 1;
    throw Object.assign(new Error('not exposed'), { code: `cleanup_failure_${calls}` });
  };
  await assert.rejects(broker.reconcile(undefined, { automatic: true }), { code: 'cleanup_failure_1' });
  await broker.reconcile(undefined, { automatic: true });
  assert.equal(calls, 1, 'backoff skips even cleanup requests');
  broker.nextCleanupRetry = 0;
  await assert.rejects(broker.reconcile(undefined, { automatic: true }), { code: 'cleanup_failure_2' });
  broker.nextCleanupRetry = 0;
  await assert.rejects(broker.reconcile(undefined, { automatic: true }), { code: 'cleanup_failure_3' });
  await broker.reconcile(undefined, { automatic: true });
  assert.equal(calls, 3);
  assert.equal(broker.snapshot().release.reason, 'cleanup_failure_3');
  assert.equal(broker.snapshot().release.automatic_retry_exhausted, true);
  assert.equal(broker.snapshot().release.next_retry_at, null);
  assert.equal(broker.blocked, true);
  assert.deepEqual(adapter.requests, []);
});

test('transient cleanup failure can recover without another generation or changing manual pause', async () => {
  const { broker, adapter, service } = fixture();
  broker.fault = 'original_transport_error';
  service.scheduler.paused = true;
  const original = adapter.bridgeStatus.bind(adapter);
  adapter.bridgeStatus = async () => { throw Object.assign(new Error('temporary'), { code: 'backend_transport_error' }); };
  await assert.rejects(broker.reconcile(undefined, { automatic: true }));
  adapter.bridgeStatus = original;
  broker.nextCleanupRetry = 0;
  await broker.reconcile(undefined, { automatic: true });
  assert.equal(broker.blocked, false);
  assert.equal(broker.verified, true);
  assert.equal(broker.snapshot().release, null);
  assert.equal(service.scheduler.paused, true);
});

test('worker failure is reported immediately instead of misleadingly called unload pending', async () => {
  const { broker, adapter } = fixture();
  const original = adapter.requestRelease.bind(adapter);
  adapter.requestRelease = async (options) => {
    await original(options);
    adapter.proof.completed = false;
    adapter.proof.error = 'release_cache_failed';
  };
  await assert.rejects(broker.quiesce(), { code: 'release_cache_failed' });
  assert.equal(broker.snapshot().release.reason, 'release_cache_failed');
});

test('history transport failures do not exhaust cleanup attempts or suppress later output import', async () => {
  const { broker, adapter } = fixture();
  const record = { id: 'uncertain-job', backend: 'comfy', state: 'uncertain' };
  broker.store.unresolved = () => [record];
  broker.store.getInternal = () => record;
  let observed = 0;
  adapter.inspect = async () => {
    observed += 1;
    throw Object.assign(new Error('temporary history read'), { code: 'backend_transport_error' });
  };
  for (let i = 0; i < 4; i += 1) {
    broker.nextObservationRetry = 0;
    await assert.rejects(broker.reconcile(undefined, { automatic: true }));
  }
  assert.equal(broker.cleanupAttempts, 0);
  assert.equal(observed, 4);
  adapter.inspect = async () => ({ terminal: true, state: 'completed' });
  let imported = false;
  broker.finish = async (job, result, signal, reconciled, { allowCleanup }) => {
    imported = result.state === 'completed';
    assert.equal(allowCleanup, false, 'exhausted cleanup does not prevent read-only result discovery');
  };
  broker.cleanupAttempts = 3;
  broker.nextObservationRetry = 0;
  await broker.reconcile(undefined, { automatic: true });
  assert.equal(imported, true);
});

test('settlement storage failure after successful cleanup cannot reset the bounded retry budget', async () => {
  const { broker, adapter } = fixture();
  const record = { id: 'completed-job', backend: 'comfy', state: 'uncertain', outputsImported: true,
    execution: { state: 'completed', terminal: true, artifacts: [] } };
  broker.store.unresolved = () => [record];
  broker.store.getInternal = () => record;
  broker.store.update = async () => { throw Object.assign(new Error('disk unavailable'), { code: 'media_state_unavailable' }); };
  for (let i = 0; i < 3; i += 1) {
    broker.nextCleanupRetry = 0;
    await assert.rejects(broker.reconcile(undefined, { automatic: true }), { code: 'media_state_unavailable' });
    assert.equal(broker.cleanupAttempts, i + 1);
  }
  const requests = adapter.requests.length;
  await broker.reconcile(undefined, { automatic: true });
  assert.equal(adapter.requests.length, requests);
  assert.equal(broker.blocked, true);
});
