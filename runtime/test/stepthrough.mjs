// Builds the reference step-through and checks it in Chromium, Firefox and
// WebKit. A step-through is a visual that the viewer can run: they type an
// input or pick an example, and step through what the code does with it.
//
// In each browser:
//   - The self-test passes, which means every example ran to its end, took
//     only declared transitions and ended with the outputs it expects.
//   - The controls move through the steps: the buttons, the keys, the
//     scrubber, a click on a character of the input and a click on a past
//     step.
//   - The drawing follows the step: the state the code is in is lit, and so
//     is the transition it took.
//   - The panels show the step, the variables it changed and the outputs.
//   - Typing a new input, and choosing an example, runs the code again.
//
// In Chromium it also plants one defect at a time in a copy of the sources
// and checks that the builder or the self-test reports it.
import { chromium, firefox, webkit } from 'playwright';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  build,
  copySources,
  openArtifact,
  out,
  referenceStepthrough,
  runSelfTest,
  tryBuild,
} from './lib.mjs';

const file = build(referenceStepthrough, 'stepthrough');

let failed = 0;
const check = (ok, name, detail) => {
  if (!ok) failed++;
  console.log(
    (ok ? 'ok    ' : 'FAIL  ') +
      name +
      (ok || detail == null ? '' : '\n      ' + detail),
  );
};

// What the page shows: the text of the step counter, the ids of the nodes
// that are lit, the transitions drawn in the wider line of a transition that
// was just taken, and the text of the panels. The width of a line is read as
// a number, because one engine reports it as "4.5" and another as "4.5px".
const shown = (page) =>
  page.evaluate(() => ({
    count: document.getElementById('cj-count').textContent,
    lit: Array.from(document.querySelectorAll('.world .cj-step-on')).map((el) =>
      el.getAttribute('data-node'),
    ),
    taken: Array.from(document.querySelectorAll('.world [data-cj="edge"]'))
      .filter(
        (el) => parseFloat(el.querySelector('path').style.strokeWidth) === 4.5,
      )
      .map((el) => el.getAttribute('class')),
    step: document.querySelector('.cj-sp-step').textContent,
    changed: Array.from(document.querySelectorAll('.cj-changed')).map((el) =>
      el.textContent.replace(/\s+/g, ' '),
    ),
    panel: document.getElementById('steppanel').textContent,
    cell: document.querySelector('#cj-tape .cj-cur')?.dataset.at ?? null,
    register: document.querySelector('.world .v-reg-v2').textContent,
  }));

for (const [name, engine] of [
  ['chromium', chromium],
  ['firefox', firefox],
  ['webkit', webkit],
]) {
  const browser = await engine.launch();
  // The page is opened standalone, as an exported file is, with its panels
  // to the right of the stage.
  const { page, errors, context } = await openArtifact(browser, file, '');

  const report = await runSelfTest(page);
  check(
    report.ok && report.issues.length === 0,
    `${name}: the self-test passes and reports nothing`,
    JSON.stringify(report.issues.slice(0, 4)),
  );
  check(
    (report.stats.simRefs || []).includes('internal/orders/limiter.go:67'),
    `${name}: the self-test hands on the code references of the steps`,
    JSON.stringify(report.stats.simRefs),
  );

  // The first example is three orders. Its first step creates the window.
  let now = await shown(page);
  check(
    now.count === 'step 1 / 3' &&
      now.lit.join() === 'allow' &&
      now.taken.join() === 'v-first' &&
      now.cell === '0' &&
      /A new window starts/.test(now.step) &&
      /internal\/orders\/limiter\.go:56/.test(now.step),
    `${name}: the first step is on screen, with its state and transition lit`,
    JSON.stringify(now),
  );

  await page.locator('#cj-next').click();
  now = await shown(page);
  check(
    now.count === 'step 2 / 3' &&
      now.taken.join() === 'v-allowstay' &&
      now.changed.some((row) => /w\.count\s*2/.test(row)) &&
      now.register === '2',
    `${name}: Next shows the second step and marks the variable it changed`,
    JSON.stringify(now),
  );
  await page.locator('#cj-prev').click();
  await page.keyboard.press('End');
  const atEnd = (await shown(page)).count;
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  check(
    atEnd === 'step 3 / 3' && (await shown(page)).count === 'step 2 / 3',
    `${name}: Previous, End, Home and the Right key move through the steps`,
    atEnd,
  );

  // An example that crosses the soft limit: order 31 is the first deferred.
  await page
    .locator('#cj-presets button', { hasText: 'Over the soft limit' })
    .click();
  await page.locator('#cj-tape [data-at="30"]').click();
  now = await shown(page);
  check(
    now.count === 'step 31 / 32' &&
      now.lit.join() === 'defer' &&
      now.taken.join() === 'v-soft' &&
      /VerdictDefer/.test(now.panel) &&
      /Goes on to/i.test(now.panel),
    `${name}: an example runs, and a click on a character goes to its step`,
    JSON.stringify({ ...now, panel: now.panel.slice(0, 200) }),
  );
  await page.locator('.cj-sp-history [data-step="2"]').click();
  check(
    (await shown(page)).count === 'step 3 / 32',
    `${name}: a click on a past step goes back to it`,
  );
  await page.locator('#cj-scrub').fill('31');
  check(
    (await shown(page)).count === 'step 32 / 32',
    `${name}: the scrubber moves to a step`,
  );

  // Typing an input runs the code on it. One order, a minute, one order: the
  // second order first drops the old window, then starts a new one.
  await page.locator('#cj-input').fill('o>o');
  await page.locator('#cj-last').click();
  now = await shown(page);
  check(
    now.count === 'step 4 / 4' &&
      now.taken.join() === 'v-first' &&
      /allowed\s*2/.test(now.panel),
    `${name}: typing an input runs the code on it`,
    JSON.stringify({ ...now, panel: now.panel.slice(0, 160) }),
  );
  await page.locator('#cj-prev').click();
  now = await shown(page);
  check(
    now.lit.join() === 'none' && now.taken.join() === 'v-xallow',
    `${name}: the step before it leaves the window that has ended`,
    JSON.stringify(now.taken),
  );

  // Play moves on by itself and stops at the last step.
  await page.locator('#cj-first').click();
  await page.locator('[data-speed="4"]').click();
  await page.locator('#cj-play').click();
  await page.waitForFunction(
    () => document.getElementById('cj-count').textContent === 'step 4 / 4',
    null,
    { timeout: 5000 },
  );
  check(
    (await page.locator('#cj-play').getAttribute('aria-label')) === 'Play',
    `${name}: Play runs to the last step and stops there`,
  );

  // A click on a state pins it in the panel, and an edge case of that state
  // has a button that loads its example.
  const box = await page.locator('.v-blocked').first().boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.locator('#steppanel', { hasText: 'Pinned state' }).waitFor();
  await page.locator('.cj-sp-case button').first().click();
  check(
    (await page.locator('#cj-input').inputValue()) === 'o'.repeat(61) &&
      (await shown(page)).count === 'step 1 / 61',
    `${name}: an edge case of the pinned state loads its example`,
    await page.locator('#cj-input').inputValue(),
  );
  check(errors.length === 0, `${name}: the page logs no errors`, errors[0]);
  if (name === 'chromium') {
    await page.keyboard.press('End');
    await page.screenshot({ path: path.join(out, 'stepthrough.png') });
  }
  await context.close();

  // Inside the app the panels lie under the stage, and the section that
  // describes the state is left out, because the app's inspector shows it.
  {
    const embedded = await openArtifact(browser, file);
    const layout = await embedded.page.evaluate(() => {
      const frame = document.getElementById('frame').getBoundingClientRect();
      const panel = document
        .getElementById('steppanel')
        .getBoundingClientRect();
      return {
        under: panel.top >= frame.bottom - 1 && panel.width > frame.width - 2,
        state: getComputedStyle(document.querySelector('.cj-sp-state')).display,
        sections: Array.from(
          document.querySelectorAll('#steppanel section'),
        ).filter((el) => getComputedStyle(el).display !== 'none').length,
      };
    });
    check(
      layout.under && layout.state === 'none' && layout.sections === 4,
      `${name}: embedded in the app, the panels lie under the stage`,
      JSON.stringify(layout),
    );
    await embedded.context.close();
  }

  if (name === 'chromium') {
    // ---- planted defects
    const edit = (dir, name, from, to) => {
      const full = path.join(dir, name);
      const text = readFileSync(full, 'utf8');
      if (!text.includes(from))
        throw new Error(`${name}: the text to replace was not found: ${from}`);
      writeFileSync(full, text.replace(from, to));
    };
    const issuesOf = async (dir, label) => {
      const opened = await openArtifact(browser, build(dir, 'st-' + label));
      const found = (await runSelfTest(opened.page)).issues;
      await opened.context.close();
      return found;
    };
    const selfTestCases = [
      {
        name: 'a step function that does not do what an example expects is reported as sim-expect',
        plant: (dir) =>
          edit(dir, 'sim.js', 'const SOFT = 30;', 'const SOFT = 29;'),
        expect: (issues) =>
          issues.some(
            (i) =>
              i.check === 'sim-expect' &&
              i.severity === 'error' &&
              /Over the soft limit/.test(i.message) &&
              /"allowed" ends as 29, but the example expects 30/.test(
                i.message,
              ),
          ),
      },
      {
        name: 'a step that names a transition between other states is reported as sim',
        plant: (dir) =>
          edit(
            dir,
            'sim.js',
            "state: 'allow', edge: 'allowstay', at,",
            "state: 'allow', edge: 'hard', at,",
          ),
        expect: (issues) =>
          issues.some(
            (i) =>
              i.check === 'sim' &&
              i.message.includes('takes the transition "hard"') &&
              i.message.includes('(defer → blocked)') &&
              i.message.includes('went from allow to allow'),
          ),
      },
      {
        name: 'a step function that never ends is stopped and reported as sim',
        plant: (dir) =>
          edit(
            dir,
            'sim.js',
            'if (m.p >= input.length) return null;',
            'if (m.p > input.length) return null;\n    if (m.p >= input.length) return { state: stateOf(m.w) };',
          ),
        expect: (issues) =>
          issues.some(
            (i) =>
              i.check === 'sim' && /did not finish within 2000/.test(i.message),
          ),
      },
      {
        name: 'a step function that throws is reported as sim, with the message',
        plant: (dir) =>
          edit(
            dir,
            'sim.js',
            'const at = m.p;',
            "const at = m.p;\n    if (at === 2) throw new Error('boom');",
          ),
        expect: (issues) =>
          issues.some((i) => i.check === 'sim' && /boom/.test(i.message)),
      },
    ];
    for (const [i, test] of selfTestCases.entries()) {
      const dir = copySources(referenceStepthrough, 'st-case' + i);
      test.plant(dir);
      const issues = await issuesOf(dir, 'case' + i);
      check(test.expect(issues), test.name, JSON.stringify(issues.slice(0, 3)));
    }
    // Without the last example, nothing takes the transition from Blocked
    // back to "No window".
    {
      const dir = copySources(referenceStepthrough, 'st-coverage');
      const visualFile = path.join(dir, 'visual.json');
      const visual = JSON.parse(readFileSync(visualFile, 'utf8'));
      visual.stepper.presets.pop();
      writeFileSync(visualFile, JSON.stringify(visual));
      const issues = await issuesOf(dir, 'coverage');
      check(
        issues.length === 1 &&
          issues[0].check === 'sim-coverage' &&
          issues[0].severity === 'warning' &&
          /"xblocked"/.test(issues[0].message),
        'a transition that no example takes is reported as sim-coverage',
        JSON.stringify(issues.slice(0, 3)),
      );
    }

    const buildCases = [
      {
        name: 'the builder asks for sim.js when visual.json has a stepper',
        plant: (dir) => rmSync(path.join(dir, 'sim.js')),
        expect: /sim\.js: error \[missing-file\]/,
      },
      {
        name: 'the builder refuses a step function that touches the page',
        plant: (dir) =>
          edit(
            dir,
            'sim.js',
            'const at = m.p;',
            'const at = m.p;\n    document.title = at;',
          ),
        expect: /sim\.js:\d+: error \[forbidden-token\] `document`/,
      },
      {
        name: 'the builder refuses a transition between nodes that do not exist',
        plant: (dir) =>
          edit(
            dir,
            'visual.json',
            '"id": "soft", "from": "allow"',
            '"id": "soft", "from": "nowhere"',
          ),
        expect: /\[stepper\] transition "soft": "from" names "nowhere"/,
      },
    ];
    for (const [i, test] of buildCases.entries()) {
      const dir = copySources(referenceStepthrough, 'st-build' + i);
      test.plant(dir);
      const result = tryBuild(dir, 'st-build' + i);
      check(
        !result.ok && test.expect.test(result.stderr),
        test.name,
        result.stderr.trim().split('\n').slice(0, 3).join(' | '),
      );
    }
  }
  await browser.close();
}

if (failed) {
  console.error(failed + ' check(s) failed');
  process.exit(1);
}
console.log('The step-through works. A picture is in ' + out);
