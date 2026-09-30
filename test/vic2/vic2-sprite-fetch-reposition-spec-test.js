// Bauer §3.8.1 rules 5 and 6: a completed offscreen emission does not
// consume bytes fetched afterwards. A later X match may emit that new row.
// PAL fetch slots come from §3.6.3. First s-access: p-cycle phi2.
import assert from 'node:assert/strict';
import { VIC2, CANVAS_W } from '../../src/vic2.js';

function render({ sprite, earlyX, expanded = false, multi = false, lateX = 240,
  lineBatchRender, vicVariant = '6569', captureDedup = true }) {
  const v = new VIC2();
  v.ram = new Uint8Array(65536);
  v.colorRam = new Uint8Array(1024);
  v.charRom = new Uint8Array(4096);
  v.lineBatchRender = lineBatchRender;
  v.captureDedup = captureDedup;
  v.vicVariant = vicVariant;
  v.regs[0x11] = 0x1b;
  v.regs[0x16] = 8;
  v.regs[0x18] = 0x14;
  v.regs[0x15] = 1 << sprite;
  v.regs[0x17] = 0;
  v.regs[0x1d] = expanded ? 1 << sprite : 0;
  v.regs[0x1c] = multi ? 1 << sprite : 0;
  v.regs[0x20] = v.regs[0x21] = 0;
  v.regs[0x26] = v.regs[0x27 + sprite] = 1;
  v.regs[sprite * 2] = earlyX & 255;
  v.regs[sprite * 2 + 1] = 100;
  v.regs[0x10] = 1 << sprite;
  v.ram[0x7f8 + sprite] = 0x80;
  // Identical rows: a fetch is an event even when the bytes do not change.
  v.ram.fill(255, 0x2000, 0x2040);
  while (!(v.raster === 102 && v.cycleInLine === 0)) {
    v.clock(1);
    if (v.raster === 101 && v.cycleInLine === 14) v.write(0x10, 0);
    if (v.raster === 101 && v.cycleInLine === 32) v.write(sprite * 2, lateX);
    v.phi2();
  }
  return v.fb32.slice((101 - 15) * CANVAS_W, (102 - 15) * CANVAS_W);
}

const cases = [
  { sprite: 7, earlyX: 424, visible: true },
  // X=448 + 24 ends at X=472, the start of sprite 7's first s-access.
  { sprite: 7, earlyX: 448, visible: true },
  { sprite: 6, earlyX: 432, visible: true },
  { sprite: 5, earlyX: 416, visible: true },
  { sprite: 7, earlyX: 424, expanded: true, visible: true },
  { sprite: 7, earlyX: 424, multi: true, visible: true },
  { sprite: 7, earlyX: 424, expanded: true, multi: true, visible: true },
  // Sprite 0's row was fetched on the preceding raster line.
  { sprite: 0, earlyX: 424, visible: false },
  // This X match happens after all three s-accesses and consumes the new row.
  { sprite: 7, earlyX: 488, visible: false },
];
for (const vicVariant of ['6569', '8565']) {
  for (const c of cases) {
    for (const lineBatchRender of [false, true]) {
      for (const captureDedup of [false, true]) {
        const row = render({ ...c, lineBatchRender, vicVariant, captureDedup });
        const pixels = row.slice(248, 248 + (c.expanded ? 48 : 24));
        const label = JSON.stringify({ ...c, lineBatchRender, vicVariant, captureDedup });
        assert.ok(pixels.every(p => ((p & 0xffffff) !== 0) === c.visible),
          `Bauer 3.8.1 rules 5/6: only data fetched after completed emission can display at a later X match: ${label}`);
      }
    }
  }
}
console.log('ok - sprite fetch ordering preserves fresh rows and blocks consumed rows in live/deferred rendering');
