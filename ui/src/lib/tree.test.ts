import { describe, expect, it } from 'vitest';
import type { TreeEntry } from './ipc';
import {
  ancestorsOf,
  flattenTree,
  formatBytes,
  formatTime,
  parentOf,
} from './tree';
import { splitHighlightedLines } from './highlight';

const dir = (relPath: string): TreeEntry => ({
  name: relPath.split('/').pop()!,
  relPath,
  kind: 'dir',
  lang: null,
  size: null,
});
const file = (relPath: string): TreeEntry => ({
  name: relPath.split('/').pop()!,
  relPath,
  kind: 'file',
  lang: null,
  size: 1,
});

describe('flattenTree', () => {
  const children = {
    '': [dir('src'), file('README.md')],
    src: [dir('src/a'), file('src/main.go')],
    'src/a': [file('src/a/x.go')],
  };

  it('shows only the root when nothing is expanded', () => {
    expect(flattenTree(children, {}).map((r) => r.entry.relPath)).toEqual([
      'src',
      'README.md',
    ]);
  });

  it('nests the entries of expanded folders under them with their depth', () => {
    const rows = flattenTree(children, { src: true, 'src/a': true });
    expect(rows.map((r) => [r.entry.relPath, r.depth])).toEqual([
      ['src', 0],
      ['src/a', 1],
      ['src/a/x.go', 2],
      ['src/main.go', 1],
      ['README.md', 0],
    ]);
    expect(rows[0].expanded).toBe(true);
  });

  it('shows an expanded folder as empty until its entries are loaded', () => {
    expect(
      flattenTree({ '': [dir('src')] }, { src: true }).map(
        (r) => r.entry.relPath,
      ),
    ).toEqual(['src']);
  });
});

describe('path helpers', () => {
  it('finds parents and ancestors', () => {
    expect(parentOf('a/b/c.txt')).toBe('a/b');
    expect(parentOf('c.txt')).toBe('');
    expect(ancestorsOf('a/b/c.txt')).toEqual(['a', 'a/b']);
    expect(ancestorsOf('c.txt')).toEqual([]);
  });

  it('formats sizes and times', () => {
    expect([
      formatBytes(812),
      formatBytes(14 * 1024),
      formatBytes(2.3 * 1024 * 1024),
    ]).toEqual(['812 B', '14 KB', '2.3 MB']);
    expect([formatTime(0), formatTime(75), formatTime(270.4)]).toEqual([
      '0:00',
      '1:15',
      '4:30',
    ]);
  });
});

describe('splitHighlightedLines', () => {
  it('keeps a token that spans lines valid on every line', () => {
    const html =
      'a <span class="c">/* one\ntwo */</span> b\n<span class="k">x</span>';
    expect(splitHighlightedLines(html)).toEqual([
      'a <span class="c">/* one</span>',
      '<span class="c">two */</span> b',
      '<span class="k">x</span>',
    ]);
  });

  it('returns one line for text without line breaks', () => {
    expect(splitHighlightedLines('plain')).toEqual(['plain']);
  });
});
