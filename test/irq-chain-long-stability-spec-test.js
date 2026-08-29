// Long IRQ chain stability spec test.
//
// Existing chain tests run 10-20 iterations. The NLP investigation
// showed that drift in IRQ pattern compounds over many frames before
// manifesting visibly. This test exercises longer chains.
//
// Key math constraint: handler `INC $D012` advances compare by 1 per
// iter. After 176 iters from compare=$50, compare wraps from $FF→$00.
// Raster wraps at line 311, not at 255 — so once compare wraps, ~57
// raster lines pass before raster=$00 lets the next IRQ fire. This is
// the standard limitation of a simple INC-compare chain.
//
// Strategy:
//   Test 1: 150-iter chain WITHIN one $D012 wrap (raster $50..$E5).
//   Test 2: Fixed-compare chain across many full frames.
//   Test 3: 256-iter "full $D012 cycle" chain — accounting for the wrap gap.

import { C64Machine } from '../src/machine.js';

let testNo = 0, testsFailing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else { testsFailing++; console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`);
    currentFailures = [];
  }
}

function makeMachine() {
  const m = new C64Machine();
  m.reset();
  m.mem.ram.fill(0xEA);
  m.cpu.pc = 0x1000;
  m.cpu.I = 0;
  m.cpu.sampledIrq = false;
  m.cpu.instructionCyclesRemaining = 0;
  m.cpu.microOpHead = 0;
  m.cpu.microOpLen = 0;
  m.mem.write(0x0001, 0x35);
  m.mem.ram[0xFFFE] = 0x00; m.mem.ram[0xFFFF] = 0x90;
  m.vic2.write(0x11, 0x00);
  m.vic2.write(0x15, 0x00);
  m.vic2.displayEnabled = false;
  return m;
}

function driveAndPark(m, raster, cy) {
  let safety = 500000;
  while (--safety && !(m.vic2.raster === raster && m.vic2.cycleInLine === cy)) {
    C64Machine.prototype._runMasterCycle.call(m);
  }
  m.cpu.pc = 0x1000;
  m.cpu.instructionCyclesRemaining = 0;
  m.cpu.microOpHead = 0;
  m.cpu.microOpLen = 0;
}

// ── 1: 150-iter chain within single $D012 wrap.
//
// Range: raster $50..$E5 (150 lines). $D012 advances $50→$E5. No wrap.
// Expected: 150 entries, all at the same cycleInLine, Δ=63 cy between.
{
  const m = makeMachine();
  let p = 0x9000;
  m.mem.ram[p++] = 0xA9; m.mem.ram[p++] = 0x01;
  m.mem.ram[p++] = 0x8D; m.mem.ram[p++] = 0x19; m.mem.ram[p++] = 0xD0;
  m.mem.ram[p++] = 0xEE; m.mem.ram[p++] = 0x12; m.mem.ram[p++] = 0xD0;
  m.mem.ram[p++] = 0x40;

  m.vic2.write(0x12, 0x50);
  m.vic2.write(0x1A, 0x01);
  driveAndPark(m, 0x4F, 1);

  const entries = [];
  let cycleCounter = 0;
  const origClock = m.cpu.clock.bind(m.cpu);
  m.cpu.clock = function() {
    if (this.pc === 0x9000 && this.instructionCyclesRemaining === 0) {
      entries.push({ cy: cycleCounter, vCy: m.vic2.cycleInLine, raster: m.vic2.raster });
    }
    cycleCounter++;
    return origClock();
  };

  // Run 151 lines worth (= +1 to capture the 150th entry).
  for (let i = 0; i < 151 * 63; i++) C64Machine.prototype._runMasterCycle.call(m);

  expect(entries.length === 150,
    `150 raster lines (raster $50..$E5) → 150 handler entries; got ${entries.length}`);

  if (entries.length > 0) {
    const firstCy = entries[0].vCy;
    let drifted = 0;
    for (const e of entries) if (e.vCy !== firstCy) drifted++;
    expect(drifted === 0,
      `every handler entry at SAME cycleInLine; ${drifted} of ${entries.length} drifted`);

    let badDeltas = 0;
    for (let i = 1; i < entries.length; i++) {
      const dt = entries[i].cy - entries[i-1].cy;
      if (dt !== 63) badDeltas++;
    }
    expect(badDeltas === 0,
      `consecutive entries Δ=63 cy (= PAL line); ${badDeltas} bad deltas`);
  }

  ok(`150-iter chain in single frame: 150 entries, zero drift, Δ=63 constant`);
}

// ── 2: Fixed-compare chain — exact-Δ between consecutive frame IRQs.
//
// Handler: PHA / ACK / PLA / RTI (full save+restore so stack stays clean
// across many frames). Compare held at $50. Run 4 PAL frames; expect 4
// IRQ entries with Δ=19656 cy each.
{
  const m = makeMachine();
  let p = 0x9000;
  m.mem.ram[p++] = 0x48;                                                 // PHA
  m.mem.ram[p++] = 0xA9; m.mem.ram[p++] = 0x01;                          // LDA #$01
  m.mem.ram[p++] = 0x8D; m.mem.ram[p++] = 0x19; m.mem.ram[p++] = 0xD0;   // STA $D019
  m.mem.ram[p++] = 0x68;                                                 // PLA
  m.mem.ram[p++] = 0x40;                                                 // RTI

  m.vic2.write(0x12, 0x50);
  m.vic2.write(0x1A, 0x01);
  driveAndPark(m, 0x4F, 1);

  const entries = [];
  let cycleCounter = 0;
  const origClock = m.cpu.clock.bind(m.cpu);
  m.cpu.clock = function() {
    if (this.pc === 0x9000 && this.instructionCyclesRemaining === 0 && this.sp === 0xFC) {
      // Only count genuine IRQ entries (SP=$fc = reset $ff minus the 3 IRQ pushes).
      entries.push({ cy: cycleCounter, raster: m.vic2.raster });
    }
    cycleCounter++;
    return origClock();
  };

  // 4 PAL frames + a bit to capture 4th IRQ.
  for (let i = 0; i < 4 * 312 * 63 + 100; i++) C64Machine.prototype._runMasterCycle.call(m);

  expect(entries.length === 4,
    `4 PAL frames + compare=$50 → 4 IRQ fires; got ${entries.length}`);
  for (const e of entries) {
    expect(e.raster === 0x50,
      `entry at raster $50; got $${e.raster.toString(16)}`);
  }
  let badGaps = 0;
  for (let i = 1; i < entries.length; i++) {
    const dt = entries[i].cy - entries[i-1].cy;
    if (dt !== 312 * 63) badGaps++;
  }
  expect(badGaps === 0,
    `consecutive frame-IRQs Δ=19656 cy (= 1 PAL frame); ${badGaps} bad gaps`);

  ok(`Fixed-line chain across 4 frames: 4 IRQs at raster $50, exact frame Δ`);
}

// ── 3: 256+ iter chain — across a $D012 wrap.
//
// Handler INCs $D012. Compare $50 → $FF (= 176 iters), then wraps to $00.
// $D012 = $00 doesn't match raster again until raster wraps to 0 too.
// PAL wraps every 312 lines. After compare=$00, raster reaches $00 at
// raster line wrap (= 312-($FF+1) = 56 lines later).
//
// Total in N lines: floor((N - 0) / 312) full frames worth + partial.
// In a frame starting at $50, compare progresses $50→$FF (176 lines) then
// no IRQ for 56 lines (raster $100..$137 = 256..311). Then raster wraps
// to 0, compare=$00 matches, fires again. From there compare $01..$4F
// matches raster $01..$4F (= 79 lines). Total per "complete cycle":
// 176 + 0 + 79 = 255 IRQs per (312+0) = 312 raster lines.
//
// Actually: per full frame starting from raster=0, $D012 covers all
// 256 values 0-$FF, so 256 IRQs per 312-line frame.
//
// Cleanly: run for exactly 2 full PAL frames starting at frame boundary.
// Expected: 512 IRQs (= 256 per frame × 2 frames).
{
  const m = makeMachine();
  let p = 0x9000;
  m.mem.ram[p++] = 0xA9; m.mem.ram[p++] = 0x01;
  m.mem.ram[p++] = 0x8D; m.mem.ram[p++] = 0x19; m.mem.ram[p++] = 0xD0;
  m.mem.ram[p++] = 0xEE; m.mem.ram[p++] = 0x12; m.mem.ram[p++] = 0xD0;
  m.mem.ram[p++] = 0x40;

  m.vic2.write(0x12, 0x00);
  m.vic2.write(0x1A, 0x01);
  // Park at end-of-frame: raster $137 (= 311) cy 1. Next clock advances raster to 0.
  driveAndPark(m, 311, 1);

  const entries = [];
  let cycleCounter = 0;
  const origClock = m.cpu.clock.bind(m.cpu);
  m.cpu.clock = function() {
    if (this.pc === 0x9000 && this.instructionCyclesRemaining === 0) {
      entries.push({ cy: cycleCounter, raster: m.vic2.raster });
    }
    cycleCounter++;
    return origClock();
  };

  // 2 full PAL frames + a couple of extra lines to capture the last IRQ.
  for (let i = 0; i < 2 * 312 * 63 + 65; i++) C64Machine.prototype._runMasterCycle.call(m);

  // 2 frames * 256 IRQs/frame = 512.
  expect(entries.length === 512,
    `2 PAL frames + INC chain → 512 IRQs (= 256 per frame); got ${entries.length}`);

  ok(`2-frame full-$D012-cycle chain: 512 IRQs (256 per frame)`);
}

console.log(`\n${testNo} long-IRQ-chain stability spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
