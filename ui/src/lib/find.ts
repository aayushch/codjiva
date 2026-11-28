// Finding text in the file of the source view, kept apart from the component
// so it can be tested.

import type { NavSpan } from './ipc';

// The most places `findMatches` returns. A search for one letter in a large
// file has more, and marking them all would make typing slow.
export const FIND_LIMIT = 5000;

// Every place `query` stands in `lines`, the lines of a file, in the order
// of the file. A place is the line, counted from 1, and the columns of its
// first character and of the character after its last. Capital and small
// letters count as the same unless `matchCase` is true. The places on one
// line do not overlap. At most FIND_LIMIT places are returned, and an empty
// `query` has none.
export function findMatches(
  lines: string[],
  query: string,
  matchCase: boolean,
): NavSpan[] {
  if (!query) return [];
  // The query is text, so every character that means something in a regular
  // expression is escaped.
  const pattern = new RegExp(
    query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    matchCase ? 'g' : 'gi',
  );
  const found: NavSpan[] = [];
  for (let index = 0; index < lines.length; index++) {
    for (const match of lines[index].matchAll(pattern)) {
      found.push({
        line: index + 1,
        column: match.index,
        endColumn: match.index + match[0].length,
      });
      if (found.length === FIND_LIMIT) return found;
    }
  }
  return found;
}

// Which of `matches` to show first when a search starts: the first one on
// or below `line`, or the first of the file when there is none below. -1
// when there are no matches.
export function firstMatchFrom(matches: NavSpan[], line: number): number {
  if (!matches.length) return -1;
  const below = matches.findIndex((match) => match.line >= line);
  return below < 0 ? 0 : below;
}

// The words beside the search box: which match is shown and how many there
// are, such as "2 of 14". A search that stopped at FIND_LIMIT says "5000+"
// for the number.
export function findCount(current: number, total: number): string {
  if (!total) return 'No results';
  return `${current + 1} of ${total}${total >= FIND_LIMIT ? '+' : ''}`;
}
