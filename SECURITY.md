# Security policy

## Reporting a vulnerability

Please do not disclose suspected vulnerabilities in a public issue. Use the repository's **Security** tab to open a private security advisory with reproduction details, affected versions, and any suggested mitigation.

The service is intended for trusted LAN or VPN deployment. Its Ollama-compatible inference and model-management routes are intentionally unauthenticated, so it must not be exposed directly to the public internet. Protect it with a firewall or authenticated reverse proxy, and restrict direct access to the underlying Ollama API.

AI Intermediary requires one host-managed `ADMIN_TOKEN` for the dashboard, Settings, maintenance/recovery, Frigate controls and media gateway. It is an administrator credential, including when used by a monitoring integration; it is not a limited read-only account. Use a strong printable-ASCII password or randomly generated token without leading/trailing whitespace. The application refuses to start without this credential.

ComfyUI receives a separate machine credential derived from the administrator secret, not the administrator password itself. The host-side `scripts/configure-comfy-auth.py` tool writes it to a root-only environment file. That credential does not authorize administrator or media-gateway login. After changing `ADMIN_TOKEN`, reprovision the ComfyUI credential and restart only ComfyUI after active work finishes; otherwise media authentication fails closed.

These credentials do not authenticate ordinary Ollama-compatible routes. Dashboard and Settings retain credentials only in browser-tab session storage, never local storage, and share the login on the same origin. Dedicated media ports use separate browser origins and an HttpOnly, SameSite cookie after login. Bearer tokens are readable by anyone who can observe unencrypted HTTP traffic, so use the page only over a trusted LAN/VPN or terminate TLS at an authenticated reverse proxy. Keep administrator browser devices and `secrets.env` appropriately restricted.

The settings service intentionally has no Docker socket and cannot write `docker-compose.yml`, `config.yml`, or `secrets.env`. It stores only allowlisted, validated overrides in the state volume at `/app/state/settings.json`; host-managed token values are never returned to the browser. Backend URLs containing credentials, query strings, or fragments are rejected. Treat the state volume as deployment-sensitive: settings reveal internal network layout, and pending media workflows can contain private prompts and inputs.

Media support is opt-in and requires the authenticated ComfyUI bridge, verified host telemetry, and an explicit local-node allowlist. Custom nodes are executable Python code; allowing a node is not sandboxing it. Do not expose raw backend execution ports or install untrusted nodes. Unknown completion holds the shared GPU slot until safe reconciliation; do not delete durable state to bypass that guard.

Local deployment files such as `secrets.env` and `config.yml` must never be committed. The repository's publication check and ignore rules enforce this for normal workflows.
