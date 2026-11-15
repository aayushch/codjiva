#!/usr/bin/env bash
# Builds the installers for the system this is run on.
#
# Usage: scripts/build.sh [arguments for `tauri build`]
#
# A release also carries signed bundles for the app's own updater. Signing them needs the
# private key whose public half is in ui/src-tauri/tauri.conf.json, given in the environment
# variables TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD, as the release
# workflow does. Without the key this script leaves the updater bundles out, so that anyone can
# build the app. A build made that way still looks for updates and installs them.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root/ui"
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  exec npx tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}' "$@"
fi
exec npx tauri build "$@"
