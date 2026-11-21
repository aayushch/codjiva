The artifact in {{artifactDir}} did not pass its checks. This is round {{round}} of {{maxRounds}}.

Fix exactly the errors below. Each one names a check, the elements involved, and a hint.

{{report}}

How to fix:
- Change only the elements an issue names. Do not redraw or restructure anything else.
- An issue's `a` and `b` each describe one element: its `selector`, its `text` and two boxes, both written as
  `[x, y, width, height]`.
  - `world` is the box in world pixels, the coordinates you wrote in your files. Work with these numbers.
  - `box` is the same element in stage pixels, as the camera shows it. Its numbers are not the numbers in
    your files, so never copy one into a file.
- `overlap` is `[across, down]`: how far two labels reach into each other, in world pixels. Moving one of them
  sideways by more than `across`, or up or down by more than `down`, separates them.
- To find an element, search your files for the name in its selector without the prefix. If the name is not
  there, search for the element's `text`.
- An element with `drawnBy` is drawn by the call or the entry that `drawnBy` names. `move` says which
  arguments of that call place the element. Change those arguments.
- A build error names a file and a line. Fix that line.
- After each change, recompute the boxes of everything within 200 px and make sure the fix did not crowd a
  neighbour.
- If an issue cannot be fixed without changing what the artifact shows, leave it and say why in
  {{artifactDir}}/progress.json → note.

When you are done, write {"phase": "done", "note": "<one line per change>"} to {{artifactDir}}/progress.json.
