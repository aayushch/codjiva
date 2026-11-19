// Boot and playback. The builder ends every artifact with one call to
// CJ.boot(data).
//
// An artifact runs in one of two ways:
//   - Standalone: opened as a file or exported. It draws its own control bar
//     and handles keys.
//   - Embedded: shown inside the Codjiva app in a sandboxed frame. It hides
//     its bar, and the app drives it with window messages. Embedded mode
//     starts when the URL has `?embed=1` or when the first `hello` message
//     arrives.
//
// With `?poster=1` as well, a film draws the single frame named by its `thumbT`
// and does not play. The app uses that for the small pictures in its library.
//
// An artifact is drawn in the dark palette unless it is told to use the light
// one. It is told by `?theme=light` in the URL, or by a `theme` message from
// the app. The page reports the palette in use in its `ready` message and after
// every `theme` message.

const ICONS = {
  play: '<svg class="i-play" viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z"/></svg>',
  pause:
    '<svg class="i-pause" viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>',
  soundOff:
    '<svg class="i-off" viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4zm12.6 3 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4z"/></svg>',
  soundOn:
    '<svg class="i-on" viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4zm11.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM13 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>',
  full: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5v2H6v3H4zm10-5h6v5h-2V6h-4V4zM4 15h2v3h3v2H4v-5zm14 3v-3h2v5h-5v-2h3z"/></svg>',
};

const FILM_CONTROLS =
  '<button id="play" data-state="paused" aria-label="Play" title="Play / pause (Space)">' +
  ICONS.play +
  ICONS.pause +
  '</button>' +
  '<div id="chapter"></div>' +
  '<div id="bar" title="Seek"><div id="fill"></div><div id="knob"></div></div>' +
  '<div id="time">0:00 / 0:00</div>' +
  '<button id="mute" data-state="muted" aria-label="Turn sound on" title="Sound (M)">' +
  ICONS.soundOff +
  ICONS.soundOn +
  '</button>' +
  '<button id="fs" aria-label="Full screen" title="Full screen (F)">' +
  ICONS.full +
  '</button>';

const formatTime = (x) => {
  const s = Math.max(0, x);
  return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
};

CJ.version = '1.4.0';

CJ.boot = async (data) => {
  const params = new URLSearchParams(window.location.search);
  let embedded = params.get('embed') === '1';
  const isFilm = !!data.film;
  // A pipeline's parts are placed by its pipeline.json, which the plant reads
  // through CJ.bay.
  registry.pipeline = data.pipeline || null;

  // The page: the stage in its frame, and the control bar below it. A
  // step-through also fills `stepbar`, above the frame, and `steppanel`, to
  // its right. Both take no room in any other artifact.
  document.body.innerHTML =
    '<div id="app"><div id="stepbar"></div><div id="row"><div id="frame"><div id="stage"></div><div id="loading">Loading…</div></div><div id="steppanel"></div></div><div id="controls"></div></div>';
  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const frame = $('frame');
  const controls = $('controls');
  const markEmbedded = () => {
    document.documentElement.classList.add('embed');
    document.body.classList.add('embed');
  };
  if (embedded) markEmbedded();
  // The style sheet holds both palettes. The attribute data-theme="light" on
  // the root element selects the light one, and without the attribute the dark
  // one applies.
  const setTheme = (mode) => {
    if (mode === 'light') document.documentElement.dataset.theme = 'light';
    else delete document.documentElement.dataset.theme;
  };
  const theme = () =>
    document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  setTheme(params.get('theme'));

  // Messages go to the page that embeds this artifact. A standalone artifact
  // has no such page.
  const host = window.parent !== window ? window.parent : null;
  const post = (message) => {
    if (host) host.postMessage(message, '*');
  };
  const reportError = (info) => {
    console.error('[codjiva]', info.scene || '', info.message);
    post({ cj: 'error', message: info.message, scene: info.scene, t: info.t });
  };

  // Text is measured during setup, so the fonts must be ready first.
  if (document.fonts && document.fonts.ready) {
    try {
      await document.fonts.ready;
    } catch (e) {
      /* the fallback font is used */
    }
  }

  // Fits the 1920 x 1080 stage into the frame, centred, keeping its shape.
  const fit = () => {
    const r = frame.getBoundingClientRect();
    const k = Math.min(r.width / STAGE_W, r.height / STAGE_H);
    stage.style.transform =
      'translate(' +
      (r.width - STAGE_W * k) / 2 +
      'px,' +
      (r.height - STAGE_H * k) / 2 +
      'px) scale(' +
      k +
      ')';
  };
  window.addEventListener('resize', fit);
  document.addEventListener('fullscreenchange', fit);

  registry.loadErrors.forEach((e) =>
    reportError({ message: e.file + ': ' + e.message }),
  );

  let film = null;
  let visual = null;
  try {
    // A view has no plant and no visual.json of its own. Both are made from
    // its data here, and the page then goes on as it does for a visual.
    if (data.view) {
      const compiled = compileView(data.view);
      registry.plant = compiled.plant;
      data.visual = compiled.visual;
    }
    if (isFilm) film = buildFilm(data.film, stage, reportError);
    else visual = buildVisual(data.visual, stage, post);
  } catch (e) {
    reportError({ message: String((e && e.message) || e) });
    $('loading').textContent =
      'This artifact could not be drawn: ' + String((e && e.message) || e);
    return;
  }

  const runSelfTest = (opts) =>
    selfTest({ film, visual, data, stage }, opts || {});

  // ---------------------------------------------------------------- point-at
  // mode The app turns this mode on with a `pick` message when the user wants
  // to show which element their feedback is about. While it is on, the next
  // press on the page is not passed to the artifact. The element under the
  // pointer is reported to the app in a `picked` message, and the mode ends.
  let picking = false;
  // Returns the class prefix of what is on screen and facts about the moment,
  // such as the scene and time of a film. The film and visual sections below
  // replace it.
  let pickContext = () => ({ prefix: '' });
  // True from the press that picked an element until the click that the same
  // press produces.
  let swallowPress = false;
  const setPicking = (on) => {
    picking = !!on;
    document.body.classList.toggle('picking', picking);
  };

  // The most specific named element at a point of the page, or null. An element
  // is named when the agent gave it a class with the scene's prefix, or when
  // the runtime tagged it as a part with `data-cj`. Of all visible named
  // elements whose box contains the point, the one with the smallest box is
  // returned. The sheet's grid and border are never returned.
  const namedElementAt = (x, y, prefix) => {
    let best = null;
    let bestArea = Infinity;
    stage.querySelectorAll('[class], [data-cj]').forEach((el) => {
      const classes = (el.getAttribute('class') || '').split(/\s+/);
      const own = classes.find((c) => c.indexOf(prefix + '-') === 0);
      if (!own && !el.hasAttribute('data-cj')) return;
      if (classes.indexOf('grid') >= 0 || classes.indexOf('border') >= 0)
        return;
      const r = el.getBoundingClientRect();
      if (
        r.width < 1 ||
        r.height < 1 ||
        x < r.left ||
        x > r.right ||
        y < r.top ||
        y > r.bottom
      )
        return;
      if (r.width * r.height >= bestArea) return;
      for (let n = el; n && n !== stage; n = n.parentElement) {
        const style = getComputedStyle(n);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          Number(style.opacity) < 0.05
        )
          return;
      }
      best = {
        el,
        selector: own
          ? '.' + own
          : el.tagName.toLowerCase() +
            '[data-cj="' +
            el.getAttribute('data-cj') +
            '"]',
      };
      bestArea = r.width * r.height;
    });
    return best;
  };

  window.addEventListener(
    'pointerdown',
    (ev) => {
      if (!picking) {
        swallowPress = false;
        return;
      }
      swallowPress = true;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      const context = pickContext();
      const found = namedElementAt(ev.clientX, ev.clientY, context.prefix);
      const stageRect = stage.getBoundingClientRect();
      const k = stageRect.width / STAGE_W || 1;
      const round = (v) => Math.round(v * 10) / 10;
      const picked = {
        cj: 'picked',
        x: round((ev.clientX - stageRect.left) / k),
        y: round((ev.clientY - stageRect.top) / k),
      };
      if (found) {
        const r = found.el.getBoundingClientRect();
        picked.selector = found.selector;
        picked.part = found.el.getAttribute('data-cj') || undefined;
        picked.text = (found.el.textContent || '')
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 80);
        picked.box = [
          round((r.left - stageRect.left) / k),
          round((r.top - stageRect.top) / k),
          round(r.width / k),
          round(r.height / k),
        ];
      }
      Object.keys(context).forEach((key) => {
        if (key !== 'prefix') picked[key] = context[key];
      });
      setPicking(false);
      post(picked);
    },
    true,
  );
  // The press that picked an element must not also act as a click on the
  // artifact.
  ['pointerup', 'click'].forEach((type) =>
    window.addEventListener(
      type,
      (ev) => {
        if (!swallowPress) return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        if (type === 'click') swallowPress = false;
      },
      true,
    ),
  );

  // ---------------------------------------------------------------- still
  // visuals
  if (visual) {
    controls.innerHTML =
      '<button id="fit" class="text" title="Fit">Fit</button><button id="zoomout" class="text" title="Zoom out">−</button><button id="zoomin" class="text" title="Zoom in">+</button><div id="layers"></div><div id="hint-text">Drag to pan · scroll to zoom · click a part or a numbered marker</div>';
    $('fit').addEventListener('click', () => visual.fit());
    $('zoomin').addEventListener('click', () => visual.zoomBy(1.25));
    $('zoomout').addEventListener('click', () => visual.zoomBy(0.8));
    const layerBox = $('layers');
    Object.keys(visual.layers()).forEach((layer) => {
      const button = document.createElement('button');
      button.className = 'text on';
      button.textContent = layer;
      button.addEventListener('click', () => {
        const on = !visual.layers()[layer];
        visual.setLayers({ [layer]: on });
        button.classList.toggle('on', on);
      });
      layerBox.append(button);
    });
    if (visual.hasLegend) {
      const button = document.createElement('button');
      button.className = 'text';
      button.textContent = 'legend';
      button.addEventListener('click', () =>
        button.classList.toggle('on', visual.setLegend()),
      );
      layerBox.append(button);
    }
    if (visual.hasRationale) {
      const button = document.createElement('button');
      button.className = 'text';
      button.textContent = 'rationale';
      button.addEventListener('click', () =>
        button.classList.toggle('on', visual.setRationale()),
      );
      layerBox.append(button);
    }
    window.addEventListener('message', (ev) => {
      if (ev.source !== host || !ev.data || !ev.data.cj) return;
      const msg = ev.data;
      if (msg.cj === 'hello') {
        embedded = true;
        markEmbedded();
        fit();
        sendReady();
      } else if (msg.cj === 'theme') {
        setTheme(msg.mode);
        post({ cj: 'theme', mode: theme() });
      } else if (msg.cj === 'legend') visual.setLegend(msg.on);
      else if (msg.cj === 'rationale') visual.setRationale(msg.on);
      else if (msg.cj === 'layers') visual.setLayers(msg.on || {});
      else if (msg.cj === 'fit') visual.fit();
      else if (msg.cj === 'zoom') visual.zoomBy(msg.factor || 1);
      else if (msg.cj === 'select') visual.select(msg.nodeId || null, true);
      else if (msg.cj === 'step' && visual.stepper)
        visual.stepper.go(msg.index);
      else if (msg.cj === 'input' && visual.stepper)
        visual.stepper.setInput(msg.value == null ? '' : msg.value);
      else if (msg.cj === 'panel' && visual.stepper)
        visual.stepper.setPanelHeight(msg.height);
      else if (msg.cj === 'page' && visual.pages)
        visual.pages.open(msg.id == null ? '' : msg.id);
      else if (msg.cj === 'pick') setPicking(msg.on !== false);
      else if (msg.cj === 'selftest')
        Promise.resolve(runSelfTest(msg.opts)).then((report) =>
          post({ cj: 'selftest', report }),
        );
    });
    pickContext = () => ({ prefix: 'v' });
    const sendReady = () =>
      post({
        cj: 'ready',
        kind: 'visual',
        title: data.visual.title,
        layers: visual.layers(),
        nodes: (data.visual.nodes || []).map((n) => n.id),
        legend: visual.hasLegend,
        rationale: visual.hasRationale,
        stepper: !!visual.stepper,
        view: data.view ? data.view.view : null,
        runtime: CJ.version,
        theme: theme(),
      });
    // A step-through adds its controls around the stage, which leaves the
    // stage less room, so the stage is fitted again afterwards.
    if (data.visual.stepper)
      visual.stepper = buildStepper(data.visual, visual, post, fit);
    // A map adds the bar that shows which level is on screen.
    if (data.visual.map)
      visual.pages = buildMapNav(data.visual, visual, post, fit);
    fit();
    window.__cj = { kind: 'visual', visual, selfTest: runSelfTest, registry };
    document.body.classList.add('ready');
    sendReady();
    if (params.get('selftest') === '1')
      Promise.resolve(runSelfTest({})).then((report) => {
        window.__cjReport = report;
        post({ cj: 'selftest', report });
      });
    return;
  }

  // ---------------------------------------------------------------- films
  controls.innerHTML = FILM_CONTROLS;
  const playBtn = $('play');
  const muteBtn = $('mute');
  const fsBtn = $('fs');
  const bar = $('bar');
  const fill = $('fill');
  const knob = $('knob');
  const timeEl = $('time');
  const chapterEl = $('chapter');

  audio.load(buildScore(data.film, film));

  const total = film.duration;
  const scenes = film.scenes;
  scenes.forEach((s, i) => {
    if (i === 0) return;
    const mark = document.createElement('div');
    mark.className = 'mark';
    mark.style.left = (100 * s.start) / total + '%';
    mark.title = s.meta.name || s.meta.title;
    bar.append(mark);
  });

  // t is the film time in real seconds. While playing with sound off, it
  // follows the page clock from the moment and position recorded in clockStart
  // and filmStart. With sound on it follows the audio clock instead.
  let t = 0;
  let playing = false;
  let muted = true;
  let rate = 1;
  let clockStart = 0;
  let filmStart = 0;
  let shownChapter = -1;
  let lastSent = 0;

  const sendTime = (force) => {
    if (!host) return;
    const nowMs = performance.now();
    if (!force && nowMs - lastSent < 100) return;
    lastSent = nowMs;
    const scene = scenes[film.sceneAt(t)];
    const sceneT =
      Math.round(
        scene.warp.tau(Math.min(scene.duration, Math.max(0, t - scene.start))) *
          100,
      ) / 100;
    post({
      cj: 'time',
      t,
      chapter: film.sceneAt(t),
      scene: scene.meta.id,
      sceneT,
      playing,
      muted,
      rate,
    });
  };

  const draw = (x) => {
    const i = film.draw(x);
    if (i !== shownChapter) {
      shownChapter = i;
      chapterEl.textContent =
        i +
        1 +
        ' / ' +
        scenes.length +
        ' · ' +
        (scenes[i].meta.name || scenes[i].meta.title);
    }
    const p = total ? Math.max(0, Math.min(total, x)) / total : 0;
    fill.style.width = p * 100 + '%';
    knob.style.left = p * 100 + '%';
    timeEl.textContent = formatTime(x) + ' / ' + formatTime(total);
  };

  const now = () =>
    !muted && audio.running && audio.ctx
      ? audio.filmTime()
      : filmStart + ((performance.now() - clockStart) / 1000) * rate;
  const restartClock = () => {
    clockStart = performance.now();
    filmStart = t;
  };

  const play = () => {
    if (t >= total - 0.01) t = 0;
    // A rationale that was opened while the film was paused closes when the
    // film goes on.
    document
      .querySelectorAll('.bub.cj-why-open')
      .forEach((bubble) => setRationaleOpen(bubble, false));
    playing = true;
    restartClock();
    if (!muted) audio.start(t, rate);
    playBtn.dataset.state = 'playing';
    playBtn.setAttribute('aria-label', 'Pause');
    sendTime(true);
  };
  const pause = () => {
    playing = false;
    audio.stop();
    playBtn.dataset.state = 'paused';
    playBtn.setAttribute('aria-label', 'Play');
    sendTime(true);
  };
  const seek = (x) => {
    t = Math.max(0, Math.min(total, x));
    restartClock();
    if (playing && !muted) audio.start(t, rate);
    draw(t);
    sendTime(true);
  };
  const setMuted = (value) => {
    muted = value;
    muteBtn.dataset.state = value ? 'muted' : 'on';
    muteBtn.setAttribute('aria-label', value ? 'Turn sound on' : 'Mute');
    if (value) audio.stop();
    else if (playing) {
      restartClock();
      audio.start(t, rate);
    } else audio.ensure();
    sendTime(true);
  };
  const setRate = (value) => {
    if (playing) t = now();
    rate = Math.min(4, Math.max(0.25, Number(value) || 1));
    restartClock();
    if (playing && !muted) audio.start(t, rate);
    sendTime(true);
  };
  const toggle = () => (playing ? pause() : play());
  const chapterStep = (dir) => {
    const i = film.sceneAt(t);
    if (dir > 0) seek(scenes[Math.min(scenes.length - 1, i + 1)].start);
    // Going back returns to the start of this chapter first, and to the
    // previous chapter if the viewer is already within two seconds of that
    // start.
    else
      seek(
        t - scenes[i].start > 2 || i === 0
          ? scenes[i].start
          : scenes[i - 1].start,
      );
  };

  const tick = () => {
    if (playing) {
      t = now();
      if (t >= total) {
        t = total;
        pause();
      }
      audio.pump();
      sendTime(false);
    }
    draw(t);
    requestAnimationFrame(tick);
  };

  // Opens or closes the rationale of a bubble. An open rationale makes the
  // bubble taller, so the film measures the bubble again and draws the
  // moment again, which keeps the taller bubble inside the view.
  const setRationaleOpen = (bubble, open) => {
    bubble.classList.toggle('cj-why-open', open);
    film.remeasureBubble(bubble);
    draw(t);
  };
  // A click on the "rationale" chip of a bubble pauses the film and opens or
  // closes the rationale. The click does not also start or stop the film,
  // which a click anywhere else on the stage does. This listener runs before
  // that one because it listens while the click travels down to the chip. A
  // chip of a bubble that is not on screen is ignored.
  frame.addEventListener(
    'click',
    (ev) => {
      const chip = ev.target.closest && ev.target.closest('.cj-why-chip');
      const bubble = chip && chip.closest('.bub');
      if (!bubble || Number(bubble.style.opacity) < 0.5) return;
      ev.stopPropagation();
      if (playing) pause();
      setRationaleOpen(bubble, !bubble.classList.contains('cj-why-open'));
    },
    true,
  );
  playBtn.addEventListener('click', toggle);
  frame.addEventListener('click', toggle);
  muteBtn.addEventListener('click', () => setMuted(!muted));
  fsBtn.addEventListener('click', () => {
    const el = $('app');
    if (document.fullscreenElement) document.exitFullscreen();
    else if (el.requestFullscreen) el.requestFullscreen();
  });

  let dragging = false;
  const timeFromPointer = (ev) => {
    const r = bar.getBoundingClientRect();
    return clamp01((ev.clientX - r.left) / r.width) * total;
  };
  bar.addEventListener('pointerdown', (ev) => {
    dragging = true;
    bar.setPointerCapture(ev.pointerId);
    seek(timeFromPointer(ev));
  });
  bar.addEventListener('pointermove', (ev) => {
    if (dragging) seek(timeFromPointer(ev));
  });
  bar.addEventListener('pointerup', () => {
    dragging = false;
  });

  window.addEventListener('keydown', (ev) => {
    if (ev.code === 'Space') {
      ev.preventDefault();
      toggle();
    } else if (ev.code === 'ArrowRight') seek(t + 5);
    else if (ev.code === 'ArrowLeft') seek(t - 5);
    else if (ev.key === 'Home') seek(0);
    else if (ev.key === 'PageDown') chapterStep(1);
    else if (ev.key === 'PageUp') chapterStep(-1);
    else if (ev.key === 'm' || ev.key === 'M') setMuted(!muted);
    else if (ev.key === 'f' || ev.key === 'F') {
      if (embedded) post({ cj: 'key', key: 'f' });
      else fsBtn.click();
    }
  });

  // What a pointed-at element is reported with: the scene on screen, the film
  // time in real seconds, and the same moment as the animation time that
  // scene's `render` was given.
  pickContext = () => {
    const scene = scenes[film.sceneAt(t)];
    const local = Math.min(scene.duration, Math.max(0, t - scene.start));
    return {
      prefix: scene.meta.id,
      scene: scene.meta.id,
      t: Math.round(t * 100) / 100,
      sceneT: Math.round(scene.warp.tau(local) * 100) / 100,
    };
  };
  const sendReady = () =>
    post({
      cj: 'ready',
      kind: 'film',
      title: data.film.title,
      duration: total,
      chapters: film.chapters(),
      runtime: CJ.version,
      theme: theme(),
    });

  window.addEventListener('message', (ev) => {
    if (ev.source !== host || !ev.data || !ev.data.cj) return;
    const msg = ev.data;
    if (msg.cj === 'hello') {
      embedded = true;
      markEmbedded();
      fit();
      sendReady();
      sendTime(true);
    } else if (msg.cj === 'theme') {
      setTheme(msg.mode);
      post({ cj: 'theme', mode: theme() });
    } else if (msg.cj === 'play') play();
    else if (msg.cj === 'pause') pause();
    else if (msg.cj === 'seek') seek(Number(msg.t) || 0);
    else if (msg.cj === 'mute') setMuted(!!msg.on);
    else if (msg.cj === 'speed') setRate(msg.x);
    else if (msg.cj === 'chapter') chapterStep(msg.dir > 0 ? 1 : -1);
    else if (msg.cj === 'pick') {
      pause();
      setPicking(msg.on !== false);
    } else if (msg.cj === 'selftest') {
      pause();
      Promise.resolve(runSelfTest(msg.opts)).then((report) => {
        draw(t);
        post({ cj: 'selftest', report });
      });
    }
  });

  fit();
  // A handle for tests and for the app's hidden validation frame.
  window.__cj = {
    kind: 'film',
    film,
    registry,
    seek: (x) => {
      pause();
      seek(x);
    },
    selfTest: runSelfTest,
  };
  document.body.classList.add('ready');
  if (params.get('poster') === '1') {
    draw(Math.max(0, Math.min(total, Number(data.film.thumbT) || 0)));
    sendReady();
    return;
  }
  draw(0);
  sendReady();
  requestAnimationFrame(tick);
  if (params.get('selftest') === '1')
    Promise.resolve(runSelfTest({})).then((report) => {
      window.__cjReport = report;
      draw(t);
      post({ cj: 'selftest', report });
    });
};
