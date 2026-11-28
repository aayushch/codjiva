// Writes latest.json for a release on GitHub and attaches it to the release.
//
// Usage: node scripts/updater-json.mjs <tag> [--print]
//
// `<tag>` is the tag of the release, such as v3.1.0. With `--print` the file
// is printed and the release is left as it is.
//
// latest.json is the file the updater of an installed app reads to find out
// whether there is a newer version. For every platform it holds the address
// of the file the updater installs and the signature of that file.
//
// The release workflow runs this once, in a job of its own, after the
// installers of every platform are attached to the release. The build jobs
// do not write latest.json, because they run at the same time and each of
// them would have to read, change and upload the one file.
//
// The script reads everything from the release: the names of the attached
// files, the text of the `.sig` file beside each installer, and the text of
// the release, which becomes the `notes` of latest.json. It stops with an
// error, and attaches nothing, when the file of a platform or its `.sig`
// file is not attached.
//
// It needs the `gh` program, signed in. In a workflow, `gh` signs in with
// the token in the environment variable GH_TOKEN.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const print = args.includes('--print');
const tag = args.find((arg) => !arg.startsWith('--'));
if (!tag) {
  console.error('usage: node scripts/updater-json.mjs <tag> [--print]');
  process.exit(1);
}
// The version of the app in the release: the tag without its leading "v".
const version = tag.replace(/^v/, '');

// The name of the app, which the names of the installers start with.
const app = JSON.parse(
  readFileSync(path.join(root, 'ui/src-tauri/tauri.conf.json'), 'utf8'),
).productName;

// The file the updater installs on each platform. A key is the name the
// updater asks for: the operating system and the processor, and for some
// keys the kind of installer as well. The updater of an app that was
// installed from a .deb package asks for `linux-x86_64-deb`, and falls back
// to `linux-x86_64` when that key is missing.
const FILES = {
  'darwin-aarch64': `${app}_aarch64.app.tar.gz`,
  'darwin-aarch64-app': `${app}_aarch64.app.tar.gz`,
  'darwin-x86_64': `${app}_x64.app.tar.gz`,
  'darwin-x86_64-app': `${app}_x64.app.tar.gz`,
  'linux-x86_64': `${app}_${version}_amd64.AppImage`,
  'linux-x86_64-appimage': `${app}_${version}_amd64.AppImage`,
  'linux-x86_64-deb': `${app}_${version}_amd64.deb`,
  'linux-x86_64-rpm': `${app}-${version}-1.x86_64.rpm`,
  'windows-x86_64': `${app}_${version}_x64_en-US.msi`,
  'windows-x86_64-msi': `${app}_${version}_x64_en-US.msi`,
  'windows-x86_64-nsis': `${app}_${version}_x64-setup.exe`,
};

// Runs `gh` with the given arguments and returns what it prints.
const gh = (...parts) =>
  execFileSync('gh', parts, { cwd: root, encoding: 'utf8' });

// The repository as "owner/name". A workflow has it in GITHUB_REPOSITORY.
const repository =
  process.env.GITHUB_REPOSITORY ||
  gh(
    'repo',
    'view',
    '--json',
    'nameWithOwner',
    '--jq',
    '.nameWithOwner',
  ).trim();

const release = JSON.parse(gh('release', 'view', tag, '--json', 'assets,body'));
const attached = new Set(release.assets.map((asset) => asset.name));

const wanted = [...new Set(Object.values(FILES))];
const missing = wanted
  .flatMap((name) => [name, `${name}.sig`])
  .filter((name) => !attached.has(name));
if (missing.length) {
  console.error(
    `The release ${tag} lacks ${missing.length} file(s), so latest.json ` +
      `is not written:\n  ${missing.join('\n  ')}`,
  );
  process.exit(1);
}

// The signature of each file is the text of the `.sig` file beside it.
const folder = mkdtempSync(path.join(tmpdir(), 'updater-json-'));
try {
  gh('release', 'download', tag, '--pattern', '*.sig', '--dir', folder);
  const platforms = {};
  for (const [key, name] of Object.entries(FILES)) {
    platforms[key] = {
      signature: readFileSync(path.join(folder, `${name}.sig`), 'utf8'),
      // The address the file has once the release is published. Until then
      // GitHub serves the files of a draft from another address, which stops
      // working when the draft is published.
      url:
        `https://github.com/${repository}/releases/download/` +
        `${encodeURIComponent(tag)}/${name}`,
    };
  }
  const text = JSON.stringify(
    {
      version,
      notes: release.body ?? '',
      pub_date: new Date().toISOString(),
      platforms,
    },
    null,
    2,
  );
  if (print) console.log(text);
  else {
    const file = path.join(folder, 'latest.json');
    writeFileSync(file, text);
    // `--clobber` replaces a latest.json that is already attached, which is
    // the case when the job is run again.
    gh('release', 'upload', tag, file, '--clobber');
    console.log(
      `Attached latest.json to ${tag} with ${Object.keys(platforms).length} ` +
        'platform keys.',
    );
  }
} finally {
  rmSync(folder, { recursive: true, force: true });
}
