// What the scripts that check and wrap source lines share: the list of files
// they work on, and a scanner that tells code, strings and comments apart.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
// Test data and the example film that agents read are kept as they were
// written, so they are not checked.
const IGNORED = ['fixtures/', 'runtime/reference/'];
// How the files of each kind write strings and comments, by file ending.
const KINDS = {
  '.rs': 'rust',
  '.js': 'js',
  '.mjs': 'js',
  '.ts': 'js',
  '.svelte': 'js',
  '.css': 'css',
};

// The files to work on: the ones in `named`, or, if `named` is empty, every
// file of a checked kind that git tracks or would track.
export function filesToCheck(named) {
  if (named.length) return named.map((file) => path.resolve(file));
  const listed = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8' },
  );
  return listed
    .split('\n')
    .filter((file) => KINDS[path.extname(file)])
    .filter((file) => !IGNORED.some((folder) => file.startsWith(folder)))
    .map((file) => path.join(root, file));
}

// Reads a file one character at a time and reports, for each line, what the
// line holds besides code.
//
// The result has one entry per line:
//   - `inString` is true if any part of the line is inside a string.
//   - `longest` is the number of characters of the longest piece of string
//     text on the line, without its quotes.
//   - `comment` is true if any part of the line is a comment.
//   - `api` is true if the line is inside a `/*@api` comment block.
//
// `kind` is 'rust', 'js' or 'css'. The three differ in how strings are
// written. In Rust a single quote starts a character or a lifetime, not a
// string, and `r#"` starts a string that ends at `"#`. In JavaScript a
// backtick starts a string that can run over several lines.
export function scan(text, kind) {
  const lines = [];
  // What the scanner is inside: 'code', 'line' for a line comment, 'block'
  // for a block comment, or the text that closes the string it is in.
  let state = 'code';
  let api = false;
  // How many characters of string text have been read since the string
  // began or the line began, whichever came last.
  let run = 0;
  let line = { inString: false, longest: 0, comment: false, api: false };
  const endRun = () => {
    line.longest = Math.max(line.longest, run);
    run = 0;
  };
  const endLine = () => {
    endRun();
    // A line comment ends with its line. So does a string in single or double
    // quotes in JavaScript and CSS, where such a string cannot hold a line
    // break. Without this, a quote character in the text of a Svelte page
    // would turn the rest of the file into a string.
    if (state === 'line') state = 'code';
    if (kind !== 'rust' && (state === "'" || state === '"')) state = 'code';
    lines.push(line);
    line = {
      inString: state !== 'code' && state !== 'block',
      longest: 0,
      comment: state === 'block',
      api: state === 'block' && api,
    };
  };
  const at = (word, index) => text.startsWith(word, index);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') {
      endLine();
    } else if (state === 'line') {
      continue;
    } else if (state === 'block') {
      const closing = at('*/', i)
        ? '*/'
        : kind === 'js' && at('-->', i) && '-->';
      if (!closing) continue;
      i += closing.length - 1;
      state = 'code';
      api = false;
    } else if (state !== 'code') {
      // Inside a string. A backslash in an ordinary string hides the
      // character after it, so an escaped quote does not end the string.
      if (ch === '\\' && state.length === 1 && text[i + 1] !== '\n') {
        run += 2;
        i++;
      } else if (at(state, i)) {
        endRun();
        i += state.length - 1;
        state = 'code';
      } else {
        run++;
      }
    } else if (kind !== 'css' && at('//', i)) {
      state = 'line';
      line.comment = true;
    } else if (at('/*', i) || (kind === 'js' && at('<!--', i))) {
      state = 'block';
      api = at('/*@api', i);
      line.comment = true;
      line.api = api;
    } else if (kind === 'rust' && /^r#*"/.test(text.slice(i, i + 12))) {
      const hashes = text.slice(i + 1).match(/^#*/)[0];
      state = '"' + hashes;
      line.inString = true;
      i += hashes.length + 1;
    } else if (kind === 'rust' && ch === "'") {
      // A character such as 'a' or '\n' is skipped as a whole. A lifetime
      // such as 'static has no closing quote and is plain code.
      const literal = text.slice(i, i + 12).match(/^'(\\[^']+|[^'\\])'/);
      if (literal) i += literal[0].length - 1;
    } else if (
      ch === '"' ||
      (kind !== 'rust' && ch === "'") ||
      (kind === 'js' && ch === '`')
    ) {
      state = ch;
      line.inString = true;
    }
  }
  endLine();
  return lines;
}

// The kind of a file, for `scan`: 'rust', 'js' or 'css'.
export const kindOf = (file) => KINDS[path.extname(file)];
