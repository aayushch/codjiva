// The plant of internal/orders/handler.go. Orders enter Submit on the left, pass the early
// refusals, the limiter and the three processing presses, and reach the routing switch. From there
// they are deferred, written at once, shed, or queued in the batch. The batch is flushed to the
// Store. The pending-bytes tank on the right drives the mode lamps and the refusal of new orders.

// The press positions on the processing belt, 100 px apart.
const PRESS_X = [580, 680, 780];
const PRESS_LABELS = ['valid', 'price', 'stamp'];

// The tank is drawn at y 230, height 520. Its liquid surface runs from y 746 (empty) to y 234 (full).
const TANK_BOTTOM = 746;
const TANK_SPAN = 512;
const SOFT_AT = 0.5;
const HARD_AT = 0.96;
const tankY = (at) => (TANK_BOTTOM - TANK_SPAN * at).toFixed(0);

// Bins are built here without a class so routes can use their slot positions.
const BATCH_BIN = CJ.bin('', 1260, 440, 140, 190, 2);
const DEFER_BIN = CJ.bin('', 1045, 240, 130, 150, 2);

// Plates: text, x, y.
const PLATES = [
  ['Order in', 60, 598],
  ['Submit()', 200, 398],
  ['Limiter.Allow()', 200, 158],
  ['process()', 500, 338],
  ['Submit switch', 900, 428],
  ['h.deferred', 1045, 198],
  ['flushLoop()', 1230, 198],
  ['Handler.mode', 1470, 198],
  ['h.batch', 1260, 650],
  ['flushLocked()', 1460, 438],
  ['pendingBytes', 1706, 188],
  ['Store.WriteBatch', 1660, 796],
];

CJ.definePlant({
  draw({ c, extraSvg, extraHtml }) {
    const presses = PRESS_X.map((x, i) => CJ.press(c('head' + i), x, 422, PRESS_LABELS[i]));
    const gauge = CJ.gaugeBar(c('gauge'), 1200, 740, 240, [{ at: 1, label: 'maxBatch 64', dx: -119 }]);
    const bin = CJ.bin(c('bin'), 1260, 440, 140, 190, 2);
    const dbin = CJ.bin(c('dbin'), 1045, 240, 130, 150, 2);
    const mode = CJ.modeLamps(c('mode'), 1470, 240, ['Normal', 'Shedding', 'Stopped'], 170);
    const tank = CJ.tank(c('tank'), 1706, 230, 50, 520,
      [{ at: SOFT_AT, label: 'soft 4MiB' }, { at: HARD_AT, label: 'hard 8MiB' }], { lampX: 1874 });

    const pk = (kind, name, p, opts) => '<g transform="translate(' + p[0] + ' ' + p[1] + ')">' + CJ.packet(kind, c(name), opts) + '</g>';
    const inBin = (b, kind, name, i) => pk(kind, name + i, b.slot(i));
    const packets =
      pk('primary', 'pk0', [1215, 560]) +
      [0, 1, 2, 3, 4, 5].map((i) => inBin(BATCH_BIN, 'primary', 'pkb', i)).join('') +
      [0, 1].map((i) => inBin(DEFER_BIN, 'primary', 'pkd', i)).join('') +
      pk('secondary', 'pk1', [1060, 780]) +
      pk('transient', 'pk2', [930, 750]) +
      pk('batch', 'pk3', [1555, 735]) +
      // Two things that are not orders. The verdict is one value that Limiter.Allow returns. The order ID
      // that Submit remembers in h.seen is a name for an order, not the order itself.
      pk('secondary', 'pkv', [395, 352], { form: 'value' }) +
      pk('secondary', 'pkk', [250, 480], { form: 'key', tag: 'ID' });

    const svg = '<svg class="art" viewBox="0 0 1920 1080">' + CJ.grid(c('grid')) + CJ.border() +
      CJ.wire(c('wsoft'), 'M1690 ' + tankY(SOFT_AT) + ' H1670 V300 H1640') +
      CJ.wire(c('whard'), 'M1690 ' + tankY(HARD_AT) + ' H1682 V156 H470 V470 H420') +
      CJ.wire(c('wflush'), 'M1440 748 H1500 V640') +
      CJ.pipe(c('pipe1'), 'M100 560 H200') + CJ.arrow(c('arr1'), 186, 560, 'r') +
      CJ.pipe(c('pipe2'), 'M395 440 V300', 'cool') + CJ.arrow(c('arr2'), 395, 415, 'u') +
      CJ.pipe(c('pipe3'), 'M310 680 V800') + CJ.arrow(c('arr3'), 310, 720, 'd') +
      CJ.pipe(c('pipe4'), 'M420 560 H500') + CJ.arrow(c('arr4'), 460, 560, 'r') +
      CJ.pipe(c('belt'), 'M500 560 H900', 'hot') + CJ.arrow(c('arr5'), 524, 560, 'r') +
      CJ.pipe(c('pipe5'), 'M1140 560 H1260', 'hot') + CJ.arrow(c('arr6'), 1165, 560, 'r') +
      CJ.pipe(c('pipe6'), 'M1110 470 V390') + CJ.arrow(c('arr7'), 1110, 430, 'u') +
      CJ.pipe(c('pipe7'), 'M1175 305 H1230') + CJ.arrow(c('arr8'), 1202, 305, 'r') +
      CJ.pipe(c('pipe8'), 'M1330 370 V440') + CJ.arrow(c('arr9'), 1330, 405, 'd') +
      CJ.pipe(c('pipe9'), 'M930 650 V800') + CJ.arrow(c('arr10'), 930, 690, 'd') +
      CJ.pipe(c('pipe10'), 'M1060 650 V870 H1480', 'cool') + CJ.arrow(c('arr11'), 1060, 700, 'd') +
      CJ.pipe(c('pipe11'), 'M1400 560 H1460', 'hot') + CJ.arrow(c('arr12'), 1430, 560, 'r') +
      CJ.pipe(c('pipe12'), 'M1555 640 V800', 'hot') + CJ.arrow(c('arr13'), 1555, 670, 'd') +
      CJ.pipe(c('pipe13'), 'M1630 870 H1800') + CJ.arrow(c('arr14'), 1710, 870, 'r') +
      CJ.machine(c('submit'), 200, 440, 220, 240, true) +
      CJ.machine(c('limiter'), 200, 200, 220, 100) +
      CJ.machine(c('process'), 500, 380, 340, 360) +
      CJ.machine(c('sw'), 900, 470, 240, 180, true) +
      CJ.machine(c('flushloop'), 1230, 240, 200, 130) +
      CJ.machine(c('flush'), 1460, 480, 170, 160, true) +
      '<g class="' + c('g1') + '" transform="translate(310 560)">' + CJ.gear(c('gear1'), 40, 10, true) + '</g>' +
      '<g class="' + c('g2') + '" transform="translate(1020 560)">' + CJ.gear(c('gear2'), 40, 10, true) + '</g>' +
      presses.map((p) => p.svg).join('') +
      '<g class="' + c('gbin') + '">' + bin.svg + '</g>' +
      '<g class="' + c('gdbin') + '">' + dbin.svg + '</g>' +
      '<g class="' + c('gmode') + '">' + mode.svg + '</g>' +
      '<g class="' + c('gtank') + '">' + tank.svg + '</g>' +
      '<g class="' + c('ggauge') + '">' + gauge.svg + '</g>' +
      CJ.dropBin(c('dropbin1'), 255, 800) + CJ.dropBin(c('dropbin2'), 875, 800) +
      CJ.drum(c('drum'), 1555, 800, 150, 140) +
      CJ.port(c('portin'), 60, 560, 'r') + CJ.port(c('portout'), 1800, 870, 'r') +
      '<g transform="translate(110 450)">' + CJ.warning(c('warn')) + '</g>' +
      packets + CJ.markedPacket(c('mp'), { marks: 3 }) +
      extraSvg + '</svg>';

    const html =
      PLATES.map((p, i) => CJ.plate(p[0], p[1], p[2], c('plate' + i))).join('') +
      presses.map((p) => p.html).join('') +
      mode.html + tank.html + gauge.html +
      CJ.label('ErrOverloaded', 62, 476, { size: 14, color: 'var(--main)' }) +
      CJ.label('h.seen', 290, 472, { size: 14 }) +
      CJ.label('rejected · duplicate · blocked', 148, 900) +
      CJ.label('shed (counted)', 855, 900) +
      CJ.label('len(batch)', 1200, 764) +
      CJ.label(['every 2s', 'releaseDeferred()'], 1250, 300, { size: 14 }) +
      CJ.label(['on error:', 'batch kept'], 1480, 586, { size: 14 }) +
      CJ.label('Store', 1480, 952);

    return svg + html + extraHtml;
  },

  refs({ q }) {
    return {
      g1: q('g1'),
      g2: q('g2'),
      press: PRESS_X.map((x, i) => CJ.press.refs(q, 'head' + i)),
      gauge: CJ.gaugeBar.refs(q, 'gauge'),
      mode: CJ.modeLamps.refs(q, 'mode'),
      tank: CJ.tank.refs(q, 'tank'),
      wires: ['wsoft', 'whard', 'wflush'].map(q),
      mp: CJ.markedPacket.refs(q, 'mp'),
    };
  },

  // level   0..1: pending bytes as a share of the tank
  // lamps   0..1 per tank mark: soft, hard
  // mode    weights for the lamps Normal, Shedding, Stopped
  // gauge   0..1: len(batch) as a share of maxBatch
  // press   one strike value per processing press
  // wires   0..1 per wire: soft limit, hard limit, batch full
  defaults: { level: 0.3, lamps: [0, 0], mode: [1, 0, 0], gauge: 0, press: [0, 0, 0], wires: [0, 0, 0] },

  set(R, S, t) {
    R.g1.setAttribute('transform', 'translate(310 560) rotate(' + (t * 30).toFixed(1) + ')');
    R.g2.setAttribute('transform', 'translate(1020 560) rotate(' + (-t * 30).toFixed(1) + ')');
    R.press.forEach((press, k) => CJ.press.set(press, S.press[k]));
    CJ.gaugeBar.set(R.gauge, S.gauge);
    CJ.modeLamps.set(R.mode, S.mode);
    CJ.tank.set(R.tank, S.level, S.lamps, t);
    R.wires.forEach((wire, i) => CJ.wire.set(wire, S.wires[i], t));
    CJ.place(R.mp.g, [870, 560], 1, 1);
    CJ.revealMarks(R.mp, 870, PRESS_X, true);
  },

  routes(CJ) {
    const r = CJ.route;
    const inlet = [[100, 560], [200, 560]];
    const toSwitch = inlet.concat([[900, 560]]);
    const batchSlot = BATCH_BIN.slot;
    return {
      // An order that is refused early drops into the left drop bin.
      refused: r([[310, 560], [310, 800]]),
      // A queued order reaches the batch bin and rests in slot i.
      queued: (i) => { const s = batchSlot(i); return r(toSwitch.concat([[1260, 560], s])); },
      // A deferred order rises into the deferred bin.
      deferred: r(toSwitch.concat([[1110, 560], [1110, 390]])),
      // A priority order goes straight to the Store.
      priority: r(toSwitch.concat([[1060, 560], [1060, 870], [1480, 870]])),
      // A shed order falls into the second drop bin.
      shed: r(toSwitch.concat([[930, 560], [930, 800]])),
      // The batch leaves the bin, enters flushLocked and goes down into the Store.
      flush: r([[1400, 560], [1555, 560], [1555, 800]]),
    };
  },

  nodes: [
    { id: 'submit', label: 'Submit()', bbox: [200, 440, 220, 240], role: 'Entry point. Refuses, de-duplicates and asks the limiter about each order', select: ['submit'] },
    { id: 'limiter', label: 'Limiter.Allow()', bbox: [200, 200, 220, 100], role: 'External rate limiter. Returns allow, defer or blocked per customer', select: ['limiter'] },
    { id: 'process', label: 'process()', bbox: [500, 380, 340, 360], role: 'Runs validateLines, price and stamp in that order', select: ['process'] },
    { id: 'sw', label: 'Submit switch', bbox: [900, 470, 240, 180], role: 'Routes a processed order: defer, write now, shed or enqueue', select: ['sw'] },
    { id: 'deferred', label: 'h.deferred', bbox: [1045, 240, 130, 150], role: 'Orders held by the soft rate limit until the next tick', select: ['gdbin'] },
    { id: 'flushloop', label: 'flushLoop()', bbox: [1230, 240, 200, 130], role: 'Every 2 seconds moves deferred orders to the batch and flushes', select: ['flushloop'] },
    { id: 'batch', label: 'h.batch', bbox: [1260, 440, 140, 190], role: 'Processed orders waiting for a flush; flushed at 64 orders', select: ['gbin'] },
    { id: 'flush', label: 'flushLocked()', bbox: [1460, 480, 170, 160], role: 'Writes the batch to the Store; keeps it in memory if the write fails', select: ['flush'] },
    { id: 'mode', label: 'Handler.mode', bbox: [1470, 240, 170, 95], role: 'Load mode. Normal, then Shedding at the soft limit, then Stopped at the hard limit', select: ['gmode'] },
    { id: 'tank', label: 'pendingBytes', bbox: [1706, 230, 50, 520], role: 'Estimated bytes of batch plus deferred, checked in reserve()', select: ['gtank'] },
    { id: 'store', label: 'Store', bbox: [1480, 800, 150, 140], role: 'The Store interface that receives WriteBatch calls', select: ['drum'] },
  ],

  ports: [
    { id: 'in:Handler.Submit', dir: 'in', anchor: [60, 560] },
    { id: 'out:Store.WriteBatch', dir: 'out', anchor: [1800, 870] },
  ],
});
