// Pure helpers for code navigation in the source view, kept apart from the
// components so they can be tested.

import type { NavGroup, NavKind, NavReference, NavRole } from './ipc';

// True for a character that can be part of a name in code.
const isNameChar = (char: string) => /[\p{L}\p{N}_$]/u.test(char);

// The name at `column` of `line`, as the indexes of its first character and
// of the character after its last, or null when the character at `column` and
// the one before it are not part of a name, and when the word starts with a
// digit.
export function wordAt(
  line: string,
  column: number,
): { start: number; end: number } | null {
  let start = Math.min(Math.max(column, 0), line.length);
  let end = start;
  while (start > 0 && isNameChar(line[start - 1])) start--;
  while (end < line.length && isNameChar(line[end])) end++;
  if (start === end || /\d/.test(line[start])) return null;
  return { start, end };
}

// A line of code cut into the part before a name, the name and the part
// after it, for showing the line in a list with the name emphasised.
//
// `text` is the line, and `column` and `endColumn` say where the name stands
// in it. The spaces and tabs the line starts with are left out. When the
// columns do not point into `text`, because a very long line was cut before
// the name, `name` and `after` are empty and `before` is the whole line.
export function previewParts(
  text: string,
  column: number,
  endColumn: number,
): { before: string; name: string; after: string } {
  const lead = text.length - text.trimStart().length;
  if (column < lead || endColumn > text.length || column >= endColumn)
    return { before: text.slice(lead), name: '', after: '' };
  return {
    before: text.slice(lead, column),
    name: text.slice(column, endColumn),
    after: text.slice(endColumn),
  };
}

// The references of each file, in the order the files first appear in
// `references`. The search reports the nearest files first, and that order is
// kept.
export function byFile(
  references: NavReference[],
): { path: string; references: NavReference[] }[] {
  const groups = new Map<string, NavReference[]>();
  for (const reference of references) {
    const group = groups.get(reference.path);
    if (group) group.push(reference);
    else groups.set(reference.path, [reference]);
  }
  return Array.from(groups, ([path, references]) => ({ path, references }));
}

// The words shown for a definition's kind.
const KIND_WORDS: Record<NavKind, string> = {
  function: 'function',
  method: 'method',
  class: 'class',
  struct: 'struct',
  interface: 'interface',
  trait: 'trait',
  enum: 'enum',
  type: 'type',
  constant: 'constant',
  variable: 'variable',
  field: 'field',
  enumerator: 'enum value',
  namespace: 'namespace',
  module: 'module',
  macro: 'macro',
};
export const kindWord = (kind: NavKind): string => KIND_WORDS[kind] ?? kind;

// The words shown for how close a definition is to the clicked name.
const GROUP_WORDS: Record<NavGroup, string> = {
  scope: 'in this function',
  owner: 'of the owner in the code',
  inherited: 'inherited by the owner in the code',
  file: 'in this file',
  imported: 'in an imported file',
  folder: 'in the same folder',
  elsewhere: 'elsewhere',
};
export const groupWord = (group: NavGroup): string =>
  GROUP_WORDS[group] ?? group;

// The short tag shown next to a reference, or an empty string for a plain
// use, which needs none.
const ROLE_TAGS: Record<NavRole, string> = {
  definition: 'defined',
  declaration: 'declared',
  call: 'called',
  type: 'as a type',
  use: '',
  text: '',
};
export const roleTag = (role: NavRole): string => ROLE_TAGS[role] ?? '';

// The extensions of C and C++ files. Only they tell a declaration, the
// prototype in a header, from a definition, so only for them is "Go to
// declaration" a command of its own.
const WITH_PROTOTYPES = ['c', 'h', 'cc', 'cpp', 'cxx', 'hh', 'hpp', 'hxx'];
export function hasPrototypes(path: string): boolean {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  return path.includes('.') && WITH_PROTOTYPES.includes(extension);
}

// The last part of a path, and the folder before it: `handler.go` and
// `internal/orders` for `internal/orders/handler.go`. The folder is empty
// for a file at the root.
export function splitPath(path: string): { name: string; folder: string } {
  const at = path.lastIndexOf('/');
  return at < 0
    ? { name: path, folder: '' }
    : { name: path.slice(at + 1), folder: path.slice(0, at) };
}
