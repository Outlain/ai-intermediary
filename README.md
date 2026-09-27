# AI Intermediary

A local AI scheduler for applications sharing one GPU: streaming Ollama requests
and opt-in, durable ComfyUI image/video workflows use the same exclusive gate.
Sources control priorities; configurable backends control where compatible work
runs. It also recovers missing Frigate descriptions through a persistent backlog.
See [the AI/ComfyUI setup guide](docs/AI_INTERMEDIARY.md) and
[sources, dedicated ports and pause schedules](docs/SOURCES_AND_SCHEDULES.md).
For an Ubuntu AMD host, the [ComfyUI installation recipe](docs/COMFYUI_AMD.md)
covers the isolated Python environment, protected service and first local image workflow.
For saved videos missing after a backend crash, see [media result recovery](docs/MEDIA_RECOVERY.md).

**AI Intermediary 2.0:** media is disabled by default. ComfyUI requires the
bundled execution bridge, read-only host ownership telemetry, private networking and tested local
workflows. Automated mock tests are not a real AMD GPU deployment validation.

The initial backend adapters support one Ollama instance and multiple ComfyUI
instances in one GPU resource group. New backend software needs an adapter;
adding a URL cannot safely support an arbitrary execution protocol. Media jobs
are non-preemptive: an already-running video finishes before a new chat starts.

The supplied defaults target these workloads without tying them to particular model names:

- Odysseus: interactive priority, protected queue, and a one-minute model lease.
- Frigate: a bounded live queue plus optional durable description catch-up when the GPU is idle.
- Ollama: a configurable backend URL, `OLLAMA_NUM_PARALLEL=1`, and `OLLAMA_MAX_LOADED_MODELS=1`.

## Install from a GitHub Release

Tagged releases publish two artifacts:

- A versioned Linux `amd64` container image in GitHub Container Registry.
- A small deployment bundle containing Compose, configuration templates, documentation, and a SHA-256 checksum.

Once a version has actually been published on [GitHub Releases](https://github.com/Outlain/ai-intermediary/releases), use its tag below. The version in source code alone does not mean that an image or release exists yet.

```sh
gh release download v2.0.3 \
  --repo Outlain/ai-intermediary \
  --pattern 'ai-intermediary-v2.0.3-linux-amd64.tar.gz*'
sha256sum -c ai-intermediary-v2.0.3-linux-amd64.tar.gz.sha256
tar -xzf ai-intermediary-v2.0.3-linux-amd64.tar.gz
cd ai-intermediary-v2.0.3-linux-amd64
cp config.example.yml config.yml
cp secrets.example.env secrets.env
chmod 600 secrets.env
# Edit secrets.env, then:
docker compose pull
docker compose up -d
```

This release installation does not require Node.js, npm, Git, or a local image build. It only requires Docker Engine with the Compose plugin. See [docs/INSTALL.md](docs/INSTALL.md) for download, upgrade, rollback, and source-install instructions.

## Build from source

```sh
cp config.example.yml config.yml
cp secrets.example.env secrets.env
# Edit secrets.env with the real backend and optional Frigate source CIDR.
docker compose up -d --build
curl http://127.0.0.1:11435/readyz
# Open /debug and sign in with ADMIN_TOKEN to inspect protected status.
```

Open `http://<docker-host>:11435/debug` for the live dashboard. It uses the same listener and does not require another port.

Open `http://<docker-host>:11435/settings` for protected, structured configuration. Use the same `ADMIN_TOKEN` from `secrets.env` for Dashboard, Settings, maintenance, recovery, catch-up controls and media. Dashboard and Settings share this login within the browser tab's session storage. A dedicated media port is a different browser origin and may ask for the same password once there too.

Then change each application's Ollama base URL to `http://<docker-host>:11435`. If possible, configure one of these headers:

```text
X-Ollama-Client: odysseus
X-Ollama-Client: frigate
```

Dedicated listeners win, then enabled client headers, then source IP/subnet mappings, exact-model mappings, and `scheduler.default_client`. The supplied configuration uses `odysseus` as the fallback source. For more sources, assign Odysseus a dedicated port, verify routing, then optionally add `misc` as the default. Cross-source IP overlaps and duplicate listener ports are rejected. The example contains no model mappings, so every model works automatically.

`clients` are workload-policy identities, not model registrations. They let the proxy give interactive Odysseus work higher priority while applying short TTL and overflow rules to Frigate. Each client's `model_policy` applies to every model that client requests. The `models` section is empty by default and exists only for rare exact-model overrides.

The container publishes host port `11435` to proxy port `11434`. The real Ollama service stays outside this Compose project.

## Scheduling algorithm

Inference endpoints enter an in-memory queue. A single dispatcher is the only code path that can open a scheduled generation request to Ollama.

`scheduler.mode: strict_priority` is the default. At each dispatch boundary:

1. Expired and disconnected live HTTP requests are removed.
2. Eligible live requests use numeric priority (larger first), then arrival order across all sources and models. There is no hard-coded Odysseus exception.
3. A lower-priority client waits for the previous client's idle hold; equal/higher priority clients do not. Paused sources do not retain a hold over eligible sources.
4. Frigate catch-up starts one native regeneration only when eligible live queues, active inference and idle holds are clear. Correlated catch-up stays behind live work. Finished attempts can await saving separately, up to `frigate.max_verifying`. Eligible jobs use configurable `frigate.catchup_order`: `newest_first` by default or `oldest_first`.

Active inference is never interrupted to give another client a turn. In strict mode, priority aging, `max_wait`, model affinity, and batch limits cannot force Frigate ahead of Odysseus. Continuous Odysseus work can therefore postpone Frigate indefinitely; that is intentional. With the default one-minute Odysseus hold, a short web-search pause does not immediately hand the GPU to Frigate.

For `O1 F1 O2 F2 O3`, when the later requests arrive while O1 runs, the order is `O1 O2 O3`, the idle hold, then `F1 F2` if no new Odysseus request arrives.

For deployments that want fairness and model affinity instead of strict priority, choose `scheduler.mode: balanced`. Only that mode applies priority aging, `max_wait` promotion, and model batch limits. A `max_wait` of zero disables forced promotion; it does not mean immediate expiration. Queue TTL is a separate setting in both modes.

### Lease versus Ollama keep-alive

These controls are related but different:

- `idle_hold` is a scheduling decision: leave the dispatcher idle briefly instead of handing the GPU to a lower-priority client. It does not delay a higher-priority request in strict mode, even when the model is unchanged.
- `keep_alive` is written into native Ollama generation request bodies: ask Ollama to retain that model for the configured duration.

The proxy never sends a separate preload request. The selected real request loads whatever model its JSON body names. OpenAI-compatible request bodies are not modified with native `keep_alive` fields. Once the scheduler has actually chosen a different model, the default GPU-safety policy sends a native `keep_alive: 0` cleanup request for the previous model and waits for `/api/ps` to confirm its unload before dispatching the replacement.

Client-wide policy example:

```yaml
clients:
  odysseus:
    model_policy:
      idle_hold: 1m
      max_batch_requests: 8
      max_batch_time: 90s
      keep_alive: 60s
```

Downloading or selecting a new Odysseus model requires no proxy configuration change. An optional exact override is possible when one unusual model needs different limits:

```yaml
models:
  unusually-large-model:latest:
    idle_hold: 30s
    max_batch_requests: 4
    max_batch_time: 2m
    keep_alive: 60s
```

## API behavior

Scheduled inference endpoints:

- `POST /api/generate`
- `POST /api/chat`
- `POST /api/embed`
- `POST /api/embeddings`
- `POST /v1/chat/completions`
- `POST /v1/completions`
- `POST /v1/responses`
- `POST /v1/embeddings`

Explicitly allowlisted metadata endpoints—including `/api/tags`, `/api/show`, `/api/ps`, and `/v1/models`—pass through immediately and do not wait for inference. Unknown routes are rejected rather than risking a new inference endpoint bypassing serialization. Supported blob checks are metadata; blob uploads and model mutations use the management gate.

Model-management endpoints `/api/pull`, `/api/push`, `/api/create`, `/api/delete`, and `/api/copy` use an exclusive operation gate. Once one is waiting it has precedence at the next inference boundary, and it never runs concurrently with generation. They can be disabled entirely.

Response status, content type, application headers, and body bytes are streamed as Ollama supplies them. The proxy does not buffer a complete model response and does not invent heartbeat tokens. Hop-by-hop HTTP headers are removed as required for a proxy. Request bodies are capped individually by `server.body_limit_bytes`; `scheduler.max_queue_bytes` additionally bounds admitted active plus queued request bodies (64 MiB by default). This is a payload budget, not a guarantee about total process memory.

Unconfigured models are normally scheduled using their detected client's policy. Keep `scheduler.unknown_model_policy: schedule` for this model-agnostic behavior. The alternative `reject` mode is only useful for an intentional model allowlist.

## Deployment variables and `secrets.env`

Docker Compose loads `secrets.env` into the container. The YAML loader parses YAML first, then expands `${NAME}`, `${NAME:-default}`, and `${NAME:?error message}` placeholders in values, so environment text cannot inject additional YAML sections.

```dotenv
OLLAMA_URL=http://192.0.2.10:11434
FRIGATE_SOURCE=192.0.2.50/32
ADMIN_TOKEN=
FRIGATE_URL=
FRIGATE_USERNAME=
FRIGATE_PASSWORD=
FRIGATE_AUTH_TOKEN=
```

Set `OLLAMA_URL` and a strong `ADMIN_TOKEN` before starting a new installation. Generate one with `openssl rand -hex 32`, or use a strong printable-ASCII password without leading/trailing whitespace. The maximum is 4,096 characters. This single credential unlocks Dashboard, Settings, maintenance, recovery, catch-up controls and media. It remains host-managed and cannot be viewed or changed through Settings.

ComfyUI still needs a machine credential to keep its raw execution port protected, but you do not need to create or remember another password. Host setup derives and provisions it from `ADMIN_TOKEN` using [scripts/configure-comfy-auth.py](scripts/configure-comfy-auth.py); the derived value cannot log into the intermediary. After changing `ADMIN_TOKEN`, recreate the intermediary, rerun provisioning and restart ComfyUI when safely idle so both sides use the new machine credential. See the [AI/ComfyUI guide](docs/AI_INTERMEDIARY.md).

**Privilege tradeoff:** the single password grants administrative access, even when used by a status-only consumer such as Home Assistant or a metrics scraper. Do not share it with untrusted viewers. Single-admin mode does not provide a separate read-only credential. Protect connections and keep the service on a trusted private network; the password does not add TLS or protect ordinary Ollama-compatible inference routes.

`FRIGATE_SOURCE` can remain blank until Frigate is connected, or when Frigate sends `X-Ollama-Client: frigate`. The supplied `scheduler.default_client: odysseus` setting means an unmatched source automatically receives the Odysseus policy; Odysseus's changing container IP never needs to be configured. Frigate's own optional login credentials remain separate because they authenticate to another application. `secrets.env` is ignored by Git and excluded from the Docker build context.

The `192.0.2.0/24` addresses above are documentation placeholders. Replace them with addresses valid for your deployment.

## Settings page, persistence, and recovery

The settings page edits an allowlisted set of application settings such as the Ollama URL, client classification, queue limits, scheduling, circuit-breaker behavior, GPU safeguards, maintenance limits, and observability limits. It does not expose a raw YAML editor.

Configuration has three deliberately separate owners:

- `config.yml` is the read-only base configuration managed on the host.
- `/app/state/settings.json` contains validated, versioned browser overrides. It lives in the persistent volume mounted at `/app/state` and takes precedence over matching base values. Preserve the same physical volume identity, including its Compose project prefix, during updates.
- `secrets.env` remains host-only. The page reports only whether a token is configured; it never returns or changes token values.

Docker Compose is also host-only. The container has neither the Compose file nor the Docker socket mounted for writing, so the page cannot change ports, mounts, restart policy, image tags, memory limits, or Docker networking. Keep machine-specific Compose changes in the ignored `docker-compose.override.yml`, not in the tracked base file.

Use **Validate changes** before **Apply settings**. Apply atomically saves the override plus one last-known-good revision, stops admitting new inference, and waits for already-dispatched work to finish before beginning shutdown and exiting with status 75. The supplied Compose `restart: unless-stopped` policy starts it again with the new values. A systemd installation needs `Restart=on-failure`; a foreground `node` process must be started again manually.

If a safely editable setting prevents normal startup, the service enters a restricted configuration-recovery mode on the same container listener. `/settings` and `/healthz` remain available, `/readyz` and `/status` return HTTP 503 with `configuration_invalid`, and inference receives HTTP 503 until a valid configuration is applied and the supervisor restarts the service. Invalid YAML, a missing host-managed token, a bad volume mount, or a listener/Compose problem still requires a host-side fix. The same `ADMIN_TOKEN` protects Settings in recovery mode; without it, the settings API remains locked.

Because saved overrides take precedence, later edits to an overridden field in `config.yml` will not change that field until its saved override is reset. The page always displays the effective values, their revision, validation diagnostics, and whether the service is running normally or in configuration recovery.

## Queue and failure behavior

- Odysseus defaults to a protected 10-request queue. Overflow returns a JSON HTTP 429; interactive jobs are never silently discarded.
- Frigate defaults to 20 queued requests and `drop_oldest`. An evicted caller receives JSON HTTP 429. Jobs older than two minutes receive HTTP 408 and are never dispatched.
- Optional coalescing is newest-wins and only activates when at least one configured header or scalar JSON field yields a key. Do not enable it until the real Frigate identifiers are confirmed.
- A queued disconnect removes the job immediately. By default, a running disconnect stops downstream delivery but drains Ollama to a normal completion while holding the single-inference gate. This deliberately trades some otherwise-wasted GPU time for safer ROCm cleanup.
- Original inference payloads are never automatically replayed. Even a connection failure before response headers is ambiguous: the backend may have started work. Optional Frigate recovery instead checks saved descriptions and asks Frigate's own regeneration API to handle still-missing results.
- Three failures in the configured window open the circuit. With `queue_behavior: hold`, queued jobs remain subject to their normal TTL while health probes run; `reject_new` returns 503 for new inference.
- A recognized GPU out-of-memory error or an uncertain upstream completion can latch `recovery_required`. Queued work is failed with 503 and new inference is rejected until recovery is verified, either by operator acknowledgment or the optional bounded host recovery integration. HTTP 200 streaming responses can contain model errors; they are not automatically counted as successful generations.
- `/api/tags` and `/api/ps` are probed periodically. `/api/ps` reconciles the scheduler's model state when no request is active, covering Ollama restarts and external unloads.

The proxy container does not receive GPU devices, the Docker socket, or general host command privileges. By default it contains an uncertain upstream operation and requires operator recovery. An optional, separately installed [host integration](integrations/host/README.md) supplies read-only AMD telemetry and a narrowly scoped, rate-limited `ollama.service` restart. Neither component can reset the GPU or reboot the host. An empty `/api/ps` response by itself is not proof that an old operation stopped or physical VRAM was released.

### GPU safety and recovery

The defaults are designed for the cancellation failure mode seen with large ROCm model loads:

```yaml
gpu_safety:
  drain_active_disconnects: true
  unload_on_model_switch: true
  unload_timeout: 30s
  recovery_on_oom: true
  error_body_limit_bytes: 65536
```

`drain_active_disconnects` applies only after dispatch. Callers that disappear while queued are still removed immediately. `unload_on_model_switch` runs only after scheduling has selected a different model. The error-body limit bounds retained error text; streaming responses are inspected incrementally for model errors without retaining complete output. Usage statistics that cannot be safely parsed within bounded buffers are unavailable, not invented.

When `/status` reports `backend.state: recovery_required`:

1. Check `ollama ps` and `sudo rocm-smi --showmeminfo vram --showpids` on the host.
2. Restart Ollama if necessary while inference is paused. If substantial unexplained VRAM usage or driver errors remain, stop and investigate the host; do not clear the lock or repeatedly restart services. GPU resets and host reboots are outside the recovery integration's authority.
3. Keep maintenance paused, with no active inference or management operation. Acknowledge recovery only after checking physical GPU state: `POST /_intermediary/v1/recovery/acknowledge`, authenticated with `ADMIN_TOKEN`, and JSON `{"confirm_gpu_recovered":true}`. The endpoint checks a fresh Ollama loaded-model list and requires it to be empty; it does not reset the GPU or independently prove that driver allocations are gone.
4. Recovery acknowledgment leaves maintenance paused. Resume explicitly, then confirm `/readyz` returns 200 before sending inference again.

The recovery latch is intentionally not cleared by an HTTP health probe: `/api/tags` can succeed while ROCm still holds orphaned VRAM.

### Optional bounded self-recovery and physical GPU monitoring

Host permissions are an explicit opt-in. `host_helper.enabled` and `auto_recovery.enabled` default to `false`. Install and validate the [Linux host helper](integrations/host/README.md), explicitly mount its protected Unix socket directory into the intermediary, and then enable the features. Host telemetry and recovery are independent of the Frigate description bridge.

For standard Ubuntu/Compose deployments, the guided setup is `python3 integrations/host/install.py` on the Ollama host as your normal Docker user, after pausing inference. It previews changes, asks for confirmation/sudo, backs up and safely merges configuration, verifies AMD telemetry, and recreates only the intermediary. `--check` performs preflight without installation. Automatic recovery remains off until enabled in Settings. This is our custom integration using AMD's existing tools, not an AMD-provided service; the container is not given host installation privileges.

With monitoring enabled, the dashboard separates **physical GPU memory** (total, used, free), activity, temperature, power, and process counts from **Ollama's reported model allocation**. Unavailable fields remain unknown, and stale samples are marked stale rather than rendered as zero or used to justify recovery. Hardware visibility is still limited to what the installed AMD driver/tools can report.

For a recoverable uncertain operation, automatic recovery keeps inference admission locked, checks that intermediary work has drained, obtains a bounded restart of only `ollama.service`, and verifies fresh host telemetry plus Ollama readiness before acknowledging the old attempt and admitting more work. Repeated idle GPU measurements alone never establish an old operation's completion boundary. A successful verified recovery retires the uncertain Frigate attempt so its late requests cannot run as new work; catch-up retries remain governed by their normal delays and priorities. The original inference payload is not blindly replayed.

Defaults require **3 stable samples**, empty Ollama loaded-model state, no reported GPU processes, and at most **512 MB baseline VRAM per GPU** after the service restart. The allowance accounts for idle display/driver use; it is not a VRAM target or a context-size setting. The application permits at most **2 restart attempts per recovery incident**, also bounded to **2 per rolling hour** with a **5-minute cooldown**. After two unsuccessful attempts for the same incident, waiting another hour does not reset that incident's limit; persistent failure needs operator investigation. The host helper independently enforces the rolling-hour ceiling and cooldown with persisted state, so restarting the container cannot reset the limit. Missing telemetry, a refused/failed restart, unchanged service identity, persistent GPU activity, or exhausted limits leave recovery blocked with an explicit status instead of pretending it succeeded.

An existing manual maintenance pause is never overridden or automatically resumed. **Check recovery now** is an administrator-authenticated explicit action; it cannot bypass either the per-incident or rolling restart limits, shorten the cooldown, or resume a paused service. **Acknowledge verified recovery** remains the operator-only fallback after actual host checks. The recovery panel explains what is blocked rather than simultaneously claiming that inference is running normally.

Host-only paths (`host_helper.socket_path`, `auto_recovery.state_path`) are not browser-editable. Other settings are validated and allowlisted in the settings page; automatic recovery requires the helper and `ADMIN_TOKEN`. `HOST_HELPER_ENABLED`, `HOST_HELPER_SOCKET_PATH`, and `AUTO_RECOVERY_ENABLED` can establish base values through `secrets.env`; saved browser overrides still take precedence. Accepted boolean environment values are exactly `true`, `false`, `1`, or `0`.

The helper also enforces its own 512 MiB post-restart residual-VRAM ceiling. Lowering the application's `max_idle_vram_mb` makes its verification stricter; increasing it above 512 does not bypass that separate host check. A host whose normal idle baseline exceeds the helper ceiling requires operator investigation rather than simply increasing a browser setting.

This is failure containment and bounded recovery, not a guarantee against AMD driver faults. A context-window overflow is a definite rejected request, not a reason to restart Ollama. Fix its input sizing/context separately. If driver allocations persist after the allowed service restart, recovery requires operator attention; automatic GPU resets and host rebooting are intentionally not implemented.

### Recovery reconciliation and host RAM guards

Install the matching intermediary and host helper versions using the
[host setup guide](integrations/host/README.md). Preserve saved jobs, credentials,
recovery records and restart limits when updating either component.

- A transient busy-GPU reading immediately after an Ollama restart no longer
  strands the incident indefinitely. The intermediary rechecks the same durable
  operation within a bounded settling window, without dispatching a second
  restart. Old-worker termination, changed service identity, and stable idle
  samples are still required. A timeout remains a visible safety lock; **Check /
  recover now** can open another read-only verification window for that operation.
- A systemd/operator restart can be adopted without an extra helper restart if
  the helper has prior durable worker observations and proves that the new
  service started after the incident, the old workers are gone, and the GPU is
  idle. Empty VRAM alone never qualifies. Uncertain records without this
  evidence still need manual host verification.
- Host telemetry now includes VM RAM total/available, swap total/used, optional
  Linux memory-pressure measurements, and the system-wide OOM-kill counter since
  boot. A captured systemd `oom-kill` result is identified separately from GPU
  faults. Polling may miss a short-lived service failure; the global counter
  alone cannot attribute an OOM to Ollama.
- With host monitoring enabled, catch-up admission defaults to waiting below
  **2 GiB available system RAM** or at **10% full memory pressure over 10 seconds**.
  Correlated requests are checked again before inference dispatch. Larger-context
  rescue always requires fresh RAM data and at least **4 GiB available**, even
  if the ordinary catch-up guard is disabled. Thresholds are editable in Settings.
  Unknown/stale RAM readings also block guarded background work; an older helper
  must be updated to supply them. Without host monitoring, ordinary catch-up keeps
  its existing behavior; context rescue still requires monitoring.

These checks defer background work without discarding jobs, triggering a service
restart, or changing live Odysseus/Frigate priority. Ordinary live requests remain
subject to the existing serial inference and recovery gates, not the new RAM
admission guard. Full swap alone is not a blocker: old cold pages can remain there
after pressure subsides. RAM floors are **not peak-memory predictions** and cannot
guarantee an oversized request will fit. Fixed VM memory, workload sizing, and
Ollama cache budgets still matter; see the [host memory guidance](integrations/host/README.md#host-memory-and-ollama-cache-budget).

## Frigate description catch-up

Catch-up is opt-in (`frigate.enabled: false` by default). It is a durable to-do list of Frigate object/review IDs, timestamps, state, and retry metadata—not a second copy of camera images, prompts, or recordings. Frigate still retrieves its own retained media and stores the resulting descriptions.

Use `/settings` for enablement and ordinary timing/limit changes. Keep connection credentials in `secrets.env`:

```dotenv
FRIGATE_URL=https://YOUR_FRIGATE_HOST:8971
FRIGATE_USERNAME=YOUR_ADMIN_USERNAME
FRIGATE_PASSWORD=YOUR_PASSWORD
# Alternatively use an appropriate bearer credential instead of username/password.
FRIGATE_AUTH_TOKEN=
```

The URL is the Frigate origin, without `/api`. Use a trusted TLS certificate; credentials must not be embedded in the URL. The intermediary needs an administrator-capable Frigate API connection because regeneration is an administrative operation. This connection is separate from `FRIGATE_SOURCE`, which identifies live inference traffic, and separate from Frigate's Ollama URL, which must continue pointing at the intermediary.

For an intentionally unauthenticated internal API (commonly `http://YOUR_FRIGATE_HOST:5000`), choose **No login required — trusted local API** under **Catch-up → Frigate authentication** and validate/apply. This saves `frigate.auth_mode: none`, sends no credentials even if old credentials remain in the environment, and removes the missing-login warning. Keep that API restricted to trusted hosts; this setting does not secure it. Other modes are `password`, `token`, and the backward-compatible default `auto` (bearer token first, then username/password, otherwise no login). Credentials themselves remain host-managed in `secrets.env`.

- Object recovery uses Frigate's native event-description regeneration API.
- Review recovery requires an installed Frigate build exposing `PUT /api/review/{id}/regenerate_description`, such as the tested-against source interface in development build `0.19.0-bb6c2e9`. This is not a claim of live hardware validation or a recommendation to blindly upgrade a production camera system.
- Unsupported review regeneration must be reported as unavailable, not silently replaced with a time-period summary.
- Effective per-camera enablement, object/zone filters, and review alert/detection settings control eligibility. The worker skips descriptions present at its final fresh check, bypassing Frigate's API cache. Frigate has no atomic “generate only if still missing” operation: a separate live/manual completion can race that check and the subsequent regeneration request. Object `force:false` respects camera enablement; it is not a no-overwrite guard.
- Cameras configured only for early object triggers (`tracked_object_end: false`) are excluded from object recovery and show `early_trigger_only_not_recoverable`. Retained event records do not expose the significant-update count needed to prove that their early trigger fired. Review recovery remains independent. Enable **Send on end** in Frigate only if you actually want that behavior; the intermediary does not change it for you.
- Automatic discovery begins at first enablement and persists that starting point. Use **Fill missing descriptions** to deliberately scan older retained items. Automatic and manual candidates share a deduplicated, newest-first backlog.
- Live HTTP requests keep their normal bounded queue and timeouts. A lost live connection does not need to remain open for hours: missing descriptions are discovered from Frigate afterwards.
- A background attempt starts only when the GPU scheduler is idle and not paused/recovering. **Odysseus → live Frigate → catch-up** remains the priority order; an already running GPU inference is never preempted. With the [version-pinned Frigate bridge](integrations/frigate/README.md), each generated inference is correlated to its native attempt and keeps its background priority even if live work arrives after handoff. Stock Frigate cannot identify these requests reliably, so it keeps the conservative idle-only handoff behavior.
- Regeneration acceptance is not completion. In **correlated mode**, the bridge reports when the entire native attempt finishes, including native failures that produced no description. A known failure enters retry backoff promptly, allowing another eligible job to proceed without waiting out the saved-description window. A successful native attempt moves to **Awaiting saved description**; only the saved description marks it completed. One native attempt may run while a bounded number of finished attempts await those saves (default **4**), but there is still only **one GPU inference** at a time. Neither HTTP 200 nor the next unrelated Frigate request is treated as proof of native completion.
- Without verified bridge capabilities, **compatibility mode** retains one unconfirmed handoff until a description appears or the confirmation timeout safely resolves. Installing only the intermediary update does not enable correlated mode. Uncertain upstream work still holds safety guards; neither a callback nor a timeout is permission to overlap or interrupt GPU inference.
- Failed or unconfirmed attempts keep retrying with exponential delays capped by `max_retry_interval` (default **5h**). Jobs are flagged **Needs attention** after `attention_after` (default **24h**) from their first unsuccessful attempt, but the flag never stops retries. Merely waiting in the initial backlog does not start that clock. Retry times are earliest eligibility times, not guaranteed dispatch times.
- Snapshots/recordings must outlast the backlog. Review regeneration uses retained recordings; object regeneration uses available configured snapshots/thumbnails, not necessarily the exact original live image sequence.

The backlog lives at `/app/state/frigate-backlog.json` by default, in the existing named volume. Never delete that volume during upgrades. `max_jobs` bounds pending queue state; a `backlog_capacity_reached` warning means discovery keeps its cursor and waits for room rather than discarding pending items. Newest-first applies to discovered, ready jobs: undiscovered items behind a full queue or unfinished scan cannot participate yet. Monitor capacity when scanning large histories.

Catch-up timing and storage have separate jobs:

| Setting | Default | Purpose |
| --- | --- | --- |
| `poll_interval` | `30s` | Discover missing descriptions. |
| `confirmation_interval` | `2s` | Check outstanding saved results independently; minimum `1s`, with API-failure backoff. |
| `cleanup_interval` / `cleanup_batch_size` | `1m` / `25` | Rate-limited media/metadata cleanup independent of GPU availability; minimum interval `10s`, batch 1–100. |
| `live_grace` | `2m` | Give live description generation time after an event ends. |
| `retry_interval` / `max_retry_interval` | `1m` / `5h` | Initial and maximum retry delay. |
| `attention_after` | `24h` | Flag prolonged unsuccessful work without stopping retries. |
| `request_timeout` | `15s` | Bound an individual Frigate API call. |
| `generation_timeout` | `10m` | Bound an unconfirmed handoff and saved-result verification. In correlated mode the saved-result window starts after native completion, not initial handoff. Never interrupts active GPU work. |
| `max_verifying` | `4` | Finished native attempts allowed to await saved descriptions before new handoffs pause; 1–16. Only used with the pinned bridge, not a GPU-concurrency setting. |
| `history_limit` | `1000` | Retain the latest completed/skipped metadata rows together; configurable 1–5,000. |

The low-rate cleanup pass removes confirmed deleted events or missing required media without waiting for the GPU to become idle. Temporary API, authentication, and connection failures are not proof of deleted footage. Media is checked again before regeneration because it can expire while queued. No universal 14-day cutoff is imposed: camera/category retention may differ, and older retained media can still be usable. Review checks use Frigate's recording index and do not prove that every underlying video file remains readable. A separate record of up to **10,000 unavailable-media/deleted-event IDs**, with **30-day revalidation**, prevents ordinary completed-history rollover from immediately rediscovering those same jobs. This is a bounded suppression cache, not a permanent archive: capacity rollover or expiration permits a later discovery to reconsider an ID. **Recheck availability** explicitly checks a retained skipped item again if media may have returned.

Only completed/skipped metadata rows roll off at the history limit. The existing pending backlog and lifetime completed/skipped totals remain separate, and no Frigate description or camera media is deleted. Existing history that already rolled off before an upgrade cannot be recovered by raising the limit.

`GET /_intermediary/v1/status` exposes `frigate.state`, `frigate.counts` (`pending`, `waiting_live`, `waiting_result`, `retrying`), `frigate.attention_count`, and persistent `frigate.totals.completed` / `frigate.totals.skipped`. Existing count keys remain compatible; `waiting_result` includes generation and saved-result verification, and `attention_count` overlaps unfinished work. New `bridge_mode`, `verifying_count`, `max_verifying`, and per-job `phase` distinguish native execution from saving; `active_job` identifies the native generation slot, not finished attempts merely awaiting a saved result. Recent jobs show reasons; connection or state-store failures appear as degraded/error state. To request the historical missing-description scan, use `POST /_intermediary/v1/frigate/scan` with `ADMIN_TOKEN` and JSON `{"confirm":true}`. The scan requests work; it does not synchronously generate every description. Home Assistant examples are in [docs/HOME_ASSISTANT.md](docs/HOME_ASSISTANT.md).

The dashboard separates **Waiting**, **Awaiting result**, **Retrying**, **Needs attention**, **Completed**, and **Skipped** views. Each paginates the whole matching saved set, not just a filter over the first visible page. **Needs attention** is a subset of unfinished work, not an additional queue; it remains flagged during a later outstanding attempt and must not be added to the pending total. `GET /_intermediary/v1/frigate/jobs?view=waiting&offset=0&limit=30` uses the same read authentication as catch-up status. Supported views are `all` (the default active backlog), `waiting`, `awaiting`, `retrying`, `attention`, `completed`, and `skipped`; `limit` accepts 1–100. Pages can shift as jobs arrive or finish. Completed/skipped views are bounded history, not an unlimited archive.

**Retry when idle** requests an earlier opportunity for an eligible retrying job; **Recheck availability** revisits a known unavailable item. These use `POST /_intermediary/v1/frigate/retry` or `/recheck` with `ADMIN_TOKEN` and JSON `{"confirm":true,"kind":"object","id":"FRIGATE_EVENT_ID"}` (`kind` may also be `review`). They revalidate the current item and never bypass live priority, maintenance/GPU safety, or the outstanding-handoff guard. An already saved description is preserved at the final fresh check, subject to the Frigate race limitation above.

The **Awaiting result** view distinguishes **Preparing in Frigate**, **Queued for GPU**, **Generating**, **Awaiting saved description**, and **Outcome uncertain**. In correlated mode, awaiting-save rows do not hold the generation slot unless their configured cap is full. In compatibility mode, **Waiting result** can still remain for the confirmation window (`generation_timeout`, normally 10 minutes), even after an inference error: the proxy cannot safely attribute an untagged native failure to a particular job. The dashboard states which mode is active instead of implying that the GPU is continuously generating. Repeated context-size errors still require fixing the Frigate request/model context; this pipeline improvement does not make an oversized request fit.

After installing or changing the bridge, **Recheck Frigate connection** under the dashboard's administrator-authenticated catch-up controls refreshes capabilities immediately instead of waiting for the normal five-minute probe. Its API is `POST /_intermediary/v1/frigate/refresh` with `ADMIN_TOKEN` and `{"confirm":true}`. It is rate-limited to once per five seconds and coalesces concurrent probes. It does not start a historical scan, retry jobs, clear an outstanding handoff, restart a service, or change pause/recovery guards.

For nearby catch-up jobs, a Frigate model `keep_alive` of `2m` can reduce unnecessary unload/reload cycles while leaving scheduling priority unchanged. The supplied configuration uses this value and a `5h` maximum retry delay. Configure them under **Settings → Frigate → Ollama keep-alive** and **Catch-up → Maximum retry delay**. Keep-alive is not idle hold, generation timeout, or a reservation of the GPU; Odysseus remains higher priority and model switching still follows GPU-safety cleanup.

`frigate.eligibility_skipped` counts discovery observations by exclusion reason, not distinct events: overlapping or repeated scans can count the same item again. Camera warnings and these counts help explain why a missing description is not eligible; they are not failed-generation totals.

Before enabling unattended recovery, test one retained object and one ended review on your installed Frigate instance, confirm the resulting descriptions appear in Frigate, then test live Odysseus priority and a container restart. Mock tests cannot validate real media retention, permissions, or GPU driver stability.

### Error-only context rescue

Optional **Settings → Catch-up → Conservative context rescue** can rescue one confirmed overflow without changing normal Frigate context or its upstream frame selection. It defaults **off**. Configure the exact model tag and a maximum context you have independently tested on that model/GPU/Ollama setup; there is deliberately no automatic 32 GB “safe cap.” The pinned Frigate bridge and enabled, backend-matched host monitoring are required. Automatic service restart can remain disabled.

- Only a complete HTTP 400 typed `exceed_context_size_error`, with valid numeric input/context counts, qualifies. Generic 400s, output-format failures, partial responses, socket failures and GPU/OOM errors do not.
- The first confirmed overflow records counts and a request fingerprint, not prompts, images or output text. After the native attempt ends, the job follows its normal retry backoff and fresh media/description checks. A later correlated request must match that complete original input, model, options and backend; changed input cannot borrow an old measurement.
- The target includes the reported input tokens, the greater of the output reserve or explicit positive `num_predict`, and the safety margin. It grows above both the rejected and requested context, rounds up toward a 4,096-token boundary without exceeding the configured cap, and must fit the model's `/api/show` context limit. This changes only the outgoing `options.num_ctx`, not Frigate settings, images, prompts or output limits.
- Immediately before enlargement, fresh host monitoring must show known GPU processes, no non-Ollama process or GPU activity, and at least 2 GiB free on each reported GPU. That free-memory check is an extra guard, **not** proof that the larger KV cache fits. Retest the cap after model/quantization/backend changes. Larger context can cause a model reload; this feature does not prewarm or keep switching context for ordinary requests.
- Exactly one enlarged dispatch is reserved durably per retained job before contacting Ollama. Restart, retry controls and rechecking a retained skipped record do not reset it. Missing/stale telemetry or other preflight blocks do not consume it. An ambiguous enlarged dispatch still invokes the existing recovery boundary; it is never blindly replayed.
- The same single-inference gate, queued live-work priority, maintenance pause and recovery locks apply. Saved-description confirmation remains separate. After a rescue is used, or if the measured input cannot fit the cap, unchanged known-oversized requests are refused locally instead of sent to the GPU again. Normal backoff, media checks and the 24-hour attention flag continue; inspect the job and adjust the input/configuration when intervention is needed. Changed input can run normally but does not grant that job a second enlargement.

The dashboard shows the policy, recorded counts, enlarged-attempt status and blocked/failure reason. History retention remains bounded; do not delete the backlog to reset safety limits. Disabling the feature restores unchanged normal forwarding. No setting can make an oversized request safe merely by retrying it, and a successful Ollama response is not marked completed until Frigate saves its description.

## Planned maintenance pause

Use maintenance pause when another application needs exclusive use of the GPU. It is safer and more informative than stopping the intermediary: callers receive a deliberate JSON HTTP 503 with code `maintenance_paused`, while the dashboard, status API, and pause state remain available.

Pausing is a safe transition rather than an abrupt cancellation:

1. New scheduled inference is rejected immediately with HTTP 503.
2. Queued inference is failed with the same status instead of being retained for hours.
3. If Ollama is already processing a request, the intermediary drains it to completion to avoid the ROCm cancellation/ghost-VRAM failure mode.
4. The loaded model is explicitly unloaded, and `/api/ps` must confirm that it is gone before `gpu_released` becomes true.

Model-management and other unsafe pass-through operations also receive the maintenance 503. Safe metadata reads such as `/api/tags`, `/api/ps`, `/api/show`, and `/v1/models` continue to work because they do not schedule GPU inference.

The pause endpoint returns HTTP 202 as soon as the pause record is safely persisted. Drain and unload then continue in the background; accepting the command is not yet proof that the GPU is free.

The simplest control surface is the **Pause mode** card at `http://<docker-host>:11435/debug`. Sign in once with `ADMIN_TOKEN`, choose **Manual** or a duration, and wait for the card to report both **Paused** and **GPU released: Yes**. There is no second maintenance password in single-admin mode. The dashboard retains the credential only in the current browser tab's session storage.

For a manual pause with no automatic expiry, use Bash below. It reads the password without echoing and supplies the authorization header on standard input rather than placing it in curl's process arguments. Do not enable shell tracing while handling credentials.

```bash
read -rsp 'Admin password: ' ADMIN_TOKEN; printf '\n'
curl -fsS -X POST http://127.0.0.1:11435/_intermediary/v1/maintenance/pause \
  --header @- \
  -H 'Content-Type: application/json' \
  --data '{"reason":"exclusive GPU task"}' <<<"Authorization: Bearer ${ADMIN_TOKEN}"
```

For a timed pause, include a duration string. The supplied maximum is seven days (`168h`):

```bash
curl -fsS -X POST http://127.0.0.1:11435/_intermediary/v1/maintenance/pause \
  --header @- \
  -H 'Content-Type: application/json' \
  --data '{"duration":"4h","reason":"exclusive GPU task"}' <<<"Authorization: Bearer ${ADMIN_TOKEN}"
```

The timed interval begins only after the active request has drained and model-unload confirmation has released the GPU. Use a manual pause for work whose end time is uncertain; a timed pause deliberately admits Ollama work again when it expires.

Before starting the other GPU task, inspect `GET /_intermediary/v1/status` or `/debug` and require all of these conditions:

```text
maintenance.state = paused
maintenance.gpu_released = true
maintenance.unload_error = null
```

`gpu_released` specifically means Ollama's `/api/ps` reports no loaded models. For a workload that needs virtually all VRAM—especially after a prior ROCm failure—also run `sudo rocm-smi --showmeminfo vram --showpids` on the host before starting it; the container cannot certify driver-level ghost allocations.

Resume manually when the exclusive task is finished:

```bash
curl -fsS -X POST http://127.0.0.1:11435/_intermediary/v1/maintenance/resume \
  --header @- \
  -H 'Content-Type: application/json' \
  --data '{}' <<<"Authorization: Bearer ${ADMIN_TOKEN}"
unset ADMIN_TOKEN
```

The pause record is stored in the Compose volume mounted at `/app/state`, so manual and timed pauses survive intermediary container restarts. `maintenance.max_pause` limits only timed pauses; a manual pause remains until resumed.

Normally Ollama can remain running: after confirmed model unload it has no loaded model consuming a large VRAM allocation, and the paused intermediary prevents its clients from starting another inference request. If any application can bypass the intermediary, or the external workload requires absolute process-level isolation, stop only Ollama after `gpu_released` is true:

```sh
sudo systemctl stop ollama
```

Leave the intermediary running so clients receive the intentional 503 and operators retain status and control. Before resuming the intermediary, restart and verify Ollama:

```sh
sudo systemctl start ollama
curl -fsS http://127.0.0.1:11434/api/tags >/dev/null
```

If `maintenance.state` is `error` or `gpu_released` is false, do not assume the GPU is free. Read `maintenance.unload_error`, check `ollama ps` and `rocm-smi`, and resolve the host-side condition first.

## Observability

`GET /status` returns backend/circuit/recovery state, current model/group, active request, whether an abandoned request is being drained, per-client and per-model queue depths/oldest ages, last activity, lease remaining, switch count, and shutdown admission state.

The responsive dashboard at `GET /debug` displays the current source client, request type/model/age, privacy-safe request size counts, queue contents, Ollama-reported VRAM/context, recovery state, and the most recent in-memory lifecycle events. Prompts, responses, images, headers, source addresses, and deduplication values are never retained in observability history.

The versioned read-only API is:

- `GET /_intermediary/v1/status` for a complete snapshot
- `GET /_intermediary/v1/history?limit=50` for bounded in-memory history
- `GET /_intermediary/v1/events` for live Server-Sent Events

These data endpoints, `/status` and `/metrics` require `ADMIN_TOKEN`. The static dashboard retains the login only in the browser tab's session storage. These endpoints are read-only, but their credential is not: anyone holding `ADMIN_TOKEN` can also invoke administrative controls. Do not give this password to a status-only consumer that you would not trust with administrative access.

Home Assistant can turn the shared snapshot into native sensors with one five-second REST poll. See [Home Assistant setup](docs/HOME_ASSISTANT.md).

`GET /metrics` emits Prometheus text including:

- `proxy_queue_depth{client=...}` and `proxy_oldest_queue_wait_seconds`
- `proxy_queue_wait_seconds` and `proxy_request_duration_seconds` histograms
- `proxy_requests_total`, `proxy_requests_failed_total`, `proxy_requests_dropped_total`
- `proxy_model_switches_total`
- `proxy_current_model{model=...}` and `proxy_backend_healthy`
- `proxy_active_request`, `proxy_active_request_duration_seconds`, and `proxy_queue_depth_total`
- `proxy_ollama_loaded_model_vram_bytes{model=...}`
- request/response byte and input/output token histograms when usage is available
- `proxy_model_load_duration_seconds` (dispatch-to-response-header estimate when a new model is expected)
- `proxy_active_disconnects_total` and `proxy_upstream_drain_duration_seconds`
- `proxy_model_unload_duration_seconds`
- `proxy_gpu_recovery_required` and `proxy_gpu_recovery_required_total`
- `proxy_maintenance_paused`, `proxy_maintenance_gpu_released`, and `proxy_maintenance_remaining_seconds`
- `proxy_maintenance_pauses_total`, `proxy_maintenance_resumes_total`, and `proxy_maintenance_gpu_releases_total`
- `proxy_upstream_draining`
- `proxy_circuit_breaker_opens_total`

All application logs are newline-delimited JSON. The supplied Compose files rotate container logs at 10 MiB across three files. Scheduling lifecycle entries include request ID, detected client, model, queue/dispatch/completion times, wait/duration, streaming flag, status, and switch reason. Supply `X-Request-ID` to correlate an existing trace; otherwise the proxy creates one. Prometheus model labels and per-metric series are bounded, with excess values aggregated rather than retained without limit.

Alert at minimum on `proxy_backend_healthy == 0`, `proxy_gpu_recovery_required == 1`, circuit openings, elevated queue age, drops, and the rate of `proxy_model_switches_total`. The last metric is the central before/after measure for GPU churn.

## Long HTTP timeouts

Queue time is deliberately unbounded by Node's server request timeout; the configured `ollama.request_timeout` starts only when a request is dispatched upstream. Every reverse proxy and client in front must allow the maximum queue wait plus model runtime.

Nginx or Nginx Proxy Manager “Advanced” configuration:

```nginx
proxy_http_version 1.1;
proxy_buffering off;
proxy_request_buffering off;
proxy_read_timeout 30m;
proxy_send_timeout 30m;
send_timeout 30m;
```

Nginx defines `proxy_read_timeout` between successive upstream reads, and disabling `proxy_buffering` passes streamed bytes onward as they arrive. See the [official proxy module documentation](https://nginx.org/en/docs/http/ngx_http_proxy_module.html).

For Traefik, set the entry point response write timeout to zero (unlimited) or above the longest request, and attach a `ServersTransport` with a response-header timeout of zero or at least 30 minutes:

```yaml
# Static configuration
entryPoints:
  websecure:
    transport:
      respondingTimeouts:
        writeTimeout: 0s

# Dynamic configuration; reference this transport from the Ollama proxy service
http:
  serversTransports:
    ollama-long:
      forwardingTimeouts:
        responseHeaderTimeout: 0s
```

Traefik documents zero as no timeout for both [entry-point responding timeouts](https://doc.traefik.io/traefik/reference/install-configuration/entrypoints/) and [ServersTransport response-header timeout](https://doc.traefik.io/traefik/reference/routing-configuration/http/load-balancing/serverstransport/).

Avoid an orange-cloud Cloudflare path for this local inference API. Cloudflare currently documents a 125-second default proxy read timeout (Enterprise-configurable) and a 30-second proxy write timeout; queued requests can exceed those limits before any protocol-valid response exists. Use LAN/VPN access, DNS-only routing, or an appropriate Enterprise design. See [Cloudflare connection limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/) and its [HTTP 524 guidance](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/).

## Ollama settings and rollout

Keep:

```text
OLLAMA_NUM_PARALLEL=1
OLLAMA_MAX_LOADED_MODELS=1
```

After validating that all applications use the proxy, reduce `OLLAMA_MAX_QUEUE` gradually (for example, 32 and later 16). Do not expose direct Ollama to application traffic, or direct requests can bypass serialization.

Recommended rollout:

1. Deploy the proxy and confirm `/readyz` and `/status`.
2. Point Odysseus at it and verify that logs report `detected_client: odysseus` with `identification_method: fallback`.
3. Set `FRIGATE_SOURCE`, point Frigate at the proxy, generate controlled events, and verify that logs report `identification_method: source_ip`.
4. Observe response latency, drops, and model switches for at least a day before tuning holds/batches.
5. Only then reduce Ollama's internal queue.

The Ollama-compatible inference and model-management surface has no authentication layer, matching Ollama's local API model. Bind/publish it only on a trusted LAN or protect it with an authenticated reverse proxy/firewall. `ADMIN_TOKEN` protects administrative interfaces and media, but it does not protect ordinary Ollama routes. Do not expose model-management endpoints to untrusted callers.

## Development and tests

```sh
npm ci
npm test
npm run test:coverage
```

The tests use Node's built-in test runner and HTTP mocks. Coverage includes strict priority and balanced scheduling, same-model client holds, higher-priority hold bypass, bounded payload memory and metric cardinality, endpoint safety classification, streaming errors/draining, unload-before-switch, recovery latching, maintenance persistence, Frigate discovery/regeneration state transitions, settings validation/restarts, status/metrics, durable media jobs and authenticated ComfyUI routing. Live Frigate media access, ComfyUI execution and ROCm hardware recovery require deployment acceptance tests.
