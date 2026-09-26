# Optional AMD host telemetry and bounded Ollama recovery

This helper runs **on the Ollama Ubuntu host**, outside Docker. It is optional;
updating the intermediary image does not install it or grant host privileges.
Telemetry and automatic recovery are separately opt-in in the intermediary.

The restricted `ai-intermediary-host` account runs
`ai-intermediary-host.service`. Its Unix socket is
`/run/ai-intermediary-host/control.sock`, and its persistent recovery journal is
`/var/lib/ai-intermediary-host/state.json`. The guided installer configures the
`ai-intermediary` Compose service. Never run two host helpers or reset their
recovery journals to bypass restart limits.

## Optional ComfyUI process ownership (read-only)

The AI intermediary can distinguish trusted ComfyUI workers from unrelated GPU
processes when this helper is updated and the host administrator adds an explicit
unit allowlist to the existing root-owned `/etc/ai-intermediary-host.env`:

```dotenv
COMFYUI_SYSTEMD_UNITS=comfyui.service
```

Use the actual local systemd unit name; up to eight distinct names may be comma
separated. Do not list `ollama.service`. An empty or absent value trusts no
ComfyUI workers. The installer preserves a valid existing allowlist on upgrade;
it does not install ComfyUI or automatically choose trusted units.

After editing this host file, restart **only the helper** to load the setting.
The helper uses unprivileged, read-only `systemctl show`, checks the service
invocation and exact cgroup membership before and after the hardware sample, and
checks each GPU PID's kernel start identity. A process named `comfyui` or `python`
is not evidence of ownership. Missing permissions, changed service incarnations
or ambiguous samples never produce `is_comfyui: true`.

This setting grants **no ComfyUI restart permission**. The sole sudoers command
remains `systemctl restart ollama.service`; GPU resets and host reboots remain
unsupported. Known ComfyUI workers still block the existing Ollama automatic
recovery path, just like other non-Ollama work. The shared media broker combines
this attribution with actual workflow completion, fresh telemetry, VRAM and
stable-sample checks before handing the GPU to another engine. Attribution alone
does not prove completion or give a remote backend process ownership.

The initial hardware target is an AMD GPU supported by AMD SMI, including the
reported Radeon AI PRO R9700 / AMD SMI 26.2.2 setup. NVIDIA support is not implied.

The only host-control operation implemented is **restart `ollama.service`**.
There is no GPU reset, reboot, driver reload, arbitrary command, remote shell,
arbitrary service selection, or process-kill API. Restarting Ollama interrupts
all of its clients, including clients that bypass the intermediary. Route all
inference through the intermediary and keep its upstream Ollama port private.

## Safety contract

- Unix HTTP socket only: `/run/ai-intermediary-host/control.sock`, mode 0660.
  Directory mode 0750. Filesystem/group membership is the authorization boundary;
  membership grants recovery control, not just telemetry. No TCP listener or
  additional browser token is used between the intermediary and helper.
- Dedicated unprivileged service account with `render` / `video` access.
  Only fixed read-only AMD SMI/systemd queries and bounded Linux `/proc` reads
  are used for telemetry and process identity.
  GPU device permissions themselves are not a hardware read-only sandbox.
- Root-owned helper code/configuration and an exact sudoers rule permitting only
  `/usr/bin/systemctl restart ollama.service`. No Docker socket or privileged
  intermediary container is needed.
- Before restart: fresh device/process data must be known, GPU processes must
  belong to the managed Ollama systemd cgroup, and `KillMode=control-group` is
  required. An unrelated process, partial process list, missing VRAM information,
  changed service identity, corrupt state, or unreadable cgroup stops recovery.
- After restart: the systemd invocation must change; every recorded old worker
  PID/start-time identity must be gone; the new main PID must be in the service
  cgroup. GPU processes must be empty, activity at most 1%, and residual VRAM no more
  than 512 MiB. These checks are in addition to, not a substitute for, the
  intermediary's independent idle samples and empty Ollama model list.
  Raising the intermediary's idle-VRAM threshold does not raise this separate
  helper ceiling; unsupported or higher-baseline hosts require manual review.
- Maximum **two restart dispatches per rolling hour**, minimum **five minutes**
  between dispatches. State and limits survive helper/container/service restarts.
  The intermediary additionally limits an individual recovery incident to **two
  attempts**; neither its per-incident limit nor these independent host limits
  are bypassed by clicking retry.
- A UUID operation ID is durably recorded **before** a restart. Retrying that same
  ID never restarts the service again, even after a timeout or helper crash. An
  uncertain operation with saved worker/boot evidence can be verified again via
  a read-only GET. Transient post-restart activity does not permanently freeze
  its outcome. The intermediary bounds the verification window; missing proof,
  a changed host boot, or persistent activity remains blocked. Uncertain
  records without proof still require manual verification. The operation is
  never silently reissued. Do not delete the journal to clear a limit.
- Inactive/unknown GPU telemetry never becomes a fictional zero. Process names
  and per-process VRAM may be unavailable. Reported physical VRAM is distinct from
  Ollama's loaded-model allocation and from CPU-visible VRAM/GTT.

An idle GPU reading by itself does **not** clear the intermediary's recovery
latch. The changed service incarnation and old-worker termination are the
recovery boundary. Manual pause remains a separate state; recovery must not
resume inference while an operator pause is active.

The helper keeps up to four durable service-incarnation observations, including
worker PID/start-time identities and host boot ID. It can verify an external
systemd/operator replacement only if the new main process started strictly after
the incident and every recorded old worker is gone. An unchanged service or
idle hardware without prior observations is insufficient. Incarnation evidence
does not prove that arbitrary GPU workloads are safe: non-Ollama work still blocks
automatic recovery.

Host-helper wire protocol (`ollama-intermediary-host-v1`):

- `GET /v1/status`: adds `memory`, capability flags, and captured systemd OOM evidence.
- `GET /v1/ollama/operations/<uuid>`: rechecks a known operation; unknown IDs never create one.
- `GET /v1/ollama/replacement?since=<Unix-seconds>`: read-only external-replacement proof.
- `POST /v1/ollama/restart`: unchanged authorization and durable operation ID;
  a repeated ID may recheck its result but can never dispatch another restart.

Worker/boot proof is private to the host journal, not returned to the browser.

## Updating the installed helper

1. In the dashboard, pause inference **until manually resumed** and wait for
   active work to drain. Disable automatic recovery in Settings during the update.
2. Update the intermediary using your normal source-build or published-release
   procedure, preserving configuration, secrets, Compose overrides and state volumes.
   Update this repository/deployment bundle too; updating only the container does
   not update the host-installed Python helper.
3. On the Ollama VM, as the normal Docker-capable user, run the updated installer:

   ```bash
   cd /opt/ai-intermediary
   python3 integrations/host/install.py
   ```

   Review its plan and confirm. It replaces the helper code/service definition,
   preserves the host journal, and restarts the helper—not Ollama. Existing
   supported Compose mounts/groups are merged without duplication. Advanced
   deployments can instead reinstall the helper files using the manual steps
   below and explicitly restart `ai-intermediary-host.service`; preserve the
   configured environment file and both recovery journals.
4. Verify that both physical GPU readings and **Host RAM & swap** are fresh.
   Re-enable automatic recovery. For an existing lock use **Check / recover now**;
   an operation without sufficient process-identity proof may still require manual host verification
   and acknowledgment procedure. Do not clear a lock just because the GPU looks idle.
5. Resume maintenance explicitly when verification succeeds. Guarded catch-up
   will wait if RAM data is missing or below its floor, retaining all jobs.

## Host memory and Ollama cache budget

GPU VRAM and VM system RAM are separate resources. Serial GPU inference does not
limit the RAM peak of one request or the RAM occupied by cached prompt states.
The helper reads host `MemAvailable` (including reclaimable memory), swap use,
optional PSI `full avg10`, and the system-wide `oom_kill` counter. Missing values
remain unknown. An occupied swap file is not itself proof of active pressure.

Avoid ballooning away RAM needed by this workload and leave sufficient real
memory for the hypervisor and other VMs. The default admission floors (2 GiB for
catch-up, 4 GiB for context rescue) are starting safeguards, not a measured safe
request size. A 30 GiB VM or 32 GiB GPU does not establish a tested context cap.

For **Ollama 0.34.0's llama-server runner**, an optional operator-managed reduction
of the prompt-state RAM cache is `LLAMA_ARG_CACHE_RAM=1024` (MiB). This limits that
cache, not total process RAM or the model's context. Smaller caches can reduce
reuse and require more recomputation. Ollama's [pinned runner version](https://github.com/ollama/ollama/blob/v0.34.0/LLAMA_CPP_VERSION)
uses llama.cpp b10760, which defines [this cache control](https://github.com/ggml-org/llama.cpp/blob/b10760/common/arg.cpp#L1608).
Recheck support after changing Ollama/runner versions; this is not a universal
Ollama setting. The installer does **not** apply it automatically.

If choosing this mitigation, keep inference paused and automatic recovery off.
Run `sudo systemctl edit ollama.service` on the Ollama host and add the following
to the editable section, preserving existing overrides:

```ini
[Service]
Environment="LLAMA_ARG_CACHE_RAM=1024"
```

Then run `sudo systemctl daemon-reload` and `sudo systemctl restart ollama.service`.
This interrupts Ollama clients, so do it only after draining. Re-enable recovery,
verify/acknowledge any existing lock safely, and resume deliberately. Inspect
runner startup/cache diagnostics after the next normal load to confirm a
1024 MiB budget before relying on it. Do not stress-test production memory merely
to validate this upgrade. This setting belongs to native Ollama's service, **not**
the intermediary's `secrets.env` or Frigate's provider options.

## Recommended: interactive one-command setup

The helper is **custom code in this repository**, not a service supplied by AMD
or Ollama. It uses the installed AMD SMI tool for readings and systemd for the
single allowed restart operation. It does not install or update GPU drivers.

Update the intermediary container to version 1.4 or later first. In the dashboard,
pause inference **until manually resumed** and wait for the active request to finish. Leave automatic
recovery disabled during installation. Then, as your normal Docker-capable user
on the Ollama VM (**not** inside the container and **not** prefixed with sudo):

```bash
cd /opt/ai-intermediary
python3 integrations/host/install.py
```

The script performs preflight, displays a plan, asks you to type `INSTALL`, and
then asks for sudo authorization. For preflight without installation:

```bash
python3 integrations/host/install.py --check
```

It detects the effective Ollama URL through the running intermediary's local
settings API (including saved UI overrides), checks that it resolves to this VM,
locates a root-owned AMD SMI executable, and checks the native Ollama service.
Settings/observability credentials stay inside the container; they are never
printed or passed on the host command line. Existing tokens must be configured.
If AMD SMI is not on PATH, supply `--amd-smi /absolute/path/to/amd-smi`.

After confirmation it creates the restricted account, installs the reviewed
helper/service/sudoers files, verifies dedicated-account GPU access, and starts
only the **helper**. It then safely merges the helper socket/group into
`docker-compose.override.yml`, validates the effective Compose configuration,
and recreates **only the paused intermediary**. It verifies helper access from
inside the recreated container. No Ollama restart, inference, GPU reset, host
reboot, driver installation, or deletion of persisted state is part of setup.

Existing Compose settings are preserved. The script checks the complete resolved
Compose configuration and refuses unrelated changes, including a different state
volume. Backups are in a private directory under
`~/.local/state/ai-intermediary-installer/`; preserve them if setup stops.
The recovery journals, `config.yml`, and `secrets.env` are not rewritten.
Existing helper environment settings are preserved if they match; custom paths
or a different backend require manual review rather than automatic overwrite.
Rerunning does not duplicate helper mounts/groups or reset any restart limits.

The automated path supports the repository's standard `docker-compose.yml` plus
optional `docker-compose.override.yml`, a local Docker engine, native systemd
Ollama over HTTP port 11434, and ordinary YAML mappings/lists. Custom Compose file
lists, remote backends, YAML aliases/custom tags, proxies, or custom ports stop
with instructions to use the manual guide below. It does not guess or flatten
advanced deployment configuration. A failed installation may leave safely
installed components in place; it reports that rather than deleting them during
an automatic rollback.

After success, open **Settings → Host telemetry & automatic recovery**. Enable
host monitoring if a saved UI override kept it disabled, verify fresh metrics,
then explicitly enable automatic recovery. The installer leaves automatic
recovery off. Your manual pause is preserved; use **Check recovery now** for an
existing recovery lock, then resume separately once recovery succeeds.

### What the container can detect

With monitoring disabled, it does not poll for the helper. With monitoring
enabled, it continuously checks its mounted Unix socket. The dashboard reports
missing socket/mount, permission denied, no listener, origin mismatch, stale
readings, or available telemetry. A missing socket **cannot prove** the service
is absent from the VM—it could be installed without a container mount. The host
installer can inspect the actual systemd service. The Settings page describes
setup but intentionally has no privileged install endpoint or Docker socket.

## Manual installation / advanced deployments

Do not run this on the Frigate host. These commands deliberately install a new
local service and a narrowly scoped privilege rule. Review the files first,
pause inference, and use your normal change window. They do **not** restart
Ollama by themselves; enabling auto-recovery can later do so when required.

1. From an updated repository checkout, verify the host prerequisites:

   ```bash
   cd /opt/ai-intermediary
   command -v amd-smi
   getent group render
   getent group video
   systemctl show ollama.service --property=ActiveState,InvocationID,MainPID,ControlGroup,KillMode
   ```

   Require a native systemd `ollama.service` with `KillMode=control-group` and a
   readable cgroup-v2 filesystem. This integration does not manage containerized
   Ollama. Record your existing intermediary upstream `ollama.url` from Settings;
   do not substitute the public intermediary port or the Frigate URL.

2. Create the account **only if it does not already exist**:

   ```bash
   sudo useradd --system --user-group --no-create-home \
     --home-dir /nonexistent --shell /usr/sbin/nologin \
     --groups render,video ai-intermediary-host
   ```

3. Install the reviewed helper and service definition:

   ```bash
   sudo install -d -o root -g root -m 0755 /opt/ai-intermediary-host
   sudo install -o root -g root -m 0644 integrations/host/host_helper.py /opt/ai-intermediary-host/host_helper.py
   sudo install -o root -g root -m 0644 integrations/host/ai-intermediary-host.service /etc/systemd/system/ai-intermediary-host.service
   sudo visudo -cf integrations/host/ai-intermediary-host.sudoers
   sudo install -o root -g root -m 0440 integrations/host/ai-intermediary-host.sudoers /etc/sudoers.d/ai-intermediary-host
   sudo visudo -c
   ```

   If any sudoers validation fails, stop and correct it before continuing. Do
   not broaden the rule to `systemctl *` or passwordless arbitrary `sudo`.

4. For a **new installation**, copy the environment template once:

   ```bash
   sudo install -o root -g root -m 0640 integrations/host/host-helper.env.example /etc/ai-intermediary-host.env
   sudoedit /etc/ai-intermediary-host.env
   ```

   Set `MANAGED_OLLAMA_ORIGIN` to the **exact** origin used as the intermediary's
   upstream `ollama.url`, including its scheme, host spelling and port, e.g.
   `http://192.0.2.10:11434` (documentation address; replace it). An origin mismatch
   blocks automatic recovery. Do not use `http://...:11435` or an `/api` suffix.
   Set `AMD_SMI_PATH` to the absolute installed root-owned `amd-smi` path discovered
   in step 1. The default is `/opt/rocm/bin/amd-smi`.
   On later updates, preserve this configured file instead of copying the template.

5. Check that the dedicated user can read GPU data without sudo, then start only
   the helper. Use your actual AMD SMI path in the first two commands:

   ```bash
   sudo -u ai-intermediary-host /opt/rocm/bin/amd-smi metric --mem-usage --usage --temperature --power --json
   sudo -u ai-intermediary-host /opt/rocm/bin/amd-smi process --json
   sudo systemctl daemon-reload
   sudo systemctl enable --now ai-intermediary-host.service
   sudo curl --unix-socket /run/ai-intermediary-host/control.sock http://localhost/v1/status
   ```

   Expect `protocol: "ollama-intermediary-host-v1"`, correct
   `managed_ollama_origin`, `service.active: true`, and `telemetry.available: true`.
   Per-GPU `processes_known` must be true for automatic recovery. If a command
   requires additional access, investigate the driver/device/cgroup permissions;
   do not run the whole helper as root or give it unrestricted sudo.

6. Give only the intermediary container access to the helper socket:

   ```bash
   getent group ai-intermediary-host
   ```

   Use that group's numeric GID as `HOST_HELPER_GID` in your Compose interpolation
   environment (normally the existing `.env` next to Compose, **not** only a
   container `env_file`). Merge the fragment in
   [`compose.host-helper.example.yml`](compose.host-helper.example.yml) into your
   existing deployment, or save it as an additional Compose file and consistently
   pass both `-f` arguments on all future Compose commands. Preserve existing
   settings, secrets, state volumes, ports and restrictions.

   The bind is the **directory**, read-only, so a helper restart can replace its
   socket without leaving the container attached to an obsolete socket inode.
   A read-only bind still permits connecting to the Unix socket; it prevents the
   container from replacing it. On host reboot, start the helper before recreating
   the container; a missing directory must not become a root-owned Docker-created
   directory. The supplied service preserves it across helper restarts. If the
   runtime directory was recreated, recreate the intermediary
   container as well so its bind refers to the current directory.

   Validate your merged Compose file, then recreate only `ai-intermediary` with
   your normal workflow. Do not run `down -v`. A restart alone does not apply new
   socket mounts, supplementary groups or container environment variables.

7. In the intermediary's Settings, first verify host telemetry is enabled and
   shows fresh physical VRAM separately from Ollama models. Then enable automatic
   recovery in Settings. The Compose example deliberately leaves it off until
   these checks pass. Saved browser settings can override environment defaults.
   Do not deliberately crash the GPU to test recovery. Use the existing recovery
   workflow if already locked; otherwise leave it enabled for future incidents.

## Update, disable and rollback

Updating the intermediary container alone does not update this helper. Review and
reinstall only the root-owned Python/service/sudoers files from step 3, preserve
the configured environment and `/var/lib/ai-intermediary-host/state.json`,
then run `sudo systemctl daemon-reload` and
`sudo systemctl restart ai-intermediary-host.service`. This restarts the
helper, **not Ollama**. Avoid doing this during a recovery operation; interruption
can deliberately leave that operation uncertain instead of risking a second restart.

To turn off automatic restarts, disable automatic recovery in intermediary
Settings. Telemetry can remain enabled. To fully remove access, disable both
features, remove only the optional socket/group/env additions from Compose, and
recreate the intermediary container. Stop/disable the helper with
`sudo systemctl disable --now ai-intermediary-host.service`. Removing its exact
sudoers file additionally revokes restart authority; preserve the journal for
audit and safe rollback. No recordings, Frigate configuration or backlog data is
stored in this helper.

## API / limits

`GET /v1/status` returns protocol, collection-start `sampled_at`, exact managed
origin, systemd service identity, telemetry, and restart-policy availability.
Systemd identity is checked before and after telemetry collection; a change
makes the sample unavailable. Unknown values are `null`, not zero. All metric
numbers are normalized to bytes, percent, degrees C and watts.

`POST /v1/ollama/restart` accepts exactly:

```json
{"operation_id":"11111111-1111-4111-8111-111111111111","expected_invocation_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
```

Normal response fields are `operation_id`, `state` (`completed`, `failed`, or
`uncertain`), `before_invocation_id`, `after_invocation_id`, `restarted`, and an
optional safe `error` code. `restarted:false` on an **uncertain** response does
not prove no restart occurred; it means completion of the command was not
observed. Callers must retain/replay the same UUID and expected identity after
transport errors. Never manufacture a new UUID merely because a call timed out.

Socket requests are serialized. Commands have bounded time and output (2 seconds
per service query, 4 seconds per AMD diagnostic, 45 seconds for restart, 1 MiB
aggregate stdout/stderr); HTTP bodies
are limited to 2 KiB. Status may take up to roughly 12 seconds on a slow host;
clients should use bounded timeouts and label old samples stale. An uncertain
restart is never inferred successful from the HTTP status alone. The journal
retains up to 100,000 operation IDs without silently dropping idempotency history;
reaching that bound stops further mutations for operator maintenance.

## Validation

```bash
python3 -m unittest discover -s integrations/host -p 'test_*.py' -v
```

Tests use mocked AMD/systemd data, temporary files and local Unix sockets; no
sudo, real Ollama restart or GPU mutation is performed. They cover recorded idle
R9700 readings, current/26.x AMD JSON shapes, unknown fields, cgroup ownership,
service-epoch changes, surviving old workers, restart limits, crash-safe UUID
replay, corrupted state, socket mode, request bounds and command timeouts.

References: [AMD SMI CLI](https://rocm.docs.amd.com/projects/amdsmi/en/latest/how-to/amdsmi-cli-tool.html),
[AMD CLI JSON process implementation](https://github.com/ROCm/amdsmi/blob/amd-mainline/amdsmi_cli/amdsmi_commands.py),
[systemd KillMode](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html),
[systemd InvocationID](https://www.freedesktop.org/software/systemd/man/latest/org.freedesktop.systemd1.html).
