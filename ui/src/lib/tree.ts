// Pure helpers for the file tree, kept apart from the interface state so they
// can be tested.

import type { TreeEntry } from './ipc';

// One visible row of the tree.
export type TreeRow = {
  entry: TreeEntry;
  // How deep the row is nested. Rows at the workspace root have depth 0.
  depth: number;
  expanded: boolean;
};

// Turns the loaded folders into the flat list of rows the tree shows, top to
// bottom.
//
// `children` maps a folder's path to its entries, with "" for the workspace
// root. A folder's entries appear under it only when the folder is expanded and
// its entries have been loaded.
export function flattenTree(
  children: Record<string, TreeEntry[]>,
  expanded: Record<string, boolean>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (dir: string, depth: number) => {
    for (const entry of children[dir] ?? []) {
      const open = entry.kind === 'dir' && !!expanded[entry.relPath];
      rows.push({ entry, depth, expanded: open });
      if (open) walk(entry.relPath, depth + 1);
    }
  };
  walk('', 0);
  return rows;
}

// The folder that contains a path, or "" for a path at the workspace root.
export function parentOf(relPath: string): string {
  const cut = relPath.lastIndexOf('/');
  return cut < 0 ? '' : relPath.slice(0, cut);
}

// Every folder above a path, outermost first: "a/b/c.txt" gives ["a", "a/b"].
export function ancestorsOf(relPath: string): string[] {
  const parts = relPath.split('/').slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
}

// Formats a byte count the way the interface shows file sizes: "812 B", "14
// KB", "2.3 MB".
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Formats seconds as minutes and seconds, "4:30". The last part of a path, for
// display. A folder's path ends with a slash, and so does its name.
export function nameOf(path: string): string {
  const folder = path.endsWith('/');
  const name = path.replace(/\/$/, '').split('/').pop() ?? path;
  return folder ? name + '/' : name;
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
