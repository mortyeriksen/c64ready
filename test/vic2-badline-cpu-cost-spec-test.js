// Bad-line CPU cycle-cost spec test.
//
// Bauer §3.5 + §3.6.1: on a bad line the VIC asserts BA-low from cycle
// 12 through cycle 54 inclusive — 43 cycles of read-stall. With a
// straight read-stream CPU instruction the cycle-count differential
// between a bad line and a non-bad line is exactly 43 master cycles.
//
// Cycle-counted IRQ handlers (stable-IRQ, FppScroller, OrbitUntold) all
// budget their work around this 43-cycle hole. A regression that
// over-stalls (e.g., extra cycle on falling or rising edge for the
// bad-line path) would push every handler exit later, accumulating into
// per-frame drift across N bad lines.
//
// Audit gap E8: "Cycle count: bad-line BA window 12-54 = 43 stolen-read
// cycles; verify CPU loses exactly that many" — ✗ before this file.

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

function makeMachine(displayActive = false) {
  const m = new C64Machine();
  m.reset();
  m.mem.ram.fill(0xEA);                  // NOP carpet
  m.cpu.pc = 0x1000;
  m.cpu.instructionCyclesRemaining = 0;
  m.cpu.microOpHead = 0;
  m.cpu.microOpLen = 0;
  if (displayActive) {
    m.vic2.regs[0x11] = 0x1B;            // DEN=1, RSEL=1, YSCROLL=3
    m.vic2.displayEnabled = true;
  }
  return m;
}

function driveTo(m, raster, cycle) {
  let safety = 200000;
  while (--safety && !(m.vic2.raster === raster && m.vic2.cycleInLine === cycle)) {
    C64Machine.prototype._runMasterCycle.call(m);
  }
  if (safety <= 0) throw new Error(`driveTo timed out at L${m.vic2.raster}.c${m.vic2.cycleInLine}`);
}

// Run N master cycles, return PC advance.
function pcAdvance(m, masterCycles) {
  const start = m.cpu.pc;
  for (let i = 0; i < masterCycles; i++) C64Machine.prototype._runMasterCycle.call(m);
  return m.cpu.pc - start;
}

// Count cycles in [c=0..62] where isBadLineBaLow() returns true for a given raster.
function countBadLineBaCycles(m, raster) {
  driveTo(m, raster, 0);
  let cycles = 0;
  for (let c = 0; c < 63; c++) {
    if (m.vic2.isBadLineBaLow()) cycles++;
    C64Machine.prototype._runMasterCycle.call(m);
  }
  return cycles;
}

// ── 1: Non-bad line has 0 BA-low cycles from the bad-line path ─────────
{
  const m = makeMachine(true);
  // raster $32 (YSCROLL=3, raster&7=2) → NOT a bad line.
  expect(!m.vic2._isBadLine(0x32, m.vic2.regs),
    `precondition: raster $32 is not a bad line`);
  const baLowCount = countBadLineBaCycles(m, 0x32);
  expect(baLowCount === 0,
    `non-bad line: 0 bad-line BA-low cycles, got ${baLowCount}`);
  ok('Bauer §3.5: non-bad line emits zero bad-line-BA-low cycles');
}

// ── 2: Bad line has exactly 43 BA-low cycles (cy 12..54 inclusive) ─────
{
  const m = makeMachine(true);
  expect(m.vic2._isBadLine(0x33, m.vic2.regs),
    `precondition: raster $33 is a bad line under YSCROLL=3`);
  const baLowCount = countBadLineBaCycles(m, 0x33);
  expect(baLowCount === 43,
    `bad line: 43 BA-low cycles (cy 12..54 inclusive), got ${baLowCount}`);
  ok('Bauer §3.5 + §3.6.1: bad-line BA-low window covers exactly cy 12..54 = 43 cycles');
}

// ── 3: 63-master-cycle span CPU-advance differential between bad/non-bad
//
// STRICT spec: bad-line steals exactly 43 cycles per Bauer §3.6.1. The
// NOP-based differential measures: advGood × 2 - advBad × 2 = 43 ± 1
// cy due to NOP boundary alignment (43 is odd, NOPs are 2 cy each). So
// (advGood - advBad) must equal exactly 21 or 22.
{
  const mBad = makeMachine(true);
  const mGood = makeMachine(true);
  driveTo(mBad, 0x33, 0);
  driveTo(mGood, 0x32, 0);
  const advBad = pcAdvance(mBad, 63);
  const advGood = pcAdvance(mGood, 63);
  const nopDiff = advGood - advBad;
  expect(nopDiff === 21 || nopDiff === 22,
    `strict Bauer §3.6.1: 43-cy stall = 21 or 22 NOP differential (NOP=2cy, 43 odd); got ${nopDiff} (advGood=${advGood}, advBad=${advBad})`);
  ok('Bauer §3.6.1: bad-line steals 43 cycles → 21..22 NOP differential (NOP alignment is the only slack)');
}

// ── 4: 9-line differential — 1-extra-bad-line span steals exactly 43 cy.
//
// STRICT spec: every additional bad-line adds 43 cy of stall. With one
// extra bad-line: NOP differential = 21 or 22 (alignment).
{
  const mA = makeMachine(true);
  const mB = makeMachine(true);
  driveTo(mA, 0x33, 0);
  driveTo(mB, 0x34, 0);
  let badInA = 0, badInB = 0;
  for (let r = 0x33; r < 0x33 + 9; r++) {
    if (mA.vic2._isBadLine(r, mA.vic2.regs)) badInA++;
  }
  for (let r = 0x34; r < 0x34 + 9; r++) {
    if (mB.vic2._isBadLine(r, mB.vic2.regs)) badInB++;
  }
  expect(badInA === 2, `A span (rasters $33..$3B): 2 bad lines, got ${badInA}`);
  expect(badInB === 1, `B span (rasters $34..$3C): 1 bad line, got ${badInB}`);

  const advA = pcAdvance(mA, 9 * 63);
  const advB = pcAdvance(mB, 9 * 63);
  const nopDiff = advB - advA;
  expect(nopDiff === 21 || nopDiff === 22,
    `strict Bauer §3.6.1: 1-extra-bad-line = 43-cy stall = 21..22 NOPs; got ${nopDiff}`);
  ok('Bauer §3.6.1: each additional bad-line steals exactly 43 cycles (21..22 NOP differential)');
}

console.log(`\n${testNo} bad-line CPU cost spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
