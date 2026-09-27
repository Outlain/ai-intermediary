# AI Intermediary: Ollama and ComfyUI on one GPU

AI Intermediary separates **sources** (who requested work and its priority) from
**backends** (the software that executes it). Ollama and ComfyUI share one
exclusive GPU scheduler. It does not create a second independent media worker.

Media is disabled by default. Configure Ollama sources, Frigate catch-up and
optional media independently. When no `backends` section is configured, one
backend named `ollama` uses `ollama.url`.

## Scope and limits

- One physical GPU resource group, `gpu0`.
- Exactly one Ollama backend and one or more configured ComfyUI instances.
- Odysseus continues using Ollama for chat. Images and videos start in ComfyUI's
  browser interface through a dedicated intermediary gateway. An Odysseus
  image/video tool connector is not part of this release.
- Adding another ComfyUI instance is configuration. Adding a new software type
  requires an adapter that implements its protocol, completion and safe-release
  checks. A backend URL alone is not enough.
- WAN, SDXL and other workflow models belong inside ComfyUI. They are not backend
  software types. Frigate's Ollama request is not a ComfyUI workflow; incompatible
  source/backend mappings are rejected instead of silently translated.
- Local execution only. Cloud/Partner/API nodes are rejected, and installed
  local node types require an explicit allowlist. Allowlisting a custom node is
  trusting its Python code, **not sandboxing it**. It must not start detached GPU
  work, download remote payloads or bypass the broker.
- No GPU reset or VM reboot. Bounded automatic **Ollama** recovery
  remains; automatic ComfyUI service restart is not added in this version.
- The software does not install GPU drivers, ROCm, PyTorch, ComfyUI or model
  weights. Runtime compatibility, image/video quality and peak RAM/VRAM usage
  require validation on the actual host. An Ollama text-context test is not a
  ComfyUI video-memory test. This release does not claim local WAN 2.7 weights.

## Priority and GPU ownership

A typical configuration is Odysseus chat at priority 100, media and miscellaneous
applications at 50, and Frigate live requests at 30. Existing saved priorities
are not automatically replaced. Larger numbers run first; equal-priority work
uses arrival order. Frigate catch-up remains behind eligible live work and their
follow-up holds, with its configurable newest/oldest-event ordering unchanged.

Work is non-preemptive: a video already running finishes before a newly arrived
chat request. Strict priority intentionally permits lower-priority starvation.
Pausing or a schedule boundary stops new dispatches; it cannot promise that a
video already executing stops exactly at the boundary.

The exclusive GPU slot includes model preparation, workflow execution and
verified memory release. Before switching engines the intermediary checks both
backend state and fresh physical host telemetry. A successful `/prompt` response
only proves that ComfyUI accepted a job. Losing its HTTP connection or WebSocket
is not proof that GPU execution stopped. The broker checks prompt-specific
history before treating a workflow as complete.

The first version favors verified release over warm media models: after a
completed media workflow it requests model release and verifies host state
before another workload can use the GPU. A keep-alive setting is not permission
to retain a model across an incompatible engine handoff.

## Deployment: configure backends and opt in

Install AI Intermediary using the [installation guide](INSTALL.md), then configure
the optional media backend below. Its container does not install ComfyUI. Leave
media disabled until ComfyUI, the bridge and host telemetry have been verified.

Back up the configuration and **entire state volume** before updates. Do not
delete state to clear an uncertain job or recovery lock. The media state contains
workflow inputs and should receive the same private storage/backup treatment as
other application data; workflows are not included in public job summaries.

The native ComfyUI gateway accepts normal full-workflow request metadata from
frontend 1.52.7. It
discards `comfy_usage_source`, `preview_method`, `auth_token_comfy_org` and
`api_key_comfy_org` before durable admission or backend forwarding. Per-request
preview overrides are not supported; backend preview defaults apply. Bounded
`extra_pnginfo` is retained privately with the workflow. Other metadata is
rejected, and the direct media-job API and host bridge still accept only
`extra_pnginfo`. This does not permit cloud nodes or change queue priorities.

### 1. Prepare a managed local ComfyUI service

Install ComfyUI in its own supported Python environment, following the official
[manual installation guide](https://docs.comfy.org/installation/manual_install).
The repository also provides a pinned [Ubuntu AMD recipe](COMFYUI_AMD.md) with
service setup and a small first image workflow.
Do not replace the working Ollama ROCm installation merely to install ComfyUI.
Use local model workflows and disable ComfyUI API/Partner nodes. Only use reviewed
custom nodes. The broker deliberately rejects unapproved workflow node types.

Install this repository's `integrations/comfyui` bridge as a ComfyUI custom node
extension and restart that ComfyUI service after configuring it. The bridge is
required, not optional: the intermediary verifies the
`ai-intermediary-comfy-v1` protocol before dispatch. It protects raw execution
routes, records broker-owned prompt/output identity, and reports unload state.

The browser uses the same human `ADMIN_TOKEN` as Dashboard and Settings. A
separate backend-only credential is derived from it; do not copy the human
password into ComfyUI. The host-only `scripts/configure-comfy-auth.py` command
writes the derived `AI_INTERMEDIARY_COMFY_TOKEN` into ComfyUI's private systemd
environment file without displaying it. Follow the exact installation and
service configuration in [the ComfyUI bridge guide](../integrations/comfyui/README.md).
The backend transport uses `X-AI-Intermediary-Token`; do not paste the token into a
workflow or publish it in Git. The browser gateway uses media authentication;
source ports and `X-Ollama-Client` are routing hints, not credentials.

Run ComfyUI under a dedicated systemd unit with a verifiable process/cgroup
identity. In the host helper's root-managed environment file, configure
`COMFYUI_SYSTEMD_UNITS` with the managed ComfyUI unit names. This allows read-only
process ownership checks; it does **not** authorize restarting those services.
Keep the existing helper socket mount, group access and Ollama binding. Refresh
the host helper from this checkout using its documented installer workflow in
[the host helper guide](../integrations/host/README.md).

Both backend APIs must be reachable from the intermediary container. Inside that
container, `127.0.0.1` means the container itself, not Ubuntu. Use an appropriate
private host/bridge address. Restrict raw backend access to the intermediary and
explicit maintenance tools: a second caller going straight to Ollama/ComfyUI can
bypass queueing. Do not publish unprotected raw ComfyUI execution ports to the LAN.
Binding to `0.0.0.0` or using an allowed-host list is not a substitute for access
control.

### 2. Register backends and source routing

Merge the following conceptual example into the existing configuration, replacing
the addresses with ones reachable from the container. Preserve all current
sources, schedules, credentials and helper settings. Do not replace a full config
with this fragment.

```yaml
backends:
  ollama:
    type: ollama
    url: http://host.docker.internal:11434
    enabled: true
    resource_group: gpu0
  comfy:
    type: comfyui
    url: http://host.docker.internal:8188
    enabled: true
    resource_group: gpu0

clients:
  odysseus:
    backend: ollama
    allowed_backends: [ollama]
  frigate:
    backend: ollama
    allowed_backends: [ollama]
  media:
    enabled: true
    header_enabled: true
    listener_port: 11438
    source_ips: []
    backend: comfy
    allowed_backends: [comfy]
    priority: 50
    queue_limit: 20
    queue_while_paused: false
    overflow_policy: reject
    model_policy:
      idle_hold: 0s
```

The sample uses port 11438 to avoid replacing the existing main endpoint or
Odysseus port. Verify that it is unused. Publish **both** sides of the new port
mapping in the existing Compose service; keep all other mappings:

```yaml
services:
  ai-intermediary:
    ports:
      - "11435:11434" # existing main endpoint
      - "11436:11436" # existing dedicated Odysseus endpoint, if used
      - "11438:11438" # new dedicated media gateway
    extra_hosts:
      - "host.docker.internal:host-gateway" # commonly needed on Linux Docker
```

Settings can configure an application listener but cannot publish a Docker port
or alter the host firewall. No Docker socket is required or recommended. Keep
the existing persistent `/app/state` volume; media workflows and owned outputs
live under it. Ensure adequate disk capacity, write permission for the container
user, and backups. Never mount model-weight directories as media output storage.
Keep a working existing backend address instead of blindly replacing it with the
example hostname. The media Compose fragment in
[`deploy/compose.media.example.yml`](../deploy/compose.media.example.yml) provides
the extra listener and a 1 GiB container memory limit. The earlier 256 MiB limit
is unsuitable for a full durable queue of large workflows plus serialization;
queue/payload limits and container memory must be sized together.

### 3. Configure media limits before enabling

Set one `ADMIN_TOKEN` in the intermediary's private `secrets.env` (or equivalent
host-managed injection). The setup helper provisions the bridge's derived
machine credential; there is no additional human password to generate.

```yaml
media:
  enabled: false # enable only after bridge, helper and workflow validation
  state_path: /app/state/media-jobs.json
  storage_path: /app/state/media
  poll_interval: 2s
  job_timeout: 6h
  retention: 168h
  max_jobs: 100
  max_workflow_bytes: 2097152
  max_output_bytes: 1073741824
  max_storage_bytes: 10737418240
  max_idle_vram_mb: 512
  max_idle_torch_vram_mb: 128
  max_idle_utilization_percent: 5
  stable_samples: 3
  allowed_node_types: [] # exact reviewed local node class names from your workflow
```

An empty node list is deliberately not runnable. Add only the local node class
names needed by the reviewed image/video workflows. Do not populate it with
every installed node merely to pass validation. Media cannot be enabled without
the host helper, a token, an enabled ComfyUI backend and an explicit node list.

`max_jobs` bounds nonterminal durable jobs, not the number of generated images.
`max_output_bytes` bounds each imported output; `max_storage_bytes` bounds the
broker's available output copies. The private workflow itself has a separate
byte limit. `job_timeout` is a verification deadline, **not** permission to assume
the GPU is idle or automatically submit the workflow again.
There is also a fixed 64 MiB aggregate budget for retained private workflow JSON,
independent of the individual workflow and job-count limits. Admission stops
when any limit is reached; it does not discard an already accepted workflow.

The idle VRAM/utilization thresholds are release checks, not model size limits.
`max_idle_vram_mb` limits total **physical** VRAM, including driver/context
overhead. Its default remains 512 MiB; upgrades preserve existing operator
choices rather than automatically increasing this ceiling.

`max_idle_torch_vram_mb` separately limits residual memory reported by
ComfyUI's PyTorch allocator after unloading. The default is 128 MiB, the allowed
range is 0–256 MiB, and 0 restores the strict zero-residual check. A nonzero
allowance requires the updated authenticated bridge to confirm model unloading
and an empty queue. Older bridges without that proof still require zero
residual memory. This allowance cannot establish that a workload stopped: the
broker must still establish its completion or an explicitly verified recovery
boundary, check known process ownership and obtain the configured number of
distinct fresh safe physical GPU samples (three by default).

Small allocator and driver/context allocations can survive a successful video.
If inspection confirms, for example, 76 MiB of post-unload PyTorch residue and
676 MiB of total physical VRAM, an **explicit** physical ceiling of 1024 MiB and
the 128 MiB PyTorch ceiling can accommodate that measured baseline. These are
not universal hardware values or permission to retain an active model. The two
checks are independent: increasing only the physical ceiling cannot bypass a
failed PyTorch/unload check. Never raise either limit to ignore unknown or
still-running processes, stale telemetry, rising allocations or a busy queue.

Validate/apply settings through the existing Settings workflow. Recreate the
intermediary when publishing new ports or changing its injected environment.
Do not enable execution just because the configuration validates: first confirm
the bridge and host telemetry work against the actual service.

### 4. Use the gateway, not raw Run

Open the dedicated source gateway, for example `http://ubuntu-ai:11438`, instead
of the raw ComfyUI port. Authenticate with `ADMIN_TOKEN`. The browser uses
ComfyUI's interface, while the bridge/gateway sends Run submissions to the broker.
The broker holds pending workflows outside ComfyUI's native execution queue and
submits only the selected job after acquiring the shared GPU slot.

Do not add a second raw ComfyUI browser connection or another client submitting
directly to its `/prompt` endpoint. Backend queues that contain unrelated work
cause the broker to refuse the handoff; it will not silently delete or interrupt
someone else's queued jobs.

The media API is under `/_intermediary/v1/media/jobs`, authenticated with the same
human administrator credential; the backend machine credential is not a browser
login credential. Submissions identify a source using the same
dedicated-port/header/IP rules; an optional backend selection must be in that
source's allowed backend list. A request's idempotency key prevents a caller from
accidentally duplicating the same accepted workflow. Reusing the same key with
different workflow/backend content is an error.

The gateway supports the native queue/history routes and the newer `/api/jobs`
list/detail/cancel routes using broker-owned records, not raw backend queue
mutations. Native progress and final output events use imported result links.
The initial browser integration assumes ComfyUI's single-user mode; source
priorities are not ComfyUI multi-user account isolation. Private UI graph metadata
under `extra_data.extra_pnginfo` is accepted up to 1 MiB, covered by idempotency
and the aggregate private-payload budget, and forwarded for PNG workflow metadata.
Other top-level `extra_data` fields, including credentials, are rejected. The
broker discards private workflow/graph JSON when a job becomes terminal; its
retained history does not implement full workflow-editor replay. Save important
workflow documents in ComfyUI or retain the generated PNG workflow metadata.

Browser compatibility is intentionally bounded, not a claim that every current
ComfyUI extension or asset-manager feature works through this gateway. Uploads
are parsed and rebuilt as input-only image/video uploads into unique private
input subdirectories; caller-selected output/temp destinations and overwrites
are not forwarded. Mask editing accepts only safe, explicit input references.
To edit a generated output's mask, download it and upload it again as an input
first. Preview links require classic safe filename/subfolder references and an
explicit input/temp type; filename annotations and `blake3:` asset-hash aliases
are rejected until they can be mapped to proven owned paths. Newer asset-manager
hash-based preview flows may therefore require the classic filename workflow.
Uploaded inputs are retained for queued-work correctness, not deleted by the
completed-output cleanup policy; monitor and manage their disk use separately.

## Durable queues, pauses and cancellation

LLM HTTP requests and media jobs have different lifetimes:

- An ordinary HTTP LLM request is live only while its connection/TTL policy
  allows. Pauses reject by default, and disconnected calls are not replayed.
- An accepted media workflow is persisted before dispatch. Closing the browser,
  pausing a source or restarting the intermediary does not delete a queued job.
  Accepted queued jobs wait until eligible again. New submissions during pauses
  are rejected by default; explicitly permitting that source to queue during
  pauses admits bounded durable media jobs, not an indefinitely held HTTP call.
- Frigate's catch-up remains its separate retained-ID/native-API recovery path.
  It does not cache image-bearing live HTTP requests for replay.

Cancelling a queued media job only removes pending work; it has no GPU side
effects. Cancelling a running job asks ComfyUI to interrupt **that owned current
job**, then waits for verified terminal history and GPU release. An interrupt
acknowledgment alone does not release ownership.

## Restart and uncertain completion

The broker persists `queued → dispatching → running → completed/failed/cancelled`.
An interrupted `dispatching` or `running` record restores as `uncertain`, holding
the safety lock. It never automatically sends that workflow a second time.

Reconciliation inspects prompt-specific backend history, or terminal evidence
already persisted by the broker. Results are durably imported **before** model
unloading, independently of the later GPU-release verification. Imported results
remain readable during recovery; only verified release settles the GPU ownership.
Missing history without persisted evidence, lost connectivity, an unavailable bridge, unmanaged GPU processes or
unconfirmed memory release keep inference blocked. A blank Ollama model list,
empty browser queue or low instantaneous GPU utilization is not sufficient proof.

Manual acknowledgment requires maintenance authentication, a paused system and
explicit confirmation that the operator verified the service was stopped; the
broker still performs backend/host release checks. Do not use acknowledgment to
skip investigating an active or unaccounted-for workflow. There is no automatic
ComfyUI restart, GPU reset or VM reboot hidden behind this control.

See [media result recovery](MEDIA_RECOVERY.md) for the native gallery behavior,
video downloads/seeking and validated recovery of an older unimported MP4. A
recovered file does not itself prove execution completion or GPU release.

## Output retention and privacy

Successful outputs are copied with streaming byte bounds into private per-job
directories under `media.storage_path`, using generated artifact IDs. Repeated
reconciliation does not duplicate already-imported artifacts. Backend copies
are deleted only through the bridge's owned-output mechanism after successful
import and verified GPU release; files not registered as belonging to that broker prompt are not removed.

By default the broker expires completed output copies after seven days and can
remove oldest completed output copies sooner to remain within the 10 GiB output
quota. Expired links report expiration rather than returning unrelated files.
The limits are settings, not a claim that every video fits in the 1 GiB
per-output default.

Terminal metadata and its idempotency mapping are retained for at least the
configured retention period, with a 1,000-record history admission budget. When
all 1,000 records are still protected, new jobs receive `media_history_full`
instead of silently losing their duplicate-submission protection. Already
accepted jobs can still finish. Old eligible records are retired to admit new
jobs only after their output files are expired or absent; following retirement,
the old job link is no longer available and its idempotency key can be reused.
Reducing retention is an explicit change to both output lifetime and the minimum
idempotency retention window. Failed jobs with retained artifacts require
operator investigation before their protected records can be retired.

Cleanup does not remove model weights, arbitrary backend files, external paths,
queued/active inputs or files from uncertain jobs. Failed-job files are protected,
except explicitly recovered outputs after the operator verifies recovery; those
copies then join normal retention. Symlinks and traversal
paths are rejected. Unknown files in the output directory are not automatically
deleted and are not counted as broker-owned output quota; monitor actual host
disk space too. Partial imported outputs attached to a failed job may require
operator cleanup after investigation.

Public job summaries omit workflows and browser client identifiers. Workflow
inputs do exist in private durable state while queued/running/uncertain; terminal
transitions discard them. Do not put secrets in prompts or treat source routing
labels as per-user authentication/isolation.

## Acceptance checks and rollback

Before leaving a new deployment unattended, verify on the actual host:

1. Odysseus and Frigate requests use their configured routes and
   preserve one-at-a-time GPU execution with media disabled.
2. A small approved local image workflow runs through the gateway, appears as a
   durable job, completes, releases memory and leaves a readable output.
3. Chat arriving during media waits; after completion, higher-priority chat runs
   before the next lower-priority media job. Frigate catch-up remains behind
   eligible live work.
4. A paused queued job survives browser disconnect/restart; a new paused
   submission is rejected under the default policy.
5. An intermediary restart during a controlled media test produces a safe
   reconciliation or visible uncertain lock, never a duplicate generation.
6. A raw/unmanaged backend submission is refused or blocks handoff rather than
   running concurrently. Test cleanup on disposable completed outputs only.

Only after these pass should larger image/video workflows be profiled. Text
context capacity cannot predict their RAM/VRAM peaks, and AMD compatibility of
custom nodes or quantization methods must be checked separately.

Keep unmanaged image/video services stopped while the broker is active so they
cannot independently load the GPU. Route all production GPU work through the
intermediary.

To roll back an update, pause, drain and verify both backends are idle first.
Preserve the state volume and verify the target version understands its schema.
Never downgrade while a workflow is active or uncertain.

## Adapter extension contract

A future backend adapter needs validated capability discovery, admission/body
limits, idempotent job correlation where available, submission, definitive job
state, cancellation semantics, reconnect/restart reconciliation, owned artifact
retrieval, safe model release and verification. Unsupported or uncertain states
must fail closed. No arbitrary command execution, URL proxy or extra independent
GPU worker can substitute for that contract.

Upstream API references:
[ComfyUI routes](https://docs.comfy.org/development/comfyui-server/comms_routes),
[execution messages](https://docs.comfy.org/development/comfyui-server/comms_messages).
In particular, a node's `executed` event is not proof that the whole workflow has
finished; completion must be correlated to the job.
