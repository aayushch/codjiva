// Shared helpers for the browser-based runtime tests.
import { execFileSync } from 'node:child_process';
import { mkdirSync, cpSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.join(here, '..', '..');
export const out = path.join(here, 'out');
export const referenceFilm = path.join(root, 'runtime/reference/film');
export const referenceVisual = path.join(root, 'runtime/reference/visual');

// Builds an artifact source folder into out/<name>.html and returns that path. Throws with the
// builder's diagnostics when the build fails.
export function build(srcDir, name) {
  mkdirSync(out, { recursive: true });
  const file = path.join(out, name + '.html');
  execFileSync('cargo', ['run', '-q', '-p', 'codjiva-build', '--', srcDir, file], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
  return file;
}

// Runs the builder and returns { ok, stderr } without throwing, for tests that expect a failure.
export function tryBuild(srcDir, name) {
  try { build(srcDir, name); return { ok: true, stderr: '' }; } catch (e) { return { ok: false, stderr: String(e.stderr || e) }; }
}

// Copies a source folder to out/src-<name> so a test can change files in the copy.
export function copySources(srcDir, name) {
  const dir = path.join(out, 'src-' + name);
  rmSync(dir, { recursive: true, force: true });
  cpSync(srcDir, dir, { recursive: true });
  return dir;
}

// Opens a built artifact in a new page, embedded-style (no control bar) at exactly stage size,
// and waits until the runtime is ready. Returns the page and the errors it logged.
export async function openArtifact(browser, file, query = '?embed=1') {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(pathToFileURL(file).href + query);
  await page.waitForFunction(() => document.body.classList.contains('ready') && !!window.__cj, null, { timeout: 30000 });
  return { page, errors, context };
}

export const runSelfTest = (page) => page.evaluate(() => window.__cj.selfTest({}));
