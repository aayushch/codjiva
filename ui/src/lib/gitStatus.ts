// How the file tree shows what git says about the files of the workspace,
// kept apart from the components so it can be tested.

import type { GitEntry, GitStatus } from './ipc';
import { ancestorsOf } from './tree';

// The letter the row of a changed file has at its right end.
export const GIT_LETTER: Record<GitStatus, string> = {
  modified: 'M',
  added: 'A',
  untracked: 'U',
  deleted: 'D',
  renamed: 'R',
  conflicted: '!',
};

// Which status a folder shows when the files inside it have different ones:
// the one that comes first in this list.
const ORDER: GitStatus[] = [
  'conflicted',
  'modified',
  'deleted',
  'added',
  'renamed',
  'untracked',
];

// What the tree needs to know about the changes, worked out once from the
// list git gave.
//   - `files`: the status of each changed file, by its path.
//   - `dirs`: the status each folder shows, by its path. A folder is in this
//     map when a changed file is somewhere inside it, or when git tracks
//     nothing in it.
//   - `untracked`: the paths of the folders in which git tracks nothing.
//     Every file and folder inside such a folder is untracked as well.
export type GitMarks = {
  files: Map<string, GitStatus>;
  dirs: Map<string, GitStatus>;
  untracked: Set<string>;
};

export const NO_MARKS: GitMarks = {
  files: new Map(),
  dirs: new Map(),
  untracked: new Set(),
};

// Works out the marks of the tree from the changes git reports.
//
// Each changed file gives its status to every folder above it, up to the
// root of the workspace. A folder above files with different statuses shows
// the one that comes first in `ORDER`. A deleted file has no row in the
// tree, and still gives its status to the folders above it.
export function gitMarks(entries: GitEntry[]): GitMarks {
  const marks: GitMarks = {
    files: new Map(),
    dirs: new Map(),
    untracked: new Set(),
  };
  const raise = (dir: string, status: GitStatus) => {
    const has = marks.dirs.get(dir);
    if (!has || ORDER.indexOf(status) < ORDER.indexOf(has))
      marks.dirs.set(dir, status);
  };
  for (const { path, status } of entries) {
    const isDir = path.endsWith('/');
    const plain = isDir ? path.slice(0, -1) : path;
    if (isDir) {
      marks.untracked.add(plain);
      raise(plain, status);
    } else marks.files.set(plain, status);
    for (const dir of ancestorsOf(plain)) raise(dir, status);
  }
  return marks;
}

// The status the row of `path` shows, or null for a row without one. `path`
// is the path of a file or a folder inside the workspace, without a slash
// at its end.
//   - A changed file shows its own status.
//   - A folder shows the status `gitMarks` worked out for it.
//   - A file or folder inside a folder in which git tracks nothing shows
//     `untracked`.
export function statusOf(
  marks: GitMarks,
  path: string,
  isDir: boolean,
): GitStatus | null {
  const own = isDir ? marks.dirs.get(path) : marks.files.get(path);
  if (own) return own;
  if (marks.untracked.size === 0) return null;
  return ancestorsOf(path).some((dir) => marks.untracked.has(dir))
    ? 'untracked'
    : null;
}

// The words the tooltip of a row has for its status. A folder is described
// by what is inside it.
export function gitTitle(status: GitStatus, isDir: boolean): string {
  if (!isDir)
    return {
      modified: 'Modified',
      added: 'Added',
      untracked: 'Untracked',
      deleted: 'Deleted',
      renamed: 'Renamed',
      conflicted: 'Has a conflict',
    }[status];
  return {
    modified: 'Has modified files',
    added: 'Has added files',
    untracked: 'Has untracked files',
    deleted: 'Has deleted files',
    renamed: 'Has renamed files',
    conflicted: 'Has files with a conflict',
  }[status];
}
