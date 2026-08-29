// JMP / JMP indirect cycle accounting + NMOS quirk spec test.
//
// NMOS 6502:
//   JMP abs ($4C): 3 cycles (opcode + lo + hi → pc=target).
//   JMP ind ($6C): 5 cycles (opcode + lo + hi + read target_lo + read target_hi).
//
// NMOS quirk (the "JMP indirect bug"): when the pointer's low byte is
// $FF, the high byte read wraps within the SAME page instead of crossing
// to the next. E.g., JMP ($10FF) reads lo from $10FF and hi from $1000
// (NOT $1100). This bug was fixed in 65C02 but persists on NMOS.

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
  mem.ram[0xFFFC] = 0x00; mem.ram[0xFFFD] = 0x04;
  const cpu = new CPU(mem);
  cpu.reset();
  for (let i = 0; i < 7; i++) cpu.clock();
  cpu.I = 0;
  return { cpu, mem };
}

function parkAt(cpu, pc) {
  cpu.pc = pc;
  cpu.instructionCyclesRemaining = 0;
  cpu.microOpHead = 0;
  cpu.microOpLen = 0;
}

function runUntilDone(cpu, budget = 20) {
  let i = 0;
  while (i < budget) {
    cpu.clock();
    i++;
    if (cpu.instructionCyclesRemaining === 0) return i;
  }
  return -1;
}

// ── 1: JMP abs = 3 cycles, lands at target.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  mem.ram[0x1000] = 0x4C; mem.ram[0x1001] = 0x00; mem.ram[0x1002] = 0x80;
  const n = runUntilDone(cpu);
  expect(n === 3, `JMP abs: 3 cy; got ${n}`);
  expect(cpu.pc === 0x8000, `JMP abs: PC=$8000; got $${cpu.pc.toString(16)}`);
  ok('NMOS 6502: JMP abs = 3 cycles');
}

// ── 2: JMP indirect = 5 cycles, lands at pointer target.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  mem.ram[0x1000] = 0x6C; mem.ram[0x1001] = 0x00; mem.ram[0x1002] = 0x80; // JMP ($8000)
  mem.ram[0x8000] = 0x34; mem.ram[0x8001] = 0x12;                          // target $1234
  const n = runUntilDone(cpu);
  expect(n === 5, `JMP ind: 5 cy; got ${n}`);
  expect(cpu.pc === 0x1234, `JMP ind: PC=$1234; got $${cpu.pc.toString(16)}`);
  ok('NMOS 6502: JMP indirect = 5 cycles');
}

// ── 3: JMP indirect NMOS bug — pointer at $XXFF wraps high byte.
//
// JMP ($10FF): reads lo from $10FF, hi from $1000 (NOT $1100).
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x2000);
  mem.ram[0x2000] = 0x6C; mem.ram[0x2001] = 0xFF; mem.ram[0x2002] = 0x10; // JMP ($10FF)
  mem.ram[0x10FF] = 0x34;   // lo
  mem.ram[0x1000] = 0x12;   // hi (wraps: $1000, NOT $1100)
  mem.ram[0x1100] = 0xFF;   // sentinel: should NOT be read
  runUntilDone(cpu);
  expect(cpu.pc === 0x1234,
    `JMP ($10FF) NMOS bug: hi wraps to $1000, PC=$1234; got $${cpu.pc.toString(16)}`);
  expect(cpu.pc !== 0xFF34,
    `JMP ($10FF) did NOT read hi from $1100 (would give PC=$FF34)`);
  ok('NMOS 6502: JMP ($XXFF) bug — high byte wraps within page (NOT fixed until 65C02)');
}

// ── 4: JMP indirect bus-kind = 5× read.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  mem.ram[0x1000] = 0x6C; mem.ram[0x1001] = 0x00; mem.ram[0x1002] = 0x80;
  mem.ram[0x8000] = 0x34; mem.ram[0x8001] = 0x12;
  const kinds = [];
  for (let i = 0; i < 5; i++) {
    kinds.push(cpu.peekNextBusKind());
    cpu.clock();
  }
  for (let i = 0; i < 5; i++) {
    expect(kinds[i] === 'read', `JMP ind cy ${i+1} = read; got ${kinds[i]}`);
  }
  ok('NMOS 6502: JMP indirect bus-kind = 5× read (entire instruction stalls under BA)');
}

// ── 5: JMP abs bus-kind = 3× read.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  mem.ram[0x1000] = 0x4C; mem.ram[0x1001] = 0x00; mem.ram[0x1002] = 0x80;
  const kinds = [];
  for (let i = 0; i < 3; i++) {
    kinds.push(cpu.peekNextBusKind());
    cpu.clock();
  }
  for (let i = 0; i < 3; i++) {
    expect(kinds[i] === 'read', `JMP abs cy ${i+1} = read; got ${kinds[i]}`);
  }
  ok('NMOS 6502: JMP abs bus-kind = 3× read');
}

console.log(`\n${testNo} JMP indirect cycle + NMOS quirk spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
