import { describe, expect, it } from 'vitest';
import {
  absolutePath,
  labelsOf,
  withOpened,
  withoutClosed,
  type OpenFile,
} from './tabs';

const tab = (path: string, view: OpenFile['view'] = 'visual'): OpenFile => ({
  path,
  view,
  line: null,
});
const paths = (files: OpenFile[]) => files.map((file) => file.path);

describe('withOpened', () => {
  const files = [tab('a.go'), tab('b.go'), tab('c.go')];

  it('puts a new tab directly after the tab the user came from', () => {
    expect(paths(withOpened(files, tab('x.go'), 'a.go'))).toEqual([
      'a.go',
      'x.go',
      'b.go',
      'c.go',
    ]);
  });

  it('puts a new tab at the end when the user came from no tab', () => {
    expect(paths(withOpened(files, tab('x.go'), null))).toEqual([
      'a.go',
      'b.go',
      'c.go',
      'x.go',
    ]);
    expect(paths(withOpened(files, tab('x.go'), 'gone.go'))).toEqual([
      'a.go',
      'b.go',
      'c.go',
      'x.go',
    ]);
  });

  it('replaces a tab that is already open and keeps the order', () => {
    const next = withOpened(
      files,
      { path: 'b.go', view: 'source', line: 12 },
      'c.go',
    );
    expect(paths(next)).toEqual(['a.go', 'b.go', 'c.go']);
    expect(next[1]).toEqual({ path: 'b.go', view: 'source', line: 12 });
  });
});

describe('withoutClosed', () => {
  const files = [tab('a.go'), tab('b.go'), tab('c.go')];

  it('shows the tab to the right of the closed one', () => {
    const { files: left, next } = withoutClosed(files, 'b.go');
    expect(paths(left)).toEqual(['a.go', 'c.go']);
    expect(next?.path).toBe('c.go');
  });

  it('shows the tab to the left when the last tab of the row is closed', () => {
    expect(withoutClosed(files, 'c.go').next?.path).toBe('b.go');
  });

  it('shows nothing when the only tab is closed', () => {
    expect(withoutClosed([tab('a.go')], 'a.go')).toEqual({
      files: [],
      next: null,
    });
  });

  it('changes nothing for a path that is not open', () => {
    expect(withoutClosed(files, 'x.go')).toEqual({ files, next: null });
  });
});

describe('labelsOf', () => {
  it('names a file by the last part of its path', () => {
    expect(labelsOf(['internal/orders/handler.go', 'go.mod'])).toEqual([
      { name: 'handler.go', where: '' },
      { name: 'go.mod', where: '' },
    ]);
  });

  it('adds the containing folder to tabs that share a name', () => {
    expect(
      labelsOf(['a/orders/index.ts', 'a/users/index.ts', 'index.ts', 'x.ts']),
    ).toEqual([
      { name: 'index.ts', where: 'orders' },
      { name: 'index.ts', where: 'users' },
      { name: 'index.ts', where: '/' },
      { name: 'x.ts', where: '' },
    ]);
  });

  it('names a folder with a slash and a pipeline by its title', () => {
    expect(
      labelsOf(['internal/orders/', 'pipeline:p1', 'pipeline:p2'], {
        p1: 'Orders to store',
      }),
    ).toEqual([
      { name: 'orders/', where: '' },
      { name: 'Orders to store', where: '' },
      { name: 'Pipeline', where: '' },
    ]);
  });
});

describe('absolutePath', () => {
  it('joins the workspace folder and the path inside it', () => {
    expect(absolutePath('/Users/me/shop', 'src/handler.go')).toBe(
      '/Users/me/shop/src/handler.go',
    );
    expect(absolutePath('/Users/me/shop/', 'src/')).toBe('/Users/me/shop/src');
  });

  it('uses backslashes throughout for a Windows workspace', () => {
    expect(absolutePath('C:\\work\\shop', 'src/lib/a.ts')).toBe(
      'C:\\work\\shop\\src\\lib\\a.ts',
    );
  });
});
