// Lists what the parts of the runtime could not draw, as the agents recorded
// it. The list shows which new part is worth drawing next.
//
// Usage: node scripts/stand-ins.mjs <workspace folder> [more folders ...]
//
// When no part of the runtime fits a thing in the code, an agent draws the
// thing with the nearest part and adds an entry to the `standIns` list of its
// analysis, `model.json`. An entry holds three texts:
//   - `what`: the thing in the code.
//   - `drawnAs`: the part it was drawn with.
//   - `missing`: what a fitting part would have to show.
//
// For every workspace named, this script reads the analysis of the current
// version of every artifact in its `.codjiva` folder. It prints the entries
// grouped by `drawnAs`, with the group that has the most entries first. A
// part that stands in for many different things is where a new part is
// missing.
//
// It also prints how often each nature appears in the `things` lists of the
// same analyses. A nature that is never used points at a form of packet that
// agents do not need.
//
// The script only reads. It never changes a workspace.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Reads a JSON file. Returns null when the file is missing or is not JSON,
// so that one damaged artifact does not stop the count.
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

// The analysis of the current version of every artifact of a workspace, as
// objects with the artifact's `title` and its `model`.
const analysesOf = (workspace) => {
  const artifacts = path.join(workspace, '.codjiva', 'artifacts');
  if (!existsSync(artifacts)) return [];
  const found = [];
  for (const id of readdirSync(artifacts).sort()) {
    const dir = path.join(artifacts, id);
    const artifact = readJson(path.join(dir, 'artifact.json'));
    if (!artifact || !artifact.currentVersion) continue;
    const model = readJson(
      path.join(dir, 'v' + artifact.currentVersion, 'model.json'),
    );
    if (model) found.push({ title: artifact.title || id, model });
  }
  return found;
};

const workspaces = process.argv.slice(2);
if (!workspaces.length) {
  console.error(
    'Usage: node scripts/stand-ins.mjs <workspace folder> [more folders ...]',
  );
  process.exit(2);
}

// The stand-ins by the part that was used, and the number of things by their
// nature.
const byPart = new Map();
const natures = new Map();
let artifacts = 0;
for (const workspace of workspaces) {
  for (const { title, model } of analysesOf(path.resolve(workspace))) {
    artifacts++;
    for (const entry of model.standIns || []) {
      const part = String(entry.drawnAs || '?').trim();
      if (!byPart.has(part)) byPart.set(part, []);
      byPart.get(part).push({ title, ...entry });
    }
    for (const thing of model.things || [])
      natures.set(thing.nature, (natures.get(thing.nature) || 0) + 1);
  }
}

console.log(
  `${artifacts} artifact(s) read from ${workspaces.length} workspace(s).`,
);

const groups = [...byPart.entries()].sort(
  (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
);
if (!groups.length) console.log('\nNo stand-ins are recorded.');
for (const [part, entries] of groups) {
  console.log(`\n${part}: stood in ${entries.length} time(s)`);
  for (const entry of entries) {
    console.log(`  - ${entry.what}`);
    console.log(`    missing: ${entry.missing}`);
    console.log(`    in: ${entry.title}`);
  }
}

if (natures.size) {
  console.log('\nThings by nature:');
  for (const [nature, count] of [...natures.entries()].sort(
    (a, b) => b[1] - a[1],
  ))
    console.log(`  ${String(count).padStart(3)}  ${nature}`);
}
