// Sprite-BA contour per sprite (0..7) spec test.
//
// Bauer §3.8.1 + §3.6.1: each sprite has its own p-access cycle. BA
// goes LOW 3 cycles before the sprite's first s-access. With only one
// sprite enabled, the BA-low window is local to that sprite. PAL cycle
// table (Bauer §3.8.2 PAL access table):
//
//   sprite 0: p-access cy 58 (s-access 58-59) → BA-low 55..59
//   sprite 1: p-access cy 60 (s-access 60-61) → BA-low 57..61 (overlaps sprite 0 if both on)
//   sprite 2: p-access cy 62 (s-access 62-0)  → BA-low 59..0 (wraps)
//   sprite 3: p-access cy 1  (s-access 1-2)   → BA-low 61..2  (wraps from prev line)
//   sprite 4: p-access cy 3  (s-access 3-4)   → BA-low 0..4
//   sprite 5: p-access cy 5  (s-access 5-6)   → BA-low 2..6
//   sprite 6: p-access cy 7  (s-access 7-8)   → BA-low 4..8
//   sprite 7: p-access cy 9  (s-access 9-10)  → BA-low 6..10
//
// This file enables ONE sprite at a time and asserts the BA-low contour
// matches the spec. Catches any per-sprite p-access cycle drift.
//
// Audit gap: per-sprite BA contour — `sprite-ba-cycles-test.js` covers
// sprite 0 in detail; this file extends to all 8 sprites independently.

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';

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

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  vic.vicVariant = '6569';
  return vic;
}

function driveTo(vic, raster, cy) {
  let safety = 312 * CYCLES_PER_LINE * 3;
  while (--safety && !(vic.raster === raster && vic.cycleInLine === cy)) vic.clock(1);
  if (safety <= 0) throw new Error(`driveTo timed out at L${vic.raster}.c${vic.cycleInLine}`);
}

// Returns array of (raster, cycle) tuples for the FIRST contiguous
// BA-low block (single sprite-DMA window). Scans until BA goes low,
// then collects consecutive low cycles, then stops at the first
// rising edge after the first fall.
function captureBaLowWindow(vic, startRaster, startCy, lineSpan) {
  const lows = [];
  driveTo(vic, startRaster, startCy);
  let seenLow = false;
  for (let i = 0; i < lineSpan * CYCLES_PER_LINE; i++) {
    const isLow = vic.isSpriteBaLow();
    if (isLow) {
      lows.push({ r: vic.raster, c: vic.cycleInLine });
      seenLow = true;
    } else if (seenLow) {
      break;
    }
    vic.clock(1);
  }
  return lows;
}

// Per-sprite spec: { p-cycle, BA-low first cycle, BA-low last cycle,
// wrap (does the window cross a line boundary?) }
const spriteSpec = [
  { sprite: 0, pCycle: 58, baLowFirst: 55, baLowLast: 59, wraps: false },
  { sprite: 1, pCycle: 60, baLowFirst: 57, baLowLast: 61, wraps: false },
  { sprite: 2, pCycle: 62, baLowFirst: 59, baLowLast: 0,  wraps: true },
  { sprite: 3, pCycle: 1,  baLowFirst: 61, baLowLast: 2,  wraps: true },
  { sprite: 4, pCycle: 3,  baLowFirst: 0,  baLowLast: 4,  wraps: false },
  { sprite: 5, pCycle: 5,  baLowFirst: 2,  baLowLast: 6,  wraps: false },
  { sprite: 6, pCycle: 7,  baLowFirst: 4,  baLowLast: 8,  wraps: false },
  { sprite: 7, pCycle: 9,  baLowFirst: 6,  baLowLast: 10, wraps: false },
];

// ── 1..8: per-sprite BA contour (only sprite N enabled).
for (const s of spriteSpec) {
  const vic = makeVic();
  vic.spriteDmaOn[s.sprite] = 1;
  // Drive across 2 lines so the wrap cases are captured.
  const lows = captureBaLowWindow(vic, 10, 50, 2);
  // The contour width should be exactly 5 cycles (3-cy BA lead + 2 s-access).
  expect(lows.length === 5,
    `sprite ${s.sprite}: BA-low width = 5 cycles; got ${lows.length} (${JSON.stringify(lows)})`);
  if (lows.length === 5) {
    const firstC = lows[0].c, lastC = lows[lows.length - 1].c;
    expect(firstC === s.baLowFirst,
      `sprite ${s.sprite}: BA-low first cycle = ${s.baLowFirst}; got ${firstC}`);
    expect(lastC === s.baLowLast,
      `sprite ${s.sprite}: BA-low last cycle = ${s.baLowLast}; got ${lastC}`);
    if (s.wraps) {
      expect(lows[0].r !== lows[lows.length - 1].r,
        `sprite ${s.sprite}: wraps across line boundary; first r=${lows[0].r} last r=${lows[lows.length - 1].r}`);
    } else {
      expect(lows[0].r === lows[lows.length - 1].r,
        `sprite ${s.sprite}: same-line window; first r=${lows[0].r} last r=${lows[lows.length - 1].r}`);
    }
  }
  ok(`Bauer §3.8.1: sprite ${s.sprite} BA-low contour cy ${s.baLowFirst}..${s.baLowLast}${s.wraps ? ' (wraps)' : ''}`);
}

// ── 9: All 8 sprites enabled — BA-low contour is contiguous cy 55..10
// (wrapping) = 19 cycles total (5 cy of line N: 55..59 + 60..62 + 14 cy
// of line N+1: 0..10... wait let me recount).
//
// Sprites 0-7 contour overlap rules: sprite N's BA window starts 3 cy
// before its s-access. Adjacent sprites are 2 cy apart. So BA-low is
// CONTIGUOUS across all 8 sprites when they're all enabled.
//
// Window: cy 55 (sprite 0 start) → cy 10 of next line (sprite 7 end).
// That's 8 cy of line N (55..62) + 11 cy of line N+1 (0..10) = 19 cy.
{
  const vic = makeVic();
  for (let s = 0; s < 8; s++) vic.spriteDmaOn[s] = 1;
  const lows = captureBaLowWindow(vic, 10, 50, 2);
  expect(lows.length === 19,
    `all 8 sprites: BA-low contour = 19 cycles contiguous; got ${lows.length}`);
  if (lows.length > 0) {
    expect(lows[0].c === 55,
      `all 8 sprites: contour starts at cy 55 (sprite 0); got cy ${lows[0].c}`);
    expect(lows[lows.length - 1].c === 10,
      `all 8 sprites: contour ends at cy 10 (sprite 7); got cy ${lows[lows.length - 1].c}`);
  }
  ok('Bauer §3.8.1: all 8 sprites enabled → BA-low contour cy 55 (raster N) .. cy 10 (raster N+1), 19 cycles');
}

console.log(`\n${testNo} sprite-BA contour per-sprite spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
