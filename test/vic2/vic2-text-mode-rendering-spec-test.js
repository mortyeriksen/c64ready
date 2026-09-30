// VIC-II: Text-mode rendering (Tests 5b-5r)
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

// Test 5b: text-path access typing distinguishes idle, g, c, and refresh slots.
{
  const vic = makeVic();
  vic.displayActive = false;
  assert(vic._getTextAccessType(10) === ACCESS_IDLE, 'non-display cycles default to idle access');

  vic.displayActive = true;
  assert(vic._getTextPhase1AccessType(20) === ACCESS_G, 'display-state phase 1 uses g-accesses');
  assert(vic._getTextPhase1AccessType(15) === ACCESS_G, 'cycle 15 is a display-state g-access');
  assert(vic._getTextPhase2AccessType(20) === ACCESS_IDLE, 'without a bad line, phase 2 stays idle');
  assert(vic._getTextAccessType(20) === ACCESS_G, 'display-state text cycles use g-accesses when no bad line is active');

  vic.lineBadLineDisplayPending = true;
  vic.lineBadLineStartCycle = 21;
  assert(vic._getTextPhase1AccessType(21) === ACCESS_G, 'bad-line cycles still perform g-accesses in phase 1');
  assert(vic._getTextPhase2AccessType(21) === ACCESS_C, 'bad-line phase 2 performs c-accesses');
  assert(vic._getTextAccessType(21) === ACCESS_C, 'bad-line fetch cycles are classified as c-accesses');

  vic.displayActive = false;
  vic.lineBadLineDisplayPending = false;
  vic.lineBadLineStartCycle = -1;
  assert(vic._getTextPhase1AccessType(11) === ACCESS_REFRESH, 'cycle 11 starts the refresh access window');
  assert(vic._getTextPhase1AccessType(15) === ACCESS_REFRESH, 'cycle 15 is still a refresh access when display state is inactive');
  assert(vic._getTextAccessType(63) === ACCESS_IDLE, 'cycle 63 is no longer used as a synthetic refresh slot');

  vic.refreshCounter = 0xFF;
  for (let cycle = 11; cycle <= 15; cycle++) vic._runTextPhase1Access(cycle);
  assert(vic.refreshCounter === 0xFA, 'five scheduled refresh accesses decrement the refresh counter by five');
  console.log('ok  - text-path access typing classifies phase-1 refresh/g and phase-2 c slots');
}

// Test 5b2: display-state g-accesses advance VC 40 times across cycles 15-54.
{
  const vic = makeVic();
  vic.displayActive = true;
  vic.vc = 0;
  vic.vmli = 0;

  for (let cycle = 15; cycle <= 54; cycle++) vic._runTextPhase1Access(cycle);

  assert(vic.vc === 40, 'display-state g-accesses advance VC 40 times per row');
  assert(vic.vmli === 40, 'display-state g-accesses advance VMLI 40 times per row');
  console.log('ok  - display-state g-accesses span all 40 text columns');
}

// Test 5c: standard text rendering starts at the spec left edge in 40-column mode.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B; // DEN=1, RSEL=1
  vic.regs[0x16] = 0x08; // CSEL=1, XSCROLL=0
  vic.regs[0x18] = 0x14;
  vic.charRom[8] = 0xFF; // full first character row
  fillTextLineState(vic, vic.regs, { hBorder: false, vBorder: false, rowVcBase: 0, rc: 0 });
  for (let cycle = 11; cycle <= 58; cycle++) {
    vic.lineCycleRowFetchedCols[cycle][0] = 1;
    vic.lineCycleRowCodes[cycle][0] = 1;
    vic.lineCycleRowColors[cycle][0] = 2;
  }

  const raster = 20;
  const rowOffset = (raster - 15) * 384;
  vic.fb32.fill(0, rowOffset, rowOffset + 384);
  vic.borderBuffer.fill(0, 0, 384);
  vic.graphicsPriorityBuffer.fill(0, 0, 384);
  vic.graphicsCollisionBuffer.fill(0, 0, 384);
  vic.spriteCollisionBuffer.fill(0, 0, 384);

  vic._renderRasterLine(raster);

  assert(vic.graphicsPriorityBuffer[31] === 0, 'no text foreground appears before the left graphics edge');
  for (let x = 32; x < 40; x++) {
    assert(vic.graphicsPriorityBuffer[x] === 1, 'the full first 8-pixel cell starts at X=32 in 40-column mode');
  }
  assert(vic.graphicsPriorityBuffer[40] === 0, 'the next cell does not bleed into the first 8-pixel slot');
  console.log('ok  - standard text starts at the spec left edge in 40-column mode');
}

// Test 5d: the first visible raster of the display window shows glyph row 0.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B; // DEN=1, RSEL=1, YSCROLL=3
  vic.regs[0x16] = 0x08; // CSEL=1, XSCROLL=0
  vic.regs[0x18] = 0x14;
  vic.ram[0x0400] = 1;
  vic.colorRam[0] = 2;
  vic.charRom[8] = 0xFF; // row 0 visible
  vic.charRom[9] = 0x00; // row 1 blank

  for (let i = 0; i < 52 * 63; i++) vic.clock(1);

  const raster = 51;
  const rowOffset = (raster - 15) * 384;
  assert(vic.graphicsPriorityBuffer[31] === 0, 'top display row does not start before X=32');
  for (let x = 32; x < 40; x++) {
    assert(vic.graphicsPriorityBuffer[x] === 1, 'top display row shows glyph row 0 at the first visible cell');
  }
  assert(vic.graphicsPriorityBuffer[40] === 0, 'top display row keeps the first cell width at 8 pixels');
  console.log('ok  - first visible display raster shows the first glyph row');
}

// Test 5e: XSCROLL shifts text inside the fixed display window by 0-7 pixels.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B; // DEN=1, RSEL=1
  vic.regs[0x18] = 0x14;
  vic.charRom[8] = 0x80; // single foreground bit at the left edge

  for (let xscroll = 0; xscroll <= 7; xscroll++) {
    vic.regs[0x16] = 0x08 | xscroll; // CSEL=1
    fillTextLineState(vic, vic.regs, { hBorder: false, vBorder: false, rowVcBase: 0, rc: 0 });
    for (let cycle = 11; cycle <= 58; cycle++) {
      vic.lineCycleRowFetchedCols[cycle][0] = 1;
      vic.lineCycleRowCodes[cycle][0] = 1;
      vic.lineCycleRowColors[cycle][0] = 2;
    }

    clearRenderedRow(vic, 20);
    vic._renderRasterLine(20);
    assert(firstForegroundX(vic, 20, 0, 96) === 32 + xscroll, `XSCROLL=${xscroll} moves the first text pixel inside the fixed display window`);
  }
  console.log('ok  - XSCROLL shifts text inside the fixed display window');
}

// Test 5f: 38-column mode clips text with the border while keeping the same graphics origin.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B; // DEN=1, RSEL=1
  vic.regs[0x16] = 0x07; // CSEL=0, XSCROLL=7 keeps text aligned in 38-column mode
  vic.regs[0x18] = 0x14;
  vic.charRom[8] = 0xFF;
  fillTextLineState(vic, vic.regs, { hBorder: false, vBorder: false, rowVcBase: 0, rc: 0 });
  for (let cycle = 11; cycle <= 58; cycle++) {
    vic.lineCycleRowFetchedCols[cycle][0] = 1;
    vic.lineCycleRowCodes[cycle][0] = 1;
    vic.lineCycleRowColors[cycle][0] = 2;
  }

  clearRenderedRow(vic, 20);
  vic._renderRasterLine(20);

  assert(firstForegroundX(vic, 20, 0, 96) === 39, '38-column mode opens the left border at X=39');
  assert(vic.graphicsPriorityBuffer[38] === 0, '38-column mode keeps the widened left border covering X=38');
  console.log('ok  - 38-column mode clips text while keeping the same graphics origin');
}

// Test 5g: the right edge of 40-column text ends at X=343 with no 41st-column bleed.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08; // CSEL=1, XSCROLL=0
  vic.regs[0x18] = 0x14;
  vic.charRom[8] = 0xFF;
  fillTextLineState(vic, vic.regs, { hBorder: false, vBorder: false, rowVcBase: 0, rc: 0 });
  for (let cycle = 11; cycle <= 58; cycle++) {
    vic.lineCycleRowFetchedCols[cycle][39] = 1;
    vic.lineCycleRowCodes[cycle][39] = 1;
    vic.lineCycleRowColors[cycle][39] = 2;
  }

  clearRenderedRow(vic, 20);
  vic._renderRasterLine(20);

  assert(lastForegroundX(vic, 20, 328, 368) === 351, '40-column text ends at X=351');
  assert(vic.graphicsPriorityBuffer[352] === 0, 'no text foreground appears at X=352');
  console.log('ok  - 40-column text clips cleanly at the right edge');
}

// Test 5h: 24-row mode opens text at raster 55 and closes it after raster 246.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x13; // DEN=1, RSEL=0, YSCROLL=3
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x14;
  for (let row = 0; row < 25; row++) {
    vic.ram[0x0400 + row * 40] = 1;
    vic.colorRam[row * 40] = 2;
  }
  for (let line = 0; line < 8; line++) vic.charRom[8 + line] = 0xFF;

  // Side buffers are line-sized (#1): inspect each raster's foreground at cy0
  // of the NEXT line — that line has rendered, its successor hasn't cleared the
  // buffer yet. firstForegroundX reads the current (single) line buffer.
  runUntil(vic, 55, 0);  assert(firstForegroundX(vic, 54, 0, 80) === -1, '24-row mode keeps raster 54 in the top border');
  runUntil(vic, 56, 0);  assert(firstForegroundX(vic, 55, 0, 96) === 32, '24-row mode starts text at raster 55');
  runUntil(vic, 247, 0); assert(firstForegroundX(vic, 246, 0, 96) === 32, '24-row mode still shows text on raster 246');
  runUntil(vic, 248, 0); assert(firstForegroundX(vic, 247, 0, 80) === -1, '24-row mode returns to border after raster 246');
  console.log('ok  - 24-row mode follows the RSEL text height geometry');
}

// Test 5i: RC progresses for 8 rasters per text row and VCBASE advances by 40 afterwards.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B; // DEN=1, RSEL=1, YSCROLL=3
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x14;

  const rcSeen = [];
  const rowBaseSeen = [];
  for (let raster = 51; raster <= 59; raster++) {
    runUntil(vic, raster + 1, 0);
    rcSeen.push(vic.lineCycleRc[15]);
    rowBaseSeen.push(vic.lineCycleRowVcBase[15]);
  }

  assert(rcSeen.join(',') === '0,1,2,3,4,5,6,7,0', 'RC advances through 0-7 and resets on the next text row');
  assert(rowBaseSeen.slice(0, 8).every((base) => base === 0), 'the first text row keeps the same matrix base for 8 rasters');
  assert(rowBaseSeen[8] === 40, 'the next text row starts 40 characters later in screen RAM');
  console.log('ok  - RC and VCBASE follow 8-raster text-line progression');
}

// Test 5j: ECM text mode uses the upper screen-code bits to select BG0-BG3 and the low 6 bits for the charset.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x40; // ECM=1
  vic.regs[0x16] = 0x00;
  vic.regs[0x18] = 0x14;
  vic.regs[0x22] = 0x03;
  vic.regs[0x23] = 0x05;
  vic.regs[0x24] = 0x07;
  vic.charRom[8] = 0x80; // code 1, line 0

  const seg = makeRenderSeg(vic, {
    rowFetchD011: 0x40,
    rowFetchD016: 0x00,
    rowFetchD018: 0x14,
  });
  seg.rowFetchedCols[0] = 1;
  seg.rowCodes[0] = 0x81; // BG2 selected, char index 1
  seg.rowColors[0] = 0x02;

  const outPixels = new Uint32Array(8);
  const outFgMap = new Uint8Array(8);
  vic._renderSourceColumn(0, 0, seg, outPixels, outFgMap, 0);

  assert(outPixels[0] === 0xFF383381, 'ECM text uses color RAM for foreground');
  assert(outPixels[1] === 0xFF4DAC56, 'ECM text uses BG2 when the upper screen-code bits select it');
  assert(outFgMap[0] === 1 && outFgMap[1] === 0, 'ECM text still classifies foreground and background per glyph bits');
  console.log('ok  - ECM text mode uses BG selection and a masked charset index');
}

// Test 5k: multicolor text leaves low-color characters in hires mode.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x00;
  vic.regs[0x16] = 0x10; // MCM=1
  vic.regs[0x18] = 0x14;
  vic.charRom[8] = 0x80;

  const seg = makeRenderSeg(vic, {
    rowFetchD011: 0x00,
    rowFetchD016: 0x10,
    rowFetchD018: 0x14,
  });
  seg.rowFetchedCols[0] = 1;
  seg.rowCodes[0] = 1;
  seg.rowColors[0] = 0x07; // <8, so hires inside MCM text

  const outPixels = new Uint32Array(8);
  const outFgMap = new Uint8Array(8);
  vic._renderSourceColumn(0, 0, seg, outPixels, outFgMap, 0);

  assert(outFgMap.join('') === '10000000', 'low-color characters stay hires in multicolor text mode');
  console.log('ok  - multicolor text keeps low-color characters in hires mode');
}

// Test 5l: multicolor text expands 2-bit pixels and uses BG1/BG2/char color for 01/10/11.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x00;
  vic.regs[0x16] = 0x10; // MCM=1
  vic.regs[0x18] = 0x14;
  vic.regs[0x22] = 0x03;
  vic.regs[0x23] = 0x05;
  vic.charRom[8] = 0b01101100; // 01 10 11 00

  const seg = makeRenderSeg(vic, {
    rowFetchD011: 0x00,
    rowFetchD016: 0x10,
    rowFetchD018: 0x14,
  });
  seg.rowFetchedCols[0] = 1;
  seg.rowCodes[0] = 1;
  seg.rowColors[0] = 0x0A; // >=8, multicolor character, char color = 2

  const outPixels = new Uint32Array(8);
  const outFgMap = new Uint8Array(8);
  vic._renderSourceColumn(0, 0, seg, outPixels, outFgMap, 0);

  assert(outFgMap.join('') === '00111100', 'multicolor text treats 10/11 as foreground and 00/01 as background');
  assert(outPixels[0] === outPixels[1] && outPixels[2] === outPixels[3] && outPixels[4] === outPixels[5], 'multicolor text expands each 2-bit pixel to two screen pixels');
  console.log('ok  - multicolor text expands 2-bit pixels with the correct palette classes');
}

// Test 5m: idle-state text-mode rendering uses the idle byte as graphics data with c-data forced to zero.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x00;
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x14;

  const seg = makeRenderSeg(vic, {
    displayColumnActive: false,
    rowFetchD011: 0x00,
    rowFetchD016: 0x08,
    rowFetchD018: 0x14,
    idleByte: 0x80,
  });

  clearRenderedRow(vic, 20);
  vic._renderOpenBorderIdleSpan(seg, (20 - 15) * 384, 32, 40);
  assert(firstForegroundX(vic, 20, 32, 40) === 32, 'idle-state text rendering uses the idle byte bits at the left edge of the graphics window');
  console.log('ok  - idle-state text rendering uses the idle byte as graphics data');
}

// Test 5n: mid-line D016 XSCROLL changes split text positioning at the cycle boundary.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x14;
  vic.charRom[8] = 0xFF;
  vic.charRom[16] = 0x00;
  fillTextLineState(vic, vic.regs, { hBorder: false, vBorder: false, rowVcBase: 0, rc: 0 });
  // The XSCROLL split is driven by mid-line $D016 changes via the live
  // per-cycle regs snapshot. rowFetchD016 (the bad-line c-fetch capture)
  // is line-invariant — only its MCM bit feeds rendering, and MCM stays
  // 0 throughout this test.
  for (let cycle = 11; cycle <= 58; cycle++) {
    const xs = cycle >= 20 ? 7 : 0;
    vic.lineCycleRegs[cycle][0x16] = 0x08 | xs;
    for (let col = 0; col < 40; col++) {
      vic.lineCycleRowFetchedCols[cycle][col] = 1;
      vic.lineCycleRowCodes[cycle][col] = (col & 1) ? 2 : 1;
      vic.lineCycleRowColors[cycle][col] = 2;
    }
  }

  clearRenderedRow(vic, 20);
  vic._renderRasterLine(20);

  const rowOffset = (20 - 15) * 384;
  assert(vic.graphicsPriorityBuffer[71] === 1, 'before the D016 split the even column remains visible at the segment boundary');
  assert(vic.graphicsPriorityBuffer[72] === 1, 'after the D016 split the new XSCROLL takes effect immediately for the next segment');
  assert(vic.graphicsPriorityBuffer[79] === 0, 'the shifted post-split segment reflects the new text alignment');
  console.log('ok  - mid-line D016 changes split text positioning at cycle boundaries');
}

// Test 5o: cancelling the top bad line with a mid-line D011 change delays the first visible text row.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B; // DEN=1, RSEL=1, YSCROLL=3
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x14;
  vic.ram[0x0400] = 1;
  vic.colorRam[0] = 2;
  vic.charRom[0] = 0x80; // idle-state glyph data for code 0
  vic.charRom[8] = 0xFF; // text row once the delayed bad line starts
  vic.ram[0x3FFF] = 0x80; // idle byte for standard text mode

  runUntil(vic, 51, 12);
  vic.write(0x11, 0x18); // DEN=1, RSEL=1, YSCROLL=0 cancels the queued bad line
  // Side buffers are line-sized (#1): read each raster at cy0 of the next line.
  runUntil(vic, 52, 0); assert(firstForegroundX(vic, 51, 0, 80) === -1, 'cancelling the top bad line suppresses text on raster 51');
  runUntil(vic, 56, 0); assert(firstForegroundX(vic, 55, 0, 80) === -1, 'text stays delayed until the later raster that matches the new YSCROLL');
  runUntil(vic, 57, 0); assert(firstForegroundX(vic, 56, 0, 96) === 32, 'text restarts on the later raster where the new YSCROLL creates a bad line');
  console.log('ok  - mid-line D011 changes can delay the first visible text row');
}

// Test 5p: mid-line D018 charset-base changes split text glyphs at the
// g-access cycle boundary. Bauer §3.7.4: CB bits of $D018 are sampled at
// each g-access (col K at cy 16+K phi1). So if lineCycleRegs[cycle][0x18]
// flips at cycle N, col K is the first to see the new CB iff its g-access
// cycle 16+K ≥ N → K ≥ N-16. For N=20: K ≥ 4 (col 4 onward use the new
// CB; col 3 and earlier use the old). Canvas X for col 4 = 32 + 4*8 = 64.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x14; // charset base $1000
  vic.charRom[0x008] = 0xFF; // code 1 at $1000
  vic.charRom[0x808] = 0x00; // code 1 at $1800
  fillTextLineState(vic, vic.regs, { hBorder: false, vBorder: false, rowVcBase: 0, rc: 0 });
  for (let cycle = 11; cycle <= 58; cycle++) {
    const d018 = cycle >= 20 ? 0x16 : 0x14; // CB flips at cy 20 phi1
    vic.lineCycleRegs[cycle][0x18] = d018;
    for (let col = 0; col < 40; col++) {
      vic.lineCycleRowFetchedCols[cycle][col] = 1;
      vic.lineCycleRowCodes[cycle][col] = 1;
      vic.lineCycleRowColors[cycle][col] = 2;
    }
  }

  clearRenderedRow(vic, 20);
  vic._renderRasterLine(20);

  const rowOffset = (20 - 15) * 384;
  assert(vic.graphicsPriorityBuffer[63] === 1, 'the old charset base is still visible before the D018 g-access split (col 3 g-access cy 19)');
  assert(vic.graphicsPriorityBuffer[64] === 0, 'the new charset base takes effect at col 4 (g-access cy 20)');
  console.log('ok  - mid-line D018 charset changes split text glyphs at g-access cycle boundaries');
}

// Test 5q: D018 screen-memory base changes on a bad line affect later c-fetches only.
{
  const vic = makeVic();
  vic.rowVcBase = 0;
  vic.vc = 0;
  vic.vmli = 0;
  vic.regs[0x18] = 0x14; // screen base $0400
  vic.ram[0x0400] = 0x11;
  vic.ram[0x0401] = 0x22;
  vic.ram[0x0802] = 0xAA;
  vic.ram[0x0803] = 0xBB;
  vic.colorRam[0] = 0x01;
  vic.colorRam[1] = 0x02;
  vic.colorRam[2] = 0x0A;
  vic.colorRam[3] = 0x0B;

  vic._beginBadLineFetchPhase();
  vic._fetchScreenRowColumn(0, vic.regs, vic.currentVicBank);
  vic._fetchScreenRowColumn(1, vic.regs, vic.currentVicBank);
  vic.regs[0x18] = 0x24; // switch screen base to $0800 mid-fetch
  vic._fetchScreenRowColumn(2, vic.regs, vic.currentVicBank);
  vic._fetchScreenRowColumn(3, vic.regs, vic.currentVicBank);

  assert(vic.rowScreenCodes[0] === 0x11 && vic.rowScreenCodes[1] === 0x22, 'early c-fetches use the old screen-memory base');
  assert(vic.rowScreenCodes[2] === 0xAA && vic.rowScreenCodes[3] === 0xBB, 'later c-fetches use the new screen-memory base');
  assert(vic.rowColorNibbles[2] === 0x0A && vic.rowColorNibbles[3] === 0x0B, 'later c-fetches also pick up color RAM from the new screen row positions');
  console.log('ok  - D018 screen-memory changes affect later bad-line c-fetches only');
}

// Test 5r: text can render under an opened side border when the main border is already reset.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x00; // CSEL=0 would normally cover X=32-38 with border
  vic.regs[0x18] = 0x14;
  vic.charRom[8] = 0xFF;
  fillTextLineState(vic, vic.regs, { hBorder: false, vBorder: false, rowVcBase: 0, rc: 0 });
  for (let cycle = 11; cycle <= 58; cycle++) {
    vic.lineCycleRowFetchedCols[cycle][0] = 1;
    vic.lineCycleRowCodes[cycle][0] = 1;
    vic.lineCycleRowColors[cycle][0] = 2;
  }

  clearRenderedRow(vic, 20);
  vic._renderRasterLine(20);

  assert(firstForegroundX(vic, 20, 0, 96) === 32, 'text remains visible at X=32 when the side border is already opened');
  assert(vic.borderBuffer[32] === 0, 'opened side border no longer covers the left edge of the text window');
  console.log('ok  - opened side borders reveal text under the normal border area');
}


console.log('\nAll Text-mode rendering (Tests 5b-5r) tests passed.');
