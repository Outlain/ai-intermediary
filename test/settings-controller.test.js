import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { RecoveryService } from '../src/recovery.js';
import { SettingsController } from '../src/settings-controller.js';
import { SettingsStore } from '../src/settings.js';
import { SilentLogger, waitFor } from './helpers.js';
import { applyHostEnvironment } from '../src/config.js';
import { ProxyService } from '../src/proxy.js';
import { testConfig } from './helpers.js';

const SETTINGS_API = '/_intermediary/v1/settings';
const ADMIN_TOKEN = 'settings-admin-secret';
const OBSERVABILITY_TOKEN = 'observability-secret-value';
const MAINTENANCE_TOKEN = 'maintenance-secret-value';

function settingsFixture(t, Store = SettingsStore) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-settings-http-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new Store({
    statePath: path.join(directory, 'settings.json'),
    environment: {
      OBSERVABILITY_TOKEN,
      MAINTENANCE_TOKEN,
    },
    baseRaw: {
      ollama: {
        url: 'http://192.0.2.10:11434',
        health_interval: '5s',
        health_timeout: '3s',
        request_timeout: '30m',
      },
      observability: {
        enabled: true,
        ui_enabled: true,
        auth_token: '${OBSERVABILITY_TOKEN:?missing observability token}',
      },
      maintenance: {
        enabled: true,
        auth_token: '${MAINTENANCE_TOKEN:?missing maintenance token}',
      },
    },
    logger: new SilentLogger(),
  });
}

async function startControllerServer(t, controller) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://settings.test');
    controller.handle(request, response, url, 'settings-test-request').catch((error) => {
      response.statusCode = 500;
      response.end(error.message);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close();
    server.closeAllConnections?.();
    await once(server, 'close').catch(() => {});
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function bearer(token = ADMIN_TOKEN) {
  return { authorization: `Bearer ${token}` };
}

async function postJson(baseUrl, pathname, body, headers = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('settings API denies missing configuration and wrong credentials, then accepts the correct token', async (t) => {
  const store = settingsFixture(t);
  await store.load();

  const unconfiguredUrl = await startControllerServer(t, new SettingsController({
    store,
    token: '',
    logger: new SilentLogger(),
  }));
  const unconfigured = await fetch(`${unconfiguredUrl}${SETTINGS_API}`);
  assert.equal(unconfigured.status, 503);
  assert.equal((await unconfigured.json()).code, 'settings_auth_not_configured');

  const configuredUrl = await startControllerServer(t, new SettingsController({
    store,
    token: ADMIN_TOKEN,
    logger: new SilentLogger(),
  }));
  const missing = await fetch(`${configuredUrl}${SETTINGS_API}`);
  assert.equal(missing.status, 401);
  assert.match(missing.headers.get('www-authenticate'), /^Bearer /);

  const wrong = await fetch(`${configuredUrl}${SETTINGS_API}`, { headers: bearer('wrong-token') });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).code, 'unauthorized');

  const correct = await fetch(`${configuredUrl}${SETTINGS_API}`, { headers: bearer() });
  assert.equal(correct.status, 200);
  assert.equal((await correct.json()).revision, 0);
});

test('authenticated settings snapshot exposes safe values and secret presence, never secret contents', async (t) => {
  const store = settingsFixture(t);
  await store.load();
  const baseUrl = await startControllerServer(t, new SettingsController({
    store,
    token: ADMIN_TOKEN,
    logger: new SilentLogger(),
  }));

  const response = await fetch(`${baseUrl}${SETTINGS_API}`, { headers: bearer() });
  assert.equal(response.status, 200);
  const bodyText = await response.text();
  const body = JSON.parse(bodyText);
  assert.equal(body.settings.ollama.url, 'http://192.0.2.10:11434');
  assert.equal(body.secrets.observability_token_configured, true);
  assert.equal(body.secrets.maintenance_token_configured, true);
  assert.equal(body.infrastructure.secrets_editable, false);
  assert.equal(body.infrastructure.compose_editable, false);
  for (const secret of [ADMIN_TOKEN, OBSERVABILITY_TOKEN, MAINTENANCE_TOKEN]) {
    assert.equal(bodyText.includes(secret), false);
  }
});

test('single-admin settings snapshot exposes only authentication mode and rejects machine/legacy credentials', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-admin-http-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new SettingsStore({ statePath: path.join(directory, 'settings.json'), environment: null,
    baseRaw: applyHostEnvironment({ ollama: { url: 'http://192.0.2.10:11434' } }, { ADMIN_TOKEN: 'new-admin-private' }) });
  await store.load();
  const machine = store.getEffectiveConfig().media.auth_token;
  const url = await startControllerServer(t, new SettingsController({ store, token: 'obsolete-explicit-token',
    authentication: { mode: 'single_admin', admin_token: 'must-not-be-exposed' }, logger: new SilentLogger() }));
  for (const token of [machine, OBSERVABILITY_TOKEN, MAINTENANCE_TOKEN, 'obsolete-explicit-token']) {
    const denied = await fetch(`${url}${SETTINGS_API}`, { headers: bearer(token) });
    assert.equal(denied.status, 401);
    assert.deepEqual((await denied.json()).authentication, { mode: 'single_admin' });
  }
  const response = await fetch(`${url}${SETTINGS_API}`, { headers: bearer('new-admin-private') });
  assert.equal(response.status, 200);
  const text = await response.text();
  const body = JSON.parse(text);
  assert.deepEqual(body.authentication, { mode: 'single_admin' });
  assert.equal(body.settings.security, undefined);
  assert.equal(store.validate({ security: { admin_token: 'browser-replacement' } }).valid, false);
  for (const secret of ['new-admin-private', machine, 'must-not-be-exposed']) assert.equal(text.includes(secret), false);
});

test('direct ProxyService construction cannot retain legacy Frigate control access in single-admin mode', () => {
  const config = testConfig({ security: { admin_token: 'canonical-admin-secret' } });
  const service = new ProxyService(config, { logger: new SilentLogger(), settingsToken: 'obsolete-options-token',
    settingsController: { token: 'obsolete-controller-token' } });
  assert.equal(service.frigateController.controlToken, 'canonical-admin-secret');
  assert.equal(service.frigateController.readToken, 'canonical-admin-secret');
});

test('configuration recovery keeps the raw host-admin identity when unrelated configuration is invalid', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-admin-recovery-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const admin = 'host-admin-during-recovery';
  const store = new SettingsStore({ statePath: path.join(directory, 'settings.json'), environment: null,
    baseRaw: { security: { admin_token: admin }, ollama: { url: 'not-a-valid-backend-url' } } });
  await store.load();
  assert.equal(store.getEffectiveConfig(), null);
  assert.equal(store.getEffectiveRaw().security.admin_token, admin);
  const url = await startControllerServer(t, new SettingsController({ store, token: 'obsolete-legacy-settings',
    mode: 'configuration_error', logger: new SilentLogger() }));
  for (const token of ['', 'obsolete-legacy-settings']) {
    const response = await fetch(`${url}${SETTINGS_API}`, { headers: bearer(token) });
    assert.equal(response.status, 401);
  }
  const response = await fetch(`${url}${SETTINGS_API}`, { headers: bearer(admin) });
  assert.equal(response.status, 200);
  const text = await response.text();
  const body = JSON.parse(text);
  assert.equal(body.mode, 'configuration_error');
  assert.equal(body.valid, false);
  assert.deepEqual(body.authentication, { mode: 'single_admin' });
  assert.equal(text.includes(admin), false);
});

test('invalid raw host-admin credentials fail closed instead of enabling legacy recovery access', () => {
  for (const admin_token of [null, false, ' padded ', 'caf\u00e9', 'bad\nvalue']) {
    assert.throws(() => new SettingsController({
      store: { getEffectiveRaw: () => ({ security: { admin_token } }), getEffectiveConfig: () => null },
      token: 'obsolete-legacy-settings',
    }), /ADMIN_TOKEN/);
  }
});

test('settings snapshot disables browser mutations while a host-only error is blocking', async (t) => {
  const store = settingsFixture(t);
  await store.load();
  const baseUrl = await startControllerServer(t, new SettingsController({
    store,
    token: ADMIN_TOKEN,
    additionalDiagnostics: [{
      path: 'maintenance.auth_token',
      code: 'required_environment_missing',
      message: 'Set MAINTENANCE_TOKEN on the host.',
      severity: 'error',
    }],
    logger: new SilentLogger(),
  }));

  const response = await fetch(`${baseUrl}${SETTINGS_API}`, { headers: bearer() });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.valid, false);
  assert.equal(body.infrastructure.ui_can_apply, false);
});

test('validate reports field diagnostics without saving an invalid draft', async (t) => {
  const store = settingsFixture(t);
  await store.load();
  const baseUrl = await startControllerServer(t, new SettingsController({
    store,
    token: ADMIN_TOKEN,
    logger: new SilentLogger(),
  }));

  const response = await postJson(baseUrl, `${SETTINGS_API}/validate`, {
    settings: { ollama: { url: 'not-a-url' } },
  }, bearer());
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.valid, false);
  assert.ok(body.diagnostics.some((item) => item.path === 'ollama.url' && item.code === 'invalid_url'));
  assert.equal(body.revision, 0);
  assert.equal(store.snapshot().revision, 0);
  assert.equal(fs.existsSync(store.statePath), false);
});

test('apply requires the current revision and rejects a stale settings document', async (t) => {
  const store = settingsFixture(t);
  await store.load();
  let restartCalls = 0;
  const baseUrl = await startControllerServer(t, new SettingsController({
    store,
    token: ADMIN_TOKEN,
    logger: new SilentLogger(),
    onRestart: () => { restartCalls += 1; },
  }));
  const settings = { ollama: { health_timeout: '8s' } };

  const missing = await postJson(baseUrl, `${SETTINGS_API}/apply`, { settings }, bearer());
  assert.equal(missing.status, 428);
  assert.equal((await missing.json()).code, 'revision_required');

  const stale = await postJson(baseUrl, `${SETTINGS_API}/apply`, {
    revision: 99,
    settings,
  }, bearer());
  assert.equal(stale.status, 409);
  const staleBody = await stale.json();
  assert.equal(staleBody.code, 'stale_revision');
  assert.equal(staleBody.revision, 0);
  assert.equal(store.snapshot().revision, 0);
  assert.equal(restartCalls, 0);
});

test('only one concurrent apply commits and schedules exactly one restart', async (t) => {
  class SlowSettingsStore extends SettingsStore {
    async save(draft) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return super.save(draft);
    }
  }

  const store = settingsFixture(t, SlowSettingsStore);
  await store.load();
  let admissionStops = 0;
  let restartCalls = 0;
  const baseUrl = await startControllerServer(t, new SettingsController({
    store,
    token: ADMIN_TOKEN,
    logger: new SilentLogger(),
    onRestartPending: () => { admissionStops += 1; },
    onRestart: () => { restartCalls += 1; },
  }));

  const requests = [
    postJson(baseUrl, `${SETTINGS_API}/apply`, {
      revision: 0,
      settings: { ollama: { health_timeout: '8s' } },
    }, bearer()),
    postJson(baseUrl, `${SETTINGS_API}/apply`, {
      revision: 0,
      settings: { ollama: { health_timeout: '9s' } },
    }, bearer()),
  ];
  const responses = await Promise.all(requests);
  assert.deepEqual(responses.map((response) => response.status).sort(), [202, 409]);
  const bodies = await Promise.all(responses.map((response) => response.json()));
  assert.ok(bodies.some((body) => body.code === 'settings_busy'));
  await waitFor(() => restartCalls === 1);
  assert.equal(admissionStops, 1);
  assert.equal(restartCalls, 1);
  assert.equal(store.snapshot().revision, 1);
});

test('settings UI assets use restrictive CSP and do not load remote resources', async (t) => {
  const store = settingsFixture(t);
  await store.load();
  const baseUrl = await startControllerServer(t, new SettingsController({
    store,
    token: ADMIN_TOKEN,
    logger: new SilentLogger(),
  }));

  const page = await fetch(`${baseUrl}/settings`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  const html = await page.text();
  assert.doesNotMatch(html, /(?:src|href)\s*=\s*["']https?:\/\//i);
  assert.match(html, /id="rollback-button"/);
  assert.match(html, /id="reset-button"/);

  const cssResponse = await fetch(`${baseUrl}/_intermediary/ui/settings.css`);
  const scriptResponse = await fetch(`${baseUrl}/_intermediary/ui/settings.js`);
  assert.equal(cssResponse.status, 200);
  assert.equal(scriptResponse.status, 200);
  assert.equal(cssResponse.headers.get('content-security-policy'), "default-src 'none'");
  assert.equal(scriptResponse.headers.get('content-security-policy'), "default-src 'none'");
  assert.doesNotMatch(await cssResponse.text(), /url\(\s*["']?https?:\/\//i);
  assert.doesNotMatch(await scriptResponse.text(), /(?:fetch|import)\s*\(\s*["'`]https?:\/\//i);
});

test('authenticated reset repairs an unreadable saved override document without editing the base', async (t) => {
  const store = settingsFixture(t);
  fs.mkdirSync(path.dirname(store.statePath), { recursive: true });
  fs.writeFileSync(store.statePath, '{broken json', 'utf8');
  const loaded = await store.load();
  assert.equal(loaded.valid, false);
  assert.ok(loaded.diagnostics.some((item) => item.code === 'settings_state_unreadable'));

  let restartCalls = 0;
  const baseUrl = await startControllerServer(t, new SettingsController({
    store,
    token: ADMIN_TOKEN,
    logger: new SilentLogger(),
    onRestart: () => { restartCalls += 1; },
  }));
  const response = await postJson(baseUrl, `${SETTINGS_API}/reset`, {
    revision: loaded.revision,
    settings: {},
  }, bearer());
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.restart_required, true);
  assert.equal(body.restart_pending, true);
  await waitFor(() => restartCalls === 1);
  assert.equal(store.snapshot().valid, true);
  assert.equal(store.snapshot().source, 'base');
  assert.equal(JSON.parse(fs.readFileSync(store.statePath, 'utf8')).overrides.constructor, Object);
});

test('recovery listener stays observable but not ready and blocks all proxy traffic', async (t) => {
  const store = settingsFixture(t);
  await store.load();
  const controller = new SettingsController({
    store,
    token: ADMIN_TOKEN,
    mode: 'recovery',
    logger: new SilentLogger(),
  });
  const recovery = new RecoveryService({
    listen: '127.0.0.1:0',
    settingsController: controller,
    logger: new SilentLogger(),
  });
  const address = await recovery.start();
  t.after(() => recovery.stop());
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    status: 'ok',
    mode: 'configuration_error',
    settings_path: '/settings',
  });

  const ready = await fetch(`${baseUrl}/readyz`);
  assert.equal(ready.status, 503);
  assert.equal((await ready.json()).code, 'configuration_invalid');

  const proxy = await postJson(baseUrl, '/api/chat', {
    model: 'must-not-reach-ollama',
    messages: [{ role: 'user', content: 'test' }],
  });
  assert.equal(proxy.status, 503);
  assert.equal(proxy.headers.get('retry-after'), '30');
  assert.equal((await proxy.json()).code, 'configuration_invalid');

  const settingsPage = await fetch(`${baseUrl}/settings`);
  assert.equal(settingsPage.status, 200);
});
