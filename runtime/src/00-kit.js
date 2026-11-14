// The Codjiva runtime: the code every generated visual and film runs on.
//
// The builder joins all files in runtime/src in file-name order and wraps them in one function.
// So the `const` declarations in this file are visible to the later runtime files, and hidden
// from the plant and scene files an agent writes. Agent code reaches the runtime only through
// the global object `CJ`.
//
// Comment blocks that start with `/*@api` are documentation for agents. The builder removes them
// from built artifacts and collects them into the runtime API reference that is added to prompts.

const CJ = {};
window.CJ = CJ;

// The stage is a fixed 1920 x 1080 box. The top HUD_H pixels hold the chapter title. The rest is
// the view, a window onto the drawn world.
const STAGE_W = 1920;
const STAGE_H = 1080;
const HUD_H = 110;
const VIEW_W = STAGE_W;
const VIEW_H = STAGE_H - HUD_H;

CJ.W = STAGE_W;
CJ.H = STAGE_H;

/*@api
## Time and easing

All of these are pure functions. `x` is a progress value from 0 to 1 unless stated otherwise.

| Function | Returns |
|----------|---------|
| `CJ.seg(t, a, b)` | Progress of `t` through the interval `a`..`b`, clamped to 0..1. Use it to turn a time into a progress value. |
| `CJ.lerp(a, b, x)` | The value `x` of the way from `a` to `b`. |
| `CJ.clamp01(x)` | `x` limited to 0..1. |
| `CJ.clamp(x, a, b)` | `x` limited to `a`..`b`. |
| `CJ.eo(x)` | Ease out (fast start, soft landing). Use for arrivals. |
| `CJ.ei(x)` | Ease in (soft start). Use for departures and the down-stroke of a press. |
| `CJ.eio(x)` | Ease in and out. Use for travel along a route. |
| `CJ.eob(x, s = 1.4)` | Ease out with a small overshoot. Use only for small pops, `s` between 1.4 and 1.8. |
| `CJ.smooth(x)` | Smoothstep. The camera uses it. |
| `CJ.win(t, a, b, fade = 0.35)` | 0..1 visibility of something shown from time `a` to time `b`, fading in and out over `fade` seconds. |
| `CJ.rng(seed)` | A function that returns the next number of a repeatable random sequence in 0..1. `Math.random` is forbidden; use this when you need variety. |
*/
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

CJ.clamp01 = clamp01;
CJ.clamp = (x, a, b) => Math.min(b, Math.max(a, x));
CJ.seg = (t, a, b) => clamp01((t - a) / (b - a));
CJ.lerp = (a, b, x) => a + (b - a) * x;
CJ.eo = (x) => { x = clamp01(x); return 1 - Math.pow(1 - x, 3); };
CJ.ei = (x) => { x = clamp01(x); return x * x * x; };
CJ.eio = (x) => { x = clamp01(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
CJ.eob = (x, s) => {
  x = clamp01(x);
  const k = s == null ? 1.4 : s;
  const c3 = k + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + k * Math.pow(x - 1, 2);
};
CJ.smooth = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };
CJ.win = (t, a, b, fade) => {
  const f = fade == null ? 0.35 : fade;
  return Math.min(1, Math.max(0, (t - a) / f)) * Math.min(1, Math.max(0, (b - t) / f));
};
CJ.rng = (seed) => {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let r = Math.imul(s ^ (s >>> 15), 1 | s);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
};

/*@api
## Text helpers

| Function | Returns |
|----------|---------|
| `CJ.esc(text)` | `text` with `&`, `<`, `>` and `"` escaped, safe to put inside HTML. |
| `CJ.textWidth(text, size = 18)` | The width in px of one line of `text` at font size `size`. Every character of the stage font is 0.6 of the font size wide, so this is exact. Use it to check that a label fits before you place it. |
*/
CJ.esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
CJ.textWidth = (text, size) => String(text).length * (size == null ? 18 : size) * 0.6;

// Turns an HTML string into one element. A string with several top-level elements is wrapped in
// a box that does not affect layout.
const elementFromHtml = (html) => {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html).trim();
  if (tpl.content.childElementCount === 1) return tpl.content.firstElementChild;
  const box = document.createElement('div');
  box.style.display = 'contents';
  box.append(tpl.content);
  return box;
};

// Rounds to two decimals and drops trailing zeros, for coordinates written into markup.
const r2 = (x) => String(Math.round(x * 100) / 100);
