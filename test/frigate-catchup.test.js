import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FrigateCatchup, frigateEligibility, hasFrigateDescription } from '../src/frigate-catchup.js';
import { FrigateError } from '../src/frigate-client.js';
import { contextRequest } from '../src/context-rescue.js';

function cameraConfig() {
  return {
    genai: { local: { provider: 'ollama', roles: ['descriptions'] } },
    cameras: { yard: {
      enabled: true,
      objects: { genai: { enabled: true, objects: ['person', 'car'], required_zones: ['driveway'], use_snapshot: true } },
      review: {
        genai: { enabled: true, alerts: true, detections: true },
        alerts: { enabled: true, labels: ['person', 'car'], required_zones: ['driveway'] },
        detections: { enabled: true, labels: null, required_zones: [] },
      },
    } },
  };
}

const object = (id, start = 100, overrides = {}) => ({
  id, camera: 'yard', start_time: start, end_time: start + 1, label: 'person',
  zones: ['driveway'], has_snapshot: true, data: {}, ...overrides,
});
const review = (id, start = 100, overrides = {}) => ({
  id, camera: 'yard', start_time: start, end_time: start + 1, severity: 'alert',
  data: { objects: ['person'], zones: ['driveway'] }, ...overrides,
});

class FakeFrigate {
  constructor() {
    this.config = cameraConfig();
    this.rows = { object: [], review: [] };
    this.support = { object: true, review: true };
    this.calls = [];
    this.listCalls = [];
    this.media = true;
  }
  async capabilities() { return this.support; }
  async getConfig() { return this.config; }
  async list(kind, query) {
    this.listCalls.push({ kind, ...structuredClone(query) });
    return this.rows[kind].filter((row) => row.start_time > query.after && row.start_time < query.before)
      .sort((a, b) => b.start_time - a.start_time).slice(0, query.limit);
  }
  async get(kind, id) {
    if (this.getError) throw this.getError;
    const row = this.rows[kind].find((item) => item.id === id);
    if (!row) throw new FrigateError('http_404', 404);
    return row;
  }
  async hasMedia() { return this.media; }
  async regenerate(kind, id, source, ticket) {
    this.calls.push({ kind, id, source, ...(ticket ? { ticket } : {}) });
    if (this.regenerateError) throw this.regenerateError;
    return { accepted: true };
  }
  close() {}
}

function setup(t, overlay = {}, existing = {}) {
  const directory = existing.directory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'frigate-backlog-test-'));
  if (!existing.directory) t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const clock = existing.clock ?? { now: 500_000 };
  const client = existing.client ?? new FakeFrigate();
  const gate = existing.gate ?? { ready: true };
  const settings = {
    enabled: true, url: 'http://frigate.test:5000', state_path: path.join(directory, 'state.json'),
    pollIntervalMs: 100, confirmationIntervalMs: 100, liveGraceMs: 1_000, requestTimeoutMs: 100, generationTimeoutMs: 5_000,
    retryIntervalMs: 1_000, maxRetryIntervalMs: 60_000, page_size: 100, max_jobs: 100, ...overlay,
  };
  const worker = new FrigateCatchup(settings, { client, clock: () => clock.now, canRun: () => gate.ready });
  worker.start();
  const clearTimers = () => {
    for (const name of ['timer', 'confirmationTimer', 'cleanupTimer']) {
      clearTimeout(worker[name]); worker[name] = null;
    }
  };
  clearTimers();
  t.after(() => worker.stop());
  const manual = () => { worker.scanMissing(); clearTimers(); };
  return { worker, client, gate, clock, settings, directory, manual, clearTimers };
}

test('changing the Frigate origin preserves old backlog and reports a specific host-change diagnostic', async (t) => {
  const first = setup(t);
  await first.worker.stop();
  const original = fs.readFileSync(first.settings.state_path, 'utf8');
  const second = setup(t, { url: 'http://another-frigate.test:5000' }, { directory: first.directory });
  await second.worker.tick();
  assert.equal(second.worker.status().last_error, 'backlog_origin_changed');
  assert.equal(second.client.calls.length, 0);
  assert.equal(fs.readFileSync(first.settings.state_path, 'utf8'), original);
});

test('manual capability refresh detects a new bridge immediately without changing outstanding work or scans', async (t) => {
  const context = setup(t);
  context.client.rows.review = [review('outstanding-review')];
  context.manual();
  await context.worker.tick();
  context.clearTimers();
  assert.equal(context.worker.status().bridge_mode, 'conservative');
  assert.equal(context.client.calls.length, 1);
  const before = structuredClone(context.worker.state);
  const savedBefore = fs.readFileSync(context.settings.state_path, 'utf8');
  const listCalls = context.client.listCalls.length;
  context.gate.ready = false;
  context.client.support = { object: true, review: true, bridge: true };
  context.clock.now += 1;
  const result = await context.worker.refreshCapabilities();
  assert.equal(result.bridge_mode, 'correlated');
  assert.equal(result.capability_checked_at, new Date(context.clock.now).toISOString());
  assert.deepEqual(context.worker.state, before);
  assert.equal(fs.readFileSync(context.settings.state_path, 'utf8'), savedBefore);
  assert.equal(context.client.calls.length, 1);
  assert.equal(context.client.listCalls.length, listCalls);
  assert.equal(context.gate.ready, false);
  await assert.rejects(context.worker.refreshCapabilities(), (error) => error.code === 'capability_refresh_cooldown' && error.statusCode === 429);
  context.clock.now += 5000;
  assert.equal((await context.worker.refreshCapabilities()).capabilities.bridge, true);
});

test('manual and automatic capability probes coalesce without overlapping API reads', async (t) => {
  const context = setup(t);
  let calls = 0;
  let finish;
  context.client.capabilities = async () => { calls++; await new Promise((resolve) => { finish = resolve; }); return { object: true, review: true, bridge: true }; };
  const automatic = context.worker.probeCapabilities();
  const manual = context.worker.refreshCapabilities();
  assert.equal(calls, 1);
  finish();
  await Promise.all([automatic, manual]);
  assert.equal(context.worker.status().bridge_mode, 'correlated');
  assert.equal(calls, 1);
});

test('failed manual capability probe leaves queue and last verified capabilities intact', async (t) => {
  const context = setup(t);
  await context.worker.probeCapabilities();
  const before = structuredClone(context.worker.state);
  const checkedAt = context.worker.status().capability_checked_at;
  context.client.capabilities = async () => { throw new FrigateError('connection_failed', 503); };
  context.clock.now += 50;
  await assert.rejects(context.worker.refreshCapabilities(), (error) => error.code === 'connection_failed');
  assert.equal(context.worker.status().capability_checked_at, checkedAt);
  assert.deepEqual(context.worker.state, before);
  assert.equal(context.client.calls.length, 0);
});

test('backlog pagination exposes every saved job in bounded newest-first metadata pages', (t) => {
  const { worker } = setup(t);
  worker.state.jobs = Array.from({ length: 258 }, (_, i) => ({
    id: `event-${i}`, kind: i % 2 ? 'object' : 'review', camera: 'yard', event_time: i,
    state: 'pending', attempts: 0, next_attempt_at: 0, prompt: 'PRIVATE', image: 'PRIVATE',
  }));
  const ids = [];
  for (let offset = 0; offset < 258; offset += 30) {
    const page = worker.jobs({ offset, limit: 30 });
    assert.equal(page.total, 258);
    assert.ok(page.items.length <= 30);
    assert.doesNotMatch(JSON.stringify(page), /PRIVATE|prompt|image/);
    ids.push(...page.items.map((item) => item.id));
  }
  assert.equal(new Set(ids).size, 258);
  assert.equal(ids[0], 'event-257');
  assert.equal(ids.at(-1), 'event-0');
  assert.equal(worker.jobs({ offset: 999, limit: 30 }).offset, 240);
  assert.throws(() => worker.jobs({ limit: 101 }), /Invalid backlog page/);
  assert.throws(() => worker.jobs({ offset: -1 }), /Invalid backlog page/);
  assert.equal(worker.status().pending_jobs.length, 30);
});

test('Frigate eligibility respects effective per-camera filters and runtime toggles', () => {
  const config = cameraConfig();
  assert.equal(frigateEligibility('object', object('o'), config).source, 'snapshot');
  assert.equal(frigateEligibility('object', object('o', 1, { label: 'dog' }), config).reason, 'label_filtered');
  assert.equal(frigateEligibility('object', object('o', 1, { zones: [] }), config).reason, 'zone_filtered');
  config.cameras.yard.objects.genai.enabled = false;
  assert.equal(frigateEligibility('object', object('o'), config).eligible, false);
  assert.equal(frigateEligibility('review', review('r'), config).eligible, true);
  config.cameras.yard.review.genai.alerts = false;
  assert.equal(frigateEligibility('review', review('r'), config).eligible, false);
  assert.equal(frigateEligibility('review', review('r', 1, { severity: 'detection' }), config).eligible, true);
  config.cameras.yard.enabled = false;
  assert.equal(frigateEligibility('review', review('r'), config).eligible, false);
});

test('existing or partial descriptions are never overwritten', () => {
  assert.equal(hasFrigateDescription('object', { data: { description: 'hello' } }), true);
  assert.equal(hasFrigateDescription('object', { data: { description: ' ' } }), false);
  assert.equal(hasFrigateDescription('review', { data: { metadata: { title: 'hello' } } }), true);
  assert.equal(hasFrigateDescription('review', { data: { metadata: {} } }), false);
});

test('unknown early-trigger eligibility fails closed rather than inventing a live trigger', () => {
  const config = cameraConfig();
  config.cameras.yard.objects.genai.send_triggers = { tracked_object_end: false, after_significant_updates: 5 };
  assert.equal(frigateEligibility('object', object('o'), config).reason, 'early_trigger_only_not_recoverable');
});

test('automatic recovery starts at first enable and remembers its boundary across restart', async (t) => {
  const first = setup(t);
  first.client.rows.object = [object('before', 499), object('after', 501)];
  first.clock.now = 510_000;
  await first.worker.tick();
  assert.deepEqual(first.client.calls.map((call) => call.id), ['after']);
  await first.worker.stop();
  const second = setup(t, {}, first);
  assert.equal(second.worker.status().enabled_at, 500_000);
  assert.equal(second.worker.status().active_job.id, 'after');
  await second.worker.tick();
  assert.equal(first.client.calls.length, 1, 'restart reconciles existing handoff instead of repeating it');
});

test('manual scan includes retained old objects and reviews, newest timestamp first', async (t) => {
  const context = setup(t);
  context.client.rows.object = [object('old', 100), object('middle', 200)];
  context.client.rows.review = [review('new', 300)];
  context.manual();
  await context.worker.tick();
  assert.deepEqual(context.client.calls, [{ kind: 'review', id: 'new', source: 'recordings' }]);
  assert.equal(context.worker.status().counts.waiting_result, 1);
  assert.equal(context.worker.status().totals.completed, 0, 'accepted is not complete');
  context.client.rows.review[0].data.metadata = { title: 'done' };
  await context.worker.tick();
  assert.equal(context.worker.status().totals.completed, 1);
  await context.worker.tick();
  assert.equal(context.client.calls[1].id, 'middle');
});

test('live foreground readiness blocks handoff while allowing scan discovery', async (t) => {
  const context = setup(t);
  context.gate.ready = false;
  context.client.rows.object = [object('old')];
  context.manual();
  await context.worker.tick();
  assert.equal(context.worker.status().total_queued, 1);
  assert.equal(context.client.calls.length, 0);
  context.gate.ready = true;
  await context.worker.tick();
  assert.equal(context.client.calls.length, 1);
});

test('readiness is checked again after media validation before handoff', async (t) => {
  const context = setup(t);
  context.client.rows.object = [object('old')];
  context.client.hasMedia = async () => { context.gate.ready = false; return true; };
  context.manual();
  await context.worker.tick();
  assert.equal(context.client.calls.length, 0);
});

test('live generation gets a grace period and an in-progress object is revisited after scan watermark', async (t) => {
  const context = setup(t);
  context.client.rows.object = [object('long', 501, { end_time: null })];
  context.clock.now = 503_000;
  await context.worker.tick();
  assert.equal(context.worker.status().counts.waiting_live, 1);
  context.client.rows.object[0].end_time = 505;
  context.clock.now = 505_500;
  await context.worker.tick();
  assert.equal(context.client.calls.length, 0);
  context.clock.now = 507_000;
  await context.worker.tick();
  assert.equal(context.client.calls.length, 1);
});

test('normal Frigate completion during grace prevents unnecessary regeneration', async (t) => {
  const context = setup(t);
  context.client.rows.object = [object('fresh', 501)];
  context.clock.now = 502_500;
  await context.worker.tick();
  context.client.rows.object[0].data.description = 'a live description';
  context.clock.now = 504_000;
  await context.worker.tick();
  assert.equal(context.client.calls.length, 0);
  assert.equal(context.worker.status().totals.completed, 1);
});

test('deleted media and deleted event are terminal skips, not endless retries', async (t) => {
  const context = setup(t);
  context.client.rows.object = [object('missing-media')];
  context.client.media = false;
  context.manual();
  await context.worker.tick();
  assert.equal(context.worker.status().recent_jobs[0].reason, 'media_expired_or_missing');
  assert.equal(context.worker.status().total_queued, 0);
  context.client.rows.object = [object('deleted', 501)];
  context.clock.now = 505_000;
  context.gate.ready = false;
  await context.worker.tick();
  context.client.rows.object = [];
  context.gate.ready = true;
  await context.worker.tick();
  assert.equal(context.worker.status().recent_jobs[0].reason, 'event_deleted');
});

test('timeout handoff is uncertain, reconciled and delayed instead of immediately duplicated', async (t) => {
  const context = setup(t);
  context.client.rows.object = [object('slow')];
  context.client.regenerateError = new FrigateError('request_timeout');
  context.manual();
  await context.worker.tick();
  assert.equal(context.worker.status().active_job.reason, 'handoff_uncertain');
  context.clock.now += 4_000;
  await context.worker.tick();
  assert.equal(context.client.calls.length, 1);
  context.clock.now += 2_000;
  context.gate.ready = false;
  await context.worker.tick();
  assert.equal(context.worker.status().counts.waiting_result, 1);
  context.gate.ready = true;
  await context.worker.tick();
  assert.equal(context.worker.status().counts.retrying, 1);
  assert.equal(context.client.calls.length, 1);
  context.clock.now += 1_500;
  await context.worker.tick();
  assert.equal(context.client.calls.length, 2);
});

test('missing capabilities do not probe mutation APIs or enqueue unsupported review requests', async (t) => {
  const context = setup(t);
  context.client.support.review = false;
  context.client.rows.review = [review('review')];
  context.manual();
  await context.worker.tick();
  assert.equal(context.worker.status().capabilities.review, false);
  assert.equal(context.client.calls.length, 0);
  assert.equal(context.worker.status().scan.manual, true, 'unsupported manual work stays discoverable after upgrade');
});

test('full queue retains scan cursor, drains, and resumes all rows without losses', async (t) => {
  const context = setup(t, { max_jobs: 1, page_size: 2 });
  context.client.rows.object = [object('one', 300), object('two', 200), object('three', 100)];
  context.manual();
  context.client.media = false;
  for (let index = 0; index < 8; index += 1) await context.worker.tick();
  assert.equal(context.worker.status().totals.skipped, 3);
  assert.equal(context.worker.status().scan.manual, false);
  assert.equal(context.worker.status().total_queued, 0);
});

test('equal timestamps expand page boundary instead of dropping events', async (t) => {
  const context = setup(t, { page_size: 2 });
  context.client.rows.object = [object('a'), object('b'), object('c'), object('d', 99)];
  context.client.media = false;
  context.manual();
  for (let index = 0; index < 8; index += 1) await context.worker.tick();
  assert.equal(context.worker.status().totals.skipped, 4);
  assert.equal(context.worker.status().scan.manual, false);
  assert.ok(context.client.listCalls.some((call) => call.limit > 2));
});

test('interrupted manual scan persists exact progress across restart', async (t) => {
  const context = setup(t, { page_size: 2 });
  context.gate.ready = false;
  context.client.rows.object = [object('a', 300), object('b', 200), object('c', 100)];
  context.manual();
  await context.worker.tick();
  const before = context.worker.state.scans.manual.object.before;
  await context.worker.stop();
  const resumed = setup(t, { page_size: 2 }, context);
  assert.equal(resumed.worker.state.scans.manual.object.before, before);
  await resumed.worker.tick();
  assert.equal(resumed.worker.status().total_queued, 3);
});

test('persisted jobs and public status do not contain prompts, snapshots or description content', async (t) => {
  const context = setup(t);
  context.client.rows.object = [object('o', 100, { thumbnail: 'PRIVATE_BASE64_IMAGE', data: { private: 'PRIVATE_PROMPT' } })];
  context.manual();
  await context.worker.tick();
  const persisted = fs.readFileSync(context.settings.state_path, 'utf8');
  assert.doesNotMatch(persisted, /PRIVATE_BASE64_IMAGE|PRIVATE_PROMPT|auth_token|password/);
  assert.doesNotMatch(JSON.stringify(context.worker.status()), /PRIVATE_BASE64_IMAGE|PRIVATE_PROMPT|auth_token|password/);
  assert.equal(fs.statSync(context.settings.state_path).mode & 0o777, 0o600);
});

test('corrupt persistence fails closed without overwriting the unreadable file', async (t) => {
  const context = setup(t);
  await context.worker.stop();
  fs.writeFileSync(context.settings.state_path, 'not valid json');
  const resumed = setup(t, {}, context);
  assert.equal(resumed.worker.status().state, 'error');
  assert.equal(resumed.worker.status().last_error, 'backlog_state_unreadable');
  assert.equal(fs.readFileSync(context.settings.state_path, 'utf8'), 'not valid json');
  assert.throws(() => resumed.worker.scanMissing());
});

test('authentication failure during status reconciliation does not release native handoff', async (t) => {
  const context = setup(t);
  context.client.rows.object = [object('o')];
  context.manual();
  await context.worker.tick();
  context.client.getError = new FrigateError('authentication_failed', 401);
  context.clock.now += 60_000;
  await context.worker.tick();
  assert.equal(context.worker.status().counts.waiting_result, 1);
  assert.equal(context.worker.status().last_error, 'authentication_failed');
  assert.equal(context.client.calls.length, 1);
});

test('scan frontiers defer old jobs until newer unseen review pages are discovered', async (t) => {
  const context = setup(t, { page_size: 2 });
  context.client.rows.object = [object('old-object', 50)];
  context.client.rows.review = [
    review('already-a', 300, { data: { metadata: { title: 'done' } } }),
    review('already-b', 250, { data: { metadata: { title: 'done' } } }),
    review('missing-newer', 200),
  ];
  context.manual();
  await context.worker.tick();
  assert.equal(context.client.calls.length, 0);
  assert.equal(context.worker.status().scan.blocked_reason, 'discovering_newer_events');
  for (let index = 0; index < 5 && !context.client.calls.length; index += 1) await context.worker.tick();
  assert.equal(context.client.calls[0].id, 'missing-newer');
});

test('oldest-first waits for discovery frontier then selects oldest eligible event', async (t) => {
  const context = setup(t, { page_size: 2, catchup_order: 'oldest_first' });
  context.client.rows.object = [object('new', 400), object('middle', 300), object('old', 50)];
  context.manual();
  await context.worker.tick();
  assert.equal(context.client.calls.length, 0);
  assert.equal(context.worker.status().scan.blocked_reason, 'discovering_older_events');
  for (let index = 0; index < 8 && !context.client.calls.length; index++) await context.worker.tick();
  assert.equal(context.client.calls[0].id, 'old');
});

test('unsupported eligibility is visible as bounded exclusion counts and camera warnings', async (t) => {
  const context = setup(t);
  context.client.config.cameras.yard.objects.genai.send_triggers = { tracked_object_end: false };
  context.client.rows.object = [object('early-only')];
  context.manual();
  await context.worker.tick();
  assert.equal(context.worker.status().eligibility_skipped.early_trigger_only_not_recoverable, 1);
  assert.deepEqual(context.worker.status().warnings, [{ camera: 'yard', code: 'early_trigger_only_not_recoverable' }]);
  assert.equal(context.client.calls.length, 0);
});

test('retry backoff also grows for metadata failures before native dispatch', async (t) => {
  const context = setup(t);
  context.client.rows.object = [object('o')];
  context.client.getError = new FrigateError('request_timeout');
  context.manual();
  await context.worker.tick();
  assert.equal(context.worker.state.jobs[0].next_attempt_at - context.clock.now, 1_000);
  context.clock.now += 1_000;
  await context.worker.tick();
  assert.equal(context.worker.state.jobs[0].next_attempt_at - context.clock.now, 2_000);
  assert.equal(context.client.calls.length, 0);
});

test('restore whitelists metadata and does not expose unknown saved reason or extra fields', async (t) => {
  const context = setup(t);
  context.client.rows.object = [object('o')];
  context.manual();
  context.gate.ready = false;
  await context.worker.tick();
  await context.worker.stop();
  const state = JSON.parse(fs.readFileSync(context.settings.state_path, 'utf8'));
  state.jobs[0].reason = 'PRIVATE_TOKEN';
  state.jobs[0].password = 'PRIVATE_PASSWORD';
  state.totals.completed = -99;
  state.totals.secret = 'PRIVATE_SECRET';
  fs.writeFileSync(context.settings.state_path, JSON.stringify(state));
  const resumed = setup(t, {}, context);
  assert.doesNotMatch(JSON.stringify(resumed.worker.status()), /PRIVATE/);
  assert.equal(resumed.worker.status().totals.completed, 0);
  assert.equal(resumed.worker.status().queue_items[0].reason, 'frigate_operation_failed');
  resumed.worker.persist();
  assert.doesNotMatch(fs.readFileSync(context.settings.state_path, 'utf8'), /PRIVATE/);
});

test('ongoing objects entering required zones after discovery are retained and recovered', async (t) => {
  const context = setup(t);
  context.client.rows.object = [object('moving', 501, { end_time: null, zones: [] })];
  context.clock.now = 503_000;
  await context.worker.tick();
  assert.equal(context.worker.status().counts.waiting_live, 1);
  context.clock.now = 800_000;
  context.client.rows.object[0].end_time = 790;
  context.client.rows.object[0].zones = ['driveway'];
  await context.worker.tick();
  assert.equal(context.client.calls[0].id, 'moving');
});

test('ongoing review escalating to eligible alert is not lost behind discovery watermark', async (t) => {
  const context = setup(t);
  context.client.config.cameras.yard.review.genai.detections = false;
  context.client.rows.review = [review('escalating', 501, { severity: 'detection', end_time: null })];
  context.clock.now = 503_000;
  await context.worker.tick();
  assert.equal(context.worker.status().counts.waiting_live, 1);
  context.clock.now = 800_000;
  context.client.rows.review[0].end_time = 790;
  context.client.rows.review[0].severity = 'alert';
  await context.worker.tick();
  assert.equal(context.client.calls[0].id, 'escalating');
});

test('discovery overlap includes a recently delayed database row without scanning before enable', async (t) => {
  const context = setup(t);
  context.clock.now = 510_000;
  await context.worker.tick();
  context.client.rows.object = [object('late', 509.5), object('old', 499)];
  context.clock.now = 513_000;
  await context.worker.tick();
  assert.deepEqual(context.client.calls.map((call) => call.id), ['late']);
});

test('live completion during media preflight is rechecked immediately before PUT', async (t) => {
  const context = setup(t);
  context.client.rows.object = [object('o')];
  context.client.hasMedia = async () => {
    context.client.rows.object[0].data.description = 'live completion';
    return true;
  };
  context.manual();
  await context.worker.tick();
  assert.equal(context.client.calls.length, 0);
  assert.equal(context.worker.status().recent_jobs[0].reason, 'completed_by_frigate');
});

function readyJob(context, id, start = 100, extra = {}) {
  context.worker.capabilities = { object: true, review: true, checked: true };
  context.worker.runtimeConfig = context.client.config;
  const job = { kind: 'object', id, camera: 'yard', event_time: start, state: 'pending',
    attempts: 0, failures: 0, created_at: context.clock.now, next_attempt_at: context.clock.now,
    first_failed_at: null, last_attempt_at: null, reason: null, ...extra };
  context.worker.state.jobs.push(job);
  context.client.rows.object.push(object(id, start));
  return job;
}

test('fast confirmation immediately hands off the next eligible job without discovery polling', async (t) => {
  const context = setup(t, { pollIntervalMs: 30_000, confirmationIntervalMs: 2_000 });
  readyJob(context, 'first', 200);
  readyJob(context, 'second', 100);
  await context.worker.processJobs();
  assert.deepEqual(context.client.calls.map((call) => call.id), ['first']);
  context.client.rows.object[0].data.description = 'saved';
  context.clock.now += 2_000;
  await context.worker.processJobs();
  assert.deepEqual(context.client.calls.map((call) => call.id), ['first', 'second']);
  assert.equal(context.worker.status().totals.completed, 1);
  assert.equal(context.client.listCalls.length, 0);
});

test('foreground arriving during confirmation blocks the next handoff, not completion verification', async (t) => {
  const context = setup(t);
  readyJob(context, 'first', 200);
  readyJob(context, 'second', 100);
  await context.worker.processJobs();
  context.client.rows.object[0].data.description = 'saved';
  context.gate.ready = false;
  await context.worker.processJobs();
  assert.equal(context.worker.status().totals.completed, 1);
  assert.equal(context.client.calls.length, 1);
  context.gate.ready = true;
  await context.worker.processJobs();
  assert.equal(context.client.calls.length, 2);
});

test('unchanged fast confirmation does not fsync the whole backlog', async (t) => {
  const context = setup(t);
  readyJob(context, 'first');
  await context.worker.processJobs();
  let writes = 0;
  const persist = context.worker.persist.bind(context.worker);
  context.worker.persist = () => { writes += 1; return persist(); };
  for (let i = 0; i < 10; i += 1) await context.worker.processJobs();
  assert.equal(writes, 0);
  assert.equal(context.client.calls.length, 1);
});

test('unavailable confirmation backs off without releasing or duplicating native work', async (t) => {
  const context = setup(t, { confirmationIntervalMs: 2_000 });
  readyJob(context, 'first');
  await context.worker.processJobs();
  context.client.getError = new FrigateError('request_timeout');
  for (let i = 0; i < 5; i += 1) {
    await context.worker.processJobs();
    if (i < 4) context.clock.now = context.worker.confirmationBackoffUntil;
  }
  context.worker.scheduleConfirmation();
  assert.equal(context.worker.nextConfirmationAt - context.clock.now, 60_000);
  clearTimeout(context.worker.confirmationTimer);
  assert.equal(context.worker.status().counts.waiting_result, 1);
  assert.equal(context.client.calls.length, 1);
});

test('blocked discovery does not block active-description confirmation', async (t) => {
  const context = setup(t);
  readyJob(context, 'first');
  await context.worker.processJobs();
  let release;
  const list = context.client.list.bind(context.client);
  const entered = new Promise((resolve) => {
    context.client.list = async (...args) => { resolve(); await new Promise((done) => { release = done; }); return list(...args); };
  });
  const background = context.worker.tick();
  await entered;
  context.client.rows.object[0].data.description = 'saved';
  await context.worker.processJobs();
  assert.equal(context.worker.status().totals.completed, 1);
  context.client.list = list;
  release();
  await background;
});

test('slow cleanup does not block confirmation and guards action races on its job', async (t) => {
  const context = setup(t);
  readyJob(context, 'active', 300);
  const cleaning = readyJob(context, 'cleaning', 200, { state: 'retrying', next_attempt_at: context.clock.now + 10_000 });
  await context.worker.processJobs();
  let release;
  const entered = new Promise((resolve) => {
    context.client.hasMedia = async () => { resolve(); return new Promise((done) => { release = done; }); };
  });
  const cleanup = context.worker.cleanupJobs();
  await entered;
  assert.throws(() => context.worker.retryJob('object', cleaning.id), (error) => error.code === 'operation_in_progress');
  context.client.rows.object[0].data.description = 'saved';
  await context.worker.processJobs();
  assert.equal(context.worker.status().totals.completed, 1);
  release(false);
  await cleanup;
  assert.equal(context.worker.status().totals.skipped, 1);
  assert.equal(context.client.calls.length, 1);
});

test('cleanup checks bounded batches while GPU is busy, skips missing media, and remembers progress', async (t) => {
  const context = setup(t, { cleanup_batch_size: 2 });
  context.gate.ready = false;
  for (const id of ['a', 'b', 'c', 'd', 'e']) readyJob(context, id);
  context.client.media = false;
  await context.worker.cleanupJobs();
  assert.equal(context.worker.status().totals.skipped, 2);
  await context.worker.cleanupJobs();
  assert.equal(context.worker.status().totals.skipped, 4);
  await context.worker.cleanupJobs();
  assert.equal(context.worker.status().totals.skipped, 5);
  assert.equal(context.client.calls.length, 0);
});

test('cleanup ignores unfinished live media and never mistakes transient failures for missing files', async (t) => {
  const context = setup(t);
  const job = readyJob(context, 'a');
  context.gate.ready = false;
  context.client.rows.object[0].end_time = null;
  context.client.media = false;
  await context.worker.cleanupJobs();
  assert.equal(context.worker.status().total_queued, 1);
  context.client.rows.object[0].end_time = 101;
  for (const error of [new FrigateError('authentication_failed', 401), new FrigateError('http_503', 503),
    new FrigateError('connection_failed'), new FrigateError('invalid_media_response')]) {
    context.client.getError = error;
    await context.worker.cleanupJobs();
    assert.equal(context.worker.status().total_queued, 1);
    assert.equal(job.first_failed_at, null);
    assert.equal(job.failures, 0);
    assert.equal(context.worker.status().cleanup.last_error, error.code);
  }
  assert.equal(context.worker.status().totals.skipped, 0);
});

test('retry delays cap at five hours and attention starts at first failure, never initial queue time', async (t) => {
  const context = setup(t, { maxRetryIntervalMs: undefined, retryIntervalMs: 60_000, attentionAfterMs: 86_400_000 });
  const job = readyJob(context, 'old');
  context.clock.now += 2 * 86_400_000;
  assert.equal(context.worker.jobs({ view: 'attention' }).total, 0);
  const failedAt = context.clock.now;
  for (let attempt = 0; attempt < 20; attempt += 1) context.worker.retry(job, 'description_not_confirmed');
  assert.equal(job.next_attempt_at - context.clock.now, 18_000_000);
  assert.equal(job.first_failed_at, failedAt);
  context.clock.now += 86_400_000 - 1;
  assert.equal(context.worker.jobs({ view: 'attention' }).total, 0);
  context.clock.now += 1;
  assert.equal(context.worker.jobs({ view: 'attention' }).items[0].needs_attention, true);
  assert.equal(context.worker.status().attention_count, 1);
  await context.worker.processJobs();
  assert.equal(context.client.calls.length, 1, 'attention does not suspend automatic retries');
});

test('legacy failed jobs retain their queue but get no invented historical first-failure time', async (t) => {
  const context = setup(t);
  const job = readyJob(context, 'legacy', 100, { state: 'retrying', failures: 20 });
  delete job.first_failed_at;
  delete job.last_attempt_at;
  context.worker.persist();
  await context.worker.stop();
  context.clock.now += 3 * 86_400_000;
  const resumed = setup(t, {}, context);
  assert.equal(resumed.worker.status().attention_count, 0);
  assert.equal(resumed.worker.state.jobs[0].first_failed_at, null);
  resumed.worker.retry(resumed.worker.state.jobs[0], 'request_timeout');
  assert.equal(resumed.worker.state.jobs[0].first_failed_at, context.clock.now);
});

test('separate filtered views paginate all matches and history uses completion time, not event age', (t) => {
  const context = setup(t);
  for (let i = 0; i < 101; i += 1) readyJob(context, `event-${i}`, i, {
    state: i % 2 ? 'retrying' : 'pending', first_failed_at: i % 2 ? context.clock.now - 86_400_000 : null,
  });
  const page = context.worker.jobs({ view: 'retrying', offset: 30, limit: 30 });
  assert.equal(page.total, 50);
  assert.equal(page.items.length, 20);
  assert.ok(page.items.every((job) => job.state === 'retrying'));
  assert.equal(context.worker.jobs({ view: 'attention' }).total, 50);
  assert.equal(context.worker.jobs({ view: 'waiting' }).total, 51);
  context.worker.finish(context.worker.state.jobs[100], 'completed', 'description_confirmed');
  context.clock.now += 1_000;
  context.worker.finish(context.worker.state.jobs[0], 'completed', 'description_confirmed');
  assert.equal(context.worker.jobs({ view: 'completed' }).items[0].id, 'event-0');
  assert.throws(() => context.worker.jobs({ view: 'unknown' }), RangeError);
});

test('default history retains latest 1000 rows but lifetime totals survive rollover', (t) => {
  const context = setup(t);
  context.worker.persist = () => true;
  for (let i = 0; i < 1_005; i += 1) {
    const job = readyJob(context, `event-${i}`, i);
    context.clock.now += 1;
    context.worker.finish(job, i % 2 ? 'completed' : 'skipped', i % 2 ? 'description_confirmed' : 'media_expired_or_missing');
  }
  assert.equal(context.worker.state.recent.length, 1_000);
  assert.equal(context.worker.state.recent[0].id, 'event-5');
  assert.equal(context.worker.status().history_limit, 1_000);
  assert.equal(context.worker.status().totals.completed + context.worker.status().totals.skipped, 1_005);
  assert.equal(context.worker.status().views.completed + context.worker.status().views.skipped, 1_000);
});

test('missing-media suppression outlives history, persists privately, and expires for later revalidation', async (t) => {
  const context = setup(t, { history_limit: 1 });
  const expired = readyJob(context, 'expired');
  context.worker.finish(expired, 'skipped', 'media_expired_or_missing');
  const other = readyJob(context, 'other');
  context.worker.finish(other, 'completed', 'description_confirmed');
  assert.equal(context.worker.state.recent.length, 1);
  context.manual();
  context.gate.ready = false;
  await context.worker.tick();
  assert.equal(context.worker.status().total_queued, 0);
  await context.worker.stop();
  const resumed = setup(t, { history_limit: 1 }, context);
  assert.equal(resumed.worker.state.suppressed[0].id, 'expired');
  resumed.clock.now += 30 * 86_400_000 + 1;
  resumed.manual();
  await resumed.worker.tick();
  assert.ok(resumed.worker.state.jobs.some((job) => job.id === 'expired'));
  assert.equal(resumed.worker.status().suppression_count, 0);
});

test('retry/recheck controls schedule safe work, preserve ambiguity grace, and bound capacity', async (t) => {
  const context = setup(t, { max_jobs: 2 });
  const job = readyJob(context, 'retry', 200, { state: 'retrying', reason: 'description_not_confirmed',
    next_attempt_at: context.clock.now + 60_000 });
  context.worker.retryJob(job.kind, job.id);
  assert.equal(job.next_attempt_at, context.clock.now + 60_000);
  job.reason = 'http_400';
  context.worker.retryJob(job.kind, job.id);
  assert.equal(job.next_attempt_at, context.clock.now);
  assert.equal(context.client.calls.length, 0, 'action itself never hands off');
  const missing = readyJob(context, 'missing');
  context.worker.finish(missing, 'skipped', 'media_expired_or_missing');
  context.worker.recheckJob(missing.kind, missing.id);
  assert.equal(context.worker.status().total_queued, 2);
  assert.equal(context.worker.state.suppressed.length, 0);
  assert.throws(() => context.worker.recheckJob(missing.kind, missing.id), (error) => error.code === 'job_not_recheckable');
  const extra = { ...missing, id: 'extra', state: 'skipped', completed_at: context.clock.now };
  context.worker.state.recent.push(extra);
  assert.throws(() => context.worker.recheckJob('object', 'extra'), (error) => error.code === 'backlog_capacity_reached');
  context.gate.ready = false;
  await context.worker.processJobs();
  assert.equal(context.client.calls.length, 0);
});

test('single-flight dispatch is durable before handoff and prevents concurrent actions or cleanup duplicates', async (t) => {
  const context = setup(t);
  readyJob(context, 'first', 200);
  readyJob(context, 'second', 100);
  let release;
  const entered = new Promise((resolve) => {
    context.client.regenerate = async (kind, id) => {
      context.client.calls.push({ kind, id });
      const saved = JSON.parse(fs.readFileSync(context.settings.state_path));
      assert.equal(saved.jobs.find((job) => job.id === id).state, 'waiting_result');
      resolve();
      await new Promise((done) => { release = done; });
    };
  });
  const processing = context.worker.processJobs();
  await entered;
  assert.equal(context.worker.processJobs(), processing);
  assert.throws(() => context.worker.retryJob('object', 'first'), (error) => error.code === 'handoff_outstanding');
  assert.throws(() => context.worker.recheckJob('object', 'first'), (error) => error.code === 'handoff_outstanding');
  await context.worker.cleanupJobs();
  assert.equal(context.client.calls.length, 1);
  release();
  await processing;
  assert.equal(context.worker.status().counts.waiting_result, 1);
});

test('public job IDs remain exact for authenticated actions, including IDs longer than 120 characters', (t) => {
  const context = setup(t);
  const id = 'event-'.padEnd(256, 'x');
  readyJob(context, id, 100, { state: 'retrying', reason: 'http_400' });
  assert.equal(context.worker.jobs({ view: 'retrying' }).items[0].id, id);
  assert.doesNotThrow(() => context.worker.retryJob('object', context.worker.jobs().items[0].id));
});

test('global outage cooldown bounds preflight failures and cannot be bypassed by discovery', async (t) => {
  const context = setup(t, { confirmationIntervalMs: 2_000 });
  for (let i = 0; i < 20; i += 1) readyJob(context, `job-${i}`, i + 100);
  let reads = 0;
  context.client.get = async () => { reads += 1; throw new FrigateError('http_503', 503); };
  await context.worker.processJobs();
  assert.equal(reads, 1, 'a server error stops the current batch');
  assert.equal(context.worker.status().counts.retrying, 1);
  context.clock.now += 2_000;
  context.worker.nextCleanupAt = context.clock.now + 60_000;
  await context.worker.tick();
  await context.worker.processJobs();
  assert.equal(reads, 1, 'discovery must honor the same fast-lane cooldown');
  context.clock.now = context.worker.confirmationBackoffUntil;
  await context.worker.processJobs();
  assert.equal(reads, 2);
  assert.equal(context.worker.confirmationBackoffUntil - context.clock.now, 8_000);
});

test('404 from config, recording availability, or regeneration is not mislabeled as event deletion', async (t) => {
  const context = setup(t);
  const job = readyJob(context, 'exists');
  context.client.getConfig = async () => { throw new FrigateError('http_404', 404); };
  await context.worker.processJobs();
  assert.equal(job.state, 'retrying');
  assert.equal(context.worker.status().totals.skipped, 0);
  context.client.media = false;
  await context.worker.cleanupJobs();
  assert.equal(context.worker.status().cleanup.last_error, 'http_404');
  assert.equal(context.worker.status().totals.skipped, 0);
  context.client.getConfig = async () => context.client.config;
  context.client.hasMedia = async () => { throw new FrigateError('http_404', 404); };
  await context.worker.cleanupJobs();
  assert.equal(context.worker.status().totals.skipped, 0);
  context.client.hasMedia = async () => true;
  context.client.regenerateError = new FrigateError('http_404', 404);
  context.clock.now = Math.max(job.next_attempt_at, context.worker.confirmationBackoffUntil);
  await context.worker.processJobs();
  assert.equal(job.state, 'retrying');
  assert.equal(context.worker.status().totals.skipped, 0);
});

test('cleanup rotates with consistent ordering and schedules the next interval after batch completion', async (t) => {
  const context = setup(t, { cleanup_batch_size: 1, cleanupIntervalMs: 60_000 });
  for (const id of ['a', 'A', 'b']) readyJob(context, id);
  const seen = [];
  const original = context.client.get.bind(context.client);
  context.client.get = async (kind, id) => { seen.push(id); context.clock.now += 90_000; return original(kind, id); };
  for (let i = 0; i < 3; i += 1) {
    await context.worker.cleanupJobs();
    assert.equal(context.worker.nextCleanupAt - context.clock.now, 60_000);
  }
  assert.deepEqual(seen, ['a', 'A', 'b'].sort((a, b) => `object:${a}`.localeCompare(`object:${b}`)));
});

test('a configured slow confirmation interval is never silently shortened by the outage ceiling', async (t) => {
  const context = setup(t, { confirmationIntervalMs: 90_000 });
  readyJob(context, 'a');
  context.client.getError = new FrigateError('connection_failed');
  await context.worker.processJobs();
  context.worker.scheduleConfirmation();
  assert.equal(context.worker.nextConfirmationAt - context.clock.now, 90_000);
});

test('fast dispatch reads current camera eligibility instead of terminal-skipping a stale disabled/filter setting', async (t) => {
  const context = setup(t);
  readyJob(context, 'newly-enabled');
  const stale = structuredClone(context.client.config);
  stale.cameras.yard.objects.genai.enabled = false;
  stale.cameras.yard.objects.genai.objects = ['dog'];
  context.worker.runtimeConfig = stale;
  await context.worker.processJobs();
  assert.equal(context.client.calls[0].id, 'newly-enabled');
  assert.equal(context.worker.status().totals.skipped, 0);
});

test('fast dispatch uses the current image source instead of skipping on missing media for a stale source', async (t) => {
  const context = setup(t);
  readyJob(context, 'changed-source');
  context.worker.runtimeConfig = structuredClone(context.client.config);
  context.client.config.cameras.yard.objects.genai.use_snapshot = false;
  const sources = [];
  context.client.hasMedia = async (kind, item, source) => { sources.push(source); return source === 'thumbnails'; };
  await context.worker.processJobs();
  assert.deepEqual(sources, ['thumbnails']);
  assert.equal(context.client.calls[0].source, 'thumbnails');
  assert.equal(context.worker.status().totals.skipped, 0);
});

test('a source change while probing missing media requeues for verification instead of terminal-skipping', async (t) => {
  const context = setup(t);
  const job = readyJob(context, 'changed-during-probe');
  context.client.hasMedia = async (kind, item, source) => {
    context.client.config.cameras.yard.objects.genai.use_snapshot = false;
    return source === 'thumbnails';
  };
  await context.worker.processJobs();
  assert.equal(job.state, 'pending');
  assert.equal(context.worker.status().totals.skipped, 0);
  assert.equal(context.client.calls.length, 0);
  context.clock.now = job.next_attempt_at;
  await context.worker.processJobs();
  assert.equal(context.client.calls[0].source, 'thumbnails');
});

test('malformed fresh camera configuration retries or retains work instead of terminal-skipping it', async (t) => {
  const context = setup(t);
  const job = readyJob(context, 'retained');
  for (const malformed of [{}, { cameras: [] }, { cameras: null }, { cameras: 'invalid' }]) {
    context.client.getConfig = async () => malformed;
    context.clock.now = Math.max(job.next_attempt_at, context.worker.confirmationBackoffUntil);
    await context.worker.processJobs();
    assert.equal(job.state, 'retrying');
    assert.equal(job.reason, 'invalid_camera_configuration');
    assert.equal(context.worker.status().total_queued, 1);
    assert.equal(context.worker.status().totals.skipped, 0);
    const failures = job.failures;
    context.client.media = false;
    await context.worker.cleanupJobs();
    assert.equal(context.worker.status().cleanup.last_error, 'invalid_camera_configuration');
    assert.equal(context.worker.status().totals.skipped, 0);
    assert.equal(job.failures, failures, 'passive cleanup does not add generation failures');
  }
  assert.equal(context.client.calls.length, 0);
});

test('malformed last-moment camera configuration cannot discard or dispatch a ready job', async (t) => {
  const context = setup(t);
  const job = readyJob(context, 'retained');
  let reads = 0;
  context.client.getConfig = async () => ++reads === 1 ? context.client.config : { cameras: [] };
  await context.worker.processJobs();
  assert.equal(job.state, 'retrying');
  assert.equal(job.reason, 'invalid_camera_configuration');
  assert.equal(context.worker.status().totals.skipped, 0);
  assert.equal(context.client.calls.length, 0);
});

function correlated(t, overlay = {}, count = 3) {
  const context = setup(t, overlay);
  for (let i = 0; i < count; i += 1) readyJob(context, `correlated-${i}`, 300 - i);
  context.worker.capabilities.bridge = true;
  context.client.support.bridge = true;
  return context;
}

test('correlated native failure releases catch-up immediately but an unrelated HTTP failure cannot', async (t) => {
  const context = correlated(t);
  await context.worker.processJobs();
  const { ticket } = context.client.calls[0];
  const reference = context.worker.claimInference(ticket, 'request-1');
  context.worker.inferenceStarted(reference, 'request-1');
  context.worker.inferenceFinished('unrelated', 'request-1', { certain: true, status: 400 });
  assert.equal(context.worker.status().active_job.phase, 'running');
  context.worker.inferenceFinished(reference, 'request-1', { certain: true, status: 400 });
  await context.worker.processJobs();
  assert.equal(context.client.calls.length, 1, 'one HTTP failure is not the native attempt lifecycle');
  context.worker.reportAttempt(ticket, { outcome: 'failed', reason: 'http_400' });
  context.clearTimers();
  assert.equal(context.worker.jobs({ view: 'retrying' }).items[0].reason, 'http_400');
  assert.equal(context.worker.status().counts.retrying, 1);
  await context.worker.processJobs();
  assert.equal(context.client.calls.length, 2, 'next job does not wait for the old ten-minute window');
  assert.equal(context.worker.state.jobs[0].failures, 1);
  context.worker.reportAttempt(ticket, { outcome: 'failed', reason: 'http_400' });
  context.clearTimers();
  assert.equal(context.worker.state.jobs[0].failures, 1, 'duplicate callback cannot increment backoff twice');
  assert.throws(() => context.worker.claimInference(ticket, 'late'), (error) => error.statusCode === 409);
});

test('native final before drained inference retains the slot, then verification pipelines bounded saved results', async (t) => {
  const context = correlated(t, { max_verifying: 2 }, 4);
  for (let i = 0; i < 2; i += 1) {
    await context.worker.processJobs();
    const { ticket } = context.client.calls[i];
    const reference = context.worker.claimInference(ticket, `r-${i}`);
    context.worker.reportAttempt(ticket, { outcome: 'success' });
    context.clearTimers();
    assert.ok(context.worker.status().active_job, 'native callback does not prove the HTTP stream has drained');
    assert.throws(() => context.worker.claimInference(ticket, 'after-final'), (error) => error.statusCode === 409);
    context.worker.inferenceFinished(reference, `r-${i}`, { certain: true, status: 200 });
    context.clearTimers();
    assert.equal(context.worker.status().active_job, null);
    assert.equal(context.worker.status().verifying_count, i + 1);
  }
  await context.worker.processJobs();
  assert.equal(context.client.calls.length, 2, 'verification capacity stops more handoffs');
  assert.equal(context.worker.status().scan.blocked_reason, 'verification_capacity_reached');
  context.client.rows.object[0].data.description = 'saved';
  await context.worker.processJobs();
  assert.equal(context.client.calls.length, 3);
  assert.equal(context.worker.status().totals.completed, 1);
  assert.equal(context.worker.status().verifying_count, 1);
});

test('one correlated native attempt can make multiple serial provider calls, never concurrent claims', async (t) => {
  const context = correlated(t);
  await context.worker.processJobs();
  const { ticket } = context.client.calls[0];
  const reference = context.worker.claimInference(ticket, 'first');
  assert.throws(() => context.worker.claimInference(ticket, 'second'), (error) => error.statusCode === 409);
  context.worker.inferenceFinished(reference, 'first', { certain: true, status: 200 });
  context.clearTimers();
  context.worker.claimInference(ticket, 'second');
  context.worker.inferenceFinished(reference, 'second', { certain: true, status: 200 });
  context.worker.reportAttempt(ticket, { outcome: 'success' });
  context.clearTimers();
  assert.equal(context.worker.status().verifying_count, 1);
  assert.equal(context.worker.state.jobs[0].attempt.requests.length, 2);
});

test('saved metadata cannot erase an active or uncertain inference correlation; verified recovery is required', async (t) => {
  const context = correlated(t);
  await context.worker.processJobs();
  const { ticket } = context.client.calls[0];
  const reference = context.worker.claimInference(ticket, 'draining');
  context.client.rows.object[0].data.description = 'already saved';
  await context.worker.processJobs();
  assert.equal(context.worker.status().totals.completed, 0);
  context.worker.inferenceFinished(reference, 'draining', { certain: false, status: 200 });
  context.worker.reportAttempt(ticket, { outcome: 'success' });
  context.clearTimers();
  context.clock.now += 100_000;
  await context.worker.processJobs();
  assert.equal(context.client.calls.length, 1);
  assert.equal(context.worker.requiresRecovery, true);
  assert.equal(context.worker.status().active_job.phase, 'uncertain');
  context.worker.acknowledgeRecovery();
  context.clearTimers();
  assert.equal(context.worker.requiresRecovery, false);
  assert.throws(() => context.worker.claimInference(ticket, 'stale'), (error) => error.statusCode === 409);
  await context.worker.processJobs();
  assert.equal(context.client.calls.length, 2);
});

test('restart restores in-flight correlation as uncertain but restores verification without blocking execution', async (t) => {
  const context = correlated(t);
  await context.worker.processJobs();
  const first = context.client.calls[0].ticket;
  const reference = context.worker.claimInference(first, 'first');
  context.worker.inferenceFinished(reference, 'first', { certain: true, status: 200 });
  context.worker.reportAttempt(first, { outcome: 'success' });
  context.clearTimers();
  await context.worker.processJobs();
  context.worker.claimInference(context.client.calls[1].ticket, 'second');
  await context.worker.stop();
  const resumed = setup(t, {}, context);
  assert.equal(resumed.worker.requiresRecovery, true);
  assert.equal(resumed.worker.status().verifying_count, 1);
  assert.equal(resumed.worker.status().active_job.phase, 'uncertain');
  await resumed.worker.tick();
  assert.equal(context.client.calls.length, 2);
  resumed.worker.acknowledgeRecovery();
  resumed.clearTimers();
  await resumed.worker.processJobs();
  assert.equal(context.client.calls.length, 3);
});

test('legacy schema migrates without discarding backlog or relaxing its conservative handoff', async (t) => {
  const context = setup(t);
  readyJob(context, 'legacy', 200);
  await context.worker.processJobs();
  await context.worker.stop();
  const saved = JSON.parse(fs.readFileSync(context.settings.state_path, 'utf8'));
  saved.schema_version = 1;
  fs.writeFileSync(context.settings.state_path, JSON.stringify(saved));
  const resumed = setup(t, {}, context);
  assert.equal(resumed.worker.state.schema_version, 2);
  assert.equal(resumed.worker.status().active_job.phase, 'legacy_confirmation');
  assert.equal(resumed.worker.status().bridge_mode, 'conservative');
  await resumed.worker.processJobs();
  assert.equal(context.client.calls.length, 1);
});

test('bridge tickets are persisted only hashed and never exposed by public APIs', async (t) => {
  const context = correlated(t);
  await context.worker.processJobs();
  const { ticket } = context.client.calls[0];
  assert.match(ticket, /^[a-f0-9]{64}$/);
  const reference = context.worker.claimInference(ticket, 'private-request');
  assert.notEqual(reference, ticket);
  const saved = fs.readFileSync(context.settings.state_path, 'utf8');
  assert.ok(!saved.includes(ticket));
  assert.ok(saved.includes(reference));
  assert.ok(!JSON.stringify(context.worker.status()).includes(reference));
  assert.ok(!JSON.stringify(context.worker.jobs()).includes(ticket));
  assert.throws(() => context.worker.claimInference('bad-ticket', 'bad'), (error) => error.statusCode === 401);
});

test('expired bridge preparation or lost final callback revokes the ticket only with no outstanding request', async (t) => {
  const context = correlated(t);
  await context.worker.processJobs();
  const { ticket } = context.client.calls[0];
  context.clock.now += context.settings.generationTimeoutMs;
  assert.throws(() => context.worker.claimInference(ticket, 'too-late'), (error) => error.statusCode === 409);
  await context.worker.processJobs();
  assert.equal(context.worker.state.jobs[0].reason, 'bridge_result_timeout');
  assert.equal(context.client.calls.length, 2);
  const second = context.client.calls[1].ticket;
  const reference = context.worker.claimInference(second, 'second');
  context.worker.inferenceFinished(reference, 'second', { certain: true, status: 200 });
  context.clearTimers();
  context.clock.now += context.settings.generationTimeoutMs;
  await context.worker.processJobs();
  assert.equal(context.worker.state.jobs[1].reason, 'bridge_result_timeout');
  assert.throws(() => context.worker.reportAttempt(second, { outcome: 'success' }), (error) => error.statusCode === 409);
});

test('failed attempt persistence prevents native handoff or correlated inference admission', async (t) => {
  const context = correlated(t);
  const original = context.worker.persist.bind(context.worker);
  context.worker.persist = () => { context.worker.storeError = 'backlog_state_write_failed'; return false; };
  await context.worker.processJobs();
  assert.equal(context.client.calls.length, 0);
  context.worker.storeError = null;
  context.worker.state.jobs[0].state = 'pending';
  delete context.worker.state.jobs[0].attempt;
  context.worker.persist = original;
  await context.worker.processJobs();
  context.worker.persist = () => { context.worker.storeError = 'backlog_state_write_failed'; return false; };
  assert.throws(() => context.worker.claimInference(context.client.calls[0].ticket, 'request'), (error) => error.statusCode === 503);
  await context.worker.processJobs();
  assert.equal(context.client.calls.length, 1);
});

test('saved metadata before native final does not release a preparing bridge attempt', async (t) => {
  const context = correlated(t);
  await context.worker.processJobs();
  const { ticket } = context.client.calls[0];
  context.client.rows.object[0].data.description = 'saved early';
  await context.worker.processJobs();
  assert.equal(context.client.calls.length, 1);
  assert.equal(context.worker.status().active_job.phase, 'handed_off');
  context.worker.reportAttempt(ticket, { outcome: 'success' });
  context.clearTimers();
  await context.worker.processJobs();
  assert.equal(context.client.calls.length, 2);
  assert.equal(context.worker.status().totals.completed, 1);
  assert.deepEqual(context.worker.reportAttempt(ticket, { outcome: 'success' }), { accepted: true });
});

test('final lifecycle persistence failure is surfaced and empty recovery acknowledgement is harmless', async (t) => {
  const disabled = new FrigateCatchup({ enabled: false });
  assert.doesNotThrow(() => disabled.acknowledgeRecovery());
  const context = correlated(t);
  await context.worker.processJobs();
  const reference = context.worker.claimInference(context.client.calls[0].ticket, 'r');
  context.worker.persist = () => { context.worker.storeError = 'backlog_state_write_failed'; return false; };
  assert.throws(() => context.worker.inferenceFinished(reference, 'r', { certain: true, status: 400 }),
    (error) => error.statusCode === 503);
});

const rescueSettings = { enabled: true, model: 'f-model', max_context: 24576, output_reserve: 2048, safety_margin: 1024 };
const rescueBody = { model: 'f-model', prompt: 'SECRET-PROMPT', images: ['SECRET-IMAGE'], options: { num_ctx: 8192 } };
const rescueRequest = contextRequest('/api/generate', Buffer.from(JSON.stringify(rescueBody)), rescueBody, 'http://ollama');

async function overflowJob(t) {
  const context = correlated(t, { context_rescue: rescueSettings }, 1);
  await context.worker.processJobs();
  const ticket = context.client.calls[0].ticket;
  const reference = context.worker.claimInference(ticket, 'normal', rescueRequest);
  context.worker.inferenceStarted(reference, 'normal');
  assert.equal(context.worker.contextRescuePlan(reference, 'normal'), null);
  // A final report may arrive just before HTTP drain bookkeeping.
  context.worker.reportAttempt(ticket, { outcome: 'failed' });
  context.worker.inferenceFinished(reference, 'normal', { certain: true, status: 400,
    contextOverflow: { prompt_tokens: 14407, reported_context: 8192 } });
  context.clearTimers();
  return context;
}

async function nextRescueAttempt(context, id) {
  const job = context.worker.state.jobs[0];
  context.clock.now = job.next_attempt_at;
  await context.worker.processJobs();
  context.clearTimers();
  const ticket = context.client.calls.at(-1).ticket;
  const reference = context.worker.claimInference(ticket, id, rescueRequest);
  context.worker.inferenceStarted(reference, id);
  return { ticket, reference, job };
}

test('context overflow and one-shot rescue survive retry, restart, manual retry and skipped-record recheck', async (t) => {
  const context = await overflowJob(t);
  const { worker } = context;
  assert.equal(worker.state.jobs[0].reason, 'context_overflow');
  assert.equal(worker.state.jobs[0].failures, 1);
  await worker.processJobs();
  assert.equal(context.client.calls.length, 1, 'ordinary retry backoff still applies');
  const attempt = await nextRescueAttempt(context, 'rescue');
  assert.equal(worker.contextRescuePlan(attempt.reference, 'rescue').context, 20480);
  worker.recordContextRescue(attempt.reference, 'rescue', { context: 20480 });
  const durable = JSON.parse(fs.readFileSync(context.settings.state_path, 'utf8'));
  assert.equal(durable.jobs[0].context_rescue.attempted, true, 'consumed before HTTP dispatch');
  assert.equal(durable.jobs[0].attempt.requests[0].rescue_context, 20480);
  assert.doesNotMatch(JSON.stringify(durable), /SECRET-PROMPT|SECRET-IMAGE/);
  assert.doesNotMatch(JSON.stringify(worker.jobs()), /signature|ticket_hash|SECRET/);
  await worker.stop();
  const resumed = setup(t, { context_rescue: rescueSettings }, context);
  assert.equal(resumed.worker.storeError, null);
  assert.equal(resumed.worker.requiresRecovery, true, 'restart cannot assume the enlarged request finished');
  resumed.worker.acknowledgeRecovery();
  resumed.clearTimers();
  resumed.worker.retryJob('object', attempt.job.id);
  assert.equal(resumed.worker.state.jobs[0].context_rescue.attempted, true);
  const saved = resumed.worker.state.jobs[0];
  resumed.worker.finish(saved, 'skipped', 'media_expired_or_missing');
  resumed.worker.recheckJob('object', saved.id);
  resumed.clearTimers();
  assert.equal(resumed.worker.state.jobs[0].context_rescue.attempted, true);
});

test('rescue preflight blocks do not consume the chance; used rescue never escalates on another retry', async (t) => {
  const context = await overflowJob(t);
  const { worker } = context;
  let attempt = await nextRescueAttempt(context, 'blocked');
  worker.recordContextRescue(attempt.reference, 'blocked', { blocked: 'rescue_telemetry_unavailable' });
  worker.inferenceFinished(attempt.reference, 'blocked', { certain: true, status: 422 });
  worker.reportAttempt(attempt.ticket, { outcome: 'failed' });
  context.clearTimers();
  assert.equal(attempt.job.reason, 'rescue_telemetry_unavailable');
  assert.equal(attempt.job.context_rescue.attempted, false);
  attempt = await nextRescueAttempt(context, 'enlarged');
  worker.recordContextRescue(attempt.reference, 'enlarged', { context: 20480 });
  worker.inferenceFinished(attempt.reference, 'enlarged', { certain: true, status: 400,
    contextOverflow: { prompt_tokens: 100000, reported_context: 20480 } });
  worker.reportAttempt(attempt.ticket, { outcome: 'failed' });
  context.clearTimers();
  assert.equal(attempt.job.reason, 'rescue_request_failed');
  assert.equal(attempt.job.context_rescue.prompt_tokens, 14407, 'never overwrite the consumed evidence to authorize more growth');
  attempt = await nextRescueAttempt(context, 'again');
  assert.equal(worker.contextRescuePlan(attempt.reference, 'again').blocked, 'rescue_used');
  assert.throws(() => worker.recordContextRescue(attempt.reference, 'again', { context: 24576 }));
});

test('serial provider retries within one native attempt cannot take the larger rescue before catch-up backoff', async (t) => {
  const context = correlated(t, { context_rescue: rescueSettings }, 1);
  await context.worker.processJobs();
  const ticket = context.client.calls[0].ticket;
  const reference = context.worker.claimInference(ticket, 'first', rescueRequest);
  context.worker.inferenceStarted(reference, 'first');
  context.worker.inferenceFinished(reference, 'first', { certain: true, status: 400,
    contextOverflow: { prompt_tokens: 14407, reported_context: 8192 } });
  context.clearTimers();
  context.worker.claimInference(ticket, 'serial', rescueRequest);
  context.worker.inferenceStarted(reference, 'serial');
  assert.equal(context.worker.contextRescuePlan(reference, 'serial'), null);
});

test('rescue state write failure refuses enlargement and malformed persisted rescue fails closed', async (t) => {
  const context = await overflowJob(t);
  const attempt = await nextRescueAttempt(context, 'write-fails');
  const before = fs.readFileSync(context.settings.state_path, 'utf8');
  const persist = context.worker.persist.bind(context.worker);
  context.worker.persist = () => { context.worker.storeError = 'backlog_state_write_failed'; return false; };
  assert.throws(() => context.worker.recordContextRescue(attempt.reference, 'write-fails', { context: 20480 }),
    (error) => error.statusCode === 503);
  assert.equal(context.worker.contextRescuePlan(attempt.reference, 'write-fails'), null);
  assert.equal(fs.readFileSync(context.settings.state_path, 'utf8'), before);
  await context.worker.stop();
  context.worker.persist = persist;
  const state = JSON.parse(before);
  state.jobs[0].context_rescue.attempted = true;
  state.jobs[0].context_rescue.target_context = null;
  fs.writeFileSync(context.settings.state_path, JSON.stringify(state));
  const resumed = setup(t, { context_rescue: rescueSettings }, context);
  assert.equal(resumed.worker.storeError, 'backlog_state_invalid');
});

test('invalid duplicate tickets and terminal attempts with outstanding requests fail closed on restore', async (t) => {
  for (const mutation of ['duplicate', 'outstanding', 'unrevoked']) {
    const context = correlated(t);
    await context.worker.processJobs();
    context.worker.reportAttempt(context.client.calls[0].ticket, { outcome: 'success' });
    context.clearTimers();
    await context.worker.stop();
    const saved = JSON.parse(fs.readFileSync(context.settings.state_path, 'utf8'));
    const attempt = saved.jobs[0].attempt;
    if (mutation === 'duplicate') {
      saved.jobs[1].state = 'waiting_result';
      saved.jobs[1].attempt = structuredClone(attempt);
    } else if (mutation === 'outstanding') attempt.requests = [{ id: 'r', state: 'queued', status: null }];
    else attempt.revoked = false;
    fs.writeFileSync(context.settings.state_path, JSON.stringify(saved));
    const resumed = setup(t, {}, context);
    assert.equal(resumed.worker.status().last_error, 'backlog_state_invalid');
  }
});
