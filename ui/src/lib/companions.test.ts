import { describe, expect, it } from 'vitest';
import { orderOf, pairNameOf, tickedOrder } from './companions';

describe('pairNameOf', () => {
  it('is the name of the file up to its first dot', () => {
    expect(pairNameOf('src/Engine.cpp')).toBe('Engine');
    expect(pairNameOf('include/Engine.h')).toBe('Engine');
    expect(pairNameOf('web/cart.test.ts')).toBe('cart');
    expect(pairNameOf('Makefile')).toBe('Makefile');
  });

  it('is the whole name for a name that starts with a dot', () => {
    expect(pairNameOf('conf/.env')).toBe('.env');
  });
});

describe('tickedOrder', () => {
  it('puts the paths in the order of the alphabet', () => {
    expect(tickedOrder(['b/two.go', 'a/one.go', 'a/three.go'])).toEqual([
      'a/one.go',
      'a/three.go',
      'b/two.go',
    ]);
  });

  it('keeps a header and its source together across folders', () => {
    expect(
      tickedOrder(['src/Engine.cpp', 'src/Agent.cpp', 'include/Engine.h']),
    ).toEqual(['include/Engine.h', 'src/Engine.cpp', 'src/Agent.cpp']);
  });
});

describe('orderOf', () => {
  const rows = ['z/strong.go', 'm/weak.go', 'a/added.go', 'k/other.go'].map(
    (path) => ({ path }),
  );
  const paths = (ticked: string[], unticked: string[] = []) =>
    orderOf(
      rows,
      Object.fromEntries(ticked.map((path) => [path, true])),
      unticked,
    ).map((row) => row.path);

  it('lists the ticked files first and the others in their own order', () => {
    expect(paths(['z/strong.go', 'a/added.go'])).toEqual([
      'a/added.go',
      'z/strong.go',
      'm/weak.go',
      'k/other.go',
    ]);
  });

  it('puts a file whose tick was taken off under the ticked files', () => {
    expect(paths(['a/added.go'], ['z/strong.go'])).toEqual([
      'a/added.go',
      'z/strong.go',
      'm/weak.go',
      'k/other.go',
    ]);
    expect(paths(['a/added.go'], ['k/other.go', 'z/strong.go'])).toEqual([
      'a/added.go',
      'k/other.go',
      'z/strong.go',
      'm/weak.go',
    ]);
  });

  it('lists a file once when its tick was taken off, put back and taken off', () => {
    expect(paths([], ['m/weak.go', 'k/other.go', 'm/weak.go'])).toEqual([
      'm/weak.go',
      'k/other.go',
      'z/strong.go',
      'a/added.go',
    ]);
  });

  it('leaves out an unticked path that is ticked again or not listed', () => {
    expect(paths(['m/weak.go'], ['m/weak.go', 'gone.go'])).toEqual([
      'm/weak.go',
      'z/strong.go',
      'a/added.go',
      'k/other.go',
    ]);
  });
});
