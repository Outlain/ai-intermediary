import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { sanitizeComfyArtifact } from './comfy-backend.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const STATES = new Set(['queued', 'dispatching', 'running', ...TERMINAL, 'uncertain']);
const TRANSITIONS = {
  queued: new Set(['dispatching', 'cancelled', 'failed']),
  dispatching: new Set(['running', 'completed', 'failed', 'cancelled', 'uncertain']),
  running: new Set(['completed', 'failed', 'cancelled', 'uncertain']),
  uncertain: new Set(['running', 'completed', 'failed', 'cancelled']),
};
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const MAX_STATE_BYTES = 256 * 1024 * 1024;
const MAX_WORKFLOW_BYTES = 64 * 1024 * 1024;
const MAX_EXTRA_DATA_BYTES = 1024 * 1024;
const MAX_TERMINAL_HISTORY = 1000;
const clone = (value) => structuredClone(value);
const text = (value, max = 160) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max);
const digest = (value) => createHash('sha256').update(value).digest('hex');

export class MediaStoreError extends Error {
  constructor(code, status = 409) { super(code); this.name = 'MediaStoreError'; this.code = code; this.status = status; this.statusCode = status; }
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

async function safeDirectory(directory, create = false) {
  const target = path.resolve(directory);
  let current = path.parse(target).root;
  for (const component of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (create) await fsp.mkdir(current, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    const stat = await fsp.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new MediaStoreError('media_unsafe_storage_path', 503);
  }
  return target;
}

async function safeFile(filename, allowMissing = false) {
  await safeDirectory(path.dirname(filename));
  try {
    const stat = await fsp.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new MediaStoreError('media_unsafe_storage_path', 503);
    return stat;
  } catch (error) { if (allowMissing && error.code === 'ENOENT') return null; throw error; }
}

function publicJob(job) {
  const { workflow, extraData, client_id, idempotencyHash, bodyHash, comfyHistory, ...publicFields } = job;
  return clone({ ...publicFields, artifacts: publicFields.artifacts.map(({ sourceHash, ...artifact }) => artifact) });
}

/** Durable metadata/workflows. Never treat an interrupted dispatch as safe to replay. */
export class MediaStore {
  constructor(config = {}, { clock = Date.now } = {}) {
    this.config = {
      state_path: '/app/state/media-jobs.json', storage_path: '/app/state/media',
      max_jobs: 100, max_workflow_bytes: 2 * 1024 * 1024,
      max_storage_bytes: 10 * 1024 ** 3, max_output_bytes: 1024 ** 3,
      retentionMs: 7 * 24 * 60 * 60 * 1000, ...config,
    };
    this.clock = clock;
    this.filename = path.resolve(this.config.state_path);
    this.storage = path.resolve(this.config.storage_path);
    this.jobs = new Map();
    this.ready = false;
    this.tail = Promise.resolve();
  }

  serial(operation) {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }

  init() {
    return this.serial(async () => {
      if (this.ready) return this;
      await safeDirectory(path.dirname(this.filename), true);
      await safeDirectory(this.storage, true);
      const stat = await safeFile(this.filename, true);
      if (stat) {
        if (stat.size > MAX_STATE_BYTES) throw new MediaStoreError('media_state_too_large', 503);
        let state;
        try {
          const handle = await fsp.open(this.filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          try { state = JSON.parse(await handle.readFile('utf8')); } finally { await handle.close(); }
        }
        catch { throw new MediaStoreError('media_state_invalid', 503); }
        if (state.schema !== 1 || !Array.isArray(state.jobs)) throw new MediaStoreError('media_state_invalid', 503);
        for (const job of state.jobs) {
          this.validateRestored(job);
          job.workflowBytes = (job.workflow ? Buffer.byteLength(JSON.stringify(job.workflow)) : 0)
            + (job.extraData ? Buffer.byteLength(JSON.stringify(job.extraData)) : 0);
          if (this.jobs.has(job.id)) throw new MediaStoreError('media_state_invalid', 503);
          if (job.state === 'dispatching' || job.state === 'running') {
            job.previousState = job.state;
            job.state = 'uncertain';
            job.reason = 'restart_outcome_unknown';
            job.updatedAt = this.clock();
          }
          this.jobs.set(job.id, job);
        }
        if (this.pendingWorkflowBytes() > MAX_WORKFLOW_BYTES) throw new MediaStoreError('media_workflow_memory_full', 503);
      }
      await this.persist();
      this.ready = true;
      return this;
    });
  }

  validateRestored(job) {
    const invalid = () => { throw new MediaStoreError('media_state_invalid', 503); };
    if (!job || !UUID.test(job.id) || !STATES.has(job.state)
      || typeof job.source !== 'string' || typeof job.backend !== 'string'
      || !Number.isFinite(job.enqueuedAt) || !Number.isFinite(job.updatedAt)
      || !HASH.test(job.bodyHash) || (job.idempotencyHash && !HASH.test(job.idempotencyHash))
      || !Array.isArray(job.artifacts)) invalid();
    if (!TERMINAL.has(job.state) && (!job.workflow || typeof job.workflow !== 'object' || Array.isArray(job.workflow))) invalid();
    for (const artifact of job.artifacts) {
      if (!artifact || !UUID.test(artifact.id) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0
        || !['available', 'expired'].includes(artifact.status)) invalid();
    }
  }

  assertReady() { if (!this.ready) throw new MediaStoreError('media_store_not_ready', 503); }
  pendingWorkflowBytes() { return [...this.jobs.values()].reduce((sum, job) => sum + (job.workflowBytes ?? 0), 0); }
  get(id) { const job = this.jobs.get(id); return job ? publicJob(job) : null; }
  getInternal(id) { const job = this.jobs.get(id); return job ? clone(job) : null; }
  list({ state, source, backend } = {}) {
    return [...this.jobs.values()].filter((job) => (!state || job.state === state)
      && (!source || job.source === source) && (!backend || job.backend === backend))
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt).map(publicJob);
  }
  listInternal() { return [...this.jobs.values()].map(clone); }
  queued({ includeWorkflow = false } = {}) {
    return [...this.jobs.values()].filter((job) => job.state === 'queued')
      .sort((a, b) => a.enqueuedAt - b.enqueuedAt).map(includeWorkflow ? clone : publicJob);
  }
  unresolved({ includeWorkflow = false } = {}) {
    return [...this.jobs.values()].filter((job) => ['dispatching', 'running', 'uncertain'].includes(job.state))
      .map(includeWorkflow ? clone : publicJob);
  }

  setComfyHistory(id, history) {
    return this.serial(async () => {
      this.assertReady();
      const job = this.jobs.get(id);
      if (!job) throw new MediaStoreError('media_job_not_found', 404);
      const outputs = {};
      let count = 0;
      // History may contain prompts, exception tracebacks, absolute paths and
      // arbitrary custom-node values. Retain only bounded output descriptors.
      for (const [nodeId, node] of Object.entries(history?.outputs ?? {})) {
        if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(nodeId) || ['__proto__', 'prototype', 'constructor'].includes(nodeId)
          || !node || typeof node !== 'object' || Array.isArray(node)) continue;
        const normalized = {};
        for (const field of ['images', 'gifs', 'videos', 'audio']) {
          if (!Array.isArray(node[field])) continue;
          normalized[field] = [];
          for (const value of node[field]) {
            if (++count > 1024) throw new MediaStoreError('media_history_too_large', 413);
            try {
              const descriptor = sanitizeComfyArtifact(value);
              if (typeof value.format === 'string' && /^[A-Za-z0-9_.+/-]{1,80}$/.test(value.format)) descriptor.format = value.format;
              if (Number.isFinite(value.frame_rate) && value.frame_rate > 0 && value.frame_rate <= 1000) descriptor.frame_rate = value.frame_rate;
              normalized[field].push(descriptor);
            } catch { /* Never retain an unsafe or unowned input/temporary path. */ }
          }
        }
        if (Array.isArray(node.animated)) normalized.animated = node.animated.slice(0, 1024).map(Boolean);
        if (Object.keys(normalized).length) outputs[nodeId] = normalized;
      }
      const previous = job.comfyHistory;
      job.comfyHistory = { outputs };
      try { await this.persist(); } catch (error) { job.comfyHistory = previous; throw error; }
    });
  }

  /** Native output metadata with broker-owned result links, never backend paths. */
  nativeOutputs(id) {
    const job = this.jobs.get(id);
    if (!job) return {};
    const outputs = {};
    for (const [nodeId, node] of Object.entries(job.comfyHistory?.outputs ?? {})) {
      const normalized = {};
      for (const field of ['images', 'gifs', 'videos', 'audio']) {
        if (!Array.isArray(node[field])) continue;
        normalized[field] = node[field].flatMap((descriptor) => {
          const { filename, subfolder, type } = descriptor;
          const hash = digest(JSON.stringify({ filename, subfolder, type }));
          const artifact = job.artifacts.find((item) => item.sourceHash === hash && item.status === 'available');
          return artifact ? [{ ...descriptor,
            ...(!descriptor.format && /^(?:video|audio)\//.test(artifact.contentType) ? { format: artifact.contentType } : {}),
            filename: artifact.id, subfolder: job.id, type: 'output' }] : [];
        });
      }
      if (Array.isArray(node.animated)) normalized.animated = clone(node.animated);
      if (Object.keys(normalized).length) outputs[nodeId] = normalized;
    }
    return outputs;
  }

  create(input, { admit = () => {} } = {}) {
    return this.serial(async () => {
      this.assertReady();
      const workflow = input.workflow ?? input.prompt;
      if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) throw new MediaStoreError('media_workflow_invalid', 400);
      let encoded;
      try { encoded = JSON.stringify(workflow); } catch { throw new MediaStoreError('media_workflow_invalid', 400); }
      if (Buffer.byteLength(encoded) > this.config.max_workflow_bytes) throw new MediaStoreError('media_workflow_too_large', 413);
      const metadata = input.extraData ?? input.extra_data ?? {};
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
        || Object.keys(metadata).some((key) => key !== 'extra_pnginfo')
        || (Object.hasOwn(metadata, 'extra_pnginfo') && (!metadata.extra_pnginfo || typeof metadata.extra_pnginfo !== 'object' || Array.isArray(metadata.extra_pnginfo)))) {
        throw new MediaStoreError('media_metadata_invalid', 400);
      }
      let encodedMetadata;
      try { encodedMetadata = JSON.stringify(metadata); } catch { throw new MediaStoreError('media_metadata_invalid', 400); }
      if (Buffer.byteLength(encodedMetadata) > MAX_EXTRA_DATA_BYTES) throw new MediaStoreError('media_metadata_too_large', 413);
      const extraData = JSON.parse(encodedMetadata);
      if (!input.source || !input.backend || typeof input.source !== 'string' || typeof input.backend !== 'string') {
        throw new MediaStoreError('media_route_invalid', 400);
      }
      const normalized = JSON.parse(encoded);
      const bodyHash = digest(stable({ source: input.source, backend: input.backend, workflow: normalized, extraData }));
      const key = input.idempotencyKey ?? input.idempotency_key;
      if (key !== undefined && (typeof key !== 'string' || !key.length || key.length > 256)) throw new MediaStoreError('media_idempotency_key_invalid', 400);
      const idempotencyHash = key ? digest(`${input.source}\0${key}`) : null;
      if (idempotencyHash) {
        const existing = [...this.jobs.values()].find((job) => job.idempotencyHash === idempotencyHash);
        if (existing) {
          if (existing.bodyHash !== bodyHash) throw new MediaStoreError('media_idempotency_conflict', 409);
          return { job: publicJob(existing), created: false };
        }
      }
      // Capacity/policy checks for a *new* admission belong after durable
      // idempotency lookup. Retrying an accepted job is not another queue slot.
      await admit();
      await this.cleanupInternal(0, null, 1);
      if ([...this.jobs.values()].filter((job) => TERMINAL.has(job.state)).length >= MAX_TERMINAL_HISTORY) throw new MediaStoreError('media_history_full', 429);
      if ([...this.jobs.values()].filter((job) => !TERMINAL.has(job.state)).length >= this.config.max_jobs) throw new MediaStoreError('media_queue_full', 429);
      const workflowBytes = Buffer.byteLength(encoded) + Buffer.byteLength(encodedMetadata);
      if (this.pendingWorkflowBytes() + workflowBytes > MAX_WORKFLOW_BYTES) throw new MediaStoreError('media_workflow_memory_full', 429);
      const id = input.id ?? randomUUID();
      if (!UUID.test(id) || this.jobs.has(id)) throw new MediaStoreError('media_job_id_invalid', 409);
      const now = this.clock();
      const job = {
        id, source: input.source, backend: input.backend, workflow: normalized, extraData, workflowBytes,
        client_id: text(input.client_id, 256), state: 'queued',
        enqueuedAt: Number.isFinite(input.enqueuedAt) ? input.enqueuedAt : now,
        updatedAt: now, completedAt: null, reason: null, artifacts: [], bodyHash, idempotencyHash,
        ...(typeof extraData.extra_pnginfo?.workflow?.id === 'string' ? { workflowId: text(extraData.extra_pnginfo.workflow.id, 256) } : {}),
      };
      this.jobs.set(id, job);
      try { await this.persist(); } catch (error) { this.jobs.delete(id); throw error; }
      return { job: publicJob(job), created: true };
    });
  }

  update(id, patch, { reconciled = false, expectedState } = {}) {
    return this.serial(async () => {
      this.assertReady();
      const previous = this.jobs.get(id);
      if (!previous) throw new MediaStoreError('media_job_not_found', 404);
      if (expectedState && previous.state !== expectedState) throw new MediaStoreError('media_job_already_dispatched', 409);
      const next = clone(previous);
      if (patch.state && patch.state !== previous.state) {
        if (!STATES.has(patch.state) || !TRANSITIONS[previous.state]?.has(patch.state)
          || (previous.state === 'uncertain' && !reconciled)) throw new MediaStoreError('media_invalid_transition', 409);
        next.state = patch.state;
      }
      // Deliberately do not merge arbitrary backend responses, paths or workflow changes.
      for (const field of ['reason', 'upstreamPromptId', 'previousState']) {
        if (Object.hasOwn(patch, field)) next[field] = patch[field] == null ? null : text(patch[field], 256);
      }
      if (Object.hasOwn(patch, 'error') && !Object.hasOwn(patch, 'reason')) next.reason = patch.error == null ? null : text(patch.error, 256);
      if (Object.hasOwn(patch, 'progress')) {
        const value = Number(patch.progress);
        if (!Number.isFinite(value) || value < 0 || value > 1) throw new MediaStoreError('media_progress_invalid', 400);
        next.progress = value;
      }
      next.updatedAt = this.clock();
      if (next.state === 'running') next.startedAt ??= this.clock();
      if (TERMINAL.has(next.state)) {
        next.completedAt ??= this.clock();
        delete next.workflow;
        delete next.extraData;
        delete next.client_id;
        next.workflowBytes = 0;
      }
      this.jobs.set(id, next);
      try { await this.persist(); } catch (error) { this.jobs.set(id, previous); throw error; }
      return publicJob(next);
    });
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return Promise.reject(new MediaStoreError('media_job_not_found', 404));
    if (job.state !== 'queued') return Promise.reject(new MediaStoreError('media_job_already_dispatched', 409));
    return this.update(id, { state: 'cancelled', reason: 'cancelled_before_dispatch' }, { expectedState: 'queued' });
  }

  /** Internal adapter contract only: the caller has definitive evidence that
   * no upstream HTTP dispatch began. Never use for network errors or restarts. */
  requeueUndispatched(id) {
    return this.serial(async () => {
      this.assertReady();
      const previous = this.jobs.get(id);
      if (!previous) throw new MediaStoreError('media_job_not_found', 404);
      if (previous.state !== 'dispatching') throw new MediaStoreError('media_invalid_transition', 409);
      const next = { ...previous, state: 'queued', updatedAt: this.clock(), reason: null };
      delete next.upstreamPromptId;
      this.jobs.set(id, next);
      try { await this.persist(); } catch (error) { this.jobs.set(id, previous); throw error; }
      return publicJob(next);
    });
  }

  artifactPath(jobId, artifactId) {
    if (!UUID.test(jobId) || !UUID.test(artifactId)) throw new MediaStoreError('media_artifact_invalid', 400);
    return path.join(this.storage, jobId, `${artifactId}.bin`);
  }

  usedBytes() { return [...this.jobs.values()].flatMap((job) => job.artifacts).filter((artifact) => artifact.status === 'available').reduce((sum, artifact) => sum + artifact.bytes, 0); }

  saveArtifact(id, { name = 'output', contentType = 'application/octet-stream', stream, data, key } = {}) {
    return this.serial(async () => {
      this.assertReady();
      const job = this.jobs.get(id);
      if (!job) throw new MediaStoreError('media_job_not_found', 404);
      if (!['running', 'dispatching', 'completed', 'uncertain'].includes(job.state)) throw new MediaStoreError('media_invalid_transition');
      if (key !== undefined && (typeof key !== 'string' || !key.length || key.length > 4096)) throw new MediaStoreError('media_artifact_key_invalid', 400);
      const sourceHash = key ? digest(key) : null;
      const existing = sourceHash && job.artifacts.find((artifact) => artifact.sourceHash === sourceHash && artifact.status === 'available');
      if (existing) return clone(existing);
      if (data !== undefined && !Buffer.isBuffer(data)) throw new MediaStoreError('media_artifact_invalid', 400);
      const source = data !== undefined ? [data] : stream;
      if (!source || (!source[Symbol.asyncIterator] && !source[Symbol.iterator])) throw new MediaStoreError('media_artifact_invalid', 400);
      const artifactId = randomUUID();
      const filename = this.artifactPath(id, artifactId);
      await safeDirectory(path.dirname(filename), true);
      const handle = await fsp.open(filename, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
      let bytes = 0;
      try {
        for await (const chunk of source) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > this.config.max_output_bytes) throw new MediaStoreError('media_output_too_large', 413);
          await this.cleanupInternal(bytes, id);
          if (this.usedBytes() + bytes > this.config.max_storage_bytes) throw new MediaStoreError('media_storage_full', 507);
          await handle.writeFile(buffer);
        }
        await handle.sync();
        await handle.close();
        const artifact = { id: artifactId, name: text(path.basename(name), 160), contentType: text(contentType, 120), bytes, status: 'available', createdAt: this.clock(), sourceHash };
        job.artifacts.push(artifact);
        try { await this.persist(); } catch (error) { job.artifacts.pop(); throw error; }
        return clone(artifact);
      } catch (error) {
        await handle.close().catch(() => {});
        await safeFile(filename).then(() => fsp.unlink(filename)).catch(() => {});
        throw error;
      }
    });
  }

  async openArtifact(id, artifactId) {
    this.assertReady();
    const job = this.jobs.get(id);
    const artifact = job?.artifacts.find((item) => item.id === artifactId);
    if (!artifact) throw new MediaStoreError('media_artifact_not_found', 404);
    if (artifact.status !== 'available') throw new MediaStoreError('media_artifact_expired', 410);
    const filename = this.artifactPath(id, artifactId);
    await safeFile(filename);
    const handle = await fsp.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    return { artifact: clone(artifact), stream: handle.createReadStream({ autoClose: true }) };
  }

  cleanup() { return this.serial(() => this.cleanupInternal(0)); }

  async cleanupInternal(reserve = 0, excludeId = null, reserveHistory = 0) {
    const candidates = [...this.jobs.values()].filter((job) => job.state === 'completed' && job.id !== excludeId)
      .sort((a, b) => a.completedAt - b.completedAt);
    let deleted = 0;
    for (const job of candidates) {
      const old = this.clock() - job.completedAt >= this.config.retentionMs;
      if (!old && this.usedBytes() + reserve <= this.config.max_storage_bytes) continue;
      for (const artifact of job.artifacts) {
        if (artifact.status !== 'available') continue;
        const filename = this.artifactPath(job.id, artifact.id);
        await safeFile(filename, true).then((stat) => stat && fsp.unlink(filename));
        artifact.status = 'expired';
        artifact.expiredAt = this.clock();
        deleted += 1;
      }
    }
    let retired = 0;
    const terminal = [...this.jobs.values()].filter((job) => TERMINAL.has(job.state)).sort((a, b) => a.completedAt - b.completedAt);
    let excess = terminal.length - (MAX_TERMINAL_HISTORY - reserveHistory);
    for (const job of terminal) {
      if (excess <= 0) break;
      if (job.id === excludeId || this.clock() - job.completedAt < this.config.retentionMs
        || job.artifacts.some((artifact) => artifact.status === 'available')) continue;
      // Only remove our generated directory if empty. An operator's unrelated
      // file intentionally prevents directory removal and is never deleted.
      const directory = path.join(this.storage, job.id);
      try { await safeDirectory(directory); await fsp.rmdir(directory); }
      catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
      this.jobs.delete(job.id);
      excess -= 1;
      retired += 1;
    }
    if (deleted || retired) await this.persist();
    return { deleted, usedBytes: this.usedBytes() };
  }

  async persist() {
    await safeDirectory(path.dirname(this.filename));
    await safeFile(this.filename, true);
    const encoded = JSON.stringify({ schema: 1, jobs: [...this.jobs.values()] });
    if (Buffer.byteLength(encoded) > MAX_STATE_BYTES) throw new MediaStoreError('media_state_too_large', 507);
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    const handle = await fsp.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(encoded);
      await handle.sync();
      await handle.close();
      await fsp.rename(temporary, this.filename);
      const directory = await fsp.open(path.dirname(this.filename), fs.constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      // A rename or directory fsync error can leave the durable outcome unknown.
      // Do not permit another admission/dispatch until the store is reopened.
      this.ready = false;
      await handle.close().catch(() => {});
      await fsp.unlink(temporary).catch(() => {});
      throw error;
    }
  }
}
