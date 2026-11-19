// The memory of the Handler in internal/orders/handler.go as events arrive, restated one step at
// a time. Each character of the input is one event:
//   o  a standard order that the limiter allows
//   d  a standard order that the limiter defers
//   p  a priority order
//   t  the 2 second tick of flushLoop
// Every other character is read as a standard order.

const FILE = 'internal/orders/handler.go';
const MAX_BATCH = 64; // maxBatch (handler.go:14)

CJ.defineSim({
  init() {
    // batch, deferred: the ids of the orders in h.batch and h.deferred. seen: every id submitted.
    // store: the ids the Store has received. tick: 0, or 1 when a tick has released the deferred
    // orders and still has to flush.
    return { p: 0, seq: 0, batch: [], deferred: [], seen: [], store: [], tick: 0, fresh: null };
  },

  step(m, input) {
    m.fresh = null;
    if (m.tick === 1) {
      // The second half of a tick: flushLocked (handler.go:263-269).
      m.tick = 0;
      const n = m.batch.length;
      m.store = m.store.concat(m.batch);
      m.batch = [];
      return { state: 'flush', does: ['Store.WriteBatch(h.batch)', 'h.batch = h.batch[:0]'],
        note: n ? 'The tick writes ' + n + ' order' + (n === 1 ? '' : 's') + ' with one call and empties the batch.' : 'The batch is empty, so nothing is written.',
        tone: 'ok', ref: FILE + ':263' };
    }
    if (m.p >= input.length) return null;
    const at = m.p++;
    const ch = input[at];

    if (ch === 't') {
      // The first half of a tick: releaseDeferred (handler.go:252).
      m.tick = 1;
      const n = m.deferred.length;
      m.batch = m.batch.concat(m.deferred);
      m.deferred = [];
      return { state: 'release', at, does: ['h.batch = append(h.batch, h.deferred...)', 'h.deferred = h.deferred[:0]'],
        note: n ? n + ' deferred order' + (n === 1 ? ' joins' : 's join') + ' the end of the batch.' : 'No order is deferred, so the batch stays as it is.',
        ref: FILE + ':252' };
    }

    // An order: Submit remembers its ID, and process stamps it (handler.go:132, 193).
    m.seq++;
    const id = '#' + m.seq;
    m.seen.push(id);
    m.fresh = id;
    if (ch === 'd') {
      m.deferred.push(id);
      return { state: 'submit', at, does: ['h.seen[o.ID] = struct{}{}', 'h.deferred = append(h.deferred, o)'],
        note: 'The limiter defers this order. It is held back until the next tick.', tone: 'warn', ref: FILE + ':147' };
    }
    if (ch === 'p') {
      m.store.push(id);
      return { state: 'submit', at, does: ['h.seen[o.ID] = struct{}{}', 'h.store.WriteBatch([]Order{o})'],
        note: 'A priority order is written at once and never enters the batch.', tone: 'ok', ref: FILE + ':150' };
    }
    m.batch.push(id);
    if (m.batch.length >= MAX_BATCH) {
      // handler.go:206: the order that fills the batch triggers the flush.
      const n = m.batch.length;
      m.store = m.store.concat(m.batch);
      m.batch = [];
      return { state: 'enqueue', at, does: ['h.batch = append(h.batch, o)', 'len(h.batch) >= maxBatch', 'h.flushLocked()'],
        note: 'This order fills the batch. All ' + n + ' orders are written and the batch is emptied.', tone: 'ok', ref: FILE + ':206' };
    }
    return { state: 'enqueue', at, does: ['h.seen[o.ID] = struct{}{}', 'h.batch = append(h.batch, o)'],
      note: 'The order waits in the batch for a flush.', ref: FILE + ':205' };
  },

  vars(m) {
    return { 'len(h.batch)': m.batch.length, 'len(h.deferred)': m.deferred.length, 'h.nextSequence': m.seq };
  },

  outputs(m) {
    return { written: m.store.length, 'h.batch': m.batch.length };
  },

  // What is in memory: the two slices of the Handler, the IDs it has seen, and what the Store holds.
  // The order of this step is amber wherever it is.
  structure(m) {
    const tones = (list) => {
      const found = {};
      list.forEach((id, i) => { if (id === m.fresh) found[i] = 'primary'; });
      return found;
    };
    const last = (list, n) => list.slice(Math.max(0, list.length - n));
    return { blocks: [
      { kind: 'array', label: 'h.batch · orders waiting for a flush', cells: m.batch, tones: tones(m.batch) },
      { kind: 'array', label: 'h.deferred · held back by the soft rate limit', cells: m.deferred, tones: tones(m.deferred) },
      { kind: 'list', label: 'the Store · the last orders it received, oldest first', items: last(m.store, 12), tones: tones(last(m.store, 12)) },
      { kind: 'table', label: 'h.seen · the last IDs submitted', rows: last(m.seen, 4).map((id) => [id, 'struct{}{}']) },
    ] };
  },
});
