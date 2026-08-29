// CIA1 timer counts during CPU BA-low stall spec test.
//
// MOS6526 + Bauer §3.6.1: CIA1 timer A counts phi2 pulses ON EVERY
// master cycle, regardless of whether the CPU is stalled by BA-low.
// The CIA chip has its own clock domain — it doesn't care about CPU
// bus contention.
//
// Stable-IRQ chains rely on this: when the IRQ handler stalls in a
// bad-line BA window (43 cy), the timer keeps counting. The handler's
// "LDA $DC04 / AND #$07 / TAX / JMP-table" alignment trick depends on
// the timer's count value being deterministic across the BA stall.
//
// If our impl stalls the timer when the CPU stalls (= incorrect), the
// timer value at the alignment-read would be off, breaking stable-IRQ.

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
  return m;
}

function driveTo(m, raster, cy) {
  let safety = 50000;
  while (--safety && !(m.vic2.raster === raster && m.vic2.cycleInLine === cy)) {
    C64Machine.prototype._runMasterCycle.call(m);
  }
}

// ── 1: Baseline — timer counts 1 per master cycle on non-bad line.
{
  const m = makeMachine();
  driveTo(m, 50, 1);
  m.cia1.timerA = 0x0100;
  m.cia1.cra = 0x01;                        // counting phi2
  const start = m.cia1.timerA;
  for (let i = 0; i < 10; i++) C64Machine.prototype._runMasterCycle.call(m);
  const advance = start - m.cia1.timerA;
  expect(advance === 10,
    `non-bad line: timer counts 1 per master cycle; 10 cy → -10; got -${advance}`);
  ok('MOS6526: timer A counts 1 per master cycle on non-bad line');
}

// ── 2: Bad-line BA window — timer counts 43 cycles even though CPU stalls.
{
  const m = makeMachine();
  // Set up a bad line via $D011 (DEN=1, YSCROLL=3) and reach raster $33.
  m.vic2.regs[0x11] = 0x1B;
  m.vic2.displayEnabled = true;
  driveTo(m, 0x33, 0);
  m.cia1.timerA = 0x0100;
  m.cia1.cra = 0x01;
  const start = m.cia1.timerA;
  // Drive across the full bad-line BA window (cy 0 → cy 63 = 63 cy).
  for (let i = 0; i < 63; i++) C64Machine.prototype._runMasterCycle.call(m);
  const advance = start - m.cia1.timerA;
  expect(advance === 63,
    `bad-line: timer still counts 63 master cycles even though CPU stalled 43 cy; got -${advance}`);
  ok('MOS6526 + Bauer §3.6.1: timer A counts FULL 63 cy on bad line (chip clock independent of CPU)');
}

// ── 3: Sprite-BA window — timer counts during sprite-BA stall too.
{
  const m = makeMachine();
  m.vic2.spriteDmaOn[0] = 1;
  driveTo(m, 10, 50);
  m.cia1.timerA = 0x0100;
  m.cia1.cra = 0x01;
  const start = m.cia1.timerA;
  // Drive across the sprite-BA window (cy 50 → cy 13 of next line = 26 cy).
  for (let i = 0; i < 26; i++) C64Machine.prototype._runMasterCycle.call(m);
  const advance = start - m.cia1.timerA;
  expect(advance === 26,
    `sprite-BA: timer counts 26 master cycles; got -${advance}`);
  ok('MOS6526: timer A counts during sprite-BA stall (chip clock independent)');
}

// ── 4: Timer value at the "alignment-read" cycle is deterministic
// across multiple raster lines.
//
// FppScroller's stable-IRQ trick: handler reads $DC04 at a known cycle
// of each raster (e.g., entry + N cy). If the timer is deterministic,
// the LSB at that read is constant across raster lines.
//
// We program timer A to free-running PHI2 mode (counts every master
// cycle, never reloads). Sample timerA value at cy 20 of 5 consecutive
// rasters. Expect a deterministic decreasing sequence.
{
  const m = makeMachine();
  m.cia1.latchA = 0xFFFF;
  m.cia1.timerA = 0xFFFF;
  m.cia1.cra = 0x01;
  const samples = [];
  for (let r = 100; r < 105; r++) {
    driveTo(m, r, 20);
    samples.push(m.cia1.timerA);
  }
  // Each raster = 63 cy, so consecutive samples differ by exactly 63.
  for (let i = 1; i < samples.length; i++) {
    const diff = (samples[i-1] - samples[i]) & 0xFFFF;
    expect(diff === 63,
      `raster-to-raster timer diff = 63 (= PAL cycles per line); got ${diff}`);
  }
  ok('MOS6526: timer A is deterministic across rasters (= stable-IRQ alignment foundation)');
}

console.log(`\n${testNo} CIA timer during BA stall spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
