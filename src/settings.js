import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expandEnvironment, normalizeConfig, parseDuration } from './config.js';

export const SETTINGS_SCHEMA_VERSION = 1;
export const SECRET_MASK = '********';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const NO_CHANGE = Symbol('no_change');

const descriptor = (type, options = {}) => Object.freeze({ type, ...options });
const duration = (options = {}) => descriptor('duration', options);
const integer = (options = {}) => descriptor('integer', options);
const number = (options = {}) => descriptor('number', options);
const boolean = (options = {}) => descriptor('boolean', options);
const string = (options = {}) => descriptor('string', options);
const stringArray = (options = {}) => descriptor('string_array', options);

const MODEL_POLICY_FIELDS = Object.freeze({
  group: string({ maxLength: 128 }),
  idle_hold: duration(),
  max_batch_requests: integer({ min: 1 }),
  max_batch_time: duration(),
  keep_alive: descriptor('nullable_duration'),
});

const CLIENT_FIELDS = Object.freeze({
  enabled: boolean(),
  header_enabled: boolean(),
  listener_port: integer({ min: 0, max: 65535 }),
  queue_while_paused: boolean(),
  priority: number(),
  queue_limit: integer({ min: 1 }),
  request_ttl: duration(),
  max_wait: duration(),
  overflow_policy: descriptor('enum', { values: ['reject', 'drop_newest', 'drop_oldest'] }),
  models: stringArray({ maxItems: 500, itemMaxLength: 256 }),
  source_ips: stringArray({ maxItems: 100, itemMaxLength: 128 }),
  model_policy: MODEL_POLICY_FIELDS,
  deduplication: Object.freeze({
    enabled: boolean(),
    headers: stringArray({ maxItems: 100, itemMaxLength: 256 }),
    json_fields: stringArray({ maxItems: 100, itemMaxLength: 256 }),
  }),
});

const EDITABLE_TREE = Object.freeze({
  server: Object.freeze({
    body_limit_bytes: integer({ min: 1, max: 1024 * 1024 * 1024 }),
    shutdown_grace: duration(),
    trusted_proxy: boolean(),
  }),
  ollama: Object.freeze({
    url: descriptor('url', { required: true, schemes: ['http:', 'https:'] }),
    health_interval: duration({ greaterThanZero: true }),
    health_timeout: duration({ greaterThanZero: true }),
    request_timeout: duration({ greaterThanZero: true }),
  }),
  scheduler: Object.freeze({
    mode: descriptor('enum', { values: ['strict_priority', 'balanced'] }),
    max_queue_bytes: integer({ min: 1, max: 1024 * 1024 * 1024 }),
    priority_aging: boolean(),
    aging_interval: duration({ greaterThanZero: true }),
    aging_bonus: number({ min: 0 }),
    default_client: string({ required: true, maxLength: 64 }),
    unknown_model_policy: descriptor('enum', { values: ['schedule', 'reject'] }),
  }),
  circuit_breaker: Object.freeze({
    failure_threshold: integer({ min: 1 }),
    failure_window: duration({ greaterThanZero: true }),
    open_duration: duration({ greaterThanZero: true }),
    queue_behavior: descriptor('enum', { values: ['hold', 'reject_new'] }),
  }),
  model_management: Object.freeze({
    enabled: boolean(),
  }),
  gpu_safety: Object.freeze({
    drain_active_disconnects: boolean(),
    unload_on_model_switch: boolean(),
    unload_timeout: duration({ greaterThanZero: true }),
    recovery_on_oom: boolean(),
    error_body_limit_bytes: integer({ min: 1, max: 16 * 1024 * 1024 }),
  }),
  host_helper: Object.freeze({
    enabled: boolean(),
    poll_interval: duration({ minMs: 1000, maxMs: 60000 }),
    request_timeout: duration({ minMs: 1000, maxMs: 60000 }),
    stale_after: duration({ minMs: 1000, maxMs: 300000 }),
    memory_guard: Object.freeze({ enabled: boolean(), min_available_mb: integer({ min: 256, max: 1048576 }),
      rescue_min_available_mb: integer({ min: 256, max: 1048576 }), max_pressure_full_percent: integer({ min: 1, max: 100 }) }),
  }),
  auto_recovery: Object.freeze({
    enabled: boolean(),
    check_interval: duration({ minMs: 1000, maxMs: 60000 }),
    restart_timeout: duration({ minMs: 10000, maxMs: 300000 }),
    verification_timeout: duration({ minMs: 10000, maxMs: 300000 }),
    cooldown: duration({ minMs: 300000, maxMs: 86400000 }),
    window: duration({ minMs: 3600000, maxMs: 604800000 }),
    max_restarts: integer({ min: 1, max: 2 }),
    stable_samples: integer({ min: 2, max: 10 }),
    max_idle_vram_mb: integer({ min: 64, max: 4096 }),
  }),
  observability: Object.freeze({
    enabled: boolean(),
    ui_enabled: boolean(),
    history_limit: integer({ min: 1, max: 1000 }),
    recent_events: integer({ min: 1, max: 1000 }),
    max_event_clients: integer({ min: 1, max: 100 }),
    queue_items_limit: integer({ min: 1, max: 500 }),
  }),
  maintenance: Object.freeze({
    enabled: boolean(),
    max_pause: duration({ greaterThanZero: true }),
  }),
  work_policy: Object.freeze({
    timezone: string({ required: true, maxLength: 100 }),
    schedules: Object.freeze({ $dynamic: Object.freeze({
      enabled: boolean(), days: stringArray({ maxItems: 7, itemMaxLength: 3 }),
      start: string({ required: true, maxLength: 5 }), end: string({ required: true, maxLength: 5 }),
      sources: stringArray({ maxItems: 100, itemMaxLength: 64 }),
      traffic: descriptor('enum', { values: ['all', 'live', 'catchup'] }),
      mode: descriptor('enum', { values: ['pause', 'release_gpu'] }),
    }) }),
  }),
  frigate: Object.freeze({
    enabled: boolean(),
    url: descriptor('url', { schemes: ['http:', 'https:'] }),
    auth_mode: descriptor('enum', { values: ['auto', 'none', 'password', 'token'] }),
    verify_tls: boolean(),
    poll_interval: duration({ greaterThanZero: true }),
    confirmation_interval: duration({ minMs: 1000 }),
    cleanup_interval: duration({ minMs: 10000 }),
    cleanup_batch_size: integer({ min: 1, max: 100 }),
    live_grace: duration(),
    retry_interval: duration({ greaterThanZero: true }),
    max_retry_interval: duration({ greaterThanZero: true }),
    attention_after: duration({ greaterThanZero: true }),
    request_timeout: duration({ greaterThanZero: true }),
    generation_timeout: duration({ greaterThanZero: true }),
    max_verifying: integer({ min: 1, max: 16 }),
    page_size: integer({ min: 1, max: 1000 }),
    max_jobs: integer({ min: 1, max: 100000 }),
    history_limit: integer({ min: 1, max: 5000 }),
    catchup_order: descriptor('enum', { values: ['newest_first', 'oldest_first'] }),
    safety_retry_interval: duration({ minMs: 5000, maxMs: 300000 }),
    context_rescue: Object.freeze({
      enabled: boolean(),
      model: string({ maxLength: 256 }),
      max_context: integer({ min: 0, max: 1048576 }),
      output_reserve: integer({ min: 256, max: 32768 }),
      safety_margin: integer({ min: 256, max: 32768 }),
    }),
  }),
  clients: Object.freeze({ $dynamic: CLIENT_FIELDS }),
  models: Object.freeze({ $dynamic: MODEL_POLICY_FIELDS, $modelNames: true }),
});

export const SETTINGS_SCHEMA = Object.freeze({
  schema_version: SETTINGS_SCHEMA_VERSION,
  editable: EDITABLE_TREE,
  read_only: Object.freeze([
    'server.listen',
    'server.status_path',
    'server.metrics_path',
    'server.dedicated_listeners',
    'scheduler.max_parallel_generations',
    'model_management.serialize_with_inference',
    'observability.auth_token',
    'maintenance.auth_token',
    'maintenance.state_path',
    'gpu_safety.state_path',
    'host_helper.socket_path',
    'auto_recovery.state_path',
    'frigate.state_path',
    'frigate.username',
    'frigate.password',
    'frigate.auth_token',
    'docker.compose',
    'docker.socket',
  ]),
  notes: Object.freeze({
    compose: 'Docker Compose is intentionally read-only and is never mounted or edited by the service.',
    restart: 'Source listeners start after a safe restart. Docker port publication, volumes and runtime changes remain host-admin tasks.',
  }),
});

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function safeKey(key) {
  return !FORBIDDEN_KEYS.has(key);
}

function validDynamicName(key, schemaNode) {
  return safeKey(key) && (schemaNode.$modelNames
    ? /^[^\s\x00-\x1f\x7f]{1,256}$/.test(key)
    : NAME_RE.test(key));
}

function deepMerge(base, overlay) {
  if (!plainObject(overlay)) return clone(overlay);
  const result = plainObject(base) ? clone(base) : {};
  for (const [key, value] of Object.entries(overlay)) {
    if (!safeKey(key)) continue;
    result[key] = plainObject(value) ? deepMerge(result[key], value) : clone(value);
  }
  return result;
}

function settingsDifference(value, base) {
  if (Array.isArray(value)) {
    return Array.isArray(base) && JSON.stringify(value) === JSON.stringify(base) ? NO_CHANGE : clone(value);
  }
  if (plainObject(value)) {
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      const difference = settingsDifference(child, plainObject(base) ? base[key] : undefined);
      if (difference !== NO_CHANGE) output[key] = difference;
    }
    return Object.keys(output).length ? output : NO_CHANGE;
  }
  return Object.is(value, base) ? NO_CHANGE : clone(value);
}

/** Merge validated overrides with the supplied raw file configuration. */
export function mergeSettingsOverrides(baseRaw = {}, overrides = {}, environment = process.env) {
  const expandedBase = environment === null
    ? clone(baseRaw)
    : expandObjectEnvironment(clone(baseRaw), environment);
  return deepMerge(expandedBase, clone(overrides));
}

function expandObjectEnvironment(value, environment) {
  if (typeof value === 'string') return expandEnvironment(value, environment);
  if (Array.isArray(value)) return value.map((item) => expandObjectEnvironment(item, environment));
  if (!plainObject(value)) return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (safeKey(key)) result[key] = expandObjectEnvironment(child, environment);
  }
  return result;
}

function diagnostic(pathValue, code, message, severity = 'error') {
  return { path: pathValue || '$', code, message, severity };
}

function validateDescriptor(value, field, spec, diagnostics) {
  const invalid = (code, message) => diagnostics.push(diagnostic(field, code, message));
  switch (spec.type) {
    case 'boolean':
      if (typeof value !== 'boolean') invalid('invalid_type', 'Must be true or false.');
      break;
    case 'integer':
      if (!Number.isInteger(value)) invalid('invalid_type', 'Must be a whole number.');
      else if (spec.min !== undefined && value < spec.min) invalid('out_of_range', `Must be at least ${spec.min}.`);
      else if (spec.max !== undefined && value > spec.max) invalid('out_of_range', `Must not exceed ${spec.max}.`);
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) invalid('invalid_type', 'Must be a finite number.');
      else if (spec.min !== undefined && value < spec.min) invalid('out_of_range', `Must be at least ${spec.min}.`);
      else if (spec.max !== undefined && value > spec.max) invalid('out_of_range', `Must not exceed ${spec.max}.`);
      break;
    case 'string':
      if (typeof value !== 'string') invalid('invalid_type', 'Must be text.');
      else if (spec.required && value.trim() === '') invalid('required', 'A value is required.');
      else if (spec.maxLength && value.length > spec.maxLength) invalid('too_long', `Must be at most ${spec.maxLength} characters.`);
      break;
    case 'duration':
      try {
        const milliseconds = parseDuration(value, field);
        if (spec.greaterThanZero && milliseconds <= 0) invalid('out_of_range', 'Must be greater than zero.');
        else if (spec.minMs !== undefined && milliseconds < spec.minMs) invalid('out_of_range', `Must be at least ${spec.minMs / 1000}s.`);
        else if (spec.maxMs !== undefined && milliseconds > spec.maxMs) invalid('out_of_range', `Must not exceed ${spec.maxMs / 1000}s.`);
      } catch {
        invalid('invalid_duration', 'Use a duration such as 500ms, 20s, 5m, or 2h.');
      }
      break;
    case 'nullable_duration':
      if (value !== null) {
        try {
          parseDuration(value, field);
        } catch {
          invalid('invalid_duration', 'Use a duration such as 30s or 5m, or leave it empty.');
        }
      }
      break;
    case 'enum':
      if (!spec.values.includes(value)) invalid('invalid_choice', `Choose one of: ${spec.values.join(', ')}.`);
      break;
    case 'string_array':
      if (!Array.isArray(value)) {
        invalid('invalid_type', 'Must be a list of text values.');
      } else if (spec.maxItems && value.length > spec.maxItems) {
        invalid('too_many_items', `Must contain no more than ${spec.maxItems} items.`);
      } else {
        value.forEach((item, index) => {
          if (typeof item !== 'string') diagnostics.push(diagnostic(`${field}.${index}`, 'invalid_type', 'Must be text.'));
          else if (spec.itemMaxLength && item.length > spec.itemMaxLength) {
            diagnostics.push(diagnostic(`${field}.${index}`, 'too_long', `Must be at most ${spec.itemMaxLength} characters.`));
          }
        });
      }
      break;
    case 'url':
      if (value === '' && !spec.required) break;
      if (typeof value !== 'string' || (spec.required && value.trim() === '')) {
        invalid('required', 'A URL is required.');
      } else {
        try {
          const parsed = new URL(value);
          if (spec.schemes && !spec.schemes.includes(parsed.protocol)) invalid('invalid_url', 'Use an http:// or https:// URL.');
        } catch {
          invalid('invalid_url', 'Enter a valid URL, including http:// or https://.');
        }
      }
      break;
    default:
      invalid('schema_error', 'This field has an unsupported settings type.');
  }
}

function sanitizeNode(input, schemaNode, field, diagnostics, currentNode) {
  if (!plainObject(input)) {
    diagnostics.push(diagnostic(field, 'invalid_type', 'Must be an object.'));
    return {};
  }
  const output = {};
  const dynamicSchema = schemaNode.$dynamic;
  for (const [key, value] of Object.entries(input)) {
    const childField = field ? `${field}.${key}` : key;
    if (!safeKey(key)) {
      diagnostics.push(diagnostic(childField, 'forbidden_key', 'This key is not allowed.'));
      continue;
    }
    let childSchema = schemaNode[key];
    if (!childSchema && dynamicSchema) {
      if (!validDynamicName(key, schemaNode)) {
        diagnostics.push(diagnostic(childField, 'invalid_name', schemaNode.$modelNames
          ? 'Model names must be 1–256 characters without whitespace or control characters.'
          : 'Names may contain letters, numbers, dots, dashes, and underscores.'));
        continue;
      }
      childSchema = dynamicSchema;
    }
    if (!childSchema || key.startsWith('$')) {
      diagnostics.push(diagnostic(childField, 'read_only_or_unknown', 'This setting is unknown or read-only and cannot be changed here.'));
      continue;
    }
    if (childSchema.type) {
      // A masked secret sent back by the UI means "leave the existing value alone".
      if (childSchema.secret && value === SECRET_MASK) continue;
      validateDescriptor(value, childField, childSchema, diagnostics);
      output[key] = clone(value);
    } else {
      const currentChild = plainObject(currentNode) ? currentNode[key] : undefined;
      output[key] = sanitizeNode(value, childSchema, childField, diagnostics, currentChild);
    }
  }
  return output;
}

function redact(message, secretValues = []) {
  let result = typeof message === 'string' ? message : 'Configuration validation failed.';
  for (const secret of secretValues) {
    if (typeof secret === 'string' && secret.length > 0) result = result.split(secret).join(SECRET_MASK);
  }
  return result.replace(/(https?:\/\/[^\s:@/]+:)[^@\s/]+@/gi, `$1${SECRET_MASK}@`);
}

function inferPath(message) {
  const match = String(message).match(/\b(server|ollama|scheduler|circuit_breaker|model_management|gpu_safety|observability|maintenance|work_policy|frigate|clients|models)(?:\.[A-Za-z0-9_.-]+)+/);
  return match?.[0] ?? '$';
}

function secretValues(value, output = []) {
  if (!plainObject(value)) return output;
  for (const [key, child] of Object.entries(value)) {
    if (/token|secret|password|api[_-]?key/i.test(key) && typeof child === 'string') output.push(child);
    else if (plainObject(child)) secretValues(child, output);
  }
  return output;
}

function projectEditable(value, schemaNode = EDITABLE_TREE) {
  if (!plainObject(value)) return {};
  const output = {};
  const dynamicSchema = schemaNode.$dynamic;
  for (const [key, child] of Object.entries(value)) {
    let childSchema = schemaNode[key];
    if (!childSchema && dynamicSchema && validDynamicName(key, schemaNode)) childSchema = dynamicSchema;
    if (!childSchema || key.startsWith('$')) continue;
    if (childSchema.type) output[key] = clone(child);
    else output[key] = projectEditable(child, childSchema);
  }
  return output;
}

function maskNode(value, schemaNode = EDITABLE_TREE) {
  if (!plainObject(value)) return value;
  const output = {};
  const dynamicSchema = schemaNode.$dynamic;
  for (const [key, child] of Object.entries(value)) {
    const childSchema = schemaNode[key] ?? dynamicSchema;
    if (!childSchema || key === '$dynamic') continue;
    if (childSchema.type) output[key] = childSchema.secret && child ? SECRET_MASK : clone(child);
    else output[key] = maskNode(child, childSchema);
  }
  return output;
}

export function maskSettings(raw) {
  const masked = maskNode(projectEditable(raw));
  for (const section of ['ollama', 'frigate']) {
    if (typeof masked?.[section]?.url === 'string') {
      try {
        const parsed = new URL(masked[section].url);
        if (parsed.username || parsed.password || parsed.search || parsed.hash) {
          parsed.username = '';
          parsed.password = '';
          parsed.search = '';
          parsed.hash = '';
          masked[section].url = parsed.toString();
        }
      } catch {
        masked[section].url = masked[section].url.replace(
          /^(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/i,
          '$1',
        );
      }
    }
  }
  return masked;
}

function operationalDiagnostics(raw, effectiveConfig) {
  const diagnostics = [];
  if (raw?.frigate?.enabled && raw.frigate.verify_tls === false) {
    diagnostics.push(diagnostic('frigate.verify_tls', 'tls_verification_disabled',
      'Frigate TLS certificate verification is disabled. Use only on a trusted network; credentials can be intercepted.', 'warning'));
  }
  if (raw?.frigate?.enabled && raw.frigate.auth_mode !== 'none' && !raw.frigate.auth_token && (!raw.frigate.username || !raw.frigate.password)) {
    diagnostics.push(diagnostic('frigate.authentication', 'frigate_credentials_missing',
      'No Frigate credentials are configured. For an intentionally open trusted API, select No login required in Frigate authentication.', 'warning'));
  }
  const policy = effectiveConfig?.clients?.frigate?.model_policy;
  // Only compare duration strings: native numeric keep_alive values have
  // different units from the intermediary's numeric duration fields.
  if (effectiveConfig?.frigate?.enabled && typeof policy?.keep_alive === 'string') {
    try {
      const keepAliveMs = parseDuration(policy.keep_alive);
      const expectedGapMs = effectiveConfig.frigate.confirmationIntervalMs + policy.idleHoldMs;
      if (keepAliveMs < expectedGapMs) {
        diagnostics.push(diagnostic('clients.frigate.model_policy.keep_alive', 'frigate_keep_alive_short',
          'Frigate keep-alive is shorter than its confirmation interval plus idle hold and may cause extra model loads between catch-up jobs. Consider 2m; exact-model overrides may differ. This is not a scheduling-priority change.', 'warning'));
      }
    } catch { /* Invalid durations are reported by configuration validation. */ }
  }
  if (raw?.maintenance?.enabled && !raw.maintenance.auth_token) {
    diagnostics.push(diagnostic(
      'maintenance.auth_token',
      'missing_control_token',
      'Pause controls are enabled but unavailable until a separate maintenance token is configured.',
      'warning',
    ));
  }
  if (raw?.observability?.enabled && raw.observability.ui_enabled && !raw.observability.auth_token) {
    diagnostics.push(diagnostic(
      'observability.auth_token',
      'unprotected_dashboard',
      'The dashboard has no bearer token. Only leave it blank on a network you fully trust.',
      'warning',
    ));
  }
  return diagnostics;
}

/**
 * Validate an editable patch without mutating either source object. Only schema
 * fields are copied, so a browser cannot smuggle Docker, listener, or derived
 * runtime properties into the persisted document.
 */
export function validateSettingsDraft({
  baseRaw = {},
  currentOverrides = {},
  draft = {},
  environment = process.env,
  normalize = normalizeConfig,
} = {}) {
  const diagnostics = [];
  const safeCurrent = sanitizeNode(currentOverrides, EDITABLE_TREE, '', diagnostics, {});
  // Stored overrides should already be valid. Keep their diagnostics, but label
  // them separately from new draft fields for recovery screens.
  for (const item of diagnostics) item.code = `stored_${item.code}`;
  const draftDiagnostics = [];
  const sanitizedPatch = sanitizeNode(draft, EDITABLE_TREE, '', draftDiagnostics, safeCurrent);
  diagnostics.push(...draftDiagnostics);
  const mergedOverrides = deepMerge(safeCurrent, sanitizedPatch);

  let expandedBase;
  let candidateRaw;
  let effectiveConfig = null;
  try {
    // A null environment explicitly means the caller supplied a source whose
    // scalar values were already expanded. This avoids recursively interpreting
    // literal ${NAME} text contained inside an environment variable's value.
    expandedBase = environment === null
      ? clone(baseRaw)
      : expandObjectEnvironment(clone(baseRaw), environment);
    candidateRaw = deepMerge(expandedBase, mergedOverrides);
  } catch (error) {
    diagnostics.push(diagnostic('$', 'environment_error', redact(error.message, secretValues(baseRaw))));
  }

  if (!diagnostics.some((item) => item.severity === 'error') && candidateRaw) {
    try {
      effectiveConfig = normalize(candidateRaw);
    } catch (error) {
      const secrets = secretValues(candidateRaw);
      diagnostics.push(diagnostic(
        inferPath(error.message),
        'invalid_configuration',
        redact(error.message, secrets),
      ));
    }
  }

  const displayRaw = candidateRaw ?? expandedBase ?? {};
  diagnostics.push(...operationalDiagnostics(displayRaw, effectiveConfig));
  const valid = !diagnostics.some((item) => item.severity === 'error');
  const settings = maskSettings(effectiveConfig ?? displayRaw);
  let overrides = mergedOverrides;
  try {
    const baseSettings = maskSettings(normalize(expandedBase));
    const difference = settingsDifference(settings, baseSettings);
    overrides = difference === NO_CHANGE ? {} : difference;
  } catch {
    // A recovery draft may be the thing that repairs an invalid base. Until the
    // base itself normalizes, retain the sanitized patch rather than guessing
    // which values came from defaults.
  }
  const result = {
    valid,
    diagnostics,
    overrides,
    settings,
  };
  // The normalized runtime config can contain bearer tokens. Keep it available
  // to trusted server code without allowing an accidental JSON response or log
  // statement to serialize those secrets.
  Object.defineProperty(result, 'effectiveConfig', {
    value: valid ? effectiveConfig : null,
    enumerable: false,
  });
  return result;
}

export class SettingsValidationError extends Error {
  constructor(diagnostics) {
    super('Settings validation failed.');
    this.name = 'SettingsValidationError';
    this.statusCode = 400;
    this.code = 'invalid_settings';
    this.diagnostics = diagnostics;
  }
}

function emptyState() {
  return {
    revision: 0,
    overrides: {},
    previousOverrides: null,
    updatedAt: null,
    source: 'base',
    storageDiagnostics: [],
  };
}

export class SettingsStore {
  constructor({
    statePath = '/app/state/settings.json',
    baseRaw = {},
    environment = process.env,
    normalize = normalizeConfig,
    clock = () => Date.now(),
    logger,
  } = {}) {
    if (typeof statePath !== 'string' || !path.isAbsolute(statePath)) {
      throw new TypeError('settings statePath must be an absolute path');
    }
    this.statePath = statePath;
    this.baseRaw = clone(baseRaw);
    this.environment = environment;
    this.normalize = normalize;
    this.clock = clock;
    this.logger = logger;
    this.state = emptyState();
    this.effectiveConfig = null;
    this.loaded = false;
    this.mutation = Promise.resolve();
  }

  async load() {
    return this.runMutation(async () => {
      let document;
      try {
        document = JSON.parse(await fs.promises.readFile(this.statePath, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') {
          this.state.storageDiagnostics = [diagnostic(
            '$',
            'settings_state_unreadable',
            `Saved settings could not be read; the last known base configuration remains active: ${redact(error.message)}`,
          )];
          this.logger?.error('saved settings could not be read; using base configuration', { error: error.message });
        }
        return this.activateLoaded({}, null, 0, null, 'base');
      }

      if (!plainObject(document) || document.schema_version !== SETTINGS_SCHEMA_VERSION) {
        this.state.storageDiagnostics = [diagnostic('$', 'unsupported_settings_state', 'Saved settings use an unsupported format; the base configuration remains active.')];
        return this.activateLoaded({}, null, 0, null, 'base');
      }

      const overrides = plainObject(document.overrides) ? document.overrides : {};
      const previous = plainObject(document.previous_overrides) ? document.previous_overrides : null;
      const currentResult = this.validate(overrides, {});
      if (currentResult.valid) {
        return this.activateLoaded(overrides, previous, document.revision, document.updated_at, 'persisted');
      }

      if (previous) {
        const previousResult = this.validate(previous, {});
        if (previousResult.valid) {
          this.state.storageDiagnostics = [diagnostic(
            '$',
            'settings_rolled_back',
            'The newest saved settings were invalid, so the previous last-known-good settings were restored.',
            'warning',
          ), ...currentResult.diagnostics.map((item) => ({
            ...item,
            code: `ignored_${item.code}`,
            severity: 'warning',
          }))];
          return this.activateLoaded(previous, null, Number(document.revision) || 0, document.updated_at, 'last_known_good');
        }
      }

      this.state.storageDiagnostics = [diagnostic(
        '$',
        'saved_settings_invalid',
        'Saved settings were invalid and no usable previous version was available; the base configuration remains active.',
      ), ...currentResult.diagnostics];
      return this.activateLoaded({}, null, Number(document.revision) || 0, null, 'base');
    });
  }

  activateLoaded(overrides, previous, revision, updatedAt, source) {
    const existingStorage = this.state.storageDiagnostics;
    const result = this.validate(overrides, {});
    this.state = {
      revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
      overrides: clone(overrides),
      previousOverrides: clone(previous),
      updatedAt: typeof updatedAt === 'string' ? updatedAt : null,
      source,
      storageDiagnostics: existingStorage,
    };
    this.effectiveConfig = result.effectiveConfig;
    this.loaded = true;
    return this.snapshot();
  }

  validate(draft = {}, currentOverrides = this.state.overrides) {
    return validateSettingsDraft({
      baseRaw: this.baseRaw,
      currentOverrides,
      draft,
      environment: this.environment,
      normalize: this.normalize,
    });
  }

  async save(draft = {}) {
    return this.runMutation(async () => {
      const result = this.validate(draft);
      if (!result.valid) throw new SettingsValidationError(result.diagnostics);
      const previousOverrides = clone(this.state.overrides);
      const next = {
        revision: this.state.revision + 1,
        overrides: result.overrides,
        previousOverrides,
        updatedAt: new Date(this.clock()).toISOString(),
      };
      await this.persist(next);
      this.state = { ...next, source: 'persisted', storageDiagnostics: [] };
      this.effectiveConfig = result.effectiveConfig;
      this.loaded = true;
      return this.snapshot();
    });
  }

  async rollback() {
    return this.runMutation(async () => {
      if (!this.state.previousOverrides) return { changed: false, ...this.snapshot() };
      const result = this.validate(this.state.previousOverrides, {});
      if (!result.valid) throw new SettingsValidationError(result.diagnostics);
      const next = {
        revision: this.state.revision + 1,
        overrides: result.overrides,
        previousOverrides: clone(this.state.overrides),
        updatedAt: new Date(this.clock()).toISOString(),
      };
      await this.persist(next);
      this.state = { ...next, source: 'last_known_good', storageDiagnostics: [] };
      this.effectiveConfig = result.effectiveConfig;
      return { changed: true, ...this.snapshot() };
    });
  }

  async reset() {
    return this.runMutation(async () => {
      const result = this.validate({}, {});
      if (!result.valid) throw new SettingsValidationError(result.diagnostics);
      const next = {
        revision: this.state.revision + 1,
        overrides: {},
        previousOverrides: clone(this.state.overrides),
        updatedAt: new Date(this.clock()).toISOString(),
      };
      await this.persist(next);
      this.state = { ...next, source: 'base', storageDiagnostics: [] };
      this.effectiveConfig = result.effectiveConfig;
      this.loaded = true;
      return this.snapshot();
    });
  }

  getEffectiveConfig() {
    return this.effectiveConfig;
  }

  /** Internal/runtime accessor. Never serialize this object in an HTTP response. */
  getEffectiveRaw() {
    return mergeSettingsOverrides(this.baseRaw, this.state.overrides, this.environment);
  }

  snapshot() {
    const result = this.validate({}, this.state.overrides);
    const storage = this.storageStatus();
    let effectiveRaw = {};
    try {
      effectiveRaw = this.getEffectiveRaw();
    } catch {
      // Secret presence is advisory in a broken environment. Validation
      // diagnostics still explain the actual configuration error.
    }
    const diagnostics = [...this.state.storageDiagnostics, ...result.diagnostics];
    if (!storage.writable) {
      diagnostics.unshift(diagnostic(
        'settings.state',
        'settings_state_not_writable',
        'The settings state location is not writable. Check the /app/state volume on the host.',
        'warning',
      ));
    }
    return {
      schema_version: SETTINGS_SCHEMA_VERSION,
      revision: this.state.revision,
      source: this.state.source,
      updated_at: this.state.updatedAt,
      valid: result.valid && !this.state.storageDiagnostics.some((item) => item.severity === 'error'),
      settings: result.settings,
      secrets: {
        observability_token_configured: Boolean(effectiveRaw?.observability?.auth_token),
        maintenance_token_configured: Boolean(effectiveRaw?.maintenance?.auth_token),
      },
      diagnostics,
      has_previous: Boolean(this.state.previousOverrides),
      compose_editable: false,
      storage,
    };
  }

  storageStatus() {
    const stateExists = fs.existsSync(this.statePath);
    let readable = true;
    if (stateExists) {
      try {
        fs.accessSync(this.statePath, fs.constants.R_OK);
      } catch {
        readable = false;
      }
    }
    // Atomic persistence writes a sibling temporary file and renames it over
    // the target, so directory permissions—not the target file's write bit—are
    // authoritative. If the directory does not exist yet, probe the nearest
    // existing ancestor that mkdir would need to extend.
    let probe = path.dirname(this.statePath);
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    try {
      fs.accessSync(probe, fs.constants.W_OK | fs.constants.X_OK);
      return { writable: true, readable, persistent_path: this.statePath };
    } catch {
      return { writable: false, readable, persistent_path: this.statePath };
    }
  }

  runMutation(operation) {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.catch(() => {});
    return result;
  }

  async persist(state) {
    const directory = path.dirname(this.statePath);
    await fs.promises.mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `.settings-${process.pid}-${randomUUID()}.tmp`);
    const body = `${JSON.stringify({
      schema_version: SETTINGS_SCHEMA_VERSION,
      revision: state.revision,
      updated_at: state.updatedAt,
      overrides: state.overrides,
      previous_overrides: state.previousOverrides,
    }, null, 2)}\n`;
    let handle;
    try {
      handle = await fs.promises.open(temporary, 'wx', 0o600);
      await handle.writeFile(body, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.promises.rename(temporary, this.statePath);
      await fs.promises.chmod(this.statePath, 0o600);
      // Persist the directory entry as well as the file contents where supported.
      let directoryHandle;
      try {
        directoryHandle = await fs.promises.open(directory, 'r');
        await directoryHandle.sync();
      } catch (error) {
        if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code)) throw error;
      } finally {
        await directoryHandle?.close().catch(() => {});
      }
    } finally {
      await handle?.close().catch(() => {});
      await fs.promises.unlink(temporary).catch((error) => {
        if (error.code !== 'ENOENT') this.logger?.warn('failed to remove temporary settings file', { error: error.message });
      });
    }
  }
}
