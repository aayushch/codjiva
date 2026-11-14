// Unit tests for the parts of the runtime that are pure maths and need no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntime } from '../load-runtime.mjs';

const { CJ, makeWarp, DEFAULT_SPEED, holdForWords, countWords, framingAt } =
  loadRuntime(['00-kit.js', '10-geom.js', '20-parts.js', '30-warp.js', '40-camera.js'], ['makeWarp', 'DEFAULT_SPEED', 'holdForWords', 'countWords', 'framingAt']);

const close = (a, b, slack = 1e-6) => assert.ok(Math.abs(a - b) <= slack, `${a} is not within ${slack} of ${b}`);

test('without bubbles, playback runs at the base speed', () => {
  const warp = makeWarp([], [], DEFAULT_SPEED);
  close(warp.tau(10), 6, 1e-3);
  close(warp.realAt(6), 10, 1e-3);
});

test('a bubble slows time down for as long as it is held', () => {
  const warp = makeWarp([3], [5], DEFAULT_SPEED);
  // The bubble is due at animation second 3, which is real second 5 at base speed.
  close(warp.starts[0], 5, 0.02);
  // During the hold the animation advances far less than it would at base speed.
  const during = warp.tau(warp.starts[0] + 5) - warp.tau(warp.starts[0]);
  assert.ok(during < 1.0, `advanced ${during} animation seconds during a 5 second hold`);
  assert.ok(during > 0.5, `advanced ${during} animation seconds during a 5 second hold`);
});

test('a bubble that is due while another is up waits for it', () => {
  const warp = makeWarp([1, 1.1], [5, 5], DEFAULT_SPEED);
  assert.ok(warp.starts[1] >= warp.starts[0] + 5, `second bubble started at ${warp.starts[1]}, first at ${warp.starts[0]}`);
});

test('realAt is the inverse of tau', () => {
  const warp = makeWarp([1.2, 4], [5, 6], DEFAULT_SPEED);
  for (const real of [0.5, 3, 7.25, 12, 20]) close(warp.realAt(warp.tau(real)), real, 1e-6);
});

test('a chapter with one bubble and a chapter with five come out at known lengths', () => {
  const oneBubble = makeWarp([5.2], [5.5], DEFAULT_SPEED);
  close(oneBubble.realAt(8.3), 18, 1e-3);
  const fiveBubbles = makeWarp([1.0, 2.1, 6.6, 9.0, 12.0], [5, 5, 5.5, 5.5, 5], DEFAULT_SPEED);
  close(fiveBubbles.realAt(14.65), 44, 1e-3);
});

test('hold time grows with the word count between 4.5 and 6.5 seconds', () => {
  assert.equal(holdForWords(3), 4.5);
  close(holdForWords(14), 1.6 + 0.28 * 14);
  assert.equal(holdForWords(60), 6.5);
});

test('word count ignores tags and includes the kicker', () => {
  assert.equal(countWords('LIMIT HIT', '<code>add()</code> calls <code>flush()</code> now'), 6);
});

test('a route moves at constant speed along its whole length', () => {
  const route = CJ.route([[0, 0], [100, 0], [100, 300]]);
  assert.deepEqual(Array.from(route(0)), [0, 0]);
  assert.deepEqual(Array.from(route(0.25)), [100, 0]);
  assert.deepEqual(Array.from(route(0.625)), [100, 150]);
  assert.deepEqual(Array.from(route(1)), [100, 300]);
  assert.deepEqual(Array.from(route(7)), [100, 300]);
});

test('strikes are full under a packet and zero beyond reach', () => {
  assert.deepEqual(Array.from(CJ.strikes([100, 200], [100])), [1, 0]);
  close(CJ.strikes([100], [125])[0], 0.5);
});

test('the seeded random sequence repeats', () => {
  const a = CJ.rng(42);
  const b = CJ.rng(42);
  const first = [a(), a(), a()];
  assert.deepEqual(first, [b(), b(), b()]);
  assert.ok(first.every((v) => v >= 0 && v < 1));
  assert.notEqual(CJ.rng(43)(), first[0]);
});

test('the camera holds, moves with easing, and holds again', () => {
  const keys = [{ cx: 0, cy: 0, z: 1 }, { t: 1, dur: 2, cx: 100, cy: 50, z: 2 }];
  assert.deepEqual({ ...framingAt(keys, 0.5) }, { cx: 0, cy: 0, z: 1 });
  assert.deepEqual({ ...framingAt(keys, 2) }, { cx: 50, cy: 25, z: 1.5 });
  assert.deepEqual({ ...framingAt(keys, 9) }, { cx: 100, cy: 50, z: 2 });
});

test('text width is exact for the monospace stage font', () => {
  close(CJ.textWidth('len(batch)'), 108);
  close(CJ.textWidth('abc', 44), 79.2);
});
