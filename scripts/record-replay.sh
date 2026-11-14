#!/usr/bin/env bash
# Turns a finished job into a recorded session that the replay backend can play back.
#
# Usage: scripts/record-replay.sh <workspace> <artifact id> <version> <name>
#
# It copies the files the agent ended up with from
#   <workspace>/.codjiva/artifacts/<artifact id>/v<version>/
# into fixtures/replay/<name>/turn-1/files/, and writes a cleaned copy of the agent's output to
# fixtures/replay/<name>/turn-1/stdout.jsonl. The recording holds the final sources, after any
# fix rounds, so playing it back gives a result that passes its checks in one turn.
#
# The agent's raw output names folders of the machine it ran on and repeats the content of
# every file it read. The cleaned copy keeps only what the app shows: the start of the session,
# the agent's messages and tool calls with paths made relative to the workspace, and the result.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
workspace="$(cd "$1" && pwd -P)"; id="$2"; version="$3"; name="$4"
from="$workspace/.codjiva/artifacts/$id/v$version"
to="$root/fixtures/replay/$name/turn-1"
[ -f "$from/manifest.json" ] || { echo "No finished version at $from" >&2; exit 1; }
rm -rf "$root/fixtures/replay/$name"
mkdir -p "$to/files"
cp "$from/model.json" "$to/files/model.json"
[ -f "$from/outline.json" ] && cp "$from/outline.json" "$to/files/outline.json"
cp -R "$from/src" "$to/files/src"
python3 -I - "$from/agent.log.jsonl" "$to/stdout.jsonl" "$workspace" "$id" "$version" <<'PY'
import json, sys
source, target, workspace, artifact, version = sys.argv[1:6]
# The recording may be played back for any version number, so paths inside the version folder
# are written without it.
version_dir = f".codjiva/artifacts/{artifact}/v{version}/"

def relative(text):
    return text.replace(workspace + "/", "").replace(workspace, ".")

def clean(value):
    if isinstance(value, str):
        return relative(value)
    if isinstance(value, list):
        return [clean(item) for item in value]
    if isinstance(value, dict):
        return {key: clean(item) for key, item in value.items()}
    return value

kept = []
for line in open(source, encoding="utf-8"):
    try:
        event = json.loads(line)
    except ValueError:
        continue
    kind = event.get("type")
    if kind == "system" and event.get("subtype") == "init":
        kept.append({"type": "system", "subtype": "init", "session_id": "recorded-session", "model": event.get("model")})
    elif kind == "assistant":
        blocks = []
        for block in event.get("message", {}).get("content", []):
            if block.get("type") == "text":
                blocks.append({"type": "text", "text": relative(block.get("text", ""))})
            elif block.get("type") == "tool_use":
                given = clean(block.get("input", {}))
                # What a tool wrote is in the files folder already; the log keeps only where.
                for key in ("content", "new_string", "old_string"):
                    if key in given:
                        given[key] = ""
                blocks.append({"type": "tool_use", "name": block.get("name"), "input": given})
        if blocks:
            kept.append({"type": "assistant", "message": {"content": blocks}})
    elif kind == "result":
        usage = event.get("usage", {})
        kept.append({"type": "result", "subtype": event.get("subtype"), "is_error": event.get("is_error", False), "result": "", "session_id": "recorded-session",
                     "total_cost_usd": event.get("total_cost_usd"),
                     "usage": {key: usage.get(key, 0) for key in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens")}})
with open(target, "w", encoding="utf-8") as out:
    for event in kept:
        out.write(json.dumps(event, ensure_ascii=False) + "\n")
PY
if grep -q "/Users/\|/private/\|/home/" "$to/stdout.jsonl"; then
  echo "The cleaned log still names a folder of this machine. Not keeping it." >&2
  rm -rf "$root/fixtures/replay/$name"
  exit 1
fi
echo "Recorded $(wc -l < "$to/stdout.jsonl" | tr -d ' ') events and $(find "$to/files" -type f | wc -l | tr -d ' ') files to fixtures/replay/$name"
