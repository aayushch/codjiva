# Job: Fix

You are changing an existing artifact in `{{artifactDir}}`. Its files are already there. You are given either a
**report** from the build or the self-test, or **feedback** from the user.

## Rules

1. **Change only what the report or the user points at.** If one label overlaps another, move or shorten that
   label. Do not change other elements, other chapters or shared styles unless told "everywhere" or "all".
2. **A report issue names the elements.** `a` and `b` each describe one element: its `selector`, its `text`
   and two boxes, both written as `[x, y, width, height]`.
   - `world` is the element's box in world pixels. These are the coordinates you write: the positions in
     `plant.js` and in the scene files, and the `x` and `y` of a marker or a bubble. Use `world` to decide
     where to move an element and by how much.
   - `box` is the same element in stage pixels, as the camera shows it at that moment. The camera scales and
     shifts the world, so the numbers in `box` are not the numbers in your files. Never copy a number from
     `box` into your files. An element outside the world, such as the title, has only `box`.
   - `overlap` is `[across, down]`: how far two overlapping labels reach into each other, in world pixels.
     Moving one of them sideways by more than `across`, or up or down by more than `down`, separates them.
   - To find an element, search your files for the name in its selector without the prefix:
     `.budget-plate3` is `c('plate3')`. If that name is not in your files, because you built it in a loop or
     gave the element no class (its selector then looks like `div.pl:nth-child(7)`), search for the
     element's `text`.
   - An element with `drawnBy` is not in your files under its own name. `drawnBy` names the call or the entry
     that draws it, and `move` says which arguments of that call place it. Find that call and change those
     arguments.
3. **Do not change the story** to fix a report: not the chapter order, not what is shown. If an issue can only
   be fixed that way, do not fix it; write the reason in `progress.json → note` and stop.
4. **Look at the neighbourhood after the fix.** Moving one label must not crowd another. Recompute the boxes of
   everything within 200 px of what you changed and check the gaps again.
5. **Keep numbers consistent.** If you move a part in `plant.js`, update the routes, labels, markers, bubbles
   and camera keys that refer to it.
6. **Prefer the smallest change**: nudge a position, shorten a label, widen a box, move a marker or a bubble.
7. **Build errors** (a schema error, a forbidden construct, a missing file) name the file and line. Fix exactly
   that.
8. **Feedback about meaning** ("this is wrong, the limit is per stream") is a correction to the analysis: check
   the code, update `model.json` with refs, then change only what depends on it.

Write what you changed in `progress.json → note` (one line per change, with the file name) and end with
`{"phase": "done"}`.
