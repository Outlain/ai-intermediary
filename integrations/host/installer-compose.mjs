// Runs inside the existing intermediary container, using its installed YAML
// parser. Tokens stay in that container; only selected non-secret fields leave.
import fs from 'node:fs';
import YAML from 'yaml';
import dns from 'node:dns/promises';

const fail = (code) => { throw new Error(code); };
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function mergeOverride(source, gid, serviceName = 'ai-intermediary') {
  if (!/^\d{1,10}$/.test(String(gid))) fail('invalid_helper_group');
  if (serviceName !== 'ai-intermediary') fail('invalid_intermediary_service');
  const doc = YAML.parseDocument(source || '', { uniqueKeys: true });
  if (doc.errors.length) fail('invalid_compose_override');
  if (doc.contents === null) doc.contents = doc.createNode({});
  // Refuse inherited/shared mappings rather than silently changing anchors or
  // dropping custom tags. The manual guide handles advanced Compose layouts.
  YAML.visit(doc, {
    Alias() { fail('compose_alias_requires_manual_setup'); },
    Node(_key, node) { if (node.tag) fail('compose_tag_requires_manual_setup'); },
  });
  if (!YAML.isMap(doc.contents)) fail('compose_override_must_be_mapping');
  for (const keys of [['services'], ['services', serviceName]]) {
    const node = doc.getIn(keys, true);
    if (node === undefined) doc.setIn(keys, doc.createNode({}));
    else if (!YAML.isMap(node)) fail('compose_service_must_be_mapping');
  }
  const base = ['services', serviceName];
  const js = doc.toJS({ maxAliasCount: 0 });
  const service = js.services[serviceName];
  const groups = service.group_add ?? [];
  if (!Array.isArray(groups)) fail('compose_groups_must_be_list');
  if (!groups.some((v) => String(v) === String(gid))) doc.setIn([...base, 'group_add'], doc.createNode([...groups, String(gid)]));
  const volumes = service.volumes ?? [];
  if (!Array.isArray(volumes)) fail('compose_volumes_must_be_list');
  const target = '/run/ai-intermediary-host';
  const existing = volumes.filter((v) => typeof v === 'string' ? v.split(':')[1] === target : v?.target === target);
  if (existing.length > 1) fail('conflicting_helper_mount');
  if (existing.length) {
    const v = existing[0];
    if (typeof v === 'string' ? v !== `${target}:${target}:ro`
      : v.type !== 'bind' || v.source !== target || v.read_only !== true) fail('conflicting_helper_mount');
  } else {
    doc.setIn([...base, 'volumes'], doc.createNode([...volumes, {
      type: 'bind', source: target, target, read_only: true, bind: { create_host_path: false },
    }]));
  }
  let env = service.environment ?? {};
  if (Array.isArray(env)) {
    const converted = Object.create(null);
    for (const entry of env) {
      if (typeof entry !== 'string' || !entry.length) fail('invalid_environment_entry');
      const separator = entry.indexOf('=');
      const key = separator < 0 ? entry : entry.slice(0, separator);
      if (!key || Object.hasOwn(converted, key)) fail('duplicate_environment_entry');
      converted[key] = separator < 0 ? null : entry.slice(separator + 1);
    }
    env = converted;
    doc.setIn([...base, 'environment'], doc.createNode(env));
  } else if (!object(env)) fail('environment_must_be_mapping_or_list');
  if (service.environment === undefined) doc.setIn([...base, 'environment'], doc.createNode({}));
  for (const [key, value] of Object.entries({ HOST_HELPER_ENABLED: 'true',
    HOST_HELPER_SOCKET_PATH: `${target}/control.sock`, AUTO_RECOVERY_ENABLED: 'false' })) {
    doc.setIn([...base, 'environment', key], value);
  }
  return String(doc);
}

export async function inspectIntermediary(fetcher = fetch, env = process.env) {
  if (typeof env.ADMIN_TOKEN !== 'string' || !env.ADMIN_TOKEN.trim()) fail('admin_token_required');
  async function get(route, token) {
    const response = await fetcher(`http://127.0.0.1:11434${route}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) fail('intermediary_api_unavailable_or_unauthorized');
    return response.json();
  }
  const settings = await get('/_intermediary/v1/settings', env.ADMIN_TOKEN);
  const status = await get('/_intermediary/v1/status', env.ADMIN_TOKEN);
  if (settings.mode !== 'running' || !settings.valid || settings.restart_pending
    || typeof settings.settings?.auto_recovery?.enabled !== 'boolean') fail('update_intermediary_first');
  return { origin: settings.settings.ollama.url, paused: status.maintenance?.paused === true,
    timed_pause: Boolean(status.maintenance?.resume_at),
    active: Boolean(status.active_request || status.scheduler?.management_active || status.scheduler?.management_pending),
    automatic_recovery: settings.settings.auto_recovery.enabled,
    maintenance_configured: status.maintenance?.control_available === true };
}

async function verifyInContainer() {
  const state = await inspectIntermediary();
  const { HostHelperClient } = await import('/app/src/host-helper.js');
  const helper = new HostHelperClient({ ollama: { url: state.origin }, host_helper: {
    enabled: true, socket_path: '/run/ai-intermediary-host/control.sock',
    requestTimeoutMs: 15000, staleAfterMs: 30000,
  } });
  try {
    const hardware = await helper.refresh();
    return { ...state, telemetry_verified: hardware.available && hardware.bound
      && hardware.gpus.every((gpu) => gpu.processes_known) };
  } finally { helper.stop(); }
}

if (process.argv[1] === '--host-install') {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const result = input.mode === 'inspect' ? await inspectIntermediary()
      : input.mode === 'verify' ? await verifyInContainer()
      : input.mode === 'resolve' ? { addresses: (await dns.lookup(new URL(input.origin).hostname.replace(/^\[|\]$/g, ''), { all: true })).map((entry) => entry.address) }
      : input.mode === 'merge' ? { yaml: mergeOverride(input.yaml, input.gid, input.service) } : fail('invalid_installer_mode');
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    // Parsing and HTTP exceptions can contain private YAML or response bodies.
    const code = /^[a-z][a-z_]{0,79}$/.test(error.message) ? error.message : 'installer_container_check_failed';
    process.stderr.write(code + '\n');
    process.exitCode = 1;
  }
}
