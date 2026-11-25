// Opens the built reference film and the built reference visual in Chromium,
// Firefox and WebKit with the network switched off, and checks that each one
// starts, logs no errors, passes its self-test and responds to the controls a
// viewer uses.
import { chromium, firefox, webkit } from 'playwright';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, referenceFilm, referenceVisual } from './lib.mjs';

const filmFile = build(referenceFilm, 'film');
const visualFile = build(referenceVisual, 'visual');

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
  const context = await browser.newContext({
    viewport: { width: 1600, height: 960 },
    offline: true,
  });
  const requests = [];
  context.on('request', (r) => {
    if (!r.url().startsWith('file:')) requests.push(r.url());
  });

  // ---- film, standalone, as a viewer opens the exported file
  let page = await context.newPage();
  let errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(pathToFileURL(filmFile).href);
  await page.waitForFunction(
    () => document.body.classList.contains('ready') && !!window.__cj,
    null,
    { timeout: 30000 },
  );
  check(
    await page.locator('#controls').isVisible(),
    `${name}: film shows its own player bar`,
  );
  check(
    await page.evaluate(() => document.fonts.check('18px "JetBrains Mono"')),
    `${name}: the embedded font is loaded`,
  );
  await page.keyboard.press('Space');
  await page.waitForTimeout(700);
  const playing = await page.evaluate(
    () => document.getElementById('play').dataset.state,
  );
  await page.keyboard.press('Space');
  const moved = await page.evaluate(() =>
    parseFloat(document.getElementById('fill').style.width),
  );
  check(
    playing === 'playing' && moved > 0,
    `${name}: Space plays and pauses, and the scrubber moves`,
    `state=${playing} fill=${moved}`,
  );
  await page.keyboard.press('PageDown');
  const chapter = await page.locator('#chapter').textContent();
  check(
    /^2 \/ 4/.test(chapter),
    `${name}: PageDown goes to the next chapter`,
    chapter,
  );
  await page.keyboard.press('m');
  check(
    (await page.evaluate(
      () => document.getElementById('mute').dataset.state,
    )) === 'on',
    `${name}: M turns sound on`,
  );
  await page.keyboard.press('m');
  const report = await page.evaluate(() => window.__cj.selfTest({}));
  check(
    report.ok,
    `${name}: film self-test has no errors`,
    JSON.stringify(
      report.issues.filter((i) => i.severity === 'error').slice(0, 3),
    ),
  );
  check(
    errors.length === 0,
    `${name}: film logs no errors`,
    errors.join(' | '),
  );
  await page.close();

  // ---- the same film asked for in the light palette
  page = await context.newPage();
  await page.goto(pathToFileURL(filmFile).href + '?theme=light');
  await page.waitForFunction(
    () => document.body.classList.contains('ready') && !!window.__cj,
    null,
    { timeout: 30000 },
  );
  const ground = await page.evaluate(() =>
    getComputedStyle(document.getElementById('stage'))
      .getPropertyValue('--ground')
      .trim(),
  );
  const lightReport = await page.evaluate(() => window.__cj.selfTest({}));
  check(
    ground.toUpperCase() === '#F7F5EF' && lightReport.ok,
    `${name}: with ?theme=light the film uses the light palette and still passes its self-test`,
    ground,
  );
  await page.close();

  // ---- still visual
  page = await context.newPage();
  errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(pathToFileURL(visualFile).href);
  await page.waitForFunction(
    () => document.body.classList.contains('ready') && !!window.__cj,
    null,
    { timeout: 30000 },
  );
  const centre = async (selector) => {
    const box = await page.locator(selector).first().boundingBox();
    return [box.x + box.width / 2, box.y + box.height / 2];
  };
  // Hover the Submit machine: it is copied above the veil with the hover
  // highlight.
  let [x, y] = await centre('.v-submit');
  // The machine is 220 sheet pixels wide, which gives the scale the sheet is
  // shown at.
  const scale =
    (await page.locator('.v-submit').first().boundingBox()).width / 220;
  await page.mouse.move(x, y);
  check(
    (await page.locator('.cj-lift .cj-hover').count()) === 1,
    `${name}: hovering a machine highlights it`,
  );
  check(
    await page
      .locator('.cj-tip')
      .evaluate((el) => el.textContent.includes('Submit()')),
    `${name}: hovering shows a tooltip with the name`,
  );
  await page.mouse.down();
  await page.mouse.up();
  check(
    (await page.locator('.cj-lift .cj-selected').count()) === 1,
    `${name}: clicking a machine selects it`,
  );
  // Clicking empty paper clears the selection. The sheet is empty 310 pixels to
  // the right of the machine's centre and 290 below it.
  await page.mouse.click(x + 310 * scale, y + 290 * scale);
  check(
    (await page.locator('.cj-lift .cj-selected').count()) === 0,
    `${name}: clicking empty paper clears the selection`,
  );
  // A marker opens its bubble.
  [x, y] = await centre('.cj-marker');
  await page.mouse.click(x, y);
  check(
    await page.locator('.v-bub0').evaluate((el) => el.style.opacity === '1'),
    `${name}: clicking a marker opens its bubble`,
  );
  // Layers. This pipe has a bend. A straight pipe has a box without width or
  // height, which a browser does not count as visible.
  const before = await page.locator('.v-pipe10').isVisible();
  await page.locator('#layers button', { hasText: 'data' }).click();
  check(
    before && !(await page.locator('.v-pipe10').isVisible()),
    `${name}: switching the data layer off hides the pipes`,
  );
  await page.locator('#layers button', { hasText: 'data' }).click();
  // The framing of the visual: how far the world is moved, and its scale.
  const framing = () =>
    page.locator('.world').evaluate((el) => {
      const [x, y, scale] = el.style.transform.match(/-?[\d.]+/g).map(Number);
      return { x, y, scale };
    });
  // Turns the wheel, with `key` held if one is given, and returns the
  // framing after it. The calls below follow each other without a pause, so
  // they also check that a key changes what the wheel does at once.
  const wheel = async (dx, dy, key) => {
    if (key) await page.keyboard.down(key);
    await page.mouse.wheel(dx, dy);
    if (key) await page.keyboard.up(key);
    await page.waitForTimeout(100);
    return framing();
  };
  const home = await framing();
  await page.mouse.move(800, 500);
  const wheeled = await wheel(120, 90);
  check(
    wheeled.scale === home.scale && wheeled.x < home.x && wheeled.y < home.y,
    `${name}: the wheel pans in both directions`,
    JSON.stringify([home, wheeled]),
  );
  const sideways = await wheel(0, 90, 'Shift');
  check(
    sideways.scale === wheeled.scale &&
      sideways.x < wheeled.x &&
      sideways.y === wheeled.y,
    `${name}: the wheel with Shift pans sideways`,
    JSON.stringify([wheeled, sideways]),
  );
  const zoomed = await wheel(0, -600, 'Control');
  check(
    zoomed.scale > sideways.scale,
    `${name}: the wheel with Control zooms in`,
    JSON.stringify([sideways, zoomed]),
  );
  const zoomedMore = await wheel(0, -600, 'Meta');
  check(
    zoomedMore.scale > zoomed.scale,
    `${name}: the wheel with Command zooms in`,
    JSON.stringify([zoomed, zoomedMore]),
  );
  // WebKit on macOS reports a pinch as gesture events. No browser lets a
  // test make a real pinch, so the events are made here, and they are sent
  // in every engine because the visual listens for them in every engine.
  const pinched = await page.locator('.view').evaluate((view) => {
    const send = (type, scale) =>
      view.dispatchEvent(
        Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
          scale,
          clientX: 800,
          clientY: 500,
        }),
      );
    send('gesturestart', 1);
    send('gesturechange', 0.8);
    send('gesturechange', 0.5);
    send('gestureend', 0.5);
    return document.querySelector('.world').style.transform;
  });
  const pinchedScale = Number(pinched.match(/scale\(([\d.]+)\)/)[1]);
  check(
    Math.abs(pinchedScale / zoomedMore.scale - 0.5) < 0.001,
    `${name}: a pinch to half the size halves the zoom`,
    `${zoomedMore.scale} | ${pinchedScale}`,
  );
  // Drag to pan, then Fit restores the default framing.
  const beforeDrag = await framing();
  await page.mouse.move(800, 500);
  await page.mouse.down();
  await page.mouse.move(700, 440, { steps: 4 });
  await page.mouse.up();
  const dragged = await framing();
  await page.locator('#fit').click();
  const fitted = await framing();
  check(
    dragged.scale === beforeDrag.scale &&
      dragged.x < beforeDrag.x &&
      dragged.y < beforeDrag.y &&
      JSON.stringify(fitted) === JSON.stringify(home),
    `${name}: drag pans, Fit restores the framing`,
    JSON.stringify([beforeDrag, dragged, fitted]),
  );
  const visualReport = await page.evaluate(() => window.__cj.selfTest({}));
  check(
    visualReport.ok,
    `${name}: visual self-test has no errors`,
    JSON.stringify(
      visualReport.issues.filter((i) => i.severity === 'error').slice(0, 4),
    ),
  );
  check(
    errors.length === 0,
    `${name}: visual logs no errors`,
    errors.join(' | '),
  );
  check(
    requests.length === 0,
    `${name}: no request leaves the page`,
    requests.join(' | '),
  );
  if (name === 'chromium')
    await page.screenshot({
      path: path.join(path.dirname(visualFile), 'visual-chromium.png'),
    });
  await browser.close();
}
if (failed) {
  console.error(failed + ' check(s) failed');
  process.exit(1);
}
console.log('All browsers pass.');
