// End-to-end test of the interface in a browser, without the desktop app.
//
// It serves the built interface (ui/dist) with the in-memory backend, plus the three built
// reference artifacts, and drives the pages the way a user would. Run `npm run build` first.
// A screenshot of each state is written to e2e/out/.
//
// Usage: node e2e/run.mjs [--browser webkit] [--scheme light]
import { chromium, webkit } from 'playwright';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ui = path.join(here, '..');
const root = path.join(ui, '..');
const out = path.join(here, 'out');
const dist = path.join(ui, 'dist');
if (!existsSync(path.join(dist, 'index.html'))) { console.error('ui/dist is missing. Run `npm run build` first.'); process.exit(2); }
mkdirSync(path.join(out, 'artifact/reference'), { recursive: true });

// Build the three reference artifacts. The example views load the film and the visual, and the
// mock shows them, and the pipeline, as the results of its jobs.
const build = (name) => execFileSync('cargo', ['run', '-q', '-p', 'codjiva-build', '--', path.join(root, 'runtime/reference', name), path.join(out, 'artifact/reference', name + '.html')], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
build('film');
build('visual');
build('pipeline');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain' };
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const file = url.pathname.startsWith('/__artifact/')
    ? path.join(out, 'artifact', url.pathname.slice('/__artifact/'.length))
    : path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(out) && !file.startsWith(dist)) { response.writeHead(403).end(); return; }
  try {
    response.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  } catch {
    response.writeHead(404).end('not found');
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}/`;

const engineName = process.argv.includes('--browser') ? process.argv[process.argv.indexOf('--browser') + 1] : 'chromium';
const browser = await (engineName === 'webkit' ? webkit : chromium).launch();
// The app follows the system's colour scheme until the theme setting says otherwise. The test
// tells the browser which scheme the system has: dark unless `--scheme light` is given.
const scheme = process.argv.includes('--scheme') ? process.argv[process.argv.indexOf('--scheme') + 1] : 'dark';
const context = await browser.newContext({ viewport: { width: 1600, height: 960 }, deviceScaleFactor: 1, colorScheme: scheme });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

let failed = 0;
const check = (ok, name, detail) => {
  if (!ok) failed++;
  console.log((ok ? 'ok    ' : 'FAIL  ') + name + (ok || detail == null ? '' : '\n      ' + detail));
};
const shot = (name) => page.screenshot({ path: path.join(out, `${engineName}-${name}.png`) });
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
// The tree row whose name is exactly `name`.
const row = (name) => page.locator('.row').filter({ has: page.getByText(name, { exact: true }) });

await page.goto(base);

// ---- welcome
await page.getByRole('button', { name: 'Open folder…' }).waitFor();
check(await page.locator('.recent').count() === 2, 'welcome lists recent workspaces');
check(await page.evaluate(() => document.fonts.check('13px "JetBrains Mono"')), 'the app font is loaded');
await shot('01-welcome');

// ---- open a workspace, browse the tree
await page.locator('.recent', { hasText: 'shop' }).click();
await row('internal').waitFor();
const topRows = await page.locator('.row .name').allTextContents();
check(JSON.stringify(topRows) === JSON.stringify(['internal', 'web', 'go.mod', 'Makefile', 'README.md']), 'the tree lists folders first, then files', JSON.stringify(topRows));
check((await page.locator('.titlebar .ws').textContent()) === 'shop', 'the title bar shows the workspace name');
await row('internal').click();
await row('orders').click();
await row('handler.go').click();
await page.locator('.empty .fname', { hasText: 'handler.go' }).waitFor();
const meta = await page.locator('.empty .meta').textContent();
check(/Go/.test(meta) && /\d+ lines/.test(meta) && /no visuals yet/.test(meta), 'the empty state shows language, line count and artifact status', meta);
check((await page.locator('.empty .path').textContent()) === 'internal/orders/handler.go', 'the empty state shows the path');
check(await page.locator('.row.selected .name').textContent() === 'handler.go', 'the selected row is marked');
const crumb = (await page.locator('.toolbar .crumb').textContent()).replace(/\s+/g, '');
check(crumb === 'internal/orders/handler.go', 'the toolbar shows the path as a breadcrumb', crumb);
await shot('02-empty-state');

// ---- Visualise: the .gitignore question once, then the instructions step, then the job
check(/Mock Agent · ready/.test(await page.locator('.titlebar .agent').textContent()), 'the title bar shows the agent that will run jobs');
await page.locator('.empty').getByRole('button', { name: 'Visualise', exact: true }).click();
await page.getByRole('dialog').getByText('to .gitignore?').waitFor();
await shot('03-gitignore');
await page.getByRole('button', { name: 'Add', exact: true }).click();
await page.getByRole('dialog').getByText('Visualise handler.go').waitFor();
check(true, 'after the .gitignore answer the instructions step opens');
await page.locator('#instructions-text').fill('Show what happens when the batch is full');
await page.locator('.chip').first().click();
const typed = await page.locator('#instructions-text').inputValue();
check(typed.startsWith('Show what happens when the batch is full Emphasise '), 'a suggestion chip adds to the instructions', typed);
await shot('03b-instructions');
await page.getByRole('dialog').getByRole('button', { name: 'Visualise' }).click();
await page.locator('.dock .step.now').first().waitFor();
check(await page.getByRole('button', { name: 'Visualising…' }).isDisabled(), 'the file shows that a job is running for it');
await page.locator('.dock .log .tool').first().waitFor();
await page.waitForTimeout(500);
await shot('03c-job');
// The job ends with the visual on screen, after the hidden frame has run the real self-test.
await page.locator('.inspector').waitFor({ timeout: 40000 });
check(/Done\. The visual passed every check\./.test(await page.locator('.dock .log').textContent()), 'the job log ends with the outcome', (await page.locator('.dock .log').textContent()).slice(-200));
check(/write guard: 0 writes outside \.codjiva\//.test(await page.locator('.dock .log').textContent()), 'the job log shows the write guard result');
check(/\$0\.42/.test(await page.locator('.dock-foot').textContent()), 'the dock shows what the job cost');
check(await page.locator('.validator').count() === 0, 'the hidden validation frame is removed after the check');
check(await page.locator('.row.selected .badge.dot').count() === 1, 'the file gets a badge in the tree');
check(await page.locator('.lib-item').count() === 1, 'the visual appears in the library');
await page.getByRole('button', { name: 'Close' }).click();

// ---- the visual: select a part, follow a code reference, switch a layer
const visual = page.frameLocator('.canvas iframe');
await visual.locator('.v-submit').waitFor({ timeout: 15000 });
const gate = await visual.locator('.v-submit').boundingBox();
await page.mouse.click(gate.x + gate.width / 2, gate.y + gate.height / 2);
await page.locator('.inspector h3', { hasText: 'Submit()' }).waitFor({ timeout: 5000 });
check(true, 'clicking a machine shows its name and role in the inspector');
await shot('03d-visual');
check(await visual.locator('.v-pipe10').isVisible(), 'the data layer starts on');
await page.getByRole('switch', { name: 'Data flow' }).click();
// The switch reaches the visual as a message, so the change arrives a moment later.
const hidden = await visual.locator('.v-pipe10').waitFor({ state: 'hidden', timeout: 3000 }).then(() => true, () => false);
check(hidden, 'switching a layer off in the inspector hides it in the visual');
await page.getByRole('switch', { name: 'Data flow' }).click();
await page.locator('.inspector button.ref').first().click();
await page.locator('.source-line.ref').waitFor({ timeout: 5000 });
check((await page.locator('.source-line.ref .source-num').textContent()).trim() === '20', 'a code reference opens the source at its line');
await page.locator('.tab', { hasText: 'Visual' }).click();
await page.locator('.inspector').waitFor();

// ---- regenerate adds a version; the instructions are remembered
await page.locator('.insp-actions').getByRole('button', { name: 'Regenerate…' }).click();
check((await page.locator('#instructions-text').inputValue()) === typed, 'Regenerate starts from the instructions of the version on screen');
await page.getByRole('dialog').getByRole('button', { name: 'Regenerate' }).click();
await page.locator('.dock .outcome').waitFor({ timeout: 40000 });
const versions = await page.locator('.toolbar select option').allTextContents();
check(versions.length === 2 && versions[0].startsWith('v2') && versions[1].includes('(earlier)'), 'the version picker lists both versions, newest first', JSON.stringify(versions));
await page.locator('.toolbar select').selectOption('1');
await page.getByText('You are looking at an earlier version.').waitFor();
check(true, 'an earlier version can be shown');
await page.locator('.toolbar select').selectOption('2');

// ---- editing a source file marks the visual stale; nothing regenerates by itself
await page.evaluate(() => window.__mockEditFile('internal/orders/handler.go'));
await page.locator('.toolbar .badge-stale').waitFor({ timeout: 5000 });
check(await page.locator('.row.selected .badge.hollow').count() === 1, 'the tree badge turns hollow when the visual is stale');
check(/handler\.go.*changed after this version was made/.test(await page.locator('.inspector').textContent()), 'the inspector says which file changed and offers Regenerate');
check((await page.locator('.toolbar select option').count()) === 2, 'a stale visual is not regenerated automatically');
await shot('03e-stale');

// ---- a running job can be cancelled
await page.locator('.insp-actions').getByRole('button', { name: 'Regenerate…' }).click();
await page.getByRole('dialog').getByRole('button', { name: 'Regenerate' }).click();
await page.locator('.dock .step.now').first().waitFor();
await page.getByRole('button', { name: 'Cancel' }).click();
await page.locator('.dock .log', { hasText: 'Cancelled.' }).waitFor({ timeout: 5000 });
check((await page.locator('.toolbar select option').count()) === 2, 'a cancelled job adds no version');
await page.getByRole('button', { name: 'Close' }).click();

// ---- Animate: companions, instructions and length, then the outline, then the film
await page.locator('.tab', { hasText: 'Film' }).click();
await page.getByRole('button', { name: 'Animate with companions…' }).click();
await page.getByRole('dialog').getByText('Animate handler.go').waitFor();
await page.locator('.companions .check').first().waitFor();
const companionRows = await page.locator('.companions .check').evaluateAll((rows) => rows.map((row) => [row.textContent.trim().split(/\s{2,}/)[0], row.querySelector('input').checked]));
check(companionRows.length === 4 && companionRows[0][0].startsWith('internal/orders/handler_test.go') && companionRows[0][1] && companionRows[1][1] && !companionRows[2][1],
  'the Animate dialog lists suggested companions with reasons and ticks the strongest', JSON.stringify(companionRows));
check(!companionRows.some(([text]) => text.startsWith('vendor/')), 'a file in a folder on the ignore list is not suggested', JSON.stringify(companionRows));

// ---- a suggested companion can be ignored for good, as a file or as a folder it is in
const ignoreDialog = page.locator('.dialog.ignore');
await page.locator('.companions .companion', { hasText: 'limiter.go' }).getByRole('button', { name: 'Ignore always…' }).click();
await ignoreDialog.waitFor();
await page.keyboard.press('Escape');
await ignoreDialog.waitFor({ state: 'detached' });
check(await page.locator('.dialog.animate').isVisible() && await page.locator('.companions .companion').count() === 4, 'Escape closes the ignore dialog only, and nothing is ignored');
await page.locator('.companions .companion', { hasText: 'lib/acme/metrics/counter.go' }).getByRole('button', { name: 'Ignore always…' }).click();
await ignoreDialog.waitFor();
check(await ignoreDialog.locator('#ignore-pattern').inputValue() === '/lib/acme/metrics/counter.go' && await ignoreDialog.locator('.scope').count() === 4,
  'the ignore dialog starts from the file itself and offers each folder above it');
await ignoreDialog.locator('.scope').nth(2).click();
check(await ignoreDialog.locator('#ignore-pattern').inputValue() === '/lib/acme/', 'choosing a folder puts its pattern in the field');
await ignoreDialog.getByText('Matches 3 code files in this workspace, 1 of them in the list of companions.').waitFor();
await ignoreDialog.locator('#ignore-pattern').fill('/lib/[z-a]/');
await ignoreDialog.getByText('This cannot be read as a pattern.').waitFor();
check(await ignoreDialog.getByRole('button', { name: 'Ignore always' }).isDisabled(), 'a pattern that cannot be read cannot be added');
await ignoreDialog.locator('#ignore-pattern').fill('/lib/acme/');
await ignoreDialog.getByText('Matches 3 code files').waitFor();
await shot('09a-ignore-dialog');
await ignoreDialog.getByRole('button', { name: 'Ignore always' }).click();
await ignoreDialog.waitFor({ state: 'detached' });
check(await page.locator('.companions .companion').count() === 3 && await page.locator('.companions .companion', { hasText: 'lib/acme' }).count() === 0,
  'the ignored folder\'s file leaves the list of companions');
check(await page.locator('.companions .check input:checked').count() === 2, 'ignoring a file keeps the ticks of the others');
await page.getByLabel('Add a companion file').fill('ledger');
await page.locator('.hit').first().click();
check(await page.locator('.companions .check', { hasText: 'ledger.py' }).locator('input').isChecked(), 'any file can be added as a companion');
await page.locator('#animate-text').fill('Follow one order to the store');
await page.getByRole('button', { name: 'Short · ~1 min' }).click();
await shot('09-animate-dialog');
await page.getByRole('dialog').getByRole('button', { name: 'Animate', exact: true }).click();
await page.locator('.outline-pane').waitFor();
check((await page.locator('.dock .kicker').first().textContent()) === 'Animate · handler.go', 'the dock names the job and the file');
check(await page.locator('.outline-list li').count() === 3, 'the story outline is shown while the film is being made');
const animateRequest = await page.evaluate(() => window.__mockLastRequest);
check(animateRequest.kind === 'animate' && animateRequest.lengthSeconds === 60 && animateRequest.companions.length === 3 && animateRequest.instructions === 'Follow one order to the store',
  'the job is started with the ticked companions, the instructions and the length', JSON.stringify(animateRequest));
await page.locator('.dock .step.now', { hasText: 'Animating chapter' }).waitFor();
await shot('09b-animate-job');
// The user reads the source while the film is being made. The finished film replaces the source
// view without a click.
await page.locator('.tab', { hasText: 'Source' }).click();
await page.locator('.player:not(.waiting)').waitFor({ timeout: 60000 });
check(await page.locator('.tab.on', { hasText: 'Film' }).count() === 1 && await page.locator('.dock .outcome').count() === 1 && await page.locator('.dock').getByRole('button', { name: 'Show the film' }).count() === 0,
  'a finished film is shown on the Film tab without a click');
check(/4 chapters/.test(await page.locator('.inspector').textContent()), 'the film is shown with its chapters in the inspector');
check(await page.locator('.tab', { hasText: 'Film' }).locator('.has').count() === 1 && await page.locator('.lib-item').count() === 2, 'the file now has a film next to its visual');
await page.getByRole('button', { name: 'Close' }).click();
await page.locator('.chapter-row').nth(2).click();
await page.waitForFunction(() => /^3 \/ 4/.test(document.querySelector('.player .chap').textContent));
check(true, 'clicking a chapter in the inspector seeks the film to it');
const speed = page.getByLabel('Speed');
check((await speed.locator('option').allTextContents()).join(' ') === '0.75× 1× 1.25× 2× 4×', 'the film can be slowed to 0.75× and sped up to 4×');
await speed.selectOption('4');
await page.waitForTimeout(600);
check(await speed.inputValue() === '4' && await speed.locator('option[value="4"]').isEnabled(), 'the film reports that it plays at 4×');
await speed.selectOption('1');
await shot('09c-film');

// ---- feedback on the film: a pinned moment, a pointed-at element, then a new version
const filmScrub = await page.locator('.player .scrub').boundingBox();
await page.keyboard.down('Alt');
await page.mouse.click(filmScrub.x + filmScrub.width * 0.5, filmScrub.y + filmScrub.height / 2);
await page.keyboard.up('Alt');
await page.locator('.feedback .pill', { hasText: 'pinned at 0:41' }).waitFor();
check(await page.locator('.player .scrub .pin').count() === 1, 'holding Alt while clicking the scrubber pins that moment for feedback');
await page.getByRole('button', { name: 'Point at…' }).click();
await page.locator('.feedback .picking').waitFor();
const filmFrame = page.frameLocator('iframe[title="How an order moves through the orders Handler"]');
await filmFrame.locator('body.picking').waitFor();
// The camera is zoomed in, so some machines are outside the frame. One whose centre is inside
// the frame is clicked.
const frameBox = await page.locator('iframe[title="How an order moves through the orders Handler"]').boundingBox();
const machines = filmFrame.locator('.scene-box:visible [data-cj="machine"]');
let target = null;
for (let i = 0; i < await machines.count() && !target; i++) {
  const box = await machines.nth(i).boundingBox();
  const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
  if (cx > frameBox.x + 20 && cx < frameBox.x + frameBox.width - 20 && cy > frameBox.y + 80 && cy < frameBox.y + frameBox.height - 20) target = [cx, cy];
}
await page.mouse.click(target[0], target[1]);
await page.locator('.feedback .pill', { hasText: 'points at:' }).waitFor();
check(await filmFrame.locator('body.picking').count() === 0, 'pointing at an element attaches it and ends point-at mode');
await page.getByLabel('Feedback').fill('This machine needs a clearer label');
await shot('09d-feedback');
await page.getByRole('button', { name: 'Send feedback' }).click();
await page.locator('.dock .kicker', { hasText: 'Feedback · handler.go' }).waitFor();
const feedbackRequest = await page.evaluate(() => window.__mockLastRequest);
check(feedbackRequest.kind === 'feedback' && feedbackRequest.baseVersion === 1 && feedbackRequest.feedback.text === 'This machine needs a clearer label'
  && Math.abs(feedbackRequest.feedback.time - 41.5) < 3 && !!feedbackRequest.feedback.pointAt.selector && feedbackRequest.feedback.pointAt.box.length === 4 && !!feedbackRequest.feedback.pointAt.scene,
  'the feedback job carries the words, the moment and the pointed-at element', JSON.stringify(feedbackRequest.feedback));
await page.locator('.dock .log', { hasText: 'Done. The film passed every check.' }).waitFor({ timeout: 45000 });
await page.locator('.inspector', { hasText: 'Changed after feedback' }).waitFor();
check((await page.locator('.toolbar select option').count()) === 2 && (await page.locator('.feedback .pill', { hasText: 'points at:' }).count()) === 0,
  'feedback adds a version and what was attached is cleared');
await page.getByRole('button', { name: 'Close' }).click();

// ---- changing the outline restarts the film with the edited outline
await page.locator('.insp-actions').getByRole('button', { name: 'Regenerate…' }).click();
await page.getByRole('dialog').getByText('Make the film again for handler.go').waitFor();
check(await page.locator('.companions .check input:checked').count() === 3, 'making a film again starts from the companions of the film on screen');
await page.getByRole('dialog').getByRole('button', { name: 'Make it again' }).click();
await page.locator('.outline-pane').waitFor();
await page.getByRole('button', { name: 'Change the outline…' }).click();
await page.getByLabel('Title of chapter 2').fill('2 · Waiting in the queue');
await page.getByRole('button', { name: 'Remove chapter 3' }).click();
check(await page.getByRole('button', { name: 'Remove chapter 1' }).isDisabled(), 'an outline keeps at least two chapters');
await shot('09e-outline');
await page.getByRole('button', { name: 'Make the film with this outline' }).click();
await page.waitForFunction(() => !!window.__mockLastRequest?.outline && document.querySelectorAll('.outline-list li').length === 2);
const outlineRequest = await page.evaluate(() => window.__mockLastRequest);
check(outlineRequest.outline.chapters.length === 2 && outlineRequest.outline.chapters[1].title === '2 · Waiting in the queue' && outlineRequest.companions.length === 3,
  'the film is started again with the edited outline', JSON.stringify(outlineRequest.outline));
check(await page.locator('.outline-list li').count() === 2, 'the dock shows the edited outline');
await page.locator('.dock .log', { hasText: 'Done. The film passed every check.' }).waitFor({ timeout: 45000 });
await page.locator('.player:not(.waiting)').waitFor({ timeout: 20000 });
check((await page.locator('.toolbar select option').count()) === 3, 'a film made from an outline the user edited is shown as a new version');
await page.getByRole('button', { name: 'Close' }).click();
await page.locator('.tab', { hasText: 'Visual' }).click();
await page.locator('.inspector', { hasText: 'This visual' }).waitFor();
check(true, 'the Visual tab still shows the visual of the same file');

// ---- a whole folder: the size estimate and the warning, then a visual of the folder
await row('web').hover();
await row('web').locator('.folder-viz').click();
await page.locator('.empty .warn-box').waitFor();
check(/This is a large folder\./.test(await page.locator('.empty .warn-box').textContent()) && /about 120 thousand tokens/.test(await page.locator('.empty .meta').textContent()),
  'a large folder shows its size and a stronger warning', await page.locator('.empty .meta').textContent());
await row('orders').hover();
await row('orders').locator('.folder-viz').click();
await page.locator('.empty .fname', { hasText: 'orders/' }).waitFor();
check(/4 code files/.test(await page.locator('.empty .meta').textContent()) && /costs more than a file/.test(await page.locator('.empty .warn-box').textContent()),
  'selecting a folder shows how much code a visual of it has to read', await page.locator('.empty .meta').textContent());
check(await page.locator('.toolbar .tab').count() === 1 && (await page.locator('.toolbar .crumb').textContent()).replace(/\s+/g, '') === 'internal/orders/', 'a folder has only the Visual tab');
await shot('10-folder');
await page.getByRole('button', { name: 'Visualise this folder…' }).click();
check(/4 files, about 4 thousand tokens/.test(await page.getByRole('dialog').locator('.warn-box').textContent()), 'the instructions step repeats the warning before the job starts');
await page.getByRole('dialog').getByRole('button', { name: 'Visualise the folder' }).click();
await page.locator('.dock .kicker', { hasText: 'Visualise · orders/' }).waitFor();
check((await page.evaluate(() => window.__mockLastRequest.subject[0])) === 'internal/orders/', 'the job is started for the folder');
await page.locator('.dock .log', { hasText: 'Done. The visual passed every check.' }).waitFor({ timeout: 45000 });
await page.locator('.inspector', { hasText: 'This visual' }).waitFor();
check(await row('orders').locator('.badge.dot').count() === 1 && await page.locator('.lib-item').count() === 3, 'the folder gets a badge in the tree and its visual is in the library');
await page.getByRole('button', { name: 'Close' }).click();
await row('handler.go').click();
await page.locator('.inspector', { hasText: 'This visual' }).waitFor();

// ---- a pipeline: two artifacts joined where their code meets
await row('store.go').click();
await page.locator('.empty').getByRole('button', { name: 'Visualise', exact: true }).click();
await page.getByRole('dialog').getByRole('button', { name: 'Visualise' }).click();
// The user selects another file while the visual is being made. The finished visual does not
// take them away from that file, and the dock offers a button that opens it.
await row('handler.go').click();
await page.locator('.dock .log', { hasText: 'Done. The visual passed every check.' }).waitFor({ timeout: 45000 });
check(await page.locator('.row.selected', { hasText: 'handler.go' }).count() === 1, 'a visual that finishes while another file is selected does not replace that file');
await page.locator('.dock').getByRole('button', { name: 'Show the visual' }).click();
await page.locator('.inspector', { hasText: 'store.go' }).waitFor();
check(await page.locator('.row.selected', { hasText: 'store.go' }).count() === 1 && await page.locator('.dock').getByRole('button', { name: 'Show the visual' }).count() === 0, 'the button in the dock opens the finished visual and its file');
await page.getByRole('button', { name: 'Close' }).click();
check(/ports · 1 in · 0 out/.test(await page.locator('.lib-item', { hasText: 'store.go' }).textContent()), 'the library shows how many ports an artifact has');
check(/Connects to/.test(await page.locator('.inspector').textContent()), 'an artifact that meets another in the code says what it connects to');
await page.locator('.lib-item', { hasText: 'store.go' }).locator('.lib-tick').check();
check(await page.getByRole('button', { name: 'Compose 1…' }).isDisabled(), 'one ticked artifact is not enough to compose');
await page.locator('.lib-item', { hasText: 'handler.go' }).first().locator('.lib-tick').check();
await page.getByRole('button', { name: 'Compose 2…' }).click();
await page.getByRole('dialog').getByText('Compose a pipeline').waitFor();
await page.locator('.dialog.compose .check').first().waitFor();
const partOrder = await page.locator('.dialog.compose .part .t').allTextContents();
check(partOrder.length === 2 && /handler\.go/.test(partOrder[0]) && /store\.go/.test(partOrder[1]), 'the parts are listed in the order work flows, the sender first', JSON.stringify(partOrder));
const joinRow = page.locator('.dialog.compose .check').first();
check(await joinRow.locator('input').isChecked() && /Store\.WriteBatch.*same name/.test((await joinRow.textContent()).replace(/\s+/g, ' ')), 'the join between the two ports is proposed and ticked, with its reason', await joinRow.textContent());
await page.locator('#compose-text').fill('Follow one batch to the store');
await shot('11-compose-dialog');
await page.getByRole('dialog').getByRole('button', { name: 'Compose', exact: true }).click();
await page.locator('.dock .kicker', { hasText: 'Compose · 2 parts' }).waitFor();
const composeRequest = await page.evaluate(() => window.__mockLastRequest);
check(composeRequest.kind === 'compose' && composeRequest.parts.length === 2 && composeRequest.joins.length === 1 && composeRequest.joins[0].fromPort === 'out:Store.WriteBatch' && !composeRequest.film,
  'the compose job is started with the parts and the confirmed join', JSON.stringify(composeRequest));
await page.locator('.dock .step', { hasText: 'Checking the joins in the code' }).waitFor();
await page.locator('.dock .log', { hasText: 'Done. The pipeline passed every check.' }).waitFor({ timeout: 45000 });
await page.locator('.inspector', { hasText: 'This pipeline' }).waitFor();
check((await page.locator('.toolbar .crumb').textContent()).replace(/\s+/g, ' ').trim() === 'Pipeline / Orders: from the handler to the store', 'the pipeline opens by itself, under its own name');
check(await page.locator('.inspector .part-row').count() === 2 && /handler.*→.*store/.test((await page.locator('.inspector .join').first().textContent()).replace(/\s+/g, ' ')), 'the inspector lists the parts and the joins of the pipeline');
const pipelineFrame = page.frameLocator('iframe[title="Orders: from the handler to the store"]');
await pipelineFrame.locator('.cj-bay').first().waitFor();
check(await pipelineFrame.locator('.cj-bay').count() === 2, 'the pipeline shows each part in its own bay');
check(/pipeline · v1/.test((await page.locator('.lib-item.on').textContent()).replace(/\s+/g, ' ')) && await page.locator('.lib-tick:checked').count() === 0, 'the pipeline is in the library and the ticks are cleared');
await page.getByRole('button', { name: 'Close' }).click();
await shot('11b-pipeline');
await page.locator('.inspector .part-row').first().click();
await page.locator('.inspector', { hasText: 'This visual' }).waitFor();
check((await page.locator('.row.selected .name').textContent()) === 'handler.go', "clicking a part opens that part's own artifact");

// ---- source tab
await page.locator('.tab', { hasText: 'Source' }).click();
await page.locator('.source-line').first().waitFor();
check((await page.locator('.source-line').first().textContent()).includes('package orders'), 'the source tab shows the file');
await page.locator('.source .hljs-keyword').first().waitFor({ timeout: 5000 }).catch(() => {});
check(await page.locator('.source .hljs-keyword').count() > 3, 'the source is coloured');
await shot('04-source');

// ---- quick open
await page.keyboard.press(`${mod}+p`);
await page.getByPlaceholder('Go to file…').fill('ledger');
await page.locator('.quick-row').first().waitFor();
await shot('05-quick-open');
await page.keyboard.press('Enter');
await page.locator('.row.selected', { hasText: 'ledger.py' }).waitFor();
check(await row('billing').count() === 1, 'quick-open selects the file and expands the folders above it');

// ---- keyboard navigation in the tree
await page.locator('.tree').focus();
await page.keyboard.press('Home');
await page.keyboard.press('ArrowLeft');
const collapsed = await page.locator('.row .name').allTextContents();
check(!collapsed.includes('orders') && collapsed.includes('internal'), 'the Left key closes a folder', JSON.stringify(collapsed));
await page.keyboard.press('ArrowRight');
await page.keyboard.press('ArrowDown');
await page.keyboard.press('ArrowDown');
await page.keyboard.press('ArrowDown');
await page.keyboard.press('Enter');
await page.locator('.empty .fname, .source-line').first().waitFor();
check((await page.locator('.row.selected .name').textContent()) != null, 'arrow keys and Enter open a file');

// ---- sidebar resize
const before = (await page.locator('.sidebar').boundingBox()).width;
const edge = await page.locator('.splitter').boundingBox();
await page.mouse.move(edge.x + 3, edge.y + 200);
await page.mouse.down();
await page.mouse.move(edge.x + 123, edge.y + 200, { steps: 4 });
await page.mouse.up();
const after = (await page.locator('.sidebar').boundingBox()).width;
check(Math.abs(after - before - 120) < 3, 'dragging the sidebar edge resizes it', `${before} -> ${after}`);

// ---- settings
await page.keyboard.press(`${mod}+,`);
await page.getByRole('dialog').getByText('Settings').first().waitFor();
const section = (name) => page.locator('.dialog.settings').getByRole('tab', { name, exact: true });
check((await page.locator('.dialog.settings [role=tab]').allTextContents()).join(', ') === 'Agent, API keys, Jobs, Films, Companion files, Source code, Appearance' && await page.locator('.pane h3').textContent() === 'Agent',
  'Settings is divided into sections and opens on the first');
await shot('06-settings');
await section('Jobs').click();
await page.locator('#set-fix').fill('5');
await page.locator('#set-fix').blur();
check(await page.locator('#set-speed').count() === 0, 'a section shows only its own settings');

// ---- the ignore list in Settings
await section('Companion files').click();
check((await page.locator('#set-ignore').inputValue()).split('\n').includes('/lib/acme/'), 'a pattern added from the Animate dialog is in the ignore list in Settings');
await page.getByText(/These patterns match 4 code files in shop/).waitFor();
await page.locator('#set-ignore').fill('vendor/\n\n  *.pb.go  \nvendor/\n/lib/[z-a]/');
await page.locator('#set-ignore').blur();
await page.getByText('Cannot be read as a pattern, and matches nothing:').waitFor();
check(await page.locator('#set-ignore').inputValue() === 'vendor/\n*.pb.go\n/lib/[z-a]/', 'the ignore list is saved one pattern per line, without empty lines and repeats');
await shot('06b-settings-companions');
await page.locator('#set-ignore').fill('vendor/\nthird_party/\nnode_modules/');
await page.locator('#set-ignore').blur();

// ---- light and dark theme
await section('Appearance').click();
const theme = () => page.evaluate(() => [document.documentElement.dataset.theme, getComputedStyle(document.body).backgroundColor]);
await page.getByRole('button', { name: 'Light', exact: true }).click();
await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
const lightTheme = await theme();
await shot('06c-settings-light');
await page.getByRole('button', { name: 'Dark', exact: true }).click();
await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
const darkTheme = await theme();
check(lightTheme[1] === 'rgb(227, 224, 216)' && darkTheme[1] === 'rgb(12, 14, 18)', 'the theme setting switches the window between light and dark', JSON.stringify([lightTheme, darkTheme]));

// ---- API providers
const provider = (id) => page.locator(`.provider[data-provider="${id}"]`);
await section('API keys').click();
await provider('api-anthropic').waitFor();
check(await page.locator('.provider').count() === 4, 'Settings lists the four API providers');
check((await provider('api-anthropic').locator('.pill').textContent()) === 'needs a key', 'a provider without a key says so');
await provider('api-anthropic').locator('summary').click();
check(await provider('api-anthropic').getByRole('button', { name: 'Test the connection' }).isDisabled(), 'a provider that is not set up cannot be tested');
await page.locator('#key-api-anthropic').fill('sk-test-key');
await provider('api-anthropic').getByRole('button', { name: 'Save' }).click();
await provider('api-anthropic').locator('.pill.ready').waitFor();
check((await page.locator('#key-api-anthropic').inputValue()) === '', 'a saved key does not stay in the page');
await section('Agent').click();
check(await page.locator('label.check', { hasText: 'Anthropic API' }).locator('input').isEnabled(), 'a provider with a key can be chosen as the agent');
await section('API keys').click();
await provider('api-anthropic').locator('summary').click();
await provider('api-anthropic').getByRole('button', { name: 'Test the connection' }).click();
await provider('api-anthropic').locator('.test.ok').waitFor();
check(/claude-opus-5-5 answered/.test(await provider('api-anthropic').locator('.test').textContent()), 'the connection test names the model that answered');
await page.locator('#key-api-anthropic').fill('bad-key');
await page.locator('#key-api-anthropic').press('Enter');
await page.waitForFunction(() => document.querySelector('#key-api-anthropic').value === '');
await provider('api-anthropic').getByRole('button', { name: 'Test the connection' }).click();
await provider('api-anthropic').locator('.test.failed').waitFor();
check(/rejected the API key/.test(await provider('api-anthropic').locator('.test').textContent()), 'a rejected key is reported next to the test button');
await provider('api-compatible').locator('summary').click();
check(/Enter the endpoint's address/.test(await provider('api-compatible').locator('.need').textContent()), 'the compatible endpoint asks for its address first');
await page.locator('#address-api-compatible').fill('http://localhost:11434/v1');
await page.locator('#address-api-compatible').press('Tab');
await page.locator('#model-api-compatible').fill('llama');
await page.locator('#model-api-compatible').press('Tab');
await provider('api-compatible').locator('.pill.ready').waitFor();
check(true, 'a local endpoint is ready with an address and a model, without a key');
await provider('api-anthropic').getByRole('button', { name: 'Remove' }).click();
await provider('api-anthropic').locator('.pill:not(.ready)').waitFor();
check(true, 'removing the key makes the provider unavailable again');
await provider('api-anthropic').scrollIntoViewIfNeeded();
await shot('06d-api-providers');
await section('Jobs').click();
await page.getByRole('button', { name: 'High', exact: true }).click();
check(await page.getByRole('button', { name: 'High', exact: true }).evaluate((b) => b.classList.contains('on')), 'the thinking effort can be changed');
await page.getByRole('button', { name: 'Done' }).click();
await page.keyboard.press(`${mod}+,`);
await section('Jobs').click();
check((await page.locator('#set-fix').inputValue()) === '5', 'a changed setting is kept');
await page.keyboard.press('Escape');
check(await page.getByRole('dialog').count() === 0, 'Escape closes a dialog');

// ---- example film in the sandboxed frame
await page.reload();
await page.getByRole('button', { name: 'Watch the example film' }).click();
const frame = page.locator('.canvas iframe');
check((await frame.getAttribute('sandbox')) === 'allow-scripts', 'the artifact frame is sandboxed with scripts only');
await page.locator('.player .chap', { hasText: '1 / 4' }).waitFor({ timeout: 15000 });
check(/ \/ 1:2[23]$/.test(await page.locator('.player .time').textContent()), 'the film reports its length to the host bar', await page.locator('.player .time').textContent());
check(await page.locator('.player .mark').count() === 3, 'the scrubber shows a tick for each later chapter');
await page.getByRole('button', { name: 'Play' }).click();
// The time shows whole seconds, so it changes about one second after playback starts.
const advanced = await page.waitForFunction(() => !document.querySelector('.player .time').textContent.startsWith('0:00'), null, { timeout: 5000 }).then(() => true, () => false);
await page.getByRole('button', { name: 'Pause' }).click();
check(advanced, 'Play advances the film', await page.locator('.player .time').textContent());
const scrub = await page.locator('.player .scrub').boundingBox();
await page.mouse.click(scrub.x + scrub.width * 0.5, scrub.y + scrub.height / 2);
await page.locator('.player .chap', { hasText: '3 / 4' }).waitFor({ timeout: 5000 });
check(true, 'clicking the scrubber seeks to another chapter');
await page.waitForTimeout(300);
await shot('07-film');
await page.locator('.player select').selectOption('1.25');
await page.getByRole('button', { name: 'Turn sound on' }).click();
await page.getByRole('button', { name: 'Mute' }).waitFor({ timeout: 3000 });
check(true, 'the sound button switches the film\'s sound and mirrors its state');

// ---- the film is drawn in the app's theme
const exampleFrame = page.frameLocator('.canvas iframe');
await page.keyboard.press(`${mod}+,`);
await section('Appearance').click();
await page.getByRole('button', { name: 'Light', exact: true }).click();
await page.getByRole('button', { name: 'Done' }).click();
await exampleFrame.locator('html[data-theme="light"]').waitFor({ timeout: 5000 });
await page.locator('.canvas iframe:not(.dark-stage)').waitFor({ timeout: 5000 });
const paper = await page.locator('.canvas').evaluate((el) => getComputedStyle(el).backgroundColor);
check(paper === 'rgb(247, 245, 239)', 'in the light theme the film and the canvas behind it are light', paper);
await shot('07b-film-light');
await page.keyboard.press(`${mod}+,`);
await section('Appearance').click();
await page.getByRole('button', { name: 'Dark', exact: true }).click();
await page.getByRole('button', { name: 'Done' }).click();
await exampleFrame.locator('html:not([data-theme])').waitFor({ timeout: 5000 });
await page.locator('.canvas iframe.dark-stage').waitFor({ timeout: 5000 });
check(true, 'back in the dark theme the film is dark again, without reloading');

// ---- example visual
await page.locator('.tab', { hasText: 'Visual' }).click();
await page.locator('.zoomctl').waitFor();
await page.waitForTimeout(800);
await page.getByRole('button', { name: 'Zoom in' }).click();
await page.waitForTimeout(200);
await shot('08-visual');
await page.getByRole('button', { name: 'Close example' }).click();
await page.getByRole('button', { name: 'Open folder…' }).waitFor();
check(true, 'closing the example returns to the welcome screen');

check(errors.length === 0, 'the page logged no errors', errors.join(' | '));
await browser.close();
server.close();
if (failed) { console.error(`${failed} check(s) failed. Screenshots are in ${out}`); process.exit(1); }
console.log(`All interface checks pass in ${engineName}. Screenshots are in ${out}`);
