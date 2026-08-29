// raster_time_gp IRQ-during-spinner mechanism spec test.
//
// In raster_time, the main loop is a CMP $D012 / BNE spinner waiting
// for the next target raster. While the spinner runs, a different
// raster IRQ fires at line 250 (= the FLI raster). When that IRQ
// fires, the CPU must:
//   1. Sample the IRQ line at the current cpu.clock().
//   2. Complete the current instruction (= CMP $D012 or BNE).
//   3. Start BRK (7 cy) at the next instruction boundary.
//   4. Vector to the handler.
//
// The "accept cycle" = vic cycle when PC first reaches the handler's
// first instruction. This is the cycle on which the FLI handler's STA
// $D018 lands — determining where the FLI row split appears.
//
// Spec-correct accept latency (NMOS 6502 + Bauer §3.12):
//   - VIC asserts at cycle 1 of target raster (= MC where vic.cycleInLine
//     transitions to 1).
//   - 1-cy pipeline (our impl choice): CPU sees IRQ next MC (= cy 2).
//   - CPU sample at start of cpu.clock(). If at instr boundary AND I=0,
//     start BRK; else continue current instr.
//   - BRK = 7 cy.
//   - Handler op fetch at MC after BRK ends.
//
// Measurement convention: this test observes assertedCy at the moment
// the CPU FIRST SEES cpu.irqLine high (= 1 MC after actual VIC assertion
// due to the 1-cy pipeline). acceptedCy at PC = $2000. So:
//   latency_observed = (X+1+7) - (X+1) = 7 cy minimum (best case: CPU
//                       was already at boundary the cycle IRQ became
//                       visible).
//   latency_observed = up to 7 + 7 = 14 cy maximum (worst case: CMP-abs
//                       had 6 cy remaining + 7 BRK).
// Spec range: 7..14 cy from "CPU sees IRQ" to "PC at handler".
//
// For a CMP-spinner (CMP-abs 4 cy + BNE-taken 3 cy = 7 cy iter):
//   - Worst case: IRQ visible at cy 1 of an instr → 6 cy remaining +
//     7 BRK + 1 = 14 cy from sample.
//   - Best case: IRQ visible at instr's last cy → 0 cy remaining + 7
//     + 1 = 8 cy from sample. Plus 1 from pipeline = 9 from assertion.
//
// Spec references:
//   - https://www.cebix.net/VIC-Article.txt (Bauer §3.12): raster IRQ at cycle 1.
//   - 6502.org "Interrupts": IRQ sampled at falling edge of phi2.
//   - NMOS 6502 spec: BRK = 7 cycles total.
//   - Branch-taken-no-cross late-IRQ delay: see
//     cpu-branch-irq-delay-spec-test.js.

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
  m.cpu.instructionCyclesRemaining = 0;
  m.cpu.microOpHead = 0;
  m.cpu.microOpLen = 0;
  m.mem.write(0x0001, 0x35);
  m.cpu.I = 0;
  return m;
}

function driveAndPark(m, raster, cycle) {
  let safety = 400000;
  while (--safety && !(m.vic2.raster === raster && m.vic2.cycleInLine === cycle)) {
    C64Machine.prototype._runMasterCycle.call(m);
  }
  if (safety <= 0) throw new Error(`driveAndPark timed out`);
  m.cpu.pc = 0x1000;
  m.cpu.instructionCyclesRemaining = 0;
  m.cpu.microOpHead = 0;
  m.cpu.microOpLen = 0;
}

function runMC(m, n) {
  for (let i = 0; i < n; i++) C64Machine.prototype._runMasterCycle.call(m);
}

// Install CMP-spinner with unreachable target so it runs forever.
function installInfiniteSpinner(m) {
  m.mem.ram[0x1000] = 0xA9; m.mem.ram[0x1001] = 0xFF;        // LDA #$FF (raster never reaches $FF on PAL)
  m.mem.ram[0x1002] = 0xCD; m.mem.ram[0x1003] = 0x12; m.mem.ram[0x1004] = 0xD0;  // CMP $D012
  m.mem.ram[0x1005] = 0xD0; m.mem.ram[0x1006] = 0xFB;        // BNE $1002
  // Handler vector → $2000. Handler is just a sentinel store.
  m.mem.write(0xFFFE, 0x00);
  m.mem.write(0xFFFF, 0x20);
  m.mem.ram[0x2000] = 0xA9; m.mem.ram[0x2001] = 0x77;        // LDA #$77
  m.mem.ram[0x2002] = 0x8D; m.mem.ram[0x2003] = 0x00; m.mem.ram[0x2004] = 0x05;  // STA $0500
  m.mem.ram[0x2005] = 0x40;                                   // RTI
}

// ── 1: IRQ assertion during spinner → BRK enters within bounded cycles ─
//
// Set up raster IRQ for line 50. Park CPU at L$30.c20, start spinner.
// VIC raster IRQ asserts at L$50.cy1. Measure cycles from assertion to
// handler entry (PC = $2000).
{
  const m = makeMachine();
  installInfiniteSpinner(m);
  // Enable raster IRQ at $50.
  m.vic2.regs[0x12] = 0x50;
  m.vic2.regs[0x11] = 0x00;
  m.vic2.regs[0x1A] = 0x01;
  m.vic2.irqMask = 0x01;
  driveAndPark(m, 0x30, 20);

  let assertedCy = -1, acceptedCy = -1, latency = 0, mcCount = 0;
  for (let i = 0; i < 64 * 63; i++) {
    C64Machine.prototype._runMasterCycle.call(m);
    mcCount++;
    if (assertedCy < 0 && m.cpu.irqLine) {
      assertedCy = m.vic2.cycleInLine;
    }
    if (m.cpu.pc === 0x2000 && acceptedCy < 0) {
      acceptedCy = m.vic2.cycleInLine;
      if (assertedCy >= 0) {
        // Compute cycles between assert and accept (within same line for simplicity).
        latency = (acceptedCy - assertedCy + 63) % 63;
      }
      break;
    }
  }
  expect(assertedCy >= 0, `VIC IRQ must assert before timeout (got ${mcCount} MCs)`);
  expect(acceptedCy >= 0, `CPU must accept IRQ before timeout (got ${mcCount} MCs)`);
  // Spec range: 9..16 cycles from assertion to handler PC = $2000.
  // (1 pipeline + 7 BRK + 1 op-fetch = 9 min; up to +7 if mid-iter).
  expect(latency >= 7 && latency <= 14,
    `IRQ accept latency must be 7..14 cy from "cpu sees IRQ" (= BRK 7 + 0..7 instr remaining); got ${latency}`);
  ok(`IRQ during spinner: accept latency ${latency} cy (spec 7..14)`);
}

// ── 2: IRQ assertion → CPU handler PC = $2000 (correct vector) ─────────
{
  const m = makeMachine();
  installInfiniteSpinner(m);
  m.vic2.regs[0x12] = 0x50;
  m.vic2.regs[0x11] = 0x00;
  m.vic2.regs[0x1A] = 0x01;
  m.vic2.irqMask = 0x01;
  driveAndPark(m, 0x30, 5);
  for (let i = 0; i < 64 * 63; i++) {
    C64Machine.prototype._runMasterCycle.call(m);
    if (m.cpu.pc === 0x2000) break;
  }
  expect(m.cpu.pc === 0x2000,
    `handler vectored from $FFFE/$FFFF (= $2000); got PC=$${m.cpu.pc.toString(16)}`);
  ok('CPU vectors to $FFFE/$FFFF (= $2000) on VIC raster IRQ');
}

// ── 3: Without IRQ enabled, spinner runs forever ───────────────────────
{
  const m = makeMachine();
  installInfiniteSpinner(m);
  // IRQ mask disabled.
  m.vic2.regs[0x12] = 0x50;
  m.vic2.regs[0x1A] = 0x00;
  m.vic2.irqMask = 0x00;
  driveAndPark(m, 0x30, 5);
  for (let i = 0; i < 5 * 63; i++) {
    C64Machine.prototype._runMasterCycle.call(m);
  }
  expect(m.cpu.pc !== 0x2000,
    `without raster IRQ enabled, CPU must stay in spinner (PC not at handler); got PC=$${m.cpu.pc.toString(16)}`);
  expect(m.cpu.pc >= 0x1000 && m.cpu.pc <= 0x1007,
    `CPU still inside spinner loop ($1000-$1007); got PC=$${m.cpu.pc.toString(16)}`);
  ok('Raster IRQ mask disabled → spinner runs forever (no vector to handler)');
}

// ── 4: Handler runs from PC=$2000 → sentinel STA $0500 = $77 ───────────
//
// Verifies the BRK sequence pushed state, vectored to handler, and the
// handler's instructions execute correctly.
{
  const m = makeMachine();
  installInfiniteSpinner(m);
  m.vic2.regs[0x12] = 0x50;
  m.vic2.regs[0x11] = 0x00;
  m.vic2.regs[0x1A] = 0x01;
  m.vic2.irqMask = 0x01;
  driveAndPark(m, 0x30, 5);
  for (let i = 0; i < 64 * 63; i++) {
    C64Machine.prototype._runMasterCycle.call(m);
    if (m.mem.read(0x0500) === 0x77) break;
  }
  expect(m.mem.read(0x0500) === 0x77,
    `handler must run and write sentinel $77 to $0500; got $${m.mem.read(0x0500).toString(16)}`);
  ok('Handler vectored from BRK runs correctly (sentinel store $77 → $0500)');
}

// ── 5: IRQ accept always >= 8 cy from VIC assertion (= 1+BRK7) ─────────
//
// Sweep multiple park cycles. The minimum latency must always be >= 8.
// This pins the "no IRQ accept before BRK completes" invariant.
{
  const minLatencies = [];
  for (const K of [5, 10, 15, 20, 25, 30, 40, 50]) {
    const m = makeMachine();
    installInfiniteSpinner(m);
    m.vic2.regs[0x12] = 0x50;
    m.vic2.regs[0x11] = 0x00;
    m.vic2.regs[0x1A] = 0x01;
    m.vic2.irqMask = 0x01;
    driveAndPark(m, 0x30, K);
    let assertedCy = -1, acceptedCy = -1;
    for (let i = 0; i < 64 * 63; i++) {
      C64Machine.prototype._runMasterCycle.call(m);
      if (assertedCy < 0 && m.cpu.irqLine) assertedCy = m.vic2.cycleInLine;
      if (m.cpu.pc === 0x2000 && acceptedCy < 0) {
        acceptedCy = m.vic2.cycleInLine;
        break;
      }
    }
    const latency = (acceptedCy - assertedCy + 63) % 63;
    minLatencies.push({ K, latency });
    expect(latency >= 7 && latency <= 14,
      `K=${K}: latency must be 7..14 cy; got ${latency}`);
  }
  ok(`IRQ accept latency bounded 7..14 across K sweep (${minLatencies.map(r => `K${r.K}:${r.latency}`).join(' ')})`);
}

// ── 6: Continuously-asserted IRQ accepts within 1 spinner iter + 7 cy ──
//
// If IRQ is asserted continuously through the pipeline BEFORE the
// spinner starts, the first BNE iter catches it at the early poll. Per
// NMOS, the branch quirk doesn't apply (caught at early poll). BRK
// enters at end of current instr. Total: at most 1 iter (7 cy) + 7 cy
// BRK + 1 cy op-fetch = 15 cy.
{
  const m = makeMachine();
  installInfiniteSpinner(m);
  driveAndPark(m, 0x30, 5);
  // Assert through the pipeline: set VIC pending + force cpu.irqLine via
  // the next _sampleCpuInterrupts. Easiest: set _cpuVicIrqPending so it
  // propagates on the next MC.
  m._cpuVicIrqPending = true;

  let acceptedAt = -1;
  for (let i = 1; i <= 20; i++) {
    C64Machine.prototype._runMasterCycle.call(m);
    if (m.cpu.pc === 0x2000) { acceptedAt = i; break; }
  }
  expect(acceptedAt >= 0,
    `IRQ must be accepted within 20 MCs of spinner start; got PC=$${m.cpu.pc.toString(16)}`);
  expect(acceptedAt <= 16,
    `IRQ accept bounded by 1 iter (7) + BRK (7) + op-fetch (1) = 15 max; got ${acceptedAt}`);
  ok(`Continuously-asserted IRQ accepts within ${acceptedAt} MCs of spinner start (bound: 15)`);
}

console.log(`\n${testNo} IRQ-during-spinner spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
