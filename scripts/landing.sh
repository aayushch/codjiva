#!/usr/bin/env bash
# Prepares the generated parts of the landing page in landing/, so the folder can be published
# or opened locally:
#
#   landing/demo/    the reference film, visual and pipeline, each built into one HTML page
#   landing/fonts/   the app's font files
#
# Both folders are git-ignored. The Pages workflow runs this script before it publishes
# landing/. To look at the page on your own machine:
#
#   scripts/landing.sh && python3 -m http.server --directory landing 8080
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

mkdir -p landing/demo landing/fonts
for name in film visual pipeline; do
  cargo run --quiet --release -p codjiva-build -- "runtime/reference/$name" "landing/demo/$name.html"
done
cp resources/fonts/*.woff2 resources/fonts/OFL.txt landing/fonts/
echo "The landing page is ready in $root/landing"
