// Comprehensive 6502/6510 illegal-opcode cycle-count audit.
//
// nine.prg's IRQ handler uses illegal opcodes (LAX zp $A7, AXS imm $CB,
// SLO/RLA/SRE/RRA/DCP/ISB read-modify-write variants) for tighter
// cycle budgets. Any one of them taking the wrong number of cycles in
// our impl shifts the demo's stable-IRQ timing.
//
// Cycle table sources of truth (NMOS 6502 / MOS 6510 documented in
// "Extra Instructions Of The 65XX Series CPU" by Adam Vardy and the
// VICE reference; corroborated by the Lorenz tests):
//
//   addressing mode          base cyc   page-cross +1
//   ─────────────────────────────────────────────────
//   immediate (imm)             2          n/a
//   zero page (zp)              3          n/a
//   zp,X / zp,Y                 4          n/a
//   absolute (abs)              4          n/a
//   abs,X / abs,Y (loads)       4          yes
//   abs,X / abs,Y (stores)      5          n/a (always 5)
//   abs,X (RMW)                 7          n/a (always 7)
//   abs,Y (RMW)                 7          n/a
//   (zp,X)                      6          n/a
//   (zp),Y (loads)              5          yes
//   (zp),Y (stores)             6          n/a (always 6)
//   (zp),Y (RMW)                8          n/a
//
// RMW = read-modify-write (DCP, ISB, SLO, RLA, SRE, RRA). Always pays
// the worst-case page-cross cost since it does a dummy write at the
// non-crossed address before the real R-M-W.
//
// One test per opcode form. Spec-derived expected cycles; failures
// expose impl bugs in cpu.js's CYCLES[] table or per-opcode logic.

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

// Build a minimal program at $0400 with `op b1 b2`, run a single
// instruction, return cycle count. The init callback can pre-set
// registers so addressing modes without page-cross can be exercised.
function runOpcode(opcode, op1 = 0, op2 = 0, init = (cpu, mem) => {}) {
  const mem = new FlatMemory();
  mem.ram[0x0400] = opcode;
  mem.ram[0x0401] = op1;
  mem.ram[0x0402] = op2;
  // Generic test fixtures so RMW reads land on something:
  mem.ram[0x0040] = 0x42;
  mem.ram[0x0050] = 0x33;
  mem.ram[0x0500] = 0x77;
  // (zp,X) pointer table: $40 → $0500, $42 → $0500
  mem.ram[0x0040] = 0x00; mem.ram[0x0041] = 0x05;
  mem.ram[0x0042] = 0x00; mem.ram[0x0043] = 0x05;
  // (zp),Y pointers in same area
  mem.ram[0x0044] = 0x00; mem.ram[0x0045] = 0x05;  // base $0500
  // page-cross variant
  mem.ram[0x0046] = 0xFF; mem.ram[0x0047] = 0x05;  // base $05FF, +Y → cross
  const cpu = new CPU(mem);
  cpu.pc = 0x0400; cpu.sp = 0xFF;
  cpu.a = 0; cpu.x = 0; cpu.y = 0;
  init(cpu, mem);
  let cycles = 0;
  while (cycles < 20) {
    cpu.clock();
    cycles++;
    if (cpu.atInstructionBoundary()) break;
  }
  return cycles;
}

function check(opcode, op1, op2, init, expected, label) {
  const c = runOpcode(opcode, op1, op2, init);
  expect(c === expected, `$${opcode.toString(16).toUpperCase()} ${label}: expected ${expected}, got ${c}`);
}

// ── 1: LAX family (LDA + LDX combined) — load timing ──────────────────
// LAX zp $A7 = 3, LAX zp,Y $B7 = 4, LAX abs $AF = 4, LAX abs,Y $BF = 4
// no-cross / 5 cross, LAX (zp,X) $A3 = 6, LAX (zp),Y $B3 = 5/6.
{
  check(0xA7, 0x40, 0, () => {}, 3, 'LAX zp');
  check(0xB7, 0x40, 0, (cpu) => { cpu.y = 1; }, 4, 'LAX zp,Y');
  check(0xAF, 0x40, 0x05, () => {}, 4, 'LAX abs');
  check(0xBF, 0x40, 0x05, (cpu) => { cpu.y = 0; }, 4, 'LAX abs,Y no-cross');
  check(0xBF, 0xFF, 0x05, (cpu) => { cpu.y = 1; }, 5, 'LAX abs,Y page-cross');
  check(0xA3, 0x40, 0, (cpu) => { cpu.x = 0; }, 6, 'LAX (zp,X)');
  check(0xB3, 0x44, 0, (cpu) => { cpu.y = 0; }, 5, 'LAX (zp),Y no-cross');
  check(0xB3, 0x46, 0, (cpu) => { cpu.y = 1; }, 6, 'LAX (zp),Y page-cross');
  ok('LAX family cycle counts (NMOS 6502)');
}

// ── 2: SAX family (A AND X → store) — store timing ────────────────────
// SAX zp $87 = 3, SAX zp,Y $97 = 4, SAX abs $8F = 4, SAX (zp,X) $83 = 6.
{
  check(0x87, 0x40, 0, () => {}, 3, 'SAX zp');
  check(0x97, 0x40, 0, (cpu) => { cpu.y = 1; }, 4, 'SAX zp,Y');
  check(0x8F, 0x40, 0x05, () => {}, 4, 'SAX abs');
  check(0x83, 0x40, 0, (cpu) => { cpu.x = 0; }, 6, 'SAX (zp,X)');
  ok('SAX family cycle counts');
}

// ── 3: SBX/AXS imm $CB = 2 — used in nine.prg handler ────────────────
{
  check(0xCB, 0x10, 0, () => {}, 2, 'SBX/AXS imm');
  ok('SBX/AXS imm ($CB) = 2 cycles');
}

// ── 4: DCP family (DEC + CMP combined) — RMW ─────────────────────────
// DCP zp $C7 = 5, DCP zp,X $D7 = 6, DCP abs $CF = 6,
// DCP abs,X $DF = 7, DCP abs,Y $DB = 7, DCP (zp,X) $C3 = 8, DCP (zp),Y $D3 = 8.
{
  check(0xC7, 0x40, 0, () => {}, 5, 'DCP zp');
  check(0xD7, 0x40, 0, (cpu) => { cpu.x = 1; }, 6, 'DCP zp,X');
  check(0xCF, 0x40, 0x05, () => {}, 6, 'DCP abs');
  check(0xDF, 0x40, 0x05, (cpu) => { cpu.x = 0; }, 7, 'DCP abs,X');
  check(0xDB, 0x40, 0x05, (cpu) => { cpu.y = 0; }, 7, 'DCP abs,Y');
  check(0xC3, 0x40, 0, (cpu) => { cpu.x = 0; }, 8, 'DCP (zp,X)');
  check(0xD3, 0x44, 0, (cpu) => { cpu.y = 0; }, 8, 'DCP (zp),Y');
  ok('DCP family cycle counts (RMW)');
}

// ── 5: ISB/ISC family (INC + SBC) — RMW ──────────────────────────────
{
  check(0xE7, 0x40, 0, () => {}, 5, 'ISB zp');
  check(0xF7, 0x40, 0, (cpu) => { cpu.x = 1; }, 6, 'ISB zp,X');
  check(0xEF, 0x40, 0x05, () => {}, 6, 'ISB abs');
  check(0xFF, 0x40, 0x05, (cpu) => { cpu.x = 0; }, 7, 'ISB abs,X');
  check(0xFB, 0x40, 0x05, (cpu) => { cpu.y = 0; }, 7, 'ISB abs,Y');
  check(0xE3, 0x40, 0, (cpu) => { cpu.x = 0; }, 8, 'ISB (zp,X)');
  check(0xF3, 0x44, 0, (cpu) => { cpu.y = 0; }, 8, 'ISB (zp),Y');
  ok('ISB/ISC family cycle counts (RMW)');
}

// ── 6: SLO family (ASL + ORA) — RMW ───────────────────────────────────
{
  check(0x07, 0x40, 0, () => {}, 5, 'SLO zp');
  check(0x17, 0x40, 0, (cpu) => { cpu.x = 1; }, 6, 'SLO zp,X');
  check(0x0F, 0x40, 0x05, () => {}, 6, 'SLO abs');
  check(0x1F, 0x40, 0x05, (cpu) => { cpu.x = 0; }, 7, 'SLO abs,X');
  check(0x1B, 0x40, 0x05, (cpu) => { cpu.y = 0; }, 7, 'SLO abs,Y');
  check(0x03, 0x40, 0, (cpu) => { cpu.x = 0; }, 8, 'SLO (zp,X)');
  check(0x13, 0x44, 0, (cpu) => { cpu.y = 0; }, 8, 'SLO (zp),Y');
  ok('SLO family cycle counts (RMW)');
}

// ── 7: RLA family (ROL + AND) — RMW ──────────────────────────────────
{
  check(0x27, 0x40, 0, () => {}, 5, 'RLA zp');
  check(0x37, 0x40, 0, (cpu) => { cpu.x = 1; }, 6, 'RLA zp,X');
  check(0x2F, 0x40, 0x05, () => {}, 6, 'RLA abs');
  check(0x3F, 0x40, 0x05, (cpu) => { cpu.x = 0; }, 7, 'RLA abs,X');
  check(0x3B, 0x40, 0x05, (cpu) => { cpu.y = 0; }, 7, 'RLA abs,Y');
  check(0x23, 0x40, 0, (cpu) => { cpu.x = 0; }, 8, 'RLA (zp,X)');
  check(0x33, 0x44, 0, (cpu) => { cpu.y = 0; }, 8, 'RLA (zp),Y');
  ok('RLA family cycle counts (RMW)');
}

// ── 8: SRE family (LSR + EOR) — RMW ──────────────────────────────────
{
  check(0x47, 0x40, 0, () => {}, 5, 'SRE zp');
  check(0x57, 0x40, 0, (cpu) => { cpu.x = 1; }, 6, 'SRE zp,X');
  check(0x4F, 0x40, 0x05, () => {}, 6, 'SRE abs');
  check(0x5F, 0x40, 0x05, (cpu) => { cpu.x = 0; }, 7, 'SRE abs,X');
  check(0x5B, 0x40, 0x05, (cpu) => { cpu.y = 0; }, 7, 'SRE abs,Y');
  check(0x43, 0x40, 0, (cpu) => { cpu.x = 0; }, 8, 'SRE (zp,X)');
  check(0x53, 0x44, 0, (cpu) => { cpu.y = 0; }, 8, 'SRE (zp),Y');
  ok('SRE family cycle counts (RMW)');
}

// ── 9: RRA family (ROR + ADC) — RMW ──────────────────────────────────
{
  check(0x67, 0x40, 0, () => {}, 5, 'RRA zp');
  check(0x77, 0x40, 0, (cpu) => { cpu.x = 1; }, 6, 'RRA zp,X');
  check(0x6F, 0x40, 0x05, () => {}, 6, 'RRA abs');
  check(0x7F, 0x40, 0x05, (cpu) => { cpu.x = 0; }, 7, 'RRA abs,X');
  check(0x7B, 0x40, 0x05, (cpu) => { cpu.y = 0; }, 7, 'RRA abs,Y');
  check(0x63, 0x40, 0, (cpu) => { cpu.x = 0; }, 8, 'RRA (zp,X)');
  check(0x73, 0x44, 0, (cpu) => { cpu.y = 0; }, 8, 'RRA (zp),Y');
  ok('RRA family cycle counts (RMW)');
}

// ── 10: Immediate-mode illegals — all 2 cycles ────────────────────────
{
  check(0x0B, 0x10, 0, () => {}, 2, 'ANC imm ($0B)');
  check(0x2B, 0x10, 0, () => {}, 2, 'ANC imm ($2B)');
  check(0x4B, 0x10, 0, () => {}, 2, 'ALR/ASR imm ($4B)');
  check(0x6B, 0x10, 0, () => {}, 2, 'ARR imm ($6B)');
  check(0xAB, 0x10, 0, () => {}, 2, 'LAX imm/LXA ($AB)');
  check(0xEB, 0x10, 0, () => {}, 2, 'illegal SBC imm ($EB)');
  ok('all immediate illegals = 2 cycles');
}

// ── 11: 1-byte illegal NOPs — all 2 cycles ────────────────────────────
{
  for (const op of [0x1A, 0x3A, 0x5A, 0x7A, 0xDA, 0xFA]) {
    const c = runOpcode(op);
    expect(c === 2, `1-byte NOP $${op.toString(16)}: expected 2, got ${c}`);
  }
  ok('1-byte illegal NOPs = 2 cycles each');
}

// ── 12: 2-byte immediate illegal NOPs ─────────────────────────────────
{
  for (const op of [0x80, 0x82, 0x89, 0xC2, 0xE2]) {
    const c = runOpcode(op, 0x10);
    expect(c === 2, `2-byte imm NOP $${op.toString(16)}: expected 2, got ${c}`);
  }
  ok('immediate 2-byte NOPs = 2 cycles each');
}

// ── 13: zp NOPs $04, $44, $64 = 3 cycles each ────────────────────────
{
  for (const op of [0x04, 0x44, 0x64]) {
    const c = runOpcode(op, 0x40);
    expect(c === 3, `zp NOP $${op.toString(16)}: expected 3, got ${c}`);
  }
  ok('zp 2-byte NOPs = 3 cycles each');
}

// ── 14: zp,X NOPs $14, $34, $54, $74, $D4, $F4 = 4 cycles each ───────
{
  for (const op of [0x14, 0x34, 0x54, 0x74, 0xD4, 0xF4]) {
    const c = runOpcode(op, 0x40, 0, (cpu) => { cpu.x = 1; });
    expect(c === 4, `zp,X NOP $${op.toString(16)}: expected 4, got ${c}`);
  }
  ok('zp,X 2-byte NOPs = 4 cycles each');
}

// ── 15: abs NOP $0C = 4 cycles ────────────────────────────────────────
{
  check(0x0C, 0x40, 0x05, () => {}, 4, 'NOP abs ($0C)');
  ok('NOP abs ($0C) = 4 cycles');
}

// ── 16: abs,X NOPs no-cross = 4 cycles ────────────────────────────────
{
  for (const op of [0x1C, 0x3C, 0x5C, 0x7C, 0xDC, 0xFC]) {
    const c = runOpcode(op, 0x40, 0x05, (cpu) => { cpu.x = 0; });
    expect(c === 4, `abs,X NOP $${op.toString(16)} no-cross: expected 4, got ${c}`);
  }
  ok('abs,X 3-byte NOPs no-cross = 4 cycles each');
}

// ── 17: abs,X NOPs page-cross = 5 cycles ──────────────────────────────
{
  for (const op of [0x1C, 0x3C, 0x5C, 0x7C, 0xDC, 0xFC]) {
    const c = runOpcode(op, 0xFF, 0x05, (cpu) => { cpu.x = 1; });
    expect(c === 5, `abs,X NOP $${op.toString(16)} page-cross: expected 5, got ${c}`);
  }
  ok('abs,X 3-byte NOPs page-cross = 5 cycles each');
}

console.log(`\n${testNo} illegal-opcode cycle audit tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
