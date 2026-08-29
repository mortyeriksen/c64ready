// NMOS 6502 page-cross + branch cycle-timing spec tests.
//
// Spec source: standard 6502 timing tables (e.g. Synertek SY6502
// datasheet, Bauer reference, "Programming the 65816" Eyes/Lichty).
//
// These are the two CPU-level timing aspects that the sbsprf24 stable-IRQ
// investigation flagged as candidates for its 5-cyc set_timer deficit
// (that characterization test is gone; the timing rules it leaned on are
// pinned here):
//
//   1. `lda abs,Y` page-cross: real 6502 does a DUMMY read at the
//      un-fixed address (high byte not yet incremented) before the
//      real read at the corrected address. Total 5 cycles vs 4 with
//      no cross. The dummy read can be observable on memory-mapped
//      I/O (e.g. reading $D012 with x=$ff dummies $C012).
//
//   2. The "eat 1 cycle" jitter-comp pattern (`beq *+2`) relies on the
//      not-taken vs taken-no-cross distinction (2 vs 3 cyc). The plain
//      2/3/4-cycle branch table is in branch-cycle-accounting-spec-test.

import { CPU } from '../src/cpu.js';

class TraceMemory {
  constructor() {
    this.ram = new Uint8Array(0x10000);
    this.reads = [];   // [{addr, value, kind}]
    this.writes = [];
  }
  read(a) {
    const v = this.ram[a & 0xFFFF];
    this.reads.push({ addr: a & 0xFFFF, value: v });
    return v;
  }
  write(a, v) {
    this.ram[a & 0xFFFF] = v & 0xFF;
    this.writes.push({ addr: a & 0xFFFF, value: v & 0xFF });
  }
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

function runOneInstruction(program, init) {
  const mem = new TraceMemory();
  for (let i = 0; i < program.length; i++) mem.ram[0x0400 + i] = program[i];
  const cpu = new CPU(mem);
  cpu.pc = 0x0400; cpu.sp = 0xFF; cpu.setP(0x24);
  cpu.a = 0; cpu.x = 0; cpu.y = 0;
  if (init) init(cpu, mem);
  // Reset trace AFTER init (init may touch memory).
  mem.reads = [];
  mem.writes = [];
  let cycles = 0;
  for (let i = 0; i < 50; i++) {
    cpu.clock();
    cycles++;
    if (cpu.atInstructionBoundary() && cycles >= 1) break;
  }
  return { cpu, mem, cycles };
}

// ───────────────────────────────────────────────────────────────────
// PART 1: lda abs,Y page-cross dummy read
// ───────────────────────────────────────────────────────────────────

// Note on bus-read counts: our impl emits a dispatch opcode-read in
// _beginMicroInstruction PLUS T0's "opcode re-read" microop. The
// trace records 2 reads at PC for every instruction's opcode fetch
// (one extra vs real silicon). The CYCLE COUNT is correct (the
// dispatch read shares a master cycle with T0). Tests below check
// the LAST 1-2 reads (dummy/real data) which are unambiguous.

// ── 1: lda abs,Y, no page cross — 4 cycles, single data read ──────
{
  // LDA $0500,Y with Y=$10 → reads $0510. No page cross.
  const program = [0xB9, 0x00, 0x05];     // LDA $0500,Y
  const { cpu, mem, cycles } = runOneInstruction(program, (cpu, m) => {
    cpu.y = 0x10;
    m.ram[0x0510] = 0x42;
  });
  expect(cycles === 4, `LDA abs,Y no cross: 4 cycles, got ${cycles}`);
  expect(cpu.a === 0x42, `LDA abs,Y: A=$42, got $${cpu.a.toString(16)}`);
  const last = mem.reads[mem.reads.length - 1];
  expect(last.addr === 0x0510,
    `LDA abs,Y no cross: last read at $0510, got $${last?.addr.toString(16)}`);
  ok('NMOS6502: LDA abs,Y no page-cross — 4 cycles, single data read at target');
}

// ── 2: lda abs,Y, page cross — 5 cycles, dummy read at un-fixed addr ─
{
  // LDA $05F0,Y with Y=$20 → target $0610. Page cross. Dummy read at
  // (high=$05) | (low=($F0+$20)&$FF=$10) = $0510.
  const program = [0xB9, 0xF0, 0x05];     // LDA $05F0,Y
  const { cpu, mem, cycles } = runOneInstruction(program, (cpu, m) => {
    cpu.y = 0x20;
    m.ram[0x0510] = 0xAA;                  // dummy-read target (observable)
    m.ram[0x0610] = 0x42;                  // real target
  });
  expect(cycles === 5, `LDA abs,Y page cross: 5 cycles, got ${cycles}`);
  expect(cpu.a === 0x42, `LDA abs,Y: A from real target, got $${cpu.a.toString(16)}`);
  const last2 = mem.reads.slice(-2);
  expect(last2[0].addr === 0x0510,
    `LDA abs,Y cross: dummy read at $0510 (un-fixed), got $${last2[0]?.addr.toString(16)}`);
  expect(last2[1].addr === 0x0610,
    `LDA abs,Y cross: final read at $0610 (fixed), got $${last2[1]?.addr.toString(16)}`);
  ok('NMOS6502: LDA abs,Y page-cross — 5 cycles, dummy read at un-fixed addr');
}

// ── 3: lda abs,X same dummy-read behavior ──────────────────────────
{
  // LDA $05FF,X with X=$01 → target $0600. Dummy at ($05) | ($00) = $0500.
  const program = [0xBD, 0xFF, 0x05];     // LDA $05FF,X
  const { cpu, mem, cycles } = runOneInstruction(program, (cpu, m) => {
    cpu.x = 0x01;
    m.ram[0x0500] = 0xAA;
    m.ram[0x0600] = 0x42;
  });
  expect(cycles === 5, `LDA abs,X cross: 5 cycles, got ${cycles}`);
  expect(cpu.a === 0x42, `LDA abs,X: A=$42, got $${cpu.a.toString(16)}`);
  const last2 = mem.reads.slice(-2);
  expect(last2[0].addr === 0x0500,
    `LDA abs,X cross: dummy at $0500, got $${last2[0]?.addr.toString(16)}`);
  expect(last2[1].addr === 0x0600,
    `LDA abs,X cross: real at $0600, got $${last2[1]?.addr.toString(16)}`);
  ok('NMOS6502: LDA abs,X page-cross — same dummy-read scheme as abs,Y');
}

// ── 4: Page-cross dummy on I/O register address ────────────────────
// stable-irq context: `lda $cf13,Y` with Y=$FF reads $D012 (raster
// register). Un-fixed dummy = (base_hi << 8) | (effective_lo) where
// effective_lo = (base_lo + Y) & $FF = ($13 + $FF) & $FF = $12.
// So dummy = ($CF << 8) | $12 = $CF12. The bus access happens
// regardless of whether the un-fixed address is RAM or I/O — that's
// why an unwary `lda $D012` indexed read can spuriously read I/O at
// the un-fixed address.
{
  // LDA $CF13,Y with Y=$FF → target $D012. Dummy at $CF12.
  const program = [0xB9, 0x13, 0xCF];     // LDA $CF13,Y
  const { cpu, mem, cycles } = runOneInstruction(program, (cpu, m) => {
    cpu.y = 0xFF;
    m.ram[0xCF12] = 0xAA;
    m.ram[0xD012] = 0x80;
  });
  expect(cycles === 5, `LDA $CF13,Y with Y=$FF: 5 cycles (page cross), got ${cycles}`);
  expect(cpu.a === 0x80, `final A from real target $D012, got $${cpu.a.toString(16)}`);
  const last2 = mem.reads.slice(-2);
  expect(last2[0].addr === 0xCF12,
    `dummy read at un-fixed $CF12, got $${last2[0]?.addr.toString(16)}`);
  expect(last2[1].addr === 0xD012,
    `real read at $D012, got $${last2[1]?.addr.toString(16)}`);
  ok('NMOS6502: page-cross dummy reads un-fixed address (observable on I/O)');
}

// ───────────────────────────────────────────────────────────────────
// PART 2: Branch (Bxx) cycle-count jitter compensation
// ───────────────────────────────────────────────────────────────────

// Multi-instruction runner: run until PC reaches stopPc at a boundary.
function runProgram(program, stopPc, init) {
  const mem = new TraceMemory();
  for (let i = 0; i < program.length; i++) mem.ram[0x0400 + i] = program[i];
  const cpu = new CPU(mem);
  cpu.pc = 0x0400; cpu.sp = 0xFF; cpu.setP(0x24);
  cpu.a = 0; cpu.x = 0; cpu.y = 0;
  if (init) init(cpu, mem);
  let cycles = 0;
  for (let i = 0; i < 1000; i++) {
    cpu.clock();
    cycles++;
    if (cpu.atInstructionBoundary() && cpu.pc === stopPc) return { cpu, mem, cycles };
  }
  throw new Error(`runProgram: never reached stopPc=$${stopPc.toString(16)} (PC=$${cpu.pc.toString(16)})`);
}

// ── 8: BEQ +$00 ("eat 1 cycle" pattern) — 3 cycles when taken ──────
// `beq *+2` actually means BEQ with offset 0 — branches to the next
// instruction (the byte after BEQ's offset). The standard
// jitter-comp use: load Z=1, fall through with extra cycle, vs Z=0
// fall through with normal cycle.
{
  // LDA #$00 (Z=1) ; BEQ +$00 (= jump to next byte) ; NOP.
  const program = [0xA9, 0x00, 0xF0, 0x00, 0xEA];
  const { cpu, cycles } = runProgram(program, 0x0405);
  // LDA: 2, BEQ taken+0 (no cross): 3, NOP: 2. Total 7.
  expect(cycles === 7, `LDA + BEQ +$00 (taken) + NOP: 2+3+2 = 7 cycles, got ${cycles}`);
  ok('NMOS6502: BEQ +$00 (taken) — 3 cycles (jitter-comp eat-1 path)');
}

// ── 9: BEQ +$00 not taken — 2 cycles (1 cyc less than taken) ───────
// Same instruction, Z=0 case — 2 cycles instead of 3 ⇒ "eat 1 cycle"
// is the difference between these two.
{
  const program = [0xA9, 0x01, 0xF0, 0x00, 0xEA];
  const { cpu, cycles } = runProgram(program, 0x0405);
  // LDA: 2, BEQ not taken: 2, NOP: 2. Total 6.
  expect(cycles === 6, `LDA + BEQ +$00 (not taken) + NOP: 2+2+2 = 6 cycles, got ${cycles}`);
  ok('NMOS6502: BEQ +$00 (not taken) — 2 cycles (1 cyc less than taken)');
}

console.log(`\n${testNo} CPU page-cross / branch jitter spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
