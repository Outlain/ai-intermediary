import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  SECRET_MASK,
  SETTINGS_SCHEMA_VERSION,
  SettingsStore,
  SettingsValidationError,
  maskSettings,
  mergeSettingsOverrides,
  validateSettingsDraft,
} from '../src/settings.js';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-intermediary-settings-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    statePath: path.join(directory, 'settings.json'),
    environment: {
      OLLAMA_URL: 'http://192.0.2.10:11434',
      OBSERVABILITY_TOKEN: 'read-only-super-secret',
      MAINTENANCE_TOKEN: 'control-super-secret',
    },
    baseRaw: {
      ollama: {
        url: '${OLLAMA_URL:?missing OLLAMA_URL}',
        health_interval: '5s',
        health_timeout: '3s',
        request_timeout: '30m',
      },
      scheduler: { default_client: 'odysseus' },
      observability: {
        enabled: true,
        ui_enabled: true,
        auth_token: '${OBSERVABILITY_TOKEN:-}',
      },
      maintenance: {
        enabled: true,
        auth_token: '${MAINTENANCE_TOKEN:?missing maintenance token}',
      },
      clients: {
        default: {
          priority: 50,
          queue_limit: 20,
          request_ttl: '10m',
          max_wait: '5m',
          overflow_policy: 'reject',
          source_ips: [],
          model_policy: {
            idle_hold: '0s',
            max_batch_requests: 1,
            max_batch_time: '60s',
            keep_alive: null,
          },
        },
        odysseus: {
          priority: 100,
          queue_limit: 10,
          request_ttl: '30m',
          max_wait: '0s',
          overflow_policy: 'reject',
          source_ips: [],
          model_policy: { group: 'odysseus', idle_hold: '1m' },
        },
        frigate: {
          priority: 30,
          queue_limit: 20,
          request_ttl: '2m',
          max_wait: '2m',
          overflow_policy: 'drop_oldest',
          source_ips: ['192.0.2.20/32'],
          model_policy: { group: 'frigate', idle_hold: '3s' },
        },
      },
    },
  };
}

test('backend registry migration, source routing and removal round-trip without exposing media secrets', async (t) => {
  const options = fixture(t);
  options.baseRaw.media = { auth_token: 'private-media-token', state_path: '/app/state/private-media.json', storage_path: '/app/state/media' };
  const store = new SettingsStore(options); await store.load();
  const primary = store.snapshot().settings.backends.ollama;
  const registry = { ollama: primary, comfy: { type: 'comfyui', enabled: false, url: 'http://192.0.2.10:8188', resource_group: 'gpu0' } };
  await store.save({ backends: registry, clients: { media: { backend: 'comfy', allowed_backends: ['comfy'], priority: 50 } } });
  const restored = new SettingsStore(options); await restored.load();
  assert.equal(restored.getEffectiveConfig().clients.media.backend, 'comfy');
  assert.equal(restored.getEffectiveConfig().ollama.url, options.environment.OLLAMA_URL);
  assert.equal(restored.getEffectiveConfig().media.auth_token, 'private-media-token');
  assert.equal(restored.snapshot().secrets.media_token_configured, true);
  assert.equal(JSON.stringify(restored.snapshot()).includes('private-media-token'), false);
  assert.equal(fs.readFileSync(options.statePath, 'utf8').includes('private-media-token'), false);
  assert.equal(restored.validate({ backends: { comfy: null } }).valid, false, 'referenced backend cannot be removed');
  await restored.save({ backends: { comfy: null }, clients: { media: { backend: 'ollama', allowed_backends: ['ollama'] } } });
  const removed = new SettingsStore(options); await removed.load();
  assert.equal(removed.getEffectiveConfig().backends.comfy, undefined);
  assert.equal(removed.getEffectiveConfig().clients.odysseus.priority, 100);
});

test('removing a file-configured backend persists a tombstone and never silently recreates it', async (t) => {
  const options = fixture(t);
  options.baseRaw.backends = { ollama: { type: 'ollama', url: '${OLLAMA_URL}' },
    comfy: { type: 'comfyui', url: 'http://192.0.2.10:8188', enabled: false } };
  const store = new SettingsStore(options); await store.load();
  await store.save({ backends: { comfy: null } });
  assert.equal(JSON.parse(fs.readFileSync(options.statePath, 'utf8')).overrides.backends.comfy, null);
  const restored = new SettingsStore(options); await restored.load();
  assert.equal(restored.getEffectiveConfig().backends.comfy, undefined);
  assert.equal(restored.validate({ backends: { ollama: null } }).valid, false);
});

test('media settings expose safe policies but never permit browser-managed secrets or filesystem paths', (t) => {
  const options = fixture(t);
  for (const [field, value] of [['auth_token', 'browser-secret'], ['storage_path', '/tmp/output'], ['state_path', '/tmp/jobs']]) {
    const result = validateSettingsDraft({ ...options, draft: { media: { [field]: value } } });
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some((item) => item.path === `media.${field}`));
  }
  const result = validateSettingsDraft({ ...options, draft: { media: { retention: '24h', max_jobs: 20,
    max_idle_utilization_percent: 3, stable_samples: 4, allowed_node_types: ['KSampler'] } } });
  assert.equal(result.valid, true);
  assert.equal(result.settings.media.retention, '24h');
  assert.equal(result.settings.media.state_path, undefined);
  assert.equal(result.settings.media.auth_token, undefined);
  assert.equal(result.settings.media.pollIntervalMs, undefined);
  assert.deepEqual(maskSettings({ backends: { bad: { type: 'comfyui', url: 'http://user:secret@host:8188/?token=hidden' } } }).backends.bad,
    { type: 'comfyui', url: 'http://host:8188/' });
});

test('source policies and weekly schedules round-trip without replacing legacy fallback or secrets', async (t) => {
  const options = fixture(t);
  const store = new SettingsStore(options); await store.load();
  const before = store.getEffectiveConfig();
  const draft = { clients: { odysseus: { listener_port: 11436, header_enabled: false }, misc: { priority: 10, queue_while_paused: false } },
    work_policy: { timezone: 'America/New_York', schedules: { night: { enabled: true, days: ['mon','tue'], start: '01:00', end: '03:00', sources: ['frigate'], traffic: 'catchup', mode: 'pause' } } },
    frigate: { catchup_order: 'oldest_first' } };
  const result = store.validate(draft);
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  assert.equal(result.effectiveConfig.scheduler.default_client, before.scheduler.default_client);
  assert.equal(result.effectiveConfig.maintenance.auth_token, before.maintenance.auth_token);
  assert.equal(result.effectiveConfig.clients.odysseus.listener_port, 11436);
  assert.equal(result.effectiveConfig.work_policy.schedules.night.traffic, 'catchup');
  await store.save(draft);
  const restored = new SettingsStore(options); await restored.load();
  assert.deepEqual(restored.getEffectiveConfig(), result.effectiveConfig);
});

test('explicit open Frigate API mode is editable without a missing-credentials warning', (t) => {
  const options = fixture(t);
  const result = validateSettingsDraft({ ...options, draft: { frigate: { enabled: true, url: 'http://frigate.test:5000', auth_mode: 'none' } } });
  assert.equal(result.valid, true);
  assert.equal(result.settings.frigate.auth_mode, 'none');
  assert.equal(result.diagnostics.some((item) => item.code === 'frigate_credentials_missing'), false);
});

test('host monitoring and recovery controls are editable while socket and state paths stay host-managed', (t) => {
  const options = fixture(t);
  const result = validateSettingsDraft({ ...options, draft: {
    host_helper: { enabled: true, poll_interval: '10s', request_timeout: '20s', stale_after: '40s',
      memory_guard: { enabled: true, min_available_mb: 3072, rescue_min_available_mb: 6144, max_pressure_full_percent: 5 } },
    auto_recovery: { enabled: true, check_interval: '10s', restart_timeout: '2m', verification_timeout: '1m', cooldown: '10m', window: '2h', max_restarts: 1, stable_samples: 4, max_idle_vram_mb: 256 },
  } });
  assert.equal(result.valid, true);
  assert.equal(result.effectiveConfig.auto_recovery.cooldownMs, 600000);
  assert.equal(result.effectiveConfig.host_helper.pollIntervalMs, 10000);
  assert.equal(result.effectiveConfig.host_helper.memory_guard.min_available_mb, 3072);
  assert.equal(result.settings.host_helper.memory_guard.rescue_min_available_mb, 6144);
  assert.equal(result.settings.auto_recovery.enabled, true);
  assert.equal(result.settings.auto_recovery.state_path, undefined);
  assert.equal(result.settings.host_helper.socket_path, undefined);
  assert.equal(result.settings.auto_recovery.cooldownMs, undefined);
  for (const [section, field] of [['host_helper', 'socket_path'], ['auto_recovery', 'state_path']]) {
    const blocked = validateSettingsDraft({ ...options, draft: { [section]: { [field]: '/tmp/changed' } } });
    assert.equal(blocked.valid, false);
    assert.ok(blocked.diagnostics.some((item) => item.path === `${section}.${field}`));
  }
});

test('context rescue is an allowlisted opt-in setting requiring a tested model cap and monitoring', (t) => {
  const options = fixture(t);
  const draft = { host_helper: { enabled: true }, frigate: { enabled: true, url: 'http://frigate:5000',
    context_rescue: { enabled: true, model: 'qwen3-vl:8b-instruct', max_context: 90000, output_reserve: 2048, safety_margin: 1024 } } };
  const result = validateSettingsDraft({ ...options, draft });
  assert.equal(result.valid, true);
  assert.deepEqual(result.settings.frigate.context_rescue, draft.frigate.context_rescue);
  assert.equal(result.effectiveConfig.auto_recovery.enabled, false, 'service restarts are not required or enabled');
  const invalid = validateSettingsDraft({ ...options, draft: { frigate: { context_rescue: { enabled: true } } } });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.diagnostics.some((item) => item.path.startsWith('frigate.context_rescue')));
});

test('host recovery settings cannot bypass bounded safety or credential requirements', (t) => {
  const options = fixture(t);
  for (const draft of [
    { auto_recovery: { enabled: true } },
    { host_helper: { enabled: true }, auto_recovery: { enabled: true }, maintenance: { enabled: false } },
    { auto_recovery: { max_restarts: 3 } },
    { auto_recovery: { cooldown: '1m' } },
    { auto_recovery: { stable_samples: 1 } },
    { host_helper: { request_timeout: '61s' } },
  ]) assert.equal(validateSettingsDraft({ ...options, draft }).valid, false);
});

test('catch-up cadence, cleanup, history, and attention options are editable and preserve saved policies', (t) => {
  const options = fixture(t);
  options.baseRaw.frigate = { max_retry_interval: '1h', state_path: '/app/state/original-backlog.json' };
  const currentOverrides = { clients: { frigate: { model_policy: { keep_alive: '15s' } } } };
  const draft = { frigate: {
    confirmation_interval: '3s', cleanup_interval: '2m', cleanup_batch_size: 20,
    history_limit: 1500, attention_after: '24h', max_verifying: 6,
  } };
  const result = validateSettingsDraft({ ...options, currentOverrides, draft });
  assert.equal(result.valid, true);
  assert.equal(result.effectiveConfig.frigate.confirmationIntervalMs, 3000);
  assert.equal(result.effectiveConfig.frigate.cleanupIntervalMs, 120000);
  assert.equal(result.settings.frigate.cleanup_batch_size, 20);
  assert.equal(result.settings.frigate.history_limit, 1500);
  assert.equal(result.settings.frigate.max_verifying, 6);
  assert.equal(result.effectiveConfig.frigate.attentionAfterMs, 24 * 3600000);
  assert.equal(result.effectiveConfig.frigate.maxRetryIntervalMs, 3600000);
  assert.equal(result.effectiveConfig.frigate.state_path, '/app/state/original-backlog.json');
  assert.equal(result.settings.clients.frigate.model_policy.keep_alive, '15s');
  assert.equal(result.settings.frigate.confirmationIntervalMs, undefined);
  assert.equal(JSON.stringify(result).includes(options.environment.MAINTENANCE_TOKEN), false);
  assert.deepEqual(currentOverrides, { clients: { frigate: { model_policy: { keep_alive: '15s' } } } });
  const updated = validateSettingsDraft({ ...options, currentOverrides, draft: { frigate: { max_retry_interval: '5h' } } });
  assert.equal(updated.valid, true);
  assert.equal(updated.effectiveConfig.frigate.maxRetryIntervalMs, 5 * 3600000);
});

test('catch-up settings report all independent unsafe cadence and storage fields', (t) => {
  const result = validateSettingsDraft({ ...fixture(t), draft: { frigate: {
    confirmation_interval: '500ms', cleanup_interval: '9s', cleanup_batch_size: 101,
    history_limit: 5001, attention_after: '0s', max_verifying: 17,
  } } });
  assert.equal(result.valid, false);
  const invalid = result.diagnostics.filter((item) => item.severity === 'error');
  assert.deepEqual(invalid.map((item) => item.path).sort(), [
    'frigate.attention_after', 'frigate.cleanup_batch_size', 'frigate.cleanup_interval',
    'frigate.confirmation_interval', 'frigate.history_limit', 'frigate.max_verifying',
  ]);
  assert.ok(invalid.every((item) => item.code === 'out_of_range'));
});

test('short Frigate keep-alive is a non-blocking warning, not a silent policy change', (t) => {
  const options = fixture(t);
  const draft = { frigate: { enabled: true, url: 'http://frigate.test:5000', auth_mode: 'none' },
    clients: { frigate: { model_policy: { keep_alive: '1s' } } } };
  const result = validateSettingsDraft({ ...options, draft });
  assert.equal(result.valid, true);
  assert.equal(result.settings.clients.frigate.model_policy.keep_alive, '1s');
  const warning = result.diagnostics.find((item) => item.code === 'frigate_keep_alive_short');
  assert.equal(warning.severity, 'warning');
  assert.equal(warning.path, 'clients.frigate.model_policy.keep_alive');
  draft.clients.frigate.model_policy.keep_alive = '2m';
  const adequate = validateSettingsDraft({ ...options, draft });
  assert.equal(adequate.diagnostics.some((item) => item.code === 'frigate_keep_alive_short'), false);
});

test('model overrides support normal tags and namespaces without exposing Frigate credentials', () => {
  const baseRaw = {
    server: { listen: '127.0.0.1:0' },
    frigate: { url: 'https://frigate.example:8971', username: 'private-admin', password: 'very-secret', auth_token: 'private-token' },
    models: { 'namespace/qwen3-vl:8b': { idle_hold: '30s' } },
  };
  const result = validateSettingsDraft({ baseRaw, environment: null, draft: {
    models: { 'namespace/qwen3-vl:8b': { idle_hold: '1m' } },
    frigate: { enabled: true },
  } });
  assert.equal(result.valid, true);
  assert.equal(result.settings.models['namespace/qwen3-vl:8b'].idle_hold, '1m');
  assert.equal(result.effectiveConfig.frigate.password, 'very-secret');
  assert.doesNotMatch(JSON.stringify(result), /private-admin|very-secret|private-token/);
  for (const field of ['username', 'password', 'auth_token', 'state_path']) {
    const blocked = validateSettingsDraft({ baseRaw, environment: null, draft: { frigate: { [field]: 'not-allowed' } } });
    assert.equal(blocked.valid, false);
    assert.ok(blocked.diagnostics.some((item) => item.path === `frigate.${field}`));
  }
});

test('structured draft merges editable fields, expands the base environment, and masks secrets', (t) => {
  const { baseRaw, environment } = fixture(t);
  const result = validateSettingsDraft({
    baseRaw,
    environment,
    draft: {
      ollama: { health_timeout: '8s' },
      scheduler: { aging_bonus: 9 },
      clients: {
        frigate: {
          request_ttl: '8h',
          source_ips: ['198.51.100.7/32'],
        },
      },
    },
  });

  assert.equal(result.valid, true);
  assert.equal(result.effectiveConfig.ollama.url, 'http://192.0.2.10:11434');
  assert.equal(result.effectiveConfig.ollama.healthTimeoutMs, 8_000);
  assert.equal(result.effectiveConfig.clients.frigate.requestTtlMs, 8 * 60 * 60 * 1_000);
  assert.deepEqual(result.effectiveConfig.clients.frigate.source_ips, ['198.51.100.7/32']);
  assert.equal(result.effectiveConfig.observability.auth_token, environment.OBSERVABILITY_TOKEN);
  assert.equal(result.settings.observability.auth_token, undefined);
  assert.equal(JSON.stringify(result).includes(environment.OBSERVABILITY_TOKEN), false);
  assert.equal(JSON.stringify(result).includes(environment.MAINTENANCE_TOKEN), false);
  assert.deepEqual(result.overrides, {
    ollama: { health_timeout: '8s' },
    scheduler: { aging_bonus: 9 },
    clients: {
      frigate: { request_ttl: '8h', source_ips: ['198.51.100.7/32'] },
    },
  });
});

test('auth tokens, listener, state path, and Docker fields are read-only', (t) => {
  const { baseRaw, environment } = fixture(t);
  const result = validateSettingsDraft({
    baseRaw,
    environment,
    draft: {
      server: { listen: '0.0.0.0:9999' },
      observability: { auth_token: 'steal-me' },
      maintenance: { state_path: '/tmp/evil', auth_token: 'replace-me' },
      docker: { socket: '/var/run/docker.sock' },
    },
  });

  assert.equal(result.valid, false);
  assert.deepEqual(
    result.diagnostics.filter((item) => item.severity === 'error').map((item) => item.path).sort(),
    ['docker', 'maintenance.auth_token', 'maintenance.state_path', 'observability.auth_token', 'server.listen'],
  );
  assert.equal(JSON.stringify(result).includes('steal-me'), false);
  assert.equal(result.overrides.server?.listen, undefined);
  assert.equal(result.overrides.docker, undefined);
});

test('validation returns field-level diagnostics for independent and cross-field errors', (t) => {
  const { baseRaw, environment } = fixture(t);
  const result = validateSettingsDraft({
    baseRaw,
    environment,
    draft: {
      ollama: { url: 'not-a-url', health_interval: 'soon' },
      observability: { history_limit: 4, recent_events: 5 },
      clients: { frigate: { queue_limit: 0, overflow_policy: 'wait' } },
    },
  });

  assert.equal(result.valid, false);
  const byPath = new Map(result.diagnostics.map((item) => [item.path, item]));
  assert.equal(byPath.get('ollama.url').code, 'invalid_url');
  assert.equal(byPath.get('ollama.health_interval').code, 'invalid_duration');
  assert.equal(byPath.get('clients.frigate.queue_limit').code, 'out_of_range');
  assert.equal(byPath.get('clients.frigate.overflow_policy').code, 'invalid_choice');

  const crossField = validateSettingsDraft({
    baseRaw,
    environment,
    draft: { observability: { history_limit: 4, recent_events: 5 } },
  });
  assert.equal(crossField.valid, false);
  assert.equal(crossField.diagnostics.at(-1).path, 'observability.recent_events');
});

test('maskSettings does not expose bearer tokens while retaining safe editable values', (t) => {
  const { baseRaw, environment } = fixture(t);
  const effectiveRaw = mergeSettingsOverrides(baseRaw, {
    ollama: { request_timeout: '1h' },
  }, environment);
  const masked = maskSettings(effectiveRaw);
  assert.equal(masked.ollama.url, 'http://192.0.2.10:11434');
  assert.equal(masked.ollama.request_timeout, '1h');
  assert.equal(masked.observability.auth_token, undefined);
  assert.equal(JSON.stringify(masked).includes('super-secret'), false);
  assert.equal(SECRET_MASK, '********');

  const unsafeBase = structuredClone(effectiveRaw);
  unsafeBase.ollama.url = 'http://operator:never-return-this@192.0.2.10:11434';
  const redacted = maskSettings(unsafeBase);
  assert.equal(redacted.ollama.url, 'http://192.0.2.10:11434/');
  assert.equal(JSON.stringify(redacted).includes('never-return-this'), false);
});

test('store atomically persists only sanitized overrides with restrictive permissions', async (t) => {
  const { baseRaw, environment, statePath, directory } = fixture(t);
  const store = new SettingsStore({
    statePath,
    baseRaw,
    environment,
    clock: () => Date.parse('2026-08-31T12:00:00.000Z'),
  });
  const initial = await store.load();
  assert.equal(initial.valid, true);
  assert.equal(initial.revision, 0);
  assert.equal(initial.source, 'base');

  const saved = await store.save({
    ollama: { url: 'http://198.51.100.40:11434', request_timeout: '45m' },
    clients: { frigate: { max_wait: '12m' } },
  });
  assert.equal(saved.revision, 1);
  assert.equal(saved.settings.ollama.url, 'http://198.51.100.40:11434');
  assert.equal(saved.secrets.maintenance_token_configured, true);
  assert.equal(store.getEffectiveConfig().clients.frigate.maxWaitMs, 12 * 60_000);
  assert.equal(store.getEffectiveRaw().observability.auth_token, environment.OBSERVABILITY_TOKEN);

  const document = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(document.schema_version, SETTINGS_SCHEMA_VERSION);
  assert.equal(document.revision, 1);
  assert.deepEqual(document.overrides, {
    ollama: { url: 'http://198.51.100.40:11434', request_timeout: '45m' },
    clients: { frigate: { max_wait: '12m' } },
  });
  assert.equal(JSON.stringify(document).includes('super-secret'), false);
  assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(directory).filter((name) => name.includes('.tmp')), []);

  const restored = new SettingsStore({ statePath, baseRaw, environment });
  const restoredSnapshot = await restored.load();
  assert.equal(restoredSnapshot.source, 'persisted');
  assert.equal(restoredSnapshot.settings.ollama.request_timeout, '45m');
  assert.equal(restored.getEffectiveConfig().ollama.requestTimeoutMs, 45 * 60_000);
});

test('submitting the full effective UI document persists only values that differ from the base', async (t) => {
  const { baseRaw, environment, statePath } = fixture(t);
  const store = new SettingsStore({ statePath, baseRaw, environment });
  const initial = await store.load();
  const fullDocument = structuredClone(initial.settings);
  fullDocument.ollama.health_timeout = '9s';

  await store.save(fullDocument);
  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.deepEqual(persisted.overrides, { ollama: { health_timeout: '9s' } });
  assert.equal(store.snapshot().settings.server.body_limit_bytes, 64 * 1024 * 1024);
});

test('invalid drafts never replace the active last-known-good settings', async (t) => {
  const { baseRaw, environment, statePath } = fixture(t);
  const store = new SettingsStore({ statePath, baseRaw, environment });
  await store.load();
  await store.save({ clients: { frigate: { max_wait: '20m' } } });
  const before = fs.readFileSync(statePath, 'utf8');

  await assert.rejects(
    store.save({ clients: { frigate: { queue_limit: -1 } } }),
    (error) => {
      assert.ok(error instanceof SettingsValidationError);
      assert.equal(error.statusCode, 400);
      assert.equal(error.diagnostics[0].path, 'clients.frigate.queue_limit');
      return true;
    },
  );
  assert.equal(store.snapshot().revision, 1);
  assert.equal(store.getEffectiveConfig().clients.frigate.maxWaitMs, 20 * 60_000);
  assert.equal(fs.readFileSync(statePath, 'utf8'), before);
});

test('load falls back to the persisted previous version when the newest override is invalid', async (t) => {
  const { baseRaw, environment, statePath } = fixture(t);
  fs.writeFileSync(statePath, `${JSON.stringify({
    schema_version: SETTINGS_SCHEMA_VERSION,
    revision: 8,
    updated_at: '2026-08-31T12:00:00.000Z',
    overrides: { clients: { frigate: { queue_limit: 0 } } },
    previous_overrides: { clients: { frigate: { max_wait: '90m' } } },
  })}\n`, { mode: 0o600 });

  const store = new SettingsStore({ statePath, baseRaw, environment });
  const snapshot = await store.load();
  assert.equal(snapshot.source, 'last_known_good');
  assert.equal(snapshot.settings.clients.frigate.max_wait, '90m');
  assert.equal(store.getEffectiveConfig().clients.frigate.maxWaitMs, 90 * 60_000);
  assert.ok(snapshot.diagnostics.some((item) => item.code === 'settings_rolled_back'));
  assert.ok(snapshot.diagnostics.some((item) => item.path === 'clients.frigate.queue_limit'));
});

test('corrupt state fails visibly but keeps a valid base configuration available for recovery', async (t) => {
  const { baseRaw, environment, statePath } = fixture(t);
  fs.writeFileSync(statePath, '{bad-json', { mode: 0o600 });
  const store = new SettingsStore({ statePath, baseRaw, environment });
  const snapshot = await store.load();

  assert.equal(snapshot.source, 'base');
  assert.equal(snapshot.valid, false);
  assert.equal(snapshot.diagnostics[0].code, 'settings_state_unreadable');
  assert.equal(store.getEffectiveConfig().ollama.url, environment.OLLAMA_URL);

  const repaired = await store.save({ ollama: { health_timeout: '6s' } });
  assert.equal(repaired.valid, true);
  assert.equal(repaired.revision, 1);
  assert.equal(store.getEffectiveConfig().ollama.healthTimeoutMs, 6_000);
});

test('secret presence remains accurate when an unrelated setting forces recovery', async (t) => {
  const { baseRaw, environment, statePath } = fixture(t);
  baseRaw.ollama.url = 'not-a-url';
  const store = new SettingsStore({ statePath, baseRaw, environment });
  const snapshot = await store.load();

  assert.equal(snapshot.valid, false);
  assert.equal(snapshot.secrets.observability_token_configured, true);
  assert.equal(snapshot.secrets.maintenance_token_configured, true);
  assert.equal(JSON.stringify(snapshot).includes(environment.OBSERVABILITY_TOKEN), false);
  assert.equal(JSON.stringify(snapshot).includes(environment.MAINTENANCE_TOKEN), false);
});

test('storage writability follows the parent directory required for atomic rename', async (t) => {
  const { baseRaw, environment, directory } = fixture(t);
  const stateDirectory = path.join(directory, 'atomic-state');
  const statePath = path.join(stateDirectory, 'settings.json');
  fs.mkdirSync(stateDirectory, { mode: 0o700 });
  fs.writeFileSync(statePath, '{}', { mode: 0o400 });
  const store = new SettingsStore({ statePath, baseRaw, environment });

  assert.equal(store.storageStatus().writable, true);
  fs.chmodSync(stateDirectory, 0o500);
  try {
    assert.equal(store.storageStatus().writable, false);
  } finally {
    fs.chmodSync(stateDirectory, 0o700);
  }
});

test('rollback swaps the current and previous validated settings revisions', async (t) => {
  const { baseRaw, environment, statePath } = fixture(t);
  const store = new SettingsStore({ statePath, baseRaw, environment });
  await store.load();
  await store.save({ ollama: { request_timeout: '40m' } });
  await store.save({ ollama: { request_timeout: '50m' } });
  const rolledBack = await store.rollback();

  assert.equal(rolledBack.changed, true);
  assert.equal(rolledBack.revision, 3);
  assert.equal(rolledBack.settings.ollama.request_timeout, '40m');
  assert.equal(store.getEffectiveConfig().ollama.requestTimeoutMs, 40 * 60_000);
});

test('dangerous object keys cannot pollute prototypes or enter persisted overrides', (t) => {
  const { baseRaw, environment } = fixture(t);
  const draft = JSON.parse('{"clients":{"__proto__":{"priority":999},"frigate":{"priority":31}}}');
  const result = validateSettingsDraft({ baseRaw, environment, draft });
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((item) => item.code === 'forbidden_key'));
  assert.equal({}.priority, undefined);
  assert.equal(Object.prototype.priority, undefined);
  assert.equal(Object.hasOwn(result.overrides.clients, '__proto__'), false);
});
