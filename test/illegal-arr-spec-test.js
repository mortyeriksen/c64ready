// ARR ($6B) — AND #imm followed by ROR through C, with special V/C flag
// semantics. Per 64doc / Visual6502 (binary mode):
//   1) A = A AND oper
//   2) A = (A >> 1) | (C_in << 7)
//   3) N = bit 7 of result   (= the old C input)
//   4) Z = (A == 0)
//   5) C_out = bit 6 of result
//   6) V = bit 6 XOR bit 5 of result
//
// NLP's fastloader uses `6B F0` and similar; an incorrect V flag breaks
// the branches that follow. This pins both arithmetic correctness AND
// the JS operator-precedence trap (`(a >> 6) ^ (a >> 5) & 1` parses as
// `(a >> 6) ^ ((a >> 5) & 1)` because `&` binds tighter than `^` — the
// bit 6 term must extract a single bit BEFORE XOR).

import { CPU } from '../src/cpu.js';

class Mem {
  constructor() { this.b = new Uint8Array(0x10000); }
  read(a) { return this.b[a & 0xFFFF]; }
  write(a, v) { this.b[a & 0xFFFF] = v & 0xFF; }
}

function assert(cond, msg) {
  if (!cond) { console.error(`  [FAIL] ${msg}`); process.exitCode = 1; }
  else console.log(`  [PASS] ${msg}`);
}

function setupCpu(a, c, operand) {
  const mem = new Mem();
  const cpu = new CPU(mem);
  cpu.pc = 0xC000;
  cpu.a = a;
  cpu.C = c;
  cpu.I = 1;
  // ARR #operand at $C000
  mem.b[0xC000] = 0x6B;
  mem.b[0xC001] = operand;
  return { cpu, mem };
}

function runOne(cpu) {
  // Drive cycle-accurate path (matches normal operation).
  for (let i = 0; i < 4; i++) cpu.clock();
}

function expectFlags(cpu, expected, label) {
  const got = {
    a: cpu.a,
    n: cpu.N ? 1 : 0,
    z: cpu.Z ? 1 : 0,
    c: cpu.C ? 1 : 0,
    v: cpu.V ? 1 : 0,
  };
  const ok = (got.a === expected.a) && (got.n === expected.n) &&
             (got.z === expected.z) && (got.c === expected.c) &&
             (got.v === expected.v);
  if (!ok) {
    console.error(`  [FAIL] ${label}: expected A=$${expected.a.toString(16)} N=${expected.n} Z=${expected.z} C=${expected.c} V=${expected.v}, got A=$${got.a.toString(16)} N=${got.n} Z=${got.z} C=${got.c} V=${got.v}`);
    process.exitCode = 1;
  } else {
    console.log(`  [PASS] ${label}`);
  }
}

console.log('ARR ($6B) — binary mode flag semantics...');

// Case 1: A=$00, C=0, oper=$FF → AND=$00 → ROR=$00. bit6=0, bit5=0. V=0.
{
  const { cpu } = setupCpu(0x00, 0, 0xFF);
  runOne(cpu);
  expectFlags(cpu, { a: 0x00, n: 0, z: 1, c: 0, v: 0 }, 'A=$00 C=0 oper=$FF → A=$00, all zero except Z');
}

// Case 2: A=$FF, C=0, oper=$FF → AND=$FF → ROR=$7F. bit6=1, bit5=1. C=1. V=0.
{
  const { cpu } = setupCpu(0xFF, 0, 0xFF);
  runOne(cpu);
  expectFlags(cpu, { a: 0x7F, n: 0, z: 0, c: 1, v: 0 }, 'A=$FF C=0 oper=$FF → A=$7F C=1 V=0');
}

// Case 3: A=$FF, C=1, oper=$FF → AND=$FF → ROR with C-in=1 = $FF. bit6=1, bit5=1. C=1. V=0.
// CRITICAL: this is the case that exposes the V precedence bug.
// (a >> 6) of $FF = 3. Buggy V = 3 ^ 1 = 2 (truthy → wrongly set).
// Correct V = 1 ^ 1 = 0.
{
  const { cpu } = setupCpu(0xFF, 1, 0xFF);
  runOne(cpu);
  expectFlags(cpu, { a: 0xFF, n: 1, z: 0, c: 1, v: 0 }, 'A=$FF C=1 oper=$FF → A=$FF, V=0 (bit-6 precedence trap)');
}

// Case 4: A=$80, C=0, oper=$FF → AND=$80 → ROR=$40. bit6=1, bit5=0. C=1. V=1.
{
  const { cpu } = setupCpu(0x80, 0, 0xFF);
  runOne(cpu);
  expectFlags(cpu, { a: 0x40, n: 0, z: 0, c: 1, v: 1 }, 'A=$80 C=0 oper=$FF → A=$40, C=1 V=1');
}

// Case 5: A=$40, C=0, oper=$FF → AND=$40 → ROR=$20. bit6=0, bit5=1. C=0. V=1.
{
  const { cpu } = setupCpu(0x40, 0, 0xFF);
  runOne(cpu);
  expectFlags(cpu, { a: 0x20, n: 0, z: 0, c: 0, v: 1 }, 'A=$40 C=0 oper=$FF → A=$20, C=0 V=1');
}

// Case 6: A=$F0, C=1, oper=$F0 (= NLP's `ARR #$F0` pattern).
// AND = $F0. ROR with C-in=1 → $F8. bit7=1, bit6=1, bit5=1.
// C = bit 6 = 1. V = bit 6 ^ bit 5 = 1 ^ 1 = 0.
// Buggy: (a >> 6) = 3, (a >> 5) & 1 = 1. V = 3 ^ 1 = 2 (truthy).
{
  const { cpu } = setupCpu(0xF0, 1, 0xF0);
  runOne(cpu);
  expectFlags(cpu, { a: 0xF8, n: 1, z: 0, c: 1, v: 0 }, 'A=$F0 C=1 oper=$F0 → A=$F8, V=0 (NLP fastloader case)');
}

// NOTE: the CPU's ONLY runtime execution path is the micro-op queue
// (_beginMicroInstruction → clock()), exercised by the cases above — which
// already pin the V operator-precedence trap (Case 3 A=$FF C=1, Case 6 the NLP
// `ARR #$F0`). The old `_executeInstruction` "direct-execute" switch (a second,
// redundant per-opcode implementation) has been REMOVED, so there is a single
// execution path and nothing else to test.

if (!process.exitCode) console.log('\nAll ARR tests passed.');
