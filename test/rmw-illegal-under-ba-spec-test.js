// RMW illegal opcodes under BA-low spec test.
//
// NMOS 6502 illegal RMW opcodes: SLO/RLA/SRE/RRA/DCP/ISC (and their
// indexed variants). All combine an ALU op with the standard RMW
// pattern:
//   cy 1: opcode fetch  (read)
//   cy 2: addr lo       (read)
//   cy 3: addr hi       (read)
//   cy 4: value read    (read)
//   cy 5: dummy write   (write)  — old value
//   cy 6: real write    (write)  — modified value
//
// (zp variants drop addr-hi → 5 cy; indexed +X variants add a +X fix
// → 7 cy; zp,X variants are 6 cy.)
//
// Under BA-low: reads stall, writes proceed. The 4 read cycles can
// stall but cycles 5-6 (writes) proceed once reached.
//
// Audit gap: illegal-opcode-cycle-audit tests them in isolation. This
// adds the BA-interaction scenario.

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

// ── 1: SLO abs ($0F) = 6 cy. SLO = ASL + ORA into A.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  cpu.a = 0x01;
  mem.ram[0x1000] = 0x0F; mem.ram[0x1001] = 0x00; mem.ram[0x1002] = 0xC0;
  mem.ram[0xC000] = 0x40;
  const n = runUntilDone(cpu);
  expect(n === 6, `SLO abs: 6 cy; got ${n}`);
  // SLO: $40 << 1 = $80. mem[$C000] = $80. A = $01 | $80 = $81.
  expect(mem.ram[0xC000] === 0x80, `SLO mem result: $80; got $${mem.ram[0xC000].toString(16)}`);
  expect(cpu.a === 0x81, `SLO A result: $81; got $${cpu.a.toString(16)}`);
  ok('NMOS illegal: SLO abs = 6 cycles (ASL+ORA)');
}

// ── 2: SLO abs bus-kind sequence = read,read,read,read,write,write.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  mem.ram[0x1000] = 0x0F; mem.ram[0x1001] = 0x00; mem.ram[0x1002] = 0xC0;
  mem.ram[0xC000] = 0x40;
  const kinds = [];
  for (let i = 0; i < 6; i++) {
    kinds.push(cpu.peekNextBusKind());
    cpu.clock();
  }
  const expected = ['read', 'read', 'read', 'read', 'write', 'write'];
  for (let i = 0; i < 6; i++) {
    expect(kinds[i] === expected[i],
      `SLO cy ${i+1}: ${expected[i]}; got ${kinds[i]}`);
  }
  ok('NMOS illegal: SLO bus-kind = 4× read + 2× write (RMW pattern)');
}

// ── 3: DCP abs ($CF) = 6 cy. DCP = DEC + CMP A.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  cpu.a = 0x07;
  mem.ram[0x1000] = 0xCF; mem.ram[0x1001] = 0x00; mem.ram[0x1002] = 0xC0;
  mem.ram[0xC000] = 0x10;
  const n = runUntilDone(cpu);
  expect(n === 6, `DCP abs: 6 cy; got ${n}`);
  // DCP: mem $10 → $0F. CMP A=$07 vs $0F → A<M → C=0, N=1 (= ($07-$0F)&0xFF=$F8 = 1111_1000).
  expect(mem.ram[0xC000] === 0x0F, `DCP mem: $0F; got $${mem.ram[0xC000].toString(16)}`);
  expect(cpu.C === 0, `DCP C: A=$07 < M=$0F → C=0`);
  ok('NMOS illegal: DCP abs = 6 cycles (DEC+CMP)');
}

// ── 4: ISC zp ($E7) = 5 cy. ISC = INC + SBC.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  cpu.a = 0x10;
  cpu.C = 1;
  cpu.D = 0;
  mem.ram[0x1000] = 0xE7; mem.ram[0x1001] = 0x80;
  mem.ram[0x0080] = 0x05;
  const n = runUntilDone(cpu);
  expect(n === 5, `ISC zp: 5 cy; got ${n}`);
  // ISC: mem $05 → $06. SBC A=$10 - $06 - (1-C=0) = $0A.
  expect(mem.ram[0x0080] === 0x06, `ISC mem: $06; got $${mem.ram[0x0080].toString(16)}`);
  expect(cpu.a === 0x0A, `ISC A=$10-$06=$0A; got $${cpu.a.toString(16)}`);
  ok('NMOS illegal: ISC zp = 5 cycles (INC+SBC)');
}

// ── 5: RLA abs ($2F) = 6 cy. RLA = ROL + AND A.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  cpu.a = 0xFF;
  cpu.C = 1;
  mem.ram[0x1000] = 0x2F; mem.ram[0x1001] = 0x00; mem.ram[0x1002] = 0xC0;
  mem.ram[0xC000] = 0x80;
  const n = runUntilDone(cpu);
  expect(n === 6, `RLA abs: 6 cy; got ${n}`);
  // RLA: mem $80 ROL with C=1 → $01, new C=1. A = $FF & $01 = $01.
  expect(mem.ram[0xC000] === 0x01, `RLA mem: $01; got $${mem.ram[0xC000].toString(16)}`);
  expect(cpu.a === 0x01, `RLA A: $01; got $${cpu.a.toString(16)}`);
  ok('NMOS illegal: RLA abs = 6 cycles (ROL+AND)');
}

// ── 6: SRE abs ($4F) = 6 cy. SRE = LSR + EOR A.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  cpu.a = 0xFF;
  mem.ram[0x1000] = 0x4F; mem.ram[0x1001] = 0x00; mem.ram[0x1002] = 0xC0;
  mem.ram[0xC000] = 0x80;
  const n = runUntilDone(cpu);
  expect(n === 6, `SRE abs: 6 cy; got ${n}`);
  // SRE: $80 LSR → $40 (C=0). A = $FF EOR $40 = $BF.
  expect(mem.ram[0xC000] === 0x40, `SRE mem: $40; got $${mem.ram[0xC000].toString(16)}`);
  expect(cpu.a === 0xBF, `SRE A: $BF; got $${cpu.a.toString(16)}`);
  ok('NMOS illegal: SRE abs = 6 cycles (LSR+EOR)');
}

// ── 7: RRA abs ($6F) = 6 cy. RRA = ROR + ADC.
{
  const { cpu, mem } = makeCpu();
  parkAt(cpu, 0x1000);
  cpu.a = 0x10;
  cpu.C = 0;
  cpu.D = 0;
  mem.ram[0x1000] = 0x6F; mem.ram[0x1001] = 0x00; mem.ram[0x1002] = 0xC0;
  mem.ram[0xC000] = 0x02;
  const n = runUntilDone(cpu);
  expect(n === 6, `RRA abs: 6 cy; got ${n}`);
  // RRA: $02 ROR with C=0 → $01, new C=0. A = $10 + $01 + 0 = $11.
  expect(mem.ram[0xC000] === 0x01, `RRA mem: $01; got $${mem.ram[0xC000].toString(16)}`);
  expect(cpu.a === 0x11, `RRA A: $11; got $${cpu.a.toString(16)}`);
  ok('NMOS illegal: RRA abs = 6 cycles (ROR+ADC)');
}

console.log(`\n${testNo} RMW illegal opcode spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
