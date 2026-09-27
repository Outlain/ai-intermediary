(function () {
  'use strict';

  var STATUS_URL = '/_intermediary/v1/status';
  var MAINTENANCE_PAUSE_URL = '/_intermediary/v1/maintenance/pause';
  var MAINTENANCE_RESUME_URL = '/_intermediary/v1/maintenance/resume';
  var ADMIN_TOKEN_KEY = 'ai-intermediary-admin-token';
  var POLL_INTERVAL_MS = 2000;

  var snapshot = null;
  var activeClock = null;
  var maintenanceClock = null;
  var memoryToken = '';
  var maintenanceActionPending = false;
  var recoveryActionPending = false;
  var mediaRecoveryActionPending = false;
  var refreshPromise = null;
  var pollTimer = null;
  var authBlocked = false;
  var catchupOffset = 0;
  var catchupPage = null;
  var catchupPagePromise = null;
  var catchupRenderedPage = null;
  var catchupView = 'waiting';
  var catchupData = {};
  var catchupAdminToken = '';
  var catchupActionPending = false;
  var CATCHUP_PAGE_SIZE = 30;
  var CATCHUP_VIEWS = {
    waiting: ['Waiting · newest event first', 'Jobs not yet handed off. Odysseus and live Frigate work always have priority.'],
    awaiting: ['Generation / awaiting saved result', 'Rows distinguish native generation from saved-result verification. Completion is confirmed only when Frigate saves a description.'],
    retrying: ['Retrying · newest event first', 'Retry times are earliest eligible times, not promised start times. Delays increase after unsuccessful attempts.'],
    attention: ['Needs attention · still retrying', 'These jobs have remained unsuccessful past the configured attention threshold. Automatic retries continue; waiting behind live work alone is not a failure.'],
    completed: ['Completed · retained history', 'Descriptions are saved in Frigate. Removing old history rows here never removes descriptions or recordings.'],
    skipped: ['Skipped / media missing · retained history', 'Jobs no longer eligible for generation, including confirmed missing media. Connection errors alone never prove that footage was deleted.']
  };

  function byId(id) { return document.getElementById(id); }
  function setText(id, value) {
    var element = byId(id);
    if (element) element.textContent = value == null || value === '' ? '—' : String(value);
  }
  function setHidden(id, hidden) {
    var element = byId(id);
    if (element) element.hidden = Boolean(hidden);
  }
  function safeNumber(value, fallback) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : (fallback == null ? 0 : fallback);
  }
  function positiveNumber(value) { return Math.max(0, safeNumber(value, 0)); }
  function titleCase(value) {
    if (!value) return 'Unknown';
    return String(value).replace(/[_-]+/g, ' ').replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
  }
  function compactId(value) {
    var text = String(value || '');
    if (text.length <= 14) return text || '—';
    return text.slice(0, 8) + '…' + text.slice(-4);
  }
  function formatInteger(value) {
    if (value == null || value === '') return '—';
    return Math.round(safeNumber(value, 0)).toLocaleString();
  }
  function formatBytes(value) {
    if (value == null || value === '') return '—';
    var bytes = positiveNumber(value);
    if (bytes < 1024) return Math.round(bytes) + ' B';
    var units = ['KB', 'MB', 'GB', 'TB'];
    var index = -1;
    do { bytes /= 1024; index += 1; } while (bytes >= 1024 && index < units.length - 1);
    var precision = bytes >= 10 ? 1 : 2;
    return bytes.toFixed(precision).replace(/\.0+$/, '') + ' ' + units[index];
  }
  function formatDuration(value) {
    if (value == null || value === '') return '—';
    var seconds = Math.max(0, Math.floor(safeNumber(value, 0)));
    if (seconds < 60) return seconds + 's';
    var minutes = Math.floor(seconds / 60);
    var remainder = seconds % 60;
    if (minutes < 60) return minutes + 'm ' + remainder + 's';
    var hours = Math.floor(minutes / 60);
    minutes %= 60;
    if (hours < 24) return hours + 'h ' + minutes + 'm';
    var days = Math.floor(hours / 24);
    return days + 'd ' + (hours % 24) + 'h';
  }
  function formatDate(value) {
    if (!value) return '—';
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(date);
  }
  function formatRelativeDate(value) {
    if (!value) return '—';
    var timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return '—';
    var seconds = (Date.now() - timestamp) / 1000;
    if (seconds < -1) return 'in ' + formatDuration(-seconds);
    if (seconds < 5) return 'just now';
    return formatDuration(seconds) + ' ago';
  }
  function create(tag, className, text) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = String(text);
    return element;
  }
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
    memoryToken = value || '';
    writeSession(ADMIN_TOKEN_KEY, memoryToken);
    setHidden('forget-token', !memoryToken);
    syncMaintenanceControls();
    syncCatchupControls();
  }
  function getMaintenanceToken() { return getToken(); }
  function setMaintenanceToken(value) { setToken(value); }
  function requestHeaders() {
    var headers = { accept: 'application/json' };
    var token = getToken();
    if (token) headers.authorization = 'Bearer ' + token;
    return headers;
  }
  function maintenanceHeaders() {
    var headers = { accept: 'application/json', 'content-type': 'application/json' };
    var token = getMaintenanceToken();
    if (token) headers.authorization = 'Bearer ' + token;
    return headers;
  }

  function ollamaRecoveryIsActive(data) {
    var state = data && data.recovery && data.recovery.state;
    return Boolean(data && data.backend && data.backend.recovery_required)
      || ['restarting', 'verifying'].includes(state);
  }
  function recoveryIsActive(data) {
    return ollamaRecoveryIsActive(data) || Boolean(data && data.media && data.media.blocked);
  }
  function mediaOutputCompleted(job) {
    return Boolean(job && job.execution_state === 'completed' && job.outputsImported === true);
  }
  function mediaCleanupPending(media) {
    if (!media || !media.blocked) return false;
    var jobs = Array.isArray(media.jobs) ? media.jobs : [];
    var unresolved = new Set(jobs.filter(function (job) { return job.state === 'uncertain'; }).map(function (job) { return job.id; }));
    (Array.isArray(media.unresolved) ? media.unresolved : []).forEach(function (id) { unresolved.add(id); });
    return unresolved.size > 0 && Array.from(unresolved).every(function (id) {
      return mediaOutputCompleted(jobs.find(function (job) { return job.id === id; }));
    });
  }
  function mediaReleaseDetail(release) {
    if (!release || typeof release !== 'object') return '';
    var details = [];
    if (release.reason) details.push('Latest release check: ' + titleCase(release.reason));
    if (release.phase === 'comfy') details.push('ComfyUI cleanup');
    if (release.phase === 'physical') details.push('Physical GPU verification');
    if (typeof release.backend === 'string') details.push('Backend: ' + release.backend);
    function memory(value, ceiling, label) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return;
      var text = label + ': ' + (value / 1024 / 1024).toFixed(1).replace(/\.0$/, '') + ' MiB';
      if (typeof ceiling === 'number' && Number.isFinite(ceiling) && ceiling >= 0) {
        text += ' / ' + (ceiling / 1024 / 1024).toFixed(1).replace(/\.0$/, '') + ' MiB ceiling';
      }
      details.push(text);
    }
    memory(release.reserved_bytes, release.max_reserved_bytes, 'PyTorch reserved');
    memory(release.active_bytes, null, 'PyTorch active');
    memory(release.physical_vram_bytes, release.max_physical_vram_bytes, 'Physical VRAM');
    if (release.sampled_at) details.push('Sample: ' + formatRelativeDate(release.sampled_at));
    if (typeof release.attempts === 'number' && Number.isSafeInteger(release.attempts) && release.attempts >= 0) {
      details.push('Cleanup attempts: ' + formatInteger(release.attempts));
    }
    if (release.automatic_retry_exhausted === true) {
      details.push('Automatic cleanup retries exhausted. Manual verification required; GPU remains blocked.');
    } else if (release.next_retry_at && Number.isFinite(new Date(release.next_retry_at).getTime())) {
      details.push('Automatic cleanup recheck ' + formatRelativeDate(release.next_retry_at) + ' (earliest eligible time). Generation is not resubmitted.');
    }
    return details.join(' · ');
  }

  function setConnection(kind, label) {
    var badge = byId('connection-status');
    badge.classList.remove('is-live', 'is-offline');
    if (kind === 'live') badge.classList.add('is-live');
    if (kind === 'offline') badge.classList.add('is-offline');
    setText('connection-label', label);
  }
  function showError(message) {
    setText('page-error', message);
    setHidden('page-error', !message);
  }
  function showAuth(message) {
    authBlocked = true;
    setHidden('auth-panel', false);
    setText('auth-message', message || 'Enter your administrator password.');
    setConnection('offline', 'Authentication required');
    stopConnections();
    window.setTimeout(function () { byId('token-input').focus(); }, 0);
  }
  function hideAuth() {
    authBlocked = false;
    setHidden('auth-panel', true);
    setText('auth-message', 'Use your administrator password to open this dashboard.');
  }

  function healthState(data) {
    var backend = data.backend || {};
    var service = data.service || {};
    var scheduler = data.scheduler || {};
    var maintenance = data.maintenance || {};
    var maintenanceState = String(maintenance.state || (maintenance.paused ? 'paused' : 'running')).toLowerCase();
    var ready = typeof service.ready === 'boolean' ? service.ready : service.state === 'ready';
    if (data.media && data.media.blocked) {
      if (mediaCleanupPending(data.media)) {
        return { css: 'health-warning', title: 'Media completed; GPU release pending',
          detail: 'Generation and output import succeeded. Shared GPU work stays blocked until cleanup and release are verified. '
            + (data.media.release && data.media.release.reason ? 'Latest check: ' + titleCase(data.media.release.reason) + '. ' : '')
            + 'See Media recovery below; do not regenerate the saved result.' };
      }
      return { css: 'health-danger', title: 'Shared GPU blocked · media recovery required',
        detail: 'A ComfyUI operation or its GPU release is unverified. New GPU work is blocked; check Media recovery below. An idle Ollama API does not clear this lock.' };
    }
    if (recoveryIsActive(data)) {
      return { css: 'health-danger', title: data.recovery && ['restarting', 'verifying'].includes(data.recovery.state) ? 'Inference recovery in progress' : 'Inference recovery required', detail: backend.recovery_reason || 'The previous operation could not be verified safe. New inference is blocked during recovery.' };
    }
    if (maintenanceState === 'error') {
      return { css: 'health-danger', title: 'Pause mode needs attention', detail: maintenance.unload_error || maintenance.reason || 'The intermediary could not complete the maintenance transition.' };
    }
    if (maintenanceState === 'pausing') {
      return { css: 'health-warning', title: 'Preparing the GPU for maintenance', detail: 'The active request is draining; queued and new inference requests receive HTTP 503.' };
    }
    if (maintenanceState === 'paused' || maintenance.paused) {
      return { css: 'health-warning', title: 'GPU reserved by pause mode', detail: maintenance.resume_at ? 'Inference will resume automatically when the timer expires.' : 'Inference remains paused until it is manually resumed.' };
    }
    if (!backend.reachable || backend.state === 'unhealthy' || backend.state === 'offline') {
      return { css: 'health-danger', title: 'Ollama is unavailable', detail: 'The intermediary cannot currently reach the Ollama backend.' };
    }
    if (!ready || service.accepting === false) {
      return { css: 'health-warning', title: 'Requests are paused', detail: 'The intermediary is online but is not accepting new inference requests.' };
    }
    if (backend.state && backend.state !== 'healthy') {
      return { css: 'health-warning', title: titleCase(backend.state), detail: 'The backend is reachable but is not in its normal healthy state.' };
    }
    if (data.recovery && (data.recovery.requires_attention || data.recovery.state === 'needs_attention')) {
      return { css: 'health-warning', title: 'Automatic recovery needs attention', detail: 'No inference recovery lock is reported. Normal scheduling can continue, but automatic recovery is unavailable until its reported issue is resolved.' };
    }
    if (backend.last_inference_error) {
      return { css: 'health-warning', title: 'Last inference request failed', detail: 'The Ollama API is reachable, but that does not confirm the model ran successfully. Inspect recent activity for the failure.' };
    }
    return {
      css: 'health-good',
      title: data.media && data.media.enabled ? 'Shared GPU scheduler operational' : 'Everything is operational',
      detail: 'Ollama is reachable · Scheduler is ' + titleCase(scheduler.state || 'idle').toLowerCase()
        + (data.media && data.media.enabled ? ' · Media jobs use the same exclusive GPU queue. Backend configuration alone is not a health test.' : '.')
    };
  }

  function renderHealth(data) {
    var service = data.service || {};
    var result = healthState(data);
    var banner = byId('health-banner');
    banner.classList.remove('health-neutral', 'health-good', 'health-warning', 'health-danger');
    banner.classList.add(result.css);
    setText('overall-state', result.title);
    setText('overall-detail', result.detail);
    setText('service-uptime', formatDuration(service.uptime_seconds));
    setText('snapshot-age', formatRelativeDate(data.generated_at));
    setText('schema-version', 'Schema ' + (data.schema_version || '—'));
  }

  function setMaintenanceActionStatus(message, kind) {
    var element = byId('maintenance-action-status');
    element.className = 'action-status';
    if (kind === 'error') element.classList.add('is-error');
    if (kind === 'success') element.classList.add('is-success');
    element.textContent = message || '';
  }

  function syncMaintenanceControls() {
    var maintenance = snapshot && snapshot.maintenance ? snapshot.maintenance : {};
    var state = String(maintenance.state || (maintenance.paused ? 'paused' : 'running')).toLowerCase();
    var controlAvailable = maintenance.control_available === true;
    var hasToken = Boolean(getMaintenanceToken());
    var canAct = controlAvailable && hasToken && !maintenanceActionPending && !recoveryActionPending && !mediaRecoveryActionPending;
    var duration = byId('pause-duration');
    var pause = byId('pause-button');
    var resume = byId('resume-button');

    if (duration) duration.disabled = !canAct || state !== 'running';
    if (pause) pause.disabled = !canAct || state !== 'running';
    if (resume) resume.disabled = !canAct || recoveryIsActive(snapshot) || (state !== 'paused' && state !== 'pausing' && state !== 'error');

    if (!snapshot) {
      setText('maintenance-control-availability', 'Waiting for maintenance status…');
    } else if (!controlAvailable) {
      setText('maintenance-control-availability', 'Maintenance controls are unavailable; enable them in Settings.');
    } else if (!hasToken) {
      setText('maintenance-control-availability', 'Log in with the administrator password to use maintenance controls.');
    } else if (maintenanceActionPending) {
      setText('maintenance-control-availability', 'A maintenance request is in progress…');
    } else {
      setText('maintenance-control-availability', recoveryIsActive(snapshot)
        ? 'Recovery is required. You may pause inference; resume is blocked until recovery completes.'
        : 'Maintenance controls are ready. Your administrator login authorizes pause, resume, and protected recovery actions.');
    }
    syncRecoveryControls();
    syncMediaRecoveryControls();
    if (snapshot) renderWorkPolicy(snapshot);
  }

  function renderMaintenance(data) {
    var maintenance = data.maintenance || {};
    var state = String(maintenance.state || (maintenance.paused ? 'paused' : 'running')).toLowerCase();
    var stateTag = byId('maintenance-state');
    var recoveryBlocked = recoveryIsActive(data);
    stateTag.className = 'tag tag-neutral';
    if (state === 'running') stateTag.className = 'tag tag-good';
    if (state === 'pausing' || state === 'paused') stateTag.className = 'tag tag-warning';
    if (state === 'error') stateTag.className = 'tag tag-danger';
    setText('maintenance-state', state === 'running' && recoveryBlocked ? 'Recovery blocked' : titleCase(state));
    if (recoveryBlocked) stateTag.className = 'tag tag-danger';

    var reasonPrefix = maintenance.reason ? 'Reason: ' + maintenance.reason + '. ' : '';
    if (recoveryBlocked) {
      setText('maintenance-title', state === 'paused' || maintenance.paused ? 'Inference is paused · recovery required' : 'Inference is blocked for recovery');
      setText('maintenance-detail', 'No new inference can start until recovery is verified. Manual pause remains in effect after recovery; it is never automatically resumed.');
    } else if (state === 'pausing') {
      setText('maintenance-title', 'Finishing the active request');
      setText('maintenance-detail', reasonPrefix + 'No additional inference will start while the active upstream request drains.');
    } else if (state === 'error') {
      setText('maintenance-title', 'Pause mode needs attention');
      setText('maintenance-detail', maintenance.unload_error || maintenance.reason || 'The intermediary could not complete the requested transition.');
    } else if (state === 'paused' || maintenance.paused) {
      setText('maintenance-title', 'Inference is paused');
      setText('maintenance-detail', reasonPrefix + (maintenance.resume_at
        ? 'The intermediary will resume inference automatically when the timer expires.'
        : 'Inference will remain paused until it is manually resumed.'));
    } else {
      var scheduled = data.scheduled_maintenance || {};
      var scoped = data.work_policy && data.work_policy.sources && data.work_policy.sources.some(function (source) { return source.live || source.catchup; });
      setText('maintenance-title', scheduled.paused ? 'Scheduled GPU reservation' : scoped ? 'Source pause rules are active' : 'Inference is running normally');
      setText('maintenance-detail', scheduled.paused ? 'A schedule blocks new work and waits for managed engines to release the GPU. Ending it does not cancel a manual pause. See schedules below.' : scoped ? 'Only eligible sources may generate. See source pauses and schedules below.' : 'Eligible AI work shares one GPU scheduler. Pause mode is ready when you need the GPU elsewhere.');
      if (scheduled.paused) setText('maintenance-state', 'Scheduled pause');
    }

    var resumeTimestamp = maintenance.resume_at ? new Date(maintenance.resume_at).getTime() : NaN;
    var hasCountdown = (state === 'paused' || state === 'pausing') && (Number.isFinite(resumeTimestamp) || maintenance.remaining_seconds != null);
    if (hasCountdown) {
      maintenanceClock = {
        seconds: positiveNumber(maintenance.remaining_seconds),
        at: performance.now(),
        resumeAt: Number.isFinite(resumeTimestamp) ? resumeTimestamp : null
      };
      setText('maintenance-resume-at', Number.isFinite(resumeTimestamp) ? formatDate(maintenance.resume_at) : 'Timer active');
    } else {
      maintenanceClock = null;
      setText('maintenance-resume-at', (state === 'paused' || state === 'pausing') ? 'Manual' : '—');
      setText('maintenance-countdown', (state === 'paused' || state === 'pausing') ? 'Manual' : '—');
    }
    if (recoveryBlocked) setText('maintenance-gpu-released', 'Not verified');
    else if (data.scheduled_maintenance && data.scheduled_maintenance.paused) setText('maintenance-gpu-released', data.scheduled_maintenance.gpu_released ? 'Yes · scheduled' : 'Scheduled release pending');
    else if (maintenance.gpu_released === true) setText('maintenance-gpu-released', 'Yes');
    else if (state === 'pausing') setText('maintenance-gpu-released', 'Waiting for drain');
    else if (state === 'paused' || state === 'error') setText('maintenance-gpu-released', 'No');
    else setText('maintenance-gpu-released', 'Managed by shared scheduler');
    setText('maintenance-paused-at', formatDate(maintenance.paused_at));
    updateLiveClocks();
    syncMaintenanceControls();
  }

  function renderActive(data) {
    var active = data.active_request;
    var mediaRunning = (data.media && Array.isArray(data.media.jobs) ? data.media.jobs : []).filter(function (job) { return ['dispatching', 'running'].includes(job.state); });
    var scheduler = data.scheduler || {};
    var workloadState = recoveryIsActive(data) ? 'recovery_required' : String(scheduler.state || (active ? 'busy' : 'idle')).toLowerCase();
    var stateTag = byId('active-state');
    stateTag.className = 'tag tag-neutral';
    if (workloadState === 'busy' || workloadState === 'idle') stateTag.className = 'tag tag-good';
    if (workloadState === 'recovery_required' || workloadState === 'unavailable' || workloadState === 'shutting_down') stateTag.className = 'tag tag-danger';
    setText('active-state', titleCase(workloadState));
    setHidden('active-empty', Boolean(active));
    setHidden('active-content', !active);
    if (!active) {
      activeClock = null;
      setText('active-empty-title', recoveryIsActive(data) ? 'New inference is blocked' : mediaRunning.length ? 'Media work holds the GPU' : 'No request is running');
      setText('active-empty-detail', recoveryIsActive(data)
        ? 'Recovery must finish before another request can start. An empty scheduler does not prove upstream work stopped.'
        : mediaRunning.length ? 'ComfyUI media work is tracked in the media panel. An empty Ollama request display does not make the shared GPU idle.'
          : data.maintenance && data.maintenance.paused ? 'Inference remains paused. Resume it only when you are ready.'
          : workloadState === 'idle' ? 'The scheduler is idle. New requests remain subject to backend and safety checks.' : 'The scheduler is not currently dispatching a request.');
      return;
    }

    var metadata = active.request || {};
    var clientTag = byId('active-client');
    clientTag.dataset.client = String(active.client || '').toLowerCase();
    setText('active-client', titleCase(active.client));
    setText('active-type', titleCase(active.type));
    setText('active-streaming', active.streaming ? 'Streaming' : 'Buffered');
    setText('active-model', active.model);
    setText('active-endpoint', active.endpoint);
    setText('active-queue-wait', formatDuration(active.queue_wait_seconds));
    setText('active-reason', titleCase(active.schedule_reason));
    setText('active-id', compactId(active.id));
    byId('active-id').title = active.id || '';
    setText('active-status-text', titleCase(active.state));
    setText('meta-body', formatBytes(metadata.body_bytes));
    setText('meta-characters', formatInteger(metadata.input_characters));
    setText('meta-messages', formatInteger(metadata.message_count));
    setText('meta-images', formatInteger(metadata.image_count));
    setText('meta-tools', formatInteger(metadata.tool_count));
    setText('meta-context', formatInteger(metadata.requested_context));
    setText('meta-output', formatInteger(metadata.requested_output_tokens));
    activeClock = { seconds: positiveNumber(active.running_seconds), at: performance.now() };
    updateLiveClocks();
  }

  function queueItem(item) {
    var li = create('li', 'queue-item');
    var header = create('div', 'queue-item-header');
    var title = create('div', 'queue-item-title');
    title.appendChild(create('strong', '', item.model || 'Unknown model'));
    title.appendChild(create('span', '', titleCase(item.client) + ' · ' + titleCase(item.type)));
    header.appendChild(title);
    header.appendChild(create('span', 'wait-time', formatDuration(item.waiting_seconds)));
    li.appendChild(header);

    var metadata = item.request || {};
    var meta = create('div', 'queue-meta');
    var values = [
      'Priority ' + formatInteger(item.effective_priority),
      'TTL ' + formatDuration(item.ttl_remaining_seconds),
      formatBytes(metadata.body_bytes),
      formatInteger(metadata.input_characters) + ' chars',
      formatInteger(metadata.message_count) + ' msgs',
      formatInteger(metadata.image_count) + ' imgs'
    ];
    if (item.classification_method) values.push('Identified by ' + titleCase(item.classification_method));
    if (item.wait_reason) values.push('Waiting: ' + titleCase(item.wait_reason));
    values.forEach(function (value) { meta.appendChild(create('span', '', value)); });
    li.appendChild(meta);
    return li;
  }

  function renderQueue(data) {
    var queue = data.queue || {};
    var byClient = queue.by_client || {};
    var items = Array.isArray(queue.items) ? queue.items : [];
    setText('queue-total', formatInteger(queue.total));
    setText('queue-odysseus', formatInteger(byClient.odysseus));
    setText('queue-frigate', formatInteger(byClient.frigate));
    setText('queue-oldest', formatDuration(queue.oldest_wait_seconds));
    setHidden('queue-empty', items.length > 0);
    var list = byId('queue-items');
    list.replaceChildren();
    items.forEach(function (item) { list.appendChild(queueItem(item)); });
  }

  function renderWorkPolicy(data) {
    var policy = data.work_policy || {}, sources = policy.sources || [];
    var enabled = Boolean(getMaintenanceToken()) && data.maintenance && data.maintenance.control_available === true && !maintenanceActionPending;
    byId('scope-pause').disabled = !enabled;
    setText('policy-timezone', policy.error || ('Schedule timezone: ' + (policy.timezone || 'America/New_York')));
    var list = byId('policy-sources'); list.replaceChildren();
    sources.forEach(function (source) {
      var listeners = (data.listeners || []).filter(function (listener) { return listener.source === source.id; });
      var queue = data.queue && data.queue.by_client || {};
      list.appendChild(create('p', 'muted', source.id + ' · Priority ' + source.priority + ' · Queued ' + (queue[source.id] || 0)
        + ' · Live: ' + (source.live ? titleCase(source.live.reason) : 'eligible')
        + (source.id === 'frigate' ? ' · Catch-up: ' + (source.catchup ? titleCase(source.catchup.reason) : 'eligible') : '')
        + (listeners.length ? ' · Container port: ' + listeners.map(function (listener) { return listener.port + ' ' + (listener.state || 'listening') + (listener.reason ? ' (' + listener.reason + ')' : ''); }).join(', ') + ' (publication unverified)' : '')));
    });
    var rules = byId('policy-rules'); rules.replaceChildren();
    (policy.manual || []).forEach(function (rule) {
      var row = create('p', 'muted', 'Manual: ' + rule.sources.join(', ') + ' · ' + rule.traffic + ' · ' + (rule.until ? 'until ' + formatDate(rule.until) : 'until resumed') + ' ');
      var button = create('button', 'quiet-button', 'Resume this scope'); button.type = 'button'; button.disabled = !enabled;
      button.addEventListener('click', function () { performScopeAction('resume', { id: rule.id }); }); row.appendChild(button); rules.appendChild(row);
    });
    (policy.schedules || []).forEach(function (rule) {
      rules.appendChild(create('p', 'muted', rule.id + ': ' + (!rule.enabled ? 'disabled' : rule.active ? 'ACTIVE' : 'scheduled')
        + ' · ' + rule.sources.join(', ') + ' / ' + rule.traffic + ' · ' + rule.start + '–' + rule.end + ' · ' + rule.days.join(', ')
        + ' · ' + titleCase(rule.mode) + (rule.next_transition ? ' · Next change: ' + formatDate(rule.next_transition) : '')));
    });
  }

  async function performScopeAction(action, body) {
    if (!getMaintenanceToken() || maintenanceActionPending) return;
    maintenanceActionPending = true;
    try {
      var response = await fetch('/_intermediary/v1/maintenance/scopes/' + action, { method: 'POST', headers: maintenanceHeaders(), body: JSON.stringify(body) });
      var result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Source pause change failed.');
      setText('scope-action-status', 'Manual scope updated. Other pauses and schedules still apply.');
      await refreshSnapshot();
    } catch (error) { setText('scope-action-status', error.message); }
    finally { maintenanceActionPending = false; syncMaintenanceControls(); if (snapshot) renderWorkPolicy(snapshot); }
  }

  function detailSummary(details) {
    if (!details || typeof details !== 'object') return '';
    var values = [details.family, details.parameter_size, details.quantization_level].filter(Boolean);
    return values.join(' · ');
  }

  function modelItem(model) {
    var li = create('li', 'model-item');
    li.appendChild(create('strong', '', model.name || 'Unknown model'));
    li.appendChild(create('span', '', formatBytes(model.size_vram)));
    var parts = [];
    if (model.context_length != null) parts.push(formatInteger(model.context_length) + ' context');
    var details = detailSummary(model.details);
    if (details) parts.push(details);
    if (model.expires_at) parts.push('expires ' + formatRelativeDate(model.expires_at));
    li.appendChild(create('small', '', parts.join(' · ') || 'No additional details'));
    return li;
  }

  function renderBackend(data) {
    var backend = data.backend || {};
    var scheduler = data.scheduler || {};
    var models = Array.isArray(backend.loaded_models) ? backend.loaded_models : [];
    var state = backend.recovery_required ? 'Recovery required' : titleCase(backend.state);
    var stateTag = byId('backend-state');
    stateTag.className = backend.recovery_required || !backend.reachable ? 'tag tag-danger' : 'tag tag-good';
    setText('backend-state', state);
    setText('scheduler-model', scheduler.current_model || 'None loaded');
    setText('scheduler-group', scheduler.current_model_group ? 'Group: ' + scheduler.current_model_group : 'No active group');
    var totalVram = models.reduce(function (total, model) { return total + positiveNumber(model.size_vram); }, 0);
    var contexts = models.map(function (model) { return safeNumber(model.context_length, 0); }).filter(function (value) { return value > 0; });
    setText('backend-vram', totalVram ? formatBytes(totalVram) : '—');
    setText('backend-context', contexts.length ? formatInteger(Math.max.apply(Math, contexts)) : '—');
    setText('backend-lease', formatDuration(scheduler.model_lease_remaining));
    setText('backend-switches', formatInteger(scheduler.model_switches));
    setText('backend-draining', scheduler.upstream_draining ? 'Yes' : 'No');
    setText('backend-last-success', formatRelativeDate(backend.last_success_at));
    setHidden('recovery-warning', !backend.recovery_required);
    setText('recovery-reason', backend.recovery_reason || 'The previous operation could not be verified safe.');
    setHidden('inference-warning', !backend.last_inference_error || backend.recovery_required);
    setText('inference-warning', backend.last_inference_error);
    setText('loaded-model-count', formatInteger(models.length));
    setHidden('models-empty', models.length > 0);
    var list = byId('loaded-models');
    list.replaceChildren();
    models.forEach(function (model) { list.appendChild(modelItem(model)); });
  }

  function syncRecoveryControls() {
    var data = snapshot || {};
    var maintenance = data.maintenance || {};
    var recovery = data.recovery || {};
    var busy = recoveryActionPending || maintenanceActionPending || mediaRecoveryActionPending || ['restarting', 'verifying'].includes(recovery.state);
    var authorized = maintenance.control_available === true && Boolean(getMaintenanceToken());
    var paused = maintenance.state === 'paused' || maintenance.paused === true;
    var locked = ollamaRecoveryIsActive(data);
    byId('recovery-check').disabled = !authorized || busy || !recovery.enabled || !locked;
    byId('recovery-acknowledge').disabled = !authorized || busy || !paused || !locked || !byId('recovery-confirm').checked || Boolean(data.active_request);
    setText('recovery-control-state', !authorized
      ? 'Log in with your administrator password to use recovery controls.'
      : busy ? 'A recovery or maintenance action is in progress. Manual pause will be preserved.'
        : !recovery.enabled ? 'Automatic recovery is disabled. Configure the host helper and automatic recovery in Settings, or verify the host and acknowledge manually while paused.'
          : 'Check / recover now may restart only Ollama within the configured limits. Manual acknowledgment requires paused inference and explicit host verification. Neither action resumes a manual pause.');
  }

  function renderRecovery(data) {
    var recovery = data.recovery || {};
    var backend = data.backend || {};
    var state = recovery.state || (recovery.enabled ? 'idle' : 'disabled');
    var descriptions = {
      disabled: 'Automatic recovery is disabled. A host helper must be installed before it can be enabled in Settings.',
      idle: 'No automatic recovery is currently needed. One-at-a-time inference protection remains active.',
      waiting: 'New inference is blocked while recovery waits for a safe restart boundary. A manual pause is preserved; use Check / recover now to explicitly request recovery while paused.',
      restarting: 'Restarting only the Ollama service to establish that the previous operation has stopped. No GPU reset or host reboot is performed.',
      verifying: 'Checking fresh host telemetry and Ollama after restart. Inference remains blocked until verification succeeds.',
      cooldown: 'Restart cooldown is active. New inference remains blocked; the next check cannot bypass the restart limit.',
      needs_attention: 'Automatic recovery could not establish a safe state within its limits. Check the reported cause and host before acknowledging recovery.',
      recovered: 'Recovery was verified. Any manual pause remains in effect; recovery does not resume it.'
    };
    setText('recovery-state', titleCase(state));
    byId('recovery-state').className = recoveryIsActive(data) ? 'tag tag-warning' : 'tag tag-neutral';
    if (recovery.requires_attention || state === 'needs_attention') byId('recovery-state').className = 'tag tag-danger';
    setText('recovery-detail', !recoveryIsActive(data) && ['waiting', 'cooldown', 'needs_attention'].includes(state)
      ? 'No inference recovery lock is reported. Normal scheduling can continue; automatic recovery needs attention before it can handle a future incident.'
      : descriptions[state] || 'Recovery status is unknown. Do not infer that GPU work has stopped.');
    var steps = {
      manual_pause: 'Waiting for your manual pause. Check / recover now explicitly permits bounded recovery while remaining paused.',
      active_operation: 'Waiting for the current operation to release the exclusive inference gate.',
      service_stopping: 'The intermediary is stopping; no new recovery operation will start.',
      media_recovery_required: 'ComfyUI recovery is required. Saved outputs may still be available. Ollama recovery cannot clear a media safety lock.',
      restarting_ollama_only: 'Restarting Ollama only; no host reboot or GPU reset.',
      checking_restart_outcome: 'Checking whether the Ollama service restart finished; it is not yet verified.',
      checking_gpu_and_ollama: 'Verifying consecutive fresh GPU samples and an empty, reachable Ollama backend after restart.',
      restart_limit_reached: 'This incident reached its restart limit. Verify the host; repeated clicks do not bypass the limit.',
      restart_window_limit: 'The restart budget for this time window is exhausted.',
      restart_cooldown: 'Waiting for the minimum interval between service restarts.',
      other_gpu_work_or_unknown_processes: 'Other GPU work or unknown process ownership prevents a safe automatic restart.',
      restart_outcome_unknown: 'The service restart outcome is uncertain. Host verification is required.',
      waiting_for_restart_settle: 'Ollama is settling after restart. Rechecking the same operation without another restart; inference stays blocked.',
      restart_verification_timeout: 'The bounded restart verification window expired. Check the host, then use Check / recover now to reverify the same operation. It does not repeat that restart.',
      verifying_existing_service_restart: 'A service restart already occurred after this incident. Verifying it without restarting Ollama again.',
      manual_pause_preserved: 'Recovery succeeded. Your manual pause remains in effect.',
      inference_reenabled: 'Recovery succeeded. Normal scheduling and live priority apply.'
    };
    setHidden('recovery-step', !recovery.reason);
    setText('recovery-step', recovery.reason ? 'Current check: ' + (steps[recovery.reason] || titleCase(recovery.reason)) : '');
    if (recovery.host_failure === 'ollama_host_oom') setText('recovery-step', 'Host evidence: systemd reported that Ollama was killed by system out-of-memory. Check VM RAM and swap; this is not a confirmed GPU VRAM fault.');
    var reason = backend.recovery_reason || recovery.reason;
    setHidden('recovery-cause', !reason);
    setText('recovery-cause', reason);
    setText('recovery-code', backend.recovery_code ? titleCase(backend.recovery_code) : 'Unknown');
    setText('recovery-enabled', recovery.enabled ? 'Enabled' : 'Disabled');
    setText('recovery-host', recovery.host_available === true ? 'Reachable' : recovery.host_available === false ? 'Unavailable' : 'Unknown');
    setText('recovery-attempts', formatInteger(recovery.attempts_in_window) + ' / ' + formatInteger(recovery.max_restarts));
    setText('recovery-episode-attempts', formatInteger(recovery.episode_attempts) + ' / ' + formatInteger(recovery.max_restarts));
    setText('recovery-window-label', recovery.window_seconds == null ? 'Restarts in rolling window' : 'Restarts in rolling ' + formatDuration(recovery.window_seconds) + ' window');
    setText('recovery-cooldown', formatDuration(recovery.cooldown_remaining_seconds));
    setText('recovery-last-check', formatRelativeDate(recovery.last_check_at));
    setHidden('recovery-last-error', !recovery.last_error);
    setText('recovery-last-error', recovery.last_error ? 'Last recovery error: ' + titleCase(recovery.last_error) : '');
    syncRecoveryControls();
  }

  function hardwareValue(value, suffix, valid) {
    if (!valid || value == null || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0) return 'Unknown';
    return Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 }) + suffix;
  }

  function hardwareBytes(value, valid) {
    return !valid || value == null || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0 ? 'Unknown' : formatBytes(value);
  }

  function renderHostGpu(data) {
    var host = data.host_gpu || {};
    var fresh = host.enabled === true && host.available === true && host.stale === false;
    var gpus = Array.isArray(host.gpus) ? host.gpus : [];
    var memory = host.memory || {};
    var memoryFresh = host.enabled === true && host.stale === false && memory.available === true;
    var memoryReason = data.scheduler && data.scheduler.background && data.scheduler.background.reason;
    setText('host-memory-state', !memoryFresh ? 'System RAM is unknown or stale. Update/check the host helper; guarded catch-up and context rescue require fresh RAM telemetry.'
      : ['host_memory_low', 'host_memory_pressure'].includes(memoryReason) ? 'Catch-up is waiting for system RAM headroom. Jobs are retained; no service restart is triggered by this guard.'
        : 'System RAM telemetry is current. Headroom checks reduce risk but cannot predict a request’s peak memory use.');
    byId('host-memory-state').className = memoryFresh && !['host_memory_low', 'host_memory_pressure'].includes(memoryReason)
      ? 'form-help' : 'notice notice-warning';
    var memoryStats = byId('host-memory-stats'); memoryStats.replaceChildren();
    [['Total RAM', hardwareBytes(memory.total_bytes, memoryFresh)], ['Available RAM', hardwareBytes(memory.available_bytes, memoryFresh)],
      ['Swap used', hardwareBytes(memory.swap_used_bytes, memoryFresh)], ['Swap total', hardwareBytes(memory.swap_total_bytes, memoryFresh)],
      ['Memory stall (10s)', hardwareValue(memory.pressure_full_avg10, '%', memoryFresh)],
      ['System OOM kills since boot', hardwareValue(memory.oom_kill_count, '', memoryFresh)]].forEach(function (entry) {
        var pair = create('div'); pair.appendChild(create('dt', '', entry[0])); pair.appendChild(create('dd', '', entry[1])); memoryStats.appendChild(pair);
      });
    var setupErrors = {
      host_helper_socket_missing: 'The helper socket is not visible in this container. The helper may not be installed, or its socket directory is not mounted. Run the host installer on ubuntu-ai; the container cannot determine which host-side step is missing.',
      host_helper_permission_denied: 'The helper socket is present but access is denied. Check the container’s supplementary helper group and socket permissions. Do not make the socket world-writable.',
      host_helper_not_listening: 'The socket is visible but no helper is accepting connections. Check the host helper service and its directory mount.',
      host_backend_mismatch: 'The helper is reachable but manages a different Ollama origin. Its configured origin must match Settings → Backend; recovery remains blocked.',
    };
    setText('host-gpu-state', !host.enabled ? 'Disabled · not checked' : setupErrors[host.error] ? 'Setup required' : host.stale ? 'Stale · unknown' : fresh ? 'Available' : 'Unavailable');
    byId('host-gpu-state').className = fresh ? 'tag tag-good' : 'tag tag-warning';
    setText('host-gpu-detail', !host.enabled ? 'Host monitoring is disabled, so helper availability is not being checked. Run python3 integrations/host/install.py on the Ollama host for setup, then enable monitoring in Settings.'
      : setupErrors[host.error] || (!fresh ? 'Fresh host telemetry is unavailable. Hardware values are unknown, not zero; no safety decision should rely on this display.'
        : gpus.length ? 'Physical GPU usage includes driver allocations and other processes, not just Ollama models.' : 'The host helper returned no GPU devices. No hardware measurements are available.'));
    setText('host-gpu-sampled', host.sampled_at ? 'Last hardware sample: ' + formatRelativeDate(host.sampled_at) + (fresh ? '' : ' · not current') : 'No hardware sample available.');
    setHidden('host-gpu-error', !host.error);
    setText('host-gpu-error', host.error);
    var list = byId('host-gpu-list');
    list.replaceChildren();
    gpus.slice(0, 8).forEach(function (gpu) {
      var item = create('section', 'host-gpu-item');
      item.appendChild(create('h3', '', String(gpu.name || 'GPU ' + (gpu.id == null ? '?' : gpu.id)).slice(0, 180)));
      var stats = create('dl', 'detail-grid');
      [['Total VRAM', hardwareBytes(gpu.vram_total_bytes, fresh)], ['Used VRAM', hardwareBytes(gpu.vram_used_bytes, fresh)],
        ['Free VRAM', hardwareBytes(gpu.vram_free_bytes, fresh)], ['GPU utilization', hardwareValue(gpu.utilization_percent, '%', fresh)],
        ['Temperature', hardwareValue(gpu.temperature_c, ' °C', fresh)], ['Power', hardwareValue(gpu.power_w, ' W', fresh)]].forEach(function (entry) {
          var pair = create('div'); pair.appendChild(create('dt', '', entry[0])); pair.appendChild(create('dd', '', entry[1])); stats.appendChild(pair);
        });
      item.appendChild(stats);
      var known = fresh && gpu.processes_known === true;
      var processes = Array.isArray(gpu.processes) ? gpu.processes : [];
      item.appendChild(create('p', 'form-help', !known ? 'GPU processes: unknown.' : processes.length ? 'Reported GPU processes (up to 12 shown):' : 'No GPU processes reported in this sample.'));
      if (known && processes.length) {
        var processList = create('ul', 'gpu-process-list');
        processes.slice(0, 12).forEach(function (process) {
          processList.appendChild(create('li', '', 'PID ' + String(process.pid == null ? 'unknown' : process.pid).slice(0, 24) + ' · '
            + String(process.name || (process.is_ollama ? 'Ollama' : 'Unnamed process')).slice(0, 100) + ' · '
            + hardwareBytes(process.vram_bytes, fresh) + ' VRAM' + (process.is_ollama ? ' · Ollama' : process.is_comfyui ? ' · Verified ComfyUI service' : ' · Ownership unverified')));
        });
        item.appendChild(processList);
        if (processes.length > 12) item.appendChild(create('p', 'form-help', formatInteger(processes.length - 12) + ' additional processes are not shown.'));
      }
      list.appendChild(item);
    });
  }

  async function performRecoveryAction(action) {
    if (!['check', 'acknowledge'].includes(action) || recoveryActionPending || maintenanceActionPending) return;
    var maintenance = snapshot && snapshot.maintenance || {};
    var recovery = snapshot && snapshot.recovery || {};
    if (!getMaintenanceToken() || maintenance.control_available !== true || !ollamaRecoveryIsActive(snapshot) || mediaRecoveryActionPending) return;
    if (['restarting', 'verifying'].includes(recovery.state)) return;
    if (action === 'check' && !recovery.enabled) return;
    if (action === 'acknowledge' && (!(maintenance.state === 'paused' || maintenance.paused === true) || !byId('recovery-confirm').checked || snapshot.active_request)) return;
    if (action === 'check' && !window.confirm('Check recovery now? This may restart only the Ollama service, interrupting its clients, within the configured limits. It never resets the GPU, reboots the host, or resumes a manual pause.')) return;
    recoveryActionPending = true;
    syncMaintenanceControls();
    setText('recovery-action-status', action === 'check' ? 'Requesting a bounded recovery check…' : 'Submitting your host recovery verification…');
    var controller = new AbortController();
    var timeout = window.setTimeout(function () { controller.abort(); }, 15000);
    try {
      var response = await fetch('/_intermediary/v1/recovery/' + action, {
        method: 'POST', headers: maintenanceHeaders(), cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
        body: JSON.stringify(action === 'check' ? { confirm: true } : { confirm_gpu_recovered: true })
      });
      var payload = await response.json();
      if (response.status === 401 || response.status === 403) { setMaintenanceToken(''); throw new Error('The administrator password was rejected. Log in again.'); }
      if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : payload.error && payload.error.message || payload.message || 'HTTP ' + response.status);
      byId('recovery-confirm').checked = false;
      setText('recovery-action-status', action === 'check' ? 'Recovery check accepted. Watch the checks and cooldown above; a manual pause remains in effect.' : 'Recovery acknowledgment accepted. A manual pause remains in effect; resume separately when ready.');
      await refreshSnapshot();
    } catch (error) {
      setText('recovery-action-status', controller.signal.aborted ? 'The recovery request timed out. Check the status before retrying; it may already be in progress.' : 'Recovery action not completed: ' + error.message);
    } finally {
      window.clearTimeout(timeout);
      recoveryActionPending = false;
      syncMaintenanceControls();
    }
  }

  function eventSeverity(event) {
    var type = String(event.type || '').toLowerCase();
    if (type === 'request_deferred') return 'event-warning';
    var status = String(event.status || '').toLowerCase();
    if (event.outcome === 'failed' || Number(event.status) >= 400 || status === 'error' || status === 'failed' || type.includes('failed') || type.includes('recovery') || type.includes('circuit_open')) return 'event-danger';
    if (status === 'completed' || status === 'success' || type.includes('completed') || type.includes('healthy') || type.includes('resum')) return 'event-good';
    if (type.includes('drop') || type.includes('cancel') || type.includes('disconnect') || type.includes('unload') || type.includes('paus')) return 'event-warning';
    return '';
  }
  function eventTitle(event) {
    var title = titleCase(event.type || event.status || 'Activity');
    if (event.client) title += ' · ' + titleCase(event.client);
    return title;
  }
  function eventDetail(event) {
    var values = [];
    var response = event.response || {};
    if (event.model) values.push(event.model);
    if (event.status && String(event.status).toLowerCase() !== String(event.type).toLowerCase()) values.push(titleCase(event.status));
    if (event.duration_seconds != null) values.push(formatDuration(event.duration_seconds));
    if (response.prompt_tokens != null) values.push(formatInteger(response.prompt_tokens) + ' input tok');
    if (response.output_tokens != null) values.push(formatInteger(response.output_tokens) + ' output tok');
    if (response.output_tokens_per_second != null) values.push(safeNumber(response.output_tokens_per_second, 0).toFixed(1) + ' tok/s');
    if (event.reason) values.push(titleCase(event.reason));
    return values.join(' · ') || 'Intermediary event';
  }
  function eventItem(event) {
    var li = create('li', 'timeline-item');
    li.appendChild(create('span', 'event-dot ' + eventSeverity(event)));
    var copy = create('div', 'event-copy');
    copy.appendChild(create('strong', '', eventTitle(event)));
    copy.appendChild(create('span', '', eventDetail(event)));
    li.appendChild(copy);
    li.appendChild(create('time', 'event-time', formatDate(event.timestamp)));
    return li;
  }
  function renderEvents(data) {
    var events = Array.isArray(data.recent_events) ? data.recent_events : [];
    setHidden('events-empty', events.length > 0);
    var list = byId('event-list');
    list.replaceChildren();
    events.slice().reverse().forEach(function (event) { list.appendChild(eventItem(event)); });
  }

  function renderAIBackends(data) {
    var backends = Array.isArray(data.backends) ? data.backends : [];
    var list = byId('backend-registry-list'); list.replaceChildren();
    backends.forEach(function (backend) {
      var row = create('li', 'queue-item');
      row.appendChild(create('strong', '', backend.id + ' · ' + titleCase(backend.type)));
      row.appendChild(create('p', 'muted', (backend.enabled ? 'Enabled in configuration' : 'Disabled')
        + ' · Shared resource: ' + (backend.resource_group || 'Not reported')));
      list.appendChild(row);
    });
    setHidden('backend-registry-empty', backends.length > 0);
    var media = data.media || {}, jobs = Array.isArray(media.jobs) ? media.jobs : [];
    var executing = jobs.filter(function (job) { return ['dispatching', 'running'].includes(job.state); });
    var active = data.active_request, badge = byId('gpu-owner-state');
    badge.className = 'tag tag-neutral';
    if (recoveryIsActive(data)) {
      badge.className = 'tag tag-danger'; setText('gpu-owner-state', 'Ownership blocked');
      setText('gpu-owner-detail', mediaCleanupPending(media)
        ? 'Media generation and output import completed. GPU release is still pending; another engine must wait for verified cleanup.'
        : 'Previous GPU work or its release has not been verified. The scheduler must not hand the GPU to another engine yet.');
    } else if (executing.length) {
      badge.className = 'tag tag-good'; setText('gpu-owner-state', 'Media owns GPU');
      setText('gpu-owner-detail', executing.map(function (job) { return job.source + ' → ' + job.backend + ' · ' + titleCase(job.state) + ' · ' + compactId(job.id); }).join('; '));
    } else if (active) {
      badge.className = 'tag tag-good'; setText('gpu-owner-state', 'Work in progress');
      setText('gpu-owner-detail', (active.client || active.source || 'Source not reported') + ' → '
        + (active.backend || (backends.filter(function (backend) { return backend.type === 'ollama'; })[0] || {}).id || 'Backend not reported')
        + ' · ' + titleCase(active.type || 'inference'));
    } else {
      setText('gpu-owner-state', 'No active job reported');
      setText('gpu-owner-detail', 'No active workload is reported. This is not proof that GPU memory is free; model unloading, maintenance and safety checks still apply.');
    }
  }

  function renderMedia(data) {
    var media = data.media || {}, jobs = Array.isArray(media.jobs) ? media.jobs : [];
    var cleanupPending = mediaCleanupPending(media), release = media.release || {};
    var uncertainIds = new Set(jobs.filter(function (job) { return job.state === 'uncertain'; }).map(function (job) { return job.id; }));
    if (media.blocked) (Array.isArray(media.unresolved) ? media.unresolved : []).forEach(function (id) { uncertainIds.add(id); });
    var queued = jobs.filter(function (job) { return job.state === 'queued'; });
    var running = jobs.filter(function (job) { return ['dispatching', 'running'].includes(job.state) && !uncertainIds.has(job.id); });
    var badge = byId('media-state');
    badge.className = media.blocked ? 'tag tag-danger' : media.enabled ? 'tag tag-good' : 'tag tag-neutral';
    setText('media-state', cleanupPending ? 'GPU release pending' : media.blocked ? 'Recovery required' : media.enabled ? 'Enabled' : data.media ? 'Disabled' : 'Not reported');
    setText('media-detail', cleanupPending ? 'Media completed; GPU release pending. Generation succeeded and outputs were imported. Saved results remain available while shared GPU work stays blocked.'
      : media.blocked ? 'Media completion or GPU release is uncertain. No new shared GPU workload may start until recovery is verified.'
      : media.enabled ? 'Durable media jobs share the same source priorities and single GPU as Ollama.'
        : 'Media execution is disabled. Existing Ollama and Frigate behavior remains available unless a previous media operation still needs recovery.');
    setText('media-queued', formatInteger(queued.length)); setText('media-running', formatInteger(running.length));
    setText('media-uncertain', formatInteger(uncertainIds.size));
    var releaseDetail = media.blocked ? mediaReleaseDetail(release) : '';
    setHidden('media-error', !media.error && !releaseDetail);
    setText('media-error', [releaseDetail, media.error ? 'Media error: ' + titleCase(media.error) : ''].filter(Boolean).join(' · '));
    var list = byId('media-jobs'); list.replaceChildren();
    setHidden('media-jobs-empty', jobs.length > 0);
    jobs.slice(0, 20).forEach(function (job) {
      var uncertain = uncertainIds.has(job.id), completed = mediaOutputCompleted(job);
      var state = uncertain ? completed ? 'Media completed; GPU release pending' : 'Uncertain · recovery required' : titleCase(job.state);
      var row = create('li', 'queue-item');
      row.appendChild(create('strong', '', compactId(job.id) + ' · ' + state));
      row.appendChild(create('p', 'muted', 'Source: ' + (job.source || 'Unknown') + ' → Backend: ' + (job.backend || 'Unknown')));
      if (uncertain && release.reason && (!release.backend || release.backend === job.backend)) {
        row.appendChild(create('p', 'muted', 'Latest release check: ' + titleCase(release.reason)));
      }
      if (job.reason || job.error) row.appendChild(create('p', 'muted', (uncertain && release.reason ? 'Original incident: ' : '') + titleCase(job.reason || job.error)));
      var artifacts = Array.isArray(job.artifacts) ? job.artifacts : [];
      if (artifacts.length) {
        var available = artifacts.filter(function (artifact) { return artifact.status === 'available'; }).length;
        row.appendChild(create('p', 'form-help', formatInteger(available) + ' retained output(s) · Open results through the media gateway with your admin login. Expired files are not downloadable.'));
      }
      list.appendChild(row);
    });
    setHidden('media-jobs-limit', jobs.length <= 20);
    setText('media-jobs-limit', 'Showing the first 20 of ' + formatInteger(jobs.length) + ' retained media jobs. Use the media gateway for the full job list.');
    setHidden('media-recovery-panel', !media.blocked);
    setText('media-recovery-detail', cleanupPending
      ? release.automatic_retry_exhausted === true
        ? 'The output is saved, but automatic cleanup retries are exhausted. Inspect the latest release check and host before manual recovery. '
          + 'For manual acknowledgment, pause inference, stop the old ComfyUI service and verify its previous workers have stopped. Never rerun the saved generation to clear this lock.'
        : 'The output is saved; generation does not need to run again. Cleanup verification may retry automatically within its bounds. '
          + 'Do not restart ComfyUI just because release is pending. If retries are exhausted, inspect the latest release check and verify the host before manual recovery. New GPU work remains blocked.'
      : 'Pause inference, stop the old ComfyUI service and verify all of its previous workers have stopped. '
        + (media.recovery || 'An idle GPU reading or closed browser alone is not proof.'));
    syncMediaRecoveryControls();
  }

  function syncMediaRecoveryControls() {
    var data = snapshot || {}, media = data.media || {}, maintenance = data.maintenance || {};
    var authorized = maintenance.control_available === true && Boolean(getMaintenanceToken());
    var paused = maintenance.state === 'paused' || maintenance.paused === true;
    var busy = maintenanceActionPending || recoveryActionPending || mediaRecoveryActionPending || Boolean(data.active_request);
    byId('media-recovery-acknowledge').disabled = !media.blocked || !media.enabled || !authorized || !paused || busy || !byId('media-recovery-confirm').checked;
    setText('media-recovery-control-state', !media.enabled ? 'Media must be enabled to verify its backend release. Re-enable it in Settings without hiding or deleting its saved state.'
      : !authorized ? 'Log in with your administrator password to acknowledge recovery.'
        : !paused ? 'Pause inference first and wait for any active GPU workload to finish.'
          : busy ? 'Another workload or control action is active. Wait before acknowledging.'
            : mediaCleanupPending(media) && media.release && media.release.automatic_retry_exhausted !== true && media.release.next_retry_at
              ? 'Bounded automatic cleanup checks are pending. Manual acknowledgment is separate and still requires verified stopped workers. It never resumes a manual pause.'
              : 'Verify the old service and workers on the host, then check the confirmation. Acknowledgment never resumes a manual pause.');
  }

  async function performMediaRecoveryAction() {
    syncMediaRecoveryControls();
    if (byId('media-recovery-acknowledge').disabled) return;
    mediaRecoveryActionPending = true; syncMaintenanceControls();
    setText('media-recovery-action-status', 'Checking your media recovery acknowledgment and safe GPU release…');
    var controller = new AbortController();
    var timeout = window.setTimeout(function () { controller.abort(); }, 30000);
    try {
      var response = await fetch('/_intermediary/v1/media/acknowledge', {
        method: 'POST', headers: maintenanceHeaders(), cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
        body: JSON.stringify({ confirm_service_stopped: true })
      });
      var payload = await response.json();
      if (response.status === 401 || response.status === 403) { setMaintenanceToken(''); throw new Error('The administrator password was rejected. Log in again.'); }
      if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : 'Media acknowledgment failed with HTTP ' + response.status);
      byId('media-recovery-confirm').checked = false;
      setText('media-recovery-action-status', 'Media acknowledgment accepted. Inference remains paused; inspect results and resume separately when ready.');
      await refreshSnapshot();
    } catch (error) {
      setText('media-recovery-action-status', controller.signal.aborted ? 'The verification response timed out. Check the status before retrying; acknowledgment may already have completed.' : 'Media recovery not acknowledged: ' + error.message);
    } finally {
      window.clearTimeout(timeout); mediaRecoveryActionPending = false; syncMaintenanceControls();
    }
  }

  function render(data) {
    renderWorkPolicy(data);
    snapshot = data;
    renderAIBackends(data);
    renderMedia(data);
    renderHealth(data);
    renderMaintenance(data);
    renderActive(data);
    renderQueue(data);
    renderBackend(data);
    renderRecovery(data);
    renderHostGpu(data);
    renderEvents(data);
    renderCatchup(data.frigate || {});
    if (data.build) setText('schema-version', 'Version ' + data.build.version + ' · ' + data.build.revision + ' · Schema ' + data.schema_version);
  }

  function renderCatchup(data) {
    catchupData = data;
    setText('catchup-state', titleCase(data.state || 'disabled'));
    var counts = data.counts || {};
    setText('catchup-pending', formatInteger((counts.pending || 0) + (counts.waiting_live || 0)));
    setText('catchup-retrying', formatInteger(counts.retrying || 0));
    setText('catchup-completed', formatInteger((data.totals || {}).completed || 0));
    var support = data.capabilities || {};
    setText('catchup-capabilities', 'Objects: ' + (support.object ? 'supported' : 'not verified') + ' · Reviews: ' + (support.review ? 'supported' : 'not verified'));
    var rescue = data.context_rescue || {};
    setText('catchup-context-rescue', rescue.enabled
      ? 'Error-only context rescue · ' + rescue.model + ' · Tested cap: ' + formatInteger(rescue.max_context)
        + ' tokens · One larger attempt per retained job.' + (data.bridge_mode !== 'correlated' ? ' Waiting for the Frigate bridge.' : '')
      : 'Error-only context rescue is disabled. Normal request context is unchanged.');
    setText('catchup-bridge', data.bridge_mode === 'correlated'
      ? 'Frigate bridge connected · One native generation at a time · Awaiting save: ' + formatInteger(data.verifying_count || 0) + ' / ' + formatInteger(data.max_verifying || 4) + ' · GPU inference remains one at a time.'
      : 'Compatibility mode · The version-pinned Frigate bridge is required for faster, correlated catch-up. Without it, one unconfirmed handoff is the safe limit.');
    setText('catchup-detail', data.enabled
      ? (data.blocked_reason ? titleCase(data.blocked_reason) : data.scan && data.scan.blocked_reason ? titleCase(data.scan.blocked_reason) : 'Background recovery runs only when live work and its idle hold are finished.')
      : 'Enable recovery and configure the Frigate connection in Settings.');
    setText('catchup-blocker', catchupBlocker(data));
    renderCatchupConfirmation();
    var views = data.views || {};
    Object.keys(CATCHUP_VIEWS).forEach(function (view) {
      setText('catchup-count-' + view, formatInteger(views[view] || 0));
    });
    byId('catchup-view-attention').classList.remove('has-attention');
    byId('catchup-view-retrying').classList.remove('has-retries');
    if (views.attention) byId('catchup-view-attention').classList.add('has-attention');
    if (views.retrying) byId('catchup-view-retrying').classList.add('has-retries');
    setText('catchup-history-limit', 'Retains the latest ' + formatInteger(data.history_limit || 1000)
      + ' completed / skipped records combined. Completed lifetime: ' + formatInteger((data.totals || {}).completed || 0)
      + ' · Skipped lifetime: ' + formatInteger((data.totals || {}).skipped || 0) + '. Tab counts describe stored rows, not lifetime totals.');
    var cleanup = data.cleanup || {};
    setText('catchup-cleanup', 'Media checks run independently of the GPU. Last cleanup: '
      + (cleanup.last_checked_at ? new Date(cleanup.last_checked_at).toLocaleString() : 'not yet checked')
      + ' · Known missing-media IDs remembered: ' + formatInteger(data.suppression_count || 0)
      + (cleanup.last_error ? ' · Cleanup delayed: ' + titleCase(cleanup.last_error) + '. This does not prove media was deleted.' : ''));
    setHidden('catchup-error', !data.last_error);
    setText('catchup-error', typeof data.last_error === 'string' ? data.last_error : data.last_error && (data.last_error.message || data.last_error.code));
    var warnings = Array.isArray(data.warnings) ? data.warnings : [];
    setHidden('catchup-warning', !warnings.length);
    setText('catchup-warning', warnings.length ? 'Some cameras use early-only object triggers that cannot be reconstructed later: '
      + warnings.map(function (warning) { return warning.camera + ' (' + titleCase(warning.code) + ')'; }).join(', ') : '');
    renderCatchupPage();
    syncCatchupControls();
  }

  function catchupBlocker(data) {
    if (!data.enabled) return 'Catch-up is disabled.';
    var background = snapshot && snapshot.scheduler && snapshot.scheduler.background || {};
    var reason = background.reason;
    var reasons = {
      maintenance_paused: 'Generation is paused for GPU maintenance; saved-result and media checks can still run.',
      recovery_required: 'Waiting for GPU recovery. No new catch-up generation can start.',
      backend_unavailable: 'Waiting for the Ollama backend to become available.',
      live_requests_pending: 'Waiting for incoming live requests to be admitted.',
      backend_operation: 'Waiting for the current backend operation to finish.',
      host_memory_unavailable: 'Waiting for fresh host RAM telemetry. Update/check the host helper; unknown memory is not free memory.',
      host_memory_low: 'Waiting for available system RAM to recover. Saved jobs are retained; GPU VRAM is a separate resource.',
      host_memory_pressure: 'Waiting for host memory pressure to ease. Saved jobs are retained.',
      service_stopping: 'The intermediary is stopping or preparing a safe restart.',
      shutting_down: 'The intermediary is shutting down.'
    };
    if (reasons[reason]) return reasons[reason];
    if (data.requires_recovery) return 'A previous inference outcome is uncertain. Verify GPU recovery before allowing another catch-up generation.';
    if (data.active_job) {
      if (data.active_job.phase && data.active_job.phase !== 'legacy_confirmation') return 'Frigate has one active native generation attempt: ' + catchupPhase(data.active_job) + '. Saved-result checks run separately; no second native attempt starts until this one finishes safely.';
      return 'Waiting for Frigate to save the outstanding description. This uncorrelated handoff retains the conservative one-at-a-time guard.';
    }
    if (reason === 'active_request') {
      var active = snapshot && snapshot.active_request;
      return 'Waiting for ' + titleCase(active && active.client || 'the active request') + ' to finish. Running inference is not preempted.';
    }
    if (reason === 'live_requests_queued') {
      var queues = snapshot && snapshot.queue && snapshot.queue.by_client || {};
      return 'Waiting behind ' + (queues.odysseus ? 'Odysseus' : queues.frigate ? 'live Frigate requests' : 'live requests') + '.';
    }
    if (reason === 'model_lease') return 'Waiting for the short model idle hold' + (background.wait_seconds == null ? '' : ' (' + formatDuration(background.wait_seconds) + ')') + '. This is separate from model keep-alive.';
    if (data.bridge_mode === 'correlated' && data.verifying_count >= (data.max_verifying || 4)) return 'Saved-result verification limit reached. Checking Frigate for saved descriptions before starting another native generation.';
    if (data.bridge_mode === 'correlated' && data.verifying_count) return 'Finished generations are awaiting saved descriptions. They do not hold the GPU; another eligible job can start when live priority and safety checks permit.';
    if (data.scan && data.scan.blocked_reason) return 'Catch-up: ' + titleCase(data.scan.blocked_reason) + '.';
    if (!data.total_queued) return 'No unfinished descriptions are queued.';
    return 'The next eligible job may start when its live grace / retry delay and all safety checks permit.';
  }

  function renderCatchupConfirmation() {
    var active = catchupData.active_job;
    var verifying = catchupData.verifying_count || 0;
    setText('catchup-active', active ? titleCase(active.kind) + ' · ' + (active.camera || '') + ' · ' + catchupPhase(active) : 'No active background generation.');
    setHidden('catchup-confirmation', !active && !verifying);
    if (active && active.phase && active.phase !== 'legacy_confirmation') {
      setText('catchup-confirmation', active.phase === 'uncertain'
        ? 'The native attempt outcome is uncertain. Catch-up is holding its generation slot until safe recovery; an idle dashboard alone is not proof that upstream work stopped.'
        : 'Waiting for the Frigate bridge to report the full native attempt outcome. A single Ollama HTTP response is not that completion report. Confirmed failures enter retry backoff promptly; successful attempts move to separate saved-result verification.');
      return;
    }
    if (active) {
      var remaining = Math.max(0, (Number(active.next_attempt_at) - Date.now()) / 1000);
      setText('catchup-confirmation', (remaining > 0
        ? 'Waiting for Frigate to save the description. Confirmation window: ' + formatDuration(remaining) + ' remaining. '
        : 'Confirmation window elapsed. Checking the saved result before arranging an idle-only retry. ')
        + 'This is not proof that the model is still generating. This uncorrelated attempt uses compatibility mode; no second catch-up handoff starts meanwhile.');
    } else if (verifying) {
      setText('catchup-confirmation', formatInteger(verifying) + ' finished generation(s) awaiting Frigate\'s saved description. Verification runs independently of GPU work. '
        + (verifying >= (catchupData.max_verifying || 4) ? 'The verification limit is full; new handoffs wait for space.' : 'There is room for the next eligible generation; live work still has priority.'));
    }
  }

  function catchupPhase(job) {
    var labels = {
      handed_off: 'Preparing in Frigate', queued: 'Queued for GPU', running: 'Generating',
      verifying_saved: 'Awaiting saved description', uncertain: 'Outcome uncertain', legacy_confirmation: 'Waiting result (compatibility mode)'
    };
    return labels[job.phase] || titleCase(job.state || job.status);
  }

  function renderCatchupJobs(id, emptyId, jobs) {
      var list = byId(id);
      var scroll = list.scrollTop;
      list.replaceChildren();
      setHidden(emptyId, jobs.length > 0);
      jobs.forEach(function (job) {
        var item = create('li', 'queue-item' + (job.needs_attention ? ' catchup-attention' : job.state === 'retrying' ? ' catchup-retrying' : ''));
        item.appendChild(create('strong', '', titleCase(job.kind) + ' · ' + (job.camera || '') + ' · ' + catchupPhase(job)));
        var eventTime = Number(job.event_time);
        var details = compactId(job.id || job.event_id) + (Number.isFinite(eventTime) && eventTime > 0 ? ' · Recorded ' + new Date(eventTime * 1000).toLocaleString() : '');
        if (job.reason) details += ' · ' + titleCase(job.reason);
        if (job.needs_attention) details += ' · Needs attention (automatic retries continue)';
        item.appendChild(create('p', 'muted', details));
        var attempts = [];
        if (job.deferred) attempts.push('Deferred before inference; no additional failure or enlarged attempt consumed');
        if (job.attempts != null) attempts.push('Attempts: ' + formatInteger(job.attempts));
        if (job.failures) attempts.push('Unsuccessful / unconfirmed: ' + formatInteger(job.failures));
        if (job.last_attempt_at) attempts.push('Last attempt: ' + new Date(job.last_attempt_at).toLocaleString());
        if (job.first_failed_at) attempts.push('First unsuccessful attempt: ' + new Date(job.first_failed_at).toLocaleString());
        if (job.state === 'retrying' && job.next_attempt_at) attempts.push('Earliest retry: ' + new Date(job.next_attempt_at).toLocaleString() + ' (when idle, not a promised start)');
        if (job.phase === 'verifying_saved' && job.next_attempt_at) attempts.push('Saved-result check deadline: ' + new Date(job.next_attempt_at).toLocaleString() + ' (not active GPU work)');
        if (attempts.length) item.appendChild(create('p', 'muted', attempts.join(' · ')));
        if (job.context_rescue) {
          var rescue = job.context_rescue;
          var reasons = {
            context_overflow: 'Overflow confirmed; the next eligible retry will check rescue safety',
            rescue_above_cap: 'Required context exceeds the tested cap',
            rescue_model_limit: 'Required context exceeds the model limit',
            rescue_model_unknown: 'Cannot verify the model context limit',
            rescue_telemetry_unavailable: 'Fresh, backend-matched GPU readings are unavailable',
            rescue_gpu_busy: 'GPU activity or another application prevents rescue',
            rescue_vram_headroom: 'Less than 2 GiB of free VRAM; rescue is blocked',
            rescue_host_memory_low: 'Not enough available system RAM for a larger-context attempt',
            rescue_host_memory_unavailable: 'Fresh host RAM readings are required; update/check the host helper',
            rescue_host_memory_pressure: 'System RAM is under sustained pressure; rescue is deferred',
            rescue_used: 'The one larger attempt has been reserved/used; no further enlargement',
            rescue_request_succeeded: 'Larger Ollama request succeeded; Frigate still determines the saved result',
            rescue_request_failed: 'Larger request failed; no further enlargement',
            rescue_outcome_uncertain: 'Larger request outcome is uncertain; recovery must be verified',
            rescue_body_limit: 'Changed request would exceed the configured memory budget'
          };
          item.appendChild(create('p', 'muted', 'Context rescue: ' + (reasons[rescue.reason] || titleCase(rescue.reason))
            + ' · Input: ' + formatInteger(rescue.prompt_tokens) + ' · Rejected context: ' + formatInteger(rescue.reported_context)
            + (rescue.target_context ? ' · Rescue context: ' + formatInteger(rescue.target_context) : '')
            + ' · Enlarged attempts: ' + (rescue.attempted ? '1 / 1' : '0 / 1')));
        }
        var action = job.state === 'retrying' ? 'retry' : (job.state || job.status) === 'skipped' ? 'recheck' : null;
        if (action) {
          var button = create('button', 'quiet-button catchup-job-action', action === 'retry' ? 'Retry when idle' : 'Recheck availability');
          button.type = 'button';
          button.disabled = !catchupAdminToken || catchupActionPending;
          button.title = catchupAdminToken ? 'Never bypasses scheduling or media checks' : 'Unlock with the Settings admin token below';
          button.addEventListener('click', function () { performCatchupAction(action, job); });
          item.appendChild(button);
        }
        list.appendChild(item);
      });
      list.scrollTop = scroll;
  }

  function renderCatchupPage() {
    var page = catchupPage || { items: [], offset: 0, total: 0 };
    Object.keys(CATCHUP_VIEWS).forEach(function (view) {
      byId('catchup-view-' + view).setAttribute('aria-pressed', String(view === catchupView));
    });
    setText('catchup-pending-heading', CATCHUP_VIEWS[catchupView][0]);
    setText('catchup-view-help', CATCHUP_VIEWS[catchupView][1]);
    if (catchupData && catchupData.catchup_order) setText('catchup-view-help', CATCHUP_VIEWS[catchupView][1]
      + ' Dispatch order: ' + (catchupData.catchup_order === 'oldest_first' ? 'oldest' : 'newest') + ' eligible event first. List display is newest first.');
    var renderKey = JSON.stringify([catchupView, page.items, Boolean(catchupAdminToken), catchupActionPending]);
    if (renderKey !== catchupRenderedPage) {
      renderCatchupJobs('catchup-pending-jobs', 'catchup-pending-empty', page.items);
      catchupRenderedPage = renderKey;
    }
    setText('catchup-page-status', page.total ? 'Showing ' + (page.offset + 1) + '–'
      + (page.offset + page.items.length) + ' of ' + formatInteger(page.total) + ' saved jobs in this view' : 'No jobs in this view.');
    byId('catchup-previous').disabled = Boolean(catchupPagePromise) || catchupOffset === 0;
    byId('catchup-next').disabled = Boolean(catchupPagePromise) || catchupOffset + CATCHUP_PAGE_SIZE >= page.total;
  }

  async function refreshCatchupPage() {
    if (catchupPagePromise) return catchupPagePromise;
    var offset = catchupOffset;
    var view = catchupView;
    var controller = new AbortController();
    var timeout = window.setTimeout(function () { controller.abort(); }, 10000);
    catchupPagePromise = (async function () {
      try {
        var response = await fetch('/_intermediary/v1/frigate/jobs?view=' + view + '&offset=' + offset + '&limit=' + CATCHUP_PAGE_SIZE,
          { headers: requestHeaders(), cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        var page = await response.json();
        if (!Array.isArray(page.items) || !Number.isSafeInteger(page.offset) || !Number.isSafeInteger(page.total)) throw new Error('Invalid page');
        if (offset !== catchupOffset || view !== catchupView) return;
        catchupOffset = page.offset;
        catchupPage = page;
        renderCatchupPage();
      } catch (error) {
        if (view === catchupView) setText('catchup-page-status', 'Could not refresh this view. Retrying automatically; saved jobs are unchanged.');
      } finally {
        window.clearTimeout(timeout);
        catchupPagePromise = null;
        byId('catchup-previous').disabled = catchupOffset === 0;
        byId('catchup-next').disabled = !catchupPage || catchupOffset + CATCHUP_PAGE_SIZE >= catchupPage.total;
      }
    })();
    byId('catchup-previous').disabled = true;
    byId('catchup-next').disabled = true;
    return catchupPagePromise;
  }

  async function changeCatchupPage(direction) {
    if (catchupPagePromise || !catchupPage) return;
    var next = Math.max(0, catchupOffset + direction * CATCHUP_PAGE_SIZE);
    if (next >= catchupPage.total && next !== 0) return;
    catchupOffset = next;
    await refreshCatchupPage();
    byId('catchup-pending-jobs').scrollTop = 0;
  }

  async function changeCatchupView(view) {
    if (!CATCHUP_VIEWS[view] || view === catchupView) return;
    catchupView = view;
    catchupOffset = 0;
    catchupPage = null;
    renderCatchupPage();
    byId('catchup-pending-jobs').scrollTop = 0;
    if (catchupPagePromise) await catchupPagePromise;
    await refreshCatchupPage();
  }

  function syncCatchupControls() {
    catchupAdminToken = getToken();
    byId('catchup-refresh').disabled = !catchupAdminToken || catchupActionPending;
    setText('catchup-control-state', catchupAdminToken
      ? 'Admin login unlocks these controls. The server checks every action. Retrying respects live priority, pause mode, and the active handoff.'
      : 'Controls are locked. Log in with your administrator password. Retrying never bypasses live priority, pause mode, or the active handoff.');
  }

  function unlockCatchup(token) {
    setToken(String(token || '').trim());
    renderCatchupPage();
  }

  async function performCatchupAction(action, job) {
    if (!catchupAdminToken || catchupActionPending || !['retry', 'recheck', 'refresh'].includes(action)) return;
    if (action === 'retry' && job.state !== 'retrying') return;
    if (action === 'recheck' && (job.state || job.status) !== 'skipped') return;
    if (action !== 'refresh' && !window.confirm(action === 'retry' ? 'Make this job eligible to retry when idle? Existing descriptions and media will be checked first. This does not bypass live priority or pause mode.' : 'Recheck this skipped item and queue it only if eligible again? No recording or description will be deleted.')) return;
    catchupActionPending = true;
    syncCatchupControls();
    renderCatchupPage();
    var controller = new AbortController();
    var timeout = window.setTimeout(function () { controller.abort(); }, 10000);
    try {
      var response = await fetch('/_intermediary/v1/frigate/' + action, {
        method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: 'Bearer ' + catchupAdminToken },
        body: JSON.stringify(action === 'refresh' ? { confirm: true } : { confirm: true, kind: job.kind, id: job.id }), signal: controller.signal
      });
      var payload = await response.json();
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) unlockCatchup('');
        throw new Error(typeof payload.error === 'string' ? payload.error : payload.error && payload.error.message || payload.message || 'HTTP ' + response.status);
      }
      setText('catchup-action-status', action === 'refresh' ? 'Connection recheck accepted. Capability status is refreshed without retrying jobs or bypassing the active handoff.' : 'Request accepted. Media, saved descriptions, and scheduling rules still apply.');
      await refreshSnapshot();
    } catch (error) {
      setText('catchup-action-status', controller.signal.aborted ? 'The action timed out. Refresh the job status before trying again; it may have been accepted.' : 'Action not completed: ' + error.message);
    } finally {
      window.clearTimeout(timeout);
      catchupActionPending = false;
      syncCatchupControls();
      renderCatchupPage();
    }
  }

  function updateLiveClocks() {
    renderCatchupConfirmation();
    if (activeClock) {
      var elapsed = activeClock.seconds + ((performance.now() - activeClock.at) / 1000);
      setText('active-running', formatDuration(elapsed));
    }
    if (maintenanceClock) {
      var remaining = maintenanceClock.resumeAt == null
        ? maintenanceClock.seconds - ((performance.now() - maintenanceClock.at) / 1000)
        : (maintenanceClock.resumeAt - Date.now()) / 1000;
      setText('maintenance-countdown', remaining > 0 ? formatDuration(remaining) : 'Resuming…');
    }
    if (snapshot) {
      var generatedAt = new Date(snapshot.generated_at).getTime();
      if (Number.isFinite(generatedAt)) {
        setText('snapshot-age', formatDuration(Math.max(0, (Date.now() - generatedAt) / 1000)) + ' ago');
      }
    }
  }

  async function refreshSnapshot() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async function () {
      var controller = new AbortController();
      var timeout = window.setTimeout(function () { controller.abort(); }, 10000);
      try {
        var response = await fetch(STATUS_URL, {
          method: 'GET',
          headers: requestHeaders(),
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal
        });
        if (response.status === 401) {
          showAuth(getToken() ? 'That password was rejected. Enter your administrator password.' : 'Log in to open this dashboard.');
          return false;
        }
        if (!response.ok) throw new Error('Status request failed with HTTP ' + response.status);
        var data = await response.json();
        hideAuth();
        showError('');
        render(data);
        await refreshCatchupPage();
        setConnection('live', 'Polling every 2s');
        return true;
      } catch (error) {
        showError(controller.signal.aborted ? 'Status request timed out. Retrying automatically.'
          : 'Unable to read intermediary status: ' + (error.message || String(error)));
        if (snapshot && snapshot.host_gpu && snapshot.host_gpu.enabled) {
          renderHostGpu({ host_gpu: Object.assign({}, snapshot.host_gpu, { available: false, stale: true,
            error: 'The dashboard cannot refresh host telemetry. Displayed hardware state is unknown until reconnection.' }) });
        }
        setConnection('offline', 'Disconnected');
        return false;
      } finally {
        window.clearTimeout(timeout);
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  }

  async function performMaintenanceAction(action) {
    if (maintenanceActionPending || recoveryActionPending || mediaRecoveryActionPending || (action === 'resume' && recoveryIsActive(snapshot))) return;
    var token = getMaintenanceToken();
    if (!token) {
      showAuth('Log in with your administrator password to use maintenance controls.');
      return;
    }
    var maintenance = snapshot && snapshot.maintenance ? snapshot.maintenance : {};
    if (maintenance.control_available !== true) {
      setMaintenanceActionStatus('Maintenance controls are not configured on this intermediary.', 'error');
      return;
    }

    maintenanceActionPending = true;
    syncMaintenanceControls();
    setMaintenanceActionStatus(action === 'pause' ? 'Requesting pause mode…' : 'Requesting inference resume…', '');
    try {
      var url = action === 'pause' ? MAINTENANCE_PAUSE_URL : MAINTENANCE_RESUME_URL;
      var options = {
        method: 'POST',
        headers: maintenanceHeaders(),
        cache: 'no-store',
        credentials: 'same-origin'
      };
      if (action === 'pause') {
        var payload = { reason: 'Dashboard pause' };
        var duration = byId('pause-duration').value;
        if (duration) payload.duration = duration;
        options.body = JSON.stringify(payload);
      }
      var response = await fetch(url, options);
      var responseText = await response.text();
      var responseBody = {};
      if (responseText) {
        try { responseBody = JSON.parse(responseText); }
        catch (_) { responseBody = {}; }
      }
      if (response.status === 401 || response.status === 403) {
        setMaintenanceToken('');
        throw new Error('The maintenance control token was rejected. Enter it again.');
      }
      if (!response.ok) {
        throw new Error(responseBody.error || ('Maintenance request failed with HTTP ' + response.status));
      }
      setMaintenanceActionStatus(action === 'pause'
        ? 'Pause mode requested. The dashboard will update as the active request drains.'
        : 'Inference resume requested.', 'success');
      await refreshSnapshot();
    } catch (error) {
      setMaintenanceActionStatus(error.message || String(error), 'error');
    } finally {
      maintenanceActionPending = false;
      syncMaintenanceControls();
    }
  }

  function startPolling() {
    if (pollTimer || authBlocked) return;
    pollTimer = window.setInterval(refreshSnapshot, POLL_INTERVAL_MS);
  }
  function stopPolling() {
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = null;
  }
  function stopConnections() {
    stopPolling();
  }

  async function reconnect() {
    stopConnections();
    authBlocked = false;
    setConnection('', 'Connecting');
    var ready = await refreshSnapshot();
    if (ready) startPolling();
    else if (!authBlocked) startPolling();
  }

  byId('token-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var value = byId('token-input').value.trim();
    if (!value) return;
    setToken(value);
    byId('token-input').value = '';
    reconnect();
  });

  byId('forget-token').addEventListener('click', function () {
    setToken('');
    reconnect();
  });

  byId('pause-button').addEventListener('click', function () { performMaintenanceAction('pause'); });
  byId('scope-pause').addEventListener('click', function () { performScopeAction('pause', {
    sources: byId('scope-sources').value.split(/[\s,]+/).filter(Boolean), traffic: byId('scope-traffic').value,
    duration: byId('scope-duration').value.trim() || null
  }); });
  byId('recovery-check').addEventListener('click', function () { performRecoveryAction('check'); });
  byId('recovery-acknowledge').addEventListener('click', function () { performRecoveryAction('acknowledge'); });
  byId('recovery-confirm').addEventListener('change', syncRecoveryControls);
  byId('media-recovery-acknowledge').addEventListener('click', performMediaRecoveryAction);
  byId('media-recovery-confirm').addEventListener('change', syncMediaRecoveryControls);
  byId('catchup-refresh').addEventListener('click', function () { performCatchupAction('refresh'); });
  byId('catchup-previous').addEventListener('click', function () { changeCatchupPage(-1); });
  byId('catchup-next').addEventListener('click', function () { changeCatchupPage(1); });
  Object.keys(CATCHUP_VIEWS).forEach(function (view) {
    byId('catchup-view-' + view).addEventListener('click', function () { changeCatchupView(view); });
  });
  byId('resume-button').addEventListener('click', function () { performMaintenanceAction('resume'); });

  window.addEventListener('pagehide', stopConnections);
  window.addEventListener('pageshow', function (event) { if (event.persisted) reconnect(); });
  window.setInterval(updateLiveClocks, 1000);
  setToken(getToken());
  reconnect();
})();
