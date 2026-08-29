// BA rising-edge CPU resume spec test.
//
// Bauer §3.6.1 + measured NMOS 6510 silicon: when BA goes high (CPU
// regains the bus), the CPU resumes on the SAME cycle. There is no
// rising-edge delay analogous to the 1-cycle falling-edge delay applied
// to sprite-BA. WDC RDY semantics: "while RDY is low, subsequent reads
// halt; on the cycle RDY goes high, the next read proceeds."
//
// This invariant is independent of which BA source caused the halt
// (bad-line BA or sprite-BA). It is what lets cycle-counted handlers
// resume at the deterministic master-cycle boundary the demo writer
// targets — a 1-cycle delay on rising edge would offset every handler
// exit by exactly 1 cycle per BA window crossed, accumulating into the
// kind of per-frame drift seen on FppScroller.
//
// Audit gap E3: "BA rising edge: CPU resumes same cycle (no delay on
// release)" — ✗ before this file.

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
  m.mem.ram.fill(0xEA);                  // NOP carpet
  m.cpu.pc = 0x1000;
  m.cpu.instructionCyclesRemaining = 0;
  m.cpu.microOpHead = 0;
  m.cpu.microOpLen = 0;
  return m;
}

function cpuStateTuple(cpu) {
  return `${cpu.pc}:${cpu.instructionCyclesRemaining}:${cpu.microOpHead}`;
}

function driveTo(m, raster, cycle) {
  let safety = 200000;
  while (--safety && !(m.vic2.raster === raster && m.vic2.cycleInLine === cycle)) {
    C64Machine.prototype._runMasterCycle.call(m);
  }
  if (safety <= 0) throw new Error(`driveTo timed out at L${m.vic2.raster}.c${m.vic2.cycleInLine}`);
}

// ── 1: Sprite-BA rising edge — CPU runs the rising-edge cycle ─────────
// Pre-seed sprite 0 DMA → BA-low window covers cy 55..59 (5 cycles).
// Symmetric BA (Bauer §3.5): cy 55..59 stall; cy 60 BA rises → CPU MUST
// run that cycle (no release delay).
{
  const m = makeMachine();
  m.vic2.spriteDmaOn[0] = 1;

  // Verify the BA window we're about to traverse.
  driveTo(m, 10, 54);
  expect(m.vic2.isSpriteBaLow() === false, `c54: BA still high`);
  C64Machine.prototype._runMasterCycle.call(m);                          // c55
  expect(m.vic2.cycleInLine === 55 && m.vic2.isSpriteBaLow() === true,
    `c55: BA falls`);
  // Drive through the stall band to cy 59 (BA still low).
  for (let i = 0; i < 4; i++) C64Machine.prototype._runMasterCycle.call(m);  // c56..c59
  expect(m.vic2.cycleInLine === 59 && m.vic2.isSpriteBaLow() === true,
    `c59: BA still low`);

  // At cycle 60 sprite 0 sequencer fires the BA-up trailing edge.
  const before60 = cpuStateTuple(m.cpu);
  C64Machine.prototype._runMasterCycle.call(m);                          // c60
  expect(m.vic2.cycleInLine === 60, `advanced to cycle 60`);
  expect(m.vic2.isSpriteBaLow() === false,
    `c60: sprite BA rises (DMA window over) — got ${m.vic2.isSpriteBaLow()}`);
  expect(cpuStateTuple(m.cpu) !== before60,
    `c60: CPU MUST resume on rising-edge cycle (no release delay)`);

  ok('Bauer §3.6.1: sprite-BA rising edge resumes CPU same cycle (no release delay)');
}

// ── 2: Bad-line BA rising edge — CPU runs cy 55 (first post-BA cycle) ─
// Bad-line BA window is cy 12..54 (Bauer §3.5). The rising edge falls
// between c54 and c55. CPU MUST run cy 55.
{
  const m = makeMachine();
  m.vic2.regs[0x11] = 0x1B;
  m.vic2.displayEnabled = true;
  // raster $33 = 51, (51 & 7) === 3 → bad line under YSCROLL=3.
  driveTo(m, 0x33, 54);
  expect(m.vic2.isBadLineBaLow() === true,
    `c54: bad-line BA still low`);
  const before55 = cpuStateTuple(m.cpu);
  C64Machine.prototype._runMasterCycle.call(m);                          // c55
  expect(m.vic2.cycleInLine === 55, `advanced to cycle 55`);
  expect(m.vic2.isBadLineBaLow() === false,
    `c55: bad-line BA rises (window closed) — got ${m.vic2.isBadLineBaLow()}`);
  expect(cpuStateTuple(m.cpu) !== before55,
    `c55: CPU MUST resume on bad-line rising-edge cycle (no release delay)`);

  ok('Bauer §3.5: bad-line BA rising edge resumes CPU same cycle');
}

// ── 3: Round-trip — full sprite-BA window costs exactly 5 stall cycles ──
// Under strict Bauer §3.5 (symmetric BA) the CPU stalls on every BA-low
// cycle. Sprite-0 BA window cy 55..59 = 5 cycles stalled. Rising edge
// (cy 60) resumes same cycle (no release delay). If a regression added a
// 1-cy rising-edge delay, total loss would be 6 cycles instead of 5.
{
  const m = makeMachine();
  m.vic2.spriteDmaOn[0] = 1;
  driveTo(m, 10, 54);
  const startState = cpuStateTuple(m.cpu);

  // Run 7 master cycles covering c55..c61 inclusive.
  for (let i = 0; i < 7; i++) C64Machine.prototype._runMasterCycle.call(m);
  expect(m.vic2.cycleInLine === 61, `7 master cycles: arrived at c61`);

  const endState = cpuStateTuple(m.cpu);
  expect(endState !== startState,
    `CPU must have advanced (no all-7-cycle stall)`);

  // Quantitative replay: cy 55 stalls (BA falls), cy 56..59 stall,
  // cy 60 resumes (rising edge).
  const m2 = makeMachine();
  m2.vic2.spriteDmaOn[0] = 1;
  driveTo(m2, 10, 54);
  const s54 = cpuStateTuple(m2.cpu);
  C64Machine.prototype._runMasterCycle.call(m2);                         // c55
  const s55 = cpuStateTuple(m2.cpu);
  expect(s55 === s54,
    `c55 (BA falls): CPU stalls same-cycle (symmetric, Bauer §3.5)`);
  for (let i = 0; i < 4; i++) C64Machine.prototype._runMasterCycle.call(m2); // c56..c59
  const s59 = cpuStateTuple(m2.cpu);
  expect(s59 === s55,
    `c56..c59: CPU stalled all four cycles (state unchanged)`);
  C64Machine.prototype._runMasterCycle.call(m2);                         // c60
  const s60 = cpuStateTuple(m2.cpu);
  expect(s60 !== s59,
    `c60 (rise+0): CPU resumed`);

  ok('Symmetric BA: 5 stall cycles per 5-cy sprite-BA window (cy 55..59), rising edge resumes same cycle');
}

console.log(`\n${testNo} BA rising-edge spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
