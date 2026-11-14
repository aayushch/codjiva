The artifact in {{artifactDir}} did not pass its checks. This is round {{round}} of {{maxRounds}}.

Fix exactly the errors below. Each one names a check, the elements involved, and a hint.

{{report}}

How to fix:
- Change only the elements an issue names. Do not redraw or restructure anything else.
- An issue's `a` and `b` give each element's selector, text and box `[x, y, width, height]` in stage pixels at
  that moment, after the camera is applied. Search your files for the name in the selector without the prefix.
- A build error names a file and a line. Fix that line.
- After each change, recompute the boxes of everything within 200 px and make sure the fix did not crowd a
  neighbour.
- If an issue cannot be fixed without changing what the artifact shows, leave it and say why in
  {{artifactDir}}/progress.json → note.

When you are done, write {"phase": "done", "note": "<one line per change>"} to {{artifactDir}}/progress.json.
