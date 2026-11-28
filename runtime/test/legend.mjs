// Checks that the legend card of a film stays inside the stage whatever the
// length of its rows. A row that fits is drawn on one line. A row that is too
// long for the stage wraps onto more lines.
//
// Also checks the legend strip of a film: the row under the frame that shows
// the packets and their short names for the whole film.
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

// The legend strip. It is a row under the frame, it is there at the start of
// the film and long after the legend card has gone, and the single frame
// that `?poster=1` draws has none.
const stripOf = (page) =>
  page.evaluate(() => {
    const strip = document.getElementById('legendbar');
    if (!strip) return null;
    const box = strip.getBoundingClientRect();
    const frame = document.getElementById('frame').getBoundingClientRect();
    const card = document.querySelector('.cj-legend');
    return {
      labels: Array.from(strip.querySelectorAll('.cj-key-label')).map(
        (label) => label.textContent,
      ),
      underFrame: Math.abs(box.top - frame.bottom) < 1,
      atPageEnd: Math.abs(box.bottom - window.innerHeight) < 1,
      frameHeight: frame.height,
      // Whether the legend card of the first scene can be seen.
      cardShown:
        !!card &&
        card.getClientRects().length > 0 &&
        Number(getComputedStyle(card).opacity) > 0.01,
    };
  });
const film = build(referenceFilm, 'legend-strip');
const opened = await openArtifact(browser, film);
const atStart = await stripOf(opened.page);
await opened.page.evaluate(() => window.__cj.seek(40));
const later = await stripOf(opened.page);
check(
  atStart &&
    atStart.labels.join() === 'An order,The batch' &&
    atStart.underFrame &&
    atStart.atPageEnd &&
    atStart.cardShown &&
    atStart.frameHeight === 1080,
  'a film has the legend strip as a row under its frame',
  JSON.stringify(atStart),
);
check(
  later &&
    later.labels.join() === 'An order,The batch' &&
    later.underFrame &&
    !later.cardShown,
  'the legend strip is still there after the legend card has gone',
  JSON.stringify(later),
);
await opened.context.close();
const poster = await openArtifact(browser, film, '?embed=1&poster=1');
check(
  (await stripOf(poster.page)) === null,
  'the single frame of a film for the library has no legend strip',
);
await poster.context.close();

await browser.close();
if (failed) {
  console.error(`${failed} check(s) failed.`);
  process.exit(1);
}
console.log('The legend card and the legend strip are drawn as they should.');
