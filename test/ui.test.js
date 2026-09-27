import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { DASHBOARD_HTML, DASHBOARD_CSS, DASHBOARD_JS } from '../src/dashboard.js';
import { SETTINGS_DASHBOARD_HTML, SETTINGS_DASHBOARD_CSS, SETTINGS_DASHBOARD_JS } from '../src/settings-dashboard.js';
import { maskSettings } from '../src/settings.js';
import { testConfig } from './helpers.js';

// Lightweight DOM contract tests keep the normal suite dependency-free. Layout
// still needs a real browser; these exercise the shipped rendering functions.
class Element {
  constructor() {
    this.children = [];
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.type = 'text';
    this.className = '';
    this.validity = {};
    this.attributes = {};
    this.classList = {
      add: (...names) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(' ').filter((name) => !names.includes(name)).join(' '); },
    };
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map((child) => child.textContent).join(''); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.text = ''; this.children = children; }
  addEventListener() {}
  setAttribute(name, value) { this.attributes[name] = value; }
  focus() {}
  scrollIntoView() { this.scrolled = true; }
  remove() {}
  querySelectorAll() { return this.children; }
}

function harness(kind, storage = new Map()) {
  const html = kind === 'dashboard' ? DASHBOARD_HTML : SETTINGS_DASHBOARD_HTML;
  const source = kind === 'dashboard' ? DASHBOARD_JS : SETTINGS_DASHBOARD_JS;
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => [match[1], new Element()]));
  const fields = [...html.matchAll(/data-field-wrap="([^"]+)"/g)].map((match) => {
    const element = new Element(); element.dataset.fieldWrap = match[1]; return element;
  });
  const inputs = [...html.matchAll(/<(?:input|select)\b[^>]*data-path="([^"]+)"[^>]*>/g)].map((match) => {
    const element = new Element();
    element.dataset.path = match[1];
    element.type = match[0].match(/\btype="([^"]+)"/)?.[1] || 'text';
    element.dataset.nullable = /data-nullable="true"/.test(match[0]) ? 'true' : 'false';
    fields.find((field) => field.dataset.fieldWrap === match[1])?.appendChild(element);
    return element;
  });
  const intervals = new Map();
  const timeouts = new Map();
  let nextTimer = 1;
  const context = vm.createContext({
    document: {
      getElementById: (id) => nodes.get(id),
      createElement: () => new Element(),
      querySelectorAll: (selector) => selector === '[data-path]' ? inputs : selector === '[data-field-wrap]' ? fields : [],
    },
    window: {
      setInterval: (fn, milliseconds) => { const id = nextTimer++; intervals.set(id, { fn, milliseconds }); return id; },
      clearInterval: (id) => intervals.delete(id),
      setTimeout: (fn, milliseconds) => { const id = nextTimer++; timeouts.set(id, { fn, milliseconds }); return id; },
      clearTimeout: (id) => timeouts.delete(id),
      addEventListener() {},
    },
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    performance, AbortController,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  });
  const marker = kind === 'dashboard' ? "  byId('token-form').addEventListener" : '  bindEvents();';
  const names = kind === 'dashboard'
    ? 'eventSeverity, formatRelativeDate, renderCatchup, healthState, refreshSnapshot, startPolling, changeCatchupPage, changeCatchupView, refreshCatchupPage, unlockCatchup, performCatchupAction, render, renderHostGpu, setMaintenanceToken, syncRecoveryControls, performRecoveryAction, performMaintenanceAction, renderAIBackends, renderMedia, syncMediaRecoveryControls, performMediaRecoveryAction, getToken, setToken, getMaintenanceToken, syncCatchupControls'
    : 'restartInfo, applyEnvelope, updateDirtyState, useWarmModel, collectPatch, refreshCatchup, showAuth, startCatchupRefresh, stopCatchupRefresh, getToken, setToken';
  const boundary = source.indexOf(marker);
  assert.ok(boundary > 0, 'UI bootstrap marker must remain identifiable');
  vm.runInContext(`${source.slice(0, boundary)}\n globalThis.ui = { ${names} };\n})();`, context);
  return { context, ui: context.ui, nodes, fields, inputs, intervals, timeouts };
}

test('UI wrappers load their independent assets and all literal element references exist', () => {
  for (const [kind, html, css, js] of [['dashboard', DASHBOARD_HTML, DASHBOARD_CSS, DASHBOARD_JS], ['settings', SETTINGS_DASHBOARD_HTML, SETTINGS_DASHBOARD_CSS, SETTINGS_DASHBOARD_JS]]) {
    assert.equal(js, fs.readFileSync(new URL(`../src/ui/${kind}.js`, import.meta.url), 'utf8'));
    assert.ok(css.includes('@media'));
    assert.doesNotThrow(() => new vm.Script(js));
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(new Set(ids).size, ids.length, `${kind}: duplicate element IDs`);
    for (const match of js.matchAll(/(?:byId|setText|setHidden)\('([^']+)'\s*[,)]/g)) assert.ok(ids.includes(match[1]), `${kind}: missing ${match[1]}`);
    if (kind === 'dashboard') for (const view of ['waiting', 'awaiting', 'retrying', 'attention', 'completed', 'skipped']) {
      assert.ok(ids.includes('catchup-view-' + view));
      assert.ok(ids.includes('catchup-count-' + view));
    }
  }
});

test('single admin login is shared across dashboard, settings and maintenance without extra credential forms', () => {
  const storage = new Map();
  const dashboard = harness('dashboard', storage);
  dashboard.ui.setToken('single-secret');
  dashboard.ui.render({ authentication: { mode: 'single_admin' }, maintenance: { state: 'running', control_available: true } });
  assert.equal(storage.get('ai-intermediary-admin-token'), 'single-secret');
  assert.equal(dashboard.ui.getMaintenanceToken(), 'single-secret');
  assert.equal(dashboard.nodes.has('maintenance-token-form'), false);
  assert.equal(dashboard.nodes.has('catchup-token-form'), false);
  assert.equal(dashboard.nodes.get('pause-button').disabled, false);
  assert.equal(dashboard.nodes.get('catchup-refresh').disabled, false);
  assert.match(DASHBOARD_HTML, /same admin credential/);
  const settings = harness('settings', storage);
  assert.equal(settings.ui.getToken(), 'single-secret');
  settings.ui.applyEnvelope({ settings: maskSettings(testConfig()), valid: true, authentication: { mode: 'single_admin' }, infrastructure: { ui_can_apply: true } });
  assert.equal(settings.nodes.has('legacy-maintenance-secret'), false);
  assert.equal(settings.nodes.has('legacy-observability-secret'), false);
  assert.match(SETTINGS_DASHBOARD_HTML, /id="admin-secret-variable">ADMIN_TOKEN/);
  settings.ui.setToken('');
  assert.equal(harness('dashboard', storage).ui.getToken(), '', 'sign-out leaves no persistent fallback credentials');
  assert.equal(storage.has('ai-intermediary-admin-token'), false);
});

test('settings-first admin login unlocks dashboard and stale role credentials are never reused', () => {
  const storage = new Map();
  const settings = harness('settings', storage);
  settings.ui.setToken('single-secret');
  settings.ui.applyEnvelope({ settings: maskSettings(testConfig()), valid: true, authentication: { mode: 'single_admin' }, infrastructure: { ui_can_apply: true } });
  assert.equal(harness('dashboard', storage).ui.getMaintenanceToken(), 'single-secret');
  const stale = new Map([
    ['ollama-intermediary-observability-token', 'old-read'],
    ['ollama-intermediary-settings-admin-token', 'old-settings'],
    ['ollama-intermediary-maintenance-token', 'old-maintenance'],
  ]);
  const dashboard = harness('dashboard', stale);
  dashboard.ui.render({ maintenance: { state: 'running', control_available: true } });
  assert.equal(dashboard.ui.getToken(), '');
  assert.equal(dashboard.ui.getMaintenanceToken(), '');
  assert.equal(harness('settings', stale).ui.getToken(), '');
  assert.equal(dashboard.nodes.get('pause-button').disabled, true);
});

test('failed request outcomes never render as successful activity', () => {
  const { ui } = harness('dashboard');
  assert.equal(ui.eventSeverity({ type: 'request_failed', status: 502 }), 'event-danger');
  assert.equal(ui.eventSeverity({ type: 'request_completed', status: 500 }), 'event-danger');
  assert.equal(ui.eventSeverity({ type: 'request_completed', status: 200, outcome: 'failed' }), 'event-danger');
  assert.equal(ui.eventSeverity({ type: 'request_completed', status: 200 }), 'event-good');
});

test('AI dashboard distinguishes source/backend ownership and durable media states without guessing gateway links', () => {
  const { ui, nodes } = harness('dashboard');
  ui.render({ backend: { reachable: true, state: 'healthy' }, service: { ready: true },
    backends: [{ id: 'ollama', type: 'ollama', enabled: true, resource_group: 'gpu0' }, { id: 'comfy', type: 'comfyui', enabled: true, resource_group: 'gpu0' }],
    media: { enabled: true, blocked: false, jobs: [
      { id: 'queued-id', source: 'media', backend: 'comfy', state: 'queued', artifacts: [] },
      { id: 'running-id', source: 'artist', backend: 'comfy', state: 'running', artifacts: [] },
      { id: 'done-id', source: 'media', backend: 'comfy', state: 'completed', artifacts: [{ status: 'available', filename: '<img src=evil>' }] },
    ] }, scheduler: { state: 'busy' } });
  assert.equal(nodes.get('media-queued').textContent, '1');
  assert.equal(nodes.get('media-running').textContent, '1');
  assert.equal(nodes.get('media-uncertain').textContent, '0');
  assert.match(nodes.get('gpu-owner-detail').textContent, /artist → comfy/);
  assert.match(nodes.get('gpu-owner-state').textContent, /Media owns GPU/);
  assert.match(nodes.get('active-empty-title').textContent, /Media work holds/);
  assert.match(nodes.get('backend-registry-list').textContent, /Enabled in configuration.*Shared resource: gpu0/);
  assert.doesNotMatch(nodes.get('backend-registry-list').textContent, /Healthy/);
  assert.match(nodes.get('media-jobs').textContent, /admin login/);
  assert.doesNotMatch(nodes.get('media-jobs').textContent, /<img|http:/);
  assert.equal(nodes.get('media-recovery-panel').hidden, true);
  assert.match(DASHBOARD_HTML, /<h1>AI Intermediary<\/h1>/);
});

test('media uncertainty overrides idle Ollama, blocks resume and cannot invoke Ollama recovery', async () => {
  const { ui, nodes, context } = harness('dashboard');
  const calls = [];
  context.fetch = async (url) => { calls.push(url); return { ok: true, json: async () => ({}) }; };
  const data = { backend: { reachable: true, state: 'healthy', recovery_required: false }, recovery: { enabled: true, state: 'idle' },
    maintenance: { state: 'paused', paused: true, control_available: true }, scheduler: { state: 'idle' },
    media: { enabled: true, blocked: true, unresolved: ['job'], jobs: [{ id: 'job', source: 'media', backend: 'comfy', state: 'uncertain' }] } };
  ui.render(data); ui.setMaintenanceToken('control');
  nodes.get('recovery-confirm').checked = true;
  assert.match(nodes.get('overall-state').textContent, /Shared GPU blocked/);
  assert.equal(nodes.get('media-uncertain').textContent, '1');
  assert.equal(nodes.get('media-running').textContent, '0');
  assert.equal(nodes.get('media-recovery-panel').hidden, false);
  assert.equal(nodes.get('resume-button').disabled, true);
  assert.equal(nodes.get('recovery-check').disabled, true);
  await ui.performMaintenanceAction('resume');
  await ui.performRecoveryAction('acknowledge');
  assert.equal(calls.length, 0);
  data.media.enabled = false; ui.render(data);
  assert.match(nodes.get('overall-state').textContent, /Shared GPU blocked/);
  assert.equal(nodes.get('media-recovery-acknowledge').disabled, true, 'turning media off cannot clear an existing lock');
});

test('completed media awaiting release shows saved results, latest cleanup failure and bounded retry state', () => {
  const { ui, nodes } = harness('dashboard');
  const data = { backend: { reachable: true, state: 'healthy' }, scheduler: { state: 'idle' },
    maintenance: { state: 'paused', paused: true, control_available: true },
    media: { enabled: true, blocked: true, unresolved: ['job'], jobs: [{ id: 'job', source: 'media', backend: 'comfy',
      state: 'uncertain', reason: 'backend_transport_error', execution_state: 'completed', outputsImported: true,
      artifacts: [{ status: 'available', filename: 'saved.mp4' }] }],
    release: { phase: 'comfy', backend: 'comfy', reason: 'comfy_torch_residual_exceeded',
      reserved_bytes: 76 * 1024 ** 2, active_bytes: 0, max_reserved_bytes: 128 * 1024 ** 2,
      sampled_at: new Date().toISOString(), attempts: 2, automatic_retry_exhausted: false,
      next_retry_at: new Date(Date.now() + 60_000).toISOString(), token: 'must-not-render' } } };
  ui.render(data); ui.setMaintenanceToken('private-admin');
  assert.equal(nodes.get('overall-state').textContent, 'Media completed; GPU release pending');
  assert.match(nodes.get('overall-detail').textContent, /output import succeeded/);
  assert.equal(nodes.get('media-state').textContent, 'GPU release pending');
  assert.equal(nodes.get('media-uncertain').textContent, '1', 'the durable lock is not presented as settled');
  assert.equal(nodes.get('media-running').textContent, '0');
  assert.match(nodes.get('media-jobs').textContent, /Media completed; GPU release pending/);
  assert.match(nodes.get('media-jobs').textContent, /1 retained output/);
  assert.match(nodes.get('media-jobs').textContent, /Latest release check: Comfy Torch Residual Exceeded/);
  assert.match(nodes.get('media-jobs').textContent, /Original incident: Backend Transport Error/);
  assert.match(nodes.get('media-error').textContent, /PyTorch reserved: 76 MiB \/ 128 MiB ceiling/);
  assert.match(nodes.get('media-error').textContent, /PyTorch active: 0 MiB/);
  assert.match(nodes.get('media-error').textContent, /Cleanup attempts: 2/);
  assert.match(nodes.get('media-error').textContent, /Automatic cleanup recheck in/);
  assert.match(nodes.get('media-error').textContent, /Generation is not resubmitted/);
  assert.doesNotMatch(nodes.get('media-error').textContent, /must-not-render|private-admin/);
  assert.match(nodes.get('media-recovery-detail').textContent, /Do not restart ComfyUI just because/);
  assert.doesNotMatch(nodes.get('media-recovery-detail').textContent, /^Pause inference, stop/);
  assert.equal(nodes.get('resume-button').disabled, true);
  assert.equal(nodes.get('recovery-check').disabled, true);
  assert.match(nodes.get('media-recovery-control-state').textContent, /Bounded automatic cleanup/);

  data.media.release = { phase: 'physical', backend: 'comfy', reason: 'media_gpu_busy',
    physical_vram_bytes: 676 * 1024 ** 2, max_physical_vram_bytes: 512 * 1024 ** 2,
    attempts: 4, automatic_retry_exhausted: true, next_retry_at: null };
  ui.render(data);
  assert.match(nodes.get('media-error').textContent, /Latest release check: Media Gpu Busy/);
  assert.match(nodes.get('media-error').textContent, /Physical VRAM: 676 MiB \/ 512 MiB ceiling/);
  assert.doesNotMatch(nodes.get('media-error').textContent, /Torch Residual|Automatic cleanup recheck/);
  assert.match(nodes.get('media-error').textContent, /retries exhausted.*Manual verification required/);
  assert.match(nodes.get('media-recovery-detail').textContent, /automatic cleanup retries are exhausted/);
  assert.match(nodes.get('media-recovery-detail').textContent, /For manual acknowledgment, pause inference/);
  assert.equal(nodes.get('resume-button').disabled, true);
});

test('unknown execution, missing imports or unresolved IDs never inherit another job completion', () => {
  const { ui, nodes } = harness('dashboard');
  const complete = { id: 'complete', state: 'uncertain', execution_state: 'completed', outputsImported: true, artifacts: [] };
  for (const jobs of [
    [{ ...complete, execution_state: null }],
    [{ ...complete, outputsImported: false }],
    [{ ...complete, outputsImported: undefined }],
    [{ ...complete, execution_state: 'failed' }],
    [complete, { id: 'unknown', state: 'uncertain', reason: 'backend_transport_error', execution_state: null }],
  ]) {
    const data = { media: { enabled: true, blocked: true, unresolved: jobs.map((job) => job.id), jobs } };
    ui.render(data);
    assert.match(nodes.get('overall-state').textContent, /Shared GPU blocked/);
    assert.equal(nodes.get('media-state').textContent, 'Recovery required');
    assert.match(nodes.get('media-jobs').textContent, /Uncertain · recovery required/);
    assert.match(nodes.get('media-recovery-detail').textContent, /^Pause inference, stop the old/);
  }
  ui.render({ media: { enabled: true, blocked: true, unresolved: ['complete', 'missing'], jobs: [complete] } });
  assert.match(nodes.get('overall-state').textContent, /Shared GPU blocked/);
  assert.equal(nodes.get('media-uncertain').textContent, '2');
  ui.render({ media: { enabled: true, blocked: true, unresolved: [], jobs: [] } });
  assert.match(nodes.get('overall-state').textContent, /Shared GPU blocked/, 'no evidence is not completed work');
});

test('media release diagnostics render bounded known fields as text and never coerce unknown memory to zero', () => {
  const { ui, nodes } = harness('dashboard');
  ui.render({ media: { enabled: true, blocked: true, jobs: [], release: {
    phase: 'comfy', reason: '<img src=invalid>', reserved_bytes: null, active_bytes: '0', max_reserved_bytes: 128 * 1024 ** 2,
    physical_vram_bytes: -1, attempts: null, automatic_retry_exhausted: false, next_retry_at: 'invalid',
    token: 'hidden-token', request: { authorization: 'hidden-auth' },
  } } });
  assert.match(nodes.get('media-error').textContent, /Latest release check:/);
  assert.equal(nodes.get('media-error').children.length, 0, 'untrusted diagnostic strings are never parsed as HTML');
  assert.doesNotMatch(nodes.get('media-error').textContent, /0 MiB|Physical VRAM|Cleanup attempts|Automatic cleanup recheck|hidden-token|hidden-auth/);
});

test('settings exposes separate residual and physical memory limits and preserves explicit strict zero in the form', () => {
  const { ui, inputs } = harness('settings');
  ui.applyEnvelope({ settings: maskSettings(testConfig({ media: { max_idle_torch_vram_mb: 0, max_idle_vram_mb: 512 } })),
    valid: true, revision: 'media-settings', infrastructure: { ui_can_apply: true } });
  assert.equal(inputs.find((input) => input.dataset.path === 'media.max_idle_torch_vram_mb').value, '0');
  assert.equal(inputs.find((input) => input.dataset.path === 'media.max_idle_vram_mb').value, '512');
  assert.match(SETTINGS_DASHBOARD_HTML, /data-path="media\.max_idle_torch_vram_mb" type="number" min="0" max="256"/);
  assert.match(SETTINGS_DASHBOARD_HTML, /Older bridges without that proof still require zero/);
});

test('media acknowledgment needs a maintenance token, pause and explicit stopped-service confirmation', async () => {
  const { ui, nodes, context } = harness('dashboard');
  const data = { media: { enabled: true, blocked: true, unresolved: ['job'], jobs: [] },
    maintenance: { state: 'running', control_available: true } };
  const calls = [];
  context.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, json: async () => options.method === 'GET' ? data : { acknowledged: true } }; };
  ui.render(data);
  nodes.get('media-recovery-confirm').checked = true;
  await ui.performMediaRecoveryAction(); assert.equal(calls.length, 0);
  ui.setMaintenanceToken('maintenance-only');
  await ui.performMediaRecoveryAction(); assert.equal(calls.length, 0, 'must be paused');
  data.maintenance = { ...data.maintenance, state: 'paused', paused: true }; ui.render(data);
  nodes.get('media-recovery-confirm').checked = false;
  await ui.performMediaRecoveryAction(); assert.equal(calls.length, 0, 'requires explicit host verification');
  nodes.get('media-recovery-confirm').checked = true;
  await ui.performMediaRecoveryAction();
  const posts = calls.filter((call) => call.options.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/_intermediary/v1/media/acknowledge');
  assert.equal(posts[0].options.headers.authorization, 'Bearer maintenance-only');
  assert.deepEqual(JSON.parse(posts[0].options.body), { confirm_service_stopped: true });
  assert.equal(nodes.get('media-recovery-confirm').checked, false);
  assert.match(nodes.get('media-recovery-action-status').textContent, /remains paused/);
  assert.equal(calls.some((call) => call.url.includes('/resume')), false);
});

test('future model expiration is displayed in the future rather than just now', () => {
  const { ui } = harness('dashboard');
  assert.match(ui.formatRelativeDate(new Date(Date.now() + 60_000).toISOString()), /^in /);
  assert.match(ui.formatRelativeDate(new Date(Date.now() - 60_000).toISOString()), /ago$/);
});

test('metadata health is not mistaken for successful model inference', () => {
  const { ui } = harness('dashboard');
  const status = ui.healthState({ backend: { reachable: true, state: 'healthy', last_inference_error: 'Model runner failed' }, service: { ready: true } });
  assert.equal(status.css, 'health-warning');
  assert.match(status.title, /inference request failed/);
});

test('recovery overrides optimistic scheduler and maintenance messages without resuming a manual pause', () => {
  const { ui, nodes } = harness('dashboard');
  for (const state of ['waiting', 'restarting', 'verifying', 'cooldown', 'needs_attention']) {
    ui.render({ backend: { reachable: true, recovery_required: true, recovery_code: 'upstream_completion_unknown', recovery_reason: 'Connection ended before completion was verified.' },
      recovery: { enabled: true, state, host_available: true, attempts_in_window: 1, max_restarts: 2, cooldown_remaining_seconds: 90 },
      maintenance: { state: 'running', control_available: true, gpu_released: true }, scheduler: { state: 'idle' } });
    assert.match(nodes.get('overall-state').textContent, /recovery/i);
    assert.match(nodes.get('maintenance-title').textContent, /blocked for recovery/);
    assert.equal(nodes.get('maintenance-gpu-released').textContent, 'Not verified');
    assert.match(nodes.get('active-empty-detail').textContent, /Recovery must finish/);
    assert.doesNotMatch(nodes.get('active-empty-detail').textContent, /ready for the next/);
    assert.equal(nodes.get('resume-button').disabled, true);
    assert.match(nodes.get('recovery-code').textContent, /Upstream Completion Unknown/);
  }
  ui.render({ backend: { reachable: true, state: 'healthy' }, recovery: { enabled: true, state: 'recovered' }, maintenance: { state: 'paused', paused: true }, scheduler: { state: 'paused' } });
  assert.match(nodes.get('recovery-detail').textContent, /manual pause remains/);
  assert.match(nodes.get('active-empty-detail').textContent, /remains paused/);
});

test('physical VRAM is distinct from model allocation and null or stale hardware data is unknown', () => {
  const { ui, nodes } = harness('dashboard');
  const host = { enabled: true, available: true, stale: false, sampled_at: new Date().toISOString(), gpus: [{ id: 0, name: 'AMD test GPU',
    vram_total_bytes: 32 * 1024 ** 3, vram_used_bytes: 57 * 1024 ** 2, vram_free_bytes: null, utilization_percent: 0, temperature_c: 29,
    power_w: null, processes_known: true, processes: [] }] };
  ui.render({ backend: { loaded_models: [{ name: 'model', size_vram: 16 * 1024 ** 3 }] }, host_gpu: host });
  assert.equal(nodes.get('backend-vram').textContent, '16 GB');
  assert.match(nodes.get('host-gpu-list').textContent, /32 GB/);
  assert.match(nodes.get('host-gpu-list').textContent, /57 MB/);
  assert.match(nodes.get('host-gpu-list').textContent, /Free VRAMUnknown/);
  assert.match(nodes.get('host-gpu-list').textContent, /GPU utilization0%/);
  assert.match(nodes.get('host-gpu-list').textContent, /PowerUnknown/);
  ui.renderHostGpu({ host_gpu: { ...host, stale: true } });
  assert.match(nodes.get('host-gpu-state').textContent, /Stale/);
  assert.doesNotMatch(nodes.get('host-gpu-list').textContent, /32 GB|57 MB|utilization0%/);
  assert.match(nodes.get('host-gpu-list').textContent, /GPU processes: unknown/);
  ui.renderHostGpu({ host_gpu: { ...host, available: false } });
  assert.equal(nodes.get('host-gpu-state').textContent, 'Unavailable');
  assert.doesNotMatch(nodes.get('host-gpu-list').textContent, /No GPU processes reported/);
});

test('host RAM is separate from VRAM and becomes unknown when telemetry is stale', () => {
  const { ui, nodes } = harness('dashboard');
  const host = { enabled: true, available: true, stale: false, gpus: [],
    memory: { available: true, total_bytes: 30 * 1024 ** 3, available_bytes: 1024 ** 3,
      swap_total_bytes: 4 * 1024 ** 3, swap_used_bytes: 2 * 1024 ** 3, pressure_full_avg10: null, oom_kill_count: 1 } };
  ui.renderHostGpu({ host_gpu: host, scheduler: { background: { reason: 'host_memory_low' } } });
  assert.match(nodes.get('host-memory-stats').textContent, /Total RAM30 GB.*Available RAM1 GB.*Swap used2 GB/);
  assert.match(nodes.get('host-memory-stats').textContent, /Memory stall \(10s\)Unknown/);
  assert.match(nodes.get('host-memory-state').textContent, /Jobs are retained/);
  ui.renderHostGpu({ host_gpu: { ...host, stale: true } });
  assert.doesNotMatch(nodes.get('host-memory-stats').textContent, /30 GB|1 GB|2 GB/);
  assert.match(nodes.get('host-memory-state').textContent, /unknown or stale/);
  const settings = harness('settings');
  for (const key of ['enabled', 'min_available_mb', 'rescue_min_available_mb', 'max_pressure_full_percent']) {
    assert.ok(settings.inputs.some(input => input.dataset.path === 'host_helper.memory_guard.' + key));
  }
});

test('automatic recovery storage unavailability does not invent an inference lock', () => {
  const { ui, nodes } = harness('dashboard');
  const data = { backend: { reachable: true, state: 'healthy', recovery_required: false }, service: { ready: true }, scheduler: { state: 'idle' },
    maintenance: { state: 'running', paused: false, control_available: true }, recovery: { enabled: true, state: 'needs_attention',
      requires_attention: true, reason: 'automatic_recovery_state_unreadable', attempts_in_window: 2, episode_attempts: 1, max_restarts: 2, window_seconds: 3600 } };
  ui.render(data);
  assert.equal(nodes.get('overall-state').textContent, 'Automatic recovery needs attention');
  assert.match(nodes.get('overall-detail').textContent, /Normal scheduling can continue/);
  assert.equal(nodes.get('maintenance-title').textContent, 'Inference is running normally');
  assert.doesNotMatch(nodes.get('active-empty-detail').textContent, /Recovery must finish/);
  assert.match(nodes.get('recovery-detail').textContent, /No inference recovery lock/);
  assert.equal(nodes.get('recovery-attempts').textContent, '2 / 2');
  assert.equal(nodes.get('recovery-episode-attempts').textContent, '1 / 2');
  assert.equal(nodes.get('recovery-window-label').textContent, 'Restarts in rolling 1h 0m window');
  data.maintenance = { ...data.maintenance, state: 'paused', paused: true };
  ui.render(data);
  ui.setMaintenanceToken('maintenance-only');
  assert.equal(nodes.get('resume-button').disabled, false, 'unavailable auto-recovery alone does not disable manual resume');
  assert.equal(nodes.get('recovery-check').disabled, true, 'there is no incident to recover');
});

test('GPU processes are rendered as bounded text rather than HTML', () => {
  const { ui, nodes } = harness('dashboard');
  ui.renderHostGpu({ host_gpu: { enabled: true, available: true, stale: false, gpus: [{ id: 0, name: '<img src=x onerror=alert(1)>', processes_known: true,
    processes: Array.from({ length: 20 }, (_, pid) => ({ pid, name: '<script>unsafe</script>' + 'x'.repeat(1000), vram_bytes: null })) }] } });
  const card = nodes.get('host-gpu-list').children[0];
  const processes = card.children.find((element) => element.className === 'gpu-process-list');
  assert.equal(processes.children.length, 12);
  assert.ok(processes.children.every((item) => item.textContent.length < 180));
  assert.match(card.textContent, /8 additional processes/);
  assert.doesNotMatch(DASHBOARD_JS, /innerHTML/);
});

test('a disconnected dashboard does not keep presenting cached hardware readings as available', async () => {
  const { ui, nodes, context } = harness('dashboard');
  ui.render({ host_gpu: { enabled: true, available: true, stale: false, gpus: [{ id: 0, vram_used_bytes: 1024, utilization_percent: 0 }] } });
  assert.equal(nodes.get('host-gpu-state').textContent, 'Available');
  context.fetch = async () => { throw new Error('connection lost'); };
  await ui.refreshSnapshot();
  assert.match(nodes.get('host-gpu-state').textContent, /Stale/);
  assert.match(nodes.get('host-gpu-error').textContent, /until reconnection/);
  assert.doesNotMatch(nodes.get('host-gpu-list').textContent, /1 KB|utilization0%/);
});

test('helper setup diagnosis does not confuse disabled monitoring or missing mounts with proven host absence', () => {
  const { ui, nodes } = harness('dashboard');
  ui.render({ host_gpu: { enabled: false } });
  assert.equal(nodes.get('host-gpu-state').textContent, 'Disabled · not checked');
  assert.match(nodes.get('host-gpu-detail').textContent, /availability is not being checked/);
  ui.render({ host_gpu: { enabled: true, available: false, stale: true, error: 'host_helper_socket_missing' } });
  assert.equal(nodes.get('host-gpu-state').textContent, 'Setup required');
  assert.match(nodes.get('host-gpu-detail').textContent, /may not be installed.*not mounted/);
  ui.render({ host_gpu: { enabled: true, error: 'host_helper_permission_denied' } });
  assert.match(nodes.get('host-gpu-detail').textContent, /access is denied/);
  ui.render({ host_gpu: { enabled: true, error: 'host_backend_mismatch' } });
  assert.match(nodes.get('host-gpu-detail').textContent, /different Ollama origin/);
});

test('recovery actions require maintenance authorization and explicit paused host acknowledgment', async () => {
  const { ui, context, nodes } = harness('dashboard');
  const data = { backend: { recovery_required: true }, recovery: { enabled: true, state: 'needs_attention' }, maintenance: { state: 'running', control_available: true } };
  ui.render(data);
  const calls = [];
  context.window.confirm = () => true;
  context.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, json: async () => options.method === 'GET' ? data : { acknowledged: true } }; };
  await ui.performRecoveryAction('check');
  assert.equal(calls.length, 0);
  ui.setMaintenanceToken('maintenance-only');
  nodes.get('recovery-confirm').checked = true;
  await ui.performRecoveryAction('acknowledge');
  assert.equal(calls.length, 0, 'running maintenance cannot be acknowledged');
  data.maintenance = { ...data.maintenance, state: 'paused', paused: true };
  ui.render(data);
  nodes.get('recovery-confirm').checked = false;
  await ui.performRecoveryAction('acknowledge');
  assert.equal(calls.length, 0, 'explicit confirmation is required');
  nodes.get('recovery-confirm').checked = true;
  await ui.performRecoveryAction('acknowledge');
  let posts = calls.filter((call) => call.options.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].options.headers.authorization, 'Bearer maintenance-only');
  assert.match(posts[0].url, /recovery\/acknowledge$/);
  assert.deepEqual(JSON.parse(posts[0].options.body), { confirm_gpu_recovered: true });
  assert.match(nodes.get('recovery-action-status').textContent, /manual pause remains/);
  await ui.performRecoveryAction('check');
  posts = calls.filter((call) => call.options.method === 'POST');
  assert.equal(posts.length, 2);
  assert.match(posts[1].url, /recovery\/check$/);
  assert.deepEqual(JSON.parse(posts[1].options.body), { confirm: true });
  assert.ok(calls.every((call) => !call.url.includes('/resume')));
  assert.equal(nodes.get('recovery-confirm').checked, false);
});

test('recovery checks respect disabled automation and rejected administrator passwords', async () => {
  const { ui, context, nodes } = harness('dashboard');
  const data = { backend: { recovery_required: true }, recovery: { enabled: false, state: 'disabled' }, maintenance: { state: 'paused', paused: true, control_available: true } };
  ui.render(data);
  ui.setMaintenanceToken('wrong-maintenance');
  const calls = [];
  context.window.confirm = () => true;
  context.fetch = async (url, options) => { calls.push({ url, options }); return { ok: false, status: 401, json: async () => ({}) }; };
  await ui.performRecoveryAction('check');
  await ui.performMaintenanceAction('resume');
  assert.equal(calls.length, 0);
  data.recovery.enabled = true;
  ui.render(data);
  await ui.performRecoveryAction('check');
  assert.equal(calls.length, 1);
  assert.match(nodes.get('recovery-action-status').textContent, /administrator password was rejected/);
  assert.equal(nodes.get('recovery-check').disabled, true);
  await ui.performRecoveryAction('check');
  assert.equal(calls.length, 1);
});

test('Frigate connection refresh uses the admin login without scheduling job mutations', async () => {
  const { ui, context, nodes } = harness('dashboard');
  ui.setMaintenanceToken('maintenance-is-not-settings');
  ui.unlockCatchup('');
  const calls = [];
  context.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, json: async () => ({}) }; };
  await ui.performCatchupAction('refresh');
  assert.equal(calls.length, 0);
  assert.equal(nodes.get('catchup-refresh').disabled, true);
  ui.unlockCatchup('settings-only');
  await ui.performCatchupAction('refresh');
  const posts = calls.filter((call) => call.options.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/_intermediary/v1/frigate/refresh');
  assert.equal(posts[0].options.headers.authorization, 'Bearer settings-only');
  assert.deepEqual(JSON.parse(posts[0].options.body), { confirm: true });
  assert.match(nodes.get('catchup-action-status').textContent, /without retrying jobs/);
});

test('catch-up rendering separates lifetime totals from stored view counts', async () => {
  const { ui, nodes, context } = harness('dashboard');
  ui.renderCatchup({ enabled: true, state: 'running', counts: { pending: 2, waiting_live: 3, retrying: 1 }, totals: { completed: 47 }, views: { waiting: 5, retrying: 1, attention: 1, completed: 10, skipped: 4 }, history_limit: 1000, scan: { blocked_reason: 'capacity_reached' }, capabilities: { object: true, review: true } });
  assert.equal(nodes.get('catchup-pending').textContent, '5');
  assert.equal(nodes.get('catchup-completed').textContent, '47');
  assert.equal(nodes.get('catchup-count-completed').textContent, '10');
  assert.equal(nodes.get('catchup-count-attention').textContent, '1');
  assert.match(nodes.get('catchup-history-limit').textContent, /1,000/);
  assert.match(nodes.get('catchup-detail').textContent, /Capacity Reached/);
  context.fetch = async () => ({ ok: true, json: async () => ({ offset: 0, total: 1, items: [{ kind: 'review', id: 'review-1', camera: 'Driveway', state: 'pending', event_time: 1_789_000_000 }] }) });
  await ui.refreshCatchupPage();
  assert.match(nodes.get('catchup-pending-jobs').textContent, /Recorded/);
  assert.equal(nodes.get('catchup-pending-empty').hidden, true);
  context.fetch = async () => ({ ok: true, json: async () => ({ offset: 0, total: 1, items: [{ kind: 'object', id: 'object-2', camera: 'Driveway', state: 'skipped', reason: 'media_expired' }] }) });
  await ui.changeCatchupView('skipped');
  assert.match(nodes.get('catchup-pending-jobs').textContent, /Media Expired/);
  assert.match(nodes.get('catchup-pending-jobs').textContent, /Recheck availability/);
});

test('context rescue UI shows opt-in status, blocked reason and one-shot outcome without promising a saved description', async () => {
  const { context, ui, nodes } = harness('dashboard');
  ui.renderCatchup({});
  assert.match(nodes.get('catchup-context-rescue').textContent, /disabled/);
  ui.renderCatchup({ context_rescue: { enabled: true, model: 'f-model', max_context: 24576 } });
  assert.match(nodes.get('catchup-context-rescue').textContent, /24,576.*Waiting for the Frigate bridge/);
  const row = { kind: 'review', id: 'review-1', state: 'retrying', context_rescue: {
    reason: 'rescue_above_cap', prompt_tokens: 14407, reported_context: 8192, attempted: false,
  } };
  context.fetch = async () => ({ ok: true, json: async () => ({ offset: 0, total: 1, items: [row] }) });
  await ui.refreshCatchupPage();
  assert.match(nodes.get('catchup-pending-jobs').textContent, /exceeds the tested cap.*14,407.*8,192.*0 \/ 1/);
  Object.assign(row.context_rescue, { reason: 'rescue_request_succeeded', attempted: true, target_context: 20480 });
  await ui.refreshCatchupPage();
  assert.match(nodes.get('catchup-pending-jobs').textContent, /Frigate still determines the saved result.*20,480.*1 \/ 1/);
  const settings = harness('settings');
  for (const field of ['enabled', 'model', 'max_context', 'output_reserve', 'safety_margin']) {
    assert.ok(settings.inputs.some((input) => input.dataset.path === 'frigate.context_rescue.' + field));
  }
});

test('backlog UI shows 30 jobs and pages through the remaining saved jobs', async () => {
  const { context, ui, nodes } = harness('dashboard');
  const rows = Array.from({ length: 65 }, (_, i) => ({ id: `event-${i}`, kind: 'object', camera: 'Yard', state: 'pending' }));
  ui.renderCatchup({ enabled: true, total_queued: 65, counts: { pending: 65 }, pending_jobs: rows.slice(0, 30) });
  const requests = [];
  context.fetch = async (url) => {
    requests.push(url);
    const offset = Number(new URL(url, 'http://example.test').searchParams.get('offset'));
    return { ok: true, json: async () => ({ offset, limit: 30, total: 65, items: rows.slice(offset, offset + 30) }) };
  };
  await ui.refreshCatchupPage();
  assert.equal(nodes.get('catchup-pending-jobs').children.length, 30);
  assert.equal(nodes.get('catchup-page-status').textContent, 'Showing 1–30 of 65 saved jobs in this view');
  await ui.changeCatchupPage(1);
  assert.equal(nodes.get('catchup-page-status').textContent, 'Showing 31–60 of 65 saved jobs in this view');
  await ui.changeCatchupPage(1);
  assert.equal(nodes.get('catchup-pending-jobs').children.length, 5);
  assert.equal(nodes.get('catchup-next').disabled, true);
  await ui.changeCatchupPage(-1);
  assert.equal(nodes.get('catchup-page-status').textContent, 'Showing 31–60 of 65 saved jobs in this view');
  assert.ok(requests.every((url) => url.includes('limit=30') && url.includes('view=waiting')));
});

test('views fetch their whole filtered dataset and preserve scroll during refresh', async () => {
  const { context, ui, nodes } = harness('dashboard');
  const requests = [];
  context.fetch = async (url) => {
    requests.push(url);
    const query = new URL(url, 'http://example.test').searchParams;
    const offset = Number(query.get('offset'));
    return { ok: true, json: async () => ({ offset, total: 1000, items: Array.from({ length: 30 }, (_, i) => ({ kind: 'object', id: `history-${offset + i}`, state: query.get('view') })) }) };
  };
  await ui.changeCatchupView('completed');
  await ui.changeCatchupPage(1);
  nodes.get('catchup-pending-jobs').scrollTop = 123;
  const originalRow = nodes.get('catchup-pending-jobs').children[0];
  await ui.refreshCatchupPage();
  assert.equal(nodes.get('catchup-pending-jobs').scrollTop, 123);
  assert.equal(nodes.get('catchup-pending-jobs').children[0], originalRow, 'unchanged rows retain focusable DOM nodes');
  assert.match(nodes.get('catchup-page-status').textContent, /31–60 of 1,000/);
  assert.ok(requests.every((url) => url.includes('view=completed')));
  assert.equal(nodes.get('catchup-view-completed').attributes['aria-pressed'], 'true');
  await ui.changeCatchupView('retrying');
  assert.match(requests.at(-1), /view=retrying&offset=0/);
  assert.equal(nodes.get('catchup-pending-jobs').scrollTop, 0);
});

test('a stale page response cannot overwrite a newly selected catch-up view', async () => {
  const { context, ui, nodes } = harness('dashboard');
  let finishOld;
  context.fetch = async (url) => {
    if (url.includes('view=waiting')) return new Promise((resolve) => { finishOld = resolve; });
    return { ok: true, json: async () => ({ offset: 0, total: 1, items: [{ kind: 'object', id: 'correct-retry', state: 'retrying' }] }) };
  };
  const old = ui.refreshCatchupPage();
  const selected = ui.changeCatchupView('retrying');
  finishOld({ ok: true, json: async () => ({ offset: 0, total: 1, items: [{ kind: 'object', id: 'wrong-pending', state: 'pending' }] }) });
  await old;
  await selected;
  assert.match(nodes.get('catchup-pending-jobs').textContent, /correct-retry/);
  assert.doesNotMatch(nodes.get('catchup-pending-jobs').textContent, /wrong-pending/);
  assert.equal(nodes.get('catchup-view-retrying').attributes['aria-pressed'], 'true');
});

test('retry rows show attention, attempts and eligibility without promising a start time', async () => {
  const { context, ui, nodes } = harness('dashboard');
  context.fetch = async () => ({ ok: true, json: async () => ({ offset: 0, total: 1, items: [{ kind: 'review', id: 'retry', state: 'retrying', needs_attention: true, attempts: 8, failures: 8, first_failed_at: 10000, last_attempt_at: 20000, next_attempt_at: 30000, reason: 'description_not_confirmed' }] }) });
  await ui.changeCatchupView('attention');
  assert.match(nodes.get('catchup-pending-jobs').textContent, /Needs attention \(automatic retries continue\)/);
  assert.match(nodes.get('catchup-pending-jobs').textContent, /Attempts: 8/);
  assert.match(nodes.get('catchup-pending-jobs').textContent, /First unsuccessful attempt/);
  assert.match(nodes.get('catchup-pending-jobs').textContent, /not a promised start/);
  assert.match(nodes.get('catchup-pending-jobs').children[0].className, /catchup-attention/);
});

test('manual retry shares the admin login and still checks job eligibility', async () => {
  const { context, ui, nodes } = harness('dashboard');
  context.window.confirm = () => true;
  const calls = [];
  context.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => url.includes('/jobs?') ? { offset: 0, total: 0, items: [] } : {} };
  };
  const job = { kind: 'review', id: 'one', state: 'retrying' };
  await ui.performCatchupAction('retry', job);
  assert.equal(calls.length, 0);
  ui.setToken('single-admin-password');
  await ui.performCatchupAction('retry', { ...job, state: 'waiting_result' });
  assert.equal(calls.length, 0);
  await ui.performCatchupAction('retry', job);
  const action = calls.find((call) => call.options.method === 'POST');
  assert.equal(action.options.headers.authorization, 'Bearer single-admin-password');
  assert.deepEqual(JSON.parse(action.options.body), { confirm: true, kind: 'review', id: 'one' });
  assert.match(nodes.get('catchup-action-status').textContent, /Request accepted/);
});

test('a rejected admin password locks catch-up actions without altering saved jobs', async () => {
  const { context, ui, nodes } = harness('dashboard');
  context.window.confirm = () => true;
  let posts = 0;
  context.fetch = async () => { posts++; return { ok: false, status: 401, json: async () => ({ error: 'Administrator password required.' }) }; };
  ui.setToken('bad-admin-password');
  const job = { kind: 'object', id: 'media-missing', state: 'skipped' };
  await ui.performCatchupAction('recheck', job);
  assert.equal(posts, 1);
  assert.match(nodes.get('catchup-control-state').textContent, /Controls are locked/);
  assert.match(nodes.get('catchup-action-status').textContent, /Administrator password required/);
  await ui.performCatchupAction('recheck', job);
  assert.equal(posts, 1);
});

test('catch-up distinguishes the live priority blocker from saved-result confirmation', async () => {
  const { context, ui, nodes } = harness('dashboard');
  let data = { backend: { reachable: true, state: 'healthy' }, service: { ready: true },
    scheduler: { background: { allowed: false, reason: 'active_request' } }, active_request: { client: 'odysseus' },
    frigate: { enabled: true, total_queued: 8 } };
  context.fetch = async (url) => ({ ok: true, status: 200, json: async () => url.includes('/jobs?') ? { offset: 0, total: 0, items: [] } : data });
  await ui.refreshSnapshot();
  assert.match(nodes.get('catchup-blocker').textContent, /Waiting for Odysseus/);
  data = { ...data, frigate: { ...data.frigate, active_job: { state: 'waiting_result' } } };
  await ui.refreshSnapshot();
  assert.match(nodes.get('catchup-blocker').textContent, /Waiting for Frigate to save/);
  data = { ...data, scheduler: { background: { allowed: false, reason: 'maintenance_paused' } } };
  await ui.refreshSnapshot();
  assert.match(nodes.get('catchup-blocker').textContent, /paused for GPU maintenance/);
});

test('waiting result explains the confirmation window instead of implying active GPU generation', () => {
  const { ui, nodes } = harness('dashboard');
  ui.renderCatchup({ enabled: true, active_job: { kind: 'review', camera: 'Yard', state: 'waiting_result', next_attempt_at: Date.now() + 600000 } });
  assert.equal(nodes.get('catchup-confirmation').hidden, false);
  assert.match(nodes.get('catchup-confirmation').textContent, /Confirmation window/);
  assert.match(nodes.get('catchup-confirmation').textContent, /not proof that the model is still generating/);
  assert.match(nodes.get('catchup-bridge').textContent, /version-pinned Frigate bridge is required/);
  ui.renderCatchup({ enabled: true, active_job: { state: 'waiting_result', next_attempt_at: 1 } });
  assert.match(nodes.get('catchup-confirmation').textContent, /elapsed/);
});

test('correlated catch-up distinguishes active native generation from independent saved-result verification', async () => {
  const { context, ui, nodes } = harness('dashboard');
  ui.renderCatchup({ enabled: true, bridge_mode: 'correlated', max_verifying: 4, verifying_count: 2,
    active_job: { kind: 'review', camera: 'Yard', state: 'waiting_result', phase: 'running' } });
  assert.match(nodes.get('catchup-bridge').textContent, /Frigate bridge connected/);
  assert.match(nodes.get('catchup-bridge').textContent, /Awaiting save: 2 \/ 4/);
  assert.match(nodes.get('catchup-active').textContent, /Generating/);
  assert.match(nodes.get('catchup-confirmation').textContent, /full native attempt outcome/);
  assert.doesNotMatch(nodes.get('catchup-confirmation').textContent, /Confirmation window/);
  ui.renderCatchup({ enabled: true, bridge_mode: 'correlated', max_verifying: 4, verifying_count: 2 });
  assert.match(nodes.get('catchup-active').textContent, /No active background generation/);
  assert.match(nodes.get('catchup-blocker').textContent, /another eligible job can start/);
  assert.match(nodes.get('catchup-confirmation').textContent, /room for the next eligible generation/);
  context.fetch = async () => ({ ok: true, json: async () => ({ offset: 0, total: 1,
    items: [{ kind: 'review', id: 'one', state: 'waiting_result', phase: 'verifying_saved', next_attempt_at: Date.now() + 600000 }] }) });
  await ui.changeCatchupView('awaiting');
  assert.match(nodes.get('catchup-pending-jobs').textContent, /Awaiting saved description/);
  assert.match(nodes.get('catchup-pending-jobs').textContent, /not active GPU work/);
});

test('verification capacity and uncertain recovery are explicit instead of implying an idle stall', () => {
  const { ui, nodes } = harness('dashboard');
  ui.renderCatchup({ enabled: true, bridge_mode: 'correlated', max_verifying: 4, verifying_count: 4 });
  assert.match(nodes.get('catchup-blocker').textContent, /verification limit reached/);
  assert.match(nodes.get('catchup-confirmation').textContent, /new handoffs wait for space/);
  ui.renderCatchup({ enabled: true, bridge_mode: 'correlated', requires_recovery: true,
    active_job: { kind: 'object', state: 'waiting_result', phase: 'uncertain' } });
  assert.match(nodes.get('catchup-blocker').textContent, /Verify GPU recovery/);
  assert.match(nodes.get('catchup-active').textContent, /Outcome uncertain/);
  assert.match(nodes.get('catchup-confirmation').textContent, /idle dashboard alone is not proof/);
});

test('open API authentication does not become a red infrastructure error and explains no login', () => {
  const { ui, nodes } = harness('settings');
  ui.applyEnvelope({ settings: maskSettings(testConfig({ frigate: { enabled: true, url: 'http://frigate.example', auth_mode: 'none' } })),
    valid: true, revision: 'test', infrastructure: { ui_can_apply: true, frigate_auth_configured: false } });
  assert.doesNotMatch(nodes.get('diagnostics-summary').textContent, /error/);
  assert.match(nodes.get('catchup-auth').textContent, /No Frigate login is required/);
});

test('settings restores the requested section after the authenticated workspace is shown', () => {
  const { context, ui, nodes, timeouts } = harness('settings');
  context.window.location = { hash: '#catchup' };
  ui.applyEnvelope({ settings: maskSettings(testConfig()), valid: true, revision: 'test', infrastructure: { ui_can_apply: true } });
  for (const timer of timeouts.values()) if (timer.milliseconds === 0) timer.fn();
  assert.equal(nodes.get('catchup').scrolled, true);
});

test('warm-model advice only changes keep-alive after explicit draft action', () => {
  const { ui, nodes, inputs } = harness('settings');
  ui.applyEnvelope({ settings: maskSettings(testConfig({ frigate: { enabled: true, url: 'http://frigate.example' }, clients: { frigate: { model_policy: { keep_alive: '15s' } } } })), valid: true, infrastructure: { ui_can_apply: true } });
  const field = inputs.find((input) => input.dataset.path === 'clients.frigate.model_policy.keep_alive');
  assert.equal(field.value, '15s');
  assert.equal(nodes.get('catchup-warm-warning').hidden, false);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.collectPatch())), {});
  ui.useWarmModel();
  assert.equal(field.value, '2m');
  assert.deepEqual(JSON.parse(JSON.stringify(ui.collectPatch())), { clients: { frigate: { model_policy: { keep_alive: '2m' } } } });
  assert.equal(nodes.get('catchup-warm-warning').hidden, true);
  assert.equal(nodes.get('document-state').textContent, 'Unapplied changes');
});

test('settings catch-up refresh is single-flight, bounded, and stops when logged out or hidden', async () => {
  const { context, ui, timeouts, intervals } = harness('settings');
  let requests = 0;
  context.fetch = async (_url, { signal }) => {
    requests++;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  };
  ui.applyEnvelope({ settings: maskSettings(testConfig()), valid: true, infrastructure: { ui_can_apply: true } });
  const outstanding = ui.refreshCatchup();
  ui.refreshCatchup();
  assert.equal(requests, 1);
  assert.ok([...timeouts.values()].some((timer) => timer.milliseconds === 10000));
  assert.ok([...intervals.values()].some((timer) => timer.milliseconds === 5000));
  ui.showAuth('Logged out');
  await outstanding;
  assert.equal(intervals.size, 0);
  assert.equal(timeouts.size, 1, 'only the token-input focus timeout remains');
  await ui.refreshCatchup();
  assert.equal(requests, 1);
  context.document.hidden = true;
  ui.applyEnvelope({ settings: maskSettings(testConfig()), valid: true, infrastructure: { ui_can_apply: true } });
  await ui.refreshCatchup();
  assert.equal(requests, 1);
  assert.equal(intervals.size, 0);
});

test('dashboard restores the connected badge after a temporary polling failure', async () => {
  const { context, ui, nodes, intervals, timeouts } = harness('dashboard');
  ui.startPolling();
  assert.ok([...intervals.values()].some((timer) => timer.milliseconds === 2000));
  context.fetch = async () => { throw new Error('mock offline'); };
  assert.equal(await ui.refreshSnapshot(), false);
  assert.equal(nodes.get('connection-label').textContent, 'Disconnected');
  context.fetch = async () => ({ ok: true, status: 200, json: async () => ({ backend: { reachable: true, state: 'healthy' }, service: { ready: true } }) });
  assert.equal(await ui.refreshSnapshot(), true);
  assert.equal(nodes.get('connection-label').textContent, 'Polling every 2s');
  assert.equal(timeouts.size, 0);
  assert.doesNotMatch(DASHBOARD_JS, /connectEvents|EVENTS_URL|STREAM_RETRY_MS|TextDecoder/);
});

test('hung polling is bounded and visibly reports a timeout', async () => {
  const { context, ui, nodes, timeouts } = harness('dashboard');
  context.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  const result = ui.refreshSnapshot();
  const timeout = [...timeouts.values()].find((timer) => timer.milliseconds === 10000);
  assert.ok(timeout);
  timeout.fn();
  assert.equal(await result, false);
  assert.match(nodes.get('page-error').textContent, /timed out/);
  assert.equal(nodes.get('connection-label').textContent, 'Disconnected');
});

test('strict settings hide and disable irrelevant fair-sharing fields', () => {
  const { ui, fields, nodes } = harness('settings');
  ui.applyEnvelope({ settings: maskSettings(testConfig({ scheduler: { mode: 'strict_priority' }, frigate: { enabled: true, url: 'http://frigate.example' } })), valid: true, revision: 'test', infrastructure: { ui_can_apply: true } });
  for (const path of ['scheduler.priority_aging', 'scheduler.aging_interval', 'clients.frigate.max_wait', 'clients.odysseus.model_policy.max_batch_time']) {
    const field = fields.find((item) => item.dataset.fieldWrap === path);
    assert.equal(field.hidden, true, path);
    assert.ok(field.children.every((input) => input.disabled), path);
  }
  assert.equal(nodes.get('catchup-scan').disabled, false);
});

test('restart_pending contract shows safe restart and blocks saved mutations and historical scan', () => {
  const { ui, nodes } = harness('settings');
  assert.equal(ui.restartInfo({ restart_pending: true }).title, 'Waiting for safe restart');
  ui.applyEnvelope({ settings: maskSettings(testConfig({ frigate: { enabled: true, url: 'http://frigate.example' } })), valid: true, restart_pending: true, revision: 'test', infrastructure: { ui_can_apply: true } });
  assert.equal(nodes.get('restart-banner').hidden, false);
  assert.equal(nodes.get('catchup-scan').disabled, true);
  assert.equal(nodes.get('apply-button').disabled, true);
  assert.equal(nodes.get('rollback-button').disabled, true);
  assert.equal(nodes.get('reset-button').disabled, true);
  assert.equal(nodes.get('document-state').textContent, 'Waiting for safe restart');
});
