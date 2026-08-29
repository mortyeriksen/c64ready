// 6502 illegal-opcode cycle-count spec audit. 10 tests against the
// cycle table that's also the source of truth for CYCLES[] in cpu.js.
// These illegals are commonly used by demos and fastloaders for their
// shorter cycle-counts than the equivalent legal-opcode pair.

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

// Run a single instruction and return total cycles.
function runOpcode(opcode, op1 = 0, op2 = 0, init = (cpu) => {}) {
  const mem = new FlatMemory();
  mem.ram[0x0400] = opcode;
  mem.ram[0x0401] = op1;
  mem.ram[0x0402] = op2;
  mem.ram[0x0040] = 0x40;     // zp-pointer fixture
  mem.ram[0x0041] = 0x05;
  mem.ram[0x0540] = 0x99;
  mem.ram[0x0050] = 0x99;
  const cpu = new CPU(mem);
  cpu.pc = 0x0400; cpu.sp = 0xFF;
  init(cpu);
  let cycles = 0;
  while (cycles < 20) {
    cpu.clock();
    cycles++;
    if (cpu.atInstructionBoundary()) break;
  }
  return cycles;
}

// ── 1: LAX abs ($AF) takes 4 cycles ────────────────────────────────────
// LAX = LDA + LDX (loads both A and X with the same byte). Same cycle
// count as LDA abs.
{
  const c = runOpcode(0xAF, 0x40, 0x05);
  expect(c === 4, `LAX abs must take 4 cycles, got ${c}`);
  ok('6502 illegal: LAX abs ($AF) = 4 cycles');
}

// ── 2: LAX abs,Y ($BF) takes 4 cycles (no page cross) ─────────────────
{
  const c = runOpcode(0xBF, 0x40, 0x05, (cpu) => { cpu.y = 0; });
  expect(c === 4, `LAX abs,Y no-cross must take 4, got ${c}`);
  ok('6502 illegal: LAX abs,Y ($BF) = 4 cycles (no page cross)');
}

// ── 3: LAX abs,Y page-cross adds +1 cycle ─────────────────────────────
{
  const mem = new FlatMemory();
  mem.ram[0x0400] = 0xBF;
  mem.ram[0x0401] = 0xFF;     // base $05FF
  mem.ram[0x0402] = 0x05;
  const cpu = new CPU(mem);
  cpu.pc = 0x0400; cpu.sp = 0xFF; cpu.y = 1;   // → $0600 page cross
  let cycles = 0;
  while (cycles < 20) {
    cpu.clock();
    cycles++;
    if (cpu.atInstructionBoundary()) break;
  }
  expect(cycles === 5, `LAX abs,Y page-cross must take 5, got ${cycles}`);
  ok('6502 illegal: LAX abs,Y ($BF) page-cross = 5 cycles');
}

// ── 4: SAX abs ($8F) takes 4 cycles ────────────────────────────────────
// SAX writes (A AND X) to memory. Always 4 cycles, no page-cross bonus
// (it's a store).
{
  const c = runOpcode(0x8F, 0x40, 0x05, (cpu) => { cpu.a = 0xF0; cpu.x = 0x0F; });
  expect(c === 4, `SAX abs must take 4 cycles, got ${c}`);
  ok('6502 illegal: SAX abs ($8F) = 4 cycles');
}

// ── 5: DCP abs,X ($DF) takes 7 cycles (always — RMW indexed) ──────────
// DCP = DEC + CMP. As an RMW with indexed addressing, always 7 cycles.
{
  const c = runOpcode(0xDF, 0x40, 0x05, (cpu) => { cpu.x = 0; });
  expect(c === 7, `DCP abs,X must take 7 cycles, got ${c}`);
  ok('6502 illegal: DCP abs,X ($DF) = 7 cycles (RMW indexed always +1)');
}

// ── 6: ISC abs,X ($FF) takes 7 cycles ──────────────────────────────────
// ISC (a.k.a. ISB) = INC + SBC. RMW indexed = 7 cycles.
{
  const c = runOpcode(0xFF, 0x40, 0x05, (cpu) => { cpu.x = 0; cpu.a = 0xFF; cpu.C = 1; });
  expect(c === 7, `ISC abs,X must take 7, got ${c}`);
  ok('6502 illegal: ISC abs,X ($FF) = 7 cycles');
}

// ── 7: RLA abs,X ($3F) takes 7 cycles ──────────────────────────────────
// RLA = ROL + AND. RMW indexed = 7.
{
  const c = runOpcode(0x3F, 0x40, 0x05, (cpu) => { cpu.x = 0; cpu.a = 0xFF; });
  expect(c === 7, `RLA abs,X must take 7, got ${c}`);
  ok('6502 illegal: RLA abs,X ($3F) = 7 cycles');
}

// ── 8: SLO abs,X ($1F) takes 7 cycles ──────────────────────────────────
// SLO = ASL + ORA.
{
  const c = runOpcode(0x1F, 0x40, 0x05, (cpu) => { cpu.x = 0; cpu.a = 0; });
  expect(c === 7, `SLO abs,X must take 7, got ${c}`);
  ok('6502 illegal: SLO abs,X ($1F) = 7 cycles');
}

// ── 9: ANC #imm ($0B) takes 2 cycles ───────────────────────────────────
// ANC = AND immediate, then copy N flag to C.
{
  const c = runOpcode(0x0B, 0x80, 0, (cpu) => { cpu.a = 0xFF; });
  expect(c === 2, `ANC #imm must take 2 cycles, got ${c}`);
  ok('6502 illegal: ANC #imm ($0B) = 2 cycles');
}

// ── 10: NOP variants — 1-byte ($1A, $3A, $5A, $7A, $DA, $FA) = 2 cyc ───
{
  for (const op of [0x1A, 0x3A, 0x5A, 0x7A, 0xDA, 0xFA]) {
    const c = runOpcode(op);
    expect(c === 2, `NOP $${op.toString(16)} must take 2 cycles, got ${c}`);
  }
  ok('6502 illegal: 1-byte NOPs ($1A/$3A/$5A/$7A/$DA/$FA) = 2 cycles');
}

console.log(`\n${testNo} 6502 illegal-opcode spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
