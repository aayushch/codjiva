// The order of the companion files in the dialog that starts a film
// (AnimateDialog.svelte), kept apart from the dialog so it can be tested.
//
// The words in this file: a "companion file" is a file the agent reads
// together with the file the film is of. The dialog lists companion files,
// each with a tick box. Only the ticked files are given to the agent.

// The name by which two files belong together: the name of the file up to
// its first dot. `src/Engine.cpp` and `include/Engine.h` both have the pair
// name `Engine`. A name that starts with a dot, such as `.env`, is its own
// pair name.
export function pairNameOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.indexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

// Puts `paths` in the order the ticked files are listed in.
//
// Files with the same pair name are next to each other, in the order of
// their paths. Such a group stands where its first path belongs among the
// first paths of the other groups. So a header and its source file are
// together even when they are in different folders.
export function tickedOrder(paths: string[]): string[] {
  const groups = new Map<string, string[]>();
  for (const path of [...paths].sort()) {
    const name = pairNameOf(path);
    groups.set(name, [...(groups.get(name) ?? []), path]);
  }
  return [...groups.values()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .flat();
}

// The rows of the dialog in the order they are shown.
//   - `rows` are the companion files in the order the dialog got them: the
//     suggestions with the strongest first, and after them the files the
//     user added.
//   - `ticked` says for a path whether its file is ticked.
//   - `unticked` are the paths the user took the tick off by hand, the last
//     one first.
//
// The ticked files come first, in the order of `tickedOrder`. Under them
// come the files of `unticked` that are still not ticked, so that a file
// whose tick was taken off by mistake is directly under the ticked files.
// The other files come last, in the order of `rows`.
export function orderOf<Row extends { path: string }>(
  rows: Row[],
  ticked: Record<string, boolean>,
  unticked: string[],
): Row[] {
  const byPath = new Map(rows.map((row) => [row.path, row]));
  const top = tickedOrder(
    rows.filter((row) => ticked[row.path]).map((row) => row.path),
  );
  const middle = unticked.filter(
    (path, at) =>
      byPath.has(path) && !ticked[path] && unticked.indexOf(path) === at,
  );
  const placed = new Set([...top, ...middle]);
  const rest = rows
    .filter((row) => !placed.has(row.path))
    .map((row) => row.path);
  return [...top, ...middle, ...rest].map((path) => byPath.get(path)!);
}
