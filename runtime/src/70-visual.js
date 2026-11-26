// The still visual: one copy of the plant that the viewer can pan, zoom and
// inspect. There is no timeline. Hovering a part highlights it, clicking
// selects it, numbered markers open bubbles, and layers can be switched off to
// declutter.

/*@api
## Still visuals (`visual.json`)

A visual shows the plant once, in a representative state, with no timeline. The runtime provides pan, zoom,
hover highlight, click to select, layer toggles and numbered markers. You only declare data:

| Field | Meaning |
|-------|---------|
| `title` | Shown in the title band. |
| `camera` | `{ cx, cy, z }`: the default framing. Choose it so the whole flow is visible with at least 40 px of margin. |
| `state` | The plant state to show, merged over the plant's `defaults`. Pick a moment where the interesting parts are visible at once. |
| `nodes` | The clickable parts: `{ id, label, role, refs: [{ path, line, end }], select: [names] }`. `select` lists the unprefixed names of the elements that highlight together; give each clickable machine one wrapping element. Whatever is drawn inside a selected element, such as the labels on a machine, is highlighted with it. A plate inside a machine can be a node of its own: a click on it selects it, and a click beside it selects the machine. A node also carries the detail that the app shows when the viewer selects it (see "Node detail"). |
| `layers` | `{ data: [...], control: [...], errors: [...], labels: [...] }`. Each entry is an unprefixed element name, a name ending in `*` (matches `pipe1`, `pipe2`, ...), or a class selector starting with `.` (such as `.pl` and `.plt` for all labels and plates). |
| `markers` | 3 to 8 points of interest: `{ x, y, n, bubble: { kicker, html, tail, alarm } }`. `n` is the number shown, in reading order along the flow. Clicking a marker opens its bubble beside it. |
| `legend` | Optional rows `{ kind, form, html }`, one for each combination of packet kind and form the plant draws. Leave `form` out for a crate. A row names one thing. At most 6 rows, and at most 3 different forms. |

A node may also have a `rationale`: why the code does what the node stands for (see Rationale).

### Node detail

The drawing stays calm, and the detail of a part is shown beside it when the viewer selects the part. Give
every node that stands for code the fields below that apply to it. They cost nothing in the drawing, so do
not hold back: this is where the viewer finds what the code really does.

| Field | Meaning |
|-------|---------|
| `refs` | `[{ path, line, end }]`. The first entry is the code of this part: `line` is its first line and `end` its last, at most 24 lines. The app shows those lines under the part's name, so never copy code into another field. |
| `inputs` | What the part reads: up to 6 short texts, each a name from the code and what it is, such as `now: the time of the order`. |
| `outputs` | What the part writes or returns, in the same form: `w.count++`. |
| `transitions` | Where the work goes from here: `[{ when, to }]`. `when` is the condition in a few words (`an order arrives`, `count > 30`, `on error`). `to` is the id of another node, or a few words when the target is not drawn. |
| `edgeCases` | What a reader would not expect: `[{ text, example, refs }]`. `text` is one or two sentences on what the code does in the case. `example` is an input that shows it, when there is one. `refs` name the line that makes it so. List every one you find: a limit that is off by one, a value that is never reset, input that is accepted although it looks wrong, a branch that can never run. Only what the code shows: no guesses about what was intended. |
*/

const buildVisual = (visual, stage, post) => {
  const plant = registry.plant;
  if (!plant)
    throw new Error(
      'No plant is defined. plant.js must call CJ.definePlant({...}).',
    );
  const box = document.createElement('div');
  box.className = 'scene-box';
  box.dataset.scene = 'v';
  stage.append(box);

  // The markers of the visual. After the numbered markers of visual.json comes
  // one marker for each node that has a rationale. Such a marker shows "?",
  // has `why` set to the id of its node, and is placed on a corner of the node
  // once the plant is drawn (see `placeWhyMarkers`). These markers are hidden
  // until the viewer switches the rationale layer on.
  const whyNodes = (visual.nodes || []).filter(
    (node) => node.rationale && node.rationale.text,
  );
  const markers = (visual.markers || []).concat(
    whyNodes.map((node) => ({
      x: 0,
      y: 0,
      n: '?',
      why: node.id,
      bubble: {
        kicker: 'RATIONALE · ' + node.label,
        html:
          rationaleHtml(node.rationale) +
          '<br><i>' +
          CJ.esc(rationaleSource(node.rationale)) +
          '</i>',
      },
    })),
  );
  const bubbles = markers.map((m) =>
    Object.assign({ x: m.x, y: m.y, maxWidth: 420 }, m.bubble),
  );
  const m = mountPlantCopy(box, 'v', plant, visual.title, {}, bubbles);
  const world = m.world;
  const state = Object.assign({}, plant.defaults || {}, visual.state || {});
  if (plant.set) plant.set(m.refs, state, 0);

  // An overlay inside the world. When a part is highlighted, a veil dims the
  // whole drawing. Copies of the highlighted elements, and of everything
  // drawn inside them, are drawn above the veil at full brightness.
  const veil = elementFromHtml('<div class="cj-veil"></div>');
  const liftSvg = elementFromHtml(
    '<svg class="art cj-lift" viewBox="0 0 1920 1080"></svg>',
  );
  const liftHtml = elementFromHtml('<div class="cj-lift-html"></div>');
  m.dimmer.before(veil, liftSvg, liftHtml);

  const markerEls = markers.map((marker, i) => {
    const el = elementFromHtml(
      '<div class="cj-marker' +
        (marker.why ? ' cj-why cj-layer-off' : '') +
        (marker.bubble && marker.bubble.alarm ? ' alarm' : '') +
        '" style="left:' +
        marker.x +
        'px;top:' +
        marker.y +
        'px">' +
        CJ.esc(marker.n == null ? i + 1 : marker.n) +
        '</div>',
    );
    m.dimmer.before(el);
    return el;
  });

  const tip = elementFromHtml('<div class="cj-tip"></div>');
  m.view.append(tip);

  // Notes. The app can put notes on the nodes of a visual that is already
  // built: it sends them in a `notes` message (see 90-player.js), which calls
  // `setNotes`. Nothing of the plant changes. Each note is a numbered mark on
  // a corner of its node, and a click on the mark shows the note's text in
  // `noteCard`. A note of the kind `emphasis` also has a frame around its
  // node.
  //
  // Each entry of `notes` holds the note as the app sent it, the entry of
  // `nodes` it is on, its mark `el`, its frame `ring` or null, and the place
  // `x`, `y` of the mark in world pixels. `openNote` is the id of the note
  // whose text is shown, or null. `notesStale` is true when a node may have
  // moved or been hidden since the marks were placed, so that the next
  // `draw` places them again.
  let notes = [];
  let notesOn = true;
  let notesStale = false;
  let openNote = null;
  const noteCard = elementFromHtml('<div class="cj-note-card"></div>');
  noteCard.style.display = 'none';
  world.append(noteCard);

  // Every element that belongs to a node, by node id.
  const nodes = (visual.nodes || []).map((node) => {
    const els = [];
    (node.select || []).forEach((name) => {
      const el = m.q(name);
      if (el) els.push(el);
    });
    els.forEach((el) => {
      el.classList.add('cj-node');
      el.setAttribute('data-node', node.id);
    });
    return { node, els };
  });
  const nodeById = {};
  nodes.forEach((entry) => {
    nodeById[entry.node.id] = entry;
  });

  // Puts the "?" marker of each node that has a rationale on a corner of the
  // node's first element. The corners are tried in the order top left, top
  // right, bottom left, bottom right, and the first one that is at least 40 px
  // away from every marker placed so far is taken. If none is, the top left
  // corner is used. The bubble of a marker in the lower part of the sheet
  // opens above it, and every other bubble below it.
  const placeWhyMarkers = () => {
    const frame = world.getBoundingClientRect();
    const scale = frame.width / STAGE_W || 1;
    const placed = markers.filter((marker) => !marker.why);
    markers.forEach((marker, i) => {
      const entry = marker.why && nodeById[marker.why];
      if (!entry || !entry.els.length) return;
      const box = entry.els[0].getBoundingClientRect();
      const left = (box.left - frame.left) / scale;
      const top = (box.top - frame.top) / scale;
      const right = (box.right - frame.left) / scale;
      const bottom = (box.bottom - frame.top) / scale;
      const corners = [
        [left, top],
        [right, top],
        [left, bottom],
        [right, bottom],
      ];
      const free = corners.find((corner) =>
        placed.every(
          (other) => Math.hypot(other.x - corner[0], other.y - corner[1]) >= 40,
        ),
      );
      const at = free || corners[0];
      marker.x = Math.round(at[0]);
      marker.y = Math.round(at[1]);
      marker.bubble.tail = marker.y > STAGE_H * 0.62 ? 'd' : 'u';
      markerEls[i].style.left = marker.x + 'px';
      markerEls[i].style.top = marker.y + 'px';
      placed.push(marker);
    });
  };
  placeWhyMarkers();
  let rationaleOn = false;

  // The elements each layer switches, resolved once from the layer's patterns.
  const layerEls = {};
  const prefixed = Array.from(world.querySelectorAll('[class]'));
  Object.keys(visual.layers || {}).forEach((layer) => {
    const found = new Set();
    visual.layers[layer].forEach((pattern) => {
      if (pattern.charAt(0) === '.') {
        world.querySelectorAll(pattern).forEach((el) => found.add(el));
        return;
      }
      const star = pattern.charAt(pattern.length - 1) === '*';
      const stem = m.c(star ? pattern.slice(0, -1) : pattern);
      prefixed.forEach((el) => {
        const classes = (el.getAttribute('class') || '').split(/\s+/);
        if (
          classes.some((one) => (star ? one.indexOf(stem) === 0 : one === stem))
        )
          found.add(el);
      });
    });
    layerEls[layer] = Array.from(found);
  });
  const layerOn = {};
  Object.keys(layerEls).forEach((layer) => {
    layerOn[layer] = true;
  });

  const home = {
    cx: visual.camera.cx,
    cy: visual.camera.cy,
    z: visual.camera.z,
  };
  // The part of the world the viewer can move over, as [x, y, width,
  // height]. A visual is drawn on the 1920 x 1080 sheet. A view may be
  // larger and says how large in `visual.bounds`; it may also be zoomed out
  // further, so that all of it fits in the window.
  const limits = visual.bounds || [0, 0, STAGE_W, STAGE_H];
  const leastZoom = visual.bounds ? 0.12 : 0.5;
  const insideX = (x) =>
    Math.min(limits[0] + limits[2], Math.max(limits[0], x));
  const insideY = (y) =>
    Math.min(limits[1] + limits[3], Math.max(limits[1], y));
  const view = { cx: home.cx, cy: home.cy, z: home.z };
  let hovered = null;
  let selected = null;
  let openMarker = -1;
  const bubbleSizes = bubbles.map(() => ({}));

  // Where a marker's bubble goes: beside the marker, on the side its tail
  // points away from.
  const placeBubble = (i) => {
    const el = m.bubbleEls[i];
    const marker = markers[i];
    const tail = (marker.bubble && marker.bubble.tail) || 'u';
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = marker.x - 49;
    let top = marker.y + 34;
    if (tail === 'd') top = marker.y - 34 - h;
    if (tail === 'l') {
      left = marker.x + 34;
      top = marker.y - 35;
    }
    if (tail === 'r') {
      left = marker.x - 34 - w;
      top = marker.y - 35;
    }
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    if (!el.classList.contains('tail-' + tail))
      el.classList.add('tail-' + tail);
    bubbleSizes[i] = {};
  };

  // The parts of the drawing that a highlight leaves alone: the overlay
  // itself, the markers and the bubbles.
  const notDrawing = (el) =>
    el === veil ||
    el === liftSvg ||
    el === liftHtml ||
    el === m.dimmer ||
    el === noteCard ||
    el.classList.contains('cj-marker') ||
    el.classList.contains('cj-note-ring') ||
    el.classList.contains('bub');

  // The elements that are drawn inside the elements of a node without being
  // part of the node: the labels and plates on a machine, and the smaller
  // parts drawn in it. They are highlighted with the node. Without them, the
  // bright copy of a machine's body would cover what is written on it.
  //
  // An element counts as inside when its box lies within the box of one of
  // the node's elements and it comes after that element in the page, which
  // means it is drawn on top of it. A group that is only partly inside is
  // searched for children that are inside. A group with a `transform` is not
  // searched, because a copy of one of its children would lose that
  // transform and be drawn in the wrong place.
  //
  // The result is kept in `entry.inside`. `setLayers` clears it, because an
  // element of a layer that is switched off has no box.
  const insideOf = (entry) => {
    if (entry.inside) return entry.inside;
    const hosts = entry.els.map((el) => ({
      el,
      box: el.getBoundingClientRect(),
    }));
    const within = (el) => {
      const b = el.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) return false;
      return hosts.some(
        (host) =>
          b.left >= host.box.left - 1 &&
          b.right <= host.box.right + 1 &&
          b.top >= host.box.top - 1 &&
          b.bottom <= host.box.bottom + 1 &&
          !!(
            host.el.compareDocumentPosition(el) &
            Node.DOCUMENT_POSITION_FOLLOWING
          ),
      );
    };
    const found = [];
    const search = (parent) => {
      Array.from(parent.children).forEach((el) => {
        if (notDrawing(el) || el.hasAttribute('data-copy')) return;
        const own = entry.els.some((one) => one === el || one.contains(el));
        if (own) return;
        const holdsNode = entry.els.some((one) => el.contains(one));
        if (!holdsNode && within(el)) found.push(el);
        else if (el.children.length && !el.hasAttribute('transform'))
          search(el);
      });
    };
    search(world);
    entry.inside = found;
    return found;
  };

  // Draws a copy of `el` above the veil. `cls` is the class that gives the
  // copy its glow, or null for an element that is only shown with a node.
  const lift = (el, cls) => {
    const copy = el.cloneNode(true);
    copy.removeAttribute('id');
    copy
      .querySelectorAll('[id]')
      .forEach((child) => child.removeAttribute('id'));
    if (cls) {
      copy.classList.add(cls);
      copy.classList.remove('cj-layer-off');
    }
    copy.setAttribute('data-copy', '1');
    (el instanceof SVGElement ? liftSvg : liftHtml).append(copy);
  };

  // Highlights a node: its own elements with the glow of `cls`, and
  // everything drawn inside them as it is.
  const liftCopies = (entry, cls) => {
    entry.els.forEach((el) => lift(el, cls));
    insideOf(entry).forEach((el) => lift(el, null));
  };

  // The veil is placed over the part of the world that the view shows, with
  // VEIL_MARGIN view pixels to spare on every side. It is placed again on
  // every draw, so it covers the whole view at every zoom and however large
  // `visual.bounds` is.
  const VEIL_MARGIN = 40;
  const placeVeil = (scale) => {
    veil.style.left = view.cx - (VIEW_CX + VEIL_MARGIN) / scale + 'px';
    veil.style.top = view.cy - (VIEW_CY + VEIL_MARGIN) / scale + 'px';
    veil.style.width = (VIEW_W + 2 * VEIL_MARGIN) / scale + 'px';
    veil.style.height = (VIEW_H + 2 * VEIL_MARGIN) / scale + 'px';
  };

  // Puts the mark of each note on a corner of the first element of its node
  // that is displayed. The corners are tried in the order top right, top
  // left, bottom right, bottom left, and the first one that is at least 40 px
  // away from every marker of the visual and every mark placed so far is
  // taken. If none is, the top right corner is used. A note whose node is not
  // displayed, for example on a level of a map that is not on screen, has
  // its mark hidden. All marks are hidden while the notes are switched off.
  const placeNotes = () => {
    const frame = world.getBoundingClientRect();
    if (!frame.width) {
      notesStale = true;
      return;
    }
    notesStale = false;
    const scale = frame.width / STAGE_W;
    const placed = markers.map((marker) => [marker.x, marker.y]);
    notes.forEach((one) => {
      const box = one.entry.els
        .map((el) => el.getBoundingClientRect())
        .find((rect) => rect.width || rect.height);
      const shown = notesOn && !!box;
      one.el.style.display = shown ? '' : 'none';
      if (one.ring) one.ring.style.display = shown ? '' : 'none';
      one.shown = shown;
      if (!shown) return;
      const left = (box.left - frame.left) / scale;
      const top = (box.top - frame.top) / scale;
      const right = (box.right - frame.left) / scale;
      const bottom = (box.bottom - frame.top) / scale;
      const corners = [
        [right, top],
        [left, top],
        [right, bottom],
        [left, bottom],
      ];
      const free = corners.find((corner) =>
        placed.every(
          (other) =>
            Math.hypot(other[0] - corner[0], other[1] - corner[1]) >= 40,
        ),
      );
      const at = free || corners[0];
      one.x = Math.round(at[0]);
      one.y = Math.round(at[1]);
      one.el.style.left = one.x + 'px';
      one.el.style.top = one.y + 'px';
      placed.push([one.x, one.y]);
      if (one.ring) {
        one.ring.style.left = left - NOTE_RING_GAP + 'px';
        one.ring.style.top = top - NOTE_RING_GAP + 'px';
        one.ring.style.width = right - left + 2 * NOTE_RING_GAP + 'px';
        one.ring.style.height = bottom - top + 2 * NOTE_RING_GAP + 'px';
      }
    });
  };
  // How far the frame of an `emphasis` note is from the box of its node, in
  // world pixels.
  const NOTE_RING_GAP = 8;

  // Shows the text of the open note beside its mark, or hides the card when
  // no note is open or the open note has no text. The card opens below and to
  // the right of the mark. It is moved left or up as far as needed to stay
  // inside the part of the world that the view shows. `scale` is the factor
  // between world pixels and view pixels.
  const placeNoteCard = (scale) => {
    const open = notes.find((one) => one.note.id === openNote);
    notes.forEach((one) => one.el.classList.toggle('open', one === open));
    if (!open || !open.shown || !open.note.text) {
      noteCard.style.display = 'none';
      return;
    }
    noteCard.style.display = '';
    noteCard.classList.toggle('cj-flag', open.note.kind === 'flag');
    const margin = 12 / scale;
    const viewLeft = view.cx - VIEW_CX / scale + margin;
    const viewRight = view.cx + (VIEW_W - VIEW_CX) / scale - margin;
    const viewTop = view.cy - VIEW_CY / scale + margin;
    const viewBottom = view.cy + (VIEW_H - VIEW_CY) / scale - margin;
    const left = Math.max(
      viewLeft,
      Math.min(open.x + 24, viewRight - noteCard.offsetWidth),
    );
    const top = Math.max(
      viewTop,
      Math.min(open.y + 24, viewBottom - noteCard.offsetHeight),
    );
    noteCard.style.left = left + 'px';
    noteCard.style.top = top + 'px';
  };

  // Makes the note with the id `id` the open one, or closes the open note
  // with null, and writes its text into the card.
  const setOpenNote = (id) => {
    const found = notes.find((one) => one.note.id === id);
    openNote = found ? found.note.id : null;
    if (found)
      noteCard.innerHTML =
        '<span class="k">' +
        (found.note.kind === 'flag' ? 'FLAG ' : 'NOTE ') +
        CJ.esc(found.note.n) +
        '</span>' +
        CJ.esc(found.note.text);
  };

  // False until the labels that lie over a packet have their two colours (see
  // `shadeLabels`). The packets of a visual do not move, so this is done
  // once, in the first `draw` in which the plant has a size on the page.
  let labelsShaded = false;

  const draw = () => {
    const scale = view.z * CAMERA_SCALE;
    applyFraming(world, view.cx, view.cy, scale);
    placeVeil(scale);
    if (!labelsShaded) labelsShaded = shadeLabels(m);
    if (notesStale && notes.length) placeNotes();
    placeNoteCard(scale);
    liftSvg.replaceChildren();
    liftHtml.replaceChildren();
    const focus = selected || hovered;
    veil.style.opacity = focus ? 0.6 : 0;
    if (selected) liftCopies(nodeById[selected], 'cj-selected');
    if (hovered && hovered !== selected)
      liftCopies(nodeById[hovered], 'cj-hover');
    m.bubbleEls.forEach((el, i) => {
      const open = i === openMarker;
      el.style.opacity = open ? 1 : 0;
      el.style.pointerEvents = open ? 'auto' : 'none';
      if (open)
        clampBubble(el, bubbleSizes[i], { cx: view.cx, cy: view.cy, z: scale });
      else el.style.transform = '';
    });
    markerEls.forEach((el, i) => {
      el.classList.toggle('open', i === openMarker);
    });
  };

  const setLayers = (on) => {
    nodes.forEach((entry) => {
      entry.inside = null;
    });
    Object.keys(layerEls).forEach((layer) => {
      if (on && on[layer] != null) layerOn[layer] = !!on[layer];
      layerEls[layer].forEach((el) =>
        el.classList.toggle('cj-layer-off', !layerOn[layer]),
      );
    });
    // A layer that is switched off hides its packets, and a label that was
    // over one of them gets its own colour back.
    labelsShaded = shadeLabels(m);
    // A node of a layer that is switched off is hidden, and so is its note.
    if (notes.length) placeNotes();
  };

  // Functions that other parts of the runtime add to be told what the viewer
  // does. Every function in `hooks.select` is called with the id of the node
  // that was selected, or null. The step-through adds one, to show that node
  // in its panel. A view may also have its own `onSelect`, which gets the
  // handle this function returns and the id.
  //
  // Every function in `hooks.open` is called with the id of a node when the
  // viewer clicks that node twice within DOUBLE_CLICK milliseconds. A map
  // adds one, to go into the node. The second click is recognised here and
  // not by the browser's own double-click event: the first click redraws
  // the highlight under the pointer, and one browser engine then no longer
  // reports the two clicks as a double-click.
  const hooks = { select: [], open: [] };
  const DOUBLE_CLICK = 450;
  let lastClick = { id: null, at: 0 };
  let handle = null;
  const select = (id, silent) => {
    selected = id && nodeById[id] ? id : null;
    draw();
    hooks.select.forEach((told) => told(selected));
    if (visual.onSelect && handle) visual.onSelect(handle, selected);
    if (!silent) post({ cj: 'selected', nodeId: selected });
  };

  const fit = () => {
    view.cx = home.cx;
    view.cy = home.cy;
    view.z = home.z;
    draw();
  };

  // The factor between page pixels and stage pixels, which changes when the
  // window is resized.
  const stageScale = () => stage.getBoundingClientRect().width / STAGE_W || 1;

  const zoomAt = (factor, pageX, pageY) => {
    const k = stageScale();
    const rect = m.view.getBoundingClientRect();
    const vx = (pageX - rect.left) / k;
    const vy = (pageY - rect.top) / k;
    const before = view.z * CAMERA_SCALE;
    const wx = view.cx + (vx - VIEW_CX) / before;
    const wy = view.cy + (vy - VIEW_CY) / before;
    view.z = Math.min(3, Math.max(leastZoom, view.z * factor));
    const after = view.z * CAMERA_SCALE;
    view.cx = insideX(wx - (vx - VIEW_CX) / after);
    view.cy = insideY(wy - (vy - VIEW_CY) / after);
    draw();
  };

  // The id of the node at a page position, or null. Smaller parts are often
  // drawn on top of the machine they belong to (a gear on a gate, stamps in a
  // processor), so the topmost element is not enough: this looks down through
  // everything stacked at that position for the first element that belongs to a
  // node.
  const nodeAt = (pageX, pageY) => {
    const stack = document.elementsFromPoint(pageX, pageY);
    for (const el of stack) {
      if (!world.contains(el)) continue;
      const owner = el.closest('[data-node]');
      if (owner) return owner.getAttribute('data-node');
    }
    return null;
  };

  let drag = null;
  m.view.addEventListener('pointerdown', (ev) => {
    drag = {
      x: ev.clientX,
      y: ev.clientY,
      cx: view.cx,
      cy: view.cy,
      moved: false,
    };
    m.view.setPointerCapture(ev.pointerId);
  });
  m.view.addEventListener('pointermove', (ev) => {
    if (drag) {
      const k = stageScale() * view.z * CAMERA_SCALE;
      const dx = ev.clientX - drag.x;
      const dy = ev.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) {
        view.cx = insideX(drag.cx - dx / k);
        view.cy = insideY(drag.cy - dy / k);
        draw();
      }
      return;
    }
    const id = nodeAt(ev.clientX, ev.clientY);
    if (id !== hovered) {
      hovered = id;
      draw();
      post({ cj: 'hover', nodeId: hovered });
    }
    if (hovered) {
      const node = nodeById[hovered].node;
      const k = stageScale();
      const rect = m.view.getBoundingClientRect();
      tip.innerHTML =
        '<b>' +
        CJ.esc(node.label) +
        '</b><span>' +
        CJ.esc(node.role || '') +
        '</span>';
      tip.style.left =
        Math.min(VIEW_W - 460, (ev.clientX - rect.left) / k + 18) + 'px';
      tip.style.top =
        Math.min(VIEW_H - 120, (ev.clientY - rect.top) / k + 18) + 'px';
      tip.style.opacity = 1;
    } else {
      tip.style.opacity = 0;
    }
  });
  m.view.addEventListener('pointerup', (ev) => {
    const wasDrag = drag && drag.moved;
    drag = null;
    if (wasDrag) return;
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    // A click on the mark of a note shows its text, or hides it if it is
    // showing. The app is told, so that it can show the answer the note
    // comes from.
    const note = notes.find((one) => one.el === under);
    if (note) {
      openMarker = -1;
      setOpenNote(openNote === note.note.id ? null : note.note.id);
      draw();
      post({ cj: 'note', id: note.note.id, open: openNote !== null });
      return;
    }
    const markerIndex = markerEls.indexOf(under);
    if (markerIndex >= 0) {
      openNote = null;
      openMarker = openMarker === markerIndex ? -1 : markerIndex;
      if (openMarker >= 0) placeBubble(openMarker);
      // A "?" marker belongs to a node, so opening it also selects the node.
      // The app then shows the same rationale in its inspector.
      const owner = markers[markerIndex].why;
      if (owner && openMarker >= 0) select(owner);
      else draw();
      return;
    }
    if (under && under.closest && under.closest('.bub, .cj-note-card')) return;
    openMarker = -1;
    openNote = null;
    const id = nodeAt(ev.clientX, ev.clientY);
    const now = performance.now();
    const twice =
      !!id && id === lastClick.id && now - lastClick.at < DOUBLE_CLICK;
    lastClick = { id: twice ? null : id, at: now };
    if (twice && hooks.open.length) hooks.open.forEach((told) => told(id));
    else select(id);
  });
  m.view.addEventListener('pointerleave', () => {
    if (hovered) {
      hovered = null;
      draw();
      post({ cj: 'hover', nodeId: null });
    }
    tip.style.opacity = 0;
  });
  // The wheel and the trackpad.
  //   - A wheel event with neither Control nor Command held pans. A trackpad
  //     and a Magic Mouse report movement on both axes, so they pan in every
  //     direction. A plain mouse wheel pans up and down, and sideways while
  //     Shift is held.
  //   - A wheel event with Control or Command held zooms at the pointer.
  //
  // Each wheel event is handled by the keys held when it arrives. So
  // pressing or releasing Control or Command in the middle of a scroll
  // changes between panning and zooming at once. A trackpad keeps sending
  // wheel events for a moment after the fingers are lifted, and those events
  // follow the keys in the same way.
  //
  // A pinch on a trackpad zooms too. A browser reports it in one of two ways.
  //   - Chromium and Firefox report a pinch as wheel events with `ctrlKey`
  //     set, although no key is held. `deltaY` of such an event is about 100
  //     times the logarithm of the change in scale, which is far less than
  //     one notch of a mouse wheel.
  //   - WebKit on macOS reports a pinch as `gesturestart`, `gesturechange`
  //     and `gestureend` events and sends no wheel events for it. It is the
  //     only engine that defines `GestureEvent`, so `pinchIsWheel` is false
  //     there and true in the other engines.
  // A wheel event zooms by the factor e to the power of `-deltaY` times
  // WHEEL_ZOOM. One notch of a mouse wheel reports about 100, which zooms by
  // about 16 percent.
  const WHEEL_ZOOM = 0.0015;
  // Where a pinch arrives as wheel events, a wheel event with only `ctrlKey`
  // set may come from a pinch or from a wheel turned with Control held. The
  // two cannot be told apart, so both zoom by e to the power of `-deltaY`
  // times PINCH_ZOOM, which makes the drawing follow the fingers of a pinch.
  // `deltaY` is first limited to the range from -PINCH_MOST to PINCH_MOST.
  // With that limit, one notch of a mouse wheel zooms by the same 16 percent
  // as it does with WHEEL_ZOOM.
  const PINCH_ZOOM = 0.01;
  const PINCH_MOST = 15;
  const pinchIsWheel = typeof GestureEvent === 'undefined';
  // Wheel movement in pixels. Firefox reports a mouse wheel in lines
  // (`deltaMode` 1), three to a notch, and other browsers report about 100
  // pixels for the same notch. `deltaMode` 2 counts in pages.
  const wheelPixels = (ev, delta) =>
    delta * (ev.deltaMode === 1 ? 33 : ev.deltaMode === 2 ? VIEW_H : 1);
  m.view.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      let dx = wheelPixels(ev, ev.deltaX);
      let dy = wheelPixels(ev, ev.deltaY);
      if (ev.ctrlKey || ev.metaKey) {
        const mayBePinch = pinchIsWheel && ev.ctrlKey && !ev.metaKey;
        const factor = mayBePinch
          ? Math.exp(
              -Math.min(PINCH_MOST, Math.max(-PINCH_MOST, dy)) * PINCH_ZOOM,
            )
          : Math.exp(-dy * WHEEL_ZOOM);
        zoomAt(factor, ev.clientX, ev.clientY);
        return;
      }
      // With Shift held the view only moves sideways, by the larger of the
      // two movements. macOS already reports a mouse wheel turned with Shift
      // as sideways movement, and other systems report it as vertical.
      if (ev.shiftKey) {
        dx = Math.abs(dx) > Math.abs(dy) ? dx : dy;
        dy = 0;
      }
      const k = stageScale() * view.z * CAMERA_SCALE;
      view.cx = insideX(view.cx + dx / k);
      view.cy = insideY(view.cy + dy / k);
      draw();
    },
    { passive: false },
  );
  // `scale` of a gesture event is the change in scale since the pinch began.
  // `pinchScale` is the value the event before had, so each event zooms by
  // the change since that event.
  let pinchScale = 1;
  m.view.addEventListener('gesturestart', (ev) => {
    ev.preventDefault();
    pinchScale = 1;
  });
  m.view.addEventListener('gesturechange', (ev) => {
    ev.preventDefault();
    if (!(ev.scale > 0)) return;
    zoomAt(ev.scale / pinchScale, ev.clientX, ev.clientY);
    pinchScale = ev.scale;
  });
  m.view.addEventListener('gestureend', (ev) => ev.preventDefault());

  // The legend card is hidden until the viewer asks for it, from the control
  // bar of a standalone visual or from the app.
  let legend = null;
  if (Array.isArray(visual.legend) && visual.legend.length) {
    legend = elementFromHtml(legendMarkup({ legend: visual.legend }));
    legend.style.display = 'none';
    m.ground.append(legend);
  }

  draw();

  handle = {
    kind: 'visual',
    visual,
    box,
    mounted: m,
    view,
    nodes,
    markers,
    hooks,
    draw,
    fit,
    nodeAt,
    // Makes the box `bounds` (`[x, y, width, height]`) the default framing,
    // which Fit returns to, and shows it.
    fitTo(bounds) {
      Object.assign(home, cameraFor(bounds));
      fit();
    },
    // Forgets which node the pointer is over. A map calls it when it shows
    // another level, because the node under the pointer is then hidden and
    // must not stay highlighted.
    clearHover() {
      hovered = null;
      tip.style.opacity = 0;
      draw();
    },
    // Moves the camera to the world point `cx, cy` without changing the
    // zoom.
    panTo(cx, cy) {
      view.cx = insideX(cx);
      view.cy = insideY(cy);
      draw();
    },
    select,
    setLayers,
    layers: () => Object.assign({}, layerOn),
    hasLegend: !!legend,
    // Shows or hides the legend card. Called with no argument it switches the
    // card over.
    setLegend(on) {
      if (!legend) return false;
      const show = on == null ? legend.style.display === 'none' : !!on;
      legend.style.display = show ? '' : 'none';
      return show;
    },
    hasRationale: whyNodes.length > 0,
    // Shows or hides the "?" markers of the nodes that have a rationale.
    // Called with no argument it switches them over. Hiding them also closes
    // the bubble of such a marker if it is open. Returns whether they are
    // shown.
    setRationale(on) {
      rationaleOn = on == null ? !rationaleOn : !!on;
      markers.forEach((marker, i) => {
        if (marker.why)
          markerEls[i].classList.toggle('cj-layer-off', !rationaleOn);
      });
      if (!rationaleOn && openMarker >= 0 && markers[openMarker].why) {
        openMarker = -1;
        draw();
      }
      return rationaleOn;
    },
    // Replaces the notes on the visual. `list` holds the notes, each as
    // `{ id, n, part, kind, text }`: `n` is the number its mark shows, `part`
    // the id of the node it is on, and `kind` one of `note`, `flag` and
    // `emphasis`. A note whose `part` is not the id of a node is left out.
    // With `on` false the notes are kept and their marks are hidden. Returns
    // how many notes the visual has now.
    setNotes(list, on) {
      notes.forEach((one) => {
        one.el.remove();
        if (one.ring) one.ring.remove();
      });
      notesOn = on !== false;
      notes = [];
      (list || []).forEach((note, i) => {
        const entry = nodeById[note.part];
        if (!entry || !entry.els.length) return;
        const kind =
          note.kind === 'flag' || note.kind === 'emphasis' ? note.kind : 'note';
        const n = note.n == null ? i + 1 : note.n;
        const el = elementFromHtml(
          '<div class="cj-marker cj-note cj-' +
            kind +
            '">' +
            CJ.esc(n) +
            '</div>',
        );
        const ring =
          kind === 'emphasis'
            ? elementFromHtml('<div class="cj-note-ring"></div>')
            : null;
        if (ring) m.dimmer.before(ring);
        m.dimmer.before(el);
        notes.push({
          note: {
            id: String(note.id),
            n,
            kind,
            text: String(note.text == null ? '' : note.text),
          },
          entry,
          el,
          ring,
          x: 0,
          y: 0,
          shown: false,
        });
      });
      setOpenNote(openNote);
      placeNotes();
      draw();
      return notes.length;
    },
    // Shows the text of the note with the id `id`, and moves the camera to
    // the note's mark when the mark is outside the view. With null, or an id
    // no note has, the open note is closed.
    showNote(id) {
      openMarker = -1;
      setOpenNote(id);
      const open = notes.find((one) => one.note.id === openNote);
      if (open && open.shown) {
        const scale = view.z * CAMERA_SCALE;
        const outside =
          Math.abs(open.x - view.cx) > (VIEW_CX - 60) / scale ||
          Math.abs(open.y - view.cy) > (VIEW_CY - 60) / scale;
        if (outside) {
          view.cx = insideX(open.x);
          view.cy = insideY(open.y);
        }
      }
      draw();
    },
    // Places the marks of the notes again. Code that moves, shows or hides
    // nodes after the visual was built calls it: a map when it shows another
    // level, and a step-through when it draws a step.
    notesMoved() {
      if (!notes.length) return;
      placeNotes();
      draw();
    },
    zoomBy(factor) {
      const rect = m.view.getBoundingClientRect();
      zoomAt(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
    },
    // Opens one marker's bubble, or closes all with -1. The self-test uses it
    // to check each bubble.
    openMarker(i) {
      openMarker = i;
      if (i >= 0) placeBubble(i);
      draw();
    },
  };
  return handle;
};
