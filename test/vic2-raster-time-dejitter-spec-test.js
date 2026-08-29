// raster_time_gp de-jitter mechanism spec test.
//
// raster_time_gp uses the canonical "double-read de-jitter" pattern at
// $6222-$622D:
//
//   $6222: LDA $D012      ; 4 cy, data-read at the 4th cycle
//   $6225: CMP $D012      ; 4 cy, data-read 4 cy after LDA's
//   $6228: BNE skip       ; 2-3 cy
//   $622A: BIT $0         ; 3 cy — compensation path (= reads were equal)
//   $622D: skip = next code path
//
// Spec-correct behavior (Bauer §3.6.3): the raster counter increments at
// cycle 1 of every line (cycle 2 for line 0). $D012 returns the live
// counter value. If the two reads span a line wrap, they see different
// values and BNE is taken (= raster_time non-BIT / no compensation path).
// If both reads are within the same line, they're equal and BIT $0
// executes (= +4 cy compensation path).
//
// VICE measurement (60 frames of raster_time_gp): the de-jitter ALWAYS
// goes through the BNE-taken path. Our impl (post-fix 2026-05-21) goes
// through the BIT path 100% of the time — indicating the spinner exits
// 1 cycle late, so both de-jitter reads land in the new line.
//
// Spec references:
//   - https://www.cebix.net/VIC-Article.txt (Bauer §3.6.3): "the moment in which
//     the RASTER register is incremented" = cycle 1; line 0 exception
//     delays the reset by one cycle.
//   - https://sourceforge.net/p/vice-emu/code/HEAD/tree/techdocs/VICII/VIC-Addendum.txt: "Raster comparison is edge triggered."
//
// What this file pins beyond existing $D012 tests:
//
//   1. _cpuVisibleRaster() returns OLD raster at the wrap MC (our cy 0).
//   2. _cpuVisibleRaster() returns NEW raster at our cy 1+.
//   3. _cpuVisibleRaster() at L0.cy1 returns 311 (delayed reset).
//   4. Back-to-back $D012 reads (LDA + CMP, 4 cy apart) parked so the
//      reads span a wrap produce UNEQUAL CPU-observed values.
//   5. Reads parked entirely within one line produce EQUAL values.
//   6. Full de-jitter sequence (LDA; CMP; BNE; BIT): the BNE-taken vs
//      BNE-not-taken paths execute correctly for both alignments.

import { C64Machine } from '../src/machine.js';
import { CYCLES_PER_LINE, LINES_PER_FRAME } from '../src/vic2.js';

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
  m.mem.write(0x0001, 0x35);  // bank out BASIC/KERNAL
  return m;
}

function driveAndPark(m, raster, cycle) {
  let safety = 400000;
  while (--safety && !(m.vic2.raster === raster && m.vic2.cycleInLine === cycle)) {
    C64Machine.prototype._runMasterCycle.call(m);
  }
  if (safety <= 0) throw new Error(`driveAndPark timed out at L${m.vic2.raster}.c${m.vic2.cycleInLine}`);
  m.cpu.pc = 0x1000;
  m.cpu.instructionCyclesRemaining = 0;
  m.cpu.microOpHead = 0;
  m.cpu.microOpLen = 0;
}

function runMC(m, n) {
  for (let i = 0; i < n; i++) C64Machine.prototype._runMasterCycle.call(m);
}

function installDoubleRead(m) {
  m.mem.ram[0x1000] = 0xAD; m.mem.ram[0x1001] = 0x12; m.mem.ram[0x1002] = 0xD0;  // LDA $D012
  m.mem.ram[0x1003] = 0xCD; m.mem.ram[0x1004] = 0x12; m.mem.ram[0x1005] = 0xD0;  // CMP $D012
}

// ── 1: $D012 CPU read at the wrap cycle returns OLD raster ─────────────
//
// Spec (Bauer §3.6.3): the raster register increments concurrent with
// cycle 1 of the new line. Before that increment (= at the inter-line
// boundary), the CPU-observed raster value must still equal N, not N+1.
// This is the spec-correct behavior of the live $D012 counter at the
// moment of line transition.
{
  const m = makeMachine();
  driveAndPark(m, 0x50, 62);
  m.vic2.clock(1);  // advance one vic cycle — wraps into new line
  const d012 = m.mem.read(0xD012);
  expect(d012 === 0x50,
    `$D012 at the wrap moment returns OLD raster $50 (per Bauer §3.6.3: raster increments at cycle 1, not before); got $${d012.toString(16)}`);
  ok('Bauer §3.6.3: $D012 at line-wrap boundary still reads OLD raster (pre-increment)');
}

// ── 2: $D012 CPU read at cycle 1 of new line returns NEW raster ────────
//
// Per Bauer §3.6.3, the increment IS visible at cycle 1.
{
  const m = makeMachine();
  driveAndPark(m, 0x50, 62);
  m.vic2.clock(1);  // wrap
  m.vic2.clock(1);  // now cycle 1 of new line
  const d012 = m.mem.read(0xD012);
  expect(d012 === 0x51,
    `$D012 at cycle 1 of new line returns NEW raster $51 (= post-increment); got $${d012.toString(16)}`);
  ok('Bauer §3.6.3: $D012 at cycle 1 of new line reads NEW raster (post-increment)');
}

// ── 3: L0.cy1 wrap exception — $D012 reads 311 (delayed reset) ──────────
//
// Bauer §3.6.3: "Raster line 0 is, however, an exception: In this line,
// IRQ and incrementing (resp. resetting) of RASTER are performed one
// cycle later than in the other lines."
// At L0.cy1, raster is still latched at 311; reset to 0 at cy 2.
// Also Bauer §3.12 cross-check: $D011 bit 7 (RST8 on read) shows bit 8
// of the raster — at L0.cy1 with raster=311, bit 8 = 1, so bit 7 of
// $D011 read is set.
{
  const m = makeMachine();
  driveAndPark(m, 0, 1);
  const d012_at_l0c1 = m.mem.read(0xD012);
  const d011_at_l0c1 = m.mem.read(0xD011);
  expect(d012_at_l0c1 === ((LINES_PER_FRAME - 1) & 0xFF),
    `$D012 at L0.cy1 = $37 (= 311 & 0xFF, delayed reset); got $${d012_at_l0c1.toString(16)}`);
  expect((d011_at_l0c1 & 0x80) !== 0,
    `$D011 bit 7 at L0.cy1 = 1 (= bit 8 of raster 311); got $${d011_at_l0c1.toString(16)}`);

  m.vic2.clock(1);  // advance to cy 2 — reset takes effect
  const d012_at_l0c2 = m.mem.read(0xD012);
  expect(d012_at_l0c2 === 0,
    `$D012 at L0.cy2 = 0 (reset complete); got $${d012_at_l0c2.toString(16)}`);
  ok('Bauer §3.6.3: $D012 at L0.cy1 reads $37 (delayed reset); at L0.cy2 reads 0');
}

// ── 4: LDA $D012 with data-read at the wrap MC returns OLD raster ──────
//
// Park at cycleInLine = 59 so the 4-cy LDA's data read lands at the
// line transition. Per Bauer §3.6.3, $D012 read at the transition
// moment returns OLD raster (= raster has not yet incremented).
//
// LDA-abs cycle structure (NMOS 6502 spec, 4 cy): op fetch, addr lo,
// addr hi, data read. Data read happens at the 4th cycle. Starting
// the LDA at cy 59 + 1 (= MC1 advances vic to cy 60) places the data
// read at cy 63 (= last cycle of line N = pre-increment moment).
{
  const m = makeMachine();
  installDoubleRead(m);
  driveAndPark(m, 0x50, 59);
  runMC(m, 4);
  expect(m.cpu.a === 0x50,
    `LDA $D012 at line transition: A = $50 (= old raster, pre-increment per Bauer §3.6.3); got $${m.cpu.a.toString(16)}`);
  ok('Bauer §3.6.3: LDA $D012 data-read at line transition returns OLD raster');
}

// ── 5: LDA $D012 + CMP $D012 spanning the wrap MC produces UNEQUAL ─────
//
// With park at cycleInLine = 59:
//   LDA data read at wrap MC (cy 0) → A = $50
//   CMP data read 4 MCs later at cy 4 → B = $51
// CMP A,B: $50 != $51 → Z=0, BNE taken.
{
  const m = makeMachine();
  installDoubleRead(m);
  driveAndPark(m, 0x50, 59);
  runMC(m, 8);
  const z = m.cpu.Z !== 0;
  expect(m.cpu.a === 0x50, `first read = old raster $50; got A=$${m.cpu.a.toString(16)}`);
  expect(z === false,
    `Reads span wrap → CMP Z=0 (BNE will be taken); got Z=${z?1:0}, vic at L$${m.vic2.raster.toString(16)} cy ${m.vic2.cycleInLine}`);
  ok('Bauer §3.6.3: $D012 double-read spanning line wrap returns UNEQUAL values');
}

// ── 6: LDA $D012 + CMP $D012 fully within one line produces EQUAL ──────
{
  const m = makeMachine();
  installDoubleRead(m);
  driveAndPark(m, 0x50, 10);
  runMC(m, 8);
  const z = m.cpu.Z !== 0;
  expect(m.cpu.a === 0x50, `LDA $D012 inside line: A=$50; got A=$${m.cpu.a.toString(16)}`);
  expect(z === true,
    `Reads within same line → CMP Z=1 (BNE not taken); got Z=${z?1:0}`);
  ok('Bauer §3.6.3: $D012 double-read fully within one line returns EQUAL values');
}

// ── 7: Boundary sweep — find which start cycles produce unequal reads ──
//
// Sweep cycleInLine = 54..62 as start point. Per the wrap-MC compensation
// rule, the unequal-reads window is {56, 57, 58, 59} (= 4 cycles wide).
// K=54 + K=55: both reads inside old line OR second at wrap (= still OLD)
// K=56..59: first read inside old line, second read inside new line
// K=60..62: first read across wrap, second read in new line (= both NEW)
{
  const m = makeMachine();
  installDoubleRead(m);
  const results = [];
  for (const k of [54, 55, 56, 57, 58, 59, 60, 61, 62]) {
    driveAndPark(m, 0x50, k);
    runMC(m, 8);
    const z = m.cpu.Z !== 0;
    results.push({ k, z, a: m.cpu.a });
  }
  const differAtK = results.filter(r => !r.z).map(r => r.k);
  expect(differAtK.length === 4,
    `Exactly 4 start cycles should produce unequal reads (= 4-cy wrap-spanning window); got ${differAtK.length}: K=${differAtK.join(',')}`);
  expect(differAtK[0] >= 55 && differAtK[differAtK.length - 1] <= 60,
    `Wrap-spanning window should fall in K=55..60; got K=${differAtK.join(',')}`);
  ok(`Bauer §3.6.3: $D012 double-read wrap-spanning window has exactly 4-cycle width`);
}

// ── 8: Monotonic raster reads across normal line transitions ────────────
{
  const m = makeMachine();
  m.mem.ram[0x1000] = 0xAD; m.mem.ram[0x1001] = 0x12; m.mem.ram[0x1002] = 0xD0;

  for (const N of [0x10, 0x20, 0x30, 0x40, 0x60, 0x80]) {
    driveAndPark(m, N + 1, 5);
    runMC(m, 4);
    expect(m.cpu.a === ((N + 1) & 0xFF),
      `at L$${(N+1).toString(16)} cy 5: $D012 = $${(N+1).toString(16)}; got $${m.cpu.a.toString(16)}`);
  }
  ok('Bauer §3.6.3: $D012 reads track raster monotonically across normal line transitions');
}

// ── 9: Full de-jitter sequence — BNE-taken path (= wrap-spanning reads) ─
//
// LDA $D012; CMP $D012; BNE skip; BIT $00; NOP. Park at K=58 to land in
// the wrap-spanning window. Expected: BNE taken → PC reaches NOP at $100A.
{
  const m = makeMachine();
  m.mem.ram[0x1000] = 0xAD; m.mem.ram[0x1001] = 0x12; m.mem.ram[0x1002] = 0xD0;  // LDA $D012
  m.mem.ram[0x1003] = 0xCD; m.mem.ram[0x1004] = 0x12; m.mem.ram[0x1005] = 0xD0;  // CMP $D012
  m.mem.ram[0x1006] = 0xD0; m.mem.ram[0x1007] = 0x02;                            // BNE +2 → $100A
  m.mem.ram[0x1008] = 0x24; m.mem.ram[0x1009] = 0x00;                            // BIT $00
  m.mem.ram[0x100A] = 0xEA;                                                       // NOP

  driveAndPark(m, 0x50, 58);
  // LDA 4 + CMP 4 + BNE-taken (3 cy, no page cross) = 11 MCs total.
  // BNE-not-taken path would be: LDA 4 + CMP 4 + BNE-not-taken (2 cy) = 10 MCs,
  // then BIT $00 op fetch at MC11 (PC advances to $1009, not $100A).
  runMC(m, 11);
  expect(m.cpu.pc === 0x100A,
    `After 11 MCs with wrap-spanning reads, PC=$100A (BNE took branch to skip BIT); got PC=$${m.cpu.pc.toString(16)}`);
  ok('De-jitter spec timing: wrap-spanning reads → BNE taken → skip BIT compensation');
}

// ── 10: Full de-jitter sequence — BNE-not-taken path (= same-line reads) ─
{
  const m = makeMachine();
  m.mem.ram[0x1000] = 0xAD; m.mem.ram[0x1001] = 0x12; m.mem.ram[0x1002] = 0xD0;
  m.mem.ram[0x1003] = 0xCD; m.mem.ram[0x1004] = 0x12; m.mem.ram[0x1005] = 0xD0;
  m.mem.ram[0x1006] = 0xD0; m.mem.ram[0x1007] = 0x02;
  m.mem.ram[0x1008] = 0x24; m.mem.ram[0x1009] = 0x00;
  m.mem.ram[0x100A] = 0xEA;

  driveAndPark(m, 0x50, 10);
  // LDA 4 + CMP 4 + BNE-not-taken (2 cy) + BIT $00 (3 cy) = 13 MCs.
  // At MC11 (before BIT), PC=$1009 (BIT op fetch in progress). At MC13 (BIT done),
  // PC=$100A. We sample at MC11 to specifically distinguish BNE-not-taken from
  // BNE-taken (which would have PC=$100A at MC11).
  runMC(m, 11);
  expect(m.cpu.pc === 0x1009,
    `After 11 MCs with same-line reads, PC=$1009 (BNE fell through, BIT op fetched); got PC=$${m.cpu.pc.toString(16)}`);
  runMC(m, 2);  // finish BIT
  expect(m.cpu.pc === 0x100A,
    `After 13 MCs total, BIT done, PC=$100A; got PC=$${m.cpu.pc.toString(16)}`);
  ok('De-jitter spec timing: same-line reads → BNE not taken → BIT $00 compensation runs');
}

console.log(`\n${testNo} raster_time de-jitter spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
