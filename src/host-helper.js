import http from 'node:http';

export const HOST_PROTOCOL = 'ollama-intermediary-host-v1';
const LIMIT = 512 * 1024;
const safeCode = (value, fallback) => typeof value === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(value) ? value : fallback;
const number = (value, maximum = Number.MAX_SAFE_INTEGER) => Number.isFinite(value) && value >= 0 && value <= maximum ? value : null;
const text = (value, maximum = 128) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, maximum) : null;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export class HostHelperError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function hostConnectionError(error) {
  if (error instanceof HostHelperError) return error;
  const codes = { ENOENT: 'host_helper_socket_missing', EACCES: 'host_helper_permission_denied',
    EPERM: 'host_helper_permission_denied', ECONNREFUSED: 'host_helper_not_listening' };
  return new HostHelperError(codes[error?.code] ?? 'host_helper_unreachable');
}

// A local Unix socket, never a user-selected network destination. No shell,
// Docker socket, host process execution, or host command input lives here.
export class HostHelperClient {
  constructor(config, { clock = () => Date.now(), onChange = () => {} } = {}) {
    this.config = config;
    this.settings = config.host_helper;
    this.clock = clock;
    this.onChange = onChange;
    this.value = null;
    this.lastError = null;
    this.pending = null;
    this.timer = null;
    this.controller = new AbortController();
  }

  request(path, { method = 'GET', body, timeoutMs = this.settings.requestTimeoutMs, signal } = {}) {
    if (!this.settings.enabled) return Promise.reject(new HostHelperError('host_helper_disabled'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const request = http.request({ socketPath: this.settings.socket_path, path, method,
        headers: { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) },
      });
      const signals = [this.controller.signal, signal].filter(Boolean);
      const abort = () => request.destroy(new HostHelperError('host_request_aborted'));
      const timer = setTimeout(() => request.destroy(new HostHelperError('host_request_timeout')), timeoutMs);
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        for (const item of signals) item.removeEventListener('abort', abort);
        if (error) reject(hostConnectionError(error));
        else resolve(value);
      };
      for (const item of signals) {
        item.addEventListener('abort', abort, { once: true });
        if (item.aborted) abort();
      }
      request.on('error', (error) => finish(error));
      request.on('response', (response) => {
        const chunks = [];
        let size = 0;
        response.on('error', (error) => finish(error));
        response.on('aborted', () => finish(new HostHelperError('host_response_incomplete')));
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > LIMIT) request.destroy(new HostHelperError('host_response_too_large'));
          else chunks.push(chunk);
        });
        response.on('end', () => {
          let value;
          try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { return finish(new HostHelperError('host_response_invalid')); }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            return finish(new HostHelperError(safeCode(value?.error, `host_http_${response.statusCode}`)));
          }
          finish(null, value);
        });
      });
      request.end(data);
    });
  }

  async refresh({ timeoutMs = this.settings.requestTimeoutMs } = {}) {
    if (this.pending) return this.waitForRefresh(this.pending, timeoutMs);
    this.pending = (async () => {
      try {
        const value = await this.request('/v1/status', { timeoutMs: Math.min(timeoutMs, this.settings.requestTimeoutMs) });
        if (value?.protocol !== HOST_PROTOCOL || !Number.isFinite(Date.parse(value.sampled_at))) {
          throw new HostHelperError('host_protocol_invalid');
        }
        // Bind the allowed service to the configured Ollama origin. Changing
        // the backend cannot silently grant control of an unrelated host.
        let bound = false;
        try { bound = new URL(value.managed_ollama_origin).href === new URL(this.config.ollama.url).href; } catch { /* fail closed */ }
        this.value = { ...value, bound, received_at: this.clock() };
        this.lastError = bound ? null : 'host_backend_mismatch';
      } catch (error) { this.lastError = safeCode(error.code, 'host_helper_unreachable'); }
      this.onChange();
      return this.snapshot();
    })().finally(() => { this.pending = null; });
    return this.pending;
  }

  async waitForRefresh(pending, timeoutMs) {
    let timer;
    try {
      return await Promise.race([pending, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new HostHelperError('host_request_timeout')), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }

  snapshot() {
    const value = this.value;
    const age = value ? this.clock() - Date.parse(value.sampled_at) : Infinity;
    const stale = !value || age < -5_000 || age > this.settings.staleAfterMs
      || this.clock() - value.received_at > this.settings.staleAfterMs;
    const raw = value?.telemetry;
    const validRows = Array.isArray(raw?.gpus) && raw.gpus.every(record);
    const gpus = (Array.isArray(raw?.gpus) ? raw.gpus : []).filter(record).slice(0, 16).map((gpu) => ({
      id: text(String(gpu.id ?? 'unknown')), name: text(gpu.name),
      vram_total_bytes: number(gpu.vram_total_bytes), vram_used_bytes: number(gpu.vram_used_bytes),
      vram_free_bytes: number(gpu.vram_free_bytes), utilization_percent: number(gpu.utilization_percent, 100),
      temperature_c: number(gpu.temperature_c, 250), power_w: number(gpu.power_w, 10_000),
      processes_known: gpu.processes_known === true && Array.isArray(gpu.processes) && gpu.processes.length <= 256
        && gpu.processes.every((process) => record(process) && Number.isSafeInteger(process.pid) && process.pid > 0),
      processes: (Array.isArray(gpu.processes) ? gpu.processes : []).filter(record).slice(0, 256).map((process) => ({
        pid: Number.isSafeInteger(process.pid) && process.pid > 0 ? process.pid : null,
        name: text(process.name), vram_bytes: number(process.vram_bytes), is_ollama: process.is_ollama === true,
        is_comfyui: value?.capabilities?.comfyui_ownership === true && process.is_comfyui === true && process.is_ollama !== true,
      })),
    }));
    const available = this.settings.enabled && !stale && !this.lastError && raw?.available === true
      && validRows && raw.gpus.length > 0 && raw.gpus.length <= 16
      && new Set(gpus.map((gpu) => gpu.id)).size === gpus.length;
    const m = value?.memory;
    const memory = Object.fromEntries(['total_bytes', 'available_bytes', 'swap_total_bytes', 'swap_used_bytes',
      'oom_kill_count', 'pressure_some_avg10', 'pressure_full_avg10'].map((key) => [key, number(m?.[key],
      key.startsWith('pressure_') ? 100 : Number.MAX_SAFE_INTEGER)]));
    memory.available = this.settings.enabled && !stale && !this.lastError && m?.available === true
      && memory.total_bytes > 0 && memory.available_bytes !== null && memory.available_bytes <= memory.total_bytes
      && memory.swap_total_bytes !== null && memory.swap_used_bytes !== null && memory.swap_used_bytes <= memory.swap_total_bytes;
    memory.error = memory.available ? null : 'host_memory_unavailable';
    return {
      enabled: this.settings.enabled, available, stale, sampled_at: value?.sampled_at ?? null,
      error: !this.settings.enabled ? null : this.lastError ?? (stale ? 'host_telemetry_stale'
        : !available ? safeCode(raw?.error, 'host_telemetry_unavailable') : null),
      gpus, memory,
      capabilities: { restart_reconciliation: value?.capabilities?.restart_reconciliation === true,
        external_replacement: value?.capabilities?.external_replacement === true,
        comfyui_ownership: value?.capabilities?.comfyui_ownership === true },
      last_service_failure: value?.last_service_failure?.code === 'ollama_host_oom'
        && Number.isFinite(Date.parse(value.last_service_failure.observed_at))
        ? { code: 'ollama_host_oom', observed_at: value.last_service_failure.observed_at } : null,
      // Internal consumers require service incarnation proof; callers should
      // omit it from public GPU summaries unless expressly needed.
      service: value?.service ?? null, bound: value?.bound === true,
      restart_policy: value?.restart_policy ?? null,
    };
  }

  restart(operationId, expectedInvocationId, { timeoutMs, signal } = {}) {
    return this.request('/v1/ollama/restart', { method: 'POST',
      body: { operation_id: operationId, expected_invocation_id: expectedInvocationId }, timeoutMs, signal });
  }

  reconcile(operationId, options) {
    return this.request(`/v1/ollama/operations/${encodeURIComponent(operationId)}`, options);
  }

  replacement(since, options) {
    return this.request(`/v1/ollama/replacement?since=${encodeURIComponent(since / 1000)}`, options);
  }

  start() {
    if (!this.settings.enabled) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.settings.pollIntervalMs);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); this.controller.abort(); }
}
