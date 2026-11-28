import { describe, expect, it } from 'vitest';
import { bookmarkLabel, nextBookmark, reanchored, toggled } from './bookmarks';

const at = (line: number, text = `line ${line}`) => ({ line, text });

describe('toggled', () => {
  it('adds a bookmark in the order of the lines and removes it again', () => {
    const one = toggled([at(8)], 3, 'three');
    expect(one).toEqual([at(3, 'three'), at(8)]);
    expect(toggled(one, 3, 'three')).toEqual([at(8)]);
  });
});

describe('nextBookmark', () => {
  const list = [at(3), at(8), at(20)];

  it('goes to the next one below and starts again at the top', () => {
    expect(nextBookmark(list, 3, true)).toEqual(at(8));
    expect(nextBookmark(list, 20, true)).toEqual(at(3));
  });

  it('goes to the next one above and starts again at the bottom', () => {
    expect(nextBookmark(list, 8, false)).toEqual(at(3));
    expect(nextBookmark(list, 3, false)).toEqual(at(20));
  });

  it('has nowhere to go in a file without bookmarks', () => {
    expect(nextBookmark([], 1, true)).toBeNull();
  });
});

describe('reanchored', () => {
  const lines = ['package a', '', 'func One() {}', 'func Two() {}', ''];

  it('returns the same list when every bookmark is still on its text', () => {
    const list = [at(3, 'func One() {}')];
    expect(reanchored(list, lines)).toBe(list);
  });

  it('follows a line that moved', () => {
    expect(reanchored([at(1, 'func Two() {}')], lines)).toEqual([
      at(4, 'func Two() {}'),
    ]);
  });

  it('stays on its number when its text is gone', () => {
    expect(reanchored([at(3, 'func Gone() {}')], lines)).toEqual([
      at(3, 'func One() {}'),
    ]);
  });

  it('moves a bookmark past the end to the last line', () => {
    expect(reanchored([at(40, 'func Gone() {}')], lines)).toEqual([at(5, '')]);
  });

  it('keeps a bookmark on an empty line on its number', () => {
    const list = [at(2, '')];
    expect(reanchored(list, lines)).toBe(list);
  });

  it('makes one bookmark of two that come to the same line', () => {
    expect(
      reanchored([at(1, 'func Two() {}'), at(4, 'func Two() {}')], lines),
    ).toEqual([at(4, 'func Two() {}')]);
  });
});

describe('bookmarkLabel', () => {
  it('shows the line number and the code without its indentation', () => {
    expect(bookmarkLabel(at(12, '\treturn nil'))).toBe('12 · return nil');
    expect(bookmarkLabel(at(1, 'x'.repeat(80)))).toBe(`1 · ${'x'.repeat(59)}…`);
  });
});
