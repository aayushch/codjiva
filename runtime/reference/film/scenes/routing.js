// Chapter 1: Submit routes orders. A malformed order is refused at once and drops into the left
// bin. A priority order is processed and then skips the batch for the Store.
const { seg, eio, eob, lerp } = CJ;

CJ.scene('routing', {
  init(ctx) {
    const c = ctx.c;
    let packets = '';
    for (let i = 0; i < 4; i++) packets += CJ.markedPacket(c('rb' + i), { marks: 3 });
    packets += CJ.packet('primary', c('ip')) + CJ.markedPacket(c('mv'), { marks: 3 }) + CJ.warning(c('wn'));
    ctx.mount({ extraSvg: packets });
    this.rest = [0, 1, 2, 3].map((i) => {
      const r = CJ.markedPacket.refs(ctx.q, 'rb' + i);
      CJ.revealMarks(r, 0, ctx.P.stepXs, true);
      return r;
    });
    this.slots = [0, 1, 2, 3].map((i) => ctx.routes.queued(i)(1));
    this.ip = ctx.q('ip');
    this.wn = ctx.q('wn');
    this.mv = CJ.markedPacket.refs(ctx.q, 'mv');
  },
  render(t, ctx) {
    this.rest.forEach((r, i) => CJ.place(r.g, this.slots[i], 1, 1));

    // The malformed order runs to the gear in Submit, then falls into the left drop bin.
    const a = seg(t, 0.5, 2.3);
    const ixy = ctx.routes.refused(eio(a));
    CJ.place(this.ip, ixy, 1, a <= 0 ? 0 : (a >= 1 ? 1 - seg(t, 2.3, 2.6) : 1));
    const pop = seg(t, 1.4, 1.9);
    CJ.place(this.wn, [310, 500], lerp(0.3, 1, eob(pop, 1.6)), pop <= 0 ? 0 : 1 - seg(t, 2.6, 3.0));

    // The priority order passes the presses and the switch, then goes straight to the Store.
    const b = seg(t, 2.4, 5.2);
    const mxy = ctx.routes.priority(eio(b));
    CJ.place(this.mv.g, mxy, 1, b <= 0 ? 0 : (b >= 1 ? 1 - seg(t, 5.2, 5.5) : 1));
    CJ.revealMarks(this.mv, mxy[0], ctx.P.stepXs, b >= 1);

    const onBelt = [a > 0 && a < 1 ? ixy[0] : -999, b > 0 && b < 1 ? mxy[0] : -999];
    ctx.set({ level: 0.34, gauge: 4 / 64, press: CJ.strikes(ctx.P.stepXs, onBelt) }, t);
  },
});
