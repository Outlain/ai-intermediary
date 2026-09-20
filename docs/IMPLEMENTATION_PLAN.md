# Intermediary reliability and Frigate catch-up

The source/schedule redesign is documented in [Sources and schedules](SOURCES_AND_SCHEDULES.md).
It generalizes the original defaults below to numeric priorities, configurable
catch-up order, per-source identification/pauses and recurring windows. The
single-inference gate, durable attempt correlation and recovery boundaries remain.

Implementation target: Frigate `0.19.0-bb6c2e9`, with an optional version-pinned
completion bridge and capability checks rather than assuming a version number
guarantees an API. Existing operator config,
credentials, media, and Docker overrides must not be replaced.

## Agreed behavior

- Odysseus first, then live Frigate, then background catch-up. Never preempt an
  already running GPU request. Respect the configured Odysseus idle hold (1m in
  the example). Arbitrary model names continue to work.
- Automatic discovery starts at first enablement. A protected "Fill missing
  descriptions" action scans retained history, respecting Frigate settings.
- Persist metadata-only object and review jobs, merged newest-event-first.
  Frigate retains and reads the media; no image copies in the intermediary.
- Skip descriptions already present at the final fresh check. Frigate cannot
  atomically exclude a concurrent live/manual completion between check and PUT.
  Confirm completion in Frigate after
  an accepted regeneration request. Retry transient errors with backoff;
  explain expired/missing media without retrying it forever.
- The operator approved preparing a small, pinned Frigate integration; deployment
  is a separate operator action. The bridge carries a per-attempt identifier
  through native processing and reports its final result. Never infer correlation
  from timing, prompts, camera/model names, or the next untagged request.
- With verified bridge support, retain one active native generation attempt and
  one GPU inference at a time. Finished native generations can await Frigate's
  saved description independently (default 4, configurable 1–16). A confirmed
  native failure moves to retry backoff without the saved-result timeout blocking
  the next eligible job. A provider HTTP response alone is not native completion.
- Without the bridge, keep the conservative single-unconfirmed-handoff behavior.
  Ambiguous outcomes never justify GPU overlap; delayed or duplicate attempt
  reports cannot complete a newer attempt. Existing queued jobs and retry policies
  survive schema migration. Rolling back to a schema-1 reader requires the
  matching pre-upgrade state backup, not editing the schema number.
- Settings UI for ordinary configuration; secrets.env for credentials. Manual
  pause also stops catch-up; normal camera recording/detection stays in Frigate.

## Workstreams

1. Strict scheduling, bounded queue memory/metrics, safe endpoint classification.
2. Stream outcome handling, downstream closure, persistent GPU recovery latch,
   consistent status authorization, safe settings restart.
3. Durable Frigate client/discovery/eligibility/retry/reconciliation subsystem.
4. Configuration validation, settings and dashboard controls, status/HA fields.
5. Mock integration/regression tests, browser verification, deployment and HA
   documentation. Live camera/GPU verification still requires the user's host.
6. [Pinned Frigate bridge](../integrations/frigate/README.md), native-attempt
   lifecycle, strict live/background classification, bounded save verification,
   conservative fallback, and phase-specific UI. Existing context-size errors
   remain request/model configuration issues; the bridge does not cure them.

## Safety boundaries

No GPU driver reset, Docker socket, arbitrary Compose editor, or automatic
Frigate modification/deployment. Preparing the pinned bridge is authorized;
replacing the running camera service is not. A healthy metadata endpoint does not prove GPU health.
Recovery acknowledgment requires an operator to verify the real GPU, and is
separate from ordinary pause/resume. Development Frigate behavior may change.

## Completion checks

- Test strict priority/leases, failed and interrupted streams, maintenance,
  restart preservation, auth and redaction, queue bounds, both regeneration
  APIs, discovery boundaries, pagination, persistence, missing media, retries.
- Test matched failure progression, delayed saves, the verification cap, stale
  reports, multi-request native attempts, restart ambiguity, ticket redaction,
  persistence failure, and compatibility mode. Never release the physical GPU
  guard merely because a native report arrives.
- Show build identity, backlog state and failures without prompts or images.
- Document upgrading without replacing settings/secrets/state and distinguish
  automated mock verification from unperformed live Frigate/ROCm tests.

## Verification performed

- Automated unit and local mock HTTP integration checks cover both native APIs,
  restart persistence, eligibility changes during tracking, strict scheduling,
  interrupted streams, recovery/management races, authorization and UI contracts.
- Isolated headless Chrome checks passed at desktop, 390px and 320px widths.
  No real credentials or camera data were used.
- Deployment/publication checks run locally. Live Frigate, Docker deployment,
  AMD GPU health and Home Assistant still require the operator's environment.
