// VIC-II: Sprite rendering edge cases (Tests 10b-10l)
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

// Test 10b: adjacent hi-res sprites render with no 1-pixel seam.
{
  const vic = makeVic();
  const canvasY = 40;
  const rowOffset = canvasY * 384;
  fillSpriteLineState(vic);
  vic.borderBuffer.fill(0, 0, 384);
  vic.graphicsPriorityBuffer.fill(0, 0, 384);
  vic.graphicsCollisionBuffer.fill(0, 0, 384);
  vic.spriteCollisionBuffer.fill(0, 0, 384);

  fillOpaqueSpriteAcrossLine(vic, 0, 24);
  fillOpaqueSpriteAcrossLine(vic, 1, 48);
  vic._renderSpriteLine(55, canvasY);

  // Renderer maps canvas X = sprite reg X + 8, so the sprites span
  // canvas X 32..79.
  for (let x = 32; x < 80; x++) {
    assert(vic.spriteCollisionBuffer[x] !== 0, 'adjacent hi-res sprites must cover all seam pixels');
  }
  console.log('ok  - adjacent hi-res sprites have no seam');
}

// Test 10c: adjacent x-expanded sprites render with no 1-pixel seam.
{
  const vic = makeVic();
  const canvasY = 40;
  const rowOffset = canvasY * 384;
  fillSpriteLineState(vic);
  vic.borderBuffer.fill(0, 0, 384);
  vic.graphicsPriorityBuffer.fill(0, 0, 384);
  vic.graphicsCollisionBuffer.fill(0, 0, 384);
  vic.spriteCollisionBuffer.fill(0, 0, 384);

  fillOpaqueSpriteAcrossLine(vic, 0, 24, { xExpand: true });
  fillOpaqueSpriteAcrossLine(vic, 1, 72, { xExpand: true });
  vic._renderSpriteLine(55, canvasY);

  // canvas X = reg X + 8 → sprites span 32..79 and 80..127.
  for (let x = 32; x < 128; x++) {
    assert(vic.spriteCollisionBuffer[x] !== 0, 'adjacent x-expanded sprites must cover all seam pixels');
  }
  console.log('ok  - adjacent x-expanded sprites have no seam');
}

// Test 10d: adjacent multicolor sprites render with no 1-pixel seam.
{
  const vic = makeVic();
  const canvasY = 40;
  const rowOffset = canvasY * 384;
  fillSpriteLineState(vic);
  vic.borderBuffer.fill(0, 0, 384);
  vic.graphicsPriorityBuffer.fill(0, 0, 384);
  vic.graphicsCollisionBuffer.fill(0, 0, 384);
  vic.spriteCollisionBuffer.fill(0, 0, 384);

  fillOpaqueSpriteAcrossLine(vic, 0, 24, { multicolor: true });
  fillOpaqueSpriteAcrossLine(vic, 1, 48, { multicolor: true });
  vic._renderSpriteLine(55, canvasY);

  // canvas X = reg X + 8 → sprites span 32..79.
  for (let x = 32; x < 80; x++) {
    assert(vic.spriteCollisionBuffer[x] !== 0, 'adjacent multicolor sprites must cover all seam pixels');
  }
  console.log('ok  - adjacent multicolor sprites have no seam');
}

// Test 10e: live DMA-driven adjacent sprites also render without a seam.
{
  const vic = makeVic();
  for (let s = 0; s < 2; s++) {
    vic.regs[0x15] |= (1 << s);
    vic.regs[0x27 + s] = 2;
  }
  vic.regs[0x00] = 24;
  vic.regs[0x01] = 58; // sprite becomes visible from raster 59
  vic.regs[0x02] = 48;
  vic.regs[0x03] = 58;
  vic.ram[0x07F8] = 0x20;
  vic.ram[0x07F9] = 0x21;
  for (let i = 0; i < 63; i++) {
    vic.ram[0x20 * 64 + i] = 0xFF;
    vic.ram[0x21 * 64 + i] = 0xFF;
  }

  runUntil(vic, 61, 0); // raster 59 and 60 rendered
  const rowOffset = (59 - 15) * 384;
  // canvas X = reg X + 8 → sprites span 32..79
  for (let x = 32; x < 80; x++) {
    assert(vic.spriteCollisionBuffer[x] !== 0, 'live adjacent sprites must cover all seam pixels');
  }
  console.log('ok  - live adjacent sprites have no seam');
}

// Test 10f: sprite rendering uses captured per-segment sprite data, not the final line-global snapshot.
{
  const vic = makeVic();
  const canvasY = 40;
  const rowOffset = canvasY * 384;
  fillSpriteLineState(vic);
  vic.borderBuffer.fill(0, 0, 384);
  vic.graphicsPriorityBuffer.fill(0, 0, 384);
  vic.graphicsCollisionBuffer.fill(0, 0, 384);
  vic.spriteCollisionBuffer.fill(0, 0, 384);

  fillOpaqueSpriteAcrossLine(vic, 0, 56);
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleSpriteDataRow[cycle][0] = 0;
    vic.lineCycleSpriteRowByteMask[cycle][0] = 0x07;
    vic.lineCycleSpriteShiftReg[cycle][0] = cycle < 20 ? 0xFFFFFF : 0x000000;
  }
  vic.spriteLineDataRow[0] = 0;
  vic.spriteRowByteMask[0] = 0x07;
  vic.spriteShiftReg[0] = 0x000000;

  vic._renderSpriteLine(55, canvasY);

  // canvas X = reg X + 8 → sprite at reg 56 starts at canvas 64.
  for (let x = 64; x < 72; x++) {
    assert(vic.spriteCollisionBuffer[x] !== 0, 'captured early sprite segments remain visible');
  }
  for (let x = 72; x < 88; x++) {
    assert(vic.spriteCollisionBuffer[x] === 0, 'later sprite segments follow their captured empty shift register');
  }
  console.log('ok  - sprite rendering follows per-segment captured sprite data');
}

// Test 10g: multicolor sprite reseed preserves sub-pixel phase across segment boundaries.
{
  const vic = makeVic();
  const canvasY = 40;
  const rowOffset = canvasY * 384;
  fillSpriteLineState(vic);
  vic.borderBuffer.fill(0, 0, 384);
  vic.graphicsPriorityBuffer.fill(0, 0, 384);
  vic.graphicsCollisionBuffer.fill(0, 0, 384);
  vic.spriteCollisionBuffer.fill(0, 0, 384);

  fillOpaqueSpriteAcrossLine(vic, 0, 25, { multicolor: true });
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleSpriteDataRow[cycle][0] = 0;
    vic.lineCycleSpriteRowByteMask[cycle][0] = 0x07;
    vic.lineCycleSpriteShiftReg[cycle][0] = cycle < 16 ? 0xFFFFFF : 0x800000;
  }
  vic.spriteLineDataRow[0] = 0;
  vic.spriteRowByteMask[0] = 0x07;
  vic.spriteShiftReg[0] = 0x800000;

  vic._renderSpriteLine(55, canvasY);

  // canvas X = reg X + 8 → sprite at reg 25 starts at canvas 33; pair-boundary
  // probe at canvas 40 (= reg 32) / canvas 41 (= reg 33).
  assert(vic.spriteCollisionBuffer[40] !== 0, 'reseeded multicolor sprite keeps the final pixel of the current pair');
  assert(vic.spriteCollisionBuffer[41] === 0, 'reseeded multicolor sprite advances to the next pair without duplicating a pixel');
  console.log('ok  - multicolor sprite reseed preserves phase across segment boundaries');
}

// Test 10h: sprite X can change before the first visible pixel and the later X wins.
{
  const vic = makeVic();
  const canvasY = 40;
  const rowOffset = canvasY * 384;
  fillSpriteLineState(vic);
  vic.borderBuffer.fill(0, 0, 384);
  vic.graphicsPriorityBuffer.fill(0, 0, 384);
  vic.graphicsCollisionBuffer.fill(0, 0, 384);
  vic.spriteCollisionBuffer.fill(0, 0, 384);

  fillOpaqueSpriteAcrossLine(vic, 0, 24, { multicolor: true });
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleRegs[cycle][0x15] |= 0x01;
    vic.lineCycleRegs[cycle][0x1C] |= 0x01;
    vic.lineCycleSpriteDisplayOn[cycle][0] = 1;
    vic.lineCycleSpriteDataRow[cycle][0] = 0;
    vic.lineCycleSpriteRowByteMask[cycle][0] = 0x07;
    vic.lineCycleSpriteShiftReg[cycle][0] = 0xFFFFFF;
    vic.lineCycleRegs[cycle][0x00] = cycle < 15 ? 24 : 40;
  }

  vic._renderSpriteLine(55, canvasY);

  // canvas X = reg X + 8 → reg 24 → canvas 32; reg 40 → canvas 48.
  for (let x = 32; x < 48; x++) {
    assert(vic.spriteCollisionBuffer[x] === 0, 'pre-start X rewrites must not render at the stale earlier X');
  }
  for (let x = 48; x < 72; x++) {
    assert(vic.spriteCollisionBuffer[x] !== 0, 'sprite rendering must begin at the later X written before display starts');
  }
  console.log('ok  - sprite start uses the latest pre-display X value');
}

// Test 10i: line start preserves the latched sprite row, and cycle 58 never exposes row 21.
{
  const vic = makeVic();
  vic.spriteDmaOn[0] = 1;
  vic.spriteDisplayOn[0] = 1;
  vic.spriteMC[0] = 63;
  vic.spriteMCBase[0] = 60;
  vic.spriteLineDataRow[0] = 20;

  vic._beginRasterLine(120);
  assert(vic.spriteDisplayOn[0] === 1, 'line start must preserve the final latched sprite row for the current raster');
  assert(vic.spriteLineDataRow[0] === 20, 'line start must not advance the sprite row ahead of rendering');

  vic.spriteDmaOn[0] = 1;
  vic.spriteDisplayOn[0] = 1;
  vic.spriteMCBase[0] = 63;
  vic.spriteMC[0] = 60;
  vic.spriteLineDataRow[0] = 20;
  vic._spriteSequencerCycle58();
  assert(vic.spriteDisplayOn[0] === 0, 'cycle 58 must end sprite display when MCBASE reaches 63');
  assert(vic.spriteLineDataRow[0] === -1, 'cycle 58 must not latch sprite row 21');
  console.log('ok  - sprite reuse path never exposes row 21');
}

// Test 10j: sprite priority only hides sprites behind foreground graphics, but
// collisions still latch from the sequencer output.
{
  const vic = makeVic();
  const canvasY = 40;
  const rowOffset = canvasY * 384;
  fillSpriteLineState(vic);
  clearRenderedRow(vic, canvasY + 15);
  fillOpaqueSpriteAcrossLine(vic, 0, 24);
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleRegs[cycle][0x1B] |= 0x01; // sprite 0 behind foreground
  }

  // canvas X = reg X + 8 → sprite at reg 24 starts at canvas 32.
  const blockedIdx = 32;  // canvas column (side buffers line-sized #1)
  const visibleIdx = rowOffset + 33;
  vic.fb32[blockedIdx] = 0x11223344;
  vic.graphicsPriorityBuffer[blockedIdx] = 1;
  vic.graphicsCollisionBuffer[blockedIdx] = 1;

  vic._renderSpriteLine(55, canvasY);

  assert(vic.fb32[blockedIdx] === 0x11223344, 'sprite behind foreground must not overwrite the foreground pixel');
  assert(vic.fb32[visibleIdx] !== 0, 'sprite behind foreground remains visible where no foreground graphics exist');
  assert((vic.regs[0x1F] & 0x01) === 0x01, 'sprite-background collision still latches behind-foreground sprite pixels');
  console.log('ok  - sprite priority hides only foreground-covered pixels and still latches collisions');
}

// Test 10k: sprite X MSB in $D010 places the sprite beyond X=255.
{
  const vic = makeVic();
  const canvasY = 40;
  const rowOffset = canvasY * 384;
  fillSpriteLineState(vic);
  clearRenderedRow(vic, canvasY + 15);
  fillOpaqueSpriteAcrossLine(vic, 0, 280);

  vic._renderSpriteLine(55, canvasY);

  // canvas X = reg X + 8 → sprite at reg 280 spans canvas 288..311.
  for (let x = 288; x < 312; x++) {
    assert(vic.spriteCollisionBuffer[x] !== 0, 'sprite X MSB must extend the sprite into the 256-319 range');
  }
  assert(vic.spriteCollisionBuffer[287] === 0, 'sprite does not start before its 9-bit X coordinate');
  console.log('ok  - sprite X MSB places sprites correctly beyond X=255');
}

// Test 10l: sprite pointer fetch uses the current VIC bank and D018 screen base.
{
  const vic = makeVic();
  vic.currentVicBank = 0x8000;
  vic.regs[0x15] = 0x01;
  vic.regs[0x18] = 0x20; // screen base $0800 inside current VIC bank
  vic.spriteDmaOn[0] = 1;
  vic.ram[0x8000 + 0x0800 + 0x03F8] = 0x22;
  vic.ram[0x8000 + 0x22 * 64 + 0] = 0x12;
  vic.ram[0x8000 + 0x22 * 64 + 1] = 0x34;
  vic.ram[0x8000 + 0x22 * 64 + 2] = 0x56;

  vic._spriteSequencerPointerAccess(58);

  assert(vic.spritePointerFresh[0] === 1, 'sprite pointer fetch marks the pointer as fresh');
  assert(vic.spritePointerValue[0] === 0x22, 'sprite pointer fetch reads from the current bank and screen base');
  assert(vic.spriteDataBase[0] === 0x22 * 64, 'sprite pointer fetch converts the pointer to a sprite data base');

  vic._spriteSequencerRowAccess(59);

  assert(vic.spriteRowData[0][0] === 0x12, 'sprite row fetch reads byte 0 from the banked sprite data');
  assert(vic.spriteRowData[0][1] === 0x34, 'sprite row fetch reads byte 1 from the banked sprite data');
  assert(vic.spriteRowData[0][2] === 0x56, 'sprite row fetch reads byte 2 from the banked sprite data');
  console.log('ok  - sprite pointer and row fetch honor VIC bank and D018 screen base');
}


console.log('\nAll Sprite rendering edge cases (Tests 10b-10l) tests passed.');
