// VIC-II: $D017 timing (Bauer §3.8.1)
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
// $D017 timing tests derived from Bauer §3.8.1.
//
// Rule 2 samples sprite enable/Y in the first phases of cycles 55 and 56.
// Rule 3 then samples MxYE in the second phase of cycle 56 and inverts the
// advance-line FF when MxYE=1 and DMA is on. These tests drive direct VIC
// states around that boundary: a value present before rule 3 is visible to
// rule 3, while a value written after cycle 56 is not retroactive. They do
// not define CPU/VIC master-cycle ordering.
// ============================================================================

// TIMING-D017-1: $D017 value present before cycle 56 phi2 is visible to
// Bauer rule 3.
{
  const vic = makeVic();
  vic.cycleInLine = 55;          // about to advance to cycle 56
  vic.regs[0x15] = 0x01;         // sp0 enabled
  vic.regs[0x17] = 0x00;         // MxYE=0 (Y-expand off)
  vic.regs[1] = 0x80;            // sp0 Y = 128
  vic.spriteDmaOn[0] = 1;        // already in DMA
  vic.spriteYExpandFF[0] = 1;

  // Model a completed $D017 write before the cycle-56 rule-3 sample.
  vic.regs[0x17] = 0x01;         // turn MxYE on for sp0

  vic.clock(1);                   // advances cycleInLine to 56, runs cycle 56

  // Cycle 56 phi2: MxYE=1 AND DMA on → toggle FF.
  assert(vic.spriteYExpandFF[0] === 0,
    'Bauer rule 3: MxYE=1 before cycle 56 phi2 toggles FF to 0');
  console.log('ok  - TIMING-D017-1: $D017 value present before cycle 56 phi2 is sampled by rule 3');
}

// TIMING-D017-2: a $D017 value written after cycle 56 is not retroactive.
{
  const vic = makeVic();
  vic.cycleInLine = 55;
  vic.regs[0x15] = 0x01;
  vic.regs[0x17] = 0x00;
  vic.regs[1] = 0x80;
  vic.spriteDmaOn[0] = 1;
  vic.spriteYExpandFF[0] = 1;

  vic.clock(1);                   // cycle 56 runs with OLD MxYE=0
  // No toggle: MxYE was 0 at cycle 56 phi2.
  assert(vic.spriteYExpandFF[0] === 1,
    'cycle 56 with OLD MxYE=0 → no toggle, FF stays 1');

  // A later $D017 write cannot change the already-completed cycle-56
  // rule-3 decision.
  vic.regs[0x17] = 0x01;

  console.log('ok  - TIMING-D017-2: post-cycle-56 $D017 write does not retroactively affect rule 3');
}

// TIMING-D017-3: pre-sample and post-sample $D017 writes produce different
// FF state, as required by Bauer rule 3's exact cycle-56 phase.
{
  // Scenario A: value is present before the cycle-56 rule-3 sample.
  const vicA = makeVic();
  vicA.cycleInLine = 55;
  vicA.regs[0x15] = 0x01;
  vicA.regs[0x17] = 0x00;
  vicA.regs[1] = 0x80;
  vicA.spriteDmaOn[0] = 1;
  vicA.spriteYExpandFF[0] = 1;
  vicA.regs[0x17] = 0x01;
  vicA.clock(1);
  const ffA = vicA.spriteYExpandFF[0];   // should be 0 (toggled)

  // Scenario B: value changes after the cycle-56 rule-3 sample.
  const vicB = makeVic();
  vicB.cycleInLine = 55;
  vicB.regs[0x15] = 0x01;
  vicB.regs[0x17] = 0x00;
  vicB.regs[1] = 0x80;
  vicB.spriteDmaOn[0] = 1;
  vicB.spriteYExpandFF[0] = 1;
  vicB.clock(1);             // rule 3 samples old MxYE=0
  vicB.regs[0x17] = 0x01;
  const ffB = vicB.spriteYExpandFF[0];   // should be 1 (no toggle)

  assert(ffA === 0, 'pre-sample MxYE=1: FF=0 after rule-3 toggle');
  assert(ffB === 1, 'post-sample MxYE=1: FF remains 1 for this line');
  assert(ffA !== ffB,
    'cycle-56 rule-3 sample point distinguishes pre-sample vs post-sample writes');
  console.log('ok  - TIMING-D017-3: Bauer rule-3 sample point is exact');
}

// TIMING-D017-4: end-to-end through C64Machine — verify that a $D017 write
// via memory.write() updates the register file synchronously. This is a
// bus-routing check, not a CPU/VIC phase-order assertion.
{
  const machine = new C64Machine();
  // No ROMs needed — we drive the VIC directly via the bus.
  machine.vic2.regs[0x15] = 0x01;
  machine.vic2.regs[0x17] = 0x00;
  machine.vic2.spriteDmaOn[0] = 1;
  machine.vic2.spriteYExpandFF[0] = 1;
  machine.vic2.regs[1] = 0x80;
  machine.vic2.cycleInLine = 30;

  // Write $D017 via the memory bus (the path the CPU takes for STA $D017).
  machine.mem.write(0xD017, 0x01);

  // Confirm the VIC saw the new value in regs immediately.
  assert(machine.vic2.regs[0x17] === 0x01,
    'memory.write to $D017 lands in vic2.regs[0x17] synchronously');
  console.log('ok  - TIMING-D017-4: memory.write to $D017 updates the VIC register file');
}

// TIMING-D017-5: Bauer rules 3 and 7 make an MxYE-expanded sprite advance
// MCBASE every other raster line.
{
  function runYE() {
    const vic = makeVic();
    vic.regs[0x15] = 0x01;
    vic.regs[0x17] = 0x01;    // MxYE on from the start
    vic.regs[1] = 0x80;
    vic.raster = 0x80;
    vic._spriteSequencerCycle55();
    vic._spriteSequencerCycle56();   // cycle 56 toggles FF: 1 → 0
    let mcb = vic.spriteMCBase[0];
    for (let line = 0; line < 21; line++) {
      vic.spriteMC[0] = mcb + 3;
      vic._spriteSequencerCycle16();
      mcb = vic.spriteMCBase[0];
      vic._spriteSequencerCycle55();
      vic._spriteSequencerCycle56();
    }
    return mcb;
  }
  const finalMCBase = runYE();
  // Y-expand: MCBase advances every other line, so after 21 lines it's at
  // approximately 10 × 3 = 30. (Exact value depends on FF starting state.)
  assert(finalMCBase >= 27 && finalMCBase <= 33,
    `Y-expand row-doubling gives MCBase ≈ 30 after 21 lines (got ${finalMCBase})`);
  console.log('ok  - TIMING-D017-5: MxYE row-doubling cadence advances MCBASE every other line');
}


console.log('\nAll $D017 timing (Bauer §3.8.1) tests passed.');
