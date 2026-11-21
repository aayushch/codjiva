import { describe, expect, it } from 'vitest';
import { lastMade, newestFirst, rationaleParts } from './artifacts';
import type { VersionSummary } from './ipc';

// A version made at `createdAt`, with the other fields filled in.
const version = (n: number, createdAt: string): VersionSummary => ({
  version: n,
  createdAt,
  passed: true,
  errors: 0,
  warnings: 0,
  instructions: '',
  agent: 'mock',
  model: null,
  parent: null,
});

describe('newestFirst', () => {
  const handler = {
    title: 'Handler',
    versions: [
      version(1, '2026-03-01T09:00:00Z'),
      version(2, '2026-03-05T16:30:00Z'),
    ],
  };
  const store = {
    title: 'Store',
    versions: [version(1, '2026-03-04T12:00:00Z')],
  };
  const batch = {
    title: 'Batch',
    versions: [version(1, '2026-03-04T12:00:00Z')],
  };

  it('takes the time of the newest version of an artifact', () => {
    expect(lastMade(handler)).toBe(Date.parse('2026-03-05T16:30:00Z'));
    expect(lastMade({ versions: [] })).toBe(0);
    expect(lastMade({ versions: [version(1, 'not a time')] })).toBe(0);
  });

  it('puts the artifact that was generated last first', () => {
    const given = [store, handler];
    expect(newestFirst(given).map((a) => a.title)).toEqual([
      'Handler',
      'Store',
    ]);
    expect(given.map((a) => a.title)).toEqual(['Store', 'Handler']);
  });

  it('orders artifacts generated at the same time by title', () => {
    expect(newestFirst([store, batch, handler]).map((a) => a.title)).toEqual([
      'Handler',
      'Batch',
      'Store',
    ]);
  });
});

describe('rationaleParts', () => {
  it('splits identifiers between backticks from the plain words', () => {
    expect(
      rationaleParts('`price` runs after `validateLines`, which checks it.'),
    ).toEqual([
      { text: 'price', code: true },
      { text: ' runs after ', code: false },
      { text: 'validateLines', code: true },
      { text: ', which checks it.', code: false },
    ]);
  });

  it('returns text without backticks as one plain part', () => {
    expect(rationaleParts('The batch is kept.')).toEqual([
      { text: 'The batch is kept.', code: false },
    ]);
  });

  it('keeps a backtick that has no partner in the plain words', () => {
    expect(rationaleParts('a ` b')).toEqual([{ text: 'a ` b', code: false }]);
  });

  it('returns nothing for an empty text', () => {
    expect(rationaleParts('')).toEqual([]);
  });
});
