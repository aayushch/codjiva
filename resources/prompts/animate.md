# Job: Animate (a film)

Produce a short film that follows the work through the subject and its companions, chapter by chapter, in the
blueprint world. Target length: **{{length}} seconds** of real time. The runtime computes real time from your
animation lengths and bubbles (see "Films" in the runtime API below); aim within 20% of the target.

## Files to write

| File | Content |
|------|---------|
| `{{artifactDir}}/model.json` | The analysis (schema `model.schema.json`). |
| `{{artifactDir}}/outline.json` | The chapters: id, title, one-line summary, beats (schema `outline.schema.json`). **Write it right after `model.json`, then keep going.** The app shows it to the user while you work. |
| `{{srcDir}}/plant.js` | The one world for the whole film. |
| `{{srcDir}}/film.json` | Title, legend, and for each scene its length, camera moves, bubbles and sound cues. |
| `{{srcDir}}/scenes/<id>.js` | One file per chapter: `CJ.scene('<id>', { init, render })`. |
| `{{srcDir}}/extra.css` | Optional. Only for something the parts cannot draw. |

Report progress in `{{artifactDir}}/progress.json` with these phases, in order: `reading`, `analysing`,
`outline`, `drawing`, then `chapter` once per scene file as `{"phase": "chapter", "chapter": 2, "of": 6}`, and
`done` at the end.

## Story (the most important part)

1. **One world.** Draw one plant that holds every machine the story needs. Every chapter is a camera view of
   that same plant. Never draw a separate diagram for a chapter.
2. **One unit of work, from start to natural end.** Follow a single item, or one stream of items, from where it
   enters to where it naturally ends: the end of the stream, the response sent, the record committed, the job
   done. The film's order is the **order in which things happen**, not the order of topics.
3. **Special cases happen inside the flow.** Mode switches, limits, flushes and errors appear at the moment
   they would occur for this unit of work. They are not separate chapters at the end.
4. **Forks, then rewind.** When the story must show a branch that ends the run, such as a hard limit or a fatal
   error, play the fork to its end. Then put `"rewind": { "until": t }` on the next scene, play the fork's
   events backwards in that scene's first `t` animation seconds, and continue the normal path to its natural
   end.
5. **Chapters.** 4 to 8. The first is a short **overview**: the whole plant, one packet runs the main path, the
   legend is visible, and it lasts at most 20 real seconds. Every other chapter has a title `n · Short title`.
6. **Every chapter moves work.** No still chapters. If a chapter explains a structure, show work flowing
   through it.
7. **Continuity.** The first state of a chapter equals the last state of the chapter before it: the same
   packets in the same places, the same gauge levels, the same lamps. The self-test checks this.

## Camera

- Each chapter starts from the framing the previous chapter ended on. Declare only the moves.
- The first move of a chapter zooms in to where the action is, with `dur` 0.8 to 1.2. Pull back before moving
  far across the plant.
- No idle drifting. Hold still while a bubble is up unless the bubble is about the motion.
- Keep `z` between 1.0 (the whole plant) and 1.85 (one machine). Keep the action and its bubble in view.

## Pace and bubbles

- A typical chapter has 8 to 16 seconds of animation and 2 to 5 bubbles. For a target of {{length}} real
  seconds, budget each chapter with the formula in the runtime API before you write it, and write the budget
  into `outline.json` as each beat's `t`.
- Put a bubble **exactly** where the thing happens: `at` is the animation time of the event. Place it beside
  the part, with the tail pointing at it.
- One bubble at a time. Space bubbles at least 1.5 animation seconds apart.
- Alarm bubbles are for limits hit, data dropped, errors and forced ends.

## Motion

- Packets move along the plant's routes with `CJ.eio` easing, 0.8 to 1.6 seconds for a pipe run.
- A press strikes down fast and rises slowly. The mark appears inside the packet at the strike.
- Merges: packets slide into the slots of a crate, then the crate closes and moves on as one batch packet.
- Gauges and tanks fill smoothly. Lamps fade over 0.2 to 0.4 seconds.
- Errors: a warning token pops up, the packet drops into the drop bin, the line pauses.
- Nothing teleports. Nothing changes size to get attention. A moving packet keeps its size.
- `render(t, ctx)` must be pure: compute every position and state from `t`. The user scrubs backwards and
  forwards, and the self-test renders times out of order.

## Sound

Declare `cues` at event times. Sound is muted unless the user turns it on, so the film must be complete without
it. At most one cue per second.

## Layout for films

The layout rules of the core guide apply at **every moment** of the film, in the camera's view at that moment.
For each bubble, work out where the camera is at `at`, and check that the bubble's box is inside the view and
does not cover the part it explains, a moving packet's path during the hold, or another label. The title band
covers the top 110 px of the stage.
