// Chapter 3: the way the run really goes. For the first 1.6 seconds the budget chapter plays
// backwards, from the end of the fork to the moment before the hard limit. Then the flush tick
// writes the batch to the Store and the pending bytes fall. Close repeats this flush at the end.
const { seg, eio, eo, eob, lerp, clamp01 } = CJ;

CJ.scene('flush', {
  init(ctx) {
    const c = ctx.c;
    let packets = '';
    for (let i = 0; i < 4; i++) packets += CJ.markedPacket(c('rb' + i), { marks: 3 });
    packets += CJ.packet('batch', c('cr')) + CJ.warning(c('wn'));
    ctx.mount({ extraSvg: CJ.ring(c('rs'), 1874, 490, 20) + CJ.ring(c('rh'), 1874, 255, 20) + packets });
    this.rest = [0, 1, 2, 3].map((i) => {
      const r = CJ.markedPacket.refs(ctx.q, 'rb' + i);
      CJ.revealMarks(r, 0, ctx.P.stepXs, true);
      return r;
    });
    this.slots = [0, 1, 2, 3].map((i) => ctx.routes.queued(i)(1));
    this.cr = ctx.q('cr');
    this.wn = ctx.q('wn');
    this.rs = ctx.q('rs');
    this.rh = ctx.q('rh');
  },
  render(t, ctx) {
    // Rewind: `u` is the time of the budget chapter that is shown, running from 7.8 back to 4.4.
    const rewinding = t < 1.6;
    const u = rewinding ? lerp(7.8, 4.4, eio(t / 1.6)) : 4.4;

    const fade = eo(seg(t, 2.5, 2.9));
    this.rest.forEach((r, i) => CJ.place(r.g, this.slots[i], 1, rewinding ? 1 : 1 - fade));

    // The crate forms in the batch bin, travels through flushLocked and enters the Store.
    const fp = seg(t, 2.9, 4.3);
    CJ.place(this.cr, ctx.routes.flush(eio(fp)), 1, rewinding ? 0 : (fp <= 0 ? fade : 1 - seg(t, 4.3, 4.6)));

    // Pending bytes fall once the write has succeeded.
    const level = rewinding
      ? 0.34 + 0.18 + 0.08 + 0.37 * eio(seg(u, 4.4, 5.3))
      : lerp(0.6, 0.3, eio(seg(t, 4.0, 4.8)));
    const lampSoft = rewinding ? eo(seg(u, 1.8, 2.1)) : clamp01((level - 0.46) / 0.08);
    const lampHard = rewinding ? eo(seg(u, 5.2, 5.5)) : 0;
    const hard = rewinding ? seg(u, 5.4, 5.8) : 0;

    this.rs.style.opacity = 0;
    this.rh.style.opacity = rewinding && u > 5.2 && u < 6.2 ? 0.8 * Math.sin(seg(u, 5.2, 6.2) * Math.PI) : 0;

    // The warning of the fork travels back along the wire and shrinks into the hard mark.
    const pop = seg(u, 5.5, 6.0);
    CJ.place(this.wn, ctx.routes.error(eio(seg(u, 5.8, 7.3))), lerp(0.3, 1.25, eob(pop, 1.8)), rewinding && pop > 0 ? 1 - eo(seg(u, 7.3, 7.7)) : 0);

    ctx.set({
      level,
      lamps: [lampSoft, lampHard],
      mode: [0, 1 - hard, hard],
      gauge: rewinding ? 4 / 64 : 4 / 64 * (1 - fade),
      press: CJ.strikes(ctx.P.stepXs, [-999]),
      wires: [1, rewinding ? seg(u, 5.3, 5.6) : 0, 0],
    }, t);
  },
});
