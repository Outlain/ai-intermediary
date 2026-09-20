import assert from 'node:assert/strict';
import test from 'node:test';
import { Classifier } from '../src/classifier.js';
import { expandEnvironment } from '../src/config.js';
import { Metrics } from '../src/metrics.js';
import { createJob, Scheduler } from '../src/scheduler.js';
import { SilentLogger, testConfig } from './helpers.js';

function harness(overlay = {}) {
  let now = 0;
  const config = testConfig(overlay);
  const scheduler = new Scheduler(config, { logger: new SilentLogger(), metrics: new Metrics(), clock: () => now });
  let sequence = 0;
  const add = (id, client, model, extra = {}) => {
    const controller = new AbortController();
    const job = createJob({ id, client, model, pathname: '/api/chat', streaming: true, sequence: ++sequence, signal: controller.signal, enqueuedAt: now, ...extra });
    assert.equal(scheduler.enqueue(job).accepted, true);
    return job;
  };
  return { config, scheduler, add, setNow: (value) => { now = value; }, now: () => now };
}

test('FIFO is preserved within a client and model', () => {
  const { scheduler, add } = harness();
  add('O1', 'odysseus', 'od-model');
  add('O2', 'odysseus', 'od-model');
  assert.equal(scheduler.take().job.id, 'O1');
  scheduler.complete(scheduler.active);
  assert.equal(scheduler.take().job.id, 'O2');
});

for (const mode of ['strict_priority', 'balanced']) {
  test(`correlated catch-up cannot hide same-model live work in ${mode} mode`, () => {
    const { scheduler, add, setNow } = harness({ scheduler: { mode }, models: { 'od-model': { idle_hold: '0ms' } },
      clients: { frigate: { request_ttl: '30s' } } });
    add('background', 'frigate', 'f-model', { trafficClass: 'catchup' });
    setNow(10_000); // Even aged work never gains background precedence.
    add('live', 'frigate', 'f-model');
    add('interactive', 'odysseus', 'od-model');
    const order = [];
    while (scheduler.jobs.length) {
      const selected = scheduler.take().job;
      assert.ok(selected);
      order.push(selected.id);
      scheduler.complete(selected);
    }
    assert.deepEqual(order, ['interactive', 'live', 'background']);
  });
}

test('background admission cannot evict live Frigate but fresh live work can evict background', async () => {
  const { scheduler, add } = harness({ clients: { frigate: { queue_limit: 1 } } });
  const live = add('live', 'frigate', 'f-model');
  const background = createJob({ id: 'background', client: 'frigate', model: 'f-model', trafficClass: 'catchup', enqueuedAt: 0 });
  assert.equal(scheduler.enqueue(background).accepted, false);
  assert.equal(live.state, 'queued');
  scheduler.cancel(live);
  assert.equal(scheduler.enqueue(background).accepted, true);
  add('fresh-live', 'frigate', 'f-model');
  assert.equal((await background.result).code, 'queue_overflow_drop_oldest');
});

test('catch-up respects live idle holds but does not create an idle hold between background jobs', () => {
  const { scheduler, add, setNow } = harness({ models: { 'f-model': { idle_hold: '3s' } },
    clients: { frigate: { request_ttl: '30s' } } });
  add('live', 'frigate', 'f-model');
  scheduler.complete(scheduler.take().job);
  add('background-1', 'frigate', 'f-model', { trafficClass: 'catchup' });
  assert.equal(scheduler.take().reason, 'model_lease');
  setNow(3_000);
  scheduler.complete(scheduler.take().job);
  add('background-2', 'frigate', 'f-model', { trafficClass: 'catchup' });
  assert.equal(scheduler.take().job.id, 'background-2');
});

test('interactive priority wins when models begin queued together', () => {
  const { scheduler, add } = harness();
  add('F1', 'frigate', 'f-model');
  add('O1', 'odysseus', 'od-model');
  assert.equal(scheduler.take().job.id, 'O1');
});

test('maximum wait prevents Frigate starvation and overrides affinity', () => {
  const { scheduler, add, setNow } = harness({ scheduler: { mode: 'balanced' } });
  add('O1', 'odysseus', 'od-model');
  const first = scheduler.take().job;
  scheduler.complete(first);
  add('F1', 'frigate', 'f-model');
  add('O2', 'odysseus', 'od-model');
  setNow(501);
  assert.equal(scheduler.take().job.id, 'F1');
  assert.equal(scheduler.active.scheduleReason, 'max_wait_exceeded');
});

test('current-model requests are batched ahead of other queued models', () => {
  const { scheduler, add } = harness({ scheduler: { mode: 'balanced' } });
  add('O1', 'odysseus', 'od-model');
  let active = scheduler.take().job;
  scheduler.complete(active);
  add('F1', 'frigate', 'f-model');
  add('O2', 'odysseus', 'od-model');
  add('O3', 'odysseus', 'od-model');
  active = scheduler.take().job;
  assert.equal(active.id, 'O2');
  scheduler.complete(active);
  active = scheduler.take().job;
  assert.equal(active.id, 'O3');
});

test('model lease waits for a follow-up and avoids an immediate switch', () => {
  const { scheduler, add, setNow } = harness();
  add('O1', 'odysseus', 'od-model');
  scheduler.complete(scheduler.take().job);
  add('F1', 'frigate', 'f-model');
  let selection = scheduler.take();
  assert.equal(selection.job, null);
  assert.equal(selection.reason, 'model_lease');
  setNow(8);
  add('O2', 'odysseus', 'od-model');
  selection = scheduler.take();
  assert.equal(selection.job.id, 'O2');
  assert.equal(scheduler.switches, 0);
});

test('batch request limit causes reevaluation and a model switch', () => {
  const { scheduler, add } = harness({ scheduler: { mode: 'balanced' }, models: {
    'od-model': { idle_hold: '0ms', max_batch_requests: 2, max_batch_time: '2s' },
    'f-model': { idle_hold: '0ms', max_batch_requests: 10, max_batch_time: '2s' },
  } });
  add('O1', 'odysseus', 'od-model');
  scheduler.complete(scheduler.take().job);
  add('O2', 'odysseus', 'od-model');
  add('O3', 'odysseus', 'od-model');
  add('F1', 'frigate', 'f-model');
  scheduler.complete(scheduler.take().job);
  assert.equal(scheduler.take().job.id, 'F1');
});

test('stale Frigate jobs expire', async () => {
  const { scheduler, add, setNow } = harness({ clients: { frigate: { request_ttl: '100ms' } } });
  const job = add('F1', 'frigate', 'f-model');
  setNow(101);
  scheduler.expire();
  const result = await job.result;
  assert.equal(result.code, 'queue_ttl_expired');
  assert.equal(scheduler.status().queues.frigate, 0);
});

test('Frigate drop_oldest overflow policy admits fresh work', async () => {
  const { scheduler, add } = harness({ clients: { frigate: { queue_limit: 2, overflow_policy: 'drop_oldest' } } });
  const first = add('F1', 'frigate', 'f-model');
  add('F2', 'frigate', 'f-model');
  add('F3', 'frigate', 'f-model');
  assert.equal((await first.result).code, 'queue_overflow_drop_oldest');
  assert.deepEqual(scheduler.jobs.map((job) => job.id), ['F2', 'F3']);
});

test('queued disconnect cancels and removes work', async () => {
  const { scheduler, add } = harness();
  const job = add('O1', 'odysseus', 'od-model');
  scheduler.cancel(job);
  assert.equal((await job.result).code, 'client_closed');
  assert.equal(scheduler.jobs.length, 0);
});

test('maintenance pause fails queued work and blocks admission until resume', async () => {
  const { scheduler, add } = harness();
  const queued = add('O1', 'odysseus', 'od-model');
  const paused = scheduler.pause();
  assert.equal(paused.queuedDropped, 1);
  assert.equal((await queued.result).code, 'maintenance_paused');
  assert.equal(scheduler.status().accepting, false);
  assert.equal(scheduler.take().job, null);

  const controller = new AbortController();
  const rejected = createJob({
    id: 'O2', client: 'odysseus', model: 'od-model', pathname: '/api/chat',
    streaming: true, sequence: 2, signal: controller.signal, enqueuedAt: 0,
  });
  assert.equal(scheduler.enqueue(rejected).code, 'maintenance_paused');
  scheduler.resume();
  assert.equal(scheduler.status().accepting, true);
  assert.equal(scheduler.enqueue(rejected).accepted, true);
});

test('model and header client mappings use the documented precedence', () => {
  const config = testConfig();
  const classifier = new Classifier(config);
  const request = { headers: { 'x-ollama-client': 'frigate' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.deepEqual(classifier.identify(request, { model: 'od-model' }), { client: 'frigate', method: 'header' });
  request.headers = {};
  assert.deepEqual(classifier.identify(request, { model: 'od-model' }), { client: 'odysseus', method: 'model' });
});

test('unknown models use the configured fallback client and can be rejected by policy', () => {
  let config = testConfig();
  let classifier = new Classifier(config);
  const request = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(classifier.identify(request, { model: 'unknown' }).client, 'default');
  config = testConfig({ scheduler: { default_client: 'odysseus' } });
  classifier = new Classifier(config);
  assert.deepEqual(classifier.identify(request, { model: 'unknown' }), { client: 'odysseus', method: 'fallback' });
  config = testConfig({ scheduler: { unknown_model_policy: 'reject' } });
  assert.equal(config.scheduler.unknown_model_policy, 'reject');
});

test('Frigate source matching overrides an Odysseus fallback', () => {
  const config = testConfig({
    scheduler: { default_client: 'odysseus' },
    clients: { frigate: { source_ips: ['192.0.2.50/32'] } },
  });
  const classifier = new Classifier(config);
  const request = { headers: {}, socket: { remoteAddress: '192.0.2.50' } };
  assert.deepEqual(classifier.identify(request, { model: 'any-frigate-model' }), { client: 'frigate', method: 'source_ip' });
  request.socket.remoteAddress = '172.18.0.5';
  assert.deepEqual(classifier.identify(request, { model: 'any-odysseus-model' }), { client: 'odysseus', method: 'fallback' });
});

test('fallback client must name a configured client', () => {
  assert.throws(
    () => testConfig({ scheduler: { default_client: 'missing' } }),
    /scheduler\.default_client must name a configured client/,
  );
});

test('backend reconciliation clears stale scheduler model state after restart', () => {
  const { scheduler, add } = harness();
  add('O1', 'odysseus', 'od-model');
  scheduler.complete(scheduler.take().job);
  assert.equal(scheduler.currentModel, 'od-model');
  scheduler.reconcile(null);
  assert.equal(scheduler.currentModel, null);
});

test('environment placeholders support required values and defaults', () => {
  const text = 'url: ${OLLAMA_URL:?missing backend}\nsource: ${CLIENT_SOURCE:-}\n';
  assert.equal(expandEnvironment(text, { OLLAMA_URL: 'http://ollama:11434' }), 'url: http://ollama:11434\nsource: \n');
  assert.throws(() => expandEnvironment(text, {}), /missing backend/);
});

test('client-wide model policy applies to an arbitrary requested model', () => {
  const { scheduler, add } = harness({ models: {} });
  const job = add('O-new', 'odysseus', 'not-registered-anywhere');
  scheduler.complete(scheduler.take().job);
  assert.equal(scheduler.modelPolicy(job.model, job.client).keep_alive, '750ms');
  assert.equal(scheduler.leaseUntil, 50);
});

test('strict priority never promotes old Frigate work ahead of waiting Odysseus', () => {
  const { scheduler, add, setNow } = harness({
    clients: { frigate: { priority: 10, request_ttl: '2h', max_wait: '1ms' } },
    scheduler: { priority_aging: true, aging_interval: '1ms', aging_bonus: 100 },
    models: { 'od-model': { max_batch_requests: 1, max_batch_time: '1ms' } },
  });
  add('F1', 'frigate', 'f-model');
  for (let index = 1; index <= 3; index += 1) {
    setNow(index * 60_000);
    add(`O${index}`, 'odysseus', 'od-model');
    const job = scheduler.take().job;
    assert.equal(job.id, `O${index}`);
    assert.equal(job.scheduleReason, 'strict_priority');
    scheduler.complete(job);
  }
  assert.equal(scheduler.take().reason, 'model_lease');
  setNow(180_050);
  assert.equal(scheduler.take().job.id, 'F1');
});

test('strict priority uses FIFO across models and does not favor the loaded model', () => {
  const { scheduler, add, setNow } = harness();
  add('O1', 'odysseus', 'od-model');
  scheduler.complete(scheduler.take().job);
  setNow(10);
  add('O2', 'odysseus', 'new-model');
  add('O3', 'odysseus', 'od-model');
  assert.equal(scheduler.take().job.id, 'O2');
});

test('strict idle hold blocks a lower-priority client even when requesting the same model', () => {
  const { scheduler, add, setNow } = harness();
  add('O1', 'odysseus', 'od-model');
  scheduler.complete(scheduler.take().job);
  add('F1', 'frigate', 'od-model');
  assert.equal(scheduler.take().reason, 'model_lease');
  setNow(50);
  assert.equal(scheduler.take().job.id, 'F1');
});

test('higher-priority work bypasses another client idle hold for same or different models', () => {
  for (const model of ['f-model', 'od-model']) {
    const { scheduler, add } = harness({ models: { 'f-model': { idle_hold: '1m' } } });
    add('F1', 'frigate', 'f-model');
    scheduler.complete(scheduler.take().job);
    add('O1', 'odysseus', model);
    assert.equal(scheduler.take().job.id, 'O1');
  }
});

test('active work is never preempted and other live clients use priority then FIFO', () => {
  const { scheduler, add } = harness();
  add('F1', 'frigate', 'f-model');
  const active = scheduler.take().job;
  add('F2', 'frigate', 'f-model');
  add('D1', 'default', 'default-model');
  add('D2', 'default', 'another-model');
  add('O1', 'odysseus', 'od-model');
  assert.equal(scheduler.take().job, null);
  assert.equal(scheduler.active, active);
  scheduler.complete(active);
  const next = scheduler.take().job;
  assert.equal(next.id, 'O1');
  scheduler.cancel(scheduler.jobs.find((job) => job.id === 'F2'));
  scheduler.complete(next);
  scheduler.leaseUntil = 0;
  assert.equal(scheduler.take().job.id, 'D1');
  scheduler.complete(scheduler.active);
  assert.equal(scheduler.take().job.id, 'D2');
});

test('background readiness accounts for live queue, active work, idle hold, pause and stop', () => {
  const { scheduler, add, setNow } = harness();
  assert.equal(scheduler.canRunBackground(), true);
  add('O1', 'odysseus', 'od-model');
  assert.equal(scheduler.backgroundReadiness().reason, 'live_requests_queued');
  scheduler.take();
  assert.equal(scheduler.backgroundReadiness().reason, 'active_request');
  scheduler.complete(scheduler.active);
  assert.deepEqual(scheduler.backgroundReadiness(), { ready: false, reason: 'model_lease', wait_seconds: 0.05 });
  setNow(50);
  assert.equal(scheduler.canRunBackground(), true);
  scheduler.pause();
  assert.equal(scheduler.backgroundReadiness().reason, 'maintenance_paused');
  scheduler.resume();
  scheduler.stop();
  assert.equal(scheduler.backgroundReadiness().reason, 'shutting_down');
});

test('aggregate body memory includes active work and frees it after completion or cancellation', () => {
  const { scheduler, add } = harness({ scheduler: { max_queue_bytes: 10 } });
  add('O1', 'odysseus', 'od-model', { body: Buffer.alloc(6) });
  scheduler.take();
  const queued = add('O2', 'odysseus', 'od-model', { body: Buffer.alloc(4) });
  const rejected = createJob({ id: 'O3', client: 'odysseus', model: 'od-model', body: Buffer.alloc(1), enqueuedAt: 0 });
  assert.equal(scheduler.enqueue(rejected).code, 'queue_bytes_exceeded');
  assert.equal(scheduler.status().total_request_bytes, 10);
  assert.equal(scheduler.status().active_bytes, 6);
  scheduler.cancel(queued);
  assert.equal(scheduler.status().queue_bytes, 0);
  assert.equal(scheduler.enqueue(rejected).accepted, true);
  scheduler.complete(scheduler.active);
  assert.equal(scheduler.status().total_request_bytes, 1);
});

test('memory rejection leaves existing work intact even for drop_oldest or deduplication', () => {
  for (const dedupeKey of [null, 'duplicate']) {
    const { scheduler, add } = harness({ scheduler: { max_queue_bytes: 10 }, clients: { frigate: { queue_limit: 1 } } });
    const original = add('F1', 'frigate', 'f-model', { body: Buffer.alloc(4), dedupeKey });
    const rejected = createJob({ id: 'F2', client: 'frigate', model: 'f-model', body: Buffer.alloc(11), dedupeKey, enqueuedAt: 0 });
    assert.equal(scheduler.enqueue(rejected).code, 'queue_bytes_exceeded');
    assert.equal(original.state, 'queued');
    assert.deepEqual(scheduler.jobs, [original]);
  }
});

test('balanced mode max_wait zero disables forced dispatch', () => {
  const { scheduler, add, setNow } = harness({ scheduler: { mode: 'balanced' }, clients: { frigate: { max_wait: '0ms' } } });
  add('O1', 'odysseus', 'od-model');
  scheduler.complete(scheduler.take().job);
  const queued = add('F1', 'frigate', 'f-model');
  assert.equal(queued.maxWaitAt, Infinity);
  setNow(10);
  assert.equal(scheduler.take().reason, 'model_lease');
});

test('arbitrary model names cannot resolve inherited policies or corrupt queue summaries', () => {
  const { scheduler, add } = harness();
  for (const name of ['__proto__', 'constructor', 'toString']) {
    add(name, 'odysseus', name);
    assert.equal(scheduler.modelPolicy(name, 'odysseus').group, 'odysseus');
    assert.equal(scheduler.status().model_queues[name], 1);
  }
  assert.equal(scheduler.take().job.id, '__proto__');
});

test('client identity must be an actual configured key, not an inherited property', () => {
  const classifier = new Classifier(testConfig());
  const request = { headers: { 'x-ollama-client': 'constructor' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.deepEqual(classifier.identify(request, { model: 'new-model' }, '__proto__'), { client: 'default', method: 'fallback' });
});
