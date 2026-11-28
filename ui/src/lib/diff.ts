// How the diff view lays out two versions of a file, kept apart from the
// components so it can be tested.

import { agoOf } from './blame';
import type { GitChange, GitHunk, GitSide } from './ipc';

// How many commits of a file the app lists at most. It is the same number
// as `HISTORY_LIMIT` in git_diff.rs.
export const HISTORY_LIMIT = 500;

// How many unchanged lines stay in view above and below a change when the
// rest of the unchanged lines are folded away.
export const CONTEXT = 3;

// A stretch of unchanged lines is folded away only when at least this many
// lines would be hidden. Hiding fewer would cost a row and save little.
const FOLD_MIN = 4;

// A part of the two versions, from the top of the file down.
//   - `same`: `lines` lines that are in both versions. They start at line
//     `old` of the old version and at line `next` of the new version.
//   - `change`: `oldLines` lines of the old version, from line `old`, that
//     were replaced by `newLines` lines of the new version, from line
//     `next`. One of the two counts can be 0.
// Lines are counted from 1.
export type Block =
  | { kind: 'same'; old: number; next: number; lines: number }
  | {
      kind: 'change';
      old: number;
      next: number;
      oldLines: number;
      newLines: number;
    };

// Splits the two versions into blocks. `hunks` are the runs of lines that
// differ, as git reports them. `oldCount` and `newCount` are the numbers of
// lines of the old and the new version.
export function blocksOf(
  hunks: GitHunk[],
  oldCount: number,
  newCount: number,
): Block[] {
  const blocks: Block[] = [];
  let old = 1;
  let next = 1;
  const same = (lines: number) => {
    if (lines > 0) blocks.push({ kind: 'same', old, next, lines });
  };
  for (const hunk of hunks) {
    // For a count of 0, git gives the line after which the other lines
    // belong. The block then starts at the line below it.
    const oldFrom = hunk.oldLines ? hunk.oldStart : hunk.oldStart + 1;
    const newFrom = hunk.newLines ? hunk.newStart : hunk.newStart + 1;
    same(oldFrom - old);
    blocks.push({
      kind: 'change',
      old: oldFrom,
      next: newFrom,
      oldLines: hunk.oldLines,
      newLines: hunk.newLines,
    });
    old = oldFrom + hunk.oldLines;
    next = newFrom + hunk.newLines;
  }
  same(Math.min(oldCount - old, newCount - next) + 1);
  return blocks;
}

// One row of the diff view.
//   - `line`: one line of code. `old` and `next` are its numbers in the old
//     and the new version, or null for a version that does not have it.
//     `change` is true for a line that was removed or added. In one column,
//     a changed row has only one of the two numbers. In two columns, a
//     changed row can have both: the removed line on the left and the added
//     line on the right.
//   - `fold`: `lines` unchanged lines that are hidden. `block` is the
//     position in the list of blocks of the block they belong to. The view
//     shows them when the user clicks the row.
export type DiffRow =
  | { kind: 'line'; old: number | null; next: number | null; change: boolean }
  | { kind: 'fold'; block: number; lines: number };

// The rows of the diff view for `blocks`.
//   - `split`: true for two columns, false for one.
//   - `whole`: true to show every line. With false, the unchanged lines
//     that are more than `CONTEXT` lines away from a change are folded into
//     one row, unless the position of their block is in `opened`.
export function rowsOf(
  blocks: Block[],
  options: { split: boolean; whole: boolean; opened: ReadonlySet<number> },
): DiffRow[] {
  const rows: DiffRow[] = [];
  const line = (old: number | null, next: number | null, change: boolean) =>
    rows.push({ kind: 'line', old, next, change });
  blocks.forEach((block, at) => {
    if (block.kind === 'change') {
      if (options.split) {
        const most = Math.max(block.oldLines, block.newLines);
        for (let i = 0; i < most; i++)
          line(
            i < block.oldLines ? block.old + i : null,
            i < block.newLines ? block.next + i : null,
            true,
          );
      } else {
        for (let i = 0; i < block.oldLines; i++)
          line(block.old + i, null, true);
        for (let i = 0; i < block.newLines; i++)
          line(null, block.next + i, true);
      }
      return;
    }
    // Unchanged lines stay in view only next to a change: below the change
    // before them and above the change after them.
    const head = at === 0 ? 0 : CONTEXT;
    const tail = at === blocks.length - 1 ? 0 : CONTEXT;
    const hidden = block.lines - head - tail;
    const folded =
      !options.whole && !options.opened.has(at) && hidden >= FOLD_MIN;
    for (let i = 0; i < block.lines; i++) {
      if (folded && i === head) {
        rows.push({ kind: 'fold', block: at, lines: hidden });
        i += hidden - 1;
      } else line(block.old + i, block.next + i, false);
    }
  });
  return rows;
}

// The positions in `rows` at which a run of changed rows starts. The
// buttons that go to the next and the previous change use them.
export function changeStarts(rows: DiffRow[]): number[] {
  const starts: number[] = [];
  rows.forEach((row, at) => {
    const changed = row.kind === 'line' && row.change;
    const before = rows[at - 1];
    if (changed && !(before?.kind === 'line' && before.change)) starts.push(at);
  });
  return starts;
}

// How many lines the hunks add and remove in all.
export function countsOf(hunks: GitHunk[]): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    added += hunk.newLines;
    removed += hunk.oldLines;
  }
  return { added, removed };
}

// What stands for a change in the list of changes and on its button: the
// first line of the commit message, or "Uncommitted changes" for the
// changes that are not committed. A commit without a message is shown by
// the start of its hash.
export const changeTitle = (change: GitChange) =>
  change.commit == null
    ? 'Uncommitted changes'
    : change.summary || change.commit.slice(0, 7);

// The second line of a change in the list: the start of the hash, the
// author and how long ago the commit was made. `now` is the present time in
// seconds since the start of 1970. For the changes that are not committed
// it says what they are compared with.
export const changeDetail = (change: GitChange, now: number) =>
  change.commit == null
    ? change.old
      ? 'Compared with the last commit'
      : 'A new file that is not committed'
    : `${change.commit.slice(0, 7)} · ${change.author} · ${agoOf(change.time, now)}`;

// A name for a change that stays the same when the list of changes is read
// again: the hash of the commit, or an empty string for the changes that
// are not committed.
export const changeKey = (change: GitChange) => change.commit ?? '';

// The two versions the diff view compares when the change on screen is
// `change`.
//   - Without `base`, they are the two versions of `change`: the file
//     before the change and the file after it.
//   - With `base`, an older change of the same file, they are the file
//     after `base` and the file after `change`. The lines `base` itself
//     changed are then not part of the comparison.
export const sidesOf = (
  change: GitChange,
  base: GitChange | null,
): { old: GitSide | null; new: GitSide } =>
  base
    ? { old: base.new, new: change.new }
    : { old: change.old, new: change.new };

// A short name for the file as a change left it: the start of the hash of
// the commit, or "Uncommitted" for the file on disk.
export const versionName = (change: GitChange) =>
  change.commit == null ? 'Uncommitted' : change.commit.slice(0, 7);

// What stands for a comparison of two versions on the button of the list of
// changes and in the bar of the diff view: the short names of the older and
// the newer version with an arrow between them.
export const compareTitle = (base: GitChange, change: GitChange) =>
  `${versionName(base)} → ${versionName(change)}`;

// Says which changes lie between two compared versions, such as "3 commits"
// or "2 commits and the uncommitted changes". `changes` is the list of
// changes of the file, newest first. `index` is the position of the newer
// version and `baseIndex` the position of the older one. The changes from
// `index` up to the one in front of `baseIndex` are the ones counted.
export function compareDetail(
  changes: GitChange[],
  index: number,
  baseIndex: number,
): string {
  const between = changes.slice(index, baseIndex);
  const commits = between.filter((change) => change.commit != null).length;
  const pending = commits < between.length;
  const counted = `${commits} ${commits === 1 ? 'commit' : 'commits'}`;
  if (!pending) return counted;
  return commits
    ? `${counted} and the uncommitted changes`
    : 'the uncommitted changes';
}
