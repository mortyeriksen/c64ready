// NMOS 6502/6510: indexed STORE and RMW dummy access uses the FALSE (wrapped)
// address on a page cross.
//
// For abs,X / abs,Y / (zp),Y, the indexed address is formed as base + index.
// On the cycle before the write (stores) or the RMW read (read-modify-write),
// the CPU performs a dummy bus access at the UNCORRECTED address — the low byte
// has the index added but the high byte is NOT yet carried:
//     falseAddr = (baseHi << 8) | ((baseLo + index) & 0xFF)
// The corrected address (baseHi+1 high byte) is used only for the actual
// write / RMW. This is bus-visible: STA $D0FF,X (X=1) dummy-reads $D000, not
// $D100 — touching a different I/O register (and on $DCxx/$DDxx it could even
// ack a CIA ICR). Loads already do this (see _queueLoadAbsIndexedMicroOps);
// stores/RMW previously dummy-read the corrected address. This pins the fix.
//
// Refs: NMOS 6502 cycle-by-cycle (indexed store always pays the extra cycle;
// the dummy access is at the pre-carry address) — VICE CPU behavior.

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
const hx = a => '$' + (a & 0xffff).toString(16).padStart(4, '0');

class LogMem {
  constructor() { this.ram = new Uint8Array(0x10000); this.reads = []; this.writes = []; }
  read(a) { a &= 0xffff; this.reads.push(a); return this.ram[a]; }
  write(a, v) { a &= 0xffff; this.writes.push([a, v & 0xff]); this.ram[a] = v & 0xff; }
}

// Run one instruction (prog bytes at $1000) with given X/Y/A; return the mem log
// captured for that instruction only (opcode/operand fetches included).
function runOne(prog, { x = 0, y = 0, a = 0, presets = {} } = {}) {
  const m = new LogMem();
  for (let i = 0; i < prog.length; i++) m.ram[0x1000 + i] = prog[i];
  for (const k in presets) m.ram[(+k) & 0xffff] = presets[k] & 0xff;   // pre-set target memory
  const cpu = new CPU(m);
  cpu.reset();
  for (let i = 0; i < 7; i++) cpu.clock();          // settle
  cpu.pc = 0x1000; cpu.x = x & 0xff; cpu.y = y & 0xff; cpu.a = a & 0xff;
  cpu.instructionCyclesRemaining = 0; cpu.microOpHead = 0; cpu.microOpLen = 0;
  m.reads.length = 0; m.writes.length = 0;
  for (let i = 0; i < 14; i++) {
    cpu.clock();
    if (m.writes.length > 0 && cpu.instructionCyclesRemaining === 0) break;
  }
  return m;
}
const inPage = (reads, lo, hi) => reads.filter(r => r >= lo && r <= hi);

// ── 1: STA abs,X page cross → dummy read at FALSE addr, write at corrected ──
{
  const m = runOne([0x9D, 0xFF, 0x20], { x: 0x01, a: 0xAA });   // STA $20FF,X
  const t = inPage(m.reads, 0x2000, 0x21FF);
  expect(t.includes(0x2000), `STA $20FF,X: dummy read at FALSE $2000; target reads=${t.map(hx)}`);
  expect(!t.includes(0x2100), `STA $20FF,X: must NOT read corrected $2100`);
  expect(m.writes.some(([a, v]) => a === 0x2100 && v === 0xAA), `write at corrected $2100=$AA, writes=${m.writes.map(([a,v])=>hx(a)+':'+v.toString(16))}`);
  ok('NMOS: STA abs,X page-cross dummy read uses the false (wrapped) address');
}

// ── 2: STA abs,X NO cross → dummy read == write addr (corrected==false) ────
{
  const m = runOne([0x9D, 0x10, 0x20], { x: 0x01, a: 0xBB });   // STA $2010,X → $2011
  const t = inPage(m.reads, 0x2000, 0x21FF);
  expect(t.includes(0x2011), `STA $2010,X no-cross: dummy read at $2011; got ${t.map(hx)}`);
  expect(m.writes.some(([a, v]) => a === 0x2011 && v === 0xBB), `write at $2011`);
  ok('NMOS: STA abs,X no-cross dummy read == target (no spurious page)');
}

// ── 3: STA (zp),Y page cross → dummy read at FALSE addr ────────────────────
{
  const prog = [0x91, 0x10];                                     // STA ($10),Y
  const m0 = new LogMem();
  m0.ram[0x1000] = prog[0]; m0.ram[0x1001] = prog[1];
  m0.ram[0x0010] = 0xFF; m0.ram[0x0011] = 0x20;                  // ptr → $20FF
  const cpu = new CPU(m0); cpu.reset(); for (let i = 0; i < 7; i++) cpu.clock();
  cpu.pc = 0x1000; cpu.y = 0x01; cpu.a = 0xCC;
  cpu.instructionCyclesRemaining = 0; cpu.microOpHead = 0; cpu.microOpLen = 0;
  m0.reads.length = 0; m0.writes.length = 0;
  for (let i = 0; i < 10; i++) { cpu.clock(); if (m0.writes.length && cpu.instructionCyclesRemaining === 0) break; }
  const t = inPage(m0.reads, 0x2000, 0x21FF);
  expect(t.includes(0x2000), `STA ($10),Y page-cross: dummy read at FALSE $2000; got ${t.map(hx)}`);
  expect(!t.includes(0x2100), `must NOT read corrected $2100`);
  expect(m0.writes.some(([a, v]) => a === 0x2100 && v === 0xCC), `write at corrected $2100`);
  ok('NMOS: STA (zp),Y page-cross dummy read uses the false (wrapped) address');
}

// ── 4: INC abs,X (RMW) page cross → all four bus phases at the right addresses:
//      false read $2000, old-value read $2100, dummy write $2100 (old value),
//      final write $2100 (modified value).
{
  const m = runOne([0xFE, 0xFF, 0x20], { x: 0x01, presets: { 0x2100: 0x41 } });  // INC $20FF,X → $2100
  const t = inPage(m.reads, 0x2000, 0x21FF);
  const w = m.writes.filter(([a]) => a >= 0x2000 && a <= 0x21FF);
  expect(t.includes(0x2000), `false read at $2000; reads=${t.map(hx)}`);
  expect(t.includes(0x2100), `old-value read at corrected $2100; reads=${t.map(hx)}`);
  expect(w.length === 2 && w.every(([a]) => a === 0x2100), `two RMW writes, both at $2100; got ${w.map(([a]) => hx(a))}`);
  expect(w[0] && w[0][1] === 0x41, `dummy write = old value $41; got ${w[0] ? hx(w[0][1]) : 'none'}`);
  expect(w[1] && w[1][1] === 0x42, `final write = INC result $42; got ${w[1] ? hx(w[1][1]) : 'none'}`);
  ok('NMOS: INC abs,X RMW page-cross — false read $2000, old-value read + dummy/final write $2100');
}

// ── 5: illegal RMW (SLO $20FF,X) page cross → same false-read path (it
//      dispatches through the shared _queueRmwAbsIndexedMicroOps).
{
  const m = runOne([0x1F, 0xFF, 0x20], { x: 0x01, a: 0x01, presets: { 0x2100: 0x40 } });  // SLO $20FF,X
  const t = inPage(m.reads, 0x2000, 0x21FF);
  const w = m.writes.filter(([a]) => a >= 0x2000 && a <= 0x21FF);
  expect(t.includes(0x2000), `illegal SLO abs,X: false read at $2000; got ${t.map(hx)}`);
  expect(w.length >= 1 && w.every(([a]) => a === 0x2100), `SLO writes at corrected $2100; got ${w.map(([a]) => hx(a))}`);
  expect(w.some(([, v]) => v === 0x80), `SLO writes ASL($40)=$80; got ${w.map(([, v]) => hx(v))}`);
  ok('NMOS: illegal RMW (SLO abs,X) page-cross uses the false (wrapped) dummy-read address');
}

// ── 6: illegal RMW (zp),Y (SLO ($10),Y) page cross → the (zp),Y RMW path
//      (_queueRmwIndyMicroOps) must mirror the abs-indexed fix: the cycle-5
//      dummy read lands at the FALSE (wrapped, hi-not-carried) address, not the
//      corrected target. Regression guard for the friend-flagged leftover where
//      it dummy-read the corrected $2100 (an I/O-page false addr would have a
//      visible read side effect at the wrong location).
{
  const m = runOne([0x13, 0x10], { y: 0x01, a: 0x01, presets: { 0x10: 0xFF, 0x11: 0x20, 0x2100: 0x40 } });  // SLO ($10),Y, ptr→$20FF, +Y → $2100
  const t = inPage(m.reads, 0x2000, 0x21FF);
  const w = m.writes.filter(([a]) => a >= 0x2000 && a <= 0x21FF);
  expect(t.includes(0x2000), `illegal SLO (zp),Y page-cross: false read at $2000; got ${t.map(hx)}`);
  expect(t.includes(0x2100), `illegal SLO (zp),Y: old-value read at corrected $2100; got ${t.map(hx)}`);
  expect(w.length >= 1 && w.every(([a]) => a === 0x2100), `SLO (zp),Y writes at corrected $2100; got ${w.map(([a]) => hx(a))}`);
  expect(w.some(([, v]) => v === 0x80), `SLO (zp),Y writes ASL($40)=$80; got ${w.map(([, v]) => hx(v))}`);
  ok('NMOS: illegal RMW (SLO (zp),Y) page-cross uses the false (wrapped) dummy-read address');
}

console.log(`\n${testNo} indexed store/RMW false-read spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
