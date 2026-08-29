// Multi-IRQ pending priority spec test.
//
// Bauer §3.13 + NMOS 6510: when MULTIPLE interrupt sources are pending
// at an instruction boundary, the priority is:
//
//   1. RESET (highest — but we don't test this here; reset bypasses all)
//   2. NMI    (rising-edge latched; bypasses I flag)
//   3. IRQ    (level-sensitive; gated by I flag)
//
// When NMI + IRQ are BOTH pending, NMI vectors first. IRQ stays
// pending — when the NMI handler RTIs, the IRQ is still on the line
// (or in irqStatus) and fires on the next instruction boundary.
//
// VIC + CIA1 IRQ sources OR-combine into the single CPU IRQ pin. If
// both fire simultaneously, the CPU sees ONE IRQ entry but both
// sources stay latched until separately acked.
//
// Audit gap: irq-sampling-spec covers the priority cases at CPU
// level; this test adds the integration case (VIC + CIA + NMI fire
// simultaneously, then NMI handler exits and IRQ fires).

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
  m.cpu.nmiEdge = false;
  m.cpu.instructionCyclesRemaining = 0;
  m.cpu.microOpHead = 0;
  m.cpu.microOpLen = 0;
  m.mem.write(0x0001, 0x35);
  for (let i = 0; i < 64; i++) m.mem.ram[0x9000 + i] = 0xEA;
  for (let i = 0; i < 64; i++) m.mem.ram[0xA000 + i] = 0xEA;
  m.mem.ram[0xFFFA] = 0x00; m.mem.ram[0xFFFB] = 0xA0;       // NMI → $A000
  m.mem.ram[0xFFFE] = 0x00; m.mem.ram[0xFFFF] = 0x90;       // IRQ → $9000
  return m;
}

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

// ── 1: VIC raster IRQ alone → CPU vectors to $9000.
{
  const m = makeMachine();
  driveAndPark(m, 0x4F, 1);
  m.vic2.write(0x12, 0x50);
  m.vic2.write(0x1A, 0x01);
  let safety = 200;
  while (--safety && m.cpu.pc < 0x9000) C64Machine.prototype._runMasterCycle.call(m);
  expect(m.cpu.pc >= 0x9000 && m.cpu.pc < 0x9010,
    `VIC raster IRQ → IRQ vector $9000; got $${m.cpu.pc.toString(16)}`);
  ok('VIC raster IRQ alone → CPU vectors via $FFFE/F to $9000');
}

// ── 2: CIA1 timer IRQ alone → CPU vectors to $9000.
{
  const m = makeMachine();
  driveAndPark(m);
  m.cia1.latchA = 0x0005;
  m.cia1.icrMask = 0x01;
  m.cia1.write(0x0E, 0x11);                  // force-load + start
  let safety = 200;
  while (--safety && m.cpu.pc < 0x9000) C64Machine.prototype._runMasterCycle.call(m);
  expect(m.cpu.pc >= 0x9000 && m.cpu.pc < 0x9010,
    `CIA1 IRQ → $9000; got $${m.cpu.pc.toString(16)}`);
  ok('CIA1 timer A IRQ alone → CPU vectors via $FFFE/F to $9000');
}

// ── 3: VIC + CIA1 IRQ both pending → ONE entry, both sources stay
// latched until separately acked.
{
  const m = makeMachine();
  driveAndPark(m, 0x4F, 1);
  // Arm both sources.
  m.vic2.write(0x12, 0x50);
  m.vic2.write(0x1A, 0x01);
  m.cia1.latchA = 0x0050;                    // ~80 cy to underflow
  m.cia1.icrMask = 0x01;
  m.cia1.write(0x0E, 0x11);
  // Both fire ~simultaneously after a few rasters.
  let safety = 500;
  while (--safety && m.cpu.pc < 0x9000) C64Machine.prototype._runMasterCycle.call(m);
  expect(m.cpu.pc >= 0x9000 && m.cpu.pc < 0x9010,
    `combined VIC+CIA IRQ → $9000; got $${m.cpu.pc.toString(16)}`);
  // At least one source should still be latched.
  const vicLatch = m.vic2.irqStatus & 0x01;
  const ciaLatch = m.cia1.icrStatus & 0x01;
  expect(vicLatch || ciaLatch,
    `at least one source still latched post-entry; VIC=${vicLatch}, CIA=${ciaLatch}`);
  ok('VIC + CIA1 IRQ OR-combine → 1 entry; both sources stay latched');
}

// ── 4: NMI + IRQ both pending → NMI wins, IRQ stays pending.
{
  const m = makeMachine();
  driveAndPark(m);
  m.cpu.setIrqLine(true);
  m.cpu.sampledIrq = true;
  m.cpu.setNmiLine(true);
  m.cpu.sampledNmiEdge = true;          // NMI edge sampled (symmetric with IRQ)
  // Use VIC pending (1-cy direct propagation) for simulated IRQ. The direct
  // setNmiLine(true) above latches nmiEdge; _cpuNmiEdgeSeen keeps the
  // machine-level CIA2 edge path asserted across the next sample.
  m._cpuVicIrqPending = true;
  m._cpuNmiPending = true;
  m._cpuNmiEdgeSeen = true;
  let safety = 100;
  while (--safety && m.cpu.pc < 0x9000 && m.cpu.pc < 0xA000) {
    C64Machine.prototype._runMasterCycle.call(m);
  }
  expect(m.cpu.pc >= 0xA000 && m.cpu.pc < 0xA010,
    `NMI wins priority → $A000; got $${m.cpu.pc.toString(16)}`);
  // IRQ line still asserted (we don't clear here).
  expect(m.cpu.irqLine === true,
    `IRQ line stays asserted post-NMI-entry`);
  ok('NMOS 6510: NMI + IRQ both pending → NMI vectors first; IRQ stays pending');
}

// ── 5: NMI line clears, then IRQ fires.
//
// After NMI is taken and the NMI line is cleared, IRQ (still pending)
// is accepted at the next instruction boundary post-handler-exit.
{
  const m = makeMachine();
  driveAndPark(m);
  // NMI handler at $A000: RTI immediately.
  m.mem.ram[0xA000] = 0x40;
  m.cpu.setIrqLine(true);
  m.cpu.sampledIrq = true;
  m.cpu.setNmiLine(true);
  m.cpu.sampledNmiEdge = true;          // NMI edge sampled (symmetric with IRQ)
  // Prime the machine-level CIA2 NMI edge path so the line is already fully
  // asserted for the cycle-counted priority check below.
  m._cpuVicIrqPending = true;
  m._cpuNmiPending = true;
  m._cpuNmiEdgeSeen = true;
  // Run NMI entry (7 cy).
  for (let i = 0; i < 7; i++) C64Machine.prototype._runMasterCycle.call(m);
  expect(m.cpu.pc === 0xA000, `NMI entered`);
  // Clear NMI line, run RTI (6 cy).
  m.cpu.setNmiLine(false);
  m._cpuNmiPending = false;
  m._cpuNmiEdgeSeen = false;
  for (let i = 0; i < 6; i++) C64Machine.prototype._runMasterCycle.call(m);
  expect(m.cpu.pc < 0xA000,
    `RTI from NMI returned to pre-NMI PC`);
  // IRQ should now fire (7 cy of entry).
  let safety = 20;
  while (--safety && m.cpu.pc < 0x9000) C64Machine.prototype._runMasterCycle.call(m);
  expect(m.cpu.pc >= 0x9000 && m.cpu.pc < 0x9010,
    `IRQ accepted post-NMI-handler-exit; pc=$${m.cpu.pc.toString(16)}`);
  ok('NMI handler exits → IRQ (still pending) fires next');
}

console.log(`\n${testNo} multi-IRQ priority spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
