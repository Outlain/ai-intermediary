import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID, createHash } from 'node:crypto';
import { MediaStore } from '../src/media-store.js';

async function setup(t, overrides = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'media-store-test-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const time = { now: 1_000_000 };
  const config = { state_path: path.join(directory, 'jobs.json'), storage_path: path.join(directory, 'outputs'), ...overrides };
  const store = new MediaStore(config, { clock: () => time.now });
  await store.init();
  return { store, config, directory, time };
}
const workflow = { '1': { class_type: 'Example', inputs: { text: 'private prompt, not a log' } } };
const input = (extra = {}) => ({ source: 'media', backend: 'comfy-main', workflow, client_id: 'private-browser', ...extra });
async function running(store) {
  const { job } = await store.create(input());
  await store.update(job.id, { state: 'dispatching' });
  await store.update(job.id, { state: 'running', upstreamPromptId: 'comfy-prompt-1' });
  return job.id;
}

test('terminal execution and output bytes survive restart independently of GPU release', async (t) => {
  const { store, config } = await setup(t);
  const id = await running(store);
  const descriptor = { filename: 'node-7_00001_.mp4', subfolder: `ai-intermediary/${id}`, type: 'output' };
  const history = { outputs: { '7': { videos: [descriptor] } }, secret: 'not retained' };
  await store.setComfyHistory(id, history, { state: 'completed', artifacts: [descriptor] });
  const data = Buffer.from('saved movie');
  const sha256 = createHash('sha256').update(data).digest('hex');
  const artifact = await store.saveArtifact(id, { data, key: JSON.stringify(descriptor), expectedSha256: sha256 });
  await store.update(id, { outputsImported: true });
  const restarted = new MediaStore(config);
  await restarted.init();
  assert.equal(restarted.get(id).state, 'uncertain');
  assert.equal(restarted.get(id).execution_state, 'completed');
  assert.equal(restarted.get(id).outputsImported, true);
  assert.equal(restarted.get(id).execution, undefined);
  assert.equal(restarted.getInternal(id).comfyHistory.secret, undefined);
  assert.equal(restarted.nativeOutputs(id)['7'].videos[0].filename, artifact.id);
  const { stream } = await restarted.openArtifact(id, artifact.id, { start: 1, end: 4 });
  let bytes = Buffer.alloc(0);
  for await (const chunk of stream) bytes = Buffer.concat([bytes, chunk]);
  assert.equal(bytes.toString(), 'aved');
});

test('checksum failures preserve originals and idempotent recovery rejects changed bytes', async (t) => {
  const { store } = await setup(t);
  const id = await running(store);
  const data = Buffer.from('movie');
  const sha256 = createHash('sha256').update(data).digest('hex');
  await assert.rejects(store.saveArtifact(id, { data, key: 'same', expectedSha256: '0'.repeat(64) }), { code: 'media_checksum_mismatch' });
  assert.deepEqual(store.get(id).artifacts, []);
  const artifact = await store.saveArtifact(id, { data, key: 'same', expectedSha256: sha256 });
  assert.equal((await store.saveArtifact(id, { data, key: 'same', expectedSha256: sha256 })).id, artifact.id);
  await assert.rejects(store.saveArtifact(id, { data, key: 'same', expectedSha256: '0'.repeat(64) }), { code: 'media_checksum_mismatch' });
  assert.equal(store.get(id).artifacts.length, 1);
});

test('invalid execution evidence cannot partially change stored history', async (t) => {
  const { store } = await setup(t);
  const id = await running(store);
  await store.setComfyHistory(id, { outputs: {} });
  const before = store.getInternal(id);
  await assert.rejects(store.setComfyHistory(id, { outputs: { '1': { images: [] } } }, {
    state: 'completed', artifacts: [{ filename: '../escape', type: 'output' }],
  }));
  assert.deepEqual(store.getInternal(id), before);
});

test('recovered outputs expire only after explicit recovery retires uncertainty', async (t) => {
  const { store, time } = await setup(t, { retentionMs: 100 });
  const id = await running(store);
  await store.saveArtifact(id, { data: Buffer.from('movie') });
  await store.update(id, { state: 'uncertain', recoveredOutputs: true });
  time.now += 1000;
  await store.cleanup();
  assert.equal(store.get(id).artifacts[0].status, 'available');
  await store.update(id, { state: 'failed', reason: 'operator_verified_service_stopped' }, { reconciled: true });
  time.now += 101;
  await store.cleanup();
  assert.equal(store.get(id).artifacts[0].status, 'expired');
});

test('durable create redacts workflows and client identifiers from every public view', async (t) => {
  const { store, config } = await setup(t);
  const { job, created } = await store.create(input());
  assert.equal(created, true);
  assert.equal(job.state, 'queued');
  for (const record of [job, store.get(job.id), ...store.list()]) {
    assert.equal(record.workflow, undefined);
    assert.equal(record.client_id, undefined);
    assert.equal(record.bodyHash, undefined);
    assert.equal(record.idempotencyHash, undefined);
    assert.equal(JSON.stringify(record).includes('private prompt'), false);
  }
  assert.deepEqual(store.getInternal(job.id).workflow, workflow);
  const disk = JSON.parse(fs.readFileSync(config.state_path, 'utf8'));
  assert.deepEqual(disk.jobs[0].workflow, workflow);
  assert.equal(fs.statSync(config.state_path).mode & 0o777, 0o600);
  assert.equal(store.get(randomUUID()), null);
});

test('idempotent create persists its mapping and detects body/backend changes', async (t) => {
  const { store, config } = await setup(t);
  const first = await store.create(input({ idempotencyKey: 'some-secret-key' }));
  const duplicate = await store.create(input({ idempotencyKey: 'some-secret-key' }));
  assert.equal(duplicate.created, false);
  assert.equal(first.job.id, duplicate.job.id);
  const restarted = new MediaStore(config);
  await restarted.init();
  assert.equal((await restarted.create(input({ idempotencyKey: 'some-secret-key' }))).created, false);
  assert.equal(fs.readFileSync(config.state_path, 'utf8').includes('some-secret-key'), false);
  await assert.rejects(store.create(input({ idempotencyKey: 'some-secret-key', workflow: { another: {} } })), { code: 'media_idempotency_conflict' });
  await assert.rejects(store.create(input({ idempotencyKey: 'some-secret-key', backend: 'other-backend' })), { code: 'media_idempotency_conflict' });
  // Idempotency is scoped to the identified source.
  assert.equal((await store.create(input({ idempotencyKey: 'some-secret-key', source: 'another-source' }))).created, true);
});

test('idempotency ignores object key ordering but preserves workflow array order', async (t) => {
  const { store } = await setup(t);
  const first = await store.create(input({ idempotencyKey: 'one', workflow: { b: 2, a: [1, 2] } }));
  assert.equal((await store.create(input({ idempotencyKey: 'one', workflow: { a: [1, 2], b: 2 } }))).job.id, first.job.id);
  await assert.rejects(store.create(input({ idempotencyKey: 'one', workflow: { a: [2, 1], b: 2 } })), { code: 'media_idempotency_conflict' });
});

test('restart restores queued jobs and quarantines dispatching/running without replay', async (t) => {
  const { store, config, time } = await setup(t);
  const queued = (await store.create(input())).job.id;
  const dispatching = (await store.create(input())).job.id;
  await store.update(dispatching, { state: 'dispatching' });
  const active = await running(store);
  time.now += 100;
  const restarted = new MediaStore(config, { clock: () => time.now });
  await restarted.init();
  assert.deepEqual(restarted.queued().map((job) => job.id), [queued]);
  assert.equal(restarted.unresolved().length, 2);
  for (const id of [dispatching, active]) {
    assert.equal(restarted.get(id).state, 'uncertain');
    assert.equal(restarted.get(id).reason, 'restart_outcome_unknown');
    await assert.rejects(restarted.update(id, { state: 'queued' }, { reconciled: true }), { code: 'media_invalid_transition' });
    await assert.rejects(restarted.update(id, { state: 'completed' }), { code: 'media_invalid_transition' });
    await restarted.update(id, { state: 'completed', reason: 'backend_history_verified' }, { reconciled: true });
  }
  assert.equal(restarted.unresolved().length, 0);
  assert.equal(JSON.parse(fs.readFileSync(config.state_path, 'utf8')).jobs.find((job) => job.id === active).workflow, undefined);
});

test('concurrent writes serialize and queued cancellation cannot race a dispatch', async (t) => {
  const { store, config } = await setup(t);
  const jobs = await Promise.all(Array.from({ length: 12 }, () => store.create(input())));
  assert.equal(store.list().length, 12);
  assert.equal(JSON.parse(fs.readFileSync(config.state_path, 'utf8')).jobs.length, 12);
  const id = jobs[0].job.id;
  const dispatch = store.update(id, { state: 'dispatching' });
  const cancel = store.cancel(id);
  await dispatch;
  await assert.rejects(cancel, { code: 'media_job_already_dispatched' });
  assert.equal(store.get(id).state, 'dispatching');
  await store.cancel(jobs[1].job.id);
  assert.equal(store.get(jobs[1].job.id).state, 'cancelled');
});

test('queue and payload limits fail without partial admissions; terminal history does not fill the queue', async (t) => {
  const { store } = await setup(t, { max_jobs: 1, max_workflow_bytes: 128 });
  await assert.rejects(store.create(input({ workflow: { text: 'x'.repeat(130) } })), { code: 'media_workflow_too_large' });
  const { job } = await store.create(input());
  await assert.rejects(store.create(input()), { code: 'media_queue_full' });
  await store.cancel(job.id);
  assert.equal((await store.create(input())).created, true);
});

test('artifact streaming enforces per-output limit and never accepts external file paths', async (t) => {
  const { store, config } = await setup(t, { max_output_bytes: 6 });
  const id = await running(store);
  await assert.rejects(store.saveArtifact(id, { stream: Readable.from([Buffer.from('four'), Buffer.from('more')]) }), { code: 'media_output_too_large' });
  assert.deepEqual(fs.readdirSync(path.join(config.storage_path, id)), []);
  const artifact = await store.saveArtifact(id, { name: '../../somewhere/image.png', contentType: 'image/png', stream: Readable.from([Buffer.from('ab'), Buffer.from('cd')]) });
  assert.equal(artifact.name, 'image.png');
  assert.equal(artifact.bytes, 4);
  const opened = await store.openArtifact(id, artifact.id);
  const chunks = [];
  for await (const chunk of opened.stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'abcd');
  assert.throws(() => store.artifactPath(id, '../outside'), { code: 'media_artifact_invalid' });
});

test('retention deletes only completed known output files and exposes expired links', async (t) => {
  const { store, config, time } = await setup(t, { retentionMs: 100 });
  const id = await running(store);
  const artifact = await store.saveArtifact(id, { data: Buffer.from('old') });
  await store.update(id, { state: 'completed' });
  const active = await running(store);
  const activeArtifact = await store.saveArtifact(active, { data: Buffer.from('active') });
  const unrelated = path.join(config.storage_path, id, 'user-upload.txt');
  fs.writeFileSync(unrelated, 'keep');
  time.now += 101;
  assert.deepEqual(await store.cleanup(), { deleted: 1, usedBytes: 6 });
  assert.equal(fs.existsSync(unrelated), true);
  assert.equal(fs.existsSync(store.artifactPath(active, activeArtifact.id)), true);
  await assert.rejects(store.openArtifact(id, artifact.id), { code: 'media_artifact_expired', status: 410 });
});

test('reconciliation imports each source artifact at most once across restarts', async (t) => {
  const { store, config } = await setup(t);
  const id = await running(store);
  const first = await store.saveArtifact(id, { data: Buffer.from('image'), key: 'safe-upstream-descriptor' });
  const restarted = new MediaStore(config);
  await restarted.init();
  const duplicate = await restarted.saveArtifact(id, { data: Buffer.from('image'), key: 'safe-upstream-descriptor' });
  assert.equal(duplicate.id, first.id);
  assert.equal(restarted.get(id).artifacts.length, 1);
  assert.equal(restarted.get(id).artifacts[0].sourceHash, undefined);
  assert.equal(restarted.usedBytes(), 5);
  assert.equal(fs.readFileSync(config.state_path, 'utf8').includes('safe-upstream-descriptor'), false);
});

test('disk quota removes oldest completed outputs, never active/failed output files', async (t) => {
  const { store, time } = await setup(t, { max_storage_bytes: 10 });
  const old = await running(store);
  const oldArtifact = await store.saveArtifact(old, { data: Buffer.from('123456') });
  await store.update(old, { state: 'completed' });
  time.now += 1;
  const next = await running(store);
  const nextArtifact = await store.saveArtifact(next, { data: Buffer.from('654321') });
  assert.equal(store.get(old).artifacts[0].status, 'expired');
  assert.equal(fs.existsSync(store.artifactPath(old, oldArtifact.id)), false);
  assert.equal(fs.existsSync(store.artifactPath(next, nextArtifact.id)), true);
  await store.update(next, { state: 'failed' });
  const another = await running(store);
  await assert.rejects(store.saveArtifact(another, { data: Buffer.from('12345') }), { code: 'media_storage_full' });
  assert.equal(fs.existsSync(store.artifactPath(next, nextArtifact.id)), true);
});

test('state/storage symlinks are rejected and cleanup never follows a linked artifact', async (t) => {
  const { store, config, directory, time } = await setup(t, { retentionMs: 1 });
  const external = path.join(directory, 'external.txt');
  fs.writeFileSync(external, 'do not delete');
  const id = await running(store);
  const artifact = await store.saveArtifact(id, { data: Buffer.from('old') });
  await store.update(id, { state: 'completed' });
  const filename = store.artifactPath(id, artifact.id);
  fs.unlinkSync(filename);
  fs.symlinkSync(external, filename);
  time.now += 2;
  await assert.rejects(store.openArtifact(id, artifact.id), { code: 'media_unsafe_storage_path' });
  await assert.rejects(store.cleanup(), { code: 'media_unsafe_storage_path' });
  assert.equal(fs.readFileSync(external, 'utf8'), 'do not delete');
  const stateLink = path.join(directory, 'state-link.json');
  fs.symlinkSync(config.state_path, stateLink);
  await assert.rejects(new MediaStore({ ...config, state_path: stateLink }).init(), { code: 'media_unsafe_storage_path' });
  const directoryLink = path.join(directory, 'directory-link');
  fs.symlinkSync(config.storage_path, directoryLink);
  await assert.rejects(new MediaStore({ ...config, storage_path: directoryLink }).init(), { code: 'media_unsafe_storage_path' });
});

test('malformed durable state fails closed without overwriting the evidence', async (t) => {
  const { config } = await setup(t);
  fs.writeFileSync(config.state_path, '{broken');
  await assert.rejects(new MediaStore(config).init(), { code: 'media_state_invalid' });
  assert.equal(fs.readFileSync(config.state_path, 'utf8'), '{broken');
});

test('update discards arbitrary response fields, clamps metadata and preserves routing', async (t) => {
  const { store } = await setup(t);
  const id = await running(store);
  const job = await store.update(id, { source: 'fake', backend: 'evil', reason: 'reason\nline', response: 'private', progress: 0.5 });
  assert.equal(job.source, 'media');
  assert.equal(job.backend, 'comfy-main');
  assert.equal(job.reason, 'reasonline');
  assert.equal(job.response, undefined);
  assert.equal(job.progress, 0.5);
  await assert.rejects(store.update(id, { progress: 2 }), { code: 'media_progress_invalid' });
});

test('history admission is bounded without silently shortening the idempotency retention window', async (t) => {
  const { store, time } = await setup(t, { retentionMs: 100 });
  const id = await running(store);
  await store.update(id, { state: 'completed' });
  const sample = store.getInternal(id);
  for (let index = 1; index < 1000; index += 1) {
    const id = randomUUID();
    store.jobs.set(id, { ...structuredClone(sample), id });
  }
  await store.persist();
  await assert.rejects(store.create(input()), { code: 'media_history_full' });
  time.now += 101;
  assert.equal((await store.create(input())).created, true);
  assert.equal(store.list().length, 1000);
});

test('aggregate private workflow bytes have a separate hard memory budget', async (t) => {
  const { store } = await setup(t);
  const { job } = await store.create(input());
  // Exercise accounting without allocating a 64 MiB fixture in each CI worker.
  store.jobs.get(job.id).workflowBytes = 64 * 1024 * 1024;
  await assert.rejects(store.create(input()), { code: 'media_workflow_memory_full' });
  assert.equal(store.queued()[0].workflow, undefined);
  await store.cancel(job.id);
  assert.equal(store.pendingWorkflowBytes(), 0);
  assert.equal((await store.create(input())).created, true);
});

test('only an explicitly undispatched preparation can return to the durable queue', async (t) => {
  const { store } = await setup(t);
  const { job } = await store.create(input());
  await store.update(job.id, { state: 'dispatching', upstreamPromptId: 'not-sent' });
  await assert.rejects(store.update(job.id, { state: 'queued' }), { code: 'media_invalid_transition' });
  await store.requeueUndispatched(job.id);
  assert.equal(store.get(job.id).state, 'queued');
  assert.equal(store.get(job.id).upstreamPromptId, undefined);
  await store.update(job.id, { state: 'dispatching' });
  await store.update(job.id, { state: 'uncertain' });
  await assert.rejects(store.requeueUndispatched(job.id), { code: 'media_invalid_transition' });
  await store.update(job.id, { state: 'running' }, { reconciled: true });
  await assert.rejects(store.requeueUndispatched(job.id), { code: 'media_invalid_transition' });
});

test('idempotent replay does not require another per-source admission slot', async (t) => {
  const { store } = await setup(t, { max_jobs: 1 });
  const value = input({ idempotencyKey: 'persisted-job' });
  const first = await store.create(value);
  let admissions = 0;
  const denied = () => { admissions += 1; throw Object.assign(new Error('full'), { code: 'source_queue_full' }); };
  assert.equal((await store.create(value, { admit: denied })).job.id, first.job.id);
  assert.equal(admissions, 0);
  await assert.rejects(store.create(input(), { admit: denied }), { code: 'source_queue_full' });
  assert.equal(admissions, 1);
});

test('private PNG workflow metadata is bounded, credential keys rejected, and idempotency covers the graph', async (t) => {
  const { store, config } = await setup(t);
  const extraData = { extra_pnginfo: { workflow: { nodes: [{ private_graph: 'do not expose in public status' }] } } };
  const request = input({ extraData, idempotencyKey: 'graph' });
  const { job } = await store.create(request);
  assert.deepEqual(store.getInternal(job.id).extraData, extraData);
  assert.equal(store.get(job.id).extraData, undefined);
  assert.equal(JSON.stringify(store.list()).includes('private_graph'), false);
  assert.equal((await store.create(request)).created, false);
  await assert.rejects(store.create({ ...request, extraData: {} }), { code: 'media_idempotency_conflict' });
  await assert.rejects(store.create(input({ extraData: { api_key: 'credential' } })), { code: 'media_metadata_invalid' });
  await assert.rejects(store.create(input({ extraData: { extra_pnginfo: 'invalid' } })), { code: 'media_metadata_invalid' });
  await assert.rejects(store.create(input({ extraData: { extra_pnginfo: { text: 'x'.repeat(1024 * 1024) } } })), { code: 'media_metadata_too_large' });
  const restarted = new MediaStore(config);
  await restarted.init();
  assert.deepEqual(restarted.getInternal(job.id).extraData, extraData);
  await restarted.cancel(job.id);
  assert.equal(restarted.getInternal(job.id).extraData, undefined);
});
