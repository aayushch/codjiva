// Chapter 0: the whole plant. After the legend card, one order enters Submit, passes the three
// presses and the switch, and rests in the batch bin next to three orders that are already there.
const { seg, eio, lerp } = CJ;

CJ.scene('overview', {
  init(ctx) {
    const c = ctx.c;
    let packets = '';
    for (let i = 0; i < 3; i++) packets += CJ.markedPacket(c('rb' + i), { marks: 3 });
    packets += CJ.markedPacket(c('mv'), { marks: 3 });
    ctx.mount({ extraSvg: packets });
    this.rest = [0, 1, 2].map((i) => {
      const r = CJ.markedPacket.refs(ctx.q, 'rb' + i);
      CJ.revealMarks(r, 0, ctx.P.stepXs, true);
      return r;
    });
    this.slots = [0, 1, 2].map((i) => ctx.routes.queued(i)(1));
    this.mv = CJ.markedPacket.refs(ctx.q, 'mv');
    this.route = ctx.routes.queued(3);
  },
  render(t, ctx) {
    this.rest.forEach((r, i) => CJ.place(r.g, this.slots[i], 1, 1));
    const p = seg(t, 4.2, 7.2);
    const xy = this.route(eio(p));
    CJ.place(this.mv.g, xy, 1, p > 0 ? 1 : 0);
    CJ.revealMarks(this.mv, xy[0], ctx.P.stepXs, p >= 1);
    const landed = seg(t, 6.8, 7.6);
    ctx.set({
      level: lerp(0.3, 0.34, landed),
      gauge: (3 + seg(t, 7.0, 7.4)) / 64,
      press: CJ.strikes(ctx.P.stepXs, [p > 0 && p < 1 ? xy[0] : -999]),
    }, t);
  },
});
