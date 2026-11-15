// Slow motion around bubbles.
//
// A scene is authored in animation seconds. Playback runs slower than that: at
// the base speed normally, and at the much slower reading speed while a bubble
// is on screen. `makeWarp` builds the mapping from real seconds (what the clock
// and the scrubber count) to animation seconds (what a scene's render function
// receives).

// Default speeds. `base` is animation seconds per real second in normal
// playback. `slow` is the same while a bubble is up. `ramp` is the real time,
// in seconds, taken to change between them.
const DEFAULT_SPEED = { base: 0.6, slow: 0.1, ramp: 0.5 };

// The mapping is tabulated in steps of WARP_STEP real seconds, up to WARP_MAX
// real seconds.
const WARP_STEP = 1 / 120;
const WARP_MAX = 300;

// How long a bubble stays up, in real seconds, when its author gives no hold
// time. It grows with the number of words (kicker included) and stays between
// 4.5 and 6.5 seconds.
const holdForWords = (words) =>
  Math.min(6.5, Math.max(4.5, 1.6 + 0.28 * words));

// Counts the words a viewer has to read in a bubble: the kicker plus the body
// with tags removed.
const countWords = (kicker, html) => {
  const text = (
    String(kicker || '') +
    ' ' +
    String(html || '').replace(/<[^>]*>/g, ' ')
  ).trim();
  return text ? text.split(/\s+/).length : 0;
};

// beats: the animation time at which each bubble is due, in order.
// holds: how many real seconds each bubble stays up.
//
// Returns:
//   - `tau(tReal)`: the animation time for a real time.
//   - `starts[i]`: the real time at which bubble i appears. A bubble that is
//     due while the previous one is still up waits until the previous one has
//     gone.
//   - `realAt(tAnim)`: the real time at which the animation reaches tAnim. It
//     is the inverse of `tau`.
const makeWarp = (beats, holds, speed) => {
  const base = speed.base;
  const slow = speed.slow;
  const ramp = speed.ramp;
  const table = [0];
  const starts = [];
  let tau = 0;
  let next = 0;
  let holdStart = -1;
  const steps = Math.round(WARP_MAX / WARP_STEP);
  for (let k = 1; k < steps; k++) {
    const t = k * WARP_STEP;
    let rate = base;
    if (holdStart >= 0) {
      const into = t - holdStart;
      const hold = holds[next];
      if (into >= hold) {
        holdStart = -1;
        next++;
      } else {
        const r = Math.max(0, Math.min(1, into / ramp, (hold - into) / ramp));
        rate = base - (base - slow) * r * r * (3 - 2 * r);
      }
    }
    if (holdStart < 0 && next < beats.length && tau >= beats[next]) {
      holdStart = t;
      starts[next] = t;
    }
    tau += rate * WARP_STEP;
    table.push(tau);
  }
  const last = table.length - 1;
  return {
    starts,
    holds,
    tau(tReal) {
      const x = Math.max(0, tReal) / WARP_STEP;
      const k = Math.floor(x);
      if (k >= last) return table[last];
      return table[k] + (table[k + 1] - table[k]) * (x - k);
    },
    realAt(tAnim) {
      if (tAnim <= 0) return 0;
      if (tAnim >= table[last]) return last * WARP_STEP;
      let lo = 0;
      let hi = last;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (table[mid] < tAnim) lo = mid;
        else hi = mid;
      }
      const span = table[hi] - table[lo];
      return (lo + (span > 0 ? (tAnim - table[lo]) / span : 0)) * WARP_STEP;
    },
  };
};

CJ.warp = (beats, holds, speed) =>
  makeWarp(beats, holds, Object.assign({}, DEFAULT_SPEED, speed || {}));
