/** Sources identify callers; adapters identify protocols. Neither a port nor
 * a client header is an authentication credential. */
export class BackendRegistry {
  constructor(config) { this.config = config; }

  resolve(source, requested, type) {
    const policy = this.config.clients[source];
    if (!policy || !policy.enabled) throw this.error('source_disabled', 503);
    const name = requested || policy.backend || this.config.primaryBackend || 'ollama';
    const allowed = policy.allowed_backends || [policy.backend || this.config.primaryBackend || 'ollama'];
    if (!allowed.includes(name)) throw this.error('backend_not_allowed', 403);
    const backend = this.config.backends?.[name];
    if (!backend?.enabled) throw this.error('backend_disabled', 503);
    if (type && backend.type !== type) throw this.error('backend_protocol_mismatch', 422);
    return { name, ...backend };
  }

  error(code, statusCode) {
    return Object.assign(new Error(code.replaceAll('_', ' ')), { code, statusCode });
  }

  snapshot() {
    return Object.entries(this.config.backends || {}).map(([id, backend]) => ({
      id, type: backend.type, enabled: backend.enabled, resource_group: backend.resource_group,
      capabilities: backend.type === 'ollama' ? ['chat', 'generate', 'embeddings'] : ['workflow'],
    }));
  }
}
