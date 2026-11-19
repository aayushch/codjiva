# Job: a view (drawn by the runtime from your data)

A view is not drawn by you. You write **data** into `view.json`, and the Codjiva runtime lays it out and draws
it. So this job has no `plant.js`, no coordinates, no layout numbers and no drawing code. Sections 3, 4 and 7
of the core guide, which are about drawing, do not apply. Everything else does: never invent behaviour, give a
`path:line` for every claim, and write the analysis first.

Because you do not draw, **all your effort goes into the content**. A view may hold far more than a drawing you
placed by hand could: every type, every field, every message, every function. Leave nothing out to save space.
The runtime finds the space.

## Files to write

| File | Content |
|------|---------|
| `{{artifactDir}}/model.json` | The analysis (schema `model.schema.json`). |
| `{{srcDir}}/view.json` | The view (schema `view-<name>.schema.json` in `{{schemasDir}}`). |

Report progress in `{{artifactDir}}/progress.json` with the phases `reading`, `analysing`, `annotating` (when
you write `view.json`) and `done`. A view that needs another file or another phase says so below.

Read "Views" in the runtime API below for the fields of `view.json`, and the finished example in
`{{referenceDir}}/views/` before you write.

## The nodes

Every view has `nodes`: the things of the code that the viewer can select. Selecting one shows its detail
beside the drawing, so give every node:

- `role`: one sentence on what it is for.
- `refs`: where it is in the code, with `line` and `end`. The app shows those lines.
- `edgeCases`: what a reader would not expect of it, each with the line that causes it. Look for them in every
  node. They are what makes a view worth opening.
- `rationale`, where the code shows why it is built this way (core guide §6).

A node's `id` is a short name without spaces. Use the code's own name where it is a valid id (`Order`,
`flushLocked`), and keep ids stable when you regenerate.

The title says what the view shows, in at most 64 characters.
