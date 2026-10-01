import assert from 'node:assert/strict';
import { newVic } from './_vic2-equivalence.js';
import { makeRenderSeg } from './_vic2-helpers.js';
import { PALETTE_RGBA } from '../../src/vic2-tables.js';

// Bauer 3.7.3: foreground classification follows data bits, independently
// of palette choices. Multicolor pairs 10/11 are foreground, 00/01 are not.
for (const fetched of [false, true]) {
  const v = newVic();
  v._fetchFeedLine = fetched;
  const pixels = new Uint32Array(8), mask = new Uint8Array(8);
  const seg = makeRenderSeg(v, {cycle: 15});
  seg.rowFetchedCols[0] = 1;
  const backgrounds = [6, 9, 10, 11];
  v.regs.set(backgrounds, 0x21);
  for (let mode = 0; mode < 8; mode++) {
    v.regs[0x11] = (mode & 6) << 4;
    v.regs[0x16] = (mode & 1) << 4;
    for (let color = 0; color < 16; color++) {
      const matrix = color * 17;
      seg.rowCodes[0] = matrix;
      seg.rowColors[0] = color;
      const multicolor = (mode & 1) && (mode !== 1 || color >= 8);
      const colors = mode === 3 ? [backgrounds[0], matrix >> 4, matrix & 15, color]
        : multicolor ? [backgrounds[0], backgrounds[1], backgrounds[2], color & 7]
        : mode === 2 ? [matrix & 15, matrix >> 4]
        : mode === 4 ? [backgrounds[matrix >> 6], color]
        : [backgrounds[0], mode === 1 ? color & 7 : color];
      for (let data = 0; data < 256; data++) {
        v.ram.fill(data); v.charRom.fill(data);
        v._fetchFeedSamples[0] = 0x800000 | color << 16 | matrix << 8 | data;
        v._renderSourceColumn(0, 0, seg, pixels, mask);
        for (let x = 0; x < 8; x++) {
          const bits = multicolor ? (data >> (6 - (x >> 1) * 2)) & 3 : (data >> (7 - x)) & 1;
          assert.equal(mask[x], multicolor ? bits >> 1 : bits,
            `Bauer 3.7.3: mode ${mode}, fetched=${fetched}, foreground follows data classification`);
          assert.equal(pixels[x], mode >= 5 ? 0xff000000 : PALETTE_RGBA[colors[bits]] >>> 0,
            `Bauer 3.7.3: mode ${mode}, fetched=${fetched}, display follows the mode color table`);
        }
      }
    }
  }

  // Equal foreground/background colors cannot erase collision information.
  v.regs[0x11] = 0; v.regs[0x16] = 0;
  v.regs.fill(0, 0x21, 0x25);
  seg.rowCodes[0] = seg.rowColors[0] = 0;
  v.ram.fill(0xa5); v.charRom.fill(0xa5);
  v._fetchFeedSamples[0] = 0x8000a5;
  v._renderSourceColumn(0, 0, seg, pixels, mask);
  assert.ok(pixels.every(p => p === PALETTE_RGBA[0] >>> 0), 'Equal colors present identically');
  assert.equal(Array.from(mask).join(''), '10100101', 'Bauer 3.11: black foreground still participates in collisions');

  // The main border covers presentation, not the foreground seen by collisions.
  v.fb32.fill(0x12345678); v.borderBuffer.fill(1);
  v._writeSegmentCollisionUnderBorder(seg, 32, 40, 0);
  assert.equal(Array.from(v.graphicsPriorityBuffer.slice(32, 40)).join(''), '10100101',
    'Bauer 3.9: graphics foreground reaches collision processing under the main border');
  assert.ok(v.fb32.every(p => p === 0x12345678), 'Bauer 3.9: collision-only processing preserves border pixels');
}
console.log('ok - graphics colors and foreground classification from RAM and immutable samples');
