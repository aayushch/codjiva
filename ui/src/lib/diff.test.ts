import { describe, expect, it } from 'vitest';
import {
  blocksOf,
  changeDetail,
  changeStarts,
  changeTitle,
  countsOf,
  rowsOf,
  type DiffRow,
} from './diff';
import type { GitChange, GitHunk } from './ipc';

// A short form of the rows: `12=12` for an unchanged line, `-12` for a line
// of the old version only, `+12` for a line of the new version only,
// `12|14` for a removed line beside an added one, and `…7` for seven folded
// lines.
const brief = (rows: DiffRow[]) =>
  rows.map((row) =>
    row.kind === 'fold'
      ? `…${row.lines}`
      : !row.change
        ? `${row.old}=${row.next}`
        : row.old != null && row.next != null
          ? `${row.old}|${row.next}`
          : row.old != null
            ? `-${row.old}`
            : `+${row.next}`,
  );

// Line 3 is replaced by two lines, and two lines are removed after line 20.
const HUNKS: GitHunk[] = [
  { oldStart: 3, oldLines: 1, newStart: 3, newLines: 2 },
  { oldStart: 21, oldLines: 2, newStart: 21, newLines: 0 },
];
const none = new Set<number>();

describe('blocksOf', () => {
  it('splits the file into unchanged and changed parts', () => {
    expect(blocksOf(HUNKS, 30, 29)).toEqual([
      { kind: 'same', old: 1, next: 1, lines: 2 },
      { kind: 'change', old: 3, next: 3, oldLines: 1, newLines: 2 },
      { kind: 'same', old: 4, next: 5, lines: 17 },
      { kind: 'change', old: 21, next: 22, oldLines: 2, newLines: 0 },
      { kind: 'same', old: 23, next: 22, lines: 8 },
    ]);
  });

  it('takes a file without an old version as one added part', () => {
    expect(
      blocksOf([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 4 }], 0, 4),
    ).toEqual([{ kind: 'change', old: 1, next: 1, oldLines: 0, newLines: 4 }]);
  });

  it('takes lines added at the end as the last part', () => {
    expect(
      blocksOf([{ oldStart: 5, oldLines: 0, newStart: 6, newLines: 2 }], 5, 7),
    ).toEqual([
      { kind: 'same', old: 1, next: 1, lines: 5 },
      { kind: 'change', old: 6, next: 6, oldLines: 0, newLines: 2 },
    ]);
  });
});

describe('rowsOf', () => {
  const blocks = blocksOf(HUNKS, 30, 29);

  it('folds the unchanged lines that are far from a change', () => {
    const rows = rowsOf(blocks, { split: false, whole: false, opened: none });
    expect(brief(rows)).toEqual([
      '1=1',
      '2=2',
      '-3',
      '+3',
      '+4',
      '4=5',
      '5=6',
      '6=7',
      '…11',
      '18=19',
      '19=20',
      '20=21',
      '-21',
      '-22',
      '23=22',
      '24=23',
      '25=24',
      '…5',
    ]);
  });

  it('shows the lines of a fold the user opened', () => {
    const rows = rowsOf(blocks, {
      split: false,
      whole: false,
      opened: new Set([2]),
    });
    expect(rows.filter((row) => row.kind === 'fold')).toHaveLength(1);
    expect(brief(rows)).toContain('12=13');
  });

  it('shows every line of the whole file', () => {
    const rows = rowsOf(blocks, { split: false, whole: true, opened: none });
    expect(rows).toHaveLength(32);
    expect(rows.every((row) => row.kind === 'line')).toBe(true);
  });

  it('puts a removed line beside an added line in two columns', () => {
    const rows = rowsOf(blocks, { split: true, whole: false, opened: none });
    expect(brief(rows).slice(0, 5)).toEqual(['1=1', '2=2', '3|3', '+4', '4=5']);
    expect(brief(rows)).toContain('-21');
  });

  it('does not fold a short stretch of unchanged lines', () => {
    const near: GitHunk[] = [
      { oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 },
      { oldStart: 11, oldLines: 1, newStart: 11, newLines: 1 },
    ];
    const rows = rowsOf(blocksOf(near, 12, 12), {
      split: false,
      whole: false,
      opened: none,
    });
    expect(rows.some((row) => row.kind === 'fold')).toBe(false);
  });
});

describe('changeStarts and countsOf', () => {
  it('finds where each run of changed rows starts', () => {
    const rows = rowsOf(blocksOf(HUNKS, 30, 29), {
      split: false,
      whole: false,
      opened: none,
    });
    expect(changeStarts(rows)).toEqual([2, 12]);
  });

  it('counts the added and the removed lines', () => {
    expect(countsOf(HUNKS)).toEqual({ added: 2, removed: 3 });
  });
});

describe('the words for a change', () => {
  const commit: GitChange = {
    commit: '9dbe5110c0ffee00000000000000000000000001',
    author: 'Ada Writer',
    time: 1_700_000_000,
    summary: 'Tune the limit',
    old: { commit: '9dbe5110c0ffee00000000000000000000000001^', path: 'a.go' },
    new: { commit: '9dbe5110c0ffee00000000000000000000000001', path: 'a.go' },
  };
  const pending: GitChange = {
    commit: null,
    author: '',
    time: 0,
    summary: '',
    old: { commit: 'HEAD', path: 'a.go' },
    new: { commit: null, path: 'a.go' },
  };

  it('names a commit by its message and the rest by what they are', () => {
    expect(changeTitle(commit)).toBe('Tune the limit');
    expect(changeTitle({ ...commit, summary: '' })).toBe('9dbe511');
    expect(changeTitle(pending)).toBe('Uncommitted changes');
  });

  it('gives the hash, the author and the age of a commit', () => {
    expect(changeDetail(commit, 1_700_000_000 + 2 * 86_400)).toBe(
      '9dbe511 · Ada Writer · 2 days ago',
    );
    expect(changeDetail(pending, 0)).toBe('Compared with the last commit');
    expect(changeDetail({ ...pending, old: null }, 0)).toBe(
      'A new file that is not committed',
    );
  });
});
