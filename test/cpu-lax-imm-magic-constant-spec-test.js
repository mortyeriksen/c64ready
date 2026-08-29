// LXA ($AB) and ANE ($8B) — unstable-opcode "magic constant" semantics.
//
// Both are unstable NMOS 6502 illegal opcodes that OR the accumulator with a
// chip-and-temperature dependent "magic constant" before masking:
//   LXA ($AB):  A = X = (A | CONST) & imm           CONST = 0xEE
//   ANE ($8B):  A     = (A | CONST) & X & imm        CONST = 0xEF  (X unchanged)
// The two constants are DIFFERENT in VICE's 6510 (0xEE vs 0xEF) — verified by
// probing the VICE monitor directly. Our old impls were A=X=imm (LXA,
// effective 0xFF) and A=X&imm (ANE, no OR term) — neither modelled the
// constant.
//
// This is exercised by the flibug test (VICII/flibug/blackmail-ee.prg): its
// FLI displayer feeds "11"-pixel colours through `lax #<color>` and relies on
// the magic constant — blackmail.asm literally comments
//   "BUG! the following requires bits 0-2 of the magic constant to be set".
// With CONST = 0xEE (bit0 clear) the low bit of those colours is dropped,
// which is exactly what the VICE reference renders. Our old impl was
// A = X = imm (effective CONST = 0xFF, all-1s) which left blackmail-ee 480px
// off across 6 colour bands; CONST = 0xEE makes it pixel-exact.
//
// Usage: node test/cpu-lax-imm-magic-constant-spec-test.js

import { CPU } from '../src/cpu.js';

let passed = 0;
function expect(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
  passed++;
}
function ok(msg) { console.log(`ok  - ${msg}`); }

class FlatMemory {
  constructor() { this.ram = new Uint8Array(0x10000); }
  read(a) { return this.ram[a & 0xFFFF]; }
  write(a, v) { this.ram[a & 0xFFFF] = v & 0xFF; }
}

// Run `program` at $0400 until PC reaches stopPc at an instruction boundary.
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
  console.error(`FAIL: never reached stopPc=$${stopPc.toString(16)} (PC=$${cpu.pc.toString(16)})`);
  process.exit(1);
}

const CONST = 0xEE;
// Reference oracle: the exact formula we claim to implement.
const lxa = (a, imm) => (a | CONST) & imm;

console.log('cpu-lax-imm-magic-constant-spec-test');

// ── 1: A = X = (A | 0xEE) & imm for a spread of A / imm values ────────────
{
  // LDA #aVal ; LXA #imm ; (stop) — A and X must both equal the formula.
  const cases = [
    [0x00, 0xFF], [0xFF, 0xFF], [0x00, 0x01], [0x01, 0x01],
    [0x08, 0x0F], [0x18, 0x0F], [0x78, 0x0F], // the flibug A=$08,$18..$78 set
    [0x11, 0xAA], [0x55, 0x55], [0x80, 0x81], [0x10, 0x11],
  ];
  for (const [aVal, imm] of cases) {
    const { cpu } = run([0xA9, aVal, 0xAB, imm, 0x00], 0x0404);
    const want = lxa(aVal, imm);
    expect(cpu.a === want,
      `LXA #$${imm.toString(16)} with A=$${aVal.toString(16)}: A expected $${want.toString(16)}, got $${cpu.a.toString(16)}`);
    expect(cpu.x === want,
      `LXA: X must equal A ($${want.toString(16)}), got $${cpu.x.toString(16)}`);
  }
  ok('LXA #imm computes A = X = (A | $EE) & imm across A/imm spread');
}

// ── 2: bit 0 of imm is dropped when A bit0 = 0 (the documented flibug "BUG") ─
{
  // A=$08 (bit0 clear), imm=$01 → (A|$EE)&$01 = $EE&$01 = $00. The colour's
  // low bit is lost — this is precisely why blackmail-ee diverged from the
  // all-1s assumption, and why it now matches VICE.
  const { cpu } = run([0xA9, 0x08, 0xAB, 0x01, 0x00], 0x0404);
  expect(cpu.a === 0x00, `bit0 dropped: A=$08, LXA #$01 → $00, got $${cpu.a.toString(16)}`);
  // Contrast: A=$09 (bit0 set) → (A|$EE)&$01 = $01 survives.
  const r2 = run([0xA9, 0x09, 0xAB, 0x01, 0x00], 0x0404);
  expect(r2.cpu.a === 0x01, `bit0 kept when A bit0 set: got $${r2.cpu.a.toString(16)}`);
  ok('magic-constant $EE drops imm bit0 unless A bit0 set (flibug "BUG" reproduced)');
}

// ── 3: bits 1-7 of the magic constant ARE set → those imm bits pass through ─
{
  // CONST=$EE has bits 1-3,5-7 set; only bit0 and bit4 clear. With A=0,
  // (0|$EE)&imm = $EE & imm. Verify against a couple of imm patterns.
  for (const imm of [0xFF, 0x1E, 0xEE, 0x12]) {
    const { cpu } = run([0xA9, 0x00, 0xAB, imm, 0x00], 0x0404);
    expect(cpu.a === ((0xEE) & imm),
      `A=0, LXA #$${imm.toString(16)} → $${(0xEE & imm).toString(16)}, got $${cpu.a.toString(16)}`);
  }
  ok('with A=0, result = $EE & imm (set magic bits pass imm through)');
}

// ── 4: flags reflect the result (N/Z from A), 2-cycle / 2-byte unchanged ──
{
  const { cpu } = run([0xA9, 0x00, 0xAB, 0x20, 0x00], 0x0404); // → $EE&$20 = $20 (bit5 set in $EE)
  expect(cpu.a === 0x20 && cpu.N === 0 && cpu.Z === 0, 'LXA sets N/Z from result (nonzero, +)');
  const r2 = run([0xA9, 0x00, 0xAB, 0x80, 0x00], 0x0404); // → $EE&$80 = $80
  expect(r2.cpu.a === 0x80 && r2.cpu.N === 1, 'LXA sets N for high-bit result');
  const r3 = run([0xA9, 0x08, 0xAB, 0x01, 0x00], 0x0404); // → $00
  expect(r3.cpu.a === 0x00 && r3.cpu.Z === 1, 'LXA sets Z for zero result');
  // PC advanced past the 2-byte instruction (operand not executed).
  expect(r3.cpu.pc === 0x0404, 'LXA #imm is 2 bytes (PC advanced past operand)');
  ok('LXA flags (N/Z) and 2-byte length');
}

// ── 5: ANE/XAA ($8B): A = (A | 0xEF) & X & imm, X unchanged ───────────────
{
  const ANE = 0xEF;
  const ane = (a, x, imm) => (a | ANE) & x & imm;
  // LDA #aVal ; LDX #xVal ; ANE #imm ; (stop)
  const cases = [
    [0x00, 0xFF, 0xFF], [0xFF, 0xFF, 0xFF], [0x00, 0x0F, 0xFF],
    [0x10, 0xFF, 0x0F], [0x01, 0xFF, 0x01], [0x00, 0xFF, 0x01],
    [0x00, 0xFF, 0x10], [0x55, 0xAA, 0xFF], [0x00, 0xFF, 0xEE],
  ];
  for (const [aVal, xVal, imm] of cases) {
    const { cpu } = run([0xA9, aVal, 0xA2, xVal, 0x8B, imm, 0x00], 0x0406);
    const want = ane(aVal, xVal, imm);
    expect(cpu.a === want,
      `ANE A=$${aVal.toString(16)} X=$${xVal.toString(16)} #$${imm.toString(16)}: A expected $${want.toString(16)}, got $${cpu.a.toString(16)}`);
    expect(cpu.x === xVal, `ANE must leave X unchanged ($${xVal.toString(16)}), got $${cpu.x.toString(16)}`);
  }
  // The $EF vs $EE distinction: A=0,X=$FF,#$FF → $EF (would be $EE under LXA's const).
  const r = run([0xA9, 0x00, 0xA2, 0xFF, 0x8B, 0xFF, 0x00], 0x0406);
  expect(r.cpu.a === 0xEF, `ANE const is $EF not $EE: got $${r.cpu.a.toString(16)}`);
  ok('ANE #imm computes A = (A | $EF) & X & imm (X unchanged); const $EF ≠ LXA $EE');
}

console.log(`\nPASS (${passed} assertions)`);
