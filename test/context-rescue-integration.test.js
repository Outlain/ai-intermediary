import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProxyService } from '../src/proxy.js';
import { MockOllama, requestJson, SilentLogger, testConfig, waitFor } from './helpers.js';

const input = { model: 'f-model', prompt: 'PRIVATE-INPUT', images: ['PRIVATE-IMAGE'], stream: false,
  options: { num_ctx: 8192, temperature: 0.2 }, format: 'json' };
const telemetry = () => ({ enabled: true, available: true, stale: false, bound: true,
  memory: { available: true, total_bytes: 30 * 1024 ** 3, available_bytes: 10 * 1024 ** 3 }, gpus: [{
  vram_free_bytes: 8 * 1024 ** 3, processes_known: true, processes: [{ is_ollama: true }], utilization_percent: 0,
}] });
const overflow = (tokens = 14407, context = 8192) => ({ error: JSON.stringify({ error: {
  code: 400, type: 'exceed_context_size_error', n_prompt_tokens: tokens, n_ctx: context,
} }) });

async function setup(t, rescue = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'context-rescue-http-'));
  const mock = new MockOllama();
  const backendUrl = await mock.start();
  const calls = [];
  const state = { modelLimit: 131072, host: telemetry(), mode: 'overflow', delay: 0, probes: 0 };
  const original = mock.handle.bind(mock);
  mock.handle = async (request, response) => {
    if (request.url === '/api/show') {
      await mock.body(request); state.probes++;
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ model_info: { 'general.architecture': 'qwen3vl', 'qwen3vl.context_length': state.modelLimit } }));
    }
    if (!['/api/generate', '/api/chat'].includes(request.url)) return original(request, response);
    const raw = await mock.body(request);
    const body = JSON.parse(raw);
    response.setHeader('content-type', 'application/json');
    if (body.keep_alive === 0) { mock.loadedModel = null; return response.end('{"done":true}'); }
    assert.equal(Number(request.headers['content-length']), raw.length);
    assert.equal(request.headers['x-ollama-intermediary-attempt'], undefined, 'bridge tickets never reach Ollama');
    calls.push(body);
    mock.loadedModel = body.model;
    mock.active++; mock.maxActive = Math.max(mock.maxActive, mock.active);
    response.once('close', () => { mock.active--; });
    if (state.delay) await new Promise((resolve) => setTimeout(resolve, state.delay));
    if (state.mode === 'socket') return response.destroy();
    if (state.mode === 'oom') { response.statusCode = 500; return response.end('{"error":"CUDA out of memory"}'); }
    if (state.mode === 'generic') { response.statusCode = 400; return response.end('{"error":"invalid format"}'); }
    if (state.mode === 'overflow-all' || (state.mode === 'overflow' && body.options?.num_ctx === 8192)) {
      response.statusCode = 400;
      return response.end(JSON.stringify(overflow(body.options.num_ctx === 8192 ? 14407 : 25000, body.options.num_ctx)));
    }
    response.end(JSON.stringify({ response: 'PRIVATE-OUTPUT', done: true }));
  };
  const config = testConfig({ ollama: { url: backendUrl, health_timeout: '1s' },
    gpu_safety: { recovery_state_path: path.join(directory, 'recovery.json') },
    maintenance: { enabled: true, auth_token: 'maintenance', state_path: path.join(directory, 'maintenance.json') },
    // Isolate rescue preflight in this suite; ordinary catch-up admission has
    // separate tests below. Rescue always checks RAM even with this disabled.
    host_helper: { enabled: true, memory_guard: { enabled: false } },
    frigate: { enabled: true, url: 'http://frigate.test:5000', state_path: path.join(directory, 'backlog.json'),
      live_grace: '0s', retry_interval: '1h', max_retry_interval: '5h',
      context_rescue: { enabled: true, model: 'f-model', max_context: 24576, ...rescue } },
  });
  const helper = { start() {}, stop() {}, snapshot: () => state.host, refresh: async () => state.host };
  const service = new ProxyService(config, { logger: new SilentLogger(), hostHelper: helper });
  const worker = service.catchup;
  worker.client.close();
  const row = { id: 'rescue-job', camera: 'yard', start_time: 100, end_time: 101, label: 'person', data: {} };
  const tickets = [];
  worker.client = {
    capabilities: async () => ({ object: true, review: true, bridge: true }),
    getConfig: async () => ({ genai: { local: { provider: 'ollama', roles: ['descriptions'] } },
      cameras: { yard: { enabled: true, objects: { genai: { enabled: true, use_snapshot: false } } } } }),
    list: async () => [], get: async () => structuredClone(row), hasMedia: async () => true, close() {},
    regenerate: async (_kind, _id, _source, ticket) => { tickets.push(ticket); return { accepted: true }; },
  };
  t.after(async () => { await service.stop(100); await mock.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  await service.start();
  const proxyUrl = `http://127.0.0.1:${service.addresses()[0].address.port}`;
  await waitFor(() => service.backend.canDispatch() && worker.capabilities.checked);
  const job = { id: row.id, kind: 'object', camera: row.camera, event_time: 100, state: 'pending', attempts: 0,
    failures: 0, created_at: Date.now(), first_failed_at: null, last_attempt_at: null, next_attempt_at: 0 };
  worker.state.jobs.push(job); worker.persist();
  await worker.processJobs();
  assert.equal(tickets.length, 1);
  const report = async (response) => {
    await response.text();
    const callback = await requestJson(`${proxyUrl}/_intermediary/v1/frigate/attempt`, { outcome: response.ok ? 'success' : 'failed' },
      { 'x-ollama-intermediary-attempt': tickets.at(-1) });
    assert.equal(callback.status, 202); await callback.text();
    await waitFor(() => !service.scheduler.active);
    return response.status;
  };
  const send = async (body = input, route = '/api/generate') => report(await requestJson(proxyUrl + route, body,
    { 'x-ollama-intermediary-attempt': tickets.at(-1) }));
  const retry = async () => {
    await waitFor(() => service.reservedBodyBytes === 0 && service.backgroundReadiness().allowed);
    const count = tickets.length;
    worker.retryJob('object', row.id);
    await worker.processJobs();
    await waitFor(() => tickets.length === count + 1);
  };
  return { config, service, worker, helper, mock, state, calls, job, row, tickets, proxyUrl, report, send, retry };
}

test('catch-up RAM pressure pauses admission and pre-dispatch while live requests keep their normal path', async (t) => {
  const f = await setup(t);
  f.config.host_helper.memory_guard.enabled = true;
  f.state.host.memory.available_bytes = 1024 ** 3;
  assert.equal(f.service.backgroundReadiness().reason, 'host_memory_low');
  assert.equal(await f.send(), 503, 'RAM can drop after the native handoff');
  assert.equal(f.calls.length, 0, 'no inference reached Ollama');
  assert.equal(f.job.state, 'retrying');
  assert.equal(f.service.backend.recoveryRequired, false);
  assert.equal(f.service.backend.canDispatch(), true);
  f.state.mode = 'success';
  const live = await requestJson(f.proxyUrl + '/api/generate', input);
  assert.equal(live.status, 200);
  await live.text();
  await waitFor(() => !f.service.scheduler.active);
  f.state.host.memory.available_bytes = 10 * 1024 ** 3;
  await f.retry();
  assert.equal(await f.send(), 200);
  assert.equal(f.mock.maxActive, 1);
});

test('confirmed catch-up overflow gets one larger later dispatch, unchanged content, single GPU and separate saved confirmation', async (t) => {
  const f = await setup(t);
  assert.equal(await f.send(), 400);
  assert.equal(f.job.state, 'retrying');
  assert.equal(f.job.reason, 'context_overflow');
  assert.equal(f.state.probes, 0, 'no extra model probe for ordinary traffic');
  assert.equal(f.worker.status().totals.completed, 0);
  await f.retry();
  assert.equal(await f.send(), 200);
  assert.equal(f.job.context_rescue.attempted, true);
  assert.equal(f.job.context_rescue.reason, 'rescue_request_succeeded');
  assert.equal(f.job.state, 'waiting_result');
  assert.equal(f.job.attempt.phase, 'verifying_saved');
  assert.equal(f.worker.status().totals.completed, 0, 'HTTP success is not a saved description');
  assert.equal(f.calls[1].options.num_ctx, 20480);
  assert.deepEqual({ ...f.calls[1], options: { ...f.calls[1].options, num_ctx: 8192 } }, f.calls[0]);
  assert.equal(f.calls[1].images[0], 'PRIVATE-IMAGE');
  assert.equal(f.mock.maxActive, 1);
  await waitFor(() => f.service.reservedBodyBytes === 0);
  const saved = fs.readFileSync(f.config.frigate.state_path, 'utf8');
  assert.doesNotMatch(saved, /PRIVATE/);
  assert.doesNotMatch(JSON.stringify(f.worker.status()), /signature|ticket_hash|PRIVATE/);
  f.row.data.description = 'Saved by Frigate';
  await f.worker.processJobs();
  assert.equal(f.worker.status().totals.completed, 1);
});

test('failed enlargement never loops into further enlargement or resends identical insufficient input', async (t) => {
  const f = await setup(t); f.state.mode = 'overflow-all';
  assert.equal(await f.send(), 400);
  await f.retry(); assert.equal(await f.send(), 400);
  assert.equal(f.job.context_rescue.reason, 'rescue_request_failed');
  await f.retry(); assert.equal(await f.send(), 422);
  assert.equal(f.calls.length, 2);
  assert.equal(f.job.reason, 'rescue_used');
  assert.equal(f.job.failures, 3);
  assert.equal(f.service.backend.recoveryRequired, false);
});

for (const [name, change, reason] of [
  ['tested cap', (f) => { f.config.frigate.context_rescue.max_context = 16384; }, 'rescue_above_cap'],
  ['model limit', (f) => { f.state.modelLimit = 16384; }, 'rescue_model_limit'],
  ['unknown model limit', (f) => { f.state.modelLimit = null; }, 'rescue_model_unknown'],
  ['stale GPU readings', (f) => { f.state.host.stale = true; }, 'rescue_telemetry_unavailable'],
  ['foreign GPU process', (f) => { f.state.host.gpus[0].processes = [{ is_ollama: false }]; }, 'rescue_gpu_busy'],
  ['insufficient VRAM', (f) => { f.state.host.gpus[0].vram_free_bytes = 1; }, 'rescue_vram_headroom'],
  ['insufficient host RAM', (f) => { f.state.host.memory.available_bytes = 3 * 1024 ** 3; }, 'rescue_host_memory_low'],
  ['unknown host RAM', (f) => { delete f.state.host.memory; }, 'rescue_host_memory_unavailable'],
  ['host memory pressure', (f) => { f.state.host.memory.pressure_full_avg10 = 20; }, 'rescue_host_memory_pressure'],
  ['body memory limit', (f) => { f.config.server.body_limit_bytes = Buffer.byteLength(JSON.stringify({ ...input, keep_alive: '1s' })); }, 'rescue_body_limit'],
]) test(`rescue refuses ${name} locally without a GPU run, consumed attempt or recovery restart`, async (t) => {
  const f = await setup(t);
  await f.send(); change(f); await f.retry();
  assert.equal(await f.send(), 422);
  assert.equal(f.calls.length, 1);
  assert.equal(f.job.reason, reason);
  assert.equal(f.job.context_rescue.attempted, false);
  assert.equal(f.service.backend.recoveryRequired, false);
  assert.equal(f.service.backend.canDispatch(), true);
});

test('changed regenerated media cannot borrow old overflow evidence; live traffic and Odysseus never qualify', async (t) => {
  const f = await setup(t);
  await f.send(); await f.retry();
  assert.equal(await f.send({ ...input, images: ['CHANGED'] }), 400);
  assert.equal(f.calls[1].options.num_ctx, 8192);
  for (const client of ['frigate', 'odysseus']) {
    const response = await requestJson(f.proxyUrl + '/api/generate', input, { 'x-ollama-client': client });
    assert.equal(response.status, 400); await response.text();
  }
  assert.equal(f.calls.length, 4);
  assert.ok(f.calls.every((call) => call.options.num_ctx === 8192));
  assert.equal(f.state.probes, 0);
});

test('disabled rescue and generic errors preserve normal retry behavior', async (t) => {
  const f = await setup(t, { enabled: false });
  await f.send(); await f.retry(); await f.send();
  assert.equal(f.job.context_rescue, undefined);
  assert.ok(f.calls.every((call) => call.options.num_ctx === 8192));
  f.config.frigate.context_rescue.enabled = true;
  f.state.mode = 'generic'; await f.retry(); await f.send();
  assert.equal(f.job.context_rescue, undefined);
  assert.equal(f.job.reason, 'http_400');
});

test('native chat requests are rescued without changing messages, image inputs or output options', async (t) => {
  const f = await setup(t);
  const body = { model: 'f-model', stream: false, options: { num_ctx: 8192, num_predict: 4096 },
    messages: [{ role: 'user', content: 'PRIVATE-INPUT', images: ['PRIVATE-IMAGE'] }] };
  assert.equal(await f.send(body, '/api/chat'), 400);
  await f.retry(); assert.equal(await f.send(body, '/api/chat'), 200);
  assert.deepEqual(f.calls[1].messages, body.messages);
  assert.equal(f.calls[1].options.num_predict, 4096);
  assert.equal(f.calls[1].options.num_ctx, 20480);
});

test('GPU allocation failures never qualify for enlargement', async (t) => {
  const f = await setup(t); f.state.mode = 'oom';
  assert.equal(await f.send(), 500);
  assert.equal(f.job.context_rescue, undefined);
  assert.equal(f.state.probes, 0);
  assert.equal(f.service.backend.recoveryRequired, true);
});

test('busy rescue defers without failure escalation and later automatically qualifies for enlargement', async (t) => {
  const f = await setup(t);
  await f.send();
  const failures = f.job.failures, firstFailure = f.job.first_failed_at;
  await f.retry();
  f.state.host.gpus[0].utilization_percent = 2;
  assert.equal(await f.send(), 422);
  assert.equal(f.job.failures, failures);
  assert.equal(f.job.first_failed_at, firstFailure);
  assert.equal(f.job.context_rescue.attempted, false);
  assert.equal(f.job.reason, 'rescue_gpu_busy');
  assert.ok(f.job.next_attempt_at <= Date.now() + 30000);
  assert.equal(f.service.observability.recent().at(-1).type, 'request_deferred');
  f.state.host.gpus[0].utilization_percent = 0;
  // Simulate the ordinary eligibility clock, not a manual retry operation.
  f.job.next_attempt_at = 0;
  await f.worker.processJobs();
  assert.equal(await f.send(), 200);
  assert.equal(f.job.context_rescue.attempted, true);
  assert.equal(f.mock.maxActive, 1);
});

test('pause after native handoff defers without sending inference or spending a rescue', async (t) => {
  const f = await setup(t);
  await f.send(); await f.retry();
  const failures = f.job.failures;
  f.service.workPolicy.pause({ sources: ['frigate'], traffic: 'catchup' });
  assert.equal(await f.send(), 503);
  assert.equal(f.job.failures, failures);
  assert.equal(f.job.reason, 'manual_source_pause');
  assert.equal(f.job.context_rescue.attempted, false);
  assert.equal(f.calls.length, 1);
});

test('failed rescue intent persistence prevents the enlarged HTTP request and fails closed', async (t) => {
  const f = await setup(t);
  await f.send(); await f.retry();
  const persist = f.worker.persist.bind(f.worker);
  f.worker.persist = () => {
    if (f.job.context_rescue?.attempted) { f.worker.storeError = 'backlog_state_write_failed'; return false; }
    return persist();
  };
  const response = await requestJson(f.proxyUrl + '/api/generate', input, { 'x-ollama-intermediary-attempt': f.tickets.at(-1) });
  await response.text();
  assert.equal(response.status, 502);
  assert.equal(f.calls.length, 1);
  await waitFor(() => f.service.backend.recoveryRequired);
  const saved = JSON.parse(fs.readFileSync(f.config.frigate.state_path, 'utf8'));
  assert.equal(saved.jobs[0].context_rescue.attempted, false);
  assert.equal(saved.jobs[0].attempt.phase, 'running', 'restart reconciles uncertain state rather than dispatching immediately');
});

test('pause during rescue preflight prevents dispatch and does not consume the rescue', async (t) => {
  const f = await setup(t);
  await f.send(); await f.retry();
  let finish;
  f.helper.refresh = () => new Promise((resolve) => { finish = resolve; });
  const pending = f.send();
  await waitFor(() => finish);
  await f.service.pauseMaintenance({}, 'test');
  finish(f.state.host);
  assert.equal(await pending, 503);
  assert.equal(f.calls.length, 1);
  assert.equal(f.job.context_rescue.attempted, false);
  assert.equal(f.service.backend.recoveryRequired, false);
});

test('ambiguous enlarged dispatch consumes the rescue and retains the existing GPU recovery lock', async (t) => {
  const f = await setup(t);
  await f.send(); await f.retry(); f.state.mode = 'socket';
  assert.equal(await f.send(), 503);
  assert.equal(f.job.context_rescue.attempted, true);
  assert.equal(f.job.context_rescue.reason, 'rescue_outcome_uncertain');
  assert.equal(f.service.backend.recoveryRequired, true);
  assert.equal(f.worker.requiresRecovery, true);
  assert.equal(f.calls.length, 2);
});

test('Odysseus and live Frigate queued before rescue are served first through the same one-inference gate', async (t) => {
  const f = await setup(t);
  await f.send(); await f.retry();
  const release = await f.service.gate.acquire('management');
  const odysseus = requestJson(f.proxyUrl + '/api/generate', { model: 'f-model', id: 'odysseus', prompt: 'live' }, { 'x-ollama-client': 'odysseus' });
  const live = requestJson(f.proxyUrl + '/api/generate', { model: 'f-model', id: 'live-frigate', prompt: 'live' }, { 'x-ollama-client': 'frigate' });
  const rescue = f.send();
  await waitFor(() => f.service.scheduler.jobs.filter((job) => job.state === 'queued').length === 3);
  f.state.delay = 20;
  release();
  for (const response of await Promise.all([odysseus, live])) { assert.equal(response.status, 200); await response.text(); }
  assert.equal(await rescue, 200);
  assert.deepEqual(f.calls.slice(1).map((call) => call.id ?? 'rescue'), ['odysseus', 'live-frigate', 'rescue']);
  assert.equal(f.mock.maxActive, 1);
});
