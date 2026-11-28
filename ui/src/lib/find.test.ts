import { describe, expect, it } from 'vitest';
import { FIND_LIMIT, findCount, findMatches, firstMatchFrom } from './find';

const lines = ['func Add(a int) int {', '\treturn add(a) + ADD', '}', 'a.b(c)'];

describe('findMatches', () => {
  it('finds every place in the order of the file, whatever the case', () => {
    expect(findMatches(lines, 'add', false)).toEqual([
      { line: 1, column: 5, endColumn: 8 },
      { line: 2, column: 8, endColumn: 11 },
      { line: 2, column: 17, endColumn: 20 },
    ]);
  });

  it('tells capital letters from small ones when asked', () => {
    expect(findMatches(lines, 'add', true)).toEqual([
      { line: 2, column: 8, endColumn: 11 },
    ]);
  });

  it('reads the query as text and not as a pattern', () => {
    expect(findMatches(lines, 'a.b(c)', false)).toEqual([
      { line: 4, column: 0, endColumn: 6 },
    ]);
    expect(findMatches(lines, '.', false)).toHaveLength(1);
  });

  it('finds nothing for an empty query', () => {
    expect(findMatches(lines, '', false)).toEqual([]);
  });

  it('stops at the limit', () => {
    const many = Array.from({ length: FIND_LIMIT }, () => 'aa');
    expect(findMatches(many, 'a', false)).toHaveLength(FIND_LIMIT);
  });
});

describe('firstMatchFrom', () => {
  const matches = findMatches(lines, 'add', false);

  it('starts at the first match on or below the line', () => {
    expect(firstMatchFrom(matches, 1)).toBe(0);
    expect(firstMatchFrom(matches, 2)).toBe(1);
  });

  it('starts again at the top when nothing is below', () => {
    expect(firstMatchFrom(matches, 3)).toBe(0);
    expect(firstMatchFrom([], 1)).toBe(-1);
  });
});

describe('findCount', () => {
  it('says which match is shown and how many there are', () => {
    expect(findCount(1, 14)).toBe('2 of 14');
    expect(findCount(-1, 0)).toBe('No results');
    expect(findCount(0, FIND_LIMIT)).toBe(`1 of ${FIND_LIMIT}+`);
  });
});
