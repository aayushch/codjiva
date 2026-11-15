// Checks that no line of source code is wider than 80 columns.
//
// Usage: node scripts/line-width.mjs [file ...]
//
// Without arguments it checks every Rust, JavaScript, TypeScript, Svelte and
// CSS file that git knows about, except the folders in IGNORED. It prints
// each line that is too wide and exits with 1 if there is one.
//
// Prettier and rustfmt already keep code within 80 columns where they can.
// This check finds what they leave alone, which is mostly comments.
//
// A line that is too wide is accepted in these cases, because nothing can
// shorten it without changing what it says:
//   - The line holds a string, and it would fit without the text of its
//     longest string. A message for the user or a selector in a test is such
//     a string.
//   - The line is inside a string that runs over several lines.
//   - The line holds a web address.
//   - The line is in a comment block that starts with `/*@api`. Those blocks
//     are Markdown that agents read, with tables that cannot be wrapped.
//   - The line is a comment made of one word that has no space to break at.
//   - The line holds a name of more than 50 letters, such as the name of a
//     test that says in full what the test shows.
//   - The line is in the markup of a Svelte file, outside its script and
//     its styles. Prettier breaks markup only where a line break does not
//     change what the page shows, so its result is taken as it is.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { filesToCheck, kindOf, root, scan } from './source-lines.mjs';

const LIMIT = 80;

// The lines of a file that are too wide and are not accepted, as objects with
// the line number and the text.
function tooWide(file) {
  const text = readFileSync(file, 'utf8');
  const facts = scan(text, kindOf(file));
  const found = [];
  // In a Svelte file, whether the line is inside the script or the styles.
  const svelte = file.endsWith('.svelte');
  let inCode = !svelte;
  text.split('\n').forEach((raw, index) => {
    if (svelte && /^<(script|style)[\s>]/.test(raw)) inCode = true;
    if (svelte && /^<\/(script|style)>/.test(raw)) inCode = false;
    const width = [...raw].length;
    if (width <= LIMIT || !inCode) return;
    if (/[A-Za-z0-9_]{51,}/.test(raw)) return;
    const fact = facts[index];
    if (fact.api || /https?:\/\//.test(raw)) return;
    if (fact.inString && width - fact.longest <= LIMIT) return;
    if (fact.comment && !/\S\s+\S+\s+\S/.test(raw.trim())) return;
    found.push({ line: index + 1, text: raw });
  });
  return found;
}

let count = 0;
for (const file of filesToCheck(process.argv.slice(2))) {
  for (const { line, text } of tooWide(file)) {
    count++;
    const where = path.relative(root, file);
    console.log(`${where}:${line}: ${[...text].length} columns`);
  }
}
if (count) {
  console.log(`${count} line(s) are wider than ${LIMIT} columns.`);
  process.exit(1);
}
console.log(`No line is wider than ${LIMIT} columns.`);
