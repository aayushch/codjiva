// The self-test: checks a built artifact from inside the page and returns a
// report.
//
// The Codjiva app runs it in a hidden frame before it shows an artifact. Every
// issue names the exact elements involved and where they are, so the agent that
// receives the report can fix those elements and nothing else.
//
// Films are sampled per scene at the start, at the end, every half second of
// real time, and at the middle of every bubble's time on screen.

const SAMPLE_STEP = 0.5;

// Classes the runtime's own styles define. Agent markup may use them without a
// prefix.
const RUNTIME_CLASSES = {
  art: 1,
  grid: 1,
  border: 1,
  pl: 1,
  plt: 1,
  bub: 1,
  k: 1,
  alarm: 1,
  tag: 1,
  note: 1,
  hot: 1,
  cool: 1,
  dim: 1,
  words: 1,
  sub: 1,
  line: 1,
  hud: 1,
  view: 1,
  world: 1,
  ground: 1,
  dimmer: 1,
  'tail-u': 1,
  'tail-d': 1,
  'tail-l': 1,
  'tail-r': 1,
};

// Tags that only style a run of text inside a label and never form a label of
// their own.
const INLINE_TEXT_TAGS = {
  CODE: 1,
  B: 1,
  I: 1,
  EM: 1,
  STRONG: 1,
  SPAN: 1,
  BR: 1,
};

const selfTest = async (env, opts) => {
  const stage = env.stage;
  const issues = [];
  const seen = {};
  const stats = { nodes: {}, renderMs: {}, samples: 0 };

  // Adds an issue once. A repeat of the same check on the same elements in the
  // same scene only raises the count of the first one, so a problem that lasts
  // ten seconds is reported once.
  const report = (issue) => {
    const key = [
      issue.check,
      issue.scene || '',
      issue.a ? issue.a.selector : '',
      issue.b ? issue.b.selector : '',
      issue.key || '',
    ].join('|');
    delete issue.key;
    if (seen[key]) {
      seen[key].count++;
      return;
    }
    issue.count = 1;
    seen[key] = issue;
    issues.push(issue);
  };

  // ---- measuring
  // -------------------------------------------------------------------------
  let stageRect = stage.getBoundingClientRect();
  let stageScale = stageRect.width / STAGE_W || 1;
  const remeasureStage = () => {
    stageRect = stage.getBoundingClientRect();
    stageScale = stageRect.width / STAGE_W || 1;
  };

  // An element's box in stage pixels: [x, y, width, height], rounded to one
  // decimal.
  const boxOf = (el) => {
    const r = el.getBoundingClientRect();
    const f = (v) => Math.round(v * 10) / 10;
    return [
      f((r.left - stageRect.left) / stageScale),
      f((r.top - stageRect.top) / stageScale),
      f(r.width / stageScale),
      f(r.height / stageScale),
    ];
  };
  const overlap = (a, b) => [
    Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]),
    Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]),
  ];
  const inside = (inner, outer, slack) =>
    inner[0] >= outer[0] - slack &&
    inner[1] >= outer[1] - slack &&
    inner[0] + inner[2] <= outer[0] + outer[2] + slack &&
    inner[1] + inner[3] <= outer[1] + outer[3] + slack;

  // The product of the opacities of an element and its ancestors up to the
  // scene box, or 0 when any of them is not displayed. `cache` holds results
  // for one sample.
  const visibility = (el, box, cache) => {
    if (el === box || !el) return 1;
    if (cache.has(el)) return cache.get(el);
    const style = getComputedStyle(el);
    const own =
      style.display === 'none' || style.visibility === 'hidden'
        ? 0
        : Number(style.opacity);
    const value = own <= 0 ? 0 : own * visibility(el.parentElement, box, cache);
    cache.set(el, value);
    return value;
  };

  // A short CSS selector that names an element for the agent: its prefixed
  // class when it has one, otherwise its runtime class and position among its
  // siblings.
  const selectorOf = (el, prefix) => {
    const classes = (el.getAttribute('class') || '')
      .split(/\s+/)
      .filter(Boolean);
    const own = classes.find((c) => c.indexOf(prefix + '-') === 0);
    if (own) return '.' + own;
    const index = el.parentElement
      ? Array.from(el.parentElement.children).indexOf(el) + 1
      : 1;
    return (
      el.tagName.toLowerCase() +
      (classes.length ? '.' + classes[0] : '') +
      ':nth-child(' +
      index +
      ')'
    );
  };
  const describe = (el, prefix) => ({
    selector: selectorOf(el, prefix),
    text: (el.textContent || '').trim().slice(0, 60),
    box: boxOf(el),
  });

  // The box of the words inside an element, in stage pixels, measured from the
  // text itself.
  const range = document.createRange();
  //
  // A bubble with a rationale ends with a chip, which lies on the bubble's top
  // edge on purpose, and with the rationale itself, which is hidden. The words
  // of such a bubble are measured up to the chip.
  const textBoxOf = (el) => {
    range.selectNodeContents(el);
    const chip = el.querySelector(':scope > .cj-why-chip');
    if (chip) range.setEndBefore(chip);
    const r = range.getBoundingClientRect();
    const f = (v) => Math.round(v * 10) / 10;
    return [
      f((r.left - stageRect.left) / stageScale),
      f((r.top - stageRect.top) / stageScale),
      f(r.width / stageScale),
      f(r.height / stageScale),
    ];
  };

  // The area a label visibly covers. A label with a background or border, such
  // as a name plate, covers its whole box. A bare label covers only its words:
  // a block element such as the title is as wide as its container, far wider
  // than what the viewer sees.
  const labelBox = (el) => {
    const box = boxOf(el);
    const style = getComputedStyle(el);
    const boxed =
      style.borderTopWidth !== '0px' ||
      !/^rgba\(0, 0, 0, 0\)$|^transparent$/.test(style.backgroundColor);
    if (boxed) return box;
    const words = textBoxOf(el);
    const left = Math.max(box[0], words[0]);
    const right = Math.min(box[0] + box[2], words[0] + words[2]);
    return [left, box[1], Math.max(0, right - left), box[3]];
  };

  // How far an element's words reach outside its own box, in stage pixels:
  // [sideways, up or down].
  const spill = (el) => {
    const box = boxOf(el);
    const words = textBoxOf(el);
    if (words[2] <= 0) return [0, 0];
    const sideways = Math.max(
      box[0] - words[0],
      words[0] + words[2] - (box[0] + box[2]),
      0,
    );
    const vertical = Math.max(
      box[1] - words[1],
      words[1] + words[3] - (box[1] + box[3]),
      0,
    );
    return [sideways, vertical];
  };
  // Words overflow when they reach past the side of their box, or past its top
  // or bottom by more than a third of a line. A font's line is taller than its
  // letters, so a snug single-line box is always a little shorter than the line
  // and that alone is not an overflow.
  const overflows = (el) => {
    const s = spill(el);
    const box = boxOf(el);
    const scale = el.offsetHeight ? box[3] / el.offsetHeight : 1;
    const fontSize = parseFloat(getComputedStyle(el).fontSize) * scale;
    return s[0] > 1.5 || s[1] > fontSize * 0.34;
  };

  // The labels of a scene: every HTML element that directly holds words. Text
  // inside an inline tag such as <code> counts for the nearest ancestor that is
  // not inline. Bubbles are checked separately and are not labels.
  const labelsIn = (box) => {
    const found = new Set();
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.nodeValue.trim()) continue;
      let el = node.parentElement;
      if (!el || el instanceof SVGElement) continue;
      while (
        el &&
        INLINE_TEXT_TAGS[el.tagName] &&
        el.parentElement &&
        el.parentElement !== box
      )
        el = el.parentElement;
      // The inside of a pipeline's bay is a part that was checked as its own
      // artifact, drawn here at a reduced scale, so its labels are not checked
      // again.
      if (
        !el ||
        el.closest('.bub') ||
        el.closest('.cj-tip') ||
        el.closest('.cj-bay')
      )
        continue;
      found.add(el);
    }
    return Array.from(found);
  };

  const parseColor = (text) => {
    const m = /^rgba?\(([^)]+)\)/.exec(text);
    if (m) {
      const p = m[1].split(/[,\s/]+/).map(Number);
      return [p[0], p[1], p[2]];
    }
    const c = /^color\(srgb ([^)]+)\)/.exec(text);
    if (c) {
      const p = c[1].split(/[\s/]+/).map(Number);
      return [p[0] * 255, p[1] * 255, p[2] * 255];
    }
    return null;
  };
  const luminance = (rgb) => {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  };
  const groundColor = parseColor(getComputedStyle(stage).backgroundColor) || [
    20, 24, 31,
  ];
  const contrastOnGround = (rgb) => {
    const a = luminance(rgb);
    const b = luminance(groundColor);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };

  // Where each packet was at the previous sample, for the packet size check.
  const packetBoxes = new Map();

  // ---- checks that look at one drawn frame
  // ------------------------------------------------- box: the scene box.
  // prefix: its class prefix. t: film time, for the report. holding: true when
  // the camera is not moving, which is when framing rules apply.
  const checkFrame = (box, prefix, sceneId, t, holding) => {
    const cache = new Map();
    const view = box.querySelector('.view');
    const viewBox = boxOf(view);
    const labels = labelsIn(box)
      .map((el) => ({
        el,
        vis: visibility(el, box, cache),
        box: labelBox(el),
        inWorld: !!el.closest('.world'),
      }))
      .filter((l) => l.vis > 0.5 && l.box[2] > 0 && l.box[3] > 0)
      .filter(
        (l) =>
          !l.inWorld ||
          (overlap(l.box, viewBox)[0] > 0 && overlap(l.box, viewBox)[1] > 0),
      );

    // 4. Text overlap: label against label.
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const a = labels[i];
        const b = labels[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        const o = overlap(a.box, b.box);
        if (o[0] > 2 && o[1] > 2) {
          report({
            check: 'text-overlap',
            severity: 'error',
            scene: sceneId,
            t,
            a: describe(a.el, prefix),
            b: describe(b.el, prefix),
            hint: 'These two labels overlap. Move or shorten one of them. Fix only these two elements.',
          });
        }
      }
    }
    // 4. Text overlap: label against a machine it is neither inside nor clear
    //    of.
    const machines = Array.from(
      box.querySelectorAll('.world [data-cj="machine"]'),
    )
      .filter(
        (el) =>
          visibility(el, box, cache) > 0.5 &&
          !el.closest('.cj-lift') &&
          !el.closest('.cj-bay'),
      )
      .map((el) => ({ el, box: boxOf(el.children[1] || el) }));
    labels.forEach((label) => {
      // A numbered marker is meant to sit on the edge or corner of the part it
      // points at.
      if (!label.inWorld || label.el.classList.contains('cj-marker')) return;
      machines.forEach((machine) => {
        const o = overlap(label.box, machine.box);
        if (o[0] > 2 && o[1] > 2 && !inside(label.box, machine.box, 1)) {
          report({
            check: 'text-overlap',
            severity: 'error',
            scene: sceneId,
            t,
            a: describe(label.el, prefix),
            b: describe(machine.el, prefix),
            hint: 'This label crosses the edge of a machine. Put it fully inside the machine or fully clear of it. Fix only this label.',
          });
        }
      });
    });

    // 5. Text overflow: words that spill out of their own box.
    labels.forEach((label) => {
      const el = label.el;
      if (overflows(el)) {
        report({
          check: 'text-overflow',
          severity: 'error',
          scene: sceneId,
          t,
          a: describe(el, prefix),
          hint: 'The text is larger than its box. Shorten the text or widen the box. Fix only this element.',
        });
      }
    });

    // 6 and 7. Bubbles: inside the view with a margin, and one at a time.
    const bubbles = Array.from(box.querySelectorAll('.bub')).filter(
      (el) => visibility(el, box, cache) > 0.05,
    );
    if (bubbles.length > 1) {
      report({
        check: 'one-bubble',
        severity: 'error',
        scene: sceneId,
        t,
        a: describe(bubbles[0], prefix),
        b: describe(bubbles[1], prefix),
        hint: 'Two bubbles are visible at once. Give them later "at" times or shorter text.',
      });
    }
    bubbles.forEach((el) => {
      const b = boxOf(el);
      const safe = [
        viewBox[0] + BUBBLE_MARGIN,
        viewBox[1] + BUBBLE_MARGIN,
        viewBox[2] - 2 * BUBBLE_MARGIN,
        viewBox[3] - 2 * BUBBLE_MARGIN,
      ];
      if (!inside(b, safe, 1.5)) {
        report({
          check: 'bubble-bounds',
          severity: 'error',
          scene: sceneId,
          t,
          a: describe(el, prefix),
          hint: 'This bubble does not fit inside the view at this zoom. Shorten its text or lower maxWidth.',
        });
      }
      if (overflows(el)) {
        report({
          check: 'text-overflow',
          severity: 'error',
          scene: sceneId,
          t,
          a: describe(el, prefix),
          hint: "The bubble's text spills out of it. Shorten the text, or shorten the longest code chip.",
        });
      }
    });

    // 8. Title band: nothing the agent drew may lie in the band, and no label
    //    may be cut by it.
    box.querySelectorAll('.ground > *').forEach((el) => {
      const cls = el.getAttribute('class') || '';
      if (/(^|\s)(view|hud|cj-[a-z-]+)(\s|$)/.test(cls)) return;
      const b = boxOf(el);
      if (
        b[2] > 0 &&
        b[3] > 0 &&
        b[1] < HUD_H &&
        visibility(el, box, cache) > 0.5
      ) {
        report({
          check: 'hud-clearance',
          severity: 'error',
          scene: sceneId,
          t,
          a: describe(el, prefix),
          hint: 'This element sits in the title band. Draw everything inside the plant.',
        });
      }
    });
    if (holding) {
      labels.forEach((label) => {
        if (
          label.inWorld &&
          label.box[1] < viewBox[1] - 2 &&
          label.box[1] + label.box[3] > viewBox[1] + 2
        ) {
          report({
            check: 'hud-clearance',
            severity: 'warning',
            scene: sceneId,
            t,
            a: describe(label.el, prefix),
            hint: 'This label is cut off by the title band at this framing. Move the camera down a little or zoom out.',
          });
        }
      });
    }

    // 9. Packets of one kind must be one size. Only packets that have not moved
    //    since the last
    // sample are compared, because a packet may shrink or grow briefly while it
    // enters or leaves.
    const sizes = {};
    box.querySelectorAll('.world [data-cj="packet"]').forEach((el) => {
      if (
        el.closest('.cj-legend') ||
        el.closest('.cj-lift') ||
        el.closest('.cj-bay')
      )
        return;
      const b = boxOf(el.firstElementChild || el);
      const last = packetBoxes.get(el);
      packetBoxes.set(el, b);
      if (visibility(el, box, cache) < 0.5 || b[2] <= 0) return;
      const still =
        last &&
        Math.abs(last[0] - b[0]) < 0.5 &&
        Math.abs(last[1] - b[1]) < 0.5 &&
        Math.abs(last[2] - b[2]) < 0.5;
      if (!still) return;
      const kind = el.getAttribute('data-kind');
      (sizes[kind] = sizes[kind] || []).push({ el, w: b[2] });
    });
    Object.keys(sizes).forEach((kind) => {
      const list = sizes[kind].sort((a, b) => a.w - b.w);
      const small = list[0];
      const large = list[list.length - 1];
      if (large.w > small.w * 1.15) {
        report({
          check: 'packet-size',
          severity: 'warning',
          scene: sceneId,
          t,
          key: kind,
          a: describe(small.el, prefix),
          b: describe(large.el, prefix),
          hint:
            'Packets of kind "' +
            kind +
            '" are drawn at different sizes. Keep every packet at scale 1 except while it enters or leaves.',
        });
      }
    });

    // 13 and 14. Font and contrast.
    labels.forEach((label) => {
      const style = getComputedStyle(label.el);
      if (!/^\s*["']?JetBrains Mono/.test(style.fontFamily)) {
        report({
          check: 'font',
          severity: 'warning',
          scene: sceneId,
          t,
          a: describe(label.el, prefix),
          hint: 'This text is not set in the stage font. Remove the font-family override.',
        });
      }
      const rgb = parseColor(style.color);
      // A dimmed label is dim on purpose, so contrast is only judged on text at
      // full strength.
      if (
        rgb &&
        label.vis > 0.9 &&
        !style.backgroundColor.match(/^rgba?\((?!0, 0, 0, 0)/) &&
        contrastOnGround(rgb) < 4.5
      ) {
        report({
          check: 'contrast',
          severity: 'warning',
          scene: sceneId,
          t,
          a: describe(label.el, prefix),
          hint: 'This text is hard to read against the background. Use var(--second) or var(--muted).',
        });
      }
    });
  };

  // 3. Class and id prefixes, and names used more than once.
  const checkNames = (box, prefix, sceneId, ids) => {
    const usedBy = {};
    box.querySelectorAll('[class], [id]').forEach((el) => {
      if (
        el.closest('.cj-legend') ||
        el.closest('.cj-lift') ||
        el.closest('.cj-lift-html')
      )
        return;
      (el.getAttribute('class') || '')
        .split(/\s+/)
        .filter(Boolean)
        .forEach((name) => {
          if (RUNTIME_CLASSES[name] || name.indexOf('cj-') === 0) return;
          if (name.indexOf(prefix + '-') !== 0) {
            report({
              check: 'prefix',
              severity: 'error',
              scene: sceneId,
              key: name,
              a: describe(el, prefix),
              hint:
                'The class "' +
                name +
                '" has no prefix. Build every class name with c(\'' +
                name +
                "').",
            });
            return;
          }
          (usedBy[name] = usedBy[name] || []).push(el);
        });
      const id = el.getAttribute('id');
      if (id) {
        if (id.indexOf(prefix + '-') !== 0) {
          report({
            check: 'prefix',
            severity: 'error',
            scene: sceneId,
            key: '#' + id,
            a: describe(el, prefix),
            hint:
              'The id "' +
              id +
              '" has no prefix. Build every id with c(\'' +
              id +
              "').",
          });
        } else if (ids[id] && ids[id] !== sceneId) {
          report({
            check: 'prefix',
            severity: 'error',
            scene: sceneId,
            key: '#' + id,
            a: describe(el, prefix),
            hint:
              'The id "' + id + '" is also used in scene "' + ids[id] + '".',
          });
        }
        ids[id] = sceneId;
      }
    });
    Object.keys(usedBy).forEach((name) => {
      if (usedBy[name].length > 1) {
        report({
          check: 'prefix',
          severity: 'error',
          scene: sceneId,
          key: name,
          a: describe(usedBy[name][0], prefix),
          b: describe(usedBy[name][1], prefix),
          hint:
            'The class "' +
            name +
            '" is on ' +
            usedBy[name].length +
            ' elements. Give each element its own name, for example ' +
            name.slice(prefix.length + 1) +
            '0 and ' +
            name.slice(prefix.length + 1) +
            '1.',
        });
      }
    });
  };

  // Compares two plant states. Numbers may differ by `slack`; arrays are
  // compared item by item.
  const sameState = (a, b, slack) => {
    if (typeof a === 'number' && typeof b === 'number')
      return Math.abs(a - b) <= slack;
    if (Array.isArray(a) && Array.isArray(b))
      return (
        a.length === b.length && a.every((v, i) => sameState(v, b[i], slack))
      );
    return a === b;
  };

  registry.loadErrors.forEach((e) => {
    report({
      check: 'exception',
      severity: 'error',
      key: e.file,
      message: e.file + ' failed while loading: ' + e.message,
      hint: 'Fix the error in ' + e.file + '.',
    });
  });

  // ---- still visuals
  // ---------------------------------------------------------------------
  if (env.visual) {
    const visual = env.visual;
    const box = visual.box;
    remeasureStage();
    visual.fit();
    visual.select(null, true);
    visual.openMarker(-1);
    stats.nodes.v = box.querySelectorAll('*').length;
    if (stats.nodes.v > 4000)
      report({
        check: 'element-budget',
        severity: 'warning',
        scene: 'v',
        message: stats.nodes.v + ' elements; the budget is 4000.',
        hint: 'Draw with fewer elements.',
      });
    checkNames(box, 'v', 'v', {});
    checkFrame(box, 'v', 'v', 0, true);
    visual.nodes.forEach((entry) => {
      if (!entry.els.length)
        report({
          check: 'visual-nodes',
          severity: 'error',
          scene: 'v',
          key: entry.node.id,
          message: 'Node "' + entry.node.id + '" selects no element.',
          hint: 'List in "select" the unprefixed class name of an element that plant.js draws.',
        });
    });
    visual.markers.forEach((marker, i) => {
      visual.openMarker(i);
      checkFrame(box, 'v', 'v', 0, true);
    });
    visual.openMarker(-1);
    stats.samples = 1 + visual.markers.length;
    const errors = issues.filter((i) => i.severity === 'error').length;
    return {
      ok: errors === 0,
      kind: 'visual',
      runtime: CJ.version,
      issues,
      stats,
    };
  }

  // ---- films
  // -----------------------------------------------------------------------------
  const film = env.film;
  const ids = {};
  const usedKinds = {};
  let previous = null;

  for (const scene of film.scenes) {
    const id = scene.meta.id;
    const box = scene.box;
    film.show(scene.index);
    remeasureStage();

    // 1. Exceptions raised while the scene was built.
    if (scene.error) {
      report({
        check: 'exception',
        severity: 'error',
        scene: id,
        t: scene.start,
        message: 'init() threw: ' + scene.error.message,
        hint: 'Fix the error in scenes/' + id + '.js.',
      });
    }
    if (!scene.mounted) {
      previous = null;
      continue;
    }

    const times = [0, scene.duration];
    for (let x = SAMPLE_STEP; x < scene.duration; x += SAMPLE_STEP)
      times.push(x);
    scene.bubbles.forEach((b, i) => {
      if (scene.warp.starts[i] != null)
        times.push(scene.warp.starts[i] + scene.holds[i] / 2);
    });
    times.sort((a, b) => a - b);

    const inHold = (x) =>
      scene.bubbles.some(
        (b, i) =>
          scene.warp.starts[i] != null &&
          x >= scene.warp.starts[i] &&
          x <= scene.warp.starts[i] + scene.holds[i],
      );
    const cameraHolding = (x) => {
      const t = scene.warp.tau(x);
      return !scene.keys
        .slice(1)
        .some((k) => t > k.t - 0.01 && t < k.t + k.dur + 0.01);
    };

    let idleSince = null;
    let lastMarkup = null;
    let startState = null;
    for (const x of times) {
      film.drawScene(scene, x);
      stats.samples++;
      // 1. Exceptions raised while drawing.
      if (scene.error && scene.error.phase === 'render') {
        report({
          check: 'exception',
          severity: 'error',
          scene: id,
          t: scene.error.t,
          message: 'render() threw: ' + scene.error.message,
          hint: 'Fix the error in scenes/' + id + '.js.',
        });
        break;
      }
      if (x === 0) startState = scene.lastState;
      checkFrame(
        box,
        id,
        id,
        Math.round((scene.start + x) * 100) / 100,
        cameraHolding(x),
      );
      // 11. Idle frames: nothing changes for more than three seconds outside a
      //     bubble.
      const markup = box.innerHTML;
      if (markup === lastMarkup && !inHold(x)) {
        if (idleSince == null) idleSince = x - SAMPLE_STEP;
        if (x - idleSince > 3)
          report({
            check: 'idle',
            severity: 'warning',
            scene: id,
            t: Math.round((scene.start + idleSince) * 100) / 100,
            message: 'Nothing moves for more than 3 seconds from here.',
            hint: 'Shorten the gap, or keep work moving through the plant.',
          });
      } else {
        idleSince = null;
      }
      lastMarkup = markup;
    }

    box.querySelectorAll('.world [data-cj="packet"]').forEach((el) => {
      if (!el.closest('.cj-legend'))
        usedKinds[el.getAttribute('data-kind')] = id;
    });

    if (scene.ready) {
      // 2. Determinism: drawing a, then b, then a again must give the same
      //    picture as the first a.
      const pairs = [
        [scene.duration * 0.25, scene.duration * 0.75],
        [scene.duration * 0.6, scene.duration * 0.05],
      ];
      scene.bubbles.forEach((b, i) => {
        if (i < 2 && scene.warp.starts[i] != null)
          pairs.push([scene.warp.starts[i] + scene.holds[i] / 2, 0]);
      });
      for (const [a, b] of pairs) {
        film.drawScene(scene, a);
        const first = box.innerHTML;
        film.drawScene(scene, b);
        film.drawScene(scene, a);
        if (box.innerHTML !== first) {
          report({
            check: 'determinism',
            severity: 'error',
            scene: id,
            t: Math.round((scene.start + a) * 100) / 100,
            message:
              'Drawing this moment after drawing ' +
              (scene.start + b).toFixed(1) +
              ' s gives a different picture than drawing it first.',
            hint: 'render(t) must set every property it ever changes on every call, from t alone. Do not keep state between calls.',
          });
          break;
        }
      }

      // 12. Element budget and render time.
      stats.nodes[id] = box.querySelectorAll('*').length;
      if (stats.nodes[id] > 4000)
        report({
          check: 'element-budget',
          severity: 'warning',
          scene: id,
          message: stats.nodes[id] + ' elements; the budget is 4000.',
          hint: 'Draw with fewer elements.',
        });
      const runs = [];
      for (let i = 0; i < 10; i++) {
        const begin = performance.now();
        film.drawScene(scene, scene.duration * (0.1 + 0.08 * i));
        runs.push(performance.now() - begin);
      }
      runs.sort((a, b) => a - b);
      stats.renderMs[id] = Math.round(runs[5] * 100) / 100;
      if (runs[5] > 8)
        report({
          check: 'element-budget',
          severity: 'warning',
          scene: id,
          message:
            'A frame takes ' +
            runs[5].toFixed(1) +
            ' ms to draw; the budget is 8 ms.',
          hint: 'Do less work in render(): cache element handles in init() and move fewer parts.',
        });
    }

    checkNames(box, id, id, ids);

    // 10. Chapter continuity: the camera and the plant state carry over from
    //     the last scene.
    if (scene.explicitOpening) {
      report({
        check: 'continuity',
        severity: 'error',
        scene: id,
        t: scene.start,
        message:
          'The camera opens on its own framing instead of the framing the previous scene ended on.',
        hint: 'Remove the camera key without "t" from this scene in film.json. Every scene after the first starts where the previous one ended.',
      });
    }
    if (previous && previous.endState && startState) {
      const skip = registry.plant.motionKeys || [];
      const keys = Object.keys(
        Object.assign({}, previous.endState, startState),
      ).filter((k) => skip.indexOf(k) < 0);
      const differing = keys.filter(
        (k) => !sameState(previous.endState[k], startState[k], 0.02),
      );
      if (differing.length) {
        const detail = differing
          .map(
            (k) =>
              k +
              ': ' +
              JSON.stringify(previous.endState[k]) +
              ' → ' +
              JSON.stringify(startState[k]),
          )
          .join('; ');
        report({
          check: 'continuity',
          severity: 'error',
          scene: id,
          t: scene.start,
          message:
            'The plant state jumps between the end of "' +
            previous.id +
            '" and the start of this scene (' +
            detail +
            ').',
          hint: "Make this scene's state at t = 0 equal the previous scene's final state, then ease to the new values.",
        });
      }
    }
    film.drawScene(scene, scene.duration);
    previous = { id, endState: scene.lastState };

    // Let the page breathe between scenes so a long film does not freeze its
    // frame.
    await new Promise((done) => setTimeout(done, 0));
  }

  // 15. Legend coverage.
  const listed = {};
  (env.data.film.legend || []).forEach((row) => {
    listed[row.kind] = 1;
  });
  Object.keys(usedKinds).forEach((kind) => {
    if (!listed[kind])
      report({
        check: 'legend',
        severity: 'warning',
        scene: usedKinds[kind],
        key: kind,
        message:
          'Packets of kind "' +
          kind +
          '" are used but the legend does not list them.',
        hint: 'Add a legend row for "' + kind + '" to film.json.',
      });
  });

  // 13. The stage font itself.
  if (document.fonts && !document.fonts.check('18px "JetBrains Mono"')) {
    report({
      check: 'font',
      severity: 'warning',
      message: 'The embedded font did not load.',
      hint: 'This is a build problem, not a problem in your sources.',
    });
  }

  const errors = issues.filter((i) => i.severity === 'error').length;
  return {
    ok: errors === 0,
    kind: 'film',
    runtime: CJ.version,
    duration: Math.round(film.duration * 100) / 100,
    chapters: film.chapters(),
    issues,
    stats,
  };
};
