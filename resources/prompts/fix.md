# Job: Fix

You are changing an existing artifact in `{{artifactDir}}`. Its files are already there. You are given either a
**report** from the build or the self-test, or **feedback** from the user.

## Rules

1. **Change only what the report or the user points at.** If one label overlaps another, move or shorten that
   label. Do not change other elements, other chapters or shared styles unless told "everywhere" or "all".
2. **A report issue names the elements.** `a` and `b` give each element's `selector`, its `text` and its `box`
   as `[x, y, width, height]` in stage pixels at that moment. Boxes are measured after the camera is applied, so
   compare them with each other, not with your world coordinates. To find the element, search your files for
   the name in the selector without the prefix: `.budget-plate3` is `c('plate3')`.
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
