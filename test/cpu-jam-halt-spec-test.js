// JAM / KIL / HLT opcode halt + recovery spec test.
//
// Locks in the behaviour exercised by the VICE cpujam testprogs
// (jamirq.prg / jamnmi.prg / unjam.prg). On the NMOS 6510 the 12 JAM
// opcodes ($02 $12 $22 $32 $42 $52 $62 $72 $92 $B2 $D2 $F2) freeze the
// CPU permanently: it fetches no further bytes, leaves PC put, drives $FF
// on the data bus, and — crucially — does NOT respond to IRQ or NMI.
// The ONLY way out is RESET.
//
// Source of truth: "NMOS 6510 Unintended Opcodes" (groepaz/Solo, the same
// VICE-testprog lineage) and the 6502/6510 datasheet. Regression target
// for src/cpu.js _queueJamMicroOps + the halted gate at the top of
// _beginMicroInstruction (which MUST precede interrupt vectoring).

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

const JAM_OPCODES = [0x02, 0x12, 0x22, 0x32, 0x42, 0x52, 0x62, 0x72,
                     0x92, 0xB2, 0xD2, 0xF2];
const hx = v => '$' + (v & 0xff).toString(16).padStart(2, '0');

// Fresh CPU sitting at an instruction boundary at $0400 with interrupts
// unmasked. Reset vector → $0400, IRQ → $9000, NMI → $A000. Handlers and
// $0400+ are filled with NOPs so a (wrongly) un-jammed CPU runs forward
// visibly instead of falling into uninitialised bytes.
function makeCpu() {
  const mem = new FlatMemory();
  mem.ram.fill(0xEA);                       // NOP everywhere by default
  mem.ram[0xFFFC] = 0x00; mem.ram[0xFFFD] = 0x04;  // RESET → $0400
  mem.ram[0xFFFE] = 0x00; mem.ram[0xFFFF] = 0x90;  // IRQ   → $9000
  mem.ram[0xFFFA] = 0x00; mem.ram[0xFFFB] = 0xA0;  // NMI   → $A000
  const cpu = new CPU(mem);
  cpu.reset();
  for (let i = 0; i < 7; i++) cpu.clock();   // consume reset settle
  cpu.I = 0;                                 // unmask IRQ for the tests
  return { cpu, mem };
}

// Run the CPU until it reports halted (or give up after `budget` cycles).
function clockUntilHalted(cpu, budget = 12) {
  for (let i = 0; i < budget && !cpu.halted; i++) cpu.clock();
}

// ── 1: every JAM opcode halts the CPU and freezes PC forever ──────────
{
  for (const op of JAM_OPCODES) {
    const { cpu, mem } = makeCpu();
    mem.ram[0x0400] = op;          // JAM at the boot PC
    clockUntilHalted(cpu);
    expect(cpu.halted === true, `${hx(op)}: cpu.halted set`);
    const pcAtJam = cpu.pc;
    // Run a long while; PC must not budge and it must stay halted.
    for (let i = 0; i < 100; i++) cpu.clock();
    expect(cpu.pc === pcAtJam, `${hx(op)}: PC frozen ($${pcAtJam.toString(16)} → $${cpu.pc.toString(16)})`);
    expect(cpu.halted === true, `${hx(op)}: still halted after 100 cy`);
  }
  ok('all 12 JAM opcodes halt the CPU and freeze PC');
}

// ── 2: a jammed CPU ignores IRQ (no vectoring, ever) ──────────────────
//
// This is the jamirq.prg scenario: a timer IRQ asserts long after the CPU
// has run into the JAM. A correct CPU never services it.
{
  const { cpu, mem } = makeCpu();
  mem.ram[0x0400] = 0x02;          // JAM
  clockUntilHalted(cpu);
  const pcAtJam = cpu.pc;

  cpu.I = 0;                       // interrupts unmasked
  cpu.setIrqLine(true);            // assert a pending IRQ
  for (let i = 0; i < 50; i++) cpu.clock();

  expect(cpu.pc === pcAtJam,
    `PC stayed at JAM ($${pcAtJam.toString(16)}), did not vector to IRQ; pc=$${cpu.pc.toString(16)}`);
  expect(cpu.pc !== 0x9000, `CPU did NOT enter the IRQ handler ($9000)`);
  expect(cpu.halted === true, `still halted with IRQ asserted`);
  ok('jammed CPU ignores a pending IRQ (jamirq.prg semantic)');
}

// ── 3: a jammed CPU ignores NMI (even though NMI bypasses the I flag) ──
//
// jamnmi.prg scenario. NMI is edge-triggered and normally cannot be
// masked — but a JAMmed CPU does not respond to it either.
{
  const { cpu, mem } = makeCpu();
  mem.ram[0x0400] = 0x02;          // JAM
  clockUntilHalted(cpu);
  const pcAtJam = cpu.pc;

  cpu.setNmiLine(true);            // rising edge → latched NMI
  expect(cpu.nmiEdge === true, `NMI edge latched`);
  for (let i = 0; i < 50; i++) cpu.clock();

  expect(cpu.pc === pcAtJam,
    `PC stayed at JAM ($${pcAtJam.toString(16)}), did not vector to NMI; pc=$${cpu.pc.toString(16)}`);
  expect(cpu.pc !== 0xA000, `CPU did NOT enter the NMI handler ($A000)`);
  expect(cpu.halted === true, `still halted with NMI asserted`);
  ok('jammed CPU ignores a pending NMI (jamnmi.prg semantic)');
}

// ── 4: staying jammed even when the opcode byte changes underneath ────
//
// unjam.prg places the JAM in a CIA timer high-byte that counts down. Once
// jammed, the CPU must NOT re-fetch and execute the byte's new value. We
// model that by rewriting the byte at PC to an RTS after the jam.
{
  const { cpu, mem } = makeCpu();
  mem.ram[0x0400] = 0x02;          // JAM
  clockUntilHalted(cpu);
  const pcAtJam = cpu.pc;

  // The "register" the JAM was read from now changes value (RTS).
  mem.ram[0x0400] = 0x60;          // RTS — must NOT be executed
  for (let i = 0; i < 50; i++) cpu.clock();

  expect(cpu.pc === pcAtJam,
    `PC frozen despite opcode byte change; pc=$${cpu.pc.toString(16)}`);
  expect(cpu.halted === true, `stayed halted (did not execute the new opcode)`);
  ok('jammed CPU stays jammed when the opcode byte changes (unjam.prg semantic)');
}

// ── 5: RESET is the only recovery (un-jam) ────────────────────────────
{
  const { cpu, mem } = makeCpu();
  mem.ram[0x0400] = 0x02;          // JAM
  clockUntilHalted(cpu);
  expect(cpu.halted === true, `halted before reset`);

  // New reset target at $0500 (NOP sled) so we can observe forward progress.
  mem.ram[0xFFFC] = 0x00; mem.ram[0xFFFD] = 0x05;
  cpu.reset();
  expect(cpu.halted === false, `RESET cleared halted`);
  expect(cpu.pc === 0x0500, `RESET vectored PC to $0500; pc=$${cpu.pc.toString(16)}`);

  for (let i = 0; i < 7; i++) cpu.clock();   // reset settle
  const pcAfterReset = cpu.pc;
  for (let i = 0; i < 10; i++) cpu.clock();   // should execute NOPs now
  expect(cpu.pc > pcAfterReset,
    `CPU resumed executing after reset (PC advanced $${pcAfterReset.toString(16)} → $${cpu.pc.toString(16)})`);
  expect(cpu.halted === false, `stayed un-halted after resuming`);
  ok('RESET recovers a jammed CPU and execution resumes');
}

// ── 6: IRQ acceptance is gated specifically by halted, not by chance ──
//
// Confirm the same CPU/IRQ setup DOES vector when NOT jammed — i.e. the
// block in test 2 is due to the halt, not a misconfigured fixture.
{
  const { cpu, mem } = makeCpu();
  mem.ram[0x0400] = 0xEA;          // NOP, not a JAM
  cpu.I = 0;
  cpu.setIrqLine(true);
  for (let i = 0; i < 20; i++) cpu.clock();
  expect(cpu.pc >= 0x9000 && cpu.pc < 0x9010,
    `un-jammed CPU DID vector to IRQ handler; pc=$${cpu.pc.toString(16)}`);
  expect(cpu.halted === false, `never halted (no JAM executed)`);
  ok('control: identical IRQ setup vectors normally without a JAM');
}

console.log(`\n${testNo} JAM halt/recovery tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
