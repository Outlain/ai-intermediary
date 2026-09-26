# AI Intermediary's local ComfyUI bridge

This custom extension is part of this repository, not an AMD or ComfyUI vendor
service. It prevents raw ComfyUI submissions from bypassing the shared GPU
scheduler and provides narrowly scoped deletion of broker-owned output copies.
It does not install ComfyUI, download models, start a GPU job, restart services,
reset the GPU, or reboot the host.

Use the intermediary's authenticated media interface. Direct access to the raw
ComfyUI browser and API is intentionally denied without the shared bridge token.
The intermediary adds that token when forwarding authorized requests; do not put
the bridge token in URLs, browser workflow JSON, or public configuration files.

## One-time installation

For a new Ubuntu/AMD host, follow the complete
[ComfyUI installation guide](../../docs/COMFYUI_AMD.md), including the isolated
ROCm Python environment, GPU smoke test and managed service. The steps below
describe the bridge itself for an already-installed ComfyUI backend.

First install and validate a **local** ComfyUI environment separately, using the
appropriate AMD PyTorch/ROCm dependencies. Do not replace the working Ollama
runtime. The example paths below assume ComfyUI is installed at `/opt/ComfyUI`
and the repository is at `/opt/ai-intermediary`; substitute your actual
absolute paths. The ComfyUI service should run as an unprivileged account.

Keep intermediary media support disabled while making these changes. Install
only these two extension files; no additional Python package is required beyond
ComfyUI's existing aiohttp dependency:

```sh
sudo install -d -m 0755 /opt/ComfyUI/custom_nodes/ai_intermediary_bridge
sudo install -m 0644 /opt/ai-intermediary/integrations/comfyui/__init__.py /opt/ComfyUI/custom_nodes/ai_intermediary_bridge/__init__.py
sudo install -m 0644 /opt/ai-intermediary/integrations/comfyui/bridge.py /opt/ComfyUI/custom_nodes/ai_intermediary_bridge/bridge.py
```

For an existing bridge installation, preserve the previous two files before
replacing them so a rollback is possible. Updating files takes effect only after
ComfyUI restarts; wait for active generation to finish first.

Use the intermediary's existing **`ADMIN_TOKEN`** for human login. ComfyUI gets a
separate derived machine credential, not that administrator password. After the
intermediary container is running, provision the private environment file with:

```sh
sudo python3 scripts/configure-comfy-auth.py --container ai-intermediary --check
sudo python3 scripts/configure-comfy-auth.py --container ai-intermediary --yes
```

Run these from the checkout or release bundle containing the script. It obtains
the credential via a private pipe, preserves unrelated environment settings and writes root-owned
mode-`0600` `/etc/ai-intermediary/comfy.env`. It does not display the credential,
install ComfyUI, or start/restart any service. The generated setting is
`AI_INTERMEDIARY_COMFY_TOKEN`; never put the human administrator password there.

No second human secret is needed. Changing `ADMIN_TOKEN` changes the derived
machine credential: rerun this setup at a paused/drained boundary and restart
only the already-configured ComfyUI service before enabling media again.

Add an `EnvironmentFile` entry to the existing service or a systemd drop-in:

```ini
[Service]
EnvironmentFile=/etc/ai-intermediary/comfy.env
```

Preserve the existing service account, virtual environment, working directory
and launch options. Add **`--disable-api-nodes`** to the existing ComfyUI launch
command. The bridge reports `local_only: false` and rejects generation if that
flag is missing, even when the token matches. Exclude partner/cloud nodes from
all workflows; no cloud account or API key is required.

After editing the service, reload systemd and restart **only that ComfyUI
service**, once active work is finished. Do not restart the whole VM. Use your
actual service name rather than assuming `comfyui.service` already exists.

Bind ComfyUI to an appropriate private interface and restrict its raw port with
the host firewall to the intermediary. A container cannot reach a host service
bound only to the host's loopback through the host's LAN address. Choose the
network binding explicitly; do not expose the raw ComfyUI port to the internet.

The intermediary's connection check calls authenticated
`GET /intermediary/status`. A ready bridge reports:

```json
{
  "protocol": "ai-intermediary-comfy-v1",
  "local_only": true,
  "queue_guard": true,
  "stable_prompt_ids": true,
  "owned_output_cleanup": true,
  "storage_healthy": true
}
```

It also returns the process PID and a per-process instance ID for reconciliation.
Reachability alone does not establish free VRAM or successful model unloading.
Do not enable media scheduling until the bridge, backend release checks, and
physical host telemetry pass the intermediary's checks.

## Supported workflows and output ownership

Use ComfyUI **API-format** workflows with individually approved local node types
in intermediary settings. The bridge rejects unknown nodes, partner/API nodes,
remote URL inputs, absolute file inputs and path traversal. Custom nodes are
Python code: an allowlist is operator approval of that code, not a sandbox. Do
not install untrusted custom nodes, downloader nodes, scripts, or nodes that
perform independent background inference.

Supported file-output nodes are currently `SaveImage`, `SaveAnimatedWEBP`,
`SaveVideo` and `VHS_VideoCombine` (with `save_output: true`). The bridge changes
only their output filename prefix to:

```text
ai-intermediary/<broker-job-UUID>/node-<node-ID>
```

Prompts, models, seeds and generation parameters are not changed. Other saving
node types need explicit bridge support before use; merely adding them to the
node allowlist is insufficient. `PreviewImage` and `PreviewAny` are allowed but
their temporary/non-file results are not retained as owned media outputs.

ComfyUI must honor the supplied `prompt_id` on `POST /prompt`. Independently of
version numbers, the bridge checks the actual queue entry before enqueueing.
An older release that substitutes its own random ID is rejected **before GPU
execution**; update ComfyUI rather than retrying blindly.

The bridge maintains a durable issued-ID ledger at
`output/ai-intermediary/.broker-owned-jobs.json`. The ledger contains identifiers,
not prompts or media. It is synchronized before enqueueing; a corrupt/full ledger
or storage error fails closed. Do not remove it to retry an uncertain job. Its
bounded capacity is 100,000 IDs; at capacity, migrate/archive the deployment's
state deliberately while no work can resume rather than silently evicting IDs.

After the intermediary safely copies completed outputs into its own retention
store, it can delete raw ComfyUI copies through authenticated
`POST /intermediary/outputs/delete`. Deletion requires all of:

- A broker-owned UUID and successful terminal history for that exact job.
- Exact artifact descriptors present in that history, with `type: output`.
- A path inside that job's forced namespace, with no symlink traversal.

Model weights, uploaded inputs, temporary previews, unrelated files and another
job's outputs are never eligible. The cleanup route does not recursively remove
directories. Missing ComfyUI history after a restart is **not** proof of
ownership/completion: raw leftovers then remain for explicit inspection instead
of being deleted by guesswork. Intermediary-owned retained copies continue using
the intermediary's configured automatic cleanup policy.

## Tests

These tests use only the Python standard library and in-memory ComfyUI/aiohttp
stubs. They do not import ComfyUI, use the GPU, open a network listener, or run
privileged commands:

```sh
python3 -m unittest discover -s integrations/comfyui -p 'test_*.py' -v
```

The implementation follows ComfyUI's
[server routes](https://docs.comfy.org/development/comfyui-server/comms_routes)
and the [upstream queue/history lifecycle](https://github.com/Comfy-Org/ComfyUI/blob/master/execution.py).
