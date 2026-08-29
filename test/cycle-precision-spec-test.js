// Verify per-instruction cycle counts for the specific opcodes the
// OrbitUntold polling loop uses. If any opcode is off by 1 cycle, that
// single error compounds over millions of iterations.
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

function runInstruction(opcodeBytes, expectedCycles, setup) {
  const mem = new FlatMemory();
  // Reset vector → $0400
  mem.ram[0xFFFC] = 0x00; mem.ram[0xFFFD] = 0x04;
  for (let i = 0; i < opcodeBytes.length; i++) mem.ram[0x0400 + i] = opcodeBytes[i];
  const cpu = new CPU(mem);
  cpu.reset();
  // Consume 7 reset dummies
  for (let i = 0; i < 7; i++) cpu.clock();
  if (setup) setup(cpu, mem);
  // Now CPU is at $0400 instruction boundary. Count cycles to next boundary.
  let cycles = 0;
  const startPc = cpu.pc;
  while (cycles < 30) {
    cpu.clock();
    cycles++;
    if (cpu.atInstructionBoundary() && cpu.pc !== startPc) break;
  }
  return cycles;
}

// CMP $D012 (4 cycles, no page-cross)
{
  const cyc = runInstruction([0xCD, 0x12, 0xD0]);
  expect(cyc === 4, `CMP $D012 must be 4 cycles, got ${cyc}`);
  ok('CMP abs (CMP $D012) = 4 cycles');
}

// BNE not-taken (2 cycles)
{
  const cyc = runInstruction([0xD0, 0x10], null, (cpu) => { cpu.Z = 1; });
  expect(cyc === 2, `BNE not-taken must be 2 cycles, got ${cyc}`);
  ok('BNE not-taken = 2 cycles');
}

// BNE taken, no page-cross (3 cycles)
{
  const cyc = runInstruction([0xD0, 0x05], null, (cpu) => { cpu.Z = 0; });
  expect(cyc === 3, `BNE taken (no page cross) must be 3 cycles, got ${cyc}`);
  ok('BNE taken = 3 cycles');
}

// BNE taken, page-cross BACKWARD (-5 from $0402 → $03FD)
{
  const cyc = runInstruction([0xD0, 0xFB], null, (cpu) => { cpu.Z = 0; });
  expect(cyc === 4, `BNE taken (page cross) must be 4 cycles, got ${cyc}`);
  ok('BNE taken with page-cross = 4 cycles');
}

// LDA abs,X no cross (4 cycles)
{
  const cyc = runInstruction([0xBD, 0x00, 0x05], null, (cpu) => { cpu.x = 0x10; });
  expect(cyc === 4, `LDA abs,X no cross must be 4 cycles, got ${cyc}`);
  ok('LDA abs,X (no page cross) = 4 cycles');
}

// LDA abs,X with cross (5 cycles)
{
  const cyc = runInstruction([0xBD, 0xFF, 0x04], null, (cpu) => { cpu.x = 0x10; });
  expect(cyc === 5, `LDA abs,X page-cross must be 5 cycles, got ${cyc}`);
  ok('LDA abs,X (page cross) = 5 cycles');
}

// STA abs (4 cycles)
{
  const cyc = runInstruction([0x8D, 0x00, 0x40]);
  expect(cyc === 4, `STA abs must be 4 cycles, got ${cyc}`);
  ok('STA abs = 4 cycles');
}

// STA abs,X always 5 cycles (no page-cross optimization on stores)
{
  const cyc = runInstruction([0x9D, 0xFF, 0x04], null, (cpu) => { cpu.x = 0x10; });
  expect(cyc === 5, `STA abs,X must be 5 cycles, got ${cyc}`);
  ok('STA abs,X = 5 cycles (no page-cross optimization)');
}

// INC abs (6 cycles RMW)
{
  const cyc = runInstruction([0xEE, 0x00, 0x40]);
  expect(cyc === 6, `INC abs must be 6 cycles, got ${cyc}`);
  ok('INC abs = 6 cycles');
}

// DEC abs (6 cycles RMW)
{
  const cyc = runInstruction([0xCE, 0x00, 0x40]);
  expect(cyc === 6, `DEC abs must be 6 cycles, got ${cyc}`);
  ok('DEC abs = 6 cycles');
}

// JSR (6 cycles)
{
  const cyc = runInstruction([0x20, 0x10, 0x05]);
  expect(cyc === 6, `JSR must be 6 cycles, got ${cyc}`);
  ok('JSR = 6 cycles');
}

// JMP abs (3 cycles)
{
  const cyc = runInstruction([0x4C, 0x10, 0x05]);
  expect(cyc === 3, `JMP abs must be 3 cycles, got ${cyc}`);
  ok('JMP abs = 3 cycles');
}

// LDA imm (2 cycles)
{
  const cyc = runInstruction([0xA9, 0x42]);
  expect(cyc === 2, `LDA imm must be 2 cycles, got ${cyc}`);
  ok('LDA imm = 2 cycles');
}

// STA zp (3 cycles)
{
  const cyc = runInstruction([0x85, 0x10]);
  expect(cyc === 3, `STA zp must be 3 cycles, got ${cyc}`);
  ok('STA zp = 3 cycles');
}

// STA abs,Y always 5 cycles
{
  const cyc = runInstruction([0x99, 0xFF, 0x04], null, (cpu) => { cpu.y = 0x10; });
  expect(cyc === 5, `STA abs,Y must be 5 cycles, got ${cyc}`);
  ok('STA abs,Y = 5 cycles (no page-cross optimization)');
}

// LDX #imm (2 cycles)
{
  const cyc = runInstruction([0xA2, 0x42]);
  expect(cyc === 2, `LDX imm must be 2 cycles, got ${cyc}`);
  ok('LDX imm = 2 cycles');
}

// CPX imm (2 cycles)
{
  const cyc = runInstruction([0xE0, 0x42]);
  expect(cyc === 2, `CPX imm must be 2 cycles, got ${cyc}`);
  ok('CPX imm = 2 cycles');
}

// ASL zp (5 cycles RMW)
{
  const cyc = runInstruction([0x06, 0x10]);
  expect(cyc === 5, `ASL zp must be 5 cycles, got ${cyc}`);
  ok('ASL zp = 5 cycles');
}

// ROL A (2 cycles)
{
  const cyc = runInstruction([0x2A]);
  expect(cyc === 2, `ROL A must be 2 cycles, got ${cyc}`);
  ok('ROL A = 2 cycles');
}

console.log(`\n${testNo} cycle-precision tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
