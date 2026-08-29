// JSR / RTS cycle accounting spec test.
//
// NMOS 6502 cycle counts and bus-kind sequences:
//
//   JSR abs (6 cy):
//     cy 1: opcode fetch         (read)
//     cy 2: addr-lo fetch        (read)
//     cy 3: internal (S-1)       (read)
//     cy 4: push PCH             (write)
//     cy 5: push PCL             (write)
//     cy 6: addr-hi fetch + jump (read)
//
//   RTS (6 cy):
//     cy 1: opcode fetch         (read)
//     cy 2: dummy next-byte      (read)
//     cy 3: dummy stack ptr inc  (read)
//     cy 4: pull PCL             (read)
//     cy 5: pull PCH             (read)
//     cy 6: increment PC         (read of fresh PC)
//
// Both are 6 cycles. JSR has 3 reads + 2 writes + 1 read (mixed bus).
// RTS has 6 reads (all stallable under BA).
//
// Subroutine-style handlers (rare in stable-IRQ but used in some demos)
// have JSR/RTS in their cycle budget. Drift here would compound.

import { CPU } from '../src/cpu.js';

class FlatMemory {
  constructor() { this.ram = new Uint8Array(0x10000); this.readLog = []; }
  read(a) { this.readLog.push(a & 0xFFFF); return this.ram[a & 0xFFFF]; }
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
  for (let i = 0; i < 0x100; i++) mem.ram[0x0400 + i] = 0xEA;
  for (let i = 0; i < 0x100; i++) mem.ram[0x8000 + i] = 0xEA;     // subroutine runway
  mem.ram[0xFFFC] = 0x00; mem.ram[0xFFFD] = 0x04;
  const cpu = new CPU(mem);
  cpu.reset();
  for (let i = 0; i < 7; i++) cpu.clock();
  cpu.I = 0;
  return { cpu, mem };
}

function parkAt(cpu, pc) {
  cpu.pc = pc;
  cpu.instructionCyclesRemaining = 0;
  cpu.microOpHead = 0;
  cpu.microOpLen = 0;
}

// ── 1: JSR abs = exactly 6 cycles.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  cpu.sp = 0xFF;
  mem.ram[0x1000] = 0x20; mem.ram[0x1001] = 0x00; mem.ram[0x1002] = 0x80;  // JSR $8000
  for (let i = 0; i < 6; i++) cpu.clock();
  expect(cpu.pc === 0x8000,
    `JSR 6-cy: PC=$8000 after 6 cycles; got $${cpu.pc.toString(16)}`);
  expect(cpu.sp === 0xFD,
    `JSR pushes 2 bytes: SP=$FD; got $${cpu.sp.toString(16)}`);
  ok('NMOS 6502: JSR abs = 6 cycles, pushes 2 bytes');
}

// ── 2: JSR pushes return address = JSR_addr + 2.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  cpu.sp = 0xFF;
  mem.ram[0x1000] = 0x20; mem.ram[0x1001] = 0x00; mem.ram[0x1002] = 0x80;
  for (let i = 0; i < 6; i++) cpu.clock();
  // Pushed: PCH then PCL. Top of stack = PCH at $01FF, PCL at $01FE.
  expect(mem.ram[0x01FF] === 0x10,
    `JSR pushes PCH = $10 (JSR_addr+2 high byte = $1002); got $${mem.ram[0x01FF].toString(16)}`);
  expect(mem.ram[0x01FE] === 0x02,
    `JSR pushes PCL = $02 (JSR_addr+2 low byte); got $${mem.ram[0x01FE].toString(16)}`);
  ok('NMOS 6502: JSR pushes (JSR_addr + 2) — points to byte AFTER the JSR operand');
}

// ── 3: RTS = exactly 6 cycles, restores PC = pushed_addr + 1.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x8000);
  // Pre-push return frame: PCH=$10, PCL=$05. SP after = $FD.
  mem.ram[0x01FF] = 0x10;
  mem.ram[0x01FE] = 0x05;
  cpu.sp = 0xFD;
  mem.ram[0x8000] = 0x60;        // RTS
  for (let i = 0; i < 6; i++) cpu.clock();
  // RTS pulls (PCL, PCH) = ($05, $10) → addr $1005. Then PC = addr + 1 = $1006.
  expect(cpu.pc === 0x1006,
    `RTS: PC = pushed_addr + 1 = $1006; got $${cpu.pc.toString(16)}`);
  expect(cpu.sp === 0xFF,
    `RTS pulls 2 bytes: SP=$FF; got $${cpu.sp.toString(16)}`);
  ok('NMOS 6502: RTS = 6 cycles, restores PC = pulled_addr + 1');
}

// ── 4: JSR bus-kind sequence is read,read,read,write,write,read.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  cpu.sp = 0xFF;
  mem.ram[0x1000] = 0x20; mem.ram[0x1001] = 0x00; mem.ram[0x1002] = 0x80;
  const kinds = [];
  for (let i = 0; i < 6; i++) {
    kinds.push(cpu.peekNextBusKind());
    cpu.clock();
  }
  const expected = ['read', 'read', 'read', 'write', 'write', 'read'];
  for (let i = 0; i < 6; i++) {
    expect(kinds[i] === expected[i],
      `JSR cy ${i+1}: bus kind ${expected[i]}; got ${kinds[i]}`);
  }
  ok('NMOS 6502: JSR bus-kind = read,read,read,write,write,read');
}

// ── 5: RTS bus-kind sequence is all reads.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x8000);
  mem.ram[0x01FF] = 0x10;
  mem.ram[0x01FE] = 0x05;
  cpu.sp = 0xFD;
  mem.ram[0x8000] = 0x60;
  const kinds = [];
  for (let i = 0; i < 6; i++) {
    kinds.push(cpu.peekNextBusKind());
    cpu.clock();
  }
  for (let i = 0; i < 6; i++) {
    expect(kinds[i] === 'read',
      `RTS cy ${i+1}: bus kind read; got ${kinds[i]}`);
  }
  ok('NMOS 6502: RTS bus-kind = 6× read (all stallable under BA)');
}

// ── 6: JSR + RTS round-trip = 12 cycles, PC restored.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  cpu.sp = 0xFF;
  mem.ram[0x1000] = 0x20; mem.ram[0x1001] = 0x00; mem.ram[0x1002] = 0x80;  // JSR $8000
  mem.ram[0x8000] = 0x60;                                                    // RTS
  mem.ram[0x1003] = 0xEA;                                                    // NOP after JSR
  for (let i = 0; i < 12; i++) cpu.clock();
  // After JSR (6 cy): PC=$8000. After RTS (6 cy): PC = pushed_addr + 1 =
  // $1002 + 1 = $1003.
  expect(cpu.pc === 0x1003,
    `JSR+RTS round-trip: PC=$1003 (after JSR operand); got $${cpu.pc.toString(16)}`);
  expect(cpu.sp === 0xFF,
    `JSR+RTS round-trip: SP restored to $FF; got $${cpu.sp.toString(16)}`);
  ok('NMOS 6502: JSR + RTS round-trip = 12 cycles, PC + SP restored');
}

// ── 7: RTS drives the exact NMOS bus addresses each cycle.
// cy1 opcode @PC, cy2 dummy @PC+1 (can side-effect on I/O-adjacent code),
// cy3 dummy stack @$0100+SP, cy4 pull PCL, cy5 pull PCH, cy6 dummy read at
// the assembled return address. There is NO read at return_addr+1 — a
// spurious extra read there would trip a bogus I/O side effect (same class
// as the $DD0D acknowledge / RTI dummy-read bug).
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x8000);
  mem.ram[0x01FF] = 0x10;        // PCH
  mem.ram[0x01FE] = 0x05;        // PCL
  cpu.sp = 0xFD;
  mem.ram[0x8000] = 0x60;        // RTS
  mem.readLog.length = 0;
  for (let i = 0; i < 6; i++) cpu.clock();
  const expected = [0x8000, 0x8001, 0x01FD, 0x01FE, 0x01FF, 0x1005];
  const got = mem.readLog.map(a => `$${a.toString(16).padStart(4, '0')}`).join(' ');
  expect(mem.readLog.length === 6,
    `RTS must do exactly 6 bus reads; got ${mem.readLog.length} (${got})`);
  for (let i = 0; i < expected.length; i++) {
    expect(mem.readLog[i] === expected[i],
      `RTS read ${i + 1}: expected $${expected[i].toString(16).padStart(4, '0')}, got ${got}`);
  }
  expect(!mem.readLog.includes(0x1006),
    `RTS must NOT read return_addr+1 ($1006) — spurious read would side-effect on I/O; got ${got}`);
  ok('NMOS 6502: RTS cycle 2 dummy-reads PC+1, no spurious read at return_addr+1');
}

console.log(`\n${testNo} JSR/RTS cycle accounting spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
