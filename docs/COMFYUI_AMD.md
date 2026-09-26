# Local ComfyUI on Ubuntu with an AMD Radeon GPU

This is a **new ComfyUI installation**, separate from the AI Intermediary Docker
container. It uses `/opt/ComfyUI`, an unprivileged `comfyui` account, and
`comfyui.service`. It does not replace Ollama, install a GPU driver, update the
kernel, reset the GPU, or reboot the VM. Inference stays local; installation and
model downloads require internet access.

The recipe targets Ubuntu 24.04 x86-64, Python 3.12, a working AMD compute driver,
and a Radeon AI PRO R9700 (`gfx1201`) with 32 GB VRAM. It pins ComfyUI **v0.37.0**
and PyTorch **2.11.0 / ROCm 7.2** wheels rather than tracking nightly builds.
Upstream ComfyUI documents that wheel channel; the matching [torch](https://download.pytorch.org/whl/rocm7.2/torch/),
[torchvision](https://download.pytorch.org/whl/rocm7.2/torchvision/), and
[torchaudio](https://download.pytorch.org/whl/rocm7.2/torchaudio/) releases are published.
See [ComfyUI's installation instructions](https://github.com/Comfy-Org/ComfyUI/blob/v0.37.0/README.md).

This is **not a claim of validation on every kernel/driver combination**. AMD's
[Radeon support matrix](https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/docs/compatibility/compatibilityrad/native_linux/native_linux_compatibility.html)
lists the R9700, but its ROCm 7.2.1 Ubuntu matrix lists kernel 6.17, not kernel
7.0.0. A working Ollama installation does not establish PyTorch compatibility.
The checks below must pass on the actual VM. If they fail, stop and inspect the
error; do not install a different driver over the working one as a guess.

## 1. Reserve the GPU and inspect prerequisites

In AI Intermediary, pause **all inference, until manually resumed**. Wait for the
current job to finish and GPU release to be verified. Leave media disabled.
Stop any separate image/video generator that could bypass the broker. Do not
kill an active job merely to accelerate setup.

Run on Ubuntu, one block at a time. Stop on any error. The project checkout is
assumed to be `/opt/ai-intermediary`; change only that path if yours differs.

```bash
cd /opt/ai-intermediary
uname -m
uname -r
. /etc/os-release
printf '%s %s\n' "$ID" "$VERSION_ID"
python3 --version
ls -l /dev/kfd /dev/dri/renderD*
ollama ps
free -h
df -h /opt
sudo amd-smi process --general
```

Require Ubuntu 24.04, x86_64, Python 3.12, accessible AMD devices and no active GPU
work. Plan at least **60 GB free disk** for the environment, SDXL, the optional
5B video weights and temporary downloads; outputs need additional space. Disk
space, system RAM and VRAM are separate limits. Do not proceed if `/opt/ComfyUI`
already contains an installation; review that installation instead of replacing it.

## 2. Install into an isolated Python environment

These are user-space packages only. No `amdgpu-install`, ROCm apt upgrade,
`--break-system-packages`, architecture override or NVIDIA CUDA wheel is needed.

```bash
(
set -e
sudo apt-get update
sudo apt-get install -y git python3-venv python3-dev build-essential ffmpeg libgl1 libglib2.0-0 curl
sudo useradd --system --create-home --home-dir /var/lib/comfyui --shell /usr/sbin/nologin --user-group comfyui
sudo usermod -aG render,video comfyui
sudo install -d -o comfyui -g comfyui -m 0755 /opt/ComfyUI
sudo -u comfyui git clone --branch v0.37.0 --depth 1 https://github.com/Comfy-Org/ComfyUI.git /opt/ComfyUI
sudo -u comfyui python3 -m venv /opt/ComfyUI/.venv
sudo -u comfyui /opt/ComfyUI/.venv/bin/python -m pip install --upgrade pip wheel
sudo -u comfyui /opt/ComfyUI/.venv/bin/python -m pip install \
  torch==2.11.0+rocm7.2 torchvision==0.26.0+rocm7.2 torchaudio==2.11.0+rocm7.2 \
  --index-url https://download.pytorch.org/whl/rocm7.2
sudo install -o comfyui -g comfyui -m 0644 deploy/comfyui-rocm.constraints.txt /opt/ComfyUI/ai-intermediary-constraints.txt
sudo -u comfyui /opt/ComfyUI/.venv/bin/python -m pip install \
  -c /opt/ComfyUI/ai-intermediary-constraints.txt -r /opt/ComfyUI/requirements.txt
sudo -u comfyui /opt/ComfyUI/.venv/bin/python -m pip check
)
```

If `useradd` reports the account already exists, stop to inspect its ownership and
purpose rather than changing another service's account. A resolver conflict is
also a stop condition: do not remove the constraints to make the error disappear.

Now run a **small GPU operation**, still with intermediary inference paused:

```bash
sudo -u comfyui /opt/ComfyUI/.venv/bin/python - <<'PY'
import torch
assert torch.__version__ == "2.11.0+rocm7.2", torch.__version__
assert torch.version.hip and torch.version.hip.startswith("7.2"), torch.version.hip
assert torch.cuda.is_available(), "AMD GPU is unavailable to the comfyui account"
assert torch.cuda.device_count() == 1, "Review GPU selection on a multi-GPU machine"
device = torch.cuda.get_device_properties(0)
architecture = getattr(device, "gcnArchName", "")
assert architecture.split(":")[0] == "gfx1201", architecture
print("PyTorch:", torch.__version__, "HIP:", torch.version.hip)
print("GPU:", device.name, "architecture:", architecture)
x = torch.randn((1024, 1024), device="cuda", dtype=torch.float16)
y = x @ x
torch.cuda.synchronize()
assert torch.isfinite(y).all().item(), "Non-finite GPU result"
print("PASS: AMD GPU tensor operation completed")
PY
```

PyTorch calls its GPU API `torch.cuda` even on AMD; `torch.version.hip` confirms
that the runtime is ROCm. This smoke test is not a video stress test.

## 3. Install the bridge and private service credential

The AI Intermediary container must already be running with `ADMIN_TOKEN` set.
Keep it paused, not stopped, so the credential helper can read its configuration.

```bash
(
set -e
cd /opt/ai-intermediary
sudo install -d -o root -g root -m 0755 /opt/ComfyUI/custom_nodes/ai_intermediary_bridge
sudo install -o root -g root -m 0644 integrations/comfyui/__init__.py /opt/ComfyUI/custom_nodes/ai_intermediary_bridge/__init__.py
sudo install -o root -g root -m 0644 integrations/comfyui/bridge.py /opt/ComfyUI/custom_nodes/ai_intermediary_bridge/bridge.py
sudo python3 scripts/configure-comfy-auth.py --container ai-intermediary --check
sudo python3 scripts/configure-comfy-auth.py --container ai-intermediary --yes
sudo install -o root -g root -m 0644 deploy/comfyui.service.example /etc/systemd/system/comfyui.service
)
```

This helper creates `/etc/ai-intermediary/comfy.env` with a derived machine
credential. There is no second password to choose. Changing `ADMIN_TOKEN` later
requires rerunning the helper and restarting ComfyUI at a drained boundary.

The unit loads only the bridge custom node, disables API/cloud nodes and enables
offline model loading. Its `Restart=no` is intentional: an uncertain job must be
reconciled rather than restarted automatically. See the [bridge contract](../integrations/comfyui/README.md).

### Bind the raw backend to Docker's private host-side bridge

Do not publish raw ComfyUI on the VM's LAN address. This uses the host's Docker
`bridge` gateway (commonly `172.17.0.1`) and prints the exact backend URL. It is a
host interface, **not a container address**. The bridge credential is still
required even from another container. This recipe assumes ordinary rootful
Docker, not rootless Docker or Docker Desktop.

```bash
(
set -e
COMFY_BIND_IP="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')"
python3 - "$COMFY_BIND_IP" <<'PY'
import ipaddress, sys
address = ipaddress.ip_address(sys.argv[1])
assert address.version == 4 and address.is_private and not address.is_loopback
print(f"ComfyUI backend URL: http://{address}:8188")
PY
sudo install -d -m 0755 /etc/systemd/system/comfyui.service.d
printf '[Service]\nEnvironment=COMFY_LISTEN_ADDRESS=%s\n' "$COMFY_BIND_IP" | sudo tee /etc/systemd/system/comfyui.service.d/network.conf >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now comfyui.service
sudo systemctl status comfyui.service --no-pager
sudo journalctl -u comfyui.service -n 80 --no-pager
)
```

Stop if startup fails or the bridge fails to import. Do not enable media or remove
the bridge to bypass an error. Without credentials, the raw API should reject:

```bash
COMFY_BIND_IP="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')"
curl -sS -o /dev/null -w 'Raw unauthenticated status: %{http_code}\n' "http://${COMFY_BIND_IP}:8188/intermediary/status"
```

Expect **401**. Check the same endpoint with its private machine credential,
without displaying or placing that credential in shell history:

```bash
COMFY_BIND_IP="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')"
sudo python3 - "$COMFY_BIND_IP" <<'PY'
import json, pathlib, re, sys, urllib.request
contents = pathlib.Path("/etc/ai-intermediary/comfy.env").read_text()
matches = re.findall(r'^AI_INTERMEDIARY_COMFY_TOKEN="([0-9a-f]{64})"$', contents, re.M)
assert len(matches) == 1, "Expected one derived machine credential"
request = urllib.request.Request(f"http://{sys.argv[1]}:8188/intermediary/status",
    headers={"X-AI-Intermediary-Token": matches[0]})
with urllib.request.urlopen(request, timeout=10) as response:
    status = json.load(response)
assert status.get("protocol") == "ai-intermediary-comfy-v1", status
for field in ("local_only", "queue_guard", "stable_prompt_ids", "owned_output_cleanup", "storage_healthy"):
    assert status.get(field) is True, (field, status)
print(json.dumps(status, indent=2))
PY
```

Check authenticated connectivity from the actual intermediary container too.
This derives the same machine credential internally; it never prints the
administrator password or puts it in command-line arguments:

```bash
COMFY_BIND_IP="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}')"
docker exec -i ai-intermediary node --input-type=module - "$COMFY_BIND_IP" <<'JS'
import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
const address = process.argv[2];
assert(/^\d+\.\d+\.\d+\.\d+$/.test(address), 'Expected a private IPv4 bridge address');
assert(process.env.ADMIN_TOKEN, 'ADMIN_TOKEN is not configured');
const token = createHmac('sha256', process.env.ADMIN_TOKEN)
  .update('ai-intermediary/comfyui-bridge/v1').digest('hex');
const url = `http://${address}:8188/intermediary/status`;
const denied = await fetch(url, { signal: AbortSignal.timeout(10000) });
assert.equal(denied.status, 401, 'Raw unauthenticated ComfyUI must reject access');
await denied.arrayBuffer();
const response = await fetch(url, { signal: AbortSignal.timeout(10000),
  headers: { 'X-AI-Intermediary-Token': token } });
assert.equal(response.status, 200, 'Authenticated ComfyUI bridge is unavailable');
const status = await response.json();
assert.equal(status.protocol, 'ai-intermediary-comfy-v1');
assert.equal(status.local_only, true);
assert.equal(status.storage_healthy, true);
console.log('PASS: container reaches authenticated local ComfyUI bridge');
JS
```

If this fails while the host check succeeds, inspect Docker/host firewall
connectivity; do not switch to an unauthenticated public listener as a workaround.

## 4. Register the service with AI Intermediary

Follow [backend/source settings](AI_INTERMEDIARY.md#2-register-backends-and-source-routing):

- Keep the existing Ollama backend and LLM sources unchanged.
- Add backend `comfy`, type `comfyui`, resource `gpu0`, using the private URL
  printed above. Check reachability **from the intermediary**, not only the host.
- Add source `media`, backend `comfy`, dedicated port `11438`, priority `50`.
  Publish `11438:11438` on the **same** intermediary container. The raw backend
  `8188` is not the browser URL.
- In the host helper's root-managed environment, set
  `COMFYUI_SYSTEMD_UNITS=comfyui.service`, using the current
  [host-helper installation guide](../integrations/host/README.md). Refresh only
  that helper at this paused boundary. This authorizes process inspection, not
  ComfyUI restarts. Physical telemetry must report a fresh, healthy sample.
- Keep media disabled until the bridge check, host helper and allowed-node list
  are configured. Use a 1 GiB intermediary container memory limit for media.

## 5. Start with one SDXL image

[SDXL Base 1.0](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0)
is an uncomplicated first local image workflow. This is a compatibility baseline,
not a claim that it is the newest or best image model. Read its model license.

```bash
sudo -u comfyui curl --fail --location --retry 3 --continue-at - \
  'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors' \
  --output /opt/ComfyUI/models/checkpoints/sd_xl_base_1.0.safetensors.partial &&
sudo -u comfyui mv -n /opt/ComfyUI/models/checkpoints/sd_xl_base_1.0.safetensors.partial /opt/ComfyUI/models/checkpoints/sd_xl_base_1.0.safetensors
```

Only run the `mv` after curl succeeds. Existing complete files are not replaced.
Review this minimal built-in node allowlist in Media settings:

```text
CheckpointLoaderSimple, CLIPTextEncode, EmptyLatentImage, KSampler, VAEDecode, SaveImage
```

Enable media, open `http://ubuntu-ai:11438`, and log in with the administrator
password. Use a basic text-to-image workflow with the SDXL checkpoint, one
1024×1024 image, approximately 20 sampling steps and `SaveImage`. Use filename
model/input selection. Asset-hash uploads and arbitrary extensions are not
supported by this first gateway release. Do not use a cloud template.

If the media login reports `Cross-origin login rejected.` on v2.0.0, update
the intermediary image to v2.0.1 or newer and reload the login page. The original
login page's `no-referrer` policy causes native browser form submissions to send
`Origin: null`; the fix uses `same-origin` on that page while retaining origin
checks. This rejection occurs before the password is checked. Keep the existing
administrator password, settings, state mounts, and ComfyUI installation; do not
disable origin checks or reinstall the backend.

Resume inference only when ready to submit through the gateway. Run **one**
image. Confirm the broker records completion and returns to verified GPU idle,
then make one Odysseus chat request. Confirm that Ollama/Frigate resume normally.
If ownership or release verification fails, preserve the logs and recovery lock;
do not loosen VRAM/process checks to force another job through.

## 6. Add local video after the image handoff passes

Start with **Wan 2.2 TI2V-5B**, which handles text-to-video and image-to-video.
The [official native ComfyUI workflow](https://docs.comfy.org/tutorials/video/wan/wan2_2)
uses these three files. They are model weights, not another backend or cloud API:

```bash
sudo -u comfyui curl --fail --location --retry 3 --continue-at - \
  'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors' \
  --output /opt/ComfyUI/models/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors.partial &&
sudo -u comfyui mv -n /opt/ComfyUI/models/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors.partial /opt/ComfyUI/models/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors
sudo -u comfyui curl --fail --location --retry 3 --continue-at - \
  'https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors' \
  --output /opt/ComfyUI/models/vae/wan2.2_vae.safetensors.partial &&
sudo -u comfyui mv -n /opt/ComfyUI/models/vae/wan2.2_vae.safetensors.partial /opt/ComfyUI/models/vae/wan2.2_vae.safetensors
sudo -u comfyui curl --fail --location --retry 3 --continue-at - \
  'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors' \
  --output /opt/ComfyUI/models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors.partial &&
sudo -u comfyui mv -n /opt/ComfyUI/models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors.partial /opt/ComfyUI/models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors
```

Again, run each rename only after its download succeeds. Load the **local**
Wan2.2 5B template from the linked official guide. Export API-format JSON and
review its `class_type` names before adding those exact built-in types to the
media allowlist. The final file-saving node must be a supported `SaveVideo` (or
another output node listed in the bridge guide). Do not approve all installed
nodes or install a custom-node manager merely to bypass validation.

Begin with a short clip, batch size 1, then increase resolution/duration while
watching `free -h` and `amd-smi metric --mem-usage --usage`. A 32 GB GPU is not a
guarantee that every 720p workflow fits a 30 GiB system-RAM VM. Finish and verify
release before the next test. A running video is non-preemptive: incoming chat
waits for it to finish.

For higher quality later, evaluate Wan2.2 A14B's two-expert workflow and appropriate
quantization **separately**. The [original Wan project](https://github.com/Wan-Video/Wan2.2)
documents much larger memory requirements for its reference A14B path; this
guide does not promise that a stock full-precision A14B workflow fits this VM.
The smaller 5B path proves installation and handoff first, without silently
switching to a cloud service. No local Wan2.7 weights were verified in the
[official Wan repositories](https://github.com/Wan-Video) when this guide was
prepared; a marketing/API version number is not a downloadable local model.

## Updating this installation later

Pause/drain first. Preserve the working venv, ComfyUI commit and model files;
update deliberately and rerun the smoke test and one image/video handoff. Do not
run an unattended `git pull` plus unconstrained `pip install --upgrade` on a
shared GPU service. The bridge verifies supplied prompt IDs before enqueueing,
so an incompatible ComfyUI release fails closed instead of duplicating a job.
The chosen [v0.37.0 server](https://github.com/Comfy-Org/ComfyUI/blob/v0.37.0/server.py)
accepts client prompt IDs, and its [launch options](https://github.com/Comfy-Org/ComfyUI/blob/v0.37.0/comfy/cli_args.py)
include the local-only/custom-node switches used here.
