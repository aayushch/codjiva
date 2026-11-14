// The yard: the Handler part on the left and the FileStore part on the right. One pipe joins the
// Handler's Store.WriteBatch port to the FileStore's WriteBatch(orders) port.

// Port anchors on each part's own sheet.
const OUT_OF_HANDLER = [1800, 870];
const INTO_STORE = [60, 560];

CJ.definePlant({
  draw({ c, extraSvg, extraHtml }) {
    const handler = CJ.bay('handler');
    const store = CJ.bay('store');
    const from = handler.point(OUT_OF_HANDLER);
    const to = store.point(INTO_STORE);
    const midX = Math.round((from[0] + to[0]) / 2);
    // The join pipe is drawn under the parts; whatever a chapter adds through extraSvg goes above them.
    return `<svg class="art" viewBox="0 0 1920 1080">${CJ.grid(c('grid'))}${CJ.border()}
        ${CJ.pipe(c('join1'), `M${from[0]} ${from[1]} H${midX} V${to[1]} H${to[0]}`, 'hot')}</svg>
      ${handler.draw(c)}${store.draw(c)}
      <svg class="art" viewBox="0 0 1920 1080">${CJ.arrow(c('arrow1'), midX, Math.round((from[1] + to[1]) / 2) + 40, 'u')}${extraSvg}</svg>
      ${CJ.plate('write · WriteBatch(orders)', midX - 146, 290)}${extraHtml}`;
  },

  refs() {
    return {};
  },

  defaults: {},

  set() {},

  routes(CJ) {
    const handler = CJ.bay('handler');
    const store = CJ.bay('store');
    const from = handler.point(OUT_OF_HANDLER);
    const to = store.point(INTO_STORE);
    const midX = Math.round((from[0] + to[0]) / 2);
    return {
      inHandler: handler.routes().flush,
      cross: CJ.route([from, [midX, from[1]], [midX, to[1]], to]),
      inStore: store.routes().main,
    };
  },
});
