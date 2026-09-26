import { createHmac } from 'node:crypto';

export const COMFY_BRIDGE_TOKEN_DOMAIN = 'ai-intermediary/comfyui-bridge/v1';

/** The machine credential is reproducible without sharing the human admin secret. */
export function deriveComfyBridgeToken(adminToken) {
  if (typeof adminToken !== 'string' || !adminToken.trim()) throw new Error('ADMIN_TOKEN must be a nonempty string');
  return createHmac('sha256', adminToken).update(COMFY_BRIDGE_TOKEN_DOMAIN, 'utf8').digest('hex');
}

export function configuredAdminToken(environment = process.env) {
  const value = environment.ADMIN_TOKEN;
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 4096 || /[^\x20-\x7e]/.test(value)) {
    // Browser fetch() Authorization headers cannot reliably carry Unicode.
    // Reject it at startup rather than creating a credential the UI cannot use.
    throw new Error('ADMIN_TOKEN must be a nonempty printable ASCII credential without surrounding whitespace (maximum 4096 characters)');
  }
  return value;
}

export function applyAuthentication(config) {
  const adminToken = configuredAdminToken({ ADMIN_TOKEN: config.security?.admin_token });
  config.security = { auth_mode: adminToken ? 'single_admin' : 'legacy', admin_token: adminToken };
  if (adminToken) {
    config.observability = { ...config.observability, auth_token: adminToken };
    config.maintenance = { ...config.maintenance, auth_token: adminToken };
    config.media = { ...config.media, auth_token: deriveComfyBridgeToken(adminToken) };
  }
  return config;
}
