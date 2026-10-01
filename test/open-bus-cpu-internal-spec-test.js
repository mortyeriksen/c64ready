// CPU internal-cycle bus visibility spec.
//
// Per Bauer + the spec, the 6510 performs a real bus access every clock
// cycle, including KIND_INTERNAL microops (reset settle, HALT spin). Our
// CPU dispatcher synthesizes a discarded read at PC for such cycles.
//
// This test counts memory reads across a HALT cycle and across the reset
// settle to confirm internal cycles actually touch the bus.

import { CPU } from '../src/cpu.js';

let testNo = 0, testsFailing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else {
    testsFailing++;
    console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`);
    currentFailures = [];
  }
}

class CountingMemory {
  constructor() {
    this.ram = new Uint8Array(0x10000);
    this.reads = 0;
    this.writes = 0;
    this.lastReadAddr = -1;
  }
  read(a) {
    this.reads++;
    this.lastReadAddr = a & 0xFFFF;
    return this.ram[a & 0xFFFF];
  }
  write(a, v) {
    this.writes++;
    this.ram[a & 0xFFFF] = v & 0xFF;
  }
}

// 1. Reset settle: each of the 7 internal cycles after reset should
//    perform exactly one bus read (the discarded PC re-fetch).
{
  const mem = new CountingMemory();
  mem.ram[0xFFFC] = 0x00; mem.ram[0xFFFD] = 0x10; // reset vector
  // Place NOPs at $1000 so the first instruction fetch finds something.
  for (let i = 0; i < 0x100; i++) mem.ram[0x1000 + i] = 0xEA;
  const cpu = new CPU(mem);
  cpu.reset();
  // reset() itself reads $FFFC/$FFFD synchronously (2 reads).
  const baseReads = mem.reads;
  for (let i = 0; i < 7; i++) cpu.clock();
  const settleReads = mem.reads - baseReads;
  expect(settleReads === 7, `expected 7 internal-cycle reads, got ${settleReads}`);
  ok('reset settle: 7 internal cycles each bus-read');
}

// A two-cycle NOP performs exactly two reads.
{
  function countNopReads() {
    const mem = new CountingMemory();
    mem.ram[0xFFFC] = 0x00; mem.ram[0xFFFD] = 0x10;
    for (let i = 0; i < 0x100; i++) mem.ram[0x1000 + i] = 0xEA;
    const cpu = new CPU(mem);
    cpu.reset();
    for (let i = 0; i < 7; i++) cpu.clock();
    cpu.I = 0;
    const base = mem.reads;
    cpu.clock(); cpu.clock();
    return mem.reads - base;
  }
  const reads = countNopReads();
  expect(reads === 2, `6502 NOP takes two read cycles, got ${reads}`);
  ok('NOP performs its two bus reads without an extra internal read');
}

if (testsFailing === 0) console.log(`\nAll ${testNo} tests passed.`);
else { console.log(`\n${testsFailing}/${testNo} tests FAILED.`); process.exit(1); }
