// Bus-kind tagging audit — verifies cpu.peekNextBusKind() matches the
// actual bus access the CPU performs during clock().
//
// Why this matters for nine.prg: the master cycle blocks the CPU when
// VIC's BA is low AND peekNextBusKind() === 'read'. If a cycle that
// actually writes is tagged 'read', the CPU stalls when it shouldn't
// (slows demo). If a cycle that actually reads is tagged 'write' or
// 'internal', the CPU runs through a sprite stall it should have paid
// (speeds demo). These tags are therefore a prerequisite for spec-level
// BA/RDY timing probes, including Nine's $D017 and $D016 raster code.
//
// Spec rule (NMOS 6502/6510): every cycle performs exactly one bus
// access — either a read or a write. There is no truly "internal" cycle
// in the sense of skipping the bus; what we tag 'internal' must in fact
// be a "dummy read" (typically of PC, of the address-low byte before
// page-fixup, etc.) so that BA-low blocks the CPU on those cycles too.
//
// This test runs each opcode cycle-by-cycle. Per cycle, before clocking:
//   - capture cpu.peekNextBusKind()
// During clock(), count mem.read() and mem.write() calls.
// After clock(), check:
//   - 'write' → exactly 1 write, 0 reads
//   - 'read' → exactly 1 read, 0 writes
//   - 'internal' → must be 0 writes and must perform a dummy read; every
//     NMOS 6502 cycle touches the bus, and BA-low must be able to stall
//     read-like dummy cycles
//
// FAILURES: a 'read'-tagged cycle that does no bus access at all is a
// candidate for the 5-cycle drift — those cycles should have stalled
// under BA-low but didn't, because the CPU never actually attempted a
// read.

import { CPU } from '../src/cpu.js';

class FlatMemory {
  constructor() { this.ram = new Uint8Array(0x10000); this.reads = 0; this.writes = 0; }
  read(a) { this.reads++; return this.ram[a & 0xFFFF]; }
  write(a, v) { this.writes++; this.ram[a & 0xFFFF] = v & 0xFF; }
  resetCounters() { this.reads = 0; this.writes = 0; }
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

// Run one opcode and verify per-cycle bus-kind matches actual access.
// Returns array of {cycle, kind, reads, writes} for inspection.
function auditOpcode(opcode, op1 = 0, op2 = 0, init = (cpu, mem) => {}) {
  const mem = new FlatMemory();
  mem.ram[0x0400] = opcode;
  mem.ram[0x0401] = op1;
  mem.ram[0x0402] = op2;
  mem.ram[0x0040] = 0x00; mem.ram[0x0041] = 0x05;
  mem.ram[0x0044] = 0x00; mem.ram[0x0045] = 0x05;
  mem.ram[0x0046] = 0xFF; mem.ram[0x0047] = 0x05;     // page-cross fixture
  mem.ram[0x0500] = 0x77;
  mem.ram[0x0600] = 0x99;
  const cpu = new CPU(mem);
  cpu.pc = 0x0400; cpu.sp = 0xFF;
  cpu.a = 0x42; cpu.x = 0; cpu.y = 0;
  init(cpu, mem);
  const cycles = [];
  for (let i = 0; i < 16; i++) {
    const kind = cpu.peekNextBusKind();
    mem.resetCounters();
    cpu.clock();
    cycles.push({ cycle: i, kind, reads: mem.reads, writes: mem.writes });
    if (cpu.atInstructionBoundary()) break;
  }
  return cycles;
}

function checkOpcode(opcode, op1, op2, init, label) {
  const cycles = auditOpcode(opcode, op1, op2, init);
  const issues = [];
  // Skip cycle 0: clock() bundles opcode fetch + first micro-op into a
  // single call, so cycle 0 always does 2 reads. This is a CPU model
  // structure choice, not a cycle-count or BA-stall bug. Cycle 1 onward
  // is what BA-low can independently stall.
  for (const c of cycles.slice(1)) {
    if (c.kind === 'write') {
      if (c.writes !== 1 || c.reads !== 0) {
        issues.push(`cycle ${c.cycle} 'write': expected 1 write 0 reads, got ${c.writes}w/${c.reads}r`);
      }
    } else if (c.kind === 'read') {
      if (c.reads !== 1 || c.writes !== 0) {
        issues.push(`cycle ${c.cycle} 'read': expected 1 read 0 writes, got ${c.writes}w/${c.reads}r`);
      }
    } else { // internal
      if (c.writes !== 0) {
        issues.push(`cycle ${c.cycle} 'internal' performed write (BA-low would NOT block; bug)`);
      }
      if (c.reads === 0) {
        issues.push(`cycle ${c.cycle} 'internal' did NO bus access (BA-low cannot stall; bug — every 6502 cycle is on the bus)`);
      }
    }
  }
  return { cycles, issues, label };
}

// Format helper for failure output.
function formatCycles(label, cycles) {
  return `${label}: cycles=[${cycles.map(c => `${c.cycle}:${c.kind}(r=${c.reads},w=${c.writes})`).join(' ')}]`;
}

// ── 1: NOP — 2 cycles, both should be reads (opcode fetch + dummy) ────
{
  const r = checkOpcode(0xEA, 0, 0, () => {}, 'NOP');
  expect(r.issues.length === 0,
    `NOP: ${r.issues.join('; ')}\n   ${formatCycles('NOP', r.cycles)}`);
  ok('NOP: every cycle does a bus read (opcode fetch + dummy PC read)');
}

// ── 2: LDA #imm — 2 cycles, both reads ────────────────────────────────
{
  const r = checkOpcode(0xA9, 0x42, 0, () => {}, 'LDA #$42');
  expect(r.issues.length === 0,
    `LDA imm: ${r.issues.join('; ')}\n   ${formatCycles('LDA imm', r.cycles)}`);
  ok('LDA imm: 2 read cycles (opcode + operand)');
}

// ── 3: LDA abs — 4 cycles, all reads ──────────────────────────────────
{
  const r = checkOpcode(0xAD, 0x00, 0x05, () => {}, 'LDA abs');
  expect(r.issues.length === 0,
    `LDA abs: ${r.issues.join('; ')}\n   ${formatCycles('LDA abs', r.cycles)}`);
  ok('LDA abs: 4 read cycles (opcode + lo + hi + data)');
}

// ── 4: STA abs — 4 cycles: 3 reads (opcode+lo+hi) + 1 write ──────────
{
  const r = checkOpcode(0x8D, 0x00, 0x05, () => {}, 'STA abs');
  // Expected: 3 reads then 1 write
  const writeCycles = r.cycles.filter(c => c.writes > 0);
  expect(writeCycles.length === 1, `STA abs must have exactly 1 write cycle, got ${writeCycles.length}`);
  expect(writeCycles[0]?.kind === 'write',
    `STA abs write cycle must be tagged 'write', got '${writeCycles[0]?.kind}'`);
  expect(r.issues.length === 0,
    `STA abs: ${r.issues.join('; ')}\n   ${formatCycles('STA abs', r.cycles)}`);
  ok('STA abs: 3 reads + 1 write, all correctly tagged');
}

// ── 5: PHA — 3 cycles: opcode read + dummy read + write ──────────────
{
  const r = checkOpcode(0x48, 0, 0, () => {}, 'PHA');
  const writeCycles = r.cycles.filter(c => c.writes > 0);
  expect(writeCycles.length === 1, `PHA must have 1 write, got ${writeCycles.length}`);
  expect(writeCycles[0]?.kind === 'write',
    `PHA write cycle must be tagged 'write', got '${writeCycles[0]?.kind}'`);
  expect(r.issues.length === 0,
    `PHA: ${r.issues.join('; ')}\n   ${formatCycles('PHA', r.cycles)}`);
  ok('PHA: opcode read + dummy read + push write, all correctly tagged');
}

// ── 6: PLA — 4 cycles: opcode + dummy + dummy stack-read + actual pop
{
  const r = checkOpcode(0x68, 0, 0, () => {}, 'PLA');
  const writeCycles = r.cycles.filter(c => c.writes > 0);
  expect(writeCycles.length === 0, `PLA must have 0 writes, got ${writeCycles.length}`);
  expect(r.issues.length === 0,
    `PLA: ${r.issues.join('; ')}\n   ${formatCycles('PLA', r.cycles)}`);
  ok('PLA: 4 read cycles (no writes), all correctly tagged');
}

// ── 7: ASL zp — 5 cycles RMW: opcode + addr + read + write + write ──
// RMW pattern: read once, write old value (dummy), write new value.
{
  const r = checkOpcode(0x06, 0x40, 0, () => {}, 'ASL zp');
  const writeCycles = r.cycles.filter(c => c.writes > 0);
  expect(writeCycles.length === 2, `ASL zp must have 2 writes (RMW dummy + real), got ${writeCycles.length}`);
  for (const c of writeCycles) {
    expect(c.kind === 'write',
      `ASL zp RMW write cycle ${c.cycle} must be tagged 'write', got '${c.kind}'`);
  }
  expect(r.issues.length === 0,
    `ASL zp: ${r.issues.join('; ')}\n   ${formatCycles('ASL zp', r.cycles)}`);
  ok('ASL zp (RMW): 3 reads + 2 writes, all correctly tagged');
}

// ── 8: JMP abs — 3 cycles, all reads ─────────────────────────────────
{
  const r = checkOpcode(0x4C, 0x00, 0x05, () => {}, 'JMP abs');
  expect(r.issues.length === 0,
    `JMP abs: ${r.issues.join('; ')}\n   ${formatCycles('JMP abs', r.cycles)}`);
  ok('JMP abs: 3 read cycles (no internal cycles without bus access)');
}

// ── 9: JSR — 6 cycles: opcode + lo + dummy + push h + push l + read hi
{
  const r = checkOpcode(0x20, 0x00, 0x05, () => {}, 'JSR');
  const writeCycles = r.cycles.filter(c => c.writes > 0);
  expect(writeCycles.length === 2, `JSR must push twice, got ${writeCycles.length} writes`);
  expect(r.issues.length === 0,
    `JSR: ${r.issues.join('; ')}\n   ${formatCycles('JSR', r.cycles)}`);
  ok('JSR: 4 reads + 2 writes (push PCH, push PCL), all correctly tagged');
}

// ── 10: RTS — 6 cycles, all reads (no internal-no-bus cycles) ──────
// Per 6502 datasheet: cycle 1 fetch, 2 dummy read PC+1, 3 read SP, 4
// pull PCL, 5 pull PCH, 6 dummy read new-PC. Six bus reads total.
{
  const mem = new FlatMemory();
  mem.ram[0x0400] = 0x60;
  mem.ram[0x01FE] = 0x00; mem.ram[0x01FF] = 0x05;
  const cpu = new CPU(mem);
  cpu.pc = 0x0400; cpu.sp = 0xFD;
  const cycles = [];
  for (let i = 0; i < 8; i++) {
    const kind = cpu.peekNextBusKind();
    mem.resetCounters();
    cpu.clock();
    cycles.push({ cycle: i, kind, reads: mem.reads, writes: mem.writes });
    if (cpu.atInstructionBoundary()) break;
  }
  expect(cycles.length === 6, `RTS must take 6 cycles, got ${cycles.length}`);
  expect(cycles.every(c => c.writes === 0),
    `RTS must do NO writes`);
  // Every cycle 1+ must touch the bus (cycle 0 = bundled opcode fetch
  // + first micro-op, see structural note).
  const noBusCycles = cycles.slice(1).filter(c => c.reads === 0 && c.writes === 0);
  expect(noBusCycles.length === 0,
    `RTS no-bus cycles found at ${noBusCycles.map(c => c.cycle).join(',')} (kinds: ${noBusCycles.map(c => c.kind).join(',')})`);
  ok('RTS: every cycle touches the bus (BA-low can stall every cycle)');
}

// ── 11: RTI — 6 cycles, all reads ────────────────────────────────────
{
  const mem = new FlatMemory();
  mem.ram[0x0400] = 0x40;
  mem.ram[0x01FD] = 0x20;
  mem.ram[0x01FE] = 0x00;
  mem.ram[0x01FF] = 0x06;
  const cpu = new CPU(mem);
  cpu.pc = 0x0400; cpu.sp = 0xFC;
  const cycles = [];
  for (let i = 0; i < 8; i++) {
    const kind = cpu.peekNextBusKind();
    mem.resetCounters();
    cpu.clock();
    cycles.push({ cycle: i, kind, reads: mem.reads, writes: mem.writes });
    if (cpu.atInstructionBoundary()) break;
  }
  expect(cycles.length === 6, `RTI must take 6 cycles, got ${cycles.length}`);
  expect(cycles.every(c => c.writes === 0),
    `RTI must do NO writes`);
  const noBusCycles = cycles.slice(1).filter(c => c.reads === 0 && c.writes === 0);
  expect(noBusCycles.length === 0,
    `RTI no-bus cycles found at ${noBusCycles.map(c => c.cycle).join(',')}`);
  ok('RTI: every cycle touches the bus');
}

// ── 12: Branch taken (BNE) — opcode + operand + dummy = 3 reads ──────
{
  const r = checkOpcode(0xD0, 0x10, 0, (cpu) => { cpu.Z = 0; }, 'BNE taken');
  expect(r.cycles.length === 3, `BNE taken: 3 cycles expected`);
  expect(r.issues.length === 0,
    `BNE taken: ${r.issues.join('; ')}\n   ${formatCycles('BNE taken', r.cycles)}`);
  ok('BNE taken (no cross): 3 read cycles');
}

// ── 13: ASL abs,X — 7 cycles RMW; verify no internal-no-bus cycles ───
// This is the "abs,X RMW" case where the indexed address fix-up cycle
// is internal. On real hw it's a dummy read of the wrong (no-fixup)
// address. If the emulator skips the bus access, BA-low won't stall here.
{
  const r = checkOpcode(0x1E, 0x00, 0x05, (cpu) => { cpu.x = 1; }, 'ASL abs,X');
  expect(r.cycles.length === 7, `ASL abs,X: 7 cycles expected`);
  expect(r.issues.length === 0,
    `ASL abs,X: ${r.issues.join('; ')}\n   ${formatCycles('ASL abs,X', r.cycles)}`);
  ok('ASL abs,X (RMW): all 7 cycles touch the bus (no internal-no-bus)');
}

// ── 14: STA abs,X — 5 cycles; the "fix-up" cycle on indexed stores ───
// Real hw: STA abs,X always does a dummy read of the no-fixup address
// at cycle 4, then writes at cycle 5. Internal-no-bus would skip BA stall.
{
  const r = checkOpcode(0x9D, 0x00, 0x05, (cpu) => { cpu.x = 1; }, 'STA abs,X');
  expect(r.cycles.length === 5, `STA abs,X: 5 cycles expected`);
  expect(r.issues.length === 0,
    `STA abs,X: ${r.issues.join('; ')}\n   ${formatCycles('STA abs,X', r.cycles)}`);
  ok('STA abs,X: 5 cycles, all touch the bus (no internal-no-bus)');
}

// ── 15: PLP — 4 cycles: opcode + dummy + stack-pre-inc + pop ─────────
{
  const r = checkOpcode(0x28, 0, 0, (cpu, mem) => { cpu.sp = 0xFE; mem.ram[0x01FF] = 0x20; }, 'PLP');
  expect(r.cycles.length === 4, `PLP: 4 cycles expected`);
  expect(r.issues.length === 0,
    `PLP: ${r.issues.join('; ')}\n   ${formatCycles('PLP', r.cycles)}`);
  ok('PLP: 4 read cycles (no internal-no-bus)');
}

// ── 16: LDA abs,X page-cross — 5 cycles, fix-up cycle must touch bus
// On real hw the page-cross cycle is a dummy read at the unfixed
// address. If the emulator marks it 'internal' with no bus access, BA-low
// can't stall this cycle — that's a free cycle for the demo.
{
  const r = checkOpcode(0xBD, 0xFF, 0x05, (cpu) => { cpu.x = 1; }, 'LDA abs,X cross');
  expect(r.cycles.length === 5, `LDA abs,X cross: 5 cycles expected`);
  expect(r.issues.length === 0,
    `LDA abs,X cross: ${r.issues.join('; ')}\n   ${formatCycles('LDA abs,X cross', r.cycles)}`);
  ok('LDA abs,X page-cross: every cycle touches the bus');
}

// ── 17: LDA abs,Y page-cross — same fix-up structure ─────────────────
{
  const r = checkOpcode(0xB9, 0xFF, 0x05, (cpu) => { cpu.y = 1; }, 'LDA abs,Y cross');
  expect(r.cycles.length === 5, `LDA abs,Y cross: 5 cycles expected`);
  expect(r.issues.length === 0,
    `LDA abs,Y cross: ${r.issues.join('; ')}\n   ${formatCycles('LDA abs,Y cross', r.cycles)}`);
  ok('LDA abs,Y page-cross: every cycle touches the bus');
}

// ── 18: LDA (zp),Y page-cross — fix-up cycle ─────────────────────────
{
  const r = checkOpcode(0xB1, 0x46, 0, (cpu) => { cpu.y = 1; }, 'LDA (zp),Y cross');
  expect(r.cycles.length === 6, `LDA (zp),Y cross: 6 cycles expected`);
  expect(r.issues.length === 0,
    `LDA (zp),Y cross: ${r.issues.join('; ')}\n   ${formatCycles('LDA (zp),Y cross', r.cycles)}`);
  ok('LDA (zp),Y page-cross: every cycle touches the bus');
}

// ── 19: STA abs,X — 5 cycles; mandatory fix-up dummy read ────────────
// Real hw ALWAYS does the dummy read at cycle 4, even when no page
// cross occurs. Stores never get +1 cycle, but the dummy read happens.
{
  const r = checkOpcode(0x9D, 0x00, 0x05, (cpu) => { cpu.x = 1; }, 'STA abs,X');
  expect(r.cycles.length === 5, `STA abs,X: 5 cycles expected`);
  expect(r.issues.length === 0,
    `STA abs,X: ${r.issues.join('; ')}\n   ${formatCycles('STA abs,X', r.cycles)}`);
  ok('STA abs,X: 5 cycles, every cycle on the bus (mandatory dummy read at fix-up)');
}

// ── 20: STA (zp),Y — 6 cycles, mandatory dummy read at fix-up ───────
{
  const r = checkOpcode(0x91, 0x44, 0, (cpu) => { cpu.y = 1; }, 'STA (zp),Y');
  expect(r.cycles.length === 6, `STA (zp),Y: 6 cycles expected`);
  expect(r.issues.length === 0,
    `STA (zp),Y: ${r.issues.join('; ')}\n   ${formatCycles('STA (zp),Y', r.cycles)}`);
  ok('STA (zp),Y: 6 cycles, every cycle on the bus');
}

// ── 21: TAX/TXA/TAY/TYA — 2 cycles, both reads (opcode fetch + dummy)
// Per spec: implied transfers fetch opcode then do a dummy read of the
// next byte. If cycle 1 is 'internal' with no bus access, BA-low
// can't stall it.
{
  for (const [op, name] of [[0xAA, 'TAX'], [0x8A, 'TXA'], [0xA8, 'TAY'], [0x98, 'TYA'],
                             [0xBA, 'TSX'], [0x9A, 'TXS']]) {
    const r = checkOpcode(op, 0, 0, () => {}, name);
    expect(r.issues.length === 0,
      `${name}: ${r.issues.join('; ')}\n   ${formatCycles(name, r.cycles)}`);
  }
  ok('TAX/TXA/TAY/TYA/TSX/TXS: both cycles touch the bus');
}

// ── 22: INX/DEX/INY/DEY/NOP — 2 cycles, both reads ───────────────────
{
  for (const [op, name] of [[0xE8, 'INX'], [0xCA, 'DEX'], [0xC8, 'INY'], [0x88, 'DEY'], [0xEA, 'NOP']]) {
    const r = checkOpcode(op, 0, 0, () => {}, name);
    expect(r.issues.length === 0,
      `${name}: ${r.issues.join('; ')}\n   ${formatCycles(name, r.cycles)}`);
  }
  ok('INX/DEX/INY/DEY/NOP: both cycles touch the bus');
}

// ── 23: CLI/SEI/CLC/SEC/CLD/SED/CLV — implied 2-cyc, both reads ─────
{
  for (const [op, name] of [[0x18, 'CLC'], [0x38, 'SEC'], [0x58, 'CLI'], [0x78, 'SEI'],
                             [0xB8, 'CLV'], [0xD8, 'CLD'], [0xF8, 'SED']]) {
    const r = checkOpcode(op, 0, 0, () => {}, name);
    expect(r.issues.length === 0,
      `${name}: ${r.issues.join('; ')}\n   ${formatCycles(name, r.cycles)}`);
  }
  ok('flag-modify ops: both cycles touch the bus');
}

// ── 24: BNE taken — 3 cycles: opcode + operand + dummy fetch ─────────
{
  const r = checkOpcode(0xD0, 0x10, 0, (cpu) => { cpu.Z = 0; }, 'BNE taken');
  expect(r.cycles.length === 3, `BNE taken: 3 cycles expected`);
  expect(r.issues.length === 0,
    `BNE taken: ${r.issues.join('; ')}\n   ${formatCycles('BNE taken', r.cycles)}`);
  ok('BNE taken: every cycle touches the bus');
}

console.log(`\n${testNo} bus-kind audit tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
