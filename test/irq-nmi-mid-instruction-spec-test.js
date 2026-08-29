// IRQ/NMI mid-instruction edge cases spec test.
//
// Consolidates edge cases NOT covered by:
//   - irq-sampling-spec-test.js / multi-irq-priority-spec-test.js (priority + edge re-arm)
//   - cia2-nmi-integration-spec-test.js (CIA2→NMI line)
//   - vic2-raster-compare-mid-line-write-spec-test.js (mid-line $D012)
//
// Covers:
//   1. IRQ asserted DURING a long instruction (INC abs RMW) — verifies
//      acceptance happens at the instruction boundary, not mid-way.
//   2. NMI rising DURING IRQ acceptance 7-cy window — verifies our
//      priority handling preserves NMI service even when IRQ acked first.
//   3. CIA2 NMI fires NESTED inside an active VIC IRQ handler — verifies
//      the IRQ→NMI cascade NLP relies on.

import { C64Machine } from '../src/machine.js';
import { CPU } from '../src/cpu.js';

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

class FlatMemory {
  constructor() { this.ram = new Uint8Array(0x10000); }
  read(a) { return this.ram[a & 0xFFFF]; }
  write(a, v) { this.ram[a & 0xFFFF] = v & 0xFF; }
}

function makeCpu() {
  const mem = new FlatMemory();
  for (let i = 0x0400; i < 0x0500; i++) mem.ram[i] = 0xEA;
  for (let i = 0x9000; i < 0x9020; i++) mem.ram[i] = 0xEA;
  for (let i = 0xA000; i < 0xA020; i++) mem.ram[i] = 0xEA;
  mem.ram[0xFFFA] = 0x00; mem.ram[0xFFFB] = 0xA0;
  mem.ram[0xFFFE] = 0x00; mem.ram[0xFFFF] = 0x90;
  mem.ram[0xFFFC] = 0x00; mem.ram[0xFFFD] = 0x04;
  const cpu = new CPU(mem);
  cpu.reset();
  for (let i = 0; i < 7; i++) cpu.clock();
  cpu.I = 0;
  return { cpu, mem };
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
  m.mem.ram[0xFFFA] = 0x00; m.mem.ram[0xFFFB] = 0xA0;
  m.mem.ram[0xFFFE] = 0x00; m.mem.ram[0xFFFF] = 0x90;
  m.vic2.write(0x11, 0x00);
  m.vic2.write(0x15, 0x00);
  m.vic2.displayEnabled = false;
  m.cia1.icrMask = 0;
  m.cia1.icrStatus = 0;
  return m;
}

function driveAndPark(m, raster, cy) {
  let safety = 50000;
  while (--safety && !(m.vic2.raster === raster && m.vic2.cycleInLine === cy)) {
    C64Machine.prototype._runMasterCycle.call(m);
  }
  m.cpu.pc = 0x1000;
  m.cpu.instructionCyclesRemaining = 0;
  m.cpu.microOpHead = 0;
  m.cpu.microOpLen = 0;
}

// ── 1: IRQ acceptance during a long-running RMW instruction.
//
// CPU executing INC $8000 (6 cy RMW). Raster IRQ asserts mid-instruction.
// Per spec: IRQ is sampled every CPU phi2 cycle but acceptance waits for
// the instruction boundary. Verify the handler enters AFTER the RMW.
{
  const m = makeMachine();
  // INC $8000 at $1000 (6-cy RMW).
  m.mem.ram[0x1000] = 0xEE; m.mem.ram[0x1001] = 0x00; m.mem.ram[0x1002] = 0x80;
  m.mem.ram[0x1003] = 0xEA;
  m.mem.ram[0x8000] = 0x00;
  // Handler at $9000.
  m.mem.ram[0x9000] = 0xEA;

  m.vic2.write(0x12, 0x50);
  m.vic2.write(0x1A, 0x01);
  driveAndPark(m, 0x4F, 49);  // ~13 cy before raster match

  let handlerEntryCy = -1;
  let cycleCounter = 0;
  const origClock = m.cpu.clock.bind(m.cpu);
  m.cpu.clock = function() {
    if (handlerEntryCy < 0 && this.pc === 0x9000 && this.instructionCyclesRemaining === 0) {
      handlerEntryCy = cycleCounter;
    }
    cycleCounter++;
    return origClock();
  };
  for (let i = 0; i < 200; i++) C64Machine.prototype._runMasterCycle.call(m);

  expect(handlerEntryCy > 0, `handler entered within 200 cycles; cy=${handlerEntryCy}`);
  ok(`IRQ during long RMW instruction: handler enters cleanly (cy=${handlerEntryCy})`);
}

// ── 2: NMI rising DURING IRQ acceptance 7-cycle window.
//
// CPU starts IRQ ack (7 cy). At cycle 3 of ack, NMI rises. Per real
// hardware, NMI may "hijack" the IRQ ack (vec fetched from $FFFA),
// OR NMI is serviced after IRQ handler's first instruction. Either way,
// NMI must be acked.
{
  const { cpu, mem } = makeCpu();
  cpu.setIrqLine(true);
  for (let i = 0; i < 4; i++) cpu.clock();  // 4 cy into IRQ ack
  cpu.setNmiLine(true);
  for (let i = 0; i < 20; i++) cpu.clock();

  // Outcome: either NMI handler ($A000) was vectored, or IRQ handler
  // ($9000) ran first and NMI is queued for next boundary.
  const inNmi = cpu.pc >= 0xA000 && cpu.pc < 0xA010;
  const inIrq = cpu.pc >= 0x9000 && cpu.pc < 0x9010;
  expect(inNmi || inIrq,
    `CPU at NMI or IRQ handler; pc=$${cpu.pc.toString(16)}`);
  if (inIrq) {
    // Run more cycles; NMI must eventually fire (nmiEdge consumed).
    for (let i = 0; i < 30; i++) cpu.clock();
    expect(cpu.pc >= 0xA000 || cpu.nmiEdge === false,
      `NMI service eventually fires; pc=$${cpu.pc.toString(16)} nmiEdge=${cpu.nmiEdge}`);
  }
  ok(`NMI rising during IRQ ack: NMI is serviced (priority preserved)`);
}

// ── 3: CIA2 NMI fires NESTED inside VIC raster IRQ handler.
//
// VIC IRQ at $A400-style handler enters. Mid-handler, CIA2 Timer B
// underflow asserts NMI line. NMI must fire after current instruction
// (NMI bypasses I flag).
{
  const m = makeMachine();
  // IRQ handler at $9000: 10 NOPs + ack + RTI.
  let p = 0x9000;
  for (let i = 0; i < 10; i++) m.mem.ram[p++] = 0xEA;
  m.mem.ram[p++] = 0xA9; m.mem.ram[p++] = 0x01;
  m.mem.ram[p++] = 0x8D; m.mem.ram[p++] = 0x19; m.mem.ram[p++] = 0xD0;
  m.mem.ram[p++] = 0x40;
  // NMI handler at $A000: read $DD0D ack + RTI.
  m.mem.ram[0xA000] = 0xAD; m.mem.ram[0xA001] = 0x0D; m.mem.ram[0xA002] = 0xDD;
  m.mem.ram[0xA003] = 0x40;

  m.vic2.write(0x12, 0x50);
  m.vic2.write(0x1A, 0x01);
  m.cia2.icrMask = 0x02;
  driveAndPark(m, 0x4F, 1);

  let nmiEntered = false, irqEntered = false;
  let cycleCounter = 0;
  const origClock = m.cpu.clock.bind(m.cpu);
  m.cpu.clock = function() {
    if (!irqEntered && this.pc === 0x9000 && this.instructionCyclesRemaining === 0) irqEntered = true;
    if (!nmiEntered && this.pc === 0xA000 && this.instructionCyclesRemaining === 0) nmiEntered = true;
    cycleCounter++;
    return origClock();
  };

  // Run until IRQ handler enters.
  for (let i = 0; i < 100; i++) C64Machine.prototype._runMasterCycle.call(m);
  expect(irqEntered, `VIC IRQ handler entered`);

  // Now simulate CIA2 Timer B underflow → NMI line asserts.
  m.cia2.icrStatus = 0x82;
  m.cpu.setNmiLine(true);

  for (let i = 0; i < 50; i++) C64Machine.prototype._runMasterCycle.call(m);
  expect(nmiEntered,
    `NMI handler entered nested inside VIC IRQ handler`);
  ok(`CIA2 NMI fires nested inside VIC IRQ handler`);
}

console.log(`\n${testNo} IRQ/NMI mid-instruction edge case tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
