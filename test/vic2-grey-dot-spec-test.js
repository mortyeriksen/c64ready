// 8565 grey-dot artifact spec test (VICE addendum / DEMO-NINE §6).
//
// VICE addendum, "Grey Dots on 856x":
//   "When writing a color register ($D020-$D02E) currently being used
//    to display graphics a grey dot (color 15) appears at the first
//    pixel of the cycle. ... independent of the previous color register
//    displayed."
//
// On the 8565 PAL VIC (HMOS-II, late C64C), the colour multiplexer
// produces a half-pixel-wide artifact at the boundary of a mid-line
// $D021/$D022/$D023 change. At framebuffer resolution we emit color
// 15 (light grey, $0F) for the first pixel of the cycle that follows
// the colour-register write.
//
// On 6569 (NMOS, original PAL) no fractional-pixel artifact occurs — the
// new colour is visible from the first pixel of the next cycle. (VICE
// matches this; the "1-pixel prev-colour delay" proposed in DEMO-NINE.md
// §4 is tagged NOT IN SPEC and produced a single-pixel mismatch with
// VICE on FppScroller-style demos.)

import { VIC2, CYCLES_PER_LINE, C64_PALETTE } from '../src/vic2.js';

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

const PALETTE_RGBA = (() => {
  const out = new Uint32Array(16);
  for (let i = 0; i < 16; i++) {
    const c = C64_PALETTE[i];
    out[i] = 0xFF000000 | ((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF);
  }
  return out;
})();
const GREY_DOT_RGBA = PALETTE_RGBA[0x0F];   // VICE addendum: color 15 (light grey)

function makeVic(variant) {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  vic.vicVariant = variant;
  return vic;
}

// Set up an open-side-border line so the renderer takes the
// _renderOpenBorderIdleSpan path (which surfaces the bg color and the
// first-pixel-of-cycle artifact).
function setupOpenBorderLineState(vic, regsTemplate, canvasY) {
  for (let c = 0; c <= CYCLES_PER_LINE; c++) {
    vic.lineCycleRegs[c].set(regsTemplate);
    vic.lineCycleVBorder[c] = 0;
    vic.lineCycleVBorderBefore[c] = 0;
    vic.lineCycleHBorder[c] = 0;             // border open
    vic.lineCycleHBorderBefore[c] = 0;
    vic.lineCycleHInner[c] = 0;              // outside text inner zone
    vic.lineCycleDisplayColumnActive[c] = 0;
    vic.lineCycleIdleByte[c] = 0;
    vic.lineCycleBanks[c] = 0;
    vic.lineCycleVc[c] = 0;
    vic.lineCycleRc[c] = 0;
    vic.lineCycleRowVcBase[c] = 0;
    vic.lineCycleCselComparator[c] = 1;
  }
}

// Render cycles 11..58 directly via the per-cycle path.
function renderLine(vic, canvasY, raster) {
  vic._initRenderRasterLine(raster, canvasY);
  for (let cycle = 11; cycle <= 58; cycle++) {
    const seg = vic._buildCycleRasterSegment(cycle);
    vic._renderCycleSegmentGraphics(seg, canvasY);
  }
}

// Common scene: D021=blue (6) cycles 11..30, D021=red (2) cycles 31..58.
// Sample: first pixel of cycle 31 (where D021 change took effect at
// the cycle boundary).
function buildScene(variant) {
  const vic = makeVic(variant);
  vic.regs[0x16] = 0x08;                     // CSEL=1
  vic.regs[0x21] = 6;                        // initial bg = blue
  const canvasY = 50;
  setupOpenBorderLineState(vic, vic.regs, canvasY);
  for (let c = 31; c <= CYCLES_PER_LINE; c++) {
    vic.lineCycleRegs[c][0x21] = 2;          // simulate D021 write at c30 phi2
  }
  renderLine(vic, canvasY, 50);
  return vic;
}

const cycle31Start = (31 - 12) * 8 + 8;
const blueRGBA = PALETTE_RGBA[6];
const redRGBA  = PALETTE_RGBA[2];

// ── 1: 6569 — no grey dot, no prev-colour artifact: first pixel of cycle 31
// shows the NEW colour immediately (matches VICE). This is the absence
// of both 8565 grey-dot AND the DEMO-NINE.md §4 "1-pixel delay" we used
// to model.
{
  const vic = buildScene('6569');
  expect(vic.vicVariant === '6569', `precondition: vicVariant === '6569', got '${vic.vicVariant}'`);
  const ro = 50 * 384;
  const got = vic.fb32[ro + cycle31Start];
  expect(got === redRGBA,
    `6569 first pixel of cycle 31: expected RED (new bg, no delay), got 0x${got.toString(16)}`);
  expect(vic.fb32[ro + cycle31Start + 1] === redRGBA,
    `6569 second pixel of cycle 31: expected RED (new bg), got 0x${vic.fb32[ro + cycle31Start + 1].toString(16)}`);
  ok('6569: mid-line $D021 change → first cycle pixel shows NEW colour (no grey dot, no prev-colour delay)');
}

// ── 2: 8565 — first pixel of cycle 31 is GREY (grey-dot artifact)
{
  const vic = buildScene('8565');
  expect(vic.vicVariant === '8565', `precondition: vicVariant === '8565', got '${vic.vicVariant}'`);
  const ro = 50 * 384;
  // 8565 has +1-cycle pipeline delay (regOffset=-1 in segment build),
  // so the boundary lands at cycle 32 instead of cycle 31. Inspect c32.
  const cycle32Start = (32 - 12) * 8 + 8;
  const got = vic.fb32[ro + cycle32Start];
  expect(got === GREY_DOT_RGBA,
    `8565 first pixel at split boundary: expected GREY ($0F), got 0x${got.toString(16)}`);
  expect(vic.fb32[ro + cycle32Start + 1] === redRGBA,
    `8565 second pixel after grey dot: expected RED (new bg), got 0x${vic.fb32[ro + cycle32Start + 1].toString(16)}`);
  ok('8565: mid-line $D021 change → first cycle pixel is GREY-DOT (DEMO-NINE §6)');
}

// ── 3: No change → no grey-dot on 8565
// If $D021 doesn't change at a cycle boundary, the first pixel of every
// cycle stays the current bg colour — no grey dot.
{
  const vic = makeVic('8565');
  expect(vic.vicVariant === '8565', `precondition: vicVariant === '8565', got '${vic.vicVariant}'`);
  vic.regs[0x16] = 0x08;
  vic.regs[0x21] = 6;
  const canvasY = 50;
  setupOpenBorderLineState(vic, vic.regs, canvasY);
  // No mid-line change.
  renderLine(vic, canvasY, 50);
  const ro = 50 * 384;
  // Sample several cycle-start pixels; none should be grey.
  let firstGrey = -1;
  for (let cycle = 12; cycle <= 58; cycle++) {
    const x = (cycle - 12) * 8 + 8;
    if (vic.fb32[ro + x] === GREY_DOT_RGBA) { firstGrey = x; break; }
  }
  expect(firstGrey === -1,
    `8565 no $D021 change: must not emit grey dot (found at canvasX=${firstGrey})`);
  ok('8565: no grey dot when colour register stays constant');
}

// ── 4: $D022 mid-line change also produces grey-dot on 8565
// The grey-dot artifact applies to all background-color registers
// ($D021/$D022/$D023). Verify $D022 specifically.
{
  const vic = makeVic('8565');
  expect(vic.vicVariant === '8565', `precondition: vicVariant === '8565', got '${vic.vicVariant}'`);
  vic.regs[0x16] = 0x08;
  vic.regs[0x21] = 6;
  vic.regs[0x22] = 1;                        // initial bg1 = white
  const canvasY = 50;
  setupOpenBorderLineState(vic, vic.regs, canvasY);
  for (let c = 31; c <= CYCLES_PER_LINE; c++) {
    vic.lineCycleRegs[c][0x22] = 7;          // bg1 → yellow
  }
  renderLine(vic, canvasY, 50);
  // We can't directly observe bg1 in the open-idle path without ECM/MCM
  // glyph data, but we can verify the helper itself returns grey on
  // 8565 + change. (Cycle 32 boundary, account for 1-cy 8565 delay.)
  // PALETTE_RGBA is now an Int32Array inside vic2 (signed, so reads are Smis),
  // so _firstPixelBgColor returns a signed 32-bit colour. fb32 reads (tests
  // 1-3) are unsigned. Compare the 32-bit colour PATTERN with >>> 0 so the
  // assertion is representation-agnostic (bits identical either way).
  const greyOut = vic._firstPixelBgColor(vic.lineCycleRegs[30], 0x22, 7, PALETTE_RGBA[7]) >>> 0;
  expect(greyOut === (GREY_DOT_RGBA >>> 0),
    `_firstPixelBgColor on 8565 + $D022 change: expected GREY, got 0x${greyOut.toString(16)}`);
  ok('8565: grey-dot helper applies to $D022 / $D023 too');
}

console.log(`\n${testNo} 8565 grey-dot tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
