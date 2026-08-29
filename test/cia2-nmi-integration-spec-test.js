// CIA2 NMI integration spec test.
//
// C64 wiring (Bauer §3.6.1 + MOS6526):
//   - CIA1's IRQ output → CPU IRQ pin (raster IRQ + keyboard scan etc.)
//   - CIA2's IRQ output → CPU NMI pin (RS-232, IEC, user port)
//
// So CIA2 timer underflow + ICR mask drives the CPU's NMI line, NOT
// the IRQ line. NMI is edge-triggered (rising-edge latched) and bypasses
// the I flag.
//
// Some stable-interrupt demos use CIA2 NMI for jitter-free timing
// (NMI cannot be masked by I, so handler doesn't need SEI). FppScroller
// MAY use CIA2 NMI in its stable-IRQ chain.
//
// Audit gap: no existing test exercises CIA2 → NMI integration.

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
  for (let i = 0; i < 64; i++) m.mem.ram[0xA000 + i] = 0xEA;
  m.mem.ram[0xFFFA] = 0x00; m.mem.ram[0xFFFB] = 0xA0;       // NMI vector → $A000
  m.mem.ram[0xFFFE] = 0x00; m.mem.ram[0xFFFF] = 0x90;       // IRQ vector → $9000
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

// ── 1: CIA2 timer A underflow + ICR mask bit 0 → ICR bit 0 latches.
{
  const m = makeMachine();
  driveAndPark(m);
  m.cia2.latchA = 0x0005;
  m.cia2.icrMask = 0x01;
  m.cia2.write(0x0E, 0x11);              // CRA: force-load + start
  let safety = 100;
  while (--safety && !(m.cia2.icrStatus & 0x01)) {
    C64Machine.prototype._runMasterCycle.call(m);
  }
  expect((m.cia2.icrStatus & 0x01) === 0x01,
    `CIA2 ICR bit 0 set after timer A underflow; got 0x${m.cia2.icrStatus.toString(16)}`);
  ok('MOS6526: CIA2 timer A underflow latches ICR bit 0 (same as CIA1)');
}

// ── 2: CIA2 underflow with ICR mask → CPU NMI line asserts (NOT irq line).
//
// Critical wiring distinction: CIA2 → NMI, not IRQ.
{
  const m = makeMachine();
  driveAndPark(m);
  m.cia2.latchA = 0x0005;
  m.cia2.icrMask = 0x01;
  m.cia2.write(0x0E, 0x11);
  let safety = 100;
  while (--safety && !m.cpu.nmiLine) {
    C64Machine.prototype._runMasterCycle.call(m);
  }
  expect(m.cpu.nmiLine === true,
    `CPU NMI line asserted after CIA2 underflow + ICR mask; got nmiLine=${m.cpu.nmiLine}`);
  expect(m.cpu.irqLine === false,
    `CPU IRQ line stays LOW (CIA2 routes to NMI, not IRQ); got irqLine=${m.cpu.irqLine}`);
  ok('C64 wiring: CIA2 IRQ output → CPU NMI line (NOT IRQ)');
}

// ── 3: CIA2 NMI → CPU vectors to $FFFA/$FFFB ($A000).
{
  const m = makeMachine();
  driveAndPark(m);
  m.cia2.latchA = 0x0005;
  m.cia2.icrMask = 0x01;
  m.cia2.write(0x0E, 0x11);
  let safety = 200;
  while (--safety && m.cpu.pc < 0xA000) {
    C64Machine.prototype._runMasterCycle.call(m);
  }
  expect(safety > 0, `CPU must enter NMI handler within budget`);
  expect(m.cpu.pc >= 0xA000 && m.cpu.pc < 0xA010,
    `CPU vectored to NMI handler at $A000+; got $${m.cpu.pc.toString(16)}`);
  ok('C64: CIA2 underflow → ICR → CPU NMI line → 7-cy entry → handler $A000');
}

// ── 4: CIA2 NMI fires even when I=1 (NMI bypasses I flag).
{
  const m = makeMachine();
  driveAndPark(m);
  m.cpu.I = 1;                            // IRQ disabled
  m.cia2.latchA = 0x0005;
  m.cia2.icrMask = 0x01;
  m.cia2.write(0x0E, 0x11);
  let safety = 200;
  while (--safety && m.cpu.pc < 0xA000) {
    C64Machine.prototype._runMasterCycle.call(m);
  }
  expect(safety > 0, `CIA2 NMI fires even with I=1; CPU must enter handler`);
  expect(m.cpu.pc >= 0xA000 && m.cpu.pc < 0xA010,
    `NMI with I=1: CPU at NMI handler; got $${m.cpu.pc.toString(16)}`);
  ok('C64: CIA2 NMI bypasses I flag (NMI is non-maskable)');
}

// ── 5: CIA1 underflow with same setup → IRQ (NOT NMI). Sanity control.
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
  expect(m.cpu.irqLine === true,
    `CIA1 underflow → CPU IRQ line; got irqLine=${m.cpu.irqLine}`);
  expect(m.cpu.nmiLine === false,
    `CIA1 underflow does NOT assert NMI; got nmiLine=${m.cpu.nmiLine}`);
  ok('Sanity: CIA1 underflow → IRQ line, NOT NMI line (correct chip routing)');
}

// ── 6: a HELD CIA2 NMI source fires EXACTLY ONCE (edge-triggered).
//
// Timer A continuous keeps underflowing; the handler does NOT read $DD0D, so
// the ICR stays set and /NMI is held low. With no fresh high→low edge the NMI
// must NOT re-enter — pins the sampled-edge recognition (cpu.sampledNmiEdge)
// against double-vectoring. A $DD0D read clears the ICR (line high); the next
// underflow is a fresh edge → exactly one more NMI. This is the precise
// property The Hat's stable CIA2 Timer-B NMI relies on (one entry per edge).
{
  const m = makeMachine();
  driveAndPark(m);
  m.mem.ram[0xA000] = 0x40;              // NMI handler = RTI immediately (no $DD0D ack)
  let nmiCount = 0;
  m.cpu.onInterruptAccept = (kind) => { if (kind === 'nmi') nmiCount++; };
  m.cia2.latchA = 0x0008;
  m.cia2.icrMask = 0x01;
  m.cia2.write(0x0E, 0x11);              // continuous timer A + force-load + start
  // ~55 underflows (period 9) over 500 master cycles — far more than one.
  for (let i = 0; i < 500; i++) C64Machine.prototype._runMasterCycle.call(m);
  expect(nmiCount === 1,
    `held CIA2 NMI (unacked) fires exactly ONCE despite repeated underflows; got ${nmiCount}`);
  // Ack the ICR ($DD0D read) → /NMI returns high; next underflow = fresh edge.
  m.cia2.read(0x0D);
  for (let i = 0; i < 500; i++) C64Machine.prototype._runMasterCycle.call(m);
  expect(nmiCount === 2,
    `after $DD0D ack + reassert, exactly one MORE NMI fires (fresh edge); got ${nmiCount}`);
  ok('MOS6526/6510: held CIA2 NMI fires once per edge; $DD0D ack re-arms the next edge');
}

console.log(`\n${testNo} CIA2 NMI integration spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
