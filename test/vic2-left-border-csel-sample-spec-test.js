// Bauer §3.9: CSEL chooses the left comparator at X=24 or X=31.
// PAL comparator timing: VICE viciisc/vicii-cycle.c check_hborder,
// wide compare at cycle 17, narrow compare at cycle 18.
// A phi2 write through cycle 16 is visible to the wide compare at phi1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeVic, paletteRgba, CANVAS_W } from './_vic2-helpers.js';

function render({ deferred, writeCycle, sprite = false, alreadyOpen = false, vertical = false }) {
  const v = makeVic();
  v.lineBatchRender = deferred;
  v.regs[0x11] = 0x1b;
  v.regs[0x16] = 0x08;
  v.regs[0x18] = 0x14;
  v.regs[0x20] = 0;
  v.regs[0x21] = 1;
  v.charRom.fill(0xff);
  v.colorRam.fill(2);
  if (sprite) {
    v.regs[0] = 24; // Sprite covers canvas x32..55, crossing the narrow edge.
    v.regs[1] = 99;
    v.regs[0x15] = 1;
    v.regs[0x27] = 5;
    v.ram[0x07f8] = 0x80;
    v.ram.fill(0xff, 0x2000, 0x2040);
  }
  while (v.raster < 100) { v.clock(1); v.phi2(); }
  if (alreadyOpen) v.hBorderActive = false;
  if (vertical) { v.vBorderActive = true; v._vBorderLatch = true; }
  for (let cycle = 1; cycle <= 63; cycle++) {
    v.clock(1);
    if (cycle === writeCycle) v.write(0x16, 0);
    v.phi2();
  }
  return v;
}

const offset = (100 - 15) * CANVAS_W;
for (const deferred of [false, true]) {
  const mode = deferred ? 'deferred' : 'live';
  for (const writeCycle of [14, 15, 16, 17, 18]) {
    const v = render({ deferred, writeCycle });
    const edge = writeCycle <= 16 ? 39 : 32;
    test(`${mode}: cycle-${writeCycle} CSEL clear selects left edge x${edge}`, () => {
      assert.deepEqual(Array.from(v.borderBuffer.slice(24, 48)),
        Array.from({ length: 24 }, (_, i) => +(24 + i < edge)),
        '§3.9: the left compare uses CSEL before the beam reaches X=24');
    });
    test(`${mode}: cycle-${writeCycle} border overlay covers graphics to x${edge - 1}`, () => {
      assert.deepEqual(Array.from(v.fb32.slice(offset + 24, offset + 48)),
        Array.from({ length: 24 }, (_, i) => paletteRgba(24 + i < edge ? 0 : 2)),
        '§3.9: the main border overlays graphics until the selected left compare');
    });
  }
  for (const writeCycle of [15, 16]) {
    const v = render({ deferred, writeCycle, sprite: true });
    test(`${mode}: cycle-${writeCycle} narrow border masks a crossing sprite`, () => {
      assert.deepEqual(Array.from(v.fb32.slice(offset + 32, offset + 48)),
        Array.from({ length: 16 }, (_, i) => paletteRgba(i < 7 ? 0 : 5)),
        '§3.9: border masks sprites through x38 and preserves them from x39');
    });
    test(`${mode}: cycle-${writeCycle} foreground persists under the narrow border`, () => {
      assert.deepEqual(Array.from(v.graphicsPriorityBuffer.slice(32, 40)), Array(8).fill(1),
        '§3.9: the main border overlay does not stop the graphics sequencer');
    });
    test(`${mode}: cycle-${writeCycle} hidden sprite pixels are not marked visible`, () => {
      assert.deepEqual(Array.from(v.spriteVisibleBuffer.slice(32, 40)), [0,0,0,0,0,0,0,1],
        '§3.9: sprite visibility follows the border output multiplexer');
    });
  }
  test(`${mode}: a left RESET cannot close an already open border`, () => {
    const v = render({ deferred, writeCycle: 16, alreadyOpen: true });
    assert.deepEqual(Array.from(v.borderBuffer.slice(32, 40)), Array(8).fill(0),
      '§3.9 rule 6: the left compare only resets the main border flip-flop');
  });
  test(`${mode}: vertical border suppresses the left RESET`, () => {
    const v = render({ deferred, writeCycle: 16, vertical: true });
    assert.deepEqual(Array.from(v.borderBuffer.slice(32, 48)), Array(16).fill(1),
      '§3.9 rule 6: the main border cannot open while the vertical border is set');
  });
}
