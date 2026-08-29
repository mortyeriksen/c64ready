// Focused 6502 illegal-opcode tests.
// Exercises the micro-op execution path (cpu.clock()) — that's the path the
// machine uses, and where bugs in PC advancement or flag handling hide.
//
// Coverage:
//   - Multi-byte NOPs: 0x80, 0x82, 0x89, 0xC2, 0xE2, 0x04, 0x44, 0x64,
//                      0x14, 0x34, 0x54, 0x74, 0xD4, 0xF4,
//                      0x0C, 0x1C, 0x3C, 0x5C, 0x7C, 0xDC, 0xFC
//   - LAX:  0xA3, 0xA7, 0xAF, 0xB3, 0xB7, 0xBF
//   - SAX:  0x83, 0x87, 0x8F, 0x97
//   - AXS/SBX: 0xCB
//   - ANC:  0x0B, 0x2B
//   - ALR:  0x4B
//   - ARR:  0x6B
//   - illegal SBC: 0xEB
//   - DCP, ISB, SLO, RLA, SRE, RRA (one variant each as a sanity probe)
//
// Usage: node test/cpu-test.js

import { CPU } from '../src/cpu.js';

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

const hex2 = v => v.toString(16).toUpperCase().padStart(2, '0');
const hex4 = v => v.toString(16).toUpperCase().padStart(4, '0');

class FlatMemory {
  constructor() { this.ram = new Uint8Array(0x10000); }
  read(a) { return this.ram[a & 0xFFFF]; }
  write(a, v) { this.ram[a & 0xFFFF] = v & 0xFF; }
}

// Run a small program at $0400 until PC reaches `stopPc` at an instruction
// boundary, then return the cpu/mem so the caller can inspect state.
// Pre-state can be set via `init` callback before execution.
function run(program, stopPc, init) {
  const mem = new FlatMemory();
  for (let i = 0; i < program.length; i++) mem.ram[0x0400 + i] = program[i];
  const cpu = new CPU(mem);
  cpu.pc = 0x0400; cpu.sp = 0xFF; cpu.setP(0x24);
  cpu.a = 0; cpu.x = 0; cpu.y = 0;
  if (init) init(cpu, mem);

  for (let i = 0; i < 1000; i++) {
    cpu.clock();
    if (cpu.atInstructionBoundary() && cpu.pc === stopPc) return { cpu, mem };
  }
  console.error(`FAIL: program never reached stopPc=$${hex4(stopPc)} (final PC=$${hex4(cpu.pc)})`);
  process.exit(1);
}

// ── Multi-byte NOPs (PC-advancement check) ────────────────────────────────
// Each NOP is followed by 0xE8 (INX). If the NOP advances PC correctly past
// its operand byte(s), INX is never executed and X stays 0. If PC is off by
// one, INX runs and X becomes 1.

function checkSkbAdvances2(opcode, name) {
  // op opnd 86 00 → STX $00 — expect X stored as 0.
  const { cpu, mem } = run(
    [opcode, 0xE8, 0x86, 0x00, 0x00],
    0x0404,
  );
  assert(cpu.x === 0, `${name}: X must be 0 (NOP must skip operand, not execute it as INX)`);
  assert(mem.ram[0] === 0, `${name}: mem[$00] must be 0`);
  console.log(`ok  - 0x${hex2(opcode)} ${name}: skips operand correctly`);
}

function checkSkb3Advances3(opcode, name) {
  // op lo hi 86 00 → STX $00 — expect X stored as 0.
  const { cpu, mem } = run(
    [opcode, 0xE8, 0xE8, 0x86, 0x00, 0x00],
    0x0405,
  );
  assert(cpu.x === 0, `${name}: X must be 0 (3-byte NOP must skip both operand bytes)`);
  assert(mem.ram[0] === 0, `${name}: mem[$00] must be 0`);
  console.log(`ok  - 0x${hex2(opcode)} ${name}: skips both operand bytes correctly`);
}

// 2-byte NOPs (immediate)
checkSkbAdvances2(0x80, 'NOP #imm');
checkSkbAdvances2(0x82, 'NOP #imm');
checkSkbAdvances2(0x89, 'NOP #imm');
checkSkbAdvances2(0xC2, 'NOP #imm');
checkSkbAdvances2(0xE2, 'NOP #imm');
// 2-byte NOPs (zero-page)
checkSkbAdvances2(0x04, 'NOP zp');
checkSkbAdvances2(0x44, 'NOP zp');
checkSkbAdvances2(0x64, 'NOP zp');
// 2-byte NOPs (zero-page, X)
checkSkbAdvances2(0x14, 'NOP zp,X');
checkSkbAdvances2(0x34, 'NOP zp,X');
checkSkbAdvances2(0x54, 'NOP zp,X');
checkSkbAdvances2(0x74, 'NOP zp,X');
checkSkbAdvances2(0xD4, 'NOP zp,X');
checkSkbAdvances2(0xF4, 'NOP zp,X');
// 3-byte NOPs (absolute and absolute,X)
checkSkb3Advances3(0x0C, 'NOP abs');
checkSkb3Advances3(0x1C, 'NOP abs,X');
checkSkb3Advances3(0x3C, 'NOP abs,X');
checkSkb3Advances3(0x5C, 'NOP abs,X');
checkSkb3Advances3(0x7C, 'NOP abs,X');
checkSkb3Advances3(0xDC, 'NOP abs,X');
checkSkb3Advances3(0xFC, 'NOP abs,X');

// ── LAX family (load A and X together, set N/Z) ───────────────────────────
{
  // LAX zp ($A7): read $80 (=$42) into A and X.
  const { cpu } = run([0xA7, 0x80, 0x00], 0x0402, (_, mem) => {
    mem.ram[0x80] = 0x42;
  });
  assert(cpu.a === 0x42 && cpu.x === 0x42, 'LAX zp loads both A and X');
  assert(cpu.Z === 0 && cpu.N === 0, 'LAX zp sets Z/N from value');
  console.log('ok  - 0xA7 LAX zp: loads A=X and sets flags');
}

{
  // LAX zp ($A7) with negative value sets N.
  const { cpu } = run([0xA7, 0x80, 0x00], 0x0402, (_, mem) => {
    mem.ram[0x80] = 0x80;
  });
  assert(cpu.a === 0x80 && cpu.x === 0x80, 'LAX zp loads negative value');
  assert(cpu.N === 1 && cpu.Z === 0, 'LAX zp sets N for high-bit value');
  console.log('ok  - 0xA7 LAX zp: N set for $80');
}

{
  // LAX zp ($A7) with zero sets Z.
  const { cpu } = run([0xA7, 0x80, 0x00], 0x0402, (_, mem) => {
    mem.ram[0x80] = 0x00;
  });
  assert(cpu.a === 0 && cpu.x === 0 && cpu.Z === 1 && cpu.N === 0, 'LAX zp sets Z for 0');
  console.log('ok  - 0xA7 LAX zp: Z set for $00');
}

{
  // LAX (indirect),Y ($B3) without page cross.
  // Pointer at $80 → $1234, Y=$05, mem[$1239] = $7E.
  const { cpu } = run([0xA0, 0x05, 0xB3, 0x80, 0x00], 0x0404, (_, mem) => {
    mem.ram[0x80] = 0x34; mem.ram[0x81] = 0x12;
    mem.ram[0x1239] = 0x7E;
  });
  assert(cpu.a === 0x7E && cpu.x === 0x7E, 'LAX (zp),Y loads A=X');
  assert(cpu.N === 0 && cpu.Z === 0, 'LAX (zp),Y flags');
  console.log('ok  - 0xB3 LAX (zp),Y: loads A=X without page cross');
}

{
  // LAX (indirect),Y with page cross.
  // Pointer at $80 → $12FF, Y=$01 → effective $1300.
  const { cpu } = run([0xA0, 0x01, 0xB3, 0x80, 0x00], 0x0404, (_, mem) => {
    mem.ram[0x80] = 0xFF; mem.ram[0x81] = 0x12;
    mem.ram[0x1300] = 0x33;
  });
  assert(cpu.a === 0x33 && cpu.x === 0x33, 'LAX (zp),Y page-cross loads correct value');
  console.log('ok  - 0xB3 LAX (zp),Y: page-cross load is correct');
}

{
  // LAX (indirect,X) ($A3): X=$04, pointer at $84 → $5000, mem[$5000] = $11.
  const { cpu } = run([0xA2, 0x04, 0xA3, 0x80, 0x00], 0x0404, (_, mem) => {
    mem.ram[0x84] = 0x00; mem.ram[0x85] = 0x50;
    mem.ram[0x5000] = 0x11;
  });
  assert(cpu.a === 0x11 && cpu.x === 0x11, 'LAX (zp,X) loads A=X');
  console.log('ok  - 0xA3 LAX (zp,X): loads A=X correctly');
}

{
  // LAX abs ($AF).
  const { cpu } = run([0xAF, 0x34, 0x12, 0x00], 0x0403, (_, mem) => {
    mem.ram[0x1234] = 0x55;
  });
  assert(cpu.a === 0x55 && cpu.x === 0x55, 'LAX abs loads A=X');
  console.log('ok  - 0xAF LAX abs: loads A=X correctly');
}

{
  // LAX zp,Y ($B7): Y=$03, mem[$83] = $99.
  const { cpu } = run([0xA0, 0x03, 0xB7, 0x80, 0x00], 0x0404, (_, mem) => {
    mem.ram[0x83] = 0x99;
  });
  assert(cpu.a === 0x99 && cpu.x === 0x99, 'LAX zp,Y loads A=X');
  console.log('ok  - 0xB7 LAX zp,Y: loads A=X correctly');
}

{
  // LAX abs,Y ($BF).
  const { cpu } = run([0xA0, 0x10, 0xBF, 0x00, 0x12, 0x00], 0x0405, (_, mem) => {
    mem.ram[0x1210] = 0xC4;
  });
  assert(cpu.a === 0xC4 && cpu.x === 0xC4 && cpu.N === 1, 'LAX abs,Y loads negative');
  console.log('ok  - 0xBF LAX abs,Y: loads A=X with N set');
}

// ── SAX family (store A AND X, no flag change) ────────────────────────────
{
  // SAX zp ($87): A=$F0, X=$33, store A&X = $30 at $80.
  const { mem } = run([0xA9, 0xF0, 0xA2, 0x33, 0x87, 0x80, 0x00], 0x0406);
  assert(mem.ram[0x80] === 0x30, 'SAX zp stores A AND X');
  console.log('ok  - 0x87 SAX zp: stores A AND X');
}

{
  // SAX abs ($8F).
  const { mem } = run([0xA9, 0xFF, 0xA2, 0x0F, 0x8F, 0x00, 0x30, 0x00], 0x0407);
  assert(mem.ram[0x3000] === 0x0F, 'SAX abs stores A AND X');
  console.log('ok  - 0x8F SAX abs: stores A AND X');
}

{
  // SAX (zp,X) ($83): X=$04, ptr at $84 → $4000, store A&X = $05.
  const { mem } = run([0xA2, 0x04, 0xA9, 0x55, 0x83, 0x80, 0x00], 0x0406, (_, m) => {
    m.ram[0x84] = 0x00; m.ram[0x85] = 0x40;
  });
  // Note: A=$55 set after X=$04 — A&X = $04 actually (since now X=4 and A=$55).
  // 0x55 & 0x04 = 0x04
  assert(mem.ram[0x4000] === (0x55 & 0x04), 'SAX (zp,X) stores A AND X');
  console.log('ok  - 0x83 SAX (zp,X): stores A AND X');
}

{
  // SAX zp,Y ($97): Y=$05, mem[$85] gets A&X.
  const { mem } = run([0xA0, 0x05, 0xA9, 0xAA, 0xA2, 0xCC, 0x97, 0x80, 0x00], 0x0408);
  assert(mem.ram[0x85] === (0xAA & 0xCC), 'SAX zp,Y stores A AND X');
  console.log('ok  - 0x97 SAX zp,Y: stores A AND X');
}

// ── 0xCB AXS/SBX (X = (A & X) - imm; sets N/Z/C; V untouched) ─────────────
{
  // (A=$F0) & (X=$0F) = $00; $00 - $00 = $00; C=1 (no borrow).
  const { cpu } = run([0xA9, 0xF0, 0xA2, 0x0F, 0xCB, 0x00, 0x00], 0x0406);
  assert(cpu.x === 0x00, 'AXS: X is (A&X)-imm');
  assert(cpu.Z === 1 && cpu.N === 0, 'AXS sets Z=1 for zero result');
  assert(cpu.C === 1, 'AXS C=1 when (A&X) >= imm');
  console.log('ok  - 0xCB AXS: zero result, C=1');
}

{
  // A=$FF, X=$F0 → A&X = $F0; $F0 - $20 = $D0; N=1, Z=0, C=1.
  const { cpu } = run([0xA9, 0xFF, 0xA2, 0xF0, 0xCB, 0x20, 0x00], 0x0406);
  assert(cpu.x === 0xD0, 'AXS: X = (A&X) - imm');
  assert(cpu.N === 1 && cpu.Z === 0 && cpu.C === 1, 'AXS flags for $D0 result');
  console.log('ok  - 0xCB AXS: positive result with N=1, C=1');
}

{
  // A=$0F, X=$0F → A&X = $0F; $0F - $20 = -$11 (= $EF in 8-bit); C=0 (borrow).
  const { cpu } = run([0xA9, 0x0F, 0xA2, 0x0F, 0xCB, 0x20, 0x00], 0x0406);
  assert(cpu.x === 0xEF, 'AXS: underflow wraps to $EF');
  assert(cpu.N === 1 && cpu.Z === 0 && cpu.C === 0, 'AXS C=0 when (A&X) < imm');
  console.log('ok  - 0xCB AXS: underflow, C=0');
}

{
  // V flag untouched: pre-set V=1 and confirm AXS doesn't clear it.
  const { cpu } = run([0x38, 0xA9, 0x40, 0x69, 0x40, 0xA2, 0xFF, 0xCB, 0x01, 0x00], 0x0409);
  // SEC; LDA #$40; ADC #$40 (sets V=1, A becomes $81); LDX #$FF; SBX #$01.
  assert(cpu.V === 1, 'AXS does not modify V');
  console.log('ok  - 0xCB AXS: leaves V untouched');
}

// ── ANC ($0B, $2B): AND #imm, then C = N (bit 7 of result) ────────────────
{
  const { cpu } = run([0xA9, 0xFF, 0x0B, 0x80, 0x00], 0x0404);
  assert(cpu.a === 0x80 && cpu.N === 1 && cpu.Z === 0 && cpu.C === 1, 'ANC sets C=N for high-bit result');
  console.log('ok  - 0x0B ANC: C=N=1 when bit 7 of result is set');
}
{
  const { cpu } = run([0xA9, 0x0F, 0x2B, 0x0F, 0x00], 0x0404);
  assert(cpu.a === 0x0F && cpu.N === 0 && cpu.C === 0, 'ANC C=0 when bit 7 clear');
  console.log('ok  - 0x2B ANC: C=0 when bit 7 of result is clear');
}

// ── ALR/ASR ($4B): A AND #imm, then LSR A ─────────────────────────────────
{
  // A=$FF AND $03 = $03, then LSR → $01, C=1 (bit-0 was 1).
  const { cpu } = run([0xA9, 0xFF, 0x4B, 0x03, 0x00], 0x0404);
  assert(cpu.a === 0x01 && cpu.C === 1 && cpu.Z === 0 && cpu.N === 0, 'ALR result and flags');
  console.log('ok  - 0x4B ALR: AND #imm then LSR A');
}

// ── ARR ($6B): A AND #imm, ROR A; C = bit 6 of result; V = bit5 ^ bit6 ───
{
  // A=$FF AND $FF = $FF; ROR with C=0 → $7F (or $FF if C-in=1). After:
  // C = bit6 of $7F = 1, V = bit5^bit6 = 1^1 = 0.
  const { cpu } = run([0xA9, 0xFF, 0x18, 0x6B, 0xFF, 0x00], 0x0405);
  // CLC → C=0; ROR of $FF with C-in=0 yields $7F (bit7 ← C-in, bit0 lost).
  assert(cpu.a === 0x7F, 'ARR: A=$7F after ARR with carry-in 0');
  assert(cpu.C === 1, 'ARR: C = bit 6 of result');
  assert(cpu.V === 0, 'ARR: V = bit5 XOR bit6');
  console.log('ok  - 0x6B ARR: result, C, V correct (carry-in=0 case)');
}
{
  // Carry-in path: SEC; LDA #$FF; ARR #$FF → ROR with C-in=1 yields $FF.
  // bit6=1, bit5=1 → C=1, V=0.
  const { cpu } = run([0x38, 0xA9, 0xFF, 0x6B, 0xFF, 0x00], 0x0405);
  assert(cpu.a === 0xFF, 'ARR: $FF preserved with C-in=1');
  assert(cpu.C === 1 && cpu.V === 0, 'ARR: C=bit6, V=bit5^bit6');
  console.log('ok  - 0x6B ARR: carry-in=1 case');
}

// ── illegal SBC ($EB): identical to legal SBC #imm ────────────────────────
{
  // A=$50, SEC, SBC #$10 → A=$40, C=1.
  const { cpu } = run([0xA9, 0x50, 0x38, 0xEB, 0x10, 0x00], 0x0405);
  assert(cpu.a === 0x40 && cpu.C === 1 && cpu.Z === 0 && cpu.N === 0,
    '0xEB SBC behaves as legal SBC');
  console.log('ok  - 0xEB SBC #imm: behaves as legal SBC');
}

// ── DCP ($C7): DEC zp, then CMP A with new value ──────────────────────────
{
  // mem[$80]=$05; LDA #$04; DCP $80 → mem[$80]=$04, CMP A with $04 → Z=1, C=1.
  const { cpu, mem } = run([0xA9, 0x04, 0xC7, 0x80, 0x00], 0x0404, (_, m) => {
    m.ram[0x80] = 0x05;
  });
  assert(mem.ram[0x80] === 0x04, 'DCP zp decremented memory');
  assert(cpu.Z === 1 && cpu.C === 1, 'DCP zp CMP flags');
  console.log('ok  - 0xC7 DCP zp: decrement memory then CMP');
}

// ── ISB/ISC ($E7): INC zp, then SBC ───────────────────────────────────────
{
  // mem[$80]=$04; LDA #$10; SEC; ISB $80 → mem[$80]=$05, A = $10 - $05 = $0B.
  const { cpu, mem } = run([0xA9, 0x10, 0x38, 0xE7, 0x80, 0x00], 0x0405, (_, m) => {
    m.ram[0x80] = 0x04;
  });
  assert(mem.ram[0x80] === 0x05, 'ISB zp incremented memory');
  assert(cpu.a === 0x0B && cpu.C === 1, 'ISB zp SBC result correct');
  console.log('ok  - 0xE7 ISB zp: increment then SBC');
}

// ── SLO ($07): ASL zp, then ORA ───────────────────────────────────────────
{
  // mem[$80]=$40; LDA #$01; SLO $80 → ASL: mem=$80, C=0, then ORA A|=$80 → $81.
  const { cpu, mem } = run([0xA9, 0x01, 0x07, 0x80, 0x00], 0x0404, (_, m) => {
    m.ram[0x80] = 0x40;
  });
  assert(mem.ram[0x80] === 0x80, 'SLO zp shifted memory');
  assert(cpu.a === 0x81 && cpu.N === 1, 'SLO zp ORA result');
  console.log('ok  - 0x07 SLO zp: ASL then ORA');
}

// ── RLA ($27): ROL zp, then AND ───────────────────────────────────────────
{
  // mem[$80]=$01, CLC; LDA #$03; RLA $80 → ROL: mem=$02, C=0, AND A&=$02 → $02.
  const { cpu, mem } = run([0x18, 0xA9, 0x03, 0x27, 0x80, 0x00], 0x0405, (_, m) => {
    m.ram[0x80] = 0x01;
  });
  assert(mem.ram[0x80] === 0x02, 'RLA zp rotated memory');
  assert(cpu.a === 0x02, 'RLA zp AND result');
  console.log('ok  - 0x27 RLA zp: ROL then AND');
}

// ── SRE ($47): LSR zp, then EOR ───────────────────────────────────────────
{
  // mem[$80]=$03; LDA #$FF; SRE $80 → LSR: mem=$01, C=1, EOR A^=$01 → $FE.
  const { cpu, mem } = run([0xA9, 0xFF, 0x47, 0x80, 0x00], 0x0404, (_, m) => {
    m.ram[0x80] = 0x03;
  });
  assert(mem.ram[0x80] === 0x01, 'SRE zp shifted memory');
  assert(cpu.a === 0xFE && cpu.C === 1, 'SRE zp EOR result and C');
  console.log('ok  - 0x47 SRE zp: LSR then EOR');
}

// ── RRA ($67): ROR zp, then ADC ───────────────────────────────────────────
{
  // mem[$80]=$02, CLC; LDA #$10; RRA $80 → ROR: mem=$01, C=0, ADC A+=$01 → $11.
  const { cpu, mem } = run([0x18, 0xA9, 0x10, 0x67, 0x80, 0x00], 0x0405, (_, m) => {
    m.ram[0x80] = 0x02;
  });
  assert(mem.ram[0x80] === 0x01, 'RRA zp rotated memory');
  assert(cpu.a === 0x11, 'RRA zp ADC result');
  console.log('ok  - 0x67 RRA zp: ROR then ADC');
}

// 1-byte NOPs
{
  const { cpu } = run([0x1A, 0x3A, 0xDA, 0x00], 0x0403);
  assert(cpu.pc === 0x0403, '1-byte NOPs advance PC by 1');
  console.log('ok  - 1-byte NOPs: advance PC correctly');
}

// ── LAS ($BB): A = X = S = S & mem ────────────────────────────────────────
{
  const { cpu } = run([0xA2, 0xFF, 0x9A, 0xBB, 0x00, 0x12, 0x00], 0x0406, (_, mem) => {
    // LDX #$FF; TXS; LAS $1200,Y (Y=0)
    mem.ram[0x1200] = 0xAA;
  });
  // S=$FF, mem=$AA -> S & mem = $AA. A=X=S=$AA.
  assert(cpu.sp === 0xAA && cpu.a === 0xAA && cpu.x === 0xAA, 'LAS loads A=X=S');
  assert(cpu.N === 1 && cpu.Z === 0, 'LAS sets Z/N flags');
  console.log('ok  - 0xBB LAS: loads A=X=S correctly');
}

// ── ANE/XAA ($8B): A = (A | CONST) & X & imm, VICE CONST=$EF ───────────────
// Unstable opcode; see cpu-lax-imm-magic-constant-spec-test.js for the full
// magic-constant coverage (ANE $EF vs LXA $EE, both verified against VICE).
{
  const { cpu } = run([0xA2, 0xF0, 0x8B, 0x0F, 0x00], 0x0404);
  // A=0 (init); LDX #$F0; XAA #$0F -> (0|$EF)&$F0&$0F = $00.
  assert(cpu.a === 0x00 && cpu.Z === 1, 'ANE performs A = (A|$EF) & X & imm');
  console.log('ok  - 0x8B ANE/XAA: A = (A|$EF) & X & imm');
}

// ── PC sanity for AXS/LAX-imm: confirm next instruction is at the right PC─
{
  // After 0xCB (2-byte), PC should be at op+2.
  const { cpu } = run([0xCB, 0x00, 0x00], 0x0402);
  assert(cpu.pc === 0x0402, '0xCB AXS advances PC by 2');
  console.log('ok  - 0xCB AXS: advances PC by 2');
}

// ── Hardware Timing & Double IRQ Stabilization ────────────────────────────
// Demos rely on exactly 7 cycles for IRQ vectoring and 2 cycles for
// register increments/decrements to lock the cycle-stealing phase.

function testInstructionCycles(opcode, name, expectedCycles) {
  const mem = new FlatMemory();
  mem.ram[0x0400] = opcode;
  mem.ram[0x0401] = 0xEA; // NOP
  const cpu = new CPU(mem);
  cpu.pc = 0x0400;

  let cycles = 0;
  while (cycles < 10) {
    cpu.clock();
    cycles++;
    if (cpu.atInstructionBoundary()) break;
  }
  assert(cycles === expectedCycles, `${name} must take exactly ${expectedCycles} cycles, took ${cycles}`);
  console.log(`ok  - 0x${hex2(opcode)} ${name}: exactly ${expectedCycles} cycles via micro-ops`);
}

testInstructionCycles(0xCA, 'DEX', 2);
testInstructionCycles(0x88, 'DEY', 2);
testInstructionCycles(0xC8, 'INY', 2);
testInstructionCycles(0xE8, 'INX', 2);

{
  const mem = new FlatMemory();
  const cpu = new CPU(mem);
  cpu.pc = 0x0400;
  cpu.sp = 0xFF;

  // Set standard IRQ vector to $1234
  mem.ram[0xFFFE] = 0x34;
  mem.ram[0xFFFF] = 0x12;

  // Force the CPU to queue the interrupt sequence
  cpu._queueInterruptMicroOps(0xFFFE, false);

  let cycles = 0;
  while (cycles < 15) {
    cpu.clock();
    cycles++;
    if (cpu.atInstructionBoundary()) break;
  }

  assert(cycles === 7, `Hardware interrupt vectoring must take exactly 7 cycles (Double IRQ expects 7), took ${cycles}`);
  assert(cpu.pc === 0x1234, `Interrupt must vector to $1234, went to $${hex4(cpu.pc)}`);
  console.log('ok  - Hardware interrupt vectoring takes exactly 7 cycles');
}

// ── Double IRQ Stabilization Suspects ──────────────────────────────────
// If DEX/DEY fell back to 1-cycle execution earlier, these other common
// raster-stabilization instructions might be missing from the micro-op 
// queue too, or have incorrect branch penalty timings!

function testStabilizationCycles(opcode, arg1, arg2, initCpu, expectedCycles, name) {
  const mem = new FlatMemory();
  mem.ram[0x0400] = opcode;
  if (arg1 !== undefined) mem.ram[0x0401] = arg1;
  if (arg2 !== undefined) mem.ram[0x0402] = arg2;

  const cpu = new CPU(mem);
  cpu.pc = 0x0400;
  if (initCpu) initCpu(cpu);

  let cycles = 0;
  while (cycles < 15) {
    cpu.clock();
    cycles++;
    if (cpu.atInstructionBoundary()) break;
  }
  assert(cycles === expectedCycles, `${name} must take exactly ${expectedCycles} cycles, took ${cycles}`);
  console.log(`ok  - ${name}: exactly ${expectedCycles} cycles`);
}

// Register transfers and standard padding
testStabilizationCycles(0xEA, undefined, undefined, null, 2, 'NOP (0xEA)');
testStabilizationCycles(0x9A, undefined, undefined, null, 2, 'TXS (0x9A)');
testStabilizationCycles(0xAA, undefined, undefined, null, 2, 'TAX (0xAA)');
testStabilizationCycles(0x8A, undefined, undefined, null, 2, 'TXA (0x8A)');

// Cycle-burning memory reads
testStabilizationCycles(0x24, 0x00, undefined, null, 3, 'BIT zp (0x24)');
testStabilizationCycles(0x2C, 0x00, 0x00, null, 4, 'BIT abs (0x2C)');
testStabilizationCycles(0x8D, 0x20, 0xD0, null, 4, 'STA abs (0x8D)');

// Branch timing (CRITICAL FOR STABILIZATION)
// Z=1 (Not Zero) -> BNE is not taken -> 2 cycles
testStabilizationCycles(0xD0, 0x05, undefined, c => c.setP(0x02), 2, 'BNE not taken');
// Z=0 (Zero) -> BNE is taken (same page) -> 3 cycles
testStabilizationCycles(0xD0, 0x05, undefined, c => c.setP(0x00), 3, 'BNE taken (same page)');

// RTI timing (Must be exactly 6 cycles)
{
  const mem = new FlatMemory();
  const cpu = new CPU(mem);
  mem.ram[0x0400] = 0x40; // RTI
  cpu.pc = 0x0400;

  // Set up the stack so RTI has valid data to pull
  cpu.sp = 0xFD;
  mem.ram[0x01FE] = 0x24; // P
  mem.ram[0x01FF] = 0x34; // PCL
  mem.ram[0x0100] = 0x12; // PCH (stack wraps at page boundary)

  let cycles = 0;
  while (cycles < 15) {
    cpu.clock();
    cycles++;
    if (cpu.atInstructionBoundary()) break;
  }
  assert(cycles === 6, `RTI must take exactly 6 cycles, took ${cycles}`);
  console.log(`ok  - RTI (0x40): exactly 6 cycles`);
}

// ── Read-Modify-Write (RMW) Dummy Write Verification ──────────────────────
// RMW instructions (INC, DEC, ASL, LSR, ROL, ROR) must perform a dummy write 
// of the original value on the 5th cycle before writing the modified value 
// on the 6th cycle. This clears $D019 one cycle earlier than a simple STA!

{
  const mem = new FlatMemory();

  // Intercept writes to $D019 to track exact cycle behavior
  let d019Writes = [];
  mem.write = function (a, v) {
    if (a === 0xD019) d019Writes.push(v);
    this.ram[a & 0xFFFF] = v & 0xFF;
  };

  mem.ram[0xD019] = 0x81; // Simulate pending raster IRQ (bit 7 and bit 0 high)

  const cpu = new CPU(mem);
  mem.ram[0x0400] = 0xEE; // INC abs
  mem.ram[0x0401] = 0x19;
  mem.ram[0x0402] = 0xD0;
  cpu.pc = 0x0400;

  let cycles = 0;
  while (cycles < 10) {
    cpu.clock();
    cycles++;
    if (cpu.atInstructionBoundary()) break;
  }

  assert(cycles === 6, `INC abs must take 6 cycles, took ${cycles}`);
  assert(d019Writes.length === 2, `INC abs must perform exactly 2 writes (dummy + real), but did ${d019Writes.length}`);
  assert(d019Writes[0] === 0x81, `The first (dummy) write must be the original value (0x81), but was 0x${hex2(d019Writes[0] || 0)}`);
  assert(d019Writes[1] === 0x82, `The second (real) write must be the incremented value (0x82), but was 0x${hex2(d019Writes[1] || 0)}`);

  console.log('ok  - RMW instructions perform the cycle 5 dummy write');
}

// ── Branch Page Boundary Penalty ───────────────────────────────────────
{
  const mem = new FlatMemory();
  const cpu = new CPU(mem);

  // Place BNE at $04FD. 
  // Base PC after reading operand is $04FF. 
  // Branching +5 bytes forward lands at $0504 (Crosses from page $04 to $05)
  mem.ram[0x04FD] = 0xD0;
  mem.ram[0x04FE] = 0x05;
  cpu.pc = 0x04FD;
  cpu.setP(0x00); // Z=0 (Branch taken)

  let cycles = 0;
  while (cycles < 10) {
    cpu.clock();
    cycles++;
    if (cpu.atInstructionBoundary()) break;
  }

  assert(cycles === 4, `Branch taken across page boundary must take exactly 4 cycles, took ${cycles}`);
  assert(cpu.pc === 0x0504, `Branch target should be $0504, was $${hex4(cpu.pc)}`);
  console.log('ok  - Branch taken across page boundary takes 4 cycles');
}

// ── IRQ flow ────────────────────────────────────────────────────────────────

// IRQ asserted with I=0 should enter the handler. Spec: handler entry pushes
// PCH, PCL, P (with B=0), sets I=1, jumps to vector at $FFFE.
{
  const mem = new FlatMemory();
  const cpu = new CPU(mem);
  cpu.pc = 0x0500; cpu.sp = 0xFF;
  cpu.setP(0x20);                     // I=0
  mem.ram[0x0500] = 0xEA;             // NOP
  mem.ram[0xFFFE] = 0x00; mem.ram[0xFFFF] = 0xC0;  // vector → $C000

  cpu.setIrqLine(true);
  // Step until we reach the handler (vector taken).
  for (let i = 0; i < 20; i++) {
    cpu.clock();
    if (cpu.atInstructionBoundary() && cpu.pc === 0xC000) break;
  }
  assert(cpu.pc === 0xC000, `IRQ handler entered (PC=$${hex4(cpu.pc)})`);
  assert(cpu.I === 1, 'IRQ entry sets I flag');

  // Stack should hold pushed P (with B=0) at sp+1, PCL at sp+2, PCH at sp+3.
  const pushedP = mem.ram[0x0100 + ((cpu.sp + 1) & 0xFF)];
  assert((pushedP & 0x10) === 0, 'IRQ pushes P with B=0 (BRK pushes B=1)');
  console.log('ok  - IRQ entry pushes P with B=0, sets I=1, vectors to $FFFE');
}

// IRQ ignored when I=1. The CPU should never enter the handler.
{
  const mem = new FlatMemory();
  // Fill RAM with NOPs so the CPU doesn't hit a stray BRK ($00 default).
  for (let a = 0; a < 0x10000; a++) mem.ram[a] = 0xEA;
  mem.ram[0xFFFE] = 0x00; mem.ram[0xFFFF] = 0xC0;
  const cpu = new CPU(mem);
  cpu.pc = 0x0500; cpu.sp = 0xFF;
  cpu.setP(0x24);                     // I=1

  cpu.setIrqLine(true);
  for (let i = 0; i < 30; i++) cpu.clock();
  assert(cpu.I === 1, 'I flag remained 1');
  assert(cpu.pc < 0xC000,
    `IRQ must NOT fire while I=1; PC went to $${hex4(cpu.pc)}`);
  assert(cpu.pc >= 0x0500,
    'CPU stayed in main code (executing NOPs)');
  console.log('ok  - IRQ stays masked when I=1');
}

// PLP shadow: pulling P from stack with I going 1→0 leaves the next
// instruction interrupt-protected (one-instruction shadow). Per Bruce
// Clark §I-flag-delay, all four I-modifying instructions (CLI, SEI, PLP,
// RTI) exhibit this shadow when I transitions 1→0. The shadow test below
// uses PLP because it's the easiest to set up; CLI/RTI behave identically
// (verified in test/irq-sampling-spec-test.js).
{
  const mem = new FlatMemory();
  for (let a = 0; a < 0x10000; a++) mem.ram[a] = 0xEA;
  const cpu = new CPU(mem);
  cpu.pc = 0x0500; cpu.sp = 0xFE;
  cpu.setP(0x24);                     // I=1
  mem.ram[0x0500] = 0x28;             // PLP — pulls $20 (I=0)
  mem.ram[0x0501] = 0xE8;             // INX (shadowed)
  mem.ram[0x01FF] = 0x20;             // pre-stack: P with I=0
  mem.ram[0xFFFE] = 0x00; mem.ram[0xFFFF] = 0xC0;

  cpu.setIrqLine(true);
  cpu.x = 0;
  // PLP is 4 cycles. After PLP, I=0; the unmask reaches the poll one
  // instruction late (verified behaviorally by the INX-then-vector below).
  for (let i = 0; i < 4; i++) cpu.clock();
  assert(cpu.atInstructionBoundary() && cpu.pc === 0x0501,
    `PLP completed (PC=$${hex4(cpu.pc)})`);
  assert(cpu.I === 0, 'PLP set I=0');

  cpu.clock(); cpu.clock();           // INX — IRQ shadowed
  assert(cpu.atInstructionBoundary() && cpu.pc === 0x0502,
    `INX completed in PLP shadow (PC=$${hex4(cpu.pc)})`);
  assert(cpu.x === 1, 'INX executed under shadow');

  for (let i = 0; i < 12; i++) {
    cpu.clock();
    if (cpu.pc === 0xC000) break;
  }
  assert(cpu.pc === 0xC000, `IRQ fired after PLP shadow (PC=$${hex4(cpu.pc)})`);
  console.log('ok  - PLP shadow: next instruction uninterruptible (CLI/PLP/RTI all shadow per spec)');
}

// RTI restores P and PC from stack. After RTI, the I flag is whatever was
// pushed (so an IRQ handler that returns can be re-interrupted if I was 0).
{
  const mem = new FlatMemory();
  const cpu = new CPU(mem);
  cpu.pc = 0xC000; cpu.sp = 0xFC;     // simulate post-IRQ-entry: 3 bytes pushed
  cpu.setP(0x24);                     // I=1 inside handler

  // Stack contents: $01FD = P (with I=0 to test restore), $01FE = PCL, $01FF = PCH.
  mem.ram[0x01FD] = 0x20;             // P with I=0
  mem.ram[0x01FE] = 0x42;             // PCL
  mem.ram[0x01FF] = 0x05;             // PCH → return to $0542

  mem.ram[0xC000] = 0x40;             // RTI
  cpu.clock(); cpu.clock(); cpu.clock();
  cpu.clock(); cpu.clock(); cpu.clock();
  assert(cpu.atInstructionBoundary(), 'RTI completed in 6 cycles');
  assert(cpu.pc === 0x0542, `RTI restored PC to $0542, got $${hex4(cpu.pc)}`);
  assert(cpu.I === 0, 'RTI restored I=0 from pushed P');
  console.log('ok  - RTI restores PC and P (including I flag)');
}

// NMI flow: vector at $FFFA/$FFFB, ignores I flag, edge-triggered.
{
  const mem = new FlatMemory();
  const cpu = new CPU(mem);
  cpu.pc = 0x0500; cpu.sp = 0xFF;
  cpu.setP(0x24);                     // I=1 — NMI ignores this
  mem.ram[0x0500] = 0xEA;             // NOP
  mem.ram[0xFFFA] = 0x00; mem.ram[0xFFFB] = 0xD0;  // NMI vector → $D000

  cpu.setNmiLine(true);
  cpu.sampledNmiEdge = true;          // edge sampled (symmetric with sampledIrq)
  for (let i = 0; i < 20; i++) {
    cpu.clock();
    if (cpu.atInstructionBoundary() && cpu.pc === 0xD000) break;
  }
  assert(cpu.pc === 0xD000, `NMI fires despite I=1 (PC=$${hex4(cpu.pc)})`);
  console.log('ok  - NMI fires regardless of I flag, vectors to $FFFA');
}

// NMI is edge-triggered: a continuously-asserted NMI line fires only ONCE.
// Once the edge has been consumed, holding NMI low cannot re-trigger.
{
  const mem = new FlatMemory();
  for (let a = 0; a < 0x10000; a++) mem.ram[a] = 0xEA;
  mem.ram[0xFFFA] = 0x00; mem.ram[0xFFFB] = 0xD0;
  mem.ram[0xD000] = 0x40;             // RTI in handler

  const cpu = new CPU(mem);
  cpu.pc = 0x0500; cpu.sp = 0xFF;
  cpu.setP(0x20);                     // I=0 (irrelevant for NMI)

  // Trigger NMI: consume the edge (handler entered, 7 cycles).
  cpu.setNmiLine(true);
  cpu.sampledNmiEdge = true;          // edge sampled (symmetric with sampledIrq)
  for (let i = 0; i < 8; i++) {
    cpu.clock();
    if (cpu.atInstructionBoundary() && cpu.pc === 0xD000) break;
  }
  assert(cpu.pc === 0xD000, `NMI handler entered (PC=$${hex4(cpu.pc)})`);

  // Run RTI (6 cycles) → return to main code.
  for (let i = 0; i < 7; i++) {
    cpu.clock();
    if (cpu.atInstructionBoundary() && cpu.pc !== 0xD000) break;
  }
  assert(cpu.pc < 0xD000, `RTI returned to main (PC=$${hex4(cpu.pc)})`);

  // NMI line is STILL asserted (we never deasserted it). CPU continues in
  // main code and must NOT re-enter the NMI handler (edge already consumed).
  for (let i = 0; i < 20; i++) cpu.clock();
  assert(cpu.pc !== 0xD000,
    `NMI must not refire on a held line (PC=$${hex4(cpu.pc)})`);
  console.log('ok  - NMI is edge-triggered: holding the line does not refire');
}

console.log('\nAll CPU tests passed.');
