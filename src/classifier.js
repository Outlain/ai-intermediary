import { BlockList, isIP } from 'node:net';
import { clientIp } from './http-utils.js';

function getPath(object, path) {
  return path.split('.').reduce((value, part) => value && typeof value === 'object' ? value[part] : undefined, object);
}

export class Classifier {
  constructor(config) {
    this.config = config;
    this.modelClients = new Map();
    this.sources = [];
    for (const [client, policy] of Object.entries(config.clients)) {
      for (const model of policy.models) this.modelClients.set(model, client);
      for (const source of policy.source_ips) {
        const [address, prefixText] = source.split('/');
        const family = isIP(address);
        if (!family) throw new Error(`invalid source IP/subnet ${source} for client ${client}`);
        const prefix = prefixText === undefined ? (family === 4 ? 32 : 128) : Number(prefixText);
        const block = new BlockList();
        block.addSubnet(address, prefix, family === 4 ? 'ipv4' : 'ipv6');
        this.sources.push({ client, block, family: family === 4 ? 'ipv4' : 'ipv6' });
      }
    }
  }

  identify(request, parsedBody, forcedClient = null) {
    if (forcedClient && Object.hasOwn(this.config.clients, forcedClient)) return { client: forcedClient, method: 'listener' };
    const header = request.headers['x-ollama-client'];
    const named = Array.isArray(header) ? header[0] : header;
    if (named && Object.hasOwn(this.config.clients, named) && this.config.clients[named].header_enabled !== false) return { client: named, method: 'header' };
    const address = clientIp(request, this.config.server.trusted_proxy);
    const family = isIP(address);
    if (family) {
      const type = family === 4 ? 'ipv4' : 'ipv6';
      const source = this.sources.find((entry) => entry.family === type && entry.block.check(address, type));
      if (source) return { client: source.client, method: 'source_ip' };
    }
    // Keep explicitly configured legacy model mappings as a last-resort migration
    // fallback; a source address is a stronger identity than a shared model name.
    const model = parsedBody?.model;
    if (model && this.modelClients.has(model)) return { client: this.modelClients.get(model), method: 'model' };
    return { client: this.config.scheduler.default_client, method: 'fallback' };
  }

  dedupeKey(client, request, parsedBody) {
    const policy = this.config.clients[client].deduplication;
    if (!policy.enabled) return null;
    const parts = [];
    for (const name of policy.headers) {
      const value = request.headers[name.toLowerCase()];
      if (value !== undefined) parts.push(`h:${name}=${Array.isArray(value) ? value[0] : value}`);
    }
    for (const path of policy.json_fields) {
      const value = getPath(parsedBody, path);
      if (value !== undefined && typeof value !== 'object') parts.push(`j:${path}=${value}`);
    }
    return parts.length ? `${client}|${parts.join('|')}` : null;
  }
}

export function classifyEndpoint(method, pathname) {
  if (method === 'POST' && [
    '/api/generate', '/api/chat', '/api/embed', '/api/embeddings',
    '/v1/chat/completions', '/v1/completions', '/v1/responses', '/v1/embeddings',
  ].includes(pathname)) return 'generation';
  if (method === 'POST' && ['/api/pull', '/api/push', '/api/create', '/api/copy'].includes(pathname)) return 'management';
  if (method === 'DELETE' && pathname === '/api/delete') return 'management';
  if (method === 'POST' && /^\/api\/blobs\/sha256:[a-f0-9]{64}$/.test(pathname)) return 'management';
  return isSafeMetadataEndpoint(method, pathname) ? 'metadata' : 'unknown';
}

export function isSafeMetadataEndpoint(method, pathname) {
  if (['GET', 'HEAD'].includes(method) && pathname === '/') return true;
  if (method === 'GET' && ['/api/tags', '/api/ps', '/api/version', '/v1/models'].includes(pathname)) return true;
  if (method === 'GET' && /^\/v1\/models\/[^/]+$/.test(pathname)) return true;
  if (method === 'POST' && pathname === '/api/show') return true;
  if (method === 'HEAD' && /^\/api\/blobs\/sha256:[a-f0-9]{64}$/.test(pathname)) return true;
  return false;
}

export function isStreaming(pathname, body) {
  if (pathname === '/api/embed' || pathname === '/api/embeddings' || pathname === '/v1/embeddings') return false;
  if (pathname.startsWith('/v1/')) return body?.stream === true;
  return body?.stream !== false;
}
