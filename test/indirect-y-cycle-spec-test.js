// Indirect-Y addressing cycle accounting spec test.
//
// NMOS 6502: LDA ($zp),Y cycle counts and bus-kind:
//   cy 1: opcode fetch                  (read)
//   cy 2: zp addr fetch                 (read)
//   cy 3: read zp lo                    (read)
//   cy 4: read zp+1 hi                  (read)
//   cy 5: read base+Y (un-fixed addr)   (read; if page cross, this read is at wrong addr)
//   cy 6 (page cross only): read base+Y (corrected)  (read)
//
//   Total: 5 cy no page cross, 6 cy page cross.
//
// STA ($zp),Y always 6 cy. RMW (zp),Y doesn't exist on 6502.
//
// Indirect-Y is heavily used by handlers that index via a zero-page
// pointer (= cycle-counted demos using "$D018 etc." indirection). 5 cy
// of reads under BA can stall the entire instruction.

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

// ── 1: LDA ($zp),Y no page cross = 5 cycles.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  cpu.y = 0x10;
  // ZP pointer at $80: low=$00, high=$C0 → base $C000. Base+Y=$C010 (no cross).
  mem.ram[0x0080] = 0x00; mem.ram[0x0081] = 0xC0;
  mem.ram[0xC010] = 0x42;
  mem.ram[0x1000] = 0xB1; mem.ram[0x1001] = 0x80;            // LDA ($80),Y
  const n = runUntilDone(cpu);
  expect(n === 5,
    `LDA ($80),Y (Y=$10, no cross): 5 cy; got ${n}`);
  expect(cpu.a === 0x42, `LDA loaded $42; got $${cpu.a.toString(16)}`);
  ok('NMOS 6502: LDA (zp),Y no page cross = 5 cycles');
}

// ── 2: LDA ($zp),Y with page cross = 6 cycles.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  cpu.y = 0x01;
  // ZP pointer: $C0FF. Base+Y = $C100 (page cross).
  mem.ram[0x0080] = 0xFF; mem.ram[0x0081] = 0xC0;
  mem.ram[0xC100] = 0x55;
  mem.ram[0x1000] = 0xB1; mem.ram[0x1001] = 0x80;
  const n = runUntilDone(cpu);
  expect(n === 6,
    `LDA ($80),Y (Y=$01, page cross): 6 cy; got ${n}`);
  expect(cpu.a === 0x55, `LDA loaded $55; got $${cpu.a.toString(16)}`);
  ok('NMOS 6502: LDA (zp),Y page cross = 6 cycles');
}

// ── 3: STA ($zp),Y ALWAYS 6 cycles (no page-cross discount).
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  cpu.y = 0x10;
  cpu.a = 0x42;
  mem.ram[0x0080] = 0x00; mem.ram[0x0081] = 0xC0;
  mem.ram[0x1000] = 0x91; mem.ram[0x1001] = 0x80;
  const n = runUntilDone(cpu);
  expect(n === 6,
    `STA ($80),Y (Y=$10, no cross): 6 cy unconditional; got ${n}`);
  expect(mem.ram[0xC010] === 0x42, `STA stored $42; got $${mem.ram[0xC010].toString(16)}`);
  ok('NMOS 6502: STA (zp),Y = 6 cycles always (write unconditional dummy fetch)');
}

// ── 4: Bus-kind sequence for LDA (zp),Y no page cross = 5× read.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  cpu.y = 0x10;
  mem.ram[0x0080] = 0x00; mem.ram[0x0081] = 0xC0;
  mem.ram[0xC010] = 0x42;
  mem.ram[0x1000] = 0xB1; mem.ram[0x1001] = 0x80;
  const kinds = [];
  for (let i = 0; i < 5; i++) {
    kinds.push(cpu.peekNextBusKind());
    cpu.clock();
  }
  for (let i = 0; i < 5; i++) {
    expect(kinds[i] === 'read',
      `LDA (zp),Y cy ${i+1}: read; got ${kinds[i]}`);
  }
  ok('NMOS 6502: LDA (zp),Y bus-kind = 5× read (all stallable under BA-low)');
}

// ── 5: Indirect-Y zp-wraparound — pointer at $FF reads zp $FF + zp $00.
//
// 6502 quirk: when zp pointer is at $FF, the high byte fetch wraps to
// $00 (NOT $0100). This is a "feature" of zero-page indirect.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  cpu.y = 0x00;
  mem.ram[0x00FF] = 0x00;      // low byte
  mem.ram[0x0000] = 0xC0;      // high byte (wraps from $FF → $00, NOT $0100)
  mem.ram[0xC000] = 0x99;
  mem.ram[0x1000] = 0xB1; mem.ram[0x1001] = 0xFF;
  runUntilDone(cpu);
  expect(cpu.a === 0x99,
    `LDA ($FF),Y wraps zp: reads pointer from $FF/$00 → $C000 → $99; got $${cpu.a.toString(16)}`);
  ok('NMOS 6502: LDA (zp),Y at zp=$FF wraps high-byte to zp $00 (zero-page boundary quirk)');
}

console.log(`\n${testNo} indirect-Y cycle accounting spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
