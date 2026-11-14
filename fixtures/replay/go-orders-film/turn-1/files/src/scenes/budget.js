// Chapter 2: the pending-bytes budget. Bytes rise past the soft mark and the Handler switches to
// ModeShedding, so a low-value order is only counted. The bytes then rise past the hard mark:
// the Handler switches to ModeStopped and ErrOverloaded travels back to the intake side. This is
// a fork; the next chapter rewinds it.
const { seg, eio, eo, eob, lerp } = CJ;

CJ.scene('budget', {
  init(ctx) {
    const c = ctx.c;
    let packets = '';
    for (let i = 0; i < 4; i++) packets += CJ.markedPacket(c('rb' + i), { marks: 3 });
    packets += CJ.markedPacket(c('sh'), { marks: 3 }) + CJ.warning(c('wn'));
    ctx.mount({ extraSvg: CJ.ring(c('rs'), 1874, 490, 20) + CJ.ring(c('rh'), 1874, 255, 20) + packets });
    this.rest = [0, 1, 2, 3].map((i) => {
      const r = CJ.markedPacket.refs(ctx.q, 'rb' + i);
      CJ.revealMarks(r, 0, ctx.P.stepXs, true);
      return r;
    });
    this.slots = [0, 1, 2, 3].map((i) => ctx.routes.queued(i)(1));
    this.sh = CJ.markedPacket.refs(ctx.q, 'sh');
    this.wn = ctx.q('wn');
    this.rs = ctx.q('rs');
    this.rh = ctx.q('rh');
  },
  render(t, ctx) {
    this.rest.forEach((r, i) => CJ.place(r.g, this.slots[i], 1, 1));

    // Pending bytes: up to the soft mark, a little more, then up to the hard mark.
    const level = 0.34 + 0.18 * eio(seg(t, 1.0, 1.9)) + 0.08 * eio(seg(t, 2.6, 3.2)) + 0.37 * eio(seg(t, 4.4, 5.3));
    const soft = seg(t, 2.0, 2.4);
    const hard = seg(t, 5.4, 5.8);
    this.rs.style.opacity = t > 1.8 && t < 2.8 ? 0.8 * Math.sin(seg(t, 1.8, 2.8) * Math.PI) : 0;
    this.rh.style.opacity = t > 5.2 && t < 6.2 ? 0.8 * Math.sin(seg(t, 5.2, 6.2) * Math.PI) : 0;

    // A low-value order in ModeShedding runs to the switch and falls into the second drop bin.
    const a = seg(t, 2.7, 4.1);
    const sxy = ctx.routes.shed(eio(a));
    CJ.place(this.sh.g, sxy, 1, a <= 0 ? 0 : 1 - seg(t, 4.1, 4.3));
    CJ.revealMarks(this.sh, sxy[0], ctx.P.stepXs, a >= 1);

    // ErrOverloaded: the warning pops at the hard mark, then follows the control wire to Submit.
    const pop = seg(t, 5.5, 6.0);
    const trip = seg(t, 5.8, 7.3);
    CJ.place(this.wn, ctx.routes.error(eio(trip)), lerp(0.3, 1.25, eob(pop, 1.8)), pop <= 0 ? 0 : 1 - eo(seg(t, 7.3, 7.7)));

    ctx.set({
      level,
      lamps: [eo(seg(t, 1.8, 2.1)), eo(seg(t, 5.2, 5.5))],
      mode: [1 - soft, soft * (1 - hard), hard],
      gauge: 4 / 64,
      press: CJ.strikes(ctx.P.stepXs, [a > 0 && a < 1 ? sxy[0] : -999]),
      wires: [eo(seg(t, 1.8, 2.2)), seg(t, 5.3, 5.6), 0],
    }, t);
  },
});
