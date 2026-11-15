// Loads runtime source files into an isolated context for tests that run in
// Node, without a browser. Only the files that do not touch the page (kit,
// geometry, warp, camera maths) can be loaded this way.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const SRC = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
);

// Evaluates the named runtime files in order and returns the values of `names`,
// which may be top-level constants of those files. `CJ` is always available
// under that name.
export function loadRuntime(files, names) {
  const code = files
    .map((f) => readFileSync(path.join(SRC, f), 'utf8'))
    .join('\n');
  const body = `(function () { 'use strict';\n${code}\nreturn { ${['CJ', ...names].join(', ')} }; })()`;
  return vm.runInNewContext(body, {
    window: {},
    Math,
    Number,
    String,
    Object,
    Array,
    console,
  });
}
