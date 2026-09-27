# Recover a saved video without rerunning generation

A saved MP4 and a verified-free GPU are different things. ComfyUI can finish
writing a video and then fail while unloading models. Do not delete job state,
click Run again, or clear a recovery lock just because the file exists.

## What the intermediary now preserves

On terminal ComfyUI history, the broker first saves the completion evidence and
copies the output bytes into its durable media store. Only then does it request
model unloading and verify physical GPU release. If cleanup fails, imported
results remain readable but **all new GPU work stays blocked**.

The native ComfyUI job API exposes available results as completed for gallery
purposes, with a separate `intermediary.recovery_required` flag. The durable
broker job remains `uncertain` until safe release is established. An uncertain
job without available results is shown as failed, not perpetually running.
Ollama automatic recovery reports `media_recovery_required`, not
`service_stopping`, and does not try to fix ComfyUI by restarting Ollama.

The installed open-source ComfyUI frontend uses completed `/api/jobs` previews
for Assets → Generated. Those previews now survive loss of ComfyUI's in-memory
history. A read-only `/api/assets` catalogue is also available for compatible
clients; this does not enable cloud services or model downloads. Registered
output URLs support GET, HEAD and single byte ranges for video playback/seeking.
Outputs remain source/backend scoped on the dedicated native media interface.

The gateway still serves the ComfyUI application itself from the backend. If
ComfyUI is stopped, a cached page may work, but a fresh page load requires the
backend to be running. Saved artifact downloads do not depend on that backend.

## Recover an older MP4 that was never imported

Deploy AI Intermediary **v2.0.3 or newer** first, preserving its entire state
volume. Keep media enabled and **Pause inference** in the dashboard. Do not
resume or acknowledge recovery yet. The ComfyUI service may remain stopped
while importing the file.

On the Linux ComfyUI host, from the updated checkout/release directory, run:

```sh
sudo python3 scripts/recover-comfy-output.py \
  JOB_UUID node-NODE_ID_00001_.mp4 --node-id NODE_ID
```

Replace the three placeholders with the job directory, saved filename and
output node ID. Defaults are `/opt/ComfyUI/output` and container
`ai-intermediary`; `--output-directory` and `--container` override them.
Use the filename that actually exists, not an absolute filename argument.

The tool:

- Requires an uncertain broker job, administrator authorization and a manual
  pause. The existing `ADMIN_TOKEN` stays inside the container.
- Checks the bridge's issued-job ledger and rejects symlinks, traversal,
  hard-linked files and empty files.
- Uses installed `ffprobe` and `ffmpeg` to check the MP4 and fully decode its
  video stream on the CPU, without generating or writing another movie.
- Verifies a SHA-256 digest while importing the bytes into the broker store.
  Repeating the same import is idempotent; changed content is rejected.
- Preserves the original MP4 and ledger. It does not restart services, submit a
  workflow, clear a GPU lock, resume inference, or invent terminal history.

FFmpeg/ffprobe must already be installed. The helper accepts files up to 512 MiB
and videos up to one hour; the existing intermediary request-body and output
limits also apply. A timeout, invalid file, checksum failure or HTTP error stops
the process without deleting the original. Do not loosen general request limits
indiscriminately to import a large file.

Refresh the authenticated ComfyUI page and look in **Assets → Generated** or
**Completed jobs**, then use the result's download control. A recovered result
means the imported video was validated, not that every node of the original
workflow is known to have completed. Its broker record retains that distinction.

## Restore GPU service separately

Only after investigating the failure and proving that the old ComfyUI process
and its workers cannot resume should you start the configured ComfyUI service
again. Keep inference paused. Do not start another Wan job as a health test.
Inspect the service and host before proceeding, for example:

```sh
systemctl show comfyui.service -p ActiveState -p SubState -p MainPID -p Result
sudo journalctl -u comfyui.service -n 60 --no-pager
sudo amd-smi process
sudo amd-smi metric --mem-usage --usage
free -h
```

Once the previous process boundary is verified, the replacement ComfyUI service
is reachable, no generation is queued there, and host telemetry is healthy,
explicitly acknowledge **media** recovery. This is different from restarting
Ollama. The following command is an administrator confirmation, not a diagnostic:

```sh
docker exec -i ai-intermediary node --input-type=module <<'JS'
const response = await fetch('http://127.0.0.1:11434/_intermediary/v1/media/acknowledge', {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ confirm_service_stopped: true }),
  signal: AbortSignal.timeout(120000)
});
console.log(response.status, await response.text());
if (!response.ok) process.exitCode = 1;
JS
```

The intermediary still checks backend unloading and fresh physical GPU samples;
it refuses to clear the lock if those checks fail. A successful acknowledgment
preserves the manual pause. Resume deliberately afterward. If Ollama has a
separate recovery incident, that incident must also be resolved.

Recovered files remain protected while the job is uncertain. After verified
recovery retires the job, the broker's normal retention/quota cleanup applies to
the recovered copies. The original host MP4 is never deleted by this helper.

## Prevent recurrence

This update prevents a cleanup failure from hiding an already-imported result.
It does **not** prove that a large video workload fits system RAM or fix a ROCm
driver fault. See the [controlled AMD memory test](COMFYUI_AMD.md#after-a-system-ram-oom).
Keep model downloads, VM RAM sizing and backend tuning separate from recovery.
