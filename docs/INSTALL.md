# Installation and updates

The recommended production installation uses the deployment bundle attached to a GitHub Release. It pulls a prebuilt, versioned image from GitHub Container Registry rather than building or copying the source tree.

## Prerequisites

- A 64-bit `amd64` Linux host.
- Docker Engine with the `docker compose` plugin.
- Network access from the proxy container to the real Ollama API.

Verify Docker:

```sh
docker --version
docker compose version
sudo systemctl enable --now docker
```

Use Docker's official installation instructions when those commands are unavailable.

## Install a release

The following creates a new installation from [Outlain/ai-intermediary releases](https://github.com/Outlain/ai-intermediary/releases). Use the desired published version tag:

```sh
mkdir -p /tmp/ai-intermediary-install
cd /tmp/ai-intermediary-install

gh release download v2.0.2 \
  --repo Outlain/ai-intermediary \
  --pattern 'ai-intermediary-v2.0.2-linux-amd64.tar.gz*'

sha256sum -c ai-intermediary-v2.0.2-linux-amd64.tar.gz.sha256
tar -xzf ai-intermediary-v2.0.2-linux-amd64.tar.gz
sudo mv ai-intermediary-v2.0.2-linux-amd64 /opt/ai-intermediary
sudo chown -R "$USER":"$USER" /opt/ai-intermediary
cd /opt/ai-intermediary

cp config.example.yml config.yml
cp secrets.example.env secrets.env
chmod 600 secrets.env
```

Without GitHub CLI, download the `.tar.gz` and `.sha256` assets from the release page in a browser, then continue at the checksum step.

Edit `secrets.env`:

```dotenv
OLLAMA_URL=http://YOUR_OLLAMA_HOST:11434
FRIGATE_SOURCE=
ADMIN_TOKEN=YOUR_PRIVATE_ADMINISTRATOR_VALUE
```

The supplied configuration treats every unmatched request as Odysseus, so Odysseus needs no IP setting. Set `FRIGATE_SOURCE` to Frigate's stable IP or CIDR when Frigate is connected. It can remain blank until then.

Generate `ADMIN_TOKEN` once with `openssl rand -hex 32`; do not use the literal placeholder. This one human administrator credential protects Dashboard, Settings, maintenance/recovery, Home Assistant administration and the optional media gateway. It is read from the container environment so configuration recovery still works when ordinary YAML is invalid. Never commit it or put it in workflow JSON.

Validate and start:

```sh
docker compose config --quiet
docker compose pull
docker compose up -d
docker compose ps
curl http://127.0.0.1:11435/readyz
```

Open `http://YOUR_UBUNTU_IP:11435/debug` to view the live dashboard and enter `ADMIN_TOKEN` when prompted. For Home Assistant, follow [HOME_ASSISTANT.md](HOME_ASSISTANT.md).

Open `http://YOUR_UBUNTU_IP:11435/settings` to view or change structured application settings. Enter `ADMIN_TOKEN`; it is retained only in the current browser tab's session storage.

The image uses `restart: unless-stopped`, so it returns after Docker or host restarts and after a settings apply. A named Docker volume stores maintenance state, validated settings overrides, and the optional Frigate backlog under `/app/state`; they survive container recreation and upgrades. Container logs rotate at 10 MiB across three files.

For local images and videos, complete the optional [ComfyUI AMD installation](COMFYUI_AMD.md)
and [shared-GPU backend configuration](AI_INTERMEDIARY.md). Keep media disabled until
the bridge, host telemetry and a small local workflow have passed their checks.

## Upgrade

Download and verify each new bundle in a separate temporary directory. **Keep your existing base Compose and override files**, then edit only the service's image reference to the new published tag. Preserve the project and physical state-volume identity:

```sh
cd /opt/ai-intermediary
# Edit only the existing service's image tag; preserve all mounts/project/ports.
nano docker-compose.yml
docker compose config --quiet
docker compose pull ai-intermediary
docker compose up -d --no-deps ai-intermediary
docker compose ps
```

`config.example.yml` is documentation for new installations; do not copy it over an existing `config.yml` during an upgrade. Review its changes and deliberately adopt only options you want. Compose recreates the container while retaining `config.yml`, `secrets.env`, the optional override file, and the named state volume. In-memory queued inference jobs are intentionally not restored; durable Frigate IDs and retry state are restored. Do not run `docker compose down -v` during an update.

Upgrade while idle, or first pause from `/debug` and wait for the active request to drain. Container replacement has a finite stop grace period and is not a safe way to interrupt a long-running GPU request. A persisted maintenance pause remains paused after the update until you resume it.

Strict priority is the default. Choose `balanced` explicitly in Settings only if you want priority aging, maximum-wait promotion and model affinity instead. Updates do not reset connection settings or secrets. Frigate recovery is disabled until you configure and enable it.

## Roll back

Roll back only to a version known to understand the current persisted state.
Never start a version without media-job recovery support against unresolved
media work. At a paused/drained boundary, restore the compatible previous image
reference in your **same existing Compose file**, keeping all project and mount
identities, then run:

```sh
docker compose pull
docker compose up -d
```

The supplied configuration enables GPU-safety draining, unload-before-switch, and latched ROCm OOM recovery. Keep the `gpu_safety` section enabled unless you are deliberately diagnosing one of those mechanisms.

If `/readyz` later reports `recovery_required` and optional automatic recovery is not enabled or is blocked, inspect the host with:

```sh
ollama ps
sudo rocm-smi --showmeminfo vram --showpids
```

Pause the intermediary and wait until no inference/management request is active. Restart Ollama if needed. If `rocm-smi` still shows an `UNKNOWN` process retaining substantial VRAM, stop and investigate the driver/host before acknowledging recovery. This project does not authorize an automatic GPU reset or reboot. Once physical GPU memory is back to its expected idle baseline and `ollama ps` is empty, acknowledge recovery using `ADMIN_TOKEN`. The endpoint requires maintenance to remain paused and independently checks the current loaded-model list:

```sh
read -rsp 'Administrator token: ' ADMIN_TOKEN; printf '\n'
curl -fsS -X POST http://127.0.0.1:11435/_intermediary/v1/recovery/acknowledge \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{"confirm_gpu_recovered":true}'
curl -fsS -X POST http://127.0.0.1:11435/_intermediary/v1/maintenance/resume \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{}'
unset ADMIN_TOKEN
curl http://127.0.0.1:11435/readyz
```

Acknowledgment does not reset hardware and does not resume inference by itself. The separate resume command above deliberately reopens admission only after the acknowledgment succeeds. Run these commands one at a time and stop if acknowledgment returns an error.

## Enable physical GPU monitoring and bounded self-recovery

**Starting the intermediary container alone does not enable host monitoring or service restarts.** Those require the optional helper on the same Linux host as the real Ollama service, not the Frigate host. The helper is also required for ComfyUI's shared-GPU handoffs.

For the standard local Ubuntu/Compose deployment, start the intermediary, pause
inference, leave automatic recovery off, and run this as your normal Docker user:

```bash
cd /opt/ai-intermediary
python3 integrations/host/install.py
```

The interactive installer automates the account/service/permission setup and
safe Compose merge below, asks for confirmation before sudo, validates telemetry
from the host and container, and preserves the paused state. It never restarts
Ollama during setup. Use `--check` for a non-installing preflight. After success,
verify monitoring in Settings, then explicitly enable automatic recovery. See
the [installer prerequisites and safeguards](../integrations/host/README.md#recommended-interactive-one-command-setup)
for supported deployments; advanced layouts use the manual procedure below.

1. Start the intermediary using your chosen source or release installation method, then pause and drain it. Preserve `config.yml`, `secrets.env`, saved settings and all state volumes. Host monitoring and automatic recovery stay disabled until explicitly enabled.
2. Follow [the host helper installation guide](../integrations/host/README.md) on the Ollama host. Its manual steps install an unprivileged, Unix-socket-only helper and narrowly scoped permission to restart **only `ollama.service`**, with an independent persisted limit of two restarts per hour and a five-minute cooldown. It has no GPU-reset or reboot permission. Review the service, environment, and sudoers artifacts before installing them; the interactive installer above automates these steps only after your confirmation.
3. Merge the supplied host-helper Compose example into the existing `docker-compose.override.yml`, preserving other overrides. Mount only the helper runtime directory and add its numeric socket group. Do not mount the Docker socket, host filesystem root, or GPU devices into the intermediary. Do not make the helper socket world-writable. If Ollama runs on a different host from the intermediary, this local-socket integration cannot be used as-is.
4. Enable only host monitoring first. Use **Settings → GPU safety** or the host-managed `HOST_HELPER_ENABLED=true` environment opt-in. Recreate the container after adding socket mounts/groups or changing environment variables. Inspect the dashboard for fresh physical VRAM/process telemetry and the correct Ollama service identity.
5. Once the helper is verified, enable `auto_recovery.enabled` in Settings, or establish the base opt-in with `AUTO_RECOVERY_ENABLED=true` in `secrets.env`. Environment values do not override previously saved UI overrides. Validate/apply, then explicitly resume a deliberate maintenance pause when ready; automatic recovery never resumes it for you.
6. Check the recovery panel after the next real failure. A protected **Check recovery now** action may be used for an already latched incident. It cannot bypass the **two-attempt limit for that incident**, the **two-per-rolling-hour limit**, or the **five-minute cooldown**; it is not a force-reset button. After two unsuccessful attempts, waiting another hour does not grant more attempts for that incident. Investigate the persistent failure and acknowledge recovery manually only after verifying the host. Never deliberately crash or exhaust production VRAM just to test the feature.

Default verification requires three fresh stable samples, no loaded Ollama models, no reported GPU processes, and no more than 512 MiB used VRAM per GPU after a confirmed service restart. The application baseline can be lowered for stricter checks, but increasing its setting above 512 does not bypass the helper's independent 512 MiB ceiling. Do not raise thresholds to hide a stuck process. Missing or stale telemetry is unknown, not a healthy reading. Persistent driver faults, non-Ollama GPU workloads, helper failures, and exhausted restart limits keep admission locked for operator investigation.

The automatic recovery ledger lives at `/app/state/auto-recovery.json`, alongside the existing GPU safety latch and catch-up state. Preserve it during updates. The helper maintains its own host-side ledger independently. Deleting either ledger to bypass a cooldown defeats the safety boundary and is not a recovery procedure. Restarts of Ollama interrupt every direct Ollama client, so route production clients through the intermediary to preserve the single-inference and pause guarantees.

For AMD systems with `amd-smi` already installed, read-only checks are:

```sh
amd-smi version
amd-smi metric --mem-usage --usage --temperature --power
amd-smi process --general
ollama ps
```

One-at-a-time scheduling prevents overlapping admitted inference, but it cannot prevent every driver or transport failure. This feature adds bounded recovery when it can be established safely; it never resets a GPU or reboots Ubuntu. Context-overflow requests still need Frigate/model input configuration fixes, not service restart loops.

## Install from source instead

```sh
git clone https://github.com/Outlain/ai-intermediary.git
cd ai-intermediary
cp config.example.yml config.yml
cp secrets.example.env secrets.env
chmod 600 secrets.env
docker compose up -d --build
```

The two `cp` commands above are for a first installation only. Never run them over an existing installation during an upgrade.

For a source update, leave `config.yml`, `secrets.env` and `docker-compose.override.yml` in place and review tracked Compose changes before pulling:

```sh
cd /opt/ai-intermediary
git pull --ff-only
docker compose config --quiet
INTERMEDIARY_BUILD="$(git rev-parse --short HEAD)" docker compose build ai-intermediary
docker compose up -d --no-deps ai-intermediary
docker compose ps
curl -fsS http://127.0.0.1:11435/readyz
```

Those three local deployment files are ignored by Git, and the named state volume is outside the source tree. However, `docker-compose.yml` is tracked: a changed project or volume name can select a different volume even without deleting the old one. Verify the effective service/project/mount identities before recreating anything.

The build argument labels the running source build in the status snapshot. `docker compose config --quiet` validates without printing resolved secret values; if inspecting the full merged Compose output, do not paste its environment values publicly.

If `git pull` says a locally modified tracked `docker-compose.yml` would be overwritten, preserve that edit while updating:

```sh
cd /opt/ai-intermediary
git stash push -m "local Compose settings before upgrade" -- docker-compose.yml
git pull --ff-only
git stash pop
docker compose config
docker compose up -d --build
```

If `git stash pop` reports a conflict, do not discard either side. Keep the new project defaults and move only the host-specific values into `docker-compose.override.yml`, then run `docker compose config` again. Even without a conflict, migrating local base-file edits into the ignored override prevents the next pull from stopping. First retain a patch copy of the exact local edit:

```sh
git diff -- docker-compose.yml > /tmp/ai-intermediary-compose-local.patch
```

A small override looks like this:

```yaml
services:
  ai-intermediary:
    environment:
      LOG_LEVEL: debug
```

After host-specific values are represented in the ignored override, restore the tracked base file once with `git restore docker-compose.yml`, then run `docker compose config` again and confirm the merged service still contains those values before recreating it. The temporary patch remains available if the override needs correction. Future `git pull --ff-only` updates will then be straightforward. Do not use `cp -f config.example.yml config.yml`, `git reset --hard`, or a whole-tree replacement as an update procedure.

## Exposure

The default mapping exposes host port `11435` on every interface. For local-only access, change it to:

```yaml
ports:
  - "127.0.0.1:11435:11434"
```

Inference remains compatible with Ollama's unauthenticated local API. Keep it on a trusted LAN/VPN or place it behind an authenticated reverse proxy. `ADMIN_TOKEN` protects human-facing administration, not ordinary Ollama inference routes. Prevent applications from reaching Ollama directly, or they can bypass scheduler serialization and maintenance pause.

## Settings page and configuration recovery

Open `http://YOUR_UBUNTU_IP:11435/settings` and enter `ADMIN_TOKEN`. The page exposes only structured application settings that the intermediary knows how to validate. It never edits raw YAML, `config.yml`, `secrets.env`, Docker Compose, Docker networks, volumes, ports, or the Docker socket.

The effective configuration is assembled in this order:

1. The operator-managed, read-only `config.yml` provides the base.
2. Validated overrides from `/app/state/settings.json` replace matching editable values.
3. Host-managed tokens remain supplied by `secrets.env`; their values are never sent to the browser.

The page requires validation before apply. A successful apply atomically saves a new revision and the prior last-known-good override, stops new inference admission, waits for dispatched work to finish before shutdown, and exits with status 75. Docker's supplied `restart: unless-stopped` policy restarts the service with the new effective configuration. If you deploy without Compose, configure a supervisor such as systemd with `Restart=on-failure`; a foreground process cannot restart itself.

## Enable Frigate object and review recovery

1. Keep Frigate's Ollama provider pointed at this intermediary. Verify live requests are identified as `frigate` before enabling recovery.
2. Set `FRIGATE_URL` in `secrets.env` to the reachable Frigate origin (for example `https://YOUR_FRIGATE_HOST:8971`, without `/api`). For an authenticated endpoint, supply `FRIGATE_USERNAME` and `FRIGATE_PASSWORD`, or `FRIGATE_AUTH_TOKEN`, for an administrator-capable connection. Use trusted TLS, and do not put credentials into the URL or UI. If you deliberately use the open internal API, use its reachable HTTP address (commonly port 5000), leave credentials unset, and select **No login required — trusted local API** in the Catch-up settings. Restrict that open API to trusted hosts.
3. Recreate the intermediary after environment changes: `docker compose up -d --force-recreate ai-intermediary`. Do this at an idle/paused boundary.
4. Open `/settings`, enable Frigate recovery, and validate/apply. Normal discovery starts at enablement, not weeks of old history. Retained connection settings and the existing state volume are reused.
5. Confirm the dashboard reports both object and review API capabilities. Review regeneration requires a Frigate build exposing the individual review regeneration API; Frigate 0.18 lacks it, while the targeted development build `0.19.0-bb6c2e9` includes it. For correlated completion reports and the faster pipeline, separately prepare and deploy the [pinned Frigate bridge](../integrations/frigate/README.md). The intermediary does not modify or replace Frigate automatically. Without that bridge the dashboard explicitly shows compatibility mode.
6. Test one retained object and one ended review. Check that the descriptions actually appear in Frigate; an accepted API request is not yet success. Then use **Fill missing descriptions** only if you want to include older retained items.

Catch-up respects current per-camera settings, works newest-first behind live requests, and stores IDs/state rather than images. Frigate must still retain the appropriate snapshots/recordings. Missing media and deleted events are reported rather than reconstructed. The existing live HTTP queue can still time out; the durable backlog provides a later regeneration path instead of holding each connection open for hours.

Check camera warnings before enabling a large historical scan. Object recovery excludes early-trigger-only cameras because retained events do not reveal whether their significant-update trigger fired; it does not change those Frigate settings. The final fresh description check avoids ordinary duplicate work, but Frigate provides no atomic no-overwrite guarantee against a separate live/manual completion. A full backlog pauses discovery without discarding queued items; newest-first ordering covers discovered jobs ready to run, not items still waiting to be discovered.

The backlog is tied to the configured Frigate server address. Changing its host, port, or HTTP/HTTPS scheme stops catch-up with `backlog_origin_changed`; it does not erase the old jobs or send their IDs to a different server. Restore the original address to resume that backlog. For an intentional server migration, disable catch-up and configure a different persistent `frigate.state_path` on the host before re-enabling, keeping the old state file intact. Discovery starts anew; **Fill missing descriptions** can rediscover retained work on the new address. Prefer stable DNS or a reserved IP to avoid unnecessary migrations.

See the [README catch-up section](../README.md#frigate-description-catch-up) for timing limits and the [Home Assistant optional sensors/action](HOME_ASSISTANT.md) for quick-view controls. Production API permissions, media availability, and GPU stability still need verification on your actual deployment.

### Catch-up defaults and validation

Defaults are **2s confirmation**, **1m cleanup / 25 jobs per pass**, **24h attention flagging**, **1,000 combined completed/skipped history records**, and **4 descriptions awaiting save**. Discovery remains on its own interval, normally 30s. With verified bridge support, one native attempt can run while up to four finished attempts await saving; a known native failure releases the next eligible job promptly. Without the bridge, one unconfirmed handoff remains the limit. Both modes always retain one GPU inference at a time and back off temporary API failures.

In `/settings`:

1. Under **Catch-up**, keep **Maximum retry delay** at `5h` initially. Retries continue with increasing delays; the 24h attention flag is informational, not a stop condition.
2. Under **Frigate**, keep **Ollama keep-alive** at `2m` initially. This can reduce reloads; it does not extend Frigate's scheduler priority or change its idle hold. Exact-model overrides can still supersede the client policy.
3. Under **Catch-up**, keep **Maximum descriptions awaiting save** at `4` initially. It only controls pending save checks with the bridge, not simultaneous GPU requests. Verify **Frigate bridge connected** appears after installing the separate pinned integration; a Frigate version number alone does not enable this mode.
4. Validate/apply at an idle/paused boundary. Verify an object and a review description are saved, then verify Odysseus and live Frigate still take priority over queued catch-up. Resume inference explicitly if maintenance pause is active.

Use the dashboard's separate **Retrying / Needs attention** views to investigate failures. **Retry when idle** still respects priority, pause, and outstanding generations. The cleanup pass checks for deleted events/missing media independently of GPU availability; it does not blindly expire everything older than two weeks. **Recheck availability** can revisit media that later becomes available. Recent completed/skipped rows roll off at the chosen limit, not pending jobs, lifetime totals, or Frigate's descriptions. Increasing history cannot restore rows that already rolled off before upgrading.

The [Home Assistant guide](HOME_ASSISTANT.md) provides optional status sensors and administrative actions.

### Context-size failures and apparent catch-up stalls

An Ollama HTTP 400 such as `request (14407 tokens) exceeds the available context size (8192 tokens)` means the images/text do not fit the configured context window. It is not a scheduling-priority decision. In the targeted Frigate build `0.19.0-bb6c2e9`, the Ollama provider reads `provider_options.options.num_ctx`. In Frigate's **Settings → Enrichments → Generative AI**, edit the provider's **Provider options** field, preserving its other settings. For that specific 14,407-token failure, 16,384 is a reasonable first trial:

```yaml
keep_alive: 2m
options:
  num_ctx: 16384
```

This is the content of the Provider options field, not a replacement Frigate configuration. Save/apply through Frigate and follow any restart prompt. Test a single affected item and verify its saved description. Larger context uses more memory, and future requests or Frigate's frame selection can still exceed it; avoid blindly increasing it repeatedly. See [the pinned provider implementation](https://github.com/blakeblackshear/frigate/blob/bb6c2e9/frigate/genai/plugins/ollama.py) and [Ollama's context/memory guidance](https://docs.ollama.com/context-length).

In compatibility mode the intermediary can continue showing **Waiting Result** until its confirmation window expires even after generation fails. With the pinned bridge, a matched final native failure enters backoff promptly and another eligible job can proceed; successful generation waits for its saved description separately. Missing reports and uncertain transport outcomes still use conservative safety guards. The queue is retained, but retrying cannot fix an unchanged oversized request. A separate `llama-server terminated ... signal: killed` line does not by itself establish an out-of-memory cause; inspect surrounding service/kernel logs. Successful `/api/tags` and `/api/ps` probes prove API reachability, not successful model inference.

### Enable conservative context rescue (optional)

Updating alone leaves this feature disabled. Keep your normal Frigate `num_ctx` and existing bridge image unchanged.

1. Verify **Frigate bridge connected** and working, fresh physical GPU monitoring from the existing host helper. A service-restart policy is not required for rescue; host monitoring is.
2. Independently validate a higher maximum with this exact model/quantization and GPU/Ollama configuration. Leave rescue off if you have not done so. VRAM capacity alone is insufficient; there is no preselected safe higher value.
3. In **Settings → Catch-up → Conservative context rescue**, enter the exact tested model tag, tested maximum context and enable the feature. Keep the initial output reserve of `2048` and safety margin of `1024` unless your workload requires more. Validate/apply at a safe idle/paused boundary.
4. Resume inference if paused. A newly observed, typed context-overflow rejection on a correlated catch-up job supplies the input measurement. A later identical request can use its one bounded rescue after the normal retry delay. Existing generic `http_400` history is not sufficient evidence; there is no immediate replay of old payloads.
5. Inspect the job's context-rescue details and verify the resulting description in Frigate. **Retry when idle** respects all safety checks and cannot reset an already-used rescue. Missing telemetry, activity, an unverified model limit or an insufficient cap block the enlarged dispatch with an explanation.

See [the complete rescue policy](../README.md#error-only-context-rescue) for limits. It does not raise context for live traffic or Odysseus, delete images to make a request fit, or respond to GPU/OOM failures by allocating more memory. Ordinary retry/backoff and needs-attention behavior remain; one larger attempt is not an unlimited escalation loop.

## Configuration recovery

If application configuration is invalid, the intermediary starts a restricted recovery listener on the same container port. In recovery mode:

- `/settings` and `/healthz` remain reachable.
- `/readyz`, `/status`, inference, and model-management routes return HTTP 503.
- Safe, editable application values can be validated and applied from the page.
- Invalid YAML, missing host-only credentials, an invalid `SETTINGS_PATH`, a bad volume mount, or Compose/listener problems must be fixed on the host.

The settings API is locked unless `ADMIN_TOKEN` exists in the container environment, including during recovery. After changing `secrets.env`, recreate the container so Docker loads the new value:

```sh
docker compose up -d --force-recreate
```

If a value changed in `config.yml` still appears unchanged, it probably has a saved browser override. The settings page displays the effective value and its persisted revision. Reset the relevant override before expecting the base-file value to win.

## Exclusive GPU maintenance

For a planned GPU-heavy task, keep the intermediary running and pause scheduling instead of shutting down both services. This gives callers an explicit HTTP 503 response, safely drains any request Ollama has already accepted, fails queued work, unloads the current model, and confirms the unload before declaring the GPU released.

The pause request receives HTTP 202 after its state is persisted. Drain and unload continue asynchronously, so always check maintenance status before starting the external workload.

You can use the **Pause mode** card on `/debug`; enter `ADMIN_TOKEN`, choose a manual or timed pause, and wait for **GPU released: Yes**. The equivalent API commands are below.

Prompt for the administrative token without putting it in shell history, then start a manual pause:

```sh
read -rsp 'Administrator token: ' ADMIN_TOKEN; printf '\n'
curl -fsS -X POST http://127.0.0.1:11435/_intermediary/v1/maintenance/pause \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{"reason":"exclusive GPU task"}'
```

Use a timed pause only when the task has a reliable upper bound:

```sh
curl -fsS -X POST http://127.0.0.1:11435/_intermediary/v1/maintenance/pause \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{"duration":"4h","reason":"exclusive GPU task"}'
```

`duration` must be greater than zero and no longer than `maintenance.max_pause` (`168h` by default). Its clock starts after drain and confirmed model unload, not when the pause request first arrives.

Check the dashboard or authenticated status snapshot. Start the external workload only when `maintenance.state` is `paused`, `maintenance.gpu_released` is `true`, and `maintenance.unload_error` is null. If unload fails, the intermediary reports `maintenance.state: error`; inspect Ollama and GPU state instead of assuming VRAM was released.

For a workload that needs virtually all VRAM, also confirm host-level allocation with `sudo rocm-smi --showmeminfo vram --showpids`. The intermediary's `gpu_released` assertion proves that Ollama's `/api/ps` is empty; it cannot prove that a failed ROCm process has not left a driver-level allocation behind.

Resume after the other task finishes:

```sh
curl -fsS -X POST http://127.0.0.1:11435/_intermediary/v1/maintenance/resume \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{}'
unset ADMIN_TOKEN
```

Ollama normally may remain running because the confirmed unload frees its model VRAM. If clients can bypass the intermediary or process-level isolation is required, wait for `gpu_released: true`, run `sudo systemctl stop ollama`, and leave the intermediary online. Run `sudo systemctl start ollama` and verify `curl -fsS http://127.0.0.1:11434/api/tags` before resuming. A manual pause is safest when task duration is uncertain because a timed pause intentionally resumes admission at expiry.
