// The bookmarks of a file in the source view, kept apart from the components
// so they can be tested.
//
// A bookmark is a line the user marked by a double click on its number. The
// bookmarks of a file are a list ordered by line, with at most one bookmark
// on a line.

import type { Bookmark } from './ipc';

// The most characters of a line that a bookmark keeps as its `text`.
const TEXT_LIMIT = 300;
const kept = (text: string) => text.slice(0, TEXT_LIMIT);

// `list` with the bookmark on `line` removed if there is one, and added if
// there is none. `text` is the code of that line.
export function toggled(
  list: Bookmark[],
  line: number,
  text: string,
): Bookmark[] {
  const without = list.filter((mark) => mark.line !== line);
  if (without.length !== list.length) return without;
  return [...without, { line, text: kept(text) }].sort(
    (a, b) => a.line - b.line,
  );
}

// The bookmark to go to from line `from`. Forward, that is the first
// bookmark below `from`, or the first of the file when there is none below.
// Backward, it is the last bookmark above `from`, or the last of the file
// when there is none above. Null when the file has no bookmark.
export function nextBookmark(
  list: Bookmark[],
  from: number,
  forward: boolean,
): Bookmark | null {
  if (!list.length) return null;
  if (forward) return list.find((mark) => mark.line > from) ?? list[0];
  const above = list.filter((mark) => mark.line < from);
  return above[above.length - 1] ?? list[list.length - 1];
}

// The bookmarks of a file after the file changed. `lines` is the code of the
// file now, one entry for each line.
//   - A bookmark whose line still has the bookmark's text stays there.
//   - Otherwise it moves to the nearest line that has that text.
//   - If no line has that text, or the text is empty or only spaces, it
//     stays on its line number and takes the text that line has now. A
//     number past the end of the file becomes the last line.
// Two bookmarks that come to the same line become one. Returns `list` itself
// when nothing changed.
export function reanchored(list: Bookmark[], lines: string[]): Bookmark[] {
  if (!lines.length) return list;
  const moved = list.map((mark) => {
    const here = Math.min(mark.line, lines.length);
    if (kept(lines[mark.line - 1] ?? '') === mark.text) return mark;
    let nearest: number | null = null;
    if (mark.text.trim())
      lines.forEach((text, index) => {
        if (kept(text) !== mark.text) return;
        const line = index + 1;
        if (
          nearest == null ||
          Math.abs(line - mark.line) < Math.abs(nearest - mark.line)
        )
          nearest = line;
      });
    const line = nearest ?? here;
    return { line, text: kept(lines[line - 1] ?? '') };
  });
  const seen = new Set<number>();
  const single = moved
    .filter((mark) => !seen.has(mark.line) && seen.add(mark.line))
    .sort((a, b) => a.line - b.line);
  const same =
    single.length === list.length &&
    single.every(
      (mark, i) => mark.line === list[i].line && mark.text === list[i].text,
    );
  return same ? list : single;
}

// What the list of bookmarks shows for one of them: the line number and the
// code of the line without the spaces around it, cut to 60 characters.
export function bookmarkLabel(mark: Bookmark): string {
  const code = mark.text.trim();
  return `${mark.line} · ${code.length > 60 ? code.slice(0, 59) + '…' : code}`;
}
