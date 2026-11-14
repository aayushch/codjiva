// Builds the reference pipeline, which places the plants of two visuals in one yard, and checks
// in a real browser that both parts are drawn in their bays, that the yard can reach into a
// part (routes and state), and that the self-test passes.
import { chromium } from 'playwright';
import path from 'node:path';
import { build, openArtifact, root } from './lib.mjs';

// The reference folder holds each part's plant.js in parts/<key>/, where the app puts them when
// a pipeline job starts.
const file = build(path.join(root, 'runtime/reference/pipeline'), 'pipeline');

let failed = 0;
const check = (ok, name, detail) => {
  if (!ok) failed++;
  console.log((ok ? 'ok    ' : 'FAIL  ') + name + (ok || !detail ? '' : '\n      ' + detail));
};

const browser = await chromium.launch();
const { page, errors } = await openArtifact(browser, file);

const bays = await page.evaluate(() => Array.from(document.querySelectorAll('.cj-bay')).map((el) => {
  const r = el.getBoundingClientRect();
  return { part: el.dataset.part, x: Math.round(r.left), width: Math.round(r.width), machines: el.querySelectorAll('[data-cj="machine"]').length };
}));
check(bays.length === 2 && bays[0].part === 'handler' && bays[1].part === 'store', 'both parts are drawn, each in its own bay', JSON.stringify(bays));
check(bays.every((b) => b.machines >= 2) && bays[0].x + bays[0].width <= bays[1].x, 'each bay holds the whole plant of its part, and the bays do not overlap', JSON.stringify(bays));

const names = await page.evaluate(() => {
  const all = Array.from(document.querySelectorAll('.cj-bay [class]')).flatMap((el) => (el.getAttribute('class') || '').split(/\s+/)).filter((n) => n.startsWith('v-p-'));
  const first = all.filter((n) => n.startsWith('v-p-handler-'));
  const second = all.filter((n) => n.startsWith('v-p-store-'));
  return { first: first.length, second: second.length, shared: first.filter((n) => second.includes(n)).length };
});
check(names.first > 20 && names.second > 20 && names.shared === 0, 'the two parts never share a class name', JSON.stringify(names));

const reach = await page.evaluate(() => {
  const yard = window.__cj.registry.plant;
  const routes = yard.routes(CJ);
  const mounted = window.__cj.visual.mounted;
  const before = mounted.bays.handler.el.innerHTML;
  // Fills the tank of the handler part almost to the top.
  CJ.bay('handler').set(mounted.refs, { level: 0.95 }, 0);
  return {
    crossStart: routes.cross(0), crossEnd: routes.cross(1), flushStart: routes.inHandler(0),
    partsHaveRefs: Object.keys(mounted.bays.handler.refs).length > 0,
    stateApplied: mounted.bays.handler.el.innerHTML !== before,
  };
});
// The handler's bay is at x 52, y 347, scale 0.46: its sheet point [1800, 870] is [880, 747.2] in
// the yard. The store's bay is at x 985 with the same y and scale: its sheet point [60, 560] is
// [1012.6, 604.6].
check(Math.abs(reach.crossStart[0] - 880) < 0.01 && Math.abs(reach.crossStart[1] - 747.2) < 0.01 && Math.abs(reach.crossEnd[0] - 1012.6) < 0.01, 'a point of a part is converted to the yard by the bay', JSON.stringify(reach));
// The handler's own flush route starts at its sheet point [1400, 560].
check(Math.abs(reach.flushStart[0] - (52 + 1400 * 0.46)) < 0.01, "a part's own route is usable in the yard's coordinates", JSON.stringify(reach.flushStart));
check(reach.partsHaveRefs && reach.stateApplied, 'the yard can set the state of a part');

const report = await page.evaluate(() => window.__cj.selfTest({}));
check(report.ok, 'the self-test passes: the inside of a bay is not checked a second time', JSON.stringify(report.issues.filter((i) => i.severity === 'error').slice(0, 4)));

// Clicking inside a bay selects the part as a whole.
const box = await page.locator('.cj-bay').first().boundingBox();
await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
const selected = await page.evaluate(() => document.querySelectorAll('.cj-selected').length);
check(selected >= 1, 'clicking inside a bay selects that part');

check(errors.length === 0, 'the page logs no errors', errors.join(' | '));
await page.screenshot({ path: path.join(path.dirname(file), 'pipeline.png') });
await browser.close();
if (failed) { console.error(`${failed} check(s) failed.`); process.exit(1); }
console.log('The reference pipeline passes.');
