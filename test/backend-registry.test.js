import test from 'node:test';
import assert from 'node:assert/strict';
import { BackendRegistry } from '../src/backend-registry.js';
import { createJob, Scheduler } from '../src/scheduler.js';
import { Metrics } from '../src/metrics.js';
import { testConfig, SilentLogger } from './helpers.js';

test('legacy source routing resolves Ollama while protocol and allowlist mismatches fail explicitly', () => {
  const config = testConfig({ backends: { ollama: { type: 'ollama', url: 'http://127.0.0.1:1' },
    comfy: { type: 'comfyui', url: 'http://127.0.0.1:2' } },
  clients: { media: { backend: 'comfy', allowed_backends: ['comfy'], priority: 50 } } });
  const registry = new BackendRegistry(config);
  assert.equal(registry.resolve('odysseus', null, 'ollama').name, 'ollama');
  assert.equal(registry.resolve('media', null, 'comfyui').name, 'comfy');
  assert.throws(() => registry.resolve('media', 'ollama', 'ollama'), { code: 'backend_not_allowed' });
  assert.throws(() => registry.resolve('media', null, 'ollama'), { code: 'backend_protocol_mismatch' });
  assert.throws(() => registry.resolve('unknown', null, 'ollama'), { code: 'source_disabled' });
  assert.ok(registry.snapshot().every((backend) => !Object.hasOwn(backend, 'url')));
});

test('accepted durable work survives pauses, TTL and Ollama recovery queue failures', () => {
  let now = 10;
  let paused = false;
  const config = testConfig();
  const scheduler = new Scheduler(config, { logger: new SilentLogger(), metrics: new Metrics(),
    clock: () => now, pauseCheck: () => paused ? { reason: 'scheduled_pause' } : null });
  const media = createJob({ id: 'media', client: 'default', backend: 'comfy', model: 'comfyui:comfy',
    pathname: '/prompt', durable: true, enqueuedAt: now, sequence: 1, body: Buffer.alloc(0) });
  assert.equal(scheduler.enqueue(media).accepted, true);
  paused = true;
  scheduler.enforcePauses();
  now += 1_000_000;
  scheduler.expire();
  scheduler.failQueued(503, 'gpu_recovery_required', 'Recovery required');
  assert.equal(media.state, 'queued');
  assert.equal(scheduler.take().job, null);
  paused = false;
  assert.equal(scheduler.take().job, media);
  scheduler.complete(media);
});

test('higher-priority chat wins next turn without preempting an active durable workflow', () => {
  const scheduler = new Scheduler(testConfig(), { logger: new SilentLogger(), metrics: new Metrics() });
  const make = (id, client, backend, sequence) => createJob({ id, client, backend, model: backend === 'comfy' ? 'comfyui:comfy' : 'od-model',
    pathname: '/prompt', durable: backend === 'comfy', sequence, body: Buffer.alloc(0) });
  const first = make('media-1', 'default', 'comfy', 1);
  const second = make('media-2', 'default', 'comfy', 2);
  const chat = make('chat', 'odysseus', 'ollama', 3);
  scheduler.enqueue(first);
  assert.equal(scheduler.take().job, first);
  scheduler.enqueue(second);
  scheduler.enqueue(chat);
  assert.equal(scheduler.take().job, null);
  scheduler.complete(first);
  assert.equal(scheduler.take().job, chat);
});
