CJ.definePlant({
  draw({ c, extraSvg, extraHtml }) {
    const bin = CJ.bin(c('bin'), 800, 470, 140, 180, 2);
    const pk = CJ.packer(c('pk'), 1040, 490, 260, ['file.Write(buf)', 'file.Sync()', 'written += n']);
    const at = (x, y, inner) => `<g transform="translate(${x} ${y})">${inner}</g>`;
    const s = [0, 1, 2].map(i => { const p = bin.slot(i); return at(p[0], p[1], CJ.packet('primary', c('pkt' + i))); }).join('');
    return `<svg class="art" viewBox="0 0 1920 1080">${CJ.grid(c('grid'))}${CJ.border()}
      ${CJ.pipe(c('pipe1'), 'M60 560 H300', 'hot')}
      ${CJ.pipe(c('pipe2'), 'M680 560 H800', 'hot')}
      ${CJ.pipe(c('pipe3'), 'M940 560 H1020', 'hot')}
      ${CJ.pipe(c('pipe4'), 'M1320 560 H1480', 'hot')}
      ${CJ.pipe(c('pipe5'), 'M490 680 V840', 'hot')}
      ${CJ.pipe(c('pipe6'), 'M1170 680 V840', 'hot')}
      ${CJ.port(c('port1'), 60, 560, 'r')}
      ${CJ.arrow(c('ar1'), 220, 560, 'r')}
      ${CJ.arrow(c('ar2'), 740, 560, 'r')}
      ${CJ.arrow(c('ar3'), 980, 560, 'r')}
      ${CJ.arrow(c('ar4'), 1445, 560, 'r')}
      ${CJ.arrow(c('ar5'), 490, 800, 'd')}
      ${CJ.arrow(c('ar6'), 1170, 800, 'd')}
      ${CJ.machine(c('enc'), 300, 440, 380, 240, false)}
      ${bin.svg}
      ${CJ.machine(c('lock'), 1020, 440, 300, 240, true)}
      ${pk.svg}
      ${CJ.drum(c('drum'), 1600, 470, 240, 180)}
      ${CJ.dropBin(c('dropbin1'), 435, 840)}
      ${CJ.dropBin(c('dropbin2'), 1115, 840)}
      ${at(490, 760, CJ.warning(c('warn1')))}
      ${at(1170, 760, CJ.warning(c('warn2')))}
      ${at(130, 560, CJ.packet('primary', c('pktin')))}
      ${at(1370, 560, CJ.packet('batch', c('pktout')))}
      ${s}${extraSvg}</svg>
      ${CJ.plate('WriteBatch(orders)', 60, 490)}
      ${CJ.plate('enc.Encode(&orders[i])', 300, 398)}
      ${CJ.plate('bytes.Buffer', 800, 428)}
      ${CJ.plate('mu.Lock · Write · Sync', 1020, 398)}
      ${CJ.plate('O_APPEND file', 1480, 428)}
      ${CJ.label(['json.NewEncoder(&buf)', 'one JSON line per order'], 330, 540, { size: 16 })}
      ${CJ.label('defer s.mu.Unlock()', 1040, 610, { size: 16 })}
      ${CJ.label('Encode error · nothing written', 570, 870, { size: 16 })}
      ${CJ.label('Write/Sync error · lock freed by defer', 1250, 870, { size: 16 })}
      ${pk.html}${extraHtml}`;
  },
  refs({ q }) { return {}; },
  defaults: {},
  set(R, S, t) {},
  routes(CJ) {
    return { main: CJ.route([[60, 560], [300, 560], [680, 560], [800, 560], [1020, 560], [1320, 560], [1480, 560]]) };
  },
  nodes: [
    { id: 'enc', label: 'enc.Encode loop', bbox: [300, 440, 380, 240], role: 'Encodes all orders', select: ['enc'] }
  ],
  ports: [
    { id: 'in:FileStore.WriteBatch', dir: 'in', anchor: [60, 560] },
    { id: 'out:os.File.Write', dir: 'out', anchor: [1600, 560] }
  ]
});
