// CIA1 timer-A underflow → CPU IRQ integration latency spec test.
//
// MOS6526 + 6510 integration: CIA1's timer A counts phi2 pulses (when
// CRA bit 0 = 1). When the counter underflows (1 → 0), ICR bit 0 is
// set. If ICR mask bit 0 is also set, the CIA asserts its IRQ line,
// which routes to the CPU's IRQ pin via the C64 motherboard.
//
// Latency chain (cycle-counted):
//   - Underflow cycle: ICR bit 0 latches.
//   - Same cycle or next: CIA IRQ line goes high.
//   - CPU samples IRQ at next instruction boundary (sampledIrq set).
//   - 7-cycle IRQ entry begins.
//   - CPU vectors to $FFFE/$FFFF handler.
//
// Stable-IRQ chains (FppScroller, OrbitUntold) use CIA1 timer A as the
// jitter-compensation latch (load $DC04 in handler). The exact latency
// from underflow to handler entry is load-bearing.
//
// Audit gap: CIA1 → CPU IRQ integration latency — cia-timer-spec covers
// CIA-internal timer behavior; this covers the full chain.

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
  m.mem.write(0x0001, 0x35);     // RAM at $E000-$FFFF
  for (let i = 0; i < 64; i++) m.mem.ram[0x9000 + i] = 0xEA;
  m.mem.ram[0xFFFE] = 0x00;
  m.mem.ram[0xFFFF] = 0x90;
  return m;
}

// Drive to a quiescent state (raster 50 cy 1), park CPU at $1000.
function driveAndPark(m, raster = 50, cy = 1) {
  let safety = 50000;
  while (--safety && !(m.vic2.raster === raster && m.vic2.cycleInLine === cy)) {
    C64Machine.prototype._runMasterCycle.call(m);
  }
  m.cpu.pc = 0x1000;
  m.cpu.instructionCyclesRemaining = 0;
  m.cpu.microOpHead = 0;
  m.cpu.microOpLen = 0;
}

// ── 1: Timer A underflow → ICR bit 0 latches + CIA IRQ line asserts.
//
// Set timer A latch = 5, force-load + start. Drive 5 master cycles.
// After underflow, ICR bit 0 should be set.
{
  const m = makeMachine();
  driveAndPark(m);
  m.cia1.latchA = 0x0005;
  m.cia1.icrMask = 0x01;          // enable timer A underflow IRQ
  m.cia1.write(0x0E, 0x11);       // CRA: force-load + start (LOAD strobe + START)
  // Force-load is a 3-cycle phase; counter reaches latch on cy 3.
  // Then runs down 5..4..3..2..1..0 (underflow at cy 9 approximately).
  let safety = 100;
  while (--safety && !(m.cia1.icrStatus & 0x01)) {
    C64Machine.prototype._runMasterCycle.call(m);
  }
  expect(safety > 0, `timer A must underflow within budget`);
  expect((m.cia1.icrStatus & 0x01) === 0x01,
    `ICR bit 0 set after timer A underflow; got 0x${m.cia1.icrStatus.toString(16)}`);
  ok('MOS6526: timer A underflow latches ICR bit 0');
}

// ── 2: Timer A underflow with IRQ mask enabled → CPU IRQ line asserts.
{
  const m = makeMachine();
  driveAndPark(m);
  m.cia1.latchA = 0x0005;
  m.cia1.icrMask = 0x01;
  m.cia1.write(0x0E, 0x11);
  let safety = 100;
  while (--safety && !m.cpu.irqLine) {
    C64Machine.prototype._runMasterCycle.call(m);
  }
  expect(safety > 0, `CPU IRQ line must assert within budget`);
  expect(m.cpu.irqLine === true,
    `CPU IRQ line asserted after timer A underflow + ICR mask`);
  ok('Integration: timer A underflow + ICR mask bit 0 → CPU IRQ line asserts');
}

// ── 3: Timer A underflow WITHOUT ICR mask → no IRQ.
{
  const m = makeMachine();
  driveAndPark(m);
  m.cia1.latchA = 0x0005;
  m.cia1.icrMask = 0x00;          // IRQ MASK disabled
  m.cia1.write(0x0E, 0x11);
  let safety = 100;
  while (--safety && !(m.cia1.icrStatus & 0x01)) {
    C64Machine.prototype._runMasterCycle.call(m);
  }
  expect((m.cia1.icrStatus & 0x01) === 0x01,
    `ICR bit 0 latches even without mask`);
  expect(m.cpu.irqLine === false,
    `CPU IRQ line stays LOW when mask cleared; got irqLine=${m.cpu.irqLine}`);
  ok('Integration: ICR mask gates CPU IRQ — underflow alone doesn\'t fire IRQ');
}

// ── 4: Reading $DC0D (ICR) clears all pending bits AND deasserts the
// IRQ line. After read, CPU IRQ should go low.
{
  const m = makeMachine();
  driveAndPark(m);
  m.cia1.latchA = 0x0005;
  m.cia1.icrMask = 0x01;
  m.cia1.write(0x0E, 0x11);
  let safety = 100;
  while (--safety && !m.cpu.irqLine) C64Machine.prototype._runMasterCycle.call(m);
  expect(m.cpu.irqLine === true, `IRQ asserted pre-read`);
  // Read $DC0D — clear-on-read.
  const icr = m.cia1.read(0x0D);
  expect((icr & 0x01) === 0x01, `read $DC0D returns bit 0 set`);
  expect((icr & 0x80) === 0x80, `read $DC0D bit 7 = IR (master pending) was set`);
  expect(m.cia1.icrStatus === 0,
    `post-read: ICR cleared (clear-on-read)`);
  // Asymmetric IRQ pipeline (2026-05-20): CIA path is 2-cy staged. The
  // read clears pending; first cycle shifts pending→staged; second cycle
  // applies staged to cpu.irqLine.
  C64Machine.prototype._runMasterCycle.call(m);
  C64Machine.prototype._runMasterCycle.call(m);
  expect(m.cpu.irqLine === false,
    `post-read + 2-cy pipeline: CPU IRQ deasserts; got irqLine=${m.cpu.irqLine}`);
  ok('MOS6526: read $DC0D (ICR) clears latched bits AND deasserts IRQ line (after 2-cy pipeline)');
}

// ── 5: Stable-IRQ pattern — CIA1 timer A IRQ triggers CPU vector entry.
//
// Full integration test: timer underflow → IRQ → CPU enters $9000.
{
  const m = makeMachine();
  driveAndPark(m);
  m.cia1.latchA = 0x0005;
  m.cia1.icrMask = 0x01;
  m.cia1.write(0x0E, 0x11);
  // Drive until CPU pc reaches $9000 (or budget exhausts).
  let safety = 200;
  while (--safety && m.cpu.pc < 0x9000) {
    C64Machine.prototype._runMasterCycle.call(m);
  }
  expect(safety > 0, `CPU must enter handler within budget`);
  expect(m.cpu.pc >= 0x9000 && m.cpu.pc < 0x9010,
    `CPU vectored to handler at $9000+; got $${m.cpu.pc.toString(16)}`);
  ok('Stable-IRQ: timer A underflow → ICR latch → CPU IRQ → 7-cy entry → handler $9000');
}

console.log(`\n${testNo} CIA1 timer-IRQ integration spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
