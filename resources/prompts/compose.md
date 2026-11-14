# Job: Compose (a pipeline across code boundaries)

Join existing artifacts where their code meets into one **pipeline**: a single world in which each artifact is
a **part**, drawn in its own **bay**, with pipes between the bays where work crosses from one part's code into
the next. You are making a pipeline **{{form}}**.

## What you are given

- The parts, in flow order, with the analysis and the plant of each. The app has copied each part's `plant.js`
  to `{{srcDir}}/parts/<key>/plant.js`. **Do not edit those copies.** They are drawn as they are, at a smaller
  scale.
- The joins the user confirmed: an `out` port of one part to an `in` port of another.
- `{{srcDir}}/pipeline.json`, already written: the parts, a first placement of their bays, and the joins.

## Files to write

| File | Content |
|------|---------|
| `{{artifactDir}}/model.json` | The analysis of the pipeline as a whole (schema `model.schema.json`): the unit of work that travels through all parts, the entry point of the first part, the steps in order across the parts, and the ports left open at both ends. Put a join you could not confirm in the code under `omitted`, with the reason. |
| `{{srcDir}}/pipeline.json` | Change only `title`, and each part's `bay` and `scale` if the first placement does not suit. Keep the keys, artifacts, versions and joins. Remove a join only if the code shows it is wrong. |
| `{{srcDir}}/plant.js` | The **yard**: draws each part in its bay and the join pipes between them. |
| `{{srcDir}}/visual.json` | For a pipeline visual: a node for each part and each join, a marker at each crossing. |
| `{{srcDir}}/film.json` and `{{srcDir}}/scenes/<id>.js` | For a pipeline film: the chapters. |

## The yard

`CJ.bay(key)` returns a handle on one part, placed as `pipeline.json` says:

| Member | What it is |
|--------|------------|
| `x`, `y`, `scale`, `width`, `height` | The bay's top-left corner in the yard's world, its scale, and its size in yard pixels (a part's sheet is 1920 × 1080 before scaling). |
| `draw(c)` | The markup of the part in its bay. Pass the yard's own `c`. |
| `point([x, y])` | A point of the part's own sheet, such as a port's `anchor`, as a point of the yard. |
| `routes()` | The part's routes, converted to the yard's world, so a packet of the yard can travel through the part. |
| `set(R, S, t)` | Applies state `S` to the part, merged over the part's own defaults. Call it from the yard's `set(R, S, t)`. |

```js
CJ.definePlant({
  draw({ c, extraSvg, extraHtml }) {
    const handler = CJ.bay('handler');
    const store = CJ.bay('store');
    const from = handler.point([1800, 870]);   // the out port's anchor on the handler's sheet
    const to = store.point([60, 560]);         // the in port's anchor on the store's sheet
    const midX = (from[0] + to[0]) / 2;
    // Two drawing layers with the bays between them: the join pipes lie under the parts, and whatever a
    // chapter adds through extraSvg travels above them.
    return `<svg class="art" viewBox="0 0 1920 1080">${CJ.grid(c('grid'))}${CJ.border()}
        ${CJ.pipe(c('join1'), `M${from[0]} ${from[1]} H${midX} V${to[1]} H${to[0]}`, 'hot')}</svg>
      ${handler.draw(c)}${store.draw(c)}
      <svg class="art" viewBox="0 0 1920 1080">${CJ.arrow(c('arrow1'), midX, (from[1] + to[1]) / 2, 'u')}${extraSvg}</svg>
      ${CJ.plate('write · Store.WriteBatch()', midX - 150, Math.min(from[1], to[1]) - 60)}${extraHtml}`;
  },
  refs() { return {}; },
  defaults: { storeFill: 0.2 },
  set(R, S, t) { CJ.bay('store').set(R, { fill: S.storeFill }, t); },
  routes(CJ) {
    const handler = CJ.bay('handler');
    const store = CJ.bay('store');
    return {
      inHandler: handler.routes().main,
      cross: CJ.route([handler.point([1800, 870]), store.point([60, 560])]),
      inStore: store.routes().main,
    };
  },
});
```

Read each part's `plant.js` for the names of its routes and state keys and for where its ports sit. Every part
must be drawn: the build fails if `CJ.bay('<key>')` is missing for a part.

## Rules

- **One unit of work across all parts**, from the first part's entry to the last part's natural end.
- **Bays left to right in flow order**, below the title band, with at least 40 px between them and to the edges.
- **Join pipes** run from the `out` port's anchor to the `in` port's anchor, orthogonal, in the hot colour. Label
  each with the boundary kind and the symbol on a plate: `write · Store.WriteBatch()`. A port without an anchor
  joins at the middle of the bay's nearest edge.
- **Name both sides at every crossing**: what leaves, what arrives, and whether it changes shape. In a visual
  this is a marker with a bubble on the join. In a film it is a bubble while the camera shows the crossing.
- **Keep each part's look.** Do not redraw its machines, and do not cover a bay with your own shapes.
- **Verify each join in the code.** Open the `out` port's `ref` and confirm the call there reaches the `in`
  port's symbol. A join that is wrong is not drawn; it goes into `model.json → omitted` with the reason.
- The layout rules of the core guide apply to what **you** draw in the yard: the plates, markers and bubbles.
  The inside of a bay was checked when the part was made and is not checked again.

## A pipeline visual

- The default camera shows the whole yard. The user zooms in to read a part.
- **Nodes**: one for each part, with `select: ["bay-<key>"]`, the part's title as `label`, and what the part does
  for the pipeline as `role`. One for each join, with `select` naming its pipe, the symbol as `label`, and `refs`
  to the `out` port's place in the code.
- **Markers**: one at each crossing, numbered in flow order, with a bubble that names both sides.
- **Layers**: `data` with the join pipes, and `labels` with `[".pl", ".plt"]`.

## A pipeline film

- Follow the story rules of a film: one unit of work, in the order things happen, 4 to 8 chapters, the first a
  short overview of the whole yard. Target length: **{{length}} seconds** of real time.
- **Zoom in to a part while work is inside it; zoom out at each crossing.** A bay drawn at scale 0.4 needs a
  camera `z` near 2.5 to be read. Pull back to `z` 1.0 to 1.3 to show a crossing.
- Move packets along `CJ.bay(key).routes()` inside a part and along your own crossing routes between parts.
- Inside each part, show only the steps that matter to the pipeline. The part's own film covers the rest.
- If the unit changes shape at a join (an event becomes a record, a request becomes a row), show the change in
  the receiving part.
- Report progress with the phases `reading`, `joining`, `outline`, `drawing`, `chapter` and `done`, and write
  `{{artifactDir}}/outline.json` before you draw.

For a visual, the phases are `reading`, `joining`, `drawing`, `annotating` and `done`.
