// The film engine: registers the plant and the scenes an agent wrote, builds
// one copy of the plant per scene, and draws any moment of the film from its
// time alone.

// What the agent's files registered while the page loaded. `parts` holds the
// plants of the artifacts a pipeline is composed of, by the key the pipeline
// gives each one. `pipeline` is the content of a pipeline's pipeline.json,
// which says where each part sits. `sim` is the step function of a
// step-through, which its sim.js registers with CJ.defineSim.
const registry = {
  plant: null,
  parts: {},
  pipeline: null,
  scenes: {},
  sim: null,
  loadErrors: [],
};
// The key of the pipeline part whose file is being loaded, or null while any
// other file loads.
let partBeingLoaded = null;

/*@api
## The plant (`plant.js`)

A plant is the one drawn world of a visual or film. Define it once:

```js
CJ.definePlant({
  // Returns the markup of the world. `c(name)` prefixes a class name; use it for every class and id.
  // Films draw one copy of the plant per chapter, and `c` keeps the copies apart.
  // Put `extraSvg` last inside the <svg> and `extraHtml` after your HTML labels: chapters use them to
  // add their packets and tokens.
  draw({ c, extraSvg, extraHtml }) {
    const tank = CJ.tank(c('tank'), 1706, 250, 50, 660, [{ at: 0.3, label: 'soft' }, { at: 0.8, label: 'hard' }]);
    return `<svg class="art" viewBox="0 0 1920 1080">${CJ.grid(c('grid'))}${CJ.border()}
        ${CJ.pipe(c('pipe1'), 'M150 550 H400', 'hot')}
        ${CJ.machine(c('gate'), 310, 470, 180, 160, true)}
        ${tank.svg}${extraSvg}</svg>
      ${CJ.plate('handleRequest()', 300, 428)}${tank.html}${extraHtml}`;
  },

  // Collects element handles once per copy. `q(name)` finds the element with class `c(name)`.
  refs({ q, qa }) { return { tank: CJ.tank.refs(q, 'tank') }; },

  // The state every chapter starts from when it passes nothing for a key.
  defaults: { level: 0, lamps: [0, 0] },

  // Applies a state to the handles. Must be pure: the same (S, t) always gives the same picture.
  set(R, S, t) { CJ.tank.set(R.tank, S.level, S.lamps, t); },

  // Named routes that packets travel on. Follow the pipes' centre lines.
  routes(CJ) { return { main: CJ.route([[150, 550], [400, 550]]) }; },

  // State keys that are clocks for continuous motion (a spinning gear, a scrolling reader) and are
  // therefore not expected to match from the end of one chapter to the start of the next.
  motionKeys: ['run'],

  // The clickable parts of the plant. `select` lists the names of the elements that highlight together.
  nodes: [{ id: 'gate', label: 'handleRequest()', bbox: [310, 470, 180, 160], role: 'Routes each request by type', select: ['gate'] }],

  // Where work crosses the edge of the analysed code.
  ports: [{ id: 'out:store.write', dir: 'out', anchor: [1690, 860] }],
});
```

Layout rules the self-test enforces: nothing in the world may sit under the title band at a chapter's
framing; at least 24 px between neighbouring parts; labels never overlap each other or a part they are not
inside of; every class name carries the prefix and is used once.
*/
CJ.definePlant = (def) => {
  if (partBeingLoaded) registry.parts[partBeingLoaded] = def;
  else registry.plant = def;
};

// ---- pipelines A pipeline joins several artifacts into one world. Each of
// them is a "part". The builder loads a part's plant.js through CJ.__part, so
// the plant it defines is kept as that part and not as the world. The
// pipeline's own plant.js, the "yard", then draws each part in a "bay": a
// rectangle of the yard that shows the whole sheet of the part at a reduced
// scale.
CJ.__part = (key, body) => {
  partBeingLoaded = key;
  try {
    CJ.__file('parts/' + key + '/plant.js', body);
  } finally {
    partBeingLoaded = null;
  }
};

const partNamed = (key) => {
  const part = registry.parts[key];
  if (!part)
    throw new Error(
      'There is no part called "' +
        key +
        '". The parts of this pipeline are: ' +
        (Object.keys(registry.parts).join(', ') || 'none') +
        '.',
    );
  return part;
};

// Returns a handle on one part of the pipeline, placed as `pipeline.json` says:
// its bay's top-left corner `x`, `y` in the yard's world and the `scale` its
// 1920 x 1080 sheet is drawn at.
//
//   - `draw(c)`: the markup of the part in its bay. `c` is the yard's own
//     prefix function. The part's class names get the yard's prefix and the
//     part's key, so two parts never share a name.
//   - `point([x, y])`: a point of the part's own sheet, such as a port's
//     anchor, as a point of the yard.
//   - `routes()`: the part's routes, with every point converted to the yard's
//     world, so a packet of the yard can travel through the part.
//   - `set(R, S, t)`: applies state `S`, merged over the part's defaults, to
//     the part. `R` is what the yard's own `set` receives.
CJ.bay = (key) => {
  const part = partNamed(key);
  const placed = ((registry.pipeline && registry.pipeline.parts) || []).find(
    (one) => one.key === key,
  );
  if (!placed)
    throw new Error(
      'pipeline.json does not place the part "' +
        key +
        '". Give it a "bay" and a "scale" there.',
    );
  const x = placed.bay[0];
  const y = placed.bay[1];
  const scale = placed.scale;
  const point = (xy) => [x + xy[0] * scale, y + xy[1] * scale];
  return {
    x,
    y,
    scale,
    point,
    width: STAGE_W * scale,
    height: STAGE_H * scale,
    draw(c) {
      const inner = part.draw({
        c: (name) => c('p-' + key + '-' + name),
        extraSvg: '',
        extraHtml: '',
      });
      return (
        '<div class="cj-bay ' +
        c('bay-' + key) +
        '" data-part="' +
        CJ.esc(key) +
        '" style="left:' +
        x +
        'px;top:' +
        y +
        'px;transform:scale(' +
        scale +
        ')">' +
        inner +
        '</div>'
      );
    },
    routes() {
      const own = part.routes ? part.routes(CJ) : {};
      // A route returns a point. Some plants also keep functions that return a
      // route, such as one route per slot of a bin. Both are converted: a point
      // is moved into the yard, and a returned function is wrapped in the same
      // way.
      const inYard =
        (fn) =>
        (...args) => {
          const value = fn(...args);
          if (typeof value === 'function') return inYard(value);
          return Array.isArray(value) ? point(value) : value;
        };
      const out = {};
      Object.keys(own).forEach((name) => {
        if (typeof own[name] === 'function') out[name] = inYard(own[name]);
      });
      return out;
    },
    set(R, state, t) {
      const bay = R && R.bays && R.bays[key];
      if (bay && part.set)
        part.set(
          bay.refs,
          Object.assign({}, part.defaults || {}, state || {}),
          t || 0,
        );
    },
  };
};

/*@api
## Scenes (`scenes/<id>.js`, films only)

One file per chapter. The `id` must match the scene's `id` in `film.json`.

```js
CJ.scene('budget', {
  // Runs once. Draw this chapter's copy of the plant with its own moving parts.
  init(ctx) {
    ctx.mount({ extraSvg: CJ.markedPacket(ctx.c('m0')) + CJ.packet('batch', ctx.c('crate')) });
    this.m0 = CJ.markedPacket.refs(ctx.q, 'm0');
    this.crate = ctx.q('crate');
  },
  // Runs for every frame. `t` is ANIMATION time in seconds from the start of this chapter. The runtime
  // has already applied slow motion, the camera and the bubbles. Must be pure: set everything from `t`.
  render(t, ctx) {
    const p = CJ.seg(t, 0.6, 2.0);
    CJ.place(this.m0.g, ctx.routes.main(CJ.eio(p)), 1, p > 0 ? 1 : 0);
    CJ.place(this.crate, ctx.routes.out(CJ.eio(CJ.seg(t, 7.9, 8.7))), 1, t > 7.9 && t < 8.7 ? 1 : 0);
    ctx.set({ level: CJ.lerp(0.2, 0.4, CJ.eio(CJ.seg(t, 1, 4))) }, t);
  },
});
```

`ctx` gives a scene everything it may touch:

| Member | What it is |
|--------|------------|
| `ctx.c(name)` | Prefixes a class name with this scene's id. |
| `ctx.mount({ extraSvg, extraHtml })` | Draws this scene's copy of the plant with the scene's own parts added. Call it once, in `init`. |
| `ctx.q(name)` / `ctx.qa(name)` | The element with class `ctx.c(name)` / every element whose class is `ctx.c(name)` followed by a number. |
| `ctx.R` | The plant's handles for this copy (what the plant's `refs()` returned). |
| `ctx.routes` | The plant's routes. |
| `ctx.set(S, t)` | Applies plant state `S` (merged over the plant's `defaults`). Call it once per `render`. |
| `ctx.scene` | This scene's entry from `film.json`. |

Rules: keep your own values on `this`; `ctx` cannot be changed. The first state of a chapter must equal the
last state of the chapter before it. Do not write bubbles, cameras, the title or sound in a scene: declare
them in `film.json`.
*/
CJ.scene = (id, def) => {
  registry.scenes[id] = def;
};

/*@api
## Films (`film.json`)

Everything about a film that is not drawing is declared here. The runtime computes all real timings.

**Time.** You author in *animation seconds*. Playback is slower: 0.6 animation seconds per real second
normally, and 0.1 while a bubble is up. So a scene's real length is about `animLength / 0.6` plus about
5 seconds per bubble. Every time in `film.json` and the `t` passed to `render` is an animation time.

| Field | Meaning |
|-------|---------|
| `title` | The film's title. |
| `legend` | One row `{ kind, form, label, html }` for each combination of packet kind and form the film draws. Leave `form` out for a crate. A row names one thing. `label` is the name of the thing in one to three words, at most 24 characters, such as `An order`. `html` is the name and what the thing is, such as `An order · <code>Order</code>, marked by <code>price</code>`. At most 6 rows, and at most 3 different forms. The legend card shows the `html` of every row. It covers a dimmed plant at the start of the first scene, then lifts away. Keep `html` to about 60 characters. A longer row wraps onto a second line. Start the first scene's own motion after animation second 4. For the whole film, a strip under the picture shows each row's packet with its `label`, and the `html` of a row while the pointer is over it. |
| `scenes` | The chapters, in order. 4 to 8. |
| `thumbT` | The real time, in seconds, of the frame to use as the thumbnail. |

Each scene:

| Field | Meaning |
|-------|---------|
| `id` | Lower-case letters, digits and dashes. Names `scenes/<id>.js` and prefixes its classes. |
| `title` | The numbered chapter title shown in the title band: `2 · The pending-bytes budget`. One line, at most 64 characters. The first scene uses the film's title. |
| `name` | A short name for the scrubber: `Soft and hard limit`. |
| `desc` | One line for the app's chapter list. It is not drawn in the film. |
| `animLength` | How many animation seconds `render` runs for. End it about 1 second after the last event. |
| `camera` | The camera moves: `{ t, dur, cx, cy, z }`. The camera is centred on world point `cx, cy`; `z` is 1.0 for the whole sheet, 1.1 to 1.3 for a region, 1.6 to 1.85 for a close-up. Every scene starts on the framing the previous scene ended on, so list only moves. Start the first move at `t: 0.05` with `dur` 0.8 to 1.2. Leave a hold between moves. Only the first scene may begin with a key that has no `t`: its starting framing. |
| `bubbles` | The explanations, in the order they appear (below). |
| `cues` | Sound effects at event times: `{ at, fx, vel }` with `fx` one of `tick` (a step), `click` (a gate), `thud` (a landing or a limit hit), `chime` (a mode switch), `boing`, `whoosh` (a camera move; optional `dur` up to 2, `into: true` reverses it) and `crash` (the one big failure). The sound of a bubble appearing is played automatically; do not add a cue for it. At most one cue per second. |
| `rewind` | `{ "until": 2.0 }` on the scene that follows a fork: for the first `until` animation seconds the runtime shows scan lines and a "REWIND" tag while your `render` plays the fork's events backwards. Otherwise omit it. |

Each bubble:

| Field | Meaning |
|-------|---------|
| `at` | The animation time of the event it explains. The bubble appears then, and time slows down. If the previous bubble is still up, it waits. Space bubbles at least 1.5 animation seconds apart. |
| `x`, `y` | The bubble's top-left corner in world pixels. Put it in clear space beside the part it explains, never on top of it. The runtime shifts a bubble that would leave the view, but that is a safety net. |
| `tail` | Which edge the tail is on, pointing at the subject: `u` (top edge, bubble sits below its subject), `d` (bottom edge, bubble sits above), `l` or `r`. |
| `tx` / `ty` | Where the tail sits: `tx` px from the bubble's left edge for `u` and `d`, `ty` px from its top edge for `l` and `r`. |
| `maxWidth` | 420 by default, up to 560. A bubble's height is about `70 + 28 × lines`; a line holds about `maxWidth / 12` characters. |
| `kicker` | The event's name in capitals, at most 5 words: `HARD LIMIT · hardPendingBytes`. Identifiers keep their own case. |
| `html` | One or two sentences, 12 to 24 words. Wrap every identifier in `<code>`. Say what happens and why it matters. |
| `alarm` | `true` for a limit hit, a forced mode switch, an error raised or work dropped. |
| `hold` | Leave it out. The runtime holds the bubble for a time computed from its word count. |
| `rationale` | Optional. Why the code does what this bubble describes (see Rationale below). |

A plant may carry its own constants for scenes to share, for example `CJ.definePlant({ stepXs: [880, 980], ... })`
read in a scene as `ctx.P.stepXs`. Each file is separate, so a `const` in `plant.js` is not visible in a scene.
*/

// The builder wraps every agent file in a call to this, so an error while a
// file loads is recorded with the file's name and reported by the self-test.
CJ.__file = (name, body) => {
  try {
    body(CJ);
  } catch (e) {
    registry.loadErrors.push({
      file: name,
      message: String((e && e.message) || e),
    });
  }
};

// Tags allowed inside bubble and legend text. Every other tag is removed, and
// attributes are dropped from the allowed ones.
const INLINE_TAGS = { code: 1, b: 1, i: 1, em: 1, strong: 1, br: 1, span: 1 };
const cleanInline = (html) =>
  String(html == null ? '' : html).replace(
    /<(\/?)([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g,
    (all, slash, tag) =>
      INLINE_TAGS[tag.toLowerCase()]
        ? '<' + slash + tag.toLowerCase() + '>'
        : '',
  );

/*@api
### Rationale

A bubble of a film and a node of a visual may carry a `rationale`: the reason why the code does what the
bubble or the node describes. It is for the reader who understands what happens and asks why it was built
that way. The film shows a small "rationale" chip on the bubble, which the viewer can open. The visual shows a
"?" marker on the node when the viewer switches the rationale layer on. Neither adds anything to the drawing
until the viewer asks.

| Field | Meaning |
|-------|---------|
| `text` | One or two sentences, at most 280 characters, in plain words. Write an identifier between backticks. |
| `basis` | `"stated"` when a comment or a name in the code gives the reason. `"inferred"` when you conclude it from how the code works. |
| `refs` | `[{ path, line }]`, at least one: the comment that states the reason, or the code that makes it necessary. |

Give a rationale only where the code shows the reason. Leave it out everywhere else. Do not guess at history,
at what the author intended or at what a team decided.
*/

// The text of a rationale as HTML. An identifier written between backticks
// becomes a code chip.
const rationaleHtml = (rationale) =>
  CJ.esc(rationale.text).replace(/`([^`]+)`/g, '<code>$1</code>');

// Where the reason of a rationale comes from, with the first place in the
// code that shows it: "Stated in the code · handler.go:257".
const rationaleSource = (rationale) => {
  const basis =
    rationale.basis === 'stated'
      ? 'Stated in the code'
      : 'Inferred from the code';
  const ref = (rationale.refs || [])[0];
  if (!ref) return basis;
  return basis + ' · ' + String(ref.path).split('/').pop() + ':' + ref.line;
};

// The part of a film bubble that holds its rationale: the chip that opens
// it, and the reason itself, which is hidden until the chip is clicked.
const rationaleMarkup = (rationale) =>
  '<button type="button" class="cj-why-chip">rationale</button>' +
  '<div class="cj-why-text"><span class="k">RATIONALE</span>' +
  rationaleHtml(rationale) +
  '<span class="cj-why-source">' +
  CJ.esc(rationaleSource(rationale)) +
  '</span></div>';

const bubbleMarkup = (bubble, cls) => {
  let style = 'left:' + bubble.x + 'px;top:' + bubble.y + 'px';
  if (bubble.maxWidth != null) style += ';max-width:' + bubble.maxWidth + 'px';
  if (bubble.tx != null) style += ';--tx:' + bubble.tx + 'px';
  if (bubble.ty != null) style += ';--ty:' + bubble.ty + 'px';
  return (
    '<div class="bub' +
    (bubble.alarm ? ' alarm' : '') +
    (bubble.tail ? ' tail-' + bubble.tail : '') +
    ' ' +
    cls +
    '" style="' +
    style +
    '">' +
    '<span class="k">' +
    CJ.esc(bubble.kicker) +
    '</span>' +
    cleanInline(bubble.html) +
    (bubble.rationale && bubble.rationale.text
      ? rationaleMarkup(bubble.rationale)
      : '') +
    '</div>'
  );
};

// Draws one copy of the plant, with a camera world, a dimmer and optional
// bubbles, into `box`. Returns the handles the film and visual modes need.
const mountPlantCopy = (box, prefix, plant, title, extras, bubbles) => {
  const c = (name) => prefix + '-' + name;
  const drawn = plant.draw({
    c,
    extraSvg: extras.extraSvg || '',
    extraHtml: extras.extraHtml || '',
  });
  const bubbleHtml = bubbles
    .map((b, i) => bubbleMarkup(b, c('bub' + i)))
    .join('');
  box.append(
    elementFromHtml(
      '<div class="ground"><div class="view"><div class="world ' +
        c('world') +
        '">' +
        drawn +
        '<div class="dimmer"></div>' +
        bubbleHtml +
        '</div></div>' +
        '<div class="hud"><h2 class="line">' +
        CJ.esc(title) +
        '</h2></div></div>',
    ),
  );
  const q = (name) => box.querySelector('.' + CSS.escape(c(name)));
  // Finds every element whose class is c(name) followed only by digits, such as
  // lamp0, lamp1.
  const qa = (name) =>
    Array.from(box.querySelectorAll('[class*="' + c(name) + '"]')).filter(
      (el) => {
        const cls = el.getAttribute('class') || '';
        return cls
          .split(/\s+/)
          .some(
            (one) =>
              one.indexOf(c(name)) === 0 &&
              /^\d+$/.test(one.slice(c(name).length)),
          );
      },
    );
  const world = box.querySelector('.world');
  // Every bay gets the handles of its part, and the part is put in its default
  // state. The yard's own handles carry them as `bays`, which is what
  // CJ.bay.set looks up.
  const bays = {};
  box.querySelectorAll('.cj-bay[data-part]').forEach((el) => {
    const key = el.getAttribute('data-part');
    const def = registry.parts[key];
    if (!def) return;
    const pc = (name) => c('p-' + key + '-' + name);
    const pq = (name) => el.querySelector('.' + CSS.escape(pc(name)));
    const pqa = (name) =>
      Array.from(el.querySelectorAll('[class*="' + pc(name) + '"]')).filter(
        (one) => {
          const cls = one.getAttribute('class') || '';
          return cls
            .split(/\s+/)
            .some(
              (n) =>
                n.indexOf(pc(name)) === 0 &&
                /^\d+$/.test(n.slice(pc(name).length)),
            );
        },
      );
    const refs = def.refs ? def.refs({ q: pq, qa: pqa }) : {};
    if (def.set) def.set(refs, Object.assign({}, def.defaults || {}), 0);
    bays[key] = { def, refs, el };
  });
  const plantRefs = plant.refs ? plant.refs({ q, qa }) : {};
  if (plantRefs && typeof plantRefs === 'object' && !plantRefs.bays)
    plantRefs.bays = bays;
  return {
    c,
    q,
    qa,
    world,
    bays,
    ground: box.querySelector('.ground'),
    view: box.querySelector('.view'),
    dimmer: box.querySelector('.dimmer'),
    bubbleEls: bubbles.map((b, i) => q('bub' + i)),
    refs: plantRefs,
  };
};

// ---- labels over packets
//
// A packet is drawn inside the plant's <svg>. A label is an HTML element that
// comes after the <svg>. So when a packet and a label are in the same place,
// the label is painted on top of the packet. A label in the packet's own
// colour could then not be read: a lit label of `CJ.modeLamps` is amber, and
// so is a primary packet.
//
// `shadeLabels` makes such a label readable. The part of the label that lies
// over a packet is drawn in the ground colour, which is the colour a packet's
// own tag has. The rest of the label keeps its colour. It works like this:
//   - The label gets the class `cj-over`. With that class the label's text is
//     filled by the label's background (see runtime.css).
//   - The lowest layer of that background is the label's own colour.
//   - Above it lies one rectangle in the ground colour for each packet under
//     the label, as large as the packet and in the packet's place.
// A packet that is fading in or out is partly transparent. Its rectangle is
// then a mix of the ground colour and the label's colour, in the same
// proportion.

// The kinds of packet that have a filled body. A packet of another kind,
// `transient` or `tally`, has a body in the ground colour, and a label over
// it can be read as it is.
const FILLED_PACKETS = { primary: 1, secondary: 1, batch: 1 };

// How opaque `el` is drawn inside `world`, from 0 to 1. That is its own
// opacity multiplied by the opacity of every element between it and `world`.
const opacityInside = (el, world) => {
  if (getComputedStyle(el).visibility === 'hidden') return 0;
  let value = 1;
  for (let at = el; at && at !== world && value > 0; at = at.parentElement)
    value *= Number(getComputedStyle(at).opacity);
  return value;
};

// Draws the part of every label that lies over a filled packet in the ground
// colour, and gives a label that no longer lies over one its own look back.
// `m` is what `mountPlantCopy` returned. Call it after everything that moves,
// shows or hides a packet.
//
// Returns false when the plant has no size on the page yet, for example
// because it is not shown. Nothing can be measured then, and the caller has
// to call again later.
const shadeLabels = (m) => {
  if (!m.world.getBoundingClientRect().width) return false;
  // The packets and labels of the plant are found once. `over` holds, for
  // each label that lies over a packet, the background it was given last.
  const shade =
    m.shade ||
    (m.shade = {
      packets: Array.from(
        m.world.querySelectorAll('[data-cj="packet"]'),
      ).filter(
        (el) =>
          FILLED_PACKETS[el.getAttribute('data-kind')] &&
          el.firstElementChild &&
          !el.closest('.cj-legend, .cj-lift'),
      ),
      labels: Array.from(m.world.querySelectorAll('.pl')).filter(
        (el) => !el.closest('.cj-lift-html'),
      ),
      over: new Map(),
    });

  // Where each packet is on the page. The first element of a packet is its
  // outline. A packet that is not displayed has an empty box.
  const packets = [];
  shade.packets.forEach((el) => {
    const box = el.firstElementChild.getBoundingClientRect();
    if (box.width && box.height) packets.push({ el, box, opacity: null });
  });

  const still = new Set();
  if (packets.length)
    shade.labels.forEach((label) => {
      const box = label.getBoundingClientRect();
      if (!box.width || !box.height) return;
      const under = packets.filter((packet) => {
        if (
          packet.box.right <= box.left ||
          packet.box.left >= box.right ||
          packet.box.bottom <= box.top ||
          packet.box.top >= box.bottom
        )
          return false;
        // The opacity is worked out only for a packet that is under a label,
        // because it takes several style lookups.
        if (packet.opacity == null)
          packet.opacity = opacityInside(packet.el, m.world);
        return packet.opacity > 0.01;
      });
      if (!under.length) return;
      // The boxes are in pixels of the page. The background is placed in the
      // label's own pixels, which differ by the zoom of the camera.
      const own = getComputedStyle(label);
      const kx = parseFloat(own.width) / box.width;
      const ky = parseFloat(own.height) / box.height;
      const images = [];
      const positions = [];
      const sizes = [];
      under.forEach((packet) => {
        const share = Math.round(packet.opacity * 100);
        const ink =
          share >= 100
            ? 'var(--ground)'
            : 'color-mix(in srgb, var(--ground) ' + share + '%, currentColor)';
        images.push('linear-gradient(' + ink + ',' + ink + ')');
        positions.push(
          ((packet.box.left - box.left) * kx).toFixed(1) +
            'px ' +
            ((packet.box.top - box.top) * ky).toFixed(1) +
            'px',
        );
        sizes.push(
          (packet.box.width * kx).toFixed(1) +
            'px ' +
            (packet.box.height * ky).toFixed(1) +
            'px',
        );
      });
      images.push('linear-gradient(currentColor,currentColor)');
      positions.push('0 0');
      sizes.push('100% 100%');
      still.add(label);
      const key = images.join() + '|' + positions.join() + '|' + sizes.join();
      if (shade.over.get(label) === key) return;
      shade.over.set(label, key);
      label.classList.add('cj-over');
      label.style.backgroundImage = images.join();
      label.style.backgroundPosition = positions.join();
      label.style.backgroundSize = sizes.join();
    });

  shade.over.forEach((key, label) => {
    if (still.has(label)) return;
    shade.over.delete(label);
    label.classList.remove('cj-over');
    label.style.backgroundImage = '';
    label.style.backgroundPosition = '';
    label.style.backgroundSize = '';
  });
  return true;
};

// Keeps a bubble wholly inside the view, with a margin, by shifting it.
// `framing` is the live camera framing with its zoom already multiplied by
// CAMERA_SCALE. The bubble's size is measured the first time it is shown and
// kept in `size`.
const BUBBLE_MARGIN = 28;
const clampBubble = (el, size, framing) => {
  if (!size.w) {
    size.w = el.offsetWidth;
    size.h = el.offsetHeight;
    size.x = parseFloat(el.style.left);
    size.y = parseFloat(el.style.top);
  }
  const z = framing.z;
  const sx = VIEW_CX + (size.x - framing.cx) * z;
  const sy = VIEW_CY + (size.y - framing.cy) * z;
  const sw = size.w * z;
  const sh = size.h * z;
  let dx = 0;
  let dy = 0;
  if (sx + sw > VIEW_W - BUBBLE_MARGIN) dx = VIEW_W - BUBBLE_MARGIN - (sx + sw);
  if (sx + dx < BUBBLE_MARGIN) dx = BUBBLE_MARGIN - sx;
  if (sy + sh > VIEW_H - BUBBLE_MARGIN) dy = VIEW_H - BUBBLE_MARGIN - (sy + sh);
  if (sy + dy < BUBBLE_MARGIN) dy = BUBBLE_MARGIN - sy;
  el.style.transform =
    'translate(' + (dx / z).toFixed(2) + 'px,' + (dy / z).toFixed(2) + 'px)';
};

// The framing a film opens on when its first scene does not give one: the whole
// sheet.
const OVERVIEW_FRAMING = { cx: 960, cy: 560, z: 1 };

// How long, in animation seconds, the legend card stays up at the start of the
// first scene when film.json does not say.
const DEFAULT_LEGEND_HOLD = 3.4;

const legendMarkup = (film) => {
  const rows = film.legend
    .map(
      (row, i) =>
        '<div class="cj-legend-row"><svg width="72" height="52" viewBox="-36 -26 72 52">' +
        CJ.packet(row.kind, 'cj-legend-icon' + i, { form: row.form }) +
        '</svg>' +
        '<p class="sub">' +
        cleanInline(row.html) +
        '</p></div>',
    )
    .join('');
  // A card placed with `legendAt` ends at least 48 px before the right edge of
  // the stage. A row that would reach further wraps.
  const at = film.legendAt;
  const style = at
    ? 'left:' +
      at[0] +
      'px;top:' +
      at[1] +
      'px;max-width:calc(100% - ' +
      (at[0] + 48) +
      'px)'
    : '';
  return (
    '<div class="words cj-legend' +
    (at ? '' : ' cj-legend-centred') +
    '" style="' +
    style +
    '">' +
    rows +
    '</div>'
  );
};

// The short name of a legend row, which the legend strip shows beside the
// row's packet. It is the row's `label`. A row without a `label` is named by
// the text of its `html` before the first " · ". A row without a `label`
// whose `html` has no " · " is named by the whole text of its `html`.
const legendLabel = (row) => {
  if (row.label) return String(row.label);
  const text = elementFromHtml(
    '<span>' + cleanInline(row.html) + '</span>',
  ).textContent;
  return text.split(' · ')[0].trim();
};

// Builds the legend strip of a film or a visual: one row of keys, a key for
// each row of `rows`, the `legend` of film.json or visual.json. A key shows
// the packet of its row, drawn small, and the row's short name. While the
// pointer is over a key, or the key has the keyboard focus, a card above the
// key shows the packet again with the `html` of the row.
//
// The strip is outside the stage, so it keeps its size when the stage is
// scaled, and it is on screen at every moment of a film. The player puts it
// in the page (see CJ.boot).
const legendStrip = (rows) => {
  const strip = document.createElement('div');
  strip.id = 'legendbar';
  strip.setAttribute('role', 'list');
  strip.setAttribute('aria-label', 'Legend');
  rows.forEach((row, i) => {
    const icon = (width, height) =>
      '<svg width="' +
      width +
      '" height="' +
      height +
      '" viewBox="-36 -26 72 52" aria-hidden="true">' +
      CJ.packet(row.kind, 'cj-key-icon' + i, { form: row.form }) +
      '</svg>';
    const key = elementFromHtml(
      '<div class="cj-key" role="listitem" tabindex="0">' +
        icon(30, 22) +
        '<span class="cj-key-label"></span>' +
        '<div class="cj-key-card" role="tooltip">' +
        icon(54, 39) +
        '<p>' +
        cleanInline(row.html) +
        '</p></div></div>',
    );
    key.querySelector('.cj-key-label').textContent = legendLabel(row);
    // The card starts at the left edge of its key. A card that would then
    // reach past the right edge of the page is moved left until it fits.
    const placeCard = () => {
      const card = key.querySelector('.cj-key-card');
      card.style.left = '0px';
      const past = card.getBoundingClientRect().right - (window.innerWidth - 8);
      if (past > 0) card.style.left = -past + 'px';
    };
    key.addEventListener('pointerenter', placeCard);
    key.addEventListener('focus', placeCard);
    strip.append(key);
  });
  // A press or a click on the strip is not passed on to the frame under it,
  // where it would drag the plant of a visual or select one of its parts.
  ['pointerdown', 'click'].forEach((type) =>
    strip.addEventListener(type, (ev) => ev.stopPropagation()),
  );
  return strip;
};

// Builds every scene of a film inside `stage` and returns the object the player
// drives.
//
// onError(info) is called when a scene's init or render throws. The scene is
// then left out of further drawing, and the rest of the film keeps working.
const buildFilm = (film, stage, onError) => {
  const plant = registry.plant;
  if (!plant)
    throw new Error(
      'No plant is defined. plant.js must call CJ.definePlant({...}).',
    );
  const speed = Object.assign({}, DEFAULT_SPEED, film.speed || {});
  const routes = plant.routes ? plant.routes(CJ) : {};
  const hasLegend = Array.isArray(film.legend) && film.legend.length > 0;
  const legendHold =
    film.legendHold == null ? DEFAULT_LEGEND_HOLD : film.legendHold;

  let start = 0;
  let framing = OVERVIEW_FRAMING;
  const scenes = film.scenes.map((meta, index) => {
    const bubbles = meta.bubbles || [];
    const holds = bubbles.map((b) =>
      b.hold != null ? b.hold : holdForWords(countWords(b.kicker, b.html)),
    );
    const warp = makeWarp(
      bubbles.map((b) => b.at),
      holds,
      speed,
    );
    // A scene lasts until its animation is over, and never ends while a bubble
    // is still fading. The length is rounded to a millionth of a second, so a
    // scene authored to end on a whole second does not come out a hair short
    // and make the film's total read one second less.
    let duration = Math.round(warp.realAt(meta.animLength) * 1e6) / 1e6;
    bubbles.forEach((b, i) => {
      if (warp.starts[i] != null)
        duration = Math.max(duration, warp.starts[i] + holds[i]);
    });

    // The camera starts on the framing the previous scene ended on. A first key
    // without a time is an explicit starting framing; it is meant for the first
    // scene only.
    const declared = (meta.camera || []).slice();
    let opening = framing;
    let explicitOpening = false;
    if (declared.length && declared[0].t == null) {
      opening = declared.shift();
      explicitOpening = true;
    }
    const keys = [{ cx: opening.cx, cy: opening.cy, z: opening.z }].concat(
      declared.map((k) => ({
        t: k.t,
        dur: k.dur == null ? 1 : k.dur,
        cx: k.cx,
        cy: k.cy,
        z: k.z,
      })),
    );
    framing = framingAt(keys, meta.animLength);

    const box = document.createElement('div');
    box.className = 'scene-box';
    box.dataset.scene = meta.id;
    box.style.display = 'none';
    stage.append(box);

    const scene = {
      meta,
      index,
      box,
      warp,
      holds,
      keys,
      start,
      duration,
      bubbles,
      explicitOpening: explicitOpening && index > 0,
      endFraming: framing,
      mounted: null,
      cam: null,
      inst: null,
      ctx: null,
      ready: false,
      error: null,
      lastState: null,
      bubbleSizes: bubbles.map(() => ({})),
      legend: null,
      world: null,
      rewindLines: null,
      rewindTag: null,
    };
    start += duration;
    return scene;
  });
  const duration = start;

  scenes.forEach((scene) => {
    const meta = scene.meta;
    const def = registry.scenes[meta.id];
    const c = (name) => meta.id + '-' + name;
    const mount = (extras) => {
      if (scene.mounted)
        throw new Error(
          'ctx.mount() was called twice in scene "' + meta.id + '".',
        );
      const m = (scene.mounted = mountPlantCopy(
        scene.box,
        meta.id,
        plant,
        meta.title,
        extras || {},
        scene.bubbles,
      ));
      scene.world = m.world;
      scene.cam = makeCamera(m.world, scene.keys);
      if (meta.rewind) {
        scene.rewindLines = elementFromHtml(
          '<div class="cj-rewind-lines"></div>',
        );
        m.view.after(scene.rewindLines);
        scene.rewindTag = elementFromHtml(
          '<div class="cj-rewind-tag">◀◀ REWIND</div>',
        );
        m.ground.append(scene.rewindTag);
      }
      if (scene.index === 0 && hasLegend) {
        scene.legend = elementFromHtml(legendMarkup(film));
        m.ground.append(scene.legend);
      }
    };
    const ctx = Object.freeze({
      id: meta.id,
      scene: Object.freeze(Object.assign({}, meta)),
      P: plant,
      stage: scene.box,
      c,
      mount,
      q: (name) => scene.mounted.q(name),
      qa: (name) => scene.mounted.qa(name),
      get R() {
        return scene.mounted ? scene.mounted.refs : null;
      },
      routes,
      set(S, t) {
        const merged = Object.assign({}, plant.defaults || {}, S || {});
        scene.lastState = merged;
        if (plant.set) plant.set(scene.mounted.refs, merged, t);
      },
    });
    scene.ctx = ctx;
    scene.inst = Object.create(def || {});
    scene.box.style.display = 'block';
    try {
      if (!def)
        throw new Error(
          'No scene is registered for id "' +
            meta.id +
            '". scenes/' +
            meta.id +
            ".js must call CJ.scene('" +
            meta.id +
            "', {...}).",
        );
      if (scene.inst.init) scene.inst.init(ctx);
      if (!scene.mounted) mount({});
      scene.ready = true;
    } catch (e) {
      scene.error = {
        scene: meta.id,
        phase: 'init',
        message: String((e && e.message) || e),
      };
      if (!scene.mounted) {
        try {
          mount({});
        } catch (e2) {
          /* the plant itself cannot be drawn */
        }
      }
      if (onError) onError(scene.error);
    }
    scene.box.style.display = 'none';
  });

  let shown = -1;

  const sceneAt = (x) => {
    for (let i = scenes.length - 1; i >= 0; i--)
      if (x >= scenes[i].start) return i;
    return 0;
  };

  // Draws one scene at `tReal` real seconds after the scene's own start.
  const drawScene = (scene, tReal) => {
    if (!scene.mounted) return;
    const local = Math.min(scene.duration, Math.max(0, tReal));
    const t = scene.warp.tau(local);
    scene.cam(t);
    if (scene.legend) {
      // The legend card covers a dimmed plant, then lifts away as the plant
      // lights up.
      const leave = CJ.eo(CJ.seg(t, legendHold, legendHold + 0.5));
      scene.legend.style.opacity = 1 - leave;
      scene.legend.style.setProperty(
        '--lift',
        CJ.lerp(0, -20, leave).toFixed(1) + 'px',
      );
      scene.world.style.opacity = CJ.lerp(
        0.3,
        1,
        CJ.eo(CJ.seg(t, legendHold + 0.2, legendHold + 1.0)),
      );
    }
    if (scene.rewindLines) {
      const until = scene.meta.rewind.until;
      scene.rewindLines.style.opacity = (
        1 - CJ.eo(CJ.seg(t, until - 0.3, until))
      ).toFixed(3);
      scene.rewindTag.style.opacity =
        t < until - 0.1
          ? (0.75 + 0.25 * Math.cos(t * 6)).toFixed(3)
          : (1 - CJ.seg(t, until - 0.1, until + 0.1)).toFixed(3);
    }
    if (scene.ready) {
      try {
        scene.inst.render(t, scene.ctx);
      } catch (e) {
        scene.ready = false;
        scene.error = {
          scene: scene.meta.id,
          phase: 'render',
          t: scene.start + local,
          message: String((e && e.message) || e),
        };
        if (onError) onError(scene.error);
      }
    }
    let most = 0;
    scene.bubbles.forEach((bubble, i) => {
      const el = scene.mounted.bubbleEls[i];
      const begin = scene.warp.starts[i];
      const v =
        begin == null ? 0 : CJ.win(local, begin, begin + scene.holds[i]);
      el.style.opacity = (v * v * (3 - 2 * v)).toFixed(3);
      if (v > 0) clampBubble(el, scene.bubbleSizes[i], scene.cam.s);
      else el.style.transform = '';
      most = Math.max(most, v);
    });
    scene.mounted.dimmer.style.opacity = (0.32 * most).toFixed(3);
    shadeLabels(scene.mounted);
  };

  return {
    kind: 'film',
    film,
    scenes,
    duration,
    sceneAt,
    // Draws the film at `x` real seconds from its start. Only the scene that
    // contains `x` is shown.
    draw(x) {
      const at = Math.max(0, Math.min(duration, x));
      const i = sceneAt(at);
      if (i !== shown) {
        if (shown >= 0) scenes[shown].box.style.display = 'none';
        scenes[i].box.style.display = 'block';
        shown = i;
      }
      drawScene(scenes[i], at - scenes[i].start);
      return i;
    },
    drawScene,
    // Makes the film measure the bubble `el` again the next time it is drawn.
    // The size of a bubble is measured once and kept, so this must be called
    // when a bubble changes its size, as it does when its rationale opens.
    remeasureBubble(el) {
      scenes.forEach((scene) => {
        const i = scene.mounted ? scene.mounted.bubbleEls.indexOf(el) : -1;
        if (i >= 0) scene.bubbleSizes[i] = {};
      });
    },
    // Shows one scene's box and hides the others, without drawing. The
    // self-test uses it.
    show(i) {
      if (i === shown) return;
      if (shown >= 0) scenes[shown].box.style.display = 'none';
      scenes[i].box.style.display = 'block';
      shown = i;
    },
    chapters() {
      return scenes.map((s) => ({
        id: s.meta.id,
        title: s.meta.title,
        name: s.meta.name || s.meta.title,
        desc: s.meta.desc || '',
        start: s.start,
        dur: s.duration,
      }));
    },
  };
};
