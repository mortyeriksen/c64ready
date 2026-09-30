// VIC-II: Idle-state g-access source (Tests 5, 5a)
// Extracted from vic2-test.js.

import fs from 'fs';
import {
  VIC2, CANVAS_W, CANVAS_H, CYCLES_PER_FRAME, CYCLES_PER_LINE, C64_PALETTE,
  C64Machine,
  paletteRgba,
  ACCESS_IDLE, ACCESS_REFRESH, ACCESS_C, ACCESS_G,
  assert, softAssert,
  makeVic, makeRenderSeg,
  fillSpriteLineState, fillOpaqueSpriteAcrossLine,
  clearLineBuffers, setupSpriteForRender, setMulticolorRegs,
  fillTextLineState,
  clearRenderedRow, firstForegroundX, lastForegroundX,
  runUntil,
  makeMasterCycleHarness,
  makeRenderableVic,
} from './_vic2-helpers.js';

// Test 5: idle-state g-access source follows $3FFF / $39FF.
{
  const vic = makeVic();
  vic.ram[0x3FFF] = 0xAA;
  vic.ram[0x39FF] = 0x55;

  vic.regs[0x11] = 0x00;
  assert(vic._readIdleGByte(vic.regs, 0x0000) === 0xAA, 'idle byte comes from $3FFF when ECM=0');

  vic.regs[0x11] = 0x40;
  assert(vic._readIdleGByte(vic.regs, 0x0000) === 0x55, 'idle byte comes from $39FF when ECM=1');
  console.log('ok  - idle-state byte source follows ECM');
}

// Test 5a: text graphics origin stays fixed while CSEL only moves border compares.
{
  const vic = makeVic();
  vic.regs[0x16] = 0x08; // CSEL=1
  const wide = vic._getHorizontalDisplayWindow(vic.regs);
  const wideBorder = vic._getHorizontalBorderCompareX(vic.regs);

  vic.regs[0x16] = 0x00; // CSEL=0
  const narrow = vic._getHorizontalDisplayWindow(vic.regs);
  const narrowBorder = vic._getHorizontalBorderCompareX(vic.regs);

  assert(wide.start === 32 && wide.end === 352, '40-column text graphics window is centered in canvas space');
  assert(narrow.start === 32 && narrow.end === 352, '38-column mode keeps the same underlying graphics origin');
  assert(wideBorder.left === 24 && wideBorder.right === 344, 'CSEL=1 border compares keep the raw VIC timing positions');
  assert(narrowBorder.left === 31 && narrowBorder.right === 335, 'CSEL=0 only moves the border compares inward');
  console.log('ok  - text graphics origin stays fixed while CSEL only moves border compares');
}


console.log('\nAll Idle-state g-access source (Tests 5, 5a) tests passed.');
