// Layout helpers for the data-driven views (72-views.js). A view is drawn
// from data that holds no coordinates, so these functions decide where
// everything goes. They are pure: the same input always gives the same
// positions, and none of them touches the page.

// Cuts `text` so that it is at most `width` px wide at font size `size`, and
// ends a cut text with an ellipsis. Every character of the stage font is 0.6
// of the font size wide, so the result always fits.
const fitText = (text, width, size) => {
  const all = String(text == null ? '' : text);
  const most = Math.max(1, Math.floor(width / (size * 0.6)));
  if (all.length <= most) return all;
  return most <= 1 ? all.slice(0, 1) : all.slice(0, most - 1) + '…';
};

// Places boxes in columns so that the arrows between them run mostly from
// left to right.
//
// `boxes` is a list of `{ id, w, h }`. `edges` is a list of `{ from, to }`
// that name boxes by id; an edge that names an unknown box is ignored.
//
// Each box gets a rank: 0 for a box that no edge points at, and otherwise one
// more than the highest rank among the boxes that point at it. An edge that
// would close a cycle is left out of the ranking, so every box gets a rank.
// Boxes of one rank form a column, in the order they were given. A column
// taller than `opts.maxH` is split into several columns side by side.
//
// `opts`: `x0`, `y0` (the top-left corner of the layout), `gapX` (between
// columns), `gapY` (between boxes of a column), `maxH`.
//
// Returns:
//   - `at`: by box id, `{ x, y, w, h, col }`, where `col` is the index of the
//     box's column.
//   - `cols`: for each column, `{ x, w }`.
//   - `w`, `h`: the size of the whole layout.
const layeredLayout = (boxes, edges, opts) => {
  const o = opts || {};
  const x0 = o.x0 || 0;
  const y0 = o.y0 || 0;
  const gapX = o.gapX == null ? 130 : o.gapX;
  const gapY = o.gapY == null ? 36 : o.gapY;
  const maxH = o.maxH == null ? 820 : o.maxH;
  const byId = {};
  boxes.forEach((box) => {
    byId[box.id] = box;
  });
  const into = {};
  boxes.forEach((box) => {
    into[box.id] = [];
  });
  (edges || []).forEach((edge) => {
    if (byId[edge.from] && byId[edge.to] && edge.from !== edge.to)
      into[edge.to].push(edge.from);
  });
  // The rank of a box, worked out from the boxes that point at it. `open`
  // holds the boxes whose rank is being worked out. An edge from one of those
  // closes a cycle and is skipped.
  const rank = {};
  const open = {};
  const rankOf = (id) => {
    if (rank[id] != null) return rank[id];
    open[id] = true;
    let most = -1;
    into[id].forEach((from) => {
      if (!open[from]) most = Math.max(most, rankOf(from));
    });
    open[id] = false;
    rank[id] = most + 1;
    return rank[id];
  };
  boxes.forEach((box) => rankOf(box.id));

  // The columns: the boxes of each rank, split where a column would be
  // taller than `maxH`.
  const columns = [];
  const ranks = boxes.reduce((most, box) => Math.max(most, rank[box.id]), 0);
  for (let r = 0; r <= ranks; r++) {
    let column = [];
    let height = 0;
    boxes
      .filter((box) => rank[box.id] === r)
      .forEach((box) => {
        const added = (column.length ? gapY : 0) + box.h;
        if (column.length && height + added > maxH) {
          columns.push(column);
          column = [];
          height = 0;
        }
        height += (column.length ? gapY : 0) + box.h;
        column.push(box);
      });
    if (column.length) columns.push(column);
  }

  const at = {};
  const cols = [];
  let x = x0;
  let tallest = 0;
  columns.forEach((column, index) => {
    const width = column.reduce((most, box) => Math.max(most, box.w), 0);
    let y = y0;
    column.forEach((box) => {
      at[box.id] = { x, y, w: box.w, h: box.h, col: index };
      y += box.h + gapY;
    });
    tallest = Math.max(tallest, y - gapY - y0);
    cols.push({ x, w: width });
    x += width + gapX;
  });
  return {
    at,
    cols,
    w: Math.max(0, x - gapX - x0),
    h: tallest,
  };
};

// The path of an arrow from box `a` to box `b`, as an SVG path of M, H and V
// segments. `a` and `b` are entries of `layeredLayout().at`, and `cols` its
// `cols`.
//
// The arrow leaves the right edge of `a` at height `ya`, and turns in the gap
// to the right of `a`'s column. `lane` (0 to 5) moves that turn sideways, so
// that several arrows that leave one column do not lie on each other.
//   - If `b` is in a later column, the arrow enters `b` from the left.
//   - If `b` is in the same column, it enters `b` from the right.
//   - If `b` is in an earlier column, it runs above the whole layout, at
//     height `top`, and enters `b` from the right.
const connector = (a, b, ya, yb, cols, lane, top) => {
  const shift = 24 + (lane || 0) * 12;
  const turn = cols[a.col].x + cols[a.col].w + shift;
  const start = 'M' + r2(a.x + a.w) + ' ' + r2(ya) + ' H' + r2(turn);
  if (b.col > a.col) return start + ' V' + r2(yb) + ' H' + r2(b.x);
  if (b.col === a.col) return start + ' V' + r2(yb) + ' H' + r2(b.x + b.w);
  const back = cols[b.col].x + cols[b.col].w + shift;
  return (
    start +
    ' V' +
    r2(top) +
    ' H' +
    r2(back) +
    ' V' +
    r2(yb) +
    ' H' +
    r2(b.x + b.w)
  );
};

// Places the nodes of a tree. `root` is `{ children: [...] }`, where a child
// may be null to keep an empty place, as the missing left child of a binary
// tree. `slot` is the width given to each leaf and `level` the height of one
// level.
//
// Leaves are placed left to right, one slot each, and a parent is centred
// over its children. Returns `nodes`, a list of `{ node, x, y, parent }` with
// `x` and `y` as the centre of the node and `parent` the index of its parent
// in the list (or -1), and the size `w`, `h` of the whole tree.
const treeLayout = (root, slot, level) => {
  const nodes = [];
  let leaves = 0;
  let deepest = 0;
  const place = (node, depth, parent) => {
    const index = nodes.length;
    const entry = { node, x: 0, y: depth * level, parent };
    nodes.push(entry);
    deepest = Math.max(deepest, depth);
    // The x of every child, in order. An empty place takes one slot and has
    // the x of that slot's middle, so that the child beside it stays on its
    // own side of the parent.
    const xs = (node.children || []).map((child) => {
      if (child) return nodes[place(child, depth + 1, index)].x;
      leaves++;
      return (leaves - 0.5) * slot;
    });
    if (xs.length) entry.x = (xs[0] + xs[xs.length - 1]) / 2;
    else {
      // A node without children is a leaf and takes one slot itself.
      leaves++;
      entry.x = (leaves - 0.5) * slot;
    }
    return index;
  };
  if (root) place(root, 0, -1);
  return { nodes, w: Math.max(1, leaves) * slot, h: (deepest + 1) * level };
};
