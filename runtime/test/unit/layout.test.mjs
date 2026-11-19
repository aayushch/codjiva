// Unit tests for the layout helpers of the data-driven views. They are pure
// functions, so they are tested in Node without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRuntime } from '../load-runtime.mjs';

const { fitText, layeredLayout, connector, treeLayout } = loadRuntime(
  ['00-kit.js', '71-layout.js'],
  ['fitText', 'layeredLayout', 'connector', 'treeLayout'],
);

// A plain copy, because a value made inside the runtime's own context is not
// equal to one made here even when it holds the same things.
const plain = (value) => JSON.parse(JSON.stringify(value));

test('a text that fits is kept, and a longer one ends with an ellipsis', () => {
  // 14 px text: every character is 8.4 px wide, so 84 px hold 10 characters.
  assert.equal(fitText('handler.go', 84, 14), 'handler.go');
  assert.equal(fitText('handler_test.go', 84, 14), 'handler_t…');
  assert.equal(fitText(null, 84, 14), '');
  assert.equal(fitText('abc', 1, 14), 'a');
});

const box = (id, w = 200, h = 100) => ({ id, w, h });

test('boxes are ranked by the arrows that point at them', () => {
  const layout = layeredLayout(
    [box('c'), box('a'), box('b'), box('alone')],
    [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'a', to: 'c' },
      { from: 'a', to: 'nowhere' },
    ],
    { x0: 100, y0: 50, gapX: 130, gapY: 30 },
  );
  // a and alone have no arrow pointing at them. b is one step from a. c is
  // two steps from a, because the longest way to it goes through b.
  assert.deepEqual(
    plain(['a', 'alone', 'b', 'c'].map((id) => layout.at[id].col)),
    [0, 0, 1, 2],
  );
  assert.deepEqual(plain(layout.at.a), {
    x: 100,
    y: 50,
    w: 200,
    h: 100,
    col: 0,
  });
  // The second box of a column is under the first, with the gap between.
  assert.equal(layout.at.alone.y, 180);
  // Columns are a column's width and the gap apart.
  assert.equal(layout.at.b.x, 430);
  assert.equal(layout.w, 860);
  assert.equal(layout.h, 230);
});

test('a cycle does not stop the ranking', () => {
  const layout = layeredLayout(
    [box('a'), box('b')],
    [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
      { from: 'a', to: 'a' },
    ],
  );
  assert.deepEqual(plain([layout.at.a.col, layout.at.b.col].sort()), [0, 1]);
});

test('a column that would be too tall is split into several', () => {
  const boxes = ['a', 'b', 'c', 'd', 'e'].map((id) => box(id, 200, 100));
  const layout = layeredLayout(boxes, [], { gapY: 20, maxH: 250 });
  // Two boxes and the gap between them are 220 px. A third would make 340.
  assert.deepEqual(
    plain(boxes.map((b) => layout.at[b.id].col)),
    [0, 0, 1, 1, 2],
  );
  assert.equal(layout.cols.length, 3);
});

test('an arrow enters a later box from the left and an earlier one from the right', () => {
  const layout = layeredLayout(
    [box('a'), box('b'), box('c')],
    [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ],
    { x0: 0, y0: 100, gapX: 130 },
  );
  const { a, b, c } = layout.at;
  // Forward: out of a's right edge, down the gap, into b's left edge.
  assert.equal(
    connector(a, b, 120, 150, layout.cols, 0, 60),
    'M200 120 H224 V150 H330',
  );
  // A second arrow from the same column turns 12 px further right.
  assert.match(connector(a, b, 120, 150, layout.cols, 1, 60), /H236 /);
  // Backward: over the top of the layout, into a's right edge.
  assert.equal(
    connector(c, a, 120, 150, layout.cols, 0, 60),
    'M860 120 H884 V60 H224 V150 H200',
  );
  // To a box of the same column: into its right edge.
  assert.equal(
    connector(a, { ...a, y: 300 }, 120, 320, layout.cols, 0, 60),
    'M200 120 H224 V320 H200',
  );
});

test('a tree puts leaves side by side and a parent over its children', () => {
  const leaf = (value) => ({ value, children: [] });
  const tree = treeLayout(
    {
      value: 8,
      children: [{ value: 3, children: [leaf(1), leaf(6)] }, leaf(10)],
    },
    80,
    70,
  );
  const at = Object.fromEntries(
    tree.nodes.map((entry) => [entry.node.value, [entry.x, entry.y]]),
  );
  // Three leaves take three slots of 80 px.
  assert.deepEqual(at[1], [40, 140]);
  assert.deepEqual(at[6], [120, 140]);
  assert.deepEqual(at[10], [200, 70]);
  // 3 is over the middle of 1 and 6, and the root over the middle of 3 and 10.
  assert.deepEqual(at[3], [80, 70]);
  assert.deepEqual(at[8], [140, 0]);
  assert.equal(tree.w, 240);
  assert.equal(tree.h, 210);
  // Every node but the root knows its parent.
  assert.equal(tree.nodes.filter((entry) => entry.parent < 0).length, 1);
});

test('an empty place keeps a child on its own side', () => {
  // A node with a right child only: the empty left place takes the first
  // slot, so the child is to the right of its parent.
  const tree = treeLayout(
    { value: 5, children: [null, { value: 9, children: [] }] },
    80,
    70,
  );
  const child = tree.nodes.find((entry) => entry.node.value === 9);
  const root = tree.nodes.find((entry) => entry.node.value === 5);
  assert.equal(child.x, 120);
  assert.equal(root.x, 80);
  assert.equal(treeLayout(null, 80, 70).nodes.length, 0);
});
