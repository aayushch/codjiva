# Job: Step through (a visual the viewer can run)

Produce a **step-through** of the subject: a drawing of its states and transitions that the viewer runs on an
input. They type an input or pick an example, and step forwards and backwards through what the code does with
it. At every step they see the state the code is in, the transition it took, the actions that ran, the value of
every variable and the outputs so far.

You write the drawing, the data and **one step function**. The runtime draws every control and every panel.
Read "Step-throughs" and "State machines" in the runtime API below before you start.

## Files to write

| File | Content |
|------|---------|
| `{{artifactDir}}/model.json` | The analysis (schema `model.schema.json`). |
| `{{srcDir}}/plant.js` | The drawing: one `CJ.state` per state, one `CJ.edge` per transition. |
| `{{srcDir}}/visual.json` | Title, camera, nodes with their detail, markers, and the `stepper` (schema `visual.schema.json`). |
| `{{srcDir}}/sim.js` | `CJ.defineSim({ init, step, vars, outputs })`: the code, restated one step at a time. |

Report progress in `{{artifactDir}}/progress.json` with these phases, in order: `reading`, `analysing`,
`drawing`, `stepping` (when you write `sim.js`), `annotating` (when you write `visual.json`), then `done`.

## What suits a step-through

Code whose behaviour depends on the input it is given, piece by piece: a state machine, a rate limiter, a
validator, a retry loop, a reducer, a parser. The **input** is the thing a viewer would want to vary: the
sequence of events, the list of requests, the text being read.

If the input of the code is not a text, choose a plain encoding for it and say what it is in `stepper.input.hint`
and under `model.json → illustrative`: one character for each event, numbers separated by spaces. Keep the
encoding small enough to type.

## The states

1. **A state is a condition the code can be in between two pieces of input**, not a line of code. Name the
   states as the code does (an enum value, a constant, a label). Where the code has no name, use two or
   three plain words.
2. **6 to 16 states.** Fewer than 6 usually means you drew functions, not states. With more than 16, group the
   states that the viewer does not need to tell apart and say so in `model.json → omitted`.
3. **Every state is a node** of `visual.json`, with all the detail fields that apply (runtime API, "Node
   detail"): `refs` with `line` and `end` so that the app shows its code, `inputs`, `outputs`, `transitions`
   and `edgeCases`.
4. **Every transition is a `CJ.edge`** with its trigger as the label, and an entry of `stepper.edges`. A
   transition taken on a mismatch or an error is `kind: 'fallback'`.
5. Lay the states out so that the usual path reads left to right or top to bottom, and choose the camera so
   that the drawing fills the view: with `z` between 1.0 and 1.4, centred on the drawing. Loops and fallbacks go
   above and below the main line. Transitions never cross a state.

## The step function (the most important part)

1. **Restate the code, branch for branch.** Go through the source and write one branch of `step` for each
   branch that the input can reach. Give each one the `ref` of its line. If the code has a table, a limit or
   a list of literals, copy it exactly, even where it looks like a mistake.
2. **Do not tidy the code's behaviour.** A value that the code never resets is never reset in `step`. A check
   that the code makes too late is made too late. The viewer comes to see what the code really does.
3. **Trace two inputs by hand before you write it**, one usual and one that takes a fallback, and write down
   the state and the variables after every piece. Your step function must give the same.
4. **The variables** are the code's own, under their own names, shown as the code would print them
   (`61` for a counter, `VerdictDefer` for an enum). Include every variable that a transition depends on.
5. **The outputs** are what a caller of the code gets: the fields it filled, the value it returned, the
   records it pushed.

## The examples

- 3 to 9, each with a short label that says what it shows: `Three orders`, `A new window`, `Over the hard
  limit`. Together they take **every transition** at least once. The self-test lists the transitions that no
  example takes.
- **Take them from the code's tests** where the workspace has tests for this code. Give the test's `path:line`
  as `ref`, and its expected values as `expect`. The self-test then compares what your step function produces
  with what the real code is known to produce, and fails if they differ. This is the only check of your step
  function against the real code, so use every test that fits.
- Where there are no tests, write `expect` only for values you derived from the code by hand, and list the
  examples under `model.json → illustrative`.

## Edge cases

Writing the step function makes you resolve every branch, and that is where you find what a reader would not
expect. Record each one as an `edgeCase` of the state it belongs to, with the line that causes it and, where
an input shows it, that input as `example`. The viewer can load the example with one click. Look for:

- a comparison at a limit that includes or leaves out the limit itself, where a reader expects the other;
- the input that changes the state, and whether that same input is still handled as before;
- a count or a flag that keeps its value where a reader expects it to start again;
- what happens when the input ends in the middle of the work;
- a branch that no input can reach.

Only what the code shows. Do not write what the author probably meant.

## Rules specific to step-throughs

- The title says what is stepped through: `Limiter.Allow · one customer's orders, one at a time`. At most
  64 characters.
- Provide the layers `data` (the transitions), `control` (tables and gauges, if any) and `labels`
  (`[".pl", ".plt"]`).
- 2 to 5 markers, on the states where the overall design needs a sentence. Detail goes into the nodes.
- No packets at rest and no legend: the runtime shows where the code is.
- Drive anything in the drawing that changes, such as a `CJ.registers` table, through the plant's
  `set(R, S, t)` and return its values from `stage(m)` in `sim.js`.
