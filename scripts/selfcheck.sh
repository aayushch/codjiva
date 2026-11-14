#!/usr/bin/env bash
# Builds the desktop app in debug mode and runs its self-check: the real window opens, tours
# itself, saves screenshots and a report, and quits. Exits with 0 when every check passed.
#
# Usage: scripts/selfcheck.sh [workspace folder] [output folder]
#
# To also run a Visualise job on a file of the workspace, set VISUALISE to its path relative to
# the workspace, and optionally INSTRUCTIONS. The job uses a real agent unless REPLAY names the
# folder of a recorded session. A job writes a .codjiva folder into the workspace, so use a copy
# of a fixture, not a folder you care about:
#
#   VISUALISE=internal/orders/handler.go REPLAY=fixtures/replay/go-orders scripts/selfcheck.sh /tmp/go-orders-copy
#
# CANCEL_AFTER=20 cancels the Visualise job after that many seconds and checks that it stops.
#
# ANIMATE works like VISUALISE and runs an Animate job, which makes a one-minute film, or one of
# LENGTH seconds. FEEDBACK is a sentence of feedback to send about that film, which makes a
# second version of it.
#
# COMPOSE=a.go,b.go joins the visuals those files already have into a still pipeline. With
# COMPOSE_FILM=1 the pipeline is a film of LENGTH seconds.
#
# SETTINGS names a settings file for the run to start with, for example to pick a model.
# NO_BUILD=1 runs the app as it was last built.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
workspace="${1:-$root/runtime}"
out="${2:-$root/target/selfcheck}"
rm -rf "$out"
mkdir -p "$out/config"
if [ -n "${VISUALISE:-}" ]; then
  export CODJIVA_SELFCHECK_VISUALISE="$VISUALISE"
  export CODJIVA_SELFCHECK_INSTRUCTIONS="${INSTRUCTIONS:-}"
  export CODJIVA_SELFCHECK_CANCEL_AFTER="${CANCEL_AFTER:-}"
fi
if [ -n "${ANIMATE:-}" ]; then
  export CODJIVA_SELFCHECK_ANIMATE="$ANIMATE"
  export CODJIVA_SELFCHECK_INSTRUCTIONS="${INSTRUCTIONS:-}"
  export CODJIVA_SELFCHECK_FEEDBACK="${FEEDBACK:-}"
  export CODJIVA_SELFCHECK_LENGTH="${LENGTH:-}"
fi
if [ -n "${COMPOSE:-}" ]; then
  export CODJIVA_SELFCHECK_COMPOSE="$COMPOSE"
  export CODJIVA_SELFCHECK_COMPOSE_FILM="${COMPOSE_FILM:-}"
  export CODJIVA_SELFCHECK_LENGTH="${LENGTH:-}"
  export CODJIVA_SELFCHECK_INSTRUCTIONS="${INSTRUCTIONS:-}"
fi
if [ -n "${REPLAY:-}" ]; then
  export CODJIVA_REPLAY_DIR="$(cd "$REPLAY" && pwd)"
fi
# A job with a real agent can take many minutes.
limit="${LIMIT_SECONDS:-120}"

if [ -n "${SETTINGS:-}" ]; then
  cp "$SETTINGS" "$out/config/settings.json"
fi
if [ -z "${NO_BUILD:-}" ]; then
  (cd "$root/ui" && npx tauri build --debug --no-bundle >/dev/null)
fi

# The self-check uses its own settings folder so it never reads or changes the user's settings.
CODJIVA_SELFCHECK="$out" CODJIVA_SELFCHECK_WORKSPACE="$workspace" CODJIVA_CONFIG_DIR="$out/config" \
  "$root/target/debug/codjiva-app" >"$out/app.log" 2>&1 &
pid=$!
for _ in $(seq 1 "$limit"); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 1
done
if kill -0 "$pid" 2>/dev/null; then
  kill "$pid"
  echo "The app did not finish its self-check within $limit seconds." >&2
  exit 1
fi
status=0
wait "$pid" || status=$?
if [ -f "$out/report.json" ]; then
  python3 -I -c '
import json, sys
report = json.load(open(sys.argv[1]))
for check in report["checks"]:
    mark = "ok    " if check["ok"] else ("skip  " if check.get("skipped") else "FAIL  ")
    print(mark + check["name"] + ("" if check["ok"] or not check.get("detail") else "\n      " + str(check["detail"])))
print("platform:", report.get("platform"), "|", report.get("userAgent"))
' "$out/report.json"
else
  echo "The app quit without writing a report. Its output is in $out/app.log" >&2
  status=1
fi
echo "Screenshots and report: $out"
exit "$status"
