// Drawing primitives: the parts a plant is built from.
//
// Simple parts are functions that return an SVG string. Parts that also need
// HTML labels, or that have state to update, return a "part object" made by
// `makePart`. Each of those functions also carries two helpers: `refs(q, name)`
// finds the part's elements once, and `set(refs, ...)` applies a state to them.

// Builds the object returned by parts that have both SVG and HTML. Using the
// object inside a template string gives the SVG, so `${CJ.bin(...)}` works
// where an SVG string is expected.
const makePart = (svg, html, extra) =>
  Object.assign(
    {
      svg,
      html: html || '',
      toString() {
        return svg;
      },
    },
    extra || {},
  );

const strokeFor = (hot) => (hot ? 'var(--main)' : 'var(--ink)');

/*@api
## Drawing parts

Everything is drawn in world pixels on a 1920 x 1080 sheet. Parts are inline SVG; words are HTML.
`cls` is always a class name you built with the prefixer (`c('name')` in the plant, `ctx.c('name')` in a
scene). Use every name once.

Parts that return a **string** go straight into the SVG markup. Parts that return an **object** have
`.svg` (put it inside the `<svg>`) and, where noted, `.html` (put it after the `</svg>`). Those parts also
have `CJ.<part>.refs(q, name)` to collect their elements in the plant's `refs()` and
`CJ.<part>.set(refs, ...)` to update them in the plant's `set()`. `name` is the unprefixed name you gave
to `c()`.

### Sheet

| Call | Draws |
|------|-------|
| `CJ.grid(cls)` | The grid paper. Put it first in the SVG. |
| `CJ.border()` | The sheet frame with tick marks. Put it right after the grid. |

### Machines, pipes and packets (strings)

| Call | Draws | Means |
|------|-------|-------|
| `CJ.machine(cls, x, y, w, h, hot)` | A housing with its top-left corner at `x, y`: shell, dashed inner panel, corner bolts, hatching. `hot: true` gives an amber outline. Widths 140 to 640. | A code unit: module, class, function, service. |
| `CJ.gear(cls, r, teeth, hot)` | A gear centred on (0, 0). Wrap it in `<g transform="translate(x y)">` and turn it by adding `rotate(deg)` to that group. | A dispatcher or router that is busy. |
| `CJ.pipe(cls, d, kind)` | A pipe along the SVG path `d`. Use only `M`, `H` and `V` segments. `kind` is `'hot'` (amber wall), `'cool'` (cyan wall) or omitted (neutral). Wall 44 px wide. | A data path or call path. |
| `CJ.arrow(cls, x, y, dir)` | A small chevron centred on `x, y` pointing `'r'`, `'l'`, `'u'` or `'d'`. One per pipe run is enough. | The direction of flow. |
| `CJ.packet(kind, cls)` | A 60 x 44 packet centred on (0, 0). Position it with `CJ.place`. Kinds: `'primary'` (amber), `'secondary'` (cyan), `'transient'` (dashed, hollow), `'batch'` (banded crate), `'tally'` (tile with tally marks). Never scale packets to different sizes. | One unit of work. |
| `CJ.wire(cls, d)` | A dashed amber control wire along path `d`. Drive it with `CJ.wire.set(el, level, t)`: `level` 0 is idle, 1 is glowing, and the dashes move with `t`. | A signal from a limit or flag to the part it restricts. |
| `CJ.drum(cls, cx, y, w, h)` | A storage drum. `cx` is its centre line, `y` its top. | Persistent storage: file, database, log. |
| `CJ.dropBin(cls, x, y)` | A 110 x 80 open bin. | Discarded or filtered data. |
| `CJ.warning(cls)` | An amber warning triangle centred on (0, 0). Position it with `CJ.place`. | An error, exception or rejection in flight. |
| `CJ.ring(cls, x, y, r, width = 4)` | A ring that starts invisible. Set its `style.opacity` to pulse it. | "This threshold was just crossed." |
| `CJ.signal(cls, d)` | A dashed cyan path plus a dot. `CJ.signal.refs(q, name)` gives `{ path, dot }`. Move the dot with `CJ.place` along a route that follows `d`. | A lifecycle event: scope end, callback, cancellation. |
| `CJ.port(cls, x, y, dir)` | A pipe end fitting at the sheet edge, opening `'l'` or `'r'`. Label it with a plate. | A boundary where work enters or leaves the analysed code. |
*/
CJ.grid = (cls) =>
  '<defs><pattern id="' +
  cls +
  '-m" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" style="fill:none;stroke:var(--fainter);stroke-width:1"/></pattern>' +
  '<pattern id="' +
  cls +
  '" width="200" height="200" patternUnits="userSpaceOnUse"><rect width="200" height="200" fill="url(#' +
  cls +
  '-m)"/><path d="M200 0H0V200" style="fill:none;stroke:var(--faint);stroke-width:1.5"/></pattern></defs>' +
  '<rect class="grid" x="-400" y="-400" width="2720" height="1880" fill="url(#' +
  cls +
  ')"/>';

CJ.border = () => {
  let s =
    '<g class="border" style="fill:none;stroke:var(--line);stroke-width:2"><rect x="28" y="28" width="1864" height="1024"/>';
  for (let x = 228; x < 1892; x += 200)
    s += '<path d="M' + x + ' 28v12M' + x + ' 1052v-12"/>';
  for (let y = 228; y < 1052; y += 200)
    s += '<path d="M28 ' + y + 'h12M1892 ' + y + 'h-12"/>';
  return s + '</g>';
};

CJ.machine = (cls, x, y, w, h, hot) => {
  const st = strokeFor(hot);
  let s =
    '<g class="' +
    cls +
    '" data-cj="machine" transform="translate(' +
    x +
    ' ' +
    y +
    ')">' +
    '<rect x="8" y="8" width="' +
    w +
    '" height="' +
    h +
    '" rx="10" style="fill:var(--fainter)"/>' +
    '<rect width="' +
    w +
    '" height="' +
    h +
    '" rx="10" style="fill:var(--panel);stroke:' +
    st +
    ';stroke-width:3"/>' +
    '<rect x="14" y="14" width="' +
    (w - 28) +
    '" height="' +
    (h - 28) +
    '" rx="6" style="fill:none;stroke:var(--faint);stroke-width:2;stroke-dasharray:10 8"/>';
  [
    [12, 12],
    [w - 12, 12],
    [12, h - 12],
    [w - 12, h - 12],
  ].forEach((p) => {
    s +=
      '<circle cx="' +
      p[0] +
      '" cy="' +
      p[1] +
      '" r="5" style="fill:none;stroke:' +
      st +
      ';stroke-width:2"/>';
  });
  for (let i = 0; i < 6; i++)
    s +=
      '<path d="M' +
      (w - 6) +
      ' ' +
      (30 + i * ((h - 60) / 6)) +
      'l-14 14" style="stroke:var(--faint);stroke-width:2"/>';
  return s + '</g>';
};

CJ.gear = (cls, r, teeth, hot) => {
  let d = '';
  for (let i = 0; i < teeth; i++) {
    const a0 = (i / teeth) * Math.PI * 2;
    const a1 = a0 + (Math.PI / teeth) * 0.5;
    const a2 = a0 + Math.PI / teeth;
    const a3 = a0 + (Math.PI / teeth) * 1.5;
    const pt = (a, rr) =>
      (Math.cos(a) * rr).toFixed(1) + ' ' + (Math.sin(a) * rr).toFixed(1);
    d +=
      (i ? 'L' : 'M') +
      pt(a0, r) +
      'L' +
      pt(a1, r + 10) +
      'L' +
      pt(a2, r + 10) +
      'L' +
      pt(a3, r);
  }
  const st = strokeFor(hot);
  return (
    '<g class="' +
    cls +
    '"><path d="' +
    d +
    'Z" style="fill:var(--panel);stroke:' +
    st +
    ';stroke-width:2.5"/><circle r="' +
    r * 0.45 +
    '" style="fill:none;stroke:' +
    st +
    ';stroke-width:2"/><circle r="5" style="fill:' +
    st +
    '"/></g>'
  );
};

CJ.pipe = (cls, d, kind) => {
  const wall =
    kind === 'hot'
      ? 'var(--amberdim)'
      : kind === 'cool'
        ? 'var(--cyandim)'
        : 'var(--faint)';
  return (
    '<g class="' +
    cls +
    '" style="fill:none;stroke-linecap:round;stroke-linejoin:round"><path d="' +
    d +
    '" style="stroke:' +
    wall +
    ';stroke-width:44"/><path d="' +
    d +
    '" style="stroke:var(--ground);stroke-width:34"/><path d="' +
    d +
    '" style="stroke:var(--faint);stroke-width:2;stroke-dasharray:6 12"/></g>'
  );
};

CJ.arrow = (cls, x, y, dir) => {
  const turn = { r: 0, d: 90, l: 180, u: 270 }[dir] || 0;
  return (
    '<path class="' +
    cls +
    '" transform="translate(' +
    x +
    ' ' +
    y +
    ') rotate(' +
    turn +
    ')" d="M-5 -8L5 0L-5 8" style="fill:none;stroke:var(--muted);stroke-width:3;stroke-linecap:round;stroke-linejoin:round"/>'
  );
};

// Every packet kind shares one 60 x 44 footprint. Kinds differ by colour and
// marking, never by size.
CJ.packet = (kind, cls) => {
  if (kind === 'batch') {
    return (
      '<g class="' +
      cls +
      '" data-cj="packet" data-kind="' +
      kind +
      '"><rect x="-30" y="-22" width="60" height="44" rx="8" style="fill:var(--second);stroke:var(--main);stroke-width:3"/>' +
      '<path d="M-28.5 -14 V-14 Q-28.5 -20.5 -22 -20.5 H22 Q28.5 -20.5 28.5 -14 V-12 H-28.5 Z" style="fill:var(--main)"/>' +
      [-20, -10, 0, 10, 20]
        .map(
          (x, i) =>
            '<rect x="' +
            (x - 3.5) +
            '" y="-5" width="7" height="20" rx="1.5" style="fill:' +
            (i === 4
              ? 'var(--accent)'
              : 'color-mix(in srgb, var(--main) ' +
                (90 - i * 14) +
                '%, var(--second))') +
            '"/>',
        )
        .join('') +
      '</g>'
    );
  }
  if (kind === 'transient') {
    return (
      '<g class="' +
      cls +
      '" data-cj="packet" data-kind="' +
      kind +
      '"><rect x="-30" y="-22" width="60" height="44" rx="8" style="fill:var(--ground);stroke:var(--muted);stroke-width:3;stroke-dasharray:8 6"/><circle r="6" style="fill:var(--muted)"/></g>'
    );
  }
  if (kind === 'tally') {
    return (
      '<g class="' +
      cls +
      '" data-cj="packet" data-kind="' +
      kind +
      '"><rect x="-30" y="-22" width="60" height="44" rx="8" style="fill:var(--ground);stroke:var(--main);stroke-width:3"/>' +
      [-15, -5, 5, 15]
        .map(
          (x) =>
            '<path d="M' +
            x +
            ' -11v22" style="stroke:var(--main);stroke-width:3"/>',
        )
        .join('') +
      '<path d="M-22 8L22 -8" style="stroke:var(--main);stroke-width:3"/></g>'
    );
  }
  const fill = kind === 'primary' ? 'var(--main)' : 'var(--accent)';
  return (
    '<g class="' +
    cls +
    '" data-cj="packet" data-kind="' +
    kind +
    '"><rect x="-30" y="-22" width="60" height="44" rx="8" style="fill:' +
    fill +
    '"/>' +
    '<path d="M-30 -8H30" style="stroke:var(--ground);stroke-width:3;opacity:.45"/><rect x="-18" y="0" width="20" height="12" rx="2" style="fill:var(--ground);opacity:.35"/></g>'
  );
};

// The packet kinds a legend may list, in the order they are documented.
const PACKET_KINDS = ['primary', 'secondary', 'transient', 'batch', 'tally'];

CJ.wire = (cls, d) =>
  '<path class="' +
  cls +
  '" d="' +
  d +
  '" style="fill:none;stroke:var(--main);stroke-width:4;stroke-dasharray:10 10;opacity:.2"/>';
CJ.wire.set = (el, level, t) => {
  el.style.opacity = 0.18 + 0.82 * (level || 0);
  el.style.strokeDashoffset = (-(t || 0) * 40).toFixed(1);
};

CJ.drum = (cls, cx, y, w, h) => {
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  let ribs = '';
  for (let ry = y + 40; ry <= y + h - 36; ry += 32)
    ribs +=
      '<path d="M' +
      x0 +
      ' ' +
      ry +
      ' Q' +
      cx +
      ' ' +
      (ry + 18) +
      ' ' +
      x1 +
      ' ' +
      ry +
      '" style="fill:none;stroke:var(--faint);stroke-width:2"/>';
  return (
    '<g class="' +
    cls +
    '"><rect x="' +
    x0 +
    '" y="' +
    y +
    '" width="' +
    w +
    '" height="' +
    h +
    '" style="fill:var(--panel);stroke:var(--ink);stroke-width:3"/>' +
    '<ellipse cx="' +
    cx +
    '" cy="' +
    (y + h) +
    '" rx="' +
    w / 2 +
    '" ry="18" style="fill:var(--panel);stroke:var(--ink);stroke-width:3"/>' +
    '<rect x="' +
    (x0 + 2) +
    '" y="' +
    y +
    '" width="' +
    (w - 4) +
    '" height="' +
    (h - 2) +
    '" style="fill:var(--panel)"/>' +
    '<ellipse cx="' +
    cx +
    '" cy="' +
    y +
    '" rx="' +
    w / 2 +
    '" ry="18" style="fill:var(--fainter);stroke:var(--ink);stroke-width:3"/>' +
    ribs +
    '</g>'
  );
};

CJ.dropBin = (cls, x, y) =>
  '<path class="' +
  cls +
  '" d="M' +
  x +
  ' ' +
  y +
  ' H' +
  (x + 110) +
  ' L' +
  (x + 96) +
  ' ' +
  (y + 80) +
  ' H' +
  (x + 14) +
  ' Z" style="fill:var(--panel);stroke:var(--ink);stroke-width:3"/>';

CJ.warning = (cls) =>
  '<g class="' +
  cls +
  '"><path d="M0 -34 L36 28 H-36 Z" style="fill:var(--ground);stroke:var(--main);stroke-width:5;stroke-linejoin:round"/><rect x="-4" y="-14" width="8" height="24" rx="3" style="fill:var(--main)"/><circle cy="19" r="4.5" style="fill:var(--main)"/></g>';

CJ.ring = (cls, x, y, r, width) =>
  '<circle class="' +
  cls +
  '" cx="' +
  x +
  '" cy="' +
  y +
  '" r="' +
  r +
  '" style="fill:none;stroke:var(--main);stroke-width:' +
  (width == null ? 4 : width) +
  ';opacity:0"/>';

CJ.signal = (cls, d) =>
  '<path class="' +
  cls +
  '" d="' +
  d +
  '" style="fill:none;stroke:var(--accent);stroke-width:4;stroke-dasharray:8 10"/><circle class="' +
  cls +
  '-dot" r="10" style="fill:var(--accent)"/>';
CJ.signal.refs = (q, name) => ({ path: q(name), dot: q(name + '-dot') });

CJ.port = (cls, x, y, dir) => {
  const s = dir === 'l' ? -1 : 1;
  return (
    '<g class="' +
    cls +
    '" transform="translate(' +
    x +
    ' ' +
    y +
    ')"><rect x="' +
    (s < 0 ? -18 : 0) +
    '" y="-30" width="18" height="60" rx="4" style="fill:var(--panel);stroke:var(--ink);stroke-width:3"/>' +
    '<path d="M' +
    s * 18 +
    ' -22V22" style="stroke:var(--main);stroke-width:4;stroke-linecap:round"/></g>'
  );
};

/*@api
### Words (HTML strings; put them after the `</svg>`)

Never use SVG `<text>`. Words are HTML so they can be measured and checked.

| Call | Draws |
|------|-------|
| `CJ.plate(text, x, y, cls)` | A boxed bold name plate with its top-left corner at `x, y`. Use it for the real name of a machine. It is 28 px tall and `CJ.textWidth(text) + 23` px wide. Place it above the machine, clear of every pipe. `cls` is optional. |
| `CJ.label(text, x, y, opts)` | A small muted label, one line, 18 px. `text` may be an array of lines. `opts`: `cls`, `size` (14 to 18), `color` (a theme variable such as `'var(--main)'`), `w` (fixed width, text centred in it). A label is `size * 1.15` px tall per line and `CJ.textWidth(text, size)` px wide. |
*/
CJ.plate = (text, x, y, cls) =>
  '<div class="plt' +
  (cls ? ' ' + cls : '') +
  '" style="left:' +
  x +
  'px;top:' +
  y +
  'px">' +
  CJ.esc(text) +
  '</div>';

CJ.label = (text, x, y, opts) => {
  const o = opts || {};
  let style = 'left:' + x + 'px;top:' + y + 'px';
  if (o.w != null) style += ';width:' + o.w + 'px;text-align:center';
  if (o.size != null) style += ';font-size:' + o.size + 'px';
  if (o.lineHeight != null) style += ';line-height:' + o.lineHeight + 'px';
  if (o.color) style += ';color:' + o.color;
  const body = Array.isArray(text)
    ? text.map((line) => '<span>' + CJ.esc(line) + '</span>').join('')
    : CJ.esc(text);
  return (
    '<div class="pl' +
    (o.cls ? ' ' + o.cls : '') +
    '" style="' +
    style +
    '">' +
    body +
    '</div>'
  );
};

/*@api
### Packets that collect marks

`CJ.markedPacket(cls, opts)` returns the SVG string of a primary packet with four marks drawn inside its
footprint: a top bar, a dot, a chip and a bottom bar. Each mark stands for what one processing step added.
`opts.accent: true` fills the dot with cyan. `opts.marks` (1 to 4) limits how many marks exist.

- `CJ.markedPacket.refs(q, name)` returns `{ g, marks }`: the group to move with `CJ.place` and the mark elements.
- `CJ.revealMarks(P, x, stepXs, done)` shows mark `k` once the packet's `x` has passed `stepXs[k]`. `done: true` shows all marks.
*/
CJ.markedPacket = (cls, opts) => {
  const o = opts || {};
  const count = o.marks == null ? 4 : o.marks;
  const marks = [
    '<rect x="-24" y="-19" width="48" height="7" rx="2" style="fill:var(--second)"/>',
    '<circle cx="19" cy="4" r="6" style="fill:' +
      (o.accent ? 'var(--accent)' : 'var(--ground)') +
      ';stroke:var(--second);stroke-width:2"/>',
    '<rect x="-6" y="0" width="14" height="10" rx="2" style="fill:var(--accent)"/>',
    '<rect x="-24" y="14" width="48" height="5" rx="2" style="fill:var(--second)"/>',
  ];
  let s = '<g class="' + cls + '">' + CJ.packet('primary', cls + '-b');
  for (let k = 0; k < count; k++)
    s += '<g class="' + cls + '-c' + k + '">' + marks[k] + '</g>';
  return s + '</g>';
};
CJ.markedPacket.refs = (q, name) => {
  const marks = [];
  for (let k = 0; k < 4; k++) {
    const el = q(name + '-c' + k);
    if (el) marks.push(el);
  }
  return { g: q(name), marks };
};
CJ.revealMarks = (P, x, stepXs, done) => {
  P.marks.forEach((el, k) => {
    el.style.opacity = done || x > stepXs[k] ? 1 : 0;
  });
};

/*@api
### Press (a processing step that marks the packet)

`CJ.press(cls, x, yTop, label)` draws a piston centred on `x` whose top is at `yTop`, with a 76 x 34 head
that carries `label` (at most 7 characters). The head's top edge is at `yTop + 64`. It strikes 26 px
downwards, so the pipe it stamps must run with its centre line about 138 px below `yTop`.
Returns `{ svg, html }`. Space presses at least 100 px apart.

- `CJ.press.refs(q, name)` returns the handles.
- `CJ.press.set(refs, strike)` moves the head and its label; `strike` is 0 (up) to 1 (down).
- `CJ.strikes(stepXs, xs, reach = 50)` returns one strike value per press from the current `x` positions of the
  packets on the belt: a press is fully down when a packet is exactly under it.
*/
CJ.press = (cls, x, yTop, label) => {
  const headY = yTop + 64;
  const svg =
    '<rect x="' +
    (x - 8) +
    '" y="' +
    yTop +
    '" width="16" height="64" style="fill:var(--faint);stroke:var(--ink);stroke-width:2"/>' +
    '<g class="' +
    cls +
    '"><rect x="' +
    (x - 38) +
    '" y="' +
    headY +
    '" width="76" height="34" rx="4" style="fill:var(--panel);stroke:var(--main);stroke-width:3"/></g>';
  const html = CJ.label(label, x - 38, headY + 2, {
    cls: cls + '-l',
    w: 76,
    size: 15,
    lineHeight: 18,
    color: 'var(--second)',
  });
  return makePart(svg, html, { x, headY });
};
CJ.press.refs = (q, name) => ({ head: q(name), label: q(name + '-l') });
CJ.press.set = (refs, strike) => {
  const dy = ((strike || 0) * 26).toFixed(1);
  refs.head.setAttribute('transform', 'translate(0 ' + dy + ')');
  refs.label.style.transform = 'translateY(' + dy + 'px)';
};
CJ.strikes = (stepXs, xs, reach) => {
  const span = reach == null ? 50 : reach;
  return stepXs.map((sx) => {
    let d = 999;
    xs.forEach((x) => {
      d = Math.min(d, Math.abs(x - sx));
    });
    return Math.max(0, 1 - d / span);
  });
};

/*@api
### Bin (a buffer, list or queue held in memory)

`CJ.bin(cls, x, y, w, h, cols = 2)` draws an open box and returns `{ svg, slot }`. `slot(i)` is the centre
`[x, y]` of the i-th packet slot, filling from the bottom row upwards, left to right. Slots are 64 px apart
across and 46 px apart upwards, so packets never touch. Make `w` at least `cols * 64 + 2`. End the route of a
packet that lands in the bin on `slot(i)`. A pipe must stop at the bin's edge, never cross it.
*/
CJ.bin = (cls, x, y, w, h, cols) => {
  const n = cols == null ? 2 : cols;
  const padX = (w - (n * 60 + (n - 1) * 4)) / 2;
  const slot = (i) => [
    x + padX + 30 + (i % n) * 64,
    y + h - 30 - Math.floor(i / n) * 46,
  ];
  const svg =
    '<rect class="' +
    cls +
    '" x="' +
    x +
    '" y="' +
    y +
    '" width="' +
    w +
    '" height="' +
    h +
    '" rx="6" style="fill:var(--fainter);stroke:var(--ink);stroke-width:2.5"/>';
  return makePart(svg, '', { slot });
};

/*@api
### Tally board (counters per key)

`CJ.tallyBoard(cls, x, y, rows)` draws a 100 px wide column of `rows` tally tiles, each with a `×N` count
beside it. Height is `rows * 64 + 4`. Returns `{ svg, html, row }`; `row(k)` is the centre `[x, y]` of tile `k`,
where a counted packet's route should end.

- `CJ.tallyBoard.refs(q, name)` returns the handles.
- `CJ.tallyBoard.set(refs, counts, opacity = 1)` writes the counts (an array of numbers) and dims the board.
*/
CJ.tallyBoard = (cls, x, y, rows) => {
  const row = (k) => [x + 34, y + 32 + k * 64];
  let tiles = '';
  let html = '';
  for (let k = 0; k < rows; k++) {
    const xy = row(k);
    tiles +=
      '<g transform="translate(' +
      xy[0] +
      ' ' +
      xy[1] +
      ')">' +
      CJ.packet('tally', cls + '-t' + k) +
      '</g>';
    html += CJ.label('×0', x + 68, y + 22 + k * 64, { cls: cls + '-n' + k });
  }
  const svg =
    '<g class="' +
    cls +
    '"><rect x="' +
    x +
    '" y="' +
    y +
    '" width="100" height="' +
    (rows * 64 + 4) +
    '" rx="6" style="fill:var(--fainter);stroke:var(--ink);stroke-width:2.5"/>' +
    tiles +
    '</g>';
  return makePart(svg, html, { row });
};
CJ.tallyBoard.refs = (q, name) => {
  const counts = [];
  for (let k = 0; q(name + '-n' + k); k++) counts.push(q(name + '-n' + k));
  return { board: q(name), counts };
};
CJ.tallyBoard.set = (refs, counts, opacity) => {
  refs.board.style.opacity = opacity == null ? 1 : opacity;
  refs.counts.forEach((el, i) => {
    el.textContent = '×' + ((counts && counts[i]) || 0);
  });
};

/*@api
### Mode lamps (the current mode of a state machine)

`CJ.modeLamps(cls, x, y, labels, w = 240)` draws a small panel with one lamp and one label per mode,
stacked 29 px apart. Height is `8 + 29 * labels.length`. Returns `{ svg, html }`.

- `CJ.modeLamps.refs(q, name)` returns the handles.
- `CJ.modeLamps.set(refs, weights)` lights each lamp by its weight (0..1). To cross-fade from mode A to mode B
  with progress `p`, pass `[1 - p, p]`.
*/
CJ.modeLamps = (cls, x, y, labels, w) => {
  const width = w == null ? 240 : w;
  let svg =
    '<rect class="' +
    cls +
    '" x="' +
    x +
    '" y="' +
    y +
    '" width="' +
    width +
    '" height="' +
    (8 + 29 * labels.length) +
    '" rx="6" style="fill:var(--ground);stroke:var(--line);stroke-width:2"/>';
  let html = '';
  labels.forEach((text, i) => {
    svg +=
      '<circle class="' +
      cls +
      '-o' +
      i +
      '" cx="' +
      (x + 18) +
      '" cy="' +
      (y + 18 + i * 29) +
      '" r="8" style="fill:var(--ground);stroke:var(--main);stroke-width:2.5"/>';
    html += CJ.label(text, x + 34, y + 8 + i * 29, { cls: cls + '-l' + i });
  });
  return makePart(svg, html);
};
CJ.modeLamps.refs = (q, name) => {
  const lamps = [];
  const labels = [];
  for (let i = 0; q(name + '-o' + i); i++) {
    lamps.push(q(name + '-o' + i));
    labels.push(q(name + '-l' + i));
  }
  return { lamps, labels };
};
CJ.modeLamps.set = (refs, weights) => {
  refs.lamps.forEach((el, i) => {
    const w = (weights && weights[i]) || 0;
    el.style.fill =
      'color-mix(in srgb, var(--main) ' +
      Math.round(100 * w) +
      '%, var(--ground))';
    refs.labels[i].style.opacity = 0.3 + 0.7 * w;
    refs.labels[i].style.color = w > 0.5 ? 'var(--main)' : 'var(--muted)';
  });
};

/*@api
### Gauge bar (a counter measured against its limits)

`CJ.gaugeBar(cls, x, y, w, ticks)` draws a 16 px tall bar with a labelled tick at each threshold.
`ticks` is `[{ at, label, dx }]`: `at` is the threshold's position from 0 to 1 along the bar, `label` is written
above the tick, and the optional `dx` moves the label's left edge relative to the tick (by default the label
is centred on it). Labels sit 34 px above the bar; keep that band clear. Returns `{ svg, html, tickX }`;
`tickX(i)` is the x of tick `i`, useful for pulse rings.

- `CJ.gaugeBar.refs(q, name)` returns the handles.
- `CJ.gaugeBar.set(refs, level)` fills the bar; `level` is 0..1.
*/
CJ.gaugeBar = (cls, x, y, w, ticks) => {
  const list = ticks || [];
  const tickX = (i) => x + list[i].at * w;
  let svg =
    '<rect x="' +
    x +
    '" y="' +
    y +
    '" width="' +
    w +
    '" height="16" rx="4" style="fill:var(--ground);stroke:var(--line);stroke-width:1.5"/>' +
    '<rect class="' +
    cls +
    '" data-w="' +
    w +
    '" x="' +
    x +
    '" y="' +
    y +
    '" width="0" height="16" rx="4" style="fill:var(--main)"/>';
  let html = '';
  let marks = '';
  list.forEach((tick, i) => {
    const tx = tickX(i);
    marks += (i ? ' ' : '') + 'M' + r2(tx) + ' ' + (y - 10) + ' V' + (y + 26);
    if (tick.label) {
      const dx =
        tick.dx == null ? -Math.round(CJ.textWidth(tick.label) / 2) : tick.dx;
      html += CJ.label(tick.label, Math.round(tx + dx), y - 34, {
        cls: cls + '-l' + i,
      });
    }
  });
  if (marks)
    svg +=
      '<path d="' + marks + '" style="stroke:var(--second);stroke-width:3"/>';
  return makePart(svg, html, { tickX });
};
CJ.gaugeBar.refs = (q, name) => {
  const fill = q(name);
  return { fill, w: Number(fill.getAttribute('data-w')) };
};
CJ.gaugeBar.set = (refs, level) => {
  refs.fill.setAttribute(
    'width',
    (refs.w * Math.min(1, Math.max(0, level || 0))).toFixed(1),
  );
};

/*@api
### Tank (a global resource with soft and hard limits)

`CJ.tank(cls, x, y, w, h, marks, opts)` draws a tall vessel that fills with cyan. `marks` is
`[{ at, label }]`: `at` is the threshold's height from 0 (empty) to 1 (full). Each mark gets a tick across
the vessel, a label to its right and a lamp. `opts.lampX` sets the x of the lamp column (default: 40 px past
the longest label). Returns `{ svg, html, markY }`; `markY(i)` is the y of mark `i`.

- `CJ.tank.refs(q, name)` returns the handles.
- `CJ.tank.set(refs, level, lamps, t)` sets the fill (`level` 0..1), lights the lamps (an array of 0..1) and
  moves the surface ripple with `t`.
*/
CJ.tank = (cls, x, y, w, h, marks, opts) => {
  const list = marks || [];
  const o = opts || {};
  const bottom = y + h - 4;
  const span = h - 8;
  const markY = (i) => bottom - list[i].at * span;
  let longest = 0;
  list.forEach((m) => {
    longest = Math.max(longest, CJ.textWidth(m.label || ''));
  });
  const lampX =
    o.lampX == null ? Math.round(x + w + 10 + longest + 40) : o.lampX;
  let svg =
    '<rect x="' +
    x +
    '" y="' +
    y +
    '" width="' +
    w +
    '" height="' +
    h +
    '" rx="12" style="fill:var(--ground);stroke:var(--ink);stroke-width:3"/>' +
    '<rect class="' +
    cls +
    '" data-x="' +
    (x + 4) +
    '" data-w="' +
    (w - 8) +
    '" data-bottom="' +
    bottom +
    '" data-span="' +
    span +
    '" x="' +
    (x + 4) +
    '" y="' +
    bottom +
    '" width="' +
    (w - 8) +
    '" height="0" rx="8" style="fill:var(--cyandim)"/>' +
    '<path class="' +
    cls +
    '-s" style="fill:none;stroke:var(--accent);stroke-width:3"/>';
  let html = '';
  list.forEach((m, i) => {
    const my = r2(markY(i));
    svg +=
      '<path d="M' +
      (x - 8) +
      ' ' +
      my +
      ' H' +
      (x + w + 8) +
      '" style="stroke:var(--main);stroke-width:3"/>' +
      '<circle class="' +
      cls +
      '-o' +
      i +
      '" cx="' +
      lampX +
      '" cy="' +
      my +
      '" r="9" style="fill:var(--ground);stroke:var(--main);stroke-width:2.5"/>';
    if (m.label)
      html += CJ.label(m.label, x + w + 10, Math.round(markY(i)) - 12, {
        cls: cls + '-l' + i,
      });
  });
  return makePart(svg, html, { markY });
};
CJ.tank.refs = (q, name) => {
  const fill = q(name);
  const lamps = [];
  for (let i = 0; q(name + '-o' + i); i++) lamps.push(q(name + '-o' + i));
  const num = (key) => Number(fill.getAttribute('data-' + key));
  return {
    fill,
    surf: q(name + '-s'),
    lamps,
    x: num('x'),
    w: num('w'),
    bottom: num('bottom'),
    span: num('span'),
  };
};
CJ.tank.set = (refs, level, lamps, t) => {
  const top = refs.bottom - Math.min(1, Math.max(0, level || 0)) * refs.span;
  refs.fill.setAttribute('y', top.toFixed(1));
  refs.fill.setAttribute('height', Math.max(0, refs.bottom - top).toFixed(1));
  let d = 'M' + refs.x + ' ' + top.toFixed(1);
  for (let x = refs.x; x <= refs.x + refs.w; x += 7)
    d +=
      ' L' + x + ' ' + (top + 3 * Math.sin(x * 0.2 + (t || 0) * 4)).toFixed(1);
  refs.surf.setAttribute('d', d);
  refs.lamps.forEach((el, i) => {
    el.style.fill =
      'color-mix(in srgb, var(--main) ' +
      Math.round(100 * ((lamps && lamps[i]) || 0)) +
      '%, var(--ground))';
  });
};

/*@api
### Packer (rows that light up as an aggregate is assembled)

`CJ.packer(cls, x, y, w, labels)` draws one 22 px row per label, 28 px apart: the sections of a record,
the fields of a batch, the steps of a commit. Draw it inside a machine. Returns `{ svg, html }`.

- `CJ.packer.refs(q, name)` returns `{ rows }`.
- `CJ.packer.set(refs, lit)` lights the rows in order: `lit = 2.5` means rows 0 and 1 fully lit and row 2 half lit.
*/
CJ.packer = (cls, x, y, w, labels) => {
  let svg = '';
  let html = '';
  labels.forEach((text, i) => {
    const ry = y + i * 28;
    svg +=
      '<rect class="' +
      cls +
      '-r' +
      i +
      '" x="' +
      x +
      '" y="' +
      ry +
      '" width="' +
      w +
      '" height="22" rx="4" style="fill:var(--amberdim);opacity:.12"/>' +
      '<rect x="' +
      x +
      '" y="' +
      ry +
      '" width="' +
      w +
      '" height="22" rx="4" style="fill:none;stroke:var(--faint);stroke-width:1.5"/>';
    html += CJ.label(text, x + 6, ry + 2, { cls: cls + '-l' + i, size: 14 });
  });
  return makePart(svg, html);
};
CJ.packer.refs = (q, name) => {
  const rows = [];
  for (let i = 0; q(name + '-r' + i); i++) rows.push(q(name + '-r' + i));
  return { rows };
};
CJ.packer.set = (refs, lit) => {
  refs.rows.forEach((el, i) => {
    el.style.opacity = 0.12 + 0.88 * Math.min(1, Math.max(0, (lit || 0) - i));
  });
};

/*@api
### Queue (pending work items)

`CJ.queue(cls, x, y, n)` draws a row of `n` file glyphs, 44 px apart, and a strike-through line that starts
hidden. Returns `{ svg }`.

- `CJ.queue.refs(q, name)` returns the handles.
- `CJ.queue.set(refs, dropped)` fades the items and draws the strike as `dropped` goes from 0 to 1. Use it when
  queued work is abandoned.
*/
CJ.queue = (cls, x, y, n) => {
  let svg = '';
  for (let i = 0; i < n; i++) {
    svg +=
      '<path class="' +
      cls +
      '-i' +
      i +
      '" d="M' +
      (x + i * 44) +
      ' ' +
      y +
      ' h22 l8 8 v30 h-30 Z" style="fill:var(--panel);stroke:var(--ink);stroke-width:2"/>';
  }
  svg +=
    '<path class="' +
    cls +
    '-x" d="M' +
    (x - 10) +
    ' ' +
    (y - 10) +
    ' L' +
    (x + n * 44 - 4) +
    ' ' +
    (y + 48) +
    '" style="stroke:var(--main);stroke-width:5;opacity:0"/>';
  return makePart(svg, '');
};
CJ.queue.refs = (q, name) => {
  const items = [];
  for (let i = 0; q(name + '-i' + i); i++) items.push(q(name + '-i' + i));
  return { items, strike: q(name + '-x') };
};
CJ.queue.set = (refs, dropped) => {
  const d = dropped || 0;
  refs.items.forEach((el) => {
    el.style.opacity = 1 - 0.7 * d;
  });
  refs.strike.style.opacity = d;
};

/*@api
### Reader (streaming input being read)

`CJ.reader(cls, x, y, w)` draws a 60 px tall window with chunks sliding through it and two read heads.
Returns `{ svg }`.

- `CJ.reader.refs(q, name)` returns the handles.
- `CJ.reader.set(refs, run)` slides the chunks; pass a value that grows while input is being read, such as
  the scene time, and hold it still when reading stops.
*/
CJ.reader = (cls, x, y, w) => {
  const count = Math.ceil(w / 30) + 2;
  let chunks = '';
  for (let i = 0; i < count; i++)
    chunks +=
      '<rect x="' +
      (x + i * 30) +
      '" y="' +
      (y + 8) +
      '" width="24" height="44" rx="3" style="fill:var(--faint);stroke:var(--ink);stroke-width:1.5"/>';
  const headX = x + Math.round(w / 2) - 5;
  const svg =
    '<defs><clipPath id="' +
    cls +
    '-clip"><rect x="' +
    x +
    '" y="' +
    y +
    '" width="' +
    w +
    '" height="60"/></clipPath></defs>' +
    '<g clip-path="url(#' +
    cls +
    '-clip)"><g class="' +
    cls +
    '">' +
    chunks +
    '</g></g>' +
    '<path d="M' +
    headX +
    ' ' +
    (y - 10) +
    ' V' +
    (y + 70) +
    ' M' +
    (headX + 30) +
    ' ' +
    (y - 10) +
    ' V' +
    (y + 70) +
    '" style="stroke:var(--main);stroke-width:3"/>';
  return makePart(svg, '');
};
CJ.reader.refs = (q, name) => ({ chunks: q(name) });
CJ.reader.set = (refs, run) => {
  refs.chunks.setAttribute(
    'transform',
    'translate(' + (-(((run || 0) * 90) % 30)).toFixed(1) + ' 0)',
  );
};
