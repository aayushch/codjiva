// Runs the runtime's self-test on the reference film and prints the report.
// Usage: node selftest.mjs [--json]
import { chromium } from 'playwright';
import { build, openArtifact, runSelfTest, referenceFilm } from './lib.mjs';

const browser = await chromium.launch();
const { page, errors } = await openArtifact(browser, build(referenceFilm, 'film'));
const began = Date.now();
const report = await runSelfTest(page);
const took = ((Date.now() - began) / 1000).toFixed(1);
await browser.close();

if (process.argv.includes('--json')) { console.log(JSON.stringify(report, null, 2)); process.exit(report.ok ? 0 : 1); }
console.log(`self-test: ${report.ok ? 'ok' : 'FAILED'} in ${took}s, ${report.stats.samples} samples, duration ${report.duration}s`);
console.log('nodes per scene:', JSON.stringify(report.stats.nodes));
console.log('render ms per scene:', JSON.stringify(report.stats.renderMs));
for (const i of report.issues) {
  console.log(`- [${i.severity}] ${i.check} scene=${i.scene || '-'} t=${i.t ?? '-'} ×${i.count}`);
  if (i.message) console.log('    ' + i.message);
  if (i.a) console.log('    a: ' + i.a.selector + ' "' + i.a.text + '" ' + JSON.stringify(i.a.box));
  if (i.b) console.log('    b: ' + i.b.selector + ' "' + i.b.text + '" ' + JSON.stringify(i.b.box));
}
if (errors.length) console.log('page errors:\n  ' + errors.join('\n  '));
process.exit(report.ok && !errors.length ? 0 : 1);
