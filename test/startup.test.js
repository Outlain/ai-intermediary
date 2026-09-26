import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETTINGS_API = '/_intermediary/v1/settings';
const ADMIN_TOKEN = 'startup-test-administrator-password';

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const stopped = new Promise((resolve) => child.once('exit', resolve));
  let timeoutHandle;
  const timeout = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve('timeout'), 2_000);
  });
  const result = await Promise.race([stopped, timeout]);
  clearTimeout(timeoutHandle);
  if (result === 'timeout' && child.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

async function startIntermediary(t, configText, environment = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-intermediary-startup-'));
  const configPath = path.join(directory, 'config.yml');
  const settingsPath = path.join(directory, 'state', 'settings.json');
  fs.writeFileSync(configPath, configText, 'utf8');

  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: REPOSITORY_ROOT,
    env: {
      ...process.env,
      CONFIG_PATH: configPath,
      SETTINGS_PATH: settingsPath,
      SETTINGS_RECOVERY_LISTEN: '127.0.0.1:0',
      ADMIN_TOKEN,
      LOG_LEVEL: 'info',
      ...environment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  let output = '';
  let stdoutBuffer = '';
  const collect = (chunk, parseJson = false) => {
    const text = chunk.toString('utf8');
    output += text;
    if (!parseJson) return;
    stdoutBuffer += text;
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        logs.push(JSON.parse(line));
      } catch {
        // Retain non-JSON output in `output` for a useful assertion failure.
      }
    }
  };
  child.stdout.on('data', (chunk) => collect(chunk, true));
  child.stderr.on('data', (chunk) => collect(chunk));

  // A child importing the application can take several seconds when the full
  // test suite is CPU-bound, even though startup itself does no blocking work.
  const waitForLog = async (message, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const entry = logs.find((item) => item.message === message);
      if (entry) return entry;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`intermediary exited before ${JSON.stringify(message)}\n${output}`);
      }
      await delay(10);
    }
    throw new Error(`timed out waiting for ${JSON.stringify(message)}\n${output}`);
  };

  t.after(async () => {
    await stopChild(child);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { child, logs, waitForLog, output: () => output };
}

function authenticatedHeaders() {
  return { authorization: `Bearer ${ADMIN_TOKEN}` };
}

const VALID_CONFIG = `
server:
  listen: 127.0.0.1:0
  shutdown_grace: 100ms
ollama:
  url: http://127.0.0.1:1
  health_interval: 50ms
  health_timeout: 50ms
  request_timeout: 2s
maintenance:
  enabled: false
observability:
  enabled: false
  ui_enabled: false
`;

test('valid configuration starts the normal proxy and exposes settings in running mode', async (t) => {
  const instance = await startIntermediary(t, VALID_CONFIG);
  const started = await instance.waitForLog('proxy listener started');
  const baseUrl = `http://127.0.0.1:${started.address.port}`;

  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });

  const settings = await fetch(`${baseUrl}${SETTINGS_API}`, { headers: authenticatedHeaders() });
  assert.equal(settings.status, 200);
  const snapshot = await settings.json();
  assert.equal(snapshot.mode, 'running');
  assert.equal(snapshot.valid, true);
  assert.equal(snapshot.infrastructure.compose_editable, false);
  assert.equal(instance.logs.some((entry) => entry.message === 'configuration recovery listener started'), false);
});

test('official startup refuses missing ADMIN_TOKEN even when old role credentials exist', async (t) => {
  const instance = await startIntermediary(t, VALID_CONFIG, {
    ADMIN_TOKEN: '', SETTINGS_TOKEN: 'old-settings', OBSERVABILITY_TOKEN: 'old-read',
    MAINTENANCE_TOKEN: 'old-maintenance', MEDIA_TOKEN: 'old-media',
  });
  await assert.rejects(instance.waitForLog('proxy listener started'), /ADMIN_TOKEN is required/);
  assert.notEqual(instance.child.exitCode, 0);
  assert.equal(instance.logs.some((entry) => entry.message === 'configuration recovery listener started'), false);
  assert.doesNotMatch(instance.output(), /old-settings|old-read|old-maintenance|old-media/);
});

test('one ADMIN_TOKEN secures all administrative endpoints without exposing secrets', async (t) => {
  const admin = 'startup-single-admin-private';
  const instance = await startIntermediary(t, `
server:
  listen: 127.0.0.1:0
  shutdown_grace: 100ms
ollama:
  url: http://127.0.0.1:1
  health_interval: 50ms
  health_timeout: 50ms
maintenance:
  enabled: true
  auth_token: "\${MAINTENANCE_TOKEN:?required legacy credential}"
observability:
  enabled: true
  auth_token: "\${OBSERVABILITY_TOKEN:?required legacy credential}"
media:
  auth_token: "\${MEDIA_TOKEN:?required legacy credential}"
`, { ADMIN_TOKEN: admin, MAINTENANCE_TOKEN: '', OBSERVABILITY_TOKEN: '', MEDIA_TOKEN: '' });
  const started = await instance.waitForLog('proxy listener started');
  const base = `http://127.0.0.1:${started.address.port}`;
  const headers = { authorization: `Bearer ${admin}` };
  const response = await fetch(`${base}${SETTINGS_API}`, { headers });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, 'running');
  assert.equal(body.valid, true);
  assert.deepEqual(body.authentication, { mode: 'single_admin' });
  assert.equal(body.diagnostics.some((item) => item.code === 'required_environment_missing'), false);
  assert.equal(JSON.stringify(body).includes(admin), false);
  assert.equal((await fetch(`${base}${SETTINGS_API}`, { headers: authenticatedHeaders() })).status, 401);
  const status = await fetch(`${base}/_intermediary/v1/status`, { headers });
  assert.equal(status.status, 200);
  assert.equal((await status.text()).includes(admin), false);
  const maintenance = await fetch(`${base}/_intermediary/v1/maintenance/pause`, { headers });
  assert.equal(maintenance.status, 405, 'the same credential reaches method validation without mutating pause state');
  assert.equal((await fetch(`${base}/_intermediary/v1/status`)).status, 401);
});

test('host environment opt-ins are parsed strictly and invalid values enter host-fix recovery', async (t) => {
  const instance = await startIntermediary(t, VALID_CONFIG, { HOST_HELPER_ENABLED: '"1"' });
  const started = await instance.waitForLog('configuration recovery listener started');
  const response = await fetch(`http://127.0.0.1:${started.address.port}${SETTINGS_API}`, { headers: authenticatedHeaders() });
  const snapshot = await response.json();
  assert.equal(snapshot.mode, 'configuration_error');
  assert.ok(snapshot.diagnostics.some((item) => item.code === 'invalid_host_environment'));
});

test('explicit false environment recovery opt-in does not enable host operations', async (t) => {
  const instance = await startIntermediary(t, VALID_CONFIG, { HOST_HELPER_ENABLED: 'false', AUTO_RECOVERY_ENABLED: '0' });
  const started = await instance.waitForLog('proxy listener started');
  const response = await fetch(`http://127.0.0.1:${started.address.port}${SETTINGS_API}`, { headers: authenticatedHeaders() });
  const snapshot = await response.json();
  assert.equal(snapshot.settings.host_helper.enabled, false);
  assert.equal(snapshot.settings.auto_recovery.enabled, false);
});

test('startup expands environment-backed YAML values exactly once', async (t) => {
  const literalToken = 'literal-${NESTED_VALUE}-token';
  const instance = await startIntermediary(t, `
server:
  listen: 127.0.0.1:0
ollama:
  url: http://127.0.0.1:1
maintenance:
  enabled: true
  auth_token: "\${MAINTENANCE_TOKEN:?required}"
observability:
  enabled: false
  ui_enabled: false
`, {
    ADMIN_TOKEN: literalToken,
    MAINTENANCE_TOKEN: literalToken,
    NESTED_VALUE: 'must-not-replace',
  });
  const started = await instance.waitForLog('proxy listener started');
  const response = await fetch(`http://127.0.0.1:${started.address.port}/_intermediary/v1/maintenance/pause`, {
    headers: { authorization: `Bearer ${literalToken}` },
  });
  assert.equal(response.status, 405);
});

test('an editable missing Ollama URL starts recovery, blocks proxy traffic, and validates a repair', async (t) => {
  const instance = await startIntermediary(t, `
server:
  listen: 127.0.0.1:0
ollama:
  url: "\${OLLAMA_URL:?Set OLLAMA_URL}"
maintenance:
  enabled: false
observability:
  enabled: false
  ui_enabled: false
`, { OLLAMA_URL: '' });
  const started = await instance.waitForLog('configuration recovery listener started');
  const baseUrl = `http://127.0.0.1:${started.address.port}`;

  const ready = await fetch(`${baseUrl}/readyz`);
  assert.equal(ready.status, 503);
  assert.equal((await ready.json()).code, 'configuration_invalid');

  const proxy = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'must-not-run', messages: [] }),
  });
  assert.equal(proxy.status, 503);
  assert.equal(proxy.headers.get('retry-after'), '30');
  assert.equal((await proxy.json()).code, 'configuration_invalid');

  const settings = await fetch(`${baseUrl}${SETTINGS_API}`, { headers: authenticatedHeaders() });
  const snapshot = await settings.json();
  assert.equal(settings.status, 200);
  assert.equal(snapshot.mode, 'configuration_error');
  assert.equal(snapshot.infrastructure.ui_can_apply, true);
  assert.ok(snapshot.diagnostics.some((item) => (
    item.path === 'ollama.url'
      && item.code === 'required_environment_missing'
      && item.ui_fixable === true
  )));

  const validation = await fetch(`${baseUrl}${SETTINGS_API}/validate`, {
    method: 'POST',
    headers: { ...authenticatedHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { ollama: { url: 'http://127.0.0.1:1' } } }),
  });
  assert.equal(validation.status, 200);
  assert.equal((await validation.json()).valid, true);
  assert.equal(instance.child.exitCode, null);
});

test('malformed YAML serves host-fix-only recovery and refuses browser apply', async (t) => {
  const instance = await startIntermediary(t, 'server:\n  listen: [not valid YAML\n');
  const started = await instance.waitForLog('configuration recovery listener started');
  const baseUrl = `http://127.0.0.1:${started.address.port}`;

  const settingsPage = await fetch(`${baseUrl}/settings`);
  assert.equal(settingsPage.status, 200);

  const settings = await fetch(`${baseUrl}${SETTINGS_API}`, { headers: authenticatedHeaders() });
  const snapshot = await settings.json();
  assert.equal(settings.status, 200);
  assert.equal(snapshot.mode, 'configuration_error');
  assert.equal(snapshot.infrastructure.ui_can_apply, false);
  assert.ok(snapshot.diagnostics.some((item) => item.code === 'base_configuration_unreadable'));

  const apply = await fetch(`${baseUrl}${SETTINGS_API}/apply`, {
    method: 'POST',
    headers: { ...authenticatedHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({
      revision: snapshot.revision,
      settings: { ollama: { url: 'http://127.0.0.1:1' } },
    }),
  });
  assert.equal(apply.status, 409);
  assert.equal((await apply.json()).code, 'host_configuration_fix_required');
  assert.equal(instance.child.exitCode, null);
});
