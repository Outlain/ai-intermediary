# Official Frigate 0.18.2 ROCm, linux/amd64 manifest. Pin the complete base,
# including its shipped dependencies and security fixes; never track dev/latest.
FROM ghcr.io/blakeblackshear/frigate:0.18.2-rocm@sha256:5c852fb2cda16fc7d642128df0d4cbdba67477282480f83d6f3ba188c3ae5728
COPY apply_bridge.py bridge.py /opt/ollama-intermediary-bridge/
RUN python3 /opt/ollama-intermediary-bridge/apply_bridge.py /opt/frigate
# Opt in explicitly in your Frigate Compose environment after configuring
# the description provider to use the intermediary. Disabled by default.
ENV FRIGATE_INTERMEDIARY_BRIDGE=0
LABEL org.opencontainers.image.description="Frigate 0.18.2 ROCm with optional AI Intermediary completion bridge and individual review regeneration"
LABEL org.opencontainers.image.base.name="ghcr.io/blakeblackshear/frigate:0.18.2-rocm"
LABEL org.opencontainers.image.base.digest="sha256:5c852fb2cda16fc7d642128df0d4cbdba67477282480f83d6f3ba188c3ae5728"
