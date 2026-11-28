import { describe, expect, it } from 'vitest';
import { agoOf, blameLabel, whoOf } from './blame';
import type { Blame } from './ipc';

const NOW = 1_800_000_000;
const DAY = 86_400;
const commit: Blame = {
  committed: true,
  commit: '9dbe5110c0ffee00000000000000000000000001',
  author: 'Ada Writer',
  byUser: false,
  time: NOW - 8 * DAY,
  summary: 'Count the ports of an artifact',
  body: '',
};

describe('agoOf', () => {
  it('uses the longest unit that fits', () => {
    expect(agoOf(NOW - 20, NOW)).toBe('just now');
    expect(agoOf(NOW - 5 * 60, NOW)).toBe('5 minutes ago');
    expect(agoOf(NOW - 3 * 3600, NOW)).toBe('3 hours ago');
    expect(agoOf(NOW - DAY, NOW)).toBe('yesterday');
    expect(agoOf(NOW - 8 * DAY, NOW)).toBe('last week');
    expect(agoOf(NOW - 70 * DAY, NOW)).toBe('2 months ago');
    expect(agoOf(NOW - 800 * DAY, NOW)).toBe('2 years ago');
  });

  it('says "just now" for a time that is after now', () => {
    expect(agoOf(NOW + 500, NOW)).toBe('just now');
  });
});

describe('blameLabel', () => {
  it('names the author, the age and the summary of a commit', () => {
    expect(blameLabel(commit, NOW)).toBe(
      'Ada Writer, last week • Count the ports of an artifact',
    );
  });

  it("says You for the user's own commit", () => {
    expect(whoOf({ ...commit, byUser: true })).toBe('You');
  });

  it('says that a line is not committed', () => {
    expect(blameLabel({ ...commit, committed: false }, NOW)).toBe(
      'Not committed yet',
    );
  });
});
