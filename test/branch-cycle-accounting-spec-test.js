// Branch cycle accounting under BA-low spec test.
//
// 6502/6510 branch instructions (BNE, BEQ, BCC, BCS, BMI, BPL, BVC, BVS):
//   2 cycles if branch NOT taken
//   3 cycles if branch taken, no page cross
//   4 cycles if branch taken, page cross
//
// The extra cycle on "taken, no page cross" is an internal dummy read
// of the next instruction's opcode (which is then discarded). The
// page-cross extra cycle is another internal read.
//
// Under BA-low, reads stall but writes proceed. Branch internal reads
// stall under BA. Handler cycle-counted code with branches in BA
// windows can drift if the branch cycle accounting differs from spec.
//
// FppScroller's handler likely has at least one conditional branch
// (loop counter, alignment guard). Drift in branch cycle count would
// cascade through every subsequent write.

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

function cyclesUntilPc(cpu, target, budget = 50) {
  for (let i = 0; i < budget; i++) {
    if (cpu.pc === target) return i;
    cpu.clock();
  }
  return -1;
}

// Count master cycles until the CPU completes the current instruction
// AND reaches `target` PC. More precise than cyclesUntilPc for branches:
// our impl updates PC at branch cycle 3 but adds a 4th cycle for the
// page-cross dummy fetch, so cyclesUntilPc would short-count at cy 3.
function cyclesUntilInstructionDone(cpu, target, budget = 50) {
  let i = 0;
  // Run at least one cycle (don't count "already done before any cycle").
  while (i < budget) {
    cpu.clock();
    i++;
    if (cpu.pc === target && cpu.instructionCyclesRemaining === 0) return i;
  }
  return -1;
}

// ── 1: Branch NOT taken = 2 cycles.
{
  const { cpu, mem } = makeCpu();
  cpu.pc = 0x1000;
  cpu.Z = 1;                          // Z=1 means BNE not taken
  cpu.instructionCyclesRemaining = 0;
  cpu.microOpHead = 0;
  cpu.microOpLen = 0;
  mem.ram[0x1000] = 0xD0; mem.ram[0x1001] = 0x10;       // BNE +$10
  const n = cyclesUntilPc(cpu, 0x1002);
  expect(n === 2,
    `BNE not taken: 2 cycles; got ${n}`);
  ok('NMOS 6502: branch NOT taken = 2 cycles');
}

// ── 2: Branch taken, no page cross = 3 cycles.
{
  const { cpu, mem } = makeCpu();
  cpu.pc = 0x1000;
  cpu.Z = 0;                          // BNE taken
  cpu.instructionCyclesRemaining = 0;
  cpu.microOpHead = 0;
  cpu.microOpLen = 0;
  mem.ram[0x1000] = 0xD0; mem.ram[0x1001] = 0x10;       // BNE +$10 → $1012
  const n = cyclesUntilInstructionDone(cpu, 0x1012);
  expect(n === 3,
    `BNE taken (no page cross): 3 cycles; got ${n}`);
  ok('NMOS 6502: branch taken, no page cross = 3 cycles');
}

// ── 3: Branch taken, page cross = 4 cycles.
//
// Branch from $10F0 with offset +$20 → target $1112 (page cross from
// $10 to $11). PC = $10F0 + 2 = $10F2, +$20 = $1112. Page byte changed
// from $10 to $11 → page cross.
{
  const { cpu, mem } = makeCpu();
  cpu.pc = 0x10F0;
  cpu.Z = 0;
  cpu.instructionCyclesRemaining = 0;
  cpu.microOpHead = 0;
  cpu.microOpLen = 0;
  mem.ram[0x10F0] = 0xD0; mem.ram[0x10F1] = 0x20;       // BNE +$20 → $1112
  const n = cyclesUntilInstructionDone(cpu, 0x1112);
  expect(n === 4,
    `BNE taken with page cross: 4 cycles; got ${n}`);
  ok('NMOS 6502: branch taken, page cross = 4 cycles');
}

// ── 4: Branch backward, taken, no page cross = 3 cycles.
// Offset is signed 8-bit; -$10 = $F0.
{
  const { cpu, mem } = makeCpu();
  cpu.pc = 0x1050;
  cpu.Z = 0;
  cpu.instructionCyclesRemaining = 0;
  cpu.microOpHead = 0;
  cpu.microOpLen = 0;
  mem.ram[0x1050] = 0xD0; mem.ram[0x1051] = 0xF0;       // BNE -$10 → $1042
  const n = cyclesUntilInstructionDone(cpu, 0x1042);
  expect(n === 3,
    `BNE backward (no page cross): 3 cycles; got ${n}`);
  ok('NMOS 6502: branch backward, no page cross = 3 cycles');
}

// ── 5: All 8 branch opcodes follow the same cycle rules.
//
// Test each branch type taken (no page cross) = 3 cy.
{
  const branches = [
    { name: 'BCS', opcode: 0xB0, setFlag: cpu => cpu.C = 1 },
    { name: 'BCC', opcode: 0x90, setFlag: cpu => cpu.C = 0 },
    { name: 'BEQ', opcode: 0xF0, setFlag: cpu => cpu.Z = 1 },
    { name: 'BNE', opcode: 0xD0, setFlag: cpu => cpu.Z = 0 },
    { name: 'BMI', opcode: 0x30, setFlag: cpu => cpu.N = 1 },
    { name: 'BPL', opcode: 0x10, setFlag: cpu => cpu.N = 0 },
    { name: 'BVS', opcode: 0x70, setFlag: cpu => cpu.V = 1 },
    { name: 'BVC', opcode: 0x50, setFlag: cpu => cpu.V = 0 },
  ];
  for (const br of branches) {
    const { cpu, mem } = makeCpu();
    cpu.pc = 0x1000;
    br.setFlag(cpu);
    cpu.instructionCyclesRemaining = 0;
    cpu.microOpHead = 0;
    cpu.microOpLen = 0;
    mem.ram[0x1000] = br.opcode; mem.ram[0x1001] = 0x10;
    const n = cyclesUntilInstructionDone(cpu, 0x1012);
    expect(n === 3,
      `${br.name} taken (no page cross): 3 cycles; got ${n}`);
  }
  ok('NMOS 6502: all 8 branch opcodes follow 2/3/4-cycle rule');
}

// ── 6: Branch internal "dummy fetch" cycle is a READ (bus-kind = read).
//
// Critical for BA-low interaction: if the branch's internal cycle is
// classified as a read, it stalls under BA-low. If as an internal-op
// (no bus), it doesn't.
{
  const { cpu, mem } = makeCpu();
  cpu.pc = 0x1000;
  cpu.Z = 0;
  cpu.instructionCyclesRemaining = 0;
  cpu.microOpHead = 0;
  cpu.microOpLen = 0;
  mem.ram[0x1000] = 0xD0; mem.ram[0x1001] = 0x10;       // BNE taken
  // Run the opcode fetch + operand fetch (2 cy).
  const kinds = [];
  for (let i = 0; i < 3; i++) {
    kinds.push(cpu.peekNextBusKind());
    cpu.clock();
  }
  expect(kinds[0] === 'read', `branch cy 1 (opcode fetch) = read; got ${kinds[0]}`);
  expect(kinds[1] === 'read', `branch cy 2 (operand fetch) = read; got ${kinds[1]}`);
  expect(kinds[2] === 'read',
    `branch cy 3 (taken internal-fetch) = read (next-opcode prefetch); got ${kinds[2]}`);
  ok('NMOS 6502: branch internal cycle is a READ (stalls under BA-low)');
}

console.log(`\n${testNo} branch cycle accounting spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
