// Standard bitmap mode (BMM=1, MCM=0, ECM=0) has NO $D021 background — a 0-bit's
// colour is the low nibble of the matrix byte (Bauer §3.7.3.6). With XSCROLL>0
// in 40-column mode (CSEL=1) the leftmost XSCROLL pixels of the display are the
// graphics sequencer's edge-filler: they sit OUTSIDE the rendered column span
// (srcX < 0). The renderer used to paint those filler pixels with $D021, which
// in standard bitmap mode is not a colour source — producing a spurious vertical
// stripe at the left of the display.
//
// Repro: Coma "GOOD THINGS COME TO" scene (XSCROLL=4, $D016=$0C, $D021=$0E light
// blue, purple bitmap background) showed a 4px light-blue column at canvas X
// 32-35. Correct behaviour: the filler follows the adjacent column's bitmap
// background (matrix low nibble), so the stripe must match the cell, never $D021.
//
// Geometry: with $D016 CSEL=1 and XSCROLL=0, column 0 of the display starts at
// canvas X 32. XSCROLL=4 shifts the picture right 4px, so column 0's data lands
// at X 36-43 and X 32-35 become the left filler.

import { VIC2, CYCLES_PER_LINE, C64_PALETTE } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  return vic;
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

const PAL = (i) => (0xFF000000 |
  ((C64_PALETTE[i] & 0xFF) << 16) |
  (C64_PALETTE[i] & 0xFF00) |
  ((C64_PALETTE[i] >> 16) & 0xFF)) >>> 0;

// Drive the chip to the bad line at raster $38 (56 & 7 == YSCROLL 0) and return
// the canvas row offset for that line. Mirrors the driving pattern of test 11 in
// vic2-gaccess-shifter-spec-test.js.
function driveToBadLine38(vic) {
  vic.displayEnabled = true;
  let safety = 312 * CYCLES_PER_LINE * 2;
  while (!(vic.raster === 0x38 && vic.cycleInLine === 1)) {
    vic.clock(1);
    if (--safety <= 0) throw new Error('drive timeout');
  }
  while (!(vic.raster === 0x39 && vic.cycleInLine === 1)) vic.clock(1);
  return (0x38 - 15) * 384;   // our row0 = raster 15
}

// ── Test 1: standard bitmap, XSCROLL=4 — left filler is the bitmap bg, NOT $D021 ──
{
  const vic = makeVic();
  // Matrix byte $14 → fg = high nibble $1 (white), bg = low nibble $4 (purple).
  for (let i = 0; i < 0x0400; i++) vic.ram[0x0400 + i] = 0x14;
  // Bitmap data stays $00 (RAM default) → every pixel is a 0-bit → bitmap bg.
  vic.regs[0x11] = 0x38;   // BMM=1, DEN=1, RSEL=1, YSCROLL=0, ECM=0
  vic.regs[0x16] = 0x0C;   // CSEL=1, XSCROLL=4, MCM=0
  vic.regs[0x18] = 0x18;   // VM=$0400, CB=$2000
  vic.regs[0x21] = 0x0E;   // $D021 = light blue — the wrong colour if it leaks
  const ro = driveToBadLine38(vic);

  const purple = PAL(0x04), lightBlue = PAL(0x0E);
  expect(purple !== lightBlue, 'sanity: purple != light blue palette entries');
  // X 32-35 = XSCROLL=4 left filler. Must be the bitmap bg (purple), never $D021.
  for (let x = 32; x <= 35; x++) {
    expect(vic.fb32[ro + x] === purple,
      `filler X=${x}: expected bitmap bg purple 0x${purple.toString(16)}, got 0x${vic.fb32[ro + x].toString(16)}`);
    expect(vic.fb32[ro + x] !== lightBlue,
      `filler X=${x}: must NOT be $D021 light blue (the stripe bug)`);
  }
  // X 36-43 = column 0's data (all 0-bits) — also the bitmap bg purple.
  for (let x = 36; x <= 43; x++) {
    expect(vic.fb32[ro + x] === purple,
      `col0 X=${x}: expected bitmap bg purple, got 0x${vic.fb32[ro + x].toString(16)}`);
  }
  ok('standard bitmap XSCROLL=4: left filler uses bitmap bg (matrix low nibble), not $D021');
}

// ── Test 2: bitmap bg follows the matrix byte (different low nibble) ────────────
// Proves the filler tracks the cell's bg, not a hard-coded colour.
{
  const vic = makeVic();
  for (let i = 0; i < 0x0400; i++) vic.ram[0x0400 + i] = 0x2A;  // bg = $A (light red)
  vic.regs[0x11] = 0x38;
  vic.regs[0x16] = 0x0C;
  vic.regs[0x18] = 0x18;
  vic.regs[0x21] = 0x0E;   // $D021 light blue still present but must not appear
  const ro = driveToBadLine38(vic);

  const lightRed = PAL(0x0A), lightBlue = PAL(0x0E);
  for (let x = 32; x <= 35; x++) {
    expect(vic.fb32[ro + x] === lightRed,
      `filler X=${x}: expected matrix-bg light red 0x${lightRed.toString(16)}, got 0x${vic.fb32[ro + x].toString(16)}`);
    expect(vic.fb32[ro + x] !== lightBlue, `filler X=${x}: must NOT be $D021`);
  }
  ok('standard bitmap XSCROLL=4: filler tracks the cell bg ($A light red), independent of $D021');
}

// ── Test 3: regression guard — TEXT mode left filler IS $D021 (unchanged) ───────
// The fix is gated to standard bitmap; in text mode $D021 is the genuine 0-bit
// background, so the filler must still be $D021.
{
  const vic = makeVic();
  for (let i = 0; i < 0x0400; i++) vic.ram[0x0400 + i] = 0x01;  // char code $01
  for (let i = 0; i < 0x0400; i++) vic.colorRam[i] = 0x07;      // fg = yellow
  // char $01 row data stays $00 (CB=$2000 region RAM = 0) → all bg pixels.
  vic.regs[0x11] = 0x18;   // BMM=0, DEN=1, RSEL=1, YSCROLL=0, ECM=0
  vic.regs[0x16] = 0x0C;   // CSEL=1, XSCROLL=4, MCM=0
  vic.regs[0x18] = 0x18;   // VM=$0400, CB=$2000
  vic.regs[0x21] = 0x0E;   // $D021 = light blue — the genuine text bg here
  const ro = driveToBadLine38(vic);

  const lightBlue = PAL(0x0E);
  for (let x = 32; x <= 43; x++) {
    expect(vic.fb32[ro + x] === lightBlue,
      `text-mode X=${x}: bg must be $D021 light blue, got 0x${vic.fb32[ro + x].toString(16)}`);
  }
  ok('text mode XSCROLL=4: left filler is $D021 (fix gated to bitmap, no regression)');
}

// ── Test 4: INVALID mode ECM+BMM — left filler is BLACK, not $D021 ──────────────
// Bauer §3.7.3.7: ECM+BMM (d011 bits 6+5) is an invalid mode — the sequencer
// outputs black for every bit value, including the edge-filler "0" bits.
// Repro: WONDER D1 bands scene (d011=$7B, $D021=8/10, XSCROLL swing 1..7) — the
// $D021 filler showed as a small flickering block at canvas x=32..38.
{
  const vic = makeVic();
  for (let i = 0; i < 0x0400; i++) vic.ram[0x0400 + i] = 0x14;  // matrix as test 1
  vic.regs[0x11] = 0x78;   // ECM=1, BMM=1, DEN=1, RSEL=1, YSCROLL=0 — invalid
  vic.regs[0x16] = 0x0C;   // CSEL=1, XSCROLL=4, MCM=0
  vic.regs[0x18] = 0x18;
  vic.regs[0x21] = 0x0E;   // $D021 light blue — the leaking colour if buggy
  const ro = driveToBadLine38(vic);

  const black = PAL(0x00), lightBlue = PAL(0x0E);
  for (let x = 32; x <= 35; x++) {
    expect(vic.fb32[ro + x] === black,
      `ECM+BMM filler X=${x}: expected black, got 0x${vic.fb32[ro + x].toString(16)}`);
    expect(vic.fb32[ro + x] !== lightBlue,
      `ECM+BMM filler X=${x}: must NOT be $D021 (WONDER bands block)`);
  }
  for (let x = 36; x <= 43; x++) {
    expect(vic.fb32[ro + x] === black,
      `ECM+BMM col0 X=${x}: expected black, got 0x${vic.fb32[ro + x].toString(16)}`);
  }
  ok('invalid ECM+BMM XSCROLL=4: left filler renders black, never $D021');
}

// ── Test 5: INVALID mode ECM+MCM text — left filler is BLACK, not $D021 ─────────
// Bauer §3.7.3.5: ECM+MCM text is the other invalid family — same black output.
{
  const vic = makeVic();
  for (let i = 0; i < 0x0400; i++) vic.ram[0x0400 + i] = 0x01;
  for (let i = 0; i < 0x0400; i++) vic.colorRam[i] = 0x0F;      // MC-flag colours
  vic.regs[0x11] = 0x58;   // ECM=1, BMM=0, DEN=1, RSEL=1, YSCROLL=0
  vic.regs[0x16] = 0x1C;   // CSEL=1, XSCROLL=4, MCM=1 — invalid with ECM
  vic.regs[0x18] = 0x18;
  vic.regs[0x21] = 0x0E;
  const ro = driveToBadLine38(vic);

  const black = PAL(0x00), lightBlue = PAL(0x0E);
  for (let x = 32; x <= 35; x++) {
    expect(vic.fb32[ro + x] === black,
      `ECM+MCM filler X=${x}: expected black, got 0x${vic.fb32[ro + x].toString(16)}`);
    expect(vic.fb32[ro + x] !== lightBlue,
      `ECM+MCM filler X=${x}: must NOT be $D021`);
  }
  ok('invalid ECM+MCM XSCROLL=4: left filler renders black, never $D021');
}

console.log(`\n${testNo} bitmap XSCROLL left-filler spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
