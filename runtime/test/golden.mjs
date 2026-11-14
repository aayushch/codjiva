// Golden-frame test. Renders two versions of one film in the same browser at a list of times,
// and fails if any frame differs by more than the allowed share of pixels. One version is a
// finished HTML page made by hand before the runtime existed. The other is the same film
// written as artifact sources, built here with the builder. Equal frames show that the runtime
// draws what the hand-made page draws.
//
// The two versions are not part of the repository. The test runs only when both are named:
//
//   GOLDEN_ORIGINAL   path of the hand-made HTML page, which has a `window.__seek(t)` function
//   GOLDEN_SOURCES    path of the folder with the same film as artifact sources
//
// Without them the test prints a note and passes.
//
// Usage: node golden.mjs [--times 1,12,30] [--keep]
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const out = path.join(here, 'out');
mkdirSync(out, { recursive: true });

// The film times, in seconds, at which the two versions are compared.
const SPEC_TIMES = [1, 12, 30, 62, 75, 110, 125, 160, 200, 215, 228, 240, 262];
// A frame passes when fewer than this share of its pixels differ.
const MAX_DIFF = 0.005;

const args = process.argv.slice(2);
const timesArg = args.indexOf('--times');
const times = timesArg >= 0 ? args[timesArg + 1].split(',').map(Number) : SPEC_TIMES;

const original = process.env.GOLDEN_ORIGINAL;
const sources = process.env.GOLDEN_SOURCES;
if (!original || !sources) {
  console.log('Golden frames skipped: GOLDEN_ORIGINAL and GOLDEN_SOURCES are not set.');
  process.exit(0);
}
const built = path.join(out, 'golden-film.html');
execFileSync('cargo', ['run', '-q', '-p', 'codjiva-build', '--', path.resolve(sources), built], { cwd: root, stdio: 'inherit' });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1920, height: 1136 }, deviceScaleFactor: 1 });
const open = async (file, ready) => {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(pathToFileURL(file).href);
  await page.waitForFunction(ready);
  return { page, errors };
};
const ref = await open(path.resolve(original), () => document.body.classList.contains('ready') && typeof window.__seek === 'function');
const port = await open(built, () => document.body.classList.contains('ready') && !!window.__cj);

// Draws the frame at time t and waits until the page has painted it.
const settle = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

let failed = 0;
for (const t of times) {
  await ref.page.evaluate((x) => window.__seek(x), t);
  await port.page.evaluate((x) => window.__cj.seek(x), t);
  await settle(ref.page);
  await settle(port.page);
  const a = PNG.sync.read(await ref.page.screenshot());
  const b = PNG.sync.read(await port.page.screenshot());
  const diff = new PNG({ width: a.width, height: a.height });
  const count = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
  const share = count / (a.width * a.height);
  const ok = share < MAX_DIFF;
  if (!ok) failed++;
  console.log(`t=${String(t).padStart(3)}s  ${(share * 100).toFixed(3)}% differ  ${ok ? 'ok' : 'FAIL'}`);
  if (!ok || args.includes('--keep')) {
    writeFileSync(path.join(out, `golden-${t}-ref.png`), PNG.sync.write(a));
    writeFileSync(path.join(out, `golden-${t}-port.png`), PNG.sync.write(b));
    writeFileSync(path.join(out, `golden-${t}-diff.png`), PNG.sync.write(diff));
  }
}
for (const [name, p] of [['reference', ref], ['port', port]]) {
  if (p.errors.length) { console.log(`${name} page errors:\n  ` + p.errors.join('\n  ')); if (name === 'port') failed++; }
}
await browser.close();
if (failed) { console.error(`${failed} check(s) failed. Frames are in ${out}`); process.exit(1); }
console.log('All frames match.');
