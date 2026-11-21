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

// Some part functions write their own labels. The agent that wrote the plant
// never typed the class name of such a label, so it cannot find the label by
// searching its files for that name. Each of these labels has a `data-cj-of`
// attribute that holds the name of the part function that wrote it, for
// example `gaugeBar`.
//
// When the self-test reports a problem with such a label, it looks up the
// part function's name in this table and adds the sentence to the issue. The
// sentence says where the part function puts the label and which arguments
// of the call move it. `{i}` is replaced by the number at the end of the
// label's class name. That number is the index of the tick, mark, row, lamp
// or name the label belongs to.
const PART_LABEL_HELP = {
  state:
    'CJ.state centres the name, and the second line `opts.sub` under it, in ' +
    'the box of the state. Move the state with `x` and `y`, widen it with ' +
    '`w`, or shorten the text.',
  edge:
    'CJ.edge writes `opts.label` at the middle of the longest segment of ' +
    'the path. Set `opts.at` to `[x, y]`, the top-left corner of the label, ' +
    'to put it somewhere else.',
  registers:
    'CJ.registers writes row {i} of the table. The name starts at `x + 12` ' +
    'and the value ends at `x + w - 12`. Rows are 26 px apart, starting at ' +
    '`y + 9`. Move the table with `x` and `y`.',
  press:
    'CJ.press writes `label` on the head of the press, in a 76 px wide box ' +
    'that starts at `x - 38` and `yTop + 66`. Move the press with `x` and ' +
    '`yTop`.',
  tallyBoard:
    'CJ.tallyBoard writes the count of row {i} at `x + 68` and ' +
    '`y + 22 + 64 * {i}`. Move the board with `x` and `y`.',
  modeLamps:
    'CJ.modeLamps writes label {i} at `x + 34` and `y + 8 + 29 * {i}`. Move ' +
    'the panel with `x` and `y`.',
  gaugeBar:
    'CJ.gaugeBar writes the label of tick {i}, `ticks[{i}].label`, above ' +
    'the bar, with its top at `y - 34`. Its left edge is at ' +
    '`x + ticks[{i}].at * w + ticks[{i}].dx`. Without a `dx` the label is ' +
    'centred on the tick. Change `ticks[{i}].dx` to move the label ' +
    'sideways, or move the bar with `x` and `y`.',
  tank:
    'CJ.tank writes the label of mark {i}, `marks[{i}].label`, to the right ' +
    'of the vessel. Its left edge is at `x + w + 10`, and it is 12 px above ' +
    'the height of the mark. Move the tank with `x` and `y`, or shorten the ' +
    'label.',
  packer:
    'CJ.packer writes label {i} inside row {i}, at `x + 6` and ' +
    '`y + 2 + 28 * {i}`. Move the rows with `x` and `y`.',
};

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
| `CJ.frame(cls, x, y, w, h)` | A window outline with its top-left corner at `x, y`: a thin frame with a 22 px title strip and no bolts. Name it with a plate, as you name a machine. | A region of the screen: a rendered component or a container element. Code that runs is a machine, not a frame. |
| `CJ.gear(cls, r, teeth, hot)` | A gear centred on (0, 0). Wrap it in `<g transform="translate(x y)">` and turn it by adding `rotate(deg)` to that group. | A dispatcher or router that is busy. |
| `CJ.pipe(cls, d, kind)` | A pipe along the SVG path `d`. Use only `M`, `H` and `V` segments. `kind` is `'hot'` (amber wall), `'cool'` (cyan wall) or omitted (neutral). Wall 44 px wide. | A data path or call path. |
| `CJ.arrow(cls, x, y, dir)` | A small chevron centred on `x, y` pointing `'r'`, `'l'`, `'u'` or `'d'`. One per pipe run is enough. | The direction of flow. |
| `CJ.packet(kind, cls, opts)` | A 60 x 44 packet centred on (0, 0). Position it with `CJ.place`. `kind` is the packet's role and colour: `'primary'` (amber), `'secondary'` (cyan), `'transient'` (dashed, hollow), `'batch'` (banded crate), `'tally'` (tile with tally marks). `opts.form` is its shape and `opts.tag` a short text on it (see "Packet forms"). Never scale packets to different sizes. | One thing that moves through the plant. |
| `CJ.wire(cls, d)` | A dashed amber control wire along path `d`. Drive it with `CJ.wire.set(el, level, t)`: `level` 0 is idle, 1 is glowing, and the dashes move with `t`. | A signal from a limit or flag to the part it restricts. |
| `CJ.drum(cls, cx, y, w, h)` | A storage drum. `cx` is its centre line, `y` its top. | Persistent storage: file, database, log. |
| `CJ.dropBin(cls, x, y)` | A 110 x 80 open bin. | Discarded or filtered data. |
| `CJ.warning(cls)` | An amber warning triangle centred on (0, 0). Position it with `CJ.place`. | An error, exception or rejection in flight. |
| `CJ.ring(cls, x, y, r, width = 4)` | A ring that starts invisible. Set its `style.opacity` to pulse it. | "This threshold was just crossed." |
| `CJ.signal(cls, d)` | A dashed cyan path plus a dot. `CJ.signal.refs(q, name)` gives `{ path, dot }`. Move the dot with `CJ.place` along a route that follows `d`. | A lifecycle event: scope end, callback, cancellation. |
| `CJ.port(cls, x, y, dir)` | A pipe end fitting at the sheet edge, opening `'l'` or `'r'`. Label it with a plate. | A boundary where work enters or leaves the analysed code. |
| `CJ.cursor(cls, dir)` | A 22 x 30 pointer with its tip at (0, 0). `dir` is the direction the tip points in: `'d'` (the default), `'u'`, `'l'` or `'r'`. Position it with `CJ.place`, with the tip on the edge of the thing it points at. | A position that moves: an iterator, an index, a read position. |

### Packet forms (what the thing is)

The kind of a packet says which role it plays in the story. The form says what the thing is. Choose the form
from the nature of the thing in the code, using the table in the core guide. Never choose it by taste.

| `opts.form` | Draws | Use it for |
|-------------|-------|------------|
| `'crate'` (the default) | A rounded crate. | Work passed between units: a request, an event, a message, a job. |
| `'record'` | A card with a tab and field lines. | A struct, row or object that is stored or returned. |
| `'value'` | A hexagon, like a nut. | One number, flag or result. |
| `'key'` | A luggage tag with a hole. | A name for something else: an id, a key, a pointer, a handle. |
| `'element'` | A pill. | Something the user sees on the screen: a button, a menu item, a list row. |
| `'chunk'` | A square block with a row of holes. | Raw data: bytes, a slice of a buffer, a chunk of text. |

Every form has the same 60 x 44 footprint and can be drawn in the kinds `'primary'`, `'secondary'` and
`'transient'`. The kinds `'batch'` and `'tally'` have their own shape. They take no form and no tag.

`opts.tag` writes at most 3 characters on the packet, such as `'3'`, `'A'` or `'GET'`. Use a tag only where
it tells two packets of one form and kind apart, or where it shows a value the film is about. Most packets
have no tag. `CJ.packet.tag(el, text)` changes the tag of a packet that was drawn with one. To draw a packet
whose tag is empty at first, pass `tag: ''`.

```js
const button = CJ.packet('primary', c('button0'), { form: 'element' });
const count = CJ.packet('secondary', c('count'), { form: 'value', tag: '5' });
// In set() or render(): the count has gone down by one.
CJ.packet.tag(q('count'), '4');
```

A thing that moves is always a packet, a `CJ.cursor`, a `CJ.warning` or the dot of a `CJ.signal`. Never draw
a moving thing with your own SVG.
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

// The first element inside the group is the frame's outer rectangle, which is
// what the self-test measures when it checks labels against the frame.
CJ.frame = (cls, x, y, w, h) =>
  '<g class="' +
  cls +
  '" data-cj="frame" transform="translate(' +
  x +
  ' ' +
  y +
  ')"><rect width="' +
  w +
  '" height="' +
  h +
  '" rx="4" style="fill:var(--panel);stroke:var(--ink);stroke-width:2"/>' +
  '<path d="M0 22H' +
  w +
  '" style="stroke:var(--ink);stroke-width:2"/>' +
  [14, 28, 42]
    .map(
      (cx) =>
        '<circle cx="' + cx + '" cy="11" r="3.5" style="fill:var(--line)"/>',
    )
    .join('') +
  '</g>';

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

// The forms a packet can be drawn in, in the order they are documented. The
// form is the outline of the packet and says what the thing is.
const PACKET_FORMS = ['crate', 'record', 'value', 'key', 'element', 'chunk'];

// The most characters the tag of a packet may have. The tag is set in bold
// 15 px text, in which every character is 9 px wide, so 3 characters take
// 27 px. That fits inside every form.
const TAG_MAX = 3;

// The outline of each form: a function that returns one SVG element with the
// given style. Every outline fills the same box, 60 px wide and 44 px tall,
// centred on (0, 0).
const FORM_OUTLINE = {
  crate: (style) =>
    '<rect x="-30" y="-22" width="60" height="44" rx="8" style="' +
    style +
    '"/>',
  record: (style) =>
    '<path d="M-30 -18Q-30 -22 -26 -22H-12L-6 -14H26Q30 -14 30 -10V18' +
    'Q30 22 26 22H-26Q-30 22 -30 18Z" style="' +
    style +
    '"/>',
  value: (style) =>
    '<path d="M-30 0L-17 -22H17L30 0L17 22H-17Z" style="' + style + '"/>',
  key: (style) =>
    '<path d="M-30 0L-14 -22H26Q30 -22 30 -18V18Q30 22 26 22H-14Z" style="' +
    style +
    '"/>',
  element: (style) =>
    '<rect x="-30" y="-22" width="60" height="44" rx="22" style="' +
    style +
    '"/>',
  chunk: (style) =>
    '<rect x="-30" y="-22" width="60" height="44" rx="2" style="' +
    style +
    '"/>',
};

// What is drawn inside the outline of a packet of the given form.
//
// `hollow` is true for the kind 'transient', whose outline is not filled.
// The marks of a hollow packet are drawn in the muted colour. The marks of a
// filled packet are drawn in the ground colour at reduced opacity.
//
// `tagged` is true when the packet carries a tag. A tagged packet leaves out
// the marks that would lie under the tag.
//
// Returns `marks`, the SVG markup, and `tagAt`, the point [x, y] the tag is
// centred on.
const packetInside = (form, hollow, tagged) => {
  const ink = hollow ? 'var(--muted)' : 'var(--ground)';
  const soft = hollow ? '' : ';opacity:.45';
  const line = (d, cap) =>
    '<path d="' +
    d +
    '" style="fill:none;stroke:' +
    ink +
    ';stroke-width:3;stroke-linecap:' +
    (cap || 'round') +
    soft +
    '"/>';
  const dot = (cx, r) =>
    '<circle cx="' + cx + '" r="' + r + '" style="fill:' + ink + soft + '"/>';
  // A row of five square holes whose top edge is at `y`.
  const holes = (y) =>
    [-24, -12, 0, 12, 24]
      .map(
        (cx) =>
          '<rect x="' +
          (cx - 3) +
          '" y="' +
          y +
          '" width="6" height="6" rx="1" style="fill:' +
          ink +
          soft +
          '"/>',
      )
      .join('');
  if (form === 'record')
    return {
      marks:
        line('M-21 -5H21') +
        (tagged ? '' : line('M-21 4H21') + line('M-21 13H5')),
      tagAt: [0, 8],
    };
  if (form === 'value')
    return {
      marks: tagged
        ? ''
        : '<circle r="8" style="fill:none;stroke:' +
          ink +
          ';stroke-width:3' +
          soft +
          '"/>',
      tagAt: [0, 0],
    };
  if (form === 'key')
    return {
      marks: dot(-14, 4.5) + (tagged ? '' : line('M0 -6H19') + line('M0 6H11')),
      tagAt: [10, 0],
    };
  if (form === 'element')
    return {
      marks: tagged ? '' : dot(-13, 5) + line('M-2 0H16'),
      tagAt: [0, 0],
    };
  if (form === 'chunk')
    return {
      marks: holes(-18) + (tagged ? '' : holes(12)),
      tagAt: [0, 4],
    };
  // A crate. A filled crate has a lid line and its tag sits below the lid. A
  // hollow crate has no lid and its tag sits in the middle.
  if (hollow) return { marks: tagged ? '' : dot(0, 6), tagAt: [0, 0] };
  return {
    marks:
      line('M-30 -8H30', 'butt') +
      (tagged
        ? ''
        : '<rect x="-18" y="0" width="20" height="12" rx="2" style="fill:' +
          ink +
          ';opacity:.35"/>'),
    tagAt: [0, 7],
  };
};

// A crate without a tag. Its markup has no `data-form` attribute, and a packet
// without that attribute counts as a crate everywhere in the runtime.
const plainCrate = (kind, cls) => {
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

// Stops with a message that says what to change when a tag is too long.
const checkTag = (tag) => {
  if (tag.length > TAG_MAX)
    throw new Error(
      'The tag "' +
        tag +
        '" has ' +
        tag.length +
        ' characters. A tag has at most ' +
        TAG_MAX +
        '.',
    );
};

// Every packet has one 60 x 44 footprint, whatever its kind and form. The
// first element inside its group is always the outline, which is what the
// self-test measures.
CJ.packet = (kind, cls, opts) => {
  const o = opts || {};
  const form = o.form == null ? 'crate' : o.form;
  const tagged = o.tag != null;
  const tag = tagged ? String(o.tag) : '';
  if (PACKET_FORMS.indexOf(form) < 0)
    throw new Error(
      'There is no packet form called "' +
        form +
        '". The forms are: ' +
        PACKET_FORMS.join(', ') +
        '.',
    );
  checkTag(tag);
  if (kind === 'batch' || kind === 'tally') {
    if (form !== 'crate' || tagged)
      throw new Error(
        'A packet of kind "' +
          kind +
          '" has its own shape. It takes no form and no tag.',
      );
    return plainCrate(kind, cls);
  }
  if (form === 'crate' && !tagged) return plainCrate(kind, cls);

  const hollow = kind === 'transient';
  const body = hollow
    ? 'fill:var(--ground);stroke:var(--muted);stroke-width:3;stroke-dasharray:8 6;stroke-linejoin:round'
    : 'fill:' + (kind === 'primary' ? 'var(--main)' : 'var(--accent)');
  const inside = packetInside(form, hollow, tagged);
  // The tag is SVG text. The stage font is 0.73 of its size tall from the
  // baseline to the top of a capital letter, so a baseline 5.5 px below
  // `tagAt` centres 15 px capitals and digits on that point.
  const text = tagged
    ? '<text class="cj-tag" x="' +
      inside.tagAt[0] +
      '" y="' +
      (inside.tagAt[1] + 5.5) +
      '" text-anchor="middle" style="font-size:15px;font-weight:700;fill:' +
      (hollow ? 'var(--muted)' : 'var(--ground)') +
      '">' +
      CJ.esc(tag) +
      '</text>'
    : '';
  return (
    '<g class="' +
    cls +
    '" data-cj="packet" data-kind="' +
    kind +
    '" data-form="' +
    form +
    '">' +
    FORM_OUTLINE[form](body) +
    inside.marks +
    text +
    '</g>'
  );
};

// Changes the tag of a packet. `el` is the packet's group element. The packet
// must have been drawn with a tag, because only then does it have the text
// element and the room for one.
CJ.packet.tag = (el, text) => {
  const tag = text == null ? '' : String(text);
  checkTag(tag);
  const slot = el.querySelector('.cj-tag');
  if (!slot)
    throw new Error(
      "This packet was drawn without a tag. Pass { tag: '' } to CJ.packet " +
        'to give it one.',
    );
  slot.textContent = tag;
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

// The pointer is drawn with its tip at (0, 0), pointing down, and is turned
// by an inner group. The outer group is left free for CJ.place, which
// replaces the whole `transform` attribute of the element it moves.
CJ.cursor = (cls, dir) => {
  const turn = { d: 0, l: 90, u: 180, r: 270 }[dir] || 0;
  return (
    '<g class="' +
    cls +
    '" data-cj="cursor"><g transform="rotate(' +
    turn +
    ')"><path d="M0 0L-11 -13V-30H11V-13Z" style="fill:var(--ground);stroke:var(--second);stroke-width:3;stroke-linejoin:round"/>' +
    '<path d="M-5 -21H5" style="stroke:var(--second);stroke-width:3;stroke-linecap:round"/></g></g>'
  );
};

/*@api
### State machines (states, transitions, the input and the variables)

Use these when the code is a state machine, or any loop that reads one input piece
by piece: the picture is then a set of states with transitions between them, not a line of machines. Each of
these parts returns an object with `.svg` and `.html`.

`CJ.state(cls, x, y, w, h, label, opts)` draws one state: a box with round corners and its name inside,
with the top-left corner at `x, y`. Heights 56 to 90, widths 150 to 300. `label` is the state's real name,
or a few words when the code has no name for it; it must be at most `(w - 32) / 9.6` characters.
`opts.sub` is an optional second line in smaller text, such as the condition that holds in this state.
`opts.kind` is `'start'` for the state the machine begins in, which gets a small arrow at its left edge,
and `'accept'` for a state the machine may end in, which gets a second outline.

- `CJ.state.refs(q, name)` returns the handles.
- `CJ.state.set(refs, level)` lights the state: `level` 0 is plain, 1 is fully amber. Use it in a film for
  the state the machine is in.

`CJ.edge(cls, d, opts)` draws one transition: a thin line along the SVG path `d` (only `M`, `H` and `V`
segments) with an arrow head at its end. Start and end it on the edges of the two states. `opts.label` is
the trigger, written beside the line, such as `an order`, `count > 30` or `on error`. By default the label sits
at the middle of the longest segment, above a horizontal one or to the right of a vertical one; `opts.at`
gives its top-left corner instead. `opts.kind: 'fallback'` draws a dashed amber line, for a transition taken
on an error or a mismatch. `opts.kind: 'quiet'` draws a dashed grey line, for a transition that only hands
something back, such as a return. A transition from a state to itself is a loop: `M x1 y V y-36 H x2 V y`.

- `CJ.edge.refs(q, name)` returns the handles.
- `CJ.edge.set(refs, level)` lights the transition: 0 is plain, 1 is the transition that was just taken.

`CJ.tape(cls, x, y, cells)` draws the input as a row of `cells` boxes, one character each, with a read head
above the current one. A box is 28 x 40 and boxes are 31 apart, so the row is `cells * 31 - 3` wide; the
read head needs 22 px of clear space above it.

- `CJ.tape.refs(q, name)` returns the handles.
- `CJ.tape.set(refs, text, at, roles)` shows `text` with the read head on the character at index `at`.
  Characters before `at` are drawn as read, and characters after it are dimmed. When the text is longer
  than the row, the row shows the part around `at`. `roles` is optional: one entry per character,
  `'primary'` (amber), `'secondary'` (cyan) or `''`, to tint the characters that belong together.

`CJ.registers(cls, x, y, w, names)` draws the variables of the code as a table: one 26 px row per name, with
the name on the left and its value on the right. Height is `10 + 26 * names.length`. A value must be at
most `(w / 2 - 18) / 8.4` characters.

- `CJ.registers.refs(q, name)` returns the handles.
- `CJ.registers.set(refs, values, changed)` writes the values, as an array of texts in the order of the
  names. `changed` is optional: an array of 0..1, where 1 draws the value in amber because the step that
  was just taken changed it.
*/

// The points an SVG path made of M, H and V segments passes through, as
// [x, y] pairs. Other commands are ignored.
const pathPoints = (d) => {
  const points = [];
  let x = 0;
  let y = 0;
  const pattern = /([MHV])\s*(-?[\d.]+)(?:[\s,]+(-?[\d.]+))?/g;
  for (let m = pattern.exec(d); m; m = pattern.exec(d)) {
    if (m[1] === 'M') {
      x = Number(m[2]);
      y = Number(m[3]);
    } else if (m[1] === 'H') x = Number(m[2]);
    else y = Number(m[2]);
    points.push([x, y]);
  }
  return points;
};

// A state of a state machine. The first element inside the group is the
// state's outline, which is what the self-test measures when it checks labels
// against the state.
CJ.state = (cls, x, y, w, h, label, opts) => {
  const o = opts || {};
  let svg =
    '<g class="' +
    cls +
    '" data-cj="state" transform="translate(' +
    x +
    ' ' +
    y +
    ')"><rect width="' +
    w +
    '" height="' +
    h +
    '" rx="16" style="fill:var(--panel);stroke:var(--ink);stroke-width:2.5"/>';
  if (o.kind === 'accept')
    svg +=
      '<rect x="5" y="5" width="' +
      (w - 10) +
      '" height="' +
      (h - 10) +
      '" rx="12" style="fill:none;stroke:var(--ink);stroke-width:1.5"/>';
  if (o.kind === 'start')
    svg +=
      '<path d="M-22 ' +
      r2(h / 2) +
      'H-6M-12 ' +
      r2(h / 2 - 6) +
      'L-6 ' +
      r2(h / 2) +
      'L-12 ' +
      r2(h / 2 + 6) +
      '" style="fill:none;stroke:var(--ink);stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round"/>';
  svg += '</g>';
  // The name is 16 px bold text, one line. With a second line the two lines
  // are centred together.
  const nameTop = Math.round(y + h / 2 - (o.sub ? 20 : 10));
  let html =
    '<div class="pl ' +
    cls +
    '-l" data-cj-of="state" style="left:' +
    x +
    'px;top:' +
    nameTop +
    'px;width:' +
    w +
    'px;text-align:center;font-size:16px;font-weight:700;line-height:20px;color:var(--second)">' +
    CJ.esc(label) +
    '</div>';
  if (o.sub)
    html += CJ.label(o.sub, x, nameTop + 22, {
      cls: cls + '-s',
      of: 'state',
      w,
      size: 14,
      lineHeight: 18,
    });
  return makePart(svg, html, { x, y, w, h });
};
CJ.state.refs = (q, name) => ({ body: q(name), label: q(name + '-l') });
CJ.state.set = (refs, level) => {
  const lit = Math.round(100 * Math.min(1, Math.max(0, level || 0)));
  refs.body.querySelectorAll('rect').forEach((el) => {
    el.style.stroke =
      'color-mix(in srgb, var(--main) ' + lit + '%, var(--ink))';
  });
  refs.label.style.color =
    'color-mix(in srgb, var(--main) ' + lit + '%, var(--second))';
};

// A transition between two states. The line and its arrow head are the two
// paths of the group, and CJ.edge.set restyles both.
CJ.edge = (cls, d, opts) => {
  const o = opts || {};
  const points = pathPoints(d);
  const fallback = o.kind === 'fallback';
  const quiet = o.kind === 'quiet';
  const stroke = fallback
    ? 'var(--main)'
    : quiet
      ? 'var(--muted)'
      : 'var(--ink)';
  let head = '';
  if (points.length >= 2) {
    const end = points[points.length - 1];
    const from = points[points.length - 2];
    // The head is drawn pointing right and turned to the direction of the
    // last segment.
    const turn =
      end[0] > from[0]
        ? 0
        : end[0] < from[0]
          ? 180
          : end[1] > from[1]
            ? 90
            : 270;
    head =
      '<path transform="translate(' +
      end[0] +
      ' ' +
      end[1] +
      ') rotate(' +
      turn +
      ')" d="M-10 -6L0 0L-10 6" style="fill:none;stroke:' +
      stroke +
      ';stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round"/>';
  }
  const svg =
    '<g class="' +
    cls +
    '" data-cj="edge" data-kind="' +
    (fallback ? 'fallback' : quiet ? 'quiet' : 'go') +
    '"><path d="' +
    d +
    '" style="fill:none;stroke:' +
    stroke +
    ';stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round' +
    (fallback || quiet ? ';stroke-dasharray:7 7' : '') +
    '"/>' +
    head +
    '</g>';
  let html = '';
  if (o.label != null && o.label !== '') {
    const width = CJ.textWidth(o.label, 14);
    let at = o.at;
    if (!at) {
      // The middle of the longest segment.
      let best = null;
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        const length = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]);
        if (!best || length > best.length) best = { a, b, length };
      }
      if (best) {
        const mx = (best.a[0] + best.b[0]) / 2;
        const my = (best.a[1] + best.b[1]) / 2;
        at =
          best.a[1] === best.b[1]
            ? [Math.round(mx - width / 2), Math.round(my - 24)]
            : [Math.round(mx + 10), Math.round(my - 8)];
      } else at = [0, 0];
    }
    html = CJ.label(o.label, at[0], at[1], {
      cls: cls + '-l',
      of: 'edge',
      size: 14,
      color: fallback ? 'var(--main)' : undefined,
    });
  }
  return makePart(svg, html, {});
};
CJ.edge.refs = (q, name) => ({ line: q(name), label: q(name + '-l') });
CJ.edge.set = (refs, level) => {
  const on = (level || 0) > 0.5;
  const kind = refs.line.getAttribute('data-kind');
  const plain = kind === 'quiet' ? 'var(--muted)' : 'var(--ink)';
  refs.line.querySelectorAll('path').forEach((el) => {
    el.style.stroke = on || kind === 'fallback' ? 'var(--main)' : plain;
    el.style.strokeWidth = on ? 4.5 : 2.5;
  });
  if (refs.label)
    refs.label.style.color =
      on || kind === 'fallback' ? 'var(--main)' : 'var(--muted)';
};

// The sizes of the tape: one cell, and the distance from one cell to the
// next.
const TAPE_CELL_W = 28;
const TAPE_CELL_H = 40;
const TAPE_PITCH = 31;

// The input of a state machine as a row of cells. Each cell is a group of a
// box and one character of SVG text. A character of the stage font at 18 px
// is 10.8 px wide, so it always fits its 28 px box.
CJ.tape = (cls, x, y, cells) => {
  let svg = '<g class="' + cls + '" data-cj="tape" data-cells="' + cells + '">';
  for (let i = 0; i < cells; i++)
    svg +=
      '<g class="' +
      cls +
      '-c' +
      i +
      '" transform="translate(' +
      (x + i * TAPE_PITCH) +
      ' ' +
      y +
      ')"><rect width="' +
      TAPE_CELL_W +
      '" height="' +
      TAPE_CELL_H +
      '" rx="5" style="fill:var(--panel);stroke:var(--line);stroke-width:1.5"/>' +
      '<text class="cj-tape-ch" x="' +
      TAPE_CELL_W / 2 +
      '" y="26.5" text-anchor="middle" style="font-size:18px;font-weight:700;fill:var(--second)"></text></g>';
  // The read head: a small pointer above the current cell, with its tip on
  // the top edge of the row. CJ.tape.set moves it.
  svg +=
    '<path class="' +
    cls +
    '-h" data-x="' +
    x +
    '" data-y="' +
    y +
    '" d="M0 -4L-8 -16H8Z" style="fill:var(--main)"/></g>';
  return makePart(svg, '', { cellX: (i) => x + i * TAPE_PITCH });
};
CJ.tape.refs = (q, name) => {
  const row = q(name);
  const cells = [];
  for (let i = 0; q(name + '-c' + i); i++) cells.push(q(name + '-c' + i));
  const head = q(name + '-h');
  return {
    row,
    cells,
    head,
    x: Number(head.getAttribute('data-x')),
    y: Number(head.getAttribute('data-y')),
  };
};
CJ.tape.set = (refs, text, at, roles) => {
  const all = String(text == null ? '' : text);
  const n = refs.cells.length;
  const here = Math.max(0, Math.min(all.length, at == null ? 0 : at));
  // The first character that is shown. The read head is kept about two
  // thirds along the row, and the row never shows space past the end of the
  // text while there is text to show before it.
  const first = Math.max(
    0,
    Math.min(here - Math.floor(n * 0.66), all.length - n),
  );
  refs.cells.forEach((cell, i) => {
    const index = first + i;
    const ch = index < all.length ? all[index] : '';
    const box = cell.firstElementChild;
    const glyph = cell.lastElementChild;
    // A space would be invisible, so it is shown as a small dot.
    glyph.textContent = ch === ' ' ? '·' : ch;
    const role = (roles && roles[index]) || '';
    box.style.fill =
      role === 'primary'
        ? 'var(--amberdim)'
        : role === 'secondary'
          ? 'var(--cyandim)'
          : 'var(--panel)';
    box.style.stroke = index === here && ch ? 'var(--main)' : 'var(--line)';
    box.style.strokeWidth = index === here && ch ? 3 : 1.5;
    cell.style.opacity = !ch ? 0.25 : index > here ? 0.45 : 1;
  });
  const slot = Math.max(0, Math.min(n - 1, here - first));
  refs.head.setAttribute(
    'transform',
    'translate(' +
      (refs.x + slot * TAPE_PITCH + TAPE_CELL_W / 2) +
      ' ' +
      refs.y +
      ')',
  );
  refs.head.style.opacity = here < all.length ? 1 : 0;
};

// The variables of the code as a table of names and values.
CJ.registers = (cls, x, y, w, names) => {
  const h = 10 + 26 * names.length;
  let svg =
    '<g class="' +
    cls +
    '" data-cj="registers"><rect x="' +
    x +
    '" y="' +
    y +
    '" width="' +
    w +
    '" height="' +
    h +
    '" rx="6" style="fill:var(--ground);stroke:var(--line);stroke-width:2"/>';
  let html = '';
  names.forEach((name, i) => {
    const top = y + 5 + i * 26;
    if (i)
      svg +=
        '<path d="M' +
        (x + 8) +
        ' ' +
        top +
        'H' +
        (x + w - 8) +
        '" style="stroke:var(--faint);stroke-width:1.5"/>';
    html +=
      CJ.label(name, x + 12, top + 4, {
        cls: cls + '-n' + i,
        of: 'registers',
        size: 14,
      }) +
      '<div class="pl ' +
      cls +
      '-v' +
      i +
      '" data-cj-of="registers" style="left:' +
      Math.round(x + w / 2) +
      'px;top:' +
      (top + 4) +
      'px;width:' +
      Math.round(w / 2 - 12) +
      'px;text-align:right;font-size:14px;color:var(--second)"></div>';
  });
  svg += '</g>';
  return makePart(svg, html, { h });
};
CJ.registers.refs = (q, name) => {
  const values = [];
  for (let i = 0; q(name + '-v' + i); i++) values.push(q(name + '-v' + i));
  return { box: q(name), values };
};
CJ.registers.set = (refs, values, changed) => {
  refs.values.forEach((el, i) => {
    const text = values && values[i] != null ? String(values[i]) : '';
    el.textContent = text;
    const lit = Math.round(
      100 * Math.min(1, Math.max(0, (changed && changed[i]) || 0)),
    );
    el.style.color =
      'color-mix(in srgb, var(--main) ' + lit + '%, var(--second))';
  });
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

// `opts.of` is for the part functions in this file and is not part of the
// documented API. A part function that writes a label of its own passes its
// own name, such as `'gaugeBar'`, and the label gets that name as its
// `data-cj-of` attribute (see PART_LABEL_HELP).
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
    '"' +
    (o.of ? ' data-cj-of="' + o.of + '"' : '') +
    ' style="' +
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
    of: 'press',
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
    html += CJ.label('×0', x + 68, y + 22 + k * 64, {
      cls: cls + '-n' + k,
      of: 'tallyBoard',
    });
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
    html += CJ.label(text, x + 34, y + 8 + i * 29, {
      cls: cls + '-l' + i,
      of: 'modeLamps',
    });
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
        of: 'gaugeBar',
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
        of: 'tank',
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
    html += CJ.label(text, x + 6, ry + 2, {
      cls: cls + '-l' + i,
      of: 'packer',
      size: 14,
    });
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
