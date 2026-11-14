#!/usr/bin/env bash
# Regenerates every app icon file from design/icon/icon.svg.
# Needs rsvg-convert (librsvg) and the UI's node modules.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
png="$(mktemp -t codjiva-icon).png"
rsvg-convert -w 1024 -h 1024 "$root/design/icon/icon.svg" -o "$png"
cd "$root/ui"
npx tauri icon "$png" -o src-tauri/icons
rm -f "$png"
# The mobile icon sets are not used by a desktop-only app.
rm -rf src-tauri/icons/android src-tauri/icons/ios
