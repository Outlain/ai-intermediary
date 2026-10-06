import { createHash } from 'node:crypto';

const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const integer = (v) => Number.isSafeInteger(v) && v > 0 && v <= 16_777_216;
const HASH = /^[a-f0-9]{64}$/;
export const DEFERRAL_REASONS = new Set(['maintenance_paused', 'manual_source_pause', 'scheduled_pause',
  'source_disabled', 'pause_state_error', 'context_rescue_interrupted', 'rescue_telemetry_unavailable',
  'rescue_gpu_busy', 'rescue_vram_headroom', 'rescue_host_memory_unavailable', 'rescue_host_memory_low',
  'rescue_host_memory_pressure', 'host_memory_unavailable', 'host_memory_low', 'host_memory_pressure']);
export const RESCUE_REASONS = new Set(['context_overflow', 'rescue_above_cap', 'rescue_model_limit',
  'rescue_model_unknown', 'rescue_telemetry_unavailable', 'rescue_gpu_busy', 'rescue_vram_headroom',
  'rescue_used', 'rescue_request_succeeded', 'rescue_request_failed', 'rescue_outcome_uncertain',
  'rescue_body_limit', 'rescue_host_memory_unavailable', 'rescue_host_memory_low', 'rescue_host_memory_pressure']);

// Only complete, bounded HTTP 400 error documents qualify. Never infer an
// overflow from free text, generated content, generic 400s, or stream failures.
export function contextOverflow(status, body, certain = true) {
  if (!certain || status !== 400 || !Buffer.isBuffer(body) || body.length > 65_536) return null;
  try {
    let document = JSON.parse(body.toString('utf8'));
    for (let depth = 0; depth < 3; depth++) {
      if (!record(document) || Object.keys(document).some((key) => !['error', 'status', 'status_code'].includes(key))) return null;
      let error = document.error;
      if (typeof error === 'string') { document = JSON.parse(error); continue; }
      if (!record(error) || error.type !== 'exceed_context_size_error' || error.code !== 400
        || !integer(error.n_prompt_tokens) || !integer(error.n_ctx) || error.n_prompt_tokens <= error.n_ctx) return null;
      return { prompt_tokens: error.n_prompt_tokens, reported_context: error.n_ctx };
    }
  } catch { /* Not the exact typed rejection. */ }
  return null;
}

// Hash, never retain, the complete original request. A later regeneration may
// select different media: old measurements must not authorize that new input.
export function contextRequest(pathname, body, parsed, origin) {
  if (!['/api/generate', '/api/chat'].includes(pathname) || !record(parsed?.options)
    || !integer(parsed.options.num_ctx) || typeof parsed.model !== 'string' || parsed.model.length > 256) return null;
  const predict = parsed.options.num_predict;
  if (predict !== undefined && predict !== -1 && !integer(predict)) return null;
  return { model: parsed.model, context: parsed.options.num_ctx,
    output_tokens: integer(predict) ? predict : 0,
    signature: createHash('sha256').update(origin).update('\0').update(pathname).update('\0').update(body).digest('hex') };
}

export function validContextRequest(value) {
  return record(value) && typeof value.model === 'string' && value.model.length > 0 && value.model.length <= 256
    && integer(value.context) && (value.output_tokens === 0 || integer(value.output_tokens)) && HASH.test(value.signature);
}

export function validRescue(value) {
  return validContextRequest(value) && integer(value.prompt_tokens) && integer(value.reported_context)
    && HASH.test(value.failed_attempt)
    && value.prompt_tokens > value.reported_context && typeof value.attempted === 'boolean'
    && (value.attempted ? integer(value.target_context) && value.target_context <= 1_048_576
      && value.target_context > Math.max(value.context, value.reported_context) : value.target_context === null)
    && RESCUE_REASONS.has(value.reason);
}

export function rescueTarget(evidence, request, settings) {
  if (!evidence || !request || !settings?.enabled || settings.model !== request.model || evidence.signature !== request.signature) return null;
  if (evidence.attempted) return { blocked: 'rescue_used' };
  const required = evidence.prompt_tokens + Math.max(settings.output_reserve, request.output_tokens) + settings.safety_margin;
  const target = Math.max(required, request.context + 1, evidence.reported_context + 1);
  if (target > settings.max_context) return { blocked: 'rescue_above_cap', required };
  return { context: Math.min(Math.ceil(target / 4096) * 4096, settings.max_context), required };
}

// idleComfy is supplied only after MediaBroker has revalidated its completed
// unload proof, empty queue and allocator limit under the shared inference gate.
// A process name (or even host ownership alone) cannot grant this allowance.
export function rescueHardwareBlock(host, idleComfy = null) {
  if (!host?.available || host.stale !== false || host.bound !== true || !host.gpus?.length
    || host.gpus.some((gpu) => !gpu.processes_known || !Array.isArray(gpu.processes)
      || !Number.isFinite(gpu.vram_free_bytes) || gpu.vram_free_bytes < 0
      || !Number.isFinite(gpu.utilization_percent) || gpu.utilization_percent < 0)) return 'rescue_telemetry_unavailable';
  const allowComfy = host.capabilities?.comfyui_ownership === true && host.gpus.length === 1
    && Number.isFinite(idleComfy?.max_utilization_percent) && idleComfy.max_utilization_percent >= 0
    && idleComfy.max_utilization_percent <= 10
    && Number.isSafeInteger(idleComfy?.max_residual_vram_bytes) && idleComfy.max_residual_vram_bytes >= 0;
  for (const gpu of host.gpus) {
    const hasComfy = allowComfy && gpu.processes.some((process) => process.is_comfyui === true && process.is_ollama !== true);
    if (gpu.processes.some((process) => process.is_ollama !== true && !(hasComfy && process.is_comfyui === true))) return 'rescue_gpu_busy';
    if (!hasComfy) {
      if (gpu.utilization_percent > 0) return 'rescue_gpu_busy';
      continue;
    }
    // Keep an already loaded Ollama model warm. Bound everything else,
    // including unattributed driver allocations, by the existing media ceiling.
    // Unknown Ollama allocation sizes cannot be subtracted from physical use.
    const ollama = gpu.processes.filter((process) => process.is_ollama === true);
    if (!Number.isSafeInteger(gpu.vram_used_bytes) || gpu.vram_used_bytes < 0
      || gpu.processes.some((process) => !Number.isSafeInteger(process.pid) || process.pid <= 0)
      || new Set(gpu.processes.map((process) => process.pid)).size !== gpu.processes.length
      || ollama.some((process) => !Number.isSafeInteger(process.vram_bytes) || process.vram_bytes < 0)) return 'rescue_telemetry_unavailable';
    const residual = gpu.vram_used_bytes - ollama.reduce((sum, process) => sum + process.vram_bytes, 0);
    if (!Number.isSafeInteger(residual) || residual < 0) return 'rescue_telemetry_unavailable';
    if (residual > idleComfy.max_residual_vram_bytes
      || gpu.utilization_percent > idleComfy.max_utilization_percent) return 'rescue_gpu_busy';
  }
  // Additional guardrail, NOT a prediction that the larger KV cache fits.
  // The operator's independently tested per-model cap remains mandatory.
  if (host.gpus.some((gpu) => gpu.vram_free_bytes < 2048 * 1024 * 1024)) return 'rescue_vram_headroom';
  return null;
}
