import { readBody, sendJson } from './http-utils.js';
import { authorized } from './observability.js';
import { SETTINGS_SCHEMA, SettingsValidationError } from './settings.js';
import { BUILD_INFO } from './build-info.js';
import { configuredAdminToken } from './auth.js';
import {
  SETTINGS_DASHBOARD_CSS,
  SETTINGS_DASHBOARD_HTML,
  SETTINGS_DASHBOARD_JS,
} from './settings-dashboard.js';

const SETTINGS_API = '/_intermediary/v1/settings';
const BODY_LIMIT = 64 * 1024;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function writeAsset(response, id, contentType, body, html = false) {
  response.writeHead(200, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'content-security-policy': html
      ? "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
      : "default-src 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'x-request-id': id,
  });
  response.end(body);
}

function requestRevision(request, body) {
  const header = request.headers['if-match'];
  const raw = header === undefined ? body.revision : String(header).replace(/^W\//, '').replaceAll('"', '');
  const revision = Number(raw);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

export class SettingsController {
  constructor({
    store,
    token = '',
    authentication = { mode: 'legacy' },
    mode = 'running',
    configPath = '/app/config.yml',
    additionalDiagnostics = [],
    mutationDisabledReason = '',
    logger,
    onRestartPending = () => {},
    onRestart = async () => {},
  } = {}) {
    this.store = store;
    // Authentication must remain canonical even when an unrelated backend
    // setting prevents normalization and opens the configuration recovery UI.
    // Invalid host-admin values fail closed, never revive a legacy token.
    const rawAdmin = store?.getEffectiveRaw?.()?.security?.admin_token;
    const configuredAdmin = configuredAdminToken({ ADMIN_TOKEN: rawAdmin === undefined
      ? store?.getEffectiveConfig?.()?.security?.admin_token : rawAdmin });
    this.token = configuredAdmin || token;
    this.authentication = { mode: configuredAdmin || authentication.mode === 'single_admin' ? 'single_admin' : 'legacy' };
    this.mode = mode;
    this.configPath = configPath;
    this.additionalDiagnostics = additionalDiagnostics;
    this.mutationDisabledReason = mutationDisabledReason;
    this.logger = logger;
    this.onRestartPending = onRestartPending;
    this.onRestart = onRestart;
    this.applying = false;
    this.restartPending = false;
    this.restartTriggered = false;
  }

  setLifecycle({ onRestartPending, onRestart } = {}) {
    if (onRestartPending) this.onRestartPending = onRestartPending;
    if (onRestart) this.onRestart = onRestart;
  }

  handles(pathname) {
    return pathname === '/settings'
      || pathname === '/settings/'
      || pathname === '/_intermediary/ui/settings.css'
      || pathname === '/_intermediary/ui/settings.js'
      || pathname === SETTINGS_API
      || pathname.startsWith(`${SETTINGS_API}/`);
  }

  async handle(request, response, url, id) {
    if (url.pathname === '/settings' || url.pathname === '/settings/') {
      if (request.method !== 'GET') {
        response.setHeader('allow', 'GET');
        return sendJson(response, 405, { error: 'settings page only supports GET', code: 'method_not_allowed' }, id);
      }
      return writeAsset(response, id, 'text/html; charset=utf-8', SETTINGS_DASHBOARD_HTML, true);
    }
    if (url.pathname === '/_intermediary/ui/settings.css' || url.pathname === '/_intermediary/ui/settings.js') {
      if (request.method !== 'GET') {
        response.setHeader('allow', 'GET');
        return sendJson(response, 405, { error: 'settings assets only support GET', code: 'method_not_allowed' }, id);
      }
      const css = url.pathname.endsWith('.css');
      return writeAsset(
        response,
        id,
        css ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
        css ? SETTINGS_DASHBOARD_CSS : SETTINGS_DASHBOARD_JS,
      );
    }

    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    if (!this.token) {
      return sendJson(response, 503, {
        error: 'Set ADMIN_TOKEN in secrets.env and recreate the container before using settings.',
        code: 'settings_auth_not_configured',
      }, id);
    }
    if (!authorized(request, this.token)) {
      response.setHeader('www-authenticate', 'Bearer realm="ai-intermediary-settings"');
      return sendJson(response, 401, { error: 'Admin login is required', code: 'unauthorized', authentication: this.authentication }, id);
    }

    if (request.method === 'GET' && url.pathname === SETTINGS_API) {
      return sendJson(response, 200, this.snapshot(), id);
    }
    if (request.method === 'POST' && url.pathname === `${SETTINGS_API}/validate`) {
      const body = await this.readSettingsBody(request);
      if (body.error) return sendJson(response, body.status, body.error, id);
      const result = this.store.validate(body.settings);
      const diagnostics = [...this.additionalDiagnostics, ...result.diagnostics];
      const valid = result.valid && !this.additionalDiagnostics.some((item) => item.severity === 'error');
      return sendJson(response, valid ? 200 : 422, {
        valid,
        diagnostics,
        settings: result.settings,
        revision: this.store.snapshot().revision,
      }, id);
    }
    if ((request.method === 'POST' && url.pathname === `${SETTINGS_API}/apply`)
      || (request.method === 'PUT' && url.pathname === SETTINGS_API)) {
      return this.apply(request, response, id);
    }
    if (request.method === 'POST' && url.pathname === `${SETTINGS_API}/rollback`) {
      return this.mutate(request, response, id, () => this.store.rollback());
    }
    if (request.method === 'POST' && url.pathname === `${SETTINGS_API}/reset`) {
      return this.mutate(request, response, id, () => this.store.reset());
    }

    response.setHeader('allow', url.pathname === SETTINGS_API ? 'GET, PUT' : 'POST');
    return sendJson(response, 404, { error: 'settings endpoint not found', code: 'not_found' }, id);
  }

  snapshot() {
    const snapshot = this.store.snapshot();
    const hasBlockingDiagnostic = this.additionalDiagnostics.some((item) => item.severity === 'error');
    const valid = snapshot.valid && !hasBlockingDiagnostic;
    return {
      ...snapshot,
      build: BUILD_INFO,
      authentication: this.authentication,
      valid,
      mode: this.mode,
      restart_pending: this.restartPending,
      diagnostics: [...this.additionalDiagnostics, ...snapshot.diagnostics],
      schema: SETTINGS_SCHEMA,
      infrastructure: {
        config_path: this.configPath,
        state_path: this.store.statePath,
        state_writable: snapshot.storage?.writable ?? false,
        persistence: 'validated overrides in the intermediary state volume',
        compose_editable: false,
        secrets_editable: false,
        restart_on_apply: true,
        restart_strategy: 'after_active_request',
        frigate_auth_configured: Boolean(this.store.getEffectiveConfig()?.frigate?.auth_token
          || (this.store.getEffectiveConfig()?.frigate?.username && this.store.getEffectiveConfig()?.frigate?.password)),
        settings_token_configured: Boolean(this.token),
        ui_can_apply: Boolean(this.token)
          && !this.mutationDisabledReason
          && !hasBlockingDiagnostic
          && Boolean(snapshot.storage?.writable),
      },
    };
  }

  async readSettingsBody(request) {
    if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      return {
        status: 415,
        error: { error: 'settings requests require application/json', code: 'unsupported_media_type' },
      };
    }
    let parsed;
    try {
      const raw = await readBody(request, BODY_LIMIT);
      parsed = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      return {
        status: error.statusCode ?? 400,
        error: { error: 'settings request body must be valid JSON', code: 'invalid_json' },
      };
    }
    if (!isPlainObject(parsed) || !isPlainObject(parsed.settings)) {
      return {
        status: 400,
        error: { error: 'settings must be a JSON object', code: 'invalid_settings_request' },
      };
    }
    if (parsed.secrets !== undefined && (!isPlainObject(parsed.secrets) || Object.keys(parsed.secrets).length > 0)) {
      return {
        status: 400,
        error: {
          error: 'Secrets cannot be changed in the browser; update secrets.env on the host.',
          code: 'secrets_read_only',
        },
      };
    }
    return { ...parsed, settings: parsed.settings };
  }

  async apply(request, response, id) {
    const body = await this.readSettingsBody(request);
    if (body.error) return sendJson(response, body.status, body.error, id);
    return this.commit(request, response, id, body, () => this.store.save(body.settings));
  }

  async mutate(request, response, id, operation) {
    let body = { settings: {} };
    if (Number(request.headers['content-length'] ?? 0) > 0 || request.headers['transfer-encoding']) {
      body = await this.readSettingsBody(request);
      if (body.error) return sendJson(response, body.status, body.error, id);
    }
    return this.commit(request, response, id, body, operation);
  }

  async commit(request, response, id, body, operation) {
    if (!this.store.snapshot().storage?.writable) {
      return sendJson(response, 409, {
        error: 'The settings state location is not writable. Check the /app/state volume on the host.',
        code: 'settings_state_not_writable',
      }, id);
    }
    if (this.additionalDiagnostics.some((item) => item.severity === 'error')) {
      return sendJson(response, 409, {
        error: 'A required host-side setting must be fixed before browser changes can be applied.',
        code: 'host_configuration_fix_required',
        diagnostics: this.additionalDiagnostics,
      }, id);
    }
    if (this.mutationDisabledReason) {
      return sendJson(response, 409, {
        error: this.mutationDisabledReason,
        code: 'host_configuration_fix_required',
      }, id);
    }
    if (this.restartPending || this.applying) {
      return sendJson(response, 409, {
        error: 'A settings change is already being committed or restarted.',
        code: this.restartPending ? 'restart_pending' : 'settings_busy',
      }, id);
    }
    const expectedRevision = requestRevision(request, body);
    if (expectedRevision === null) {
      return sendJson(response, 428, {
        error: 'Include the revision returned by GET settings.',
        code: 'revision_required',
      }, id);
    }
    const currentRevision = this.store.snapshot().revision;
    if (expectedRevision !== currentRevision) {
      return sendJson(response, 409, {
        error: 'Settings changed since this page was loaded. Reload and try again.',
        code: 'stale_revision',
        revision: currentRevision,
      }, id);
    }

    this.applying = true;
    try {
      const saved = await operation();
      this.restartPending = true;
      try {
        this.onRestartPending();
      } catch (error) {
        this.logger?.error('could not stop admission after settings commit', { error: error.message });
      }
      this.armRestart(response);
      return sendJson(response, 202, {
        ok: true,
        revision: saved.revision,
        restart_required: true,
        restart_pending: true,
        restarting: true,
        message: 'Settings were saved. New GPU work is held; the intermediary will restart after the active request finishes.',
      }, id);
    } catch (error) {
      if (error instanceof SettingsValidationError) {
        return sendJson(response, 422, {
          error: error.message,
          code: error.code,
          diagnostics: error.diagnostics,
        }, id);
      }
      this.logger?.error('settings could not be persisted', { error: error.message });
      return sendJson(response, 500, {
        error: 'Settings could not be saved. Verify that the intermediary state volume is writable.',
        code: 'settings_storage_error',
      }, id);
    } finally {
      this.applying = false;
    }
  }

  armRestart(response) {
    const trigger = () => {
      if (this.restartTriggered) return;
      this.restartTriggered = true;
      setImmediate(() => Promise.resolve(this.onRestart()).catch((error) => {
        this.logger?.error('settings restart failed', { error: error.stack ?? error.message });
      }));
    };
    response.once('finish', trigger);
    response.once('close', trigger);
    const fallback = setTimeout(trigger, 1_000);
    fallback.unref?.();
  }
}
