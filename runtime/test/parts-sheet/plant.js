// The parts sheet: every form of packet in every kind, with and without a
// tag, the two kinds that have their own shape, the cursor in its four
// directions, a frame next to a machine, and the parts of a state machine:
// states, transitions, the input tape and the table of variables. It is
// built as a visual, so it can be opened in a browser to judge the look of
// the parts. `parts.mjs` builds it and measures it.
/* global CJ */

const FORMS = ['crate', 'record', 'value', 'key', 'element', 'chunk'];
const KINDS = ['primary', 'secondary', 'transient'];
// The tag shown on each form in the tagged rows.
const TAGS = {
  crate: 'GET',
  record: 'row',
  value: '3',
  key: 'ID',
  element: 'OK',
  chunk: '0x',
};

// The table of forms. Column `i` is centred on COLUMN_X + i * COLUMN_STEP.
// The three rows without a tag come first, then the three rows with one.
const COLUMN_X = 330;
const COLUMN_STEP = 110;
const ROW_Y = [240, 305, 370, 460, 525, 590];

CJ.definePlant({
  draw({ c, extraSvg, extraHtml }) {
    const at = (x, y, markup) =>
      '<g transform="translate(' + x + ' ' + y + ')">' + markup + '</g>';

    let table = '';
    let words = '';
    FORMS.forEach((form, i) => {
      const x = COLUMN_X + i * COLUMN_STEP;
      words += CJ.label(form, x - 50, 170, { w: 100, size: 16 });
      ROW_Y.forEach((y, row) => {
        const kind = KINDS[row % 3];
        const tagged = row >= 3;
        table += at(
          x,
          y,
          CJ.packet(kind, c(form + '-' + kind + (tagged ? '-t' : '')), {
            form,
            tag: tagged ? TAGS[form] : undefined,
          }),
        );
      });
    });
    ROW_Y.forEach((y, row) => {
      words += CJ.label(KINDS[row % 3] + (row >= 3 ? ', tag' : ''), 80, y - 10);
    });

    const own =
      at(330, 690, CJ.packet('batch', c('batch'))) +
      at(440, 690, CJ.packet('tally', c('tally')));
    words +=
      CJ.label('batch', 280, 722, { w: 100, size: 16 }) +
      CJ.label('tally', 390, 722, { w: 100, size: 16 });

    const cursors =
      at(600, 705, CJ.cursor(c('cur-d'), 'd')) +
      at(690, 678, CJ.cursor(c('cur-u'), 'u')) +
      at(765, 692, CJ.cursor(c('cur-l'), 'l')) +
      at(890, 692, CJ.cursor(c('cur-r'), 'r'));
    words += CJ.label('cursor: d, u, l, r', 640, 722, { size: 16 });

    // A frame that holds what the user sees, and a machine that holds what
    // the code works on.
    const inFrame =
      [1130, 1210, 1290]
        .map((x, i) =>
          at(x, 340, CJ.packet('primary', c('item' + i), { form: 'element' })),
        )
        .join('') +
      at(
        1370,
        340,
        CJ.packet('secondary', c('more'), { form: 'element', tag: '2' }),
      ) +
      at(1470, 340, CJ.packet('transient', c('ghost'), { form: 'element' })) +
      at(1210, 310, CJ.cursor(c('cur-item'), 'd'));
    const inMachine =
      at(
        1130,
        685,
        CJ.packet('primary', c('count'), { form: 'value', tag: '3' }),
      ) +
      at(1230, 685, CJ.packet('secondary', c('row'), { form: 'record' })) +
      at(1330, 685, CJ.packet('secondary', c('id'), { form: 'key' })) +
      at(1430, 685, CJ.packet('primary', c('bytes'), { form: 'chunk' })) +
      at(1530, 685, CJ.packet('primary', c('req'))) +
      at(1630, 685, CJ.packet('transient', c('copy'), { form: 'record' }));
    words +=
      CJ.plate('menu', 1060, 158, c('plate-frame')) +
      CJ.plate('render()', 1060, 518, c('plate-mach')) +
      CJ.label('a frame: a region of the screen', 1090, 400, { size: 14 }) +
      CJ.label('a machine: code that runs', 1090, 760, { size: 14 });

    // A small state machine: a start state, a state it may end in, a
    // transition between them, a loop, and a dashed transition back. Below
    // it are the input tape and the variables.
    const machine = [
      CJ.state(c('st-a'), 120, 880, 220, 70, 'No window', {
        sub: 'the default',
        kind: 'start',
      }),
      CJ.state(c('st-b'), 520, 880, 220, 70, 'Allowing', { kind: 'accept' }),
      CJ.edge(c('ed-ab'), 'M340 905 H520', { label: 'an order' }),
      CJ.edge(c('ed-ba'), 'M520 930 H340', {
        label: 'a minute on',
        kind: 'fallback',
        at: [398, 936],
      }),
      CJ.edge(c('ed-aa'), 'M170 880 V836 H290 V880', { label: 'no order' }),
      CJ.tape(c('tape'), 860, 900, 12),
      CJ.registers(c('reg'), 1320, 868, 300, ['count', 'blocked']),
    ];
    words += CJ.label('tape', 860, 950, { size: 16 });

    return (
      '<svg class="art" viewBox="0 0 1920 1080">' +
      CJ.grid(c('grid')) +
      CJ.border() +
      CJ.frame(c('frame'), 1060, 200, 740, 250) +
      CJ.machine(c('mach'), 1060, 560, 740, 250, true) +
      table +
      own +
      cursors +
      inFrame +
      inMachine +
      machine.map((part) => part.svg).join('') +
      extraSvg +
      '</svg>' +
      words +
      machine.map((part) => part.html).join('') +
      extraHtml
    );
  },

  refs({ q }) {
    return {
      taken: CJ.edge.refs(q, 'ed-ab'),
      now: CJ.state.refs(q, 'st-b'),
      tape: CJ.tape.refs(q, 'tape'),
      reg: CJ.registers.refs(q, 'reg'),
    };
  },

  // The sheet shows the state machine parts as they look in use: the
  // transition that was just taken and the state it led to are lit, the tape
  // has its read head on the fifth character, and one variable has changed.
  set(R) {
    CJ.edge.set(R.taken, 1);
    CJ.state.set(R.now, 1);
    CJ.tape.set(R.tape, 'ooo oo>ooo', 4, [
      'primary',
      'primary',
      'primary',
      '',
      'secondary',
      'secondary',
      'secondary',
    ]);
    CJ.registers.set(R.reg, ['31', 'false'], [1, 0]);
  },

  nodes: [
    {
      id: 'frame',
      label: 'menu',
      bbox: [1060, 200, 740, 250],
      role: 'A frame',
      select: ['frame'],
    },
    {
      id: 'mach',
      label: 'render()',
      bbox: [1060, 560, 740, 250],
      role: 'A machine',
      select: ['mach'],
    },
  ],
});
