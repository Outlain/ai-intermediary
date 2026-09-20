import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkPolicy, scheduleActive } from '../src/work-policy.js';
import { Classifier } from '../src/classifier.js';
import { testConfig, SilentLogger } from './helpers.js';
import { Scheduler, createJob } from '../src/scheduler.js';
import { Metrics } from '../src/metrics.js';

const zone = 'America/New_York';
const rule = (extra = {}) => ({ enabled: true, days: ['sun','mon','tue','wed','thu','fri','sat'],
  start: '01:00', end: '03:00', sources: ['frigate'], traffic: 'all', mode: 'pause', ...extra });
const active = (r, date) => scheduleActive(r, Date.parse(date), zone);
function fixture(t, overlay = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return testConfig({ ...overlay, maintenance: { state_path: path.join(dir, 'maintenance.json') } });
}

test('weekly and overnight windows use the starting weekday and an exclusive end', () => {
  const r = rule({ days: ['mon'], start: '23:00', end: '03:00' });
  assert.equal(active(r, '2026-09-22T02:59:00Z'), false);
  assert.equal(active(r, '2026-09-22T03:00:00Z'), true);
  assert.equal(active(r, '2026-09-22T06:59:59Z'), true);
  assert.equal(active(r, '2026-09-22T07:00:00Z'), false);
  assert.equal(active(r, '2026-09-23T04:00:00Z'), false);
});

test('DST follows local wall clock in skipped and repeated hours', () => {
  assert.equal(active(rule(), '2026-03-08T06:59:00Z'), true);
  assert.equal(active(rule(), '2026-03-08T07:00:00Z'), false);
  assert.equal(active(rule({ start: '02:00' }), '2026-03-08T07:00:00Z'), false);
  const repeated = rule({ start: '01:30', end: '01:45' });
  for (const at of ['05:35', '06:35']) assert.equal(active(repeated, `2026-11-01T${at}:00Z`), true);
  for (const at of ['05:50', '06:50']) assert.equal(active(repeated, `2026-11-01T${at}:00Z`), false);
});

test('manual, timed and recurring scopes combine, persist and resume independently', (t) => {
  let now = Date.parse('2026-09-20T05:30:00Z');
  const config = fixture(t, { work_policy: { schedules: { night: rule() } } });
  let policy = new WorkPolicy(config, { clock: () => now });
  const manual = policy.pause({ sources: ['odysseus'], traffic: 'live' });
  const timed = policy.pause({ sources: ['*'], traffic: 'catchup', until: now + 60000 });
  assert.equal(policy.block('frigate').reason, 'scheduled_pause');
  assert.equal(policy.block('odysseus').reason, 'manual_source_pause');
  assert.equal(policy.block('odysseus', 'catchup').reason, 'manual_source_pause');
  assert.match(policy.status().schedules[0].next_transition, /07:00:00/);
  policy = new WorkPolicy(config, { clock: () => now });
  assert.equal(policy.manual.length, 2);
  policy.resume(manual.id);
  assert.equal(policy.block('odysseus'), null);
  assert.ok(policy.block('frigate'));
  now += 2 * 3600000;
  assert.equal(policy.block('frigate'), null);
  assert.equal(policy.block('odysseus', 'catchup'), null);
  assert.ok(timed.id);
});

test('invalid scoped state fails closed; disabled source stays classified', (t) => {
  const config = fixture(t, { clients: { odysseus: { enabled: false } } });
  fs.writeFileSync(config.maintenance.state_path + '.scopes', '{bad');
  assert.equal(new WorkPolicy(config).block('frigate').reason, 'pause_state_error');
  assert.equal(new Classifier(config).identify({ headers: { 'x-ollama-client': 'odysseus' }, socket: {} }, {}).client, 'odysseus');
});

test('source and schedule validation rejects unsafe definitions', (t) => {
  for (const schedules of [{ a: rule({ sources: ['unknown'] }) }, { a: rule({ start: '03:00' }) },
    { a: rule({ mode: 'release_gpu' }) }, { a: rule({ days: [] }) }]) {
    assert.throws(() => fixture(t, { work_policy: { schedules } }));
  }
  assert.throws(() => fixture(t, { work_policy: { timezone: 'invalid-zone' } }));
  assert.throws(() => fixture(t, { clients: { odysseus: { listener_port: 11436 }, frigate: { listener_port: 11436 } } }));
  assert.throws(() => fixture(t, { clients: { odysseus: { listener_port: -1 } } }));
  assert.throws(() => fixture(t, { clients: { odysseus: { source_ips: ['192.0.2.0/24'] }, frigate: { source_ips: ['192.0.2.3'] } } }), /overlaps/);
});

test('dedicated listener beats headers; header opt-out uses IP before legacy model', (t) => {
  const config = fixture(t, { clients: { odysseus: { source_ips: ['127.0.0.1'] }, frigate: { header_enabled: false } } });
  const classifier = new Classifier(config), request = { headers: { 'x-ollama-client': 'frigate' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(classifier.identify(request, { model: 'f-model' }).client, 'odysseus');
  assert.equal(classifier.identify(request, {}, 'frigate').method, 'listener');
});

test('strict numeric priority and equal-priority FIFO apply to any source', (t) => {
  const config = fixture(t, { clients: { misc: { priority: 1000, model_policy: { idle_hold: '0s' } }, frigate: { priority: 100 } } });
  const scheduler = new Scheduler(config, { logger: new SilentLogger(), metrics: new Metrics(), clock: () => 0 });
  for (const [index, client] of ['frigate', 'odysseus', 'misc'].entries()) {
    scheduler.enqueue(createJob({ client, model: 'shared', sequence: index, enqueuedAt: 0 }));
  }
  const order = [];
  while (scheduler.jobs.length) { const job = scheduler.take().job; order.push(job.client); scheduler.complete(job); }
  assert.deepEqual(order, ['misc', 'frigate', 'odysseus']);
});

test('opt-in paused queues expire and cancel normally; default queues reject/drop', (t) => {
  let now = 0, paused = false;
  const config = fixture(t, { clients: { odysseus: { queue_while_paused: true, request_ttl: '2s' } } });
  const scheduler = new Scheduler(config, { logger: new SilentLogger(), metrics: new Metrics(), clock: () => now,
    pauseCheck: () => paused ? { reason: 'scheduled_pause' } : null });
  const job = (client, sequence) => createJob({ client, sequence, model: 'shared', enqueuedAt: now });
  const dropped = job('frigate', 1); scheduler.enqueue(dropped);
  paused = true; scheduler.enforcePauses(); assert.equal(dropped.state, 'dropped');
  assert.equal(scheduler.enqueue(job('frigate', 2)).accepted, false);
  const waiting = job('odysseus', 3); assert.equal(scheduler.enqueue(waiting).accepted, true);
  assert.equal(scheduler.take().job, null);
  now = 2001; scheduler.expire(); assert.equal(waiting.state, 'dropped');
  const cancelled = job('odysseus', 4); scheduler.enqueue(cancelled); scheduler.cancel(cancelled);
  const resumed = job('odysseus', 5); scheduler.enqueue(resumed);
  paused = false; scheduler.enforcePauses(); assert.equal(scheduler.take().job, resumed);
});
