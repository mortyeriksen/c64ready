// Per-opcode cycle audit. For every opcode the CPU dispatches via the
// micro-op queue, run it in isolation and assert the cycle count matches
// the CYCLES[] reference table (the canonical base-cycle counts the CPU's
// micro-op queue lengths must honor). Page-cross variants execute with no
// page cross and zero index, so we get the BASE cycle count.
//
// Designed to catch the same class of bug as 2026-04-30's LDA abs,X /
// abs,Y / (zp),Y miscounts: whenever an opcode's micro-op queue length
// disagrees with the canonical CYCLES table, this fails.

import { CPU } from '../src/cpu.js';
import fs from 'fs';

class FlatMemory {
  constructor() { this.ram = new Uint8Array(0x10000); }
  read(a)   { return this.ram[a & 0xFFFF]; }
  write(a, v) { this.ram[a & 0xFFFF] = v & 0xFF; }
}

// Reference table — same values as the CYCLES[] table inside cpu.js. These
// are documented base cycle counts, no page-cross / branch-taken bonus.
const CYCLES_REF = new Uint8Array([
  // 0  1  2  3  4  5  6  7  8  9  A  B  C  D  E  F
  7, 6, 2, 8, 3, 3, 5, 5, 3, 2, 2, 2, 4, 4, 6, 6, // 0x
  2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7, // 1x
  6, 6, 2, 8, 3, 3, 5, 5, 4, 2, 2, 2, 4, 4, 6, 6, // 2x
  2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7, // 3x
  6, 6, 2, 8, 3, 3, 5, 5, 3, 2, 2, 2, 3, 4, 6, 6, // 4x
  2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7, // 5x
  6, 6, 2, 8, 3, 3, 5, 5, 4, 2, 2, 2, 5, 4, 6, 6, // 6x
  2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7, // 7x
  2, 6, 2, 6, 3, 3, 3, 3, 2, 2, 2, 2, 4, 4, 4, 4, // 8x
  2, 6, 2, 6, 4, 4, 4, 4, 2, 5, 2, 5, 5, 5, 5, 5, // 9x
  2, 6, 2, 6, 3, 3, 3, 3, 2, 2, 2, 2, 4, 4, 4, 4, // Ax
  2, 5, 2, 5, 4, 4, 4, 4, 2, 4, 2, 4, 4, 4, 4, 4, // Bx
  2, 6, 2, 8, 3, 3, 5, 5, 2, 2, 2, 2, 4, 4, 6, 6, // Cx
  2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7, // Dx
  2, 6, 2, 8, 3, 3, 5, 5, 2, 2, 2, 2, 4, 4, 6, 6, // Ex
  2, 5, 2, 8, 4, 4, 6, 6, 2, 4, 2, 7, 4, 4, 7, 7, // Fx
]);

// Opcodes that need special handling or are not appropriate for blind audit:
// - Branches at $10/$30/$50/$70/$90/$B0/$D0/$F0 take 2/3/4 cycles depending
//   on taken/page-cross. Audit them separately with branch NOT taken (=2).
// - JSR ($20), RTS ($60), RTI ($40), BRK ($00) require stack/return state.
// - JMP abs ($4C), JMP ind ($6C) — easy.
// - KIL/halt opcodes ($02, $12, $22, ...) — halt (no fixed cycle count).
// - Illegal/unstable opcodes ($93, $9B, $9C, $9E, $9F) — value-unstable
//   store-illegals; audited elsewhere, not here.
// - PHP/PLP/PHA/PLA: stack ops, easy.
const SKIP = new Set([
  // KIL/halt
  0x02, 0x12, 0x22, 0x32, 0x42, 0x52, 0x62, 0x72, 0x92, 0xB2, 0xD2, 0xF2,
  // unstable illegals (fall-back path)
  0x93, 0x9B, 0x9C, 0x9E, 0x9F,
  // BRK ($00) and RTS/RTI — require special stack state
  0x00, 0x60, 0x40,
  // JSR — needs an actual address
  0x20,
]);

const BRANCH_OPS = new Set([0x10, 0x30, 0x50, 0x70, 0x90, 0xB0, 0xD0, 0xF0]);

let pass = 0, fail = 0;
const failures = [];

for (let op = 0; op < 256; op++) {
  if (SKIP.has(op)) continue;

  const mem = new FlatMemory();
  // Place opcode + plausible operands at $0400. For most modes 2 bytes of
  // operand suffice. Pre-fill operands to safe values that won't cross a
  // page boundary when indexed (operand $40 + X=0/Y=0 → $0040, no cross).
  mem.ram[0x0400] = op;
  mem.ram[0x0401] = 0x40;
  mem.ram[0x0402] = 0x05;   // hi byte → addr $0540, no page cross from $0540
  // For (zp),Y / (zp,X): the zp indirect base is at $0040 = ($00, $05) too.
  mem.ram[0x0040] = 0x40;
  mem.ram[0x0041] = 0x05;
  // Trailing safety: NOP after the opcode so we land at instruction boundary.
  mem.ram[0x0403] = 0xEA;
  mem.ram[0x0404] = 0xEA;
  mem.ram[0x0405] = 0xEA;
  mem.ram[0x0406] = 0xEA;

  const cpu = new CPU(mem);
  cpu.pc = 0x0400;
  cpu.x = 0;
  cpu.y = 0;
  cpu.a = 0;
  cpu.sp = 0xFF;
  // For branches: clear all flags so each branch has a deterministic taken/
  // not-taken outcome. We test the not-taken case (= 2 cycles, base).
  if (BRANCH_OPS.has(op)) {
    cpu.N = 0; cpu.V = 0; cpu.Z = 0; cpu.C = 0;
    // For BPL/BVC/BNE/BCC: these are not taken when N/V/Z/C are 1. We have
    // them at 0, so they ARE taken. Flip flags so they're NOT taken.
    if (op === 0x10) cpu.N = 1; // BPL not taken if N=1
    if (op === 0x30) cpu.N = 0; // BMI not taken if N=0
    if (op === 0x50) cpu.V = 1; // BVC not taken if V=1
    if (op === 0x70) cpu.V = 0; // BVS not taken if V=0
    if (op === 0x90) cpu.C = 1; // BCC not taken if C=1
    if (op === 0xB0) cpu.C = 0; // BCS not taken if C=0
    if (op === 0xD0) cpu.Z = 1; // BNE not taken if Z=1
    if (op === 0xF0) cpu.Z = 0; // BEQ not taken if Z=0
  }

  // Run cycles until we land on the next instruction boundary.
  let cycles = 0;
  const MAX = 20;
  while (cycles < MAX) {
    cpu.clock();
    cycles++;
    if (cpu.atInstructionBoundary()) break;
  }

  const expected = CYCLES_REF[op];
  if (cycles !== expected) {
    fail++;
    failures.push({ op, cycles, expected });
  } else {
    pass++;
  }
}

console.log(`base cycle audit: ${pass} ok, ${fail} mismatch`);
if (failures.length) {
  console.log('\nMISMATCHES:');
  for (const f of failures) {
    console.log(`  $${f.op.toString(16).padStart(2,'0').toUpperCase()}: actual=${f.cycles} expected=${f.expected} (Δ=${f.cycles - f.expected})`);
  }
  process.exit(1);
}
console.log('all base opcode cycles match CYCLES[] reference');

// ── Page-cross audit ─────────────────────────────────────────────────────
// abs,X / abs,Y / (zp),Y on read instructions add +1 cycle when the
// effective addr crosses a page. Setting operand=$FF and index=1 forces
// the cross. Stores (STA abs,X / abs,Y / (zp),Y) ALWAYS pay the dummy
// false read so the +1 is already in the base — verify no extra.
const PAGE_CROSS_READ_OPS = [
  // LDA abs,X/Y, LDX abs,Y, LDY abs,X
  0xBD, 0xB9, 0xBE, 0xBC,
  // ORA / AND / EOR / ADC / SBC / CMP abs,X
  0x1D, 0x3D, 0x5D, 0x7D, 0xDD, 0xFD,
  // ORA / AND / EOR / ADC / SBC / CMP abs,Y
  0x19, 0x39, 0x59, 0x79, 0xD9, 0xF9,
  // (zp),Y reads: ORA AND EOR ADC LDA CMP SBC
  0x11, 0x31, 0x51, 0x71, 0xB1, 0xD1, 0xF1,
  // ILLEGAL read ops that ALSO pay the page-cross +1 — previously un-audited.
  // Motivated by the Coma mole illegal census: LAX (zp),Y ($b3) runs 282k× in
  // the loader/decruncher, so any page-cross miscount there accumulates into the
  // stable-raster phase. LAX abs,Y ($bf), LAS abs,Y ($bb), NOP abs,X/SKW ($1c…).
  0xBF, 0xBB, 0xB3, 0x1C, 0x3C, 0x5C, 0x7C, 0xDC, 0xFC,
];

let pcPass = 0, pcFail = 0;
const pcFailures = [];
const INDY_OPS = new Set([0x11, 0x31, 0x51, 0x71, 0xB1, 0xD1, 0xF1, 0xB3]);
for (const op of PAGE_CROSS_READ_OPS) {
  const mem = new FlatMemory();
  mem.ram[0x0400] = op;
  // For (zp),Y: operand is a zp address. Use $40, where (zp[$40], zp[$41])
  // points to $05FF; +Y=1 then crosses to $0600.
  // For abs,X / abs,Y: operand IS the 16-bit base address. Use $05FF and
  // index=1 to cross.
  if (INDY_OPS.has(op)) {
    mem.ram[0x0401] = 0x40;     // zp address
    mem.ram[0x0040] = 0xFF;     // base lo
    mem.ram[0x0041] = 0x05;     // base hi
  } else {
    mem.ram[0x0401] = 0xFF;     // base lo
    mem.ram[0x0402] = 0x05;     // base hi
  }
  mem.ram[0x0403] = 0xEA;

  const cpu = new CPU(mem);
  cpu.pc = 0x0400;
  cpu.x = 1; cpu.y = 1; cpu.a = 0; cpu.sp = 0xFF;

  let cycles = 0;
  while (cycles < 20) {
    cpu.clock();
    cycles++;
    if (cpu.atInstructionBoundary()) break;
  }
  const expected = CYCLES_REF[op] + 1;
  if (cycles !== expected) {
    pcFail++;
    pcFailures.push({ op, cycles, expected });
  } else {
    pcPass++;
  }
}
console.log(`\npage-cross audit (read +1): ${pcPass} ok, ${pcFail} mismatch`);
for (const f of pcFailures) {
  console.log(`  $${f.op.toString(16).padStart(2,'0').toUpperCase()}: actual=${f.cycles} expected=${f.expected} (Δ=${f.cycles - f.expected})`);
}

// Stores never pay a page-cross bonus.
const STORE_OPS_NO_PC = [0x9D, 0x99, 0x91];
let stPass = 0, stFail = 0;
const stFailures = [];
for (const op of STORE_OPS_NO_PC) {
  const mem = new FlatMemory();
  mem.ram[0x0400] = op;
  if (op === 0x91) {
    mem.ram[0x0401] = 0x40;
    mem.ram[0x0040] = 0xFF;
    mem.ram[0x0041] = 0x05;
  } else {
    mem.ram[0x0401] = 0xFF;
    mem.ram[0x0402] = 0x05;
  }
  mem.ram[0x0403] = 0xEA;

  const cpu = new CPU(mem);
  cpu.pc = 0x0400;
  cpu.x = 1; cpu.y = 1; cpu.a = 0; cpu.sp = 0xFF;

  let cycles = 0;
  while (cycles < 20) {
    cpu.clock();
    cycles++;
    if (cpu.atInstructionBoundary()) break;
  }
  const expected = CYCLES_REF[op]; // unchanged on page cross
  if (cycles !== expected) {
    stFail++;
    stFailures.push({ op, cycles, expected });
  } else {
    stPass++;
  }
}
console.log(`store +0 page-cross audit: ${stPass} ok, ${stFail} mismatch`);
for (const f of stFailures) {
  console.log(`  $${f.op.toString(16).padStart(2,'0').toUpperCase()}: actual=${f.cycles} expected=${f.expected} (Δ=${f.cycles - f.expected})`);
}

// Branch taken / page-cross
const BRANCH_TESTS = [
  // op, set flags so branch IS taken, expected cycles same-page (3)
  { op: 0x10, init: c => { c.N = 0; }, expSame: 3 },  // BPL
  { op: 0x30, init: c => { c.N = 1; }, expSame: 3 },  // BMI
  { op: 0x50, init: c => { c.V = 0; }, expSame: 3 },  // BVC
  { op: 0x70, init: c => { c.V = 1; }, expSame: 3 },  // BVS
  { op: 0x90, init: c => { c.C = 0; }, expSame: 3 },  // BCC
  { op: 0xB0, init: c => { c.C = 1; }, expSame: 3 },  // BCS
  { op: 0xD0, init: c => { c.Z = 0; }, expSame: 3 },  // BNE
  { op: 0xF0, init: c => { c.Z = 1; }, expSame: 3 },  // BEQ
];
let brPass = 0, brFail = 0;
const brFailures = [];
for (const t of BRANCH_TESTS) {
  // Same-page: small forward offset
  {
    const mem = new FlatMemory();
    mem.ram[0x0400] = t.op;
    mem.ram[0x0401] = 0x10; // +16 → $0412, same page
    for (let i = 0; i < 32; i++) mem.ram[0x0402 + i] = 0xEA;

    const cpu = new CPU(mem);
    cpu.pc = 0x0400; cpu.sp = 0xFF;
    t.init(cpu);

    let cycles = 0;
    while (cycles < 20) {
      cpu.clock();
      cycles++;
      if (cpu.atInstructionBoundary()) break;
    }
    if (cycles !== t.expSame) {
      brFail++;
      brFailures.push({ op: t.op, kind: 'same-page-taken', cycles, expected: t.expSame });
    } else {
      brPass++;
    }
  }
  // Page-cross taken: branch from $04F0 with offset $40 → $0532 (cross)
  {
    const mem = new FlatMemory();
    mem.ram[0x04F0] = t.op;
    mem.ram[0x04F1] = 0x40; // +0x40 from $04F2 → $0532 → cross
    for (let i = 0; i < 64; i++) mem.ram[0x0532 + i] = 0xEA;

    const cpu = new CPU(mem);
    cpu.pc = 0x04F0; cpu.sp = 0xFF;
    t.init(cpu);

    let cycles = 0;
    while (cycles < 20) {
      cpu.clock();
      cycles++;
      if (cpu.atInstructionBoundary()) break;
    }
    const expected = 4; // branch taken + page cross
    if (cycles !== expected) {
      brFail++;
      brFailures.push({ op: t.op, kind: 'cross-page-taken', cycles, expected });
    } else {
      brPass++;
    }
  }
}
console.log(`branch audit (taken same/cross): ${brPass} ok, ${brFail} mismatch`);
for (const f of brFailures) {
  console.log(`  $${f.op.toString(16).padStart(2,'0').toUpperCase()} ${f.kind}: actual=${f.cycles} expected=${f.expected} (Δ=${f.cycles - f.expected})`);
}

const totalFail = fail + pcFail + stFail + brFail;
if (totalFail) {
  console.log(`\n${totalFail} total mismatches`);
  process.exit(1);
}
console.log('\nALL CYCLE AUDITS PASS');
