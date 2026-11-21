// Seeded-defect tests. Each case plants one known defect in a copy of the
// reference film and checks that the builder or the self-test reports it with
// the right check and element.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  build,
  tryBuild,
  copySources,
  openArtifact,
  runSelfTest,
  referenceFilm,
  referenceVisual,
} from './lib.mjs';

// Replaces `from` with `to` in one file of a copied source folder. Fails if
// `from` is absent, so a case cannot silently stop planting its defect when the
// reference sources change.
const edit = (dir, file, from, to) => {
  const full = path.join(dir, file);
  const text = readFileSync(full, 'utf8');
  if (!text.includes(from))
    throw new Error(`${file}: the text to replace was not found: ${from}`);
  writeFileSync(full, text.replace(from, to));
};

const browser = await chromium.launch();
let failed = 0;
const pass = (name) => console.log('ok    ' + name);
const fail = (name, why) => {
  failed++;
  console.log('FAIL  ' + name + '\n      ' + why);
};

// Builds the edited copy, runs the self-test and returns its issues.
const issuesOf = async (dir, name) => {
  const { page, context } = await openArtifact(
    browser,
    build(dir, 'seeded-' + name),
  );
  const report = await runSelfTest(page);
  await context.close();
  return report.issues;
};

const selfTestCases = [
  {
    name: 'an overlapping label is reported as text-overlap, naming both labels',
    plant: (dir) =>
      edit(
        dir,
        'plant.js',
        "CJ.label('shed (counted)', 855, 900)",
        "CJ.label('shed (counted)', 200, 904)",
      ),
    expect: (issues) =>
      issues.some(
        (i) =>
          i.check === 'text-overlap' &&
          i.severity === 'error' &&
          [i.a.text, i.b.text].sort().join() ===
            'rejected · duplicate · blocked,shed (counted)',
      ),
  },
  {
    // The label 'rejected · duplicate · blocked' is 30 characters of 18 px
    // text at world point (148, 900), so it is 324 px wide and 20.7 px tall.
    // The planted label starts at (200, 904) and is 151.2 px wide. The two
    // reach 151.2 px into each other across and 16.7 px down.
    name: 'an overlapping label is given in world pixels, with how far the two overlap',
    plant: (dir) =>
      edit(
        dir,
        'plant.js',
        "CJ.label('shed (counted)', 855, 900)",
        "CJ.label('shed (counted)', 200, 904)",
      ),
    expect: (issues) =>
      issues.some((i) => {
        if (i.check !== 'text-overlap' || !i.a || !i.b) return false;
        const moved = [i.a, i.b].find((e) => e.text === 'shed (counted)');
        return (
          moved &&
          moved.world &&
          moved.world[0] === 200 &&
          moved.world[1] === 904 &&
          moved.box[0] !== 200 &&
          JSON.stringify(i.overlap) === '[152,17]'
        );
      }),
  },
  {
    // The tick label of the gauge bar `c('gauge')` is written by CJ.gaugeBar
    // at world point (1321, 706). Its class name is not in plant.js, so the
    // issue must say which call draws it and which argument moves it.
    name: 'a label that a part wrote is reported with the call that draws it',
    plant: (dir) =>
      edit(
        dir,
        'plant.js',
        "CJ.label('len(batch)', 1200, 764)",
        "CJ.label('len(batch)', 1330, 710)",
      ),
    expect: (issues) =>
      issues.some((i) => {
        if (i.check !== 'text-overlap' || !i.a || !i.b) return false;
        const tick = [i.a, i.b].find((e) => /-gauge-l0$/.test(e.selector));
        return (
          tick &&
          tick.drawnBy === "CJ.gaugeBar(c('gauge'), ...)" &&
          tick.move.includes('ticks[0].dx') &&
          tick.world[0] === 1321 &&
          tick.world[1] === 706
        );
      }),
  },
  {
    // Marker 1 of the reference visual is moved onto the label 'Store',
    // which is at world point (1480, 952).
    name: 'a marker of a visual is reported with its entry in visual.json',
    source: referenceVisual,
    plant: (dir) =>
      edit(
        dir,
        'visual.json',
        '{ "x": 200, "y": 680, "n": 1,',
        '{ "x": 1500, "y": 962, "n": 1,',
      ),
    expect: (issues) =>
      issues.some((i) => {
        if (i.check !== 'text-overlap' || !i.a || !i.b) return false;
        const marker = [i.a, i.b].find((e) => /cj-marker/.test(e.selector));
        return (
          marker &&
          marker.drawnBy === 'visual.json, markers[0]' &&
          marker.world[0] === 1485 &&
          marker.world[1] === 947
        );
      }),
  },
  {
    name: 'a label crossing a machine edge is reported as text-overlap against that machine',
    plant: (dir) =>
      edit(
        dir,
        'plant.js',
        "CJ.label('Store', 1480, 952)",
        "CJ.label('Store', 1480, 630)",
      ),
    // The machine is drawn with CJ.machine(c('flush'), 1460, 480, 170, 160),
    // and its world box must be exactly those four numbers.
    expect: (issues) =>
      issues.some(
        (i) =>
          i.check === 'text-overlap' &&
          i.a.text === 'Store' &&
          /-flush$/.test(i.b.selector) &&
          JSON.stringify(i.b.world) === '[1460,480,170,160]',
      ),
  },
  {
    name: 'a render that throws is reported as exception, naming the scene',
    plant: (dir) =>
      edit(
        dir,
        'scenes/budget.js',
        'const soft = seg(t, 2.0, 2.4);',
        "if (t > 5) throw new Error('boom');\n    const soft = seg(t, 2.0, 2.4);",
      ),
    expect: (issues) =>
      issues.some(
        (i) =>
          i.check === 'exception' &&
          i.scene === 'budget' &&
          /boom/.test(i.message),
      ),
  },
  {
    name: 'a class used on two elements is reported as prefix, naming the class',
    plant: (dir) =>
      edit(
        dir,
        'scenes/budget.js',
        "CJ.ring(c('rh'), 1874, 255, 20)",
        "CJ.ring(c('rh'), 1874, 255, 20) + CJ.ring(c('rs'), 1874, 372, 20)",
      ),
    expect: (issues) =>
      issues.some(
        (i) =>
          i.check === 'prefix' &&
          i.scene === 'budget' &&
          i.a.selector === '.budget-rs',
      ),
  },
  {
    name: 'a class without the scene prefix is reported as prefix',
    plant: (dir) =>
      edit(
        dir,
        'scenes/budget.js',
        "CJ.ring(c('rh'), 1874, 255, 20)",
        "CJ.ring(c('rh'), 1874, 255, 20) + CJ.ring('loose', 1874, 372, 20)",
      ),
    expect: (issues) =>
      issues.some(
        (i) =>
          i.check === 'prefix' &&
          i.scene === 'budget' &&
          /"loose"/.test(i.hint),
      ),
  },
  {
    name: 'a render that keeps state between frames is reported as determinism',
    plant: (dir) =>
      edit(
        dir,
        'scenes/budget.js',
        'const soft = seg(t, 2.0, 2.4);',
        'this.calls = (this.calls || 0) + 1;\n    this.rs.style.strokeWidth = this.calls;\n    const soft = seg(t, 2.0, 2.4);',
      ),
    expect: (issues) =>
      issues.some((i) => i.check === 'determinism' && i.scene === 'budget'),
  },
  {
    name: 'a label too long for its fixed-width box is reported as text-overflow',
    plant: (dir) =>
      edit(
        dir,
        'plant.js',
        "const PRESS_LABELS = ['valid', 'price', 'stamp'];",
        "const PRESS_LABELS = ['valid', 'price', 'stampWithALongName'];",
      ),
    expect: (issues) =>
      issues.some(
        (i) =>
          i.check === 'text-overflow' && /stampWithALongName/.test(i.a.text),
      ),
  },
  {
    name: 'a state jump between chapters is reported as continuity, naming the key',
    plant: (dir) =>
      edit(
        dir,
        'scenes/routing.js',
        'ctx.set({ level: 0.34, gauge: 4 / 64,',
        'ctx.set({ level: 0.6, gauge: 4 / 64,',
      ),
    expect: (issues) =>
      issues.some(
        (i) =>
          i.check === 'continuity' &&
          i.scene === 'routing' &&
          /level: 0\.34 → 0\.6/.test(i.message),
      ),
  },
  {
    name: 'a packet kind missing from the legend is reported as legend',
    plant: (dir) =>
      edit(
        dir,
        'film.json',
        '{ "kind": "batch", "html": "The batch · <code>[]Order</code> written by one <code>WriteBatch</code>" }',
        '{ "kind": "primary", "html": "again" }',
      ),
    expect: (issues) =>
      issues.some((i) => i.check === 'legend' && /"batch"/.test(i.message)),
  },
  {
    name: 'a packet form missing from the legend is reported as legend, naming the form and the kind',
    plant: (dir) =>
      edit(
        dir,
        'scenes/routing.js',
        "CJ.packet('primary', c('ip'))",
        "CJ.packet('primary', c('ip'), { form: 'record' })",
      ),
    expect: (issues) =>
      issues.some(
        (i) =>
          i.check === 'legend' &&
          i.scene === 'routing' &&
          /form "record" and kind "primary"/.test(i.message) &&
          /"form": "record"/.test(i.hint),
      ),
  },
  {
    name: 'a tag that is too long is reported as exception, with the limit',
    plant: (dir) =>
      edit(
        dir,
        'scenes/routing.js',
        "CJ.packet('primary', c('ip'))",
        "CJ.packet('primary', c('ip'), { tag: 'long' })",
      ),
    expect: (issues) =>
      issues.some(
        (i) =>
          i.check === 'exception' &&
          i.scene === 'routing' &&
          /at most 3/.test(i.message),
      ),
  },
];

for (const [index, test] of selfTestCases.entries()) {
  try {
    const dir = copySources(test.source || referenceFilm, 'case' + index);
    test.plant(dir);
    const issues = await issuesOf(dir, 'case' + index);
    if (test.expect(issues)) pass(test.name);
    else
      fail(
        test.name,
        'issues were: ' +
          JSON.stringify(
            issues.map((i) => [
              i.check,
              i.scene,
              i.a && i.a.selector,
              i.a && i.a.world,
              i.b && i.b.selector,
              i.b && i.b.world,
              i.overlap,
              i.message,
            ]),
          ).slice(0, 900),
      );
  } catch (e) {
    fail(test.name, String(e.stderr || e.message || e).slice(0, 600));
  }
}

const builderCases = [
  {
    name: 'the builder rejects fetch and names the file and line',
    code: "\nfetch('/data');\n",
    expect: /scenes\/budget\.js:\d+: error \[forbidden-token\] `fetch`/,
  },
  {
    name: 'the builder rejects Math.random and names the file and line',
    code: '\nconst jitter = Math.random();\n',
    expect: /scenes\/budget\.js:\d+: error \[forbidden-token\] `Math\.random`/,
  },
  {
    name: 'the builder rejects a timer',
    code: '\nsetTimeout(() => {}, 10);\n',
    expect: /\[forbidden-token\] `setTimeout`/,
  },
];
for (const [index, test] of builderCases.entries()) {
  const dir = copySources(referenceFilm, 'build' + index);
  const file = path.join(dir, 'scenes/budget.js');
  writeFileSync(file, readFileSync(file, 'utf8') + test.code);
  const result = tryBuild(dir, 'seeded-build' + index);
  if (!result.ok && test.expect.test(result.stderr)) pass(test.name);
  else fail(test.name, 'builder said: ' + result.stderr.slice(0, 400));
}

await browser.close();
if (failed) {
  console.error(failed + ' seeded-defect case(s) failed');
  process.exit(1);
}
console.log('All seeded defects were caught.');
