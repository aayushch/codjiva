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
| `nodes` | The clickable parts: `{ id, label, role, refs: [{ path, line }], select: [names] }`. `select` lists the unprefixed names of the elements that highlight together; give each clickable machine one wrapping element. Whatever is drawn inside a selected element, such as the labels on a machine, is highlighted with it. A plate inside a machine can be a node of its own: a click on it selects it, and a click beside it selects the machine. |
| `layers` | `{ data: [...], control: [...], errors: [...], labels: [...] }`. Each entry is an unprefixed element name, a name ending in `*` (matches `pipe1`, `pipe2`, ...), or a class selector starting with `.` (such as `.pl` and `.plt` for all labels and plates). |
| `markers` | 3 to 8 points of interest: `{ x, y, n, bubble: { kicker, html, tail, alarm } }`. `n` is the number shown, in reading order along the flow. Clicking a marker opens its bubble beside it. |
| `legend` | Optional rows `{ kind, html }`, one per packet kind used. |

A node may also have a `rationale`: why the code does what the node stands for (see Rationale).
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
    el.classList.contains('cj-marker') ||
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

  const draw = () => {
    const scale = view.z * CAMERA_SCALE;
    applyFraming(world, view.cx, view.cy, scale);
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
  };

  const select = (id, silent) => {
    selected = id && nodeById[id] ? id : null;
    draw();
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
    view.z = Math.min(3, Math.max(0.5, view.z * factor));
    const after = view.z * CAMERA_SCALE;
    view.cx = Math.min(STAGE_W, Math.max(0, wx - (vx - VIEW_CX) / after));
    view.cy = Math.min(STAGE_H, Math.max(0, wy - (vy - VIEW_CY) / after));
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
        view.cx = Math.min(STAGE_W, Math.max(0, drag.cx - dx / k));
        view.cy = Math.min(STAGE_H, Math.max(0, drag.cy - dy / k));
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
    const markerIndex = markerEls.indexOf(under);
    if (markerIndex >= 0) {
      openMarker = openMarker === markerIndex ? -1 : markerIndex;
      if (openMarker >= 0) placeBubble(openMarker);
      // A "?" marker belongs to a node, so opening it also selects the node.
      // The app then shows the same rationale in its inspector.
      const owner = markers[markerIndex].why;
      if (owner && openMarker >= 0) select(owner);
      else draw();
      return;
    }
    if (under && under.closest && under.closest('.bub')) return;
    openMarker = -1;
    select(nodeAt(ev.clientX, ev.clientY));
  });
  m.view.addEventListener('pointerleave', () => {
    if (hovered) {
      hovered = null;
      draw();
      post({ cj: 'hover', nodeId: null });
    }
    tip.style.opacity = 0;
  });
  m.view.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      zoomAt(Math.exp(-ev.deltaY * 0.0015), ev.clientX, ev.clientY);
    },
    { passive: false },
  );

  // The legend card is hidden until the viewer asks for it, from the control
  // bar of a standalone visual or from the app.
  let legend = null;
  if (Array.isArray(visual.legend) && visual.legend.length) {
    legend = elementFromHtml(legendMarkup({ legend: visual.legend }));
    legend.style.display = 'none';
    m.ground.append(legend);
  }

  draw();

  return {
    kind: 'visual',
    visual,
    box,
    mounted: m,
    view,
    nodes,
    markers,
    draw,
    fit,
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
};
