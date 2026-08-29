// Comprehensive 6502 LEGAL-opcode cycle-count audit. The illegal-opcode
// audit covers $03/$07/$0B/.../$FB; this one covers documented opcodes
// — the same instructions Klaus runs but isolated per-instruction so a
// timing-only bug shows up directly.
//
// Cycle table from Synertek SY6502 datasheet + MOS 6510 datasheet,
// corroborated by Bauer §3.5 and the 6502 reference manual:
//
//   addressing mode           load    store    R-M-W
//   ──────────────────────────────────────────────────
//   imm                          2       —        —
//   zp                           3       3        5
//   zp,X / zp,Y                  4       4        6
//   abs                          4       4        6
//   abs,X (load, no cross)       4       —        —
//   abs,X (load, page cross)     5       —        —
//   abs,X (store)                —       5        —      (always 5, no +1)
//   abs,X (R-M-W)                —       —        7
//   abs,Y (load, no cross)       4       —        —
//   abs,Y (load, page cross)     5       —        —
//   abs,Y (store)                —       5        —
//   (zp,X)                       6       6        —
//   (zp),Y (load, no cross)      5       —        —
//   (zp),Y (load, page cross)    6       —        —
//   (zp),Y (store)               —       6        —
//   branches: 2 not-taken, 3 taken-no-cross, 4 taken-page-cross
//   JMP abs = 3, JMP (abs) = 5
//   JSR = 6, RTS = 6, RTI = 6, BRK = 7
//   PHA/PHP = 3, PLA/PLP = 4
//   CLI/SEI/CLC/SEC/CLV/CLD/SED, INX/DEX/INY/DEY, TAX/TXA/etc, NOP = 2

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

function runOpcode(opcode, op1 = 0, op2 = 0, init = (cpu, mem) => {}) {
  const mem = new FlatMemory();
  mem.ram[0x0400] = opcode;
  mem.ram[0x0401] = op1;
  mem.ram[0x0402] = op2;
  // (zp,X) and (zp),Y pointer fixtures
  mem.ram[0x0040] = 0x00; mem.ram[0x0041] = 0x05;     // zp $40 → $0500
  mem.ram[0x0044] = 0x00; mem.ram[0x0045] = 0x05;     // zp $44 → $0500
  mem.ram[0x0046] = 0xFF; mem.ram[0x0047] = 0x05;     // zp $46 → $05FF (cross w/ Y=1)
  mem.ram[0x0500] = 0x77;
  mem.ram[0x0600] = 0x99;
  const cpu = new CPU(mem);
  cpu.pc = 0x0400; cpu.sp = 0xFF;
  cpu.a = 0; cpu.x = 0; cpu.y = 0;
  init(cpu, mem);
  let cycles = 0;
  while (cycles < 20) {
    cpu.clock();
    cycles++;
    if (cpu.atInstructionBoundary()) break;
  }
  return cycles;
}

function check(opcode, op1, op2, init, expected, label) {
  const c = runOpcode(opcode, op1, op2, init);
  expect(c === expected, `$${opcode.toString(16).toUpperCase()} ${label}: expected ${expected}, got ${c}`);
}

// ── 1: Branches not taken = 2 cycles each ─────────────────────────────
// BPL/BMI/BVC/BVS/BCC/BCS/BNE/BEQ. With flag set NOT to take.
{
  // BPL ($10): not-taken when N=1
  check(0x10, 0x10, 0, (cpu) => { cpu.N = 1; }, 2, 'BPL not-taken');
  // BMI ($30): not-taken when N=0
  check(0x30, 0x10, 0, (cpu) => { cpu.N = 0; }, 2, 'BMI not-taken');
  // BVC ($50): not-taken when V=1
  check(0x50, 0x10, 0, (cpu) => { cpu.V = 1; }, 2, 'BVC not-taken');
  // BVS ($70): not-taken when V=0
  check(0x70, 0x10, 0, (cpu) => { cpu.V = 0; }, 2, 'BVS not-taken');
  // BCC ($90): not-taken when C=1
  check(0x90, 0x10, 0, (cpu) => { cpu.C = 1; }, 2, 'BCC not-taken');
  // BCS ($B0): not-taken when C=0
  check(0xB0, 0x10, 0, (cpu) => { cpu.C = 0; }, 2, 'BCS not-taken');
  // BNE ($D0): not-taken when Z=1
  check(0xD0, 0x10, 0, (cpu) => { cpu.Z = 1; }, 2, 'BNE not-taken');
  // BEQ ($F0): not-taken when Z=0
  check(0xF0, 0x10, 0, (cpu) => { cpu.Z = 0; }, 2, 'BEQ not-taken');
  ok('all 8 branches not-taken = 2 cycles each');
}

// ── 2: Branches taken, no page cross = 3 cycles each ─────────────────
// Branch from $0400 with offset $10 → target $0412 (same page).
{
  check(0x10, 0x10, 0, (cpu) => { cpu.N = 0; }, 3, 'BPL taken no-cross');
  check(0x30, 0x10, 0, (cpu) => { cpu.N = 1; }, 3, 'BMI taken no-cross');
  check(0x50, 0x10, 0, (cpu) => { cpu.V = 0; }, 3, 'BVC taken no-cross');
  check(0x70, 0x10, 0, (cpu) => { cpu.V = 1; }, 3, 'BVS taken no-cross');
  check(0x90, 0x10, 0, (cpu) => { cpu.C = 0; }, 3, 'BCC taken no-cross');
  check(0xB0, 0x10, 0, (cpu) => { cpu.C = 1; }, 3, 'BCS taken no-cross');
  check(0xD0, 0x10, 0, (cpu) => { cpu.Z = 0; }, 3, 'BNE taken no-cross');
  check(0xF0, 0x10, 0, (cpu) => { cpu.Z = 1; }, 3, 'BEQ taken no-cross');
  ok('all 8 branches taken (no page cross) = 3 cycles each');
}

// ── 3: Branches taken, page cross = 4 cycles each ────────────────────
// Branch from $04F0 (mem[0x04F0]=op, mem[0x04F1]=offset) with offset $20
// → target $0512 (different page).
{
  function runBranchCross(opcode, init) {
    const mem = new FlatMemory();
    mem.ram[0x04F0] = opcode;
    mem.ram[0x04F1] = 0x20;
    const cpu = new CPU(mem);
    cpu.pc = 0x04F0; cpu.sp = 0xFF;
    init(cpu);
    let cycles = 0;
    while (cycles < 20) {
      cpu.clock();
      cycles++;
      if (cpu.atInstructionBoundary()) break;
    }
    return cycles;
  }
  expect(runBranchCross(0x10, (cpu) => { cpu.N = 0; }) === 4, `BPL page-cross: expected 4`);
  expect(runBranchCross(0x30, (cpu) => { cpu.N = 1; }) === 4, `BMI page-cross: expected 4`);
  expect(runBranchCross(0x50, (cpu) => { cpu.V = 0; }) === 4, `BVC page-cross: expected 4`);
  expect(runBranchCross(0x70, (cpu) => { cpu.V = 1; }) === 4, `BVS page-cross: expected 4`);
  expect(runBranchCross(0x90, (cpu) => { cpu.C = 0; }) === 4, `BCC page-cross: expected 4`);
  expect(runBranchCross(0xB0, (cpu) => { cpu.C = 1; }) === 4, `BCS page-cross: expected 4`);
  expect(runBranchCross(0xD0, (cpu) => { cpu.Z = 0; }) === 4, `BNE page-cross: expected 4`);
  expect(runBranchCross(0xF0, (cpu) => { cpu.Z = 1; }) === 4, `BEQ page-cross: expected 4`);
  ok('all 8 branches taken (page cross) = 4 cycles each');
}

// ── 4: Jumps and subroutine ops ───────────────────────────────────────
// JMP abs = 3, JMP (abs) = 5, JSR = 6.
{
  check(0x4C, 0x00, 0x05, () => {}, 3, 'JMP abs');
  // JMP (abs): vector at $0500/$0501 → $0600
  check(0x6C, 0x00, 0x05, (cpu, mem) => { mem.ram[0x0500] = 0x00; mem.ram[0x0501] = 0x06; }, 5, 'JMP (abs)');
  check(0x20, 0x00, 0x05, () => {}, 6, 'JSR abs');
  ok('JMP abs/(abs), JSR cycle counts');
}

// ── 5: RTS, RTI, BRK ──────────────────────────────────────────────────
// RTS = 6, RTI = 6, BRK = 7. These are the suspects for nine.prg drift.
{
  // RTS: pre-push a return address to verify it actually executes.
  const memR = new FlatMemory();
  memR.ram[0x0400] = 0x60;          // RTS
  const cpuR = new CPU(memR);
  cpuR.pc = 0x0400; cpuR.sp = 0xFD;
  memR.ram[0x01FE] = 0x00; memR.ram[0x01FF] = 0x05;  // return addr $0500
  let cR = 0;
  while (cR < 20) { cpuR.clock(); cR++; if (cpuR.atInstructionBoundary()) break; }
  expect(cR === 6, `RTS: expected 6 cycles, got ${cR}`);
  expect(cpuR.pc === 0x0501, `RTS PC must = $0501 (return + 1), got $${cpuR.pc.toString(16)}`);

  // RTI: pre-push P then return address.
  const memI = new FlatMemory();
  memI.ram[0x0400] = 0x40;          // RTI
  const cpuI = new CPU(memI);
  cpuI.pc = 0x0400; cpuI.sp = 0xFC;
  memI.ram[0x01FD] = 0x20;          // P (just N flag clear, dummy)
  memI.ram[0x01FE] = 0x00;          // PCL
  memI.ram[0x01FF] = 0x06;          // PCH
  let cI = 0;
  while (cI < 20) { cpuI.clock(); cI++; if (cpuI.atInstructionBoundary()) break; }
  expect(cI === 6, `RTI: expected 6 cycles, got ${cI}`);
  expect(cpuI.pc === 0x0600, `RTI PC must = $0600, got $${cpuI.pc.toString(16)}`);

  // BRK: 7 cycles, increments PC by 2, pushes PC+P, fetches IRQ vector.
  const memB = new FlatMemory();
  memB.ram[0x0400] = 0x00;          // BRK
  memB.ram[0xFFFE] = 0x00; memB.ram[0xFFFF] = 0x90;  // IRQ vector $9000
  const cpuB = new CPU(memB);
  cpuB.pc = 0x0400; cpuB.sp = 0xFF;
  let cB = 0;
  while (cB < 20) { cpuB.clock(); cB++; if (cpuB.atInstructionBoundary()) break; }
  expect(cB === 7, `BRK: expected 7 cycles, got ${cB}`);
  expect(cpuB.pc === 0x9000, `BRK must vector to $9000, got $${cpuB.pc.toString(16)}`);
  ok('RTS/RTI/BRK = 6/6/7 cycles');
}

// ── 6: Flag-modifying ops (CLI/SEI/CLC/SEC/CLV/CLD/SED) = 2 ──────────
{
  check(0x18, 0, 0, () => {}, 2, 'CLC');
  check(0x38, 0, 0, () => {}, 2, 'SEC');
  check(0x58, 0, 0, (cpu) => { cpu.I = 1; }, 2, 'CLI');
  check(0x78, 0, 0, () => {}, 2, 'SEI');
  check(0xB8, 0, 0, (cpu) => { cpu.V = 1; }, 2, 'CLV');
  check(0xD8, 0, 0, () => {}, 2, 'CLD');
  check(0xF8, 0, 0, () => {}, 2, 'SED');
  ok('flag-modifying ops CLC/SEC/CLI/SEI/CLV/CLD/SED = 2 cycles each');
}

// ── 7: Stack ops PHA/PHP/PLA/PLP ─────────────────────────────────────
{
  check(0x48, 0, 0, () => {}, 3, 'PHA');
  check(0x08, 0, 0, () => {}, 3, 'PHP');
  check(0x68, 0, 0, (cpu, mem) => { cpu.sp = 0xFE; mem.ram[0x01FF] = 0x42; }, 4, 'PLA');
  check(0x28, 0, 0, (cpu, mem) => { cpu.sp = 0xFE; mem.ram[0x01FF] = 0x20; }, 4, 'PLP');
  ok('PHA/PHP = 3 cycles, PLA/PLP = 4 cycles');
}

// ── 8: Transfer ops TAX/TXA/TAY/TYA/TSX/TXS = 2 ──────────────────────
{
  check(0xAA, 0, 0, () => {}, 2, 'TAX');
  check(0x8A, 0, 0, () => {}, 2, 'TXA');
  check(0xA8, 0, 0, () => {}, 2, 'TAY');
  check(0x98, 0, 0, () => {}, 2, 'TYA');
  check(0xBA, 0, 0, () => {}, 2, 'TSX');
  check(0x9A, 0, 0, () => {}, 2, 'TXS');
  ok('TAX/TXA/TAY/TYA/TSX/TXS = 2 cycles each');
}

// ── 9: INX/DEX/INY/DEY = 2; NOP = 2 ───────────────────────────────────
{
  check(0xE8, 0, 0, () => {}, 2, 'INX');
  check(0xCA, 0, 0, () => {}, 2, 'DEX');
  check(0xC8, 0, 0, () => {}, 2, 'INY');
  check(0x88, 0, 0, () => {}, 2, 'DEY');
  check(0xEA, 0, 0, () => {}, 2, 'NOP');
  ok('INX/DEX/INY/DEY/NOP = 2 cycles each');
}

// ── 10: BIT zp/abs ────────────────────────────────────────────────────
{
  check(0x24, 0x40, 0, () => {}, 3, 'BIT zp');
  check(0x2C, 0x00, 0x05, () => {}, 4, 'BIT abs');
  ok('BIT zp/abs = 3/4 cycles');
}

// ── 11: Shifts on accumulator (ASL/LSR/ROL/ROR A) = 2 ────────────────
{
  check(0x0A, 0, 0, () => {}, 2, 'ASL A');
  check(0x4A, 0, 0, () => {}, 2, 'LSR A');
  check(0x2A, 0, 0, () => {}, 2, 'ROL A');
  check(0x6A, 0, 0, () => {}, 2, 'ROR A');
  ok('ASL/LSR/ROL/ROR A = 2 cycles each');
}

// ── 12: Shifts on memory — RMW timings ───────────────────────────────
{
  // ASL zp = 5
  check(0x06, 0x40, 0, () => {}, 5, 'ASL zp');
  // ASL zp,X = 6
  check(0x16, 0x40, 0, (cpu) => { cpu.x = 1; }, 6, 'ASL zp,X');
  // ASL abs = 6
  check(0x0E, 0x00, 0x05, () => {}, 6, 'ASL abs');
  // ASL abs,X = 7
  check(0x1E, 0x00, 0x05, (cpu) => { cpu.x = 0; }, 7, 'ASL abs,X');
  // LSR zp = 5
  check(0x46, 0x40, 0, () => {}, 5, 'LSR zp');
  // ROL abs,X = 7
  check(0x3E, 0x00, 0x05, (cpu) => { cpu.x = 0; }, 7, 'ROL abs,X');
  // ROR zp,X = 6
  check(0x76, 0x40, 0, (cpu) => { cpu.x = 1; }, 6, 'ROR zp,X');
  ok('ASL/LSR/ROL/ROR memory RMW = 5/6/6/7 cycles');
}

// ── 13: INC/DEC memory — RMW timings ─────────────────────────────────
{
  check(0xE6, 0x40, 0, () => {}, 5, 'INC zp');
  check(0xF6, 0x40, 0, (cpu) => { cpu.x = 1; }, 6, 'INC zp,X');
  check(0xEE, 0x00, 0x05, () => {}, 6, 'INC abs');
  check(0xFE, 0x00, 0x05, (cpu) => { cpu.x = 0; }, 7, 'INC abs,X');
  check(0xC6, 0x40, 0, () => {}, 5, 'DEC zp');
  check(0xDE, 0x00, 0x05, (cpu) => { cpu.x = 0; }, 7, 'DEC abs,X');
  ok('INC/DEC memory RMW = 5/6/6/7 cycles');
}

// ── 14: LDA / STA / ALU ops — abs,X with page cross ──────────────────
// load forms +1 cycle on cross; store forms always 5; RMW forms always 7.
{
  // LDA abs,X no-cross
  check(0xBD, 0x00, 0x05, (cpu) => { cpu.x = 0; }, 4, 'LDA abs,X no-cross');
  // LDA abs,X page-cross
  check(0xBD, 0xFF, 0x05, (cpu) => { cpu.x = 1; }, 5, 'LDA abs,X page-cross');
  // LDA abs,Y page-cross
  check(0xB9, 0xFF, 0x05, (cpu) => { cpu.y = 1; }, 5, 'LDA abs,Y page-cross');
  // STA abs,X — 5 always (no +1)
  check(0x9D, 0xFF, 0x05, (cpu) => { cpu.x = 1; }, 5, 'STA abs,X (no +1 on cross)');
  // STA abs,Y — 5 always
  check(0x99, 0xFF, 0x05, (cpu) => { cpu.y = 1; }, 5, 'STA abs,Y (no +1 on cross)');
  // STA (zp),Y — 6 always
  check(0x91, 0x46, 0, (cpu) => { cpu.y = 1; }, 6, 'STA (zp),Y page-cross stays 6');
  ok('store-form abs,X/abs,Y/(zp),Y do NOT pay page-cross penalty');
}

// ── 15: LDA / ALU loads — (zp),Y page cross ──────────────────────────
{
  // LDA (zp),Y no-cross
  check(0xB1, 0x44, 0, (cpu) => { cpu.y = 1; }, 5, 'LDA (zp),Y no-cross');
  // LDA (zp),Y page-cross — pointer at $46/$47 is $05FF, +Y=1 → $0600
  check(0xB1, 0x46, 0, (cpu) => { cpu.y = 1; }, 6, 'LDA (zp),Y page-cross');
  ok('LDA (zp),Y = 5 no-cross / 6 page-cross');
}

// ── 16: CPX / CPY immediate / zp / abs ───────────────────────────────
{
  check(0xE0, 0x10, 0, () => {}, 2, 'CPX imm');
  check(0xE4, 0x40, 0, () => {}, 3, 'CPX zp');
  check(0xEC, 0x00, 0x05, () => {}, 4, 'CPX abs');
  check(0xC0, 0x10, 0, () => {}, 2, 'CPY imm');
  check(0xC4, 0x40, 0, () => {}, 3, 'CPY zp');
  check(0xCC, 0x00, 0x05, () => {}, 4, 'CPY abs');
  ok('CPX/CPY imm/zp/abs = 2/3/4 cycles');
}

console.log(`\n${testNo} legal-opcode cycle audit tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
