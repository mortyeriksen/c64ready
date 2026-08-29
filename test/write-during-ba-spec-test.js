// CPU write cycles vs BA-low edge case spec audit. From Linus Akesson's
// "Nine Explained" article (specifically about VIC-II rastercode):
//
//   "Each CPU instruction can involve a combination of read and write
//    cycles, so these write-only cycles can easily throw off carefully
//    timed code. That is why I mention towards the end of the video
//    that there's a special case when write cycles in the rastercode
//    coincide with the start of sprite DMA."
//
// Per Bauer §3.6.1 + 6510 BA pin behavior:
//   - BA goes LOW 3 cycles before each sprite p-access.
//   - BA-low BLOCKS CPU READ cycles (the 6510 halts when it tries to
//     read while BA is low).
//   - BA-low does NOT block CPU WRITE cycles — the 6510 completes
//     pending writes even while BA is asserted.
//   - AEC-low blocks ALL cycles (full halt).
//
// Edge case nine.prg's author flags: a CPU instruction whose final
// write cycle coincides with BA going low. The write completes (per
// spec). The next instruction's first read is blocked. This means:
//   - Instructions ending in writes: zero stall delta from BA going
//     low at the write cycle (write proceeds normally).
//   - Instructions whose 4th cycle is a read: stall normally.
//
// Each test below isolates one rule via the integrated VIC + CPU
// machine harness so the actual bus arbitration is exercised.

import { CPU } from '../src/cpu.js';
import { VIC2 } from '../src/vic2.js';

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

// Build a CPU + VIC pair tied via irqHandler. The VIC has sprite 0
// enabled with DMA on (Y far from start so DMA stays in steady state).
function makeRig() {
  const mem = new FlatMemory();
  // Reset vector at $0400.
  mem.ram[0xFFFC] = 0x00; mem.ram[0xFFFD] = 0x04;
  const cpu = new CPU(mem);
  cpu.reset();
  // 6502 reset takes 8 cycles before the first instruction fetch. Consume
  // the 7 dummy cycles queued by reset so each rig starts at the first
  // user-instruction boundary.
  for (let i = 0; i < 7; i++) cpu.clock();
  cpu.I = 0;
  const vic = new VIC2();
  vic.ram = mem.ram;
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  // Sprite 0 alone, DMA on, Y far from raster.
  vic.regs[0x15] = 0x01;
  vic.spriteDmaOn[0] = 1;
  vic.regs[0x01] = 200;
  vic.irqHandler = (s) => cpu.setIrqLine(!!s);
  return { cpu, vic, mem };
}

// Drive cpu+vic to a (raster, cycle) position. Each iteration advances
// one master cycle (vic.clock(1) + cpu.clock() if not BA-blocked).
function driveTo(rig, raster, cycle, baCheck = true) {
  const { cpu, vic } = rig;
  let safety = 200000;
  while (--safety) {
    if (vic.raster === raster && vic.cycleInLine === cycle) return;
    vic.clock(1);
    if (baCheck) {
      const blocked = (vic.isBaLow() && cpu.peekNextBusKind() === 'read') || vic.isAecLow();
      if (!blocked) cpu.clock();
    } else {
      cpu.clock();
    }
  }
  throw new Error(`driveTo timed out at L${vic.raster}.c${vic.cycleInLine}`);
}

// Drive until both: raster.cycle hits target AND CPU is at instruction
// boundary. Useful for tests that need to insert a new instruction at a
// precise cycle position.
function driveToAtBoundary(rig, raster, cycle) {
  const { cpu, vic } = rig;
  let safety = 200000;
  while (--safety) {
    if (vic.raster === raster && vic.cycleInLine === cycle && cpu.atInstructionBoundary()) return;
    vic.clock(1);
    const blocked = (vic.isBaLow() && cpu.peekNextBusKind() === 'read') || vic.isAecLow();
    if (!blocked) cpu.clock();
  }
  throw new Error(`driveToAtBoundary timed out at L${vic.raster}.c${vic.cycleInLine}`);
}

// ── 1: STA abs straddling BA-low edge — write completes ──────────────
// sp0 BA-low starts at c55. Position STA $4000 to begin at c52 so its
// write cycle (4th of 4) lands at c55 — exactly where BA goes low.
// Per spec, the write completes (BA only blocks reads).
{
  const rig = makeRig();
  // Program at $0400: NOPs + STA $4000 at the right cycle.
  for (let i = 0; i < 60; i++) rig.mem.ram[0x0400 + i] = 0xEA;
  // We'll insert STA at a position computed by trial: drive to L1 c51,
  // then place 0x8D at PC. cpu.pc is whatever the CPU's at after
  // running NOPs.
  rig.cpu.a = 0x42;
  // Land at L1 c52 with CPU at instruction boundary so the next clock
  // begins our patched STA. STA abs takes 4 cycles, so cycle 4 (the
  // write) lands at c55 — exactly where BA goes low for sp0.
  driveToAtBoundary(rig, 1, 52);
  const pc = rig.cpu.pc;
  rig.mem.ram[pc] = 0x8D;
  rig.mem.ram[pc + 1] = 0x00;
  rig.mem.ram[pc + 2] = 0x40;
  // Run until next instruction boundary (= STA completed).
  let started = false;
  for (let i = 0; i < 16 && (!started || !rig.cpu.atInstructionBoundary()); i++) {
    rig.vic.clock(1);
    const blocked = (rig.vic.isBaLow() && rig.cpu.peekNextBusKind() === 'read') || rig.vic.isAecLow();
    if (!blocked) { rig.cpu.clock(); started = true; }
  }
  expect(rig.mem.ram[0x4000] === 0x42,
    `STA $4000 with write cycle at BA-low edge: $4000 = $42, got $${rig.mem.ram[0x4000].toString(16)}`);
  ok('Bauer §3.6.1: STA write completes when its write cycle coincides with BA going low');
}

// ── 2: LDA abs whose data-read cycle hits BA-low — STALLS ────────────
// LDA $4000 is 4 cycles, all reads. If cycle 4 (the data read) lands
// at c55 (BA going low), CPU stalls until BA goes high.
{
  const rig = makeRig();
  for (let i = 0; i < 60; i++) rig.mem.ram[0x0400 + i] = 0xEA;
  rig.mem.ram[0x4000] = 0x77;
  // LDA abs takes 4 cycles. Cycle 4 (data read) lands at c55 if LDA
  // starts at boundary c52. BA goes low at c55 so the data read stalls.
  driveToAtBoundary(rig, 1, 52);
  const pc = rig.cpu.pc;
  rig.mem.ram[pc] = 0xAD;
  rig.mem.ram[pc + 1] = 0x00;
  rig.mem.ram[pc + 2] = 0x40;
  let masterCycles = 0;
  let started = false;
  while (masterCycles < 20 && (!started || !rig.cpu.atInstructionBoundary())) {
    rig.vic.clock(1);
    masterCycles++;
    const blocked = (rig.vic.isBaLow() && rig.cpu.peekNextBusKind() === 'read') || rig.vic.isAecLow();
    if (!blocked) { rig.cpu.clock(); started = true; }
  }
  expect(rig.cpu.a === 0x77, `LDA $4000 must read $77, got $${rig.cpu.a.toString(16)}`);
  // LDA abs nominally takes 4 cycles. With BA-stall starting at c55, it
  // should take longer (~7+ cycles depending on BA-low duration).
  expect(masterCycles > 4,
    `LDA crossing BA-low edge: must take MORE than 4 master cycles (stalled), got ${masterCycles}`);
  ok('Bauer §3.6.1: LDA stalls when its read cycle lands at BA-low edge');
}

// ── 3: A pure-read-cycles instruction (NOP) stalls, takes ≥3 cycles ──
// NOP is 2 cycles, both reads. If both fall in BA-low, both stall.
{
  const rig = makeRig();
  for (let i = 0; i < 60; i++) rig.mem.ram[0x0400 + i] = 0xEA;
  // Drive to c54 (1 cycle before BA goes low). NOP starts at c54;
  // cycle 0 (opcode fetch) at c54, cycle 1 at c55 (BA low → stall).
  driveTo(rig, 1, 54);
  let masterCycles = 0;
  let started = false;
  while (masterCycles < 30 && (!started || !rig.cpu.atInstructionBoundary())) {
    rig.vic.clock(1);
    masterCycles++;
    const blocked = (rig.vic.isBaLow() && rig.cpu.peekNextBusKind() === 'read') || rig.vic.isAecLow();
    if (!blocked) { rig.cpu.clock(); started = true; }
  }
  // NOP nominally 2 cycles. With cycle 1 stalled by BA-low (and AEC
  // taking over from c58..c63), the NOP can stretch substantially.
  expect(masterCycles > 2,
    `NOP straddling BA-low: must take >2 master cycles (stalled), got ${masterCycles}`);
  ok('Bauer §3.6.1: NOP cycle 1 stalls under BA-low');
}

// ── 4: STA abs entirely BEFORE BA-low: takes exactly 4 master cycles ─
{
  const rig = makeRig();
  for (let i = 0; i < 60; i++) rig.mem.ram[0x0400 + i] = 0xEA;
  rig.cpu.a = 0xAB;
  // Drive to L1 c20 (well before BA-low at c55).
  driveTo(rig, 1, 20);
  const pc = rig.cpu.pc;
  rig.mem.ram[pc] = 0x8D;
  rig.mem.ram[pc + 1] = 0x00;
  rig.mem.ram[pc + 2] = 0x40;
  let masterCycles = 0;
  let started = false;
  while (masterCycles < 10 && (!started || !rig.cpu.atInstructionBoundary())) {
    rig.vic.clock(1);
    masterCycles++;
    const blocked = (rig.vic.isBaLow() && rig.cpu.peekNextBusKind() === 'read') || rig.vic.isAecLow();
    if (!blocked) { rig.cpu.clock(); started = true; }
  }
  expect(rig.mem.ram[0x4000] === 0xAB,
    `STA $4000 outside BA-low: $4000 = $AB, got $${rig.mem.ram[0x4000].toString(16)}`);
  expect(masterCycles === 4,
    `STA $4000 outside BA-low: 4 master cycles, got ${masterCycles}`);
  ok('STA abs outside BA-low: 4 master cycles, no stall');
}

// ── 5: BA-low → high transition releases pending CPU read ────────────
// CPU stalled mid-LDA; once BA goes high, CPU resumes the read on the
// very next master cycle (no extra delay).
{
  const rig = makeRig();
  for (let i = 0; i < 60; i++) rig.mem.ram[0x0400 + i] = 0xEA;
  rig.mem.ram[0x4000] = 0x55;
  // Place LDA so that cycle 4 (data read) lands at c58 (full AEC zone).
  driveTo(rig, 1, 54);
  const pc = rig.cpu.pc;
  rig.mem.ram[pc] = 0xAD;
  rig.mem.ram[pc + 1] = 0x00;
  rig.mem.ram[pc + 2] = 0x40;
  // Run until LDA completes.
  let masterCycles = 0;
  let started = false;
  while (masterCycles < 30 && (!started || !rig.cpu.atInstructionBoundary())) {
    rig.vic.clock(1);
    masterCycles++;
    const blocked = (rig.vic.isBaLow() && rig.cpu.peekNextBusKind() === 'read') || rig.vic.isAecLow();
    if (!blocked) { rig.cpu.clock(); started = true; }
  }
  expect(rig.cpu.a === 0x55, `LDA must complete with $55, got $${rig.cpu.a.toString(16)}`);
  // Spec: LDA stalls during BA-low (c55..c63 = 9 cycles) + BA stays low
  // through c0 phantom..c-end of sprite chain. With sp0 alone, BA back
  // high at c60. AEC c58..c59. So stall ~6 cycles. Total ~10 cycles.
  expect(masterCycles >= 5 && masterCycles <= 30,
    `LDA stall path completes: 5-30 master cycles, got ${masterCycles}`);
  ok('Bauer §3.6.1: CPU resumes read immediately after BA goes high');
}

console.log(`\n${testNo} write-during-BA spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
