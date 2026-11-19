// Pure helpers for the row of file tabs above the toolbar, kept apart from
// the interface state so they can be tested.
//
// The words in this file: a "file tab" stands for one thing the user has
// open. That thing is a file, a folder or a pipeline. Its `path` is what
// `app.selected` holds while it is on screen: a file's path, a folder's path
// with a slash at its end, or a pipeline's id after `PIPELINE_PREFIX`.

import { PIPELINE_PREFIX } from './artifacts';
import type { ViewTab } from './state/app.svelte';

// One file tab. Besides the path it keeps how the user last looked at the
// thing, so that coming back to the tab shows the same view.
//   - `view` is which of Visual, Film and Source was showing.
//   - `line` is the line the source view was at, or null when the source view
//     was not showing or was not at a particular line.
export type OpenFile = { path: string; view: ViewTab; line: number | null };

// Returns `files` with `entry` in it.
//
// If a tab with the same path is in the list, `entry` replaces it and the
// order stays the same. Otherwise `entry` is a new tab. It is put directly
// after the tab whose path is `after`, which is the tab the user came from.
// If `after` is null or is not in the list, the new tab goes to the end.
export function withOpened(
  files: OpenFile[],
  entry: OpenFile,
  after: string | null,
): OpenFile[] {
  const at = files.findIndex((file) => file.path === entry.path);
  if (at >= 0) return files.map((file, i) => (i === at ? entry : file));
  const from = files.findIndex((file) => file.path === after);
  const index = from < 0 ? files.length : from + 1;
  return [...files.slice(0, index), entry, ...files.slice(index)];
}

// Returns `files` without the tab whose path is `path`, as `files`, and the
// tab to show in its place, as `next`.
//
// `next` is the tab that was to the right of the closed one. If the closed
// tab was the last in the row, `next` is the tab to its left. `next` is null
// when no tab is left, or when `path` was not in the list.
export function withoutClosed(
  files: OpenFile[],
  path: string,
): { files: OpenFile[]; next: OpenFile | null } {
  const at = files.findIndex((file) => file.path === path);
  if (at < 0) return { files, next: null };
  const left = files.filter((_, i) => i !== at);
  return { files: left, next: left[at] ?? left[at - 1] ?? null };
}

// What a file tab shows: `name`, and `where`, which is empty unless two tabs
// would otherwise show the same name.
export type TabLabel = { name: string; where: string };

// The labels of the tabs with the given paths, in the same order.
//
// A file's name is the last part of its path. A folder's name is the last
// part of its path with a slash after it. A pipeline's name is its title,
// looked up in `pipelineTitles` by the pipeline's id, or "Pipeline" when the
// id is not there.
//
// When two or more files or folders have the same name, each of them gets
// the folder that contains it as `where`, so that the user can tell them
// apart: "orders" for "internal/orders/handler.go". A file at the workspace
// root gets "/" as `where` in that case.
export function labelsOf(
  paths: string[],
  pipelineTitles: Record<string, string> = {},
): TabLabel[] {
  const names = paths.map((path) => {
    if (path.startsWith(PIPELINE_PREFIX))
      return pipelineTitles[path.slice(PIPELINE_PREFIX.length)] ?? 'Pipeline';
    const folder = path.endsWith('/');
    const parts = path.replace(/\/$/, '').split('/');
    return parts[parts.length - 1] + (folder ? '/' : '');
  });
  const count = new Map<string, number>();
  for (const name of names) count.set(name, (count.get(name) ?? 0) + 1);
  return paths.map((path, i) => {
    const name = names[i];
    if (path.startsWith(PIPELINE_PREFIX) || (count.get(name) ?? 0) < 2)
      return { name, where: '' };
    const parts = path.replace(/\/$/, '').split('/');
    return { name, where: parts[parts.length - 2] ?? '/' };
  });
}

// The full path of a file or folder of the workspace, as the operating system
// writes it. `root` is the workspace folder and `relPath` the path inside it,
// which the app always writes with forward slashes. A slash at the end of
// `relPath`, which marks a folder, is left out.
//
// A `root` that holds a backslash is a Windows path, and the result then uses
// backslashes throughout.
export function absolutePath(root: string, relPath: string): string {
  const windows = root.includes('\\');
  const separator = windows ? '\\' : '/';
  const inside = relPath.replace(/\/$/, '');
  const base = root.endsWith(separator) ? root.slice(0, -1) : root;
  return base + separator + (windows ? inside.replaceAll('/', '\\') : inside);
}
