// Sprite BA-low / AEC-low cycle accounting spec audit. Per Bauer §3.6.1
// + the bumbershootsoft "VIC-II interrupt timing" article + DEMO-NINE.md
// rule 1 (flanking DMA):
//
//   - Each enabled sprite has a p-access (1 phi1 cycle) and an s-access
//     (1 phi1+phi2 cycle). Per-sprite p/s cycles:
//        sp0: p=58, s=59      sp1: p=60, s=61
//        sp2: p=62, s=63      sp3: p=1,  s=2  (next line)
//        sp4: p=3,  s=4       sp5: p=5,  s=6
//        sp6: p=7,  s=8       sp7: p=9,  s=10  (wait — let me check)
//
//   - BA goes low 3 cycles BEFORE the p-access and stays low through
//     p-access + s-access. AEC = BA(c) && BA(c-3) — so AEC tracks BA
//     after a 3-cycle settling time.
//
//   - "Flanking DMA" (rule 1): if two enabled sprite slots are < 3
//     cycles apart, BA never goes back up between them, so the CPU
//     cycles in the gap are also stolen. nine.prg uses sprites 0/2/4/6
//     as anchors so the cycle budget is constant whether sprites
//     1/3/5/7 are enabled or not.
//
// Each test below enables a specific sprite combo, drives the VIC across
// the relevant cycle range, and asserts the exact stolen-cycle count.
// If any test fails, timed raster code can drift because the emulator is
// charging the wrong number of Bauer §3.6.1 AEC-low cycles.

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  return vic;
}

function driveTo(vic, raster, cycle) {
  let safety = 200000;
  while (--safety) {
    if (vic.raster === raster && vic.cycleInLine === cycle) return;
    vic.clock(1);
  }
  throw new Error(`driveTo timed out`);
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

// Helper: count AEC-low cycles across exactly one PAL line (cycles 1..63).
// PAL VIC-II has 63 cycles per line; cycleInLine 0 is the post-wrap
// reset, NOT a real cycle. Pre-arms sprites with DMA on and Y=200 so the
// cycle-55/56 DMA-start checks don't fire mid-test.
function countStallsAcrossLine(vic, sprMask) {
  vic.regs[0x15] = sprMask;
  for (let s = 0; s < 8; s++) {
    if ((sprMask >> s) & 1) {
      vic.spriteDmaOn[s] = 1;
      vic.regs[s * 2 + 1] = 200;
    }
  }
  driveTo(vic, 1, 0);                  // line 1 cycle 0 = post-wrap state
  let stalls = 0;
  for (let cy = 1; cy <= CYCLES_PER_LINE; cy++) {
    // Synthetic test: spriteDmaOn[] was set directly, so use the live
    // pure-function form of AEC (Bauer §3.6.1 BA(c) && BA(c-3) over
    // current state). _spriteStealsCpuCycle delegates to the historic
    // variant which requires per-cycle BA history that the synthetic
    // setup hasn't populated for all cy 1..63 yet.
    if (vic._spriteAecLow(cy)) stalls++;
  }
  return stalls;
}

// ── 1: Sprite 0 alone → 2 AEC stalls (cycles 58, 59) ──────────────────
// Bauer §3.6.1: AEC = BA(c) && BA(c-3). With sp0 p=58, BA spans c55..c59,
// AEC asserts at c58 and c59.
{
  const vic = makeVic();
  const stalls = countStallsAcrossLine(vic, 0x01);
  expect(stalls === 2, `sp0 alone: 2 stalls expected, got ${stalls}`);
  ok('Bauer §3.6.1: sprite 0 alone steals exactly 2 cycles per line');
}

// ── 2: Sprites 0 + 1 (adjacent, no gap) → 4 stalls ────────────────────
// sp0 p=58 s=59, sp1 p=60 s=61. BA covers c55..c61 contiguously. AEC
// at c58, c59, c60, c61 = 4 cycles.
{
  const vic = makeVic();
  const stalls = countStallsAcrossLine(vic, 0x03);
  expect(stalls === 4, `sp0+sp1: 4 stalls expected, got ${stalls}`);
  ok('Bauer §3.6.1: adjacent sprites 0+1 steal 4 cycles per line');
}

// ── 3: Sprites 0 + 2 ("flanking") → 6 stalls due to BA staying low ────
// DEMO-NINE rule 1: sp0 (p=58, s=59) and sp2 (p=62, s=63) are 4 cycles
// apart. sp2's BA-low lead starts at c59 (= c62-3). sp0's BA stays low
// through c59. So BA is contiguous c55..c63. AEC asserts at c58..c63 =
// 6 cycles. The "missing" sp1 slot (c60, c61) IS stolen.
{
  const vic = makeVic();
  const stalls = countStallsAcrossLine(vic, 0x05);  // sp0 + sp2
  expect(stalls === 6, `sp0+sp2 (flanking): 6 stalls expected, got ${stalls}`);
  ok('DEMO-NINE rule 1: sp0+sp2 flanking steals 6 cycles (sp1 slot stolen too)');
}

// ── 4: Sprites 0 + 1 + 2 → also 6 stalls (sp1 explicitly enabled) ─────
// Same BA contour as sp0+sp2 flanking (BA already low through sp1's slot).
// Adding sp1 doesn't increase the AEC-low count — it just causes sp1's
// data to actually be fetched.
{
  const vic = makeVic();
  const stalls = countStallsAcrossLine(vic, 0x07);
  expect(stalls === 6, `sp0+sp1+sp2: 6 stalls expected, got ${stalls}`);
  ok('Flanking equivalence: sp0+sp1+sp2 = sp0+sp2 (6 stalls)');
}

// ── 5: All 8 sprites — Bauer §3.6.1 says 2 cycles per sprite = 16/line
// "Each sprite needs 2 cycles for its bus accesses" (Bauer §3.6.1). With
// all 8 sprites enabled, BA-low is contiguous from c55(line N) through
// c10(line N+1). AEC = BA(c) && BA(c-3) so AEC-low duration = BA-low
// duration − 3.
//
// Per-line count (measuring cycles 1..63 of line N+1; sp0/1/2 fire here,
// sp3-7 carry over from prev line's chain):
//   - c1..c10 (10 cycles): sp3-7 chain from sp2(prev)→sp7(this)
//   - c58..c63 (6 cycles): sp0+sp1+sp2 chain
// Total: 16 cycles. Matches Bauer's "2 × 8 = 16".
{
  const vic = makeVic();
  const stalls = countStallsAcrossLine(vic, 0xFF);
  expect(stalls === 16,
    `Bauer §3.6.1: 8 sprites × 2 cycles = 16 stalls per line, got ${stalls}`);
  ok('Bauer §3.6.1: all 8 sprites = 2 × 8 = 16 AEC-stall cycles per line');
}

// ── 6: BA-low extends 3 cycles before p-access (sp0) ──────────────────
// Spec: BA goes low at c55 = c58-3 for sp0. Verify by sampling the BA
// signal before, at, and after the lead start.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.spriteDmaOn[0] = 1;
  vic.regs[0x01] = 200;
  driveTo(vic, 1, 54);
  expect(!vic._spriteBaLow(54), `c54: BA must be high (4 cycles before p=58), got low`);
  driveTo(vic, 1, 55);
  expect(vic._spriteBaLow(55), `c55: BA must be low (3 cycles before p=58), got high`);
  driveTo(vic, 1, 59);
  expect(vic._spriteBaLow(59), `c59: BA must be low (s-access of sp0), got high`);
  ok('Bauer §3.6.1: sprite BA-low spans 3 lead cycles + p-access + s-access');
}

// ── 7: AEC asserts only after 3 cycles of BA-low warning ──────────────
// sp0 BA goes low at c55. AEC = BA(c) && BA(c-3). BA(55)=1 but BA(52)=0
// → AEC(55)=0. AEC first asserts at c58 (BA(58)=1, BA(55)=1).
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;
  vic.spriteDmaOn[0] = 1;
  vic.regs[0x01] = 200;
  for (const c of [55, 56, 57]) {
    driveTo(vic, 1, c);
    expect(!vic._spriteAecLow(c),
      `c${c}: AEC must NOT be low yet (BA only ${c - 55} cycles in); got AEC low`);
  }
  driveTo(vic, 1, 58);
  expect(vic._spriteAecLow(58),
    `c58: AEC must be low (BA(58)=1, BA(55)=1)`);
  ok('Bauer §3.6.1: AEC follows BA after 3-cycle settling');
}

// ── 8: Anchor pattern sp0+sp2+sp4+sp6 — flanking across line boundary ─
// Per DEMO-NINE rule 1: with sp0/2/4/6 anchors, BA stays low from c55 of
// line N through c8 of line N+1 (sp6 s-access). The cycle budget is
// constant regardless of whether sp1/3/5/7 are also enabled.
//
// Measure on line N+1: sp3 (p=1, s=2) → BA low c63(prev line), c0..c2;
// sp4 (p=3, s=4) → BA low c0..c4; sp5 (p=5, s=6); sp6 (p=7, s=8) → BA
// low through c8. So BA is contiguous c63(prev) .. c8(this). With all
// of sp3-7 disabled (just sp4+sp6 enabled on the new line) BA fragments.
//
// Test: sp4 alone → AEC at c3, c4 = 2 stalls (only sp4's own slot).
{
  const vic = makeVic();
  const stalls = countStallsAcrossLine(vic, 0x10);  // sp4 alone
  expect(stalls === 2, `sp4 alone: 2 stalls (c3, c4), got ${stalls}`);
  ok('Bauer §3.6.1: sp4 alone steals 2 cycles');
}

// ── 9: sp4 + sp6 flanking on same line → 6 stalls ────────────────────
// sp4 p=3, sp6 p=7; gap = 7 - 4 = 3 cycles. sp6 BA-low lead starts at
// c4. sp4 BA-low ends at c4 (s-access). So BA contiguous c0..c8. AEC
// at c3..c8 = 6 stalls.
{
  const vic = makeVic();
  const stalls = countStallsAcrossLine(vic, 0x50);  // sp4 + sp6
  expect(stalls === 6, `sp4+sp6 flanking: 6 stalls (c3..c8), got ${stalls}`);
  ok('DEMO-NINE rule 1: sp4+sp6 flanking steals 6 cycles');
}

// ── 10: Anchor sprites 0+2+4+6 (DEMO-NINE rule 1) ─────────────────────
// Bauer §3.6.1 + DEMO-NINE rule 1: with 4 anchor sprites flanked across
// the wrap (sp2 line N → sp4 line N+1, gap = c63→c3 = 4 cycles), BA is
// contiguous from c55 of line N to c8 of line N+1.
//
// Per-line cycle count for line N+1 (cycles 1..63):
//   - sp4+sp6 chain BA-low: c0..c8, but cycle 0 is not a real cycle
//     (PAL has 63 cycles 1..63), so AEC-low cycles in this window are
//     c1..c8 = 8 cycles
//   - sp0+sp2 chain BA-low: c55..c63 → AEC c58..c63 = 6 cycles
// Total: 14 cycles per line.
//
// (Compare: 4 sprites × 2 cycles each = 8 stalls if NOT flanking; the
// extra 6 cycles come from BA staying low across the sp2-sp4 wrap and
// the sp4-sp6 gap.)
{
  const vic = makeVic();
  const stalls = countStallsAcrossLine(vic, 0x55);  // 0,2,4,6
  expect(stalls === 14,
    `anchors 0+2+4+6: 14 stalls expected (8 from sp4/6 chain + 6 from sp0/2), got ${stalls}`);
  ok('DEMO-NINE rule 1: anchor sprites 0+2+4+6 = 14 AEC-stall cycles per line');
}

// ── 11: nine.prg snapshot scenario — sprites 0,2,4,5 (mask $35) ───────
// The user's snapshot shows D017=$35 enabling sprites 0,2,4,5 across the
// MxYE-crunch line transition (line 11→12). Per Bauer §3.6.1:
//   - Line N+1 sp0+sp2 chain: BA c55..c63, AEC c58..c63 = 6 cycles
//   - Line N+1 sp4+sp5 chain (spilling from line N's sp2 wrap): BA
//     c0..c6, AEC c1..c6 (phantom c0 excluded) = 6 cycles
// Per-line total: 12 cycles. Spec rule: 4 sprites × 2 cycles = 8 base
// + 4 cycles flanking gap (sp0..sp2 includes c60/61 stolen because sp1
// slot is BA-low; sp4..sp5 are adjacent so no extra gap).
// The base 8 from "2 cycles × 4 sprites" + 4 cycles for the sp0→sp2
// flanking BA bridge = 12. (sp4+sp5 are adjacent, no bridge.)
{
  const vic = makeVic();
  const stalls = countStallsAcrossLine(vic, 0x35);  // sprites 0,2,4,5
  expect(stalls === 12,
    `mask $35 (sp0,2,4,5): 12 stalls expected per line, got ${stalls}`);
  ok('Bauer §3.6.1: nine.prg mask $35 (sp0,2,4,5) = 12 AEC-stalls per line');
}

// ── 12: D017 diagnostic window — line 11 c34 to line 12 c10 ───────────
// Counts AEC stalls across an observed Nine $D017 window with sprites
// 0,2,4,5 enabled. The asserted value is derived from Bauer §3.6.1; the
// line/cycle endpoints are only the diagnostic scenario being measured.
//
// Spec count:
//   line 11 c34..c63 (30 wall cycles): only sp0+sp2 chain stalls in this
//     window, at c58..c63 = 6 stalls
//   line 12 c1..c10 (10 wall cycles): sp4+sp5 chain spilling at c1..c6
//     = 6 stalls
// Total stalls in window: 12. CPU instruction cycles available: 40-12=28.
//
// This is not a normative "the demo must write here" assertion. It only
// verifies the spec stall budget for this measured interval.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x35;
  for (const s of [0, 2, 4, 5]) {
    vic.spriteDmaOn[s] = 1;
    vic.regs[s * 2 + 1] = 200;
  }
  driveTo(vic, 11, 34);
  let stalls = 0;
  // Run from line 11 c34 to line 12 c10. That's (63-34) + 10 = 39 wall
  // cycles after the start point (we're already AT c34 so don't count it).
  // Track the cycle we just processed so a wrap to cycleInLine=0 is
  // sampled as the just-finished cy 63.
  for (let i = 0; i < 39; i++) {
    vic.clock(1);
    const cy = vic.cycleInLine === 0 ? CYCLES_PER_LINE : vic.cycleInLine;
    if (vic._spriteAecLow(cy)) stalls++;
  }
  // The demo wall-time gap is 40 cycles (c34 of line 11 inclusive to c10
  // of line 12 inclusive). We measure 39 cycles (c35..c10) since c34 was
  // the start position (the SET write completes at c34).
  expect(stalls === 12,
    `SET→CLEAR window, sp0,2,4,5: 12 AEC stalls expected, got ${stalls}`);
  ok('Bauer §3.6.1: SET→CLEAR window has exactly 12 AEC-stall cycles');
}

console.log(`\n${testNo} sprite-cycle accounting spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
