Custom Frigate image based on the official **0.18.2 ROCm release**, for **linux/amd64**.

```text
ghcr.io/outlain/frigate-intermediary:0.18.2-rocm-v1
```

Includes the official release's software and security fixes, plus the optional
AI Intermediary completion bridge and individual review-regeneration API.
Preserves catch-up attempt identity, completion/failure reporting, and stable
live review processing. The intermediary still controls GPU priority and
serialization. Enable `FRIGATE_INTERMEDIARY_BRIDGE=1` in the existing Frigate
service and keep its Ollama description provider pointed at the intermediary.

The official base is pinned to
`ghcr.io/blakeblackshear/frigate:0.18.2-rocm@sha256:5c852fb2cda16fc7d642128df0d4cbdba67477282480f83d6f3ba188c3ae5728`.
Eight upstream source files are hash-checked before patching. Publication follows
exact-source integration tests, an installed-code check, real Frigate import
checks, and tests inside the built container. CI does not exercise an AMD GPU,
camera streams, or a user's database.

**Migration notice:** the previous `bb6c2e9-v1` image used a 0.19 development base.
Its configuration and database may already have been migrated beyond 0.18.2.
Do not simply replace that image tag on live volumes. Preserve a complete backup,
convert and validate copied configuration, and assess the copied database first.
This image does not rewrite or downgrade existing configuration/database files.

[Build, enable, migration and rollback documentation](https://github.com/Outlain/ai-intermediary/blob/codex/frigate-0.18.2-rocm/integrations/frigate/README.md).
The attached `image-digest.txt` identifies the exact published image.
