// Wraps comments that are wider than 80 columns. Prettier and rustfmt format
// code but leave the text of comments alone, so this script does that part.
//
// Usage: node scripts/wrap-comments.mjs [file ...]
//
// Without arguments it works on the same files as scripts/line-width.mjs.
//
// It changes only a paragraph of a comment that has a line wider than 80
// columns, and it changes that paragraph by moving words between its lines.
// Every other line of the file stays as it is.
//
// Two forms of comment are wrapped:
//   - A run of lines that each start with `//`, `///` or `//!`.
//   - A comment between `/*` and `*/`, or between `<!--` and `-->`, that
//     starts at the beginning of a line and ends at the end of one.
//
// Within a comment, a paragraph is a run of lines with the same indentation.
// A line that starts with `- `, `* ` or a number is a list item, and the more
// indented lines under it belong to it.
//
// These lines are never changed, because their line breaks carry meaning:
//   - a line inside a ``` block, and a line indented like a code sample
//   - a line of a table, a Markdown heading, or text lined up in columns
//   - a line that gives an instruction to a tool, such as `eslint-disable`
//   - a comment block that starts with `/*@api`
//   - a comment that follows code on the same line
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { filesToCheck, kindOf, root, scan } from './source-lines.mjs';

const LIMIT = 80;
const widthOf = (text) => [...text].length;

// Breaks `words` into lines of at most `width` columns. A word that is wider
// than `width` gets a line of its own.
function fill(words, width) {
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line && widthOf(line) + 1 + widthOf(word) > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// True for a line of comment text that must stay as it is. `body` is the
// text without the spaces before it.
function isFixed(body) {
  return (
    /^[|#]/.test(body) ||
    /\S {2,}\S/.test(body) ||
    /^(eslint-|prettier-|svelte-ignore|@ts-|cspell:|SAFETY:)/.test(body)
  );
}

// Wraps the text of one comment. `texts` holds the comment's lines without
// the comment marker, and `room` is the number of columns each of them may
// take. Returns the new lines.
//
// The text is split into paragraphs. A paragraph with a line wider than
// `room` is filled again from its words. Its first line keeps its
// indentation and its list marker, and the lines after it are indented to
// where the text of the first line starts.
function wrapTexts(texts, room) {
  const out = [];
  // The paragraph being collected: `lead` is the indentation of its first
  // line, `marker` its list marker, `hang` the indentation of its other
  // lines, `words` its text and `raw` its lines as they are in the file.
  let para = null;
  let fenced = false;
  const flush = () => {
    if (!para) return;
    if (para.raw.some((line) => widthOf(line) > room)) {
      const words = para.words.join(' ').split(/\s+/).filter(Boolean);
      const lines = fill(words, room - para.hang);
      lines.forEach((line, index) => {
        const start = index ? ' '.repeat(para.hang) : para.first;
        out.push(start + line);
      });
    } else {
      out.push(...para.raw);
    }
    para = null;
  };
  for (const text of texts) {
    const raw = text.trimEnd();
    const body = raw.trimStart();
    const lead = raw.length - body.length;
    const continues = para && lead === para.hang;
    if (body.startsWith('```')) {
      flush();
      fenced = !fenced;
      out.push(raw);
    } else if (fenced || !body || isFixed(body) || (!continues && lead > 4)) {
      flush();
      out.push(raw);
    } else {
      const marker = body.match(/^([-*•]|\d+[.)])\s+/)?.[0] ?? '';
      if (marker || !continues) {
        flush();
        para = {
          first: ' '.repeat(lead) + marker,
          hang: lead + marker.length,
          words: [body.slice(marker.length)],
          raw: [raw],
        };
      } else {
        para.words.push(body);
        para.raw.push(raw);
      }
    }
  }
  flush();
  return out;
}

// Wraps the comments of one file and returns the new text of the file.
function wrapFile(text, kind) {
  const facts = scan(text, kind);
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length;) {
    const fact = facts[i];
    const line = lines[i];
    // A run of line comments with the same indentation and the same marker.
    const marked = kind !== 'css' && line.match(/^(\s*)(\/\/[/!]?)(?!\/)(.*)$/);
    if (marked && !fact.inString && !fact.api) {
      const [, indent, marker] = marked;
      const texts = [];
      for (; i < lines.length; i++) {
        const next = lines[i].match(/^(\s*)(\/\/[/!]?)(?!\/)(.*)$/);
        if (!next || next[1] !== indent || next[2] !== marker) break;
        if (facts[i].inString) break;
        texts.push(next[3]);
      }
      const room = LIMIT - widthOf(indent) - marker.length;
      for (const wrapped of wrapTexts(texts, room)) {
        out.push(indent + marker + wrapped);
      }
      continue;
    }
    // A comment between `/*` and `*/` or between `<!--` and `-->`.
    const opened = line.match(/^(\s*)(\/\*|<!--)(?!@api)(.*)$/);
    if (opened && fact.comment && !fact.inString && !fact.api) {
      const [, indent, opener] = opened;
      const closer = opener === '/*' ? '*/' : '-->';
      let end = i;
      while (end < lines.length - 1 && !lines[end].includes(closer)) end++;
      const block = lines.slice(i, end + 1);
      const wrapped = wrapBlock(block, indent, opener, closer);
      out.push(...(wrapped ?? block));
      i = end + 1;
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join('\n');
}

// Wraps one comment between `opener` and `closer`. `block` holds its lines.
// Returns the new lines, or null if the comment is left as it is.
//
// Two layouts are known. In the first, the text starts on the line of the
// opener and the lines after it are indented to line up with that text. In
// the second, the comment opens with a line that holds only `/*` or `/**`,
// closes with a line of its own, and every line between starts with ` * `.
function wrapBlock(block, indent, opener, closer) {
  if (!block.some((line) => widthOf(line) > LIMIT)) return null;
  const last = block[block.length - 1];
  if (!last.trimEnd().endsWith(closer)) return null;
  const starred = opener === '/*' && /^\/\*\*?$/.test(block[0].trim());
  if (starred) {
    const inner = block.slice(1, -1);
    if (!inner.every((line) => /^\s*\*( |$)/.test(line))) return null;
    const texts = inner.map((line) => line.replace(/^\s*\*/, ''));
    const room = LIMIT - widthOf(indent) - 2;
    const wrapped = wrapTexts(texts, room).map((t) => `${indent} *${t}`);
    return [block[0], ...wrapped, last];
  }
  // The text lines up one column after the opener: three columns in for
  // `/*` and five for `<!--`.
  const hang = ' '.repeat(opener.length + 1);
  const texts = block.map((line, index) => {
    let text = line;
    if (index === 0) text = text.slice(indent.length + opener.length);
    else if (text.startsWith(indent + hang)) {
      text = ' ' + text.slice(indent.length + hang.length);
    } else if (text.trim()) return null;
    return text;
  });
  if (texts.includes(null)) return null;
  // The closer is wrapped as the last word of the text, so that it is never
  // pushed past the limit.
  const room = LIMIT - widthOf(indent) - opener.length;
  const wrapped = wrapTexts(texts, room);
  return wrapped.map((text, index) => {
    if (index === 0) return indent + opener + text;
    return text.trim() ? indent + hang + text.slice(1) : '';
  });
}

let changed = 0;
for (const file of filesToCheck(process.argv.slice(2))) {
  const before = readFileSync(file, 'utf8');
  const after = wrapFile(before, kindOf(file));
  if (after === before) continue;
  writeFileSync(file, after);
  changed++;
  console.log(`wrapped comments in ${path.relative(root, file)}`);
}
console.log(`${changed} file(s) changed.`);
