// Checks how a rationale is shown. A rationale says why the code does what a
// bubble of a film or a node of a visual describes.
//
// In the film, a bubble with a rationale has a chip. A click on the chip
// pauses the film and opens the reason inside the bubble, which stays inside
// the view. Playing on closes it.
//
// In the visual, a node with a rationale has a "?" marker, which is hidden
// until the rationale layer is switched on. A click on the marker opens the
// reason in a bubble and selects the node.
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

// ---------------------------------------------------------------- film
{
  const { page, errors } = await openArtifact(
    browser,
    build(referenceFilm, 'rationale-film'),
    '',
  );
  // Moves the film to the first moment at which the first bubble of the
  // `flush` chapter is fully shown.
  const shown = await page.evaluate(() => {
    const scene = window.__cj.film.scenes.find((s) => s.meta.id === 'flush');
    for (let x = scene.start; x < scene.start + scene.duration; x += 0.25) {
      window.__cj.seek(x);
      const bubble = document.querySelector('.flush-bub0');
      if (Number(bubble.style.opacity) > 0.95) return x;
    }
    return null;
  });
  check(shown != null, 'the bubble with a rationale comes on screen', shown);

  const state = () =>
    page.evaluate(() => {
      const bubble = document.querySelector('.flush-bub0');
      const text = bubble.querySelector('.cj-why-text');
      const view = document.querySelector('.scene-box .view');
      const visible = Array.from(document.querySelectorAll('.view')).find(
        (el) => el.getBoundingClientRect().width > 0,
      );
      const frame = (visible || view).getBoundingClientRect();
      const box = bubble.getBoundingClientRect();
      return {
        open: bubble.classList.contains('cj-why-open'),
        text: getComputedStyle(text).display === 'none' ? '' : text.textContent,
        height: Math.round(box.height),
        inside:
          box.left >= frame.left &&
          box.right <= frame.right &&
          box.top >= frame.top &&
          box.bottom <= frame.bottom,
        playing: document.getElementById('play').dataset.state === 'playing',
      };
    });

  const closed = await state();
  check(
    !closed.open && closed.text === '',
    'the rationale is hidden until the chip is clicked',
    JSON.stringify(closed),
  );

  // The film is started, so that the click on the chip has something to
  // pause.
  await page.evaluate(() => document.getElementById('play').click());
  await page.locator('.flush-bub0 .cj-why-chip').click();
  const open = await state();
  check(
    open.open &&
      !open.playing &&
      /RATIONALE/.test(open.text) &&
      /the next flush writes it again/.test(open.text) &&
      /Stated in the code · handler\.go:257/.test(open.text),
    'a click on the chip pauses the film and shows the reason and where it comes from',
    JSON.stringify(open),
  );
  check(
    open.height > closed.height && open.inside,
    'the opened bubble is taller and still inside the view',
    JSON.stringify({
      closed: closed.height,
      open: open.height,
      in: open.inside,
    }),
  );

  await page.locator('.flush-bub0 .cj-why-chip').click();
  const again = await state();
  check(
    !again.open && !again.playing && again.height === closed.height,
    'a second click closes the rationale and leaves the film paused',
    JSON.stringify(again),
  );

  await page.locator('.flush-bub0 .cj-why-chip').click();
  await page.evaluate(() => document.getElementById('play').click());
  const playing = await state();
  check(
    !playing.open && playing.playing,
    'playing on closes an open rationale',
    JSON.stringify(playing),
  );
  check(errors.length === 0, 'the film logs no errors', errors.join(' | '));
  await page.context().close();
}

// ---------------------------------------------------------------- visual
{
  const { page, errors } = await openArtifact(
    browser,
    build(referenceVisual, 'rationale-visual'),
  );
  // The "?" markers that are shown, with the distance from each to the
  // nearest numbered marker.
  const whyMarkers = () =>
    page.evaluate(() => {
      const centre = (el) => {
        const r = el.getBoundingClientRect();
        return [r.left + r.width / 2, r.top + r.height / 2];
      };
      const numbered = Array.from(
        document.querySelectorAll('.cj-marker:not(.cj-why)'),
      ).map(centre);
      return Array.from(document.querySelectorAll('.cj-marker.cj-why'))
        .filter((el) => getComputedStyle(el).display !== 'none')
        .map((el) => {
          const [x, y] = centre(el);
          return {
            text: el.textContent,
            nearest: Math.round(
              Math.min(...numbered.map((n) => Math.hypot(n[0] - x, n[1] - y))),
            ),
          };
        });
    });

  check(
    (await whyMarkers()).length === 0,
    'the "?" markers are hidden when the visual opens',
  );
  const report = await runSelfTest(page);
  check(
    report.ok,
    'the visual passes its self-test, which opens every rationale bubble',
    JSON.stringify(report.issues.filter((i) => i.severity === 'error')),
  );

  await page.evaluate(() => window.__cj.visual.setRationale(true));
  const markers = await whyMarkers();
  check(
    markers.length === 4 && markers.every((m) => m.text === '?'),
    'switching the rationale layer on shows one "?" marker for each node that has a rationale',
    JSON.stringify(markers),
  );
  check(
    markers.every((m) => m.nearest >= 30),
    'no "?" marker lies on a numbered marker',
    JSON.stringify(markers),
  );

  // The marker of the node `flush`. Its bubble says why the batch is kept.
  const flushMarker = await page.evaluate(() => {
    const index = window.__cj.visual.markers.findIndex(
      (marker) => marker.why === 'flush',
    );
    const r = document
      .querySelectorAll('.cj-marker')
      [index].getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(flushMarker.x, flushMarker.y);
  const opened = await page.evaluate(() => {
    const bubble = Array.from(document.querySelectorAll('.bub')).find(
      (el) => Number(el.style.opacity) === 1,
    );
    return {
      bubble: bubble ? bubble.textContent : '',
      selected: Array.from(document.querySelectorAll('.cj-lift .cj-selected'))
        .map((el) => el.getAttribute('data-node'))
        .join(),
    };
  });
  check(
    /^RATIONALE · flushLocked\(\)/.test(opened.bubble) &&
      /the next flush writes it again/.test(opened.bubble) &&
      /Stated in the code · handler\.go:257/.test(opened.bubble),
    'a click on a "?" marker opens the reason in a bubble',
    opened.bubble,
  );
  check(
    opened.selected === 'flush',
    'the click also selects the node the marker belongs to',
    opened.selected,
  );

  await page.evaluate(() => window.__cj.visual.setRationale(false));
  const after = await page.evaluate(
    () =>
      Array.from(document.querySelectorAll('.bub')).filter(
        (el) => Number(el.style.opacity) === 1,
      ).length,
  );
  check(
    (await whyMarkers()).length === 0 && after === 0,
    'switching the layer off hides the markers and closes the open bubble',
  );
  check(errors.length === 0, 'the visual logs no errors', errors.join(' | '));
  await page.context().close();
}

await browser.close();
if (failed) {
  console.error(`${failed} check(s) failed.`);
  process.exit(1);
}
console.log('Rationales are shown when the viewer asks for them.');
