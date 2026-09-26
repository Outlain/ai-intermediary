# Sources, pause scopes and schedules

Ollama and optional ComfyUI backends share one GPU, with one workload executing
at a time. Sources set priority and route compatible work to a backend. Dedicated
ports and pause schedules are opt-in. No GPU reset or VM reboot is performed.

## Sources and priorities

Use **Settings → Sources & ports** with `ADMIN_TOKEN`. Each source has
an enabled flag, numeric priority, queue limit/lifetime, overflow policy,
follow-up hold and model keep-alive. Larger priorities run first. Equal-priority
live requests use arrival order across sources and models. Running inference is
never preempted. Strict priority deliberately allows lower-priority starvation;
Optional `balanced` mode is available, but its aging/batching settings do not
apply in strict mode.

A follow-up hold delays lower-priority work after a live response. Equal/higher
priority live work can run immediately. Catch-up waits for live holds. Paused
sources do not retain a hold over eligible sources. Keep-alive only retains model
memory. Existing exact-model overrides in `models` still take precedence over
source model policies; most installations should keep `models: {}`.

Identification order: dedicated listener → enabled `X-Ollama-Client` header →
IP/subnet → exact-model mapping → `scheduler.default_client`. Disabling a source
rejects its inference rather than reclassifying it. Cross-source IP overlaps and
duplicate listener ports are rejected. Empty IP lists disable IP identification.
Headers and ports are routing hints, **not authentication**; restrict them to
trusted clients. Shared Docker gateways cannot reliably identify individual apps.
Only enable forwarded-IP trust behind a proxy that strips untrusted values.

### Odysseus on port 11436

1. Assign `odysseus` dedicated container port `11436`, validate and apply. Settings
   use the existing safe-drain/restart workflow. The port must be unused.
2. Add the new mapping to the existing Compose service, preserving all other
   ports, mounts, credentials and settings:

   ```yaml
   services:
     ai-intermediary:
       ports:
         - "11435:11434" # existing main endpoint
         - "11436:11436" # dedicated Odysseus endpoint
   ```

3. Recreate only the intermediary:

   ```sh
   cd /opt/ai-intermediary
   docker compose config --quiet
   docker compose up -d --no-deps ai-intermediary
   curl --fail -sS http://127.0.0.1:11436/api/version
   ```

4. Point Odysseus to `http://ubuntu-ai:11436` (replace the host name as needed).
   No header is needed. Responses stream on the same client connection: no
   redirect, extra proxy hop or response-port setting.

Settings generates additional port lines but cannot edit Docker or verify host
publication. No Docker socket is mounted. Explicit `server.dedicated_listeners`
must not duplicate source ports. Runtime port collisions
with unrelated host processes mark that source listener unavailable; the main
Settings endpoint stays available so you can correct the port and apply again.

After verifying Odysseus routing, optionally add `misc` and select it as the
default under Scheduler. Until then keep your existing default. All inference
clients must use the intermediary: direct Ollama requests bypass its safety gate.

## Manual pauses and replay

**Pause inference** reserves the whole GPU: drain active work,
block new work, then verify backend release. **Source pauses & schedules** instead
pauses selected work without promising GPU release. Select comma-separated
source names or `*`, and `all`, `live`, or `catchup` traffic. Only Frigate has a
durable catch-up adapter. Metadata endpoints, discovery, cleanup and saved-result
verification continue. Recovery is an independent lock that pauses cannot clear.

Default: new and queued paused HTTP requests receive 503, with no replay. The
per-source **Hold connected live requests during pauses** option retains only
in-memory, still-connected requests, bounded by queue TTL, queue limit, overflow
rules and the shared memory limit. Expired/disconnected requests are cancelled;
process restarts do not replay them. A client may time out before a pause ends.

Frigate instead rediscovers eligible missing descriptions by ID and regenerates
them through its API after the pause. This requires catch-up to be enabled,
retained media, and an event in the configured discovery range (or an explicit
retained-history scan). It is not replaying cached HTTP request bodies.

Manual scope controls use `ADMIN_TOKEN`, the same human credential as Settings
and Dashboard.
POST `/_intermediary/v1/maintenance/scopes/pause` accepts
`{"sources":["frigate"],"traffic":"all","duration":"2h"}`; omit duration for
an indefinite pause. POST `/_intermediary/v1/maintenance/scopes/resume` accepts
`{"id":"<returned pause ID>"}`. Resume removes only that manual pause.

## Recurring schedules

Use **Settings → Pause schedules**. New rules start disabled; the default timezone
is `America/New_York`. Choose days, start/end local time, sources and traffic.
`pause` stops selected inference. `release_gpu` requires all sources/all traffic
and drains then unloads Ollama.

```yaml
work_policy:
  timezone: America/New_York
  schedules:
    night:
      enabled: true
      days: [sun, mon, tue, wed, thu, fri, sat]
      start: "01:00"
      end: "03:00"
      sources: [frigate]
      traffic: all
      mode: pause
```

Start is inclusive, end exclusive. Overnight weekdays refer to the start day:
Monday 23:00–03:00 ends Tuesday. End time is fixed, not measured from when a
running request finishes. An unload already in progress finishes before admission
reopens. Overlapping rules combine; ending a schedule never clears manual pauses
or recovery. Restart evaluates schedules before admitting/dispatching requests.
The dashboard shows active rules, source blockers and next transitions. Maximum:
32 schedules, 100 sources, 100 manual scopes and 1,000 total IP mappings.

DST follows local wall clock: missing minutes are skipped and repeated minutes
are evaluated twice. A narrow 01:30–01:45 fall-back window pauses twice with a gap;
01:00–03:00 stays paused across the repeated hour. Choose UTC for no DST ambiguity.

Manual scope state is stored beside maintenance state in `maintenance.json.scopes`;
scheduled release uses `maintenance.json.scheduled`. Invalid/unwritable scoped
state fails closed. Back up the whole state volume. Before downgrading, stop
traffic and deliberately replace/remove new policies: older versions do not
enforce these source pauses or schedules.

## Frigate ordering and rescue deferrals

`frigate.catchup_order` is `newest_first` by default or `oldest_first`. Only jobs
whose grace/retry delay elapsed qualify. Discovery frontiers are respected; a
full bounded backlog must drain to avoid deadlock, so ordering is then limited
to discovered jobs, not all unseen history. List browsing stays newest-first.

Real generation failures retain exponential backoff. Temporary **pre-dispatch**
safety refusals use `frigate.safety_retry_interval` (default `30s`, range `5s`–`5m`).
Pauses, busy GPU, unavailable telemetry or insufficient RAM/VRAM do not add a
failure, start a failure timer, or consume the enlarged attempt. A previous real
failure can still have an attention flag. Native handoff counts can increase
even when no GPU inference was sent.

Rescue can reread telemetry up to three times, with 350ms settling gaps, for counters
to settle, under the same inference gate. Sustained nonzero activity, unknown
process ownership and missing telemetry still defer; there is no arbitrary
utilization threshold. RAM, VRAM headroom, tested context cap and one-enlarged-
dispatch-per-retained-job guards remain. Idle telemetry never clears a recovery
lock. Temporary refusals appear amber as **Request deferred**, not an Ollama
generation failure. Settings changes do not automatically increase a tested cap.
