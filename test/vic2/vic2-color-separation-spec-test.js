import assert from 'node:assert/strict';
import { newVic, placeSprites, standardWrites } from './_vic2-equivalence.js';
import { makeRenderSeg } from './_vic2-helpers.js';
import { PALETTE_RGBA } from '../../src/vic2-tables.js';

const v = newVic();
v.separateColorOutput = true;
const pixels = new Uint32Array(8), mask = new Uint8Array(8);
const pack = (mode, color, matrix, data) => 0x800000 | mode << 20 | color << 16 | matrix << 8 | data;
for (const mode of [0, 1, 2, 3, 4, 5, 6, 7]) {
  for (const color of [0, 7, 8, 15]) {
    const sample = pack(mode, color, 0x93, 0x1b);
    v._decodeGraphicsForeground(sample, mask);
    const multicolor = (mode & 1) && (mode !== 1 || color >= 8);
    assert.equal(Array.from(mask).join(''), multicolor ? '00001111' : '00011011',
      `Bauer 3.7.3: mode ${mode}, color ${color}, foreground follows bits or high bits of pairs`);
    const before = mask.slice();
    for (let bg = 0; bg < 16; bg++) {
      v.regs.fill(bg, 0x21, 0x25);
      v._presentGraphicsColumn(sample, v.regs, pixels);
      assert.deepEqual(mask, before, 'Bauer 3.11: color presentation cannot change foreground classification');
      if (mode >= 5) assert.ok(pixels.every(p => p === 0xff000000), 'Bauer 3.7.3: invalid modes output black while preserving foreground');
    }
  }
}
// Equal visible colors must not erase graphics collision bits.
v.regs.fill(0, 0x21, 0x25);
const blackSample = pack(0, 0, 0, 0xa5);
v._decodeGraphicsForeground(blackSample, mask);
v._presentGraphicsColumn(blackSample, v.regs, pixels);
assert.ok(pixels.every(p => p === PALETTE_RGBA[0] >>> 0), 'Black foreground and background present identically');
assert.equal(Array.from(mask).join(''), '10100101', 'Bauer 3.11: black foreground still participates in collisions');

// The main border covers presentation, not the foreground seen by collisions.
{
  const vic = newVic();
  vic.separateColorOutput = true;
  const seg = makeRenderSeg(vic, {cycle:15});
  seg.rowFetchedCols[0] = 1; seg.rowCodes[0] = 1;
  vic.charRom[8] = 0xa5;
  vic.fb32.fill(0x12345678); vic.borderBuffer.fill(1);
  vic._presentGraphicsColumn = () => { throw Error('Closed border must not run color presentation'); };
  vic._renderSourceColumnReference = () => { throw Error('Closed border must not run combined rendering'); };
  vic._writeSegmentCollisionUnderBorder(seg, 32, 40, 0);
  assert.equal(Array.from(vic.graphicsPriorityBuffer.slice(32,40)).join(''), '10100101', 'Bauer 3.9: graphics foreground reaches collision processing under the main border');
  assert.ok(vic.fb32.every(p => p === 0x12345678), 'Bauer 3.9: collision-only processing preserves border pixels');
}

// Exhaustive byte/color-mode comparison supplements the spec assertions.
v.regs.set([6, 9, 10, 11], 0x21);
const seg = makeRenderSeg(v, {cycle:15});
seg.rowFetchedCols[0] = 1;
const refPixels = new Uint32Array(8), refMask = new Uint8Array(8);
for (let mode = 0; mode < 8; mode++) {
  v.regs[0x11] = (mode & 6) << 4; v.regs[0x16] = (mode & 1) << 4;
  for (let color = 0; color < 16; color++) {
    seg.rowCodes[0] = (color * 17) & 255; seg.rowColors[0] = color;
    for (let data = 0; data < 256; data++) {
      v.ram.fill(data); v.charRom.fill(data);
      v._renderSourceColumnReference(0, 0, seg, refPixels, refMask);
      v._renderSourceColumn(0, 0, seg, pixels, mask);
      assert.deepEqual(pixels, refPixels, 'Separated color output agrees with the reference in every mode');
      assert.deepEqual(mask, refMask, 'Separated foreground agrees with the reference in every mode');
    }
  }
}

for (const variant of ['6569', '8565']) {
  for (const deferred of [false, true]) {
    const pair = [false, true].map(separated => {
      const vic = newVic();
      vic.vicVariant = variant; vic.lineBatchRender = deferred; vic.separateColorOutput = separated;
      placeSprites(vic, [0, 32, 128, 255, 343, 355, 496, 511]);
      for (let s = 0; s < 8; s++) vic.regs[s*2+1] = 50+s*23;
      vic.regs[0x1b] = 0xaa; vic.regs[0x1c] = 0x55; vic.regs[0x1d] = 0xaa;
      return vic;
    });
    for (let step = 0; step < 2*312*63; step++) {
      for (const vic of pair) {
        vic.clock(1);
        standardWrites(vic, vic.raster, vic.cycleInLine);
        if (vic.cycleInLine === 30) vic.write(0x20, vic.raster & 15);
        if (vic.cycleInLine === 35) vic.write(0x16, vic.regs[0x16] ^ 8);
        vic.phi2();
      }
      const [a,b] = pair;
      if (a.cycleInLine === 30 || a.cycleInLine === 60) {
        for (const reg of [0x19,0x1e,0x1f]) assert.equal(b.read(reg), a.read(reg), 'Color separation preserves CPU-visible collision and IRQ reads');
      }
      assert.equal(b.irqPending, a.irqPending, 'Color separation preserves IRQ timing');
      if (a.cycleInLine === 0) assert.deepEqual(b.fb32, a.fb32, 'Color separation preserves line-end pixels');
    }
  }
}
console.log('ok - separate color presentation and foreground/collision processing');
