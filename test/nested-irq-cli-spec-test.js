// Nested IRQ via CLI / PLP / RTI — interrupt shadow spec test.
//
// NMOS 6502: SEI/CLI/PLP/RTI all have a "1-instruction interrupt
// shadow":
//
//   - SEI: I flag is SET by end of SEI (cy 2). But the I-flag-check
//     for the NEXT instruction uses the OLD I value. So an IRQ
//     pending DURING SEI still fires on the instruction after SEI.
//   - CLI: I flag is CLEARED by end of CLI. But the NEXT instruction
//     still uses the OLD I (= 1), so the IRQ doesn't fire until the
//     instruction AFTER the NEXT one.
//   - PLP: same logic for the I bit it restores.
//   - RTI: restores I from stack. The pulled I is in effect FROM the
//     first instruction post-RTI (no shadow on RTI, unlike SEI/CLI/PLP).
//
// IRQ handlers that CLI inside themselves (to allow nesting) trigger
// this shadow. cpu-irq-sampled-only-spec-test.js covers some of these,
// but the SPECIFIC "nested IRQ within an active handler" scenario is
// worth pinning end-to-end.
//
// Audit gap: nested-IRQ via CLI in handler — covered indirectly by
// cpu-irq-sampled-only-spec-test (which has CLI/PLP/RTI shadow tests),
// but no end-to-end "handler does CLI, second IRQ fires" test.

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
  for (let i = 0; i < 0x200; i++) mem.ram[0x9000 + i] = 0xEA;       // IRQ handler runway
  mem.ram[0xFFFE] = 0x00; mem.ram[0xFFFF] = 0x90;
  mem.ram[0xFFFC] = 0x00; mem.ram[0xFFFD] = 0x04;
  const cpu = new CPU(mem);
  cpu.reset();
  for (let i = 0; i < 7; i++) cpu.clock();
  cpu.I = 0; cpu._pollI = 0;
  return { cpu, mem };
}

function parkAt(cpu, pc) {
  cpu.pc = pc;
  cpu.instructionCyclesRemaining = 0;
  cpu.microOpHead = 0;
  cpu.microOpLen = 0;
}

function runUntilDone(cpu, budget = 30) {
  let i = 0;
  while (i < budget) {
    cpu.clock();
    i++;
    if (cpu.instructionCyclesRemaining === 0) return i;
  }
  return -1;
}

// ── 1: IRQ handler entry sets I=1 — second IRQ blocked.
{
  const { cpu, mem } = makeCpu();
  cpu.setIrqLine(true);
  cpu.sampledIrq = true;
  for (let i = 0; i < 7; i++) cpu.clock();        // IRQ entry
  expect(cpu.pc === 0x9000, `entered IRQ handler`);
  expect(cpu.I === 1, `I flag set after entry`);
  // Now CPU is in handler. Run a few NOPs. IRQ line still asserted but
  // I=1 should block re-entry.
  const pcBeforeNops = cpu.pc;
  for (let i = 0; i < 6; i++) cpu.clock();         // 3 NOPs
  expect(cpu.pc === pcBeforeNops + 3,
    `3 NOPs ran inside handler (no re-entry); pc=$${cpu.pc.toString(16)}`);
  ok('NMOS 6502: handler entry sets I=1, blocks re-entry while IRQ still asserted');
}

// ── 2: Handler does CLI → 1-instruction shadow → 2nd IRQ fires AFTER
// the next instruction.
//
// Setup:
//   $9000: CLI (2 cy, clears I; but next instr's boundary check uses
//          OLD I=1, so IRQ blocked)
//   $9001: NOP (2 cy; runs even though IRQ is pending and I=0 now,
//          due to shadow)
//   $9002: NOP (this is where IRQ entry takes over)
{
  const { cpu, mem } = makeCpu();
  cpu.setIrqLine(true);
  cpu.sampledIrq = true;
  for (let i = 0; i < 7; i++) cpu.clock();        // first IRQ entry
  expect(cpu.pc === 0x9000, `first IRQ: at $9000`);
  // Install handler at $9000: CLI; NOP; NOP; ... and keep IRQ line up.
  mem.ram[0x9000] = 0x58;        // CLI
  mem.ram[0x9001] = 0xEA;        // NOP (runs in shadow)
  mem.ram[0x9002] = 0xEA;        // NOP (this fires nested IRQ before it runs)
  // CLI: 2 cy.
  for (let i = 0; i < 2; i++) cpu.clock();
  expect(cpu.I === 0, `CLI cleared I; got I=${cpu.I}`);
  expect(cpu.pc === 0x9001, `CLI ran; pc=$9001`);
  // Run NOP at $9001 — should NOT trigger IRQ entry yet (CLI shadow).
  for (let i = 0; i < 2; i++) cpu.clock();
  expect(cpu.pc === 0x9002,
    `NOP at $9001 ran in CLI shadow (no IRQ); pc=$9002, got $${cpu.pc.toString(16)}`);
  // Now at boundary at $9002 with I=0 and IRQ pending → fire nested IRQ.
  // 7 cy of entry → pc = $9000 (handler vector again).
  for (let i = 0; i < 7; i++) cpu.clock();
  expect(cpu.pc === 0x9000,
    `nested IRQ entered handler again; pc=$9000, got $${cpu.pc.toString(16)}`);
  ok('NMOS 6502: handler CLI + NOP → 1-instr shadow → nested IRQ entry on next instruction');
}

// ── 3: SEI inside handler — IRQ blocked from next instruction (no shadow
// for re-blocking).
//
// Actually NMOS SEI also has a 1-instruction shadow on the INTERRUPT
// check (analogously to CLI). For SEI: I is SET, but the next
// instruction's IRQ-check uses the OLD I=0, so a pending IRQ might still
// fire. Test this.
{
  const { cpu, mem } = makeCpu();
  cpu.pc = 0x0500;
  cpu.I = 0; cpu._pollI = 0;
  cpu.instructionCyclesRemaining = 0;
  cpu.microOpHead = 0;
  cpu.microOpLen = 0;
  mem.ram[0x0500] = 0x78;        // SEI
  mem.ram[0x0501] = 0xEA;        // NOP — pending IRQ may fire after this
  mem.ram[0x0502] = 0xEA;
  // Run SEI WITHOUT IRQ pending (= clean SEI execution).
  for (let i = 0; i < 2; i++) cpu.clock();
  expect(cpu.I === 1, `SEI set I=1; got I=${cpu.I}`);
  expect(cpu.pc === 0x0501, `SEI done, pc=$0501; got $${cpu.pc.toString(16)}`);
  // NOW assert IRQ (line only — poking sampledIrq here would claim the
  // line was already pending during SEI, which is the slip case that
  // correctly fires). I is already 1, so an IRQ asserting after SEI is
  // blocked: the next instruction's poll sees the new I.
  cpu.setIrqLine(true);
  for (let i = 0; i < 7; i++) cpu.clock();
  // STRICT spec: SEI sets I=1, so subsequently-asserted IRQ is BLOCKED.
  // 7 cycles of NOP execution = 3 NOPs + 1 cy of 4th NOP.
  // pc advance: $0501 → $0504 (3 NOPs ran) or $0504 (mid-4th-NOP).
  // The exact pc depends on cycle alignment but must be in $0504..$0505.
  expect(cpu.pc === 0x0504 || cpu.pc === 0x0505,
    `SEI sets I=1; post-SEI IRQ blocked; CPU runs 3-4 NOPs in 7 cy; pc ∈ {$0504, $0505}; got $${cpu.pc.toString(16)}`);
  ok('NMOS 6502: SEI sets I=1; subsequently-asserted IRQ is blocked (CPU continues with NOPs)');
}

// ── 4: RTI restores I from stack — restored I in effect FROM first
// instruction post-RTI (no shadow on RTI).
//
// Setup: P on stack has I=0. RTI returns with I=0. The first
// instruction post-RTI runs with I=0, and any pending IRQ fires.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x9000);
  cpu.I = 1; cpu._pollI = 1;                                  // handler currently has I=1
  cpu.sp = 0xFC;
  mem.ram[0x01FF] = 0x05;        // PCH
  mem.ram[0x01FE] = 0x00;        // PCL → return to $0500
  mem.ram[0x01FD] = 0x20;        // P with I=0
  mem.ram[0x9000] = 0x40;        // RTI
  cpu.setIrqLine(true);
  cpu.sampledIrq = false;        // arm
  // Run RTI = 6 cy. After RTI, I should = 0, pc = $0500.
  for (let i = 0; i < 6; i++) cpu.clock();
  expect(cpu.I === 0, `RTI restored I=0; got I=${cpu.I}`);
  expect(cpu.pc === 0x0500, `RTI returned to $0500; got $${cpu.pc.toString(16)}`);
  // IRQ should now fire (pin still asserted, I=0). Boundary check at
  // $0500 accepts IRQ if sampledIrq is set. Sample happens at end of cy
  // of RTI's last cycle. Run boundary check + entry.
  cpu.sampledIrq = true;
  for (let i = 0; i < 7; i++) cpu.clock();
  expect(cpu.pc === 0x9000,
    `nested IRQ via RTI: pc=$9000; got $${cpu.pc.toString(16)}`);
  ok('NMOS 6502: RTI restores I; first-post-RTI instruction respects new I (no RTI shadow)');
}

console.log(`\n${testNo} nested IRQ + CLI/PLP/RTI spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
