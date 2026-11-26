// Checks that a label can be read while a packet is under it. A packet is
// drawn below the labels. The letters of a label that lie over a filled packet
// are drawn in the ground colour, and the other letters keep the label's own
// colour.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import {
  build,
  copySources,
  openArtifact,
  referenceFilm,
  referenceVisual,
} from './lib.mjs';

let failed = 0;
const check = (ok, name, detail) => {
  if (!ok) failed++;
  console.log(
    (ok ? 'ok    ' : 'FAIL  ') +
      name +
      (ok || !detail ? '' : '\n      ' + detail),
  );
};

// Adds one amber label to the plant in `dir`, after the plant's last label.
// The label's text is `text`, its top left corner is `x, y`, and its class is
// `c(name)`.
const addLabel = (dir, text, x, y, name) => {
  const file = path.join(dir, 'plant.js');
  const plant = readFileSync(file, 'utf8');
  const last = "CJ.label('Store', 1480, 952);";
  if (!plant.includes(last))
    throw new Error('plant.js: the place to add the label was not found');
  writeFileSync(
    file,
    plant.replace(
      last,
      last.slice(0, -1) +
        ` + CJ.label('${text}', ${x}, ${y}, { cls: c('${name}'), color: 'var(--main)' });`,
    ),
  );
};

// What the runtime did to the label `selector`: whether it has the class
// `cj-over`, and the place and size of the dark rectangles of its background.
const lookOf = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return {
      over: el.classList.contains('cj-over'),
      position: el.style.backgroundPosition,
      size: el.style.backgroundSize,
      fill: getComputedStyle(el).webkitTextFillColor,
    };
  }, selector);

const browser = await chromium.launch();

// ---- a visual: the label "checked" lies half over the packet that rests at
// 870, 560. The packet covers 840 to 900 across and 538 to 582 down. The
// label starts at 852, 549.
const visualDir = copySources(referenceVisual, 'labels-visual');
addLabel(visualDir, 'checked', 852, 549, 'over');
const visual = await openArtifact(browser, build(visualDir, 'labels-visual'));
const page = visual.page;

// True when the first two numbers in `text` are `a` and `b`, to within half
// a pixel.
const startsWith = (text, a, b) => {
  const found = (text.match(/-?[\d.]+/g) || []).map(Number);
  return Math.abs(found[0] - a) <= 0.5 && Math.abs(found[1] - b) <= 0.5;
};

const resting = await lookOf(page, '.v-over');
check(
  resting.over &&
    startsWith(resting.position, -12, -11) &&
    startsWith(resting.size, 60, 44) &&
    resting.fill === 'rgba(0, 0, 0, 0)',
  'a label over a resting packet has a dark rectangle where the packet is',
  JSON.stringify(resting),
);
const untouched = await page.evaluate(
  () => document.querySelectorAll('.world .pl.cj-over').length,
);
check(
  untouched === 1,
  'a label that is not over a packet keeps its look',
  `${untouched} labels have the class`,
);

// The number of dark pixels in the part of the label that is over the packet.
// The letters are the only dark thing there that the class changes.
const darkPixels = async () => {
  const box = await page.locator('.v-over').boundingBox();
  const packet = await page.locator('.v-mp-b > rect').first().boundingBox();
  const clip = {
    x: box.x,
    y: box.y,
    width: packet.x + packet.width - box.x,
    height: box.height,
  };
  const png = PNG.sync.read(await page.screenshot({ clip }));
  let dark = 0;
  for (let i = 0; i < png.data.length; i += 4)
    if (png.data[i] < 70 && png.data[i + 1] < 70 && png.data[i + 2] < 80)
      dark++;
  return dark;
};
const darkWith = await darkPixels();
// The same label without what the runtime did to it: the whole label in its
// own colour. The packet's own marks are the dark pixels that are left.
await page.evaluate(() => {
  const el = document.querySelector('.v-over');
  el.dataset.kept = el.getAttribute('style');
  el.classList.remove('cj-over');
  el.style.backgroundImage = '';
});
const darkWithout = await darkPixels();
await page.evaluate(() => {
  const el = document.querySelector('.v-over');
  el.setAttribute('style', el.dataset.kept);
  delete el.dataset.kept;
  el.classList.add('cj-over');
});
// The dark letters add about 90 dark pixels in Chromium on macOS and about
// 60 on Linux, which draws the letters thinner. When the letters are not
// drawn dark, the two counts are the same.
check(
  darkWith > darkWithout + 30,
  'the letters over the packet are drawn dark',
  `${darkWith} dark pixels with the two colours, ${darkWithout} without them`,
);

await page.evaluate(() => window.__cj.visual.zoomBy(1.5));
const zoomed = await lookOf(page, '.v-over');
check(
  zoomed.over &&
    zoomed.position === resting.position &&
    zoomed.size === resting.size,
  'zooming leaves the dark rectangle on the packet',
  JSON.stringify(zoomed),
);

await page.evaluate(() => window.__cj.visual.setLayers({ data: false }));
const hidden = await lookOf(page, '.v-over');
check(
  !hidden.over && hidden.position === '' && hidden.fill !== 'rgba(0, 0, 0, 0)',
  'with the packet hidden the label has its own colour again',
  JSON.stringify(hidden),
);
await page.evaluate(() => window.__cj.visual.setLayers({ data: true }));
check(
  (await lookOf(page, '.v-over')).over,
  'with the packet shown again the label is dark over it again',
);
check(
  visual.errors.length === 0,
  'the visual logs no errors',
  visual.errors.join(' | '),
);
await visual.context.close();

// ---- a film: in the first chapter one packet travels along the line at
// height 560 and passes under the label "passing" at 700, 549.
const filmDir = copySources(referenceFilm, 'labels-film');
addLabel(filmDir, 'passing', 700, 549, 'passing');
const film = await openArtifact(browser, build(filmDir, 'labels-film'));
// For every 50th of a second of the first chapter: null when the label has
// its own look, otherwise how far the left edge of the dark rectangle is from
// the left edge of the label, in pixels.
const passes = await film.page.evaluate(() => {
  const seen = [];
  const film = window.__cj.film;
  for (let x = 0; x < film.duration && film.sceneAt(x) === 0; x += 0.02) {
    window.__cj.seek(x);
    const el = document.querySelector('.overview-passing');
    seen.push(
      el.classList.contains('cj-over')
        ? parseFloat(el.style.backgroundPosition)
        : null,
    );
  }
  return seen;
});
const first = passes.findIndex((at) => at != null);
const last = passes.findLastIndex((at) => at != null);
const during = passes.slice(first, last + 1);
check(
  first > 0 &&
    last < passes.length - 1 &&
    during.length > 3 &&
    during.every((at) => at != null),
  'the label is dark only while the packet is under it',
  `samples ${first} to ${last} of ${passes.length}`,
);
check(
  during.every((at, i) => i === 0 || at > during[i - 1]) &&
    during[0] < 0 &&
    during[during.length - 1] > 0,
  'the dark rectangle moves across the label with the packet',
  JSON.stringify(during),
);
check(
  film.errors.length === 0,
  'the film logs no errors',
  film.errors.join(' | '),
);

await browser.close();
if (failed) {
  console.error(`${failed} check(s) failed.`);
  process.exit(1);
}
console.log('A label over a packet can be read.');
