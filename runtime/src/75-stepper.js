// The step-through: a visual whose drawing follows one input through the
// code, one step at a time.
//
// A step-through is a still visual with two additions. `visual.json` has a
// `stepper` object, which names the input, the examples, the transitions and
// the variables. `sim.js` registers a step function with CJ.defineSim. This
// file runs that function on an input, keeps the list of steps it returns,
// and draws the controls and the panels around the stage.
//
// The agent writes only data and the step function. Every control and every
// panel is drawn here, so that all step-throughs look and work alike.

/*@api
## Step-throughs (`sim.js`, and `stepper` in `visual.json`)

Only a step-through job writes these. A step-through is a visual that the viewer can run: they type an
input or pick an example, and step through what the code does with it. The runtime draws the controls, the
input, the variables, the outputs and the list of steps. You write the drawing, the data below and one
step function.

**The drawing.** `plant.js` draws the states with `CJ.state` and the transitions with `CJ.edge`. Every state
is a node of `visual.json`, with the detail fields of a node filled in (`inputs`, `outputs`, `transitions`,
`edgeCases`).

**`stepper` in `visual.json`:**

| Field | Meaning |
|-------|---------|
| `input` | `{ label, hint, maxLength }`. `label` names the input (`Orders`). `hint` says in one sentence what may be typed. `maxLength` is at most 500. |
| `presets` | 3 to 9 examples: `{ label, input, expect, ref }`. Choose them so that together they take every transition at least once. Take them from the code's own tests where there are tests: `ref` is then the test's `path:line`, and `expect` holds the values the test expects, as `{ outputName: value }`. The self-test runs every preset and fails when the final outputs differ from `expect`. |
| `edges` | Every transition: `{ id, from, to, when, select, ref }`. `from` and `to` are node ids. `when` is the trigger in a few words. `select` lists the unprefixed names of the `CJ.edge` parts that light up when the transition is taken. `ref` is the `path:line` of the code that makes the transition. |
| `variables` | `[{ name, meaning }]`: what `vars()` returns, in the order to show it. |
| `outputs` | `[{ name, meaning }]`: what `outputs()` returns, in the order to show it. |

**`sim.js`:**

```js
CJ.defineSim({
  // The memory of the code before the first step: its variables, and where it is in the input.
  // Plain data only (numbers, texts, booleans, arrays, plain objects).
  init(input) { return { p: 0, state: 'start', count: 0, out: '' }; },

  // Performs ONE step and changes `m` in place. Returns what happened, or null when the code has finished.
  step(m, input) {
    if (m.p >= input.length) return null;
    const ch = input[m.p++];
    m.count++;
    return {
      state: 'counting',            // the id of the node the code is in after this step
      edge: 'start-counting',       // the id of the transition it took, when it took one
      at: m.p - 1,                  // the index of the input character this step read, if it read one
      does: ['count++ → ' + m.count],     // the actions that ran, in the code's own names
      note: 'One more order in this window.',   // one sentence for the viewer
      tone: '',                     // '' (normal), 'ok' (something completed), 'warn' (a fallback or an
                                    // edge case) or 'error' (the code rejects the input)
      ref: 'internal/orders/limiter.go:63',     // the line that does this
    };
  },

  // What the panels show after each step. Format values as the code would print them.
  vars(m) { return { p: m.p, count: m.count }; },
  outputs(m) { return { result: m.out }; },

  // Optional: plant state for this moment, merged over the plant's defaults and given to its set().
  stage(m) { return { level: m.count / 60 }; },
});
```

Rules for the step function:

- **It is the code, not a story about the code.** Every branch of `step` restates one branch of the source,
  and its `ref` names that line. Do not simplify a rule, and do not leave out a case because it is rare:
  the edge cases are what the viewer comes for.
- **One step is one thing the viewer can follow**: one input character read, one transition, or one action
  that changes a variable. A typical example takes 5 to 80 steps.
- **It is pure and it ends.** No `Math.random`, no dates, no page access. The same input always gives the
  same steps. The runtime stops a run after 2000 steps and the self-test reports that as an error.
- A step's `state` must be the id of a node, and its `edge` the id of an entry of `stepper.edges` whose
  `from` is the previous step's state and whose `to` is this step's state.
- A value in `vars` or `outputs` is a number, a text, a boolean, or an array of those. An array of arrays
  or of plain objects is shown as one row per item.
*/

// A run that has not finished after this many steps is stopped, so that a
// step function with an endless loop cannot hang the page.
const MAX_SIM_STEPS = 2000;
// The longest input the viewer can type, whatever `stepper.input.maxLength`
// says.
const MAX_SIM_INPUT = 500;
// The time between two steps while a step-through plays at speed 1, in
// milliseconds.
const STEP_INTERVAL = 800;
// The speeds the viewer can choose.
const STEP_SPEEDS = [0.5, 1, 2, 4];

CJ.defineSim = (def) => {
  registry.sim = def;
};

// A copy of a value that shares nothing with the original, so that a later
// step cannot change what an earlier step recorded. A value that is not plain
// data becomes null.
const plainCopy = (value) => {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (e) {
    return null;
  }
};

// Runs the step function of sim.js on `input` and returns what it did:
//   - `steps`: one record per step, each with the state, the transition, the
//     input position, the actions, the note, the tone, the code reference,
//     and copies of the variables, the outputs and the plant state.
//   - `error`: null, or why the run could not be made. That is the case when
//     sim.js registered no step function, when the function threw, and when
//     it returned no step at all.
//   - `capped`: true when the run was stopped at MAX_SIM_STEPS.
const runSim = (input) => {
  const sim = registry.sim;
  const run = { steps: [], error: null, capped: false };
  if (
    !sim ||
    typeof sim.init !== 'function' ||
    typeof sim.step !== 'function'
  ) {
    run.error = 'sim.js must call CJ.defineSim({ init, step, vars, outputs }).';
    return run;
  }
  const TONES = { ok: 1, warn: 1, error: 1 };
  try {
    const memory = sim.init(input);
    for (;;) {
      const result = sim.step(memory, input);
      if (!result) break;
      if (run.steps.length === MAX_SIM_STEPS) {
        run.capped = true;
        break;
      }
      run.steps.push({
        state: String(result.state),
        edge: result.edge == null ? null : String(result.edge),
        at: Number.isInteger(result.at) ? result.at : null,
        does: Array.isArray(result.does) ? result.does.map(String) : [],
        note: result.note == null ? '' : String(result.note),
        tone: TONES[result.tone] ? result.tone : '',
        ref: result.ref ? String(result.ref) : null,
        vars: plainCopy(sim.vars ? sim.vars(memory) : {}) || {},
        outputs: plainCopy(sim.outputs ? sim.outputs(memory) : {}) || {},
        stage: sim.stage ? plainCopy(sim.stage(memory)) : null,
      });
    }
  } catch (e) {
    run.error = String((e && e.message) || e);
  }
  if (!run.error && !run.steps.length)
    run.error = 'The step function returned no step for this input.';
  return run;
};

// A value of `vars` or `outputs` as lines of text. A scalar is one line. An
// array of scalars is one line with commas. An array of arrays or of objects
// is one line per item.
const valueLines = (value) => {
  const scalar = (v) =>
    v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (!Array.isArray(value)) return [scalar(value)];
  if (!value.length) return [];
  const nested = value.some((item) => item && typeof item === 'object');
  if (!nested) return [value.map(scalar).join(', ')];
  return value.map((item) => {
    if (Array.isArray(item)) return item.map(scalar).join(', ');
    if (item && typeof item === 'object')
      return Object.keys(item)
        .map((key) => key + ': ' + scalar(item[key]))
        .join(', ');
    return scalar(item);
  });
};

// An example input as a button shows it: whole when it is short, and cut to
// its first 20 characters with an ellipsis when it is longer. The button's
// tooltip has the whole input.
const shortExample = (text) => {
  const all = String(text);
  return all.length > 24 ? all.slice(0, 20) + '…' : all;
};

// Builds the step-through around a visual that has been drawn.
//
// `visual` is the content of visual.json and `handle` what buildVisual
// returned for it. `post` sends a message to the app. `layout` is called when
// the controls have changed the room that is left for the stage.
//
// The controls go into the element with the id `stepbar`, above the stage,
// and the panels into the element with the id `steppanel`, to its right.
// CJ.boot creates both. This function adds the element with the id
// `stepgrip` before the panels: the handle that sets their height when they
// lie under the stage.
const buildStepper = (visual, handle, post, layout) => {
  const spec = visual.stepper;
  const bar = document.getElementById('stepbar');
  const panel = document.getElementById('steppanel');
  document.body.classList.add('stepper');

  // The handle that sets the height of the panels. It is shown only inside
  // the Codjiva app, where the panels are a strip under the stage, and it
  // lies on the top edge of that strip. Dragging it up makes the strip
  // taller and the stage smaller. Dragging it down does the opposite.
  //
  // The height is the custom property `--cj-strip-h` of the panels' element,
  // which the style sheet (runtime.css) reads only for the strip. The style
  // sheet also sets the least and the greatest height of the strip.
  //
  // The app remembers the height. This page tells the app the strip's height
  // in a `panel` message, and the app sends a `panel` message with the
  // remembered height when it opens a step-through (see `setPanelHeight`).
  const grip = document.createElement('div');
  grip.id = 'stepgrip';
  grip.setAttribute('role', 'separator');
  grip.setAttribute('aria-orientation', 'horizontal');
  grip.setAttribute('aria-label', 'Resize the panels');
  grip.title = 'Drag to resize the panels';
  panel.before(grip);

  // Tells the app how tall the strip is, if the height differs from the one
  // the app was told last. `byUser` is true when the viewer set the height by
  // dragging the handle, which is the height the app remembers. Nothing is
  // sent while the panels are a column beside the stage.
  let reportedHeight = null;
  const reportPanelHeight = (byUser) => {
    if (!document.body.classList.contains('embed')) return;
    const height = panel.offsetHeight;
    if (height === reportedHeight) return;
    reportedHeight = height;
    post({ cj: 'panel', height, byUser });
  };
  // Makes the strip `height` pixels tall, within the limits of the style
  // sheet, and fits the stage into the room that is left. A `height` that is
  // not a positive number gives the strip the height the style sheet starts
  // it with. The app calls this through the `panel` message.
  const setPanelHeight = (height) => {
    if (Number(height) > 0)
      panel.style.setProperty('--cj-strip-h', Math.round(height) + 'px');
    else panel.style.removeProperty('--cj-strip-h');
    layout();
    reportPanelHeight(false);
  };
  // A window that becomes lower can make the strip lower, because the strip
  // always leaves room for the stage.
  window.addEventListener('resize', () => reportPanelHeight(false));

  // While the handle is dragged: the id of the pointer, where it was pressed,
  // and how tall the strip was then. Null at every other time.
  let gripDrag = null;
  const endGripDrag = () => {
    if (!gripDrag) return;
    if (grip.hasPointerCapture(gripDrag.pointer))
      grip.releasePointerCapture(gripDrag.pointer);
    gripDrag = null;
    document.body.classList.remove('cj-sizing');
  };
  grip.addEventListener('pointerdown', (ev) => {
    // Cancelling the press keeps the browser from starting a text selection.
    ev.preventDefault();
    gripDrag = {
      pointer: ev.pointerId,
      y: ev.clientY,
      height: panel.offsetHeight,
    };
    grip.setPointerCapture(ev.pointerId);
    document.body.classList.add('cj-sizing');
  });
  grip.addEventListener('pointermove', (ev) => {
    if (!gripDrag) return;
    // A browser may not report a release that happens outside the page. A
    // move with no button pressed therefore also ends the drag.
    if (!ev.buttons) {
      endGripDrag();
      return;
    }
    const wanted = Math.max(1, gripDrag.height + gripDrag.y - ev.clientY);
    panel.style.setProperty('--cj-strip-h', wanted + 'px');
    // The style sheet's limits may have made the strip a different height
    // from the one asked for. The height it really has is the one kept.
    panel.style.setProperty('--cj-strip-h', panel.offsetHeight + 'px');
    layout();
    reportPanelHeight(true);
  });
  grip.addEventListener('pointerup', endGripDrag);
  grip.addEventListener('pointercancel', endGripDrag);

  const nodes = {};
  handle.nodes.forEach((entry) => {
    nodes[entry.node.id] = entry;
  });
  const edges = {};
  (spec.edges || []).forEach((edge) => {
    edges[edge.id] = edge;
  });
  const presets = spec.presets || [];
  const maxLength = Math.min(
    MAX_SIM_INPUT,
    (spec.input && spec.input.maxLength) || 200,
  );

  // What the viewer is looking at: the input, the run made from it, the
  // index of the step on screen, and whether the steps are playing.
  let input = presets.length ? String(presets[0].input) : '';
  let run = runSim(input);
  let index = 0;
  let speed = 1;
  let timer = null;

  // The marker that shows where the machine is: a small amber tag on the
  // top-right corner of the current state, with the character that was just
  // read. It is drawn in a layer of its own above the drawing.
  const layer = elementFromHtml(
    '<svg class="art cj-step-layer" viewBox="0 0 1920 1080">' +
      '<g class="cj-step-token"><rect x="-19" y="-14" width="38" height="28" rx="14" style="fill:var(--main)"/>' +
      '<text x="0" y="5.5" text-anchor="middle" style="font-size:15px;font-weight:700;fill:var(--ground)"></text></g></svg>',
  );
  handle.mounted.dimmer.before(layer);
  const token = layer.querySelector('.cj-step-token');

  // With `spec.input` the viewer types an input, and the bar has a field for
  // it, a row of examples and the input as a row of characters. Without it
  // the viewer only chooses among the examples, which then take the place of
  // the field. A lanes view works that way: its examples are its scenarios.
  const typed = !!spec.input;
  bar.innerHTML =
    '<div class="cj-sb-row">' +
    (typed
      ? '<label class="cj-sb-k" for="cj-input">' +
        CJ.esc(spec.input.label || 'Input') +
        '</label><input id="cj-input" type="text" spellcheck="false" autocomplete="off" maxlength="' +
        maxLength +
        '" title="' +
        CJ.esc(spec.input.hint || '') +
        '" placeholder="' +
        CJ.esc(spec.input.hint || '') +
        '">'
      : '<span class="cj-sb-k">' +
        CJ.esc(spec.choose || 'Example') +
        '</span><div id="cj-presets" class="cj-sb-presets cj-sb-grow"></div>') +
    '<div class="cj-sb-transport" role="group" aria-label="Steps">' +
    '<button id="cj-first" title="First step (Home)" aria-label="First step">⏮</button>' +
    '<button id="cj-prev" title="Previous step (Left)" aria-label="Previous step">◀</button>' +
    '<button id="cj-play" title="Play or pause (Space)" aria-label="Play">▶</button>' +
    '<button id="cj-next" title="Next step (Right)" aria-label="Next step">▶▏</button>' +
    '<button id="cj-last" title="Last step (End)" aria-label="Last step">⏭</button></div>' +
    '<div class="cj-sb-speeds" role="group" aria-label="Speed">' +
    STEP_SPEEDS.map(
      (s) => '<button data-speed="' + s + '">' + s + '×</button>',
    ).join('') +
    '</div></div>' +
    (typed
      ? '<div class="cj-sb-row"><span class="cj-sb-k">Examples</span><div id="cj-presets" class="cj-sb-presets"></div></div>'
      : '') +
    '<div class="cj-sb-row"><div id="cj-tape" class="cj-sb-tape"></div>' +
    '<div class="cj-sb-scrub"><span id="cj-count"></span><input id="cj-scrub" type="range" min="0" value="0" aria-label="Step"></div></div>';
  const $ = (id) => document.getElementById(id);
  const field = $('cj-input');
  if (field) field.value = input;

  presets.forEach((preset, i) => {
    const button = document.createElement('button');
    button.textContent = preset.label;
    button.title = preset.input;
    button.dataset.preset = String(i);
    button.addEventListener('click', () => setInput(String(preset.input)));
    $('cj-presets').append(button);
  });

  // The input position of every step: the index of the character the step
  // read or, for a step that read none, the position of the step before it.
  // -1 means nothing has been read yet.
  const positions = () => {
    let last = -1;
    return run.steps.map((step) => {
      if (step.at != null) last = step.at;
      return last;
    });
  };

  // The node whose details the panel shows: the one the viewer clicked, or
  // the state of the step on screen.
  let pinned = null;

  // Where the token goes for a node: the top-right corner of the node's first
  // element, in the units of the sheet.
  const cornerOf = (entry) => {
    const el = entry && entry.els[0];
    if (!el) return null;
    const world = handle.mounted.world.getBoundingClientRect();
    const k = world.width / STAGE_W || 1;
    const box = el.getBoundingClientRect();
    return [(box.right - world.left) / k - 30, (box.top - world.top) / k];
  };

  const lightState = (el, on) => {
    el.classList.toggle('cj-step-on', on);
    if (el.getAttribute('data-cj') === 'state')
      el.querySelectorAll('rect').forEach((rect) => {
        rect.style.stroke = on ? 'var(--main)' : 'var(--ink)';
      });
  };

  const drawStage = () => {
    const step = run.steps[index];
    const seen = {};
    for (let i = 0; i < index; i++) seen[run.steps[i].state] = 1;
    Object.keys(nodes).forEach((id) => {
      nodes[id].els.forEach((el) => {
        lightState(el, !!step && step.state === id);
        el.classList.toggle(
          'cj-step-seen',
          !!seen[id] && !(step && step.state === id),
        );
      });
    });
    Object.keys(edges).forEach((id) => {
      (edges[id].select || []).forEach((name) => {
        const refs = CJ.edge.refs(handle.mounted.q, name);
        if (refs.line) CJ.edge.set(refs, step && step.edge === id ? 1 : 0);
      });
    });
    const plant = registry.plant;
    if (plant && plant.set)
      plant.set(
        handle.mounted.refs,
        Object.assign(
          {},
          plant.defaults || {},
          visual.state || {},
          (step && step.stage) || {},
        ),
        0,
      );
    // The marker shows the character the step read, on the corner of the
    // state the code is in. A step that read no character has no marker.
    const read = step && step.at != null ? input[step.at] : null;
    const corner = read != null ? cornerOf(nodes[step.state]) : null;
    if (corner) {
      CJ.place(token, corner, 1, 1);
      token.lastElementChild.textContent = read === ' ' ? '·' : read;
    } else token.style.opacity = 0;
  };

  // One row of the list of transitions that leave a node.
  const transitionRow = (when, to) =>
    '<div class="cj-sp-tr"><span>' +
    CJ.esc(when) +
    '</span><span>→ ' +
    CJ.esc((nodes[to] && nodes[to].node.label) || to) +
    '</span></div>';

  const drawPanel = () => {
    if (run.error) {
      panel.innerHTML =
        '<section class="cj-sp-alarm"><h3>The steps could not be made</h3><p>' +
        CJ.esc(run.error) +
        '</p></section>';
      return;
    }
    const step = run.steps[index];
    const before = index > 0 ? run.steps[index - 1] : null;
    const ch = step.at != null ? input[step.at] : null;
    let html =
      '<section class="cj-sp-step cj-tone-' +
      step.tone +
      '"><h3>This step<span>' +
      CJ.esc(
        (nodes[step.state] && nodes[step.state].node.label) || step.state,
      ) +
      '</span></h3>' +
      (ch == null
        ? ''
        : '<div class="cj-sp-char">read <code>' +
          CJ.esc(ch === ' ' ? 'space' : ch) +
          '</code> at ' +
          step.at +
          '</div>') +
      '<p>' +
      CJ.esc(step.note) +
      '</p>' +
      step.does
        .map((act) => '<div class="cj-sp-act">' + CJ.esc(act) + '</div>')
        .join('') +
      (step.ref
        ? '<div class="cj-sp-ref">' + CJ.esc(step.ref) + '</div>'
        : '') +
      (run.capped && index === run.steps.length - 1
        ? '<div class="cj-sp-ref">Stopped after ' +
          MAX_SIM_STEPS +
          ' steps.</div>'
        : '') +
      '</section>';

    const shown = nodes[pinned] || nodes[step.state];
    if (shown) {
      const node = shown.node;
      // A view whose transitions belong to one example each, as the messages
      // of a lanes view do, sets `listEdges: false`, and the state's section
      // then lists none.
      const out =
        spec.listEdges === false
          ? []
          : (spec.edges || []).filter((edge) => edge.from === node.id);
      html +=
        '<section class="cj-sp-state"><h3>' +
        (pinned ? 'Pinned state' : 'State') +
        '<span>' +
        CJ.esc(node.label) +
        '</span></h3><p>' +
        CJ.esc(node.role || '') +
        '</p>' +
        (out.length
          ? '<h4>Goes on to</h4>' +
            out.map((edge) => transitionRow(edge.when || '', edge.to)).join('')
          : '') +
        ((node.edgeCases || []).length
          ? '<h4>Edge cases</h4>' +
            node.edgeCases
              .map(
                (one, i) =>
                  '<div class="cj-sp-case">' +
                  CJ.esc(one.text) +
                  (one.example != null
                    ? ' <button data-node="' +
                      CJ.esc(node.id) +
                      '" data-case="' +
                      i +
                      '" title="' +
                      CJ.esc(one.example) +
                      '">Try ' +
                      CJ.esc(shortExample(one.example)) +
                      '</button>'
                    : '') +
                  '</div>',
              )
              .join('')
          : '') +
        '</section>';
    }

    const rows = (names, values, previous) =>
      names
        .map((name) => {
          const lines = valueLines(values[name]);
          const changed =
            previous &&
            JSON.stringify(previous[name]) !== JSON.stringify(values[name]);
          return (
            '<div class="cj-sp-var' +
            (changed ? ' cj-changed' : '') +
            '"><span>' +
            CJ.esc(name) +
            '</span><span>' +
            (lines.length
              ? lines.map((line) => '<i>' + CJ.esc(line) + '</i>').join('')
              : '<i class="cj-none">none</i>') +
            '</span></div>'
          );
        })
        .join('');
    // The declared names come first, in their declared order. A name that
    // the step function returns without declaring it is shown after them.
    const ordered = (declared, values) => {
      const names = (declared || []).map((one) => one.name);
      Object.keys(values).forEach((name) => {
        if (names.indexOf(name) < 0) names.push(name);
      });
      return names;
    };
    const varNames = ordered(spec.variables, step.vars);
    if (varNames.length)
      html +=
        '<section><h3>Variables</h3>' +
        rows(varNames, step.vars, before && before.vars) +
        '</section>';
    const outNames = ordered(spec.outputs, step.outputs);
    if (outNames.length)
      html +=
        '<section><h3>Outputs</h3>' +
        rows(outNames, step.outputs, before && before.outputs) +
        '</section>';

    html +=
      '<section class="cj-sp-history"><h3>Steps<span>click one to go to it</span></h3>' +
      run.steps
        .slice(0, index + 1)
        .map(
          (one, i) =>
            '<button data-step="' +
            i +
            '"' +
            (i === index ? ' class="cj-now"' : '') +
            '><span>' +
            (i + 1) +
            '</span><span>' +
            CJ.esc(
              (nodes[one.state] && nodes[one.state].node.label) || one.state,
            ) +
            '</span><span>' +
            CJ.esc(one.note) +
            '</span></button>',
        )
        .reverse()
        .join('') +
      '</section>';
    panel.innerHTML = html;
  };

  const drawBar = () => {
    const total = run.steps.length;
    const at = total ? positions()[index] : -1;
    $('cj-tape').innerHTML = (typed ? input : '')
      .split('')
      .map(
        (ch, i) =>
          '<button data-at="' +
          i +
          '" class="' +
          (i === at ? 'cj-cur' : i > at ? 'cj-fut' : '') +
          '">' +
          CJ.esc(ch === ' ' ? '·' : ch) +
          '</button>',
      )
      .join('');
    const current = $('cj-tape').querySelector('.cj-cur');
    if (current && current.scrollIntoView)
      current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    $('cj-count').textContent = total
      ? 'step ' + (index + 1) + ' / ' + total
      : 'no steps';
    const scrub = $('cj-scrub');
    scrub.max = String(Math.max(0, total - 1));
    scrub.value = String(index);
    scrub.disabled = total < 2;
    $('cj-first').disabled = $('cj-prev').disabled = index <= 0;
    $('cj-next').disabled = $('cj-last').disabled = index >= total - 1;
    $('cj-play').disabled = total < 2;
    $('cj-play').textContent = timer ? '⏸' : '▶';
    $('cj-play').setAttribute('aria-label', timer ? 'Pause' : 'Play');
    bar.querySelectorAll('[data-speed]').forEach((button) => {
      button.classList.toggle('cj-on', Number(button.dataset.speed) === speed);
    });
    bar.querySelectorAll('[data-preset]').forEach((button) => {
      button.classList.toggle(
        'cj-on',
        String(presets[Number(button.dataset.preset)].input) === input,
      );
    });
  };

  const draw = () => {
    drawStage();
    drawBar();
    drawPanel();
  };

  const pause = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  // Shows the step at `to`, which is brought inside the list of steps.
  const go = (to) => {
    const last = Math.max(0, run.steps.length - 1);
    index = Math.max(0, Math.min(last, Math.round(Number(to) || 0)));
    if (index >= last) pause();
    draw();
    const step = run.steps[index];
    if (step && spec.onStep) spec.onStep(handle, step, index, run);
    post({
      cj: 'step',
      index,
      total: run.steps.length,
      nodeId: step ? step.state : null,
    });
  };

  const play = () => {
    if (run.steps.length < 2) return;
    if (index >= run.steps.length - 1) index = 0;
    pause();
    timer = setInterval(() => go(index + 1), STEP_INTERVAL / speed);
    draw();
  };

  // Runs the step function on a new input and shows its first step.
  const setInput = (value) => {
    pause();
    input = String(value).slice(0, maxLength);
    if (field && field.value !== input) field.value = input;
    run = runSim(input);
    if (spec.onRun) spec.onRun(handle, run);
    go(0);
  };

  if (field) field.addEventListener('input', () => setInput(field.value));
  $('cj-first').addEventListener('click', () => go(0));
  $('cj-prev').addEventListener('click', () => go(index - 1));
  $('cj-next').addEventListener('click', () => go(index + 1));
  $('cj-last').addEventListener('click', () => go(run.steps.length - 1));
  $('cj-play').addEventListener('click', () =>
    timer ? (pause(), draw()) : play(),
  );
  $('cj-scrub').addEventListener('input', (ev) => {
    pause();
    go(ev.target.value);
  });
  bar.querySelectorAll('[data-speed]').forEach((button) => {
    button.addEventListener('click', () => {
      speed = Number(button.dataset.speed);
      if (timer) play();
      else draw();
    });
  });
  // A click on a character of the input goes to the first step that read it.
  $('cj-tape').addEventListener('click', (ev) => {
    const cell = ev.target.closest('[data-at]');
    if (!cell) return;
    const found = run.steps.findIndex(
      (step) => step.at === Number(cell.dataset.at),
    );
    if (found >= 0) {
      pause();
      go(found);
    }
  });
  panel.addEventListener('click', (ev) => {
    const row = ev.target.closest('[data-step]');
    if (row) {
      pause();
      go(Number(row.dataset.step));
      return;
    }
    const tryIt = ev.target.closest('[data-case]');
    if (tryIt) {
      const entry = nodes[tryIt.dataset.node];
      const one = entry && entry.node.edgeCases[Number(tryIt.dataset.case)];
      if (one && one.example != null) setInput(String(one.example));
    }
  });
  // The keys work wherever the focus is, except in the input field, where
  // they are needed for typing.
  window.addEventListener('keydown', (ev) => {
    if (ev.target === field || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.key === 'ArrowRight') go(index + 1);
    else if (ev.key === 'ArrowLeft') go(index - 1);
    else if (ev.key === 'Home') go(0);
    else if (ev.key === 'End') go(run.steps.length - 1);
    else if (ev.key === ' ') {
      if (timer) {
        pause();
        draw();
      } else play();
    } else return;
    ev.preventDefault();
  });
  // The panel follows the node the viewer selects in the drawing.
  handle.hooks.select.push((id) => {
    pinned = id;
    drawPanel();
  });

  layout();
  if (spec.onRun) spec.onRun(handle, run);
  go(0);

  // Checks every example, for the self-test. Returns the problems found, each
  // with a `check`, a `severity`, a `message` and a `hint`, and the code
  // references the steps gave, for the app to compare with the workspace.
  const check = () => {
    const issues = [];
    const refs = {};
    const declared = (list) => {
      const names = {};
      (list || []).forEach((one) => {
        names[one.name] = 1;
      });
      return names;
    };
    const variables = declared(spec.variables);
    const outputs = declared(spec.outputs);
    const taken = {};
    presets.forEach((preset, p) => {
      const name = 'Example "' + preset.label + '"';
      const first = runSim(String(preset.input));
      const second = runSim(String(preset.input));
      const report = (checkName, message, hint, severity) =>
        issues.push({
          check: checkName,
          severity: severity || 'error',
          scene: 'v',
          key: checkName + '|' + p + '|' + message,
          message: name + ': ' + message,
          hint,
        });
      if (first.error) {
        report('sim', first.error, 'Fix the step function in sim.js.');
        return;
      }
      if (first.capped)
        report(
          'sim',
          'the run did not finish within ' + MAX_SIM_STEPS + ' steps.',
          'step() must return null when the code has finished. Check that every branch moves on in the input.',
        );
      if (JSON.stringify(first.steps) !== JSON.stringify(second.steps))
        report(
          'determinism',
          'two runs of the same input gave different steps.',
          'The step function must depend only on its arguments.',
        );
      const unknown = {};
      first.steps.forEach((step, i) => {
        if (step.ref) refs[step.ref] = 1;
        if (!nodes[step.state] && !unknown['s' + step.state]) {
          unknown['s' + step.state] = 1;
          report(
            'sim',
            'step ' +
              (i + 1) +
              ' is in the state "' +
              step.state +
              '", which is not the id of a node.',
            'Return the id of a node of visual.json as `state`.',
          );
        }
        if (step.edge == null) return;
        const edge = edges[step.edge];
        if (!edge) {
          if (!unknown['e' + step.edge]) {
            unknown['e' + step.edge] = 1;
            report(
              'sim',
              'step ' +
                (i + 1) +
                ' takes the transition "' +
                step.edge +
                '", which is not in stepper.edges.',
              'Add the transition to stepper.edges, or return the id of one that is there.',
            );
          }
          return;
        }
        taken[edge.id] = 1;
        // A step normally starts in the state the step before it ended in.
        // A view whose steps are not such a chain says so with `chain:
        // false`, and only the end of the transition is compared then.
        const from =
          i > 0 && spec.chain !== false ? first.steps[i - 1].state : null;
        if ((from != null && edge.from !== from) || edge.to !== step.state)
          report(
            'sim',
            'step ' +
              (i + 1) +
              ' takes the transition "' +
              edge.id +
              '" (' +
              edge.from +
              ' → ' +
              edge.to +
              '), but the code went from ' +
              (from == null ? 'its start' : from) +
              ' to ' +
              step.state +
              '.',
            'Return the transition that joins these two states, or correct its `from` and `to`.',
          );
      });
      const last = first.steps[first.steps.length - 1];
      Object.keys(last.vars).forEach((key) => {
        if (!variables[key])
          report(
            'sim',
            'vars() returns "' +
              key +
              '", which stepper.variables does not list.',
            'Add it to stepper.variables with its meaning.',
            'warning',
          );
      });
      Object.keys(last.outputs).forEach((key) => {
        if (!outputs[key])
          report(
            'sim',
            'outputs() returns "' +
              key +
              '", which stepper.outputs does not list.',
            'Add it to stepper.outputs with its meaning.',
            'warning',
          );
      });
      Object.keys(preset.expect || {}).forEach((key) => {
        const got = JSON.stringify(last.outputs[key]);
        const want = JSON.stringify(preset.expect[key]);
        if (got !== want)
          report(
            'sim-expect',
            'the output "' +
              key +
              '" ends as ' +
              got +
              ', but the example expects ' +
              want +
              '.',
            'The step function does not do what the code does for this input. Read the code again and correct the step function. Change `expect` only if it does not match the test it was taken from.',
          );
      });
    });
    (spec.edges || []).forEach((edge) => {
      if (!taken[edge.id])
        issues.push({
          check: 'sim-coverage',
          severity: 'warning',
          scene: 'v',
          key: 'sim-coverage|' + edge.id,
          message:
            'No example takes the transition "' +
            edge.id +
            '" (' +
            edge.from +
            ' → ' +
            edge.to +
            ').',
          hint: 'Add an example whose input takes this transition, or remove the transition if the code cannot take it.',
        });
    });
    // Drawing the first and the last step of the first example must not
    // throw.
    const kept = input;
    try {
      presets.forEach((preset) => {
        setInput(String(preset.input));
        go(run.steps.length - 1);
      });
    } catch (e) {
      issues.push({
        check: 'exception',
        severity: 'error',
        scene: 'v',
        key: 'stepper-draw',
        message: 'Drawing a step threw: ' + String((e && e.message) || e),
        hint: "Check `stage()` in sim.js and the plant's set().",
      });
    }
    setInput(kept);
    return { issues, refs: Object.keys(refs) };
  };

  return {
    go,
    play,
    pause,
    setInput,
    setPanelHeight,
    check,
    get input() {
      return input;
    },
    get index() {
      return index;
    },
    get run() {
      return run;
    },
  };
};
