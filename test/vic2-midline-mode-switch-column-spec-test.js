// Mid-line $D011/$D016 mode-switch column timing (VICII/split-tests/modesplit).
//
// On a real 6569 a mid-line ECM/BMM/MCM flip takes effect on screen at the
// HALF-character (4px) boundary, not the full column boundary. Verified
// pixel-exact against the hardware-matched modesplit reference: the
// transition column shows the +2 output snapshot in its LEFT 4px and the +3
// snapshot in its RIGHT 4px (lineCycleRegs[seg.cycle+2] / [seg.cycle+3]).
//
// The cycle-incremental render is deferred by 1 and can only read up to the
// +1 snapshot at paint time, so _fixupColumns re-renders the affected columns
// at end of line: Pass 1 paints the +2 mode across the column, then
// _fixupModeSplitRightHalf re-paints the right 4px with the +3 mode (merging
// only where the pixel is still graphics-owned, so sprites/border untouched).
//
// This test pins that column: a text→mode-110 (ECM+BMM, all-BLACK) flip
// captured into lineCycleRegs[c] for c >= 40 must, after the fixup, leave
// seg.cycle 37's LEFT half text (+2 = lineCycleRegs[39]) and its RIGHT half
// BLACK (+3 = lineCycleRegs[40]); seg.cycle 38 is fully BLACK.
//
// Sources: VIC-Addendum.txt "Fetch" (6569 modesplit/movesplit timing),
// Bauer §3.7.3.7 (mode 110 → BLACK), §3.6.3 (write visibility).

import { VIC2, CYCLES_PER_LINE, CANVAS_W, C64_PALETTE } from '../src/vic2.js';

let testNo = 0, testsFailing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else {
    testsFailing++;
    console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`);
    currentFailures = [];
  }
}

const PAL = (i) => (0xFF000000 |
  ((C64_PALETTE[i] & 0xFF) << 16) |
  (C64_PALETTE[i] & 0xFF00) |
  ((C64_PALETTE[i] >> 16) & 0xFF)) >>> 0;
const BLACK = PAL(0x00);
const BLUE = PAL(0x06);

// seg.cycle c → canvas X start = (c - 11) * 8. Pick the middle of each
// column to avoid the segment's first-pixel delayed-bg edge.
const colMidX = (c) => (c - 11) * 8 + 4;

function makeVic() {
  const v = new VIC2();
  v.ram = new Uint8Array(0x10000);      // char code 0, row byte 0 → text = all bg
  v.colorRam = new Uint8Array(0x0400);
  v.charRom = new Uint8Array(0x1000);
  v.currentVicBank = 0x0000;
  return v;
}

// Render one line's graphics with the default (+1) mode the same way the
// cycle-incremental dispatch does, into fb32 at canvasY.
function renderGraphicsPlus1(vic, canvasY) {
  for (let c = 11; c <= 58; c++) {
    const seg = vic._buildCycleRasterSegment(c);
    vic._renderCycleSegmentGraphics(seg, canvasY);
  }
}

// ── 1: mid-line text→mode-110 flip — fixup moves the BLACK boundary to the
//        +2 snapshot column (one char earlier than +1). ──────────────────
{
  const vic = makeVic();
  const FLIP = 40;                       // flip captured in lineCycleRegs[c>=40]
  vic.regs[0x11] = 0x1B;                 // text mode (ECM=0,BMM=0)
  vic.regs[0x16] = 0x08;                 // CSEL=1, XSCROLL=0
  vic.regs[0x21] = 0x06;                 // bg0 = blue → text columns render BLUE
  vic.raster = 60;
  vic.rc = 0;
  vic.displayActive = true;
  for (let c = 0; c <= CYCLES_PER_LINE; c++) {
    vic.lineCycleRegs[c].set(vic.regs);
    if (c >= FLIP) vic.lineCycleRegs[c][0x11] = 0x73;  // ECM+BMM = mode 110 (BLACK)
    vic.lineCycleRowCodes[c].fill(0);
    vic.lineCycleRowColors[c].fill(0);
    vic.lineCycleRowFetchedCols[c].fill(1);
    vic.lineCycleDisplayColumnActive[c] = 1;
    vic.lineCycleHBorderBefore[c] = (c <= 14 || c >= 56) ? 1 : 0;
    vic.lineCycleHBorder[c] = (c <= 14 || c >= 56) ? 1 : 0;
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
    vic.lineCycleVBorder[c] = 0;
    vic.lineCycleVBorderBefore[c] = 0;
  }
  const canvasY = 60 - 15;
  const ro = canvasY * CANVAS_W;
  renderGraphicsPlus1(vic, canvasY);

  // Before the fixup (+1 only): seg.cycle 38 reads lineCycleRegs[39] (text)
  // → still BLUE; seg.cycle 39 reads lineCycleRegs[40] (mode 110) → BLACK.
  expect(vic.fb32[ro + colMidX(38)] === BLUE,
    `pre-fixup: seg 38 (+1 snapshot = text) renders BLUE, got 0x${vic.fb32[ro + colMidX(38)].toString(16)}`);
  expect(vic.fb32[ro + colMidX(39)] === BLACK,
    `pre-fixup: seg 39 (+1 snapshot = mode110) renders BLACK`);

  vic._fixupColumns(canvasY);

  // After the fixup: the flip takes effect at the HALF-character (4px) mark.
  // seg.cycle 37 LEFT half (+2 = lineCycleRegs[39] = text) stays BLUE; its
  // RIGHT half (+3 = lineCycleRegs[40] = mode 110) is BLACK. seg.cycle 38 is
  // fully BLACK (+2 and +3 both mode 110); seg.cycle 36 is fully BLUE.
  const leftX = (c) => (c - 11) * 8 + 1;    // a pixel in the +2 left half
  const rightX = (c) => (c - 11) * 8 + 5;   // a pixel in the +3 right half
  expect(vic.fb32[ro + leftX(36)] === BLUE && vic.fb32[ro + rightX(36)] === BLUE,
    `seg 36 (+2 & +3 both text) stays fully BLUE`);
  expect(vic.fb32[ro + leftX(37)] === BLUE,
    `seg 37 LEFT half (+2 = lineCycleRegs[39] = text) must stay BLUE, got 0x${vic.fb32[ro + leftX(37)].toString(16)}`);
  expect(vic.fb32[ro + rightX(37)] === BLACK,
    `seg 37 RIGHT half (+3 = lineCycleRegs[40] = mode 110) must be BLACK — the half-character split`);
  expect(vic.fb32[ro + leftX(38)] === BLACK && vic.fb32[ro + rightX(38)] === BLACK,
    `seg 38 (+2 = lineCycleRegs[40] = mode 110) must be fully BLACK after fixup`);
  ok('modesplit: mid-line mode switch splits at the half-character (4px) boundary');
}

// ── 2: no mid-line mode change → fixup is a no-op (early-out). ───────────
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x21] = 0x06;
  vic.raster = 60;
  vic.rc = 0;
  vic.displayActive = true;
  for (let c = 0; c <= CYCLES_PER_LINE; c++) {
    vic.lineCycleRegs[c].set(vic.regs);   // stable mode all line
    vic.lineCycleRowCodes[c].fill(0);
    vic.lineCycleRowColors[c].fill(0);
    vic.lineCycleRowFetchedCols[c].fill(1);
    vic.lineCycleDisplayColumnActive[c] = 1;
    vic.lineCycleHBorderBefore[c] = (c <= 14 || c >= 56) ? 1 : 0;
    vic.lineCycleHBorder[c] = (c <= 14 || c >= 56) ? 1 : 0;
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
    vic.lineCycleVBorder[c] = 0;
    vic.lineCycleVBorderBefore[c] = 0;
  }
  const canvasY = 60 - 15;
  const ro = canvasY * CANVAS_W;
  renderGraphicsPlus1(vic, canvasY);
  const before = Uint32Array.from(vic.fb32.subarray(ro, ro + CANVAS_W));
  vic._fixupColumns(canvasY);
  let changed = 0;
  for (let x = 0; x < CANVAS_W; x++) if (vic.fb32[ro + x] !== before[x]) changed++;
  expect(changed === 0, `stable-mode line: fixup must be a no-op, changed ${changed} px`);
  ok('modesplit: fixup is a no-op when no mid-line mode change occurred');
}

if (testsFailing > 0) {
  console.error(`\n${testsFailing} test(s) FAILED`);
  process.exit(1);
}
console.log(`\nAll ${testNo} tests passed.`);
