// Checks that the legend card of a film stays inside the stage whatever the
// length of its rows. A row that fits is drawn on one line. A row that is too
// long for the stage wraps onto more lines.
//
// Each case changes the legend in a copy of the reference film, builds the
// copy and measures the card at the start of the film, where it is shown.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { build, copySources, openArtifact, referenceFilm } from './lib.mjs';

// The stage is this wide, and a card keeps this much room to its right edge.
const STAGE_WIDTH = 1920;
const MARGIN = 48;

const LONG_ROW =
  'An order · gains a mark in <code>Submit</code>, in ' +
  '<code>process</code>, in <code>enqueue</code>, in ' +
  '<code>flushLocked</code> and once more when ' +
  '<code>Store.WriteBatch</code> has written its batch to the file';

let failed = 0;
const check = (ok, name, detail) => {
  if (!ok) failed++;
  console.log(
    (ok ? 'ok    ' : 'FAIL  ') +
      name +
      (ok || !detail ? '' : '\n      ' + detail),
  );
};

const browser = await chromium.launch();

// Builds the reference film after `change` has edited its film.json, and
// returns the box of the legend card and, for each row, how many lines its
// text takes and whether any of the text is cut off.
const measure = async (name, change) => {
  const dir = copySources(referenceFilm, 'legend-' + name);
  const file = path.join(dir, 'film.json');
  const film = JSON.parse(readFileSync(file, 'utf8'));
  change(film);
  writeFileSync(file, JSON.stringify(film, null, 2));
  const { page, context } = await openArtifact(
    browser,
    build(dir, 'legend-' + name),
  );
  const found = await page.evaluate(() => {
    const card = document.querySelector('.cj-legend');
    const stage = card.closest('.ground').getBoundingClientRect();
    const box = card.getBoundingClientRect();
    return {
      left: box.left - stage.left,
      right: box.right - stage.left,
      rows: Array.from(card.querySelectorAll('.cj-legend-row .sub')).map(
        (text) => ({
          // One line of text is about 1.3 times as tall as the font size.
          lines: Math.round(
            text.getBoundingClientRect().height /
              (1.3 * parseFloat(getComputedStyle(text).fontSize)),
          ),
          cut: text.scrollWidth > text.clientWidth + 1,
        }),
      ),
    };
  });
  await context.close();
  return found;
};

const inside = (card) =>
  card.left >= 0 && card.right <= STAGE_WIDTH - MARGIN + 0.5;

const short = await measure('short', () => {});
check(
  inside(short) && short.rows.every((row) => row.lines === 1 && !row.cut),
  'a legend with short rows is drawn with one line per row',
  JSON.stringify(short),
);

const placed = await measure('placed', (film) => {
  film.legend[0].html = LONG_ROW;
  film.legendAt = [560, 250];
});
check(
  inside(placed) && placed.rows[0].lines > 1 && !placed.rows[0].cut,
  'a long row of a card placed with legendAt wraps inside the stage',
  JSON.stringify(placed),
);

const centred = await measure('centred', (film) => {
  film.legend[0].html = LONG_ROW;
});
check(
  inside(centred) &&
    centred.left >= MARGIN - 0.5 &&
    centred.rows[0].lines > 1 &&
    !centred.rows[0].cut,
  'a long row of a centred card wraps inside the stage',
  JSON.stringify(centred),
);

check(
  Math.abs(short.left + short.right - STAGE_WIDTH) < 1,
  'a centred card with short rows sits in the middle of the stage',
  JSON.stringify(short),
);

await browser.close();
if (failed) {
  console.error(`${failed} check(s) failed.`);
  process.exit(1);
}
console.log('The legend card stays inside the stage.');
