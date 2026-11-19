// The plant of Limiter.Allow in internal/orders/limiter.go, drawn as a state machine. The four
// states are the conditions one customer's window can be in. An order moves the customer along
// a transition. The table on the right shows the fields of that customer's customerWindow.

// Every state is 250 wide and 80 tall, and their tops are at y 500, so every transition between
// two neighbours runs along y 540.
const STATE_Y = 500;
const STATES = [
  // name, x, label, second line, kind
  ['none', 120, 'No window', 'customer not seen yet', 'start'],
  ['allow', 560, 'Allowing', 'count ≤ 30', ''],
  ['defer', 1000, 'Deferring', 'count 31 to 60', ''],
  ['blocked', 1440, 'Blocked', 'until the window ends', ''],
];

// Transitions: name, path, label, where the label goes (null for the default place).
const EDGES = [
  ['first', 'M370 540 H560', 'first order', null],
  ['allowstay', 'M620 500 V440 H750 V500', 'count ≤ 30', null],
  ['soft', 'M810 540 H1000', 'count > 30', null],
  ['deferstay', 'M1060 500 V440 H1190 V500', 'count ≤ 60', null],
  ['hard', 'M1250 540 H1440', 'count > 60', null],
  ['blockedstay', 'M1500 500 V440 H1630 V500', 'every order', null],
  // The three transitions back to "No window" share one line along the bottom. Only the last
  // one carries the label.
  ['xallow', 'M685 580 V700 H245 V580', '', null],
  ['xdefer', 'M1125 580 V700 H245 V580', '', null],
  ['xblocked', 'M1565 580 V700 H245 V580', 'an order arrives 1 minute or more after the window began', [680, 710]],
];

const REGISTERS = ['now', 'w.start', 'w.count', 'w.blocked'];

CJ.definePlant({
  draw({ c, extraSvg, extraHtml }) {
    const states = STATES.map((s) => CJ.state(c(s[0]), s[1], STATE_Y, 250, 80, s[2], { sub: s[3], kind: s[4] }));
    const edges = EDGES.map((e) => CJ.edge(c(e[0]), e[1], { label: e[2], at: e[3] || undefined }));
    const reg = CJ.registers(c('reg'), 1440, 220, 360, REGISTERS);

    const svg = '<svg class="art" viewBox="0 0 1920 1080">' + CJ.grid(c('grid')) + CJ.border() +
      edges.map((e) => e.svg).join('') +
      states.map((s) => s.svg).join('') +
      '<g class="' + c('greg') + '">' + reg.svg + '</g>' +
      extraSvg + '</svg>';

    const html =
      CJ.plate('Limiter.Allow()', 120, 250, c('title')) +
      CJ.label(['One customer, one window of 1 minute.', 'Each order moves the customer along one transition.'], 120, 292, { size: 16 }) +
      CJ.plate('customerWindow', 1440, 178, c('regplate')) +
      edges.map((e) => e.html).join('') +
      states.map((s) => s.html).join('') +
      reg.html + extraHtml;

    return svg + html;
  },

  refs({ q }) {
    return { reg: CJ.registers.refs(q, 'reg') };
  },

  // reg       the four values of the table, as texts
  // changed   0 or 1 per value: 1 when the step on screen changed it
  defaults: { reg: ['0 s', '', '0', 'false'], changed: [0, 0, 0, 0] },

  set(R, S) {
    CJ.registers.set(R.reg, S.reg, S.changed);
  },

  routes() { return {}; },

  nodes: STATES.map((s) => ({ id: s[0], label: s[2], bbox: [s[1], STATE_Y, 250, 80], role: '', select: [s[0]] })),

  ports: [{ id: 'in:Limiter.Allow', dir: 'in', anchor: [120, 540] }],
});
