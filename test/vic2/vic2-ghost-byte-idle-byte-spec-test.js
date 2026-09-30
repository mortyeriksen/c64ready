// VIC-II: Ghost-byte shine-through + idle-byte alignment (Tests 22-30)
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

// Test 22: Ghost-byte shine-through populates foreground priority map in open side borders.
{
  const vic = makeVic();
  const seg = makeRenderSeg(vic, {
    displayColumnActive: false,
    idleByte: 0xAA, // Binary 10101010
  });
  vic.regs[0x11] = 0x1B; // DEN=1, RSEL=1, standard text
  seg.regs[0x11] = 0x1B;

  const rowOffset = 0;
  // Render an 8-pixel span right after the right graphics window closes (X=352)
  vic._renderOpenBorderIdleSpan(seg, rowOffset, 352, 360);

  assert(vic.graphicsPriorityBuffer[352] === 1, 'bit 7 of 0xAA is 1, creating a foreground mask pixel');
  assert(vic.graphicsPriorityBuffer[353] === 0, 'bit 6 of 0xAA is 0, leaving background');
  assert(vic.graphicsPriorityBuffer[359] === 0, 'bit 0 of 0xAA is 0, leaving background');
  console.log('ok  - ghost-byte shine-through populates foreground priority map');
}

// Test 23: Mode $70 behaves like ECM for the ghost byte, creating a solid mask.
{
  const vic = makeVic();
  const seg = makeRenderSeg(vic, {
    displayColumnActive: false,
    idleByte: 0xFF, // Solid mask
  });
  // Mode $70 = ECM (0x40) + BMM (0x20) + DEN (0x10) + RSEL (0x08)
  vic.regs[0x11] = 0x7B;
  seg.regs[0x11] = 0x7B;

  const rowOffset = 0;
  vic._renderOpenBorderIdleSpan(seg, rowOffset, 352, 360);

  assert(vic.graphicsPriorityBuffer[352] === 1, 'Mode $70 ghost byte treats 1s as foreground priority');
  assert(vic.fb32[352] === 0xFF000000, 'Mode $70 ghost byte renders as black');
  console.log('ok  - Mode $70 behaves like ECM for the ghost byte mask');
}

// Test 24: Sprites with priority 1 are correctly masked by ghost-byte shine-through.
{
  const vic = makeVic();
  const canvasY = 40;
  const rowOffset = canvasY * 384;
  fillSpriteLineState(vic);
  clearRenderedRow(vic, canvasY + 15);

  // Setup a sprite in the right border (canvas X=352..375 — reg X=344 with
  // the renderer's +8 canvas offset).
  fillOpaqueSpriteAcrossLine(vic, 0, 344);
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleRegs[cycle][0x1B] |= 0x01; // sprPri = 1 (behind foreground)
  }

  // Simulate the ghost byte writing a solid mask to BOTH priority and
  // collision buffers across the sprite's first 8 canvas-X pixels.
  for (let x = 352; x < 360; x++) {
    vic.graphicsPriorityBuffer[x] = 1;
    vic.graphicsCollisionBuffer[x] = 1;
    vic.fb32[rowOffset + x] = 0xFF000000; // Black ghost byte pixels
  }

  vic._renderSpriteLine(55, canvasY);

  assert(vic.fb32[rowOffset + 352] === 0xFF000000, 'sprite is hidden behind ghost byte mask');
  assert((vic.regs[0x1F] & 0x01) === 0x01, 'sprite-background collision still latches against the ghost byte');
  console.log('ok  - sprites with priority 1 are masked by ghost-byte shine-through');
}

// Test 25: Cycle 59 next-line fetch must not corrupt the current line's sprite.
{
  const vic = makeVic();
  const canvasY = 40;
  const rowOffset = canvasY * 384;
  fillSpriteLineState(vic);
  clearRenderedRow(vic, canvasY + 15);

  // Create a sprite at X=300 (drawn near the end of the line)
  fillOpaqueSpriteAcrossLine(vic, 0, 300, { shiftReg: 0xFFFFFF });

  // At cycle 59 (X=376), hardware fetches the NEXT line's sprite data.
  // The captured segment state reflects this new shift register.
  for (let cycle = 59; cycle <= 63; cycle++) {
    vic.lineCycleSpriteShiftReg[cycle][0] = 0x000000;
  }

  vic._renderSpriteLine(55, canvasY);

  // The sprite should render fully up to 324 using the original 0xFFFFFF data.
  // If it fails, the mid-line reseed is destructively overriding the active shift register.
  assert(vic.spriteCollisionBuffer[323] !== 0, 'current line sprite render is immune to cycle 59 next-line fetch');
  console.log('ok  - sprite shift register is immune to next-line fetches');
}

// Test 26: Idle byte shifting must be aligned to the global 8-pixel character grid.
{
  const vic = makeVic();
  const seg = makeRenderSeg(vic, {
    displayColumnActive: false,
    idleByte: 0x80, // bit 7 is 1, others 0
  });
  vic.regs[0x11] = 0x1B;
  seg.regs[0x11] = 0x1B;

  vic._renderOpenBorderIdleSpan(seg, 0, 352, 360);
  assert(vic.graphicsPriorityBuffer[352] === 1, 'bit 7 of idle byte falls on X=352 (aligned)');
  assert(vic.graphicsPriorityBuffer[353] === 0, 'bit 6 falls on X=353');

  // Render a sub-segment starting at 354
  vic.graphicsPriorityBuffer.fill(0);
  vic._renderOpenBorderIdleSpan(seg, 0, 354, 360);
  assert(vic.graphicsPriorityBuffer[354] === 0, 'sub-segment rendering preserves global X alignment');
  console.log('ok  - idle byte shifting is aligned to global 8-pixel grid');
}

// Test 28: Sprite sub-pixel phase is correctly maintained across 8-pixel segment boundaries.
{
  const vic = makeVic();
  const canvasY = 40;
  const rowOffset = canvasY * 384;
  fillSpriteLineState(vic);
  clearRenderedRow(vic, canvasY + 15);

  // X-Expanded sprite starts at X=25. It crosses a segment boundary at X=32.
  fillOpaqueSpriteAcrossLine(vic, 0, 25, { xExpand: true, shiftReg: 0xAAAAAA });

  vic._renderSpriteLine(55, canvasY);

  // An X-expanded pixel is 2 canvas pixels wide. 
  // If the phase resets at the boundary (X=32), the pixel widths will be corrupted.
  assert(vic.spriteCollisionBuffer[31] === vic.spriteCollisionBuffer[32], 'sprite pixel width is preserved across segment boundary');
  console.log('ok  - sprite sub-pixel phase is maintained across boundaries');
}

// Test 29: Open left border (X < 32) shifts the idle g-byte. In side-border-
// open mode the shifter keeps clocking the idle data across the full row —
// that's the visible "ribbon" pattern in real C64 demos. In invalid bitmap
// mode 110/111 every pixel is BLACK regardless of shifter state per Bauer
// §3.7.3.7-8, but the foreground/priority map still reflects the idle bits.
{
  const vic = makeVic();
  const seg = makeRenderSeg(vic, {
    displayColumnActive: false,
    idleByte: 0xFF,
  });
  vic.regs[0x11] = 0x7B; // Mode $70
  seg.regs[0x11] = 0x7B;

  const rowOffset = 0;
  vic.fb32.fill(0xFF111111);

  vic._renderOpenBorderIdleSpan(seg, rowOffset, 0, 32);

  assert(vic.graphicsPriorityBuffer[31] === 1,
    'left border priority follows idle byte bits (ribbon visible across X<32)');
  assert(vic.fb32[31] === 0xFF000000,
    'mode 110 left border renders BLACK (per spec; every pixel BLACK regardless of shifter)');
  assert(vic.fb32[31] !== 0xFF111111,
    'left border successfully overwrites pre-existing pixel');
  console.log('ok  - open left border in mode 110 renders BLACK with idle byte driving foreground map');
}

// Test 30: Right border in mode 110 — pixels are BLACK whether the shifter
// is in the ghost-byte window (X 352..359) or in the side-border-open ribbon
// region (X >= 360). With idle byte 0xFF the foreground map stays set across
// the whole span; the rendered color is BLACK throughout per spec.
{
  const vic = makeVic();
  const seg = makeRenderSeg(vic, {
    displayColumnActive: false,
    idleByte: 0xFF,
  });
  vic.regs[0x11] = 0x7B; // Mode $70
  seg.regs[0x11] = 0x7B;

  const rowOffset = 0;
  vic.fb32.fill(0xFF111111);

  vic._renderOpenBorderIdleSpan(seg, rowOffset, 352, 368);

  assert(vic.graphicsPriorityBuffer[352] === 1, 'X=352 priority set by idle byte');
  assert(vic.fb32[359] === 0xFF000000, 'X=359 mode 110 renders BLACK');

  assert(vic.graphicsPriorityBuffer[360] === 1,
    'X=360 priority still set — open right border keeps shifting idle byte');
  assert(vic.fb32[360] === 0xFF000000,
    'X=360 still renders BLACK in mode 110 (every pixel is black per spec)');
  assert(vic.fb32[360] !== 0xFF111111, 'X=360 overwrote the pre-existing pixel');

  console.log('ok  - mode 110 right-border ribbon: priority follows idle byte across X=352..367');
}



console.log('\nAll Ghost-byte shine-through + idle-byte alignment (Tests 22-30) tests passed.');
