// Builds the four reference views and checks them in Chromium, Firefox and
// WebKit. A view is drawn by the runtime from the data in view.json, with no
// coordinates and no drawing code from an agent.
//
//   - schema: every type is a card, selecting a type lights its relations.
//   - lanes: a scenario is played one message at a time, and only the
//     messages up to the step on screen are shown.
//   - structure: the drawing of what is in memory changes with every step.
//   - map: one level is on screen at a time, and a double-click on a box
//     that has parts inside opens its level.
//
// Each view must pass its self-test, which also checks that no two labels of
// the drawing overlap. In Chromium the builder is also given broken views,
// and must name what is wrong with each.
import { chromium, firefox, webkit } from 'playwright';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  build,
  copySources,
  openArtifact,
  out,
  referenceView,
  runSelfTest,
  tryBuild,
} from './lib.mjs';

const files = Object.fromEntries(
  ['schema', 'lanes', 'structure', 'map'].map((name) => [
    name,
    build(referenceView(name), 'view-' + name),
  ]),
);

let failed = 0;
const check = (ok, name, detail) => {
  if (!ok) failed++;
  console.log(
    (ok ? 'ok    ' : 'FAIL  ') +
      name +
      (ok || detail == null ? '' : '\n      ' + detail),
  );
};

// The middle of the first element with the given class, in page pixels.
const middleOf = async (page, selector) => {
  const box = await page.locator(selector).first().boundingBox();
  return [box.x + box.width / 2, box.y + box.height / 2];
};
// The transitions and relations that are drawn lit: their line is 4.5 wide.
const litEdges = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.world [data-cj="edge"]'))
      .filter(
        (el) => parseFloat(el.querySelector('path').style.strokeWidth) === 4.5,
      )
      .map((el) => el.getAttribute('class')),
  );

for (const [engineName, engine] of [
  ['chromium', chromium],
  ['firefox', firefox],
  ['webkit', webkit],
]) {
  const browser = await engine.launch();
  const open = async (name) => {
    const opened = await openArtifact(browser, files[name], '');
    const report = await runSelfTest(opened.page);
    check(
      report.ok && report.issues.length === 0,
      `${engineName}: the ${name} view passes its self-test and reports nothing`,
      JSON.stringify(report.issues.slice(0, 3)),
    );
    return opened;
  };

  // ---- schema
  {
    const { page, errors, context } = await open('schema');
    const drawn = await page.evaluate(() => ({
      cards: document.querySelectorAll('.world [data-cj="card"]').length,
      relations: document.querySelectorAll('.world [data-cj="edge"]').length,
      dashed: Array.from(
        document.querySelectorAll('.world [data-cj="edge"][data-kind="quiet"]'),
      ).length,
      field: document.querySelector('.v-Order-f0').textContent,
      type: document.querySelector('.v-Order-y3').textContent,
    }));
    check(
      drawn.cards === 11 &&
        drawn.relations === 10 &&
        drawn.dashed === 1 &&
        drawn.field === '◆ ID' &&
        drawn.type === '[]Line',
      `${engineName}: a schema draws a card per type, with its fields, and an arrow per relation`,
      JSON.stringify(drawn),
    );
    const [x, y] = await middleOf(page, '.v-Order');
    await page.mouse.click(x, y);
    const lit = await litEdges(page);
    // Order holds Line and refers to Kind, and Handler holds Order.
    check(
      lit.sort().join() === 'v-rel0,v-rel1,v-rel2',
      `${engineName}: selecting a type lights the relations it takes part in`,
      lit.join(),
    );
    check(
      errors.length === 0,
      `${engineName}: schema logs no errors`,
      errors[0],
    );
    if (engineName === 'chromium')
      await page.screenshot({ path: path.join(out, 'view-schema.png') });
    await context.close();
  }

  // ---- lanes
  {
    const { page, errors, context } = await open('lanes');
    // What is on screen: the step counter, the messages that are visible in
    // the scenarios that are shown, and the message that is lit.
    const shown = () =>
      page.evaluate(() => ({
        count: document.getElementById('cj-count').textContent,
        visible: Array.from(
          document.querySelectorAll('.world [data-cj="edge"]'),
        ).filter(
          (el) =>
            !el.closest('.cj-layer-off') && Number(el.style.opacity) === 1,
        ).length,
        note: document.querySelector('.cj-sp-step p').textContent,
        input: !!document.getElementById('cj-input'),
        scenarios: Array.from(
          document.querySelectorAll('#cj-presets button'),
        ).map((el) => el.textContent),
      }));
    let now = await shown();
    check(
      now.count === 'step 1 / 6' &&
        now.visible === 1 &&
        !now.input &&
        now.scenarios.length === 5 &&
        /hands one order/.test(now.note),
      `${engineName}: lanes start on the first message of the first scenario, with scenarios to choose`,
      JSON.stringify(now),
    );
    await page.locator('#cj-next').click();
    await page.locator('#cj-next').click();
    now = await shown();
    check(
      now.count === 'step 3 / 6' &&
        now.visible === 3 &&
        (await litEdges(page)).join() === 'v-s0m2',
      `${engineName}: each step shows one more message and lights it`,
      JSON.stringify(now),
    );
    await page
      .locator('#cj-presets button', { hasText: 'A write fails' })
      .click();
    await page.locator('#cj-last').click();
    now = await shown();
    check(
      now.count === 'step 7 / 7' && now.visible === 7,
      `${engineName}: choosing a scenario shows its messages and hides the other scenario's`,
      JSON.stringify(now),
    );
    check(errors.length === 0, `${engineName}: lanes log no errors`, errors[0]);
    if (engineName === 'chromium')
      await page.screenshot({ path: path.join(out, 'view-lanes.png') });
    await context.close();
  }

  // ---- structure
  {
    const { page, errors, context } = await open('structure');
    // The texts drawn in memory, and how many cells have the tone of the
    // thing the step changed.
    const memory = () =>
      page.evaluate(() => ({
        count: document.getElementById('cj-count').textContent,
        texts: Array.from(document.querySelectorAll('.v-memory text')).map(
          (el) => el.textContent,
        ),
        changed: Array.from(document.querySelectorAll('.v-memory rect')).filter(
          (el) => el.style.stroke === 'var(--main)',
        ).length,
        lit: Array.from(document.querySelectorAll('.world .cj-step-on')).map(
          (el) => el.getAttribute('data-node'),
        ),
      }));
    let now = await memory();
    check(
      now.count === 'step 1 / 5' &&
        now.texts.includes('#1') &&
        now.changed === 1 &&
        now.lit.join() === 'enqueue',
      `${engineName}: a structure draws what is in memory after the first step`,
      JSON.stringify(now),
    );
    await page.locator('#cj-last').click();
    now = await memory();
    check(
      now.count === 'step 5 / 5' &&
        now.lit.join() === 'flush' &&
        now.texts.filter((text) => text === 'empty').length === 2 &&
        /written\s*3/.test(await page.locator('#steppanel').textContent()),
      `${engineName}: the drawing follows the steps, and the batch is empty after the flush`,
      JSON.stringify(now),
    );
    // A deferred order joins the batch behind an order that came after it.
    await page.locator('#cj-input').fill('odot');
    await page.locator('#cj-scrub').fill('3');
    now = await memory();
    const batch = now.texts.slice(
      now.texts.findIndex((text) => text.startsWith('h.batch')) + 1,
      now.texts.findIndex((text) => text.startsWith('h.deferred')),
    );
    check(
      batch.filter((text) => text.startsWith('#')).join() === '#1,#3,#2',
      `${engineName}: typing an input runs the code on it`,
      JSON.stringify(batch),
    );
    check(
      errors.length === 0,
      `${engineName}: structure logs no errors`,
      errors[0],
    );
    if (engineName === 'chromium')
      await page.screenshot({ path: path.join(out, 'view-structure.png') });
    await context.close();
  }

  // ---- map
  {
    const { page, errors, context } = await open('map');
    // The page on screen: the levels in the bar, the boxes that are shown
    // and the number of arrows between them.
    const level = () =>
      page.evaluate(() => {
        // A highlighted box is drawn a second time, above the others. That
        // copy is not counted.
        const visible = (el) =>
          !el.closest('.cj-layer-off') && !el.hasAttribute('data-copy');
        return {
          trail: Array.from(
            document.querySelectorAll('#stepbar [data-page]'),
          ).map((el) => el.textContent),
          boxes: Array.from(
            document.querySelectorAll('.world [data-cj="card"]'),
          )
            .filter(visible)
            .map((el) => el.getAttribute('data-node')),
          links: Array.from(
            document.querySelectorAll('.world [data-cj="edge"]'),
          ).filter(visible).length,
        };
      });
    let now = await level();
    check(
      now.trail.join() === 'Top' &&
        now.boxes.join() === 'cmd,orders,file' &&
        now.links === 2,
      `${engineName}: a map starts on its top level, with one arrow per pair of boxes that use each other`,
      JSON.stringify(now),
    );
    let [x, y] = await middleOf(page, '.v-orders');
    await page.mouse.dblclick(x, y);
    now = await level();
    check(
      now.trail.join() === 'Top,internal/orders' &&
        now.boxes.join() === 'handler,limiter,store' &&
        now.links === 2,
      `${engineName}: a double-click on a box that has parts inside opens its level`,
      JSON.stringify(now),
    );
    [x, y] = await middleOf(page, '.v-handler');
    await page.mouse.dblclick(x, y);
    now = await level();
    check(
      now.trail.join() === 'Top,internal/orders,handler.go' &&
        now.boxes.length === 7 &&
        now.boxes.includes('submit'),
      `${engineName}: the levels go down to the functions of a file`,
      JSON.stringify(now),
    );
    if (engineName === 'chromium')
      await page.screenshot({ path: path.join(out, 'view-map.png') });
    await page.locator('#stepbar [data-page]', { hasText: 'Top' }).click();
    check(
      (await level()).boxes.join() === 'cmd,orders,file',
      `${engineName}: a level in the bar goes back to it`,
    );
    // Selecting a node that is on another level opens that level.
    await page.evaluate(() => window.__cj.visual.select('allow'));
    now = await level();
    check(
      now.trail.join() === 'Top,internal/orders,limiter.go' &&
        (await page.locator('.cj-lift .cj-selected').count()) === 1,
      `${engineName}: selecting a node from outside opens the level it is on`,
      JSON.stringify(now),
    );
    check(errors.length === 0, `${engineName}: map logs no errors`, errors[0]);
    await context.close();
  }

  if (engineName === 'chromium') {
    // ---- what the builder refuses
    const change = (name, label, edit) => {
      const dir = copySources(referenceView(name), 'view-bad-' + label);
      const file = path.join(dir, 'view.json');
      const data = JSON.parse(readFileSync(file, 'utf8'));
      edit(data, dir);
      writeFileSync(file, JSON.stringify(data));
      return tryBuild(dir, 'view-bad-' + label);
    };
    const cases = [
      [
        'a relation to a type that is not there is refused',
        () =>
          change('schema', 'relation', (data) => {
            data.relations[0].to = 'Nowhere';
          }),
        /relation 0: "to" names "Nowhere", which is not the id of a node/,
      ],
      [
        'a use of a field that the type does not have is refused',
        () =>
          change('schema', 'use', (data) => {
            data.uses[0].field = 'Missing';
          }),
        /use 0 names the field "Missing", which "Order" does not have/,
      ],
      [
        'a message to a participant that is not there is refused',
        () =>
          change('lanes', 'step', (data) => {
            data.scenarios[0].steps[1].to = 'nobody';
          }),
        /scenario "queued", step 1: "to" names "nobody"/,
      ],
      [
        'a map node that is inside itself is refused',
        () =>
          change('map', 'loop', (data) => {
            data.nodes.find((node) => node.id === 'orders').parent = 'handler';
          }),
        /node "(orders|handler)" is inside itself/,
      ],
      [
        'a map level with too many boxes is refused, with the advice to group them',
        () =>
          change('map', 'crowded', (data) => {
            for (let i = 0; i < 12; i++)
              data.nodes.push({
                id: 'extra' + i,
                label: 'extra ' + i,
                kind: 'file',
                role: 'One more file.',
              });
          }),
        /the top level holds 15 nodes; .* at most 12\. Group related nodes/,
      ],
      [
        'a structure view without its step function is refused',
        () =>
          change('structure', 'nosim', (data, dir) => {
            rmSync(path.join(dir, 'sim.js'));
          }),
        /sim\.js: error \[missing-file\] a structure view is stepped through/,
      ],
      [
        'a view of an unknown kind is refused, with the kinds there are',
        () =>
          change('map', 'kind', (data) => {
            data.view = 'graph';
          }),
        /"graph", which is not a view\. Set it to one of: schema, lanes/,
      ],
    ];
    for (const [name, run, expected] of cases) {
      const result = run();
      check(
        !result.ok && expected.test(result.stderr),
        name,
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
console.log('The four views work. Pictures are in ' + out);
