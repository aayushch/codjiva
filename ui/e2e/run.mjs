// End-to-end test of the interface in a browser, without the desktop app.
//
// It serves the built interface (ui/dist) with the in-memory backend, plus the
// three built reference artifacts, and drives the pages the way a user would.
// Run `npm run build` first. A screenshot of each state is written to e2e/out/.
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
if (!existsSync(path.join(dist, 'index.html'))) {
  console.error('ui/dist is missing. Run `npm run build` first.');
  process.exit(2);
}
mkdirSync(path.join(out, 'artifact/reference'), { recursive: true });

// Build the three reference artifacts. The example views load the film and the
// visual, and the mock shows them, and the pipeline, as the results of its
// jobs.
const build = (name) =>
  execFileSync(
    'cargo',
    [
      'run',
      '-q',
      '-p',
      'codjiva-build',
      '--',
      path.join(root, 'runtime/reference', name),
      path.join(out, 'artifact/reference', name + '.html'),
    ],
    { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] },
  );
build('film');
build('visual');
build('pipeline');
build('stepthrough');
// The four reference views, which the mock shows for a view of each name.
for (const view of ['schema', 'lanes', 'structure', 'map'])
  execFileSync(
    'cargo',
    [
      'run',
      '-q',
      '-p',
      'codjiva-build',
      '--',
      path.join(root, 'runtime/reference/views', view),
      path.join(out, 'artifact/reference', `view-${view}.html`),
    ],
    { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] },
  );

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
};
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const file = url.pathname.startsWith('/__artifact/')
    ? path.join(out, 'artifact', url.pathname.slice('/__artifact/'.length))
    : path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(out) && !file.startsWith(dist)) {
    response.writeHead(403).end();
    return;
  }
  try {
    response
      .writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      })
      .end(readFileSync(file));
  } catch {
    response.writeHead(404).end('not found');
  }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}/`;

const engineName = process.argv.includes('--browser')
  ? process.argv[process.argv.indexOf('--browser') + 1]
  : 'chromium';
const browser = await (engineName === 'webkit' ? webkit : chromium).launch();
// The app follows the system's colour scheme until the theme setting says
// otherwise. The test tells the browser which scheme the system has: dark
// unless `--scheme light` is given.
const scheme = process.argv.includes('--scheme')
  ? process.argv[process.argv.indexOf('--scheme') + 1]
  : 'dark';
const context = await browser.newContext({
  viewport: { width: 1600, height: 960 },
  deviceScaleFactor: 1,
  colorScheme: scheme,
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

let failed = 0;
const check = (ok, name, detail) => {
  if (!ok) failed++;
  console.log(
    (ok ? 'ok    ' : 'FAIL  ') +
      name +
      (ok || detail == null ? '' : '\n      ' + detail),
  );
};
const shot = (name) =>
  page.screenshot({ path: path.join(out, `${engineName}-${name}.png`) });
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
// The tree row whose name is exactly `name`.
const row = (name) =>
  page.locator('.row').filter({ has: page.getByText(name, { exact: true }) });
// The command of an open menu whose label starts with `label`. The sentence
// that explains a command is in the same element, so the label is matched by
// itself.
const menuCommand = (label) =>
  page.locator('.menu-item').filter({
    has: page.locator('.menu-label', {
      hasText: new RegExp('^\\s*' + label),
    }),
  });
// Shows one kind of artifact of the selected file, as a user does: opens the
// menu of the toolbar's "Visuals" button and chooses the kind called `label`.
const showKind = async (label) => {
  await page.locator('.tab.kinds').click();
  await menuCommand(label).click();
};

await page.goto(base);

// ---- welcome
await page.getByRole('button', { name: 'Open folder…' }).waitFor();
check(
  (await page.locator('.recent').count()) === 2,
  'welcome lists recent workspaces',
);
check(
  await page.evaluate(() => document.fonts.check('13px "JetBrains Mono"')),
  'the app font is loaded',
);
await shot('01-welcome');

// ---- open a workspace, browse the tree
await page.locator('.recent', { hasText: 'shop' }).click();
await row('internal').waitFor();
const topRows = await page.locator('.row .name').allTextContents();
check(
  JSON.stringify(topRows) ===
    JSON.stringify(['internal', 'web', 'go.mod', 'Makefile', 'README.md']),
  'the tree lists folders first, then files',
  JSON.stringify(topRows),
);
check(
  (await page.locator('.titlebar .ws').textContent()) === 'shop',
  'the title bar shows the workspace name',
);
await row('internal').click();
await row('orders').click();
await row('handler.go').click();
await page.locator('.empty .fname', { hasText: 'handler.go' }).waitFor();
await page.locator('.empty .meta', { hasText: 'lines' }).waitFor();
const meta = await page.locator('.empty .meta').textContent();
check(
  /Go/.test(meta) &&
    /\d+ lines/.test(meta) &&
    (await page.locator('.empty .pick').count()) === 6 &&
    (await page.locator('.empty .pick.made').count()) === 0,
  'the empty state shows language, line count and the six views to make',
  meta,
);
check(
  (await page.locator('.empty .path').textContent()) ===
    'internal/orders/handler.go',
  'the empty state shows the path',
);
check(
  (await page.locator('.row.selected .name').textContent()) === 'handler.go',
  'the selected row is marked',
);
const crumb = (await page.locator('.toolbar .crumb').textContent()).replace(
  /\s+/g,
  '',
);
check(
  crumb === 'internal/orders/handler.go',
  'the toolbar shows the path as a breadcrumb',
  crumb,
);
await shot('02-empty-state');

// ---- the job panel before any job: closed, with a handle on the bottom edge
// of the window
const dockHandle = page.getByRole('separator', {
  name: 'Resize the job panel',
});
const dockBox = () => page.locator('.dock').boundingBox();
const windowHeight = page.viewportSize().height;
{
  const closed = await dockHandle.boundingBox();
  check(
    (await page.locator('.dock').count()) === 0 &&
      closed &&
      Math.round(closed.y + closed.height) === windowHeight,
    'with the job panel closed, its handle lies on the bottom edge of the window',
    JSON.stringify(closed),
  );
  await dockHandle.click();
  check(
    /No job has run/.test(await page.locator('.dock.idle').textContent()),
    'a click on the handle opens the job panel, which says that nothing has run yet',
  );
  await page
    .locator('.dock.idle')
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  check(
    (await page.locator('.dock').count()) === 0,
    'the empty job panel closes again',
  );
}

// ---- Visualise: the .gitignore question once, then the instructions step,
// then the job
check(
  /Mock Agent · ready/.test(
    await page.locator('.titlebar .agent').textContent(),
  ),
  'the title bar shows the agent that will run jobs',
);
await page
  .locator('.empty')
  .getByRole('button', { name: 'Visualise', exact: true })
  .click();
await page.getByRole('dialog').getByText('to .gitignore?').waitFor();
check(
  (await page.getByRole('dialog').getByRole('button').allTextContents()).join(
    ' | ',
  ) === 'Do not ask again | Ask later | Keep tracked (share with team) | Add',
  'the .gitignore question can be added, kept tracked, put off, or stopped',
  (await page.getByRole('dialog').getByRole('button').allTextContents()).join(
    ' | ',
  ),
);
await shot('03-gitignore');
await page.getByRole('button', { name: 'Add', exact: true }).click();
await page.getByRole('dialog').getByText('Visualise handler.go').waitFor();
check(true, 'after the .gitignore answer the instructions step opens');
await page
  .locator('#instructions-text')
  .fill('Show what happens when the batch is full');
await page.locator('.chip').first().click();
const typed = await page.locator('#instructions-text').inputValue();
check(
  typed.startsWith('Show what happens when the batch is full Emphasise '),
  'a suggestion chip adds to the instructions',
  typed,
);
await shot('03b-instructions');
await page
  .getByRole('dialog')
  .getByRole('button', { name: 'Visualise' })
  .click();
await page.locator('.dock .step.now').first().waitFor();
check(
  await page.getByRole('button', { name: 'Visualising…' }).isDisabled(),
  'the file shows that a job is running for it',
);
await page.locator('.dock .log .tool').first().waitFor();
await page.waitForTimeout(500);
await shot('03c-job');
// The job ends with the visual on screen, after the hidden frame has run the
// real self-test.
await page.locator('.inspector').waitFor({ timeout: 40000 });
check(
  /Done\. The visual passed every check\./.test(
    await page.locator('.dock .log').textContent(),
  ),
  'the job log ends with the outcome',
  (await page.locator('.dock .log').textContent()).slice(-200),
);
check(
  /write guard: no file outside the version folder changed/.test(
    await page.locator('.dock .log').textContent(),
  ),
  'the job log shows the write guard result',
);
check(
  /\$0\.42/.test(await page.locator('.dock-meta').textContent()),
  'the dock shows what the job cost',
);
check(
  (await page.locator('.validator').count()) === 0,
  'the hidden validation frame is removed after the check',
);
check(
  (await page.locator('.row.selected .badge.dot').count()) === 1,
  'the file gets a badge in the tree',
);
check(
  (await page.locator('.lib-item').count()) === 1,
  'the visual appears in the library',
);
// Every folder above the file has a small dot, also when it is closed. The
// background of such a row stays clear, because a background means that the
// row is selected or under the mouse.
check(
  (await row('internal').locator('.dot.inside').count()) === 1 &&
    (await row('orders').locator('.dot.inside').count()) === 1 &&
    (await page.locator('.row .dot.inside').count()) === 2,
  'the folders above a file with a visual have a small dot',
);
await row('internal').click();
await page.mouse.move(800, 400);
check(
  (await row('internal').locator('.dot.inside').count()) === 1 &&
    (await row('internal').evaluate(
      (el) => getComputedStyle(el).backgroundColor === 'rgba(0, 0, 0, 0)',
    )) &&
    (await row('handler.go').count()) === 0,
  'a closed folder shows that a file inside it has a visual',
);
await shot('03d-tree-dots');
await row('internal').click();
await row('handler.go').waitFor();
await page.getByRole('button', { name: 'Close', exact: true }).click();

// ---- the library can be closed to its heading, and its top edge can be
// dragged
const libraryHeight = () =>
  page
    .locator('.library')
    .evaluate((el) => Math.round(el.getBoundingClientRect().height));
const heightAsMade = await libraryHeight();
await page.locator('.lib-toggle').click();
check(
  (await page.locator('.lib-item').count()) === 0 &&
    (await libraryHeight()) <= 38 &&
    /1/.test(await page.locator('.lib-toggle .count').textContent()),
  "clicking the library's heading leaves only the heading, with the number of artifacts",
);
await page.locator('.lib-toggle').click();
check(
  (await page.locator('.lib-item').count()) === 1 &&
    (await libraryHeight()) === heightAsMade,
  'clicking the heading again shows the list',
);
const grip = await page.locator('.library .splitter').boundingBox();
await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
await page.mouse.down();
await page.mouse.move(grip.x + grip.width / 2, grip.y - 200, { steps: 4 });
await page.mouse.up();
check(
  Math.abs((await libraryHeight()) - (heightAsMade + 203)) <= 4,
  "dragging the library's top edge up makes it taller",
  `${heightAsMade} -> ${await libraryHeight()}`,
);
await page.mouse.move(grip.x + grip.width / 2, grip.y - 200);
await page.mouse.down();
await page.mouse.move(grip.x + grip.width / 2, grip.y - 2000, { steps: 4 });
await page.mouse.up();
check(
  (await page
    .locator('.tree')
    .evaluate((el) => Math.round(el.getBoundingClientRect().height))) >= 120,
  'the library cannot be dragged over the whole file tree',
  String(await libraryHeight()),
);
await shot('03d-library-tall');
await page.mouse.move(
  grip.x + grip.width / 2,
  await page
    .locator('.library .splitter')
    .evaluate((el) => el.getBoundingClientRect().top + 3),
);
await page.mouse.down();
await page.mouse.move(grip.x + grip.width / 2, 2000, { steps: 4 });
await page.mouse.up();
check(
  (await libraryHeight()) === 96,
  'the library keeps a least height while its list is showing',
  String(await libraryHeight()),
);
// The library is left tall enough for the rows that later steps click.
await page.mouse.move(
  grip.x + grip.width / 2,
  await page
    .locator('.library .splitter')
    .evaluate((el) => el.getBoundingClientRect().top + 3),
);
await page.mouse.down();
await page.mouse.move(grip.x + grip.width / 2, 560, { steps: 4 });
await page.mouse.up();

// ---- the job panel can be shown again, and the toolbar's icons say what they
// do
check((await page.locator('.dock').count()) === 0, 'Close hides the job panel');
{
  // Dragging the handle up from the bottom edge opens the panel at the height
  // of the drag.
  const across = (await dockHandle.boundingBox()).x + 300;
  const drag = async (fromY, toY) => {
    await page.mouse.move(across, fromY);
    await page.mouse.down();
    await page.mouse.move(across, toY, { steps: 6 });
    await page.mouse.up();
  };
  await drag(windowHeight - 3, windowHeight - 300);
  check(
    (await page.evaluate(() => String(window.getSelection()))) === '',
    'dragging a handle does not select the text the pointer passes over',
    await page.evaluate(() => String(window.getSelection()).slice(0, 80)),
  );
  let box = await dockBox();
  check(
    box &&
      Math.abs(box.height - 297) <= 4 &&
      (await page.locator('.dock .outcome').count()) === 1,
    'dragging the handle up from the bottom edge shows the job panel again, with the last job in it',
    JSON.stringify(box),
  );
  await drag(box.y, box.y + 100);
  box = await dockBox();
  check(
    box && Math.abs(box.height - 197) <= 4,
    'dragging the top edge of the job panel changes its height',
    JSON.stringify(box),
  );
  await drag(box.y, 40);
  box = await dockBox();
  const mainBox = await page.locator('main.main').boundingBox();
  check(
    mainBox.height >= 160,
    'the job panel cannot be dragged over the whole editor area',
    `${mainBox.height} left, panel ${box.height}`,
  );
  await drag(box.y, windowHeight - 90);
  check(
    (await dockBox()).height === 120,
    'the job panel keeps a least height while it is open',
    String((await dockBox())?.height),
  );
  await drag((await dockBox()).y, windowHeight - 20);
  check(
    (await page.locator('.dock').count()) === 0,
    'dragging the job panel down to the bottom edge closes it',
  );
  await page.keyboard.press(`${mod}+Shift+Y`);
  check(
    (await page.locator('.dock').count()) === 1,
    'the key for the job panel shows it',
  );
  await page.keyboard.press(`${mod}+Shift+Y`);
  check((await page.locator('.dock').count()) === 0, 'the same key hides it');
}

// ---- the inspector: the same handle on its left edge, a button and a key
{
  const windowWidth = page.viewportSize().width;
  const handle = page.getByRole('separator', { name: 'Resize the inspector' });
  const width = async () =>
    (await page.locator('.inspector').boundingBox())?.width ?? 0;
  const drag = async (fromX, toX) => {
    await page.mouse.move(fromX, 400);
    await page.mouse.down();
    await page.mouse.move(toX, 400, { steps: 6 });
    await page.mouse.up();
  };
  const edgeOf = async () => {
    const box = await handle.boundingBox();
    return box.x + box.width / 2;
  };
  check(
    (await width()) === 320,
    'the inspector starts 320 pixels wide',
    String(await width()),
  );
  await drag(await edgeOf(), windowWidth - 420);
  check(
    Math.abs((await width()) - 420) <= 3,
    'dragging the left edge of the inspector changes its width',
    String(await width()),
  );
  await drag(await edgeOf(), 300);
  check(
    (await width()) === 560,
    'the inspector has a greatest width',
    String(await width()),
  );
  await drag(await edgeOf(), windowWidth - 200);
  check(
    (await width()) === 240,
    'the inspector keeps a least width while it is open',
    String(await width()),
  );
  await drag(await edgeOf(), windowWidth - 10);
  const closed = await handle.boundingBox();
  check(
    (await page.locator('.inspector').count()) === 0 &&
      Math.round(closed.x + closed.width) === windowWidth,
    'dragging the inspector to the right edge closes it and leaves its handle there',
    JSON.stringify(closed),
  );
  await drag(windowWidth - 4, windowWidth - 330);
  check(
    Math.abs((await width()) - 326) <= 4,
    'dragging the handle in from the right edge shows the inspector again',
    String(await width()),
  );
  const button = page
    .locator('.titlebar')
    .getByRole('button', { name: 'Inspector' });
  await button.click();
  check(
    (await page.locator('.inspector').count()) === 0,
    'the inspector button in the title bar hides the inspector',
  );
  await handle.click();
  check(
    (await page.locator('.inspector').count()) === 1,
    'a click on the handle at the right edge shows it',
  );
  await page.keyboard.press(`${mod}+Alt+Digit0`);
  check(
    (await page.locator('.inspector').count()) === 0,
    'the key for the inspector hides it',
  );
  await button.click();
  await drag(await edgeOf(), windowWidth - 320);
  check(
    (await width()) === 320,
    'the inspector is back at its first width',
    String(await width()),
  );
}
const panelButton = page
  .locator('.titlebar')
  .getByRole('button', { name: 'Job panel' });
await panelButton.hover();
check(
  await panelButton.evaluate(
    (el) =>
      getComputedStyle(el, '::after').display !== 'none' &&
      getComputedStyle(el, '::after').content.includes('Show the job panel'),
  ),
  'the job panel button has a label that appears at once',
);
await panelButton.click();
check(
  (await page.locator('.dock .outcome').count()) === 1,
  'the button in the title bar shows the job panel again, with the last job in it',
);
await panelButton.click();
check(
  (await page.locator('.dock').count()) === 0,
  'the same button hides the job panel',
);
const actionNames = await page
  .locator('.toolbar .actions button')
  .evaluateAll((buttons) => buttons.map((b) => b.getAttribute('aria-label')));
check(
  actionNames.join(' | ') ===
    'Regenerate… | Animate… | Export HTML | Open in browser | Reveal in .codjiva',
  'the actions on the version are icons in the toolbar',
  actionNames.join(' | '),
);
const exportButton = page
  .locator('.toolbar')
  .getByRole('button', { name: 'Export HTML' });
await exportButton.hover();
check(
  await exportButton.evaluate(
    (el) =>
      getComputedStyle(el, '::after').display === 'block' &&
      getComputedStyle(el, '::after').content.includes(
        'Export as an HTML file',
      ),
  ),
  'an icon shows its label as soon as the pointer is over it',
);
await shot('03d-toolbar-tip');
// The page inside the frame is see-through around its drawing, so the grid
// shows there.
check(
  await page
    .locator('.canvas iframe')
    .evaluate((el) => getComputedStyle(el).colorScheme === 'light'),
  'the frame of an artifact has the colour scheme of its page, which keeps it see-through',
);
// The toolbar is as wide as the editor area and the inspector together, and
// the controls at its right end stay where they are when the inspector goes
// away. The Source button is measured. The "Visuals" button beside it is as
// wide as its label, which is the name of the kind on screen.
const placeOf = (selector) =>
  page.locator(selector).evaluate((el) => {
    const box = el.getBoundingClientRect();
    return [
      Math.round(box.left),
      Math.round(box.right),
      Math.round(box.bottom),
    ];
  });
const tabsWithInspector = await placeOf('.toolbar .source-tab');
const barWithInspector = await placeOf('.toolbar');
const inspectorTop = await page
  .locator('.inspector')
  .evaluate((el) => Math.round(el.getBoundingClientRect().top));
check(
  inspectorTop === barWithInspector[2] &&
    barWithInspector[1] === page.viewportSize().width,
  'the inspector is below the toolbar, which reaches the right edge of the window',
  JSON.stringify({ inspectorTop, barWithInspector }),
);
await showKind('Film');
await page.locator('.empty').waitFor();
check(
  (await page.locator('.inspector').count()) === 0 &&
    JSON.stringify(await placeOf('.toolbar .source-tab')) ===
      JSON.stringify(tabsWithInspector),
  'the tabs do not move when the inspector closes',
  JSON.stringify([tabsWithInspector, await placeOf('.toolbar .source-tab')]),
);
await showKind('Blueprint');
await page.locator('.inspector').waitFor();

// ---- the visual: select a part, follow a code reference, switch a layer
const visual = page.frameLocator('.canvas iframe');
await visual.locator('.v-submit').waitFor({ timeout: 15000 });
const gate = await visual.locator('.v-submit').boundingBox();
await page.mouse.click(gate.x + gate.width / 2, gate.y + gate.height / 2);
await page
  .locator('.inspector h3', { hasText: 'Submit()' })
  .waitFor({ timeout: 5000 });
check(true, 'clicking a machine shows its name and role in the inspector');
// The inspector also shows the detail of the part: the lines of its code,
// read from the file, what it reads and writes, where the work goes on, and
// its edge cases.
await page.locator('.inspector .excerpt-line').first().waitFor();
const partDetail = await page.evaluate(() => {
  const inspector = document.querySelector('.inspector');
  return {
    firstLine: inspector.querySelector('.excerpt-num').textContent,
    lines: inspector.querySelectorAll('.excerpt-line').length,
    heading: inspector.querySelector('.excerpt .ref').textContent,
    io: Array.from(inspector.querySelectorAll('.io-row')).map(
      (el) => el.textContent,
    ),
    transitions: Array.from(inspector.querySelectorAll('.transition')).map(
      (el) => el.textContent.replace(/\s+/g, ' ').trim(),
    ),
    edgeCase: inspector.querySelector('.edge-case')?.textContent ?? '',
  };
});
check(
  partDetail.firstLine === '20' &&
    partDetail.lines === 7 &&
    partDetail.heading === 'handler.go:20–26' &&
    partDetail.io.includes('o: the order') &&
    partDetail.transitions[0] === 'the order is valid → flushLocked()' &&
    /repeated ID/.test(partDetail.edgeCase) &&
    /handler\.go:22/.test(partDetail.edgeCase),
  'the inspector shows the code, the inputs, the transitions and the edge cases of a part',
  JSON.stringify(partDetail),
);
// A transition that leads to another part selects that part.
await page.locator('.inspector .transition button').first().click();
await page.locator('.inspector h3', { hasText: 'flushLocked()' }).waitFor();
// The drawing learns of the selection through a message, a moment later.
await visual.locator('.v-flush.cj-selected').waitFor();
check(true, 'a transition in the inspector selects the part it leads to');
await page.mouse.click(gate.x + gate.width / 2, gate.y + gate.height / 2);
await page.locator('.inspector h3', { hasText: 'Submit()' }).waitFor();
await shot('03d-visual');
check(
  await visual.locator('.v-pipe10').isVisible(),
  'the data layer starts on',
);
await page.getByRole('switch', { name: 'Data flow' }).click();
// The switch reaches the visual as a message, so the change arrives a moment
// later.
const hidden = await visual
  .locator('.v-pipe10')
  .waitFor({ state: 'hidden', timeout: 3000 })
  .then(
    () => true,
    () => false,
  );
check(hidden, 'switching a layer off in the inspector hides it in the visual');
await page.getByRole('switch', { name: 'Data flow' }).click();

// ---- rationale: why a part is built the way it is
const flushMachine = await visual.locator('.v-flush').boundingBox();
await page.mouse.click(
  flushMachine.x + 14,
  flushMachine.y + flushMachine.height - 14,
);
await page.locator('.inspector h3', { hasText: 'flushLocked()' }).waitFor();
const nodeRationale = page.locator('.inspector .rationale');
check(
  (await page
    .locator('.inspector .kicker', { hasText: 'Rationale' })
    .count()) === 1 &&
    /the next flush writes it again/.test(await nodeRationale.textContent()) &&
    (await nodeRationale.locator('code').textContent()) === 'flushLocked' &&
    (await nodeRationale.locator('.basis').textContent()) ===
      'Stated in the code' &&
    (await nodeRationale.locator('button.ref').textContent()) ===
      'handler.go:33',
  'a selected part shows its rationale, where the reason comes from and the line that shows it',
  await nodeRationale.textContent(),
);
await shot('03e-rationale');
const whyShown = () =>
  visual
    .locator('.cj-marker.cj-why')
    .evaluateAll(
      (els) =>
        els.filter((el) => getComputedStyle(el).display !== 'none').length,
    );
check(
  (await whyShown()) === 0,
  'the "?" markers of a visual are hidden at first',
);
await page.getByRole('switch', { name: 'Rationale' }).click();
await page.waitForTimeout(300);
check(
  (await whyShown()) === 4 &&
    (await page
      .getByRole('switch', { name: 'Rationale' })
      .getAttribute('aria-checked')) === 'true',
  'the Rationale switch shows a "?" marker on each part that has a rationale',
  String(await whyShown()),
);
await shot('03f-rationale-markers');
await page.getByRole('switch', { name: 'Rationale' }).click();
await page.waitForTimeout(300);
check((await whyShown()) === 0, 'switching it off hides the markers again');
await nodeRationale.locator('button.ref').click();
await page.locator('.source-line.ref').waitFor({ timeout: 5000 });
check(
  (await page.locator('.source-line.ref .source-num').textContent()).trim() ===
    '33',
  "the reference of a rationale opens the source at the reason's line",
);
await showKind('Blueprint');
await visual.locator('.v-submit').waitFor({ timeout: 15000 });
const gateAgain = await visual.locator('.v-submit').boundingBox();
await page.mouse.click(
  gateAgain.x + gateAgain.width / 2,
  gateAgain.y + gateAgain.height / 2,
);
await page.locator('.inspector h3', { hasText: 'Submit()' }).waitFor();
check(
  (await page.locator('.inspector .rationale').count()) === 0,
  'a part without a rationale shows none',
);
await page.locator('.inspector button.ref').first().click();
await page.locator('.source-line.ref').waitFor({ timeout: 5000 });
check(
  (await page.locator('.source-line.ref .source-num').textContent()).trim() ===
    '20',
  'a code reference opens the source at its line',
);
await showKind('Blueprint');
await page.locator('.inspector').waitFor();

// ---- regenerate adds a version; the instructions are remembered
await page
  .locator('.toolbar')
  .getByRole('button', { name: 'Regenerate…' })
  .click();
check(
  (await page.locator('#instructions-text').inputValue()) === typed,
  'Regenerate starts from the instructions of the version on screen',
);
await page
  .getByRole('dialog')
  .getByRole('button', { name: 'Regenerate' })
  .click();
await page.locator('.dock .outcome').waitFor({ timeout: 40000 });
const versions = await page.locator('.toolbar select option').allTextContents();
check(
  versions.length === 2 &&
    versions[0].startsWith('v2') &&
    versions[1].includes('(earlier)'),
  'the version picker lists both versions, newest first',
  JSON.stringify(versions),
);
await page.locator('.toolbar select').selectOption('1');
await page.getByText('You are looking at an earlier version.').waitFor();
check(true, 'an earlier version can be shown');
await page.locator('.toolbar select').selectOption('2');

// ---- editing a source file marks the visual stale; nothing regenerates by
// itself
await page.evaluate(() => window.__mockEditFile('internal/orders/handler.go'));
await page.locator('.toolbar .badge-stale').waitFor({ timeout: 5000 });
check(
  (await page.locator('.row.selected .badge.hollow').count()) === 1,
  'the tree badge turns hollow when the visual is stale',
);
check(
  /handler\.go.*changed after this version was made/.test(
    await page.locator('.inspector').textContent(),
  ),
  'the inspector says which file changed and offers Regenerate',
);
check(
  (await page.locator('.toolbar select option').count()) === 2,
  'a stale visual is not regenerated automatically',
);
await shot('03e-stale');

// ---- a running job can be cancelled
await page
  .locator('.toolbar')
  .getByRole('button', { name: 'Regenerate…' })
  .click();
await page
  .getByRole('dialog')
  .getByRole('button', { name: 'Regenerate' })
  .click();
await page.locator('.dock .step.now').first().waitFor();
await page.getByRole('button', { name: 'Cancel' }).click();
await page
  .locator('.dock .log', { hasText: 'Cancelled.' })
  .waitFor({ timeout: 5000 });
check(
  (await page.locator('.toolbar select option').count()) === 2,
  'a cancelled job adds no version',
);
await page.getByRole('button', { name: 'Close', exact: true }).click();

// ---- several jobs at the same time: a second file can be visualised while
// the first job runs, and only a second job for the same visual is refused
await page
  .locator('.toolbar')
  .getByRole('button', { name: 'Regenerate…' })
  .click();
await page
  .getByRole('dialog')
  .getByRole('button', { name: 'Regenerate' })
  .click();
await page.locator('.dock .step.now').first().waitFor();
check(
  await page
    .locator('.toolbar')
    .getByRole('button', { name: 'Regenerate…' })
    .isDisabled(),
  'a visual cannot be regenerated while a job is making a version of it',
);
await row('store.go').click();
const visualiseOther = page
  .locator('.empty')
  .getByRole('button', { name: 'Visualise', exact: true });
await visualiseOther.waitFor();
check(
  !(await visualiseOther.isDisabled()),
  'another file can be visualised while that job runs',
);
await visualiseOther.click();
await page
  .getByRole('dialog')
  .getByRole('button', { name: 'Visualise' })
  .click();
await page.locator('.dock .job-row').nth(1).waitFor();
check(
  (await page.locator('.dock .job-row').count()) === 2 &&
    (await page.locator('.dock .job-pick .state.running').count()) === 2,
  'the job panel lists both running jobs',
);
check(
  /2 jobs running/.test(await page.locator('.titlebar .agent').textContent()),
  'the title bar says how many jobs are running',
);
check(
  /store\.go/.test(await page.locator('.dock .steps .kicker').textContent()) &&
    (await page.locator('.dock .job-row.on').textContent()).includes(
      'store.go',
    ),
  'the job panel shows the job that was started last',
);
check(
  await page
    .locator('.empty')
    .getByRole('button', { name: 'Visualising…' })
    .isDisabled(),
  'the second file shows that a job is running for it',
);
await page.locator('.dock .log .tool').first().waitFor();
// The whole title of a job, with its status, is shown as soon as the pointer
// is over the job in the list.
await page.locator('.dock .job-pick', { hasText: 'handler.go' }).hover();
check(
  (await page.locator('.job-tip').count()) === 1 &&
    (await page.locator('.job-tip').textContent()).trim() ===
      'Visualise · handler.go (running)' &&
    (await page.locator('.dock .job-pick[title]').count()) === 0,
  'a job in the list shows its whole title and status under the pointer at once',
  await page.locator('.job-tip').allTextContents(),
);
await shot('03f-two-jobs');
await page.mouse.move(800, 400);
check(
  (await page.locator('.job-tip').count()) === 0,
  'the label of a job in the list goes when the pointer leaves the job',
);
await page.locator('.dock .job-pick', { hasText: 'handler.go' }).click();
check(
  /handler\.go/.test(await page.locator('.dock .steps .kicker').textContent()),
  'clicking a job in the list shows that job',
);
await page.getByRole('button', { name: 'Cancel' }).click();
await page
  .locator('.dock .log', { hasText: 'Cancelled.' })
  .waitFor({ timeout: 5000 });
check(
  (await page.locator('.dock .job-pick .state.running').count()) === 1 &&
    /Mock Agent · working/.test(
      await page.locator('.titlebar .agent').textContent(),
    ),
  'cancelling one job leaves the other running',
);
await page.locator('.dock .job-pick', { hasText: 'store.go' }).click();
await page.getByRole('button', { name: 'Cancel' }).click();
await page
  .locator('.dock .log', { hasText: 'Cancelled.' })
  .waitFor({ timeout: 5000 });
await page.locator('.dock .job-row.on .job-drop').click();
check(
  (await page.locator('.dock .job-list').count()) === 0 &&
    /handler\.go/.test(
      await page.locator('.dock .steps .kicker').textContent(),
    ),
  'a job that has ended can be removed from the list',
);
await page.getByRole('button', { name: 'Close', exact: true }).click();
await row('handler.go').click();
await page.locator('.toolbar select').waitFor();
check(
  (await page.locator('.toolbar select option').count()) === 2 &&
    (await page.locator('.lib-item').count()) === 1,
  'the cancelled jobs added nothing',
);

// ---- Animate: companions, instructions and length, then the outline, then the
// film
await showKind('Film');
await page.getByRole('button', { name: 'Animate with companions…' }).click();
await page.getByRole('dialog').getByText('Animate handler.go').waitFor();
await page.locator('.companions .check').first().waitFor();
const companionRows = await page
  .locator('.companions .check')
  .evaluateAll((rows) =>
    rows.map((row) => [
      row.textContent.trim().split(/\s{2,}/)[0],
      row.querySelector('input').checked,
    ]),
  );
check(
  companionRows.length === 4 &&
    companionRows[0][0].startsWith('internal/orders/handler_test.go') &&
    companionRows[0][1] &&
    companionRows[1][1] &&
    !companionRows[2][1],
  'the Animate dialog lists suggested companions with reasons and ticks the strongest',
  JSON.stringify(companionRows),
);
check(
  !companionRows.some(([text]) => text.startsWith('vendor/')),
  'a file in a folder on the ignore list is not suggested',
  JSON.stringify(companionRows),
);

// ---- a suggested companion can be ignored for good, as a file or as a folder
// it is in
const ignoreDialog = page.locator('.dialog.ignore');
await page
  .locator('.companions .companion', { hasText: 'limiter.go' })
  .getByRole('button', { name: 'Ignore always…' })
  .click();
await ignoreDialog.waitFor();
await page.keyboard.press('Escape');
await ignoreDialog.waitFor({ state: 'detached' });
check(
  (await page.locator('.dialog.animate').isVisible()) &&
    (await page.locator('.companions .companion').count()) === 4,
  'Escape closes the ignore dialog only, and nothing is ignored',
);
await page
  .locator('.companions .companion', { hasText: 'lib/acme/metrics/counter.go' })
  .getByRole('button', { name: 'Ignore always…' })
  .click();
await ignoreDialog.waitFor();
check(
  (await ignoreDialog.locator('#ignore-pattern').inputValue()) ===
    '/lib/acme/metrics/counter.go' &&
    (await ignoreDialog.locator('.scope').count()) === 4,
  'the ignore dialog starts from the file itself and offers each folder above it',
);
await ignoreDialog.locator('.scope').nth(2).click();
check(
  (await ignoreDialog.locator('#ignore-pattern').inputValue()) === '/lib/acme/',
  'choosing a folder puts its pattern in the field',
);
await ignoreDialog
  .getByText(
    'Matches 3 code files in this workspace, 1 of them in the list of companions.',
  )
  .waitFor();
await ignoreDialog.locator('#ignore-pattern').fill('/lib/[z-a]/');
await ignoreDialog.getByText('This cannot be read as a pattern.').waitFor();
check(
  await ignoreDialog
    .getByRole('button', { name: 'Ignore always' })
    .isDisabled(),
  'a pattern that cannot be read cannot be added',
);
await ignoreDialog.locator('#ignore-pattern').fill('/lib/acme/');
await ignoreDialog.getByText('Matches 3 code files').waitFor();
await shot('09a-ignore-dialog');
await ignoreDialog.getByRole('button', { name: 'Ignore always' }).click();
await ignoreDialog.waitFor({ state: 'detached' });
check(
  (await page.locator('.companions .companion').count()) === 3 &&
    (await page
      .locator('.companions .companion', { hasText: 'lib/acme' })
      .count()) === 0,
  "the ignored folder's file leaves the list of companions",
);
check(
  (await page.locator('.companions .check input:checked').count()) === 2,
  'ignoring a file keeps the ticks of the others',
);
await page.getByLabel('Add a companion file').fill('ledger');
await page.locator('.hit').first().click();
check(
  await page
    .locator('.companions .check', { hasText: 'ledger.py' })
    .locator('input')
    .isChecked(),
  'any file can be added as a companion',
);
// The dialog says how long the film usually takes to make. The range follows
// the length the user picks.
const estimateLine = page.locator('.dialog.animate .estimate');
const rangeOf = async () =>
  ((await estimateLine.textContent()) ?? '').match(
    /Usually takes (\d+–\d+ min) to make\./,
  )?.[1];
await page.getByRole('button', { name: 'Deep · ~5 min' }).click();
await page.waitForFunction(() =>
  /Usually takes \d+–\d+ min to make/.test(
    document.querySelector('.dialog.animate .estimate')?.textContent ?? '',
  ),
);
const deepRange = await rangeOf();
check(
  !!deepRange &&
    /first estimate from the size of the code/.test(
      (await estimateLine.textContent()) ?? '',
    ),
  'the Animate dialog says how long the film usually takes to make',
  await estimateLine.textContent(),
);
await page.evaluate(() => (window.__mockEstimateSamples = 4));
await page.locator('#animate-text').fill('Follow one order to the store');
await page.getByRole('button', { name: 'Short · ~1 min' }).click();
await page.waitForFunction(
  (deep) =>
    !(
      document.querySelector('.dialog.animate .estimate')?.textContent ?? deep
    ).includes(deep),
  deepRange,
);
const shortRange = await rangeOf();
check(
  !!shortRange &&
    parseInt(shortRange) < parseInt(deepRange) &&
    /Going by 4 earlier jobs with Mock Agent on this computer/.test(
      ((await estimateLine.textContent()) ?? '').replace(/\s+/g, ' '),
    ),
  'the estimate is shorter for a shorter film and names the earlier jobs it goes by',
  `${deepRange} then ${await estimateLine.textContent()}`,
);
await shot('09-animate-dialog');
await page
  .getByRole('dialog')
  .getByRole('button', { name: 'Animate', exact: true })
  .click();
await page.locator('.outline-pane').waitFor();
check(
  (await page.locator('.dock .kicker').first().textContent()) ===
    'Animate · handler.go',
  'the dock names the job and the file',
);
check(
  (await page.locator('.outline-list li').count()) === 3,
  'the story outline is shown while the film is being made',
);
const animateRequest = await page.evaluate(() => window.__mockLastRequest);
check(
  animateRequest.kind === 'animate' &&
    animateRequest.lengthSeconds === 60 &&
    animateRequest.companions.length === 3 &&
    animateRequest.instructions === 'Follow one order to the store',
  'the job is started with the ticked companions, the instructions and the length',
  JSON.stringify(animateRequest),
);
await page
  .locator('.dock .step.now', { hasText: 'Animating chapter' })
  .waitFor();
check(
  (await page.locator('.dock .pill.estimate').textContent()) ===
    `usually ${shortRange}`,
  'the dock says how long the running job usually takes',
  await page.locator('.dock .pill.estimate').textContent(),
);
// The tags under the job's title are on one line and inside the column, and the
// row of buttons below the steps holds the Cancel button and no tag.
const dockLayout = await page.evaluate(() => {
  const column = document.querySelector('.dock .steps').getBoundingClientRect();
  const pills = Array.from(document.querySelectorAll('.dock-meta .pill')).map(
    (el) => el.getBoundingClientRect(),
  );
  const foot = document.querySelector('.dock-foot');
  return {
    pills: pills.length,
    oneLine: pills.every((box) => Math.abs(box.top - pills[0].top) < 1),
    inside: pills.every(
      (box) => box.left >= column.left && box.right <= column.right,
    ),
    footButtons: Array.from(foot.querySelectorAll('button')).map((el) =>
      el.textContent.trim(),
    ),
    footPills: foot.querySelectorAll('.pill').length,
  };
});
check(
  dockLayout.pills === 3 &&
    dockLayout.oneLine &&
    dockLayout.inside &&
    dockLayout.footButtons.join() === 'Cancel' &&
    dockLayout.footPills === 0,
  'the tags of a job are on one line, and Cancel is by itself below the steps',
  JSON.stringify(dockLayout),
);
// A step whose label is too long for one line wraps, grows taller, and pushes
// the next step down. The label is made longer here because the in-memory
// backend plays no fix round, which is the step with the longest label.
const wrapped = await page.evaluate(() => {
  const steps = Array.from(document.querySelectorAll('.dock .step'));
  const label = steps[0].querySelector('.label');
  const text = label.textContent;
  const before = steps[0].getBoundingClientRect().height;
  label.textContent = 'Fixing what the checks found in the film (round 12)';
  const first = steps[0].getBoundingClientRect();
  const second = steps[1].getBoundingClientRect();
  const words = label.getBoundingClientRect();
  const result = {
    before,
    after: first.height,
    clear: second.top >= words.bottom,
  };
  label.textContent = text;
  return result;
});
check(
  wrapped.after > wrapped.before && wrapped.clear,
  'a step with a long label wraps without touching the step below it',
  JSON.stringify(wrapped),
);
await shot('09b-animate-job');
// The user reads the source while the film is being made. The finished film
// replaces the source view without a click.
await page.locator('.tab.source-tab').click();
await page.locator('.player:not(.waiting)').waitFor({ timeout: 60000 });
check(
  (await page.locator('.tab.kinds.on', { hasText: 'Film' }).count()) === 1 &&
    (await page.locator('.dock .outcome').count()) === 1 &&
    (await page
      .locator('.dock')
      .getByRole('button', { name: 'Show the film' })
      .count()) === 0,
  'a finished film is shown on the Film tab without a click',
);
check(
  /4 chapters/.test(await page.locator('.inspector').textContent()),
  'the film is shown with its chapters in the inspector',
);
await page.locator('.tab.kinds').click();
const madeMarks = [
  await menuCommand('Blueprint').locator('.menu-mark').innerText(),
  await menuCommand('Film').locator('.menu-mark').innerText(),
];
await page.keyboard.press('Escape');
check(
  madeMarks.join() === 'made,made' &&
    (await page.locator('.lib-item').count()) === 2,
  'the file now has a film next to its blueprint',
  madeMarks.join(),
);
await page.getByRole('button', { name: 'Close', exact: true }).click();
await page.locator('.chapter-row').nth(2).click();
await page.waitForFunction(() =>
  /^3 \/ 4/.test(document.querySelector('.player .chap').textContent),
);
check(true, 'clicking a chapter in the inspector seeks the film to it');
// The film's rationales are listed in the inspector, each under the heading
// of its bubble. A click on a heading goes to the chapter of that bubble.
const filmRationales = page.locator('.inspector .rationale-item');
check(
  (await filmRationales.count()) === 2 &&
    (await filmRationales.locator('.rationale-head').allTextContents()).join(
      ' | ',
    ) === 'ROUTING · PRIORITY | FLUSH · flushLocked()' &&
    (await filmRationales.locator('.basis.inferred').count()) === 1 &&
    (await filmRationales.locator('.on').count()) === 0,
  'the inspector lists the rationales of a film and says which are inferred',
  await filmRationales.allTextContents().then((all) => all.join(' | ')),
);
await filmRationales.nth(1).locator('.rationale-head').click();
await page.waitForFunction(() =>
  /^4 \/ 4/.test(document.querySelector('.player .chap').textContent),
);
check(
  await filmRationales.nth(1).evaluate((el) => el.classList.contains('on')),
  'a click on the heading of a rationale goes to its chapter, and the rationale is marked',
);
check(
  (await page
    .frameLocator('.canvas iframe')
    .locator('.cj-why-chip')
    .count()) === 3,
  'the bubbles of the film that have a rationale carry a chip',
);
await shot('09f-film-rationale');
await page.locator('.chapter-row').nth(2).click();
await page.waitForFunction(() =>
  /^3 \/ 4/.test(document.querySelector('.player .chap').textContent),
);
const speed = page.getByLabel('Speed');
check(
  (await speed.locator('option').allTextContents()).join(' ') ===
    '0.75× 1× 1.25× 2× 4×',
  'the film can be slowed to 0.75× and sped up to 4×',
);
await speed.selectOption('4');
await page.waitForTimeout(600);
check(
  (await speed.inputValue()) === '4' &&
    (await speed.locator('option[value="4"]').isEnabled()),
  'the film reports that it plays at 4×',
);
await speed.selectOption('1');
await shot('09c-film');

// ---- Back and Forward: a code link leaves the film, Back returns to it where
// it was
const seconds = async () => {
  const [m, sec] = (await page.locator('.player .time').textContent())
    .trim()
    .split(' / ')[0]
    .split(':')
    .map(Number);
  return m * 60 + sec;
};
const backButton = page
  .locator('.toolbar')
  .getByRole('button', { name: 'Back', exact: true });
const forwardButton = page
  .locator('.toolbar')
  .getByRole('button', { name: 'Forward', exact: true });
const leftAt = await seconds();
check(
  leftAt > 30 &&
    (await forwardButton.isDisabled()) &&
    (await backButton.isEnabled()),
  'Forward is disabled at the newest place and Back is enabled',
  String(leftAt),
);
// Every companion file is given 600 lines, so that the file that opens is
// much longer than the window.
await page.evaluate(() => {
  const text = Array.from(
    { length: 600 },
    (_, i) => `    total += lines[${i}].price // line ${i + 1}`,
  ).join('\n');
  for (const name of [
    'internal/billing/ledger.py',
    'internal/orders/store.go',
    'internal/orders/limiter.go',
    'internal/orders/handler_test.go',
  ])
    window.__mockSetFile(name, text + '\n');
});
await page.locator('.inspector .companion .ref').first().click();
await page.locator('.tab.source-tab.on').waitFor();
await page.locator('.source-line').first().waitFor();
// Scrolls the source view to its end and measures where things are.
const longSource = await page.evaluate(async () => {
  const source = document.querySelector('.source');
  source.scrollTop = source.scrollHeight;
  await new Promise((done) => setTimeout(done, 200));
  const box = source.getBoundingClientRect();
  const lines = Array.from(source.querySelectorAll('.source-line'));
  const last = lines[lines.length - 1];
  return {
    pageScrolls: document.scrollingElement.scrollHeight - window.innerHeight,
    sourceBottom: Math.round(box.bottom),
    barTop: Math.round(
      document.querySelector('.source-bar').getBoundingClientRect().top,
    ),
    windowHeight: window.innerHeight,
    lastNumber: last.querySelector('.source-num').textContent,
    gapAfterLastLine: Math.round(
      box.bottom - last.getBoundingClientRect().bottom,
    ),
  };
});
check(
  longSource.pageScrolls <= 0 &&
    longSource.barTop < longSource.windowHeight &&
    longSource.sourceBottom === longSource.barTop,
  'a long file scrolls inside the source view and the bar under it stays in the window',
  JSON.stringify(longSource),
);
check(
  longSource.lastNumber === '600' &&
    longSource.gapAfterLastLine >= 0 &&
    longSource.gapAfterLastLine < 20,
  'the last line of a long file is at the bottom of the source view when it is scrolled to its end',
  JSON.stringify(longSource),
);
check(
  /ledger\.py|store\.go|limiter\.go|handler_test\.go/.test(
    await page.locator('.toolbar .crumb').textContent(),
  ) && (await page.locator('.player').count()) === 0,
  'a companion file opens in the source view',
  await page.locator('.toolbar .crumb').textContent(),
);
const companionCrumb = await page.locator('.toolbar .crumb').textContent();
await backButton.hover();
check(
  await backButton.evaluate(
    (el) =>
      getComputedStyle(el, '::after').display === 'block' &&
      /^"Back \(/.test(getComputedStyle(el, '::after').content),
  ),
  'the Back button says what it does and names its keys',
);
await shot('09c-back-tip');
await backButton.click();
await page.locator('.player:not(.waiting)').waitFor({ timeout: 20000 });
await page
  .waitForFunction(
    () =>
      !/^0:0[0-2] /.test(
        document.querySelector('.player .time').textContent.trim(),
      ),
    null,
    { timeout: 5000 },
  )
  .catch(() => {});
check(
  /handler\.go/.test(await page.locator('.toolbar .crumb').textContent()) &&
    (await page.locator('.tab.kinds.on', { hasText: 'Film' }).count()) === 1,
  'Back returns to the film the link was clicked in',
);
check(
  Math.abs((await seconds()) - leftAt) <= 3,
  'the film continues from the moment it was left at',
  `${leftAt} -> ${await seconds()}`,
);
check(await forwardButton.isEnabled(), 'Forward is enabled after going back');
await forwardButton.click();
await page.locator('.tab.source-tab.on').waitFor();
check(
  (await page.locator('.toolbar .crumb').textContent()) === companionCrumb,
  'Forward goes to the companion file again',
);
// The browser build is not macOS to the app, so Back is Alt with the left
// arrow.
await page.keyboard.press('Alt+ArrowLeft');
await page.locator('.player:not(.waiting)').waitFor({ timeout: 20000 });
check(
  (await page.locator('.tab.kinds.on', { hasText: 'Film' }).count()) === 1,
  'the keyboard goes back as well',
);
// Going somewhere new from the middle of the list drops the places after it.
await showKind('Blueprint');
await page.locator('.inspector', { hasText: 'This blueprint' }).waitFor();
check(
  await forwardButton.isDisabled(),
  'a new place replaces the ones Forward led to',
);
await backButton.click();
await page.locator('.player:not(.waiting)').waitFor({ timeout: 20000 });

// ---- a film continues where it was left when its tab is opened again
{
  const filmWasAt = await seconds();
  await page.locator('.tab.source-tab').click();
  await page.locator('.source-line').first().waitFor();
  await showKind('Film');
  await page.locator('.player:not(.waiting)').waitFor({ timeout: 20000 });
  await page
    .waitForFunction(
      () =>
        !/^0:0[0-2] /.test(
          document.querySelector('.player .time').textContent.trim(),
        ),
      null,
      { timeout: 5000 },
    )
    .catch(() => {});
  check(
    filmWasAt > 30 && Math.abs((await seconds()) - filmWasAt) <= 3,
    'a film that is opened again by its tab continues where it was left',
    `${filmWasAt} -> ${await seconds()}`,
  );

  // The film's buttons name themselves at once, above the bar.
  const play = page
    .locator('.player')
    .getByRole('button', { name: /^(Play|Pause)$/ });
  await play.hover();
  check(
    await play.evaluate((el) => {
      const tip = getComputedStyle(el, '::after');
      return (
        tip.display === 'block' &&
        /\(Space\)/.test(tip.content) &&
        parseFloat(tip.bottom) > 0
      );
    }),
    'the Play button has a label that appears at once, above it',
  );

  // A click inside the film does not take the keyboard away from the app.
  const stage = await page.locator('.canvas iframe').boundingBox();
  await page.mouse.click(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await page.waitForTimeout(200);
  check(
    await page.evaluate(() => document.activeElement?.tagName !== 'IFRAME'),
    'a click inside the film leaves the keyboard focus with the app',
  );
  await page.keyboard.press('Alt+ArrowLeft');
  await page
    .locator('.tab.source-tab.on')
    .waitFor({ timeout: 5000 })
    .catch(() => {});
  check(
    (await page.locator('.tab.source-tab.on').count()) === 1,
    'the key for Back works after a click inside the film',
  );
  await page.keyboard.press('Alt+ArrowRight');
  await page.locator('.player:not(.waiting)').waitFor({ timeout: 20000 });
  if (
    await page.locator('.player').getByRole('button', { name: 'Pause' }).count()
  )
    await page
      .locator('.player')
      .getByRole('button', { name: 'Pause' })
      .click();

  // Back passes over a file that was deleted after the user looked at it.
  await row('README.md').click();
  await page.locator('.toolbar .crumb', { hasText: 'README.md' }).waitFor();
  await row('go.mod').click();
  await page.locator('.toolbar .crumb', { hasText: 'go.mod' }).waitFor();
  await page.evaluate(() => window.__mockDeleteFile('README.md'));
  await backButton.click();
  await page.locator('.player:not(.waiting)').waitFor({ timeout: 20000 });
  check(
    /handler\.go/.test(await page.locator('.toolbar .crumb').textContent()) &&
      (await page
        .locator('.toast', { hasText: 'README.md is no longer there.' })
        .count()) === 1,
    'Back passes over a deleted file, says so, and shows the place before it',
    await page.locator('.toolbar .crumb').textContent(),
  );
  check(
    await forwardButton.isEnabled(),
    'Forward still leads to the place after the deleted file',
  );
}

// ---- feedback on the film: a pinned moment, a pointed-at element, then a new
// version
const filmScrub = await page.locator('.player .scrub').boundingBox();
await page.keyboard.down('Alt');
await page.mouse.click(
  filmScrub.x + filmScrub.width * 0.5,
  filmScrub.y + filmScrub.height / 2,
);
await page.keyboard.up('Alt');
await page.locator('.feedback .pill', { hasText: 'pinned at 0:41' }).waitFor();
check(
  (await page.locator('.player .scrub .pin').count()) === 1,
  'holding Alt while clicking the scrubber pins that moment for feedback',
);
// Where the two buttons of the feedback box are, measured from the top left
// corner of the text box above them, as "x,y x,y". Measuring from the text box
// leaves out how far the inspector is scrolled.
const feedbackButtons = () =>
  page.locator('.feedback').evaluate((box) => {
    const origin = box.querySelector('textarea').getBoundingClientRect();
    return Array.from(box.querySelectorAll('.line .btn'))
      .map((button) => button.getBoundingClientRect())
      .map(
        (at) => `${Math.round(at.x - origin.x)},${Math.round(at.y - origin.y)}`,
      )
      .join(' ');
  });
const buttonsBefore = await feedbackButtons();
await page.getByRole('button', { name: 'Point at…' }).click();
await page.locator('.feedback .picking').waitFor();
await page.getByRole('button', { name: 'Stop pointing' }).waitFor();
check(
  (await feedbackButtons()) === buttonsBefore,
  'the buttons of the feedback box stay in place when "Point at…" is clicked',
  `${buttonsBefore} -> ${await feedbackButtons()}`,
);
const filmFrame = page.frameLocator(
  'iframe[aria-label="How an order moves through the orders Handler"]',
);
await filmFrame.locator('body.picking').waitFor();
// The camera is zoomed in, so some machines are outside the frame. One whose
// centre is inside the frame is clicked.
const frameBox = await page
  .locator('iframe[aria-label="How an order moves through the orders Handler"]')
  .boundingBox();
const machines = filmFrame.locator('.scene-box:visible [data-cj="machine"]');
let target = null;
for (let i = 0; i < (await machines.count()) && !target; i++) {
  const box = await machines.nth(i).boundingBox();
  const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
  if (
    cx > frameBox.x + 20 &&
    cx < frameBox.x + frameBox.width - 20 &&
    cy > frameBox.y + 80 &&
    cy < frameBox.y + frameBox.height - 20
  )
    target = [cx, cy];
}
await page.mouse.click(target[0], target[1]);
await page.locator('.feedback .pill', { hasText: 'points at:' }).waitFor();
check(
  (await feedbackButtons()) === buttonsBefore,
  'the buttons stay in place when the pointed-at element is attached',
  `${buttonsBefore} -> ${await feedbackButtons()}`,
);
check(
  (await filmFrame.locator('body.picking').count()) === 0,
  'pointing at an element attaches it and ends point-at mode',
);
await page.getByLabel('Feedback').fill('This machine needs a clearer label');
await shot('09d-feedback');
await page.getByRole('button', { name: 'Send feedback' }).click();
await page
  .locator('.dock .kicker', { hasText: 'Film feedback · handler.go' })
  .waitFor();
const feedbackRequest = await page.evaluate(() => window.__mockLastRequest);
check(
  feedbackRequest.kind === 'feedback' &&
    feedbackRequest.baseVersion === 1 &&
    feedbackRequest.feedback.text === 'This machine needs a clearer label' &&
    Math.abs(feedbackRequest.feedback.time - 41.5) < 3 &&
    !!feedbackRequest.feedback.pointAt.selector &&
    feedbackRequest.feedback.pointAt.box.length === 4 &&
    !!feedbackRequest.feedback.pointAt.scene,
  'the feedback job carries the words, the moment and the pointed-at element',
  JSON.stringify(feedbackRequest.feedback),
);
await page
  .locator('.dock .log', { hasText: 'Done. The film passed every check.' })
  .waitFor({ timeout: 45000 });
await page
  .locator('.inspector', { hasText: 'Changed after feedback' })
  .waitFor();
check(
  (await page.locator('.toolbar select option').count()) === 2 &&
    (await page
      .locator('.feedback .pill', { hasText: 'points at:' })
      .count()) === 0,
  'feedback adds a version and what was attached is cleared',
);
await page.getByRole('button', { name: 'Close', exact: true }).click();

// ---- changing the outline restarts the film with the edited outline
await page
  .locator('.toolbar')
  .getByRole('button', { name: 'Regenerate…' })
  .click();
await page
  .getByRole('dialog')
  .getByText('Make the film again for handler.go')
  .waitFor();
check(
  (await page.locator('.companions .check input:checked').count()) === 3,
  'making a film again starts from the companions of the film on screen',
);
await page
  .getByRole('dialog')
  .getByRole('button', { name: 'Make it again' })
  .click();
await page.locator('.outline-pane').waitFor();
await page.getByRole('button', { name: 'Change the outline…' }).click();
await page.getByLabel('Title of chapter 2').fill('2 · Waiting in the queue');
await page.getByRole('button', { name: 'Remove chapter 3' }).click();
check(
  await page.getByRole('button', { name: 'Remove chapter 1' }).isDisabled(),
  'an outline keeps at least two chapters',
);
await shot('09e-outline');
await page
  .getByRole('button', { name: 'Make the film with this outline' })
  .click();
await page.waitForFunction(
  () =>
    !!window.__mockLastRequest?.outline &&
    document.querySelectorAll('.outline-list li').length === 2,
);
const outlineRequest = await page.evaluate(() => window.__mockLastRequest);
check(
  outlineRequest.outline.chapters.length === 2 &&
    outlineRequest.outline.chapters[1].title === '2 · Waiting in the queue' &&
    outlineRequest.companions.length === 3,
  'the film is started again with the edited outline',
  JSON.stringify(outlineRequest.outline),
);
check(
  (await page.locator('.outline-list li').count()) === 2,
  'the dock shows the edited outline',
);
await page
  .locator('.dock .log', { hasText: 'Done. The film passed every check.' })
  .waitFor({ timeout: 45000 });
await page.locator('.player:not(.waiting)').waitFor({ timeout: 20000 });
check(
  (await page.locator('.toolbar select option').count()) === 3,
  'a film made from an outline the user edited is shown as a new version',
);
await page.getByRole('button', { name: 'Close', exact: true }).click();
await showKind('Blueprint');
await page.locator('.inspector', { hasText: 'This blueprint' }).waitFor();
check(true, 'Blueprint still shows the blueprint of the same file');

// ---- a whole folder: the size estimate and the warning, then a visual of the
// folder
await row('web').hover();
await row('web').locator('.folder-viz').click();
await page.locator('.empty .warn-box').waitFor();
check(
  /This is a large folder\./.test(
    await page.locator('.empty .warn-box').textContent(),
  ) &&
    /about 120 thousand tokens/.test(
      await page.locator('.empty .meta').textContent(),
    ),
  'a large folder shows its size and a stronger warning',
  await page.locator('.empty .meta').textContent(),
);
await row('orders').hover();
await row('orders').locator('.folder-viz').click();
await page.locator('.empty .fname', { hasText: 'orders/' }).waitFor();
check(
  /4 code files/.test(await page.locator('.empty .meta').textContent()) &&
    /costs more than a file/.test(
      await page.locator('.empty .warn-box').textContent(),
    ),
  'selecting a folder shows how much code a visual of it has to read',
  await page.locator('.empty .meta').textContent(),
);
check(
  (await page.locator('.toolbar .tab').allTextContents())
    .map((text) => text.trim())
    .join() === 'Blueprint,Map' &&
    (await page.locator('.toolbar .crumb').textContent()).replace(
      /\s+/g,
      '',
    ) === 'internal/orders/',
  'a folder has the Blueprint tab and the Map tab',
);
await shot('10-folder');
await page.getByRole('button', { name: 'Visualise this folder…' }).click();
check(
  /4 files, about 4 thousand tokens/.test(
    await page.getByRole('dialog').locator('.warn-box').textContent(),
  ),
  'the instructions step repeats the warning before the job starts',
);
await page
  .getByRole('dialog')
  .getByRole('button', { name: 'Visualise the folder' })
  .click();
await page
  .locator('.dock .kicker', { hasText: 'Visualise · orders/' })
  .waitFor();
check(
  (await page.evaluate(() => window.__mockLastRequest.subject[0])) ===
    'internal/orders/',
  'the job is started for the folder',
);
await page
  .locator('.dock .log', { hasText: 'Done. The visual passed every check.' })
  .waitFor({ timeout: 45000 });
await page.locator('.inspector', { hasText: 'This blueprint' }).waitFor();
check(
  (await row('orders').locator('.badge.dot').count()) === 1 &&
    (await page.locator('.lib-item').count()) === 3,
  'the folder gets a badge in the tree and its visual is in the library',
);
await page.getByRole('button', { name: 'Close', exact: true }).click();
await row('handler.go').click();
await page.locator('.inspector', { hasText: 'This blueprint' }).waitFor();

// ---- a pipeline: two artifacts joined where their code meets
await row('store.go').click();
await page
  .locator('.empty')
  .getByRole('button', { name: 'Visualise', exact: true })
  .click();
await page
  .getByRole('dialog')
  .getByRole('button', { name: 'Visualise' })
  .click();
// The user selects another file while the visual is being made. The finished
// visual does not take them away from that file, and the dock offers a button
// that opens it.
await row('handler.go').click();
await page
  .locator('.dock .log', { hasText: 'Done. The visual passed every check.' })
  .waitFor({ timeout: 45000 });
check(
  (await page.locator('.row.selected', { hasText: 'handler.go' }).count()) ===
    1,
  'a visual that finishes while another file is selected does not replace that file',
);
await page
  .locator('.dock')
  .getByRole('button', { name: 'Show the visual' })
  .click();
await page.locator('.inspector', { hasText: 'store.go' }).waitFor();
check(
  (await page.locator('.row.selected', { hasText: 'store.go' }).count()) ===
    1 &&
    (await page
      .locator('.dock')
      .getByRole('button', { name: 'Show the visual' })
      .count()) === 0,
  'the button in the dock opens the finished visual and its file',
);
await page.getByRole('button', { name: 'Close', exact: true }).click();
check(
  /ports · 1 in · 0 out/.test(
    await page.locator('.lib-item', { hasText: 'store.go' }).textContent(),
  ),
  'the library shows how many ports an artifact has',
);
check(
  /Connects to/.test(await page.locator('.inspector').textContent()),
  'an artifact that meets another in the code says what it connects to',
);
await page
  .locator('.lib-item', { hasText: 'store.go' })
  .locator('.lib-tick')
  .check();
check(
  await page.getByRole('button', { name: 'Compose 1…' }).isDisabled(),
  'one ticked artifact is not enough to compose',
);
await page
  .locator('.lib-item', { hasText: 'handler.go' })
  .first()
  .locator('.lib-tick')
  .check();
await page.getByRole('button', { name: 'Compose 2…' }).click();
await page.getByRole('dialog').getByText('Compose a pipeline').waitFor();
await page.locator('.dialog.compose .check').first().waitFor();
const partOrder = await page
  .locator('.dialog.compose .part .t')
  .allTextContents();
check(
  partOrder.length === 2 &&
    /handler\.go/.test(partOrder[0]) &&
    /store\.go/.test(partOrder[1]),
  'the parts are listed in the order work flows, the sender first',
  JSON.stringify(partOrder),
);
const joinRow = page.locator('.dialog.compose .check').first();
check(
  (await joinRow.locator('input').isChecked()) &&
    /Store\.WriteBatch.*same name/.test(
      (await joinRow.textContent()).replace(/\s+/g, ' '),
    ),
  'the join between the two ports is proposed and ticked, with its reason',
  await joinRow.textContent(),
);
await page.locator('#compose-text').fill('Follow one batch to the store');
await shot('11-compose-dialog');
await page
  .getByRole('dialog')
  .getByRole('button', { name: 'Compose', exact: true })
  .click();
await page.locator('.dock .kicker', { hasText: 'Compose · 2 parts' }).waitFor();
const composeRequest = await page.evaluate(() => window.__mockLastRequest);
check(
  composeRequest.kind === 'compose' &&
    composeRequest.parts.length === 2 &&
    composeRequest.joins.length === 1 &&
    composeRequest.joins[0].fromPort === 'out:Store.WriteBatch' &&
    !composeRequest.film,
  'the compose job is started with the parts and the confirmed join',
  JSON.stringify(composeRequest),
);
await page
  .locator('.dock .step', { hasText: 'Checking the joins in the code' })
  .waitFor();
await page
  .locator('.dock .log', { hasText: 'Done. The pipeline passed every check.' })
  .waitFor({ timeout: 45000 });
await page.locator('.inspector', { hasText: 'This pipeline' }).waitFor();
check(
  (await page.locator('.toolbar .crumb').textContent())
    .replace(/\s+/g, ' ')
    .trim() === 'Pipeline / Orders: from the handler to the store',
  'the pipeline opens by itself, under its own name',
);
// The toolbar of a pipeline ends with its action buttons, so their labels are
// the ones nearest the right edge of the window. A label is as wide as its
// text and is not wrapped. The label of a button with the class `tip-end`
// ends at the button's right edge. Any other label is centred under its
// button. A label has a width only while it shows, so each button is hovered
// before its label is measured.
{
  const buttons = page.locator('.toolbar .actions .tb-btn');
  const cutOff = [];
  for (let i = 0; i < (await buttons.count()); i++) {
    await buttons.nth(i).hover();
    const right = await buttons.nth(i).evaluate((button) => {
      const box = button.getBoundingClientRect();
      const style = getComputedStyle(button, '::after');
      const width =
        parseFloat(style.width) +
        parseFloat(style.paddingLeft) +
        parseFloat(style.paddingRight) +
        parseFloat(style.borderLeftWidth) +
        parseFloat(style.borderRightWidth);
      return button.classList.contains('tip-end')
        ? box.right
        : box.left + box.width / 2 + width / 2;
    });
    if (!(right <= page.viewportSize().width))
      cutOff.push(await buttons.nth(i).getAttribute('data-tip'));
  }
  await page.mouse.move(0, 0);
  check(
    cutOff.length === 0,
    'the labels of the toolbar buttons of a pipeline fit inside the window',
    JSON.stringify(cutOff),
  );
}
check(
  (await page.locator('.inspector .part-row').count()) === 2 &&
    /handler.*→.*store/.test(
      (await page.locator('.inspector .join').first().textContent()).replace(
        /\s+/g,
        ' ',
      ),
    ),
  'the inspector lists the parts and the joins of the pipeline',
);
const pipelineFrame = page.frameLocator(
  'iframe[aria-label="Orders: from the handler to the store"]',
);
await pipelineFrame.locator('.cj-bay').first().waitFor();
check(
  (await pipelineFrame.locator('.cj-bay').count()) === 2,
  'the pipeline shows each part in its own bay',
);
check(
  /pipeline · v1/.test(
    (await page.locator('.lib-item.on').textContent()).replace(/\s+/g, ' '),
  ) && (await page.locator('.lib-tick:checked').count()) === 0,
  'the pipeline is in the library and the ticks are cleared',
);
await page.getByRole('button', { name: 'Close', exact: true }).click();
await shot('11b-pipeline');
await page.locator('.inspector .part-row').first().click();
await page.locator('.inspector', { hasText: 'This blueprint' }).waitFor();
check(
  (await page.locator('.row.selected .name').textContent()) === 'handler.go',
  "clicking a part opens that part's own artifact",
);

// ---- source tab
await page.locator('.tab.source-tab').click();
await page.locator('.source-line').first().waitFor();
check(
  (await page.locator('.source-line').first().textContent()).includes(
    'package orders',
  ),
  'the source tab shows the file',
);
await page
  .locator('.source .hljs-keyword')
  .first()
  .waitFor({ timeout: 5000 })
  .catch(() => {});
check(
  (await page.locator('.source .tk-keyword').count()) > 3,
  'the source is coloured',
);
await shot('04-source');

// ---- file tabs
// Every file that was selected so far has a tab. The context menu of a tab
// closes the others.
const tabNames = () => page.locator('.file-tab .name').allTextContents();
const fileTab = (name) =>
  page
    .locator('.file-tab')
    .filter({ has: page.getByText(name, { exact: true }) });
const menuItems = () => page.locator('.menu-item').allTextContents();
check(
  (await tabNames()).length > 1 &&
    (await page.locator('.file-tab.on .name').textContent()) === 'handler.go',
  'every selected file has a tab, and the tab of the file on screen is marked',
  (await tabNames()).join(),
);
await fileTab('handler.go').click({ button: 'right' });
check(
  (await menuItems()).join('|') ===
    'Close|Close the other tabs|Copy path|Copy relative path',
  'a right-click on a tab opens its menu',
  (await menuItems()).join('|'),
);
await page.locator('.menu-item', { hasText: 'Close the other tabs' }).click();
check(
  (await tabNames()).join() === 'handler.go' &&
    (await page.locator('.menu').count()) === 0,
  'Close the other tabs leaves one tab, and choosing a command closes the menu',
  (await tabNames()).join(),
);
await row('store.go').click();
await page.locator('.file-tab.on', { hasText: 'store.go' }).waitFor();
check(
  (await tabNames()).join() === 'handler.go,store.go',
  'a click on a file in the tree opens it in a new tab',
  (await tabNames()).join(),
);
// Each tab remembers its own view. handler.go was left on Source. store.go is
// switched to Blueprint here.
await showKind('Blueprint');
await fileTab('handler.go').click();
await page.locator('.row.selected', { hasText: 'handler.go' }).waitFor();
await page.locator('.source-line').first().waitFor();
const handlerOnSource = await page.locator('.tab.source-tab.on').count();
await fileTab('store.go').click();
await page.locator('.row.selected', { hasText: 'store.go' }).waitFor();
check(
  handlerOnSource === 1 &&
    (await page.locator('.tab.kinds.on', { hasText: 'Blueprint' }).count()) ===
      1,
  'a tab comes back in the view it was left in',
);
// A new tab is put directly after the tab the user came from.
await fileTab('handler.go').click();
await page.locator('.file-tab.on', { hasText: 'handler.go' }).waitFor();
await row('limiter.go').click();
await page.locator('.file-tab.on', { hasText: 'limiter.go' }).waitFor();
check(
  (await tabNames()).join() === 'handler.go,limiter.go,store.go',
  'a new tab is put directly after the tab the user came from',
  (await tabNames()).join(),
);
await shot('13-file-tabs');
// Closing the tab on screen shows the tab to its right.
await fileTab('limiter.go').locator('.file-tab-close').click();
await page.locator('.file-tab.on', { hasText: 'store.go' }).waitFor();
check(
  (await tabNames()).join() === 'handler.go,store.go' &&
    (await page.locator('.row.selected .name').textContent()) === 'store.go',
  'closing the tab on screen shows the tab to its right',
  (await tabNames()).join(),
);
// A click of the middle button closes a tab. This tab is not on screen, so
// the file on screen stays.
await fileTab('handler.go').click({ button: 'middle' });
check(
  (await tabNames()).join() === 'store.go' &&
    (await page.locator('.row.selected .name').textContent()) === 'store.go',
  'a middle click closes a tab and leaves the file on screen alone',
  (await tabNames()).join(),
);
// Closing the last tab leaves nothing selected, and Back opens it again.
await fileTab('store.go').locator('.file-tab-close').click();
await page.getByText('Select a file in the explorer').waitFor();
check(
  (await page.locator('.file-tab').count()) === 0 &&
    (await page.locator('.row.selected').count()) === 0,
  'closing the last tab leaves nothing selected',
);
await page.locator('.toolbar [aria-label="Back"]').click();
await page.locator('.file-tab.on', { hasText: 'store.go' }).waitFor();
check(
  (await tabNames()).join() === 'store.go',
  'Back opens the tab that was closed last',
  (await tabNames()).join(),
);

// ---- the context menu of the tree, and copying a path
// Chromium lets a test read the clipboard once it has been given leave. The
// other engines do not, so there the toast is the only evidence.
const canReadClipboard = engineName === 'chromium';
if (canReadClipboard)
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
await row('limiter.go').click({ button: 'right' });
check(
  (await menuItems()).join('|') ===
    'Visualise…|Animate…|Step through…|Schema view…|Lanes view…|Structure view…|Copy path|Copy relative path' &&
    (await page.evaluate(() => document.activeElement.textContent)) ===
      'Visualise…',
  'a right-click on a file opens a menu, with keyboard focus on its first command',
  (await menuItems()).join('|'),
);
await shot('13b-context-menu');
await page.keyboard.press('ArrowDown');
const afterArrow = await page.evaluate(
  () => document.activeElement.textContent,
);
await page.keyboard.press('Escape');
check(
  afterArrow === 'Animate…' && (await page.locator('.menu').count()) === 0,
  'the arrow keys move through the menu and Escape closes it',
  afterArrow,
);
await row('limiter.go').click({ button: 'right' });
await page.locator('.menu-item', { hasText: 'Copy relative path' }).click();
await page
  .locator('.toast', { hasText: 'Copied internal/orders/limiter.go' })
  .waitFor();
check(
  !canReadClipboard || (await clipboard()) === 'internal/orders/limiter.go',
  'Copy relative path puts the path inside the workspace on the clipboard',
);
await row('limiter.go').click({ button: 'right' });
await page.locator('.menu-item', { hasText: 'Copy path' }).first().click();
const copiedFull = await page
  .locator('.toast', {
    hasText: /Copied .+[\\/]internal[\\/]orders[\\/]limiter\.go/,
  })
  .locator('.toast-text')
  .textContent();
check(
  !canReadClipboard || 'Copied ' + (await clipboard()) === copiedFull,
  'Copy path puts the full path on the clipboard',
  copiedFull,
);
// A folder can be visualised and cannot be animated.
await row('billing').click({ button: 'right' });
check(
  (await menuItems()).join('|') ===
    'Visualise this folder…|Map this folder…|Copy path|Copy relative path',
  'the menu of a folder has no Animate command',
  (await menuItems()).join('|'),
);
await page.keyboard.press('Escape');
// A press of the pointer outside the menu closes it.
await row('limiter.go').click({ button: 'right' });
await page.locator('.titlebar .ws').click();
check(
  (await page.locator('.menu').count()) === 0,
  'a click outside the menu closes it',
);
// Animate in the menu selects the file and opens the Animate dialog for it.
await row('limiter.go').click({ button: 'right' });
await page.locator('.menu-item', { hasText: 'Animate…' }).click();
await page.locator('.dialog', { hasText: 'limiter.go' }).waitFor();
check(
  (await page.locator('.row.selected .name').textContent()) === 'limiter.go' &&
    (await page.locator('.file-tab.on .name').textContent()) === 'limiter.go',
  'Animate in the menu selects the file and opens the Animate dialog',
);
await page.keyboard.press('Escape');
await page.locator('.dialog').waitFor({ state: 'detached' });
// Visualise in the menu opens the instructions step for the file.
await row('limiter.go').click({ button: 'right' });
await page.locator('.menu-item', { hasText: 'Visualise…' }).click();
await page.locator('.dialog', { hasText: 'limiter.go' }).waitFor();
check(
  (await page.getByRole('button', { name: /^Visualise/ }).count()) > 0,
  'Visualise in the menu opens the instructions step for the file',
);
await page.keyboard.press('Escape');
await page.locator('.dialog').waitFor({ state: 'detached' });
// The button after the path in the toolbar copies the path the toolbar shows.
await page.locator('.toolbar .copy-path').click();
await page.locator('.toolbar .copy-path[data-tip="Copied"]').waitFor();
check(
  !canReadClipboard || (await clipboard()) === 'internal/orders/limiter.go',
  'the copy button in the toolbar copies the path and says so',
);
await page.locator('.toolbar .crumb').click({ button: 'right' });
check(
  (await menuItems()).join('|') === 'Copy path|Copy relative path',
  'a right-click on the path in the toolbar offers both ways to copy it',
  (await menuItems()).join('|'),
);
await page.keyboard.press('Escape');
// ---- a step-through: a visual the user can run on an input
await row('limiter.go').click();
await page.locator('.file-tab.on', { hasText: 'limiter.go' }).waitFor();
await showKind('Step-through');
await page.getByRole('button', { name: 'Step through…' }).click();
await page.locator('.dialog', { hasText: 'Step through limiter.go' }).waitFor();
await shot('14-stepthrough-dialog');
await page
  .locator('.dialog')
  .getByRole('button', { name: 'Step through', exact: true })
  .click();
await page
  .locator('.dock .step', { hasText: 'Writing the step function' })
  .waitFor();
const stepRequestKind = await page.evaluate(
  () => window.__mockLastRequest.kind,
);
check(
  (await page.locator('.dock .kicker').first().textContent()).includes(
    'Step through',
  ) && stepRequestKind === 'stepthrough',
  'Step through starts a step-through job, which lists its own steps',
  stepRequestKind,
);
const steps = page.frameLocator('.canvas iframe');
await steps.locator('#cj-count').waitFor({ timeout: 20000 });
await page
  .locator('.inspector .kicker', { hasText: 'Current state' })
  .waitFor();
check(
  (await page.locator('.tab.on').textContent()).includes('Step-through') &&
    (await steps.locator('#cj-count').textContent()) === 'step 1 / 3' &&
    (await page.locator('.inspector h3').first().textContent()) ===
      'Allowing' &&
    /step-through · v1/.test(
      (await page.locator('.lib-item.on').textContent()).replace(/\s+/g, ' '),
    ),
  'the finished step-through is on its own tab, and the inspector describes the state it is in',
  await steps.locator('#cj-count').textContent(),
);
await page.getByRole('button', { name: 'Close', exact: true }).click();
// The inspector follows the steps.
await steps
  .locator('#cj-presets button', { hasText: 'Over the hard limit' })
  .click();
await steps.locator('#cj-last').click();
await page.locator('.inspector h3', { hasText: 'Blocked' }).waitFor();
check(
  (await page.locator('.inspector .edge-case').count()) === 2 &&
    (await page.locator('.inspector .excerpt-line').count()) > 0,
  'the inspector follows the steps, with the edge cases and the code of the state',
);
await shot('14b-stepthrough');
// An edge case with an example runs the step-through on that example.
await page.locator('.inspector .edge-case .chip').first().click();
await steps.locator('#cj-count', { hasText: '/ 61' }).waitFor();
check(
  (await steps.locator('#cj-input').inputValue()) === 'o'.repeat(61) &&
    (await steps.locator('#cj-count').textContent()) === 'step 1 / 61',
  'an edge case in the inspector runs the step-through on its example',
  await steps.locator('#cj-count').textContent(),
);
// A click on a state pins it in the inspector, whatever the step on screen.
const noWindow = await steps.locator('.v-none').first().boundingBox();
await page.mouse.click(
  noWindow.x + noWindow.width / 2,
  noWindow.y + noWindow.height / 2,
);
await page.locator('.inspector .kicker', { hasText: 'Selected' }).waitFor();
check(
  (await page.locator('.inspector h3').first().textContent()) === 'No window',
  'a click on a state pins it in the inspector',
);
// The strip of panels under the step-through is resized by dragging its top
// edge, and the app remembers the height.
{
  // The height of the strip, and how far the bottom of the zoom controls is
  // above the strip's top edge.
  const strip = async () => {
    const panel = await steps.locator('#steppanel').boundingBox();
    const zoom = await page.locator('.zoomctl').boundingBox();
    return {
      height: Math.round(panel.height),
      zoomGap: Math.round(panel.y - (zoom.y + zoom.height)),
    };
  };
  const before = await strip();
  const edge = await steps.locator('#stepgrip').boundingBox();
  const x = edge.x + edge.width / 2;
  const y = edge.y + edge.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 120, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(
    () => window.__mockSettings().layout.stepPanelHeight != null,
    null,
    { timeout: 5000 },
  );
  const dragged = await strip();
  const saved = await page.evaluate(
    () => window.__mockSettings().layout.stepPanelHeight,
  );
  check(
    before.height === 190 &&
      before.zoomGap === 12 &&
      dragged.height === 310 &&
      dragged.zoomGap === 12 &&
      saved === 310,
    "dragging the top edge of a step-through's panels makes them taller, moves the zoom buttons up and saves the height",
    JSON.stringify({ before, dragged, saved }),
  );
  await shot('14c-stepthrough-tall');
  // Leaving the step-through and coming back loads its page again.
  await page.locator('.tab.source-tab').click();
  await showKind('Step-through');
  await steps.locator('#cj-count').waitFor({ timeout: 20000 });
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('.zoomctl')).bottom === '322px',
    null,
    { timeout: 5000 },
  );
  const reopened = await strip();
  check(
    reopened.height === 310 && reopened.zoomGap === 12,
    'a step-through that is opened again has the height its panels were dragged to',
    JSON.stringify(reopened),
  );
}
// The context menu now offers to make the step-through again.
await row('limiter.go').click({ button: 'right' });
check(
  (await menuItems()).includes('Step through again…'),
  'the menu of a file that has a step-through offers to make it again',
  (await menuItems()).join('|'),
);
await page.keyboard.press('Escape');

// ---- the views, which Codjiva draws from data
// The menu of the "Visuals" button lists the six kinds of a file. The
// sentence on what a kind is for is shown while the pointer is on its command.
await row('handler.go').click();
await page.locator('.file-tab.on', { hasText: 'handler.go' }).waitFor();
await page.locator('.tab.kinds').click();
const kindLabels = await page
  .locator('.menu-item .menu-label')
  .evaluateAll((labels) =>
    labels.map((label) => label.firstChild.textContent.trim()),
  );
const shownDetails = () => page.locator('.menu-detail.shown');
const detailsAtFirst = await shownDetails().count();
await menuCommand('Lanes').hover();
const lanesDetail = await shownDetails().allInnerTexts();
// The box of the sentence must be beside the menu, inside the window.
const detailPlace = await page.evaluate(() => {
  const menu = document.querySelector('.menu').getBoundingClientRect();
  const box = document
    .querySelector('.menu-detail.shown')
    .getBoundingClientRect();
  return { besideMenu: box.right <= menu.left, inWindow: box.left >= 0 };
});
await shot('14-kind-menu');
await page.mouse.move(40, 500);
const detailsAfter = await shownDetails().count();
check(
  kindLabels.join('|') ===
    'Blueprint|Film|Step-through|Schema|Lanes|Structure|Which view fits this file?',
  'the Visuals button lists the six kinds of a file',
  kindLabels.join('|'),
);
check(
  detailsAtFirst === 0 &&
    lanesDetail.length === 1 &&
    lanesDetail[0].startsWith('Who talks to whom') &&
    detailPlace.besideMenu &&
    detailPlace.inWindow &&
    detailsAfter === 0,
  'the menu explains a kind only while the pointer is on it',
  JSON.stringify({ detailsAtFirst, lanesDetail, detailPlace, detailsAfter }),
);
// The arrow keys show the sentence of the command they move to.
await page.keyboard.press('ArrowDown');
check(
  (await shownDetails().allInnerTexts()).join().startsWith('A film in'),
  'an arrow key shows what the command it moves to is for',
  (await shownDetails().allInnerTexts()).join(),
);
await menuCommand('Schema').click();
await page.getByRole('button', { name: 'Make the schema view…' }).click();
await page
  .locator('.dialog', { hasText: 'Make the schema view of handler.go' })
  .waitFor();
await page
  .locator('.dialog')
  .getByRole('button', { name: 'Make the view', exact: true })
  .click();
await page
  .locator('.dock .kicker', { hasText: 'Schema · handler.go' })
  .waitFor();
const viewRequest = await page.evaluate(() => window.__mockLastRequest);
const schema = page.frameLocator('.canvas iframe');
await schema.locator('.v-Order').first().waitFor({ timeout: 20000 });
check(
  viewRequest.kind === 'view' &&
    viewRequest.view === 'schema' &&
    (await page.locator('.tab.kinds.on').textContent()).includes('Schema') &&
    /schema view · v1/.test(
      (await page.locator('.lib-item.on').textContent()).replace(/\s+/g, ' '),
    ),
  'a view job makes the schema view, and the Visuals button has its name',
  JSON.stringify(viewRequest),
);
await page.getByRole('button', { name: 'Close', exact: true }).click();
// Selecting a type shows its fields, and who writes each of them.
// Closing the job panel gives the frame more room, and the drawing is fitted
// again a moment later. `settled` returns the box of an element once the
// element has stopped moving, so that a click lands on it.
const settled = async (locator) => {
  let box = await locator.boundingBox();
  for (let tries = 0; tries < 20; tries++) {
    await page.waitForTimeout(100);
    const again = await locator.boundingBox();
    const still = again.x === box.x && again.y === box.y;
    box = again;
    if (still) break;
  }
  return box;
};
const orderCard = await settled(schema.locator('.v-Order').first());
await page.mouse.click(orderCard.x + 40, orderCard.y + 12);
await page.locator('.inspector h3', { hasText: /^Order$/ }).waitFor();
const fieldsShown = await page.evaluate(() => ({
  fields: document.querySelectorAll('.inspector .field-row').length,
  uses: Array.from(document.querySelectorAll('.inspector .field-use')).map(
    (el) => el.textContent.replace(/\s+/g, ' ').trim(),
  ),
}));
check(
  fieldsShown.fields === 9 &&
    fieldsShown.uses.includes('written by price') &&
    fieldsShown.uses.includes('read by Submit'),
  'the inspector lists the fields of a type and the functions that write and read them',
  JSON.stringify(fieldsShown),
);
await shot('15-schema-view');
// The function that writes a field leads to its line in the source.
await page
  .locator('.inspector .field-use button', { hasText: 'price' })
  .first()
  .click();
await page.locator('.tab.source-tab.on').waitFor();
// The in-memory backend's copy of the file is shorter than the real file the
// view was made of, so the line itself cannot be looked for here.
check(
  /handler\.go/.test(await page.locator('.toolbar .crumb').textContent()) &&
    (await page.locator('.source-line').count()) > 0,
  'a function that writes a field opens the source of its file',
);

// A lanes view is played one message at a time, like a step-through.
await showKind('Lanes');
await page.getByRole('button', { name: 'Make the lanes view…' }).click();
await page
  .locator('.dialog')
  .getByRole('button', { name: 'Make the view', exact: true })
  .click();
const lanes = page.frameLocator('.canvas iframe');
await lanes.locator('#cj-count').waitFor({ timeout: 20000 });
await page.getByRole('button', { name: 'Close', exact: true }).click();
await lanes.locator('#cj-next').click();
await page.locator('.inspector h3', { hasText: 'Limiter' }).waitFor();
check(
  (await lanes.locator('#cj-count').textContent()) === 'step 2 / 6' &&
    (await page.locator('.zoomctl.above-strip').count()) === 1,
  'a lanes view is stepped through, and the inspector follows the participant',
  await lanes.locator('#cj-count').textContent(),
);
await shot('15b-lanes-view');

// A folder has a map. Its menu in the explorer starts one.
await row('orders').click({ button: 'right' });
await page.locator('.menu-item', { hasText: 'Map this folder…' }).click();
await page.locator('.dialog', { hasText: 'Make the map of orders/' }).waitFor();
await page
  .locator('.dialog')
  .getByRole('button', { name: 'Make the map', exact: true })
  .click();
const map = page.frameLocator('.canvas iframe');
await map.locator('.v-orders').first().waitFor({ timeout: 20000 });
await page.getByRole('button', { name: 'Close', exact: true }).click();
check(
  (await page.locator('.tab.on').textContent()).trim().startsWith('Map') &&
    (await page.locator('.file-tab.on .name').textContent()) === 'orders/',
  'the map of a folder is shown on the Map tab of the folder',
);
// Two clicks on a box that has parts inside open its level.
const packageBox = await settled(map.locator('.v-orders').first());
await page.mouse.dblclick(
  packageBox.x + packageBox.width / 2,
  packageBox.y + 20,
);
await map.locator('#stepbar [data-page="orders"]').waitFor();
// A node that stands for a file links to it and to what was made of it.
const fileBox = await settled(map.locator('.v-handler').first());
await page.mouse.click(fileBox.x + fileBox.width / 2, fileBox.y + 20);
await page.locator('.inspector h3', { hasText: 'handler.go' }).waitFor();
const mapLinks = await page.locator('.inspector button.ref').allTextContents();
check(
  mapLinks.some((text) => text.includes('Open internal/orders/handler.go')) &&
    mapLinks.some((text) => text.includes('Show its schema view')) &&
    mapLinks.some((text) => text.includes('Show its blueprint')),
  'a file on the map links to the file and to everything that was made of it',
  mapLinks.join(' | '),
);
await shot('15c-map-view');
await page
  .locator('.inspector button.ref', { hasText: 'Show its schema view' })
  .click();
await page.locator('.file-tab.on', { hasText: 'handler.go' }).waitFor();
check(
  (await page.locator('.tab.kinds.on').textContent()).includes('Schema'),
  'a link on the map opens the schema view of that file',
);

// The checks that follow were written with the Source view showing, which a
// file opened next keeps.
await page.locator('.tab.source-tab').click();
await page.locator('.source-line').first().waitFor();

// ---- quick open
await page.keyboard.press(`${mod}+p`);
await page.getByPlaceholder('Go to file…').fill('ledger');
await page.locator('.quick-row').first().waitFor();
await shot('05-quick-open');
await page.keyboard.press('Enter');
await page.locator('.row.selected', { hasText: 'ledger.py' }).waitFor();
check(
  (await row('billing').count()) === 1,
  'quick-open selects the file and expands the folders above it',
);

// ---- the tree keeps its scroll position while the user works in it
// The window is made short, so that the tree is shorter than its rows and
// can be scrolled. ledger.py is selected and is the third row.
await page.setViewportSize({ width: 1600, height: 560 });
const tree = page.locator('.tree');
const scrollDown = () =>
  tree.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return el.scrollTop;
  });
// True when the selected row is inside the visible part of the tree.
const selectedInView = () =>
  page.evaluate(() => {
    const view = document.querySelector('.tree').getBoundingClientRect();
    const row = document.querySelector('.row.selected');
    if (!row) return false;
    const box = row.getBoundingClientRect();
    return box.top >= view.top - 1 && box.bottom <= view.bottom + 1;
  });
// The folder `web` is closed first when it is open, so that the click below
// opens it. Opening a folder adds rows below it and leaves every row above
// it where it is.
const webWasOpen = (await row('src').count()) === 1;
if (webWasOpen) {
  await row('web').click();
  await row('src').waitFor({ state: 'detached' });
}
// The tree is scrolled until the row of `web` is its first visible row.
// The selected row is then above the visible part.
const scrolledTo = await tree.evaluate((el) => {
  const web = Array.from(el.querySelectorAll('.row')).find(
    (one) => one.getAttribute('title') === 'web',
  );
  el.scrollTop +=
    web.getBoundingClientRect().top - el.getBoundingClientRect().top;
  return el.scrollTop;
});
await page.waitForTimeout(100);
const outOfView = !(await selectedInView());
await row('web').click();
await row('src').waitFor();
await page.waitForTimeout(150);
const afterToggle = await tree.evaluate((el) => el.scrollTop);
check(
  outOfView && scrolledTo > 0 && afterToggle === scrolledTo,
  'opening a folder does not scroll the tree back to the selected file',
  `selected row out of view: ${outOfView}, scrollTop ${scrolledTo} -> ${afterToggle}`,
);
// A selection made outside the tree still scrolls the tree to its row.
await page.locator('.file-tab', { hasText: 'handler.go' }).click();
await page.locator('.row.selected', { hasText: 'handler.go' }).waitFor();
await scrollDown();
await page.locator('.file-tab', { hasText: 'ledger.py' }).click();
await page.locator('.row.selected', { hasText: 'ledger.py' }).waitFor();
await page.waitForTimeout(150);
check(
  await selectedInView(),
  'choosing a file tab scrolls the tree to the row of that file',
  String(await tree.evaluate((el) => el.scrollTop)),
);
// The row is put in the middle of the tree, or as near to the middle as the
// scroll range allows. `wanted` is the scroll position that puts it there.
const centred = await tree.evaluate((el) => {
  const row = el.querySelector('.row.selected');
  const top =
    row.getBoundingClientRect().top -
    el.getBoundingClientRect().top +
    el.scrollTop;
  const middle = top - (el.clientHeight - row.offsetHeight) / 2;
  const wanted = Math.max(
    0,
    Math.min(el.scrollHeight - el.clientHeight, middle),
  );
  return { wanted, scrollTop: el.scrollTop };
});
check(
  Math.abs(centred.scrollTop - centred.wanted) <= 8,
  'the row of that file is put in the middle of the tree',
  JSON.stringify(centred),
);
if (!webWasOpen) {
  await row('web').click();
  await row('src').waitFor({ state: 'detached' });
}
await page.setViewportSize({ width: 1600, height: 960 });

// ---- keyboard navigation in the tree
await page.locator('.tree').focus();
await page.keyboard.press('Home');
await page.keyboard.press('ArrowLeft');
const collapsed = await page.locator('.row .name').allTextContents();
check(
  !collapsed.includes('orders') && collapsed.includes('internal'),
  'the Left key closes a folder',
  JSON.stringify(collapsed),
);
await page.keyboard.press('ArrowRight');
await page.keyboard.press('ArrowDown');
await page.keyboard.press('ArrowDown');
await page.keyboard.press('ArrowDown');
await page.keyboard.press('Enter');
await page.locator('.empty .fname, .source-line').first().waitFor();
check(
  (await page.locator('.row.selected .name').textContent()) != null,
  'arrow keys and Enter open a file',
);

// ---- sidebar resize
const before = (await page.locator('.sidebar').boundingBox()).width;
const edge = await page
  .getByRole('separator', { name: 'Resize the sidebar' })
  .boundingBox();
await page.mouse.move(edge.x + 3, edge.y + 200);
await page.mouse.down();
await page.mouse.move(edge.x + 123, edge.y + 200, { steps: 4 });
await page.mouse.up();
const after = (await page.locator('.sidebar').boundingBox()).width;
check(
  Math.abs(after - before - 120) < 3,
  'dragging the sidebar edge resizes it',
  `${before} -> ${after}`,
);
{
  const handle = page.getByRole('separator', { name: 'Resize the sidebar' });
  const drag = async (fromX, toX) => {
    await page.mouse.move(fromX, edge.y + 200);
    await page.mouse.down();
    await page.mouse.move(toX, edge.y + 200, { steps: 6 });
    await page.mouse.up();
  };
  const mainLeft = async () =>
    (await page.locator('main.main').boundingBox()).x;
  await drag((await handle.boundingBox()).x + 3, 150);
  check(
    (await page.locator('.sidebar').boundingBox()).width === 200,
    'the sidebar keeps a least width while it is open',
  );
  await drag((await handle.boundingBox()).x + 3, 20);
  const closed = await handle.boundingBox();
  check(
    (await page.locator('.sidebar').count()) === 0 &&
      (await mainLeft()) === 0 &&
      closed.x === 0,
    'dragging the sidebar to the left edge closes it and leaves its handle there',
    JSON.stringify(closed),
  );
  check(
    (await page.locator('.toolbar').boundingBox()).x === 0,
    'the toolbar and the editor area take the room of the closed sidebar',
  );
  await drag(4, 300);
  check(
    Math.abs((await page.locator('.sidebar').boundingBox()).width - 296) <= 4,
    'dragging the handle in from the left edge shows the sidebar again',
  );
  const button = page
    .locator('.titlebar')
    .getByRole('button', { name: 'Sidebar' });
  await button.click();
  check(
    (await page.locator('.sidebar').count()) === 0,
    'the sidebar button in the title bar hides the sidebar',
  );
  await handle.click();
  check(
    (await page.locator('.sidebar').count()) === 1,
    'a click on the handle at the left edge shows it',
  );
  await page.keyboard.press(`${mod}+Digit0`);
  check(
    (await page.locator('.sidebar').count()) === 0,
    'the key for the sidebar hides it',
  );
  await page.keyboard.press(`${mod}+Digit0`);
  check(
    (await page.locator('.sidebar .row').count()) > 0,
    'the same key shows it again, with the file tree as it was',
  );
  // The layout is written to the settings a moment after the last change.
  await page.waitForTimeout(800);
  const saved = await page.evaluate(() => window.__mockSettings().layout);
  check(
    saved.sidebarOpen === true &&
      saved.sidebarWidth ===
        Math.round((await page.locator('.sidebar').boundingBox()).width) &&
      saved.inspectorWidth === 320,
    'the sizes of the panels are saved with the settings',
    JSON.stringify(saved),
  );
}

// ---- settings
await page.keyboard.press(`${mod}+,`);
await page.getByRole('dialog').getByText('Settings').first().waitFor();
const section = (name) =>
  page.locator('.dialog.settings').getByRole('tab', { name, exact: true });
check(
  (await page.locator('.dialog.settings [role=tab]').allTextContents()).join(
    ', ',
  ) ===
    'Agent, API keys, Jobs, Films, Companion files, Source code, Appearance, Updates' &&
    (await page.locator('.pane h3').textContent()) === 'Agent',
  'Settings is divided into sections and opens on the first',
);
await shot('06-settings');
await section('Jobs').click();
await page.locator('#set-fix').fill('5');
await page.locator('#set-fix').blur();
check(
  (await page.locator('#set-speed').count()) === 0,
  'a section shows only its own settings',
);

// ---- the ignore list in Settings
await section('Companion files').click();
check(
  (await page.locator('#set-ignore').inputValue())
    .split('\n')
    .includes('/lib/acme/'),
  'a pattern added from the Animate dialog is in the ignore list in Settings',
);
await page.getByText(/These patterns match 4 code files in shop/).waitFor();
await page
  .locator('#set-ignore')
  .fill('vendor/\n\n  *.pb.go  \nvendor/\n/lib/[z-a]/');
await page.locator('#set-ignore').blur();
await page
  .getByText('Cannot be read as a pattern, and matches nothing:')
  .waitFor();
check(
  (await page.locator('#set-ignore').inputValue()) ===
    'vendor/\n*.pb.go\n/lib/[z-a]/',
  'the ignore list is saved one pattern per line, without empty lines and repeats',
);
await shot('06b-settings-companions');
await page.locator('#set-ignore').fill('vendor/\nthird_party/\nnode_modules/');
await page.locator('#set-ignore').blur();

// ---- light and dark theme
await section('Appearance').click();
const theme = () =>
  page.evaluate(() => [
    document.documentElement.dataset.theme,
    getComputedStyle(document.body).backgroundColor,
  ]);
await page.getByRole('button', { name: 'Light', exact: true }).click();
await page.waitForFunction(
  () => document.documentElement.dataset.theme === 'light',
);
const lightTheme = await theme();
await shot('06c-settings-light');
await page.getByRole('button', { name: 'Dark', exact: true }).click();
await page.waitForFunction(
  () => document.documentElement.dataset.theme === 'dark',
);
const darkTheme = await theme();
check(
  lightTheme[1] === 'rgb(227, 224, 216)' && darkTheme[1] === 'rgb(12, 14, 18)',
  'the theme setting switches the window between light and dark',
  JSON.stringify([lightTheme, darkTheme]),
);

// ---- API providers
const provider = (id) => page.locator(`.provider[data-provider="${id}"]`);
await section('API keys').click();
await provider('api-anthropic').waitFor();
check(
  (await page.locator('.provider').count()) === 4,
  'Settings lists the four API providers',
);
check(
  (await provider('api-anthropic').locator('.pill').textContent()) ===
    'needs a key',
  'a provider without a key says so',
);
await provider('api-anthropic').locator('summary').click();
check(
  await provider('api-anthropic')
    .getByRole('button', { name: 'Test the connection' })
    .isDisabled(),
  'a provider that is not set up cannot be tested',
);
await page.locator('#key-api-anthropic').fill('sk-test-key');
await provider('api-anthropic').getByRole('button', { name: 'Save' }).click();
await provider('api-anthropic').locator('.pill.ready').waitFor();
check(
  (await page.locator('#key-api-anthropic').inputValue()) === '',
  'a saved key does not stay in the page',
);
await section('Agent').click();
check(
  await page
    .locator('label.check', { hasText: 'Anthropic API' })
    .locator('input')
    .isEnabled(),
  'a provider with a key can be chosen as the agent',
);
// The mock agent can be started without the user's own setup for it, so the
// Agent section offers the switch that leaves those arguments out.
const ownSetup = page.locator('label.check', { hasText: 'load my own setup' });
check(
  /--plain/.test(await ownSetup.textContent()),
  "the Agent section names the arguments that keep out the user's own setup",
);
await ownSetup.locator('input').check();
await page.waitForTimeout(200);
check(
  (await page.evaluate(() => window.__mockSettings().agentCustomizations)) ===
    true,
  "the agent can be allowed to load the user's own setup",
);
await ownSetup.locator('input').uncheck();
await section('API keys').click();
await provider('api-anthropic').locator('summary').click();
await provider('api-anthropic')
  .getByRole('button', { name: 'Test the connection' })
  .click();
await provider('api-anthropic').locator('.test.ok').waitFor();
check(
  /claude-opus-5-5 answered/.test(
    await provider('api-anthropic').locator('.test').textContent(),
  ),
  'the connection test names the model that answered',
);
await page.locator('#key-api-anthropic').fill('bad-key');
await page.locator('#key-api-anthropic').press('Enter');
await page.waitForFunction(
  () => document.querySelector('#key-api-anthropic').value === '',
);
await provider('api-anthropic')
  .getByRole('button', { name: 'Test the connection' })
  .click();
await provider('api-anthropic').locator('.test.failed').waitFor();
check(
  /rejected the API key/.test(
    await provider('api-anthropic').locator('.test').textContent(),
  ),
  'a rejected key is reported next to the test button',
);
await provider('api-compatible').locator('summary').click();
check(
  /Enter the endpoint's address/.test(
    await provider('api-compatible').locator('.need').textContent(),
  ),
  'the compatible endpoint asks for its address first',
);
await page.locator('#address-api-compatible').fill('http://localhost:11434/v1');
await page.locator('#address-api-compatible').press('Tab');
await page.locator('#model-api-compatible').fill('llama');
await page.locator('#model-api-compatible').press('Tab');
await provider('api-compatible').locator('.pill.ready').waitFor();
check(
  true,
  'a local endpoint is ready with an address and a model, without a key',
);
await provider('api-anthropic').getByRole('button', { name: 'Remove' }).click();
await provider('api-anthropic').locator('.pill:not(.ready)').waitFor();
check(true, 'removing the key makes the provider unavailable again');
await provider('api-anthropic').scrollIntoViewIfNeeded();
await shot('06d-api-providers');
await section('Jobs').click();
await page.getByRole('button', { name: 'High', exact: true }).click();
check(
  await page
    .getByRole('button', { name: 'High', exact: true })
    .evaluate((b) => b.classList.contains('on')),
  'the thinking effort can be changed',
);
await page.getByRole('button', { name: 'Done' }).click();
await page.keyboard.press(`${mod}+,`);
await section('Jobs').click();
check(
  (await page.locator('#set-fix').inputValue()) === '5',
  'a changed setting is kept',
);
await page.keyboard.press('Escape');
check((await page.getByRole('dialog').count()) === 0, 'Escape closes a dialog');

// ---- updates of the app: a check on request, the notice in the title bar,
// the download and the restart
{
  const pane = page.locator('.dialog.settings .pane');
  const notice = page.locator('.titlebar .update');
  await page.keyboard.press(`${mod}+,`);
  await section('Updates').click();
  check(
    /Codjiva 0\.1\.0/.test(await pane.textContent()) &&
      (await notice.count()) === 0,
    'the Updates section names the running version, and no notice is shown',
  );
  await pane.getByRole('button', { name: 'Check for updates' }).click();
  await pane.getByText('This is the newest version.').waitFor();
  check(true, 'a check that finds nothing newer says so');

  await page.evaluate(() => {
    window.__mockUpdate = { version: '0.2.0', notes: 'Films start faster.' };
  });
  await pane.getByRole('button', { name: 'Check for updates' }).click();
  await pane.getByText('Version 0.2.0 is available.').waitFor();
  check(
    /Films start faster\./.test(await pane.textContent()),
    'a newer release is offered with its notes',
  );
  const automatic = pane.getByRole('checkbox');
  await automatic.uncheck();
  await page.waitForTimeout(200);
  check(
    (await page.evaluate(() => window.__mockSettings().checkForUpdates)) ===
      false,
    'the automatic check can be switched off',
  );
  await automatic.check();
  await page.getByRole('button', { name: 'Done' }).click();

  check(
    (await notice.getByRole('button', { name: 'Update to 0.2.0' }).count()) ===
      1,
    'the title bar offers the update',
  );
  await shot('12-update-notice');
  await notice.getByRole('button', { name: 'Update to 0.2.0' }).click();
  await notice.getByText(/Updating · \d+%/).waitFor();
  check(true, 'the notice shows the download as it arrives');
  await notice.getByRole('button', { name: 'Restart to update' }).waitFor();
  await notice.getByRole('button', { name: 'Restart to update' }).click();
  check(
    await page.evaluate(() => window.__mockRelaunched === true),
    'after the update is installed the notice restarts the app',
  );
  await notice.getByRole('button', { name: 'Hide the update notice' }).click();
  check((await notice.count()) === 0, 'the notice can be hidden');
}

// ---- example film in the sandboxed frame
await page.reload();
await page.getByRole('button', { name: 'Watch the example film' }).click();
const frame = page.locator('.canvas iframe');
check(
  (await frame.getAttribute('sandbox')) === 'allow-scripts',
  'the artifact frame is sandboxed with scripts only',
);
await page
  .locator('.player .chap', { hasText: '1 / 4' })
  .waitFor({ timeout: 15000 });
check(
  / \/ 1:2[23]$/.test(await page.locator('.player .time').textContent()),
  'the film reports its length to the host bar',
  await page.locator('.player .time').textContent(),
);
check(
  (await page.locator('.player .mark').count()) === 3,
  'the scrubber shows a tick for each later chapter',
);
await page.getByRole('button', { name: 'Play' }).click();
// The time shows whole seconds, so it changes about one second after playback
// starts.
const advanced = await page
  .waitForFunction(
    () =>
      !document.querySelector('.player .time').textContent.startsWith('0:00'),
    null,
    { timeout: 5000 },
  )
  .then(
    () => true,
    () => false,
  );
await page.getByRole('button', { name: 'Pause' }).click();
check(
  advanced,
  'Play advances the film',
  await page.locator('.player .time').textContent(),
);
const scrub = await page.locator('.player .scrub').boundingBox();
await page.mouse.click(scrub.x + scrub.width * 0.5, scrub.y + scrub.height / 2);
await page
  .locator('.player .chap', { hasText: '3 / 4' })
  .waitFor({ timeout: 5000 });
check(true, 'clicking the scrubber seeks to another chapter');
await page.waitForTimeout(300);
await shot('07-film');
await page.locator('.player select').selectOption('1.25');
await page.getByRole('button', { name: 'Turn sound on' }).click();
await page.getByRole('button', { name: 'Mute' }).waitFor({ timeout: 3000 });
check(true, "the sound button switches the film's sound and mirrors its state");

// ---- the film is drawn in the app's theme
const exampleFrame = page.frameLocator('.canvas iframe');
await page.keyboard.press(`${mod}+,`);
await section('Appearance').click();
await page.getByRole('button', { name: 'Light', exact: true }).click();
await page.getByRole('button', { name: 'Done' }).click();
await exampleFrame
  .locator('html[data-theme="light"]')
  .waitFor({ timeout: 5000 });
await page
  .locator('.canvas iframe:not(.dark-stage)')
  .waitFor({ timeout: 5000 });
const paper = await page
  .locator('.canvas')
  .evaluate((el) => getComputedStyle(el).backgroundColor);
check(
  paper === 'rgb(247, 245, 239)',
  'in the light theme the film and the canvas behind it are light',
  paper,
);
await shot('07b-film-light');
await page.keyboard.press(`${mod}+,`);
await section('Appearance').click();
await page.getByRole('button', { name: 'Dark', exact: true }).click();
await page.getByRole('button', { name: 'Done' }).click();
await exampleFrame.locator('html:not([data-theme])').waitFor({ timeout: 5000 });
await page.locator('.canvas iframe.dark-stage').waitFor({ timeout: 5000 });
check(true, 'back in the dark theme the film is dark again, without reloading');

// ---- example visual
await page.locator('.tab', { hasText: 'Blueprint' }).click();
await page.locator('.zoomctl').waitFor();
await page.waitForTimeout(800);
await page.getByRole('button', { name: 'Zoom in' }).click();
await page.waitForTimeout(200);
// The zoom buttons are in the bottom right corner of the visual. Each
// tooltip must lie inside the visual's area, or its end is cut off.
const zoomTips = [];
for (const name of ['Zoom out', 'Fit', 'Zoom in']) {
  const button = page.getByRole('button', { name, exact: true });
  await button.hover();
  zoomTips.push(
    await button.evaluate((el) => {
      const tip = getComputedStyle(el, '::after');
      const area = el.closest('.canvas').getBoundingClientRect();
      const box = el.getBoundingClientRect();
      // The tooltip's right edge is `right` pixels left of the button's.
      const right = box.right - parseFloat(tip.right);
      const left = right - parseFloat(tip.width);
      return {
        shown: tip.display === 'block',
        inside: left >= area.left && right <= area.right,
        text: tip.content,
      };
    }),
  );
}
check(
  zoomTips.every((tip) => tip.shown && tip.inside),
  'the tooltips of the zoom buttons lie inside the visual and are not cut off',
  JSON.stringify(zoomTips),
);
await shot('08-visual');
await page.getByRole('button', { name: 'Close example' }).click();
await page.getByRole('button', { name: 'Open folder…' }).waitFor();
check(true, 'closing the example returns to the welcome screen');

// ---- the colours of code, on a C++ header that is added to the workspace
await page.evaluate(() =>
  window.__mockSetFile(
    'internal/billing/index.h',
    [
      '#ifndef BILLING_INDEX_H',
      '#define BILLING_INDEX_H',
      '#include <map>',
      '',
      'namespace billing {',
      '',
      '/// Finds the ledger entries of one customer.',
      'template <typename Id, typename Less = std::less<Id>>',
      'class Index {',
      'public:',
      '    explicit Index(size_t limit) : limit_(limit) {}',
      '    Index(const Index&) = delete;',
      '',
      '    bool add(const Id& id, int cents) {',
      '        if (cents_.size() >= limit_) return false;',
      '        cents_[id] += cents * 100;',
      '        return true;',
      '    }',
      '',
      '    const char* name() const { return "index"; }',
      '',
      'private:',
      '    const size_t limit_;',
      '    std::map<Id, int, Less> cents_;',
      '};',
      '',
      '} // namespace billing',
      '',
      '#endif // BILLING_INDEX_H',
      '',
    ].join('\n'),
  ),
);
await page.locator('.recent', { hasText: 'shop' }).click();
await row('internal').waitFor();
await page.keyboard.press(`${mod}+p`);
await page.getByPlaceholder('Go to file…').fill('index.h');
await page.locator('.quick-row').first().waitFor();
await page.keyboard.press('Enter');
await page.locator('.tab.source-tab').click();
await page.locator('.source .tk-keyword').first().waitFor();
// The text of every piece of each kind in the file.
const coloured = await page.evaluate(() =>
  Object.fromEntries(
    ['meta', 'comment', 'keyword', 'type', 'function', 'string', 'number'].map(
      (kind) => [
        kind,
        Array.from(document.querySelectorAll(`.source .tk-${kind}`)).map((el) =>
          el.textContent.trim(),
        ),
      ],
    ),
  ),
);
check(
  coloured.keyword.includes('class') &&
    coloured.keyword.includes('const') &&
    coloured.type.includes('Index') &&
    coloured.function.includes('add') &&
    coloured.string.includes('"index"') &&
    coloured.number.includes('100') &&
    coloured.comment.some((text) => text.startsWith('///')) &&
    coloured.meta.length > 0,
  'C++ is coloured by kind: keywords, types, function names, strings, numbers, comments and compiler lines',
  JSON.stringify(coloured),
);
const kindColours = await page.evaluate(() =>
  ['keyword', 'type', 'function', 'string', 'number', 'comment'].map(
    (kind) =>
      getComputedStyle(document.querySelector(`.source .tk-${kind}`)).color,
  ),
);
check(
  new Set(kindColours).size === kindColours.length,
  'each kind of code has a colour of its own',
  kindColours.join(' | '),
);
await shot('10-source-cpp');
// In the light theme each kind has a darker colour, which reads on the light
// ground. The theme is switched on the page itself for this look.
const themeBefore = await page.evaluate(() => {
  const before = document.documentElement.getAttribute('data-theme');
  document.documentElement.setAttribute('data-theme', 'light');
  return before;
});
const lightKeyword = await page.evaluate(
  () => getComputedStyle(document.querySelector('.source .tk-keyword')).color,
);
check(
  lightKeyword === 'rgb(116, 70, 196)',
  'in the light theme the code colours are the darker set',
  lightKeyword,
);
await shot('10b-source-cpp-light');
await page.evaluate((before) => {
  if (before) document.documentElement.setAttribute('data-theme', before);
  else document.documentElement.removeAttribute('data-theme');
}, themeBefore);

// ---- code navigation in the source view
// Two files are added to the workspace. The first has eighty lines of
// comment above its code, so that it has to be scrolled to reach the code.
await page.evaluate(() => {
  const filler = Array.from({ length: 80 }, (_, i) => `// note ${i + 1}`);
  window.__mockSetFile(
    'nav/meter.go',
    [
      'package nav',
      ...filler,
      'type Meter struct {',
      '\ttotal int',
      '}',
      '',
      'func (m *Meter) Add(amount int) {',
      '\tm.total += amount',
      '}',
      '',
      'func Run() int {',
      '\tmeter := &Meter{}',
      '\tmeter.Add(2)',
      '\tmeter.Add(3)',
      '\treturn Total(meter) // Add and Total',
      '}',
      '',
    ].join('\n'),
  );
  window.__mockSetFile(
    'nav/total.go',
    [
      'package nav',
      ...filler,
      'func Total(m *Meter) int {',
      '\treturn m.total',
      '}',
      '',
    ].join('\n'),
  );
});
await page.keyboard.press(`${mod}+KeyP`);
await page.locator('.dialog.quick .input').fill('nav/meter');
await page.locator('.quick-row').first().waitFor();
await page.keyboard.press('Enter');
await page.locator('.tab.source-tab').click();
await page.locator('.source-line').first().waitFor();
// Scrolls the code into view, as a user would with the wheel.
await page.evaluate(async () => {
  document.querySelector('.source').scrollTop = 70 * 20;
  await new Promise((done) => setTimeout(done, 150));
});
// The middle of the `nth` place, counted from 0, of `word` in a line of
// the source view, in pixels of the window. A place inside a longer word
// counts too.
const pointOf = (line, word, nth = 0) =>
  page.evaluate(
    ([line, word, nth]) => {
      const holder = document.querySelector(
        `.source-line[data-line="${line}"] .source-text`,
      );
      let at = -1;
      for (let i = 0; i <= nth; i++)
        at = holder.textContent.indexOf(word, at + 1);
      const walker = document.createTreeWalker(holder, NodeFilter.SHOW_TEXT);
      let before = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (at < before + node.data.length) {
          const range = new Range();
          range.setStart(node, at - before);
          range.setEnd(node, at - before + word.length);
          const box = range.getBoundingClientRect();
          return {
            x: box.left + box.width / 2,
            y: box.top + box.height / 2,
            box: {
              x: Math.floor(box.left),
              y: Math.floor(box.top),
              width: Math.ceil(box.width),
              height: Math.ceil(box.height),
            },
          };
        }
        before += node.data.length;
      }
      return null;
    },
    [line, word, nth],
  );
// A click with the Control key held, which is "go to definition" outside
// macOS. The events are made in the page, because a real Control-click on a
// Mac opens the context menu instead.
const followClick = ({ x, y }) =>
  page.evaluate(
    ([x, y]) => {
      const target = document.elementFromPoint(x, y);
      for (const type of ['mousedown', 'mouseup', 'click'])
        target.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            clientX: x,
            clientY: y,
            button: 0,
            detail: 1,
            ctrlKey: true,
          }),
        );
    },
    [x, y],
  );
// How the second call of `Add` looks before any name is selected.
const secondAdd = await pointOf(93, 'Add');
const unmarked = await page.screenshot({ clip: secondAdd.box });

// A click on a name selects it.
const firstAdd = await pointOf(92, 'Add');
await page.mouse.click(firstAdd.x, firstAdd.y);
await page.locator('.symbol-panel').waitFor();
await page.locator('.symbol-panel .ref-row').nth(3).waitFor();
check(
  (await page.locator('.symbol-panel h3').textContent()) === 'Add',
  'a click on a name in the source view selects it and opens its panel',
);
check(
  (
    await page
      .locator('.symbol-panel .nav-row .nav-where')
      .first()
      .textContent()
  )
    .trim()
    .startsWith('meter.go:86'),
  'the panel lists where the selected name is defined',
  await page.locator('.symbol-panel .nav-row .nav-where').first().textContent(),
);
const listed = await page
  .locator('.symbol-panel .ref-row .nav-num')
  .allTextContents();
check(
  listed.join(',') === '86,92,93,94',
  'the panel lists the lines the selected name is used on',
  listed.join(','),
);
// The mouse is moved away, so that the second call is not under it.
await page.mouse.move(firstAdd.x, firstAdd.y + 200);
const marks = await page.evaluate(() => ({
  supported: typeof Highlight !== 'undefined' && 'highlights' in CSS,
  uses: CSS.highlights?.get('nav-use')?.size ?? 0,
  selected: CSS.highlights?.get('nav-selected')?.size ?? 0,
}));
const marked = await page.screenshot({ clip: secondAdd.box });
check(
  marks.supported && marks.uses === 4 && marks.selected === 1,
  'every use of the selected name in the file is marked',
  JSON.stringify(marks),
);
check(
  !unmarked.equals(marked),
  'a marked use is drawn differently from one that is not marked',
);
await shot('11-source-name-selected');

// A word in a comment is not a name.
const inComment = await pointOf(94, 'Total', 1);
await page.mouse.click(inComment.x, inComment.y);
await page.locator('.symbol-panel').waitFor({ state: 'detached' });
check(
  (await page.locator('.symbol-panel').count()) === 0,
  'a click on a word in a comment selects nothing',
);

// A right-click on a name offers the commands, without "Go to declaration"
// for a language that has no prototypes.
await page.mouse.click(firstAdd.x, firstAdd.y, { button: 'right' });
await page.locator('.menu').waitFor();
// WebKit selects the word under a right-click as text, and the menu then
// has "Copy" as well.
const commands = (await page.locator('.menu button').allTextContents()).filter(
  (command) => command !== 'Copy',
);
check(
  commands.join('|') === 'Go to definition|Find references',
  'a right-click on a name offers to go to its definition and to find its references',
  commands.join('|'),
);
await page.locator('.menu button', { hasText: 'Find references' }).click();
await page.locator('.symbol-panel .ref-row').nth(3).waitFor();
check(
  (await page.locator('.symbol-panel h3').textContent()) === 'Add',
  '"Find references" opens the panel for the name',
);

// A click with the key held goes to the definition, in another file.
const leftAtScroll = await page.evaluate(
  () => document.querySelector('.source').scrollTop,
);
await followClick(await pointOf(94, 'Total'));
await page.locator('.source-line.ref').waitFor();
await page
  .locator('.toolbar .crumb', { hasText: 'total.go' })
  .waitFor({ timeout: 5000 });
const arrived = await page.evaluate(() => ({
  line: document
    .querySelector('.source-line.ref .source-num')
    .textContent.trim(),
  target: CSS.highlights?.get('nav-target')?.size ?? 0,
  panel: document.querySelector('.symbol-panel h3')?.textContent,
}));
check(
  arrived.line === '82' && arrived.target === 1,
  'a click with the key held goes to the definition and marks the name there',
  JSON.stringify(arrived),
);
check(
  arrived.panel === 'Add',
  'going to a definition leaves the selected name and its list as they were',
  String(arrived.panel),
);
await shot('12-source-definition');

// Back shows the first file scrolled as it was left.
await page.keyboard.press('Alt+ArrowLeft');
await page.locator('.toolbar .crumb', { hasText: 'meter.go' }).waitFor();
await page.locator('.source-line[data-line="94"]').waitFor();
const cameBackTo = await page.evaluate(async () => {
  await new Promise((done) => setTimeout(done, 150));
  return document.querySelector('.source').scrollTop;
});
check(
  Math.abs(cameBackTo - leftAtScroll) < 20,
  'Back returns to the line the user went to the definition from',
  `${leftAtScroll} then ${cameBackTo}`,
);

// A click on a reference in the panel shows that place.
await page.locator('.symbol-panel .ref-row').nth(0).click();
await page.locator('.source-line.ref[data-line="86"]').waitFor();
check(
  await page
    .locator('.symbol-panel .ref-row')
    .nth(0)
    .evaluate((row) => row.classList.contains('on')),
  'a click on a reference shows its line, and the reference is drawn as chosen',
);

// A click on the same line again scrolls back to it after the view moved.
await page.evaluate(() => (document.querySelector('.source').scrollTop = 0));
await page.locator('.symbol-panel .ref-row').nth(0).click();
await page.locator('.source-line[data-line="86"]').waitFor();
check(
  (await page.evaluate(() => document.querySelector('.source').scrollTop)) > 0,
  'going to the line that is already marked scrolls to it again',
);

// Escape selects nothing.
await page.keyboard.press('Escape');
await page.locator('.symbol-panel').waitFor({ state: 'detached' });
check(
  await page.evaluate(() => !CSS.highlights?.has('nav-use')),
  'Escape selects nothing and removes the marks',
);

// With no symbol selected, the panel beside the source view stays and says
// how to select one. Dragging it shut leaves its handle on the right edge of
// the window and its button in the title bar enabled, and a click in the code
// does not take them away.
{
  const inspectorButton = page
    .locator('.titlebar')
    .getByRole('button', { name: 'Inspector' });
  check(
    /Click a symbol in the code/.test(
      await page.locator('.symbol-empty').textContent(),
    ) && (await inspectorButton.isEnabled()),
    'with no symbol selected, the panel beside the source view says how to select one',
  );
  await inspectorButton.click();
  const blank = await page.locator('.source').boundingBox();
  await page.mouse.click(
    blank.x + blank.width - 200,
    blank.y + blank.height - 40,
  );
  check(
    (await page.locator('.inspector').count()) === 0 &&
      (await page.locator('.insp-edge.closed').count()) === 1 &&
      (await inspectorButton.isEnabled()),
    'the closed panel beside the source view keeps its handle and its button after a click in the code',
  );
  await inspectorButton.click();
  await page.locator('.symbol-empty').waitFor();
}

// A definition is found by its name in the quick-open dialog.
await page.keyboard.press(`${mod}+KeyT`);
check(
  (await page.locator('.dialog.quick .input').inputValue()) === '#',
  'the key for going to a definition opens the dialog with "#"',
);
await page.locator('.dialog.quick .input').fill('#tota');
await page.locator('.quick-row', { hasText: 'Total' }).waitFor();
await page.keyboard.press('Enter');
await page.locator('.toolbar .crumb', { hasText: 'total.go' }).waitFor();
await page.locator('.source-line.ref').waitFor();
check(
  (await page.locator('.source-line.ref .source-num').textContent()).trim() ===
    '82',
  'choosing a definition in the dialog shows it in the source view',
);

// Two more files. `Reset` is defined in both of them, and `meter` is built
// from the type `Meter` of the file added above.
await page.evaluate(() => {
  window.__mockSetFile(
    'nav/gauge.go',
    [
      'package nav',
      '',
      'func Reset() {}',
      '',
      'func Read() int {',
      '\tmeter := &Meter{}',
      '\tReset()',
      '\treturn meter.total',
      '}',
      '',
    ].join('\n'),
  );
  window.__mockSetFile(
    'nav/reset.go',
    ['package nav', '', 'func Reset() {}', ''].join('\n'),
  );
});
await page.keyboard.press(`${mod}+KeyP`);
await page.locator('.dialog.quick .input').fill('nav/gauge');
await page.locator('.quick-row').first().waitFor();
await page.keyboard.press('Enter');
await page.locator('.source-line[data-line="7"]').waitFor();
const resetCall = await pointOf(7, 'Reset');
await page.mouse.click(resetCall.x, resetCall.y);
await page.locator('.symbol-panel .nav-others').waitFor();
const shownRows = () =>
  page.locator('.symbol-panel .nav-row:not(.ref-row):visible').count();
check(
  (await shownRows()) === 1 &&
    (await page.locator('.nav-others summary').textContent()).trim() ===
      'Others with this name · 1',
  'definitions that only share the name are kept behind one line',
  `${await shownRows()} rows`,
);
await page.locator('.nav-others summary').click();
check(
  (await page.locator('.nav-others .nav-where').textContent())
    .trim()
    .startsWith('reset.go:3'),
  'opening that line lists the other definitions',
);
const builtName = await pointOf(6, 'meter');
await page.mouse.click(builtName.x, builtName.y);
await page.locator('.symbol-panel .kicker', { hasText: 'Type' }).waitFor();
check(
  (await page.locator('.symbol-panel .kicker', { hasText: 'Type' }).innerText())
    .toLowerCase()
    .includes('type · meter') &&
    (
      await page
        .locator('.symbol-panel .nav-row .nav-where')
        .first()
        .innerText()
    )
      .trim()
      .startsWith('meter.go:82'),
  'the panel offers the definition of the type the code gives a name',
);
await shot('12-source-name-type');

// ---- a file chosen outside the tree is put in the middle of the tree
// A folder of eighty files is added, so that the tree is much longer than
// its visible part and the fortieth of them can be put in the middle.
await page.evaluate(() => {
  for (let i = 1; i <= 80; i++)
    window.__mockSetFile(
      `pad/pad-${String(i).padStart(2, '0')}.go`,
      'package pad\n',
    );
  // The stand-in backend lists the root folder again when it is told that
  // a file there changed. That is how the new folder gets its row.
  window.__mockEditFile('go.mod');
});
await row('pad').waitFor();
await page.keyboard.press(`${mod}+KeyP`);
await page.locator('.dialog.quick .input').fill('pad/pad-40');
await page.locator('.quick-row').first().waitFor();
await page.keyboard.press('Enter');
await page.locator('.row.selected', { hasText: 'pad-40.go' }).waitFor();
await page.waitForTimeout(150);
const offCentre = await page.locator('.tree').evaluate((el) => {
  const view = el.getBoundingClientRect();
  const row = el.querySelector('.row.selected').getBoundingClientRect();
  return Math.abs(row.top + row.height / 2 - (view.top + view.height / 2));
});
check(
  offCentre <= 16,
  'a file chosen outside the tree is put in the middle of the tree',
  `${offCentre}px from the middle`,
);
await shot('13-tree-selected-in-the-middle');

// ---- asking the agent which view fits a file
// api.ts has no artifact, so the editor area shows the card with the six
// views and the button that asks. The stand-in agent puts the lanes view
// first for a `.ts` file.
await page.keyboard.press(`${mod}+KeyP`);
await page.locator('.dialog.quick .input').fill('web/src/api');
await page.locator('.quick-row').first().waitFor();
await page.keyboard.press('Enter');
await page.locator('.file-tab.on', { hasText: 'api.ts' }).waitFor();
await showKind('Blueprint');
await page.locator('.empty .meta', { hasText: 'lines' }).waitFor();
// The size of the card and of each of the six small cards, as text.
const cardSizes = () =>
  page.evaluate(() =>
    ['.file-card', ...Array(6).keys()]
      .map((one) =>
        typeof one === 'string'
          ? document.querySelector(one)
          : document.querySelectorAll('.pick')[one],
      )
      .map((el) => {
        const box = el.getBoundingClientRect();
        return `${Math.round(box.width)}x${Math.round(box.height)}`;
      })
      .join(' '),
  );
const sizesBefore = await cardSizes();
check(
  (await page.locator('.pick').count()) === 6 &&
    new Set(sizesBefore.split(' ').slice(1)).size === 1 &&
    (await page.locator('.pick.suggested').count()) === 0,
  'the card of a file offers the six views as small cards of one size',
  sizesBefore,
);
// No small card touches the next one.
const apart = await page.evaluate(() => {
  const boxes = Array.from(document.querySelectorAll('.pick'), (el) =>
    el.getBoundingClientRect(),
  );
  return boxes.every((a, i) =>
    boxes.every(
      (b, j) =>
        i === j ||
        a.right + 6 <= b.left ||
        b.right + 6 <= a.left ||
        a.bottom + 6 <= b.top ||
        b.bottom + 6 <= a.top,
    ),
  );
});
check(apart, 'there is space between any two of the small cards');
await page.getByRole('button', { name: 'Which view fits this file?' }).click();
const sizesWhileAsking = await cardSizes();
await page.locator('.pick.suggested').waitFor();
const suggestedPick = page.locator('.pick.suggested');
check(
  (await page.locator('.pick.suggested').count()) === 1 &&
    (await suggestedPick.locator('.pick-name').innerText()).startsWith(
      'Lanes',
    ) &&
    (await suggestedPick.locator('.pick-tag').innerText()) === 'suggested' &&
    (await page.locator('.pick-note').innerText()).startsWith(
      'Suggested: Lanes.',
    ),
  'the view the agent puts first is marked as suggested, with its reason',
  await page.locator('.pick-note').innerText(),
);
const sizesAfter = await cardSizes();
check(
  sizesWhileAsking === sizesBefore && sizesAfter === sizesBefore,
  'the card keeps its size while the agent is asked and after it answered',
  `${sizesBefore} | ${sizesWhileAsking} | ${sizesAfter}`,
);
check(
  (await page.locator('.tab.kinds.suggested').count()) === 1,
  'the Visuals button is marked once the agent has suggested a kind',
);
// The note shows the reason for the view the pointer is on.
await page.locator('.pick', { hasText: 'Schema' }).hover();
check(
  (await page.locator('.pick-note').innerText()).startsWith(
    'Schema, as Mock Agent sees it.',
  ) && (await cardSizes()) === sizesBefore,
  'pointing at a view shows the reason the agent gave for it',
  await page.locator('.pick-note').innerText(),
);
await shot('14-suggested-view');
await page.mouse.move(40, 500);
await page.locator('.tab.kinds').click();
const lanesItem = menuCommand('Lanes');
await lanesItem.hover();
check(
  (await lanesItem.locator('.menu-mark').innerText()) === 'suggested' &&
    (await page.locator('.menu-mark').count()) === 1 &&
    (await page.locator('.menu-detail.shown').innerText()).startsWith(
      'Suggested for this file.',
    ) &&
    (await page
      .locator('.menu-item', { hasText: 'Ask again which view fits' })
      .count()) === 1,
  'the menu of the Visuals button marks the suggested kind and gives the reason',
);
await shot('14-suggested-view-menu');
await page.keyboard.press('Escape');
// A click on a small card opens the dialog that makes that view.
// The question about `.gitignore` comes first when it has not been answered
// for the workspace that is open at this point.
await suggestedPick.click();
const lanesDialog = page.locator('.dialog', {
  hasText: 'Make the lanes view of api.ts',
});
const ignoreQuestion = page.getByRole('dialog').getByText('to .gitignore?');
await lanesDialog.or(ignoreQuestion).first().waitFor();
if (await ignoreQuestion.count())
  await page.getByRole('button', { name: 'Add', exact: true }).click();
await lanesDialog.waitFor();
check(true, 'a click on a small card opens the dialog that makes that view');
await page
  .locator('.dialog')
  .getByRole('button', { name: 'Cancel', exact: true })
  .click();
await page.locator('.dialog').waitFor({ state: 'detached' });
// The answer is kept for the file: it is on the card again after another
// file was shown, without asking again.
await page.locator('.file-tab', { hasText: 'gauge.go' }).click();
await page.locator('.file-tab.on', { hasText: 'gauge.go' }).waitFor();
await showKind('Blueprint');
await page.locator('.empty .meta', { hasText: 'lines' }).waitFor();
const otherFile = await page.locator('.pick.suggested').count();
const sizesOtherFile = await cardSizes();
await page.locator('.file-tab', { hasText: 'api.ts' }).click();
await page.locator('.file-tab.on', { hasText: 'api.ts' }).waitFor();
await showKind('Blueprint');
await page.locator('.pick.suggested').waitFor();
check(
  otherFile === 0 &&
    sizesOtherFile === sizesBefore &&
    (await page.locator('.pick.suggested .pick-name').innerText()).startsWith(
      'Lanes',
    ),
  'the answer is shown again for its file and for no other file',
  `${otherFile} suggested for the other file, sizes ${sizesOtherFile}`,
);

// ---- opening a folder again shows the tabs it had
// The file tabs of a folder, and which of them was on screen, are remembered
// for the folder. The "Open folder" button of the title bar opens the same
// folder again here, because the in-memory backend always picks that folder.
// Opening a folder empties the list of places the user has been, so the Back
// button is disabled once the folder has been opened again.
const tabsBeforeReopening = (await tabNames()).join();
const shownBeforeReopening = await page
  .locator('.file-tab.on .name')
  .textContent();
await page.locator('[aria-label="Open folder"]').click();
await page.locator('.toolbar [aria-label="Back"][disabled]').waitFor();
await page.locator('.file-tab.on', { hasText: shownBeforeReopening }).waitFor();
check(
  tabsBeforeReopening.includes(',') &&
    (await tabNames()).join() === tabsBeforeReopening &&
    (await page.locator('.row.selected .name').textContent()) ===
      shownBeforeReopening,
  'opening a folder again shows the file tabs it had, with the same tab on screen',
  `${tabsBeforeReopening} -> ${(await tabNames()).join()}`,
);

check(errors.length === 0, 'the page logged no errors', errors.join(' | '));
await browser.close();
server.close();
if (failed) {
  console.error(`${failed} check(s) failed. Screenshots are in ${out}`);
  process.exit(1);
}
console.log(
  `All interface checks pass in ${engineName}. Screenshots are in ${out}`,
);
