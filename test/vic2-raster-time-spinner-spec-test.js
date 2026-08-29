// raster_time_gp spinner-exit cycle spec test.
//
// The handler at $6215+ uses a tight CMP $D012 / BNE spinner to wait
// for a target raster:
//
//   $6215: LDA #target  ; 2 cy
//   $6217: CMP $D012    ; 4 cy abs, data-read at the 4th cycle
//   $621A: BNE $6217    ; 3 cy taken, 2 cy not taken
//
// Each iteration is 7 cy when taken (= no match yet). When CMP matches,
// BNE is not-taken (2 cy), spinner exits, total CMP+BNE = 6 cy.
//
// Spec-correct exit alignment (Bauer §3.6.3 + §3.12):
//   - CMP $D012 data-read returns the live raster at the 4th cycle of CMP.
//   - Raster register increments at cycle 1 of new line (cycle 2 for L0).
//   - The first iter whose data-read returns the target value matches.
//
// Per-iteration phase invariant: each 7-cy iter shifts the data-read
// cycle position by 7. The data-read cycle (= A) is determined by the
// SPINNER ENTRY PHASE and is line-invariant across iterations.
//
// Cycle math from park(L_pre, K):
//   MC 1: vic K+1, LDA op fetch
//   MC 2: vic K+2, LDA done (A:=target, 1 internal cy)
//   MC 3: vic K+3, CMP op fetch
//   MC 6: vic K+6, CMP data-read (= A in raster_time's nomenclature)
//   MC 7: vic K+7, BNE op fetch
//   MC 8: vic K+8, BNE operand fetch (last cy of not-taken)
//   MC 9: vic K+9, NOP op fetch — PC = $1008 (= exit detection point)
//
// So exit cy = data-read cy + 3 (for not-taken iter).
//
// Spec references:
//   - https://www.cebix.net/VIC-Article.txt (Bauer §3.6.3): raster increment at cy 1.
//   - https://www.cebix.net/VIC-Article.txt (Bauer §3.12): raster IRQ check at cy 1.
//   - 6502 spec: CMP-abs = 4 cy, BNE-taken-no-cross = 3 cy, BNE-not-taken = 2 cy.

import { C64Machine } from '../src/machine.js';
import { CYCLES_PER_LINE } from '../src/vic2.js';

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
  m.mem.write(0x0001, 0x35);
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

function installSpinner(m, target) {
  m.mem.ram[0x1000] = 0xA9; m.mem.ram[0x1001] = target;
  m.mem.ram[0x1002] = 0xCD; m.mem.ram[0x1003] = 0x12; m.mem.ram[0x1004] = 0xD0;
  m.mem.ram[0x1005] = 0xD0; m.mem.ram[0x1006] = 0xFB;
  m.mem.ram[0x1007] = 0xEA;
}

// Wait for NOP at $1007 to be fetched (= PC reaches $1008).
function runSpinnerUntilExit(m, maxIterMCs = 8192) {
  let mcRun = 0;
  while (mcRun < maxIterMCs && m.cpu.pc !== 0x1008) {
    C64Machine.prototype._runMasterCycle.call(m);
    mcRun++;
  }
  if (m.cpu.pc !== 0x1008) throw new Error(`spinner did not exit; pc=$${m.cpu.pc.toString(16)} after ${mcRun} MCs`);
  return { exitVicCycle: m.vic2.cycleInLine, exitVicRaster: m.vic2.raster, mcRun };
}

// ── 1: Spinner exit cycle for K=5, target = next line ──────────────────
//
// Park L$30.c5. Data-read phase = K+6 = cy 11 of L$30 → reads $30.
// 9 iters later (= 63 cy), data-read at cy 11+56 = 67 = cy 4 of L$31.
// L$31.c4: $D012 returns $31 → MATCH. Exit at cy 4+3 = cy 7 of L$31.
{
  const m = makeMachine();
  installSpinner(m, 0x31);
  driveAndPark(m, 0x30, 5);
  const { exitVicCycle, exitVicRaster } = runSpinnerUntilExit(m);
  expect(exitVicRaster === 0x31,
    `spinner exit at target raster $31; got $${exitVicRaster.toString(16)}`);
  expect(exitVicCycle === 7,
    `K=5: data-read at cy 11, iter 9 matches at L$31.c4, exit at cy 4+3=7; got cy ${exitVicCycle}`);
  ok('Spinner phase invariant: park L$30.c5 → exit L$31.c7 (= data-read cy 4 + BNE-not-taken 3)');
}

// ── 2: 1-cy entry shift → 1-cy exit shift ─────────────────────────────
{
  const m = makeMachine();
  installSpinner(m, 0x31);
  driveAndPark(m, 0x30, 6);
  const { exitVicCycle, exitVicRaster } = runSpinnerUntilExit(m);
  expect(exitVicRaster === 0x31, `exit raster $31; got $${exitVicRaster.toString(16)}`);
  expect(exitVicCycle === 8,
    `K=6 (1 cy later than K=5): exit shifts by 1 cy → cy 8; got cy ${exitVicCycle}`);
  ok('Spinner phase invariant: 1-cy entry shift → 1-cy exit shift (K=6 → exit cy 8)');
}

// ── 3: Spinner exit cycle is line-invariant ────────────────────────────
//
// Park at L$10 (= 33 lines before target $31). Phase invariant says
// exit cy depends only on entry K, not start line. K=5 → exit cy 7.
{
  const m = makeMachine();
  installSpinner(m, 0x31);
  driveAndPark(m, 0x10, 5);
  const { exitVicCycle, exitVicRaster } = runSpinnerUntilExit(m, 64 * 63);
  expect(exitVicRaster === 0x31,
    `spinner exit at raster $31 (from far-away start); got $${exitVicRaster.toString(16)}`);
  expect(exitVicCycle === 7,
    `phase invariant across long spinning: K=5 → exit cy 7 (same as test 1); got cy ${exitVicCycle}`);
  ok('Spinner phase invariant holds across many line transitions (L$10 → L$31)');
}

// ── 4: Sweep K=3..8 — every 1-cy shift produces 1-cy exit shift ────────
{
  const expected = { 3: 5, 4: 6, 5: 7, 6: 8, 7: 9, 8: 10 };
  const results = [];
  for (const K of Object.keys(expected).map(Number)) {
    const m = makeMachine();
    installSpinner(m, 0x31);
    driveAndPark(m, 0x30, K);
    const { exitVicCycle, exitVicRaster } = runSpinnerUntilExit(m);
    results.push({ K, exitVicCycle, exitVicRaster });
    expect(exitVicRaster === 0x31, `K=${K}: must exit at raster $31; got $${exitVicRaster.toString(16)}`);
    expect(exitVicCycle === expected[K],
      `K=${K}: exit cy must be ${expected[K]}; got ${exitVicCycle}`);
  }
  ok(`Spinner exit cycle: linear 1:1 shift across K=3..8 (${results.map(r => `${r.K}→${r.exitVicCycle}`).join(', ')})`);
}

// ── 5: Target raster $00 — exit during L0 (delayed reset) ──────────────
//
// Bauer §3.6.3 line-0 exception: at L0.cy1, $D012 still reads $37 (=
// 311 & 0xFF). $D012 reads 0 starting from L0.cy2.
//
// K=L311.c5: data-read at cy 11 of L311 → reads $37 (no match).
// Iter 9 at L0.c4 → reads 0 (cy >= 2, post-reset). MATCH. Exit cy 7.
{
  const m = makeMachine();
  installSpinner(m, 0x00);
  driveAndPark(m, 311, 5);
  const { exitVicCycle, exitVicRaster } = runSpinnerUntilExit(m, 64 * 63);
  expect(exitVicRaster === 0,
    `spinner targeting $00 must exit during L0; got L$${exitVicRaster.toString(16)}`);
  expect(exitVicCycle === 7,
    `K=L311.c5 + delayed reset → exit L0.c7; got cy ${exitVicCycle}`);
  ok('Bauer §3.6.3: spinner for $D012=0 exits during L0 (after delayed reset takes effect)');
}

// ── 6: Wrap MC of target raster is NOT a valid exit point ──────────────
//
// At cy 0 of target line (= wrap MC), _cpuVisibleRaster returns OLD
// raster (target - 1). So a data-read landing on the wrap MC does NOT
// match the target, and the spinner takes one extra iter.
//
// K=L$31.c57: data-read phase = cy 0 of L$32 (wrap MC, returns $31, no
// match). Iter 2 data-read at cy 7 of L$32 (returns $32, MATCH). Exit
// at cy 7+3 = cy 10. Compare to K=58 (data-read at cy 1, MATCH, exit
// cy 4) — the K=57 case is +6 cy "later" due to the extra iter.
{
  const m1 = makeMachine();
  installSpinner(m1, 0x32);
  driveAndPark(m1, 0x31, 57);
  const r1 = runSpinnerUntilExit(m1);
  expect(r1.exitVicRaster === 0x32 && r1.exitVicCycle === 10,
    `K=57 (data-read at wrap MC, no match): extra iter → exit L$32.c10; got L$${r1.exitVicRaster.toString(16)}.c${r1.exitVicCycle}`);

  const m2 = makeMachine();
  installSpinner(m2, 0x32);
  driveAndPark(m2, 0x31, 58);
  const r2 = runSpinnerUntilExit(m2);
  expect(r2.exitVicRaster === 0x32 && r2.exitVicCycle === 4,
    `K=58 (data-read at cy 1 post-increment): first-iter match → exit L$32.c4; got L$${r2.exitVicRaster.toString(16)}.c${r2.exitVicCycle}`);

  ok('Bauer §3.6.3: wrap MC of target raster is NOT a valid spinner exit point (skipped, +1 iter)');
}

// ── 7: MC count from spinner entry to exit is bounded by line distance ─
//
// From L$30.c5 to L$31.c7: roughly 1 line wrap (63 cy) + 9 cy from
// iter wraparound = 65 MCs. Pin this exact value.
{
  const m = makeMachine();
  installSpinner(m, 0x31);
  driveAndPark(m, 0x30, 5);
  const { mcRun } = runSpinnerUntilExit(m);
  expect(mcRun === 65,
    `K=L$30.c5 → exit L$31.c7: should take exactly 65 MCs (= 1 line wrap of iters + matching iter); got ${mcRun}`);
  ok(`Spinner MC count from L$30.c5 to L$31.c7 = 65 (matches spec: 9 iters * 7 + LDA 2 = 65)`);
}

// ── 8: Two consecutive iters' data-read cycles differ by exactly 7 ─────
//
// Each iter = CMP-abs (4 cy) + BNE-taken (3 cy) = 7 cy. So consecutive
// data-read cycles differ by 7 (mod 63).
{
  const m = makeMachine();
  installSpinner(m, 0xFF);  // unreachable target
  driveAndPark(m, 0x10, 5);
  // After park: vic at L$10.c5. LDA = 2 cy. CMP = 4 cy. So 6 MCs to data read.
  runMC(m, 6);
  const firstReadCy = m.vic2.cycleInLine;
  // BNE-taken = 3 cy + CMP next iter = 4 cy = 7 more MCs to next data read.
  runMC(m, 7);
  const secondReadCy = m.vic2.cycleInLine;
  const expectedSecond = (firstReadCy + 7) % CYCLES_PER_LINE;
  expect(secondReadCy === expectedSecond,
    `consecutive data-reads differ by 7 cy; first=cy ${firstReadCy}, second=cy ${secondReadCy}, expected=cy ${expectedSecond}`);
  ok('Spec: CMP $D012 + BNE-taken iter = exactly 7 cy → data-read phase shifts by 7 per iter');
}

// ── 9: Exit cycle for first-iter-match cases (K=58..62) ────────────────
//
// When park K is such that the very first CMP data-read lands at target
// raster's cy 1+ (post-increment), the spinner exits at MC 9.
// K=58: data-read at L$32.c1 → match → exit L$32.c4.
// K=59: data-read at L$32.c2 → match → exit L$32.c5.
// K=62: data-read at L$32.c5 → match → exit L$32.c8.
{
  const expected = { 58: 4, 59: 5, 60: 6, 61: 7, 62: 8 };
  for (const K of Object.keys(expected).map(Number)) {
    const m = makeMachine();
    installSpinner(m, 0x32);
    driveAndPark(m, 0x31, K);
    const { exitVicCycle, exitVicRaster, mcRun } = runSpinnerUntilExit(m);
    expect(exitVicRaster === 0x32,
      `K=${K}: exit raster $32; got $${exitVicRaster.toString(16)}`);
    expect(exitVicCycle === expected[K],
      `K=${K}: first-iter match → exit cy ${expected[K]}; got cy ${exitVicCycle}`);
    expect(mcRun === 9,
      `K=${K}: first-iter match → exit in exactly 9 MCs (LDA 2 + CMP 4 + BNE-not-taken 2 + NOP-fetch 1); got ${mcRun}`);
  }
  ok('Spinner first-iter-match: K=58..62 exits in exactly 9 MCs at cy 4..8 of target line');
}

console.log(`\n${testNo} raster_time spinner spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
