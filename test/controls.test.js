import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProxyService } from '../src/proxy.js';
import { FrigateCatchup } from '../src/frigate-catchup.js';
import { MockOllama, SilentLogger, testConfig, waitFor } from './helpers.js';

async function fixture(t, overlay = {}, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'intermediary-controls-'));
  const backend = new MockOllama();
  await backend.start();
  const config = testConfig({
    ...overlay,
    ollama: { ...overlay.ollama, url: backend.url },
    maintenance: { ...overlay.maintenance, auth_token: 'maintenance-test', state_path: path.join(directory, 'pause.json') },
    gpu_safety: { ...overlay.gpu_safety, state_path: path.join(directory, 'gpu.json') },
    auto_recovery: { ...overlay.auto_recovery, state_path: path.join(directory, 'automatic-recovery.json') },
  });
  const service = new ProxyService(config, { logger: new SilentLogger(), settingsToken: 'settings-test', ...options });
  await service.start();
  const base = `http://127.0.0.1:${service.addresses()[0].address.port}`;
  t.after(async () => { await service.stop(); await backend.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  await waitFor(() => service.backend.canDispatch());
  return { service, backend, base, directory, config };
}

const post = (url, token, body) => fetch(url, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('dedicated source ports share one inference gate and override conflicting headers/models', async (t) => {
  const probe = new MockOllama(); await probe.start();
  const port = Number(new URL(probe.url).port); await probe.stop();
  const { service, base, backend } = await fixture(t, { clients: { odysseus: { listener_port: port } } });
  const send = (origin, client, id) => fetch(origin + '/api/generate', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ollama-client': client },
    body: JSON.stringify({ model: 'f-model', id, stream: false, delay_ms: 25 }) });
  const results = await Promise.all([send(`http://127.0.0.1:${port}`, 'frigate', 'dedicated'), send(base, 'frigate', 'main')]);
  for (const response of results) { assert.equal(response.status, 200); await response.text(); }
  assert.equal(backend.maxActive, 1);
  const queued = service.observability.recent(100).filter((event) => event.type === 'request_queued');
  assert.deepEqual(queued.map((event) => event.client).sort(), ['frigate', 'odysseus']);
  assert.equal(service.addresses().find((listener) => listener.forcedClient === 'odysseus').address.port, port);
});

test('startup applies active recurring pauses before inference admission', async (t) => {
  const { base, backend, service } = await fixture(t, { work_policy: { timezone: 'UTC', schedules: {
    night: { enabled: true, days: ['sun'], start: '01:00', end: '03:00', sources: ['*'], traffic: 'all', mode: 'pause' },
  } } }, { clock: () => Date.parse('2026-09-20T02:00:00Z') });
  const response = await post(base + '/api/generate', '', { model: 'f-model' });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'scheduled_pause');
  assert.equal(backend.order.length, 0);
  assert.equal(service.observabilitySnapshot().service.ready, false);
});

test('an occupied optional source port leaves main Settings available for repair', async (t) => {
  const occupied = new MockOllama();
  await new Promise((resolve) => occupied.server.listen(0, '0.0.0.0', resolve));
  t.after(() => occupied.stop());
  const port = occupied.server.address().port;
  const { service, base } = await fixture(t, { clients: { odysseus: { listener_port: port } } });
  assert.equal((await fetch(base + '/api/version')).status, 200);
  assert.equal(service.observabilitySnapshot().listeners.find((item) => item.source === 'odysseus').state, 'unavailable');
  assert.equal(service.listenerFailures[0].reason, 'EADDRINUSE');
});

test('scoped pauses are authenticated, preserve other sources and resume only their own rule', async (t) => {
  const { service, base, backend } = await fixture(t);
  const endpoint = `${base}/_intermediary/v1/maintenance/scopes`;
  assert.equal((await post(endpoint + '/pause', 'settings-test', { sources: ['frigate'], traffic: 'all' })).status, 401);
  const paused = await post(endpoint + '/pause', 'maintenance-test', { sources: ['frigate'], traffic: 'all' });
  assert.equal(paused.status, 200);
  const id = (await paused.json()).work_policy.manual[0].id;
  const generate = (client) => fetch(base + '/api/generate', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ollama-client': client }, body: JSON.stringify({ model: 'od-model', stream: false }) });
  assert.equal((await generate('frigate')).status, 503);
  const live = await generate('odysseus'); assert.equal(live.status, 200); await live.text();
  assert.equal(service.maintenance.paused, false);
  assert.equal(backend.maxActive, 1);
  await service.pauseMaintenance();
  await post(endpoint + '/resume', 'maintenance-test', { id });
  assert.equal(service.maintenance.paused, true);
  assert.equal((await generate('frigate')).status, 503);
});

test('scheduled GPU release drains and unloads, and schedule end preserves manual maintenance', async (t) => {
  let now = Date.parse('2026-09-20T00:30:00Z');
  const { service, backend } = await fixture(t, { work_policy: { timezone: 'UTC', schedules: {
    nightly: { enabled: true, days: ['sun'], start: '01:00', end: '03:00', sources: ['*'], traffic: 'all', mode: 'release_gpu' },
  } } }, { clock: () => now });
  backend.loadedModel = 'od-model';
  now = Date.parse('2026-09-20T01:00:00Z');
  await service.syncWorkPolicy();
  assert.equal(service.workPolicy.block('odysseus').reason, 'scheduled_pause');
  await waitFor(() => service.scheduledMaintenance.status().gpu_released);
  assert.equal(backend.loadedModel, null);
  await service.pauseMaintenance();
  now = Date.parse('2026-09-20T03:00:00Z');
  await service.syncWorkPolicy();
  assert.equal(service.scheduledMaintenance.paused, false);
  assert.equal(service.maintenance.paused, true);
  assert.equal(service.releasePaused, true);
  assert.equal(service.scheduler.pauseReason({ client: 'odysseus' }).reason, 'maintenance_paused');
});

test('configured live pause queue holds the connected response, without starting GPU work', async (t) => {
  const { service, base, backend } = await fixture(t, { clients: { odysseus: { queue_while_paused: true } } });
  const rule = service.workPolicy.pause({ sources: ['odysseus'], traffic: 'live' });
  const pending = fetch(base + '/api/generate', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ollama-client': 'odysseus' },
    body: JSON.stringify({ model: 'od-model', stream: false }) });
  await waitFor(() => service.scheduler.jobs.length === 1);
  assert.equal(backend.active, 0);
  assert.equal(service.observabilitySnapshot().queue.items[0].wait_reason, 'manual_source_pause');
  service.workPolicy.resume(rule.id); service.scheduler.enforcePauses();
  const response = await pending; assert.equal(response.status, 200); await response.text();
  assert.equal(backend.maxActive, 1);
});

test('catch-up status accepts read/admin tokens but historical scans require admin confirmation', async (t) => {
  let scans = 0;
  const catchup = { start() {}, async stop() {}, status: () => ({ enabled: true, state: 'running' }),
    scanMissing() { scans++; return this.status(); } };
  const { base } = await fixture(t, { observability: { auth_token: 'read-test' } }, { catchup });
  const endpoint = `${base}/_intermediary/v1/frigate`;
  assert.equal((await fetch(`${endpoint}/status`)).status, 401);
  for (const token of ['read-test', 'settings-test']) {
    assert.equal((await fetch(`${endpoint}/status`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
  }
  assert.equal((await post(`${endpoint}/scan`, 'read-test', { confirm: true })).status, 401);
  assert.equal((await post(`${endpoint}/scan`, 'settings-test', {})).status, 400);
  assert.equal((await post(`${endpoint}/scan`, 'settings-test', { confirm: true })).status, 202);
  assert.equal(scans, 1);
  const snapshot = await (await fetch(`${base}/_intermediary/v1/status`, { headers: { authorization: 'Bearer read-test' } })).json();
  assert.equal(snapshot.frigate.enabled, true);
  assert.equal(snapshot.build.version, JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
});

test('GPU recovery acknowledgment requires admin, pause, empty models, and explicit host confirmation', async (t) => {
  const { base, service, backend } = await fixture(t);
  service.backend.requireRecovery('test fault');
  const endpoint = `${base}/_intermediary/v1/recovery/acknowledge`;
  assert.equal((await post(endpoint, 'wrong', { confirm_gpu_recovered: true })).status, 401);
  assert.equal((await post(endpoint, 'maintenance-test', {})).status, 400);
  assert.equal((await post(endpoint, 'maintenance-test', { confirm_gpu_recovered: true })).status, 409);
  await post(`${base}/_intermediary/v1/maintenance/pause`, 'maintenance-test', {});
  await waitFor(() => !service.gate.active && !service.maintenanceTask);
  backend.loadedModel = 'still-loaded';
  assert.equal((await post(endpoint, 'maintenance-test', { confirm_gpu_recovered: true })).status, 409);
  assert.equal(service.backend.recoveryRequired, true);
  backend.loadedModel = null;
  assert.equal((await post(endpoint, 'maintenance-test', { confirm_gpu_recovered: true })).status, 200);
  assert.equal(service.backend.recoveryRequired, false);
  assert.equal(service.maintenance.paused, true);
});

test('recovery check requires maintenance authority, POST, JSON and explicit confirmation', async (t) => {
  const { base, service } = await fixture(t, { observability: { auth_token: 'read-test' } });
  const endpoint = `${base}/_intermediary/v1/recovery/check`;
  let checks = 0;
  service.automaticRecovery.checkNow = () => { checks++; return { enabled: true, state: 'waiting' }; };
  for (const token of ['', 'read-test', 'settings-test', 'wrong']) {
    assert.equal((await post(endpoint, token, { confirm: true })).status, 401);
  }
  const get = await fetch(endpoint, { headers: { authorization: 'Bearer maintenance-test' } });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { authorization: 'Bearer maintenance-test' }, body: '{}' })).status, 415);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { authorization: 'Bearer maintenance-test', 'content-type': 'application/json' }, body: '{bad' })).status, 400);
  for (const body of [{}, { confirm: false }, { confirm: 'true' }]) {
    assert.equal((await post(endpoint, 'maintenance-test', body)).status, 400);
  }
  assert.equal(checks, 0);
  const response = await post(endpoint, 'maintenance-test', { confirm: true });
  assert.equal(response.status, 202);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.equal(result.accepted, true);
  assert.equal(result.recovery.state, 'waiting');
  assert.equal(checks, 1);
});

test('recovery check fails visibly when disabled and cannot operate during settings shutdown', async (t) => {
  const { base, service } = await fixture(t);
  const endpoint = `${base}/_intermediary/v1/recovery/check`;
  let response = await post(endpoint, 'maintenance-test', { confirm: true });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'automatic_recovery_disabled');
  let checks = 0;
  service.automaticRecovery.checkNow = () => { checks++; return {}; };
  service.beginSettingsRestart();
  response = await post(endpoint, 'maintenance-test', { confirm: true });
  assert.equal(response.status, 409);
  assert.equal(checks, 0);
});

test('recovery check cannot run without a configured maintenance credential', async (t) => {
  const { base, service } = await fixture(t);
  service.config.maintenance.auth_token = '';
  let checks = 0;
  service.automaticRecovery.checkNow = () => { checks++; return {}; };
  const response = await post(`${base}/_intermediary/v1/recovery/check`, '', { confirm: true });
  assert.equal(response.status, 503);
  assert.equal(checks, 0);
});

test('an explicit recovery check preserves a manual pause and does not acknowledge an unverified fault', async (t) => {
  const { base, service } = await fixture(t);
  service.backend.requireRecovery('Ollama request failed after dispatch; upstream completion is unknown', { code: 'upstream_disconnected' });
  await post(`${base}/_intermediary/v1/maintenance/pause`, 'maintenance-test', {});
  await waitFor(() => !service.gate.active && !service.maintenanceTask);
  const revision = service.maintenance.revision;
  service.automaticRecovery.checkNow = () => ({ enabled: true, state: 'needs_attention', reason: 'restart_limit_reached' });
  const response = await post(`${base}/_intermediary/v1/recovery/check`, 'maintenance-test', { confirm: true });
  assert.equal(response.status, 202);
  const result = await response.json();
  assert.equal(result.recovery.reason, 'restart_limit_reached');
  assert.equal(service.backend.recoveryRequired, true);
  assert.equal(service.maintenance.paused, true);
  assert.equal(service.maintenance.revision, revision);
});

test('Frigate capability refresh requires settings authority but no job ID and preserves pause', async (t) => {
  let refreshes = 0;
  const catchup = { start() {}, async stop() {}, status: () => ({ enabled: true, state: 'running' }),
    async refreshCapabilities() { refreshes++; return { capabilities: { checked: true, object: true, review: true, bridge: true } }; } };
  const { base, service } = await fixture(t, { observability: { auth_token: 'read-test' } }, { catchup });
  const endpoint = `${base}/_intermediary/v1/frigate/refresh`;
  for (const token of ['', 'read-test', 'maintenance-test']) assert.equal((await post(endpoint, token, { confirm: true })).status, 401);
  assert.equal((await fetch(endpoint)).status, 405);
  assert.equal((await post(endpoint, 'settings-test', {})).status, 400);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { authorization: 'Bearer settings-test' }, body: '{}' })).status, 415);
  assert.equal(refreshes, 0);
  await post(`${base}/_intermediary/v1/maintenance/pause`, 'maintenance-test', {});
  await waitFor(() => !service.gate.active && !service.maintenanceTask);
  const revision = service.maintenance.revision;
  const response = await post(endpoint, 'settings-test', { confirm: true });
  assert.equal(response.status, 202);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.equal(result.frigate.capabilities.bridge, true);
  assert.equal(refreshes, 1);
  assert.equal(service.maintenance.paused, true);
  assert.equal(service.maintenance.revision, revision);
});

test('Frigate capability refresh exposes its cooldown but redacts arbitrary upstream errors', async (t) => {
  let error = Object.assign(new Error('PRIVATE UPSTREAM DETAIL'), { code: 'capability_refresh_cooldown', statusCode: 429 });
  const catchup = { start() {}, async stop() {}, status: () => ({}), async refreshCapabilities() { throw error; } };
  const { base } = await fixture(t, {}, { catchup });
  const endpoint = `${base}/_intermediary/v1/frigate/refresh`;
  let response = await post(endpoint, 'settings-test', { confirm: true });
  assert.equal(response.status, 429);
  assert.equal((await response.json()).code, 'capability_refresh_cooldown');
  error = Object.assign(new Error('PRIVATE UPSTREAM DETAIL'), { code: 'PRIVATE UPSTREAM DETAIL', statusCode: 500 });
  response = await post(endpoint, 'settings-test', { confirm: true });
  assert.doesNotMatch(await response.text(), /PRIVATE/);
});

test('backlog pages use read authorization and enforce bounded page parameters', async (t) => {
  const calls = [];
  const catchup = { start() {}, async stop() {}, status: () => ({}), jobs(page) { calls.push(page); return { ...page, total: 50, items: [] }; } };
  const { base } = await fixture(t, { observability: { auth_token: 'read-test' } }, { catchup });
  const endpoint = `${base}/_intermediary/v1/frigate/jobs`;
  assert.equal((await fetch(endpoint)).status, 401);
  for (const token of ['read-test', 'settings-test']) {
    const response = await fetch(`${endpoint}?offset=30&limit=30`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).total, 50);
  }
  for (const query of ['offset=-1', 'offset=NaN', 'limit=101', 'limit=0', 'limit=1.5', 'view=unknown']) {
    assert.equal((await fetch(`${endpoint}?${query}`, { headers: { authorization: 'Bearer read-test' } })).status, 400);
  }
  assert.deepEqual(calls, [{ offset: 30, limit: 30, view: 'all' }, { offset: 30, limit: 30, view: 'all' }]);
  for (const view of ['waiting', 'awaiting', 'retrying', 'attention', 'completed', 'skipped']) {
    const response = await fetch(`${endpoint}?view=${view}`, { headers: { authorization: 'Bearer read-test' } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).view, view);
    assert.equal(calls.at(-1).view, view);
  }
});

test('retry/recheck require settings authority, explicit confirmation and valid saved-job identifiers', async (t) => {
  const calls = [];
  const catchup = { start() {}, async stop() {}, status: () => ({ enabled: true }),
    retryJob: async (kind, id) => { calls.push(['retry', kind, id]); return { enabled: true }; },
    recheckJob: async (kind, id) => { calls.push(['recheck', kind, id]); return { enabled: true }; },
  };
  const { base } = await fixture(t, { observability: { auth_token: 'read-test' } }, { catchup });
  for (const action of ['retry', 'recheck']) {
    const endpoint = `${base}/_intermediary/v1/frigate/${action}`;
    const body = { confirm: true, kind: 'review', id: 'saved-job' };
    for (const token of ['', 'read-test', 'maintenance-test']) assert.equal((await post(endpoint, token, body)).status, 401);
    assert.equal((await fetch(endpoint)).status, 405);
    assert.equal((await post(endpoint, 'settings-test', { ...body, confirm: false })).status, 400);
    for (const invalid of [{ ...body, kind: 'all' }, { ...body, id: '' }, { ...body, id: 'x'.repeat(257) }, { ...body, id: 'bad\n' }]) {
      assert.equal((await post(endpoint, 'settings-test', invalid)).status, 400);
    }
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { authorization: 'Bearer settings-test' }, body: '{}' })).status, 415);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { authorization: 'Bearer settings-test', 'content-type': 'application/json' }, body: '{bad' })).status, 400);
    assert.equal((await post(endpoint, 'settings-test', body)).status, 202);
  }
  assert.deepEqual(calls, [['retry', 'review', 'saved-job'], ['recheck', 'review', 'saved-job']]);
});

test('catch-up controls expose only safe errors and cannot run without an administrative token', async (t) => {
  let failure = Object.assign(new Error('PRIVATE RESPONSE'), { code: 'handoff_outstanding', statusCode: 409 });
  const catchup = { start() {}, async stop() {}, status: () => ({}), async retryJob() { throw failure; } };
  const { base } = await fixture(t, {}, { catchup });
  const endpoint = `${base}/_intermediary/v1/frigate/retry`;
  const body = { confirm: true, kind: 'object', id: 'pending' };
  let response = await post(endpoint, 'settings-test', body);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'handoff_outstanding');
  failure = Object.assign(new Error('PRIVATE RESPONSE'), { code: 'PRIVATE RESPONSE', statusCode: 500 });
  response = await post(endpoint, 'settings-test', body);
  assert.doesNotMatch(await response.text(), /PRIVATE/);
  const disabled = await fixture(t, {}, { catchup, settingsToken: '' });
  assert.equal((await post(`${disabled.base}/_intermediary/v1/frigate/retry`, 'settings-test', body)).status, 503);
});

test('request memory admission includes bodies held by an active HTTP request', async (t) => {
  const { base, service } = await fixture(t, { server: { body_limit_bytes: 300 }, scheduler: { max_queue_bytes: 300 } });
  const body = { model: 'od-model', id: 'long', delay_ms: 150, prompt: 'x'.repeat(160) };
  const first = post(`${base}/api/generate`, '', body);
  await waitFor(() => service.scheduler.active);
  const rejected = await post(`${base}/api/generate`, '', { ...body, id: 'later' });
  assert.equal(rejected.status, 429);
  assert.equal((await rejected.json()).code, 'request_memory_full');
  await (await first).text();
  await waitFor(() => service.reservedBodyBytes === 0);
});

test('queued model management rechecks recovery and restart state before reaching Ollama', async (t) => {
  const { service, base, backend } = await fixture(t);
  for (const stopReason of ['recovery', 'restart']) {
    const release = await service.gate.acquire('inference');
    const pending = post(`${base}/api/pull`, '', { model: 'not-downloaded' });
    await waitFor(() => service.gate.managementPending);
    if (stopReason === 'recovery') service.backend.requireRecovery('test fault while queued');
    else service.beginSettingsRestart();
    release();
    const response = await pending;
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, stopReason === 'recovery' ? 'gpu_recovery_required' : 'shutting_down');
    assert.equal(backend.events.includes('/api/pull'), false);
    if (stopReason === 'recovery') service.backend.clearRecovery();
  }
});

test('recovery acknowledgment does not clear the latch if maintenance resumes during verification', async (t) => {
  const { service, base } = await fixture(t);
  service.backend.requireRecovery('test fault');
  await post(`${base}/_intermediary/v1/maintenance/pause`, 'maintenance-test', {});
  await waitFor(() => !service.gate.active && !service.maintenanceTask);
  let verifying = false;
  let finishVerification;
  const verified = new Promise((resolve) => { finishVerification = resolve; });
  service.backendClient.loadedModels = async () => { verifying = true; await verified; return []; };
  const pending = post(`${base}/_intermediary/v1/recovery/acknowledge`, 'maintenance-test', { confirm_gpu_recovered: true });
  await waitFor(() => verifying);
  await service.resumeMaintenance('test');
  finishVerification();
  const response = await pending;
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'recovery_state_changed');
  assert.equal(service.backend.recoveryRequired, true);
});

test('real catch-up worker waits through Odysseus request and idle hold before native Frigate handoff', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'intermediary-catchup-integration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let service;
  let base;
  let generated = 0;
  let nativeError;
  const item = { id: 'past-object', camera: 'driveway', label: 'person', start_time: Date.now()/1000-500, end_time: Date.now()/1000-400, data: {} };
  const client = {
    close() {}, capabilities: async () => ({ object: true, review: true }),
    getConfig: async () => ({ genai: { local: { roles: ['descriptions'] } }, cameras: {
      driveway: { enabled: true, objects: { genai: { enabled: true, use_snapshot: true } } },
    } }),
    list: async (kind, scan) => kind === 'object' && item.start_time > scan.after && item.start_time < scan.before ? [item] : [],
    get: async () => item, hasMedia: async () => true,
    regenerate: async () => {
      generated++;
      fetch(`${base}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ollama-client': 'frigate' },
        body: JSON.stringify({ model: 'f-model', id: 'catch-up', stream: false }),
      }).then(async (response) => { await response.text(); if (response.ok) item.data.description = 'Saved by Frigate'; else nativeError = response.status; }).catch((error) => { nativeError = error; });
      return { accepted: true };
    },
  };
  const workerConfig = testConfig({ frigate: {
    enabled: true, url: 'http://frigate.invalid', state_path: path.join(directory, 'jobs.json'),
    poll_interval: '10ms', live_grace: '0s', generation_timeout: '1s',
  } });
  const catchup = new FrigateCatchup(workerConfig, { logger: new SilentLogger(), client,
    canRun: () => service ? service.backgroundReadiness() : false });
  ({ service, base } = await fixture(t, { scheduler: { default_client: 'odysseus' } }, { catchup }));
  const active = post(`${base}/api/generate`, '', { model: 'od-model', id: 'foreground', delay_ms: 120 });
  await waitFor(() => service.scheduler.active);
  catchup.scanMissing();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(generated, 0);
  await (await active).text();
  await waitFor(() => catchup.status().totals.completed === 1);
  assert.equal(generated, 1);
  assert.equal(nativeError, undefined);
});

test('real timer confirms successive saved descriptions without another discovery poll and keeps GPU inference serial', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'intermediary-fast-catchup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let service;
  let base;
  const calls = [];
  const failures = [];
  const items = ['newer', 'older'].map((id, i) => ({ id, camera: 'driveway', label: 'person',
    start_time: Date.now() / 1000 - 500 - i * 10, end_time: Date.now() / 1000 - 400 - i * 10, data: {} }));
  const client = {
    close() {}, capabilities: async () => ({ object: true, review: false }),
    getConfig: async () => ({ genai: { local: { roles: ['descriptions'] } }, cameras: {
      driveway: { enabled: true, objects: { genai: { enabled: true, use_snapshot: true } } },
    } }),
    list: async (kind, scan) => items.filter((item) => item.start_time > scan.after && item.start_time < scan.before),
    get: async (kind, id) => items.find((item) => item.id === id), hasMedia: async () => true,
    regenerate: async (kind, id) => {
      calls.push(id);
      // Like Frigate, acknowledge now and save only after native inference ends.
      post(`${base}/api/generate`, '', { model: 'f-model', id, delay_ms: 50, stream: false })
        .then(async (response) => {
          await response.text();
          if (response.ok) items.find((item) => item.id === id).data.description = 'Saved';
          else failures.push(response.status);
        }).catch((error) => failures.push(error));
      return { accepted: true };
    },
  };
  const config = testConfig({ frigate: { enabled: true, url: 'http://frigate.invalid',
    state_path: path.join(directory, 'jobs.json'), poll_interval: '1h', confirmation_interval: '1s', live_grace: '0s' } });
  const catchup = new FrigateCatchup(config, { logger: new SilentLogger(), client,
    canRun: () => service ? service.backgroundReadiness() : false });
  const fixtureResult = await fixture(t, {}, { catchup });
  ({ service, base } = fixtureResult);
  assert.equal((await post(`${base}/_intermediary/v1/frigate/scan`, 'settings-test', { confirm: true })).status, 202);
  await waitFor(() => catchup.status().totals.completed === 2, 5_000);
  assert.deepEqual(calls, ['newer', 'older']);
  assert.deepEqual(failures, []);
  assert.equal(fixtureResult.backend.maxActive, 1);
  const history = await (await fetch(`${base}/_intermediary/v1/frigate/jobs?view=completed`)).json();
  assert.equal(history.total, 2);
  assert.equal(history.items.every((job) => job.state === 'completed'), true);
});
