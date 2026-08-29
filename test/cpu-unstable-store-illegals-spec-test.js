// Unstable store-illegals spec test: SHA/AHX ($93,$9F), SHX ($9E),
// SHY ($9C), TAS/SHS ($9B).
//
// Before this was implemented these 5 opcodes fell through to the NOP
// default and advanced PC by only 1 byte — the operand bytes were then
// executed as opcodes (a derail). This pins the documented "stable"
// behaviour validated by the VICE CPU/sha, shxy and shs testprogs
// (shaabsy1/shazpy1/shxy1/shyx1/shsabsy1 all PASS):
//
//   value stored = reg & (H+1)   (reg = A&X for SHA/TAS, X for SHX, Y for SHY)
//   H = high byte of the base address; TAS also sets SP = A&X.
//   On a page-boundary crossing the TARGET's high byte is replaced by the
//   stored value (the classic "high byte = value" address corruption).
//
// NOT covered (documented limitation, matches VICE x64): the cycle-exact
// VIC-DMA "& (H+1) drop-off" (shaabsy2+/shxy2+/shsabsy2+), which needs
// BA-stall coupling and even x64 fails.

import { CPU } from '../src/cpu.js';

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

class FlatMemory {
  constructor() { this.ram = new Uint8Array(0x10000); }
  read(a) { return this.ram[a & 0xFFFF]; }
  write(a, v) { this.ram[a & 0xFFFF] = v & 0xFF; }
}

// Run a single instruction `op b1 [b2]` at $0400; return cycles + memory.
function runOpcode(bytes, init) {
  const mem = new FlatMemory();
  mem.ram.fill(0xEA);
  bytes.forEach((b, i) => { mem.ram[0x0400 + i] = b; });
  const cpu = new CPU(mem);
  cpu.reset();
  for (let i = 0; i < 7; i++) cpu.clock();
  cpu.pc = 0x0400; cpu.instructionCyclesRemaining = 0; cpu.microOpHead = 0; cpu.microOpLen = 0;
  cpu.a = 0; cpu.x = 0; cpu.y = 0;
  init(cpu, mem);
  let cycles = 0;
  while (cycles < 20) { cpu.clock(); cycles++; if (cpu.atInstructionBoundary()) break; }
  return { cpu, mem, cycles, pcDelta: (cpu.pc - 0x0400) & 0xFFFF };
}
const hx = v => '$' + (v & 0xff).toString(16).padStart(2, '0');

// ── 1: SHX abs,Y stable — M = X & (H+1), 3 bytes / 5 cycles ──────────
{
  // base $0200 (H=$02), Y=0, X=$FF → $FF & $03 = $03 @ $0200
  const r = runOpcode([0x9E, 0x00, 0x02], (c) => { c.x = 0xFF; c.y = 0x00; });
  expect(r.mem.ram[0x0200] === 0x03, `M=$03 got ${hx(r.mem.ram[0x0200])}`);
  expect(r.pcDelta === 3, `PC+3 got ${r.pcDelta}`);
  expect(r.cycles === 5, `5 cy got ${r.cycles}`);
  ok('SHX abs,Y stable: M = X & (H+1)');
}

// ── 2: SHY abs,X stable — M = Y & (H+1) ──────────────────────────────
{
  // base $0300 (H=$03), X=0, Y=$FF → $FF & $04 = $04 @ $0300
  const r = runOpcode([0x9C, 0x00, 0x03], (c) => { c.y = 0xFF; c.x = 0x00; });
  expect(r.mem.ram[0x0300] === 0x04, `M=$04 got ${hx(r.mem.ram[0x0300])}`);
  expect(r.pcDelta === 3 && r.cycles === 5, `3B/5c got ${r.pcDelta}B/${r.cycles}c`);
  ok('SHY abs,X stable: M = Y & (H+1)');
}

// ── 3: SHA abs,Y stable — M = A & X & (H+1) ──────────────────────────
{
  // base $0500 (H=$05), A=$FF, X=$0F, Y=0 → ($FF&$0F)&$06 = $06 @ $0500
  const r = runOpcode([0x9F, 0x00, 0x05], (c) => { c.a = 0xFF; c.x = 0x0F; c.y = 0; });
  expect(r.mem.ram[0x0500] === 0x06, `M=$06 got ${hx(r.mem.ram[0x0500])}`);
  expect(r.pcDelta === 3 && r.cycles === 5, `3B/5c got ${r.pcDelta}B/${r.cycles}c`);
  ok('SHA abs,Y stable: M = A & X & (H+1)');
}

// ── 4: SHA (zp),Y stable — 2 bytes / 6 cycles ────────────────────────
{
  // zp $40 → $0600 (H=$06), A=$FF, X=$0F, Y=0 → $0F & $07 = $07 @ $0600
  const r = runOpcode([0x93, 0x40], (c, m) => {
    m.ram[0x40] = 0x00; m.ram[0x41] = 0x06; c.a = 0xFF; c.x = 0x0F; c.y = 0;
  });
  expect(r.mem.ram[0x0600] === 0x07, `M=$07 got ${hx(r.mem.ram[0x0600])}`);
  expect(r.pcDelta === 2, `PC+2 got ${r.pcDelta}`);
  expect(r.cycles === 6, `6 cy got ${r.cycles}`);
  ok('SHA (zp),Y stable: M = A & X & (H+1), 2B/6c');
}

// ── 5: TAS/SHS abs,Y — SP ← A&X, then M = (A&X) & (H+1) ──────────────
{
  // base $0700 (H=$07), A=$FF, X=$3C, Y=0 → SP=$3C; $3C & $08 = $08 @ $0700
  const r = runOpcode([0x9B, 0x00, 0x07], (c) => { c.a = 0xFF; c.x = 0x3C; c.y = 0; });
  expect(r.cpu.sp === 0x3C, `SP=$3C got ${hx(r.cpu.sp)}`);
  expect(r.mem.ram[0x0700] === 0x08, `M=$08 got ${hx(r.mem.ram[0x0700])}`);
  expect(r.pcDelta === 3 && r.cycles === 5, `3B/5c got ${r.pcDelta}B/${r.cycles}c`);
  ok('TAS abs,Y: SP = A&X and M = (A&X) & (H+1)');
}

// ── 6: page-cross address corruption — target high byte = value ──────
//
// SHX $02FF,Y with Y=2: lo $FF + 2 crosses the page. value = X & (H+1) =
// $FF & $03 = $03. The effective high byte becomes the value → store $03
// at $0301, and the "expected" non-crossed page ($0201) is untouched.
{
  const r = runOpcode([0x9E, 0xFF, 0x02], (c) => { c.x = 0xFF; c.y = 0x02; });
  expect(r.mem.ram[0x0301] === 0x03, `M[$0301]=$03 got ${hx(r.mem.ram[0x0301])}`);
  expect(r.mem.ram[0x0201] === 0xEA, `M[$0201] untouched (got ${hx(r.mem.ram[0x0201])})`);
  ok('page-cross: target high byte replaced by stored value');
}

// ── 7: mirrors the VICE sha1 page-crossing reference exactly ─────────
//
// sha1.s: base $C0FF, A=X=$FF, Y=2 → cross. value = $FF & ($C0+1) = $C1,
// effective high = value → $C101 gets $C1; $C201 (would-be) stays put.
{
  const r = runOpcode([0x9F, 0xFF, 0xC0], (c, m) => {
    c.a = 0xFF; c.x = 0xFF; c.y = 2; m.ram[0xC201] = 0xFF;
  });
  expect(r.mem.ram[0xC101] === 0xC1, `M[$C101]=$C1 got ${hx(r.mem.ram[0xC101])}`);
  expect(r.mem.ram[0xC201] === 0xFF, `M[$C201] untouched ($FF) got ${hx(r.mem.ram[0xC201])}`);
  ok('SHA abs,Y matches VICE sha1 page-cross reference ($C101=$C1)');
}

console.log(`\n${testNo} unstable store-illegal tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
