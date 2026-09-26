(function () {
  'use strict';

  var SETTINGS_URL = '/_intermediary/v1/settings';
  var VALIDATE_URL = '/_intermediary/v1/settings/validate';
  var APPLY_URL = '/_intermediary/v1/settings/apply';
  var ROLLBACK_URL = '/_intermediary/v1/settings/rollback';
  var RESET_URL = '/_intermediary/v1/settings/reset';
  var ADMIN_TOKEN_KEY = 'ai-intermediary-admin-token';
  var memoryToken = '';
  var loadedSettings = null;
  var loadedEnvelope = null;
  var loadedRevision = null;
  var busy = false;
  var dirty = false;
  var lastValidatedSignature = '';
  var lastApplyFeedback = null;
  var touchedPaths = new Set();
  var removedBackends = new Set();
  var catchupRefreshPromise = null;
  var catchupRefreshController = null;
  var catchupRefreshTimer = null;
  var workspaceVisible = false;

  function byId(id) { return document.getElementById(id); }
  function all(selector) { return Array.prototype.slice.call(document.querySelectorAll(selector)); }
  function setText(id, value) {
    var element = byId(id);
    if (element) element.textContent = value == null || value === '' ? '—' : String(value);
  }
  function setHidden(id, hidden) {
    var element = byId(id);
    if (element) element.hidden = Boolean(hidden);
  }
  function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
  function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  function getToken() {
    return readSession(ADMIN_TOKEN_KEY) || memoryToken;
  }
  function readSession(key) {
    try { return sessionStorage.getItem(key) || ''; } catch (_) { return ''; }
  }
  function writeSession(key, value) {
    try { if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key); } catch (_) { /* Tab memory fallback. */ }
  }
  function setToken(value) {
    memoryToken = String(value || '');
    writeSession(ADMIN_TOKEN_KEY, memoryToken);
    setHidden('forget-token', !memoryToken);
  }
  function headers(withBody) {
    var result = { accept: 'application/json' };
    if (withBody) result['content-type'] = 'application/json';
    if (withBody && loadedRevision != null) result['if-match'] = String(loadedRevision);
    var token = getToken();
    if (token) result.authorization = 'Bearer ' + token;
    return result;
  }
  function formatDate(value) {
    if (!value) return '—';
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }
  async function parseResponse(response) {
    var text = await response.text();
    if (!text) return {};
    try { return JSON.parse(text); }
    catch (_) { return { error: text }; }
  }
  function errorMessage(payload, fallback) {
    if (!payload) return fallback;
    if (typeof payload.error === 'string') return payload.error;
    if (payload.error && typeof payload.error.message === 'string') return payload.error.message;
    if (typeof payload.message === 'string') return payload.message;
    return fallback;
  }
  function showPageError(message) {
    setText('page-error', message);
    setHidden('page-error', !message);
  }
  function showAuth(message) {
    workspaceVisible = false;
    stopCatchupRefresh();
    setHidden('settings-workspace', true);
    setHidden('auth-panel', false);
    setText('auth-message', message || 'Enter your administrator password.');
    window.setTimeout(function () { byId('admin-token').focus(); }, 0);
  }
  function showWorkspace() {
    workspaceVisible = true;
    setHidden('auth-panel', true);
    setHidden('settings-workspace', false);
  }

  function pathParts(path) { return String(path || '').split('.').filter(Boolean).map(decodeURIComponent); }
  function getPath(source, path) {
    return pathParts(path).reduce(function (current, key) {
      return current == null ? undefined : current[key];
    }, source);
  }
  function hasPath(source, path) {
    var current = source;
    var parts = pathParts(path);
    for (var index = 0; index < parts.length; index += 1) {
      if (current == null || !Object.prototype.hasOwnProperty.call(Object(current), parts[index])) return false;
      current = current[parts[index]];
    }
    return true;
  }
  function setPath(target, path, value) {
    var parts = pathParts(path);
    var current = target;
    parts.forEach(function (key, index) {
      if (index === parts.length - 1) {
        current[key] = value;
        return;
      }
      var nextIsIndex = /^[0-9]+$/.test(parts[index + 1]);
      if (!current[key] || typeof current[key] !== 'object') current[key] = nextIsIndex ? [] : {};
      current = current[key];
    });
  }
  function inputValue(input) {
    if (input.dataset.list === 'true') return input.value.split(/[\s,]+/).filter(Boolean);
    if (input.type === 'checkbox') return input.checked;
    if (input.type === 'number') return input.value === '' ? null : Number(input.value);
    if (input.dataset.nullable === 'true' && input.value.trim() === '') return null;
    return input.value.trim();
  }
  function setInputValue(input, value) {
    if (input.dataset.list === 'true') { input.value = Array.isArray(value) ? value.join(', ') : ''; return; }
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = value == null ? '' : String(value);
  }
  function settingsFromEnvelope(payload) {
    if (payload && payload.settings && typeof payload.settings === 'object') return payload.settings;
    return {};
  }
  function populateForm(settings) {
    removedBackends.clear();
    renderPolicyEditors(settings);
    var defaultClient = byId('default-client');
    all('#default-client option[data-dynamic-client]').forEach(function (option) { option.remove(); });
    var availableClients = Object.keys(asObject(settings.clients));
    var selectedClient = getPath(settings, 'scheduler.default_client');
    if (selectedClient && !availableClients.includes(selectedClient)) availableClients.push(selectedClient);
    availableClients.forEach(function (name) {
      if (all('#default-client option').some(function (option) { return option.value === name; })) return;
      var option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      option.dataset.dynamicClient = 'true';
      defaultClient.appendChild(option);
    });
    all('[data-path]').forEach(function (input) {
      setInputValue(input, getPath(settings, input.dataset.path));
    });
    setText('fallback-client-readout', getPath(settings, 'scheduler.default_client') || 'Odysseus');
    renderCompose(settings);
  }

  function policyField(parent, path, label, type, value, choices) {
    var wrap = document.createElement('div'); wrap.className = 'field'; wrap.dataset.fieldWrap = path;
    if (type === 'checkbox') wrap.className += ' policy-checkbox';
    var element = document.createElement('label'); element.textContent = label;
    var input = document.createElement(choices ? 'select' : 'input');
    if (choices) choices.forEach(function (choice) {
      var option = document.createElement('option'); option.value = choice; option.textContent = choice; input.appendChild(option);
    });
    else input.type = type === 'list' ? 'text' : type;
    if (type === 'list') input.dataset.list = 'true';
    if (path.endsWith('.keep_alive')) input.dataset.nullable = 'true';
    input.dataset.path = path; setInputValue(input, value);
    element.appendChild(input); wrap.appendChild(element); parent.appendChild(wrap);
  }
  function sourceEditor(name, policy) {
    var card = document.createElement('fieldset'); card.className = 'settings-card';
    var legend = document.createElement('legend'); legend.textContent = name; card.appendChild(legend);
    var grid = document.createElement('div'); grid.className = 'field-grid field-grid-2'; card.appendChild(grid);
    var root = 'clients.' + encodeURIComponent(name).replace(/\./g, '%2E') + '.';
    var backendNames = Object.keys(asObject(collectSettings().backends));
    if (policy.backend && !backendNames.includes(policy.backend)) backendNames.push(policy.backend);
    [['enabled', 'Enabled', 'checkbox'], ['header_enabled', 'Accept X-Ollama-Client: ' + name, 'checkbox'],
      ['backend', 'Default backend (engine for compatible requests)', 'text', backendNames],
      ['allowed_backends', 'Allowed backend names (comma separated)', 'list'],
      ['listener_port', 'Dedicated container port (0 = off)', 'number'], ['source_ips', 'IP/subnets (comma separated; empty = off)', 'list'],
      ['priority', 'Priority (larger runs first)', 'number'], ['queue_limit', 'Maximum queued requests', 'number'],
      ['request_ttl', 'Queue lifetime (e.g. 10m)', 'text'], ['queue_while_paused', 'Hold connected live requests during pauses (off = reject)', 'checkbox'],
      ['deduplication.enabled', 'Deduplicate using configured stable identifiers (advanced)', 'checkbox'],
      ['overflow_policy', 'When queue fills', 'text', ['reject', 'drop_oldest', 'drop_newest']],
      ['model_policy.idle_hold', 'Follow-up hold before lower priority (e.g. 20s)', 'text'],
      ['max_wait', 'Balanced mode: forced switch wait', 'text'],
      ['model_policy.max_batch_requests', 'Balanced mode: maximum batch requests', 'number'],
      ['model_policy.max_batch_time', 'Balanced mode: maximum batch time', 'text'],
      ['model_policy.keep_alive', 'Ollama model keep-alive (blank = client choice)', 'text']].forEach(function (field) {
        policyField(grid, root + field[0], field[1], field[2], getPath(policy, field[0]), field[3]);
      });
    var help = document.createElement('p'); help.className = 'field-help';
    help.textContent = 'Source priority decides who runs next; backend decides which engine runs it. Only compatible request formats may use an allowed backend. Hold during pause applies to connected HTTP requests only; disconnected or expired requests are never replayed. Accepted media jobs are durable and use the separate media lifetime. Frigate catch-up uses retained IDs separately. Model hold/keep-alive applies to Ollama; another engine must first receive verified GPU ownership.';
    card.appendChild(help); byId('source-editors').appendChild(card);
    return card;
  }
  function backendEditor(name, backend) {
    var card = document.createElement('fieldset'); card.className = 'settings-card';
    var legend = document.createElement('legend'); legend.textContent = name; card.appendChild(legend);
    var grid = document.createElement('div'); grid.className = 'field-grid field-grid-2'; card.appendChild(grid);
    var root = 'backends.' + encodeURIComponent(name).replace(/\./g, '%2E') + '.';
    [['type', 'Backend software / adapter', 'text', ['ollama', 'comfyui']], ['enabled', 'Enabled', 'checkbox'],
      ['url', 'Raw backend origin (not the intermediary)', 'url'], ['resource_group', 'Shared GPU resource', 'text', ['gpu0']]].forEach(function (field) {
        policyField(grid, root + field[0], field[1], field[2], backend[field[0]], field[3]);
      });
    if (backend.type !== 'ollama') {
      var remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary-button'; remove.textContent = 'Remove backend from draft';
      remove.addEventListener('click', function () {
        if (busy) return;
        removedBackends.add(name); card.remove(); lastValidatedSignature = ''; updateDirtyState();
      });
      card.appendChild(remove);
    }
    byId('backend-editors').appendChild(card); return card;
  }
  function addBackend() {
    if (busy || !loadedSettings) return;
    var nameInput = byId('new-backend-name'), name = nameInput.value.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) { showPageError('Use a backend name with 1–64 letters, numbers, underscores or dashes.'); return; }
    if (Object.prototype.hasOwnProperty.call(collectSettings().backends, name)) { showPageError('That backend already exists.'); return; }
    removedBackends.delete(name);
    var card = backendEditor(name, { type: 'comfyui', enabled: false, url: 'http://host.docker.internal:8188', resource_group: 'gpu0' });
    card.querySelectorAll('[data-path]').forEach(function (input) { touchedPaths.add(input.dataset.path); });
    all('[data-path$=".backend"]').forEach(function (select) {
      var option = document.createElement('option'); option.value = name; option.textContent = name; select.appendChild(option);
    });
    nameInput.value = ''; lastValidatedSignature = ''; showPageError(''); updateDirtyState();
  }
  function scheduleEditor(name, policy) {
    var card = document.createElement('fieldset'); card.className = 'settings-card';
    var legend = document.createElement('legend'); legend.textContent = name; card.appendChild(legend);
    var grid = document.createElement('div'); grid.className = 'field-grid field-grid-2'; card.appendChild(grid);
    var root = 'work_policy.schedules.' + name + '.';
    [['enabled', 'Enabled', 'checkbox'], ['days', 'Start days (sun, mon, tue, wed, thu, fri, sat)', 'list'],
      ['start', 'Start local time', 'time'], ['end', 'End local time', 'time'],
      ['sources', 'Source names (comma separated, or * for all)', 'list'],
      ['traffic', 'Work to pause', 'text', ['all', 'live', 'catchup']],
      ['mode', 'Pause or reserve GPU', 'text', ['pause', 'release_gpu']]].forEach(function (field) {
        policyField(grid, root + field[0], field[1], field[2], policy[field[0]], field[3]);
      });
    byId('schedule-editors').appendChild(card); return card;
  }
  function renderPolicyEditors(settings) {
    // Use the same source editor for every configured application.
    ['odysseus', 'frigate', 'frigate-source'].forEach(function (id) {
      var old = byId(id); old.hidden = true;
      old.querySelectorAll('[data-path]').forEach(function (input) { input.removeAttribute('data-path'); });
      all('a[href="#' + id + '"]').forEach(function (link) { link.hidden = true; });
    });
    var legacyIp = all('[data-path="clients.frigate.source_ips.0"]')[0];
    if (legacyIp) { legacyIp.removeAttribute('data-path'); legacyIp.disabled = true; legacyIp.placeholder = 'Configure under Sources & ports'; }
    byId('source-editors').replaceChildren(); byId('schedule-editors').replaceChildren(); byId('backend-editors').replaceChildren();
    Object.entries(asObject(settings.backends)).forEach(function (entry) { backendEditor(entry[0], entry[1]); });
    // The registry is authoritative; a base URL field remains for configuration recovery.
    var legacyBackendUrl = byId('ollama-url');
    var hasRegistry = Object.keys(asObject(settings.backends)).length > 0;
    setHidden('base-ollama-url', hasRegistry);
    if (hasRegistry) delete legacyBackendUrl.dataset.path;
    else legacyBackendUrl.dataset.path = 'ollama.url';
    Object.entries(asObject(settings.clients)).forEach(function (entry) { sourceEditor(entry[0], entry[1]); });
    Object.entries(asObject(settings.work_policy && settings.work_policy.schedules)).forEach(function (entry) { scheduleEditor(entry[0], entry[1]); });
  }
  function addPolicy(kind) {
    if (busy || !loadedSettings) return;
    var nameInput = byId('new-' + kind + '-name'), name = nameInput.value.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) { showPageError('Use 1–64 letters, numbers, underscores or dashes, starting with a letter or number.'); return; }
    var draft = collectSettings(), card;
    if (kind === 'source') {
      if (Object.prototype.hasOwnProperty.call(draft.clients, name)) { showPageError('That source already exists.'); return; }
      card = sourceEditor(name, { enabled: true, header_enabled: true, listener_port: 0, source_ips: [], priority: 10,
        backend: Object.keys(asObject(draft.backends)).find(function (key) { return draft.backends[key].type === 'ollama'; }) || 'ollama',
        allowed_backends: [Object.keys(asObject(draft.backends)).find(function (key) { return draft.backends[key].type === 'ollama'; }) || 'ollama'],
        queue_limit: 20, request_ttl: '10m', max_wait: '5m', queue_while_paused: false, overflow_policy: 'reject',
        model_policy: { idle_hold: '0s', keep_alive: null, max_batch_requests: 1, max_batch_time: '60s' } });
      var option = document.createElement('option'); option.value = name; option.textContent = name; option.dataset.dynamicClient = 'true'; byId('default-client').appendChild(option);
    } else {
      if (Object.prototype.hasOwnProperty.call(draft.work_policy.schedules, name)) { showPageError('That schedule already exists.'); return; }
      card = scheduleEditor(name, { enabled: false, days: ['sun','mon','tue','wed','thu','fri','sat'], start: '01:00', end: '03:00', sources: ['*'], traffic: 'all', mode: 'pause' });
    }
    card.querySelectorAll('[data-path]').forEach(function (input) { touchedPaths.add(input.dataset.path); });
    nameInput.value = ''; lastValidatedSignature = ''; showPageError(''); updateDirtyState();
  }
  function renderCompose(settings) {
    var ports = Object.entries(asObject(settings.clients)).filter(function (entry) { return entry[1].listener_port > 0; });
    setText('source-compose', ports.length ? 'ports:\n' + ports.map(function (entry) {
      return '  - "' + entry[1].listener_port + ':' + entry[1].listener_port + '" # ' + entry[0];
    }).join('\n') + '\n\n# Add ports to the ai-intermediary service, preserving its current ports.\n# Then recreate that service:\n# docker compose up -d --no-deps ai-intermediary'
      : 'No additional source ports configured. Keep your existing main port mapping.');
  }
  function collectSettings() {
    var result = clone(loadedSettings || {});
    all('[data-path]').forEach(function (input) {
      var path = input.dataset.path;
      if (!touchedPaths.has(path)) return;
      var value = inputValue(input);
      if (path === 'clients.frigate.source_ips.0' && value === '') {
        var existingSources = getPath(result, 'clients.frigate.source_ips');
        if (Array.isArray(existingSources) && existingSources.length) {
          setPath(result, 'clients.frigate.source_ips', existingSources.slice(1));
        }
        return;
      }
      setPath(result, path, value);
    });
    removedBackends.forEach(function (name) { if (result.backends) delete result.backends[name]; });
    return result;
  }
  function collectPatch() {
    var result = {};
    all('[data-path]').forEach(function (input) {
      var path = input.dataset.path;
      if (!touchedPaths.has(path)) return;
      var value = inputValue(input);
      if (path === 'clients.frigate.source_ips.0') {
        var existingSources = getPath(loadedSettings, 'clients.frigate.source_ips');
        var nextSources = Array.isArray(existingSources) ? existingSources.slice() : [];
        if (value === '') nextSources = nextSources.slice(1);
        else if (nextSources.length) nextSources[0] = value;
        else nextSources.push(value);
        setPath(result, 'clients.frigate.source_ips', nextSources);
        return;
      }
      setPath(result, path, value);
    });
    if (Object.keys(result.backends || {}).length || removedBackends.size) {
      // Legacy installs synthesize their primary backend; persist the full registry on first edit.
      result.backends = clone(collectSettings().backends || {});
      removedBackends.forEach(function (name) { result.backends[name] = null; });
    }
    return result;
  }
  function requestPayload() {
    // The API accepts patches. Sending only touched fields prevents a repair of
    // one invalid base setting from accidentally pinning every displayed base
    // value into the persistent override document.
    return { settings: collectPatch() };
  }
  function signature() {
    return JSON.stringify({ settings: collectSettings() });
  }
  function calculateDirty() {
    if (!loadedSettings) return false;
    return signature() !== JSON.stringify({ settings: loadedSettings });
  }

  function secretConfigured(payload, name) {
    var statuses = asObject(payload.secret_status || payload.secrets);
    if (name === 'admin_token' && payload.infrastructure && typeof payload.infrastructure.settings_token_configured === 'boolean') {
      return payload.infrastructure.settings_token_configured;
    }
    var aliases = [name, name + '_configured', name.replace('_token', ''), name.replace(/_([a-z])/g, function (_, c) { return c.toUpperCase(); })];
    for (var i = 0; i < aliases.length; i += 1) {
      var value = statuses[aliases[i]];
      if (typeof value === 'boolean') return value;
      if (value && typeof value.configured === 'boolean') return value.configured;
      if (value && typeof value.present === 'boolean') return value.present;
      if (typeof value === 'string') return value.length > 0;
    }
    return null;
  }
  function renderSecretStatus(payload) {
    [
      ['media_token', 'media-secret-state'],
      ['admin_token', 'admin-secret-state']
    ].forEach(function (entry) {
      var configured = secretConfigured(payload, entry[0]);
      var badge = byId(entry[1]);
      badge.className = 'configured-badge';
      if (configured === true) { badge.classList.add('is-configured'); badge.textContent = 'Configured'; }
      else if (configured === false) { badge.classList.add('is-missing'); badge.textContent = 'Missing'; }
      else badge.textContent = 'Not reported';
    });
  }

  function normalizeDiagnostics(payload) {
    var infrastructure = payload.infrastructure;
    var source = infrastructure && (infrastructure.diagnostics || infrastructure.checks || (Array.isArray(infrastructure) ? infrastructure : null));
    if (!source && infrastructure && typeof infrastructure === 'object') {
      source = Object.keys(infrastructure).filter(function (key) {
        return key !== 'diagnostics' && key !== 'checks' && key !== 'ollama';
      }).map(function (key) {
        var value = infrastructure[key];
        var title = key.replace(/_/g, ' ').replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
        var message;
        if (typeof value === 'boolean') message = value ? 'Yes' : 'No';
        else if (value == null) message = 'Not reported';
        else if (typeof value === 'object') message = JSON.stringify(value);
        else message = String(value);
        var expectedFalse = key === 'compose_editable' || key === 'secrets_editable';
        return {
          id: key,
          title: title,
          message: message,
          ok: expectedFalse ? value === false : (key === 'ui_can_apply' || key === 'frigate_auth_configured' ? undefined : (typeof value === 'boolean' ? value : undefined)),
          severity: key === 'ui_can_apply' && value === false ? 'warning' : 'info'
        };
      });
    }
    if (!source) source = payload.infrastructure_diagnostics || [];
    if (!Array.isArray(source) && source && typeof source === 'object') {
      source = Object.keys(source).map(function (key) {
        var value = source[key];
        return typeof value === 'object' ? Object.assign({ id: key }, value) : { id: key, message: String(value) };
      });
    }
    var combined = Array.isArray(source) ? source.slice() : [];
    var configurationDiagnostics = Array.isArray(payload.diagnostics) ? payload.diagnostics : [];
    configurationDiagnostics.forEach(function (item) {
      if (!item) return;
      var normalized = typeof item === 'string' ? { message: item } : Object.assign({}, item);
      normalized.title = normalized.title
        || (normalized.path && normalized.path !== '$' ? normalized.path : null)
        || normalized.code
        || 'Configuration check';
      combined.push(normalized);
    });
    return combined;
  }
  function diagnosticSeverity(item) {
    var severity = String(item.severity || item.level || item.status || '').toLowerCase();
    if (item.ok === true || severity === 'ok' || severity === 'pass' || severity === 'healthy') return 'good';
    if (item.ok === false || severity === 'error' || severity === 'critical' || severity === 'failed') return 'error';
    if (severity === 'warning' || severity === 'warn' || severity === 'restart_required') return 'warning';
    return 'neutral';
  }
  function renderDiagnostics(payload) {
    var diagnostics = normalizeDiagnostics(payload);
    var list = byId('diagnostics-list');
    list.replaceChildren();
    var errors = 0;
    var warnings = 0;
    diagnostics.forEach(function (item) {
      item = typeof item === 'string' ? { message: item } : asObject(item);
      var severity = diagnosticSeverity(item);
      if (severity === 'error') errors += 1;
      if (severity === 'warning') warnings += 1;
      var li = document.createElement('li');
      li.className = 'diagnostic diagnostic-' + severity;
      var icon = document.createElement('span');
      icon.className = 'diagnostic-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = severity === 'good' ? '\u2713' : severity === 'error' ? '!' : severity === 'warning' ? '\u2022' : 'i';
      var copy = document.createElement('div');
      var title = document.createElement('strong');
      title.textContent = item.title || item.name || item.id || 'Infrastructure check';
      var message = document.createElement('p');
      message.textContent = item.message || item.detail || 'No details reported.';
      copy.appendChild(title);
      copy.appendChild(message);
      if (item.remediation || item.action) {
        var remediation = document.createElement('small');
        remediation.textContent = item.remediation || item.action;
        copy.appendChild(remediation);
      }
      li.appendChild(icon);
      li.appendChild(copy);
      list.appendChild(li);
    });
    setHidden('diagnostics-empty', diagnostics.length > 0);
    var badge = byId('diagnostics-summary');
    badge.className = 'status-pill';
    if (errors) { badge.classList.add('status-error'); badge.textContent = errors + ' error' + (errors === 1 ? '' : 's'); }
    else if (warnings) { badge.classList.add('status-warning'); badge.textContent = warnings + ' warning' + (warnings === 1 ? '' : 's'); }
    else if (diagnostics.length) { badge.classList.add('status-good'); badge.textContent = 'All checks passed'; }
    else { badge.classList.add('status-neutral'); badge.textContent = 'Not reported'; }
  }

  function clearErrors() {
    all('[data-field-wrap]').forEach(function (element) { element.classList.remove('has-error'); });
    all('[data-error-for]').forEach(function (element) { element.textContent = ''; });
    setHidden('validation-summary', true);
  }
  function normalizeErrors(payload) {
    var source = payload.field_errors || payload.errors || (payload.validation && (payload.validation.errors || payload.validation.diagnostics)) || payload.diagnostics || [];
    var result = [];
    if (Array.isArray(source)) {
      source.forEach(function (error) {
        if (typeof error === 'string') result.push({ path: '', message: error });
        else if (error && typeof error === 'object' && String(error.severity || 'error').toLowerCase() === 'error') result.push({ path: error.path || error.field || error.pointer || '', message: error.message || error.error || 'Invalid value' });
      });
    } else if (source && typeof source === 'object') {
      Object.keys(source).forEach(function (path) {
        var value = source[path];
        if (Array.isArray(value)) value.forEach(function (message) { result.push({ path: path, message: String(message) }); });
        else result.push({ path: path, message: typeof value === 'string' ? value : (value.message || 'Invalid value') });
      });
    }
    return result;
  }
  function normalizeErrorPath(path) {
    return String(path || '').replace(/^settings\./, '').replace(/^\//, '').replace(/\//g, '.').replace(/\[(\d+)\]/g, '.$1');
  }
  function browserFieldErrors() {
    var errors = [];
    all('[data-path]').forEach(function (input) {
      var value = input.type === 'checkbox' ? '' : input.value.trim();
      if (input.required && !value) {
        errors.push({ path: input.dataset.path, message: 'A value is required.' });
      } else if (input.validity && input.validity.typeMismatch) {
        errors.push({ path: input.dataset.path, message: 'Enter a valid value in the requested format.' });
      } else if (input.validity && (input.validity.badInput || input.validity.rangeOverflow || input.validity.rangeUnderflow || input.validity.stepMismatch)) {
        errors.push({ path: input.dataset.path, message: input.validationMessage || 'Enter a value within the allowed range.' });
      }
    });
    return errors;
  }
  function renderErrors(payload) {
    clearErrors();
    var errors = normalizeErrors(payload);
    browserFieldErrors().forEach(function (error) {
      if (!errors.some(function (existing) { return normalizeErrorPath(existing.path) === error.path; })) errors.push(error);
    });
    errors.forEach(function (error) {
      var path = normalizeErrorPath(error.path);
      var wrap = all('[data-field-wrap]').find(function (element) { return element.dataset.fieldWrap === path; });
      var output = all('[data-error-for]').find(function (element) { return element.dataset.errorFor === path; });
      if (wrap) wrap.classList.add('has-error');
      if (output) output.textContent = error.message;
    });
    if (errors.length) {
      var summary = byId('validation-summary');
      var located = errors.filter(function (error) { return Boolean(error.path); }).length;
      summary.textContent = errors.length + ' configuration ' + (errors.length === 1 ? 'error needs' : 'errors need') + ' attention.' + (located < errors.length ? ' ' + (errors.length - located) + ' general error(s) are listed by the server.' : '');
      summary.hidden = false;
      summary.focus();
    }
    return errors;
  }

  function restartInfo(payload) {
    var required = payload.restart_required === true;
    var pending = payload.restart_pending === true;
    return {
      required: required || pending,
      title: pending || payload.restarting ? 'Waiting for safe restart' : 'Restart required',
      detail: payload.message || 'Settings are saved. The current GPU request will finish before the intermediary restarts; new requests are held.'
    };
  }
  function renderRestart(payload) {
    var info = restartInfo(payload);
    setHidden('restart-banner', !info.required);
    if (info.required) {
      setText('restart-title', info.title);
      setText('restart-detail', info.detail);
    }
  }
  function configValidity(payload) {
    if (payload.valid === false || payload.configuration_valid === false) return false;
    if (browserFieldErrors().length) return false;
    if (payload.valid === true || payload.configuration_valid === true) return true;
    return normalizeErrors(payload).length === 0;
  }
  function renderConfiguration(payload) {
    var valid = configValidity(payload);
    var restart = restartInfo(payload);
    var mode = String(payload.mode || '').toLowerCase();
    var recovery = mode === 'recovery' || mode === 'configuration_error';
    var banner = byId('configuration-banner');
    banner.className = 'configuration-banner ' + (!valid || recovery ? 'state-error' : restart.required ? 'state-warning' : 'state-good');
    if (!valid || recovery) {
      setText('configuration-title', 'Configuration needs attention');
      setText('configuration-detail', recovery
        ? 'The intermediary is in restricted recovery mode. Correct the red fields, validate the draft, and apply it before inference can resume.'
        : 'Correct the red fields, validate the draft, and apply it before inference continues.');
    } else if (restart.required) {
      setText('configuration-title', 'Saved settings are waiting for restart');
      setText('configuration-detail', restart.detail);
    } else {
      setText('configuration-title', 'Configuration is valid');
      setText('configuration-detail', 'The structured settings passed the intermediary\'s current validation checks.');
    }
    setText('configuration-revision', payload.revision != null ? payload.revision : (payload.etag != null ? payload.etag : (payload.version != null ? payload.version : '—')));
    setText('configuration-applied-at', formatDate(payload.applied_at || payload.updated_at));
    renderRestart(payload);
  }

  function setBusy(next, label) {
    busy = next;
    all('#settings-form button').forEach(function (button) { button.disabled = next; });
    if (!next) all('#settings-form button').forEach(function (button) { button.disabled = false; });
    if (!next) updateDirtyState();
    if (next) {
      setText('action-title', label || 'Working…');
      setText('action-detail', 'Keep this page open while the intermediary processes the request.');
    }
  }
  function updateDirtyState() {
    renderCompose(collectSettings());
    dirty = calculateDirty();
    var validForCurrentDraft = dirty && lastValidatedSignature === signature();
    var restartPending = Boolean(loadedEnvelope && loadedEnvelope.restart_pending);
    var canMutateSaved = !restartPending && Boolean(loadedEnvelope && loadedEnvelope.infrastructure && loadedEnvelope.infrastructure.ui_can_apply !== false);
    byId('discard-button').disabled = busy || !dirty;
    byId('validate-button').disabled = busy;
    byId('apply-button').disabled = busy || !dirty || !validForCurrentDraft || !canMutateSaved;
    byId('rollback-button').disabled = busy || dirty || !canMutateSaved || !Boolean(loadedEnvelope && loadedEnvelope.has_previous);
    byId('reset-button').disabled = busy || dirty || !canMutateSaved;
    byId('catchup-scan').disabled = busy || dirty || !loadedSettings || !loadedSettings.frigate || !loadedSettings.frigate.enabled || restartPending;
    var strict = getPath(collectSettings(), 'scheduler.mode') !== 'balanced';
    all('[data-field-wrap]').forEach(function (wrap) {
      var field = wrap.dataset.fieldWrap;
      var legacy = field.startsWith('scheduler.aging_') || field === 'scheduler.priority_aging'
        || field.endsWith('.max_wait') || field.endsWith('.max_batch_requests') || field.endsWith('.max_batch_time');
      if (legacy) { wrap.hidden = strict; wrap.querySelectorAll('input,select').forEach(function (input) { input.disabled = strict; }); }
    });
    var state = byId('document-state');
    state.className = 'status-pill ' + (dirty || restartPending ? 'status-warning' : 'status-good');
    state.textContent = restartPending ? 'Waiting for safe restart' : dirty ? 'Unapplied changes' : 'Settings current';
    if (restartPending) {
      setText('action-title', 'Settings saved · waiting for safe restart');
      setText('action-detail', 'Active work will finish first. Reload after the intermediary restarts to check the applied settings.');
    } else if (dirty) {
      setText('action-title', !canMutateSaved ? 'Host fix required' : (validForCurrentDraft ? 'Draft validated' : 'Unapplied changes'));
      setText('action-detail', !canMutateSaved
        ? 'Validation remains available, but applying is disabled until the host-side diagnostic is corrected.'
        : (validForCurrentDraft ? 'This exact draft passed validation and is ready to apply.' : 'Validate the draft before applying it.'));
    } else if (lastApplyFeedback) {
      setText('action-title', lastApplyFeedback.title);
      setText('action-detail', lastApplyFeedback.detail);
    } else {
      setText('action-title', 'No unapplied changes');
      setText('action-detail', 'Edit a field to create a draft.');
    }
    setText('fallback-client-readout', getPath(collectSettings(), 'scheduler.default_client') || 'Odysseus');
    renderFrigateAuthentication();
    renderWarmModelHint();
  }

  function durationSeconds(value) {
    if (typeof value === 'number') return value;
    var match = /^(-?\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(String(value == null ? '' : value).trim());
    if (!match) return null;
    return Number(match[1]) * ({ ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 }[match[2] || 's']);
  }

  function renderWarmModelHint() {
    var settings = collectSettings();
    var keepAlive = durationSeconds(getPath(settings, 'clients.frigate.model_policy.keep_alive'));
    var confirmation = durationSeconds(getPath(settings, 'frigate.confirmation_interval')) || 2;
    // Frigate's native preparation can also take time; this is a recommendation,
    // not a measured guarantee about how long a particular model takes to load.
    var usefulGap = Math.max(30, confirmation * 2);
    var show = getPath(settings, 'frigate.enabled') && keepAlive != null && keepAlive >= 0 && keepAlive < usefulGap;
    setHidden('catchup-warm-warning', !show);
    setText('catchup-warm-detail', 'Frigate keep-alive is shorter than a useful gap between catch-up jobs and may cause repeated model loads. Consider 2m to keep the model warm; this occupies VRAM while idle but does not reserve the GPU against higher-priority work.');
    byId('catchup-use-warm-model').disabled = busy || Boolean(loadedEnvelope && loadedEnvelope.restart_pending);
  }

  function useWarmModel() {
    if (busy || !loadedSettings || loadedEnvelope && loadedEnvelope.restart_pending) return;
    var path = 'clients.frigate.model_policy.keep_alive';
    var input = all('[data-path]').find(function (field) { return field.dataset.path === path; });
    if (!input) return;
    input.value = '2m';
    touchedPaths.add(path);
    lastValidatedSignature = '';
    lastApplyFeedback = null;
    updateDirtyState();
  }

  function renderFrigateAuthentication() {
    var mode = getPath(collectSettings(), 'frigate.auth_mode') || 'auto';
    var configured = loadedEnvelope && loadedEnvelope.infrastructure && loadedEnvelope.infrastructure.frigate_auth_configured;
    setText('catchup-auth', mode === 'none'
      ? 'No Frigate login is required. The intermediary will send no credentials. Only use this on a trusted local network.'
      : configured ? 'Frigate credentials are managed in secrets.env; their values are never sent to this page.'
      : 'For an open local API, select No login required above. Otherwise add the selected credentials to secrets.env and recreate the container.');
  }

  function applyEnvelope(payload) {
    loadedEnvelope = payload;
    loadedSettings = clone(settingsFromEnvelope(payload));
    loadedRevision = payload.revision != null ? payload.revision : (payload.etag != null ? payload.etag : (payload.version != null ? payload.version : null));
    touchedPaths.clear();
    populateForm(loadedSettings);
    renderConfiguration(payload);
    renderSecretStatus(payload);
    renderDiagnostics(payload);
    renderErrors(payload);
    if (payload.connectivity || payload.backend || payload.backend_connectivity || (payload.infrastructure && payload.infrastructure.ollama)) {
      renderConnectivity(payload, true);
    }
    lastValidatedSignature = '';
    showWorkspace();
    updateDirtyState();
    // Anchors may have been resolved while the authenticated workspace was hidden.
    var section = window.location && window.location.hash;
    if (section && /^#[a-z-]+$/.test(section)) window.setTimeout(function () {
      var target = byId(section.slice(1));
      if (target) target.scrollIntoView({ block: 'start' });
    }, 0);
    refreshCatchup();
    startCatchupRefresh();
  }

  async function refreshCatchup() {
    if (!workspaceVisible || document.hidden) return;
    if (catchupRefreshPromise) return catchupRefreshPromise;
    var controller = new AbortController();
    catchupRefreshController = controller;
    var timeout = window.setTimeout(function () { controller.abort(); }, 10000);
    catchupRefreshPromise = (async function () {
      try {
        var response = await fetch('/_intermediary/v1/frigate/status', { headers: headers(false), cache: 'no-store', signal: controller.signal });
        if (response.status === 401 || response.status === 403) { showAuth('The settings admin token was rejected.'); return; }
        if (!response.ok) throw new Error('HTTP ' + response.status);
        var data = await response.json();
        if (!workspaceVisible || controller.signal.aborted) return;
        setText('catchup-state', data.state || 'Unknown');
        var counts = data.counts || {};
        setText('catchup-status', 'Objects: ' + (data.capabilities && data.capabilities.object ? 'supported' : 'not verified')
          + ' · Reviews: ' + (data.capabilities && data.capabilities.review ? 'supported' : 'not verified')
          + ' · Waiting: ' + ((counts.pending || 0) + (counts.waiting_live || 0))
          + ' · Generation / unconfirmed: ' + (counts.waiting_result || 0) + ' · Retrying: ' + (counts.retrying || 0)
          + ' · Needs attention: ' + (data.attention_count || 0)
          + (data.bridge_mode === 'correlated'
            ? ' · Frigate bridge connected · Awaiting save: ' + (data.verifying_count || 0) + ' / ' + (data.max_verifying || 4)
            : ' · Compatibility mode: install the pinned Frigate bridge for faster correlated catch-up; otherwise one unconfirmed handoff is the safe limit.')
          + (data.last_error ? ' · ' + (data.last_error.message || data.last_error.code || data.last_error) : ''));
      } catch (_) {
        if (workspaceVisible && !document.hidden) setText('catchup-status', 'Catch-up status could not refresh. Retrying automatically; your draft is unchanged.');
      } finally {
        window.clearTimeout(timeout);
        catchupRefreshPromise = null;
        catchupRefreshController = null;
      }
    })();
    return catchupRefreshPromise;
  }

  function startCatchupRefresh() {
    if (!catchupRefreshTimer && workspaceVisible && !document.hidden) catchupRefreshTimer = window.setInterval(refreshCatchup, 5000);
  }

  function stopCatchupRefresh() {
    if (catchupRefreshTimer) window.clearInterval(catchupRefreshTimer);
    catchupRefreshTimer = null;
    if (catchupRefreshController) catchupRefreshController.abort();
  }

  byId('catchup-scan').addEventListener('click', async function () {
    if (busy || dirty) return;
    if (!window.confirm('Scan all retained eligible objects and reviews without descriptions? This can create a large background backlog. Items with descriptions are skipped at the final check.')) return;
    setBusy(true, 'Starting historical discovery…');
    try {
      var response = await fetch('/_intermediary/v1/frigate/scan', {
        method: 'POST', headers: headers(true), body: JSON.stringify({ confirm: true })
      });
      var payload = await parseResponse(response);
      if (!response.ok) throw new Error(errorMessage(payload, 'The scan could not start.'));
      setText('catchup-status', 'Historical scan accepted. Catch-up runs one job at a time when live work is idle.');
      await refreshCatchup();
    } catch (error) { showPageError(error.message); }
    finally { setBusy(false); }
  });

  async function loadSettings() {
    showPageError('');
    var response;
    try {
      response = await fetch(SETTINGS_URL, { method: 'GET', headers: headers(false), cache: 'no-store' });
    } catch (_) {
      showPageError('The intermediary could not be reached. Check the address and try again.');
      showAuth('The settings API could not be reached.');
      return;
    }
    var payload = await parseResponse(response);
    if (response.status === 401 || response.status === 403) {
      showAuth(errorMessage(payload, 'A valid settings admin token is required.'));
      return;
    }
    if (!response.ok) {
      showPageError(errorMessage(payload, 'Settings could not be loaded.'));
      showAuth('The settings API is unavailable.');
      return;
    }
    lastApplyFeedback = null;
    applyEnvelope(payload);
  }

  function renderConnectivity(payload, responseOk) {
    var source = payload.connectivity || payload.backend_connectivity || payload.backend || (payload.validation && payload.validation.connectivity) || (payload.infrastructure && payload.infrastructure.ollama) || {};
    var reachable = source.reachable === true || source.ok === true || source.status === 'healthy';
    var tested = source.tested !== false && Object.keys(asObject(source)).length > 0;
    var badge = byId('backend-connectivity');
    badge.className = 'status-pill';
    if (reachable) {
      badge.classList.add('status-good');
      badge.textContent = 'Reachable';
      setText('backend-connectivity-detail', source.message || 'The draft Ollama address responded successfully.');
      return true;
    } else if (tested || !responseOk) {
      badge.classList.add('status-error');
      badge.textContent = 'Unreachable';
      setText('backend-connectivity-detail', source.message || source.error || 'Ollama did not pass the connectivity check.');
      return false;
    } else {
      badge.classList.add('status-neutral');
      badge.textContent = 'Not tested';
      setText('backend-connectivity-detail', 'The server validated the draft without reporting a connectivity result.');
      return null;
    }
  }

  async function validateDraft() {
    if (busy || !loadedSettings) return false;
    setBusy(true, 'Validating draft…');
    clearErrors();
    showPageError('');
    var draftSignature = signature();
    try {
      var response = await fetch(VALIDATE_URL, { method: 'POST', headers: headers(true), body: JSON.stringify(requestPayload()) });
      var payload = await parseResponse(response);
      if (response.status === 401 || response.status === 403) { showAuth(errorMessage(payload, 'The admin token was rejected.')); return false; }
      renderDiagnostics(Object.assign({}, loadedEnvelope || {}, payload, {
        diagnostics: Array.isArray(payload.diagnostics) ? payload.diagnostics : []
      }));
      var errors = renderErrors(payload);
      if (!response.ok || payload.valid === false || errors.length) {
        showPageError(errorMessage(payload, 'The draft contains errors. No settings were changed.'));
        return false;
      }
      lastValidatedSignature = draftSignature;
      setText('action-title', 'Draft validated');
      setText('action-detail', 'No settings were saved. This draft is ready to apply.');
      return true;
    } catch (_) {
      showPageError('The validation request failed. No settings were changed.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function applyDraft() {
    if (busy || !dirty || !loadedSettings || (loadedEnvelope && loadedEnvelope.restart_pending) || lastValidatedSignature !== signature()) return;
    setBusy(true, 'Applying settings…');
    clearErrors();
    showPageError('');
    var payloadToSend = requestPayload();
    try {
      var response = await fetch(APPLY_URL, { method: 'POST', headers: headers(true), body: JSON.stringify(payloadToSend) });
      var payload = await parseResponse(response);
      if (response.status === 401 || response.status === 403) { showAuth(errorMessage(payload, 'The admin token was rejected.')); return; }
      var errors = renderErrors(payload);
      if (!response.ok || payload.valid === false || errors.length) {
        showPageError(errorMessage(payload, response.status === 409 ? 'The configuration changed elsewhere. Reload the current settings and try again.' : 'The draft was not applied.'));
        return;
      }
      var envelope = payload.settings ? payload : Object.assign({}, loadedEnvelope || {}, payload, {
        settings: collectSettings(),
        updated_at: payload.updated_at || new Date().toISOString()
      });
      applyEnvelope(envelope);
      showPageError('');
      lastApplyFeedback = {
        title: restartInfo(payload).required ? 'Settings saved · restart required' : 'Settings applied',
        detail: restartInfo(payload).required ? 'Review the restart notice above before expecting every value to be active.' : 'The intermediary accepted the new configuration.'
      };
    } catch (_) {
      showPageError('The apply request failed. The intermediary may not have changed anything; reload before trying again.');
    } finally {
      setBusy(false);
    }
  }

  function discardDraft() {
    if (!loadedSettings) return;
    touchedPaths.clear();
    populateForm(loadedSettings);
    clearErrors();
    showPageError('');
    lastApplyFeedback = null;
    lastValidatedSignature = '';
    updateDirtyState();
  }

  async function mutateSavedOverrides(action) {
    if (busy || dirty || !loadedEnvelope || loadedEnvelope.restart_pending) return;
    var rollback = action === 'rollback';
    var question = rollback
      ? 'Roll back to the preceding saved settings revision? The intermediary will restart.'
      : 'Remove every browser-saved override and return to config.yml values? The intermediary will restart.';
    if (!window.confirm(question)) return;
    setBusy(true, rollback ? 'Rolling back saved settings…' : 'Resetting saved overrides…');
    clearErrors();
    showPageError('');
    try {
      var response = await fetch(rollback ? ROLLBACK_URL : RESET_URL, {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({ revision: loadedRevision, settings: {} })
      });
      var payload = await parseResponse(response);
      if (response.status === 401 || response.status === 403) {
        setBusy(false);
        showAuth(errorMessage(payload, 'The admin token was rejected.'));
        return;
      }
      if (!response.ok) {
        renderErrors(payload);
        showPageError(errorMessage(payload, response.status === 409
          ? 'The saved settings changed elsewhere or require a host-side repair. Reload and try again.'
          : 'The saved overrides could not be changed.'));
        setBusy(false);
        return;
      }
      loadedRevision = payload.revision != null ? payload.revision : loadedRevision;
      renderRestart(payload);
      setText('configuration-revision', loadedRevision);
      setText('configuration-title', 'Saved settings updated');
      setText('configuration-detail', payload.message || 'The intermediary is restarting with the selected settings revision.');
      var state = byId('document-state');
      state.className = 'status-pill status-warning';
      state.textContent = 'Restarting';
      setText('action-title', rollback ? 'Rollback saved' : 'Overrides reset');
      setText('action-detail', payload.message || 'Wait for the intermediary to restart, then reload this page.');
      // Keep controls disabled while the process exits and its supervisor
      // restarts it. Reloading after restart obtains the authoritative state.
    } catch (_) {
      showPageError('The request was interrupted. Reload after the intermediary restarts to verify the saved state.');
      setBusy(false);
    }
  }

  function bindEvents() {
    byId('auth-form').addEventListener('submit', function (event) {
      event.preventDefault();
      setToken(byId('admin-token').value.trim());
      byId('admin-token').value = '';
      loadSettings();
    });
    byId('forget-token').addEventListener('click', function () {
      setToken('');
      loadedSettings = null;
      showAuth('The settings admin token was cleared from this browser tab.');
    });
    byId('settings-form').addEventListener('input', function (event) {
      var path = event.target.dataset.path || '';
      if (path) {
        touchedPaths.add(path);
        var wrap = event.target.closest('[data-field-wrap]');
        var output = all('[data-error-for]').find(function (element) { return element.dataset.errorFor === path; });
        if (wrap) wrap.classList.remove('has-error');
        if (output) output.textContent = '';
      }
      lastApplyFeedback = null;
      lastValidatedSignature = '';
      updateDirtyState();
    });
    byId('settings-form').addEventListener('change', function (event) {
      if (event.target.dataset.path) touchedPaths.add(event.target.dataset.path);
      lastValidatedSignature = '';
      updateDirtyState();
    });
    byId('settings-form').addEventListener('submit', function (event) { event.preventDefault(); applyDraft(); });
    byId('validate-button').addEventListener('click', function () { validateDraft(); });
    byId('test-backend').addEventListener('click', function () { validateDraft(); });
    byId('discard-button').addEventListener('click', discardDraft);
    byId('rollback-button').addEventListener('click', function () { mutateSavedOverrides('rollback'); });
    byId('reset-button').addEventListener('click', function () { mutateSavedOverrides('reset'); });
    byId('catchup-use-warm-model').addEventListener('click', useWarmModel);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stopCatchupRefresh();
      else { refreshCatchup(); startCatchupRefresh(); }
    });
    window.addEventListener('pagehide', stopCatchupRefresh);
    window.addEventListener('pageshow', function () { refreshCatchup(); startCatchupRefresh(); });
    window.addEventListener('beforeunload', function (event) {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  bindEvents();
  byId('add-source').addEventListener('click', function () { addPolicy('source'); });
  byId('add-schedule').addEventListener('click', function () { addPolicy('schedule'); });
  byId('add-backend').addEventListener('click', addBackend);
  if (getToken()) loadSettings();
  else showAuth('Enter your administrator password to view or change configuration.');
})();
