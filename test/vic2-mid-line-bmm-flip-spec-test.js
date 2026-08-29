// Mid-line $D011 BMM (bitmap-mode) flip PIXEL spec test.
//
// Bauer §3.7.3: ECM/BMM/MCM mode bits in $D011/$D016 are sampled LIVE
// per pixel for rendering. A mid-line BMM=0→1 flip switches rendering
// from text-mode (§3.7.3.1) to standard bitmap mode (§3.7.3.3) at the
// cycle of the write.
//
// Standard bitmap mode: each col reads a bitmap byte from
// bitmapBase + VC*8 + RC. fg = (code >> 4) & 0xF, bg = code & 0xF.
//
// FPP/FLD demos use this mode flip on a per-line basis. This test
// pins the live-mode rendering invariant for BMM specifically.
//
// We use the direct lineCycleRegs setup pattern (mirroring
// midline-mode-flip-rendering-spec-test.js) so the test isn't blocked
// by vBorder/displayColumnActive bootstrapping when driving the full
// clock.

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

// Set up a "display-active" line with all cycle slots populated.
// Codes/colors/fetched-cols match what a bad-line c-access would have
// produced. The caller can then override per-cycle regs to test mode
// flips.
function setupDisplayLine(vic, code, color) {
  vic.rowFetchD011 = 0x1B;
  vic.rowFetchD016 = 0x08;
  vic.rowFetchD018 = 0x10;
  for (let c = 0; c <= 63; c++) {
    vic.lineCycleRegs[c].set(vic.regs);
    vic.lineCycleRowCodes[c].fill(code);
    vic.lineCycleRowColors[c].fill(color);
    vic.lineCycleRowFetchedCols[c].fill(1);
    vic.lineCycleDisplayColumnActive[c] = 1;
    vic.lineCycleHBorderBefore[c] = (c <= 14 || c >= 56) ? 1 : 0;
    vic.lineCycleHBorder[c] = (c <= 14 || c >= 56) ? 1 : 0;
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
    vic.lineCycleVBorder[c] = 0;
    vic.lineCycleVBorderBefore[c] = 0;
    vic.lineCycleRowVcBase[c] = 0;
    vic.lineCycleRc[c] = 0;
    vic.lineCycleCselComparator[c] = 1;
    vic.lineCycleBanks[c] = 0;
  }
  vic.displayActive = true;
}

// ── 1: Mid-line BMM=0→1 flip — pre-flip cols render TEXT mode, post-flip
// cols render BITMAP mode (standard bitmap §3.7.3.3).
{
  const vic = makeVic();
  // Text-mode glyph: code $76 row 0 = $FF (all-fg).
  for (let b = 0; b < 8; b++) vic.ram[0x76 * 8 + b] = 0xFF;
  // Bitmap data at base $0000: each col at $0 + VC*8 + 0. Use $A5
  // (10100101 → fg, bg, fg, bg, bg, fg, bg, fg).
  for (let col = 0; col < 40; col++) vic.ram[col * 8] = 0xA5;

  vic.regs[0x11] = 0x1B;             // text mode initially
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x10;             // VM=$0400, CB=$0000, bitmap base=$0000
  vic.regs[0x21] = 0x06;             // bg = blue
  setupDisplayLine(vic, 0x76, 0x0A);  // code $76, fg color $A (light red)
  // Mid-line flip: cycles 30..63 have BMM=1.
  for (let c = 30; c <= 63; c++) {
    vic.lineCycleRegs[c][0x11] = 0x3B;       // BMM=1, DEN=1, RSEL=1, YS=3
  }
  vic._renderRasterLine(60);

  const ro = (60 - 15) * CANVAS_W;
  // Pre-flip col 0 (cycle 15) → text mode, glyph $76 = all-fg = light red.
  expect(vic.fb32[ro + 32] === PAL(0x0A),
    `pre-flip col 0 text: expected light red ($0A); got 0x${vic.fb32[ro + 32].toString(16)}`);
  // Post-flip col 30 (cycle 45 → bitmap mode):
  //   code $76 → fg=$7 (yellow), bg=$6 (blue). byte $A5 = 10100101.
  //   Pixel 0 (bit 7=1) = yellow; pixel 1 (bit 6=0) = blue.
  const xPost = 32 + 30 * 8;          // col 30 canvas X
  expect(vic.fb32[ro + xPost] === PAL(0x07),
    `post-flip col 30 bitmap byte $A5 bit 7=1: expected yellow ($07); got 0x${vic.fb32[ro + xPost].toString(16)}`);
  expect(vic.fb32[ro + xPost + 1] === PAL(0x06),
    `post-flip col 30 bitmap byte $A5 bit 6=0: expected blue ($06); got 0x${vic.fb32[ro + xPost + 1].toString(16)}`);
  ok('Bauer §3.7.3.3: mid-line $D011 BMM=0→1 flip switches rendering to bitmap mode (live mode sample)');
}

// ── 2: Text-mode baseline (no flip) — all cols render text glyph.
{
  const vic = makeVic();
  for (let b = 0; b < 8; b++) vic.ram[0x76 * 8 + b] = 0xFF;
  for (let col = 0; col < 40; col++) vic.ram[col * 8] = 0xA5;
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x10;
  vic.regs[0x21] = 0x06;
  setupDisplayLine(vic, 0x76, 0x0A);
  vic._renderRasterLine(60);

  const ro = (60 - 15) * CANVAS_W;
  let lightRedCols = 0;
  for (let col = 0; col < 40; col++) {
    if (vic.fb32[ro + 32 + col * 8] === PAL(0x0A)) lightRedCols++;
  }
  expect(lightRedCols === 40,
    `text-mode baseline (no flip): all 40 cols light-red (fg of glyph $76); got ${lightRedCols}`);
  ok('Text-mode baseline (no flip): all 40 cols render light-red fg');
}

// ── 3: Mid-line BMM=1→0 flip — pre-flip cols render BITMAP mode,
// post-flip cols render TEXT mode.
{
  const vic = makeVic();
  for (let b = 0; b < 8; b++) vic.ram[0x76 * 8 + b] = 0xFF;
  for (let col = 0; col < 40; col++) vic.ram[col * 8] = 0xA5;
  vic.regs[0x11] = 0x3B;             // BMM=1 initially
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x10;
  vic.regs[0x21] = 0x06;
  setupDisplayLine(vic, 0x76, 0x0A);
  // Mid-line flip: cycles 30..63 have BMM=0 (text).
  for (let c = 30; c <= 63; c++) {
    vic.lineCycleRegs[c][0x11] = 0x1B;
  }
  vic._renderRasterLine(60);

  const ro = (60 - 15) * CANVAS_W;
  // Pre-flip col 0 bitmap → byte $A5 bit 7=1 → fg yellow.
  expect(vic.fb32[ro + 32] === PAL(0x07),
    `pre-flip col 0 bitmap: expected yellow (fg from code $7); got 0x${vic.fb32[ro + 32].toString(16)}`);
  // Post-flip col 30 text → glyph $76 all-fg light red.
  expect(vic.fb32[ro + 32 + 30 * 8] === PAL(0x0A),
    `post-flip col 30 text: expected light red; got 0x${vic.fb32[ro + 32 + 30 * 8].toString(16)}`);
  ok('Bauer §3.7.3: mid-line $D011 BMM=1→0 flip switches rendering to text mode (live mode sample)');
}

console.log(`\n${testNo} mid-line BMM-flip spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
