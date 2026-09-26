// Native ComfyUI UI requests carry optional frontend/API metadata. Keep the
// durable store and host bridge's narrower extra_pnginfo-only contract intact.
const UI_METADATA_KEYS = new Set([
  'extra_pnginfo', 'comfy_usage_source', 'preview_method',
  'auth_token_comfy_org', 'api_key_comfy_org',
]);
const MAX_METADATA_BYTES = 1024 * 1024;
const reject = (code, statusCode = 400) => { throw Object.assign(new Error(code), { code, statusCode }); };

export function nativeComfyMetadata(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) reject('invalid_body');
  const metadata = body.extra_data ?? {};
  if (typeof metadata !== 'object' || Array.isArray(metadata)
    || Object.keys(metadata).some((key) => !UI_METADATA_KEYS.has(key))) reject('media_metadata_invalid');
  // Bound the original envelope, including fields that will be discarded.
  if (Buffer.byteLength(JSON.stringify(metadata)) > MAX_METADATA_BYTES) reject('media_metadata_too_large', 413);
  // Usage tags and per-request preview preferences are not execution inputs.
  // Use the server's preview defaults; never persist/forward cloud credentials.
  // The store still validates the type/size of the retained workflow metadata.
  return Object.hasOwn(metadata, 'extra_pnginfo') ? { extra_pnginfo: metadata.extra_pnginfo } : {};
}

// Only fixed, reviewed text/codes reach browsers and logs. Error messages can
// contain prompts, credentials, filesystem paths or upstream response bodies.
const ERRORS = {
  invalid_body: [400, 'The request must be a valid JSON object'],
  invalid_workflow: [400, 'The workflow is invalid; submit a complete ComfyUI API-format workflow'],
  media_workflow_invalid: [400, 'The workflow is invalid; submit a complete ComfyUI API-format workflow'],
  node_not_allowed: [422, 'A workflow node is not approved; review the trusted node types in Media settings'],
  unknown_node: [422, 'A workflow node is not installed on the configured ComfyUI backend'],
  cloud_node_forbidden: [422, 'Cloud/API nodes are blocked; choose a local-only workflow'],
  remote_workflow_input: [422, 'Remote URL inputs are blocked; upload the input file through ComfyUI'],
  invalid_workflow_path: [422, 'Workflow file inputs must use relative backend paths without parent-directory traversal'],
  invalid_client_id: [400, 'The browser client identifier is invalid; reload ComfyUI and try again'],
  media_metadata_invalid: [400, 'The request contains unsupported or invalid metadata; use the supported local ComfyUI request format'],
  media_metadata_too_large: [413, 'Workflow metadata exceeds the 1 MiB limit; reduce embedded workflow notes or data'],
  media_workflow_too_large: [413, 'The workflow exceeds the configured workflow byte limit'],
  request_too_large: [413, 'The request exceeds the configured byte limit'],
  media_disabled: [503, 'Media is disabled or unavailable; check Media settings and dashboard status'],
  source_disabled: [503, 'This source is disabled; enable it in Sources settings'],
  backend_disabled: [503, 'The configured media backend is disabled or unavailable; check Backends settings'],
  backend_not_allowed: [403, 'This source is not permitted to use the requested backend'],
  backend_protocol_mismatch: [422, 'This source must be linked to a ComfyUI backend'],
  maintenance_paused: [503, 'Inference is paused; resume it in the dashboard before submitting'],
  manual_source_pause: [503, 'This source is paused; check source pauses in the dashboard'],
  scheduled_pause: [503, 'This source is paused by a schedule; check source schedules or wait for the pause to end'],
  gpu_recovery_required: [503, 'GPU recovery is required; check the dashboard before submitting more work'],
  media_recovery_required: [503, 'Media recovery is required; check the dashboard before submitting more work'],
  shutting_down: [503, 'The intermediary is restarting or stopping; wait for it to become ready'],
  queue_full: [429, 'This source queue is full; wait for existing jobs to finish'],
  media_queue_full: [429, 'The media queue is full; wait for existing jobs to finish'],
  media_workflow_memory_full: [429, 'Queued workflows have reached the memory budget; wait for existing jobs to finish'],
  media_storage_full: [507, 'Media storage is full; review completed-output cleanup and storage limits'],
  media_idempotency_conflict: [409, 'This request identifier already belongs to different job contents'],
  media_idempotency_key_invalid: [400, 'The request idempotency key is invalid'],
  media_job_not_found: [404, 'The media job was not found'],
  media_job_not_cancellable: [409, 'This media job cannot currently be cancelled; check its status'],
  media_request_failed: [503, 'Media request could not be completed; check the job status and configuration'],
};

export function mediaRequestError(error) {
  const suppliedStatus = error?.statusCode ?? error?.status;
  const code = Object.hasOwn(ERRORS, error?.code) ? error.code
    : error instanceof SyntaxError ? 'invalid_body'
      : suppliedStatus === 413 ? 'request_too_large' : 'media_request_failed';
  const [defaultStatus, message] = ERRORS[code];
  const status = Number.isInteger(suppliedStatus) && suppliedStatus >= 400 && suppliedStatus <= 599
    ? suppliedStatus : defaultStatus;
  return { status, code, error: `${message} (${code}).` };
}
