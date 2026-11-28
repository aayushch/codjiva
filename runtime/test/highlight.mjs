// Checks what a visual shows when a part is highlighted.
//   - The part under the pointer has a glowing frame around it, and nothing
//     is dimmed.
//   - A click selects a part. The drawing is dimmed, and the part is drawn
//     bright above the dimmed drawing together with everything that is drawn
//     inside it, such as the labels on a machine.
//   - While a part is selected, the part under the pointer is drawn bright
//     above the dimmed drawing in the same way.
// A box inside a machine that has a node of its own can be selected by
// itself.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { build, copySources, openArtifact, referenceVisual } from './lib.mjs';

let failed = 0;
const check = (ok, name, detail) => {
  if (!ok) failed++;
  console.log(
    (ok ? 'ok    ' : 'FAIL  ') +
      name +
      (ok || !detail ? '' : '\n      ' + detail),
  );
};

// The reference visual with one more plate, drawn inside the `process`
// machine, and a node for that plate.
const dir = copySources(referenceVisual, 'highlight');
const plantFile = path.join(dir, 'plant.js');
const plant = readFileSync(plantFile, 'utf8');
const labels = "CJ.label('Store', 1480, 952);";
if (!plant.includes(labels))
  throw new Error('plant.js: the place to add the plate was not found');
writeFileSync(
  plantFile,
  plant.replace(
    labels,
    "CJ.label('Store', 1480, 952) + CJ.plate('stamp()', 520, 696, c('inner'));",
  ),
);
const visualFile = path.join(dir, 'visual.json');
const visual = JSON.parse(readFileSync(visualFile, 'utf8'));
visual.nodes.push({
  id: 'inner',
  label: 'stamp()',
  role: 'The last of the three steps',
  refs: [{ path: 'internal/orders/handler.go', line: 190 }],
  select: ['inner'],
});
writeFileSync(visualFile, JSON.stringify(visual, null, 2));

const browser = await chromium.launch();
const { page, errors } = await openArtifact(browser, build(dir, 'highlight'));

// What is drawn above the dimmed drawing: the names of the bright copies of
// the hovered and the selected node, and the text of the copied labels.
const lifted = () =>
  page.evaluate(() => {
    const names = (cls) =>
      Array.from(
        document.querySelectorAll(`.cj-lift .${cls}, .cj-lift-html .${cls}`),
      ).map((el) => el.getAttribute('data-node'));
    return {
      hover: names('cj-hover'),
      // The parts that have the glowing frame of the pointer around them.
      glow: Array.from(document.querySelectorAll('.cj-glow-ring'))
        .filter((ring) => ring.style.display !== 'none')
        .map((ring) => ring.getAttribute('data-node')),
      selected: names('cj-selected'),
      words: Array.from(document.querySelectorAll('.cj-lift-html > *')).map(
        (el) => el.textContent,
      ),
      dimmed: Number(document.querySelector('.cj-veil').style.opacity) > 0,
    };
  });

// A point inside a machine, near its lower left corner, where nothing is
// drawn on it.
const cornerOf = async (name) => {
  const box = await page
    .locator('.world .v-' + name)
    .first()
    .boundingBox();
  return { x: box.x + 14, y: box.y + box.height - 14 };
};

const loop = await cornerOf('flushloop');
await page.mouse.move(loop.x, loop.y);
const hovered = await lifted();
check(
  !hovered.dimmed &&
    hovered.glow.length > 0 &&
    hovered.glow.every((name) => name === 'flushloop') &&
    hovered.hover.length === 0 &&
    hovered.words.length === 0,
  'a hovered machine has a glowing frame, and the drawing is not dimmed',
  JSON.stringify(hovered),
);

const process = await cornerOf('process');
await page.mouse.click(process.x + 200, process.y);
const outer = await lifted();
check(
  outer.selected.join() === 'process' && outer.words.includes('stamp()'),
  'a selected machine shows the box that is drawn inside it',
  JSON.stringify(outer),
);
check(
  outer.dimmed && outer.glow.length === 0,
  'a click dims the drawing around the selected machine',
  JSON.stringify(outer),
);

// While a machine is selected, the machine under the pointer is drawn bright
// above the dimmed drawing, with the labels that are on it.
await page.mouse.move(loop.x, loop.y);
const beside = await lifted();
check(
  beside.dimmed &&
    beside.hover.join() === 'flushloop' &&
    beside.glow.length === 0 &&
    beside.words.some((text) => text.includes('releaseDeferred()')),
  'beside a selected machine, a hovered machine is drawn bright with the labels that are on it',
  JSON.stringify(beside),
);
check(
  !beside.words.some((text) => text.includes('Store')),
  'a label outside both machines stays dimmed',
  JSON.stringify(beside.words),
);

const plate = await page.locator('.world > .v-inner').boundingBox();
await page.mouse.click(plate.x + plate.width / 2, plate.y + plate.height / 2);
const inner = await lifted();
check(
  inner.selected.join() === 'inner' && inner.words.join() === 'stamp()',
  'a click on a box inside a machine selects that box, not the machine',
  JSON.stringify(inner),
);

// With the labels layer off, the labels of a highlighted machine stay off.
await page.evaluate(() => window.__cj.visual.setLayers({ labels: false }));
await page.mouse.click(loop.x, loop.y);
const withoutLabels = await lifted();
check(
  withoutLabels.selected.join() === 'flushloop' &&
    (await page
      .locator('.cj-lift-html > *')
      .evaluateAll((els) =>
        els.every((el) => getComputedStyle(el).display === 'none'),
      )),
  'labels of a layer that is switched off are not shown with the machine',
  JSON.stringify(withoutLabels),
);

check(errors.length === 0, 'the page logs no errors', errors.join(' | '));
await browser.close();
if (failed) {
  console.error(`${failed} check(s) failed.`);
  process.exit(1);
}
console.log('Highlighting keeps what is inside a part visible.');
