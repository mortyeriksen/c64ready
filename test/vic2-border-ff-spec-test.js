// VIC-II: Border flip-flops + bad-line edges (Tests 11-13)
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

// Test 11: border flip-flops follow top/bottom and left/right compare rules.
// Bauer §3.9, modeled as the chip's two-stage flip-flop (validated against
// dentest den10-51-N / denrsel-* and VICE):
//   • Vertical FF — re-evaluated every cycle: top compare (start line + DEN)
//     clears it at the START of the line (cycle 1); bottom compare (stop line)
//     arms the latch that the cycle-1 copy applies. Lives in
//     `_advanceVerticalBorderFlipFlop()`.
//   • Main/horizontal FF — opens at the left compare ONLY when the vertical FF
//     is clear, closes at the right compare. Lives in
//     `_advanceHorizontalBorderState()`.
{
  const vic = makeVic();
  const regs = vic.regs;
  vic.displayEnabled = true;
  regs[0x11] = 0x1B; // DEN=1, RSEL=1
  regs[0x16] = 0x08; // CSEL=1

  // Top compare at L51 with DEN=1 → vertical FF reset at line start (cycle 1).
  vic.raster = 51; vic.cycleInLine = 1;
  vic.vBorderActive = true; vic._vBorderLatch = true;
  vic._advanceVerticalBorderFlipFlop();
  assert(vic.vBorderActive === false, 'top compare (L51, DEN=1) resets the vertical FF at line start');

  // Top compare with DEN=0 → no reset (open-border-trick precondition).
  regs[0x11] = 0x0B; // DEN=0, RSEL=1
  vic.raster = 51; vic.cycleInLine = 1;
  vic.vBorderActive = true; vic._vBorderLatch = true;
  vic._advanceVerticalBorderFlipFlop();
  assert(vic.vBorderActive === true, 'top compare with DEN=0 does NOT reset the vertical FF');

  // Main FF: the left compare opens it ONLY when the vertical FF is clear.
  // vertical FF set → main border stays closed across the left edge.
  regs[0x11] = 0x0B;
  vic.vBorderActive = true; vic.hBorderActive = true;
  vic._advanceHorizontalBorderState(15, regs);
  assert(vic.hBorderActive === true, 'main border stays set at the left compare while the vertical FF is set');

  // vertical FF clear → left compare opens the main border.
  vic.vBorderActive = false; vic.hBorderActive = true;
  vic._advanceHorizontalBorderState(15, regs);
  assert(vic.hBorderActive === false, 'left compare opens the main border when the vertical FF is clear');

  vic.hBorderActive = false;
  vic._advanceHorizontalBorderState(55, regs);
  assert(vic.hBorderActive === true, 'right compare closes the main border');

  // Bottom compare at L251 → latch armed; the cycle-1 copy closes the vertical FF.
  regs[0x11] = 0x1B;
  vic.raster = 251; vic.cycleInLine = 1;
  vic.vBorderActive = false; vic._vBorderLatch = false;
  vic._advanceVerticalBorderFlipFlop();
  assert(vic.vBorderActive === true, 'bottom compare (L251) closes the vertical FF');
  console.log('ok  - border flip-flops follow top/bottom and left/right compare rules');
}

// Test 12: suppressing the queued bad line before cycle 15 prevents the next
// text-line start (FLD-style delayed bad line). FLD is performed by changing
// YSCROLL so the cycle-14 bad-line check no longer matches; live DEN does
// NOT suppress bad-lines once the raster-$30 latch is set (see _isBadLine
// comment for details).
{
  const vic = makeVic();
  const raster = 0x30;
  vic.displayEnabled = true;
  vic.displayActive = true;
  vic.rc = 7;
  vic.regs[0x11] = 0x10 | 0x00; // DEN=1, YSCROLL=0

  vic._updateBadLineStateForCycle(12, raster);
  assert(vic.lineBadLineDisplayPending === true, 'bad line before cycle 15 queues c-fetch phase');
  assert(vic.lineBadLineStartCycle === 15, 'early bad line queues c-fetches for cycle 15');

  vic.regs[0x11] = 0x10 | 0x01; // YSCROLL=1 → no longer matches raster $30 & 7 = 0
  vic._updateBadLineStateForCycle(13, raster);
  vic._advanceDisplayStateCycle14(raster);
  vic._advanceDisplayStateCycle58(raster);

  assert(vic.lineBadLineDisplayPending === false, 'bad-line fetch phase cancels before it starts');
  assert(vic.lineBadLineStartCycle === -1, 'cancelled bad line clears queued start cycle');
  assert(vic.displayActive === false, 'without the bad line, the current text line finishes and the sequencer returns to idle');
  console.log('ok  - suppressing a queued bad line delays the next text-line start');
}

// Test 13: creating a bad line mid-window starts matrix fetches in the
// same line (FLI/DMA-delay style behavior). Per Bauer §3.14.6, BA goes
// low AND c-accesses start in the cycle the trigger is observed (= one
// cycle after the CPU write in real flow). The display-state transition
// happens at the observation cycle before the g-access phase, so VC
// advances in lock-step with the same-cycle c-access.
{
  const vic = makeVic();
  const raster = 0x30;
  vic.displayEnabled = true;
  vic.vc = 0;
  vic.vmli = 0;
  vic.regs[0x11] = 0x10 | 0x00; // DEN=1, YSCROLL=0

  vic._updateBadLineStateForCycle(20, raster);

  assert(vic.displayActive === true, 'mid-line bad line trigger switches display state at observation cycle');
  assert(vic.lineBadLineDisplayPending === true, 'mid-line bad line queues a c-fetch phase');
  assert(vic.lineBadLineStartCycle === 20, 'mid-line bad line queues c-fetches at the observation cycle (Bauer §3.14.6: same cycle as BA-low)');
  assert(vic.lineBadLineInvalidCReadsPending === 3, 'late-start bad line models initial invalid c-fetches');

  // Same-cycle g-access runs before phase2 c-access; missing this increment
  // is the off-by-one VC drift that late bad-line timing must avoid.
  vic._advanceDisplayStateGAccess();
  assert(vic.vc === 1 && vic.vmli === 1, 'late bad line performs same-cycle g-access / VC increment');

  // _beginBadLineFetchPhase is invoked from phase2 of the start cycle.
  if (vic.lineBadLineDisplayPending && vic.lineBadLineStartCycle === 20) {
    vic._beginBadLineFetchPhase();
  }
  assert(vic.lineMatrixFetchCol === 0, 'late bad line begins matrix fetching at its queued start cycle');
  assert(vic._isBadLineFetchPhase(21) === true, 'late bad line creates a c-fetch phase within the same line');
  // Bauer §3.14.6: invalid c-reads (BA-low but AEC-high settle window) store
  // $FF for character pointers (VIC D0-D7 tri-stated). Without a wired CPU /
  // memory (this synthetic unit vic), the colour nibble falls back to the
  // $0F pull-up approximation.
  vic.rowScreenCodes[0] = 0xA5;
  vic.rowColorNibbles[0] = 0x0A;
  vic._fetchScreenRowColumn(0, vic.regs, vic.currentVicBank);
  assert(vic.rowScreenCodes[0] === 0xFF && vic.rowColorNibbles[0] === 0x0F,
    'invalid c-read stores $FF screen code and the $0F pull-up colour fallback (no CPU wired)');
  // Drain the 3 invalid reads (col 0 already consumed one), then a valid fetch should write.
  vic._fetchScreenRowColumn(1, vic.regs, vic.currentVicBank);
  vic._fetchScreenRowColumn(2, vic.regs, vic.currentVicBank);
  vic.rowScreenCodes[3] = 0xA5;
  vic._fetchScreenRowColumn(3, vic.regs, vic.currentVicBank);
  assert(vic.rowScreenCodes[3] !== 0xA5, 'valid c-read (after AEC settles) overwrites the c-buffer cell');
  console.log('ok  - mid-line bad lines create late matrix-fetch starts within the same line');
}

// ── Invalid c-read COLOUR = low nibble of the stalled CPU bus byte ──────────
//
// Bauer §3.14.6: during the 3-cycle AEC settle window the colour bits D8-D13
// come through the U16 analog switch from the CPU's D0-D3 — i.e. the low
// nibble of the byte the BA-stalled CPU is driving, which is its pending
// opcode fetch at PC. (spritecrunch2: the opcode after `sta $d011` is
// `stx $d017` = $8E -> colour $0E, matching VICE.) The character pointer
// still reads $FF.
{
  const vic = makeVic();
  vic.cpu = { pc: 0x0810 };
  vic.memory = { peek(a) { return a === 0x0810 ? 0x8E : 0x00; } };
  vic.lineBadLineInvalidCReadsActive = 1;
  vic._fetchScreenRowColumn(0, vic.regs, vic.currentVicBank);
  assert(vic.rowScreenCodes[0] === 0xFF && vic.rowColorNibbles[0] === 0x0E,
    'invalid c-read colour = low nibble of stalled CPU bus byte (mem[PC]=$8E -> $0E), Bauer §3.14.6');
  console.log('ok  - invalid c-read colour samples the stalled CPU bus byte (§3.14.6)');
}


console.log('\nAll Border flip-flops + bad-line edges (Tests 11-13) tests passed.');
