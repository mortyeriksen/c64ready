// VIC-II: Invalid ECM+MCM+BMM modes (Tests 8-8c)
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

// Test 8: invalid ECM+MCM text mode (mode 011) renders black but
// preserves the foreground map per the standard MCM rule (pairs 10/11
// = fg, pairs 00/01 = bg). Bauer §3.7.3.6: invalid mode 011 outputs
// black for every pixel; the underlying multi-color pair classification
// still drives sprite priority + collision latching per §3.11.2.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x40; // ECM=1
  vic.regs[0x16] = 0x10; // MCM=1
  vic.regs[0x18] = 0x14;
  vic.charRom[8] = 0b10011100; // pairs: 10 01 11 00

  const seg = makeRenderSeg(vic, {
    rowFetchD011: 0x40,
    rowFetchD016: 0x10,
    rowFetchD018: 0x14,
  });
  seg.rowFetchedCols[0] = 1;
  seg.rowCodes[0] = 1;
  seg.rowColors[0] = 0x0F;

  const outPixels = new Uint32Array(8);
  const outFgMap = new Uint8Array(8);
  vic._renderSourceColumn(0, 0, seg, outPixels, outFgMap, 0);

  assert(outPixels.every((px) => px === 0xFF000000), 'invalid text mode renders black pixels');
  assert(Array.from(outFgMap).join('') === '11001100', 'invalid text mode still marks 10/11 pairs as foreground');
  console.log('ok  - invalid ECM+MCM text mode preserves collision foreground map');
}

// Test 8b: invalid ECM+BMM bitmap mode 1 renders black but keeps 1-bit foreground data.
{
  const vic = makeVic();
  const rowVcBase = 0x0181;
  // Bauer §3.7.3.7: g-access addr drops VC6/VC7. Mask is VC0..VC5 + VC8..VC9.
  const invalidVc = rowVcBase & 0x033F;
  const invalidAddr = (0x2000 + invalidVc * 8) & 0x3FFF;
  vic.currentVicBank = 0x4000;
  vic.regs[0x11] = 0x60; // ECM=1, BMM=1
  vic.regs[0x16] = 0x00; // MCM=0
  vic.regs[0x18] = 0x18; // bitmap base $2000
  vic.ram[vic.currentVicBank + invalidAddr] = 0b10100101;

  const seg = makeRenderSeg(vic, {
    bank: vic.currentVicBank,
    rowVcBase,
    rowFetchD011: 0x60,
    rowFetchD016: 0x00,
    rowFetchD018: 0x18,
  });
  seg.rowFetchedCols[0] = 1;
  seg.rowCodes[0] = 0;
  seg.rowColors[0] = 0;

  const outPixels = new Uint32Array(8);
  const outFgMap = new Uint8Array(8);
  vic._renderSourceColumn(0, 0, seg, outPixels, outFgMap, 0);

  assert(outPixels.every((px) => px === 0xFF000000), 'invalid bitmap mode 1 renders black pixels');
  assert(Array.from(outFgMap).join('') === '10100101', 'invalid bitmap mode 1 preserves 1-bit foreground/background data');
  console.log('ok  - invalid ECM+BMM bitmap mode preserves 1-bit foreground map');
}

// Test 8c: invalid ECM+BMM+MCM bitmap mode 2 renders black and treats 01 as background.
{
  const vic = makeVic();
  const rowVcBase = 0x0181;
  // Bauer §3.7.3.8: same address scheme as invalid bitmap mode 1.
  const invalidVc = rowVcBase & 0x033F;
  const invalidAddr = (0x2000 + invalidVc * 8) & 0x3FFF;
  vic.currentVicBank = 0x4000;
  vic.regs[0x11] = 0x60; // ECM=1, BMM=1
  vic.regs[0x16] = 0x10; // MCM=1
  vic.regs[0x18] = 0x18; // bitmap base $2000
  vic.ram[vic.currentVicBank + invalidAddr] = 0b01101100; // pairs: 01 10 11 00

  const seg = makeRenderSeg(vic, {
    bank: vic.currentVicBank,
    rowVcBase,
    rowFetchD011: 0x60,
    rowFetchD016: 0x10,
    rowFetchD018: 0x18,
  });
  seg.rowFetchedCols[0] = 1;
  seg.rowCodes[0] = 0;
  seg.rowColors[0] = 0;

  const outPixels = new Uint32Array(8);
  const outFgMap = new Uint8Array(8);
  vic._renderSourceColumn(0, 0, seg, outPixels, outFgMap, 0);

  assert(outPixels.every((px) => px === 0xFF000000), 'invalid bitmap mode 2 renders black pixels');
  assert(Array.from(outFgMap).join('') === '00111100', 'invalid bitmap mode 2 treats 01 as background and 10/11 as foreground');
  console.log('ok  - invalid ECM+BMM+MCM bitmap mode preserves multicolor foreground map');
}


console.log('\nAll Invalid ECM+MCM+BMM modes (Tests 8-8c) tests passed.');
