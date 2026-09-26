import assert from 'node:assert/strict';
import test from 'node:test';
import { HostHelperClient, HOST_PROTOCOL } from '../src/host-helper.js';
import { testConfig } from './helpers.js';

function fixture() {
  let now = 1_800_000_000_000;
  const config = testConfig({ host_helper: { enabled: true } });
  const client = new HostHelperClient(config, { clock: () => now });
  const value = { protocol: HOST_PROTOCOL, sampled_at: new Date(now).toISOString(),
    managed_ollama_origin: config.ollama.url,
    service: { invocation_id: 'before', active: true, kill_mode: 'control-group' },
    telemetry: { available: true, gpus: [{ id: '0', processes: [], processes_known: true,
      vram_total_bytes: 32 * 1024 ** 3, vram_used_bytes: 57 * 1024 ** 2,
      vram_free_bytes: 32 * 1024 ** 3 - 57 * 1024 ** 2, utilization_percent: 0,
      temperature_c: 29, power_w: 1 }] },
  };
  client.request = async () => value;
  return { client, value, advance: (ms) => { now += ms; } };
}

test('physical telemetry stays distinct, nullable and freshness bounded', async () => {
  const f = fixture();
  const snapshot = await f.client.refresh();
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.gpus[0].vram_used_bytes, 57 * 1024 ** 2);
  assert.equal(snapshot.gpus[0].name, null);
  f.advance(31_000);
  assert.equal(f.client.snapshot().available, false);
  assert.equal(f.client.snapshot().stale, true);
});

test('ComfyUI process ownership requires new helper capability and an explicit verified boolean', async () => {
  const f = fixture();
  f.value.telemetry.gpus[0].processes = [{ pid: 12, name: 'comfyui', is_comfyui: true }];
  assert.equal((await f.client.refresh()).gpus[0].processes[0].is_comfyui, false);
  f.value.capabilities = { comfyui_ownership: true };
  assert.equal((await f.client.refresh()).gpus[0].processes[0].is_comfyui, true);
  f.value.telemetry.gpus[0].processes[0].is_comfyui = 'true';
  assert.equal((await f.client.refresh()).gpus[0].processes[0].is_comfyui, false);
  f.value.telemetry.gpus[0].processes[0].is_comfyui = true;
  f.value.telemetry.gpus[0].processes[0].is_ollama = true;
  assert.equal((await f.client.refresh()).gpus[0].processes[0].is_comfyui, false);
  assert.equal((await f.client.refresh()).gpus[0].processes[0].is_ollama, true);
});

test('missing and malformed GPU rows never become idle proof or throw', async () => {
  for (const gpus of [undefined, null, [], [null], [1], ['text'], [{ id: '0' }, null],
    Array.from({ length: 17 }, (_, i) => ({ id: String(i) })), [{ id: '0' }, { id: '0' }]]) {
    const f = fixture(); f.value.telemetry.gpus = gpus;
    const snapshot = await f.client.refresh();
    assert.equal(snapshot.available, false);
  }
});

test('malformed process rows are unknown, never an empty safe process list', async () => {
  for (const processes of [null, [null], [1], [{}], [{ pid: -1 }], [{ pid: '12' }],
    Array.from({ length: 257 }, () => ({ pid: 2 }))]) {
    const f = fixture(); f.value.telemetry.gpus[0].processes = processes;
    const snapshot = await f.client.refresh();
    assert.equal(snapshot.gpus[0].processes_known, false);
  }
});

test('invalid measurements and protocol return unknown instead of a fictional zero', async () => {
  const f = fixture();
  f.value.telemetry.gpus[0].vram_used_bytes = '57 MB';
  f.value.telemetry.gpus[0].utilization_percent = -1;
  const snapshot = await f.client.refresh();
  assert.equal(snapshot.gpus[0].vram_used_bytes, null);
  assert.equal(snapshot.gpus[0].utilization_percent, null);
  f.value.protocol = 'other-v1';
  assert.equal((await f.client.refresh()).error, 'host_protocol_invalid');
});

test('origin mismatch and failed refresh block recovery even with recently cached telemetry', async () => {
  const f = fixture();
  f.value.managed_ollama_origin = 'http://different-host:11434';
  const mismatch = await f.client.refresh();
  assert.equal(mismatch.bound, false);
  assert.equal(mismatch.available, false);
  assert.equal(mismatch.error, 'host_backend_mismatch');
  f.client.request = async () => { throw new Error('private raw backend detail'); };
  assert.equal((await f.client.refresh()).error, 'host_helper_unreachable');
});

test('status is single-flight but verification wait uses its smaller deadline', async () => {
  const f = fixture();
  let resolve;
  let calls = 0;
  f.client.request = () => { calls++; return new Promise((done) => { resolve = done; }); };
  const first = f.client.refresh();
  await assert.rejects(f.client.refresh({ timeoutMs: 5 }), /host_request_timeout/);
  resolve(f.value);
  await first;
  assert.equal(calls, 1);
});

test('restart request contains only immutable operation ID and expected service incarnation', async () => {
  const f = fixture();
  let call;
  f.client.request = async (...args) => { call = args; };
  await f.client.restart('test-id', 'before', { timeoutMs: 200 });
  assert.deepEqual(call, ['/v1/ollama/restart', { method: 'POST',
    body: { operation_id: 'test-id', expected_invocation_id: 'before' }, timeoutMs: 200, signal: undefined }]);
});

test('host RAM is independently validated and expires with its sample', async () => {
  const f = fixture();
  f.value.memory = { available: true, total_bytes: 30 * 1024 ** 3, available_bytes: 8 * 1024 ** 3,
    swap_total_bytes: 4 * 1024 ** 3, swap_used_bytes: 4 * 1024 ** 3, pressure_full_avg10: 0, oom_kill_count: 2 };
  f.value.capabilities = { restart_reconciliation: true, external_replacement: true };
  let h = await f.client.refresh();
  assert.equal(h.memory.available, true);
  assert.equal(h.memory.oom_kill_count, 2);
  assert.equal(h.capabilities.external_replacement, true);
  f.value.telemetry.available = false;
  h = await f.client.refresh();
  assert.equal(h.memory.available, true, 'SMI failure does not erase independent RAM measurements');
  f.advance(31_000);
  assert.equal(f.client.snapshot().memory.available, false);
  f.value.sampled_at = new Date(1_800_000_031_000).toISOString();
  f.value.memory.available_bytes = f.value.memory.total_bytes + 1;
  assert.equal((await f.client.refresh()).memory.available, false);
});

test('restart reconciliation and external proof use read-only GET requests', async () => {
  const f = fixture(); const calls = [];
  f.client.request = async (...args) => calls.push(args);
  await f.client.reconcile('known-id', { timeoutMs: 50 });
  await f.client.replacement(1_800_000_000_000, { timeoutMs: 50 });
  assert.equal(calls[0][0], '/v1/ollama/operations/known-id');
  assert.equal(calls[1][0], '/v1/ollama/replacement?since=1800000000');
  assert.equal(calls.every(call => call[1].method !== 'POST'), true);
});
