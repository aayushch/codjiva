// Builds the parts sheet, which draws every form of packet in every kind, the
// cursor and the frame, and checks it in Chromium, Firefox and WebKit:
//
//   - Every packet has the same 60 x 44 outline, whatever its form.
//   - Every tag is set in the stage font and lies inside its packet.
//   - `CJ.packet.tag` changes a tag, and refuses a packet without one.
//   - The legend card draws each row in the form the row names.
//   - The self-test reports a label that crosses the edge of a frame.
//
// It also saves pictures of the sheet in out/, for a person to judge the look
// of the parts: `parts-sheet.png` at the size of the stage and
// `parts-sheet-close.png` at twice that size.
//
// `CJ` is the runtime's global object in the page under test. The functions
// passed to `page.evaluate` run in that page, where it exists.
/* global CJ */
import { chromium, firefox, webkit } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  build,
  copySources,
  here,
  openArtifact,
  out,
  runSelfTest,
} from './lib.mjs';

const sheet = path.join(here, 'parts-sheet');
const file = build(sheet, 'parts-sheet');

let failed = 0;
const check = (ok, name, detail) => {
  if (!ok) failed++;
  console.log(
    (ok ? 'ok    ' : 'FAIL  ') +
      name +
      (ok || !detail ? '' : '\n      ' + detail),
  );
};

for (const [name, engine] of [
  ['chromium', chromium],
  ['firefox', firefox],
  ['webkit', webkit],
]) {
  const browser = await engine.launch();
  const { page, errors, context } = await openArtifact(browser, file);

  // The outline of a packet is the first element of its group. getBBox gives
  // its size in the packet's own units, before the camera scales it.
  const outlines = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.world [data-cj="packet"]')).map(
      (el) => {
        const box = el.firstElementChild.getBBox();
        return {
          look:
            (el.getAttribute('data-form') || 'crate') +
            ' ' +
            el.getAttribute('data-kind'),
          size: [box.x, box.y, box.width, box.height].map(
            (v) => Math.round(v * 10) / 10,
          ),
        };
      },
    ),
  );
  const wrong = outlines.filter((o) => o.size.join() !== '-30,-22,60,44');
  check(
    outlines.length >= 38 && wrong.length === 0,
    `${name}: every packet has the same 60 x 44 outline`,
    JSON.stringify(wrong.slice(0, 4)),
  );

  // A tag must lie inside the outline of its packet with at least 2 px to
  // spare on each side, and must be set in the stage font, in which every
  // character of 15 px text is 9 px wide.
  //
  // The width of a tag is the distance its characters advance, which every
  // engine reports alike. The tag is centred on its `x` attribute. Its top
  // and bottom come from getBBox.
  const tags = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.world .cj-tag')).map((el) => {
      const outline = el.parentElement.firstElementChild.getBBox();
      const box = el.getBBox();
      const width = el.getComputedTextLength();
      const left = Number(el.getAttribute('x')) - width / 2;
      return {
        text: el.textContent,
        form: el.parentElement.getAttribute('data-form'),
        font: getComputedStyle(el).fontFamily,
        width: Math.round(width * 10) / 10,
        spare: [
          left - outline.x,
          box.y - outline.y,
          outline.x + outline.width - (left + width),
          outline.y + outline.height - (box.y + box.height),
        ].map((v) => Math.round(v * 10) / 10),
      };
    }),
  );
  const badTags = tags.filter(
    (tag) =>
      !/^["']?JetBrains Mono/.test(tag.font) ||
      Math.abs(tag.width - 9 * tag.text.length) > 1 ||
      tag.spare.some((v) => v < 2),
  );
  check(
    tags.length >= 20 && badTags.length === 0,
    `${name}: every tag is in the stage font and inside its packet`,
    JSON.stringify(badTags.slice(0, 4)),
  );

  const changed = await page.evaluate(() => {
    const result = {};
    const tagged = document.querySelector('.v-count');
    CJ.packet.tag(tagged, '4');
    result.text = tagged.querySelector('.cj-tag').textContent;
    try {
      CJ.packet.tag(tagged, 'four');
      result.long = 'no error';
    } catch (e) {
      result.long = e.message;
    }
    try {
      CJ.packet.tag(document.querySelector('.v-row'), '1');
      result.untagged = 'no error';
    } catch (e) {
      result.untagged = e.message;
    }
    CJ.packet.tag(tagged, '3');
    return result;
  });
  check(
    changed.text === '4' &&
      /at most 3/.test(changed.long) &&
      /drawn without a tag/.test(changed.untagged),
    `${name}: CJ.packet.tag changes a tag and says why it cannot`,
    JSON.stringify(changed),
  );

  // The legend strip of a visual: one key for each row of the legend, in
  // the lower left corner of the frame. A row with a `label` is named by it.
  // A row without one is named by the start of its `html`.
  const legend = await page.evaluate(() => {
    const strip = document.getElementById('legendbar');
    const rows = Array.from(
      strip.querySelectorAll('.cj-key > svg [data-cj="packet"]'),
    ).map(
      (el) => el.getAttribute('data-form') + ' ' + el.getAttribute('data-kind'),
    );
    const box = strip.getBoundingClientRect();
    const frame = document.getElementById('frame').getBoundingClientRect();
    return {
      rows,
      labels: Array.from(strip.querySelectorAll('.cj-key-label')).map(
        (label) => label.textContent,
      ),
      cut: Array.from(strip.querySelectorAll('.cj-key-label')).some(
        (label) => label.scrollWidth > label.clientWidth + 1,
      ),
      inside:
        box.left >= frame.left &&
        box.right <= frame.right &&
        box.top >= frame.top &&
        box.bottom <= frame.bottom,
      cards: strip.querySelectorAll('.cj-key-card').length,
      cardsShown: Array.from(strip.querySelectorAll('.cj-key-card')).filter(
        (card) => getComputedStyle(card).visibility === 'visible',
      ).length,
    };
  });
  check(
    legend.rows.join() ===
      'element primary,element secondary,element transient,' +
        'record secondary,record transient,value primary' &&
      legend.inside &&
      !legend.cut,
    `${name}: the legend strip draws each row in its form, and six rows fit`,
    JSON.stringify(legend),
  );
  check(
    legend.labels.join() ===
      'A menu item,The More item,A passing item,A table row,A copied row,A number',
    `${name}: a key is named by its label, or by the start of its text`,
    legend.labels.join(),
  );
  // The card of a key is shown while the pointer is over the key, and it
  // has the whole text of the row.
  const lastKey = page.locator('#legendbar .cj-key').last();
  await lastKey.hover();
  const card = await lastKey.locator('.cj-key-card').evaluate((el) => {
    const box = el.getBoundingClientRect();
    return {
      shown: getComputedStyle(el).visibility === 'visible',
      text: el.textContent,
      inside: box.left >= 0 && box.right <= window.innerWidth && box.top >= 0,
    };
  });
  check(
    legend.cards === 6 &&
      legend.cardsShown === 0 &&
      card.shown &&
      card.inside &&
      card.text === 'A number · count, with its value written on it',
    `${name}: the card of a key shows the whole row while the pointer is on it`,
    JSON.stringify({ legend, card }),
  );
  if (name === 'chromium')
    await page.screenshot({ path: path.join(out, 'parts-sheet-legend.png') });
  await page.mouse.move(960, 300);

  const report = await runSelfTest(page);
  const unexpected = report.issues.filter(
    (i) => i.severity === 'error' || i.check !== 'legend',
  );
  check(
    report.ok && unexpected.length === 0,
    `${name}: the self-test reports nothing but the looks the legend leaves out`,
    JSON.stringify(unexpected.slice(0, 4)),
  );
  check(
    report.issues.some(
      (i) =>
        i.check === 'legend' && /form "key" and kind "primary"/.test(i.message),
    ) && !report.issues.some((i) => /form "element"/.test(i.message || '')),
    `${name}: a look without a legend row is reported, a listed one is not`,
  );
  check(
    errors.length === 0,
    `${name}: the page logs no errors`,
    errors.join(' | '),
  );

  if (name === 'chromium')
    await page.screenshot({ path: path.join(out, 'parts-sheet.png') });
  await context.close();

  if (name === 'chromium') {
    const close = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 2,
    });
    const closePage = await close.newPage();
    await closePage.goto('file://' + file + '?embed=1');
    await closePage.waitForFunction(
      () => document.body.classList.contains('ready') && !!window.__cj,
    );
    await closePage.screenshot({
      path: path.join(out, 'parts-sheet-close.png'),
    });
    await close.close();

    // A label that crosses the edge of the frame is an error, as it is for a
    // machine.
    const dir = copySources(sheet, 'parts-frame-label');
    const plant = path.join(dir, 'plant.js');
    const text = readFileSync(plant, 'utf8');
    const from = "'a frame: a region of the screen', 1090, 400";
    if (!text.includes(from))
      throw new Error('plant.js: the label to move was not found');
    writeFileSync(
      plant,
      text.replace(from, "'a frame: a region of the screen', 1090, 440"),
    );
    const moved = await openArtifact(browser, build(dir, 'parts-frame-label'));
    const issues = (await runSelfTest(moved.page)).issues;
    check(
      issues.some(
        (i) =>
          i.check === 'text-overlap' &&
          i.b &&
          i.b.selector === '.v-frame' &&
          /edge of a frame/.test(i.hint),
      ),
      'a label that crosses the edge of a frame is reported as text-overlap',
      JSON.stringify(issues.filter((i) => i.severity === 'error').slice(0, 3)),
    );
    await moved.context.close();
  }
  await browser.close();
}

if (failed) {
  console.error(failed + ' check(s) failed');
  process.exit(1);
}
console.log('The parts are drawn as specified. Pictures are in ' + out);
