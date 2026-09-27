import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AutomaticRecovery } from '../src/auto-recovery.js';
import { OperationGate } from '../src/backend.js';
import { testConfig } from './helpers.js';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-recovery-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const f = { now: 1_800_000_000_000, calls: [], cleared: 0, acknowledged: 0, refreshed: 0, stopping: false };
  f.config = testConfig({
    maintenance: { enabled: true, auth_token: 'test-maintenance' },
    host_helper: { enabled: true },
    auto_recovery: { enabled: true, state_path: path.join(directory, 'recovery.json'), check_interval: '1s',
      verification_timeout: '10s', restart_timeout: '10s' },
  });
  f.host = { available: true, bound: true, error: null,
    service: { invocation_id: 'before', kill_mode: 'control-group', active: true },
    restart_policy: { available: true },
    gpus: [{ id: '0', vram_total_bytes: 32 * 1024 ** 3, vram_used_bytes: 57 * 1024 ** 2,
      utilization_percent: 0, processes_known: true, processes: [] }],
  };
  f.helper = {
    refresh: async () => { f.refreshed += 1; return f.host; },
    snapshot: () => ({ ...f.host, sampled_at: new Date(f.now).toISOString() }),
    restart: async (id, before) => {
      f.calls.push(id);
      assert.equal(f.gate.activeKind, 'maintenance');
      f.host.service.invocation_id = 'after';
      return { operation_id: id, state: 'completed', restarted: true,
        before_invocation_id: before, after_invocation_id: 'after' };
    },
  };
  f.backend = { recoveryRequired: true, recoveryCode: 'upstream_disconnected', recoverySince: f.now,
    reachable: true, probe: async () => {},
    clearRecovery: () => { f.cleared += 1; f.backend.recoveryRequired = false; },
  };
  f.maintenance = { paused: false, revision: 0 };
  f.gate = new OperationGate();
  f.scheduler = { active: null, reconcile: () => {}, wake: () => {} };
  f.catchup = { requiresRecovery: true, acknowledgeRecovery: () => { f.acknowledged += 1; } };
  f.backendClient = { loadedModels: async (_signal, timeoutMs) => {
    assert.ok(timeoutMs <= f.config.ollama.healthTimeoutMs, 'verification must not use inference timeout');
    return [];
  } };
  f.make = () => new AutomaticRecovery(f.config, { clock: () => f.now,
    helper: f.helper, backend: f.backend, backendClient: f.backendClient, gate: f.gate,
    scheduler: f.scheduler, catchup: f.catchup, maintenance: f.maintenance, isStopping: () => f.stopping,
    mediaBlocked: () => f.mediaBlocked });
  f.engine = f.make();
  f.step = async (ms = 1000) => { f.now += ms; await f.engine.tick(); };
  return f;
}

test('media recovery is not service shutdown and never restarts Ollama or clears a lock', async (t) => {
  const f = fixture(t);
  f.mediaBlocked = true;
  await f.step();
  assert.equal(f.engine.reason, 'media_recovery_required');
  assert.equal(f.engine.state, 'needs_attention');
  assert.deepEqual(f.calls, []);
  assert.equal(f.cleared, 0);
  f.stopping = true;
  await f.step();
  assert.equal(f.engine.reason, 'service_stopping');
});

test('media lock arriving during host checks prevents a restart', async (t) => {
  const f = fixture(t);
  f.helper.refresh = async () => { f.mediaBlocked = true; };
  await f.step();
  assert.deepEqual(f.calls, []);
  assert.equal(f.engine.reason, 'media_recovery_required');
});

test('media lock arriving during final probe prevents acknowledgment', async (t) => {
  const f = fixture(t);
  await f.step();
  await f.step();
  await f.step();
  f.backend.probe = async () => { f.mediaBlocked = true; };
  await f.step();
  assert.equal(f.cleared, 0);
  assert.equal(f.acknowledged, 0);
  assert.equal(f.engine.reason, 'media_recovery_required');
});

test('replacement proof plus three independent samples clears recovery, not an empty GPU alone', async (t) => {
  const f = fixture(t);
  await f.step();
  assert.equal(f.calls.length, 1);
  assert.equal(f.engine.state, 'verifying');
  assert.equal(f.cleared, 0);
  await f.step();
  await f.step(0); // a repeated observation is not a second sample
  assert.equal(f.engine.saved.current.samples, 1);
  await f.step();
  assert.equal(f.cleared, 0);
  await f.step();
  assert.equal(f.cleared, 1);
  assert.equal(f.acknowledged, 1);
  assert.equal(f.engine.state, 'recovered');
  assert.equal(f.gate.active, false);
});

test('transient post-restart activity is rechecked read-only across restart and manual pause', async (t) => {
  const f = fixture(t); let checks = 0;
  f.helper.restart = async (id, before) => {
    f.calls.push(id); f.host.service.invocation_id = 'after';
    return { operation_id: id, before_invocation_id: before, state: 'uncertain', recheckable: true,
      error: 'gpu_active_after_restart', restarted: true };
  };
  f.helper.reconcile = async id => {
    checks++;
    assert.equal(f.gate.activeKind, 'maintenance');
    return { operation_id: id, state: 'completed', restarted: true,
      before_invocation_id: 'before', after_invocation_id: 'after' };
  };
  await f.step();
  assert.equal(f.engine.reason, 'waiting_for_restart_settle');
  f.maintenance.paused = true;
  f.engine = f.make();
  await f.step();
  for (let i = 0; i < 3; i++) await f.step();
  assert.equal(checks, 1);
  assert.equal(f.calls.length, 1);
  assert.equal(f.cleared, 1);
  assert.equal(f.maintenance.paused, true);
});

test('settling window is bounded; manual recheck extends verification but cannot restart again', async (t) => {
  const f = fixture(t); let reply; let checks = 0;
  f.helper.restart = async id => {
    f.calls.push(id);
    reply = { operation_id: id, state: 'uncertain', recheckable: true, error: 'gpu_vram_after_restart' };
    return reply;
  };
  f.helper.reconcile = async () => { checks++; return reply; };
  await f.step();
  await f.step();
  await f.step(30_000);
  assert.equal(f.engine.reason, 'restart_verification_timeout');
  await f.step(3_600_000);
  assert.equal(checks, 1);
  f.engine.checkNow(); await f.engine.busy;
  assert.equal(checks, 2);
  assert.equal(f.calls.length, 1);
  assert.equal(f.cleared, 0);
});

test('verified external service replacement is adopted without spending restart budget', async (t) => {
  const f = fixture(t);
  f.host.capabilities = { external_replacement: true };
  f.host.service.invocation_id = 'after';
  f.helper.replacement = async since => ({ state: 'completed', service_replaced: true,
    started_after: since / 1000, before_invocation_id: 'before', after_invocation_id: 'after' });
  await f.step();
  assert.equal(f.engine.reason, 'verifying_existing_service_restart');
  for (let i = 0; i < 3; i++) await f.step();
  assert.equal(f.cleared, 1);
  assert.equal(f.calls.length, 0);
  assert.equal(f.engine.status().episode_attempts, 0);
});

test('only current captured systemd OOM evidence is reported as host OOM', (t) => {
  const f = fixture(t);
  f.host.last_service_failure = { code: 'ollama_host_oom', observed_at: new Date(f.now).toISOString() };
  assert.equal(f.engine.status().host_failure, 'ollama_host_oom');
  f.backend.recoverySince += 10_000;
  assert.equal(f.engine.status().host_failure, null, 'old OOM evidence is not a diagnosis of a later disconnect');
});

test('failed verification cannot endlessly re-adopt the same external service epoch', async (t) => {
  const f = fixture(t);
  f.host.capabilities = { external_replacement: true };
  f.host.service.invocation_id = 'after';
  f.helper.replacement = async since => ({ state: 'completed', service_replaced: true,
    started_after: since / 1000, before_invocation_id: 'before', after_invocation_id: 'after' });
  await f.step();
  await f.step(11_000);
  assert.equal(f.engine.saved.current.phase, 'failed');
  f.helper.restart = async id => {
    f.calls.push(id);
    return { operation_id: id, state: 'failed', restarted: false, error: 'unrelated_gpu_process' };
  };
  await f.step();
  assert.equal(f.calls.length, 1, 'fall back to bounded restart instead of resetting external verification indefinitely');
  f.engine = f.make();
  await f.step();
  assert.equal(f.engine.reason, 'restart_cooldown', 'a later failed restart must not erase the rejected external epoch');
});

test('pause blocks automatic restart; explicit manual check can recover but never resumes', async (t) => {
  const f = fixture(t);
  f.maintenance.paused = true;
  await f.step();
  assert.equal(f.calls.length, 0);
  assert.equal(f.engine.reason, 'manual_pause');
  const status = f.engine.checkNow();
  assert.equal(status.enabled, true);
  await f.engine.busy;
  for (let i = 0; i < 3; i++) await f.step();
  assert.equal(f.cleared, 1);
  assert.equal(f.maintenance.paused, true);
  assert.equal(f.engine.reason, 'manual_pause_preserved');
});

test('new manual pause during host check revokes earlier manual consent', async (t) => {
  const f = fixture(t);
  f.helper.refresh = async () => { f.maintenance.paused = true; f.maintenance.revision += 1; };
  f.engine.checkNow();
  await f.engine.busy;
  assert.equal(f.calls.length, 0);
  assert.equal(f.cleared, 0);
});

test('pending restart ID survives lost response and engine restart without a second operation', async (t) => {
  const f = fixture(t);
  const restart = f.helper.restart;
  let response;
  f.helper.restart = async (id, before) => {
    if (!response) {
      response = await restart(id, before);
      throw Object.assign(new Error('lost reply'), { code: 'host_request_timeout' });
    }
    assert.equal(id, response.operation_id);
    return response;
  };
  await f.step();
  assert.equal(f.engine.saved.current.phase, 'pending');
  f.engine = f.make();
  await f.step();
  for (let i = 0; i < 3; i++) await f.step();
  assert.equal(f.calls.length, 1);
  assert.equal(f.cleared, 1);
  assert.equal(f.engine.saved.history.length, 1);
});

test('restored pending operation cannot start a restart during manual pause', async (t) => {
  const f = fixture(t);
  f.helper.restart = async () => { throw Object.assign(new Error(), { code: 'host_helper_unreachable' }); };
  await f.step();
  const id = f.engine.saved.current.id;
  f.maintenance.paused = true;
  f.engine = f.make();
  let attempts = 0;
  f.helper.restart = async () => { attempts++; };
  await f.step();
  assert.equal(attempts, 0);
  assert.equal(f.engine.saved.current.id, id);
  assert.equal(f.engine.reason, 'manual_pause');
});

test('restored pending replay rechecks backend binding before any mutating request', async (t) => {
  const f = fixture(t);
  f.helper.restart = async () => { throw Object.assign(new Error(), { code: 'host_helper_unreachable' }); };
  await f.step();
  f.host.bound = false;
  f.host.error = 'host_backend_mismatch';
  f.engine = f.make();
  let attempts = 0;
  f.helper.restart = async () => { attempts++; };
  await f.step();
  assert.equal(attempts, 0);
  assert.equal(f.engine.reason, 'host_backend_mismatch');
});

test('at most two restarts per incident, durable cooldown and no manual bypass', async (t) => {
  const f = fixture(t);
  f.helper.restart = async (id) => {
    f.calls.push(id);
    return { operation_id: id, state: 'failed', error: 'gpu_not_verified_idle', restarted: false };
  };
  await f.step();
  f.engine = f.make();
  await f.step();
  assert.equal(f.calls.length, 1);
  assert.equal(f.engine.reason, 'restart_cooldown');
  await f.step(300_000);
  assert.equal(f.calls.length, 2);
  await f.step(3_600_000);
  f.engine.checkNow(); await f.engine.busy;
  assert.equal(f.calls.length, 2);
  assert.equal(f.engine.reason, 'restart_limit_reached');
  assert.equal(f.engine.status().episode_attempts, 2);
});

test('rolling limit also applies across distinct recovery incidents', async (t) => {
  const f = fixture(t);
  f.engine.saved.history = [1, 2].map((i) => ({ id: `00000000-0000-4000-8000-00000000000${i}`, at: f.now - i * 1000 }));
  f.engine.persist();
  await f.step();
  assert.equal(f.calls.length, 0);
  assert.equal(f.engine.reason, 'restart_window_limit');
});

test('unknown process, unavailable telemetry or mismatched backend cannot restart', async (t) => {
  for (const apply of [
    (f) => { f.host.available = false; },
    (f) => { f.host.bound = false; },
    (f) => { f.host.gpus[0].processes_known = false; },
    (f) => { f.host.gpus[0].processes = [{ pid: 12, is_ollama: false }]; },
    (f) => { f.host.service.kill_mode = 'process'; },
  ]) {
    const f = fixture(t); apply(f); await f.step();
    assert.equal(f.calls.length, 0);
    assert.equal(f.engine.state, 'needs_attention');
  }
});

test('GPU or model activity resets stable proof and keeps dispatch blocked', async (t) => {
  const f = fixture(t);
  await f.step(); await f.step();
  f.host.gpus[0].vram_used_bytes = 8 * 1024 ** 3;
  await f.step();
  assert.equal(f.engine.saved.current.samples, 0);
  f.host.gpus[0].vram_used_bytes = 0;
  f.backendClient.loadedModels = async () => ['still-loaded'];
  await f.step();
  assert.equal(f.cleared, 0);
  await f.step(10_000);
  assert.equal(f.engine.saved.current.phase, 'failed');
  assert.equal(f.engine.reason, 'verification_timeout');
});

test('helper failed/uncertain/mismatched proof never clears an idle GPU latch', async (t) => {
  for (const result of [
    { state: 'failed', restarted: false },
    { state: 'uncertain', restarted: true },
    { state: 'completed', restarted: true, before_invocation_id: 'before', after_invocation_id: 'before' },
    { state: 'completed', restarted: true, before_invocation_id: 'unrelated', after_invocation_id: 'after' },
  ]) {
    const f = fixture(t);
    f.helper.restart = async (id) => ({ operation_id: id, ...result });
    await f.step(); await f.step();
    assert.equal(f.cleared, 0);
  }
});

test('active inference or a management gate delays recovery without overlap', async (t) => {
  const f = fixture(t);
  const release = await f.gate.acquire('inference');
  await f.step();
  assert.equal(f.calls.length, 0);
  release();
  f.scheduler.active = { id: 'active' };
  await f.step();
  assert.equal(f.calls.length, 0);
  f.scheduler.active = null;
  await f.step();
  assert.equal(f.calls.length, 1);
});

test('bookkeeping faults and corrupt durable recovery state never trigger host restart', async (t) => {
  const f = fixture(t);
  f.backend.recoveryCode = 'catchup_state_error';
  await f.step();
  assert.equal(f.calls.length, 0);
  f.backend.recoveryCode = 'upstream_disconnected';
  f.backend.recoveryStorageError = 'disk full';
  await f.step();
  assert.equal(f.calls.length, 0);
  f.backend.recoveryStorageError = null;
  fs.writeFileSync(f.config.auto_recovery.state_path, '{invalid');
  f.engine = f.make();
  await f.step();
  assert.equal(f.calls.length, 0);
  assert.throws(() => f.engine.checkNow(), /unreadable/);
});

test('failed completion persistence cannot clear the backend safety latch', async (t) => {
  const f = fixture(t);
  await f.step(); await f.step(); await f.step();
  f.engine.persist = () => { throw Object.assign(new Error(), { code: 'automatic_recovery_state_unwritable' }); };
  await f.step();
  assert.equal(f.cleared, 0);
  assert.equal(f.acknowledged, 0);
  assert.equal(f.engine.state, 'needs_attention');
});

test('completed-but-not-cleared record is reverified after process restart', async (t) => {
  const f = fixture(t);
  await f.step(); await f.step(); await f.step();
  f.catchup.acknowledgeRecovery = () => { throw Object.assign(new Error(), { code: 'catchup_unavailable' }); };
  await f.step();
  assert.equal(f.engine.saved.current.phase, 'completed');
  assert.equal(f.cleared, 0);
  f.engine = f.make();
  f.catchup.acknowledgeRecovery = () => { f.acknowledged++; };
  await f.step(); await f.step();
  assert.equal(f.cleared, 0);
  await f.step();
  assert.equal(f.cleared, 1);
  assert.equal(f.calls.length, 1);
});

test('shutdown during a restart retains its durable ID without clearing recovery', async (t) => {
  const f = fixture(t);
  f.helper.restart = async (_id, _before, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
  });
  const ticking = f.engine.tick();
  await new Promise((resolve) => setImmediate(resolve));
  f.stopping = true;
  await f.engine.stop(); await ticking;
  assert.equal(f.engine.saved.current.phase, 'pending');
  assert.equal(f.cleared, 0);
  assert.equal(f.gate.active, false);
});
