import { describe, expect, it } from 'vitest';
import {
  answerBlocks,
  notesOf,
  olderThan,
  scopeLines,
  scopeTitle,
  scopesOf,
  targetKey,
  threadsOf,
} from './discuss';
import type { ArtifactSummary, Scope, Thread } from './ipc';

const scope = (id: string, start: number, end: number, symbol?: string) =>
  ({
    id,
    path: 'queue.go',
    symbol,
    startLine: start,
    endLine: end,
    textHash: 'h',
  }) satisfies Scope;

const thread = (id: string, rest: Partial<Thread>): Thread => ({
  id,
  title: id,
  path: 'queue.go',
  createdAt: `2026-11-26T10:00:0${id.slice(-1)}Z`,
  updatedAt: '',
  messages: [],
  ...rest,
});

const artifact = (id: string, rest: Partial<ArtifactSummary>) =>
  ({
    id,
    kind: 'visual',
    title: id,
    subject: ['queue.go'],
    currentVersion: 1,
    versions: [],
    sources: [],
    stale: false,
    staleSources: [],
    durationSec: null,
    ports: [],
    ...rest,
  }) satisfies ArtifactSummary;

describe('olderThan', () => {
  it('compares version numbers part by part', () => {
    expect(olderThan('1.4.0', '1.5.0')).toBe(true);
    expect(olderThan('1.5.0', '1.5.0')).toBe(false);
    expect(olderThan('1.10.0', '1.9.9')).toBe(false);
    expect(olderThan('1.4', '1.4.1')).toBe(true);
    expect(olderThan('', '1.0.0')).toBe(true);
  });
});

describe('scopeTitle', () => {
  it('names a scope by its definition or by the lines it is on now', () => {
    expect(scopeTitle(scope('push', 7, 12, 'Queue.Push'))).toBe('Queue.Push');
    expect(scopeTitle(scope('l4_9', 4, 9))).toBe('lines 4–9');
    const moved = { startLine: 6, endLine: 6, state: 'moved' as const };
    expect(scopeTitle(scope('l4_9', 4, 9), moved)).toBe('line 6');
    expect(scopeLines(scope('l4_9', 4, 9))).toBe('4–9');
    expect(scopeLines(scope('l4_9', 4, 9), moved)).toBe('6');
  });
});

describe('threadsOf', () => {
  const push = scope('push', 7, 12, 'Queue.Push');
  const threads = [
    thread('t1', { artifactId: 'visual-a' }),
    thread('t2', { scope: push }),
    thread('t3', { scope: { ...push, path: 'other.go' } }),
    thread('t4', { artifactId: 'film-a' }),
  ];
  it('gives a visual of a whole file the discussions about that visual', () => {
    const target = { path: 'queue.go', artifact: artifact('visual-a', {}) };
    expect(threadsOf(threads, target).map((one) => one.id)).toEqual(['t1']);
    expect(targetKey(target)).toBe('artifact:visual-a');
  });
  it('gives a scope, and a visual of that scope, the discussions about the scope', () => {
    const bare = { path: 'queue.go', scope: push };
    const scoped = {
      path: 'queue.go',
      artifact: artifact('v', { scope: push }),
    };
    expect(threadsOf(threads, bare).map((one) => one.id)).toEqual(['t2']);
    expect(threadsOf(threads, scoped).map((one) => one.id)).toEqual(['t2']);
    expect(targetKey(bare)).toBe(targetKey(scoped));
  });
  it('gives nothing to a target that names neither', () => {
    expect(threadsOf(threads, { path: 'queue.go' })).toEqual([]);
  });
});

describe('notesOf', () => {
  it('numbers the notes of one artifact, the oldest discussion first', () => {
    const note = (id: string, artifactId: string) => ({
      id,
      artifactId,
      part: 'push',
      kind: 'note' as const,
      text: id,
    });
    const answer = (notes: ReturnType<typeof note>[]) => ({
      role: 'agent' as const,
      text: 'a',
      createdAt: '',
      author: '',
      notes,
    });
    const question = (text: string) => ({
      role: 'user' as const,
      text,
      createdAt: '',
      author: '',
    });
    const threads = [
      thread('t2', {
        messages: [question('second'), answer([note('c', 'v')])],
      }),
      thread('t1', {
        messages: [
          question('first'),
          answer([note('a', 'v'), note('x', 'other'), note('b', 'v')]),
        ],
      }),
    ];
    const found = notesOf(threads, 'v');
    expect(found.map((one) => [one.n, one.id, one.question])).toEqual([
      [1, 'a', 'first'],
      [2, 'b', 'first'],
      [3, 'c', 'second'],
    ]);
    expect(found[2].threadId).toBe('t2');
  });
});

describe('scopesOf', () => {
  it('groups the discussions and visuals of a file by scope, in line order', () => {
    const push = scope('push', 7, 12, 'Queue.Push');
    const lines = scope('l2_3', 2, 3);
    const found = scopesOf(
      [
        thread('t1', {
          scope: push,
          scopeNow: { startLine: 9, endLine: 14, state: 'moved' },
        }),
        thread('t2', { scope: lines }),
        thread('t3', { artifactId: 'visual-a' }),
      ],
      [
        artifact('scoped', { scope: push }),
        artifact('whole', {}),
        artifact('elsewhere', { scope: push, subject: ['other.go'] }),
      ],
      'queue.go',
    );
    expect(found.map((one) => one.scope.id)).toEqual(['l2_3', 'push']);
    expect(found[1].now.startLine).toBe(9);
    expect(found[1].threads.map((one) => one.id)).toEqual(['t1']);
    expect(found[1].artifacts.map((one) => one.id)).toEqual(['scoped']);
    expect(found[0].now.state).toBe('same');
  });
});

describe('answerBlocks', () => {
  const refs = [
    { text: 'queue.go:7', path: 'queue.go', line: 7 },
    { text: 'queue.go:7-9', path: 'queue.go', line: 7, end: 9 },
  ];
  it('splits an answer into paragraphs, lists and code', () => {
    const blocks = answerBlocks(
      'Push appends,\nsee `queue.go:7`.\n\n- first `item`\n- at queue.go:7-9 too\n\n```\nq.items = x\n```\nDone.',
      refs,
    );
    expect(blocks.map((block) => block.kind)).toEqual([
      'paragraph',
      'list',
      'code',
      'paragraph',
    ]);
    expect(blocks[0]).toEqual({
      kind: 'paragraph',
      pieces: [
        { kind: 'text', text: 'Push appends, see ' },
        { kind: 'ref', text: 'queue.go:7', ref: refs[0] },
        { kind: 'text', text: '.' },
      ],
    });
    expect(blocks[1]).toEqual({
      kind: 'list',
      items: [
        [
          { kind: 'text', text: 'first ' },
          { kind: 'code', text: 'item' },
        ],
        [
          { kind: 'text', text: 'at ' },
          { kind: 'ref', text: 'queue.go:7-9', ref: refs[1] },
          { kind: 'text', text: ' too' },
        ],
      ],
    });
    expect(blocks[2]).toEqual({ kind: 'code', text: 'q.items = x' });
  });
  it('leaves a place that was not checked as a name from the code', () => {
    expect(answerBlocks('See `gone.go:4`.', refs)[0]).toEqual({
      kind: 'paragraph',
      pieces: [
        { kind: 'text', text: 'See ' },
        { kind: 'code', text: 'gone.go:4' },
        { kind: 'text', text: '.' },
      ],
    });
  });
});
