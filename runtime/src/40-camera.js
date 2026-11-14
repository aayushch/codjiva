// The camera: how the 1920 x 1080 world is mapped into the view below the title band.

// The world is drawn slightly smaller than its nominal zoom, so a zoom of 1 shows the whole sheet
// inside the view with a margin.
const CAMERA_SCALE = 0.85;
const VIEW_CX = VIEW_W / 2;
const VIEW_CY = VIEW_H / 2;

// Computes the framing at animation time `t`.
//
// keys[0] is the starting framing { cx, cy, z }. Every later key { t, dur, cx, cy, z } is a move
// that starts at `t`, lasts `dur` and ends on that framing. Moves ease with smoothstep and the
// framing does not change between moves.
const framingAt = (keys, t) => {
  let cx = keys[0].cx;
  let cy = keys[0].cy;
  let z = keys[0].z;
  for (let i = 1; i < keys.length; i++) {
    const key = keys[i];
    const k = Math.min(1, Math.max(0, (t - key.t) / key.dur));
    if (k <= 0) break;
    const e = k * k * (3 - 2 * k);
    cx += (key.cx - cx) * e;
    cy += (key.cy - cy) * e;
    z += (key.z - z) * e;
  }
  return { cx, cy, z };
};

// Writes a framing to the world element. `scale` is the framing's zoom times CAMERA_SCALE.
const applyFraming = (worldEl, cx, cy, scale) => {
  worldEl.style.transform = 'translate(' + (VIEW_CX - cx * scale).toFixed(3) + 'px,' + (VIEW_CY - cy * scale).toFixed(3) + 'px) scale(' + scale.toFixed(5) + ')';
};

// Returns a function cam(t) that moves the world element to the framing at animation time t.
// After each call, cam.s holds the live framing { cx, cy, z } with z already multiplied by
// CAMERA_SCALE. Bubble clamping reads it to convert world positions to view positions.
const makeCamera = (worldEl, keys) => {
  worldEl.style.transformOrigin = '0 0';
  const cam = (t) => {
    const f = framingAt(keys, t);
    const scale = f.z * CAMERA_SCALE;
    cam.s = { cx: f.cx, cy: f.cy, z: scale };
    applyFraming(worldEl, f.cx, f.cy, scale);
  };
  cam.keys = keys;
  return cam;
};

CJ.camera = makeCamera;
