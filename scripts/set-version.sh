#!/usr/bin/env bash
# Sets the version of the app in every file that records it: the Tauri configuration, the
# interface's package.json and its lock file, and the Cargo workspace and its lock file.
#
# Usage: scripts/set-version.sh 0.2.0
#
# The release workflow runs this with the name of the tag, without the leading "v". The app's
# updater compares this version with the one in the latest release, so an installer must be built
# with the version of its tag. Run it by hand, and commit, before you make the tag.
set -euo pipefail
version="${1:-}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$ ]]; then
  echo "usage: $0 <version>, for example 0.2.0" >&2
  exit 1
fi
root="$(cd "$(dirname "$0")/.." && pwd)"

node -e '
  const fs = require("fs");
  const [version, ...files] = process.argv.slice(1);
  for (const file of files) {
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    json.version = version;
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
  }
' "$version" "$root/ui/src-tauri/tauri.conf.json" "$root/ui/package.json"

# The lock file of the interface records the version of its package too.
(cd "$root/ui" && npm install --package-lock-only --ignore-scripts --no-audit --no-fund >/dev/null 2>&1) \
  || echo "warning: ui/package-lock.json could not be refreshed" >&2

# Every crate takes its version from the [workspace.package] table of the top Cargo.toml.
sed -i.bak -E "s/^version = \"[^\"]*\"/version = \"$version\"/" "$root/Cargo.toml"
rm -f "$root/Cargo.toml.bak"
(cd "$root" && (cargo update --workspace --offline >/dev/null 2>&1 || cargo update --workspace >/dev/null))

echo "The version is now $version."
