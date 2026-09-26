import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { ComfyBackend, validateComfyWorkflow, sanitizeComfyArtifact } from '../src/comfy-backend.js';

const ID = '617f9518-f82e-4a10-980f-f3aa8ccf0c65';
const OTHER = '81b3d636-4662-4386-a2a8-1638906dc0a7';
const workflow = { '1': { class_type: 'KSampler', inputs: { steps: 20, seed: 1 } } };
const emptyQueue = { queue_running: [], queue_pending: [] };
const artifact = { filename: 'video.mp4', subfolder: 'ai-intermediary/test', type: 'output' };

async function mock(t, handle, config = {}) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    const entry = { method: request.method, url: request.url, headers: request.headers, body: text ? JSON.parse(text) : undefined };
    requests.push(entry);
    response.setHeader('Content-Type', 'application/json');
    await handle(entry, response, request);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { client: new ComfyBackend({ url: `http://127.0.0.1:${server.address().port}`, allowed_node_types: ['KSampler'], ...config }), requests };
}
function json(response, value) { response.end(JSON.stringify(value)); }

test('Comfy submits only explicit local allowlisted workflows with stable IDs and bridge authentication', async (t) => {
  const { client, requests } = await mock(t, (req, response) => {
    if (req.url === '/object_info') return json(response, { KSampler: { python_module: 'nodes' } });
    json(response, { prompt_id: req.body.prompt_id, number: 3, node_errors: {} });
  }, { token: 'local-secret' });
  const result = await client.submit(workflow, { promptId: ID, clientId: 'browser-1' });
  assert.equal(result.prompt_id, ID);
  assert.equal(requests[1].body.prompt_id, ID);
  assert.equal(requests[1].body.client_id, 'browser-1');
  assert.equal(requests[1].headers['x-ai-intermediary-token'], 'local-secret');
  assert.deepEqual(requests[1].body.prompt, workflow);
});

test('Comfy rejects missing allowlist, API metadata, unknown nodes and URL/path input bypasses', async () => {
  assert.throws(() => validateComfyWorkflow(workflow), { code: 'node_not_allowed' });
  const options = { allowedNodeTypes: ['KSampler'] };
  assert.throws(() => validateComfyWorkflow(workflow, { ...options, objectInfo: {} }), { code: 'unknown_node' });
  assert.throws(() => validateComfyWorkflow(workflow, { ...options, objectInfo: { KSampler: { api_node: true } } }), { code: 'cloud_node_forbidden' });
  for (const type of ['OpenAIImage', 'KlingVideo', 'Wan2_7Video', 'HTTPRequest', 'RunwayGenerate']) {
    assert.throws(() => validateComfyWorkflow({ a: { class_type: type, inputs: {} } }, { allowedNodeTypes: [type] }), { code: 'cloud_node_forbidden' });
  }
  for (const input of [{ image: '../private.png' }, { image: '/etc/passwd' }, { video: 'C:\\private.mp4' }, { image: 'https://remote/image.png' }]) {
    assert.throws(() => validateComfyWorkflow({ a: { class_type: 'KSampler', inputs: input } }, options), (error) => ['invalid_workflow_path', 'remote_workflow_input'].includes(error.code));
  }
  assert.throws(() => validateComfyWorkflow({ a: { class_type: 'KSampler', inputs: JSON.parse('{"__proto__":{"polluted":true}}') } }, options), { code: 'invalid_workflow' });
  assert.equal(validateComfyWorkflow(workflow, options), workflow);
});

test('Comfy blocks workflow size and nesting without fetching', async () => {
  assert.throws(() => validateComfyWorkflow(workflow, { allowedNodeTypes: ['KSampler'], maxBytes: 10 }), { code: 'request_too_large' });
  let nested = {};
  for (let i = 0; i < 35; i++) nested = { nested };
  assert.throws(() => validateComfyWorkflow({ a: { class_type: 'KSampler', inputs: nested } }, { allowedNodeTypes: ['KSampler'] }), { code: 'invalid_workflow' });
  const client = new ComfyBackend({ url: 'http://localhost:8188', allowed_node_types: ['KSampler'] }, { fetchImpl: () => { throw new Error('must not fetch'); } });
  await assert.rejects(client.submit(workflow, { promptId: ID, extraData: { auth_token_comfy_org: 'secret' } }), { code: 'invalid_metadata', uncertain: false });
});

test('Comfy submission disconnect is uncertain and never automatically resent', async (t) => {
  const { client, requests } = await mock(t, (req, response, request) => {
    if (req.url === '/object_info') return json(response, { KSampler: {} });
    request.socket.destroy();
  });
  await assert.rejects(client.submit(workflow, { promptId: ID }), { code: 'backend_transport_error', uncertain: true });
  assert.equal(requests.filter((entry) => entry.url === '/prompt').length, 1);
});

test('Comfy backend minting another ID is unsafe, not a successful submit', async (t) => {
  const { client } = await mock(t, (req, response) => {
    json(response, req.url === '/object_info' ? { KSampler: {} } : { prompt_id: OTHER, number: 0 });
  });
  await assert.rejects(client.submit(workflow, { promptId: ID }), { code: 'submission_uncertain', uncertain: true });
});

test('Comfy validation rejection differs from uncertain backend failure', async (t) => {
  let status = 400;
  const { client } = await mock(t, (req, response) => {
    if (req.url === '/object_info') return json(response, { KSampler: {} });
    response.statusCode = status;
    json(response, { error: 'test failure' });
  });
  await assert.rejects(client.submit(workflow, { promptId: ID }), { code: 'backend_http_error', status: 400, uncertain: false });
  status = 409;
  await assert.rejects(client.submit(workflow, { promptId: ID }), { code: 'backend_http_error', status: 409, uncertain: true, definiteRejection: false });
  status = 500;
  await assert.rejects(client.submit(workflow, { promptId: ID }), { code: 'backend_http_error', status: 500, uncertain: true });
});

test('Comfy missing queue/history is unknown, never success; malformed queue fails closed', async (t) => {
  let queue = emptyQueue;
  const { client } = await mock(t, (req, response) => json(response, req.url === '/queue' ? queue : {}));
  assert.deepEqual(await client.inspect(ID), { state: 'unknown', terminal: false, artifacts: [] });
  queue = {};
  await assert.rejects(client.inspect(ID), { code: 'invalid_queue' });
});

test('Comfy tracks running and pending work and requires explicit successful terminal history', async (t) => {
  let queue = { ...emptyQueue, queue_running: [[0, ID]] };
  let record = {};
  const { client } = await mock(t, (req, response) => json(response, req.url === '/queue' ? queue : { [ID]: record }));
  assert.equal((await client.inspect(ID)).state, 'running');
  queue = { ...emptyQueue, queue_pending: [[0, ID]] };
  assert.equal((await client.inspect(ID)).state, 'queued');
  queue = emptyQueue;
  record = { status: { status_str: 'success', completed: false } };
  assert.equal((await client.inspect(ID)).terminal, false);
  record = { status: { status_str: 'success', completed: true }, outputs: { a: { videos: [artifact], images: [{ filename: '../../escape.png', type: 'output' }, { filename: 'temp.png', type: 'temp' }] } } };
  assert.deepEqual(await client.inspect(ID), { state: 'completed', terminal: true, artifacts: [artifact] });
  record = { status: { status_str: 'error', completed: false, messages: [['execution_error', {}]] } };
  assert.equal((await client.inspect(ID)).state, 'failed');
  record.status.messages = [['execution_interrupted', {}]];
  assert.equal((await client.inspect(ID)).state, 'interrupted');
});

test('Comfy interrupt requires exactly owned active workflow and does not claim completion', async (t) => {
  let queue = { ...emptyQueue, queue_running: [[0, ID]] };
  const { client, requests } = await mock(t, (req, response) => req.url === '/queue' ? json(response, queue) : response.end());
  await assert.rejects(client.interrupt(ID, { ownedPromptId: OTHER }), { code: 'not_owned' });
  queue = { ...emptyQueue, queue_running: [[0, OTHER]] };
  await assert.rejects(client.interrupt(ID, { ownedPromptId: ID }), { code: 'not_owned' });
  queue = { ...emptyQueue, queue_running: [[0, ID]], queue_pending: [[1, OTHER]] };
  await assert.rejects(client.interrupt(ID, { ownedPromptId: ID }), { code: 'not_owned' });
  queue = { ...emptyQueue, queue_running: [[0, ID]] };
  assert.deepEqual(await client.interrupt(ID, { ownedPromptId: ID }), { requested: true, terminal: false });
  assert.equal(requests.filter((entry) => entry.url === '/interrupt').length, 1);
  assert.deepEqual(requests.at(-1).body, { prompt_id: ID });
});

test('Comfy free acknowledgment is not proof; release checks idle queue and reserved torch memory', async (t) => {
  let queue = emptyQueue;
  let devices = [{ type: 'cuda', torch_vram_total: 2_000_000 }];
  const { client } = await mock(t, (req, response) => {
    if (req.url === '/queue') return json(response, queue);
    if (req.url === '/system_stats') return json(response, { devices });
    response.end();
  });
  assert.deepEqual(await client.requestFree(), { requested: true, released: false });
  assert.equal((await client.releaseEvidence()).released, false);
  devices[0].torch_vram_total = 0;
  assert.equal((await client.releaseEvidence()).released, true);
  queue = { ...emptyQueue, queue_pending: [[0, ID]] };
  assert.equal((await client.releaseEvidence()).released, false);
  await assert.rejects(client.requestFree(), { code: 'backend_busy' });
  queue = emptyQueue;
  for (const invalid of [[], [{ type: 'cuda' }], [{ type: 'cpu', torch_vram_total: 0 }], [{ torch_vram_total: 0 }], [{ type: 'cuda', torch_vram_total: '0' }]]) {
    devices = invalid;
    assert.equal((await client.releaseEvidence()).released, false);
  }
});

test('Comfy bridge status and scoped output deletion are authenticated and sanitized', async (t) => {
  const { client, requests } = await mock(t, (req, response) => json(response, { ok: true }), { token: 'token' });
  await client.bridgeStatus();
  await client.deleteArtifacts(ID, [artifact]);
  assert.equal(requests[0].url, '/intermediary/status');
  assert.deepEqual(requests[1].body, { prompt_id: ID, artifacts: [artifact] });
  assert.equal(requests[1].headers['x-ai-intermediary-token'], 'token');
  await assert.rejects(client.deleteArtifacts(ID, [{ ...artifact, type: 'input' }]), { code: 'invalid_artifact' });
});

test('Comfy artifact references cannot traverse, select input files or use path annotations', () => {
  for (const filename of ['../secret', '/secret', 'C:\\secret', 'file [input]', '.', '..', 'foo\nbar']) {
    assert.throws(() => sanitizeComfyArtifact({ ...artifact, filename }), { code: 'invalid_artifact' });
  }
  for (const subfolder of ['../secret', '/secret', 'one/../two', 'one//two', 'one\\two', 'folder [input]']) {
    assert.throws(() => sanitizeComfyArtifact({ ...artifact, subfolder }), { code: 'invalid_artifact' });
  }
  assert.deepEqual(sanitizeComfyArtifact({ ...artifact, other: 'not forwarded' }), artifact);
});

test('Comfy artifact downloads are streamed and bounded even without Content-Length', async (t) => {
  const { client, requests } = await mock(t, (req, response) => {
    response.setHeader('Content-Type', 'video/mp4');
    response.write('1234');
    response.end('5678');
  });
  const result = await client.readArtifact(artifact, { maxBytes: 8 });
  assert.equal(result.body.toString(), '12345678');
  assert.equal(result.bytes, 8);
  assert.equal(result.contentType, 'video/mp4');
  const parsed = new URL(requests[0].url, 'http://localhost');
  assert.equal(parsed.searchParams.get('type'), 'output');
  await assert.rejects(client.readArtifact(artifact, { maxBytes: 7 }), { code: 'artifact_too_large' });
});

test('Comfy JSON responses, artifact Content-Length, invalid JSON and redirects are bounded', async (t) => {
  let mode = 'size';
  const { client, requests } = await mock(t, (req, response) => {
    if (mode === 'size') return response.end(JSON.stringify({ value: 'x'.repeat(256) }));
    if (mode === 'bad-json') return response.end('{broken');
    response.statusCode = 302;
    response.setHeader('Location', '/secret');
    response.end();
  }, { maxResponseBytes: 128 });
  await assert.rejects(client.health(), { code: 'response_too_large' });
  await assert.rejects(client.readArtifact(artifact, { maxBytes: 5 }), { code: 'response_too_large' });
  mode = 'bad-json';
  await assert.rejects(client.health(), { code: 'invalid_response' });
  mode = 'redirect';
  await assert.rejects(client.health(), { code: 'backend_transport_error' });
  assert.equal(requests.some((entry) => entry.url === '/secret'), false);
});

test('Comfy slow response bodies time out and no untrusted absolute routes can escape the origin', async (t) => {
  const { client } = await mock(t, (req, response) => { response.write('{'); }, { timeoutMs: 20 });
  await assert.rejects(client.health(), { code: 'backend_transport_error', uncertain: false });
  await assert.rejects(client.request('http://example.com'), { code: 'invalid_route' });
  await assert.rejects(client.request('//example.com'), { code: 'invalid_route' });
  for (const url of ['http://user:password@localhost:8188', 'file:///tmp/file', 'http://localhost:8188/path']) {
    assert.throws(() => new ComfyBackend({ url }), { code: 'invalid_config' });
  }
});

test('Comfy pre-aborted mutations are safe non-dispatch and post-dispatch timeout is uncertain', async (t) => {
  const { client, requests } = await mock(t, (req, response) => { response.write('{'); }, { timeoutMs: 20 });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.request('/free', { body: {}, signal: controller.signal }), { code: 'request_aborted', uncertain: false });
  assert.equal(requests.length, 0);
  await assert.rejects(client.request('/free', { body: {} }), { code: 'backend_transport_error', uncertain: true });
});

test('Comfy final synchronous dispatch guard catches a pause arriving during object-info preflight', async (t) => {
  let paused = false;
  const { client, requests } = await mock(t, (req, response) => {
    paused = true;
    json(response, { KSampler: {} });
  });
  await assert.rejects(client.submit(workflow, { promptId: ID, beforeDispatch() {
    if (paused) throw Object.assign(new Error('Paused'), { code: 'media_dispatch_deferred' });
  } }), { code: 'media_dispatch_deferred', beforeDispatch: true, uncertain: false });
  assert.deepEqual(requests.map((request) => request.url), ['/object_info']);
});

test('Comfy signals abort object-info preflight without POST and all read helpers honor pre-abort', async (t) => {
  const controller = new AbortController();
  const { client, requests } = await mock(t, (req, response) => {
    controller.abort(new Error('shutdown'));
    json(response, { KSampler: {} });
  });
  await assert.rejects(client.submit(workflow, { promptId: ID, signal: controller.signal }), { beforeDispatch: true, uncertain: false });
  assert.equal(requests.filter((request) => request.url === '/prompt').length, 0);
  for (const operation of [() => client.health({ signal: controller.signal }), () => client.queue({ signal: controller.signal }),
    () => client.history(ID, { signal: controller.signal }), () => client.objectInfo({ signal: controller.signal }),
    () => client.bridgeStatus({ signal: controller.signal }), () => client.inspect(ID, { signal: controller.signal }),
    () => client.releaseEvidence({ signal: controller.signal }), () => client.requestFree({ signal: controller.signal })]) {
    await assert.rejects(operation(), { beforeDispatch: true, uncertain: false });
  }
});

test('Comfy cancellation after POST begins is uncertain, not a safe pre-dispatch failure', async (t) => {
  const controller = new AbortController();
  const { client, requests } = await mock(t, (req, response) => {
    if (req.url === '/object_info') return json(response, { KSampler: {} });
    response.write('{');
    controller.abort(new Error('shutdown'));
  });
  await assert.rejects(client.submit(workflow, { promptId: ID, signal: controller.signal }), {
    code: 'backend_transport_error', uncertain: true, beforeDispatch: false,
  });
  assert.equal(requests.filter((request) => request.url === '/prompt').length, 1);
});
