# Job: Visualise (a still, interactive visual)

Produce a **still** blueprint of the subject that the user can explore: pan, zoom, hover a part to highlight it,
click it to see its role and code references, toggle layers, and open numbered markers that show bubbles. There
is no timeline and nothing moves.

## Files to write

| File | Content |
|------|---------|
| `{{artifactDir}}/model.json` | the analysis (schema `model.schema.json`) |
| `{{srcDir}}/plant.js` | `CJ.definePlant({ draw, refs, defaults, set, routes, nodes, ports })` — the world |
| `{{srcDir}}/visual.json` | title, camera, state, layers, nodes, markers, legend (schema `visual.schema.json`) |
| `{{srcDir}}/extra.css` | optional and rarely needed; theme variables only |

## What a good visual shows

- The **whole path** of the unit of work in one view, left to right, from entry to natural end, including the
  branch exits and where errors go.
- **A representative state.** Choose `state` so the interesting parts are visible at once: a part-filled tank,
  a gauge near a threshold, the default mode lamp lit. Draw a few packets at rest along the path, directly in
  `draw()`, each wrapped in `<g transform="translate(x y)">` at a point on its pipe's centre line or in a bin
  slot.
- **Nodes** for every part that stands for something in the code: each machine, press, bin, queue, tank, gauge
  and tally board. A node has an `id`, a short `label` (the real name), a one-sentence `role`, `refs` (`path` and
  `line`), and `select` (the unprefixed name of the part's element). A visual of one file usually has 6 to 12
  nodes. A part without a node is a dead spot when the user clicks it.
- **Layers** so the user can declutter. Provide all four: `data` (pipes, bins, drums, packets), `control`
  (wires, lamps, gauges, tanks, tally boards), `errors` (drop bins, warnings) and `labels` (`[".pl", ".plt"]`).
- **3 to 8 markers**, numbered in reading order along the flow. Each opens one bubble (§6 of the core guide).
  Put a marker on the edge or corner of the part it is about, clear of every plate and label.
- **Ports** at the sheet edges for anything that crosses a boundary, with a plate naming the symbol.
- A **legend** row for each packet kind you drew.

## Rules specific to visuals

- Use the default camera `{ "cx": 960, "cy": 560, "z": 1 }`, which shows the whole sheet below the title band.
  Draw the plant so that it fills the usable sheet (§7) at that framing.
- The title says what the visual shows and at what moment: `OrderHandler · a batch about to flush`. At most 64
  characters.
- Give every clickable machine one element, the `CJ.machine` itself, and list its name in the node's `select`.
- Keep the plant ready for a film: put the routes packets would travel in `routes()`, and drive everything that
  could change through `set(R, S, t)` and `defaults`, even though the visual shows one state.
- Draw one `CJ.arrow` on each pipe run to show the direction of flow.

Write `progress.json` phases in this order: `reading` → `analysing` → `drawing` → `annotating` → `done`.
`annotating` is when you write `visual.json`.
