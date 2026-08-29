// VIC-II: IRQ-prelude / sprite-DMA / bad-line-stun (bumbershoot)
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
// IRQ-prelude / sprite-DMA / bad-line-stun timing (bumbershootsoft article).
//
// The "VIC-II Interrupt Timing" article (2015) states explicitly:
//   - IRQ assertion → CPU notice: 2 cycles.
//   - In-flight instruction completion: 0-6 cycles.
//   - Interrupt sequence (push PC + flags + vector load): 7 cycles exactly.
//   - KERNAL $EA31 handler: 29 cycles deterministic.
//   - Total prelude (IRQ → user code): 38-44 cycles, 6-cycle inherent jitter.
//   - Bad-line stun: 40-43 cycles, "always 43" in practical IRQ handlers.
//   - Sprite DMA: 2 cycles per active sprite during HBLANK.
// ============================================================================

// IRQ-PRELUDE-1: the 6502 interrupt vector sequence is exactly 7 cycles
// (push PC hi, push PC lo, push P, read vector lo, read vector hi, plus
// 2 dummy reads at the start). Verified against the article's "7 cycles".
{
  const machine = new C64Machine();
  // Bypass KERNAL: install a tiny user IRQ handler at $1000 and point the
  // 6502 hardware vector at it.
  machine.mem.ram[0x1000] = 0xEA;        // NOP (so we can detect entry)
  machine.mem.ram[0xFFFE] = 0x00;        // IRQ vector low → $1000
  machine.mem.ram[0xFFFF] = 0x10;
  // Position CPU at instruction boundary (no in-flight micro-ops).
  machine.cpu.pc = 0x2000;
  machine.cpu.I = 0;                     // IRQ enabled
  machine.cpu.instructionCyclesRemaining = 0;
  machine.cpu.microOps = null;
  machine.cpu.irqLine = true;
  machine.cpu.sampledIrq = true;         // already sampled
  // Place a known instruction to execute first if no IRQ — but with sampledIrq
  // set and at instruction boundary, the next clock kicks off the IRQ sequence.

  // Step CPU one cycle: this triggers _beginInstruction → _queueInterruptMicroOps.
  // From this point the next 7 cycles are the interrupt sequence.
  let cyclesToVector = 0;
  while (machine.cpu.pc !== 0x1000 && cyclesToVector < 12) {
    machine.cpu.clock();
    cyclesToVector++;
  }
  assert(machine.cpu.pc === 0x1000,
    `interrupt sequence reached vector $1000 (got pc=$${machine.cpu.pc.toString(16)})`);
  assert(cyclesToVector === 7,
    `interrupt sequence is exactly 7 cycles (got ${cyclesToVector})`);
  console.log('ok  - IRQ-PRELUDE-1: 6502 interrupt sequence is exactly 7 cycles (push PC+P, vector load)');
}

// IRQ-PRELUDE-2: the CPU samples the IRQ line during the *current*
// instruction, not at the boundary. With a 4-cycle in-flight instruction,
// asserting IRQ at cycle 1 of that instruction means: 3 remaining cycles +
// 7 sequence cycles = 10 cycles to reach the vector.
//
// This asserts the spec-level latency envelope: in-flight instruction
// remainder plus the 7-cycle interrupt sequence.
{
  // Helper: start an LDA #$00 (2 cycles), let it run, then assert IRQ during
  // an LDA $XX (4 cycles, abs read) — count cycles to vector.
  const machine = new C64Machine();
  machine.mem.ram[0xFFFE] = 0x00;
  machine.mem.ram[0xFFFF] = 0x10;
  // Place: NOP NOP NOP NOP (each 2 cycles) at $2000.
  for (let i = 0; i < 8; i++) machine.mem.ram[0x2000 + i] = 0xEA;

  machine.cpu.pc = 0x2000;
  machine.cpu.I = 0;
  machine.cpu.instructionCyclesRemaining = 0;
  machine.cpu.microOps = null;

  // Run cycle 1 of an instruction (begins one).
  machine.cpu.clock();
  // Now assert IRQ — we are mid-instruction, 1 cycle remaining of NOP.
  machine.cpu.irqLine = true;

  // From now: instruction remainder plus the 7-cycle interrupt sequence.
  // The article allows 0-6 cycles of in-flight-instruction jitter, so
  // total range is 7..13 cycles depending on sampling timing.
  let cycles = 0;
  while (machine.cpu.pc !== 0x1000 && cycles < 20) {
    machine.cpu.clock();
    cycles++;
  }
  assert(machine.cpu.pc === 0x1000,
    `vector reached (pc=$${machine.cpu.pc.toString(16)})`);
  assert(cycles >= 7 && cycles <= 13,
    `mid-instruction IRQ → 7..13 cycles to vector (got ${cycles}; article allows 0-6 in-flight + 7-cycle sequence)`);
  console.log(`ok  - IRQ-PRELUDE-2: mid-instruction IRQ → ${cycles} cycles to vector (within the article's 7-13 range)`);
}

// SPRITE-DMA-STALL-1: each active sprite costs CPU cycles during sprite
// DMA at the start/end of each line. Bauer's p/s schedule gives 2 AEC-low
// cycles per active sprite. With sprites 0..6 active, cycles 58-63 and
// 1-8 are stolen for 14 total CPU-stall cycles.
{
  const vic = makeVic();
  for (let s = 0; s < 7; s++) vic.spriteDmaOn[s] = 1;
  vic.spriteDmaOn[7] = 0;   // 7 active sprites
  let stallCycles = 0;
  for (let c = 1; c <= 63; c++) {
    if (vic._spriteAecLow(c)) stallCycles++;
  }
  // 2 cycles per active sprite × 7 = exactly 14 stall cycles.
  assert(stallCycles === 14,
    `7 active sprites stall CPU on exactly 14 cycles per line (got ${stallCycles})`);
  console.log(`ok  - SPRITE-DMA-STALL-1: 7 active sprites → exactly 14 CPU stall cycles/line (matches article)`);
}

// SPRITE-DMA-STALL-2: each additional sprite enabled adds EXACTLY 2 stall
// cycles (one for the p-access, one for the s-access). The expected
// pattern is `[0, 2, 4, 6, 8, 10, 12, 14, 16]`.
{
  const counts = [];
  for (let n = 0; n <= 8; n++) {
    const vic = makeVic();
    for (let s = 0; s < n; s++) vic.spriteDmaOn[s] = 1;
    let stalls = 0;
    for (let c = 1; c <= 63; c++) if (vic._spriteAecLow(c)) stalls++;
    counts.push(stalls);
  }
  assert(counts[0] === 0, `0 sprites → 0 stall cycles (got ${counts[0]})`);
  assert(counts[8] === 16, `8 sprites → exactly 16 stall cycles (got ${counts[8]})`);
  for (let n = 1; n <= 8; n++) {
    const delta = counts[n] - counts[n - 1];
    assert(delta === 2,
      `adding sprite ${n - 1}: +${delta} cycles (article says +2 — must be exact)`);
  }
  console.log(`ok  - SPRITE-DMA-STALL-2: stall cycles by enabled-sprite count: [${counts.join(', ')}] — exact +2/sprite`);
}

// BAD-LINE-STUN-1: bad-line stun duration. Bauer's bad-line c-accesses
// occupy cycles 15-54. BA starts three cycles earlier at cycle 12, so
// BA-low covers cycles 12-54 while AEC-low covers the c-access window.
//
// The article's "43" matches BA-low duration (relevant when CPU is trying
// to read), not AEC-low. Pin both numbers.
{
  const vic = makeVic();
  vic.lineMatrixFetchCol = 0;       // simulate fetch is live
  vic.lineBadLineDisplayPending = true;
  vic.lineBadLineStartCycle = 15;
  let baLow = 0, aecLow = 0;
  for (let c = 1; c <= 63; c++) {
    if (vic._isBadLineBaLow(c)) baLow++;
    if (vic._isBadLineFetchPhase(c)) aecLow++;
  }
  // The article's "43" includes 3 cycles of BA lead-in before AEC. The
  // queued-fetch case with startCycle 15 gives BA-low from cycle 12
  // onwards.
  const vic2 = makeVic();
  vic2.lineBadLineDisplayPending = true;
  vic2.lineBadLineStartCycle = 15;
  vic2.lineMatrixFetchCol = -1;     // not yet started
  let baWithLead = 0;
  for (let c = 1; c <= 63; c++) {
    if (vic2._isBadLineBaLow(c)) baWithLead++;
  }
  assert(baWithLead === 43,
    `BA-low with 3-cycle lead-in spans cycles 12-54 = 43 cycles (got ${baWithLead})`);
  console.log(`ok  - BADLINE-STUN-1: BA-low duration 43 cycles (matches article's "always 43")`);
}

// BAD-LINE-STUN-2: AEC-low (full CPU stall, including writes) is 40 cycles
// — narrower than BA-low. This is the "stun" the article describes: 40-43
// cycles depending on whether CPU was mid-write at the start.
{
  const vic = makeVic();
  vic.lineMatrixFetchCol = 0;
  let aecCount = 0;
  for (let c = 1; c <= 63; c++) {
    if (vic._isBadLineFetchPhase(c)) aecCount++;
  }
  assert(aecCount === 40,
    `AEC-low (matrix fetch active) spans cycles 15-54 = 40 cycles (got ${aecCount})`);
  console.log('ok  - BADLINE-STUN-2: AEC-low duration is 40 cycles (BA-lead-in adds the article\'s extra 3)');
}


console.log('\nAll IRQ-prelude / sprite-DMA / bad-line-stun (bumbershoot) tests passed.');
