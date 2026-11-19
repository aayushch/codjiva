import { describe, expect, it } from 'vitest';
import type { NavReference } from './ipc';
import { byFile, hasPrototypes, previewParts, splitPath, wordAt } from './nav';

describe('wordAt', () => {
  const line = '\treturn h.Flush(ctx), $total2';
  const word = (column: number) => {
    const found = wordAt(line, column);
    return found ? line.slice(found.start, found.end) : null;
  };

  it('finds the name the column is inside, at its start and at its end', () => {
    expect(word(line.indexOf('Flush'))).toBe('Flush');
    expect(word(line.indexOf('Flush') + 2)).toBe('Flush');
    expect(word(line.indexOf('Flush') + 5)).toBe('Flush');
    expect(word(line.indexOf('$total2') + 3)).toBe('$total2');
  });

  it('finds nothing on punctuation, on a number and outside the line', () => {
    expect(word(0)).toBeNull();
    expect(word(line.indexOf(',') + 1)).toBeNull();
    expect(wordAt('x = 42;', 5)).toBeNull();
    expect(wordAt('', 3)).toBeNull();
  });

  it('counts letters of other alphabets as part of a name', () => {
    const found = wordAt('größe = 1', 2);
    expect(found).toEqual({ start: 0, end: 5 });
  });
});

describe('previewParts', () => {
  it('cuts a line around the name and drops the indentation', () => {
    expect(previewParts('\t\treturn h.Flush(ctx)', 11, 16)).toEqual({
      before: 'return h.',
      name: 'Flush',
      after: '(ctx)',
    });
  });

  it('shows the whole line when the columns point outside it', () => {
    expect(previewParts('  a long line that was cut', 400, 405)).toEqual({
      before: 'a long line that was cut',
      name: '',
      after: '',
    });
  });
});

describe('byFile', () => {
  it('groups references and keeps the order the files came in', () => {
    const ref = (path: string, line: number): NavReference => ({
      path,
      line,
      column: 0,
      endColumn: 1,
      role: 'use',
      text: '',
    });
    const groups = byFile([ref('b.go', 4), ref('a.go', 1), ref('b.go', 9)]);
    expect(
      groups.map((g) => [g.path, g.references.map((r) => r.line)]),
    ).toEqual([
      ['b.go', [4, 9]],
      ['a.go', [1]],
    ]);
  });
});

describe('paths', () => {
  it('knows which files can have a prototype apart from a body', () => {
    expect(hasPrototypes('src/LogWriter.cpp')).toBe(true);
    expect(hasPrototypes('include/LogWriter.H')).toBe(true);
    expect(hasPrototypes('internal/orders/handler.go')).toBe(false);
    expect(hasPrototypes('Makefile')).toBe(false);
  });

  it('splits a path into its name and its folder', () => {
    expect(splitPath('internal/orders/handler.go')).toEqual({
      name: 'handler.go',
      folder: 'internal/orders',
    });
    expect(splitPath('go.mod')).toEqual({ name: 'go.mod', folder: '' });
  });
});
