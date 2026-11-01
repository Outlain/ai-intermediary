# Frigate 0.18.2 ROCm with native completion bridge

This is a **custom, derived Frigate image**, not an official Frigate release.
The image is based on the official **0.18.2 ROCm release for linux/amd64**, pinned
by digest, including the dependencies and security fixes shipped in that release.
The exact upstream source revision is
[`cfa08c56b23d23280c3d0a218e5a43182c97445b`](https://github.com/blakeblackshear/frigate/tree/v0.18.2).
It adds the completion bridge and backports individual review regeneration from
the earlier development integration. The patch does not change camera settings,
prompts, model options, recordings, authentication rules, or database schema.

Published image: `ghcr.io/outlain/frigate-intermediary:0.18.2-rocm-v1`.
The Frigate-specific GitHub release includes `image-digest.txt` for immutable
deployment. This is a separate image from AI Intermediary; do not replace the
intermediary service with it.

## Existing development-image installations

**Do not replace `bb6c2e9-v1` by changing only the image tag.** That image used a
0.19 development base, which can already have rewritten configuration and the
database. Stable 0.18.2 has no reverse migration. In particular, 0.19's `models`
list replaces the older `detectors`/`model` configuration, and Birdseye `modes`
replaces `mode`. Changing the configuration version number alone does not
convert these fields.

Before deploying, stop Frigate at a planned boundary and make a complete backup
of `/config` including `frigate.db` and any SQLite sidecars. Keep the original
image digest. Convert and validate a **copy** of the configuration, and check a
copy of the database. The development base added migrations 036–039; their
presence does not alone prevent stable startup, but stable ignores recording
stream types and later migrations may need separate reconciliation. Do not
delete migration records or rebuild the live database to hide the difference.
The automatic `/config/backup_config.yaml` file is not a guaranteed complete
pre-development backup and contains no database backup.

Use a matched pre-development configuration/database backup only if losing
newer metadata is acceptable. Otherwise, plan an explicit migration of the
current data. This image does **not** perform that migration automatically.
See [official backup and rollback guidance](https://docs.frigate.video/frigate/updating/).

## Why this is needed

Stock Frigate accepts a regeneration request asynchronously. It does not tell
the intermediary which subsequent Ollama request belongs to that regeneration,
or when generation fails before saving a description. Guessing from timing
could confuse a live request with a catch-up request.

The bridge carries a fresh, secret attempt ticket through the existing native
object and review processing paths. It labels the associated Ollama requests
and reports when the **whole native generation attempt** has finished. A valid
result handed to Frigate's save path is reported as success; the intermediary
still independently confirms that the description was actually saved.
These attempt tickets are generated automatically; they are not another token
you need to create, enter in the dashboard, or add to `secrets.env`.

This allows the intermediary to start another eligible generation while an
earlier result is being checked, without starting two Ollama inferences at once.
The intermediary remains responsible for queue priority, GPU serialization,
pause/drain, retries, and bounded pending confirmations. Merely installing this
image does not increase Ollama concurrency or fix a context-size HTTP 400.

## Pull or build without changing your running Frigate

On the **Frigate Docker host**:

```bash
docker pull ghcr.io/outlain/frigate-intermediary:0.18.2-rocm-v1
```

Pulling downloads the image without restarting Frigate. For a local build from
this repository:

```bash
docker build --platform linux/amd64 \
  -t frigate-intermediary:0.18.2-rocm-v1 integrations/frigate
```

The Dockerfile pins the official ROCm image to
`sha256:5c852fb2cda16fc7d642128df0d4cbdba67477282480f83d6f3ba188c3ae5728`.
The build verifies SHA-256 hashes of **all eight affected upstream files** before
changing any of them. Mismatched or previously patched sources refuse to build.
Do not bypass this check for another release or substitute a moving tag.

## Enable during a deliberate Frigate update

First update the intermediary to a version supporting this bridge. Pause
intermediary inference and allow active work to drain before restarting either
service. Editing/recreating Frigate briefly interrupts its camera processing.

In **your existing Frigate Compose service**, change only its image and add the
environment entry below. Preserve all existing ports, devices, volumes, shared
memory, credentials, and other settings. This is a fragment, not a replacement
Compose file:

```yaml
services:
  frigate:
    image: ghcr.io/outlain/frigate-intermediary:0.18.2-rocm-v1
    environment:
      FRIGATE_INTERMEDIARY_BRIDGE: "1"
```

If your environment uses list syntax, add
`- FRIGATE_INTERMEDIARY_BRIDGE=1` to its existing list instead. In Portainer,
make these edits in the existing Frigate stack/container configuration.

The Ollama **description provider** must already point to the intermediary's
origin, e.g. `http://intermediary.lan:11435`, not directly to Ollama. The bridge
supports HTTP/HTTPS origins only, with no path prefix, embedded credentials,
query, or fragment. It does not change that provider setting for you.

Validate your Frigate Compose file, then recreate only that service using your
normal deployment workflow. Resume inference after both services are healthy.
The bridge defaults to **disabled** if the environment entry is absent.

## Verify

On the trusted internal, unauthenticated Frigate API used by this deployment:

```bash
curl -fsS http://frigate.lan:5000/api/intermediary/capabilities
```

Expected when enabled with an Ollama description provider:

```json
{"protocol":"ollama-intermediary-v1","object":true,"review":true,"completion_reports":true}
```

On an authenticated Frigate API, use an existing **admin** session; the endpoint
does not bypass Frigate authorization. An unpatched image returns 404. A patched
but disabled/unsupported configuration returns the protocol with false flags.
Neither should be interpreted as native completion support.

Do not expose Frigate's unauthenticated port 5000 publicly. The intermediary
must also be reachable from the Frigate container for inference and completion
reports. If a report is lost, the intermediary retains its conservative
timeout/reconciliation behavior; a capability response is not proof that every
callback can reach it.

## Protocol and safety

- Capability endpoint: admin-protected `GET /api/intermediary/capabilities`.
- Existing regeneration endpoints accept an optional
  `X-Ollama-Intermediary-Attempt` header: exactly 64 lowercase hexadecimal
  characters. Invalid tickets are rejected; tagged requests are rejected while
  the bridge is disabled or the description provider is not supported.
- The ticket travels explicitly through object metadata IPC, review IPC, and
  review threads. Live requests receive no catch-up ticket.
- An HTTPX request hook injects the scoped ticket only into POST
  `/api/generate` or `/api/chat` requests to the configured provider origin.
  It does not mutate shared client headers, and strips stale tickets on other
  requests/destinations. Model probes are not inference evidence.
- The review regeneration thread waits for its own native analysis child;
  normal live analysis remains asynchronous. Native success is marked only
  after a valid result is handed to Frigate's existing save/update path.
- Completion is posted to the configured provider origin plus
  `/_intermediary/v1/frigate/attempt`, with the same ticket header and
  `{"outcome":"success"|"failed","reason":"safe_enum"}`. No user-supplied
  callback URL, general API credential, prompt, description, or image is sent.
- Callbacks never follow redirects. They make at most three attempts with a
  two-second network timeout and short increasing delays. Missing/rejected
  reports never trigger an automatic second native generation inside Frigate.
- The bridge does not log ticket values or callback payloads. Existing Frigate
  logging remains unchanged; do not enable verbose prompt logging unnecessarily.
- There is no durable bridge job database. Restarts and lost callbacks require
  conservative intermediary reconciliation rather than guessed completion.

## Rollback

Restore the original Frigate image and its matched configuration/database backup
during a planned restart. Preserve media volumes. Keep the bridge environment
enabled when returning to a compatible custom image; disable it for stock
Frigate. The intermediary must detect native capabilities afresh. Outstanding
attempts may need their normal reconciliation timeout after a restart; never
force them complete just because the image changed.

## Development tests

No Docker daemon, Frigate instance, camera images, model, or network is needed
for the standalone bridge tests:

```bash
python3 -m unittest discover -s integrations/frigate -p 'test_*.py' -v
```

For exact-source integration tests, download and verify the eight files listed
in `apply_bridge.HASHES` from the pinned official release source, then run:

```bash
fixture_dir=$(mktemp -d)
python3 integrations/frigate/fetch_test_sources.py "$fixture_dir"
FRIGATE_BRIDGE_SOURCE_FIXTURES="$fixture_dir" \
  python3 -m unittest discover -s integrations/frigate -p 'test_*.py' -v
```

These tests compile every transformed file and execute the transformed native
object/review API, IPC, media, thread, provider, and save paths with controlled
stubs. They verify identity propagation, premature-completion prevention,
invalid-output/media failures, thread isolation, callback limits, and safety.
The image workflow also verifies the installed patch byte-for-byte, imports the
actual Frigate modules with the image's dependencies, and reruns these tests
inside the built container before publishing. No camera or GPU is used in CI;
these checks are not a substitute for testing the deployment's AMD hardware and
validated configuration.
