// BRK opcode IRQ entry semantics spec test.
//
// NMOS 6502/6510: BRK ($00) is a 7-cycle software interrupt:
//   cy 1: opcode fetch
//   cy 2: read & discard next byte (BRK is "2 bytes" — operand discarded)
//   cy 3: push PCH                                  (write)
//   cy 4: push PCL                                  (write)
//   cy 5: push P with B flag SET                    (write)
//   cy 6: read IRQ vector lo ($FFFE)                (read)
//   cy 7: read IRQ vector hi ($FFFF) → load PC      (read)
//
// Distinctions from hardware IRQ:
//   - B flag (bit 4) is SET in the pushed P (hardware IRQ clears B).
//   - PC pushed is BRK_addr + 2 (BRK skips the byte after the opcode).
//   - Always executes — not gated by I flag.
//
// Audit gap: BRK semantics — not covered by IRQ tests (which test
// hardware IRQ entry only).

import { CPU } from '../src/cpu.js';

class FlatMemory {
  constructor() { this.ram = new Uint8Array(0x10000); }
  read(a) { return this.ram[a & 0xFFFF]; }
  write(a, v) { this.ram[a & 0xFFFF] = v & 0xFF; }
}

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

function makeCpu() {
  const mem = new FlatMemory();
  for (let i = 0; i < 64; i++) mem.ram[0x0400 + i] = 0xEA;
  for (let i = 0; i < 64; i++) mem.ram[0x9000 + i] = 0xEA;
  mem.ram[0xFFFE] = 0x00;
  mem.ram[0xFFFF] = 0x90;
  mem.ram[0xFFFC] = 0x00;
  mem.ram[0xFFFD] = 0x04;
  const cpu = new CPU(mem);
  cpu.reset();
  for (let i = 0; i < 7; i++) cpu.clock();
  cpu.I = 0;
  return { cpu, mem };
}

// ── 1: BRK takes exactly 7 cycles and vectors to $9000.
{
  const { cpu, mem } = makeCpu();
  cpu.pc = 0x1000;
  cpu.instructionCyclesRemaining = 0;
  cpu.microOpHead = 0;
  cpu.microOpLen = 0;
  mem.ram[0x1000] = 0x00;       // BRK
  mem.ram[0x1001] = 0x00;       // signature byte (discarded by BRK)
  for (let i = 0; i < 7; i++) cpu.clock();
  expect(cpu.pc === 0x9000,
    `BRK 7-cy entry: PC=$9000 (IRQ vector); got $${cpu.pc.toString(16)}`);
  ok('NMOS 6502: BRK takes 7 cycles and vectors via $FFFE/$FFFF');
}

// ── 2: BRK pushes PCH/PCL = BRK_addr + 2 (skips signature byte).
{
  const { cpu, mem } = makeCpu();
  cpu.pc = 0x1000;
  cpu.sp = 0xFF;
  cpu.instructionCyclesRemaining = 0;
  cpu.microOpHead = 0;
  cpu.microOpLen = 0;
  mem.ram[0x1000] = 0x00;
  mem.ram[0x1001] = 0xEA;       // signature byte
  for (let i = 0; i < 7; i++) cpu.clock();
  // After BRK: SP advanced by 3 (PCH, PCL, P). Top-of-stack frame:
  //   $01FF = PCH = $10 (BRK+2 = $1002 → hi $10)
  //   $01FE = PCL = $02
  //   $01FD = P (with B flag)
  expect(mem.ram[0x01FF] === 0x10,
    `BRK pushes PCH = $10 (BRK+2 high byte); got $${mem.ram[0x01FF].toString(16)}`);
  expect(mem.ram[0x01FE] === 0x02,
    `BRK pushes PCL = $02 (BRK+2 low byte); got $${mem.ram[0x01FE].toString(16)}`);
  ok('NMOS 6502: BRK pushes (BRK_addr + 2) as return address (skips signature byte)');
}

// ── 3: BRK pushes P with B flag (bit 4) SET.
{
  const { cpu, mem } = makeCpu();
  cpu.pc = 0x1000;
  cpu.sp = 0xFF;
  cpu.instructionCyclesRemaining = 0;
  cpu.microOpHead = 0;
  cpu.microOpLen = 0;
  mem.ram[0x1000] = 0x00;
  for (let i = 0; i < 7; i++) cpu.clock();
  const pushedP = mem.ram[0x01FD];
  expect((pushedP & 0x10) === 0x10,
    `BRK pushes P with B flag (bit 4) SET; got P=0x${pushedP.toString(16)}`);
  // Unused bit 5 is also typically set.
  expect((pushedP & 0x20) === 0x20,
    `BRK pushes P with unused bit 5 set (NMOS convention); got P=0x${pushedP.toString(16)}`);
  ok('NMOS 6502: BRK pushes P with B flag (bit 4) SET — distinguishes from hardware IRQ');
}

// ── 4: BRK sets I flag (interrupt disable) after entry — like IRQ.
{
  const { cpu, mem } = makeCpu();
  cpu.pc = 0x1000;
  cpu.I = 0;
  cpu.instructionCyclesRemaining = 0;
  cpu.microOpHead = 0;
  cpu.microOpLen = 0;
  mem.ram[0x1000] = 0x00;
  for (let i = 0; i < 7; i++) cpu.clock();
  expect(cpu.I === 1,
    `BRK sets I=1 (interrupt disable) by end of entry; got I=${cpu.I}`);
  ok('NMOS 6502: BRK sets I flag after entry (further IRQs blocked until CLI/PLP/RTI)');
}

// ── 5: BRK fires even when I=1 (NOT masked by I).
{
  const { cpu, mem } = makeCpu();
  cpu.pc = 0x1000;
  cpu.I = 1;                                  // IRQ disabled
  cpu.instructionCyclesRemaining = 0;
  cpu.microOpHead = 0;
  cpu.microOpLen = 0;
  mem.ram[0x1000] = 0x00;
  for (let i = 0; i < 7; i++) cpu.clock();
  expect(cpu.pc === 0x9000,
    `BRK with I=1: still vectors to $9000 (BRK is not maskable); got $${cpu.pc.toString(16)}`);
  ok('NMOS 6502: BRK is not maskable by I flag (unlike hardware IRQ)');
}

console.log(`\n${testNo} BRK opcode spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
