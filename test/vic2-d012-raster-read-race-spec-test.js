// $D012 raster-read race spec test.
//
// Bauer §3.12: $D012 reads the low 8 bits of the current raster
// counter; $D011 bit 7 (RST8 on read) holds the 9th bit. The raster
// counter increments at cy 0 of each line (raster $X → raster $X+1).
// Reading $D012 returns the LIVE counter value.
//
// Stable-IRQ chains poll $D012 in tight loops (or via cmp $D012 / bne
// .loop) to synchronize handler entry to a specific raster. The exact
// cycle the new raster becomes visible to the CPU matters.
//
// In our integration: VIC clocks BEFORE CPU each master cycle. So if
// VIC increments raster at cy 0 phi1, the CPU's phi2 read at cy 0 sees
// the NEW raster.

import { C64Machine } from '../src/machine.js';

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

function makeMachine() {
  const m = new C64Machine();
  m.reset();
  m.mem.ram.fill(0xEA);
  m.cpu.pc = 0x1000;
  m.cpu.instructionCyclesRemaining = 0;
  m.cpu.microOpHead = 0;
  m.cpu.microOpLen = 0;
  // Disable BASIC/KERNAL so we can park CPU at NOP loop in RAM safely.
  m.mem.write(0x0001, 0x35);
  return m;
}

// Drive VIC to target raster/cycle, then re-park CPU at $1000 at
// instruction boundary so the test's installed instructions execute
// from a known PC.
function driveAndPark(m, raster, cycle) {
  let safety = 200000;
  while (--safety && !(m.vic2.raster === raster && m.vic2.cycleInLine === cycle)) {
    C64Machine.prototype._runMasterCycle.call(m);
  }
  if (safety <= 0) throw new Error(`driveAndPark timed out at L${m.vic2.raster}.c${m.vic2.cycleInLine}`);
  m.cpu.pc = 0x1000;
  m.cpu.instructionCyclesRemaining = 0;
  m.cpu.microOpHead = 0;
  m.cpu.microOpLen = 0;
}

// ── 1: LDA $D012 mid-raster returns current raster low byte.
//
// At raster $50 cy 20, vic.raster === 0x50. Execute LDA $D012 and verify
// A = $50.
{
  const m = makeMachine();
  m.mem.ram[0x1000] = 0xAD; m.mem.ram[0x1001] = 0x12; m.mem.ram[0x1002] = 0xD0; // LDA $D012
  driveAndPark(m, 0x50, 20);
  // CPU at instruction boundary at cy 20. Run LDA $D012 = 4 cycles
  // (opcode, lo, hi, data read).
  for (let i = 0; i < 4; i++) C64Machine.prototype._runMasterCycle.call(m);
  expect(m.cpu.a === 0x50,
    `LDA $D012 at raster $50: A=$50; got $${m.cpu.a.toString(16)}`);
  ok('Bauer §3.12: LDA $D012 mid-raster returns current raster low byte');
}

// ── 2: LDA $D012 across raster transition — reads NEW raster.
//
// Park CPU at raster R cy 60. LDA $D012 begins. Its data-read cycle
// lands AT raster R+1 cy 0 (since LDA abs = 4 cy, fetch at 60, 61, 62,
// and the data-read at cy 0 of next line). At that moment vic.raster
// has incremented to R+1.
{
  const m = makeMachine();
  m.mem.ram[0x1000] = 0xAD; m.mem.ram[0x1001] = 0x12; m.mem.ram[0x1002] = 0xD0;
  driveAndPark(m, 0x50, 60);
  // 3-cycle fetch at cy 60, 61, 62. Cy 0 of raster $51 = data-read.
  for (let i = 0; i < 4; i++) C64Machine.prototype._runMasterCycle.call(m);
  expect(m.cpu.a === 0x51,
    `LDA $D012 spanning raster transition: A=$51 (data-read at raster $51 cy 0); got $${m.cpu.a.toString(16)}`);
  ok('Bauer §3.12: LDA $D012 across raster transition reads NEW raster (VIC-first ordering)');
}

// ── 3: $D012 changes monotonically across rasters — sample at multiple
// rasters and verify each returns its own raster value.
{
  const m = makeMachine();
  const samples = [];
  for (const target of [0x30, 0x40, 0x50, 0x60, 0x70]) {
    driveAndPark(m, target, 10);
    samples.push({ target, d012: m.mem.read(0xD012) });
  }
  for (const s of samples) {
    expect(s.d012 === s.target,
      `at raster $${s.target.toString(16)}: $D012 reads $${s.target.toString(16)}; got $${s.d012.toString(16)}`);
  }
  ok('Bauer §3.12: $D012 reads track live raster across multiple rasters');
}

// ── 4: $D011 bit 7 (RST8) on READ reflects raster bit 8.
//
// At raster $100 (= 256), $D011 bit 7 must be 1 when read. At raster
// $00, bit 7 must be 0.
{
  const m = makeMachine();
  m.mem.ram[0x1000] = 0xAD; m.mem.ram[0x1001] = 0x11; m.mem.ram[0x1002] = 0xD0; // LDA $D011
  driveAndPark(m, 0x100, 20);
  // Sample DEN/RSEL/YSCROLL bits separately — only check bit 7.
  for (let i = 0; i < 4; i++) C64Machine.prototype._runMasterCycle.call(m);
  expect((m.cpu.a & 0x80) === 0x80,
    `raster $100: $D011 bit 7 = 1 (RST8 on read); got $${m.cpu.a.toString(16)}`);
  // Now at raster $00.
  m.cpu.pc = 0x1000;
  m.cpu.instructionCyclesRemaining = 0;
  m.cpu.microOpHead = 0;
  m.cpu.microOpLen = 0;
  driveAndPark(m, 0x00, 20);
  for (let i = 0; i < 4; i++) C64Machine.prototype._runMasterCycle.call(m);
  expect((m.cpu.a & 0x80) === 0x00,
    `raster $00: $D011 bit 7 = 0 (RST8 on read); got $${m.cpu.a.toString(16)}`);
  ok('Bauer §3.12: $D011 bit 7 (RST8) read reflects raster bit 8 (RST8 on read != RST8 on write)');
}

console.log(`\n${testNo} $D012 raster-read race spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
