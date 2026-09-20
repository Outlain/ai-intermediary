import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const formatters = new Map();
const minute = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

export function localTime(now, timezone) {
  if (!formatters.has(timezone)) formatters.set(timezone, new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }));
  const parts = Object.fromEntries(formatters.get(timezone).formatToParts(now).map((part) => [part.type, part.value]));
  return { day: parts.weekday.toLowerCase(), minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

// Days refer to the start day of an overnight window. Local wall-clock rules
// apply to both occurrences of a repeated hour; nonexistent minutes are skipped.
export function scheduleActive(rule, now, timezone) {
  if (!rule.enabled) return false;
  return matchesLocal(rule, localTime(now, timezone));
}

function matchesLocal(rule, local) {
  const start = minute(rule.start), end = minute(rule.end);
  if (start < end) return rule.days.includes(local.day) && local.minute >= start && local.minute < end;
  const yesterday = DAYS[(DAYS.indexOf(local.day) + 6) % 7];
  return (rule.days.includes(local.day) && local.minute >= start)
    || (rule.days.includes(yesterday) && local.minute < end);
}

export function validateWorkPolicy(config) {
  const settings = config.work_policy;
  if (typeof settings?.timezone !== 'string' || !settings.timezone || settings.timezone.length > 100) throw new Error('work_policy.timezone must be a valid IANA timezone');
  try { localTime(Date.now(), settings.timezone); } catch { throw new Error('work_policy.timezone must be a valid IANA timezone'); }
  if (!settings.schedules || typeof settings.schedules !== 'object' || Array.isArray(settings.schedules)
    || Object.keys(settings.schedules).length > 32) throw new Error('work_policy.schedules must contain at most 32 named schedules');
  for (const [name, rule] of Object.entries(settings.schedules)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error('schedule names must start with a letter/number and use letters, numbers, underscores or dashes');
    validateScope(rule, config);
    if (typeof rule.enabled !== 'boolean' || !['pause', 'release_gpu'].includes(rule.mode)
      || !Array.isArray(rule.days) || !rule.days.length || rule.days.length > 7 || rule.days.some((day) => !DAYS.includes(day))
      || !/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.end)
      || rule.start === rule.end) throw new Error(`invalid schedule ${name}: use weekdays and distinct HH:MM boundaries`);
    if (rule.mode === 'release_gpu' && (rule.sources.length !== 1 || rule.sources[0] !== '*' || rule.traffic !== 'all')) {
      throw new Error(`schedule ${name}: GPU release must target all sources and all traffic`);
    }
  }
}

export function validateScope(rule, config) {
  if (!rule || !Array.isArray(rule.sources) || !rule.sources.length || rule.sources.length > 100
    || rule.sources.some((name) => typeof name !== 'string' || (name !== '*' && !Object.hasOwn(config.clients, name)))
    || !['all', 'live', 'catchup'].includes(rule.traffic)) throw new Error('pause scope requires configured sources (or *) and all/live/catchup traffic');
}

export class WorkPolicy {
  constructor(config, { clock = () => Date.now() } = {}) {
    this.config = config;
    this.clock = clock;
    this.file = `${config.maintenance.state_path}.scopes`;
    this.manual = [];
    this.error = null;
    this.cache = null;
    try {
      if (fs.statSync(this.file).size > 128 * 1024) throw new Error('scoped pause state too large');
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.schema_version !== 1 || !Array.isArray(saved.manual) || saved.manual.length > 100) throw new Error('invalid scoped pause state');
      const ids = new Set();
      for (const rule of saved.manual) {
        // Removed sources remain paused records, but cannot match another source.
        if (!rule || typeof rule.id !== 'string' || !rule.id || rule.id.length > 64 || ids.has(rule.id)
          || !Array.isArray(rule.sources) || !rule.sources.length || rule.sources.length > 100
          || rule.sources.some((name) => typeof name !== 'string' || !name || name.length > 64) || !['all', 'live', 'catchup'].includes(rule.traffic)
          || (rule.until !== null && !Number.isFinite(rule.until))) throw new Error('invalid scoped pause record');
        ids.add(rule.id);
      }
      this.manual = saved.manual;
    } catch (error) { if (error.code !== 'ENOENT') this.error = 'Scoped pause state could not be read; admission is blocked.'; }
  }

  save(next) {
    if (this.error) throw new Error(this.error);
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(temporary, JSON.stringify({ schema_version: 1, manual: next }), { mode: 0o600, flag: 'wx' });
      const descriptor = fs.openSync(temporary, 'r');
      try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary, this.file);
      this.manual = next;
      this.cache = null;
    } catch (error) {
      this.error = 'Scoped pause state could not be persisted; admission is blocked.';
      throw error;
    } finally { try { fs.unlinkSync(temporary); } catch { /* renamed or absent */ } }
  }

  pause({ sources, traffic = 'all', until = null }) {
    validateScope({ sources, traffic }, this.config);
    if (until !== null && (!Number.isFinite(until) || until <= this.clock())) throw new Error('pause expiry must be in the future');
    const current = this.manual.filter((item) => item.until === null || item.until > this.clock());
    if (current.length >= 100) throw new Error('at most 100 manual scoped pauses are allowed');
    const rule = { id: randomUUID(), sources: [...new Set(sources)], traffic, until };
    this.save([...current, rule]);
    return rule;
  }

  resume(id) { this.save(this.manual.filter((rule) => rule.id !== id)); }

  active(now = this.clock()) {
    const second = Math.floor(now / 1000);
    if (this.cache?.second === second) return this.cache.rules;
    const rules = this.manual.filter((rule) => rule.until === null || rule.until > now)
      .map((rule) => ({ ...rule, reason: 'manual_source_pause', mode: 'pause' }));
    for (const [name, rule] of Object.entries(this.config.work_policy.schedules)) {
      if (scheduleActive(rule, now, this.config.work_policy.timezone)) rules.push({ ...rule, id: name, reason: 'scheduled_pause' });
    }
    this.cache = { second, rules };
    return rules;
  }

  block(client, traffic = 'live', now = this.clock()) {
    if (this.error) return { reason: 'pause_state_error', rules: [] };
    if (this.config.clients[client]?.enabled === false) return { reason: 'source_disabled', rules: [] };
    const rules = this.active(now).filter((rule) => (rule.sources.includes('*') || rule.sources.includes(client))
      && (rule.traffic === 'all' || rule.traffic === traffic));
    return rules.length ? { reason: rules[0].reason, rules: rules.map((rule) => rule.id) } : null;
  }

  releaseRequested(now = this.clock()) { return this.active(now).some((rule) => rule.mode === 'release_gpu'); }

  status(now = this.clock()) {
    const currentMinute = Math.floor(now / 60000);
    if (this.previewMinute !== currentMinute) {
      this.previewMinute = currentMinute;
      this.preview = Object.entries(this.config.work_policy.schedules).map(([id, rule]) => ({
        id, ...rule, active: scheduleActive(rule, now, this.config.work_policy.timezone), next_transition: null,
      }));
      // Format each future local minute once, shared by all rules. Cache this
      // bounded preview rather than repeating Intl work on every status poll.
      let pending = this.preview.filter((rule) => rule.enabled);
      for (let offset = 1; pending.length && offset <= 8 * 24 * 60; offset++) {
        const at = currentMinute * 60000 + offset * 60000;
        const local = localTime(at, this.config.work_policy.timezone);
        pending = pending.filter((rule) => {
          if (matchesLocal(rule, local) === rule.active) return true;
          rule.next_transition = new Date(at).toISOString();
          return false;
        });
      }
    }
    return { timezone: this.config.work_policy.timezone, error: this.error,
      manual: this.manual.filter((rule) => rule.until === null || rule.until > now), schedules: this.preview,
      sources: Object.keys(this.config.clients).map((id) => ({ id, priority: this.config.clients[id].priority,
        live: this.block(id, 'live', now), catchup: this.block(id, 'catchup', now) })) };
  }
}
