// Checks the notes that the app puts on a visual or a film after it was
// built.
//
// On a visual, a note is a numbered mark on a corner of its node. A click on
// the mark shows the note's text in a card, and a second click hides it. A
// note of the kind `emphasis` also has a frame around its node. A note on a
// node that does not exist is left out. Switching the notes off hides the
// marks and keeps the notes.
//
// On a film, a note is a card in the top right corner of the stage, shown
// for a few seconds from the note's time.
import { chromium } from 'playwright';
import {
  build,
  openArtifact,
  referenceFilm,
  referenceVisual,
  runSelfTest,
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

const browser = await chromium.launch();

// ---------------------------------------------------------------- visual
{
  const { page, errors } = await openArtifact(
    browser,
    build(referenceVisual, 'notes-visual'),
  );
  const ids = await page.evaluate(() =>
    window.__cj.visual.nodes
      .filter((entry) => entry.els.length)
      .map((entry) => entry.node.id),
  );
  check(
    ids.length >= 3,
    'the reference visual has three nodes to put notes on',
  );
  const list = [
    {
      id: 'a',
      n: 1,
      part: ids[0],
      kind: 'note',
      text: 'Reads <b>one</b> order.',
    },
    { id: 'b', n: 2, part: ids[1], kind: 'flag', text: 'Never reset.' },
    { id: 'c', n: 3, part: ids[2], kind: 'emphasis', text: '' },
    { id: 'd', n: 4, part: 'no-such-node', kind: 'note', text: 'Nowhere.' },
  ];
  const kept = await page.evaluate(
    (notes) => window.__cj.visual.setNotes(notes, true),
    list,
  );
  check(kept === 3, 'a note on a node that does not exist is left out', kept);

  // Where each mark is, and how far it is from the nearest corner of its
  // node and from the nearest other marker, in page pixels. The page is
  // shown at stage size, so a page pixel is a stage pixel.
  const measure = () =>
    page.evaluate(() => {
      const centre = (el) => {
        const box = el.getBoundingClientRect();
        return [box.left + box.width / 2, box.top + box.height / 2];
      };
      const marks = Array.from(document.querySelectorAll('.cj-note'));
      const others = Array.from(
        document.querySelectorAll('.cj-marker:not(.cj-layer-off)'),
      );
      return marks.map((mark) => {
        const at = centre(mark);
        const nearest = Math.min(
          ...others
            .filter((other) => other !== mark)
            .map((other) => {
              const to = centre(other);
              return Math.hypot(to[0] - at[0], to[1] - at[1]);
            }),
        );
        return {
          text: mark.textContent,
          cls: mark.className,
          shown: getComputedStyle(mark).display !== 'none',
          at,
          nearest,
        };
      });
    });
  const cornerDistance = (partIds) =>
    page.evaluate((parts) => {
      const visual = window.__cj.visual;
      const marks = Array.from(document.querySelectorAll('.cj-note'));
      return marks.map((mark, i) => {
        const box = mark.getBoundingClientRect();
        const at = [box.left + box.width / 2, box.top + box.height / 2];
        const entry = visual.nodes.find((one) => one.node.id === parts[i]);
        const host = entry.els[0].getBoundingClientRect();
        return Math.min(
          ...[
            [host.right, host.top],
            [host.left, host.top],
            [host.right, host.bottom],
            [host.left, host.bottom],
          ].map((corner) => Math.hypot(corner[0] - at[0], corner[1] - at[1])),
        );
      });
    }, partIds);

  const marks = await measure();
  check(
    marks.length === 3 &&
      marks.map((mark) => mark.text).join() === '1,2,3' &&
      marks.every((mark) => mark.shown),
    'each note has a numbered mark',
    JSON.stringify(marks),
  );
  check(
    / cj-flag/.test(marks[1].cls) && / cj-emphasis/.test(marks[2].cls),
    'the mark of a flag and of an emphasis has the class of its kind',
    JSON.stringify(marks.map((mark) => mark.cls)),
  );
  const onCorner = await cornerDistance(ids);
  check(
    onCorner.every((distance) => distance < 2),
    'each mark is on a corner of its node',
    JSON.stringify(onCorner),
  );
  const scale = await page.evaluate(
    () => document.querySelector('.world').getBoundingClientRect().width / 1920,
  );
  check(
    marks.every((mark) => mark.nearest >= 40 * scale - 1),
    'no mark is closer than 40 px to another marker',
    JSON.stringify(marks.map((mark) => Math.round(mark.nearest))),
  );

  const ring = await page.evaluate((part) => {
    const rings = document.querySelectorAll('.cj-note-ring');
    const entry = window.__cj.visual.nodes.find((one) => one.node.id === part);
    const host = entry.els[0].getBoundingClientRect();
    const box = rings[0] && rings[0].getBoundingClientRect();
    return {
      count: rings.length,
      around:
        !!box &&
        box.left < host.left &&
        box.top < host.top &&
        box.right > host.right &&
        box.bottom > host.bottom,
    };
  }, ids[2]);
  check(
    ring.count === 1 && ring.around,
    'a note of the kind emphasis has a frame around its node',
    JSON.stringify(ring),
  );

  const card = () =>
    page.evaluate(() => {
      const el = document.querySelector('.cj-note-card');
      const view = document.querySelector('.view').getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return {
        shown: getComputedStyle(el).display !== 'none',
        text: el.textContent,
        html: el.innerHTML,
        flag: el.classList.contains('cj-flag'),
        inside:
          box.left >= view.left &&
          box.right <= view.right &&
          box.top >= view.top &&
          box.bottom <= view.bottom,
      };
    });
  check(!(await card()).shown, 'no text is shown until a mark is clicked');
  await page.locator('.cj-note').first().click();
  const open = await card();
  check(
    open.shown &&
      open.text === 'NOTE 1Reads <b>one</b> order.' &&
      !/<b>/.test(open.html) &&
      open.inside,
    'a click on a mark shows the text of its note, as text, inside the view',
    JSON.stringify(open),
  );
  check(
    await page.evaluate(() =>
      document.querySelector('.cj-note').classList.contains('open'),
    ),
    'the mark of the open note is drawn as open',
  );
  await page.locator('.cj-note').first().click();
  check(!(await card()).shown, 'a second click hides the text');

  await page.evaluate(() => window.__cj.visual.showNote('b'));
  const flag = await card();
  check(
    flag.shown && flag.flag && flag.text === 'FLAG 2Never reset.',
    'the app can open a note by its id',
    JSON.stringify(flag),
  );
  await page.evaluate(() => window.__cj.visual.showNote('c'));
  check(!(await card()).shown, 'a note without a text opens no card');

  // Zooming and panning move the marks with their nodes.
  await page.evaluate(() => {
    window.__cj.visual.zoomBy(1.4);
    window.__cj.visual.panTo(1100, 600);
  });
  const zoomed = await cornerDistance(ids);
  check(
    zoomed.every((distance) => distance < 3),
    'the marks stay on their corners when the view is zoomed and moved',
    JSON.stringify(zoomed),
  );
  await page.evaluate(() => window.__cj.visual.fit());

  await page.evaluate(
    (notes) => window.__cj.visual.setNotes(notes, false),
    list,
  );
  const off = await measure();
  check(
    off.length === 3 && off.every((mark) => !mark.shown),
    'switching the notes off hides the marks and keeps the notes',
    JSON.stringify(off.map((mark) => mark.shown)),
  );

  await page.evaluate(() => window.__cj.visual.setNotes([], true));
  const none = await page.evaluate(
    () => document.querySelectorAll('.cj-note, .cj-note-ring').length,
  );
  check(none === 0, 'an empty list removes every mark and frame', none);

  // The notes change nothing the checks look at.
  await page.evaluate(
    (notes) => window.__cj.visual.setNotes(notes, true),
    list,
  );
  const report = await runSelfTest(page);
  check(
    report.issues.filter((issue) => issue.severity === 'error').length === 0,
    'the visual passes its self-test with notes on it',
    JSON.stringify(report.issues.slice(0, 3)),
  );
  check(errors.length === 0, 'the visual logged no errors', errors.join('\n'));
  await page.context().close();
}

// ---------------------------------------------------------------- film
{
  const { page, errors } = await openArtifact(
    browser,
    build(referenceFilm, 'notes-film'),
  );
  const list = [
    { id: 'x', n: 1, time: 5, kind: 'note', text: 'Watch the <i>gate</i>.' },
    { id: 'y', n: 2, time: 6, kind: 'flag', text: 'It never reopens.' },
    { id: 'z', n: 3, kind: 'note', text: 'No time.' },
  ];
  await page.evaluate((notes) => window.__cj.setNotes(notes, true), list);
  const cards = (at) =>
    page.evaluate((x) => {
      window.__cj.seek(x);
      const stage = document.getElementById('stage').getBoundingClientRect();
      const hud = document.querySelector('.hud').getBoundingClientRect();
      return Array.from(document.querySelectorAll('.cj-film-note')).map(
        (el) => {
          const box = el.getBoundingClientRect();
          return {
            text: el.textContent,
            html: el.innerHTML,
            flag: el.classList.contains('cj-flag'),
            inside:
              box.right <= stage.right &&
              box.left >= stage.left + stage.width / 2 &&
              box.top >= hud.bottom &&
              box.bottom <= stage.bottom,
          };
        },
      );
    }, at);
  check((await cards(4)).length === 0, 'a note is not shown before its time');
  const one = await cards(5.5);
  check(
    one.length === 1 &&
      one[0].text === 'NOTE 1Watch the <i>gate</i>.' &&
      !/<i>/.test(one[0].html) &&
      one[0].inside,
    'from its time a note is a card in the top right corner, below the title',
    JSON.stringify(one),
  );
  const two = await cards(6.5);
  check(
    two.length === 2 && two[1].flag && two.every((card) => card.inside),
    'two notes that are due together are both shown',
    JSON.stringify(two),
  );
  check(
    (await cards(12.5)).length === 1 && (await cards(13.5)).length === 0,
    'a note goes away seven seconds after its time',
  );
  await page.evaluate((notes) => window.__cj.setNotes(notes, false), list);
  check(
    (await cards(5.5)).length === 0,
    'switching the notes off shows no card',
  );
  check(errors.length === 0, 'the film logged no errors', errors.join('\n'));
  await page.context().close();
}

await browser.close();
if (failed) {
  console.log(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks of the notes pass.');
