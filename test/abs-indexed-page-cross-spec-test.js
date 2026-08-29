// Absolute,X / Absolute,Y page-cross cycle accounting spec test.
//
// NMOS 6502: LDA abs,X (and similar) cycle counts:
//   4 cy if (base + X) does NOT cross a page boundary
//   5 cy if it DOES cross
//
// The extra cycle is a "dummy read" at the WRONG page-byte address
// (= base_lo + X mod 256, base_hi unchanged) followed by the corrected
// fetch. This is the 6502's "phantom read" — observable if the dummy
// address has read side effects (e.g., $D019 clear-on-read).
//
// STA abs,X (and similar write-instructions) ALWAYS take 5 cycles
// regardless of page-cross — the dummy fetch happens unconditionally
// because the write address must be settled before the actual write.
//
// Under BA-low, the dummy reads stall. Variable page-cross cycle drift
// could be a source of handler-cycle accumulation across BA windows.
//
// Audit gap: page-cross cycle accounting — covered partially by
// cpu-page-cross-spec-test.js but worth a focused per-instruction test
// confirming the +1 cycle for read instructions only.

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

// ── 1: LDA $C000,X with X=$10 (no page cross) = 4 cycles.
// (Read base $C010 — same page as $C000.)
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  cpu.x = 0x10;
  mem.ram[0x1000] = 0xBD; mem.ram[0x1001] = 0x00; mem.ram[0x1002] = 0xC0; // LDA $C000,X
  mem.ram[0xC010] = 0x42;
  const n = runUntilDone(cpu);
  expect(n === 4,
    `LDA $C000,X (X=$10, no page cross): 4 cy; got ${n}`);
  expect(cpu.a === 0x42, `LDA loaded $42; got $${cpu.a.toString(16)}`);
  ok('NMOS 6502: LDA abs,X no page cross = 4 cycles');
}

// ── 2: LDA $C0FF,X with X=$01 (page crosses from $C0 to $C1) = 5 cycles.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  cpu.x = 0x01;
  mem.ram[0x1000] = 0xBD; mem.ram[0x1001] = 0xFF; mem.ram[0x1002] = 0xC0; // LDA $C0FF,X
  mem.ram[0xC100] = 0x55;
  const n = runUntilDone(cpu);
  expect(n === 5,
    `LDA $C0FF,X (X=$01, page cross): 5 cy; got ${n}`);
  expect(cpu.a === 0x55, `LDA loaded $55; got $${cpu.a.toString(16)}`);
  ok('NMOS 6502: LDA abs,X page cross = 5 cycles');
}

// ── 3: LDA abs,Y same rule (no page cross = 4, page cross = 5).
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  cpu.y = 0x10;
  mem.ram[0x1000] = 0xB9; mem.ram[0x1001] = 0x00; mem.ram[0x1002] = 0xC0; // LDA $C000,Y
  mem.ram[0xC010] = 0x42;
  const n = runUntilDone(cpu);
  expect(n === 4,
    `LDA $C000,Y (Y=$10, no cross): 4 cy; got ${n}`);

  const m2 = makeCpu();
  parkAt(m2.cpu, 0x1000);
  m2.cpu.y = 0x01;
  m2.mem.ram[0x1000] = 0xB9; m2.mem.ram[0x1001] = 0xFF; m2.mem.ram[0x1002] = 0xC0; // LDA $C0FF,Y
  m2.mem.ram[0xC100] = 0x55;
  const n2 = runUntilDone(m2.cpu);
  expect(n2 === 5,
    `LDA $C0FF,Y (Y=$01, page cross): 5 cy; got ${n2}`);
  ok('NMOS 6502: LDA abs,Y follows same 4/5-cycle rule');
}

// ── 4: STA abs,X ALWAYS takes 5 cycles (no page-cross discount).
//
// Write instructions can't short-circuit because the address must be
// fully resolved before writing. The dummy fetch fires unconditionally.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  cpu.x = 0x10;
  cpu.a = 0x42;
  mem.ram[0x1000] = 0x9D; mem.ram[0x1001] = 0x00; mem.ram[0x1002] = 0xC0; // STA $C000,X
  const n = runUntilDone(cpu);
  expect(n === 5,
    `STA $C000,X (X=$10, no cross): 5 cy (unconditional); got ${n}`);
  expect(mem.ram[0xC010] === 0x42,
    `STA stored $42 at $C010; got $${mem.ram[0xC010].toString(16)}`);

  const m2 = makeCpu();
  parkAt(m2.cpu, 0x1000);
  m2.cpu.x = 0x01;
  m2.cpu.a = 0x55;
  m2.mem.ram[0x1000] = 0x9D; m2.mem.ram[0x1001] = 0xFF; m2.mem.ram[0x1002] = 0xC0;
  const n2 = runUntilDone(m2.cpu);
  expect(n2 === 5,
    `STA $C0FF,X (X=$01, page cross): still 5 cy (no extra); got ${n2}`);
  ok('NMOS 6502: STA abs,X = 5 cycles always (page-cross is unconditional for writes)');
}

// ── 5: RMW abs,X (INC abs,X) = 7 cycles ALWAYS.
//
// INC $C000,X: opcode, lo, hi, dummy-read base+X, read at (base+X)
// + carry fix, dummy-write old value, real-write new value.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  cpu.x = 0x10;
  mem.ram[0x1000] = 0xFE; mem.ram[0x1001] = 0x00; mem.ram[0x1002] = 0xC0; // INC $C000,X
  mem.ram[0xC010] = 0x05;
  const n = runUntilDone(cpu);
  expect(n === 7,
    `INC $C000,X (X=$10, no cross): 7 cy; got ${n}`);
  expect(mem.ram[0xC010] === 0x06, `INC: $05 → $06; got $${mem.ram[0xC010].toString(16)}`);

  const m2 = makeCpu();
  parkAt(m2.cpu, 0x1000);
  m2.cpu.x = 0x01;
  m2.mem.ram[0x1000] = 0xFE; m2.mem.ram[0x1001] = 0xFF; m2.mem.ram[0x1002] = 0xC0;
  m2.mem.ram[0xC100] = 0x05;
  const n2 = runUntilDone(m2.cpu);
  expect(n2 === 7,
    `INC $C0FF,X (X=$01, page cross): 7 cy (RMW unconditional); got ${n2}`);
  ok('NMOS 6502: INC abs,X = 7 cycles always (RMW with unconditional page-fix)');
}

console.log(`\n${testNo} abs-indexed page-cross spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
