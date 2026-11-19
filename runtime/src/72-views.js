// The data-driven views: schema, lanes, structure and map.
//
// A visual, a film and a step-through are drawn by a plant that an agent
// wrote, with every coordinate chosen by the agent. A view is different. The
// agent writes only data, in `view.json`, and this file decides where
// everything goes and draws it. That keeps views alike, and lets a view show
// far more items than an agent could place by hand.
//
// `compileView` turns the data into the two things a visual is made of: a
// plant (the drawing) and the content of a visual.json (the nodes, the camera
// and, for the views that can be stepped through, a stepper). CJ.boot then
// builds it exactly as it builds a visual, so selecting, panning, zooming,
// the app's inspector and the self-test work for a view without more code.
//
// The four views:
//   - schema: the data shapes of the code as cards with their fields, and
//     arrows for the relations between them.
//   - lanes: the participants of an exchange as lanes, and the messages
//     between them in time order, shown one at a time.
//   - structure: a data structure as it is in memory after each step of an
//     input: arrays, lists, tables and trees, laid out again at every step.
//   - map: a folder or a codebase as nested boxes. One level is shown at a
//     time, and the viewer goes into a box to see what is inside it.

/*@api
## Views (`view.json`)

Only a view job writes this file. A view is drawn by the runtime from data: you give **no coordinates**, no
`plant.js` and no drawing code. Write `view.json` with the `view` the job names. Every view has a `title`
and `nodes`. A node is something of the code that the viewer can select, and it carries the same detail
as a node of a visual (`role`, `refs` with `line` and `end`, `inputs`, `outputs`, `transitions`,
`edgeCases`, `rationale`). A node's `id` starts with a letter and holds letters, digits, `-` and `_` only.

### `"view": "schema"` (data shapes)

| Field | Meaning |
|-------|---------|
| `nodes` | One per type: `{ id, label, role, refs, kind, fields }`. `kind` is `struct`, `class`, `interface`, `enum`, `table`, `message` or `type`. `fields` is `[{ name, type, note, key, optional, ref }]`, in the order of the code. An enum's values are fields without a `type`. `key: true` marks a field that identifies the record. |
| `relations` | `[{ from, to, kind, field }]`: the type `from` holds or refers to the type `to`, through its field `field`. `kind` is `has` (it contains it), `refers` (it holds an id or a pointer to it), `extends` or `implements`. |
| `uses` | `[{ node, field, by, how, ref }]`: the code `by` (a function's name) `reads` or `writes` the field. List every writer of every field, and the readers that decide something. This is what tells the viewer where a field gets its value. |

### `"view": "lanes"` (who talks to whom, in time order)

| Field | Meaning |
|-------|---------|
| `nodes` | The participants, left to right in the order they first take part: `{ id, label, role, refs, kind }`. `kind` is `client`, `service`, `function`, `thread`, `queue`, `store`, `component` or `external`. 2 to 8. |
| `scenarios` | 1 to 8 runs of the exchange: `{ id, label, steps }`. The first is the usual run. Add one for each way it can go differently: a timeout, a retry, an error, a rejected request. |
| `steps` | The messages of a scenario in the order they happen: `{ from, to, label, kind, note, does, ref }`. `from` and `to` are node ids; the same id twice is something a participant does by itself. `kind` is `call`, `return`, `async`, `event`, `error`, `timeout` or `retry`. `label` is what is sent, in at most 40 characters. `note` is one sentence for the viewer, and `does` lists what the receiver does. At most 60 steps. |

### `"view": "structure"` (a data structure in memory, step by step)

A structure view is stepped through like a step-through, so it also needs `sim.js` (see "Step-throughs").
The difference is the drawing: `sim.js` has one more function, `structure(m)`, which returns what is in
memory after the step, and the runtime lays it out.

| Field | Meaning |
|-------|---------|
| `nodes` | The operations of the code, such as `insert`, `rotateLeft`, `resize`: `{ id, label, role, refs, edgeCases }`. A step's `state` is the id of the operation that is running. |
| `stepper` | `{ input, presets, variables, outputs }`, as in a step-through. It has no `edges`. |

`structure(m)` returns `{ blocks: [...] }`. A block is one of:

| Block | Draws |
|-------|-------|
| `{ kind: 'array', label, cells, marks, tones }` | A row of cells with their indexes. `cells` is the values. `marks` is `{ index: text }`, written above a cell, such as `{ 3: 'i', 7: 'hi' }`. |
| `{ kind: 'list', label, items, tones }` | A linked list: boxes with arrows between them. |
| `{ kind: 'table', label, rows, tones }` | A map: one row `[key, value]` per entry. |
| `{ kind: 'tree', label, root }` | A tree. `root` is `{ value, tone, children }`; a child may be `null` to keep an empty place, as a missing left child. |

`tones` is `{ index: 'primary' | 'secondary' }`: `primary` (amber) for what this step changed, `secondary`
(cyan) for what it looked at. A tree node has its own `tone`. Values are shown as text, cut to 6 characters.

### `"view": "map"` (a folder or a codebase, level by level)

| Field | Meaning |
|-------|---------|
| `nodes` | Everything on the map: `{ id, label, role, refs, kind, parent, path }`. `kind` is `system`, `service`, `package`, `folder`, `file`, `class`, `function`, `store` or `external`. `parent` is the id of the node this one is inside; a node without `parent` is on the top level. `path` is the workspace path of the file or folder the node stands for, which lets the app open it and list what was made of it. At most 4 levels, and at most 12 nodes inside one parent. |
| `links` | `[{ from, to, kind, label }]`: `from` uses `to`. `kind` is `calls`, `imports`, `data` or `events`. Give links between the most specific nodes you know, such as function to function. The runtime shows a link at every level, between the boxes that contain its two ends. |
*/

// The sizes the views are drawn with, in sheet pixels.
const VIEW_LEFT = 100;
const VIEW_TOP = 190;

// The grid paper of a view, which may be larger than the 1920 x 1080 sheet.
// It covers the box `x, y, w, h` and 400 px around it.
const viewGrid = (cls, x, y, w, h) =>
  '<defs><pattern id="' +
  cls +
  '-m" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" style="fill:none;stroke:var(--fainter);stroke-width:1"/></pattern>' +
  '<pattern id="' +
  cls +
  '" width="200" height="200" patternUnits="userSpaceOnUse"><rect width="200" height="200" fill="url(#' +
  cls +
  '-m)"/><path d="M200 0H0V200" style="fill:none;stroke:var(--faint);stroke-width:1.5"/></pattern></defs>' +
  '<rect class="grid" x="' +
  (x - 400) +
  '" y="' +
  (y - 400) +
  '" width="' +
  (w + 800) +
  '" height="' +
  (h + 800) +
  '" fill="url(#' +
  cls +
  ')"/>';

// The camera that shows the box `bounds` (`[x, y, w, h]`) whole, with a
// margin, without enlarging small content beyond 1.3.
const cameraFor = (bounds) => {
  const scale = Math.min(
    VIEW_W / (bounds[2] + 160),
    VIEW_H / (bounds[3] + 140),
  );
  return {
    cx: bounds[0] + bounds[2] / 2,
    cy: bounds[1] + bounds[3] / 2,
    z: Math.min(1.3, scale / CAMERA_SCALE),
  };
};

// The nodes of a view as a visual has them: each with the name of the
// element that stands for it.
const viewNodes = (data) =>
  (data.nodes || []).map((node) =>
    Object.assign({}, node, { select: [node.id] }),
  );

// A box with a darker band along its top, as a group with the class `cls`.
// The cards of a schema and the boxes of a map are drawn with it.
const viewCard = (cls, box, head, hot) =>
  '<g class="' +
  cls +
  '" data-cj="card"><rect x="' +
  box.x +
  '" y="' +
  box.y +
  '" width="' +
  box.w +
  '" height="' +
  box.h +
  '" rx="8" style="fill:var(--panel);stroke:' +
  (hot ? 'var(--main)' : 'var(--ink)') +
  ';stroke-width:2"/>' +
  (head
    ? '<path d="M' +
      box.x +
      ' ' +
      (box.y + head) +
      'H' +
      (box.x + box.w) +
      '" style="stroke:var(--line);stroke-width:1.5"/>'
    : '') +
  '</g>';

// ---- schema ---------------------------------------------------------------

const SCHEMA_ROW = 24;
const SCHEMA_HEAD = 38;

const compileSchema = (data) => {
  const nodes = data.nodes || [];
  const sizes = nodes.map((node) => {
    const fields = node.fields || [];
    let widest = 0;
    fields.forEach((field) => {
      const chars =
        String(field.name).length +
        (field.key ? 2 : 0) +
        (field.optional ? 1 : 0) +
        Math.min(22, String(field.type || '').length) +
        3;
      widest = Math.max(widest, chars);
    });
    const title =
      CJ.textWidth(node.label, 16) + CJ.textWidth(node.kind || '', 12) + 48;
    return {
      id: node.id,
      w: Math.round(Math.min(460, Math.max(240, title, widest * 8.4 + 28))),
      h: SCHEMA_HEAD + fields.length * SCHEMA_ROW + (fields.length ? 10 : 0),
    };
  });
  const relations = (data.relations || []).filter((one) => one.from !== one.to);
  const layout = layeredLayout(sizes, relations, {
    x0: VIEW_LEFT,
    y0: VIEW_TOP + 40,
    gapX: 130,
    gapY: 36,
    maxH: 780,
  });
  const bounds = [
    VIEW_LEFT - 40,
    VIEW_TOP - 40,
    Math.max(1200, layout.w + 80),
    Math.max(700, layout.h + 120),
  ];
  // The height at which a relation leaves its card: the row of the field it
  // goes through, or the card's title when it names no field.
  const exitY = (node, box, fieldName) => {
    const index = (node.fields || []).findIndex((f) => f.name === fieldName);
    return index < 0
      ? box.y + SCHEMA_HEAD / 2
      : box.y + SCHEMA_HEAD + index * SCHEMA_ROW + SCHEMA_ROW / 2 + 2;
  };
  const byId = {};
  nodes.forEach((node) => {
    byId[node.id] = node;
  });

  const plant = {
    draw({ c, extraSvg, extraHtml }) {
      let lines = '';
      const lanes = {};
      relations.forEach((one, i) => {
        const a = layout.at[one.from];
        const b = layout.at[one.to];
        if (!a || !b) return;
        lanes[a.col] = (lanes[a.col] || 0) + 1;
        const d = connector(
          a,
          b,
          exitY(byId[one.from], a, one.field),
          b.y + SCHEMA_HEAD / 2,
          layout.cols,
          (lanes[a.col] - 1) % 6,
          VIEW_TOP + 10 - ((lanes[a.col] - 1) % 6) * 6,
        );
        lines += CJ.edge(c('rel' + i), d, {
          kind:
            one.kind === 'extends' || one.kind === 'implements'
              ? 'quiet'
              : 'go',
        }).svg;
      });
      let cards = '';
      let words = '';
      nodes.forEach((node) => {
        const box = layout.at[node.id];
        const fields = node.fields || [];
        cards += viewCard(c(node.id), box, fields.length ? SCHEMA_HEAD : 0);
        const kindWidth = CJ.textWidth(node.kind || '', 12);
        words +=
          '<div class="pl ' +
          c(node.id + '-t') +
          '" style="left:' +
          (box.x + 12) +
          'px;top:' +
          (box.y + 9) +
          'px;font-size:16px;font-weight:700;color:var(--second)">' +
          CJ.esc(fitText(node.label, box.w - kindWidth - 40, 16)) +
          '</div>' +
          (node.kind
            ? CJ.label(node.kind, box.x + box.w - kindWidth - 12, box.y + 13, {
                cls: c(node.id + '-k'),
                size: 12,
                color: 'var(--accent)',
              })
            : '');
        fields.forEach((field, i) => {
          const y = box.y + SCHEMA_HEAD + i * SCHEMA_ROW + 5;
          const name =
            (field.key ? '◆ ' : '') + field.name + (field.optional ? '?' : '');
          const type = fitText(field.type || '', 22 * 8.4, 14);
          const typeWidth = CJ.textWidth(type, 14);
          words += CJ.label(
            fitText(name, box.w - typeWidth - 36, 14),
            box.x + 12,
            y,
            {
              cls: c(node.id + '-f' + i),
              size: 14,
              color: field.key ? 'var(--main)' : 'var(--second)',
            },
          );
          if (type)
            words += CJ.label(type, box.x + box.w - typeWidth - 12, y, {
              cls: c(node.id + '-y' + i),
              size: 14,
            });
        });
      });
      return (
        '<svg class="art" viewBox="0 0 1920 1080">' +
        viewGrid(c('grid'), bounds[0], bounds[1], bounds[2], bounds[3]) +
        lines +
        cards +
        extraSvg +
        '</svg>' +
        words +
        extraHtml
      );
    },
    refs({ q }) {
      return {
        relations: relations.map((one, i) => ({
          one,
          refs: CJ.edge.refs(q, 'rel' + i),
        })),
      };
    },
    set() {},
    nodes: [],
    ports: [],
  };
  return {
    plant,
    visual: {
      title: data.title,
      camera: cameraFor(bounds),
      bounds,
      nodes: viewNodes(data),
      // The relations of the selected type are lit, so that the viewer sees
      // what it holds and what holds it.
      onSelect(handle, id) {
        handle.mounted.refs.relations.forEach((entry) => {
          if (entry.refs.line)
            CJ.edge.set(
              entry.refs,
              id && (entry.one.from === id || entry.one.to === id) ? 1 : 0,
            );
        });
      },
    },
  };
};

// ---- lanes ----------------------------------------------------------------

const LANE_TOP = VIEW_TOP - 20;
const LANE_HEAD = 64;
const LANE_FIRST = LANE_TOP + LANE_HEAD + 70;
const LANE_ROW = 58;

// How a kind of message is drawn, and the tone of the step that shows it.
const LANE_KINDS = {
  call: { edge: 'go', tone: '' },
  async: { edge: 'go', tone: '' },
  event: { edge: 'go', tone: '' },
  return: { edge: 'quiet', tone: 'ok' },
  error: { edge: 'fallback', tone: 'error' },
  timeout: { edge: 'fallback', tone: 'warn' },
  retry: { edge: 'fallback', tone: 'warn' },
};

const compileLanes = (data) => {
  const nodes = data.nodes || [];
  const scenarios = data.scenarios || [];
  const count = Math.max(2, nodes.length);
  const pitch = Math.min(360, Math.max(230, 1560 / (count - 1)));
  const headWidth = Math.min(260, pitch - 30);
  const laneX = {};
  nodes.forEach((node, i) => {
    laneX[node.id] = 200 + i * pitch;
  });
  const most = scenarios.reduce(
    (n, scenario) => Math.max(n, (scenario.steps || []).length),
    1,
  );
  const bottom = LANE_FIRST + most * LANE_ROW + 20;
  const bounds = [
    60,
    LANE_TOP - 30,
    Math.max(1700, 200 + (count - 1) * pitch + 220),
    bottom - LANE_TOP + 60,
  ];
  const rowY = (k) => LANE_FIRST + k * LANE_ROW;
  const nameOf = (si, k) => 's' + si + 'm' + k;

  const plant = {
    draw({ c, extraSvg, extraHtml }) {
      let svg = '';
      let html = '';
      nodes.forEach((node) => {
        const x = laneX[node.id];
        svg +=
          '<path d="M' +
          x +
          ' ' +
          (LANE_TOP + LANE_HEAD) +
          'V' +
          bottom +
          '" style="stroke:var(--line);stroke-width:2;stroke-dasharray:6 8"/>';
        const head = CJ.state(
          c(node.id),
          Math.round(x - headWidth / 2),
          LANE_TOP,
          headWidth,
          LANE_HEAD,
          fitText(node.label, headWidth - 32, 16),
          { sub: node.kind },
        );
        svg += head.svg;
        html += head.html;
      });
      scenarios.forEach((scenario, si) => {
        let lines = '';
        let words = '';
        (scenario.steps || []).forEach((step, k) => {
          const x1 = laneX[step.from];
          const x2 = laneX[step.to];
          if (x1 == null || x2 == null) return;
          const y = rowY(k);
          const kind = (LANE_KINDS[step.kind] || LANE_KINDS.call).edge;
          let edge;
          if (x1 === x2) {
            // Something a participant does by itself: a short loop to the
            // right of its lane, with the words beside it.
            edge = CJ.edge(
              c(nameOf(si, k)),
              'M' +
                x1 +
                ' ' +
                (y - 10) +
                ' H' +
                (x1 + 56) +
                ' V' +
                (y + 12) +
                ' H' +
                (x1 + 10),
              {
                kind,
                label: fitText(step.label, pitch - 110, 14),
                at: [x1 + 68, y - 8],
              },
            );
          } else {
            const dir = x2 > x1 ? 1 : -1;
            edge = CJ.edge(
              c(nameOf(si, k)),
              'M' + (x1 + dir * 6) + ' ' + y + ' H' + (x2 - dir * 6),
              {
                kind,
                label: fitText(step.label, Math.abs(x2 - x1) - 40, 14),
              },
            );
          }
          lines += edge.svg;
          words += edge.html;
        });
        svg += '<g class="' + c('sc' + si) + '">' + lines + '</g>';
        html +=
          '<div class="cj-group ' + c('sw' + si) + '">' + words + '</div>';
      });
      return (
        '<svg class="art" viewBox="0 0 1920 1080">' +
        viewGrid(c('grid'), bounds[0], bounds[1], bounds[2], bounds[3]) +
        svg +
        extraSvg +
        '</svg>' +
        html +
        extraHtml
      );
    },
    refs({ q }) {
      return {
        scenarios: scenarios.map((scenario, si) => ({
          lines: q('sc' + si),
          words: q('sw' + si),
          steps: (scenario.steps || []).map((step, k) =>
            CJ.edge.refs(q, nameOf(si, k)),
          ),
        })),
      };
    },
    defaults: { scenario: 0, shown: -1 },
    // Shows one scenario, with its messages up to the one at index `shown`.
    set(R, S) {
      R.scenarios.forEach((entry, si) => {
        const on = si === S.scenario;
        entry.lines.classList.toggle('cj-layer-off', !on);
        entry.words.classList.toggle('cj-layer-off', !on);
        if (!on) return;
        entry.steps.forEach((refs, k) => {
          const visible = k <= S.shown ? 1 : 0;
          if (refs.line) refs.line.style.opacity = visible;
          if (refs.label) refs.label.style.opacity = visible;
        });
      });
    },
    nodes: [],
    ports: [],
  };

  // The step function of a lanes view: one step per message of the chosen
  // scenario. The input is the scenario's id.
  registry.sim = {
    init(id) {
      const si = Math.max(
        0,
        scenarios.findIndex((scenario) => scenario.id === id),
      );
      return { si, k: 0 };
    },
    step(m) {
      const step = ((scenarios[m.si] || {}).steps || [])[m.k];
      if (!step) return null;
      m.k++;
      return {
        state: step.to,
        edge: nameOf(m.si, m.k - 1),
        does: step.does || [],
        note: step.note || step.label,
        tone: (LANE_KINDS[step.kind] || LANE_KINDS.call).tone,
        ref: step.ref,
      };
    },
    vars: () => ({}),
    outputs: () => ({}),
    stage: (m) => ({ scenario: m.si, shown: m.k - 1 }),
  };

  const edges = [];
  scenarios.forEach((scenario, si) => {
    (scenario.steps || []).forEach((step, k) => {
      edges.push({
        id: nameOf(si, k),
        from: step.from,
        to: step.to,
        when: step.label,
        select: [nameOf(si, k)],
      });
    });
  });
  const home = cameraFor([bounds[0], bounds[1], bounds[2], 820]);
  return {
    plant,
    visual: {
      title: data.title,
      camera: home,
      bounds,
      nodes: viewNodes(data),
      stepper: {
        // The viewer chooses a scenario; there is nothing to type.
        input: null,
        choose: 'Scenario',
        presets: scenarios.map((scenario) => ({
          label: scenario.label,
          input: scenario.id,
        })),
        edges,
        // Two messages in a row need not share a participant, so a step is
        // not required to start where the one before it ended.
        chain: false,
        listEdges: false,
        variables: [],
        outputs: [],
        // Keeps the message of the step on screen in view: when it lies in
        // the lower third of the view or outside it, the camera moves down
        // so that it sits a third of the way from the top.
        onStep(handle, step, index) {
          const y = rowY(index);
          const half = VIEW_H / (handle.view.z * CAMERA_SCALE) / 2;
          const top = handle.view.cy - half;
          if (y > top + half * 1.4 || y < top + 120)
            handle.panTo(handle.view.cx, Math.max(home.cy, y + half * 0.35));
        },
      },
    },
  };
};

// ---- structure ------------------------------------------------------------

const CELL_W = 60;
const CELL_H = 44;
const CELL_PITCH = 62;
const CELLS_PER_ROW = 26;

// The fill and outline of a cell, a box or a tree node with the given tone.
const toneStyle = (tone) =>
  tone === 'primary'
    ? 'fill:var(--amberdim);stroke:var(--main);stroke-width:2.5'
    : tone === 'secondary'
      ? 'fill:var(--cyandim);stroke:var(--accent);stroke-width:2.5'
      : 'fill:var(--panel);stroke:var(--ink);stroke-width:1.5';

// One line of SVG text. The words of a structure change at every step, so
// they are drawn as SVG text of a known width and not as measured labels.
const structText = (text, x, y, size, color, anchor, bold) =>
  '<text x="' +
  r2(x) +
  '" y="' +
  r2(y) +
  '" text-anchor="' +
  (anchor || 'middle') +
  '" style="font-size:' +
  size +
  'px;' +
  (bold ? 'font-weight:700;' : '') +
  'fill:' +
  color +
  '">' +
  CJ.esc(text) +
  '</text>';

const valueText = (value) =>
  fitText(value == null ? '' : value, CELL_W - 8, 15);

// Draws the blocks that `structure(m)` of a structure view returned, one
// under the other, starting at `x0, y0`. Returns the SVG markup and the size
// the blocks take.
const renderBlocks = (blocks, x0, y0) => {
  let svg = '';
  let y = y0;
  let width = 0;
  (blocks || []).forEach((block) => {
    if (!block) return;
    svg += structText(
      block.label || '',
      x0,
      y + 14,
      14,
      'var(--muted)',
      'start',
    );
    y += 30;
    const tones = block.tones || {};
    if (block.kind === 'array' || block.kind === 'list') {
      const values = block.kind === 'array' ? block.cells : block.items;
      const list = Array.isArray(values) ? values : [];
      const pitch = block.kind === 'array' ? CELL_PITCH : CELL_PITCH + 34;
      const marks = block.marks || {};
      const rows = Math.max(1, Math.ceil(list.length / CELLS_PER_ROW));
      list.forEach((value, i) => {
        const cx = x0 + (i % CELLS_PER_ROW) * pitch;
        const cy = y + 20 + Math.floor(i / CELLS_PER_ROW) * 100;
        svg +=
          '<rect x="' +
          cx +
          '" y="' +
          cy +
          '" width="' +
          CELL_W +
          '" height="' +
          CELL_H +
          '" rx="' +
          (block.kind === 'array' ? 4 : 10) +
          '" style="' +
          toneStyle(tones[i]) +
          '"/>' +
          structText(
            valueText(value),
            cx + CELL_W / 2,
            cy + 28,
            15,
            'var(--second)',
            'middle',
            true,
          );
        if (block.kind === 'array')
          svg += structText(
            i,
            cx + CELL_W / 2,
            cy + CELL_H + 16,
            12,
            'var(--muted)',
          );
        else if (i < list.length - 1 && (i + 1) % CELLS_PER_ROW)
          svg +=
            '<path d="M' +
            (cx + CELL_W + 4) +
            ' ' +
            (cy + CELL_H / 2) +
            'H' +
            (cx + pitch - 6) +
            'm-8 -5l8 5l-8 5" style="fill:none;stroke:var(--ink);stroke-width:2;stroke-linecap:round;stroke-linejoin:round"/>';
        if (marks[i] != null)
          svg += structText(
            fitText(marks[i], CELL_W, 13),
            cx + CELL_W / 2,
            cy - 6,
            13,
            'var(--accent)',
            'middle',
            true,
          );
      });
      if (!list.length)
        svg += structText('empty', x0, y + 46, 14, 'var(--muted)', 'start');
      width = Math.max(width, Math.min(list.length, CELLS_PER_ROW) * pitch);
      y += 20 + rows * 100;
    } else if (block.kind === 'table') {
      const rows = Array.isArray(block.rows) ? block.rows : [];
      const cut = (v) => fitText(v == null ? '' : v, 30 * 8.4, 14);
      let keyWidth = 80;
      let valueWidth = 80;
      rows.forEach((row) => {
        keyWidth = Math.max(keyWidth, CJ.textWidth(cut(row[0]), 14) + 24);
        valueWidth = Math.max(valueWidth, CJ.textWidth(cut(row[1]), 14) + 24);
      });
      rows.forEach((row, i) => {
        const ry = y + i * 30;
        svg +=
          '<rect x="' +
          x0 +
          '" y="' +
          ry +
          '" width="' +
          (keyWidth + valueWidth) +
          '" height="28" rx="4" style="' +
          toneStyle(tones[i]) +
          '"/><path d="M' +
          (x0 + keyWidth) +
          ' ' +
          ry +
          'v28" style="stroke:var(--line);stroke-width:1.5"/>' +
          structText(
            cut(row[0]),
            x0 + 12,
            ry + 19,
            14,
            'var(--second)',
            'start',
            true,
          ) +
          structText(
            cut(row[1]),
            x0 + keyWidth + 12,
            ry + 19,
            14,
            'var(--second)',
            'start',
          );
      });
      if (!rows.length)
        svg += structText('empty', x0, y + 20, 14, 'var(--muted)', 'start');
      width = Math.max(width, keyWidth + valueWidth);
      y += Math.max(1, rows.length) * 30 + 10;
    } else if (block.kind === 'tree') {
      const tree = treeLayout(block.root || null, 78, 76);
      let links = '';
      let boxes = '';
      tree.nodes.forEach((entry) => {
        const x = x0 + entry.x;
        const cy = y + 22 + entry.y;
        if (entry.parent >= 0) {
          const parent = tree.nodes[entry.parent];
          links +=
            '<path d="M' +
            r2(x0 + parent.x) +
            ' ' +
            r2(y + 22 + parent.y + 19) +
            'L' +
            r2(x) +
            ' ' +
            r2(cy - 19) +
            '" style="stroke:var(--ink);stroke-width:2"/>';
        }
        boxes +=
          '<rect x="' +
          r2(x - 32) +
          '" y="' +
          r2(cy - 19) +
          '" width="64" height="38" rx="19" style="' +
          toneStyle(entry.node.tone) +
          '"/>' +
          structText(
            valueText(entry.node.value),
            x,
            cy + 5,
            15,
            'var(--second)',
            'middle',
            true,
          );
      });
      if (!tree.nodes.length)
        svg += structText('empty', x0, y + 20, 14, 'var(--muted)', 'start');
      svg += links + boxes;
      width = Math.max(width, tree.w);
      y += Math.max(40, tree.h) + 20;
    }
    y += 26;
  });
  return { svg, w: width, h: y - y0 };
};

const compileStructure = (data) => {
  const nodes = data.nodes || [];
  // The operations of the code, as a row of chips along the top. A row that
  // would reach past the sheet continues on the next line.
  const chips = [];
  let x = VIEW_LEFT;
  let y = VIEW_TOP - 20;
  nodes.forEach((node) => {
    const w = Math.round(
      Math.min(300, Math.max(150, CJ.textWidth(node.label, 16) + 44)),
    );
    if (x + w > 1820 && x > VIEW_LEFT) {
      x = VIEW_LEFT;
      y += 74;
    }
    chips.push({ node, x, y, w });
    x += w + 22;
  });
  const top = y + 56 + 50;
  const agentSim = registry.sim || {};
  // The step function is the agent's. Its `structure(m)` becomes the plant
  // state of the step, which the plant below draws.
  registry.sim = Object.assign({}, agentSim, {
    stage: (m) => ({
      structure: agentSim.structure ? agentSim.structure(m) : { blocks: [] },
    }),
  });
  const base = [VIEW_LEFT - 40, VIEW_TOP - 60, 1760, 760];

  const plant = {
    draw({ c, extraSvg, extraHtml }) {
      let svg = '';
      let html = '';
      chips.forEach((chip) => {
        const part = CJ.state(
          c(chip.node.id),
          chip.x,
          chip.y,
          chip.w,
          56,
          fitText(chip.node.label, chip.w - 32, 16),
        );
        svg += part.svg;
        html += part.html;
      });
      return (
        '<svg class="art" viewBox="0 0 1920 1080">' +
        viewGrid(c('grid'), base[0], base[1], 4000, 4000) +
        svg +
        '<g class="' +
        c('memory') +
        '"></g>' +
        extraSvg +
        '</svg>' +
        html +
        extraHtml
      );
    },
    refs({ q }) {
      return { memory: q('memory') };
    },
    defaults: { structure: { blocks: [] } },
    set(R, S) {
      R.memory.innerHTML = renderBlocks(
        (S.structure || {}).blocks,
        VIEW_LEFT,
        top,
      ).svg;
    },
    nodes: [],
    ports: [],
  };
  const stepper = Object.assign({ edges: [] }, data.stepper || {}, {
    chain: false,
    // Frames the whole run: the camera shows the largest picture any of its
    // steps draws, so that it does not move while the viewer steps.
    onRun(handle, run) {
      let w = 0;
      let h = 0;
      run.steps.forEach((step) => {
        const size = renderBlocks(
          ((step.stage || {}).structure || {}).blocks,
          VIEW_LEFT,
          top,
        );
        w = Math.max(w, size.w);
        h = Math.max(h, size.h);
      });
      handle.fitTo([
        base[0],
        base[1],
        Math.max(1200, w + 120),
        Math.max(500, top - base[1] + h + 40),
      ]);
    },
  });
  return {
    plant,
    visual: {
      title: data.title,
      camera: cameraFor(base),
      bounds: [base[0], base[1], 4000, 4000],
      nodes: viewNodes(data),
      stepper,
    },
  };
};

// ---- map ------------------------------------------------------------------

// The id of the page that shows the top level of a map.
const MAP_ROOT = '';

const compileMap = (data) => {
  const nodes = data.nodes || [];
  const byId = {};
  nodes.forEach((node) => {
    byId[node.id] = node;
  });
  const children = {};
  nodes.forEach((node) => {
    const parent = node.parent && byId[node.parent] ? node.parent : MAP_ROOT;
    (children[parent] = children[parent] || []).push(node);
  });
  // The node of `page` that contains `id`, or is it: the box that stands for
  // `id` on that page. Null when `id` is not inside the page.
  const boxOn = (page, id) => {
    let at = id;
    for (let guard = 0; at && guard < 12; guard++) {
      const parent =
        byId[at].parent && byId[byId[at].parent] ? byId[at].parent : MAP_ROOT;
      if (parent === page) return at;
      at = parent === MAP_ROOT ? null : parent;
    }
    return null;
  };
  const pages = Object.keys(children).map((page) => {
    const boxes = children[page].map((node) => {
      const inside = children[node.id] || [];
      const preview = Math.min(5, inside.length);
      return {
        id: node.id,
        w: Math.round(
          Math.min(
            340,
            Math.max(
              inside.length ? 280 : 210,
              CJ.textWidth(node.label, 16) + 56,
            ),
          ),
        ),
        h: 66 + (preview ? preview * 20 + 12 : 0),
      };
    });
    // A link is shown on this page between the two boxes that contain its
    // ends, when those are two different boxes.
    const seen = {};
    const links = [];
    (data.links || []).forEach((link) => {
      if (!byId[link.from] || !byId[link.to]) return;
      const from = boxOn(page, link.from);
      const to = boxOn(page, link.to);
      if (!from || !to || from === to || seen[from + '>' + to]) return;
      seen[from + '>' + to] = 1;
      links.push({ from, to });
    });
    const layout = layeredLayout(boxes, links, {
      x0: VIEW_LEFT,
      y0: VIEW_TOP + 40,
      gapX: 140,
      gapY: 34,
      maxH: 760,
    });
    return {
      id: page,
      links,
      layout,
      bounds: [
        VIEW_LEFT - 40,
        VIEW_TOP - 40,
        Math.max(1200, layout.w + 80),
        Math.max(640, layout.h + 120),
      ],
    };
  });
  const pageById = {};
  pages.forEach((page) => {
    pageById[page.id] = page;
  });
  const pageClass = (id) => 'pg-' + (id === MAP_ROOT ? 'top' : id);
  const world = pages.reduce(
    (b, page) => [
      b[0],
      b[1],
      Math.max(b[2], page.bounds[2]),
      Math.max(b[3], page.bounds[3]),
    ],
    [VIEW_LEFT - 40, VIEW_TOP - 40, 1200, 640],
  );

  const plant = {
    draw({ c, extraSvg, extraHtml }) {
      let svg = '';
      let html = '';
      pages.forEach((page) => {
        let lines = '';
        let cards = '';
        let words = '';
        const out = {};
        page.links.forEach((link, i) => {
          const a = page.layout.at[link.from];
          const b = page.layout.at[link.to];
          out[link.from] = (out[link.from] || 0) + 1;
          const lane = (out[link.from] - 1) % 6;
          lines += CJ.edge(
            c(pageClass(page.id) + '-l' + i),
            connector(
              a,
              b,
              a.y + 22 + lane * 6,
              b.y + 22,
              page.layout.cols,
              lane,
              VIEW_TOP + 14 - lane * 6,
            ),
          ).svg;
        });
        children[page.id].forEach((node) => {
          const box = page.layout.at[node.id];
          const inside = children[node.id] || [];
          cards += viewCard(c(node.id), box, 0, inside.length > 0);
          words +=
            '<div class="pl ' +
            c(node.id + '-t') +
            '" style="left:' +
            (box.x + 14) +
            'px;top:' +
            (box.y + 12) +
            'px;font-size:16px;font-weight:700;color:var(--second)">' +
            CJ.esc(fitText(node.label, box.w - 28, 16)) +
            '</div>' +
            CJ.label(
              (node.kind || '') +
                (inside.length
                  ? ' · ' + inside.length + ' inside · double-click'
                  : ''),
              box.x + 14,
              box.y + 38,
              {
                cls: c(node.id + '-k'),
                size: 12,
                color: 'var(--accent)',
              },
            );
          inside.slice(0, 5).forEach((child, i) => {
            const more = i === 4 && inside.length > 5;
            words += CJ.label(
              more
                ? '+ ' + (inside.length - 4) + ' more'
                : fitText(child.label, box.w - 40, 13),
              box.x + 26,
              box.y + 64 + i * 20,
              { cls: c(node.id + '-p' + i), size: 13 },
            );
          });
        });
        const off = page.id === MAP_ROOT ? '' : ' cj-layer-off';
        svg +=
          '<g class="' +
          c(pageClass(page.id)) +
          off +
          '">' +
          lines +
          cards +
          '</g>';
        html +=
          '<div class="cj-group ' +
          c(pageClass(page.id) + '-w') +
          off +
          '">' +
          words +
          '</div>';
      });
      return (
        '<svg class="art" viewBox="0 0 1920 1080">' +
        viewGrid(c('grid'), world[0], world[1], world[2], world[3]) +
        svg +
        extraSvg +
        '</svg>' +
        html +
        extraHtml
      );
    },
    refs({ q }) {
      const found = {};
      pages.forEach((page) => {
        found[page.id] = {
          boxes: q(pageClass(page.id)),
          words: q(pageClass(page.id) + '-w'),
        };
      });
      return { pages: found };
    },
    set() {},
    nodes: [],
    ports: [],
  };
  // The path from the top level to a page, as the ids of the nodes to go
  // into, outermost first.
  const trail = (page) => {
    const path = [];
    let at = page;
    while (at && byId[at] && path.length < 12) {
      path.unshift(at);
      at = byId[at].parent || MAP_ROOT;
    }
    return path;
  };
  return {
    plant,
    visual: {
      title: data.title,
      camera: cameraFor(pageById[MAP_ROOT] ? pageById[MAP_ROOT].bounds : world),
      bounds: world,
      nodes: viewNodes(data),
      map: {
        pages: pages.map((page) => page.id),
        // The pages a node has: true when the viewer can go into it.
        has: (id) => !!pageById[id],
        bounds: (id) => (pageById[id] || pages[0]).bounds,
        trail,
        label: (id) => (byId[id] ? byId[id].label : data.title),
      },
    },
  };
};

// Turns the content of a view.json into a plant and the content of a
// visual.json. Throws with a sentence that says what to change when the view
// is of an unknown kind.
const compileView = (data) => {
  const compilers = {
    schema: compileSchema,
    lanes: compileLanes,
    structure: compileStructure,
    map: compileMap,
  };
  const compile = compilers[data.view];
  if (!compile)
    throw new Error(
      'view.json has the view "' +
        data.view +
        '". The views are: ' +
        Object.keys(compilers).join(', ') +
        '.',
    );
  return compile(data);
};

// Builds the navigation of a map around its drawing. A map shows one level at
// a time, which this file calls a page: the top level, or the inside of one
// node. All pages are drawn when the map is built, and all but one are
// hidden.
//
// `visual` is what `compileMap` returned as the visual, and `handle` what
// buildVisual returned for it. `post` sends a message to the app. `layout` is
// called when the bar has changed the room that is left for the stage.
//
// The bar above the stage shows the way from the top level to the page on
// screen, one button per level. Two quick clicks on a box that has parts
// inside open its page. Selecting a node that is on another page, as the
// app does when the user follows a link in the inspector, opens that page
// first.
const buildMapNav = (visual, handle, post, layout) => {
  const map = visual.map;
  const bar = document.getElementById('stepbar');
  document.body.classList.add('mapview');
  const refs = handle.mounted.refs.pages;
  const parentOf = {};
  visual.nodes.forEach((node) => {
    parentOf[node.id] = node.parent && map.has(node.parent) ? node.parent : '';
  });
  let current = MAP_ROOT;

  const drawBar = () => {
    const levels = [MAP_ROOT].concat(map.trail(current));
    bar.innerHTML =
      '<div class="cj-sb-row"><span class="cj-sb-k">Level</span><div class="cj-sb-presets cj-sb-grow">' +
      levels
        .map(
          (id) =>
            '<button data-page="' +
            CJ.esc(id) +
            '"' +
            (id === current ? ' class="cj-on"' : '') +
            '>' +
            CJ.esc(id === MAP_ROOT ? 'Top' : map.label(id)) +
            '</button>',
        )
        .join('') +
      '</div><span class="cj-map-hint">Double-click a box that has parts inside to open it</span></div>';
  };

  // Shows the page with the id `id`, which is MAP_ROOT for the top level or
  // the id of a node that has parts inside.
  const open = (id) => {
    if (!map.has(id)) return;
    current = id;
    Object.keys(refs).forEach((page) => {
      refs[page].boxes.classList.toggle('cj-layer-off', page !== id);
      refs[page].words.classList.toggle('cj-layer-off', page !== id);
    });
    handle.select(null);
    handle.clearHover();
    // The boxes of the page that was hidden had no size, so what the visual
    // remembers about them is cleared.
    handle.setLayers();
    handle.fitTo(map.bounds(id));
    drawBar();
    post({ cj: 'page', id });
  };

  bar.addEventListener('click', (ev) => {
    const button = ev.target.closest('[data-page]');
    if (button) open(button.dataset.page);
  });
  handle.hooks.open.push((id) => {
    if (map.has(id)) open(id);
  });
  handle.hooks.select.push((id) => {
    if (id && parentOf[id] !== current) {
      open(parentOf[id]);
      handle.select(id, true);
    }
  });

  drawBar();
  layout();
  return {
    ids: map.pages,
    open,
    get current() {
      return current;
    },
  };
};
