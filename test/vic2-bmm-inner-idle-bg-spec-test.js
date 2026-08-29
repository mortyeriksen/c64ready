// Bitmap-mode inner-zone idle-span colour spec test.
//
// In bitmap mode (BMM=1), when the segment is in the horizontal inner
// zone (no v/h border active) but the cycle isn't displayColumnActive
// (= matrix fetch not happening this cycle), the sequencer clocks the live
// idle g-access byte ($3FFF) through the shifter exactly as in display
// state, but with the video-matrix c-data forced to 0 (Bauer §3.7.3). The
// per-mode colour assignment for that byte then decides the pixels:
//
//   - Standard (hi-res) bitmap (§3.7.3.3): "0" colour = c-data bits 0-3,
//     "1" colour = c-data bits 4-7. Both nibbles are 0 in idle → BLACK,
//     regardless of the byte.
//   - MCM bitmap (§3.7.3.4): pair 00 → $D021 background; pairs 01/10/11 →
//     c-data / colour-RAM nibbles = 0 = BLACK. So the idle byte shows
//     through as a PATTERN — 00-pairs are $D021, the rest black — NOT a
//     solid $D021 bar.
//   - Invalid modes (ECM+BMM 110/111): always BLACK (§3.7.3.7/8).
//
// Spec references:
//   - https://www.cebix.net/VIC-Article.txt: Bauer §3.7.3 (idle c-data=0), §3.7.3.3 /
//     §3.7.3.4 (bitmap colour assignment)
//   - VICE testprogs/VICII/colorsplit (MCM-bitmap idle byte $F0 renders as
//     dots, not a solid bar) and /border (border-250/bm-idle/bm-ysh = black)
//
// What this file pins:
//   1. Standard bitmap + inner-zone + displayActive=true → pixel = BLACK.
//   2. BMM=0 (text) + same setup → renders idle-byte pattern (ghost byte
//      preserved for nine.prg-style demos).
//   3. Standard bitmap + displayActive=false (idle line) → BLACK.
//   4. MCM bitmap + idle line → idle-byte pattern (00=$D021, else BLACK).
//   5. Invalid sub-modes (ECM=1, BMM=1) → BLACK.

import { VIC2, CANVAS_W, C64_PALETTE } from '../src/vic2.js';

const PAL_RGBA = (idx) => (0xFF000000 |
  ((C64_PALETTE[idx] & 0xFF) << 16) |
  (C64_PALETTE[idx] & 0xFF00) |
  ((C64_PALETTE[idx] >> 16) & 0xFF)) >>> 0;

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
  vic.regs[0x16] = 0x08;  // CSEL=1
  return vic;
}

// Set up a line where: all 63 cycles are hInner (= no v/h border),
// displayColumnActive is selectively true/false based on the cycle map.
// idleByte = a pattern that would corrupt the bars if rendered. The
// idle-span path runs for cycles where displayColumnActive=false.
function setupBmmInnerIdleLine(vic, opts = {}) {
  const {
    mode = 0x3B,            // $D011 = DEN=1, RSEL=1, YS=3, BMM=1
    d016 = 0x08,            // CSEL=1, MCM=0
    bgColor = 0x06,         // $D021 = blue
    idleByte = 0xFF,        // pattern that WOULD render as black-or-fg
    displayActive = true,
    activeColumnCycles = new Set(),  // cycles where displayColumnActive=true (inside inner zone)
  } = opts;

  vic.regs[0x11] = mode;
  vic.regs[0x16] = d016;
  vic.regs[0x20] = 0x0E;   // border = light blue (irrelevant — vBorder=0)
  vic.regs[0x21] = bgColor;

  // Mirror what _beginRasterLine would have captured at cy 1 of this
  // line. This synthetic setup bypasses the normal clock path, so the
  // line-start scalars (used by other impl-detail invariants in
  // _renderOpenBorderIdleSpan and _isDisplayColumnPhase) must be seeded
  // explicitly to match the test's intended steady-state $D011.
  vic._lineStartD011 = mode;
  vic._lineStartD021 = bgColor;
  vic._prevLineStartD011 = mode;

  for (let c = 0; c <= 63; c++) {
    vic.lineCycleRegs[c].set(vic.regs);
    vic.lineCycleVBorderBefore[c] = 0;
    vic.lineCycleVBorder[c] = 0;
    vic.lineCycleCselComparator[c] = 1;
    // hBorder is OFF only INSIDE the side zones. With CSEL=1, hBorder
    // turns off at cy 17 (= left edge) and on at cy 55 (= right edge).
    // So hInner is true for cycles in the 40-col display area.
    vic.lineCycleHBorderBefore[c] = 0;
    vic.lineCycleHBorder[c] = 0;
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
    vic.lineCycleIdleByte[c] = idleByte;
    vic.lineCycleDisplayColumnActive[c] = activeColumnCycles.has(c) ? 1 : 0;
    vic.lineCycleRowFetchedCols[c].fill(0);
    vic.lineCycleRowCodes[c].fill(0);
    vic.lineCycleRowColors[c].fill(0);
  }
  vic.displayActive = displayActive;
  vic.lineDisplayActive = displayActive;
}

// ── 1: standard bitmap + displayActive + displayColumnActive=false → BLACK
//
// All cycles in the inner zone have displayColumnActive=false. With
// idleByte=$FF the inner-zone pixels render via the idle span; standard
// bitmap idle (c-data=0) → BLACK regardless of the byte (§3.7.3.3).
{
  const vic = makeVic();
  setupBmmInnerIdleLine(vic, {
    mode: 0x3B,                        // BMM=1, ECM=0, MCM=0 (standard bitmap)
    bgColor: 0x06,
    idleByte: 0xFF,
    displayActive: true,
    activeColumnCycles: new Set(),    // NO cycles are displayColumnActive
  });
  vic._renderRasterLine(60);
  const cy = 60 - 15;
  const ro = cy * CANVAS_W;
  const BLACK = 0xFF000000;
  // Inner zone pixels (X=32..343 = the 40-col display area).
  for (const x of [40, 100, 200, 300]) {
    expect(vic.fb32[ro + x] === BLACK,
      `std-bitmap inner-idle X=${x}: must be BLACK; got 0x${vic.fb32[ro + x].toString(16).padStart(8, '0')}`);
  }
  ok(`Bauer §3.7.3.3: standard bitmap + displayActive + inner-zone-idle → BLACK`);
}

// ── 2: TEXT mode + same setup → idle-byte pattern preserved ────────────
//
// In text mode (BMM=0), the ghost-byte semantics should still apply.
// Inner-zone idle in text mode renders the idle-byte bit pattern.
// (This is what nine.prg's bottom-border ghost-byte demo relies on.)
{
  const vic = makeVic();
  setupBmmInnerIdleLine(vic, {
    mode: 0x1B,                        // BMM=0 (text mode), ECM=0, MCM=0
    bgColor: 0x06,
    idleByte: 0xFF,
    displayActive: true,
    activeColumnCycles: new Set(),
  });
  vic._renderRasterLine(60);
  const cy = 60 - 15;
  const ro = cy * CANVAS_W;
  // Text-mode idle byte $FF should render some non-bg pixels (= bit
  // pattern). At least ONE pixel in the inner zone should differ from
  // bg color.
  let nonBg = 0;
  for (let x = 32; x < 344; x++) {
    if (vic.fb32[ro + x] !== PAL_RGBA(0x06)) nonBg++;
  }
  expect(nonBg > 0,
    `text-mode idle byte $FF: must render bit pattern (non-bg pixels) in inner zone; got 0 non-bg pixels`);
  ok(`Text-mode ghost-byte rendering preserved (BMM=0 gate not affected by fix)`);
}

// ── 3: standard bitmap + displayActive=false (idle line) → BLACK ───────
//
// On a genuine idle-state line the idle byte is clobbered to 0; standard
// bitmap → BLACK (§3.7.3.3, c-data=0).
{
  const vic = makeVic();
  setupBmmInnerIdleLine(vic, {
    mode: 0x3B,
    bgColor: 0x06,
    idleByte: 0xFF,
    displayActive: false,
    activeColumnCycles: new Set(),
  });
  vic._renderRasterLine(60);
  const cy = 60 - 15;
  const ro = cy * CANVAS_W;
  const BLACK = 0xFF000000;
  for (const x of [50, 150, 250]) {
    expect(vic.fb32[ro + x] === BLACK,
      `std-bitmap idle-state line X=${x}: BLACK; got 0x${vic.fb32[ro + x].toString(16).padStart(8, '0')}`);
  }
  ok(`Bauer §3.7.3.3: standard bitmap idle-state line → BLACK`);
}

// ── 4: MCM bitmap + displayActive=false (idle line) → idle-byte pattern ─
//
// MCM bitmap idle (§3.7.3.4): pair 00 → $D021; pairs 01/10/11 → c-data /
// colour-RAM nibbles = 0 = BLACK. So the idle byte shows through as a
// pattern — NOT a solid $D021 bar. Verified against the VICE colorsplit
// reference (MCM-bitmap idle byte $F0 = dots). Three bytes pin the rule:
// $00 (all 00 → all $D021), $FF (all 11 → all BLACK), $F0 (mixed pattern).
{
  const bg0 = PAL_RGBA(0x06), BLACK = 0xFF000000;
  const ro = (60 - 15) * CANVAS_W;
  const renderByte = (idleByte) => {
    const vic = makeVic();
    setupBmmInnerIdleLine(vic, { mode: 0x3B, d016: 0x18, bgColor: 0x06, idleByte, displayActive: false });
    vic._renderRasterLine(60);
    return vic;
  };
  // (a) all-00 byte → whole span is $D021.
  let vic = renderByte(0x00);
  for (const x of [50, 150, 250]) expect(vic.fb32[ro + x] === bg0,
    `MCM idle $00 X=${x}: $D021; got 0x${vic.fb32[ro + x].toString(16).padStart(8, '0')}`);
  // (b) all-11 byte → whole span is BLACK (no 00 pairs).
  vic = renderByte(0xFF);
  for (const x of [50, 150, 250]) expect(vic.fb32[ro + x] === BLACK,
    `MCM idle $FF X=${x}: BLACK; got 0x${vic.fb32[ro + x].toString(16).padStart(8, '0')}`);
  // (c) $F0 = pairs 11,11,00,00 → within each 8-px char (XSCROLL=0, char
  //     boundary at X=32): pixels 0-3 BLACK, 4-7 $D021. The byte is NOT
  //     suppressed (the bug rendered the whole span as a solid colour).
  vic = renderByte(0xF0);
  for (const x of [32, 40, 48]) expect(vic.fb32[ro + x] === BLACK,
    `MCM idle $F0 X=${x} (pair 11): BLACK; got 0x${vic.fb32[ro + x].toString(16).padStart(8, '0')}`);
  for (const x of [36, 44, 52]) expect(vic.fb32[ro + x] === bg0,
    `MCM idle $F0 X=${x} (pair 00): $D021; got 0x${vic.fb32[ro + x].toString(16).padStart(8, '0')}`);
  ok(`Bauer §3.7.3.4: MCM bitmap idle → idle-byte pattern (00=$D021, else BLACK), not solid`);
}

// ── 5: BMM=1 + ECM=1 (invalid mode 110) → BLACK ────────────────────────
//
// Bauer §3.7.3.7/8: invalid modes (BMM+ECM=1, or BMM+ECM+MCM=1) output
// BLACK. The mode-dispatch inside _renderOpenBorderIdleSpan still gates
// invalid modes regardless of the bg-force.
{
  const vic = makeVic();
  setupBmmInnerIdleLine(vic, {
    mode: 0x7B,                        // BMM=1, ECM=1 (invalid mode 110)
    bgColor: 0x06,
    idleByte: 0xFF,
    displayActive: true,
    activeColumnCycles: new Set(),
  });
  vic._renderRasterLine(60);
  const cy = 60 - 15;
  const ro = cy * CANVAS_W;
  const BLACK = 0xFF000000;
  for (const x of [50, 150, 250]) {
    expect(vic.fb32[ro + x] === BLACK,
      `BMM+ECM invalid mode X=${x}: BLACK; got 0x${vic.fb32[ro + x].toString(16).padStart(8, '0')}`);
  }
  ok(`Bauer §3.7.3.7/8: invalid mode (BMM+ECM=1) → BLACK (gate doesn't bypass mode-dispatch)`);
}

console.log(`\n${testNo} BMM inner-idle colour spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
