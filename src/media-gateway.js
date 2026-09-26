import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { authorized } from './observability.js';
import { readBody, sendJson } from './http-utils.js';
import { mediaRequestError, nativeComfyMetadata } from './media-request.js';

const API = '/_intermediary/v1/media';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_SOCKETS = 32;
const MAX_BUFFERED = 16 * 1024 * 1024;
const cookieName = (source) => `ai_media_${source}`;
const loginHtml = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>AI Intermediary · Media</title><body><h1>Media gateway</h1><p>Use your AI Intermediary administrator password. This port uses the same password as the dashboard and Settings. Raw ComfyUI cannot bypass the shared GPU queue.</p><form method="post" action="/media-login"><label>Administrator password <input name="token" type="password" required autocomplete="current-password"></label><button>Open ComfyUI</button></form></body></html>`;
const safeAsset = (name) => /^\/(?:assets|extensions|scripts|css|fonts|locales|icons|templates)\/[A-Za-z0-9_./@%+-]+$/.test(name)
  && !name.split('/').includes('..') && /\.(?:js|mjs|css|json|woff2?|ttf|svg|png|webp|avif|jpe?g|gif|mp4|webm|ico|wasm|map)$/.test(name);
const readonly = (name) => ['/', '/index.html', '/favicon.ico', '/favicon.svg', '/features', '/extensions', '/embeddings', '/models', '/object_info', '/system_stats', '/workflow_templates', '/users', '/userdata', '/v2/userdata', '/settings'].includes(name)
  || /^\/(?:models|object_info|userdata|settings)\/[A-Za-z0-9_./@%+-]+$/.test(name) || safeAsset(name);
const writeEditor = (name) => /^\/(?:userdata|settings)(?:\/[A-Za-z0-9_./@%+-]+)?$/.test(name);
const uploadError = (code = 'media_upload_invalid', statusCode = 400) => Object.assign(new Error(code), { code, statusCode });
const inputFilename = (value) => {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 255 || value !== value.trim()
    || value.startsWith('.') || /[\x00-\x1f\x7f\/\\:\[\]%]/.test(value)) throw uploadError('media_input_path_invalid');
  return value;
};
const inputSubfolder = (value = '') => {
  if (typeof value !== 'string' || value.length > 1024 || /[\x00-\x1f\x7f\\:\[\]%]/.test(value)
    || (value && value.split('/').some((part) => !part || part.startsWith('.') || part !== part.trim()))) {
    throw uploadError('media_input_path_invalid');
  }
  return value;
};

/** A dedicated source listener serves the real ComfyUI frontend, but GPU
 * mutations are broker operations, never a transparent /prompt pass-through. */
export class MediaGateway {
  constructor(service) {
    this.service = service;
    this.sessions = new Map();
    this.sockets = new Set();
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false });
    service.media.listeners.add((type, job) => {
      this.broadcastStatus();
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(type)) this.broadcastTerminal(job.id);
    });
  }

  sourceBackend(source) {
    if (!source) return null;
    const name = this.service.config.clients[source]?.backend;
    const entry = this.service.config.backends[name];
    return entry?.type === 'comfyui' ? { name, ...entry } : null;
  }

  handles(url, source) { return url.pathname.startsWith(`${API}/`) || Boolean(this.sourceBackend(source)); }

  get singleAdmin() { return this.service.config.security?.auth_mode === 'single_admin'; }

  get loginToken() {
    // The bridge's derived machine credential never authorizes a human/admin
    // session. Official startup requires the operator's administrator password.
    return this.singleAdmin ? this.service.config.security.admin_token : this.service.config.media.auth_token;
  }

  authenticated(request, source) {
    const token = this.loginToken;
    if (!token) return false;
    if (authorized(request, token)) return true;
    const cookie = String(request.headers.cookie || '').split(';').map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName(source)}=`))?.split('=')[1];
    const session = cookie && this.sessions.get(cookie);
    return session?.source === source && session.expires > Date.now();
  }

  checkOrigin(request) {
    if (!request.headers.origin) return true;
    try { return new URL(request.headers.origin).host === request.headers.host; } catch { return false; }
  }

  async handle(request, response, url, id, forcedSource) {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    try {
      if (!this.service.media.enabled) return sendJson(response, 503, { code: 'media_disabled', error: 'Enable and configure media in Settings first.' }, id);
      const native = !url.pathname.startsWith(`${API}/`);
      const source = forcedSource || this.service.classifier.identify(request, {}, null).client;
      if (native && url.pathname === '/media-login' && request.method === 'POST') return await this.login(request, response, source, id);
      if (url.pathname === `${API}/acknowledge`) return this.acknowledge(request, response, id);
      if (!this.authenticated(request, source)) {
        if (native && request.method === 'GET' && url.pathname === '/') {
          // Native form POSTs under no-referrer send Origin: null, including
          // same-origin logins. Preserve their origin without allowing foreign
          // or opaque origins through checkOrigin, or leaking cross-site refs.
          response.setHeader('referrer-policy', 'same-origin');
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'" });
          return response.end(loginHtml);
        }
        return sendJson(response, 401, { code: 'admin_token_required',
          error: 'Use your AI Intermediary administrator password.' }, id);
      }
      if (request.method !== 'GET' && !this.checkOrigin(request)) return sendJson(response, 403, { error: 'Cross-origin mutation rejected.' }, id);
      if (url.pathname.startsWith(`${API}/`)) return await this.api(request, response, url, id, source);
      const backend = this.service.registry.resolve(source, null, 'comfyui');
      const route = url.pathname.replace(/^\/api(?=\/)/, '');
      if (route === '/jobs' || route.startsWith('/jobs/')) return this.nativeJobs(request, response, url, route, id, source, backend.name);
      if (route === '/prompt' && request.method === 'POST') {
        const body = JSON.parse((await readBody(request, this.service.config.media.max_workflow_bytes + 1024 * 1024 + 65_536)).toString());
        const extraData = nativeComfyMetadata(body);
        const job = await this.service.media.submit({ source, backend: backend.name, workflow: body.prompt,
          clientId: body.client_id, extraData, idempotencyKey: request.headers['idempotency-key'] });
        return sendJson(response, 200, { prompt_id: job.id, number: job.enqueuedAt, node_errors: {} }, id);
      }
      if (['/prompt', '/queue'].includes(route) && request.method === 'GET') {
        const queue = this.queue(source, backend.name);
        return sendJson(response, 200, route === '/prompt'
          ? { exec_info: { queue_remaining: queue.queue_running.length + queue.queue_pending.length } } : queue, id);
      }
      if (route === '/queue' && request.method === 'POST') {
        const body = JSON.parse((await readBody(request, 16_384)).toString());
        const ids = body.clear === true ? this.jobs(source, backend.name).filter((job) => job.state === 'queued').map((job) => job.id) : body.delete;
        if (!Array.isArray(ids) || ids.some((jobId) => !this.jobs(source, backend.name).some((job) => job.id === jobId && job.state === 'queued'))) {
          return sendJson(response, 409, { error: 'Only your queued media jobs may be removed.' }, id);
        }
        for (const jobId of ids) await this.service.media.cancel(jobId);
        return sendJson(response, 200, {}, id);
      }
      if (route === '/interrupt' && request.method === 'POST') {
        const job = this.jobs(source, backend.name).find((item) => item.id === this.service.scheduler.active?.mediaId);
        if (!job) return sendJson(response, 409, { error: 'No active media job belongs to this source.' }, id);
        await this.service.media.cancel(job.id);
        return sendJson(response, 200, {}, id);
      }
      if (/^\/history(?:\/[a-f0-9-]+)?$/.test(route) && request.method === 'GET') {
        const selected = route.split('/')[2];
        const history = Object.fromEntries(this.jobs(source, backend.name).filter((job) =>
          ['completed', 'failed', 'cancelled', 'uncertain'].includes(job.state) && (!selected || selected === job.id))
          .map((job) => [job.id, this.history(job)]));
        return sendJson(response, 200, history, id);
      }
      if (route === '/view' && request.method === 'GET') {
        const jobId = url.searchParams.get('subfolder');
        const artifactId = url.searchParams.get('filename');
        if (UUID.test(jobId || '') && UUID.test(artifactId || '') && this.jobs(source, backend.name).some((job) => job.id === jobId)) {
          return this.artifact(response, jobId, artifactId);
        }
        // Preview/input requests are delegated to ComfyUI; output requests are
        // restricted to paths registered by this broker, never arbitrary files.
        // ComfyUI defaults an omitted type to output; require explicit input or
        // temporary previews so omission cannot bypass owned-output checks.
        if (!['input', 'temp'].includes(url.searchParams.get('type'))) return sendJson(response, 404, { error: 'Use the broker history output link.' }, id);
        // ComfyUI filename annotations such as "name.png [output]" override
        // type=input upstream. Reconstruct a single unambiguous safe query.
        const query = new URLSearchParams({ filename: inputFilename(artifactId),
          subfolder: inputSubfolder(jobId ?? ''), type: url.searchParams.get('type') });
        for (const field of ['preview', 'channel']) {
          const value = url.searchParams.get(field);
          if (value !== null && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value)) query.set(field, value);
        }
        return this.forward(request, response, backend, `/view?${query}`);
      }
      if (request.method === 'POST' && ['/upload/image', '/upload/mask'].includes(route)) {
        return this.upload(request, response, backend, route, source);
      }
      if ((request.method === 'GET' && readonly(route))
        || (['POST', 'PUT', 'DELETE'].includes(request.method) && writeEditor(route))) {
        return this.forward(request, response, backend, route + url.search);
      }
      return sendJson(response, 404, { code: 'unsupported_media_endpoint', error: 'This endpoint is not permitted through the scheduled media gateway.' }, id);
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      const failure = mediaRequestError(error);
      this.service.logger.warn('Media request rejected', { code: failure.code, status: failure.status, request_id: id });
      return sendJson(response, failure.status, { code: failure.code, error: failure.error }, id);
    }
  }

  jobs(source, backend) { return this.service.media.loaded ? this.service.media.store.list().filter((job) => job.source === source && (!backend || job.backend === backend)) : []; }

  queue(source, backend) {
    const tuple = (job) => [job.enqueuedAt, job.id, {}, { client_id: 'ai-intermediary' }, []];
    const jobs = this.jobs(source, backend);
    return { queue_running: jobs.filter((job) => ['dispatching', 'running', 'uncertain'].includes(job.state)).map(tuple),
      queue_pending: jobs.filter((job) => job.state === 'queued').map(tuple) };
  }

  history(job) {
    return { prompt: [job.enqueuedAt, job.id, {}, {}, []],
      status: { completed: ['completed', 'failed', 'cancelled'].includes(job.state),
        status_str: job.state === 'completed' ? 'success' : job.state === 'uncertain' ? 'running' : 'error', messages: [] },
      outputs: this.service.media.store.nativeOutputs(job.id),
      intermediary: { state: job.state, reason: job.reason } };
  }

  nativeJob(job, detail = false) {
    const status = { queued: 'pending', dispatching: 'in_progress', running: 'in_progress', uncertain: 'in_progress',
      completed: 'completed', failed: 'failed', cancelled: 'cancelled' }[job.state];
    const outputs = this.service.media.store.nativeOutputs(job.id);
    const descriptors = Object.entries(outputs).flatMap(([nodeId, node]) => Object.entries(node)
      .filter(([field, values]) => field !== 'animated' && Array.isArray(values))
      .flatMap(([mediaType, values]) => values.map((value) => ({ ...value, nodeId, mediaType }))));
    const result = { id: job.id, status, priority: this.service.config.clients[job.source]?.priority ?? 0,
      create_time: job.enqueuedAt, outputs_count: descriptors.length, previewable_outputs_count: descriptors.length,
      ...(job.startedAt ? { execution_start_time: job.startedAt } : {}),
      ...(job.completedAt ? { execution_end_time: job.completedAt } : {}),
      ...(job.workflowId ? { workflow_id: job.workflowId } : {}),
      ...(descriptors.length ? { preview_output: descriptors[0] } : {}),
      intermediary: { state: job.state, reason: job.reason, workflow_retained: false } };
    if (detail && ['completed', 'failed', 'cancelled', 'uncertain'].includes(job.state)) {
      result.outputs = outputs;
      result.execution_status = this.history(job).status;
      result.workflow = { prompt: {}, extra_data: {} };
    }
    return result;
  }

  async nativeJobs(request, response, url, route, id, source, backend) {
    const jobs = this.jobs(source, backend);
    if (request.method === 'GET' && route === '/jobs') {
      const params = url.searchParams;
      const statuses = (params.get('status') || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
      const sortBy = (params.get('sort_by') || 'created_at').toLowerCase();
      const direction = (params.get('sort_order') || 'desc').toLowerCase();
      const validStatuses = ['pending', 'in_progress', 'completed', 'failed', 'cancelled'];
      const limit = params.has('limit') ? Number(params.get('limit')) : null;
      const offset = params.has('offset') ? Number(params.get('offset')) : 0;
      if (statuses.some((value) => !validStatuses.includes(value)) || !['created_at', 'execution_duration'].includes(sortBy)
        || !['asc', 'desc'].includes(direction) || (limit !== null && (!Number.isSafeInteger(limit) || limit <= 0))
        || !Number.isSafeInteger(offset) || offset < 0) return sendJson(response, 400, { error: 'Invalid job list filters or pagination.' }, id);
      const workflowId = params.get('workflow_id');
      const matching = jobs.map((job) => this.nativeJob(job)).filter((job) => (!statuses.length || statuses.includes(job.status))
        && (!workflowId || job.workflow_id === workflowId));
      const key = (job) => sortBy === 'created_at' ? job.create_time
        : job.execution_start_time && job.execution_end_time ? job.execution_end_time - job.execution_start_time : 0;
      matching.sort((a, b) => (key(a) - key(b)) * (direction === 'asc' ? 1 : -1));
      const page = matching.slice(offset, limit === null ? undefined : offset + limit);
      return sendJson(response, 200, { jobs: page, pagination: { offset, limit, total: matching.length, has_more: offset + page.length < matching.length } }, id);
    }
    const match = route.match(/^\/jobs\/([a-f0-9-]+)(?:\/(cancel))?$/);
    if (request.method === 'GET' && match && !match[2] && UUID.test(match[1])) {
      const job = jobs.find((entry) => entry.id === match[1]);
      return sendJson(response, job ? 200 : 404, job ? this.nativeJob(job, true) : { error: 'Job not found.' }, id);
    }
    if (request.method === 'POST' && (route === '/jobs/cancel' || (match?.[2] === 'cancel' && UUID.test(match[1])))) {
      let ids;
      if (route === '/jobs/cancel') {
        const body = JSON.parse((await readBody(request, 65_536)).toString());
        ids = body?.job_ids;
      } else ids = [match[1]];
      if (!Array.isArray(ids) || ids.length > 1000 || ids.some((value) => typeof value !== 'string' || !UUID.test(value))) {
        return sendJson(response, 400, { error: 'job_ids must be a bounded list of UUIDs.' }, id);
      }
      let cancelled = false;
      for (const jobId of new Set(ids)) {
        const job = jobs.find((entry) => entry.id === jobId);
        if (!job || !['queued', 'running'].includes(job.state)) continue;
        try { await this.service.media.cancel(job.id); cancelled = true; }
        catch (error) { if (error.statusCode !== 409 && error.status !== 409) throw error; }
      }
      return sendJson(response, 200, { cancelled }, id);
    }
    return sendJson(response, 404, { error: 'Unknown media job operation.' }, id);
  }

  async api(request, response, url, id, source) {
    if (url.pathname === `${API}/jobs` && request.method === 'POST') {
      const body = JSON.parse((await readBody(request, this.service.config.media.max_workflow_bytes + 1024 * 1024 + 65_536)).toString());
      const backend = this.service.registry.resolve(source, body.backend, 'comfyui');
      const job = await this.service.media.submit({ source, backend: backend.name, workflow: body.workflow,
        clientId: body.client_id, extraData: body.extra_data, idempotencyKey: request.headers['idempotency-key'] });
      return sendJson(response, 202, job, id);
    }
    if (url.pathname === `${API}/jobs` && request.method === 'GET') return sendJson(response, 200, this.service.media.snapshot(), id);
    const match = url.pathname.match(/^\/_intermediary\/v1\/media\/jobs\/([a-f0-9-]+)(?:\/(cancel|artifacts)(?:\/([a-f0-9-]+))?)?$/);
    if (match && UUID.test(match[1])) {
      const job = this.service.media.store.get(match[1]);
      if (!job) return sendJson(response, 404, { error: 'Job not found.' }, id);
      if (request.method === 'GET' && !match[2]) return sendJson(response, 200, job, id);
      if (request.method === 'POST' && match[2] === 'cancel') {
        await this.service.media.cancel(job.id);
        return sendJson(response, 202, { accepted: true, message: 'Cancellation requested. Active GPU work remains fenced until verified stopped.' }, id);
      }
      if (request.method === 'GET' && match[2] === 'artifacts' && UUID.test(match[3] || '')) return this.artifact(response, job.id, match[3]);
    }
    return sendJson(response, 404, { error: 'Unknown media operation.' }, id);
  }

  async artifact(response, id, artifactId) {
    const { stream, artifact } = await this.service.media.store.openArtifact(id, artifactId);
    // Never serve executable HTML/SVG under the application origin.
    const type = /^(?:image\/(?:png|jpeg|webp|gif)|video\/(?:mp4|webm))$/.test(artifact.contentType) ? artifact.contentType : 'application/octet-stream';
    response.writeHead(200, { 'content-type': type, 'content-length': artifact.bytes,
      'content-disposition': `${type === 'application/octet-stream' ? 'attachment' : 'inline'}; filename="${artifact.name.replace(/[^A-Za-z0-9_.-]/g, '_')}"`,
      'content-security-policy': "default-src 'none'; sandbox" });
    await pipeline(stream, response);
  }

  async login(request, response, source, requestId) {
    if (!this.checkOrigin(request)) return sendJson(response, 403, { error: 'Cross-origin login rejected.' }, requestId);
    // URL form escaping can expand a valid 4096-character credential several
    // times; bound the encoded request without rejecting supported passwords.
    const body = new URLSearchParams((await readBody(request, 65_536)).toString());
    const supplied = createHash('sha256').update(body.get('token') || '').digest();
    const expected = createHash('sha256').update(this.loginToken || '').digest();
    if (!this.loginToken || !timingSafeEqual(supplied, expected)) return sendJson(response, 401, { error: 'Incorrect administrator password.' }, requestId);
    for (const [id, session] of this.sessions) if (session.expires <= Date.now()) this.sessions.delete(id);
    if (this.sessions.size >= 100) this.sessions.delete(this.sessions.keys().next().value);
    const id = randomUUID();
    this.sessions.set(id, { source, expires: Date.now() + 8 * 3600_000 });
    response.writeHead(303, { location: '/', 'set-cookie': `${cookieName(source)}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${request.socket.encrypted ? '; Secure' : ''}` });
    response.end();
  }

  async upload(request, response, backend, route, source) {
    const contentType = request.headers['content-type'] ?? '';
    if (!/^multipart\/form-data(?:;|$)/i.test(contentType)) throw uploadError('media_upload_multipart_required', 415);
    const encoded = await readBody(request, this.service.config.server.body_limit_bytes);
    let form;
    try { form = await new Request('http://multipart.invalid/', { method: 'POST', headers: { 'content-type': contentType }, body: encoded }).formData(); }
    catch { throw uploadError(); }
    const fields = new Set(['image', 'type', 'subfolder', 'overwrite', ...(route === '/upload/mask' ? ['original_ref'] : [])]);
    for (const key of form.keys()) {
      if (!fields.has(key) || form.getAll(key).length !== 1) throw uploadError('media_upload_fields_invalid');
    }
    const requestedType = form.get('type');
    if (requestedType !== null && requestedType !== 'input') throw uploadError('media_upload_input_only', 403);
    const subfolder = inputSubfolder(form.get('subfolder') ?? '');
    const image = form.get('image');
    if (!image || typeof image === 'string' || typeof image.arrayBuffer !== 'function' || image.size <= 0) throw uploadError('media_upload_image_required');
    const filename = inputFilename(image.name);
    // These endpoints are for image/video inputs, never arbitrary executable,
    // model, JSON-ledger or secret files. Extension/MIME checks are not proof of
    // decoded image content; /view applies independent non-executable headers.
    if (!/\.(?:png|jpe?g|webp|gif|bmp|tiff?|avif|mp4|webm|mov|mkv)$/i.test(filename)
      || (image.type && !/^(?:image\/(?:png|jpeg|webp|gif|bmp|tiff|avif)|video\/[A-Za-z0-9.+-]+|application\/octet-stream)$/i.test(image.type))) {
      throw uploadError('media_upload_format_unsupported', 415);
    }
    const normalized = new FormData();
    normalized.set('image', image, filename);
    normalized.set('type', 'input');
    // Unique input directories prevent overwriting even another queued job's
    // inputs; never honor upstream type/output or overwrite controls verbatim.
    const sourceKey = createHash('sha256').update(source).digest('hex').slice(0, 16);
    normalized.set('subfolder', `ai-intermediary-inputs/${sourceKey}/${randomUUID()}${subfolder ? `/${subfolder}` : ''}`);
    normalized.set('overwrite', 'false');
    if (route === '/upload/mask') {
      const raw = form.get('original_ref');
      if (typeof raw !== 'string' || raw.length > 4096) throw uploadError('media_mask_reference_invalid');
      let original;
      try { original = JSON.parse(raw); } catch { throw uploadError('media_mask_reference_invalid'); }
      if (!original || typeof original !== 'object' || Array.isArray(original)
        || Object.keys(original).some((key) => !['filename', 'subfolder', 'type'].includes(key))
        || original.type !== 'input') throw uploadError('media_mask_input_reference_required', 403);
      normalized.set('original_ref', JSON.stringify({ filename: inputFilename(original.filename),
        subfolder: inputSubfolder(original.subfolder ?? ''), type: 'input' }));
    }
    return this.forward(request, response, backend, route, { body: normalized, contentType: null });
  }

  async forward(request, response, backend, route, normalized = null) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    const close = () => { if (!response.writableEnded) controller.abort(); };
    response.once('close', close);
    try {
      const body = normalized ? normalized.body : request.method === 'GET' ? undefined : await readBody(request, this.service.config.server.body_limit_bytes);
      const contentType = normalized ? normalized.contentType : request.headers['content-type'];
      const upstream = await fetch(new URL(route, backend.url), { method: request.method, redirect: 'error', signal: controller.signal, body,
        headers: { 'x-ai-intermediary-token': this.service.config.media.auth_token,
          ...(contentType ? { 'content-type': contentType } : {}) } });
      const view = route.startsWith('/view?');
      const upstreamType = (upstream.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
      const safeMedia = /^(?:image\/(?:png|jpeg|webp|gif|bmp|tiff|avif)|video\/(?:mp4|webm|quicktime|x-matroska))$/.test(upstreamType);
      response.writeHead(upstream.status, { 'content-type': view ? safeMedia ? upstreamType : 'application/octet-stream'
        : upstream.headers.get('content-type') || 'application/octet-stream',
      ...(view ? { 'content-disposition': safeMedia ? 'inline' : 'attachment',
        'content-security-policy': "default-src 'none'; sandbox", 'x-content-type-options': 'nosniff' }
        : { 'content-security-policy': "default-src 'self' blob: data:; connect-src 'self' ws: wss:; script-src 'self' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'" }) });
      let bytes = 0;
      const limit = new Transform({ transform(chunk, encoding, callback) {
        bytes += chunk.length;
        callback(bytes > 64 * 1024 * 1024 ? new Error('gateway_response_limit') : null, chunk);
      } });
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), limit, response);
      else response.end();
    } finally { clearTimeout(timeout); response.removeListener('close', close); }
  }

  async acknowledge(request, response, id) {
    const token = this.service.config.maintenance.auth_token;
    if (!token || !authorized(request, token)) return sendJson(response, 401, {
      error: 'Administrator password required.',
    }, id);
    if (request.method !== 'POST' || !this.checkOrigin(request)) return sendJson(response, 405, { error: 'Use same-origin POST.' }, id);
    const body = JSON.parse((await readBody(request, 4096)).toString());
    if (body.confirm_service_stopped !== true) return sendJson(response, 400, { error: 'Verify that the previous ComfyUI service/workers were stopped and cannot resume, then set confirm_service_stopped:true.' }, id);
    if (!this.service.maintenance.paused || this.service.scheduler.active || this.service.gate.active) return sendJson(response, 409, { error: 'Pause and wait for active GPU work to finish first.' }, id);
    const revision = this.service.maintenance.revision;
    const beforeAcknowledge = () => {
      if (!this.service.maintenance.paused || this.service.maintenance.revision !== revision || this.service.settingsRestartPending) {
        throw Object.assign(new Error('Recovery pause changed during verification.'), { code: 'media_recovery_policy_changed', statusCode: 409 });
      }
    };
    const release = await this.service.gate.acquire('maintenance', this.service.workerController.signal);
    try {
      beforeAcknowledge();
      await this.service.media.acknowledge(this.service.workerController.signal, beforeAcknowledge);
      return sendJson(response, 200, { acknowledged: true, paused: true }, id);
    } finally { release(); }
  }

  upgrade(request, socket, head, source) {
    const url = new URL(request.url, 'http://gateway.local');
    const backend = this.sourceBackend(source);
    if (!this.service.media.enabled || !backend?.enabled || !['/ws', '/api/ws'].includes(url.pathname)
      || !this.authenticated(request, source) || !this.checkOrigin(request)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
    }
    if (this.sockets.size >= MAX_SOCKETS) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return;
    }
    const target = new URL(`/ws${url.search}`, backend.url);
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    this.wss.handleUpgrade(request, socket, head, (client) => {
      const upstream = new WebSocket(target, { headers: { 'X-AI-Intermediary-Token': this.service.config.media.auth_token },
        handshakeTimeout: 10_000, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false, followRedirects: false });
      const entry = { client, upstream, source, backend: backend.name, pendingPrompts: new Set() };
      this.sockets.add(entry);
      let featuresForwarded = false;
      client.on('message', (data, binary) => {
        if (featuresForwarded || binary || data.length > 16_384) return;
        try {
          const message = JSON.parse(data.toString());
          if (message.type !== 'feature_flags' || !message.data || typeof message.data !== 'object'
            || Array.isArray(message.data) || Object.keys(message.data).length > 100) return;
          featuresForwarded = true;
          const payload = JSON.stringify({ type: 'feature_flags', data: message.data });
          const send = () => { if (upstream.readyState === WebSocket.OPEN) upstream.send(payload); };
          if (upstream.readyState === WebSocket.OPEN) send(); else upstream.once('open', send);
        } catch { /* Only the bounded native feature negotiation is forwarded. */ }
      });
      client.on('close', () => { this.sockets.delete(entry); upstream.terminate(); });
      client.on('error', () => client.terminate());
      upstream.on('error', () => client.close(1011, 'Backend progress unavailable; jobs remain tracked.'));
      upstream.on('close', () => client.close());
      upstream.on('message', (data, binary) => {
        if (client.readyState !== WebSocket.OPEN) return;
        if (!binary) {
          try {
            const event = JSON.parse(data.toString());
            if (event.data?.prompt_id) {
              const job = this.jobs(source, backend.name).find((item) => item.id === event.data.prompt_id);
              if (!job) return; // Never forward another source's job progress.
              entry.pendingPrompts.add(job.id);
              // Native output paths are not public gateway paths. Emit output
              // and terminal events only after owned artifacts are imported and
              // GPU release is verified, with broker result URLs below.
              if (['executed', 'execution_success', 'execution_error', 'execution_interrupted'].includes(event.type)
                || (event.type === 'executing' && event.data.node == null)) return;
            }
            if (event.type === 'status') {
              const queue = this.queue(source, backend.name);
              event.data.status.exec_info.queue_remaining = queue.queue_running.length + queue.queue_pending.length;
              data = JSON.stringify(event);
            }
          } catch { /* forward opaque bounded events */ }
        }
        if (client.bufferedAmount > MAX_BUFFERED) return client.close(1013, 'Progress consumer is too slow.');
        client.send(data, { binary });
      });
    });
  }

  broadcastStatus() {
    for (const { client, source, backend } of this.sockets) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (client.bufferedAmount > MAX_BUFFERED) { client.close(1013, 'Progress consumer is too slow.'); continue; }
      const queue = this.queue(source, backend);
      client.send(JSON.stringify({ type: 'status', data: { status: { exec_info: { queue_remaining: queue.queue_running.length + queue.queue_pending.length } } } }));
    }
  }

  broadcastTerminal(id) {
    const job = this.service.media.store.get(id);
    if (!job || !['completed', 'failed', 'cancelled'].includes(job.state)) return;
    for (const { client, source, backend, pendingPrompts } of this.sockets) {
      if (client.readyState !== WebSocket.OPEN || source !== job.source || backend !== job.backend || !pendingPrompts.has(id)) continue;
      if (client.bufferedAmount > MAX_BUFFERED) { client.close(1013, 'Progress consumer is too slow.'); continue; }
      pendingPrompts.delete(id);
      const send = (type, data) => {
        if (client.readyState !== WebSocket.OPEN) return;
        if (client.bufferedAmount > MAX_BUFFERED) { client.close(1013, 'Progress consumer is too slow.'); return; }
        client.send(JSON.stringify({ type, data: { prompt_id: id, ...data } }));
      };
      if (job.state === 'completed') {
        for (const [node, output] of Object.entries(this.service.media.store.nativeOutputs(id))) {
          send('executed', { node, display_node: node, output });
        }
        send('execution_success', { timestamp: job.completedAt });
      } else if (job.state === 'cancelled') {
        send('execution_interrupted', { node_id: null, node_type: null, executed: [] });
      } else {
        send('execution_error', { node_id: null, node_type: null, executed: [], exception_type: 'MediaJobFailed',
          exception_message: job.reason || 'Media job failed; inspect broker status.', traceback: [], current_inputs: {}, current_outputs: [] });
      }
      send('executing', { node: null });
    }
  }

  close() {
    for (const { client, upstream } of this.sockets) { client.terminate(); upstream.terminate(); }
    this.sockets.clear();
    this.wss.close();
    this.sessions.clear();
  }
}
