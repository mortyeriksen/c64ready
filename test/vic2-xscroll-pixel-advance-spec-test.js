// XSCROLL per-frame pixel-advance spec test.
//
// Bauer §3.7.2 + C64PRG §3.5: $D016 bits 0-2 = XSCROLL. With same fetched
// row codes, increasing XSCROLL by 1 shifts the rendered inner display
// RIGHT by 1 canvas pixel. Smooth-scroller demos rely on this: they
// advance XSCROLL by 1 every frame (and "rotate" the VM by one column
// every 8 frames). If a regression changes the per-pixel XSCROLL
// sample point, the demo's apparent velocity changes.
//
// This checks rendered pixel movement directly rather than inferring it from
// per-frame screen-RAM mutation.

import { VIC2, CYCLES_PER_LINE, CANVAS_W, C64_PALETTE } from '../src/vic2.js';

const PAL = (i) => (0xFF000000 |
  ((C64_PALETTE[i] & 0xFF) << 16) |
  (C64_PALETTE[i] & 0xFF00) |
  ((C64_PALETTE[i] >> 16) & 0xFF)) >>> 0;

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

// Drive VIC to raster R, cycle C.
function driveTo(vic, r, c) {
  let safety = 312 * CYCLES_PER_LINE * 3;
  while (!(vic.raster === r && vic.cycleInLine === c)) {
    vic.clock(1);
    if (--safety <= 0) throw new Error(`drive timeout reaching r${r} c${c}`);
  }
}

// Find the canvas X of the FIRST yellow pixel on a given canvas row.
function firstYellowX(vic, ro) {
  for (let x = 0; x < CANVAS_W; x++) {
    if (vic.fb32[ro + x] === PAL(0x07)) return x;
  }
  return -1;
}

// Common scene: VM=$0400 with col 5 = code $11 (all-fg glyph),
// all other cols = code $00 (all-bg glyph).
function setupBgWithOneFgGlyphAtCol5(vic) {
  for (let i = 0; i < 0x0400; i++) vic.ram[0x0400 + i] = 0x00;
  // Make col 5 of every row = $11.
  for (let row = 0; row < 25; row++) vic.ram[0x0400 + row * 40 + 5] = 0x11;
  for (let i = 0; i < 0x0400; i++) vic.colorRam[i] = 0x07;       // fg yellow everywhere
  // Glyph $00 row 0..7 = $00 (all-bg). Glyph $11 row 0..7 = $FF (all-fg).
  for (let b = 0; b < 8; b++) vic.ram[0x00 * 8 + b] = 0x00;
  for (let b = 0; b < 8; b++) vic.ram[0x11 * 8 + b] = 0xFF;
  vic.regs[0x11] = 0x18;       // DEN=1, RSEL=1, YSCROLL=0
  vic.regs[0x16] = 0x08;       // CSEL=1, XSCROLL=0
  vic.regs[0x18] = 0x10;       // VM=$0400, CB=$0000
  vic.regs[0x20] = 0x0E;
  vic.regs[0x21] = 0x06;       // bg blue
  vic.displayEnabled = true;
}

// ── 1: XSCROLL=0 baseline — first fg pixel lands at canvas X of col 5.
//
// With CSEL=1, the inner display starts at canvas X=32 (cycle 15's pixel 0).
// Col N occupies canvas X = 32 + N*8. Col 5 → X=72.
// Under XSCROLL=0 the col-5 glyph (all-fg) renders 8 yellow pixels at X=72-79.
{
  const vic = makeVic();
  setupBgWithOneFgGlyphAtCol5(vic);
  driveTo(vic, 0x38, 1);
  // Run through the bad-line and to end-of-line so the renderer commits
  // the pixels.
  driveTo(vic, 0x39, 1);

  const canvasY = 0x38 - 15;
  const ro = canvasY * CANVAS_W;
  const first = firstYellowX(vic, ro);
  // The 6569 inner-display origin is at canvas X=32 + XSCROLL.
  // Plus our 1-cycle pipeline starts at offset 8 within the segment.
  // Empirically (model under test): col 5, bit 0 lands at X = baselineX.
  // We snapshot baselineX here and use it relative below — testing the
  // INVARIANT that XSCROLL=N shifts the pattern by N pixels.
  expect(first >= 64 && first <= 96,
    `XSCROLL=0 baseline: first-yellow X expected near col 5 (~72), got ${first}`);
  ok(`XSCROLL=0 baseline: col-5 fg glyph at canvas X=${first}`);

  // Persist baseline for cross-test comparison via closure.
  globalThis.__XSCROLL_BASELINE_X = first;
}

// ── 2: XSCROLL=1 → first fg pixel moves RIGHT by exactly 1 pixel.
//
// Sample over an isolated VIC instance for cleanliness; assert the
// position relative to the test-1 baseline.
{
  const vic = makeVic();
  setupBgWithOneFgGlyphAtCol5(vic);
  vic.regs[0x16] = 0x09;       // CSEL=1, XSCROLL=1
  driveTo(vic, 0x38, 1);
  driveTo(vic, 0x39, 1);

  const canvasY = 0x38 - 15;
  const ro = canvasY * CANVAS_W;
  const first = firstYellowX(vic, ro);
  const baseline = globalThis.__XSCROLL_BASELINE_X;
  expect(first === baseline + 1,
    `XSCROLL=1: first-yellow X must be baseline+1 (=${baseline+1}), got ${first}`);
  ok('Bauer §3.7.2 + C64PRG §3.5: XSCROLL=1 shifts inner display by exactly 1 pixel right');
}

// ── 3: XSCROLL=0..7 sweep — each step shifts the pattern by exactly 1 px.
//
// This is the smoothness invariant: every XSCROLL increment must advance
// the pattern by exactly 1 pixel. A regression that off-by-one's the
// shift would cause jerky scroll motion (e.g., advances of 0, 2, 1, 1,
// 0, 2 instead of 1, 1, 1, 1).
{
  const baseline = globalThis.__XSCROLL_BASELINE_X;
  const offsets = [];
  for (let xs = 0; xs <= 7; xs++) {
    const vic = makeVic();
    setupBgWithOneFgGlyphAtCol5(vic);
    vic.regs[0x16] = 0x08 | xs;
    driveTo(vic, 0x38, 1);
    driveTo(vic, 0x39, 1);
    const canvasY = 0x38 - 15;
    const ro = canvasY * CANVAS_W;
    offsets.push(firstYellowX(vic, ro));
  }
  const diffs = [];
  for (let i = 1; i < offsets.length; i++) diffs.push(offsets[i] - offsets[i-1]);
  expect(diffs.every(d => d === 1),
    `XSCROLL 0..7 must shift by exactly 1 pixel per step. Got offsets ${offsets.join(',')}, diffs ${diffs.join(',')}`);
  expect(offsets[0] === baseline,
    `XSCROLL=0 in sweep should match test-1 baseline (${baseline}), got ${offsets[0]}`);
  ok('Bauer §3.7.2: XSCROLL 0..7 sweep advances inner display by exactly 1 pixel per increment (smooth scroll invariant)');
}

console.log(`\n${testNo} XSCROLL pixel-advance spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
