import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { ProxyService } from '../src/proxy.js';
import { MediaStore } from '../src/media-store.js';
import { MockOllama, SilentLogger, requestJson, testConfig, waitFor } from './helpers.js';

const workflow = { '7': { class_type: 'TestImage', inputs: { text: 'private image prompt' } } };
const token = 'a-private-media-test-token';
const headers = { authorization: `Bearer ${token}`, 'x-ollama-client': 'media' };

class FakeComfy {
  constructor() { this.submitted = []; this.records = new Map(); this.interruptions = []; this.freed = 0; this.deleted = []; }
  async bridgeStatus() { return { protocol: 'ai-intermediary-comfy-v1', local_only: true }; }
  async queue() { return { queue_running: [...this.records].filter(([, value]) => value.state === 'running').map(([id]) => [0, id, {}, {}, []]), queue_pending: [] }; }
  async requestFree() { this.freed += 1; }
  async releaseEvidence() { return { idle: !(await this.queue()).queue_running.length, released: !(await this.queue()).queue_running.length }; }
  async objectInfo() { return { TestImage: { input: {} } }; }
  async submit(value, { promptId, beforeDispatch }) {
    await this.beforeSubmit?.(promptId);
    beforeDispatch?.();
    this.submitted.push(promptId);
    this.records.set(promptId, { state: 'running', terminal: false, artifacts: [] });
    return { prompt_id: promptId };
  }
  async inspect(id) {
    if (this.inspectError) throw Object.assign(new Error('transport closed'), { code: 'comfy_disconnected' });
    return this.records.get(id) ?? { state: 'unknown', terminal: false };
  }
  complete(id, artifacts = []) { this.records.set(id, { state: 'completed', terminal: true, artifacts }); }
  async history(id) { return { [id]: { outputs: { '7': { images: this.records.get(id)?.artifacts ?? [] } }, status: { completed: true, status_str: 'success' } } }; }
  async artifactResponse() { return new Response(Buffer.from('PNG'), { headers: { 'content-type': 'image/png' } }); }
  async deleteArtifacts(id) { this.deleted.push(id); }
  async interrupt(id) { this.interruptions.push(id); this.records.set(id, { state: 'interrupted', terminal: true, artifacts: [] }); }
}

test('a pause arriving during Comfy preflight requeues the durable job without POST or recovery lock', async (t) => {
  const { service, comfy } = await setup(t);
  comfy.beforeSubmit = async () => { service.scheduler.pause(); };
  const job = await service.media.submit({ source: 'media', backend: 'comfy', workflow });
  await waitFor(() => service.scheduler.paused && !service.scheduler.active);
  assert.equal(service.media.store.get(job.id).state, 'queued');
  assert.equal(service.media.blocked, false);
  assert.deepEqual(comfy.submitted, []);
  comfy.beforeSubmit = null;
  service.scheduler.resume();
  await waitFor(() => comfy.submitted.includes(job.id));
  comfy.complete(job.id);
  await waitFor(() => service.media.store.get(job.id).state === 'completed');
});

test('definite Comfy validation rejection fails only that job, never locks healthy LLM work', async (t) => {
  const { service, comfy, proxyUrl, mock } = await setup(t);
  comfy.beforeSubmit = async () => { throw Object.assign(new Error('rejected'), { code: 'backend_http_error', status: 400, definiteRejection: true }); };
  const job = await service.media.submit({ source: 'media', backend: 'comfy', workflow });
  await waitFor(() => service.media.store.get(job.id).state === 'failed');
  assert.equal(service.media.blocked, false);
  const response = await requestJson(`${proxyUrl}/api/generate`, { model: 'od-model', id: 'after-rejected-media' });
  await response.text();
  assert.equal(response.status, 200);
  assert.deepEqual(mock.order, ['after-rejected-media']);
  assert.deepEqual(comfy.submitted, []);
});

test('cancelling selected but undispatched media does not raise GPU recovery', async (t) => {
  const { service, comfy } = await setup(t);
  let releaseInfo;
  comfy.objectInfo = () => new Promise((resolve) => { releaseInfo = resolve; });
  const job = await service.media.submit({ source: 'media', backend: 'comfy', workflow });
  await waitFor(() => Boolean(releaseInfo));
  await service.media.cancel(job.id);
  releaseInfo({ TestImage: { input: {} } });
  await waitFor(() => !service.scheduler.active);
  assert.equal(service.media.store.get(job.id).state, 'cancelled');
  assert.equal(service.media.blocked, false);
  assert.deepEqual(comfy.submitted, []);
});

test('invalid browser client ID is rejected before durable admission', async (t) => {
  const { service } = await setup(t);
  await assert.rejects(service.media.submit({ source: 'media', backend: 'comfy', workflow, clientId: 'unsafe\nclient' }), { code: 'invalid_client_id' });
  assert.deepEqual(service.media.store.list(), []);
});

test('media login preserves the browser form origin without accepting null or foreign origins', async (t) => {
  const { service } = await setup(t);
  const admin = 'browser-form-test-password';
  service.config.security = { auth_mode: 'single_admin', admin_token: admin };
  await service.startServer('127.0.0.1:0', 'media');
  const url = `http://127.0.0.1:${service.addresses().find((entry) => entry.forcedClient === 'media').address.port}`;
  const page = await fetch(url);
  // Node fetch does not apply document referrer policies. Native browser form
  // POSTs under no-referrer send Origin: null, even back to the same host.
  assert.equal(page.headers.get('referrer-policy'), 'same-origin');
  assert.match(page.headers.get('content-security-policy'), /form-action 'self'/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /method="post" action="\/media-login"/);
  const submit = (origin, password = admin) => fetch(`${url}/media-login`, {
    method: 'POST', body: new URLSearchParams({ token: password }), redirect: 'manual',
    headers: { origin },
  });
  for (const origin of ['null', 'https://untrusted.invalid', 'http://127.0.0.1:1', 'not-an-origin']) {
    const rejected = await submit(origin);
    assert.equal(rejected.status, 403, `${origin} must remain rejected`);
    assert.equal(rejected.headers.has('set-cookie'), false);
    assert.equal((await rejected.json()).error, 'Cross-origin login rejected.');
  }
  const incorrect = await submit(url, 'incorrect-password');
  assert.equal(incorrect.status, 401);
  assert.equal(incorrect.headers.has('set-cookie'), false);
  assert.equal((await incorrect.json()).error, 'Incorrect administrator password.');
  const login = await submit(url);
  assert.equal(login.status, 303);
  assert.equal(login.headers.get('location'), '/');
  const sessionCookie = login.headers.get('set-cookie');
  assert.match(sessionCookie, /HttpOnly; SameSite=Strict/);
  const cookie = sessionCookie.split(';')[0];
  assert.equal((await fetch(`${url}/api/queue`, { headers: { cookie } })).status, 200);
  for (const origin of ['null', 'https://untrusted.invalid']) {
    const mutation = await fetch(`${url}/api/prompt`, {
      method: 'POST', headers: { cookie, origin }, body: '{}',
    });
    assert.equal(mutation.status, 403, 'a valid session must not bypass mutation origin checks');
    assert.equal((await mutation.json()).error, 'Cross-origin mutation rejected.');
  }
});

test('single-admin media login uses the admin password, never the derived bridge credential', async (t) => {
  const { service, proxyUrl } = await setup(t);
  const admin = 'one-private-administrator-password';
  service.config.security = { auth_mode: 'single_admin', admin_token: admin };
  await service.startServer('127.0.0.1:0', 'media');
  const url = `http://127.0.0.1:${service.addresses().find((entry) => entry.forcedClient === 'media').address.port}`;
  const page = await fetch(url);
  const html = await page.text();
  assert.match(html, /same password as the dashboard and Settings/);
  assert.equal(html.includes('separate MEDIA_TOKEN'), false);
  const endpoint = `${proxyUrl}/_intermediary/v1/media/jobs`;
  assert.equal((await fetch(endpoint, { headers: { authorization: `Bearer ${token}` } })).status, 401);
  const accepted = await fetch(endpoint, { headers: { authorization: `Bearer ${admin}` } });
  assert.equal(accepted.status, 200);
  const rejectedLogin = await fetch(`${url}/media-login`, {
    method: 'POST', body: new URLSearchParams({ token }), redirect: 'manual',
  });
  assert.equal(rejectedLogin.status, 401);
  const crossOriginLogin = await fetch(`${url}/media-login`, {
    method: 'POST', body: new URLSearchParams({ token: admin }), redirect: 'manual',
    headers: { origin: 'https://untrusted.invalid' },
  });
  assert.equal(crossOriginLogin.status, 403);
  const login = await fetch(`${url}/media-login`, {
    method: 'POST', body: new URLSearchParams({ token: admin }), redirect: 'manual',
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(`${url}/api/queue`, { headers: { cookie } })).status, 200);
  assert.equal(service.observabilitySnapshot().authentication.mode, 'single_admin');
  assert.equal(JSON.stringify(service.observabilitySnapshot()).includes(admin), false);
  service.config.security.admin_token = '&'.repeat(4096);
  const escapedLogin = await fetch(`${url}/media-login`, {
    method: 'POST', body: new URLSearchParams({ token: service.config.security.admin_token }), redirect: 'manual',
  });
  assert.equal(escapedLogin.status, 303, 'form encoding must not reject a valid maximum-length credential');
});

test('shutdown before Comfy dispatch preserves accepted workflow for a later restart', async (t) => {
  const { service, comfy } = await setup(t);
  let entered = false;
  comfy.objectInfo = ({ signal }) => new Promise((resolve, reject) => {
    entered = true;
    signal.addEventListener('abort', () => reject(Object.assign(new Error('shutdown before submit'),
      { code: 'request_aborted', beforeDispatch: true })), { once: true });
  });
  const job = await service.media.submit({ source: 'media', backend: 'comfy', workflow });
  await waitFor(() => entered);
  await service.stop(10);
  assert.equal(service.media.store.get(job.id).state, 'queued');
  assert.deepEqual(service.media.store.getInternal(job.id).workflow, workflow);
  assert.deepEqual(comfy.submitted, []);
});

test('temporary failure before Comfy POST retains and retries the accepted job after verification', async (t) => {
  const { service, comfy } = await setup(t);
  let attempts = 0;
  comfy.beforeSubmit = async () => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error('object metadata timed out'),
      { code: 'backend_transport_error', beforeDispatch: true });
  };
  const job = await service.media.submit({ source: 'media', backend: 'comfy', workflow });
  await waitFor(() => comfy.submitted.includes(job.id));
  assert.equal(attempts, 2);
  assert.deepEqual(comfy.submitted, [job.id]);
  comfy.complete(job.id);
  await waitFor(() => service.media.store.get(job.id).state === 'completed');
});

async function setup(t, { directory, comfy = new FakeComfy(), paused = false, overlay = {} } = {}) {
  const owned = !directory;
  directory ??= fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'media-integration-')));
  const mock = new MockOllama();
  const url = await mock.start();
  const config = testConfig({
    backends: { ollama: { type: 'ollama', url }, comfy: { type: 'comfyui', url: 'http://127.0.0.1:8188' } },
    media: { enabled: true, auth_token: token, allowed_node_types: ['TestImage'], stable_samples: 2,
      state_path: path.join(directory, 'media-jobs.json'), storage_path: path.join(directory, 'media') },
    maintenance: { enabled: true, auth_token: 'test-maintenance-token', state_path: path.join(directory, 'maintenance.json') },
    gpu_safety: { state_path: path.join(directory, 'gpu-state.json'), unload_timeout: '1s' },
    host_helper: { enabled: true },
    clients: { media: { backend: 'comfy', allowed_backends: ['comfy'], priority: 50, model_policy: { idle_hold: '0ms' } } },
    models: { 'od-model': { idle_hold: '0ms' } }, ...overlay,
  });
  config.media.pollIntervalMs = 5;
  config.media.jobTimeoutMs = 2000;
  let sample = 0;
  const snapshot = () => ({ enabled: true, available: true, bound: true, stale: false, sampled_at: ++sample,
    gpus: [{ id: '0', processes_known: true, processes: [], vram_used_bytes: 0, utilization_percent: 0 }],
    memory: { available: true, available_bytes: 24 * 1024 ** 3, total_bytes: 30 * 1024 ** 3, pressure_full_avg10: 0 } });
  const helper = { start() {}, stop() {}, refresh: async () => snapshot(), snapshot };
  const service = new ProxyService(config, { logger: new SilentLogger(), hostHelper: helper, media: { adapters: new Map([['comfy', comfy]]) } });
  if (paused) service.scheduler.pause();
  await service.start();
  t.after(async () => {
    await service.stop(10);
    await mock.stop();
    if (owned) fs.rmSync(directory, { recursive: true, force: true });
  });
  await waitFor(() => service.backend.canDispatch());
  const proxyUrl = `http://127.0.0.1:${service.addresses()[0].address.port}`;
  return { directory, config, mock, comfy, service, proxyUrl };
}

test('media and LLMs share one nonpreemptive gate; higher-priority chat runs between media jobs', async (t) => {
  const { service, mock, comfy, config, proxyUrl } = await setup(t);
  comfy.beforeSubmit = async (id) => {
    assert.equal(service.gate.active, true);
    assert.equal(mock.active, 0);
    assert.equal(JSON.parse(fs.readFileSync(config.media.state_path, 'utf8')).jobs.find((job) => job.id === id).state, 'dispatching');
  };
  const first = await service.media.submit({ source: 'media', backend: 'comfy', workflow });
  await waitFor(() => comfy.submitted.includes(first.id));
  assert.equal(service.scheduler.active.mediaId, first.id);
  const second = await service.media.submit({ source: 'media', backend: 'comfy', workflow });
  const chat = requestJson(`${proxyUrl}/api/generate`, { model: 'od-model', id: 'chat-between-videos', delay_ms: 30 });
  await waitFor(() => service.scheduler.jobs.some((job) => job.client === 'odysseus'));
  assert.deepEqual(mock.order, []);
  assert.deepEqual(comfy.submitted, [first.id]);
  comfy.complete(first.id);
  await waitFor(() => mock.order.includes('chat-between-videos'));
  assert.equal(service.media.store.get(second.id).state, 'queued');
  await (await chat).text();
  await waitFor(() => comfy.submitted.includes(second.id));
  comfy.complete(second.id);
  await waitFor(() => service.media.store.get(second.id).state === 'completed');
  assert.equal(service.media.store.get(first.id).state, 'completed');
  assert.equal(mock.maxActive, 1);
});

test('accepted durable media survives pauses while new paused submissions are rejected', async (t) => {
  const { service, comfy } = await setup(t);
  service.scheduler.pause();
  service.config.clients.media.queue_while_paused = true;
  const accepted = await service.media.submit({ source: 'media', backend: 'comfy', workflow });
  service.config.clients.media.queue_while_paused = false;
  await assert.rejects(service.media.submit({ source: 'media', backend: 'comfy', workflow }), { code: 'maintenance_paused' });
  service.scheduler.enforcePauses();
  assert.equal(service.media.store.get(accepted.id).state, 'queued');
  assert.equal(service.scheduler.jobs[0].deadline, Infinity);
  assert.deepEqual(comfy.submitted, []);
  service.scheduler.resume();
  await waitFor(() => comfy.submitted.includes(accepted.id));
  comfy.complete(accepted.id);
  await waitFor(() => service.media.store.get(accepted.id).state === 'completed');
});

test('uncertain transport never replays media or allows subsequent LLM GPU work', async (t) => {
  const { service, comfy, proxyUrl, mock } = await setup(t);
  const job = await service.media.submit({ source: 'media', backend: 'comfy', workflow });
  await waitFor(() => comfy.submitted.includes(job.id));
  comfy.inspectError = true;
  await waitFor(() => service.media.store.get(job.id).state === 'uncertain');
  const response = await requestJson(`${proxyUrl}/api/generate`, { model: 'od-model', id: 'must-not-run' });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'media_recovery_required');
  assert.deepEqual(mock.order, []);
  assert.deepEqual(comfy.submitted, [job.id]);
  assert.equal(service.media.blocked, true);
});

test('shutdown of active media persists uncertainty; queued work is not dispatched again on restart', async (t) => {
  const { service, comfy, config } = await setup(t);
  const job = await service.media.submit({ source: 'media', backend: 'comfy', workflow });
  await waitFor(() => comfy.submitted.includes(job.id));
  await service.stop(5);
  const restored = new MediaStore(config.media);
  await restored.init();
  assert.equal(restored.get(job.id).state, 'uncertain');
  assert.deepEqual(restored.queued(), []);
  assert.deepEqual(comfy.submitted, [job.id]);
});

test('graceful shutdown keeps host telemetry alive through active media release without dispatching queued work', async (t) => {
  const { service, comfy, config } = await setup(t);
  let helperStopped = false;
  let releaseSamples = 0;
  let stoppedAfterCompletion = false;
  const originalRefresh = service.hostHelper.refresh;
  service.hostHelper.refresh = async () => {
    assert.equal(helperStopped, false, 'physical release checks require a live host-helper client');
    if (!service.running) releaseSamples += 1;
    return originalRefresh();
  };
  const active = await service.media.submit({ source: 'media', backend: 'comfy', workflow });
  await waitFor(() => service.media.store.get(active.id).state === 'running');
  const queued = await service.media.submit({ source: 'media', backend: 'comfy', workflow });
  service.hostHelper.stop = () => {
    helperStopped = true;
    stoppedAfterCompletion = service.media.store.get(active.id).state === 'completed'
      && !service.scheduler.active && !service.gate.active;
  };
  const stopping = service.stop(1000);
  assert.equal(service.scheduler.accepting, false, 'queue admission closes before shutdown awaits');
  assert.equal(helperStopped, false);
  comfy.complete(active.id);
  await stopping;
  assert.equal(helperStopped, true);
  assert.equal(stoppedAfterCompletion, true);
  assert.ok(releaseSamples >= config.media.stable_samples);
  assert.equal(service.media.store.get(active.id).state, 'completed');
  assert.equal(service.media.store.get(queued.id).state, 'queued');
  assert.equal(service.media.blocked, false);
  assert.deepEqual(comfy.submitted, [active.id]);
  const restored = new MediaStore(config.media);
  await restored.init();
  assert.equal(restored.get(active.id).state, 'completed');
  assert.equal(restored.get(queued.id).state, 'queued');
});

test('media API authenticates separately and returns durable job metadata without prompt contents', async (t) => {
  const { service, proxyUrl } = await setup(t);
  service.scheduler.pause();
  service.config.clients.media.queue_while_paused = true;
  const endpoint = `${proxyUrl}/_intermediary/v1/media/jobs`;
  assert.equal((await requestJson(endpoint, { workflow })).status, 401);
  const created = await requestJson(endpoint, { workflow }, headers);
  assert.equal(created.status, 202);
  const record = await created.json();
  assert.equal(record.workflow, undefined);
  assert.equal(record.state, 'queued');
  const listed = await fetch(endpoint, { headers });
  const text = await listed.text();
  assert.equal(text.includes('private image prompt'), false);
  const cancelled = await requestJson(`${endpoint}/${record.id}/cancel`, {}, headers);
  assert.equal(cancelled.status, 202);
  assert.equal(service.media.store.get(record.id).state, 'cancelled');
  assert.equal(service.scheduler.active, null);
});

test('saved video remains playable and listed when cleanup fails; restart reconciliation never regenerates it', async (t) => {
  const { service, comfy, config, proxyUrl, mock } = await setup(t);
  await service.startServer('127.0.0.1:0', 'media');
  const url = `http://127.0.0.1:${service.addresses().find((entry) => entry.forcedClient === 'media').address.port}`;
  const video = { filename: 'node-7_00001_.mp4', subfolder: 'owned', type: 'output' };
  comfy.history = async (id) => ({ [id]: { outputs: { '7': { videos: [video] } } } });
  comfy.artifactResponse = async () => new Response('0123456789', { headers: { 'content-type': 'video/mp4' } });
  const job = await service.media.submit({ source: 'media', backend: 'comfy', workflow });
  await waitFor(() => comfy.submitted.includes(job.id));
  const release = service.media.releaseComfy.bind(service.media);
  service.media.releaseComfy = async () => {
    assert.equal(service.media.store.get(job.id).outputsImported, true, 'copy must finish before unload');
    throw Object.assign(new Error('lost backend during unload'), { code: 'comfy_release_unconfirmed' });
  };
  comfy.complete(job.id, [video]);
  await waitFor(() => service.media.store.get(job.id).state === 'uncertain' && !service.scheduler.active);
  assert.equal(service.media.blocked, true);
  assert.deepEqual(comfy.deleted, []);
  assert.deepEqual(service.mediaGateway.queue('media', 'comfy').queue_running, []);
  const list = await (await fetch(`${url}/api/jobs?status=completed`, { headers })).json();
  assert.equal(list.jobs[0].status, 'completed');
  assert.ok(list.jobs[0].preview_output);
  assert.equal(list.jobs[0].intermediary.recovery_required, true);
  const assets = await (await fetch(`${url}/api/assets?include_tags=output&limit=1`, { headers })).json();
  assert.equal(assets.assets.length, 1);
  const view = `${url}${assets.assets[0].preview_url}`;
  const get = (extra = {}, method = 'GET') => fetch(view, { method, headers: { ...headers, ...extra } });
  assert.equal(await (await get()).text(), '0123456789');
  for (const [range, expected, value] of [['bytes=0-1', 'bytes 0-1/10', '01'], ['bytes=-3', 'bytes 7-9/10', '789'], ['bytes=8-', 'bytes 8-9/10', '89']]) {
    const response = await get({ range });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), expected);
    assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.equal(await response.text(), value);
  }
  const head = await get({}, 'HEAD');
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(await head.text(), '');
  for (const range of ['bytes=10-', 'bytes=0-1,3-4', 'bytes=-0', 'broken']) {
    const response = await get({ range });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-range'), 'bytes */10');
    await response.text();
  }
  assert.equal((await get({ range: 'bytes=0-1', 'if-range': '"wrong"' })).status, 200);
  const refused = await requestJson(`${proxyUrl}/api/generate`, { model: 'od-model', id: 'must-not-run' });
  assert.equal(refused.status, 503);
  await refused.text();
  assert.deepEqual(mock.order, []);
  // Simulate broker restart and complete loss of ComfyUI's RAM-only history.
  const restored = new MediaStore(config.media);
  await restored.init();
  service.media.store = restored;
  comfy.inspect = async () => { throw new Error('History is gone; persisted proof must be used'); };
  comfy.artifactResponse = async () => { throw new Error('Imported bytes must not be fetched again'); };
  service.media.releaseComfy = release;
  await service.media.reconcile(new AbortController().signal);
  assert.equal(restored.get(job.id).state, 'completed');
  assert.equal(service.media.blocked, false);
  assert.deepEqual(comfy.submitted, [job.id]);
  restored.clock = () => Date.now() + config.media.retentionMs + 1000;
  await restored.cleanup();
  const expired = await get({ range: 'bytes=0-1' });
  assert.equal(expired.status, 410);
  assert.equal((await expired.json()).code, 'media_artifact_expired');
  const expiredAssets = await (await fetch(`${url}/api/assets`, { headers })).json();
  assert.equal(expiredAssets.total, 0);
});

test('manual MP4 recovery requires paused admin confirmation and never clears uncertain execution', async (t) => {
  const { service, comfy, proxyUrl } = await setup(t);
  // Single administrator mode matches deployed authentication.
  service.config.security = { auth_mode: 'single_admin', admin_token: 'test-maintenance-token' };
  const job = await service.media.submit({ source: 'media', backend: 'comfy', workflow });
  await waitFor(() => comfy.submitted.includes(job.id));
  comfy.inspectError = true;
  await waitFor(() => service.media.store.get(job.id).state === 'uncertain' && !service.scheduler.active);
  assert.equal(service.mediaGateway.nativeJob(service.media.store.get(job.id)).status, 'failed');
  assert.deepEqual(service.mediaGateway.queue('media', 'comfy').queue_running, []);
  const endpoint = `${proxyUrl}/_intermediary/v1/media/jobs/${job.id}/recover-output?filename=node-7_00001_.mp4&node_id=7`;
  const bytes = Buffer.from('operator-validated-mp4');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const admin = { authorization: 'Bearer test-maintenance-token', 'content-type': 'video/mp4',
    'x-confirm-output-validated': 'true', 'x-output-sha256': digest };
  const upload = (changes = {}) => fetch(endpoint, { method: 'POST', headers: { ...admin, ...changes }, body: bytes });
  assert.equal((await upload()).status, 409);
  await service.maintenance.begin({ reason: 'Test recovery import' });
  assert.equal((await upload({ authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await upload({ 'x-confirm-output-validated': 'false' })).status, 400);
  const wrong = await upload({ 'x-output-sha256': '0'.repeat(64) });
  assert.equal(wrong.status, 400);
  assert.equal((await wrong.json()).code, 'media_checksum_mismatch');
  assert.deepEqual(service.media.store.get(job.id).artifacts, []);
  const imported = await upload();
  assert.equal(imported.status, 200);
  const result = await imported.json();
  assert.equal(result.recovery_required, true);
  const repeated = await (await upload()).json();
  assert.equal(repeated.artifact_id, result.artifact_id);
  const saved = service.media.store.get(job.id);
  assert.equal(saved.artifacts.length, 1);
  assert.equal(saved.state, 'uncertain');
  assert.equal(saved.execution_state, null);
  assert.equal(saved.outputsImported, undefined, 'one MP4 cannot stand in for all workflow outputs');
  assert.equal(saved.recoveredOutputs, true);
  assert.equal(service.media.blocked, true);
  const native = service.mediaGateway.nativeJob(saved, true);
  assert.equal(native.status, 'completed');
  assert.equal(native.intermediary.outputs_recovered, true);
  assert.equal(native.intermediary.recovery_required, true);
  assert.deepEqual(comfy.deleted, []);
  assert.deepEqual(comfy.submitted, [job.id]);
  // Explicit host verification retires uncertainty without inventing terminal
  // execution evidence. Recovered results remain available in native history.
  comfy.records.clear();
  await service.media.acknowledge(new AbortController().signal);
  const acknowledged = service.media.store.get(job.id);
  assert.equal(acknowledged.state, 'failed');
  assert.equal(acknowledged.execution_state, null);
  assert.equal(service.media.blocked, false);
  assert.equal(service.mediaGateway.nativeJob(acknowledged).intermediary.recovery_required, false);
});

test('completed ComfyUI node outputs use broker paths and correct image/video fields', async (t) => {
  const { service, comfy } = await setup(t);
  const image = { filename: 'private-image.png', subfolder: 'owned', type: 'output' };
  const video = { filename: 'private-video.webm', subfolder: 'owned', type: 'output' };
  comfy.history = async (id) => ({ [id]: { outputs: { '7': { images: [image] }, '9': { videos: [{ ...video, format: 'video/webm' }] } } } });
  const job = await service.media.submit({ source: 'media', backend: 'comfy', workflow });
  await waitFor(() => comfy.submitted.includes(job.id));
  comfy.complete(job.id, [image, video]);
  await waitFor(() => service.media.store.get(job.id).state === 'completed');
  const history = service.mediaGateway.history(service.media.store.get(job.id));
  assert.ok(history.outputs['7'].images[0].filename !== image.filename);
  assert.ok(history.outputs['9'].videos[0].filename !== video.filename);
  assert.equal(history.outputs['9'].videos[0].subfolder, job.id);
  assert.equal(history.outputs['9'].videos[0].format, 'video/webm');
  assert.equal(JSON.stringify(history).includes('private-image'), false);
  assert.equal(service.media.store.get(job.id).comfyHistory, undefined);
  const events = [];
  service.mediaGateway.sockets.add({ source: 'media', backend: 'comfy', pendingPrompts: new Set([job.id]),
    client: { readyState: 1, bufferedAmount: 0, send: (value) => events.push(JSON.parse(value)), terminate() {} },
    upstream: { terminate() {} } });
  service.mediaGateway.broadcastTerminal(job.id);
  assert.deepEqual(events.map((event) => event.type), ['executed', 'executed', 'execution_success', 'executing']);
  assert.equal(events[1].data.node, '9');
  assert.equal(events[1].data.output.videos[0].subfolder, job.id);
  assert.equal(events[3].data.node, null);
});

test('dedicated native gateway forwards authenticated assets/uploads but never raw GPU mutations', async (t) => {
  const { service } = await setup(t);
  service.scheduler.pause();
  service.config.clients.media.queue_while_paused = true;
  const forwarded = [];
  const backend = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    forwarded.push({ path: request.url, token: request.headers['x-ai-intermediary-token'], body: Buffer.concat(chunks).toString() });
    response.setHeader('content-type', request.url.startsWith('/assets/') ? 'application/javascript' : 'application/json');
    response.end(request.url.startsWith('/assets/') ? 'window.loaded=true;' : JSON.stringify({ name: 'uploaded.png' }));
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  t.after(async () => { backend.closeAllConnections(); await new Promise((resolve) => backend.close(resolve)); });
  service.config.backends.comfy.url = `http://127.0.0.1:${backend.address().port}`;
  await service.startServer('127.0.0.1:0', 'media');
  const url = `http://127.0.0.1:${service.addresses().find((entry) => entry.forcedClient === 'media').address.port}`;
  const page = await fetch(url);
  assert.match(await page.text(), /Administrator password/);
  assert.equal(forwarded.length, 0);
  const login = await fetch(`${url}/media-login`, { method: 'POST', body: new URLSearchParams({ token }), redirect: 'manual' });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const asset = await fetch(`${url}/assets/index.js`, { headers: { cookie } });
  assert.equal(asset.status, 200);
  assert.match(await asset.text(), /window.loaded/);
  const imageForm = new FormData();
  imageForm.set('image', new Blob(['PNG'], { type: 'image/png' }), 'image.png');
  const upload = await fetch(`${url}/api/upload/image`, { method: 'POST', headers: { cookie }, body: imageForm });
  assert.equal(upload.status, 200);
  await upload.text();
  assert.deepEqual(forwarded.map((request) => request.path), ['/assets/index.js', '/upload/image']);
  assert.ok(forwarded.every((request) => request.token === token));
  const rejected = await requestJson(`${url}/free`, { unload_models: true }, { cookie });
  assert.equal(rejected.status, 404);
  for (const query of ['filename=unowned.png', 'filename=unowned.png&type=output', 'filename=unowned.png&type=unknown']) {
    const rawOutput = await fetch(`${url}/api/view?${query}`, { headers: { cookie } });
    assert.equal(rawOutput.status, 404);
  }
  const queued = await requestJson(`${url}/api/prompt`, { prompt: workflow, client_id: 'browser-client' }, { cookie });
  assert.equal(queued.status, 200);
  assert.ok((await queued.json()).prompt_id);
  assert.equal(forwarded.length, 2);
  const crossOrigin = await requestJson(`${url}/prompt`, { prompt: workflow }, { cookie, origin: 'https://untrusted.invalid' });
  assert.equal(crossOrigin.status, 403);
});

test('media JSON envelope permits bounded private UI metadata in addition to workflow bytes', async (t) => {
  const { service, proxyUrl, comfy } = await setup(t);
  // Deliberately small workflow limit: graph metadata has its own 1 MiB budget.
  service.config.media.max_workflow_bytes = 1024;
  const extraData = { extra_pnginfo: { workflow: { notes: 'private-ui-note'.repeat(6000) } } };
  let sentMetadata;
  const submit = comfy.submit.bind(comfy);
  comfy.submit = async (value, options) => { sentMetadata = options.extraData; return submit(value, options); };
  const created = await requestJson(`${proxyUrl}/_intermediary/v1/media/jobs`, { workflow, extra_data: extraData }, headers);
  assert.equal(created.status, 202);
  const job = await created.json();
  await waitFor(() => comfy.submitted.includes(job.id));
  assert.deepEqual(sentMetadata, extraData);
  assert.equal(JSON.stringify(service.media.snapshot()).includes('private-ui-note'), false);
  comfy.complete(job.id);
  await waitFor(() => service.media.store.get(job.id).state === 'completed');
});

test('native ComfyUI 1.52.7 requests queue durably with only local workflow metadata forwarded', async (t) => {
  const { service, comfy, config } = await setup(t);
  service.scheduler.pause();
  service.config.clients.media.queue_while_paused = true;
  await service.startServer('127.0.0.1:0', 'media');
  const url = `http://127.0.0.1:${service.addresses().find((entry) => entry.forcedClient === 'media').address.port}`;
  const login = await fetch(`${url}/media-login`, { method: 'POST', body: new URLSearchParams({ token }), redirect: 'manual' });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const retained = { extra_pnginfo: { workflow: { id: 'native-test', nodes: [], notes: 'private-graph-note' } } };
  // Mirrors queuePrompt in ComfyUI_frontend v1.52.7. Cloud auth can be absent,
  // null or populated by a browser; none of it belongs in a local-only job.
  const body = { prompt: workflow, client_id: 'native-browser', extra_data: {
    ...retained, comfy_usage_source: 'comfyui-frontend', preview_method: 'latent2rgb',
    auth_token_comfy_org: 'private-cloud-token', api_key_comfy_org: 'private-api-key',
  } };
  const warnings = [];
  service.logger.warn = (...args) => warnings.push(args);
  const created = await requestJson(`${url}/api/prompt`, body, { cookie, 'idempotency-key': 'native-request' });
  assert.equal(created.status, 200);
  const { prompt_id: id } = await created.json();
  assert.equal(service.media.store.get(id).state, 'queued');
  assert.deepEqual(service.media.store.getInternal(id).extraData, retained);
  assert.deepEqual(comfy.submitted, [], 'native Run must not bypass the shared paused scheduler');
  // The unprefixed route and empty browser credentials behave identically;
  // discarded UI fields must not change durable request identity.
  const duplicate = await requestJson(`${url}/prompt`, { ...body, extra_data: {
    ...retained, comfy_usage_source: 'comfyui-frontend', auth_token_comfy_org: null, api_key_comfy_org: '',
  } }, { cookie, 'idempotency-key': 'native-request' });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).prompt_id, id);
  assert.equal(service.media.store.list().length, 1);
  const restored = new MediaStore(config.media);
  await restored.init();
  assert.deepEqual(restored.getInternal(id).extraData, retained);
  const disk = fs.readFileSync(config.media.state_path, 'utf8');
  for (const value of ['private-cloud-token', 'private-api-key', 'comfy_usage_source', 'preview_method']) {
    assert.equal(disk.includes(value), false);
    assert.equal(JSON.stringify(warnings).includes(value), false);
  }
  assert.equal(JSON.stringify(service.media.snapshot()).includes('private-graph-note'), false);
  let sentMetadata;
  const submit = comfy.submit.bind(comfy);
  comfy.submit = async (value, options) => { sentMetadata = options.extraData; return submit(value, options); };
  service.scheduler.resume();
  await waitFor(() => comfy.submitted.includes(id));
  assert.deepEqual(sentMetadata, retained, 'the existing strict host bridge requires extra_pnginfo only');
  assert.deepEqual(comfy.submitted, [id]);
  comfy.complete(id);
  await waitFor(() => service.media.store.get(id).state === 'completed');
});

test('native metadata compatibility preserves rejections and reports safe actionable errors', async (t) => {
  const { service, proxyUrl, comfy } = await setup(t);
  service.scheduler.pause();
  service.config.clients.media.queue_while_paused = true;
  await service.startServer('127.0.0.1:0', 'media');
  const url = `http://127.0.0.1:${service.addresses().find((entry) => entry.forcedClient === 'media').address.port}`;
  const warnings = [];
  service.logger.warn = (...args) => warnings.push(args);
  const privateValue = 'private-value-that-must-not-appear';
  const metadata = { comfy_usage_source: 'comfyui-frontend', api_key_comfy_org: privateValue };
  const cases = [
    [{ prompt: workflow, extra_data: { ...metadata, unknown_field: privateValue } }, 400, 'media_metadata_invalid'],
    [{ prompt: workflow, extra_data: { ...metadata, extra_pnginfo: 'invalid' } }, 400, 'media_metadata_invalid'],
    [{ prompt: workflow, extra_data: { ...metadata, auth_token_comfy_org: 'x'.repeat(1024 * 1024) } }, 413, 'media_metadata_too_large'],
    [{ prompt: { '1': { class_type: 'UnapprovedLocalNode', inputs: {} } }, extra_data: metadata }, 422, 'node_not_allowed'],
    [{ prompt: { '1': { class_type: 'CloudGenerate', inputs: {} } }, extra_data: metadata }, 422, 'cloud_node_forbidden'],
    [{ prompt: { '1': { class_type: 'TestImage', inputs: { image: `https://example.invalid/${privateValue}` } } }, extra_data: metadata }, 422, 'remote_workflow_input'],
    [null, 400, 'invalid_body'],
  ];
  for (const [body, status, code] of cases) {
    const response = await requestJson(`${url}/api/prompt`, body, headers);
    assert.equal(response.status, status);
    const error = await response.json();
    assert.equal(error.code, code);
    assert.ok(error.error.includes(code));
    assert.equal(JSON.stringify(error).includes(privateValue), false);
  }
  // The direct media API retains its strict metadata contract.
  const direct = await requestJson(`${proxyUrl}/_intermediary/v1/media/jobs`, { workflow, extra_data: metadata }, headers);
  assert.equal(direct.status, 400);
  assert.equal((await direct.json()).code, 'media_metadata_invalid');
  service.config.clients.media.queue_while_paused = false;
  const paused = await requestJson(`${url}/prompt`, { prompt: workflow, extra_data: metadata }, headers);
  assert.equal(paused.status, 503);
  assert.equal((await paused.json()).code, 'maintenance_paused');
  const originalSubmit = service.media.submit;
  try {
    service.media.submit = async () => { throw Object.assign(new Error(privateValue), { code: privateValue }); };
    const unknown = await requestJson(`${url}/prompt`, { prompt: workflow, extra_data: metadata }, headers);
    assert.equal(unknown.status, 503);
    const error = await unknown.json();
    assert.equal(error.code, 'media_request_failed');
    assert.equal(JSON.stringify(error).includes(privateValue), false);
  } finally { service.media.submit = originalSubmit; }
  assert.equal(JSON.stringify(warnings).includes(privateValue), false);
  assert.ok(warnings.some(([message, data]) => message === 'Media request rejected' && data.code === 'node_not_allowed'));
  assert.deepEqual(service.media.store.list(), []);
  assert.deepEqual(comfy.submitted, []);
});

test('gateway limits progress sockets and drops slow broadcast consumers', async (t) => {
  const { service } = await setup(t);
  const closed = [];
  for (let index = 0; index < 32; index += 1) service.mediaGateway.sockets.add({ source: 'media', backend: 'comfy', pendingPrompts: new Set(),
    client: { readyState: 1, bufferedAmount: 17 * 1024 * 1024, close: (code) => closed.push(code), send() { assert.fail('slow socket must not buffer more'); }, terminate() {} },
    upstream: { terminate() {} } });
  let refusal;
  service.mediaGateway.upgrade({ url: '/ws', headers: { authorization: `Bearer ${token}` } }, { end: (value) => { refusal = value; } }, Buffer.alloc(0), 'media');
  assert.match(refusal, /503 Service Unavailable/);
  service.mediaGateway.broadcastStatus();
  assert.equal(closed.length, 32);
  assert.ok(closed.every((code) => code === 1013));
});

test('current native ComfyUI jobs API uses broker pagination, workflow filters and owned cancellation', async (t) => {
  const { service } = await setup(t);
  service.scheduler.pause();
  service.config.clients.media.queue_while_paused = true;
  await service.startServer('127.0.0.1:0', 'media');
  const url = `http://127.0.0.1:${service.addresses().find((entry) => entry.forcedClient === 'media').address.port}`;
  const nativeHeaders = { authorization: `Bearer ${token}` };
  const extraData = { extra_pnginfo: { workflow: { id: 'workflow-test', nodes: [] } } };
  const one = await service.media.submit({ source: 'media', backend: 'comfy', workflow, extraData });
  const two = await service.media.submit({ source: 'media', backend: 'comfy', workflow });
  const listing = await fetch(`${url}/api/jobs?status=pending&sort_order=asc&limit=1`, { headers: nativeHeaders });
  const page = await listing.json();
  assert.equal(listing.status, 200);
  assert.equal(page.jobs.length, 1);
  assert.equal(page.jobs[0].id, one.id);
  assert.deepEqual(page.pagination, { offset: 0, limit: 1, total: 2, has_more: true });
  const filtered = await fetch(`${url}/api/jobs?workflow_id=workflow-test`, { headers: nativeHeaders });
  assert.equal((await filtered.json()).pagination.total, 1);
  const detail = await fetch(`${url}/api/jobs/${one.id}`, { headers: nativeHeaders });
  assert.equal((await detail.json()).status, 'pending');
  const malformed = await requestJson(`${url}/api/jobs/cancel`, { job_ids: [one.id, 'not-a-uuid'] }, nativeHeaders);
  assert.equal(malformed.status, 400);
  assert.equal(service.media.store.get(one.id).state, 'queued');
  const cancelled = await requestJson(`${url}/api/jobs/${one.id}/cancel`, {}, nativeHeaders);
  assert.deepEqual(await cancelled.json(), { cancelled: true });
  const noOp = await requestJson(`${url}/api/jobs/${one.id}/cancel`, {}, nativeHeaders);
  assert.deepEqual(await noOp.json(), { cancelled: false });
  const bulk = await requestJson(`${url}/api/jobs/cancel`, { job_ids: [one.id, two.id] }, nativeHeaders);
  assert.deepEqual(await bulk.json(), { cancelled: true });
  const invalid = await fetch(`${url}/api/jobs?status=unknown`, { headers: nativeHeaders });
  assert.equal(invalid.status, 400);
});

test('native uploads cannot write outputs or ledgers and masks only reference safe input files', async (t) => {
  const { service } = await setup(t);
  const forwarded = [];
  const backend = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const form = await new Request('http://fixture.invalid', { method: 'POST',
      headers: { 'content-type': request.headers['content-type'] }, body: Buffer.concat(chunks) }).formData();
    const file = form.get('image');
    const value = { route: request.url, type: form.get('type'), subfolder: form.get('subfolder'),
      overwrite: form.get('overwrite'), original_ref: form.get('original_ref'), filename: file.name,
      bytes: Buffer.from(await file.arrayBuffer()).toString() };
    forwarded.push(value);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ name: value.filename, subfolder: value.subfolder, type: value.type }));
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  t.after(async () => { backend.closeAllConnections(); await new Promise((resolve) => backend.close(resolve)); });
  service.config.backends.comfy.url = `http://127.0.0.1:${backend.address().port}`;
  await service.startServer('127.0.0.1:0', 'media');
  const url = `http://127.0.0.1:${service.addresses().find((entry) => entry.forcedClient === 'media').address.port}`;
  const make = (fields = {}, filename = 'image.png') => {
    const body = new FormData();
    body.set('image', new Blob(['image-bytes'], { type: 'image/png' }), filename);
    for (const [key, value] of Object.entries(fields)) body.set(key, value);
    return body;
  };
  const send = (route, body) => fetch(`${url}${route}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body });
  for (const [body, status] of [
    [make({ type: 'output', subfolder: 'ai-intermediary', overwrite: 'true' }, '.broker-owned-jobs.json'), 403],
    [make({ type: 'temp' }), 403],
    [make({ type: 'input', subfolder: '../output' }), 400],
    [make({ type: 'input', subfolder: '/output' }), 400],
    [make({ type: 'input' }, '.broker-owned-jobs.json'), 400],
    [make({ type: 'input' }, 'image.png [output]'), 400],
  ]) {
    const response = await send('/upload/image', body);
    assert.equal(response.status, status);
    await response.text();
  }
  const duplicate = make({ type: 'input' });
  duplicate.append('type', 'output');
  assert.equal((await send('/upload/image', duplicate)).status, 400);
  assert.equal(forwarded.length, 0);
  const first = await send('/upload/image', make({ type: 'input', subfolder: 'pictures', overwrite: 'true' }));
  assert.equal(first.status, 200);
  const uploaded = await first.json();
  assert.equal(uploaded.type, 'input');
  assert.match(uploaded.subfolder, /^ai-intermediary-inputs\/[a-f0-9]{16}\/[a-f0-9-]{36}\/pictures$/);
  assert.equal(forwarded[0].overwrite, 'false');
  assert.equal(forwarded[0].bytes, 'image-bytes');
  const second = await send('/upload/image', make({ type: 'input', subfolder: 'pictures', overwrite: 'true' }));
  assert.notEqual((await second.json()).subfolder, uploaded.subfolder);
  for (const original of [
    { filename: 'output.png', subfolder: 'ai-intermediary', type: 'output' },
    { filename: 'image.png [output]', type: 'input' },
    { filename: '../image.png', type: 'input' },
    { filename: 'image.png', subfolder: '../output', type: 'input' },
    { filename: 'image.png', type: 'temp' },
    { filename: 'image.png' },
  ]) {
    const response = await send('/upload/mask', make({ original_ref: JSON.stringify(original) }, 'mask.png'));
    assert.ok([400, 403].includes(response.status));
    await response.text();
  }
  assert.equal(forwarded.length, 2);
  const original = { filename: uploaded.name, subfolder: uploaded.subfolder, type: 'input' };
  const mask = await send('/upload/mask', make({ original_ref: JSON.stringify(original), type: 'input', overwrite: 'true' }, 'mask.png'));
  assert.equal(mask.status, 200);
  const masked = await mask.json();
  assert.equal(masked.type, 'input');
  assert.notEqual(masked.subfolder, uploaded.subfolder);
  assert.equal(forwarded[2].overwrite, 'false');
  assert.deepEqual(JSON.parse(forwarded[2].original_ref), original);
});

test('native input/temp previews reject output annotations, hash aliases and traversal before forwarding', async (t) => {
  const { service } = await setup(t);
  const requests = [];
  const backend = http.createServer((request, response) => {
    requests.push(request.url);
    response.setHeader('content-type', request.url.includes('active.png') ? 'text/html' : 'image/png');
    response.end(request.url.includes('active.png') ? '<script>should not execute</script>' : 'image');
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  t.after(async () => { backend.closeAllConnections(); await new Promise((resolve) => backend.close(resolve)); });
  service.config.backends.comfy.url = `http://127.0.0.1:${backend.address().port}`;
  await service.startServer('127.0.0.1:0', 'media');
  const url = `http://127.0.0.1:${service.addresses().find((entry) => entry.forcedClient === 'media').address.port}`;
  const read = (query) => fetch(`${url}/api/view?${new URLSearchParams(query)}`, { headers: { authorization: `Bearer ${token}` } });
  for (const fields of [
    { filename: 'image.png [output]', type: 'input' },
    { filename: 'image.png [output]', type: 'temp' },
    { filename: 'image.png%20%5Boutput%5D', type: 'input' },
    { filename: '.broker-owned-jobs.json', type: 'input' },
    { filename: 'blake3:abcdef', type: 'input' },
    { filename: '../output.png', type: 'input' },
    { filename: 'image.png', subfolder: '../../output', type: 'input' },
    { filename: 'image.png', subfolder: '/output', type: 'temp' },
  ]) {
    const response = await read(fields);
    assert.equal(response.status, 400);
    await response.text();
  }
  assert.equal(requests.length, 0);
  const image = await read({ filename: 'image one.png', subfolder: 'pictures/originals', type: 'input', preview: 'webp;90' });
  assert.equal(image.status, 200);
  await image.text();
  const actual = new URL(requests[0], 'http://fixture.invalid');
  assert.equal(actual.searchParams.get('filename'), 'image one.png');
  assert.equal(actual.searchParams.get('type'), 'input');
  assert.equal(actual.searchParams.get('subfolder'), 'pictures/originals');
  const temporary = await read({ filename: 'preview.png', type: 'temp' });
  assert.equal(temporary.status, 200);
  await temporary.text();
  assert.equal(new URL(requests[1], 'http://fixture.invalid').searchParams.get('type'), 'temp');
  const activeContent = await read({ filename: 'active.png', type: 'input' });
  assert.equal(activeContent.headers.get('content-type'), 'application/octet-stream');
  assert.equal(activeContent.headers.get('content-disposition'), 'attachment');
  assert.equal(activeContent.headers.get('x-content-type-options'), 'nosniff');
  assert.match(activeContent.headers.get('content-security-policy'), /sandbox/);
  await activeContent.text();
});
