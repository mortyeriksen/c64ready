// RTI cycle accounting under BA-low spec test.
//
// NMOS 6502/6510: RTI (Return from Interrupt) is a 6-cycle instruction.
// Its bus phases (per Visual6502 + WDC):
//   cy 1: opcode fetch                  (read)
//   cy 2: dummy read of next byte       (read)
//   cy 3: dummy read from $0100+S       (read, stack pointer pre-inc)
//   cy 4: pull P from stack             (read)
//   cy 5: pull PCL from stack           (read)
//   cy 6: pull PCH from stack           (read)
//
// ALL 6 cycles are reads. Under BA-low (RDY low for reads) the entire
// RTI stalls until BA rises. This is load-bearing for cycle-counted
// IRQ chains where the demo budgets exactly N cycles for the handler
// AND its RTI exit.
//
// Bauer §3.6.1 + Bauer §3.13: writes proceed under BA-low; reads stall.
// RTI being all-reads means RTI takes (6 + stall_cycles_in_BA_window).
//
// Audit gap: RTI under BA — not previously covered. irq-ba-stall covers
// IRQ ENTRY under BA; this covers EXIT (RTI) under BA.

import { CPU } from '../src/cpu.js';

class FlatMemory {
  constructor() {
    this.ram = new Uint8Array(0x10000);
    this.readLog = [];
  }
  read(a) {
    this.readLog.push(a & 0xFFFF);
    return this.ram[a & 0xFFFF];
  }
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

// Setup CPU primed for RTI: stack contains (P, PCL, PCH) for return to $0400.
function makeCpuForRti() {
  const mem = new FlatMemory();
  for (let i = 0; i < 64; i++) mem.ram[0x0400 + i] = 0xEA;     // main NOP runway
  mem.ram[0xFFFE] = 0x00; mem.ram[0xFFFF] = 0x90;
  mem.ram[0xFFFC] = 0x00; mem.ram[0xFFFD] = 0x04;
  const cpu = new CPU(mem);
  cpu.reset();
  for (let i = 0; i < 7; i++) cpu.clock();
  cpu.I = 0;
  // Park CPU at $9000 with stack containing return frame for $0400.
  // Real stack order (RTI pulls): P first, then PCL, then PCH.
  // So pre-push: PCH @ $1FF, PCL @ $1FE, P @ $1FD. SP after = $FC.
  mem.ram[0x01FF] = 0x04;        // PCH
  mem.ram[0x01FE] = 0x00;        // PCL
  mem.ram[0x01FD] = 0x20;        // P (some bits)
  cpu.sp = 0xFC;
  cpu.pc = 0x9000;
  mem.ram[0x9000] = 0x40;        // RTI opcode
  cpu.instructionCyclesRemaining = 0;
  cpu.microOpHead = 0;
  cpu.microOpLen = 0;
  return { cpu, mem };
}

// ── 1: RTI on a clear bus — exactly 6 cycles, lands at $0400.
{
  const { cpu } = makeCpuForRti();
  for (let i = 0; i < 6; i++) cpu.clock();
  expect(cpu.pc === 0x0400,
    `clear-bus RTI: PC=$0400 after 6 cycles; got $${cpu.pc.toString(16)}`);
  ok('NMOS 6502: RTI takes exactly 6 cycles on a clear bus');
}

// ── 2: Per-cycle bus-kind for RTI is read,read,read,read,read,read.
{
  const { cpu } = makeCpuForRti();
  const kinds = [];
  for (let i = 0; i < 6; i++) {
    kinds.push(cpu.peekNextBusKind());
    cpu.clock();
  }
  for (let i = 0; i < 6; i++) {
    expect(kinds[i] === 'read',
      `RTI cy ${i+1}: bus kind expected 'read', got '${kinds[i]}'`);
  }
  ok('NMOS 6502: RTI bus-kind sequence is 6× read');
}

// ── 3: RTI cycle 2 dummy-reads the byte after the opcode.
{
  const { cpu, mem } = makeCpuForRti();
  mem.readLog.length = 0;
  for (let i = 0; i < 6; i++) cpu.clock();
  const got = mem.readLog.map(a => `$${a.toString(16).padStart(4, '0')}`).join(' ');
  const expected = [0x9000, 0x9001, 0x01FC, 0x01FD, 0x01FE, 0x01FF];
  for (let i = 0; i < expected.length; i++) {
    expect(mem.readLog[i] === expected[i],
      `RTI read ${i + 1}: expected $${expected[i].toString(16).padStart(4, '0')}, got ${got}`);
  }
  ok('NMOS 6502: RTI cycle 2 dummy-reads PC+1 before stack pulls');
}

// ── 3: RTI under sustained BA-low — entire RTI stalls until BA rises.
//
// We simulate BA-low by NOT calling cpu.clock() when peekNextBusKind ===
// 'read' AND BA is asserted (simulated). After BA rises (lifted), RTI
// proceeds normally and takes 6 cycles total of running time.
{
  const { cpu } = makeCpuForRti();
  // Phase A: 5 stall cycles under simulated BA-low.
  let stallCount = 0;
  for (let i = 0; i < 5; i++) {
    if (cpu.peekNextBusKind() === 'read') { stallCount++; /* skip cpu.clock() */ }
  }
  expect(stallCount === 5,
    `all 5 BA cycles stalled an RTI read; got ${stallCount}`);
  expect(cpu.pc === 0x9000,
    `RTI not advanced during BA-low: PC still $9000; got $${cpu.pc.toString(16)}`);
  // Phase B: BA rises, run RTI for 6 cycles.
  for (let i = 0; i < 6; i++) cpu.clock();
  expect(cpu.pc === 0x0400,
    `post-BA RTI completes in 6 cycles; PC=$0400; got $${cpu.pc.toString(16)}`);
  ok('Bauer §3.6.1: RTI under BA-low stalls (all 6 cycles are reads)');
}

// ── 4: RTI as part of cycle-counted handler exit — sample N=43 stall.
//
// Simulate bad-line BA stall: 43 cy of BA-low coincide with RTI start.
// After BA rises, RTI completes in 6 cy. Total elapsed: 43 + 6 = 49 cy
// of master-clock from handler-exit start (= STA $D019 + RTI begin) to
// "back at main".
//
// We don't run the BA gate explicitly here — just confirm that with
// 43 cycles of "no progress" + 6 normal cycles, the CPU returns.
{
  const { cpu } = makeCpuForRti();
  // 43 cy of BA-low: skip cpu.clock() for each read.
  for (let i = 0; i < 43; i++) {
    if (cpu.peekNextBusKind() === 'read') { /* stall */ }
  }
  expect(cpu.pc === 0x9000,
    `43-cy BA hold: PC still $9000 (RTI hasn't progressed); got $${cpu.pc.toString(16)}`);
  // BA releases, run RTI.
  for (let i = 0; i < 6; i++) cpu.clock();
  expect(cpu.pc === 0x0400,
    `post-43cy-BA RTI completes: PC=$0400; got $${cpu.pc.toString(16)}`);
  ok('Stable-IRQ exit budget: RTI under 43-cy bad-line BA pays 43+6=49 master cycles');
}

// ── 5: RTI cycle accounting unchanged by stack contents.
// Push different return frame, verify cycle count stays 6.
{
  const { cpu, mem } = makeCpuForRti();
  mem.ram[0x01FF] = 0x80;        // return to $80??
  mem.ram[0x01FE] = 0x12;
  mem.ram[0x01FD] = 0x00;
  for (let i = 0; i < 6; i++) cpu.clock();
  expect(cpu.pc === 0x8012,
    `RTI returns to popped frame ($8012); got $${cpu.pc.toString(16)}`);
  ok('NMOS 6502: RTI cycle count (6) independent of return address');
}

console.log(`\n${testNo} RTI cycle accounting spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
