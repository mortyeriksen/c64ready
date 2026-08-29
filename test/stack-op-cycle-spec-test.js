// Stack op cycle accounting spec test.
//
// NMOS 6502 stack op cycles and bus-kind:
//
//   PHA / PHP (3 cy):
//     cy 1: opcode fetch       (read)
//     cy 2: dummy next-byte    (read)
//     cy 3: push value         (write)
//
//   PLA / PLP (4 cy):
//     cy 1: opcode fetch       (read)
//     cy 2: dummy next-byte    (read)
//     cy 3: dummy stack ptr    (read)
//     cy 4: pull value         (read)
//
// Stable-IRQ handler prologues use PHA/TXA/PHA/TYA/PHA (3×3 = 9 cy of
// pushes) then later PLA/TAY/PLA/TAX/PLA (3×4 = 12 cy of pulls). The
// handler's cycle budget depends on these counts being correct.

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

function runUntilDone(cpu, budget = 20) {
  let i = 0;
  while (i < budget) {
    cpu.clock();
    i++;
    if (cpu.instructionCyclesRemaining === 0) return i;
  }
  return -1;
}

// ── 1: PHA = 3 cycles, A pushed to stack.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  cpu.a = 0x42;
  cpu.sp = 0xFF;
  mem.ram[0x1000] = 0x48;        // PHA
  const n = runUntilDone(cpu);
  expect(n === 3, `PHA: 3 cy; got ${n}`);
  expect(mem.ram[0x01FF] === 0x42, `PHA pushed $42 at $01FF`);
  expect(cpu.sp === 0xFE, `PHA SP decremented to $FE`);
  ok('NMOS 6502: PHA = 3 cycles, pushes A to stack');
}

// ── 2: PLA = 4 cycles, A loaded from stack.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  cpu.a = 0x00;
  cpu.sp = 0xFE;
  mem.ram[0x01FF] = 0x55;
  mem.ram[0x1000] = 0x68;        // PLA
  const n = runUntilDone(cpu);
  expect(n === 4, `PLA: 4 cy; got ${n}`);
  expect(cpu.a === 0x55, `PLA loaded $55 into A`);
  expect(cpu.sp === 0xFF, `PLA SP incremented to $FF`);
  ok('NMOS 6502: PLA = 4 cycles, pulls A from stack');
}

// ── 3: PHP = 3 cycles, P pushed with B and bit 5 set.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  cpu.sp = 0xFF;
  cpu.C = 1; cpu.Z = 0; cpu.I = 0; cpu.D = 0; cpu.V = 0; cpu.N = 1;
  mem.ram[0x1000] = 0x08;        // PHP
  const n = runUntilDone(cpu);
  expect(n === 3, `PHP: 3 cy; got ${n}`);
  const pushedP = mem.ram[0x01FF];
  // PHP pushes P with B (bit 4) AND unused bit 5 set.
  expect((pushedP & 0x30) === 0x30,
    `PHP pushes P with bits 4,5 set; got P=$${pushedP.toString(16)}`);
  expect((pushedP & 0x01) === 0x01, `PHP: C flag preserved`);
  expect((pushedP & 0x80) === 0x80, `PHP: N flag preserved`);
  ok('NMOS 6502: PHP = 3 cycles, pushes P with bits 4,5 set');
}

// ── 4: PLP = 4 cycles, restores P (ignores bits 4,5).
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  cpu.sp = 0xFE;
  cpu.C = 0; cpu.N = 0;
  mem.ram[0x01FF] = 0xA1;        // bits 7 (N), 5, 0 (C) set
  mem.ram[0x1000] = 0x28;        // PLP
  const n = runUntilDone(cpu);
  expect(n === 4, `PLP: 4 cy; got ${n}`);
  expect(cpu.C === 1, `PLP restored C=1`);
  expect(cpu.N === 1, `PLP restored N=1`);
  ok('NMOS 6502: PLP = 4 cycles, restores P from stack');
}

// ── 5: PHA bus-kind: read, read, write.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  cpu.sp = 0xFF;
  mem.ram[0x1000] = 0x48;
  const kinds = [];
  for (let i = 0; i < 3; i++) {
    kinds.push(cpu.peekNextBusKind());
    cpu.clock();
  }
  expect(kinds[0] === 'read', `PHA cy 1 = read; got ${kinds[0]}`);
  expect(kinds[1] === 'read', `PHA cy 2 = read; got ${kinds[1]}`);
  expect(kinds[2] === 'write', `PHA cy 3 = write; got ${kinds[2]}`);
  ok('NMOS 6502: PHA bus-kind = read, read, write (push proceeds under BA-low)');
}

// ── 6: PLA bus-kind: 4× read (entire instruction stalls under BA-low).
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  cpu.sp = 0xFE;
  mem.ram[0x01FF] = 0x55;
  mem.ram[0x1000] = 0x68;
  const kinds = [];
  for (let i = 0; i < 4; i++) {
    kinds.push(cpu.peekNextBusKind());
    cpu.clock();
  }
  for (let i = 0; i < 4; i++) {
    expect(kinds[i] === 'read', `PLA cy ${i+1} = read; got ${kinds[i]}`);
  }
  ok('NMOS 6502: PLA bus-kind = 4× read (entire pull stalls under BA-low)');
}

// ── 7: IRQ handler prologue PHA/TXA/PHA/TYA/PHA = exactly 11 cycles.
// (3 + 2 + 3 + 2 + 3 = 13 wait, with TXA/TYA = 2 each... let me recount.)
// PHA(3) + TXA(2) + PHA(3) + TYA(2) + PHA(3) = 13 cycles.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  cpu.sp = 0xFF;
  cpu.a = 0x11; cpu.x = 0x22; cpu.y = 0x33;
  mem.ram[0x1000] = 0x48;        // PHA
  mem.ram[0x1001] = 0x8A;        // TXA
  mem.ram[0x1002] = 0x48;        // PHA
  mem.ram[0x1003] = 0x98;        // TYA
  mem.ram[0x1004] = 0x48;        // PHA
  for (let i = 0; i < 13; i++) cpu.clock();
  expect(cpu.pc === 0x1005,
    `prologue 13 cy: PC=$1005; got $${cpu.pc.toString(16)}`);
  expect(cpu.sp === 0xFC, `3 pushes: SP=$FC; got $${cpu.sp.toString(16)}`);
  expect(mem.ram[0x01FF] === 0x11, `slot $1FF = A=$11 (first push)`);
  expect(mem.ram[0x01FE] === 0x22, `slot $1FE = X=$22 (after TXA, second push)`);
  expect(mem.ram[0x01FD] === 0x33, `slot $1FD = Y=$33 (after TYA, third push)`);
  ok('NMOS 6502: standard IRQ prologue PHA/TXA/PHA/TYA/PHA = 13 cycles');
}

// ── 8: PHA/PHP drive the exact NMOS bus addresses.
// cy1 opcode @PC, cy2 DUMMY read @PC+1 (NOT a stack read), cy3 push (write).
// The cy2 read must hit PC+1 — a stack read there would skip the real
// PC+1 dummy-read side effect when a push sits one byte before I/O.
for (const [op, name] of [[0x48, 'PHA'], [0x08, 'PHP']]) {
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  cpu.sp = 0xFF;
  mem.ram[0x1000] = op;
  mem.readLog.length = 0;
  runUntilDone(cpu);
  const got = mem.readLog.map(a => `$${a.toString(16).padStart(4, '0')}`).join(' ');
  const expected = [0x1000, 0x1001];   // cy3 is a write — not logged
  expect(mem.readLog.length === 2, `${name} must do exactly 2 bus reads; got ${mem.readLog.length} (${got})`);
  for (let i = 0; i < expected.length; i++) {
    expect(mem.readLog[i] === expected[i],
      `${name} read ${i + 1}: expected $${expected[i].toString(16).padStart(4, '0')}, got ${got}`);
  }
  expect(!mem.readLog.includes(0x01FF),
    `${name} cy2 must dummy-read PC+1, NOT the stack page ($01FF); got ${got}`);
  ok(`NMOS 6502: ${name} cycle 2 dummy-reads PC+1 (not the stack page)`);
}

// ── 9: PLA/PLP drive the exact NMOS bus addresses.
// cy1 opcode @PC, cy2 DUMMY read @PC+1, cy3 DUMMY stack read @$0100+SP
// (pre-increment), cy4 pull @$0100+SP+1.
for (const [op, name] of [[0x68, 'PLA'], [0x28, 'PLP']]) {
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  cpu.sp = 0xFE;
  mem.ram[0x01FF] = 0x55;
  mem.ram[0x1000] = op;
  mem.readLog.length = 0;
  runUntilDone(cpu);
  const got = mem.readLog.map(a => `$${a.toString(16).padStart(4, '0')}`).join(' ');
  const expected = [0x1000, 0x1001, 0x01FE, 0x01FF];
  expect(mem.readLog.length === 4, `${name} must do exactly 4 bus reads; got ${mem.readLog.length} (${got})`);
  for (let i = 0; i < expected.length; i++) {
    expect(mem.readLog[i] === expected[i],
      `${name} read ${i + 1}: expected $${expected[i].toString(16).padStart(4, '0')}, got ${got}`);
  }
  expect(mem.readLog[1] !== 0x01FE,
    `${name} cy2 must dummy-read PC+1, NOT the stack page; got ${got}`);
  ok(`NMOS 6502: ${name} cy2 dummy-reads PC+1, cy3 dummy-reads $0100+SP before the pull`);
}

console.log(`\n${testNo} stack op cycle spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
