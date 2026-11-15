import { describe, expect, it } from 'vitest';
import { rationaleParts } from './artifacts';

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
