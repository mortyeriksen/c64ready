// VIC-II: $D015 (sprite enable) mid-line changes
// Extracted from vic2-test.js.

import {
  VIC2,
  CANVAS_W,
  CANVAS_H,
  CYCLES_PER_FRAME,
  CYCLES_PER_LINE,
  C64_PALETTE,
  C64Machine,
  paletteRgba,
  ACCESS_IDLE,
  ACCESS_REFRESH,
  ACCESS_C,
  ACCESS_G,
  assert,
  softAssert,
  makeVic,
  makeRenderSeg,
  fillSpriteLineState,
  fillOpaqueSpriteAcrossLine,
  clearLineBuffers,
  setupSpriteForRender,
  setMulticolorRegs,
  fillTextLineState,
  clearRenderedRow,
  firstForegroundX,
  lastForegroundX,
  runUntil,
  makeMasterCycleHarness,
} from './_vic2-helpers.js';

// ============================================================================
// $D015 (sprite enable) mid-line changes.
// $D015 is sampled at cycle 55 (rule 2, first DMA-start check) and cycle 56
// (rule 2, second DMA-start check). Only writes that land before/at those
// cycles affect DMA-start for THIS line; later writes take effect next line.
// ============================================================================

// D015-MID-1: enabling a sprite BEFORE cycle 55 starts DMA on that sprite.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x00;       // all sprites disabled
  vic.regs[0x17] = 0x00;       // no Y-expand (yExpFF=1 unconditionally per rule 1)
  vic.regs[1] = 100;           // sprite 0 Y = 100
  vic.spriteMCBase[0] = 0;
  vic.spriteDmaOn[0] = 0;
  vic.spriteYExpandFF[0] = 1;
  vic.raster = 100;            // raster matches sprite Y → DMA-start condition met

  // CPU writes $D015 at (say) cycle 50 — well before cycle 55.
  vic.regs[0x15] = 0x01;
  vic._spriteSequencerCycle55();
  assert(vic.spriteDmaOn[0] === 1,
    '$D015 enable seen at cycle 55 starts sprite 0 DMA');
  console.log('ok  - D015-MID-1: enabling $D015 before cycle 55 starts sprite DMA on the same line');
}

// D015-MID-2: enabling AFTER cycle 56 misses the DMA-start window — DMA
// stays off this line.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x00;
  vic.regs[0x17] = 0x00;
  vic.regs[1] = 100;
  vic.spriteMCBase[0] = 0;
  vic.spriteDmaOn[0] = 0;
  vic.spriteYExpandFF[0] = 1;
  vic.raster = 100;

  // Both DMA-start cycles run with $D015=0:
  vic._spriteSequencerCycle55();
  vic._spriteSequencerCycle56();
  assert(vic.spriteDmaOn[0] === 0,
    '$D015=0 across cycles 55-56 keeps DMA off');

  // CPU writes $D015 at cycle 57 — after both DMA-start checks. No effect
  // on this line.
  vic.regs[0x15] = 0x01;
  // (No more sequencer hooks fire on this line for DMA-start.)
  assert(vic.spriteDmaOn[0] === 0,
    'Bauer §3.8.1 rule 2: write to $D015 after cycle 56 has no effect on this line');
  console.log('ok  - D015-MID-2: enabling $D015 after cycle 56 misses the DMA-start window');
}

// D015-MID-3: enabling between cycles 55 and 56 still catches the second
// DMA-start check (cycle 56 phi1). This is the "DMA-start window is two
// cycles wide" property.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x00;
  vic.regs[0x17] = 0x00;
  vic.regs[1] = 100;
  vic.spriteMCBase[0] = 0;
  vic.spriteDmaOn[0] = 0;
  vic.spriteYExpandFF[0] = 1;
  vic.raster = 100;

  vic._spriteSequencerCycle55();
  assert(vic.spriteDmaOn[0] === 0, '$D015=0 at cycle 55 leaves DMA off');

  // CPU enables sprite between cycles 55 and 56.
  vic.regs[0x15] = 0x01;
  vic._spriteSequencerCycle56();
  assert(vic.spriteDmaOn[0] === 1,
    'Bauer §3.8.1 rule 2: cycle-56 second check still catches a fresh enable');
  console.log('ok  - D015-MID-3: enabling $D015 between cycles 55 and 56 still starts DMA');
}

// D015-MID-4: per-segment $D015 capture. Mid-line $D015 changes are
// captured per cycle in `lineCycleRegs`, so the segments built for sprite
// rendering see the post-write value at later cycles. Verifies that the
// register-change matrix records the live mid-line write.
{
  const vic = makeVic();
  vic.raster = 100;
  vic.regs[0x15] = 0x00;
  vic._captureCycleState(20);              // pre-write capture
  vic.write(0x15, 0xFF);                   // mid-line change arrives via a CPU write
  vic._captureCycleState(40);              // post-write capture

  assert(vic.lineCycleRegs[20][0x15] === 0x00,
    'pre-write cycle captures $D015=$00');
  assert(vic.lineCycleRegs[40][0x15] === 0xFF,
    'post-write cycle captures $D015=$FF — mid-line change visible to renderer');
  console.log('ok  - D015-MID-4: mid-line $D015 changes are captured in lineCycleRegs per cycle');
}


console.log('\nAll $D015 (sprite enable) mid-line changes tests passed.');
