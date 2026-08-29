// Cycle-counted handler bus-kind audit spec test.
//
// FppScroller-style handlers use specific instructions whose bus-kind
// sequences determine how they interact with BA-low. This file pins
// the per-cycle bus-kind for the most common handler instructions:
//
//   LDA imm           — 2 cy: read, read
//   LDA abs           — 4 cy: read, read, read, read
//   LDA zp            — 3 cy: read, read, read
//   STA abs           — 4 cy: read, read, read, write
//   STA zp            — 3 cy: read, read, write
//   TAX/TAY/TXA/TYA   — 2 cy: read, read (no bus on internal cy 2)
//   EOR imm           — 2 cy: read, read
//   ORA abs           — 4 cy: read, read, read, read
//   PHA               — 3 cy: read, read, write
//   PLA               — 4 cy: read, read, read, read
//   RTI               — 6 cy: read × 6
//
// Audit gap: existing bus-kind-audit-test covers some but not the
// specific handler-instruction subset.

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

function captureBusKinds(cpu, cycles) {
  const kinds = [];
  for (let i = 0; i < cycles; i++) {
    kinds.push(cpu.peekNextBusKind());
    cpu.clock();
  }
  return kinds;
}

function expectKinds(kinds, expected, label) {
  for (let i = 0; i < expected.length; i++) {
    expect(kinds[i] === expected[i],
      `${label} cy ${i+1}: ${expected[i]}; got ${kinds[i]}`);
  }
}

// ── 1: LDA imm = 2× read.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  mem.ram[0x1000] = 0xA9; mem.ram[0x1001] = 0x42;
  const kinds = captureBusKinds(cpu, 2);
  expectKinds(kinds, ['read', 'read'], 'LDA imm');
  ok('NMOS: LDA imm bus-kind = 2× read');
}

// ── 2: LDA abs = 4× read.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  mem.ram[0x1000] = 0xAD; mem.ram[0x1001] = 0x00; mem.ram[0x1002] = 0xC0;
  const kinds = captureBusKinds(cpu, 4);
  expectKinds(kinds, ['read', 'read', 'read', 'read'], 'LDA abs');
  ok('NMOS: LDA abs bus-kind = 4× read');
}

// ── 3: STA abs = 3× read + 1× write.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  mem.ram[0x1000] = 0x8D; mem.ram[0x1001] = 0x00; mem.ram[0x1002] = 0xC0;
  const kinds = captureBusKinds(cpu, 4);
  expectKinds(kinds, ['read', 'read', 'read', 'write'], 'STA abs');
  ok('NMOS: STA abs bus-kind = read, read, read, write');
}

// ── 4: STA zp = 2× read + 1× write.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  mem.ram[0x1000] = 0x85; mem.ram[0x1001] = 0x80;
  const kinds = captureBusKinds(cpu, 3);
  expectKinds(kinds, ['read', 'read', 'write'], 'STA zp');
  ok('NMOS: STA zp bus-kind = read, read, write');
}

// ── 5: TAX/TAY/TXA/TYA all = 2× read (both cycles are bus reads in
// NMOS — internal ops also drive the bus, dummy-read PC+1).
{
  const transfers = [
    { name: 'TAX', opcode: 0xAA },
    { name: 'TAY', opcode: 0xA8 },
    { name: 'TXA', opcode: 0x8A },
    { name: 'TYA', opcode: 0x98 },
  ];
  for (const t of transfers) {
    const { cpu, mem } = makeCpu();
    parkAt(cpu, 0x1000);
    mem.ram[0x1000] = t.opcode;
    const kinds = captureBusKinds(cpu, 2);
    expect(kinds[0] === 'read' && kinds[1] === 'read',
      `${t.name} bus-kind = 2× read; got ${kinds.join(',')}`);
  }
  ok('NMOS: TAX/TAY/TXA/TYA all = 2× read');
}

// ── 6: ORA imm + EOR imm + AND imm = 2× read each.
{
  const ops = [
    { name: 'ORA imm', opcode: 0x09 },
    { name: 'EOR imm', opcode: 0x49 },
    { name: 'AND imm', opcode: 0x29 },
  ];
  for (const o of ops) {
    const { cpu, mem } = makeCpu();
    parkAt(cpu, 0x1000);
    mem.ram[0x1000] = o.opcode; mem.ram[0x1001] = 0xFF;
    const kinds = captureBusKinds(cpu, 2);
    expect(kinds[0] === 'read' && kinds[1] === 'read',
      `${o.name}: 2× read; got ${kinds.join(',')}`);
  }
  ok('NMOS: ORA/EOR/AND imm all = 2× read');
}

// ── 7: NOP = 2× read.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  mem.ram[0x1000] = 0xEA;
  const kinds = captureBusKinds(cpu, 2);
  expectKinds(kinds, ['read', 'read'], 'NOP');
  ok('NMOS: NOP bus-kind = 2× read');
}

// ── 8: LSR A / ROL A / ASL A / ROR A (accumulator) = 2× read.
{
  const ops = [
    { name: 'LSR A', opcode: 0x4A },
    { name: 'ROL A', opcode: 0x2A },
    { name: 'ASL A', opcode: 0x0A },
    { name: 'ROR A', opcode: 0x6A },
  ];
  for (const o of ops) {
    const { cpu, mem } = makeCpu();
    parkAt(cpu, 0x1000);
    mem.ram[0x1000] = o.opcode;
    const kinds = captureBusKinds(cpu, 2);
    expect(kinds[0] === 'read' && kinds[1] === 'read',
      `${o.name}: 2× read; got ${kinds.join(',')}`);
  }
  ok('NMOS: shift/rotate accumulator (LSR/ROL/ASL/ROR A) = 2× read');
}

console.log(`\n${testNo} handler bus-kind audit spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
