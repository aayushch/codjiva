/*@api
## Geometry

`CJ.route(points)` builds a path through `points` (`[[x, y], ...]`, straight segments) and returns a function
`p => [x, y]`. `p` runs from 0 (first point) to 1 (last point) and moves at constant speed along the whole
path, whatever the lengths of the individual segments. Pipes are orthogonal, so give routes only horizontal
and vertical segments that follow the pipe's centre line.

`CJ.place(el, [x, y], scale = 1, opacity = 1)` moves an SVG group to a world position and sets its scale and
opacity. Packets, tokens and other moving parts are drawn around their own centre (0, 0) and positioned with
this. To hide a part, place it with opacity 0.

```js
const route = CJ.route([[150, 550], [400, 550], [400, 250], [560, 250]]);
CJ.place(packetEl, route(CJ.eio(CJ.seg(t, 2.0, 3.4))), 1, t < 2.0 ? 0 : 1);
```
*/
CJ.route = (points) => {
  const lengths = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const l = Math.hypot(
      points[i][0] - points[i - 1][0],
      points[i][1] - points[i - 1][1],
    );
    lengths.push(l);
    total += l;
  }
  return (p) => {
    let d = Math.max(0, Math.min(1, p)) * total;
    for (let i = 0; i < lengths.length; i++) {
      if (d <= lengths[i] || i === lengths.length - 1) {
        const q = lengths[i] ? Math.min(1, d / lengths[i]) : 0;
        return [
          points[i][0] + (points[i + 1][0] - points[i][0]) * q,
          points[i][1] + (points[i + 1][1] - points[i][1]) * q,
        ];
      }
      d -= lengths[i];
    }
    return points[points.length - 1];
  };
};

CJ.place = (el, xy, scale, opacity) => {
  el.setAttribute(
    'transform',
    'translate(' +
      xy[0].toFixed(1) +
      ' ' +
      xy[1].toFixed(1) +
      ') scale(' +
      (scale == null ? 1 : scale) +
      ')',
  );
  el.style.opacity = opacity == null ? 1 : opacity;
};
