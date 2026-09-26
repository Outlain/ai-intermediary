import assert from 'node:assert/strict';
import test from 'node:test';
import YAML from 'yaml';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mergeOverride, inspectIntermediary } from '../integrations/host/installer-compose.mjs';
import { hostConnectionError, HostHelperError } from '../src/host-helper.js';

test('installer merge creates only helper wiring and is idempotent', () => {
  const first = mergeOverride('', 993);
  const second = mergeOverride(first, 993);
  assert.equal(first, second);
  const result = YAML.parse(first).services['ai-intermediary'];
  assert.deepEqual(result.group_add, ['993']);
  assert.equal(result.environment.AUTO_RECOVERY_ENABLED, 'false');
  assert.equal(result.environment.HOST_HELPER_ENABLED, 'true');
  assert.equal(result.volumes[0].read_only, true);
  assert.equal(result.volumes[0].bind.create_host_path, false);
});

test('installer preserves existing services, comments, settings, groups and volume entries', () => {
  const source = `# keep my comment
services:
  ai-intermediary:
    ports: ["9999:11434"]
    group_add: ["44"]
    volumes: ["data:/app/state", "./config.yml:/app/config.yml:ro"]
    environment:
      LOG_LEVEL: debug
      EXAMPLE_VALUE: '\${KEEP_ME}'
  unrelated:
    image: example:keep
volumes:
  data: {}
`;
  const merged = mergeOverride(source, 993);
  assert.match(merged, /keep my comment/);
  const result = YAML.parse(merged);
  assert.equal(result.services.unrelated.image, 'example:keep');
  assert.deepEqual(result.services['ai-intermediary'].ports, ['9999:11434']);
  assert.deepEqual(result.services['ai-intermediary'].group_add, ['44', '993']);
  assert.deepEqual(result.services['ai-intermediary'].volumes.slice(0, 2), ['data:/app/state', './config.yml:/app/config.yml:ro']);
  assert.equal(result.services['ai-intermediary'].environment.EXAMPLE_VALUE, '${KEEP_ME}');
});

test('installer preserves list-style environment semantics including passthrough variables', () => {
  const result = YAML.parse(mergeOverride('services:\n  ai-intermediary:\n    environment: ["A=one=two", "FROM_HOST", "EMPTY="]\n', 1));
  assert.equal(result.services['ai-intermediary'].environment.A, 'one=two');
  assert.equal(result.services['ai-intermediary'].environment.FROM_HOST, null);
  assert.equal(result.services['ai-intermediary'].environment.EMPTY, '');
});

test('unsupported or ambiguous overrides fail instead of being overwritten', () => {
  for (const source of [
    'services: []', 'services:\n  ai-intermediary: false',
    'services:\n  ai-intermediary: {}\n  ai-intermediary: {}',
    'x-template: &base { environment: { X: yes } }\nservices:\n  ai-intermediary: *base',
    'services:\n  ai-intermediary:\n    environment: !reset {}',
    'services:\n  ai-intermediary:\n    environment: ["A=one", "A=two"]',
    'services:\n  ai-intermediary:\n    volumes: ["/elsewhere:/run/ai-intermediary-host:rw"]',
  ]) assert.throws(() => mergeOverride(source, 1));
  assert.throws(() => mergeOverride('', 'bad: group'), /invalid_helper_group/);
});

test('installer accepts an existing correct short helper mount without duplication', () => {
  const input = 'services:\n  ai-intermediary:\n    volumes: ["/run/ai-intermediary-host:/run/ai-intermediary-host:ro"]';
  assert.equal(YAML.parse(mergeOverride(input, 1)).services['ai-intermediary'].volumes.length, 1);
});

test('installer reads effective settings and status without returning tokens or unrelated data', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, token: options.headers.authorization });
    return { ok: true, json: async () => url.endsWith('/settings')
      ? { mode: 'running', valid: true, settings: { ollama: { url: 'http://192.0.2.10:11434' }, auto_recovery: { enabled: false }, unrelated: 'private' } }
      : { maintenance: { paused: true, control_available: true }, active_request: null, scheduler: {}, unrelated: 'private' } };
  };
  const result = await inspectIntermediary(fetcher, { ADMIN_TOKEN: 'admin-test' });
  assert.deepEqual(result, { origin: 'http://192.0.2.10:11434', paused: true, timed_pause: false, active: false, automatic_recovery: false, maintenance_configured: true });
  assert.equal(calls[0].token, 'Bearer admin-test');
  assert.equal(calls[1].token, 'Bearer admin-test');
  assert.doesNotMatch(JSON.stringify(result), /private|admin-test/);
});

test('installer targets only the canonical service', () => {
  const merged = YAML.parse(mergeOverride('services:\n  ai-intermediary:\n    image: local:test\n', 993, 'ai-intermediary'));
  assert.deepEqual(Object.keys(merged.services), ['ai-intermediary']);
  assert.equal(merged.services['ai-intermediary'].image, 'local:test');
  assert.deepEqual(merged.services['ai-intermediary'].group_add, ['993']);
  assert.throws(() => mergeOverride('', 993, 'unrelated'), /invalid_intermediary_service/);
  assert.throws(() => mergeOverride('', 993, 'ollama-scheduler'), /invalid_intermediary_service/);
});

test('installer prefers the single administrator credential for settings and telemetry', async () => {
  const credentials = [];
  const result = await inspectIntermediary(async (url, options) => {
    credentials.push(options.headers.authorization);
    return { ok: true, json: async () => url.endsWith('/settings')
      ? { mode: 'running', valid: true, settings: { ollama: { url: 'http://localhost:11434' }, auto_recovery: { enabled: false } } }
      : { maintenance: { paused: true, control_available: true }, scheduler: {} } };
  }, { ADMIN_TOKEN: 'private-admin', SETTINGS_TOKEN: 'obsolete-settings', OBSERVABILITY_TOKEN: 'obsolete-read' });
  assert.deepEqual(credentials, ['Bearer private-admin', 'Bearer private-admin']);
  assert.doesNotMatch(JSON.stringify(result), /private-admin|obsolete/);
});

test('installer refuses unauthenticated API and old/restarting intermediary', async () => {
  await assert.rejects(inspectIntermediary(async () => ({ ok: false }), { ADMIN_TOKEN: 'admin-test' }), /unauthorized/);
  await assert.rejects(inspectIntermediary(async () => ({ ok: true, json: async () => ({ mode: 'recovery', valid: false }) }), { ADMIN_TOKEN: 'admin-test' }), /update_intermediary_first/);
  await assert.rejects(inspectIntermediary(async () => { throw new Error('must not fetch'); }, { SETTINGS_TOKEN: 'old-test' }), /admin_token_required/);
});

test('connection diagnosis distinguishes missing mount, permissions and stopped listener without claiming host absence', () => {
  for (const [error, expected] of Object.entries({ ENOENT: 'host_helper_socket_missing', EACCES: 'host_helper_permission_denied',
    EPERM: 'host_helper_permission_denied', ECONNREFUSED: 'host_helper_not_listening', OTHER: 'host_helper_unreachable' })) {
    assert.equal(hostConnectionError({ code: error, message: 'private' }).code, expected);
  }
  const known = new HostHelperError('host_request_timeout');
  assert.equal(hostConnectionError(known), known);
});

test('the actual container command entrypoint merges stdin without exposing YAML parse errors', () => {
  const code = fs.readFileSync(new URL('../integrations/host/installer-compose.mjs', import.meta.url), 'utf8');
  const args = ['--input-type=module', '-e', code, '--', '--host-install'];
  const result = JSON.parse(execFileSync(process.execPath, args, {
    input: JSON.stringify({ mode: 'merge', yaml: '', gid: 993 }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  }));
  assert.deepEqual(YAML.parse(result.yaml).services['ai-intermediary'].group_add, ['993']);
  assert.throws(() => execFileSync(process.execPath, args, {
    input: JSON.stringify({ mode: 'merge', yaml: 'private: [SECRET_VALUE', gid: 993 }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  }), (error) => !String(error.stderr).includes('SECRET_VALUE') && String(error.stderr).includes('invalid_compose_override'));
});

test('real Compose config accepts the generated overlay without a Docker daemon', (t) => {
  try { execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' }); }
  catch { t.skip('Docker Compose CLI is not installed'); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'installer-compose-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const base = path.join(directory, 'docker-compose.yml');
  const override = path.join(directory, 'override.yml');
  fs.writeFileSync(base, 'services:\n  ai-intermediary:\n    image: installer-test-only:local\n    volumes: ["state:/app/state"]\nvolumes:\n  state: {}\n');
  fs.writeFileSync(override, mergeOverride('', 993));
  const effective = JSON.parse(execFileSync('docker', ['compose', '-p', 'installer-test-only', '-f', base, '-f', override,
    'config', '--format', 'json'], { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert.equal(effective.name, 'installer-test-only');
  const service = effective.services['ai-intermediary'];
  assert.deepEqual(service.group_add, ['993']);
  assert.equal(service.environment.AUTO_RECOVERY_ENABLED, 'false');
  assert.equal(service.volumes.find((v) => v.target === '/app/state').source, 'state');
  assert.equal(effective.volumes.state.name, 'installer-test-only_state');
  assert.equal(service.volumes.find((v) => v.target === '/run/ai-intermediary-host').read_only, true);
});
