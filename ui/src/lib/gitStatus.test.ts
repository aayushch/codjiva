import { describe, expect, it } from 'vitest';
import { GIT_LETTER, gitMarks, gitTitle, statusOf } from './gitStatus';

describe('gitMarks', () => {
  const marks = gitMarks([
    { path: 'src/app/a.ts', status: 'modified' },
    { path: 'src/app/new.ts', status: 'added' },
    { path: 'src/lib/gone.ts', status: 'deleted' },
    { path: 'docs/', status: 'untracked' },
    { path: 'top.ts', status: 'conflicted' },
  ]);

  it('gives a changed file its own status', () => {
    expect(statusOf(marks, 'src/app/a.ts', false)).toBe('modified');
    expect(statusOf(marks, 'src/app/new.ts', false)).toBe('added');
    expect(statusOf(marks, 'top.ts', false)).toBe('conflicted');
    expect(statusOf(marks, 'src/app/same.ts', false)).toBeNull();
  });

  it('gives every folder above a changed file a status', () => {
    // Modified comes before added, so the folder of both shows modified.
    expect(statusOf(marks, 'src/app', true)).toBe('modified');
    expect(statusOf(marks, 'src', true)).toBe('modified');
    // A deleted file has no row, and its folder still shows the change.
    expect(statusOf(marks, 'src/lib', true)).toBe('deleted');
    expect(statusOf(marks, 'other', true)).toBeNull();
  });

  it('treats everything inside an untracked folder as untracked', () => {
    expect(statusOf(marks, 'docs', true)).toBe('untracked');
    expect(statusOf(marks, 'docs/guide/intro.md', false)).toBe('untracked');
    expect(statusOf(marks, 'docs/guide', true)).toBe('untracked');
  });

  it('shows a conflict before every other status of a folder', () => {
    const mixed = gitMarks([
      { path: 'a/one.ts', status: 'untracked' },
      { path: 'a/two.ts', status: 'conflicted' },
      { path: 'a/three.ts', status: 'modified' },
    ]);
    expect(statusOf(mixed, 'a', true)).toBe('conflicted');
  });
});

describe('the letter and the words of a status', () => {
  it('names each status', () => {
    expect(GIT_LETTER.modified).toBe('M');
    expect(GIT_LETTER.conflicted).toBe('!');
    expect(gitTitle('untracked', false)).toBe('Untracked');
    expect(gitTitle('modified', true)).toBe('Has modified files');
  });
});
