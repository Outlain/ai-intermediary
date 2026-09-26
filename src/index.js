import process from 'node:process';
import { applyHostEnvironment, readConfigSource } from './config.js';
import { Logger } from './logger.js';
import { ProxyService } from './proxy.js';
import { RecoveryService } from './recovery.js';
import { SettingsController } from './settings-controller.js';
import { SettingsStore } from './settings.js';
import { configuredAdminToken } from './auth.js';

const logger = new Logger();
const configPath = process.env.CONFIG_PATH ?? '/app/config.yml';
const requestedSettingsPath = process.env.SETTINGS_PATH ?? '/app/state/settings.json';
const recoveryListen = process.env.SETTINGS_RECOVERY_LISTEN ?? '0.0.0.0:11434';
const adminToken = configuredAdminToken(process.env);
if (!adminToken) throw new Error('ADMIN_TOKEN is required. Set one administrator credential in secrets.env and recreate the container.');
const settingsToken = adminToken;

let service;
let settingsController;
let shuttingDown = false;
let restartingForSettings = false;

function issue(path, code, message, severity = 'error', uiFixable = false) {
  return { path, code, message, severity, ui_fixable: uiFixable };
}

async function restartForSettings() {
  if (restartingForSettings) return;
  restartingForSettings = true;
  logger.warn('validated settings were committed; waiting for active work before restart');
  try {
    await service?.waitForIdle?.();
    await service?.stop();
  } catch (error) {
    logger.error('graceful settings restart cleanup failed', { error: error.stack ?? error.message });
  }
  // Docker's unless-stopped policy and systemd Restart=on-failure both relaunch
  // exit 75. Direct foreground runs intentionally stop and must be started again.
  process.exit(75);
}

async function shutdown(signal) {
  if (shuttingDown || restartingForSettings) return;
  shuttingDown = true;
  logger.info('shutdown requested', { signal });
  if (!service) {
    // Startup has not acquired any listener or GPU-facing resource yet. Exit
    // immediately instead of swallowing the supervisor's stop request while
    // asynchronous settings-state initialization is still in progress.
    process.exit(0);
  }
  try {
    await service.stop();
  } catch (error) {
    logger.error('graceful shutdown failed', { error: error.stack ?? error.message });
    process.exitCode = 1;
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const diagnostics = [];
let baseRaw = {};
let missingEnvironment = [];
let mutationDisabledReason = '';

try {
  const source = readConfigSource(configPath, process.env, { allowMissingRequired: true });
  baseRaw = source.raw;
  missingEnvironment = source.missingEnvironment;
} catch (error) {
  mutationDisabledReason = 'config.yml cannot be parsed safely. Correct it on the host before applying browser settings.';
  diagnostics.push(issue(
    'config.yml',
    'base_configuration_unreadable',
    'The read-only config.yml file could not be read or parsed. Fix its YAML syntax or mount on the host.',
  ));
  logger.error('base configuration could not be read for recovery', {
    error: error.stack ?? error.message,
    config_path: configPath,
  });
}

let settingsPath = requestedSettingsPath;
// Host-managed credentials work even with older operator-owned config.yml files.
// Browser overrides never contain these values.
baseRaw.frigate = { ...baseRaw.frigate };
for (const [field, variable] of Object.entries({
  url: 'FRIGATE_URL', username: 'FRIGATE_USERNAME', password: 'FRIGATE_PASSWORD', auth_token: 'FRIGATE_AUTH_TOKEN',
})) {
  if (process.env[variable]) baseRaw.frigate[field] = process.env[variable];
}
baseRaw.gpu_safety = { state_path: '/app/state/gpu-recovery.json', ...baseRaw.gpu_safety };
try {
  baseRaw = applyHostEnvironment(baseRaw, process.env);
} catch (error) {
  mutationDisabledReason = 'Host helper/recovery environment values are invalid. Correct them on the host and recreate the container.';
  diagnostics.push(issue('environment.host_helper', 'invalid_host_environment', error.message));
}
let settingsStore;
try {
  settingsStore = new SettingsStore({
    statePath: settingsPath,
    baseRaw,
    // readConfigSource already expanded each YAML value exactly once. An empty
    // environment prevents literal ${NAME} text inside an env value from being
    // interpreted a second time by the settings layer.
    environment: null,
    logger,
  });
} catch (error) {
  settingsPath = '/app/state/settings.json';
  mutationDisabledReason = 'SETTINGS_PATH is invalid. Set it to an absolute path in the container environment.';
  diagnostics.push(issue(
    'environment.SETTINGS_PATH',
    'invalid_settings_path',
    'SETTINGS_PATH must be an absolute path inside the container.',
  ));
  settingsStore = new SettingsStore({ statePath: settingsPath, baseRaw, environment: null, logger });
}

let settingsSnapshot;
try {
  settingsSnapshot = await settingsStore.load();
} catch (error) {
  diagnostics.push(issue(
    'settings.state',
    'settings_state_load_failed',
    'Saved settings could not be loaded. Verify that the intermediary state volume is readable and writable.',
  ));
  logger.error('settings state initialization failed', { error: error.stack ?? error.message });
  settingsSnapshot = settingsStore.snapshot();
}

for (const missing of missingEnvironment) {
  if (adminToken && ['OBSERVABILITY_TOKEN', 'SETTINGS_TOKEN', 'MAINTENANCE_TOKEN', 'MEDIA_TOKEN'].includes(missing.variable)) continue;
  // ollama.url is editable and full normalization already reports it as an
  // error when blank. Keeping the environment hint as a warning lets the UI
  // repair it with a persistent override. Credentials remain host-only.
  const editableInUi = missing.path === 'ollama.url';
  diagnostics.push(issue(
    missing.path ?? `environment.${missing.variable}`,
    'required_environment_missing',
    editableInUi
      ? `${missing.variable} is empty; set the Ollama URL here or in secrets.env.`
      : `${missing.variable} is required in secrets.env and cannot be changed in the browser.`,
    editableInUi ? 'warning' : 'error',
    editableInUi,
  ));
}

settingsController = new SettingsController({
  store: settingsStore,
  token: settingsToken,
  authentication: { mode: 'single_admin' },
  mode: 'starting',
  configPath,
  additionalDiagnostics: diagnostics,
  mutationDisabledReason,
  logger,
  onRestart: restartForSettings,
});

const hasBlockingBootstrapIssue = diagnostics.some((item) => item.severity === 'error');
const config = settingsStore.getEffectiveConfig();
const configurationReady = !mutationDisabledReason
  && !hasBlockingBootstrapIssue
  && settingsSnapshot.valid
  && Boolean(config);

if (configurationReady) {
  settingsController.mode = 'running';
  service = new ProxyService(config, { logger, settingsController });
  settingsController.setLifecycle({
    onRestartPending: () => service.beginSettingsRestart(),
    onRestart: restartForSettings,
  });
} else {
  settingsController.mode = 'configuration_error';
  service = new RecoveryService({
    listen: recoveryListen,
    settingsController,
    logger,
  });
  settingsController.setLifecycle({ onRestart: restartForSettings });
}

try {
  await service.start();
} catch (error) {
  // Listener conflicts and other runtime failures are not configuration
  // recovery conditions. Fail loudly so the supervisor can report/retry them.
  logger.error('intermediary startup failed', { error: error.stack ?? error.message, config_path: configPath });
  if (service?.running) await service.stop().catch(() => {});
  process.exitCode = 1;
}
