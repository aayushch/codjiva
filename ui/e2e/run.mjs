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

// Build the reference artifacts. The mock shows them as the results of its
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
// The legend strip: the packets the visual draws, each with its short name.
// It lies in the lower left corner of the visual, beside the zoom buttons,
// and the inspector has no switch for it.
const visualKeys = await visual
  .locator('#legendbar .cj-key-label')
  .allTextContents();
const visualStrip = await visual.locator('#legendbar').boundingBox();
const zoomButtons = await page.locator('.zoomctl').boundingBox();
const canvasBox = await page.locator('.canvas').boundingBox();
check(
  visualKeys.join() ===
    'Order,Priority order,Verdict,Order ID,Shed order,Batch',
  'a visual shows its legend as a strip of packets with their names',
  visualKeys.join(),
);
check(
  visualStrip.x >= canvasBox.x &&
    visualStrip.x + visualStrip.width < zoomButtons.x &&
    visualStrip.y + visualStrip.height <= canvasBox.y + canvasBox.height &&
    Math.abs(
      visualStrip.y +
        visualStrip.height / 2 -
        (zoomButtons.y + zoomButtons.height / 2),
    ) < 6,
  'the legend strip of a visual is on the line of the zoom buttons, to their left',
  JSON.stringify({ visualStrip, zoomButtons }),
);
check(
  !(await page.locator('.inspector .layer').allTextContents()).some((name) =>
    /legend/i.test(name),
  ),
  'the layers of the inspector have no switch for the legend',
);
await visual.locator('#legendbar .cj-key').first().hover();
check(
  (await visual
    .locator('#legendbar .cj-key')
    .first()
    .locator('.cj-key-card')
    .evaluate((card) => getComputedStyle(card).visibility)) === 'visible' &&
    /will be queued or deferred/.test(
      await visual.locator('#legendbar .cj-key-card').first().textContent(),
    ),
  'the pointer over a packet of the legend strip shows what the packet is',
);
await shot('03e-visual-legend');
await page.mouse.move(gate.x + gate.width / 2, gate.y + gate.height / 2);
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
// The ticked companion files are listed first. A file whose tick is taken
// off moves to directly under the ticked files, and back when it is ticked
// again. The rows slide to their new places.
const companionNames = () =>
  page
    .locator('.companions .check span')
    .evaluateAll((spans) =>
      spans.map((span) => span.firstChild.textContent.trim().split('/').pop()),
    );
const companionsAtRest = () =>
  page.waitForFunction(() =>
    document
      .querySelector('.companions')
      .getAnimations({ subtree: true })
      .every((animation) => animation.playState !== 'running'),
  );
await page.evaluate(() => {
  window.__rowsMoved = new Set();
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (...args) {
    const moved = (Array.isArray(args[0]) ? args[0] : []).some((frame) =>
      /translateY\((?!0px)/.test(frame.transform ?? ''),
    );
    if (moved && this.classList.contains('companion'))
      window.__rowsMoved.add(
        this.querySelector('.check span').firstChild.textContent.trim(),
      );
    return animate.apply(this, args);
  };
});
const namesAtStart = (await companionNames()).join();
const firstCompanion = page.locator('.companions .companion').first();
await firstCompanion.locator('input').uncheck();
await companionsAtRest();
const namesUnticked = (await companionNames()).join();
const rowsMoved = await page.evaluate(() => window.__rowsMoved.size);
await page
  .locator('.companions .companion', { hasText: 'handler_test.go' })
  .locator('input')
  .check();
await companionsAtRest();
check(
  namesAtStart === 'handler_test.go,store.go,limiter.go' &&
    namesUnticked === 'store.go,handler_test.go,limiter.go' &&
    (await companionNames()).join() === namesAtStart,
  'the ticked companion files are listed first, and a file moves when its tick changes',
  `${namesAtStart} | ${namesUnticked} | ${await companionNames()}`,
);
check(
  rowsMoved === 2,
  'the rows of the companion files slide to their new places',
  String(rowsMoved),
);
// The files that match the search are listed over the dialog, below the
// search field. The dialog keeps its place and its size, nothing covers the
// list, and the list scrolls when it has more files than fit.
// The folder gets six more files for this, so that more files match than
// fit in the list. They are deleted again below.
const spareFiles = [1, 2, 3, 4, 5, 6].map((n) => `spare/e${n}.txt`);
await page.evaluate((paths) => {
  for (const path of paths) window.__mockSetFile(path, '');
}, spareFiles);
const animateBox = () => page.locator('.dialog.animate').boundingBox();
const animateBefore = JSON.stringify(await animateBox());
await page.getByLabel('Add a companion file').fill('e');
await page.locator('.hit').first().waitFor();
const hitList = await page.locator('.hits').evaluate((list) => {
  const box = list.getBoundingClientRect();
  const field = document
    .querySelector('[aria-label="Add a companion file"]')
    .getBoundingClientRect();
  const shows = (x, y) => list.contains(document.elementFromPoint(x, y));
  return {
    files: list.children.length,
    scrolls: list.scrollHeight > list.clientHeight,
    inWindow: box.top >= 0 && box.bottom <= window.innerHeight,
    uncovered:
      shows(box.left + 4, box.top + 4) &&
      shows(box.left + box.width / 2, box.top + box.height / 2) &&
      shows(box.right - 24, box.bottom - 4),
    underField:
      box.top >= field.bottom &&
      box.top - field.bottom < 8 &&
      Math.abs(box.left - field.left) < 1 &&
      Math.abs(box.width - field.width) < 1,
  };
});
check(
  JSON.stringify(await animateBox()) === animateBefore,
  'the list of matching files leaves the dialog as large as it was',
  `${animateBefore} ${JSON.stringify(await animateBox())}`,
);
check(
  hitList.inWindow && hitList.uncovered && hitList.underField,
  'the list of matching files is below the search field, inside the window, with nothing over it',
  JSON.stringify(hitList),
);
check(
  hitList.files > 8 && hitList.scrolls,
  'the list of matching files scrolls when it has more files than fit',
  JSON.stringify(hitList),
);
await shot('09b-companion-search');
// Scrolling the list to its end keeps it open, and the last file can be
// reached.
await page.locator('.hits').evaluate((list) => {
  list.scrollTop = list.scrollHeight;
});
await page.waitForFunction(
  () => document.querySelector('.hits')?.scrollTop > 0,
);
const lastHit = await page.locator('.hits').evaluate((list) => {
  const box = list.getBoundingClientRect();
  const last = list.lastElementChild.getBoundingClientRect();
  return last.bottom <= box.bottom + 1 && last.top >= box.top;
});
check(lastHit, 'the last matching file can be scrolled into view');
// Escape closes the list and leaves the dialog open.
await page.keyboard.press('Escape');
await page.locator('.hits').waitFor({ state: 'detached' });
check(
  (await page.locator('.dialog.animate').count()) === 1 &&
    JSON.stringify(await animateBox()) === animateBefore,
  'Escape closes the list of matching files and not the dialog',
);
// The arrow keys move through the list of matching files, the list scrolls
// to keep the file they are on in view, and Enter adds that file. The list
// of companion files is made lower and scrolled to its end for this, so that
// the row of the added file, which is the first of the list, is out of view
// until the list is scrolled to it.
await page.locator('.companions').evaluate((list) => {
  list.style.maxHeight = '100px';
  list.scrollTop = list.scrollHeight;
  // The list of matching files closes when the companion files are
  // scrolled, so the scroll is let finish before the search starts.
  return new Promise((done) =>
    requestAnimationFrame(() => requestAnimationFrame(done)),
  );
});
await page.getByLabel('Add a companion file').fill('e');
await page.locator('.hit.on').waitFor();
const hitNames = await page.locator('.hit').allTextContents();
const markedHit = async () =>
  (await page.locator('.hit.on').allTextContents()).join();
const startsOnFirst = (await markedHit()) === hitNames[0];
for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowDown');
const onTwelfth = (await markedHit()) === hitNames[12];
const twelfthInView = await page.locator('.hits').evaluate((list) => {
  const box = list.getBoundingClientRect();
  const row = list.querySelector('.hit.on').getBoundingClientRect();
  return row.top >= box.top - 1 && row.bottom <= box.bottom + 1;
});
// Back up to ledger.py, the fifth file of the list.
for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowUp');
const onFifth = (await markedHit()) === hitNames[4];
check(
  startsOnFirst && onTwelfth && onFifth && hitNames[4].endsWith('ledger.py'),
  'the arrow keys move through the list of matching files',
  `${startsOnFirst} ${onTwelfth} ${onFifth} ${hitNames.join()}`,
);
check(
  twelfthInView,
  'the list of matching files scrolls to the file the arrow keys are on',
);
await page.keyboard.press('Enter');
await page.locator('.hits').waitFor({ state: 'detached' });
check(
  (await page
    .locator('.companions .check', { hasText: 'ledger.py' })
    .locator('input')
    .isChecked()) &&
    (await page.getByLabel('Add a companion file').inputValue()) === '' &&
    (await page.locator('.dialog.animate').count()) === 1,
  'Enter adds the file the arrow keys are on and empties the search field',
);
// The row of the added file is scrolled into view and highlighted, and the
// highlight is taken off after it faded out.
const addedRow = await page.locator('.companions').evaluate((list) => {
  const row = list.querySelector('.companion.added');
  if (!row) return null;
  const box = list.getBoundingClientRect();
  const at = row.getBoundingClientRect();
  return {
    name: row.querySelector('.check span').firstChild.textContent.trim(),
    inView: at.top >= box.top - 1 && at.bottom <= box.bottom + 1,
    first: row === list.querySelector('.companion'),
    scrolled: list.scrollTop === 0,
  };
});
check(
  addedRow?.name.endsWith('ledger.py') &&
    addedRow.first &&
    addedRow.inView &&
    addedRow.scrolled,
  'an added file is listed with the ticked files, scrolled into view and highlighted',
  JSON.stringify(addedRow),
);
await shot('09g-companion-added');
await page.locator('.companion.added').waitFor({ state: 'detached' });
check(true, 'the highlight of an added file is taken off after it faded out');
await page.locator('.companions').evaluate((list) => {
  list.style.maxHeight = '';
});
await page.evaluate((paths) => {
  for (const path of paths) window.__mockDeleteFile(path);
}, spareFiles);
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
    windowHeight: window.innerHeight,
    lastNumber: last.querySelector('.source-num').textContent,
    gapAfterLastLine: Math.round(
      box.bottom - last.getBoundingClientRect().bottom,
    ),
  };
});
check(
  longSource.pageScrolls <= 0 &&
    longSource.sourceBottom <= longSource.windowHeight,
  'a long file scrolls inside the source view, which ends inside the window',
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
    'Close|Close the other tabs|Open in external editor|Reveal in file manager|Copy path|Copy relative path',
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
// The tabs have one width. The window is made so narrow here that the row
// of tabs is 480 pixels wide, which is less than three tabs at their widest.
const tabWidths = () =>
  page
    .locator('.file-tab')
    .evaluateAll((tabs) =>
      tabs.map((tab) => tab.getBoundingClientRect().width),
    );
const tabsAtRest = () =>
  page.waitForFunction(() =>
    document
      .querySelector('.file-tabs')
      .getAnimations({ subtree: true })
      .every((animation) => animation.playState !== 'running'),
  );
const wideRow = await page
  .locator('.file-tabs')
  .evaluate((tabRow) => tabRow.clientWidth);
await page.setViewportSize({ width: 1600 - (wideRow - 480), height: 960 });
await page.waitForFunction(
  () => document.querySelector('.file-tabs').clientWidth === 480,
);
const threeTabs = await tabWidths();
check(
  threeTabs.length === 3 && threeTabs.every((w) => Math.abs(w - 160) < 0.5),
  'the tabs share the width of the row in equal parts',
  threeTabs.join(),
);
// Closing the tab on screen shows the tab to its right. That tab moves to
// where the closed tab was, so its close button is under the pointer, and
// the widths of the tabs stay as they are while the pointer is on the row.
// The names of the tabs that were moved sideways with an animation.
await page.evaluate(() => {
  window.__tabsMoved = new Set();
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (...args) {
    const sideways = (Array.isArray(args[0]) ? args[0] : []).some((frame) =>
      /translateX\((?!0px)/.test(frame.transform ?? ''),
    );
    if (sideways && this.classList.contains('file-tab'))
      window.__tabsMoved.add(this.querySelector('.name').textContent);
    return animate.apply(this, args);
  };
});
const closeLeft = async (name) =>
  (await fileTab(name).locator('.file-tab-close').boundingBox()).x;
const closedAt = await closeLeft('limiter.go');
await fileTab('limiter.go').locator('.file-tab-close').click();
await page.locator('.file-tab.on', { hasText: 'store.go' }).waitFor();
await tabsAtRest();
const nextAt = await closeLeft('store.go');
const keptTabs = await tabWidths();
check(
  Math.abs(nextAt - closedAt) < 0.5,
  'the close button of the next tab is where the closed tab had its own',
  `${closedAt} ${nextAt}`,
);
check(
  keptTabs.length === 2 && keptTabs.every((w) => Math.abs(w - 160) < 0.5),
  'the tabs keep their widths while the pointer is on the row of tabs',
  keptTabs.join(),
);
const tabsMoved = await page.evaluate(() => [...window.__tabsMoved].join());
check(
  tabsMoved === 'store.go',
  'the tab after a closed tab slides to its new place',
  tabsMoved,
);
await page.mouse.move(700, 500);
await page.waitForFunction(() => !document.querySelector('.file-tab.kept'));
await tabsAtRest();
const freedTabs = await tabWidths();
check(
  freedTabs.every((w) => Math.abs(w - 200) < 0.5),
  'the tabs share the row again when the pointer leaves the row of tabs',
  freedTabs.join(),
);
await page.setViewportSize({ width: 1600, height: 960 });
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
    'Visualise…|Animate…|Step through…|Schema view…|Lanes view…|Structure view…|Show history|Copy path|Copy relative path' &&
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

// ---- a film in the sandboxed frame
// The page is loaded again and a film is made of handler.go, so that the
// checks below start from a film that nothing has been done to.
await page.reload();
check(
  (await page.locator('.welcome .actions .btn').allTextContents())
    .map((label) => label.trim())
    .join(' | ') === 'Open folder…',
  'the welcome screen offers to open a folder and no example',
  (await page.locator('.welcome .actions .btn').allTextContents()).join(' | '),
);
await page.locator('.recent', { hasText: 'shop' }).click();
await row('internal').waitFor();
// Starts the job of the dialog that is open. The first job after the page
// was loaded asks about .gitignore before its own dialog.
const startJob = async (title, button) => {
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  const add = dialog.getByRole('button', { name: 'Add', exact: true });
  if ((await add.count()) === 1) await add.click();
  await dialog.getByText(title).waitFor();
  await dialog.getByRole('button', { name: button, exact: true }).click();
};
await page.keyboard.press(`${mod}+p`);
await page.getByPlaceholder('Go to file…').fill('orders/handler.go');
await page.locator('.quick-row').first().waitFor();
await page.keyboard.press('Enter');
await page.locator('.file-tab.on', { hasText: 'handler.go' }).waitFor();
await showKind('Film');
await page.getByRole('button', { name: 'Animate with companions…' }).click();
await startJob('Animate handler.go', 'Animate');
await page.locator('.player:not(.waiting)').waitFor({ timeout: 60000 });
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
// The legend strip of a film is a row under the picture, directly above the
// bar of the player, and it is there in every chapter.
const filmKeys = await page
  .frameLocator('.canvas iframe')
  .locator('#legendbar .cj-key-label')
  .allTextContents();
const filmStrip = await page
  .frameLocator('.canvas iframe')
  .locator('#legendbar')
  .boundingBox();
const playerBar = await page.locator('.player').boundingBox();
check(
  filmKeys.join() === 'An order,The batch' &&
    Math.abs(filmStrip.y + filmStrip.height - playerBar.y) < 2 &&
    Math.abs(filmStrip.width - playerBar.width) < 2,
  'a film shows its legend as a row above the bar of the player, in every chapter',
  JSON.stringify({ filmKeys, filmStrip, playerBar }),
);
await page.waitForTimeout(300);
await shot('07-film');
await page.locator('.player select').selectOption('1.25');
await page.getByRole('button', { name: 'Turn sound on' }).click();
await page.getByRole('button', { name: 'Mute' }).waitFor({ timeout: 3000 });
check(true, "the sound button switches the film's sound and mirrors its state");

// ---- the film is drawn in the app's theme
const filmFrameInTheme = page.frameLocator('.canvas iframe');
await page.keyboard.press(`${mod}+,`);
await section('Appearance').click();
await page.getByRole('button', { name: 'Light', exact: true }).click();
await page.getByRole('button', { name: 'Done' }).click();
await filmFrameInTheme
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
await filmFrameInTheme
  .locator('html:not([data-theme])')
  .waitFor({ timeout: 5000 });
await page.locator('.canvas iframe.dark-stage').waitFor({ timeout: 5000 });
check(true, 'back in the dark theme the film is dark again, without reloading');

// ---- the zoom buttons of a blueprint
await showKind('Blueprint');
await page.locator('.empty .pick').first().click();
await startJob('Visualise handler.go', 'Visualise');
await page.locator('.zoomctl').waitFor({ timeout: 60000 });
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
// The next checks start from the welcome screen.
await page.reload();
await page.getByRole('button', { name: 'Open folder…' }).waitFor();

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

// The references of a file can be closed, and the button beside the word
// "References" closes and opens the references of every file.
const fileHeads = page.locator('.symbol-panel .nav-file');
const refRows = page.locator('.symbol-panel .ref-row');
const allFiles = page.locator('.symbol-panel .nav-refs-head .tb-btn');
await fileHeads.nth(1).waitFor();
const rowsOpen = await refRows.count();
const rowsOfFirst = Number(
  await fileHeads.nth(0).locator('.muted').last().textContent(),
);
await fileHeads.nth(0).click();
check(
  (await refRows.count()) === rowsOpen - rowsOfFirst &&
    (await fileHeads.nth(0).getAttribute('aria-expanded')) === 'false' &&
    (await fileHeads.count()) === 2,
  'a click on the heading of a file closes the references of that file only',
  `${await refRows.count()} of ${rowsOpen} rows`,
);
await allFiles.click();
check(
  (await refRows.count()) === 0 &&
    (await fileHeads.count()) === 2 &&
    (await allFiles.getAttribute('aria-label')) === 'Expand all files',
  'the button beside "References" closes every file and leaves the headings',
  `${await refRows.count()} rows`,
);
await fileHeads.nth(1).click();
check(
  (await refRows.count()) === rowsOpen - rowsOfFirst &&
    (await allFiles.getAttribute('aria-label')) === 'Collapse all files',
  'a file can be opened alone after every file was closed',
  `${await refRows.count()} rows`,
);
check(
  (await page.locator('.insp-tabs').count()) === 0,
  'the panel beside the source view has no About and Ask tabs',
);
await allFiles.click();
await allFiles.click();
check(
  (await refRows.count()) === rowsOpen &&
    (await fileHeads.nth(0).getAttribute('aria-expanded')) === 'true',
  'the same button opens every file again',
  `${await refRows.count()} of ${rowsOpen} rows`,
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

// A named constant is drawn in the colour of a number. A click on it selects
// it like any other name.
await page.evaluate(() =>
  window.__mockSetFile(
    'nav/limits.ts',
    [
      'const MAX_BATCH = 64;',
      '',
      'export const full = (count: number) => count >= MAX_BATCH;',
      '',
    ].join('\n'),
  ),
);
await page.keyboard.press(`${mod}+KeyP`);
await page.locator('.dialog.quick .input').fill('nav/limits');
await page.locator('.quick-row').first().waitFor();
await page.keyboard.press('Enter');
await page.locator('.source-line[data-line="3"] .tk-number').waitFor();
const constantUse = await pointOf(3, 'MAX_BATCH');
const constantKind = await page.evaluate(
  ([x, y]) => document.elementFromPoint(x, y).className,
  [constantUse.x, constantUse.y],
);
await page.mouse.click(constantUse.x, constantUse.y);
await page.locator('.symbol-panel h3', { hasText: 'MAX_BATCH' }).waitFor();
check(
  constantKind === 'tk-number',
  'a click on a named constant, which has the colour of a number, selects it',
  constantKind,
);

// The size of the code is changed in Settings, and a line stays 20 pixels
// tall for every 13 pixels of the size.
const codeMetrics = () =>
  page
    .locator('.source-line')
    .first()
    .evaluate((line) => ({
      font: getComputedStyle(line).fontSize,
      height: line.getBoundingClientRect().height,
    }));
const codeBefore = await codeMetrics();
await page.keyboard.press(`${mod}+,`);
await section('Appearance').click();
await page.getByRole('button', { name: 'Larger code' }).click();
await page.getByRole('button', { name: 'Larger code' }).click();
await page.locator('.stepper-value', { hasText: '15 px' }).waitFor();
await shot('12b-code-size');
await page.getByRole('button', { name: 'Done' }).click();
const codeLarger = await codeMetrics();
check(
  codeBefore.font === '13px' &&
    codeBefore.height === 20 &&
    codeLarger.font === '15px' &&
    codeLarger.height === 23,
  'Settings changes the size of the code in the source view',
  JSON.stringify([codeBefore, codeLarger]),
);
await page.keyboard.press(`${mod}+,`);
await section('Appearance').click();
await page.getByRole('button', { name: 'Reset', exact: true }).click();
await page.locator('.stepper-value', { hasText: '13 px' }).waitFor();
await page.getByRole('button', { name: 'Done' }).click();
check(
  (await codeMetrics()).font === '13px',
  'the Reset button sets the size of the code back',
);

// ---- the last change of a line
// A click on a line asks git who changed it last. The answer is written
// after the code of the line, and a card with the whole commit shows while
// the pointer is over it. The mock tracks every file but those under `nav/`.
{
  const blameOf = (line) =>
    page.locator(`.source-line[data-line="${line}"] .source-blame`);
  const numberOf = (line) =>
    page.locator(`.source-line[data-line="${line}"] .source-num`);
  await numberOf(1).click();
  await page.waitForTimeout(300);
  check(
    (await page.locator('.source-blame').count()) === 0,
    'a line of a file that git does not track has no last change',
  );
  await page.keyboard.press(`${mod}+KeyP`);
  await page.locator('.dialog.quick .input').fill('orders/handler.go');
  await page.locator('.quick-row').first().waitFor();
  await page.keyboard.press('Enter');
  await page.locator('.file-tab.on', { hasText: 'handler.go' }).waitFor();
  await page.locator('.tab.source-tab').click();
  await numberOf(3).waitFor();
  await numberOf(3).click();
  await blameOf(3).waitFor();
  check(
    (await blameOf(3).textContent()).trim() ===
      'You, last week • Refuse an order when the batch is full',
    'a click on a line shows who changed it last, how long ago and why',
    await blameOf(3).textContent(),
  );
  const copied = await page.evaluate(() => {
    const line = document.querySelector('.source-line[data-line="3"]');
    const range = document.createRange();
    range.selectNodeContents(line);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const text = selection.toString();
    selection.removeAllRanges();
    return text;
  });
  check(
    !copied.includes('Refuse an order'),
    'the last change is not selected with the code of its line',
    copied,
  );
  await blameOf(3).hover();
  const card = page.locator('.blame-card');
  await card.waitFor();
  const cardText = await card.innerText();
  check(
    cardText.includes('You') &&
      cardText.includes('9dbe511') &&
      cardText.includes('The batch holds at most 64 orders.') &&
      !cardText.includes('9dbe5110'),
    'the card over the last change shows the whole commit message and the short hash',
    cardText,
  );
  await shot('12c-blame');
  // The card stays while the pointer is over it, and goes when it leaves.
  await card.hover();
  await page.waitForTimeout(400);
  const stayed = (await card.count()) === 1;
  await page.mouse.move(5, 5);
  await card.waitFor({ state: 'detached' });
  check(stayed, 'the card stays while the pointer is over it');
  await numberOf(4).click();
  await blameOf(4).waitFor();
  check(
    (await blameOf(4).textContent()).trim().startsWith('Ada Writer, ') &&
      (await page.locator('.source-blame').count()) === 1,
    'a click on another line moves the last change to that line',
    await blameOf(4).textContent(),
  );
}

// ---- bookmarks in the source view
// A double click on a line number sets a bookmark on the line and a second
// one removes it. F2 and Shift with F2 go through the bookmarks of the file,
// each has a tick on the right edge of the view, and the bookmark button of
// the toolbar lists them. They are there again when the folder is opened
// again.
{
  const numberOf = (line) =>
    page.locator(`.source-line[data-line="${line}"] .source-num`);
  const marked = () =>
    page
      .locator('.source-line.bookmarked')
      .evaluateAll((rows) => rows.map((row) => Number(row.dataset.line)));
  const shownLine = () =>
    page
      .locator('.source-line.ref')
      .evaluate((row) => Number(row.dataset.line));
  for (const line of [9, 27, 34]) await numberOf(line).dblclick();
  await page.locator('.source-tick').nth(2).waitFor();
  check(
    (await marked()).join() === '9,27,34' &&
      (await page.locator('.bookmark-mark').count()) === 3 &&
      (await page.locator('.bookmarks-tab .count').textContent()) === '3',
    'a double click on a line number sets a bookmark, which the line and the toolbar show',
    (await marked()).join(),
  );
  const amber = await numberOf(9).evaluate(
    (number) => getComputedStyle(number).color,
  );
  const plain = await numberOf(10).evaluate(
    (number) => getComputedStyle(number).color,
  );
  check(
    amber !== plain,
    'the number of a bookmarked line has a colour of its own',
    `${amber} and ${plain}`,
  );
  // The ticks are at the right edge of the view, in the order of the lines.
  const ticks = await page.evaluate(() => {
    const view = document.querySelector('.source').getBoundingClientRect();
    return Array.from(document.querySelectorAll('.source-tick')).map((tick) => {
      const box = tick.getBoundingClientRect();
      return {
        atEdge: Math.abs(box.right - view.right) < 20,
        top: Math.round(box.top - view.top),
      };
    });
  });
  check(
    ticks.every((tick) => tick.atEdge) &&
      ticks[0].top < ticks[1].top &&
      ticks[1].top < ticks[2].top,
    'each bookmark has a tick on the right edge of the source view',
    JSON.stringify(ticks),
  );
  await shot('12d-bookmarks');

  // F2 goes down through the bookmarks and starts again at the top.
  const order = [9, 27, 34];
  await page.keyboard.press('F2');
  await page.locator('.source-line.ref.bookmarked').waitFor();
  const first = await shownLine();
  const after = (line, steps) =>
    order[(order.indexOf(line) + steps + order.length) % order.length];
  const visited = [first];
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('F2');
    await page.waitForTimeout(150);
    visited.push(await shownLine());
  }
  await page.keyboard.press('Shift+F2');
  await page.waitForTimeout(150);
  visited.push(await shownLine());
  check(
    order.includes(first) &&
      visited[1] === after(first, 1) &&
      visited[2] === after(first, 2) &&
      visited[3] === first &&
      visited[4] === after(first, -1),
    'F2 goes to the next bookmark, around the end of the file, and Shift with F2 goes back',
    visited.join(),
  );

  // The list of the toolbar and a tick go to a bookmark too.
  await page.locator('.bookmarks-tab').click();
  const listed = await page.locator('.menu-item').allTextContents();
  check(
    listed.length === 4 &&
      listed[0].trim().startsWith('9 · ') &&
      listed[3].trim() === 'Remove all bookmarks of this file',
    'the bookmark button lists the bookmarks of the file',
    listed.join(' | '),
  );
  await page.locator('.menu-item').nth(1).click();
  await page.locator('.source-line.ref[data-line="27"]').waitFor();
  await page.locator('.source-tick').first().click();
  await page.locator('.source-line.ref[data-line="9"]').waitFor();
  check(true, 'the list and a tick go to the line of a bookmark');

  // The folder is opened again, and the bookmarks are still there.
  await page.keyboard.press(`${mod}+o`);
  await page.locator('.file-tab.on', { hasText: 'handler.go' }).waitFor();
  await page.locator('.source-tick').nth(2).waitFor();
  check(
    (await marked()).join() === '9,27,34',
    'the bookmarks are there again when the folder is opened again',
    (await marked()).join(),
  );

  // A second double click removes one, and the list removes the rest. The
  // line a jump went to is highlighted, and removing its bookmark removes
  // that highlight too.
  await page.locator('.source-tick').first().click();
  await page.locator('.source-line.ref[data-line="9"]').waitFor();
  await numberOf(9).dblclick();
  await page.locator('.bookmarks-tab .count', { hasText: '2' }).waitFor();
  const afterOne = (await marked()).join();
  const highlightAfterOne = await page.locator('.source-line.ref').count();
  await page.keyboard.press('F2');
  await page.locator('.source-line.ref.bookmarked').waitFor();
  await page.locator('.bookmarks-tab').click();
  await page
    .locator('.menu-item', { hasText: 'Remove all bookmarks of this file' })
    .click();
  await page.locator('.source-tick').first().waitFor({ state: 'detached' });
  check(
    highlightAfterOne === 0 &&
      (await page.locator('.source-line.ref').count()) === 0,
    'removing a bookmark removes the highlight of the line a jump to it left',
    `${highlightAfterOne} then ${await page.locator('.source-line.ref').count()}`,
  );
  check(
    afterOne === '27,34' &&
      (await marked()).length === 0 &&
      (await page.locator('.bookmarks-tab .count').count()) === 0,
    'a second double click removes a bookmark, and the list removes them all',
    afterOne,
  );
}

// ---- finding text in the source view
// The key with F opens the search of the file on screen, which is
// handler.go. Every place the text stands is marked, the view shows one of
// them, and Enter goes to the next. A place far down a long file is
// scrolled to, although its line was not in the page.
{
  const count = page.locator('.source-find .find-count');
  const box = page.getByLabel('Find in this file');
  const marks = () =>
    page.evaluate(() => ({
      all: CSS.highlights?.get('find-match')?.size ?? 0,
      current: CSS.highlights?.get('find-current')?.size ?? 0,
    }));
  await page.keyboard.press(`${mod}+f`);
  await box.waitFor();
  check(
    await box.evaluate((input) => input === document.activeElement),
    'the key with F opens the search of the file with the keyboard in its box',
  );
  await page.keyboard.type('handler');
  await count.filter({ hasText: ' of ' }).waitFor();
  const anyCase = await count.textContent();
  const total = Number(anyCase.split(' of ')[1]);
  const marked = await marks();
  check(
    anyCase.startsWith('1 of ') &&
      total > 1 &&
      marked.all === total &&
      marked.current === 1,
    'every place the text stands in the file is marked, and one of them more strongly',
    `${anyCase} ${JSON.stringify(marked)}`,
  );
  await shot('12e-find');
  await page.keyboard.press('Enter');
  const second = await count.textContent();
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.press('Shift+Enter');
  const last = await count.textContent();
  check(
    second === `2 of ${total}` && last === `${total} of ${total}`,
    'Enter goes to the next place, and Shift with Enter goes back around the start of the file',
    `${second} then ${last}`,
  );
  await page.getByRole('button', { name: 'Match case' }).click();
  await page.waitForTimeout(150);
  const exactCase = await count.textContent();
  check(
    exactCase === 'No results' || Number(exactCase.split(' of ')[1]) < total,
    'the "Aa" button tells capital letters from small ones',
    `${anyCase} then ${exactCase}`,
  );
  await page.getByRole('button', { name: 'Match case' }).click();
  await box.fill('no such text anywhere');
  await count.filter({ hasText: 'No results' }).waitFor();
  check(
    (await marks()).all === 0,
    'text that is not in the file has no result and no mark',
  );
  await page.keyboard.press('Escape');
  await page.locator('.source-find').waitFor({ state: 'detached' });
  check(true, 'Escape closes the search');

  // A long file, with the word only on line 300.
  await page.evaluate(() =>
    window.__mockSetFile(
      'nav/long.go',
      Array.from({ length: 400 }, (_, i) =>
        i === 299 ? 'var needle = 1' : `// line ${i + 1}`,
      ).join('\n'),
    ),
  );
  await page.keyboard.press(`${mod}+KeyP`);
  await page.locator('.dialog.quick .input').fill('nav/long');
  await page.locator('.quick-row').first().waitFor();
  await page.keyboard.press('Enter');
  await page.locator('.file-tab.on', { hasText: 'long.go' }).waitFor();
  await page.locator('.source-line[data-line="1"]').waitFor();
  await page.keyboard.press(`${mod}+f`);
  await box.fill('needle');
  await page.locator('.source-line[data-line="300"]').waitFor();
  const needle = await page.evaluate(() => {
    const view = document.querySelector('.source').getBoundingClientRect();
    const line = document
      .querySelector('.source-line[data-line="300"]')
      .getBoundingClientRect();
    return {
      inView: line.top > view.top && line.bottom < view.bottom,
      current: CSS.highlights?.get('find-current')?.size ?? 0,
    };
  });
  check(
    needle.inView &&
      needle.current === 1 &&
      (await count.textContent()) === '1 of 1',
    'the search scrolls to a place on a line that was not in the page',
    JSON.stringify(needle),
  );
  await page.getByRole('button', { name: 'Close the search' }).click();
  await page.locator('.source-find').waitFor({ state: 'detached' });
  check(
    await page.evaluate(() => !CSS.highlights?.has('find-match')),
    'closing the search removes its marks',
  );
}

// ---- pictures, and files shown rendered
// An image file is shown as its picture. An SVG file and an HTML file are
// text, and the Preview command of the file tree and the Preview button of
// the toolbar show them rendered.
{
  await page.evaluate(() => {
    window.__mockSetFile('art/dot.png', 'not text');
    window.__mockSetFile(
      'art/logo.svg',
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="teal"/></svg>',
    );
    window.__mockSetFile(
      'art/page.html',
      '<!doctype html><h1>Orders</h1><p>A page of the shop.</p>',
    );
    window.__mockSetFile(
      'art/guide.md',
      [
        '# Guide',
        '',
        'Read the [manual](https://example.com/manual) first.',
        '',
        '![The logo](logo.svg)',
        '',
        '- [x] one',
        '- [ ] two',
        '',
        '```go',
        'func main() {}',
        '```',
      ].join('\n'),
    );
    // The stand-in backend lists the root folder again when it is told that
    // a file there changed. That is how the new folder gets its row.
    window.__mockEditFile('go.mod');
  });
  await row('art').waitFor();
  const open = async (name) => {
    await page.keyboard.press(`${mod}+KeyP`);
    await page.locator('.dialog.quick .input').fill(name);
    await page.locator('.quick-row').first().waitFor();
    await page.keyboard.press('Enter');
    await page
      .locator('.file-tab.on', { hasText: name.split('/').pop() })
      .waitFor();
  };
  await open('art/dot.png');
  await page.locator('.preview-about', { hasText: 'px' }).waitFor();
  check(
    (await page.locator('.preview-about').innerText()).trim() ===
      '2 × 1 px · 70 B' &&
      (await page.locator('.source').count()) === 0 &&
      (await page.locator('.preview-tab').count()) === 0,
    'an image file is shown as its picture, with its size in pixels and in bytes',
    await page.locator('.preview-about').innerText(),
  );
  await shot('12f-picture');

  // An SVG file opens as text. The Preview button shows the picture and
  // shows the text again.
  await open('art/logo.svg');
  await page.locator('.source-line').first().waitFor();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.locator('.preview-about', { hasText: '40 × 20 px' }).waitFor();
  check(
    (await page.locator('.source').count()) === 0 &&
      (await page.locator('.bookmarks-tab').count()) === 0,
    'the Preview button shows an SVG file as the picture it describes',
  );
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.locator('.source-line').first().waitFor();
  check(
    (await page.locator('.preview').count()) === 0,
    'the same button shows the text of the file again',
  );

  // The Preview command of the file tree opens an HTML file as a page, in a
  // frame that may do nothing.
  await row('page.html').click({ button: 'right' });
  check(
    (await page.locator('.menu-item').allTextContents())
      .map((label) => label.trim())
      .includes('Preview'),
    'the menu of a file that can be shown rendered has a Preview command',
    (await page.locator('.menu-item').allTextContents()).join('|'),
  );
  await page.locator('.menu-item', { hasText: 'Preview' }).click();
  const framed = page.locator('.preview-frame');
  await framed.waitFor();
  check(
    (await framed.getAttribute('sandbox')) === '' &&
      (await framed.getAttribute('srcdoc')).includes('<h1>Orders</h1>') &&
      (await page.locator('.file-tab.on .name').textContent()) === 'page.html',
    'the Preview command opens an HTML file as a page, in a frame that runs no scripts',
    await framed.getAttribute('sandbox'),
  );
  const heading = page.frameLocator('.preview-frame').locator('h1');
  await heading.waitFor({ timeout: 5000 });
  check(
    (await heading.textContent()) === 'Orders',
    'the page of the HTML file is laid out in the frame',
  );
  await shot('12g-page');

  // A Markdown file opens as text, and the Preview button shows it as a
  // document in the colours of the app. The picture it names is a file of
  // the workspace, so it is shown. The link keeps its address as a tooltip
  // and cannot be followed.
  await open('art/guide.md');
  await page.locator('.source-line').first().waitFor();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const rendered = page.frameLocator('.preview-frame');
  await rendered.locator('h1').waitFor({ timeout: 5000 });
  const guide = await rendered.locator('body').evaluate((body) => ({
    title: body.querySelector('h1').textContent,
    picture: body.querySelector('img').getAttribute('src').slice(0, 19),
    link: body.querySelector('a').getAttribute('href'),
    tip: body.querySelector('a').getAttribute('title'),
    boxes: body.querySelectorAll('input[type=checkbox]').length,
    code: body.querySelector('pre code').textContent.trim(),
    ground: getComputedStyle(body.ownerDocument.documentElement)
      .backgroundColor,
  }));
  const ground = await page.evaluate(
    () => getComputedStyle(document.querySelector('.preview')).backgroundColor,
  );
  check(
    guide.title === 'Guide' &&
      guide.picture === 'data:image/svg+xml;' &&
      guide.link === null &&
      guide.tip === 'https://example.com/manual' &&
      guide.boxes === 2 &&
      guide.code === 'func main() {}' &&
      (await page.locator('.preview-frame').getAttribute('sandbox')) === '',
    'the Preview button shows a Markdown file as a document, with its picture from the workspace',
    JSON.stringify(guide),
  );
  check(
    guide.ground === ground,
    'the Markdown document has the ground of the app',
    `${guide.ground} / ${ground}`,
  );
  await shot('12h-markdown');
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.locator('.source-line').first().waitFor();
}

// ---- what git says about the files, in the file tree
// The stand-in backend reports the changes the test gives it, and is asked
// again when a file changes on disk and when the window comes to the front.
{
  const git = (name) =>
    row(name).evaluate((element) => {
      const probe = document.createElement('span');
      probe.style.color = `var(--git-${element.dataset.git})`;
      document.body.append(probe);
      const wanted = getComputedStyle(probe).color;
      probe.remove();
      const name = element.querySelector('.name');
      const letter = element.querySelector('.git-letter');
      return {
        status: element.dataset.git ?? null,
        letter: letter?.textContent ?? null,
        coloured:
          getComputedStyle(name).color === wanted &&
          (!letter || getComputedStyle(letter).color === wanted),
        title: element.getAttribute('title'),
      };
    });
  const plain = await git('guide.md');
  check(
    plain.status === null && plain.letter === null,
    'a file without a change has no git mark',
    JSON.stringify(plain),
  );
  await page.evaluate(() => {
    window.__mockGitStatus = [
      { path: 'art/logo.svg', status: 'modified' },
      { path: 'art/guide.md', status: 'untracked' },
      { path: 'art/page.html', status: 'conflicted' },
      { path: 'art/dot.png', status: 'added' },
      { path: 'internal/orders/gone.go', status: 'deleted' },
    ];
    window.__mockEditFile('go.mod');
  });
  await page.locator('.row[data-git="modified"]').first().waitFor();
  const marks = {
    logo: await git('logo.svg'),
    guide: await git('guide.md'),
    page: await git('page.html'),
    dot: await git('dot.png'),
    art: await git('art'),
    internal: await git('internal'),
  };
  check(
    marks.logo.letter === 'M' &&
      marks.guide.letter === 'U' &&
      marks.page.letter === '!' &&
      marks.dot.letter === 'A' &&
      Object.values(marks).every((mark) => mark.coloured) &&
      marks.logo.title === 'art/logo.svg · Modified',
    'a changed file has the letter and the colour of its git status',
    JSON.stringify(marks),
  );
  check(
    marks.art.status === 'conflicted' &&
      marks.art.letter === null &&
      marks.art.title.includes('Has files with a conflict') &&
      marks.internal.status === 'deleted',
    'a folder has the colour of the changes inside it, and no letter',
    JSON.stringify([marks.art, marks.internal]),
  );
  await shot('12i-git');

  // Git tracks nothing in a folder: every row inside it is untracked. The
  // window coming to the front asks git again.
  await page.evaluate(() => {
    window.__mockGitStatus = [{ path: 'art/', status: 'untracked' }];
    window.dispatchEvent(new Event('focus'));
  });
  await page.locator('.row[data-git="untracked"]').first().waitFor();
  await page.waitForFunction(
    () => document.querySelectorAll('.row[data-git="conflicted"]').length === 0,
  );
  const inside = [
    await git('art'),
    await git('logo.svg'),
    await git('dot.png'),
  ];
  check(
    inside.every((mark) => mark.status === 'untracked' && mark.coloured) &&
      inside[0].letter === null &&
      inside[1].letter === 'U' &&
      (await git('internal')).status === null,
    'everything inside a folder that git does not track is untracked',
    JSON.stringify(inside),
  );
  await page.evaluate(() => {
    window.__mockGitStatus = [];
    window.dispatchEvent(new Event('focus'));
  });
  await page.waitForFunction(
    () => document.querySelectorAll('.row[data-git]').length === 0,
  );
  check(
    (await page.locator('.git-letter').count()) === 0,
    'the marks go when git reports no changes',
  );
}

// ---- the changes of a file, walked from what is not committed
// The stand-in backend gives `diffs/price.go` three commits and a change
// that is not committed. The Changes button of the toolbar shows one change
// at a time, compared with the version before it.
{
  await page.evaluate(() => {
    // The file after each commit. Each version is the one before with one
    // edit, so every change has a known number of lines.
    const first = ['package price', ''];
    for (let i = 1; i <= 60; i++) first.push(`const Step${i} = ${i}`);
    const second = [...first];
    second[4] = 'const Step3 = 300';
    const third = [...second];
    third.splice(50, 0, 'const Extra = 1', 'const More = 2');
    const now = [...third];
    now[10] = 'const Step9 = 900';
    now.splice(20, 1);
    const text = (lines) => lines.join('\n') + '\n';
    window.__mockSetFile('diffs/price.go', text(now));
    const day = 86_400;
    const at = Math.floor(Date.now() / 1000);
    window.__mockGitHistory = {
      'diffs/price.go': {
        pending: true,
        commits: [
          {
            commit: 'c3'.padEnd(40, '0'),
            author: 'Bo Reader',
            time: at - 2 * day,
            summary: 'Add two prices',
            text: text(third),
          },
          {
            commit: 'c2'.padEnd(40, '0'),
            author: 'Ada Writer',
            time: at - 5 * day,
            summary: 'Raise the third step',
            text: text(second),
          },
          {
            commit: 'c1'.padEnd(40, '0'),
            author: 'Ada Writer',
            time: at - 9 * day,
            summary: 'Add the prices',
            text: text(first),
          },
        ],
      },
    };
    window.__mockGitStatus = [{ path: 'diffs/price.go', status: 'modified' }];
    window.__mockEditFile('go.mod');
  });
  await row('diffs').waitFor();
  await page.keyboard.press(`${mod}+KeyP`);
  await page.locator('.dialog.quick .input').fill('diffs/price.go');
  await page.locator('.quick-row').first().waitFor();
  await page.keyboard.press('Enter');
  await page.locator('.file-tab.on', { hasText: 'price.go' }).waitFor();
  await page.locator('.tab.source-tab').click();
  await page.locator('.source-line').first().waitFor();

  // Where the buttons at the right end of the toolbar are, from left to
  // right. They must not move when the list of changes appears.
  const places = () =>
    page
      .locator('.toolbar .tabs .tab')
      .evaluateAll((tabs) =>
        tabs.map((tab) => Math.round(tab.getBoundingClientRect().left)),
      );
  const before = await places();
  const changesButton = page.getByRole('button', {
    name: 'Changes',
    exact: true,
  });
  await changesButton.click();
  await page.locator('.diff-line').first().waitFor();
  const picker = page.locator('.commit-button');
  const shown = async () => (await picker.innerText()).replace(/\s*▾$/, '');
  check(
    (await shown()) === 'Uncommitted changes' &&
      (await page.locator('.source').count()) === 0,
    'the Changes button shows what is not committed in place of the text',
    await shown(),
  );
  check(
    JSON.stringify(await places()) === JSON.stringify(before) &&
      before.length >= 3,
    'the buttons at the right end of the toolbar stay where they are when the list of changes appears',
    `${JSON.stringify(before)} -> ${JSON.stringify(await places())}`,
  );
  const pickerWidth = (await picker.boundingBox()).width;

  // One column: the removed lines and the added lines of the change, with
  // the unchanged lines far from them folded away.
  const lines = (kind) => page.locator(`.diff-line.${kind}`);
  const texts = async (kind) =>
    (await lines(kind).locator('.source-text').allTextContents()).join('|');
  check(
    (await texts('removed')) === 'const Step9 = 9|const Step19 = 19' &&
      (await texts('added')) === 'const Step9 = 900' &&
      (await page.locator('.diff-counts').innerText()).replace(/\s+/g, ' ') ===
        '+1 −2',
    'a change is shown as the lines it removed and the lines it added',
    `${await texts('removed')} / ${await texts('added')} / ${await page.locator('.diff-counts').innerText()}`,
  );
  const folds = page.locator('.diff-fold');
  const foldCount = await folds.count();
  const rowsBefore = await page.locator('.diff-line').count();
  check(
    foldCount === 2 &&
      (await folds.first().innerText()).trim() === '⋯ 7 unchanged lines',
    'the unchanged lines far from a change are folded away',
    (await folds.allInnerTexts()).join(' | '),
  );
  await folds.first().click();
  check(
    (await folds.count()) === foldCount - 1 &&
      (await page.locator('.diff-line').count()) === rowsBefore + 7,
    'a click on a row of folded lines shows those lines',
    `${await folds.count()} folds, ${await page.locator('.diff-line').count()} lines`,
  );
  await shot('12j-diff');

  // A click on a number of the new version shows that line in the text.
  await lines('added').locator('.diff-num.to-line').click();
  await page.locator('.source-line.ref').waitFor();
  check(
    (await page.locator('.source-line.ref').getAttribute('data-line')) ===
      '11' && (await page.locator('.diff').count()) === 0,
    'a click on a line number of the file on disk shows that line in the text',
    await page.locator('.source-line.ref').getAttribute('data-line'),
  );
  await changesButton.click();
  await page.locator('.diff-line').first().waitFor();

  // The whole file: nothing is folded. The buttons of the bar go from one
  // place where lines changed to the next.
  await page.getByRole('button', { name: 'Whole file' }).click();
  const pane = page.locator('.diff-pane').first();
  const top = () => pane.evaluate((element) => element.scrollTop);
  await page.waitForFunction(
    () => document.querySelectorAll('.diff-fold').length === 0,
  );
  const sizer = await page
    .locator('.diff-sizer')
    .evaluate((element) => element.getBoundingClientRect().height);
  check(
    sizer === 65 * 20,
    'the whole file is shown with every line',
    `${sizer} px`,
  );
  const atFirst = await top();
  // The rows that are highlighted: the class each has for its highlight and
  // whether it is a changed row.
  const flashed = () =>
    page
      .locator('.diff-line.flash-a, .diff-line.flash-b')
      .evaluateAll((lines) =>
        lines.map(
          (line) =>
            (line.classList.contains('flash-a') ? 'a' : 'b') +
            (line.matches('.added, .removed') ? ' changed' : ' same'),
        ),
      );
  await page.getByRole('button', { name: 'Next change' }).click();
  const atSecond = await top();
  const flashedSecond = await flashed();
  await shot('12n-diff-went-to-change');
  await page.keyboard.press('Shift+F7');
  const flashedFirst = await flashed();
  check(
    atSecond > atFirst && (await top()) === atFirst,
    'the bar and the F7 key go to the next and the previous change',
    `${atFirst} -> ${atSecond} -> ${await top()}`,
  );
  check(
    flashedSecond.length > 0 &&
      flashedSecond.every((line) => line === 'a changed') &&
      flashedFirst.length > 0 &&
      flashedFirst.every((line) => line === 'b changed'),
    'the rows of the change the view went to are highlighted',
    `${flashedSecond.join()} | ${flashedFirst.join()}`,
  );
  await page.waitForFunction(
    () => !document.querySelector('.diff-line.flash-a, .diff-line.flash-b'),
  );
  check(true, 'the highlight of a change is removed after it faded out');

  // Two columns: the old version on the left, the new one on the right, and
  // both scroll up and down together.
  await page.getByRole('button', { name: 'Split' }).click();
  await page.locator('.diff-pane[data-column="new"]').waitFor();
  const oldPane = page.locator('.diff-pane[data-column="old"]');
  const newPane = page.locator('.diff-pane[data-column="new"]');
  check(
    (await oldPane.locator('.diff-line.removed').count()) === 2 &&
      (await oldPane.locator('.diff-line.added').count()) === 0 &&
      (await newPane.locator('.diff-line.added').count()) === 1 &&
      (await newPane.locator('.diff-line.removed').count()) === 0 &&
      (await newPane.locator('.diff-line.blank').count()) === 1,
    'two columns show the old version on the left and the new one on the right',
  );
  await oldPane.evaluate((element) => (element.scrollTop = 240));
  await page.waitForFunction(
    () =>
      document.querySelector('.diff-pane[data-column="new"]').scrollTop === 240,
  );
  check(true, 'the two columns scroll up and down together');
  check(
    await page.evaluate(() => {
      const layout = window.__mockSettings().layout;
      return layout.diffSplit === true && layout.diffWholeFile === true;
    }),
    'the layout of the diff view is kept in the settings',
  );
  await shot('12k-diff-split');
  await page.getByRole('button', { name: 'Single' }).click();
  await page.getByRole('button', { name: 'Changes only' }).click();
  await page.locator('.diff-fold').first().waitFor();

  // Older and Newer walk through the commits of the file.
  const older = page.getByRole('button', { name: 'Older change' });
  const newer = page.getByRole('button', { name: 'Newer change' });
  check(
    (await newer.isDisabled()) && !(await older.isDisabled()),
    'what is not committed is the newest change',
  );
  await older.click();
  await page.locator('.diff-what', { hasText: 'Add two prices' }).waitFor();
  await page.waitForFunction(
    () => !document.querySelector('.diff-panes.reading'),
  );
  check(
    (await shown()) === 'Add two prices' &&
      (await texts('added')) === 'const Extra = 1|const More = 2' &&
      (await lines('removed').count()) === 0 &&
      (await page.locator('.diff-what').innerText()).includes(
        'c300000 · Bo Reader · 2 days ago',
      ) &&
      (await picker.boundingBox()).width === pickerWidth,
    'Older shows the commit before, compared with the version before it',
    await page.locator('.diff-what').innerText(),
  );
  await older.click();
  await page.locator('.diff-what', { hasText: 'Raise the third' }).waitFor();
  await older.click();
  await page.locator('.diff-what', { hasText: 'Add the prices' }).waitFor();
  await page.waitForFunction(
    () => !document.querySelector('.diff-panes.reading'),
  );
  check(
    (await older.isDisabled()) &&
      (await page.locator('.diff-what').innerText()).includes(
        'created the file',
      ) &&
      (await lines('removed').count()) === 0 &&
      (await page.locator('.diff-counts').innerText()).replace(/\s+/g, ' ') ===
        '+62 −0',
    'the commit that created the file shows every line as added',
    await page.locator('.diff-counts').innerText(),
  );
  await newer.click();
  await page.locator('.diff-what', { hasText: 'Raise the third' }).waitFor();
  await page.waitForFunction(
    () => !document.querySelector('.diff-panes.reading'),
  );
  check(
    (await texts('removed')) === 'const Step3 = 3' &&
      (await texts('added')) === 'const Step3 = 300',
    'Newer shows the commit after',
    `${await texts('removed')} / ${await texts('added')}`,
  );

  // The list of changes.
  await picker.click();
  const entries = page.locator('.commit-row');
  await entries.first().waitFor();
  check(
    (await entries.locator('.commit-title').allTextContents()).join('|') ===
      'Uncommitted changes|Add two prices|Raise the third step|Add the prices' &&
      (await page.locator('.commit-row.on .commit-title').textContent()) ===
        'Raise the third step' &&
      (await entries.nth(0).locator('.commit-detail').textContent()) ===
        'Compared with the last commit',
    'the list has what is not committed first and then the commits, newest first',
    (await entries.locator('.commit-title').allTextContents()).join('|'),
  );
  await shot('12l-diff-list');
  await page.keyboard.press('Escape');
  check(
    (await entries.count()) === 0 &&
      (await page.locator('.diff').count()) === 1,
    'Escape closes the list of changes',
  );
  await picker.click();
  await entries.nth(1).click();
  await page.locator('.diff-what', { hasText: 'Add two prices' }).waitFor();
  check(
    (await entries.count()) === 0 && (await shown()) === 'Add two prices',
    'choosing an entry of the list shows that change',
    await shown(),
  );

  // The change on screen is the same one when the user comes back to the
  // file.
  await page.locator('.file-tab', { hasText: 'guide.md' }).click();
  await page.locator('.source-line').first().waitFor();
  check(
    (await page.locator('.commit-picker').count()) === 0,
    'the list of changes is in the toolbar only while changes are on screen',
  );
  await page.locator('.file-tab', { hasText: 'price.go' }).click();
  await page.locator('.diff-what', { hasText: 'Add two prices' }).waitFor();
  check(
    (await shown()) === 'Add two prices',
    'a file shows the change that was last on screen for it',
    await shown(),
  );

  // The menu of the tree opens the changes of a changed file and the
  // history of every other file.
  await changesButton.click();
  await page.locator('.source-line').first().waitFor();
  await row('price.go').click({ button: 'right' });
  const commands = async () =>
    (await page.locator('.menu-item').allTextContents()).map((label) =>
      label.trim(),
    );
  check(
    (await commands()).includes('Show changes') &&
      !(await commands()).includes('Show history'),
    'the menu of a changed file has a command that shows its changes',
    (await commands()).join('|'),
  );
  await page.keyboard.press('Escape');
  await row('guide.md').click({ button: 'right' });
  check(
    (await commands()).includes('Show history'),
    'the menu of an unchanged file has a command that shows its history',
    (await commands()).join('|'),
  );
  await page.locator('.menu-item', { hasText: 'Show history' }).click();
  await page.locator('.diff-what', { hasText: 'Add guide.md' }).waitFor();
  check(
    (await shown()) === 'Add guide.md' &&
      (await page.locator('.file-tab.on .name').textContent()) === 'guide.md',
    'a file without changes opens on its newest commit',
    await shown(),
  );
  await changesButton.click();
  await page.locator('.source-line').first().waitFor();

  // The card about the last change of a line opens that change.
  await page.locator('.source-line[data-line="3"] .source-num').click();
  await page.locator('.source-blame').waitFor();
  await page.locator('.source-blame').hover();
  await page.mouse.move(600, 300);
  await page.locator('.source-blame').hover();
  await page.locator('.blame-card').waitFor();
  await page.getByRole('button', { name: 'Show this change' }).click();
  await page.locator('.diff-what', { hasText: 'Add guide.md' }).waitFor();
  check(
    (await page.locator('.blame-card').count()) === 0 &&
      (await page.locator('.diff-what').innerText()).includes('9dbe511'),
    'the card about the last change of a line shows that change',
    await page.locator('.diff-what').innerText(),
  );
  await changesButton.click();
  await page.locator('.source-line').first().waitFor();
  await page.evaluate(() => {
    window.__mockGitStatus = [];
    window.dispatchEvent(new Event('focus'));
  });
  await page.waitForFunction(
    () => document.querySelectorAll('.row[data-git]').length === 0,
  );
}

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

// The text of an element with every run of white space as one space. The
// sentences of the interface are written over several lines in its source,
// and where a line breaks is not what a check is about.
const words = async (locator) =>
  (await locator.textContent()).replace(/\s+/g, ' ').trim();

// ---- asking about a visual, and notes on it
// The Ask tab of the inspector holds the discussion about the visual on
// screen. An answer names places in the code, which are links when they
// exist, and can put notes on parts of the visual. The page inside the frame
// draws a mark for each note.
{
  await page.keyboard.press(`${mod}+p`);
  await page.getByPlaceholder('Go to file…').fill('orders/handler.go');
  await page.locator('.quick-row').first().waitFor();
  await page.keyboard.press('Enter');
  await page.locator('.file-tab.on', { hasText: 'handler.go' }).waitFor();
  await showKind('Blueprint');
  // Earlier checks may have left the file without a blueprint, or the panel
  // on the right closed. Both are put right here.
  await page.locator('.main .canvas').first().waitFor();
  await page.waitForTimeout(300);
  if ((await page.locator('.main .canvas iframe').count()) === 0) {
    await page.locator('.empty .pick').first().click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Visualise', exact: true })
      .click();
    await page
      .locator('.dock .log', {
        hasText: 'Done. The visual passed every check.',
      })
      .waitFor({ timeout: 30000 });
    await page.locator('.main .canvas iframe').waitFor();
  }
  if ((await page.locator('.insp-edge.closed').count()) === 1)
    await page
      .locator('.titlebar')
      .getByRole('button', { name: 'Inspector' })
      .click();
  await page.locator('.insp-tabs').waitFor();
  const stage = page.frameLocator('.main .canvas iframe');
  await stage.locator('.cj-node').first().waitFor();

  // The two tab buttons stay at the top of the inspector while the About tab
  // scrolls below them. The window is made low, so that the About tab is
  // taller than the panel.
  {
    await page.setViewportSize({ width: 1600, height: 420 });
    const tabsTop = () =>
      page
        .locator('.insp-tabs')
        .evaluate((tabs) => tabs.getBoundingClientRect().top);
    const topBefore = await tabsTop();
    const scrolled = await page.locator('.insp-body').evaluate((body) => {
      body.scrollTop = body.scrollHeight;
      return body.scrollTop;
    });
    check(
      scrolled > 0 && (await tabsTop()) === topBefore,
      'the tab buttons of the inspector stay in place while the About tab scrolls',
      `scrolled ${scrolled}, top ${topBefore} -> ${await tabsTop()}`,
    );
    await page.setViewportSize({ width: 1600, height: 960 });
  }
  const askTab = page.locator('.insp-tabs .itab', { hasText: 'Ask' });
  const ask = page.locator('.inspector .ask');
  const question = ask.getByLabel('Question');
  const askButton = ask.getByRole('button', { name: 'Ask', exact: true });
  await askTab.click();
  check(
    /The agent that drew it answers/.test(await words(ask)) &&
      (await askButton.isDisabled()) &&
      (await page.locator('.inspector .feedback').count()) === 0,
    'the Ask tab starts with a hint and takes the place of the About tab',
  );

  await page.evaluate(() => (window.__mockAskDelay = 600));
  await question.fill('What does Submit do?');
  await askButton.click();
  await ask.locator('.ask-a.waiting').waitFor();
  check(
    /Mock Agent · continues the conversation/.test(
      await ask.locator('.ask-a.waiting .ask-who').textContent(),
    ) &&
      (await question.inputValue()) === '' &&
      (await askButton.isDisabled()),
    'a question that waits for its answer names the agent and empties the box',
  );
  await ask.locator('.ask-a:not(.waiting)').waitFor();
  await page.evaluate(() => (window.__mockAskDelay = 0));
  const asked = await page.evaluate(() => window.__mockLastAsk);
  check(
    asked.text === 'What does Submit do?' &&
      /^visual-/.test(asked.about.artifactId) &&
      asked.about.version >= 1 &&
      asked.path === 'internal/orders/handler.go' &&
      asked.scope == null,
    'a question about a visual says which visual and version is on screen',
    JSON.stringify(asked),
  );
  const answer = ask.locator('.ask-a').first();
  check(
    /queues the order/.test(await answer.textContent()) &&
      (await answer.locator('li').count()) === 2 &&
      (await answer.locator('button.ref').allTextContents()).join() ===
        'internal/orders/handler.go:20' &&
      (await answer.locator('code').allTextContents()).includes(
        'internal/orders/handler.go:9000',
      ),
    'an answer is shown with its list, and only a place that exists is a link',
    await answer.innerHTML(),
  );
  check(
    (await ask.locator('.ask-q .ask-who').textContent()).includes(
      'Mock User',
    ) &&
      /What does Submit do\?/.test(
        await ask.locator('.ask-title').textContent(),
      ),
    'a question is listed with the name of who asked, and names its discussion',
  );
  check(
    (await askTab.locator('.count').textContent()) === '1',
    'the Ask tab counts the discussions of the visual',
  );

  // The note of the answer.
  const note = ask.locator('.ask-note');
  check(
    (await note.count()) === 1 &&
      (await note.locator('.n').textContent()) === '1' &&
      (await note.locator('.where').textContent()) === 'Submit()' &&
      /is where the order comes in/.test(
        await note.locator('.t').textContent(),
      ),
    'a note of an answer is listed with its number, its part and its text',
    await note.first().textContent(),
  );
  await stage.locator('.cj-note').first().waitFor();
  check(
    (await stage.locator('.cj-note').count()) === 1 &&
      (await stage.locator('.cj-note').textContent()) === '1' &&
      !(await stage.locator('.cj-note-card').isVisible()),
    'the visual draws a numbered mark for the note without being built again',
  );
  await note.click();
  await stage.locator('.cj-note-card').waitFor({ state: 'visible' });
  check(
    /NOTE 1Submit\(\) is where the order comes in\./.test(
      await stage.locator('.cj-note-card').textContent(),
    ) && (await ask.locator('.ask-note.on').count()) === 1,
    'a click on a note in the answer opens its text on the visual',
  );
  await shot('16-ask-note');

  // A second question in the same discussion, which also flags a part.
  await question.fill('Is there a flag worth raising?');
  await question.press(`${mod}+Enter`);
  await ask.locator('.ask-note.flag').waitFor();
  const second = await page.evaluate(() => window.__mockLastAsk);
  check(
    !!second.threadId &&
      (await ask.locator('.ask-q').count()) === 2 &&
      (await ask.locator('.ask-note .n').allTextContents()).join() ===
        '1,2,3' &&
      (await stage.locator('.cj-note').count()) === 3 &&
      (await stage.locator('.cj-note.cj-flag').count()) === 1,
    'a second question goes into the same discussion, and its notes are numbered on',
    JSON.stringify(second),
  );

  // The notes can be switched off, here and on the About tab.
  const notesSwitch = ask.locator('.ask-notes .layer');
  check(
    /Notes on the blueprint · 3/.test(await words(notesSwitch)) &&
      (await notesSwitch.getAttribute('aria-checked')) === 'true' &&
      (await ask.locator('.ask-old').count()) === 0,
    'the discussion says how many notes the visual has',
    await notesSwitch.textContent(),
  );
  await notesSwitch.click();
  await stage.locator('.cj-note').first().waitFor({ state: 'hidden' });
  await page.locator('.insp-tabs .itab', { hasText: 'About' }).click();
  const layerSwitch = page.locator('.inspector .layer', { hasText: 'Notes' });
  check(
    (await layerSwitch.getAttribute('aria-checked')) === 'false' &&
      (await page.locator('.inspector .feedback').count()) === 1,
    'the About tab has the same switch among the layers, and is off too',
  );
  await layerSwitch.click();
  await stage.locator('.cj-note').first().waitFor({ state: 'visible' });
  check(true, 'switching the notes on shows the marks again');

  // A click on a mark of the visual opens the Ask tab.
  await stage.locator('.cj-note').nth(1).click();
  await ask.waitFor();
  check(
    (await ask.locator('.ask-note.on .n').textContent()) === '2',
    'a click on a mark on the visual shows the answer the note comes from',
  );

  // A question is sent with the part that is selected.
  await stage.locator('.cj-node').first().click({ force: true });
  await ask.locator('.ask-box .pill').waitFor();
  const selectedPart = await ask.locator('.ask-box .pill').textContent();
  await ask.getByRole('button', { name: 'New', exact: true }).click();
  check(
    (await ask.locator('.ask-q').count()) === 0 &&
      (await ask.locator('select[aria-label="Discussion"]').inputValue()) ===
        '',
    '"New" starts an empty discussion and keeps the earlier one in the list',
  );
  await question.fill('And this part?');
  await askButton.click();
  await ask.locator('.ask-a:not(.waiting)').waitFor();
  const third = await page.evaluate(() => window.__mockLastAsk);
  check(
    third.threadId == null &&
      !!third.about.part &&
      (await askTab.locator('.count').textContent()) === '2' &&
      (await ask.locator('select[aria-label="Discussion"] option').count()) ===
        2,
    'a question in a new discussion is sent with the selected part',
    `${selectedPart} ${JSON.stringify(third.about)}`,
  );

  // A question that fails keeps the text, and adds nothing.
  await question.fill('Please fail here');
  await askButton.click();
  await page.locator('.toast.error', { hasText: 'Not logged in' }).waitFor();
  check(
    (await question.inputValue()) === 'Please fail here' &&
      (await ask.locator('.ask-q').count()) === 1,
    'a question that fails is put back in the box and adds no message',
  );
  await question.fill('');

  // Deleting a discussion takes two clicks, and removes its notes.
  const marksBefore = await stage.locator('.cj-note').count();
  const deleteButton = ask.getByRole('button', { name: /^Delete/ });
  await deleteButton.click();
  check(
    (await deleteButton.textContent()) === 'Delete?' &&
      (await askTab.locator('.count').textContent()) === '2',
    'the first click on Delete only asks',
  );
  await deleteButton.click();
  await page.locator('.insp-tabs .itab .count', { hasText: '1' }).waitFor();
  await stage
    .locator('.cj-note')
    .nth(marksBefore - 1)
    .waitFor({ state: 'detached' });
  check(
    (await ask.locator('.ask-q').count()) === 2 &&
      (await stage.locator('.cj-note').count()) === 3,
    'the second click deletes the discussion with its notes, and the other one is shown',
    `${await stage.locator('.cj-note').count()} marks, ${marksBefore} before`,
  );

  // The feedback job that is started from a discussion names the
  // discussion, so that the agent knows what was said.
  await ask
    .getByRole('button', { name: 'Change the blueprint from this…' })
    .click();
  await page
    .locator('.dock .kicker', { hasText: 'Blueprint feedback · handler.go' })
    .waitFor();
  const applied = await page.evaluate(() => window.__mockLastRequest);
  check(
    applied.kind === 'feedback' &&
      !!applied.thread &&
      /what our discussion found/.test(applied.feedback.text) &&
      (await askButton.isDisabled()),
    'changing the visual from a discussion starts a feedback job that names the discussion',
    JSON.stringify(applied),
  );
  await page
    .locator('.dock .log', { hasText: 'Done. The visual passed every check.' })
    .waitFor({ timeout: 30000 });
  await page.locator('.insp-tabs').waitFor();
}

// ---- discussing and visualising selected code
// In the source view the user selects lines. A small bar offers to discuss
// them or to make a visual of them. Both open in the lower section of the
// panel on the right, whose upper section lists the references of a name.
{
  await page.locator('.tab.source-tab').click();
  const panel = page.locator('.inspector.source-panel');
  await panel.waitFor();
  check(
    (await panel.locator('.sp-section').count()) === 2 &&
      /Click a symbol/.test(await words(panel.locator('.symbol-empty'))) &&
      /Select code in the file to discuss it/.test(
        await words(panel.locator('.scope-list')),
      ) &&
      (await panel.locator('.sp-split').count()) === 1,
    'beside the code the panel has a section for references and one for discussions',
  );

  // Selects the lines `from` to `to` with the pointer, from the first
  // character of the first line to the end of the last.
  // The first line is brought near the top of the view before, so that the
  // pointer stays away from the lower edge, where a drag scrolls the code.
  const selectLines = async (from, to) => {
    await page
      .locator('.source')
      .evaluate((view, line) => (view.scrollTop = (line - 3) * 20), from);
    await page.waitForTimeout(100);
    const first = await page
      .locator(`.source-line[data-line="${from}"] .source-text`)
      .boundingBox();
    const lastLine = page.locator(`.source-line[data-line="${to}"]`);
    // The right end of a line that is in view. A line can be wider than the
    // view, and the pointer must stay over the code.
    const view = await page.locator('.source').boundingBox();
    const rightOf = (box) =>
      Math.min(box.x + box.width, view.x + view.width - 16);
    // A click in the empty room at the end of a line removes an earlier
    // selection. A press on selected text would drag that text and select
    // nothing new.
    await page.mouse.click(
      rightOf(await lastLine.boundingBox()) - 12,
      first.y + 10,
    );
    // The click shows the last change of the line it was on, which can make
    // every line wider or narrower. The last line is measured after that.
    await page.waitForTimeout(150);
    const last = await lastLine.boundingBox();
    await page.mouse.move(first.x + 1, first.y + 10);
    await page.mouse.down();
    await page.mouse.move(first.x + 60, first.y + 12, { steps: 3 });
    await page.mouse.move(rightOf(last) - 30, last.y + 10, { steps: 6 });
    await page.mouse.up();
  };
  const bar = page.locator('.select-bar');

  // A whole function is named by its name.
  await selectLines(20, 32);
  await bar.waitFor();
  check(
    (await bar.locator('.what').textContent()) === 'Handler.Submit' &&
      (await bar.locator('.seg').count()) === 0,
    'selecting a whole function offers to discuss the function by its name',
    await bar.textContent(),
  );
  // Lines inside it offer the lines or the function around them.
  await selectLines(21, 23);
  await bar.locator('.seg').waitFor();
  check(
    (await bar.locator('.seg button').allTextContents()).join('|') ===
      'lines 21–23|Handler.Submit' &&
      (await bar.locator('.seg button.on').textContent()) === 'lines 21–23',
    'selecting lines inside a function offers the lines or the whole function',
    await bar.textContent(),
  );
  await shot('17-select-bar');
  // A word that is selected, to copy it, brings no bar up.
  await page
    .locator('.source-line[data-line="27"] .source-text')
    .dblclick({ position: { x: 40, y: 10 } });
  await page.waitForTimeout(150);
  check((await bar.count()) === 0, 'a selected word brings no bar up');

  await selectLines(21, 23);
  await bar.getByRole('button', { name: 'Discuss' }).click();
  const scopeSection = panel.locator('.sp-section', {
    has: page.locator('.sp-body.scope'),
  });
  const ask = scopeSection.locator('.ask');
  await ask.waitFor();
  check(
    (await scopeSection.locator('.sp-what').textContent()) === 'lines 21–23' &&
      (await bar.count()) === 0 &&
      (await ask
        .getByLabel('Question')
        .evaluate((el) => el === document.activeElement)) &&
      (await page.locator('.source-line.in-scope').count()) === 3 &&
      /Lines 21–23/.test(await words(scopeSection.locator('.scope-where'))),
    'Discuss opens the lines in the panel, tints them, and is ready for a question',
  );
  await ask.getByLabel('Question').fill('Why is the order checked first?');
  await ask.getByRole('button', { name: 'Ask', exact: true }).click();
  await ask.locator('.ask-a:not(.waiting)').waitFor();
  const asked = await page.evaluate(() => window.__mockLastAsk);
  const mark = page.locator('.source-line[data-line="21"] .scope-mark');
  await mark.waitFor();
  check(
    asked.scope?.id === 'l21_23' &&
      asked.about.artifactId == null &&
      /Lines 21 to 23 queues/.test(await ask.locator('.ask-a').textContent()) &&
      (await ask.locator('.ask-note').count()) === 0 &&
      (await page.locator('.scope-mark').count()) === 1 &&
      !(await mark.evaluate((el) => el.classList.contains('visual'))) &&
      (await mark.getAttribute('data-tip')) === 'lines 21–23 · discussion',
    'a question about selected code is about those lines, and the lines get a mark',
    JSON.stringify(asked),
  );

  // A click on a name fills the upper section and leaves the lower one.
  const flushName = await page
    .locator('.source-line[data-line="29"] .source-text')
    .evaluate((el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.data.indexOf('Flush');
        if (at < 0) continue;
        const range = new Range();
        range.setStart(node, at);
        range.setEnd(node, at + 5);
        const box = range.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      }
      return null;
    });
  await page.mouse.click(flushName.x, flushName.y);
  await panel.locator('.symbol-panel h3', { hasText: 'Flush' }).waitFor();
  check(
    (await ask.locator('.ask-q').count()) === 1 &&
      (await scopeSection.locator('.sp-what').textContent()) ===
        'lines 21–23' &&
      (await panel.locator('.sp-head .sp-what').allTextContents()).join('|') ===
        'Flush|lines 21–23',
    'the references of a clicked name are shown above the discussion, which stays',
  );
  await shot('18-source-panel');

  // The line between the two sections can be dragged, and they can be
  // swapped.
  const split = await panel.locator('.sp-split .splitter').boundingBox();
  const refsBefore = (await panel.locator('.sp-section').first().boundingBox())
    .height;
  await page.mouse.move(split.x + 100, split.y + 3);
  await page.mouse.down();
  await page.mouse.move(split.x + 100, split.y + 123, { steps: 4 });
  await page.mouse.up();
  const refsAfter = (await panel.locator('.sp-section').first().boundingBox())
    .height;
  check(
    Math.abs(refsAfter - refsBefore - 120) < 4,
    'dragging the line between the two sections gives the upper one more room',
    `${refsBefore} -> ${refsAfter}`,
  );
  await panel.getByRole('button', { name: 'Swap the two sections' }).click();
  check(
    (await panel.locator('.sp-head .sp-what').allTextContents()).join('|') ===
      'lines 21–23|Flush',
    'the two sections can be swapped',
  );
  await panel.getByRole('button', { name: 'Swap the two sections' }).click();
  await page.waitForFunction(
    () => window.__mockSettings().layout.sourceSplit > 40,
  );
  check(
    (await page.evaluate(
      () => window.__mockSettings().layout.sourceSwapped,
    )) === false,
    'the share of the two sections is kept with the layout',
  );

  // A visual of the selected lines. The mock records the runtime the test
  // names, so that this visual looks as if an older app had built it.
  await page.evaluate(() => (window.__mockRuntime = '1.4.0'));
  await scopeSection.locator('.scope-kinds .chip.make').click();
  await menuCommand('Blueprint').click();
  await page
    .getByRole('dialog')
    .getByText('Visualise lines 21–23 in handler.go')
    .waitFor();
  check(
    /draws how the selected code works/.test(
      await words(page.locator('.dialog .lead')),
    ),
    'the dialog for a visual of selected code names the lines and says what is drawn',
  );
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Visualise', exact: true })
    .click();
  await page
    .locator('.dock .kicker', {
      hasText: 'Visualise · handler.go › lines 21–23',
    })
    .waitFor();
  const request = await page.evaluate(() => window.__mockLastRequest);
  check(
    request.scope?.id === 'l21_23' &&
      /^t-mock-/.test(request.thread ?? '') &&
      request.subject.join() === 'internal/orders/handler.go',
    'the job is for those lines of the file and names the discussion about them',
    JSON.stringify(request),
  );
  await page
    .locator('.dock .log', { hasText: 'Done. The visual passed every check.' })
    .waitFor({ timeout: 30000 });
  await page.evaluate(() => (window.__mockRuntime = undefined));
  const chip = scopeSection.locator('.scope-kinds .chip.on');
  await chip.waitFor();
  const scoped = page.frameLocator('.scope-frame iframe');
  await scoped.locator('.cj-node').first().waitFor();
  check(
    (await chip.textContent()).trim() === 'Blueprint · v1' &&
      (await page.locator('.main .canvas iframe').count()) === 0 &&
      (await mark.evaluate((el) => el.classList.contains('visual'))) &&
      (await mark.getAttribute('data-tip')) ===
        'lines 21–23 · discussion · Blueprint',
    'the visual of the lines is shown in the panel beside the code, and the mark says so',
  );
  const libraryItem = page.locator('.lib-item', {
    has: page.locator('.lib-part'),
  });
  check(
    (await libraryItem.count()) === 1 &&
      (await libraryItem.locator('.lib-part').textContent()) ===
        'handler.go › lines 21–23' &&
      (await libraryItem.locator('.lib-tick').count()) === 0,
    'the library names the file and the lines of such a visual',
  );
  await shot('19-scoped-visual');

  // The blueprint of the whole file is still the one on the Blueprint tab.
  await showKind('Blueprint');
  await page.locator('.insp-tabs').waitFor();
  check(
    !/lines 21–23/.test(await page.locator('.toolbar .crumb').textContent()) &&
      (await page.locator('.toolbar .select option').count()) >= 2,
    'the Blueprint tab of the file still shows the blueprint of the whole file',
  );
  await page.locator('.tab.source-tab').click();
  await scoped.locator('.cj-node').first().waitFor();

  // A question with the visual on screen puts a note on it. The visual was
  // built by an older runtime, so the panel offers to build it again.
  await ask.getByLabel('Question').fill('Show me where it starts');
  await ask.getByRole('button', { name: 'Ask', exact: true }).click();
  await ask.locator('.ask-note').waitFor();
  const old = ask.locator('.ask-old');
  await old.waitFor();
  check(
    /built before notes could be drawn on it/.test(await words(old)),
    'a visual built before notes existed offers to be built again',
  );
  await old.getByRole('button', { name: 'Update it' }).click();
  await scopeSection
    .locator('.scope-kinds .chip.on', { hasText: 'Blueprint · v2' })
    .waitFor();
  await page.locator('.toast', { hasText: 'version 2' }).waitFor();
  await scoped.locator('.cj-note').first().waitFor();
  check(
    (await ask.locator('.ask-old').count()) === 0 &&
      (await scoped.locator('.cj-note').count()) === 1,
    'building it again makes a new version that shows the note',
  );

  // The panel beside the code can be much wider than the inspector.
  const edge = await page.locator('.insp-edge .splitter').boundingBox();
  await page.mouse.move(edge.x + 3, edge.y + 200);
  await page.mouse.down();
  await page.mouse.move(edge.x - 500, edge.y + 200, { steps: 5 });
  await page.mouse.up();
  const wide = (await panel.boundingBox()).width;
  check(
    wide > 800 && (await page.locator('.source').boundingBox()).width >= 150,
    'the panel beside the code can be dragged far wider than the inspector',
    `${wide}`,
  );
  await shot('20-scoped-visual-wide');

  // Maximise shows the visual in place of the code, as a file's visual is
  // shown, and "Back to the code" returns.
  await panel.getByRole('button', { name: 'Maximise the visual' }).click();
  await page.locator('.toolbar .back-to-code').waitFor();
  await page.locator('.main .canvas iframe').waitFor();
  const inspectorWidth = (await page.locator('.inspector').boundingBox()).width;
  check(
    /handler\.go › lines 21–23/.test(
      await page.locator('.toolbar .crumb').textContent(),
    ) &&
      (await page.locator('.source').count()) === 0 &&
      (await page.locator('.inspector.source-panel').count()) === 0 &&
      inspectorWidth <= 560 &&
      (await page.locator('.toolbar .select option').count()) === 2 &&
      (await page.locator('.insp-tabs .itab .count').textContent()) === '1',
    'maximise shows the visual with its controls and its inspector in place of the code',
    `${inspectorWidth}`,
  );
  await shot('21-scoped-visual-maximised');
  await page.locator('.toolbar .back-to-code').click();
  await panel.waitFor();
  check(
    (await page.locator('.source').count()) === 1 &&
      Math.abs((await panel.boundingBox()).width - wide) < 2 &&
      (await scopeSection.locator('.scope-kinds .chip.on').count()) === 1,
    '"Back to the code" shows the code again with the visual beside it',
  );

  // Closing the open code lists what the file has, and the mark opens it
  // again.
  await panel.getByRole('button', { name: 'Close the discussion' }).click();
  const listed = panel.locator('.scope-list .scope-row');
  check(
    (await listed.count()) === 1 &&
      /lines 21–23/.test(await words(listed)) &&
      /1 discussion · blueprint/.test(await words(listed)) &&
      (await page.locator('.source-line.in-scope').count()) === 0,
    'with nothing open, the panel lists the code that has a discussion or a visual',
    await listed.first().textContent(),
  );
  await mark.click();
  await scopeSection.locator('.scope-kinds .chip.on').waitFor();
  check(
    (await page.locator('.source-line.in-scope').count()) === 3 &&
      (await ask.locator('.ask-q').count()) === 2,
    'a click on the mark in front of the code opens its discussion and visual again',
  );

  // The library opens such a visual beside its code too.
  await showKind('Blueprint');
  await page.locator('.insp-tabs').waitFor();
  await libraryItem.click();
  await panel.waitFor();
  await scopeSection.locator('.scope-kinds .chip.on').waitFor();
  check(
    (await page.locator('.source-line.ref').getAttribute('data-line')) === '21',
    'the library opens a visual of selected code beside that code',
  );
  // Leave the panel at a usual width for whatever runs after this.
  const wideEdge = await page.locator('.insp-edge .splitter').boundingBox();
  await page.mouse.move(wideEdge.x + 3, wideEdge.y + 200);
  await page.mouse.down();
  await page.mouse.move(wideEdge.x + 480, wideEdge.y + 200, { steps: 5 });
  await page.mouse.up();
}

// ---- the app starts with the folder that was open when it last stopped
// The stand-in backend names that folder when the test has put its path in
// the session storage. The page is loaded again, which is a new start of the
// app. Without the path, the app starts on the welcome screen.
{
  await page.evaluate(() =>
    sessionStorage.setItem('mockLastWorkspace', '/mock/shop'),
  );
  await page.reload();
  await row('go.mod').waitFor();
  check(
    (await page.locator('.welcome').count()) === 0 &&
      (await page.locator('.titlebar').innerText()).includes('shop'),
    'the app opens the folder that was open when it last stopped',
  );
  await page.evaluate(() => sessionStorage.removeItem('mockLastWorkspace'));
  await page.reload();
  await page.getByRole('button', { name: 'Open folder…' }).waitFor();
  check(
    (await page.locator('.tree .row').count()) === 0,
    'the app starts on the welcome screen when no folder was open',
  );
}

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
