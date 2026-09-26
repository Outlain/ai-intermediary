import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FORBIDDEN_NODE = /(?:^|[_\s-])(?:api|cloud|http|request|download|shell|exec|python)(?:$|[_\s-])|(?:api|cloud|http)(?:node|request|generate)|(?:openai|anthropic|replicate|falai|fal_|kling|runway|veo|luma|ideogram|bfl|stabilityapi)|(?:shell|exec|python)(?:code|command|script)|(?:wan2[._]?7)/i;
const FORBIDDEN_KEY = /^(?:__proto__|prototype|constructor)$/;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export class ComfyBackendError extends Error {
  constructor(code, message, { uncertain = false, status = null, beforeDispatch = false, definiteRejection = false, cause } = {}) {
    super(message, { cause });
    this.name = 'ComfyBackendError';
    this.code = code;
    this.uncertain = uncertain;
    this.status = status;
    this.beforeDispatch = beforeDispatch;
    this.definiteRejection = definiteRejection;
  }
}

function fail(code, message, options) { throw new ComfyBackendError(code, message, options); }
function boundedInteger(value, fallback, min, max, name) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) fail('invalid_config', `Invalid ComfyUI ${name}`);
  return result;
}
function promptId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail('invalid_prompt_id', 'A canonical UUID prompt ID is required');
  return value;
}
function plainJson(value, maxBytes) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { fail('invalid_body', 'The ComfyUI request must be JSON serializable'); }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > maxBytes) fail('request_too_large', 'ComfyUI request exceeds the configured byte limit');
  return serialized;
}

// An allowlist is approval of installed node code, not a sandbox for arbitrary
// custom Python nodes. Partner/API nodes remain forbidden in local-only mode.
export function validateComfyWorkflow(workflow, { allowedNodeTypes = [], objectInfo = null, maxBytes = 2 * 1024 * 1024, maxNodes = 512 } = {}) {
  if (!isObject(workflow) || Object.keys(workflow).length === 0 || Object.keys(workflow).length > maxNodes) {
    fail('invalid_workflow', 'Expected a non-empty bounded ComfyUI API-format workflow');
  }
  plainJson(workflow, maxBytes);
  const allowed = new Set(allowedNodeTypes);
  const visit = (value, depth = 0, key = '') => {
    if (depth > 32) fail('invalid_workflow', 'Workflow nesting exceeds the supported limit');
    if (typeof value === 'string') {
      if (/^(?:https?|ftp|file|s3|gs):\/\//i.test(value.trim()) || /^\/\//.test(value.trim())) {
        fail('remote_workflow_input', 'Remote URL and file URL workflow inputs are not permitted');
      }
      if (/(?:filename|filepath|file_path|directory|folder|prefix|ckpt_name|model_name|image|video)$/i.test(key)
        && (/^[\/\\]/.test(value) || /^[a-z]:/i.test(value) || value.split(/[\/\\]/).includes('..'))) {
        fail('invalid_workflow_path', 'Workflow file inputs must use relative non-traversing backend paths');
      }
    } else if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1, key);
    } else if (isObject(value)) {
      for (const [childKey, entry] of Object.entries(value)) {
        if (FORBIDDEN_KEY.test(childKey)) fail('invalid_workflow', 'Reserved workflow keys are not permitted');
        visit(entry, depth + 1, childKey);
      }
    } else if (value !== null && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value))) {
      fail('invalid_workflow', 'Workflow inputs must contain only JSON values');
    }
  };
  for (const [id, node] of Object.entries(workflow)) {
    if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(id) || FORBIDDEN_KEY.test(id) || !isObject(node) || !isObject(node.inputs)
      || typeof node.class_type !== 'string' || node.class_type.length > 200) fail('invalid_workflow', 'Invalid ComfyUI workflow node');
    const type = node.class_type;
    const info = objectInfo?.[type];
    if (FORBIDDEN_NODE.test(type) || info?.api_node === true || /comfy_api_nodes|api[ _/-]?nodes|partner[ _/-]?nodes/i.test(`${info?.python_module ?? ''} ${info?.category ?? ''}`)) {
      fail('cloud_node_forbidden', `Node ${type} is not permitted in a local-only workflow`);
    }
    if (!allowed.has(type)) fail('node_not_allowed', `Node ${type} must be explicitly allowed in backend settings`);
    if (objectInfo !== null && (!Object.hasOwn(objectInfo, type) || !isObject(info))) fail('unknown_node', `Node ${type} is not available on the configured ComfyUI backend`);
    visit(node.inputs);
  }
  return workflow;
}

export function sanitizeComfyArtifact(value) {
  if (!isObject(value) || value.type !== 'output' || typeof value.filename !== 'string' || value.filename.length > 255
    || !value.filename || /[\x00-\x1f\x7f\/\\:\[\]]/.test(value.filename) || ['.', '..'].includes(value.filename)) {
    fail('invalid_artifact', 'Only safe ComfyUI output artifacts can be retrieved');
  }
  const subfolder = value.subfolder ?? '';
  if (typeof subfolder !== 'string' || subfolder.length > 1024 || /[\x00-\x1f\x7f\\:\[\]]/.test(subfolder)
    || subfolder.startsWith('/') || (subfolder !== '' && subfolder.split('/').some((part) => !part || part === '.' || part === '..'))) {
    fail('invalid_artifact', 'Invalid ComfyUI output subfolder');
  }
  return { filename: value.filename, subfolder, type: 'output' };
}

function artifactsFromHistory(record) {
  const results = [];
  const seen = new Set();
  for (const node of Object.values(isObject(record.outputs) ? record.outputs : {})) {
    if (!isObject(node)) continue;
    for (const field of ['images', 'gifs', 'videos', 'audio']) {
      if (!Array.isArray(node[field])) continue;
      for (const entry of node[field]) {
        try {
          const artifact = sanitizeComfyArtifact(entry);
          const key = JSON.stringify(artifact);
          if (!seen.has(key)) { seen.add(key); results.push(artifact); }
        } catch { /* Never expose unsafe paths or temporary/input files. */ }
      }
    }
  }
  return results;
}

function parseQueue(value) {
  if (!isObject(value) || !Array.isArray(value.queue_running) || !Array.isArray(value.queue_pending)) fail('invalid_queue', 'ComfyUI returned an invalid queue response');
  for (const item of [...value.queue_running, ...value.queue_pending]) {
    if (!Array.isArray(item) || typeof item[1] !== 'string' || item[1].length > 256) fail('invalid_queue', 'ComfyUI returned an invalid queue item');
  }
  return value;
}

export class ComfyBackend {
  constructor(config, { fetchImpl = globalThis.fetch } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    let url;
    try { url = new URL(config.url); } catch { fail('invalid_config', 'Invalid ComfyUI backend URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      fail('invalid_config', 'ComfyUI backend URL must be an HTTP(S) origin without credentials or a path');
    }
    this.url = url.origin;
    this.timeoutMs = boundedInteger(config.timeoutMs ?? config.requestTimeoutMs, 15_000, 1, 300_000, 'request timeout');
    this.maxResponseBytes = boundedInteger(config.maxResponseBytes, 8 * 1024 * 1024, 128, 64 * 1024 * 1024, 'response limit');
    this.maxRequestBytes = boundedInteger(config.maxRequestBytes, 2 * 1024 * 1024, 128, 64 * 1024 * 1024, 'request limit');
    this.maxArtifactBytes = boundedInteger(config.maxArtifactBytes, 512 * 1024 * 1024, 1, 16 * 1024 * 1024 * 1024, 'artifact limit');
    this.artifactTimeoutMs = boundedInteger(config.artifactTimeoutMs, 300_000, 1, 3_600_000, 'artifact timeout');
    if (config.token !== undefined && (typeof config.token !== 'string' || /[\r\n]/.test(config.token) || config.token.length > 4096)) fail('invalid_config', 'Invalid ComfyUI bridge token');
  }

  async request(path, { body, maxBytes = this.maxResponseBytes, signal, raw = false, timeoutMs = this.timeoutMs, beforeDispatch } = {}) {
    // Paths originate only in adapter methods. Do not expose this method as an
    // arbitrary user-controlled proxy route.
    if (typeof path !== 'string' || !/^\/(?:system_stats|queue|history\/[0-9a-f-]+|object_info|prompt|interrupt|free|intermediary\/(?:status|outputs\/delete)|view\?[^#]*)$/.test(path)) {
      fail('invalid_route', 'Unsupported ComfyUI adapter route');
    }
    const payload = body === undefined ? undefined : plainJson(body, this.maxRequestBytes);
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) fail('request_aborted', 'ComfyUI request was aborted before dispatch', { beforeDispatch: true });
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('ComfyUI request timed out')), timeoutMs);
    timer.unref?.();
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    let response;
    let dispatched = false;
    try {
      signal?.throwIfAborted();
      const callbackResult = beforeDispatch?.();
      if (callbackResult && typeof callbackResult.then === 'function') {
        callbackResult.catch?.(() => {});
        fail('invalid_dispatch_guard', 'ComfyUI dispatch guard must be synchronous');
      }
      signal?.throwIfAborted();
      dispatched = true;
      response = await this.fetchImpl(`${this.url}${path}`, {
        method: payload === undefined ? 'GET' : 'POST',
        headers: { accept: raw ? '*/*' : 'application/json', ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
          ...(this.config.token ? { 'X-AI-Intermediary-Token': this.config.token } : {}) },
        body: payload, redirect: 'error', signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        // Conflict can mean this durable ID already executed, rather than a
        // new validation rejection. It must be reconciled, never replayed.
        fail('backend_http_error', `ComfyUI returned HTTP ${response.status}`, { status: response.status,
          uncertain: payload !== undefined && (response.status >= 500 || response.status === 409),
          definiteRejection: payload !== undefined && response.status >= 400 && response.status < 500 && response.status !== 409 });
      }
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
        await response.body?.cancel();
        fail('response_too_large', 'ComfyUI response exceeds the configured byte limit', { uncertain: payload !== undefined });
      }
      if (raw) return { response, cleanup, signal: controller.signal };
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body ?? []) {
        bytes += chunk.length;
        if (bytes > maxBytes) fail('response_too_large', 'ComfyUI response exceeds the configured byte limit', { uncertain: payload !== undefined });
        chunks.push(Buffer.from(chunk));
      }
      const text = Buffer.concat(chunks).toString('utf8');
      let value;
      try { value = text.length ? JSON.parse(text) : {}; } catch { fail('invalid_response', 'ComfyUI returned invalid JSON', { uncertain: payload !== undefined }); }
      if (!isObject(value)) fail('invalid_response', 'ComfyUI returned an invalid response object', { uncertain: payload !== undefined });
      cleanup();
      return value;
    } catch (error) {
      controller.abort();
      cleanup();
      if (!dispatched && error instanceof Error) {
        error.beforeDispatch = true;
        error.uncertain = false;
        throw error;
      }
      if (error instanceof ComfyBackendError) throw error;
      fail('backend_transport_error', 'ComfyUI connection failed or timed out', { uncertain: payload !== undefined, cause: error });
    }
  }

  async health({ signal } = {}) { return this.request('/system_stats', { signal }); }
  async queue({ signal } = {}) { return parseQueue(await this.request('/queue', { signal })); }
  async history(id, { signal } = {}) { return this.request(`/history/${promptId(id)}`, { signal }); }
  async objectInfo({ signal } = {}) { return this.request('/object_info', { signal }); }
  async bridgeStatus({ signal } = {}) { return this.request('/intermediary/status', { signal }); }
  async deleteArtifacts(id, artifacts, { signal } = {}) {
    promptId(id);
    if (!Array.isArray(artifacts) || artifacts.length > 1024) fail('invalid_artifact', 'Invalid bounded ComfyUI artifact list');
    return this.request('/intermediary/outputs/delete', { body: { prompt_id: id, artifacts: artifacts.map(sanitizeComfyArtifact) }, signal });
  }

  async submit(workflow, { promptId: id, clientId = 'ai-intermediary', extraData = {}, signal, beforeDispatch } = {}) {
    let posted = false;
    try {
      promptId(id);
      if (typeof clientId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(clientId)) fail('invalid_client_id', 'Invalid ComfyUI client ID');
      // Never forward API credentials, auth tokens, or arbitrary hidden-node
      // metadata. The UI workflow is retained solely for Comfy history display.
      if (!isObject(extraData) || Object.keys(extraData).some((key) => key !== 'extra_pnginfo')) fail('invalid_metadata', 'Unsupported ComfyUI submission metadata');
      const allowedNodeTypes = this.config.allowed_node_types ?? this.config.allowedNodeTypes ?? [];
      validateComfyWorkflow(workflow, { allowedNodeTypes, maxBytes: this.maxRequestBytes });
      const info = await this.objectInfo({ signal });
      validateComfyWorkflow(workflow, { allowedNodeTypes, objectInfo: info, maxBytes: this.maxRequestBytes });
      const result = await this.request('/prompt', { body: { prompt: workflow, prompt_id: id, client_id: clientId, extra_data: extraData }, signal,
        beforeDispatch: () => {
          const result = beforeDispatch?.();
          if (result && typeof result.then === 'function') {
            result.catch?.(() => {});
            fail('invalid_dispatch_guard', 'ComfyUI dispatch guard must be synchronous');
          }
          signal?.throwIfAborted();
          posted = true;
        } });
      if (result.prompt_id !== id || !Number.isFinite(result.number)) {
        fail('submission_uncertain', 'ComfyUI did not confirm the supplied prompt ID; do not resubmit automatically', { uncertain: true });
      }
      return { prompt_id: id, number: result.number, node_errors: isObject(result.node_errors) ? result.node_errors : {} };
    } catch (error) {
      if (!posted && error instanceof Error) { error.beforeDispatch = true; error.uncertain = false; }
      throw error;
    }
  }

  async inspect(id, { signal } = {}) {
    promptId(id);
    const history = await this.history(id, { signal });
    const record = history[id];
    if (record !== undefined && !isObject(record)) fail('invalid_history', 'ComfyUI returned an invalid job history record');
    const queue = await this.queue({ signal });
    if (queue.queue_running.some((item) => item[1] === id)) return { state: 'running', terminal: false, artifacts: [] };
    if (queue.queue_pending.some((item) => item[1] === id)) return { state: 'queued', terminal: false, artifacts: [] };
    if (record && isObject(record.status)) {
      const { completed, status_str: status, messages } = record.status;
      if (status === 'success' && completed === true) return { state: 'completed', terminal: true, artifacts: artifactsFromHistory(record) };
      if (status === 'error' && typeof completed === 'boolean') {
        const interrupted = Array.isArray(messages) && messages.some((entry) => Array.isArray(entry) && entry[0] === 'execution_interrupted');
        return { state: interrupted ? 'interrupted' : 'failed', terminal: true, artifacts: [] };
      }
    }
    // Empty queue/history could mean restart or dropped history, never proof of
    // completion. The owning scheduler must retain its recovery fence.
    return { state: 'unknown', terminal: false, artifacts: [] };
  }

  async interrupt(id, { ownedPromptId, signal } = {}) {
    promptId(id);
    if (ownedPromptId !== id) fail('not_owned', 'Only the scheduler-owned active ComfyUI workflow can be interrupted');
    const queue = await this.queue({ signal });
    if (queue.queue_running.length !== 1 || queue.queue_running[0][1] !== id || queue.queue_pending.length) {
      fail('not_owned', 'ComfyUI does not have exactly the owned workflow running with an empty pending queue');
    }
    await this.request('/interrupt', { body: { prompt_id: id }, signal });
    return { requested: true, terminal: false };
  }

  async requestFree({ signal } = {}) {
    const queue = await this.queue({ signal });
    if (queue.queue_running.length || queue.queue_pending.length) fail('backend_busy', 'ComfyUI cannot unload while its queue contains work');
    await this.request('/free', { body: { unload_models: true, free_memory: true }, signal });
    return { requested: true, released: false };
  }

  async releaseEvidence({ maxReservedBytes = 0, signal } = {}) {
    if (!Number.isSafeInteger(maxReservedBytes) || maxReservedBytes < 0) fail('invalid_release_limit', 'Invalid ComfyUI release threshold');
    const stats = await this.health({ signal });
    const queue = await this.queue({ signal });
    const idle = queue.queue_running.length === 0 && queue.queue_pending.length === 0;
    const devices = Array.isArray(stats.devices) ? stats.devices : [];
    const valid = devices.length > 0 && devices.every((device) => isObject(device) && ['cuda', 'hip', 'xpu', 'mps', 'privateuseone'].includes(device.type)
      && Number.isSafeInteger(device.torch_vram_total) && device.torch_vram_total >= 0);
    return { idle, released: idle && valid && devices.every((device) => device.torch_vram_total <= maxReservedBytes), devices };
  }

  async downloadArtifact(artifact, destination, { maxBytes = this.maxArtifactBytes, signal } = {}) {
    const fetched = await this.artifactResponse(artifact, { maxBytes, signal });
    let bytes = 0;
    const limiter = new Transform({ transform(chunk, encoding, callback) {
      bytes += chunk.length;
      callback(bytes > maxBytes ? new ComfyBackendError('artifact_too_large', 'ComfyUI artifact exceeds the configured byte limit') : null, chunk);
    } });
    try {
      await pipeline(Readable.fromWeb(fetched.body), limiter, destination, { signal: fetched.signal });
      return { bytes, contentType: fetched.headers.get('content-type') ?? 'application/octet-stream', artifact: fetched.artifact };
    } finally { fetched.cleanup(); }
  }

  async artifactResponse(artifact, { maxBytes = this.maxArtifactBytes, signal } = {}) {
    const clean = sanitizeComfyArtifact(artifact);
    boundedInteger(maxBytes, this.maxArtifactBytes, 1, this.maxArtifactBytes, 'artifact download limit');
    const query = new URLSearchParams(clean);
    const fetched = await this.request(`/view?${query}`, { raw: true, maxBytes, signal, timeoutMs: this.artifactTimeoutMs });
    if (!fetched.response.body) { fetched.cleanup(); fail('invalid_artifact', 'ComfyUI returned an empty artifact body'); }
    const reader = fetched.response.body.getReader();
    let bytes = 0;
    let finished = false;
    const cleanup = () => {
      if (!finished) { finished = true; void reader.cancel().catch(() => {}); }
      fetched.cleanup();
    };
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) { finished = true; fetched.cleanup(); controller.close(); return; }
          bytes += value.byteLength;
          if (bytes > maxBytes) fail('artifact_too_large', 'ComfyUI artifact exceeds the configured byte limit');
          controller.enqueue(value);
        } catch (error) { cleanup(); controller.error(error); }
      },
      cancel() { cleanup(); },
    });
    return { body, headers: fetched.response.headers, status: fetched.response.status, signal: fetched.signal, cleanup, artifact: clean };
  }

  async readArtifact(artifact, { maxBytes = Math.min(this.maxArtifactBytes, 16 * 1024 * 1024), signal } = {}) {
    // Only use this convenience method for small previews; videos should stream.
    const chunks = [];
    const destination = new Transform({ transform(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    const result = await this.downloadArtifact(artifact, destination, { maxBytes, signal });
    return { ...result, body: Buffer.concat(chunks) };
  }
}
