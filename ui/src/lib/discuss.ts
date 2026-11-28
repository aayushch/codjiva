// Small questions about discussions, about the notes their answers put on
// visuals, and about the parts of a file that discussions and visuals are
// about. Everything here is a pure function, so it is tested without a
// window. The state that goes with it is in state/discuss.svelte.ts.

import type {
  AnswerRef,
  ArtifactSummary,
  Note,
  Scope,
  ScopeNow,
  Thread,
} from './ipc';

// The first version of the runtime that draws notes on a visual. A version
// of an artifact keeps the runtime it was built with, so one that was built
// before this cannot show notes until it is built again.
export const NOTES_RUNTIME = '1.5.0';

// The first version of the runtime that shows the legend of a film or a
// visual as a strip beside the picture. A version of an artifact that was
// built before this shows no legend strip until it is built again.
export const LEGEND_RUNTIME = '1.6.0';

// True when the version number `version` is lower than `wanted`. Both are
// written as numbers with dots between them, such as 1.4.0. A part that is
// missing or is not a number counts as 0.
export function olderThan(version: string, wanted: string): boolean {
  const parts = (text: string) =>
    text.split('.').map((part) => parseInt(part, 10) || 0);
  const [a, b] = [parts(version), parts(wanted)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference < 0;
  }
  return false;
}

// What a scope is called where the user reads it: the name of its
// definition, or "lines 4–9", or "line 4" for a single line. `now` says
// where the scope is in the file now. Without it the lines are the ones the
// scope was made on.
export function scopeTitle(scope: Scope, now?: ScopeNow | null): string {
  if (scope.symbol) return scope.symbol;
  const start = now?.startLine ?? scope.startLine;
  const end = now?.endLine ?? scope.endLine;
  return start === end ? `line ${start}` : `lines ${start}–${end}`;
}

// The lines a scope is on, as "4–9" or "4".
export function scopeLines(scope: Scope, now?: ScopeNow | null): string {
  const start = now?.startLine ?? scope.startLine;
  const end = now?.endLine ?? scope.endLine;
  return start === end ? String(start) : `${start}–${end}`;
}

// What a discussion can be about, and what the user has on screen while
// they ask.
//   - `path` is the file the discussion belongs to.
//   - `scope` is the part of that file it is about. Without it, the
//     discussion is about `artifact`.
//   - `artifact` is the visual on screen, if any, and `version` the version
//     of it that is showing. An answer can put notes on it.
export type Target = {
  path: string;
  scope?: Scope | null;
  artifact?: ArtifactSummary | null;
  version?: number | null;
};

// True when `a` and `b` are the same part of the same file.
export const sameScope = (
  a: Scope | null | undefined,
  b: Scope | null | undefined,
): boolean => !!a && !!b && a.id === b.id && a.path === b.path;

// A text that is the same for two targets exactly when they have the same
// discussions.
export function targetKey(target: Target): string {
  const scope = target.scope ?? target.artifact?.scope;
  return scope
    ? `scope:${scope.path}#${scope.id}`
    : `artifact:${target.artifact?.id ?? ''}`;
}

// The discussions of `target`, in the order of `threads`.
//   - A target with a scope has the discussions about that scope. The scope
//     can be the target's own, or that of its artifact, so a visual of a part
//     of a file shows the discussions about that part.
//   - Any other target has the discussions about its artifact.
export function threadsOf(threads: Thread[], target: Target): Thread[] {
  const scope = target.scope ?? target.artifact?.scope;
  if (scope) return threads.filter((one) => sameScope(one.scope, scope));
  const id = target.artifact?.id;
  return id ? threads.filter((one) => !one.scope && one.artifactId === id) : [];
}

// A note as the interface lists it and sends it to a visual: the note, the
// number its mark shows, and the discussion and the question it comes from.
export type ShownNote = Note & {
  n: number;
  threadId: string;
  question: string;
};

// The notes that the answers of `threads` put on the artifact with the id
// `artifactId`, numbered from 1 in the order they were made: the oldest
// discussion first, and within a discussion the first answer first.
export function notesOf(threads: Thread[], artifactId: string): ShownNote[] {
  const found: ShownNote[] = [];
  const oldestFirst = [...threads].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  for (const thread of oldestFirst)
    thread.messages.forEach((message, at) => {
      for (const note of message.notes ?? [])
        if (note.artifactId === artifactId)
          found.push({
            ...note,
            n: found.length + 1,
            threadId: thread.id,
            question: thread.messages[at - 1]?.text ?? '',
          });
    });
  return found;
}

// A part of a file that has a discussion or a visual: the scope, where it
// is in the file now, and what it has.
export type FileScope = {
  scope: Scope;
  now: ScopeNow;
  threads: Thread[];
  artifacts: ArtifactSummary[];
};

// Where a scope is taken to be when nothing has located it yet: on the
// lines it was made on, unchanged.
export const asMade = (scope: Scope): ScopeNow => ({
  startLine: scope.startLine,
  endLine: scope.endLine,
  state: 'same',
});

// The parts of the file at `path` that have a discussion or a visual, in
// the order of their first line.
export function scopesOf(
  threads: Thread[],
  artifacts: ArtifactSummary[],
  path: string,
): FileScope[] {
  const found = new Map<string, FileScope>();
  const entry = (scope: Scope, now: ScopeNow | undefined) => {
    const has = found.get(scope.id);
    if (has) return has;
    const made: FileScope = {
      scope,
      now: now ?? asMade(scope),
      threads: [],
      artifacts: [],
    };
    found.set(scope.id, made);
    return made;
  };
  for (const thread of threads)
    if (thread.scope?.path === path)
      entry(thread.scope, thread.scopeNow).threads.push(thread);
  for (const artifact of artifacts)
    if (artifact.scope && artifact.subject[0] === path)
      entry(artifact.scope, artifact.scopeNow).artifacts.push(artifact);
  return [...found.values()].sort(
    (a, b) =>
      a.now.startLine - b.now.startLine || a.now.endLine - b.now.endLine,
  );
}

// One piece of a line of an answer: plain words, a name from the code that
// the answer wrote between backticks, or a place in the code that exists and
// is shown as a link.
export type AnswerPiece =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'ref'; text: string; ref: AnswerRef };
// One block of an answer: a paragraph, a list, or lines of code that the
// answer wrote between two lines of three backticks.
export type AnswerBlock =
  | { kind: 'paragraph'; pieces: AnswerPiece[] }
  | { kind: 'list'; items: AnswerPiece[][] }
  | { kind: 'code'; text: string };

// Splits one line of an answer into its pieces. `refs` are the places the
// core found in the answer and checked. A place is made a link wherever the
// answer writes it, between backticks or not. Any other text between
// backticks is a name from the code.
function piecesOf(line: string, refs: AnswerRef[]): AnswerPiece[] {
  const pieces: AnswerPiece[] = [];
  // Longer places first, so that `a.go:7-9` is not cut at `a.go:7`.
  const places = [...refs].sort((a, b) => b.text.length - a.text.length);
  const plain = (text: string) => {
    let rest = text;
    while (rest) {
      let first: { at: number; ref: AnswerRef } | null = null;
      for (const ref of places) {
        const at = rest.indexOf(ref.text);
        if (at >= 0 && (!first || at < first.at)) first = { at, ref };
      }
      if (!first) break;
      if (first.at > 0)
        pieces.push({ kind: 'text', text: rest.slice(0, first.at) });
      pieces.push({ kind: 'ref', text: first.ref.text, ref: first.ref });
      rest = rest.slice(first.at + first.ref.text.length);
    }
    if (rest) pieces.push({ kind: 'text', text: rest });
  };
  let at = 0;
  for (const found of line.matchAll(/`([^`]+)`/g)) {
    if (found.index > at) plain(line.slice(at, found.index));
    const ref = refs.find((one) => one.text === found[1]);
    pieces.push(
      ref
        ? { kind: 'ref', text: found[1], ref }
        : { kind: 'code', text: found[1] },
    );
    at = found.index + found[0].length;
  }
  if (at < line.length) plain(line.slice(at));
  return pieces;
}

// Splits the text of an answer into blocks for showing it.
//   - Lines between two lines that start with three backticks are code.
//   - Lines that start with "- " or "* " are the items of a list.
//   - Other lines that follow each other are one paragraph. An empty line
//     ends a paragraph and a list.
export function answerBlocks(text: string, refs: AnswerRef[]): AnswerBlock[] {
  const blocks: AnswerBlock[] = [];
  let paragraph: string[] = [];
  let items: AnswerPiece[][] = [];
  let code: string[] | null = null;
  const flush = () => {
    if (paragraph.length)
      blocks.push({
        kind: 'paragraph',
        pieces: piecesOf(paragraph.join(' '), refs),
      });
    if (items.length) blocks.push({ kind: 'list', items });
    paragraph = [];
    items = [];
  };
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      if (code) {
        blocks.push({ kind: 'code', text: code.join('\n') });
        code = null;
      } else {
        flush();
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    const item = line.match(/^\s*[-*]\s+(.*)$/);
    if (item) {
      if (paragraph.length) flush();
      items.push(piecesOf(item[1], refs));
    } else if (!line.trim()) flush();
    else {
      if (items.length) flush();
      paragraph.push(line.trim());
    }
  }
  if (code) blocks.push({ kind: 'code', text: code.join('\n') });
  flush();
  return blocks;
}
