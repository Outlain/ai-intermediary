import fs from 'node:fs';
import { BlockList, isIP } from 'node:net';
import YAML from 'yaml';
import { validateWorkPolicy } from './work-policy.js';
import { applyAuthentication, configuredAdminToken } from './auth.js';

const DURATION_RE = /^([0-9]+(?:\.[0-9]+)?)(ms|s|m|h)$/;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function parseDuration(value, field = 'duration') {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_TIMER_DELAY_MS) return value;
  if (typeof value !== 'string') throw new Error(`${field} must be a duration such as 500ms, 20s, or 30m`);
  const match = DURATION_RE.exec(value.trim());
  if (!match) throw new Error(`${field} has invalid duration ${JSON.stringify(value)}`);
  const factors = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  const milliseconds = Number(match[1]) * factors[match[2]];
  if (!Number.isFinite(milliseconds) || milliseconds > MAX_TIMER_DELAY_MS) {
    throw new Error(`${field} must not exceed ${MAX_TIMER_DELAY_MS}ms`);
  }
  return milliseconds;
}

const DEFAULTS = {
  server: {
    listen: '0.0.0.0:11434',
    body_limit_bytes: 64 * 1024 * 1024,
    shutdown_grace: '2m',
    trusted_proxy: false,
    status_path: '/status',
    metrics_path: '/metrics',
    dedicated_listeners: [],
  },
  ollama: {
    url: 'http://127.0.0.1:11434',
    health_interval: '5s',
    health_timeout: '3s',
    request_timeout: '30m',
  },
  media: {
    enabled: false,
    state_path: '/app/state/media-jobs.json',
    storage_path: '/app/state/media',
    auth_token: '',
    poll_interval: '2s',
    job_timeout: '6h',
    retention: '168h',
    max_storage_bytes: 10 * 1024 ** 3,
    max_jobs: 100,
    max_workflow_bytes: 2 * 1024 ** 2,
    max_output_bytes: 1024 ** 3,
    max_idle_vram_mb: 512,
    max_idle_utilization_percent: 5,
    stable_samples: 3,
    allowed_node_types: [],
  },
  scheduler: {
    mode: 'strict_priority',
    max_queue_bytes: 64 * 1024 * 1024,
    max_parallel_generations: 1,
    priority_aging: true,
    aging_interval: '10s',
    aging_bonus: 5,
    default_client: 'default',
    unknown_model_policy: 'schedule',
  },
  circuit_breaker: {
    failure_threshold: 3,
    failure_window: '60s',
    open_duration: '30s',
    queue_behavior: 'hold',
  },
  model_management: {
    enabled: true,
    serialize_with_inference: true,
  },
  gpu_safety: {
    state_path: '',
    drain_active_disconnects: true,
    unload_on_model_switch: true,
    unload_timeout: '30s',
    recovery_on_oom: true,
    error_body_limit_bytes: 65_536,
  },
  host_helper: {
    enabled: false,
    socket_path: '/run/ai-intermediary-host/control.sock',
    poll_interval: '5s',
    request_timeout: '15s',
    stale_after: '30s',
    memory_guard: { enabled: true, min_available_mb: 2048, rescue_min_available_mb: 4096, max_pressure_full_percent: 10 },
  },
  auto_recovery: {
    enabled: false,
    state_path: '/app/state/auto-recovery.json',
    check_interval: '5s',
    restart_timeout: '90s',
    verification_timeout: '60s',
    cooldown: '5m',
    window: '1h',
    max_restarts: 2,
    stable_samples: 3,
    max_idle_vram_mb: 512,
  },
  observability: {
    enabled: true,
    ui_enabled: true,
    auth_token: '',
    history_limit: 100,
    recent_events: 20,
    max_event_clients: 10,
    queue_items_limit: 50,
  },
  maintenance: {
    enabled: true,
    auth_token: '',
    max_pause: '168h',
    state_path: '/app/state/maintenance.json',
  },
  work_policy: { timezone: 'America/New_York', schedules: {} },
  frigate: {
    enabled: false,
    url: '',
    auth_mode: 'auto',
    username: '',
    password: '',
    auth_token: '',
    verify_tls: true,
    state_path: '/app/state/frigate-backlog.json',
    poll_interval: '30s',
    confirmation_interval: '2s',
    cleanup_interval: '1m',
    cleanup_batch_size: 25,
    live_grace: '2m',
    retry_interval: '1m',
    max_retry_interval: '5h',
    attention_after: '24h',
    request_timeout: '15s',
    generation_timeout: '10m',
    max_verifying: 4,
    page_size: 100,
    max_jobs: 10000,
    history_limit: 1000,
    catchup_order: 'newest_first',
    safety_retry_interval: '30s',
    context_rescue: {
      enabled: false,
      model: '',
      max_context: 0,
      output_reserve: 2048,
      safety_margin: 1024,
    },
  },
  clients: {
    default: {
      enabled: true,
      header_enabled: true,
      listener_port: 0,
      queue_while_paused: false,
      priority: 50,
      queue_limit: 20,
      request_ttl: '10m',
      max_wait: '5m',
      overflow_policy: 'reject',
      models: [],
      source_ips: [],
      model_policy: {
        idle_hold: '0s',
        max_batch_requests: 1,
        max_batch_time: '60s',
        keep_alive: null,
      },
    },
  },
  models: {},
};

function clone(value) {
  return structuredClone(value);
}

export function deepMerge(base, overlay) {
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) return overlay ?? base;
  const result = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? deepMerge(base?.[key] ?? {}, value)
      : value;
  }
  return result;
}

function durationFields(config) {
  config.server.shutdownGraceMs = parseDuration(config.server.shutdown_grace, 'server.shutdown_grace');
  config.ollama.healthIntervalMs = parseDuration(config.ollama.health_interval, 'ollama.health_interval');
  config.ollama.healthTimeoutMs = parseDuration(config.ollama.health_timeout, 'ollama.health_timeout');
  config.ollama.requestTimeoutMs = parseDuration(config.ollama.request_timeout, 'ollama.request_timeout');
  config.scheduler.agingIntervalMs = parseDuration(config.scheduler.aging_interval, 'scheduler.aging_interval');
  config.circuit_breaker.failureWindowMs = parseDuration(config.circuit_breaker.failure_window, 'circuit_breaker.failure_window');
  config.circuit_breaker.openDurationMs = parseDuration(config.circuit_breaker.open_duration, 'circuit_breaker.open_duration');
  config.gpu_safety.unloadTimeoutMs = parseDuration(config.gpu_safety.unload_timeout, 'gpu_safety.unload_timeout');
  config.maintenance.maxPauseMs = parseDuration(config.maintenance.max_pause, 'maintenance.max_pause');
  for (const [section, fields] of Object.entries({
    media: { poll_interval: 'pollIntervalMs', job_timeout: 'jobTimeoutMs', retention: 'retentionMs' },
    host_helper: { poll_interval: 'pollIntervalMs', request_timeout: 'requestTimeoutMs', stale_after: 'staleAfterMs' },
    auto_recovery: {
      check_interval: 'checkIntervalMs', restart_timeout: 'restartTimeoutMs', verification_timeout: 'verificationTimeoutMs',
      cooldown: 'cooldownMs', window: 'windowMs',
    },
  })) {
    for (const [field, derived] of Object.entries(fields)) config[section][derived] = parseDuration(config[section][field], `${section}.${field}`);
  }
  for (const [field, derived] of Object.entries({
    poll_interval: 'pollIntervalMs', live_grace: 'liveGraceMs',
    confirmation_interval: 'confirmationIntervalMs', cleanup_interval: 'cleanupIntervalMs',
    retry_interval: 'retryIntervalMs', max_retry_interval: 'maxRetryIntervalMs',
    safety_retry_interval: 'safetyRetryIntervalMs',
    attention_after: 'attentionAfterMs',
    request_timeout: 'requestTimeoutMs', generation_timeout: 'generationTimeoutMs',
  })) config.frigate[derived] = parseDuration(config.frigate[field], `frigate.${field}`);

  for (const [name, client] of Object.entries(config.clients)) {
    client.requestTtlMs = parseDuration(client.request_ttl, `clients.${name}.request_ttl`);
    client.maxWaitMs = parseDuration(client.max_wait, `clients.${name}.max_wait`);
    client.models = (client.models ?? []).filter(Boolean);
    client.source_ips = (client.source_ips ?? []).filter(Boolean);
    client.overflow_policy ??= 'reject';
    client.deduplication = deepMerge({ enabled: false, headers: [], json_fields: [] }, client.deduplication ?? {});
    client.model_policy = normalizeModelPolicy(client.model_policy ?? {}, `clients.${name}.model_policy`, name);
  }

  for (const [name, model] of Object.entries(config.models)) {
    config.models[name] = normalizeModelPolicy(model, `models.${name}`, name);
  }
}

function normalizeBackends(config, raw) {
  const registry = raw.backends === undefined
    ? { ollama: { type: 'ollama', url: config.ollama.url } }
    : raw.backends;
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
    throw new Error('backends must be a named registry of backend objects');
  }
  config.backends = {};
  for (const [name, backend] of Object.entries(registry)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) {
      throw new Error('backends names must contain 1–64 letters, numbers, dots, dashes, or underscores');
    }
    if (backend === null) continue; // Explicit settings tombstone removes an instance, never its files.
    if (!backend || typeof backend !== 'object' || Array.isArray(backend)) throw new Error(`backends.${name} must be an object`);
    const normalized = { enabled: true, resource_group: 'gpu0', ...backend };
    if (!['ollama', 'comfyui'].includes(normalized.type)) throw new Error(`backends.${name}.type must be ollama or comfyui; other software requires an adapter`);
    if (typeof normalized.enabled !== 'boolean') throw new Error(`backends.${name}.enabled must be true or false`);
    if (normalized.resource_group !== 'gpu0') throw new Error(`backends.${name}.resource_group must be gpu0; this release supports one shared GPU`);
    config.backends[name] = normalized;
  }
  if (Object.keys(config.backends).length > 20) throw new Error('backends must contain at most 20 instances');
  const ollama = Object.entries(config.backends).filter(([, backend]) => backend.type === 'ollama');
  if (ollama.length !== 1) throw new Error('backends must contain exactly one Ollama instance; multiple Ollama recovery owners are not supported');
  const [name, primary] = ollama[0];
  if (!primary.enabled) throw new Error(`backends.${name}.enabled must remain true; disabling the primary Ollama instance is not supported`);
  config.primaryBackend = name;
  config.ollama.url = primary.url;
}

function normalizeModelPolicy(policy, field, fallbackGroup) {
  const normalized = { ...policy };
  normalized.idleHoldMs = parseDuration(normalized.idle_hold ?? '0s', `${field}.idle_hold`);
  normalized.maxBatchTimeMs = parseDuration(normalized.max_batch_time ?? '60s', `${field}.max_batch_time`);
  normalized.max_batch_requests ??= 1;
  if (!Number.isInteger(normalized.max_batch_requests) || normalized.max_batch_requests < 1) {
    throw new Error(`${field}.max_batch_requests must be a positive integer`);
  }
  normalized.keep_alive ??= null;
  normalized.group ??= fallbackGroup;
  return normalized;
}

function validate(config) {
  validateMedia(config);
  for (const [section, fields] of Object.entries({
    ollama: { health_interval: 'healthIntervalMs', health_timeout: 'healthTimeoutMs', request_timeout: 'requestTimeoutMs' },
    scheduler: { aging_interval: 'agingIntervalMs' },
    circuit_breaker: { failure_window: 'failureWindowMs', open_duration: 'openDurationMs' },
    gpu_safety: { unload_timeout: 'unloadTimeoutMs' },
    frigate: { poll_interval: 'pollIntervalMs', retry_interval: 'retryIntervalMs', max_retry_interval: 'maxRetryIntervalMs', attention_after: 'attentionAfterMs', request_timeout: 'requestTimeoutMs', generation_timeout: 'generationTimeoutMs' },
  })) {
    for (const [field, derived] of Object.entries(fields)) {
      if (config[section][derived] <= 0) throw new Error(`${section}.${field} must be greater than zero`);
    }
  }
  if (!Number.isInteger(config.circuit_breaker.failure_threshold) || config.circuit_breaker.failure_threshold < 1) {
    throw new Error('circuit_breaker.failure_threshold must be a positive integer');
  }
  if (!['strict_priority', 'balanced'].includes(config.scheduler.mode)) {
    throw new Error('scheduler.mode must be strict_priority or balanced');
  }
  if (!Number.isSafeInteger(config.scheduler.max_queue_bytes) || config.scheduler.max_queue_bytes < 1) {
    throw new Error('scheduler.max_queue_bytes must be a positive safe integer');
  }
  if (typeof config.gpu_safety.state_path !== 'string'
    || (config.gpu_safety.state_path && !config.gpu_safety.state_path.startsWith('/'))) {
    throw new Error('gpu_safety.state_path must be empty or an absolute path');
  }
  for (const section of ['host_helper', 'auto_recovery']) {
    if (typeof config[section].enabled !== 'boolean') throw new Error(`${section}.enabled must be true or false`);
  }
  for (const [section, field] of [['host_helper', 'socket_path'], ['auto_recovery', 'state_path']]) {
    const value = config[section][field];
    if (typeof value !== 'string' || !value.startsWith('/') || /[\x00-\x1f\x7f]/.test(value)) {
      throw new Error(`${section}.${field} must be an absolute path without control characters`);
    }
  }
  for (const [section, field, derived, min, max] of [
    ['host_helper', 'poll_interval', 'pollIntervalMs', 1000, 60000],
    ['host_helper', 'request_timeout', 'requestTimeoutMs', 1000, 60000],
    ['host_helper', 'stale_after', 'staleAfterMs', 1000, 300000],
    ['auto_recovery', 'check_interval', 'checkIntervalMs', 1000, 60000],
    ['auto_recovery', 'restart_timeout', 'restartTimeoutMs', 10000, 300000],
    ['auto_recovery', 'verification_timeout', 'verificationTimeoutMs', 10000, 300000],
    ['auto_recovery', 'cooldown', 'cooldownMs', 300000, 86400000],
    ['auto_recovery', 'window', 'windowMs', 3600000, 604800000],
  ]) {
    if (config[section][derived] < min || config[section][derived] > max) {
      throw new Error(`${section}.${field} must be between ${min / 1000}s and ${max / 1000}s`);
    }
  }
  if (config.host_helper.staleAfterMs < config.host_helper.pollIntervalMs) {
    throw new Error('host_helper.stale_after must be at least host_helper.poll_interval');
  }
  const memory = config.host_helper.memory_guard;
  if (typeof memory.enabled !== 'boolean') throw new Error('host_helper.memory_guard.enabled must be boolean');
  for (const key of ['min_available_mb', 'rescue_min_available_mb']) {
    if (!Number.isInteger(memory[key]) || memory[key] < 256 || memory[key] > 1048576) {
      throw new Error(`host_helper.memory_guard.${key} must be between 256 and 1048576`);
    }
  }
  if (memory.rescue_min_available_mb < memory.min_available_mb) throw new Error('host_helper.memory_guard rescue headroom must be at least normal headroom');
  if (!Number.isInteger(memory.max_pressure_full_percent) || memory.max_pressure_full_percent < 1 || memory.max_pressure_full_percent > 100) {
    throw new Error('host_helper.memory_guard.max_pressure_full_percent must be between 1 and 100');
  }
  for (const [field, min, max] of [['max_restarts', 1, 2], ['stable_samples', 2, 10], ['max_idle_vram_mb', 64, 4096]]) {
    if (!Number.isInteger(config.auto_recovery[field]) || config.auto_recovery[field] < min || config.auto_recovery[field] > max) {
      throw new Error(`auto_recovery.${field} must be between ${min} and ${max}`);
    }
  }
  if (config.auto_recovery.windowMs < config.auto_recovery.cooldownMs) {
    throw new Error('auto_recovery.window must be at least auto_recovery.cooldown');
  }
  if (config.auto_recovery.verificationTimeoutMs < config.auto_recovery.stable_samples * config.auto_recovery.checkIntervalMs) {
    throw new Error('auto_recovery.verification_timeout must allow stable_samples times check_interval');
  }
  if (config.auto_recovery.enabled && !config.host_helper.enabled) {
    throw new Error('auto_recovery.enabled requires host_helper.enabled');
  }
  if (config.auto_recovery.enabled && (!config.maintenance.enabled || typeof config.maintenance.auth_token !== 'string' || !config.maintenance.auth_token.trim())) {
    throw new Error('auto_recovery.enabled requires maintenance.enabled and ADMIN_TOKEN');
  }
  for (const field of ['enabled', 'verify_tls']) {
    if (typeof config.frigate[field] !== 'boolean') throw new Error(`frigate.${field} must be true or false`);
  }
  for (const field of ['username', 'password', 'auth_token', 'url']) {
    if (typeof config.frigate[field] !== 'string') throw new Error(`frigate.${field} must be a string`);
  }
  if (config.frigate.enabled && !config.frigate.url) throw new Error('frigate.url is required when catch-up is enabled');
  if (!['auto', 'none', 'password', 'token'].includes(config.frigate.auth_mode)) {
    throw new Error('frigate.auth_mode must be auto, none, password, or token');
  }
  if (config.frigate.enabled && config.frigate.auth_mode === 'password'
    && (!config.frigate.username || !config.frigate.password)) {
    throw new Error('frigate.auth_mode requires FRIGATE_USERNAME and FRIGATE_PASSWORD in secrets.env');
  }
  if (config.frigate.enabled && config.frigate.auth_mode === 'token' && !config.frigate.auth_token) {
    throw new Error('frigate.auth_mode requires FRIGATE_AUTH_TOKEN in secrets.env');
  }
  if (config.frigate.url) {
    let address;
    try { address = new URL(config.frigate.url); } catch { throw new Error('frigate.url must be an absolute HTTP(S) URL'); }
    if (!['http:', 'https:'].includes(address.protocol)
      || address.username || address.password || address.search || address.hash || address.pathname !== '/') {
      throw new Error('frigate.url must be an HTTP(S) origin without credentials, a path, query string, or fragment');
    }
  }
  if (typeof config.frigate.state_path !== 'string' || !config.frigate.state_path.startsWith('/')) {
    throw new Error('frigate.state_path must be an absolute path');
  }
  if (!Number.isInteger(config.frigate.page_size) || config.frigate.page_size < 1 || config.frigate.page_size > 1000) {
    throw new Error('frigate.page_size must be between 1 and 1000');
  }
  if (!Number.isInteger(config.frigate.max_jobs) || config.frigate.max_jobs < 1 || config.frigate.max_jobs > 100000) {
    throw new Error('frigate.max_jobs must be between 1 and 100000');
  }
  if (!Number.isInteger(config.frigate.max_verifying) || config.frigate.max_verifying < 1 || config.frigate.max_verifying > 16) {
    throw new Error('frigate.max_verifying must be between 1 and 16');
  }
  if (config.frigate.confirmationIntervalMs < 1000) {
    throw new Error('frigate.confirmation_interval must be at least 1s');
  }
  if (config.frigate.cleanupIntervalMs < 10000) {
    throw new Error('frigate.cleanup_interval must be at least 10s');
  }
  if (!Number.isInteger(config.frigate.cleanup_batch_size) || config.frigate.cleanup_batch_size < 1 || config.frigate.cleanup_batch_size > 100) {
    throw new Error('frigate.cleanup_batch_size must be between 1 and 100');
  }
  if (!Number.isInteger(config.frigate.history_limit) || config.frigate.history_limit < 1 || config.frigate.history_limit > 5000) {
    throw new Error('frigate.history_limit must be between 1 and 5000');
  }
  if (config.frigate.maxRetryIntervalMs < config.frigate.retryIntervalMs) {
    throw new Error('frigate.max_retry_interval must be at least frigate.retry_interval');
  }
  const rescue = config.frigate.context_rescue;
  if (!rescue || typeof rescue.enabled !== 'boolean' || typeof rescue.model !== 'string'
    || rescue.model.length > 256 || /[\u0000-\u0020\u007f]/.test(rescue.model)) {
    throw new Error('frigate.context_rescue requires a boolean enabled and an exact model tag without whitespace');
  }
  for (const [field, min, max] of [['max_context', 0, 1048576], ['output_reserve', 256, 32768], ['safety_margin', 256, 32768]]) {
    if (!Number.isSafeInteger(rescue[field]) || rescue[field] < min || rescue[field] > max) {
      throw new Error(`frigate.context_rescue.${field} must be between ${min} and ${max}`);
    }
  }
  if (rescue.enabled && (!config.frigate.enabled || !config.host_helper.enabled || !rescue.model
    || rescue.max_context <= rescue.output_reserve + rescue.safety_margin)) {
    throw new Error('frigate.context_rescue.enabled requires catch-up, host monitoring, an exact tested model tag and a tested maximum above the output reserve plus margin');
  }
  if (!Number.isInteger(config.server.body_limit_bytes) || config.server.body_limit_bytes < 1) {
    throw new Error('server.body_limit_bytes must be a positive integer');
  }
  const primaryListen = parseListen(config.server.listen);
  const listenerAddresses = [primaryListen];
  if (!Array.isArray(config.server.dedicated_listeners)) {
    throw new Error('server.dedicated_listeners must be an array');
  }
  for (const [index, listener] of config.server.dedicated_listeners.entries()) {
    if (!listener || typeof listener !== 'object' || Array.isArray(listener)) {
      throw new Error(`server.dedicated_listeners.${index} must be an object`);
    }
    listenerAddresses.push(parseListen(listener.listen));
    if (!config.clients[listener.client]) {
      throw new Error(`server.dedicated_listeners.${index}.client must name a configured client`);
    }
  }
  if (config.scheduler.max_parallel_generations !== 1) {
    throw new Error('scheduler.max_parallel_generations must be 1; this release intentionally serializes GPU work');
  }
  if (!config.clients.default) throw new Error('clients.default is required');
  if (Object.keys(config.clients).length > 100) throw new Error('clients must contain at most 100 sources');
  const ipRules = [];
  for (const [name, client] of Object.entries(config.clients)) {
    if (typeof client.backend !== 'string' || !config.backends[client.backend]) throw new Error(`clients.${name}.backend must name a configured backend`);
    if (!Array.isArray(client.allowed_backends) || !client.allowed_backends.length
      || client.allowed_backends.some((backend) => typeof backend !== 'string' || !config.backends[backend])
      || new Set(client.allowed_backends).size !== client.allowed_backends.length
      || !client.allowed_backends.includes(client.backend)) {
      throw new Error(`clients.${name}.allowed_backends must name distinct configured backends and include the default backend`);
    }
    if (name === 'frigate' && (config.backends[client.backend].type !== 'ollama'
      || client.allowed_backends.some((backend) => config.backends[backend].type !== 'ollama'))) {
      throw new Error('clients.frigate.backend and allowed_backends must use Ollama; Frigate requests are not ComfyUI workflows');
    }
    for (const field of ['enabled', 'header_enabled', 'queue_while_paused']) {
      if (typeof client[field] !== 'boolean') throw new Error(`clients.${name}.${field} must be true or false`);
    }
    if (!Number.isInteger(client.listener_port) || client.listener_port < 0 || client.listener_port > 65535) {
      throw new Error(`clients.${name}.listener_port must be 0 (off) or an available port`);
    }
    if (client.listener_port) listenerAddresses.push({ host: '0.0.0.0', port: client.listener_port });
    if (!Number.isFinite(client.priority)) throw new Error(`clients.${name}.priority must be a number`);
    if (!Number.isInteger(client.queue_limit) || client.queue_limit < 1) throw new Error(`clients.${name}.queue_limit must be a positive integer`);
    if (!['reject', 'drop_newest', 'drop_oldest'].includes(client.overflow_policy)) {
      throw new Error(`clients.${name}.overflow_policy must be reject, drop_newest, or drop_oldest`);
    }
    for (const [index, source] of client.source_ips.entries()) {
      const [address, prefix, extra] = source.split('/');
      const family = isIP(address);
      if (!family || extra !== undefined) {
        throw new Error(`clients.${name}.source_ips.${index} must be an IP address or CIDR`);
      }
      if (prefix !== undefined) {
        const numericPrefix = Number(prefix);
        const maximum = family === 4 ? 32 : 128;
        if (!/^\d+$/.test(prefix) || numericPrefix < 0 || numericPrefix > maximum) {
          throw new Error(`clients.${name}.source_ips.${index} has an invalid CIDR prefix`);
        }
      }
      const type = family === 4 ? 'ipv4' : 'ipv6';
      const block = new BlockList();
      block.addSubnet(address, prefix === undefined ? (family === 4 ? 32 : 128) : Number(prefix), type);
      if (ipRules.some((rule) => rule.name !== name && rule.type === type
        && (rule.block.check(address, type) || block.check(rule.address, type)))) {
        throw new Error(`clients.${name}.source_ips overlaps another source; use a dedicated port or non-overlapping IP mappings`);
      }
      ipRules.push({ name, address, type, block });
      if (ipRules.length > 1000) throw new Error('clients.source_ips must contain at most 1000 total mappings');
    }
  }
  const claimedPorts = new Set();
  for (const listener of listenerAddresses) {
    if (listener.port === 0) continue; // ephemeral listeners used by tests
    if (claimedPorts.has(listener.port)) throw new Error('listener port conflicts with another intermediary listener');
    claimedPorts.add(listener.port);
  }
  if (!['newest_first', 'oldest_first'].includes(config.frigate.catchup_order)) throw new Error('frigate.catchup_order must be newest_first or oldest_first');
  if (config.frigate.safetyRetryIntervalMs < 5000 || config.frigate.safetyRetryIntervalMs > 300000) throw new Error('frigate.safety_retry_interval must be between 5s and 5m');
  validateWorkPolicy(config);
  if (!['hold', 'reject_new'].includes(config.circuit_breaker.queue_behavior)) {
    throw new Error('circuit_breaker.queue_behavior must be hold or reject_new');
  }
  if (!['schedule', 'reject'].includes(config.scheduler.unknown_model_policy)) {
    throw new Error('scheduler.unknown_model_policy must be schedule or reject');
  }
  if (!config.clients[config.scheduler.default_client]) {
    throw new Error(`scheduler.default_client must name a configured client; received ${JSON.stringify(config.scheduler.default_client)}`);
  }
  if (config.model_management.serialize_with_inference !== true) {
    throw new Error('model_management.serialize_with_inference must be true; model-state mutations may not overlap inference');
  }
  for (const field of ['drain_active_disconnects', 'unload_on_model_switch', 'recovery_on_oom']) {
    if (typeof config.gpu_safety[field] !== 'boolean') throw new Error(`gpu_safety.${field} must be true or false`);
  }
  if (!Number.isInteger(config.gpu_safety.error_body_limit_bytes) || config.gpu_safety.error_body_limit_bytes < 1) {
    throw new Error('gpu_safety.error_body_limit_bytes must be a positive integer');
  }
  for (const field of ['enabled', 'ui_enabled']) {
    if (typeof config.observability[field] !== 'boolean') throw new Error(`observability.${field} must be true or false`);
  }
  if (typeof config.observability.auth_token !== 'string') throw new Error('observability.auth_token must be a string');
  for (const field of ['history_limit', 'recent_events', 'max_event_clients', 'queue_items_limit']) {
    if (!Number.isInteger(config.observability[field]) || config.observability[field] < 1) {
      throw new Error(`observability.${field} must be a positive integer`);
    }
  }
  if (config.observability.history_limit > 1_000) throw new Error('observability.history_limit cannot exceed 1000');
  if (config.observability.max_event_clients > 100) throw new Error('observability.max_event_clients cannot exceed 100');
  if (config.observability.queue_items_limit > 500) throw new Error('observability.queue_items_limit cannot exceed 500');
  if (config.observability.recent_events > config.observability.history_limit) {
    throw new Error('observability.recent_events cannot exceed observability.history_limit');
  }
  if (typeof config.maintenance.enabled !== 'boolean') throw new Error('maintenance.enabled must be true or false');
  if (typeof config.maintenance.auth_token !== 'string') throw new Error('maintenance.auth_token must be a string');
  if (!Number.isFinite(config.maintenance.maxPauseMs) || config.maintenance.maxPauseMs <= 0) {
    throw new Error('maintenance.max_pause must be greater than zero');
  }
  if (typeof config.maintenance.state_path !== 'string' || !config.maintenance.state_path.startsWith('/')) {
    throw new Error('maintenance.state_path must be an absolute path');
  }
  let backendUrl;
  try {
    backendUrl = new URL(config.ollama.url);
  } catch {
    throw new Error('ollama.url must be a valid absolute HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(backendUrl.protocol)) {
    throw new Error('ollama.url must use http or https');
  }
  if (backendUrl.username || backendUrl.password || backendUrl.search || backendUrl.hash || backendUrl.pathname !== '/') {
    throw new Error('ollama.url must be an origin only, without credentials, a path, query string, or fragment');
  }
  const backendPort = Number(backendUrl.port || (backendUrl.protocol === 'https:' ? 443 : 80));
  const backendHost = backendUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const backendIpFamily = isIP(backendHost);
  const localBackend = backendHost === 'localhost'
    || backendHost.endsWith('.localhost')
    || backendHost === '0.0.0.0'
    || backendHost === '::'
    || backendHost === '::1'
    || (backendIpFamily === 4 && backendHost.startsWith('127.'));
  if (localBackend && listenerAddresses.some((listener) => listener.port === backendPort)) {
    throw new Error('ollama.url points back to the intermediary listener; use the real Ollama address');
  }
  const origins = new Set();
  for (const [name, backend] of Object.entries(config.backends)) {
    let address;
    try { address = new URL(backend.url); } catch { throw new Error(`backends.${name}.url must be a valid absolute HTTP(S) URL`); }
    if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.search || address.hash || address.pathname !== '/') {
      throw new Error(`backends.${name}.url must be an HTTP(S) origin without credentials, a path, query string, or fragment`);
    }
    const host = address.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    const port = Number(address.port || (address.protocol === 'https:' ? 443 : 80));
    const local = ['localhost', '0.0.0.0', '::', '::1'].includes(host) || host.endsWith('.localhost') || (isIP(host) === 4 && host.startsWith('127.'));
    if (local && listenerAddresses.some((listener) => listener.port === port)) throw new Error(`backends.${name}.url points back to an intermediary listener`);
    const identity = `${address.protocol}//${local ? 'loopback' : host}:${port}`;
    if (origins.has(identity)) throw new Error(`backends.${name}.url duplicates another backend origin; each managed instance must be unique`);
    origins.add(identity);
  }
}

function validateMedia(config) {
  const media = config.media;
  if (typeof media.enabled !== 'boolean') throw new Error('media.enabled must be true or false');
  if (typeof media.auth_token !== 'string') throw new Error('media.auth_token must be a host-managed string');
  for (const key of ['state_path', 'storage_path']) {
    if (typeof media[key] !== 'string' || !media[key].startsWith('/') || media[key] === '/' || /[\x00-\x1f\x7f]/.test(media[key])) {
      throw new Error(`media.${key} must be a non-root absolute path without control characters`);
    }
  }
  for (const [field, derived, min, max] of [
    ['poll_interval', 'pollIntervalMs', 1000, 60000],
    ['job_timeout', 'jobTimeoutMs', 60000, 604800000],
    ['retention', 'retentionMs', 3600000, MAX_TIMER_DELAY_MS],
  ]) {
    if (media[derived] < min || media[derived] > max) throw new Error(`media.${field} must be between ${min / 1000}s and ${max / 1000}s`);
  }
  for (const [field, min, max] of [
    ['max_storage_bytes', 1024 ** 2, Number.MAX_SAFE_INTEGER], ['max_jobs', 1, 10000],
    ['max_workflow_bytes', 1024, 2 * 1024 ** 2], ['max_output_bytes', 1024, 16 * 1024 ** 3],
    ['max_idle_vram_mb', 64, 4096], ['max_idle_utilization_percent', 0, 10], ['stable_samples', 2, 10],
  ]) {
    if (!Number.isSafeInteger(media[field]) || media[field] < min || media[field] > max) throw new Error(`media.${field} must be an integer between ${min} and ${max}`);
  }
  if (media.max_output_bytes > media.max_storage_bytes) throw new Error('media.max_output_bytes must not exceed max_storage_bytes');
  if (!Array.isArray(media.allowed_node_types) || media.allowed_node_types.length > 1000
    || media.allowed_node_types.some((type) => typeof type !== 'string' || !type.trim() || type.length > 256 || /[\x00-\x1f\x7f]/.test(type))) {
    throw new Error('media.allowed_node_types must be an explicit list of at most 1000 trusted local node type names');
  }
  if (media.enabled) {
    if (!config.host_helper.enabled) throw new Error('media.enabled requires host_helper.enabled for verified GPU ownership');
    if (!media.auth_token.trim()) throw new Error('media.enabled requires ADMIN_TOKEN to derive ComfyUI machine authentication');
    if (!media.allowed_node_types.length) throw new Error('media.enabled requires explicit media.allowed_node_types; arbitrary workflows are not trusted');
    if (!Object.values(config.backends).some((backend) => backend.enabled && backend.type === 'comfyui')) throw new Error('media.enabled requires an enabled ComfyUI backend');
  }
}

export function normalizeConfig(raw = {}) {
  const config = applyAuthentication(deepMerge(clone(DEFAULTS), raw));
  normalizeBackends(config, raw);
  // Every named client inherits operational defaults, while retaining its own identity fields.
  for (const [name, client] of Object.entries(config.clients)) {
    if (name !== 'default') config.clients[name] = deepMerge({ ...clone(config.clients.default), enabled: true,
      header_enabled: true, queue_while_paused: false, listener_port: 0, source_ips: [], models: [] }, client);
    config.clients[name].backend = raw.clients?.[name]?.backend ?? config.primaryBackend;
    config.clients[name].allowed_backends = raw.clients?.[name]?.allowed_backends ?? [config.clients[name].backend];
  }
  durationFields(config);
  validate(config);
  return config;
}

/** Host opt-ins also work with an older config.yml; unset environment values never replace operator choices. */
export function applyHostEnvironment(raw = {}, environment = process.env) {
  const result = clone(raw);
  for (const [section, variable] of [['host_helper', 'HOST_HELPER_ENABLED'], ['auto_recovery', 'AUTO_RECOVERY_ENABLED']]) {
    const value = environment[variable];
    if (value === undefined || value === '') continue;
    if (!['true', 'false', '1', '0'].includes(value)) throw new Error(`${variable} must be exactly true, false, 1, or 0`);
    result[section] = { ...result[section], enabled: value === 'true' || value === '1' };
  }
  if (environment.HOST_HELPER_SOCKET_PATH) {
    result.host_helper = { ...result.host_helper, socket_path: environment.HOST_HELPER_SOCKET_PATH };
  }
  if (environment.MEDIA_TOKEN !== undefined) result.media = { ...result.media, auth_token: environment.MEDIA_TOKEN };
  const adminToken = configuredAdminToken(environment);
  if (adminToken) result.security = { admin_token: adminToken };
  return adminToken || result.security?.admin_token ? applyAuthentication(result) : result;
}

export function expandEnvironment(text, environment = process.env) {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:-|:\?)([^}]*))?\}/g, (token, name, operator, operand = '') => {
    const value = environment[name];
    const missing = value === undefined || value === '';
    if (operator === ':-') return missing ? operand : value;
    if (operator === ':?' && missing) throw new Error(operand || `environment variable ${name} is required`);
    return value ?? '';
  });
}

/**
 * Parse the operator-owned YAML without normalizing it. Recovery mode uses the
 * lenient option so a missing ${NAME:?message} value can be supplied later by a
 * validated settings override. YAML syntax errors remain host-edit problems: we
 * never try to rewrite an operator's source file from the web UI.
 */
export function parseConfigSource(text, environment = process.env, { allowMissingRequired = false } = {}) {
  const missingEnvironment = [];
  const parsed = YAML.parse(text) ?? {};
  const expandString = (value, fieldPath) => value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:-|:\?)([^}]*))?\}/g,
    (token, name, operator, operand = '') => {
      const replacement = environment[name];
      const missing = replacement === undefined || replacement === '';
      if (operator === ':-') return missing ? operand : replacement;
      if (operator === ':?' && missing) {
        if (!allowMissingRequired) throw new Error(operand || `environment variable ${name} is required`);
        if (!missingEnvironment.some((entry) => entry.variable === name && entry.path === fieldPath)) {
          missingEnvironment.push({
            variable: name,
            path: fieldPath,
            message: operand || `environment variable ${name} is required`,
          });
        }
        return '';
      }
      return replacement ?? '';
    },
  );
  const expandNode = (value, fieldPath = '') => {
    if (typeof value === 'string') return expandString(value, fieldPath || '$');
    if (Array.isArray(value)) return value.map((child, index) => expandNode(child, `${fieldPath}.${index}`));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      expandNode(child, fieldPath ? `${fieldPath}.${key}` : key),
    ]));
  };
  return { raw: expandNode(parsed), missingEnvironment };
}

export function readConfigSource(path, environment = process.env, options = {}) {
  let text;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`cannot read config file ${path}: ${error.message}`, { cause: error });
  }
  try {
    return parseConfigSource(text, environment, options);
  } catch (error) {
    throw new Error(`cannot parse config file ${path}: ${error.message}`, { cause: error });
  }
}

export function loadConfig(path, environment = process.env) {
  const { raw } = readConfigSource(path, environment);
  return normalizeConfig(raw);
}

export function parseListen(value) {
  const index = value.lastIndexOf(':');
  if (index < 1) throw new Error(`invalid listen address ${value}`);
  let host = value.slice(0, index);
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const port = Number(value.slice(index + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid listen port in ${value}`);
  return { host, port };
}
