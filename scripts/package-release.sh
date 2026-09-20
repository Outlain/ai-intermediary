#!/bin/sh
set -eu

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <container-image> <version-tag> <output-directory>" >&2
  exit 2
fi

image=$1
version=$2
output=$3

case "$version" in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "version tag must look like v1.0.0" >&2; exit 2 ;;
esac

bundle_name="ollama-scheduling-proxy-${version}-linux-amd64"
bundle_directory="${output}/${bundle_name}"

mkdir -p "${bundle_directory}/docs"
sed "s|__IMAGE__|${image}:${version}|g" deploy/docker-compose.release.yml > "${bundle_directory}/docker-compose.yml"
cp config.example.yml "${bundle_directory}/config.example.yml"
cp secrets.example.env "${bundle_directory}/secrets.example.env"
cp README.md SECURITY.md "${bundle_directory}/"
cp docs/INSTALL.md "${bundle_directory}/docs/INSTALL.md"
cp docs/SOURCES_AND_SCHEDULES.md "${bundle_directory}/docs/SOURCES_AND_SCHEDULES.md"
cp docs/HOME_ASSISTANT.md "${bundle_directory}/docs/HOME_ASSISTANT.md"
cp docs/RELEASING.md "${bundle_directory}/docs/RELEASING.md"
mkdir -p "${bundle_directory}/integrations/frigate"
cp integrations/frigate/README.md integrations/frigate/Dockerfile integrations/frigate/apply_bridge.py integrations/frigate/bridge.py "${bundle_directory}/integrations/frigate/"
mkdir -p "${bundle_directory}/integrations/host"
cp integrations/host/README.md integrations/host/host_helper.py integrations/host/ollama-intermediary-host.service integrations/host/ollama-intermediary-host.sudoers integrations/host/host-helper.env.example integrations/host/compose.host-helper.example.yml "${bundle_directory}/integrations/host/"
cp integrations/host/install.py integrations/host/installer-compose.mjs "${bundle_directory}/integrations/host/"
printf '%s\n' "$version" > "${bundle_directory}/VERSION"

tar -C "$output" -czf "${output}/${bundle_name}.tar.gz" "$bundle_name"
(cd "$output" && sha256sum "${bundle_name}.tar.gz" > "${bundle_name}.tar.gz.sha256")

echo "${output}/${bundle_name}.tar.gz"
