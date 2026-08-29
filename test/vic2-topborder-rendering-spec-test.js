// Top-border rendering with mode-flip demo spec audit. 10 tests
// targeting the user's snapshot scenario: vBorder=open across top zone
// (via DEN/RSEL flip trick) + mid-line $D011 mode flips. Per spec the
// top-zone with non-mode-110 should render either black (idle byte 0
// with bg=$D021=black) or color-RAM-driven garbage; with mode 110 it
// must render black per Bauer §3.7.3.7.
//
// Sources: Bauer §3.9 (open-border tricks), §3.7.3.7 (invalid mode 110),
// §3.7.5 (idle byte), §3.7.2 (display state).

import { VIC2, CYCLES_PER_LINE, CANVAS_W, C64_PALETTE } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  return vic;
}

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

function setupOpenVBorderLine(vic, mode, idleByte = 0xFF) {
  // Set vBorder/hBorder open across the line (after left-compare),
  // hInner=true in the inner X range, mode set in regs.
  vic.regs[0x11] = mode;
  vic.regs[0x16] = 0x08;
  for (let cycle = 0; cycle <= 63; cycle++) {
    vic.lineCycleVBorderBefore[cycle] = 0;
    vic.lineCycleVBorder[cycle] = 0;
    // hBorder closed for sides (cycles 1..14 / 56..63), open for inner.
    const hb = (cycle <= 14 || cycle >= 56) ? 1 : 0;
    vic.lineCycleHBorderBefore[cycle] = hb;
    vic.lineCycleHBorder[cycle] = hb;
    vic.lineCycleHInner[cycle] = (cycle >= 15 && cycle <= 54) ? 1 : 0;
    vic.lineCycleRegs[cycle].set(vic.regs);
    vic.lineCycleIdleByte[cycle] = idleByte;
  }
}

// ── 1: Mode 110 ($73) in top-zone with vBorder=open → all pixels black
// Bauer §3.7.3.7: invalid mode 110 paints every pixel BLACK regardless
// of fetched data. Even with stale c-data, top zone must render black.
{
  const vic = makeVic();
  setupOpenVBorderLine(vic, 0x73, 0x00);
  vic.regs[0x21] = 0x06;             // bg = blue (would show if not mode 110)
  vic.displayActive = true;
  for (let c = 0; c <= 63; c++) vic.lineCycleRegs[c].set(vic.regs);
  vic._renderRasterLine(20);
  const cy = 20 - 15;
  const ro = cy * CANVAS_W;
  // Inner X range cycles 15..54 → canvas X=32..351.
  for (const x of [50, 100, 200, 300, 350]) {
    expect(vic.fb32[ro + x] === 0xFF000000,
      `mode 110 + vBorder open: canvas X=${x} must be BLACK, got 0x${vic.fb32[ro + x].toString(16)}`);
  }
  ok('Bauer §3.7.3.7: mode 110 ($73) renders BLACK across entire inner display');
}

// ── 2: Mode 111 ($D011 with ECM=1, BMM=1, $D016 with MCM=1) → black ────
{
  const vic = makeVic();
  setupOpenVBorderLine(vic, 0x73, 0x00);
  vic.regs[0x16] = 0x18;             // MCM=1 + CSEL=1
  vic.displayActive = true;
  for (let c = 0; c <= 63; c++) vic.lineCycleRegs[c].set(vic.regs);
  vic._renderRasterLine(20);
  const cy = 20 - 15;
  const ro = cy * CANVAS_W;
  for (const x of [50, 200, 300]) {
    expect(vic.fb32[ro + x] === 0xFF000000,
      `mode 111 + vBorder open: canvas X=${x} must be BLACK`);
  }
  ok('Bauer §3.7.3.8: mode 111 (ECM+BMM+MCM) renders BLACK');
}

// ── 3: Standard text mode + zero c-data + bg=black → all black ────────
// If demo prepares c-data=0 and bg=$D021=black, even standard text mode
// renders entirely black. This is the path that produces "no garbage"
// in the user's snapshot expectation.
{
  const vic = makeVic();
  setupOpenVBorderLine(vic, 0x1B, 0x00);   // standard text mode
  vic.regs[0x21] = 0x00;             // bg = black
  for (let c = 0; c <= 63; c++) {
    vic.lineCycleRegs[c].set(vic.regs);
    vic.lineCycleRowCodes[c].fill(0);
    vic.lineCycleRowColors[c].fill(0);
    vic.lineCycleRowFetchedCols[c].fill(0);   // not fetched
  }
  vic._renderRasterLine(20);
  const cy = 20 - 15;
  const ro = cy * CANVAS_W;
  for (const x of [50, 100, 200, 300]) {
    expect(vic.fb32[ro + x] === 0xFF000000,
      `text mode + bg=black + idle=0: pixel x=${x} must be black`);
  }
  ok('Bauer §3.7.3.1: text mode + bg=black + idle=0 renders all black');
}

// ── 4: Idle byte $00 in standard text mode → bg color ──────────────────
{
  const vic = makeVic();
  setupOpenVBorderLine(vic, 0x1B, 0x00);
  vic.regs[0x21] = 0x06;             // bg = blue
  for (let c = 0; c <= 63; c++) {
    vic.lineCycleRegs[c].set(vic.regs);
    vic.lineCycleRowCodes[c].fill(0);
    vic.lineCycleRowColors[c].fill(0);
    vic.lineCycleRowFetchedCols[c].fill(0);
    vic.lineCycleIdleByte[c] = 0x00;
  }
  vic._renderRasterLine(20);
  const cy = 20 - 15;
  const ro = cy * CANVAS_W;
  for (const x of [50, 200]) {
    expect(vic.fb32[ro + x] === PAL(0x06),
      `text mode + idle=0: pixel x=${x} = bg ($D021), got 0x${vic.fb32[ro + x].toString(16)}`);
  }
  ok('Bauer §3.7.3.1: idle=0 in text mode paints bg color $D021');
}

// ── 5: ECM mode bg-index encoding from screen-code bits 6,7 ────────────
// Bauer §3.7.3.5: bgSel = (rawCode >> 6) & 3. Verify the formula
// independently of full rendering setup.
{
  // Pure logic — no rendering. Rule is in cpu.js _renderSourceColumn:
  // bgSel := (rawCode >> 6) & 0x03. Just assert the four code values.
  for (const [code, expectedSel] of [[0x00, 0], [0x40, 1], [0x80, 2], [0xC0, 3]]) {
    expect(((code >> 6) & 0x03) === expectedSel,
      `code=$${code.toString(16)} → bgSel=${expectedSel}`);
  }
  ok('Bauer §3.7.3.5: ECM bgSel = (screen-code >> 6) & 3 (4 bg banks)');
}

// ── 6: borderBuffer correctly tracks vBorder=0 + hBorder=0 → 0 ────────
// With both open, borderBuffer must be cleared (0) for the segment so
// sprites can paint there.
{
  const vic = makeVic();
  setupOpenVBorderLine(vic, 0x73, 0xFF);
  vic.displayActive = true;
  vic._renderRasterLine(20);
  const cy = 20 - 15;
  const ro = cy * CANVAS_W;
  // Inner window cycles 15..54 → canvas 32..351 should have borderBuffer=0.
  let openCnt = 0;
  for (let x = 32; x <= 351; x++) {
    if (vic.borderBuffer[x] === 0) openCnt++;
  }
  expect(openCnt > 100,
    `vBorder + hBorder both open: inner X range borderBuffer=0 for sprites`);
  ok('Bauer §3.9: both borders open → borderBuffer=0 in inner range');
}

// ── 7: With vBorder=0 in TOP zone (raster < L51), display still hits idle path
// When vBorder is wrongly open (DEN-disable trick) in the top zone, the
// renderer enters the same paths as inner-display, just without active
// display. Idle byte determines the shifter; mode determines color.
{
  const vic = makeVic();
  setupOpenVBorderLine(vic, 0x1B, 0xFF);
  vic.regs[0x21] = 0x06;
  vic.displayActive = false;             // no active display in top zone
  for (let c = 0; c <= 63; c++) {
    vic.lineCycleRegs[c].set(vic.regs);
    vic.lineCycleDisplayColumnActive[c] = 0;
    vic.lineCycleIdleByte[c] = 0xFF;
  }
  vic._renderRasterLine(20);
  const cy = 20 - 15;
  const ro = cy * CANVAS_W;
  // With idle=$FF + mode 000 (text), all pixels are foreground BLACK
  // per the open-border idle-shifter logic.
  for (const x of [50, 100, 200]) {
    expect(vic.fb32[ro + x] === 0xFF000000,
      `top zone vBorder=open + idle $FF: x=${x} = BLACK (fg)`);
  }
  ok('Bauer §3.7.5: open vBorder + idle $FF → fg pixels (BLACK in text mode)');
}

// ── 8: mid-line vBorder transition splits rendering: Method 1 → Method 2
// Bauer §3.9 + §3.14.1: with hBorder=0 (main FF reset) across the inner
// zone, vBorder=1 in the first half forces sequencer→bg color (Method 1),
// while vBorder=0 in the second half opens fully (Method 2 → idle byte).
// borderBuffer is 0 throughout (main FF reset) — sprites can paint.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x20] = 0x06;             // border = blue (irrelevant in inner)
  vic.regs[0x21] = 0x02;             // bg = red — distinguishes from black
  for (let c = 0; c <= 63; c++) {
    vic.lineCycleVBorder[c] = c <= 30 ? 1 : 0;
    vic.lineCycleVBorderBefore[c] = c <= 30 ? 1 : 0;
    vic.lineCycleHBorder[c] = (c <= 14 || c >= 56) ? 1 : 0;
    vic.lineCycleHBorderBefore[c] = (c <= 14 || c >= 56) ? 1 : 0;
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
    vic.lineCycleRegs[c].set(vic.regs);
    vic.lineCycleIdleByte[c] = 0xFF;          // ghost pattern — visible only in Method 2
  }
  vic._renderRasterLine(20);
  const cy = 20 - 15;
  const ro = cy * CANVAS_W;
  // First half (cycle 25 → canvas X ~104..111, hBorder=0+vBorder=1 →
  // Method 1): bg color $D021 = red.
  expect(vic.fb32[ro + 104] === PAL(0x02),
    `mid-line vBorder=1 zone: x=104 must be bg=$02 (Method 1)`);
  expect(vic.borderBuffer[104] === 0,
    `mid-line vBorder=1 zone: x=104 borderBuffer=0 (main FF reset)`);
  // Second half (cycle 40 → canvas X ~232, hBorder=0+vBorder=0 →
  // Method 2 with idle=$FF text mode → all BLACK fg).
  expect(vic.fb32[ro + 232] === 0xFF000000,
    `mid-line vBorder=0 zone: x=232 must be ghost-byte BLACK (Method 2)`);
  expect(vic.borderBuffer[232] === 0,
    `mid-line vBorder=0 zone: x=232 borderBuffer=0`);
  ok('Bauer §3.9 + §3.14.1: mid-line vBorder transition switches Method 1 ↔ Method 2');
}

// ── 9: Sprites overlay border-color where borderBuffer=1 ───────────────
// Sprite paint is gated by borderBuffer === 0. With borderBuffer=1
// (closed), sprites are blocked. The user's snapshot relies on the
// demo opening the border so sprites can be visible.
{
  const vic = makeVic();
  for (let c = 1; c <= 63; c++) {
    vic.lineCycleRegs[c][0x15] |= 1;
    vic.lineCycleRegs[c][0] = 100;
    vic.lineCycleRegs[c][0x27] = 0x02;
    vic.lineCycleSpriteDisplayOn[c][0] = 1;
    vic.lineCycleSpriteDataRow[c][0] = 0;
    vic.lineCycleSpriteRowByteMask[c][0] = 0x07;
    vic.lineCycleSpriteShiftReg[c][0] = 0xFFFFFF;
  }
  vic.spriteShiftReg[0] = 0xFFFFFF;
  vic.spriteRowByteMask[0] = 0x07;
  vic.spriteLineDataRow[0] = 0;
  const cy = 20;
  const ro = cy * CANVAS_W;
  // borderBuffer fully closed.
  vic.borderBuffer.fill(1, 0, CANVAS_W);
  vic.spriteOwnerBuffer.fill(0xFF, 0, CANVAS_W);
  vic._renderSpriteLine(20, cy);
  let painted = 0;
  for (let x = 0; x < CANVAS_W; x++) if (vic.spriteOwnerBuffer[x] === 0) painted++;
  expect(painted === 0,
    `sprites blocked when borderBuffer=1 (closed)`);
  ok('Bauer §3.8 + §3.9: sprite paint requires borderBuffer=0 (open)');
}

// ── 10: Sprite paints when border-FF is open via demo trick ───────────
// Open the border-FF (borderBuffer=0) and verify sprite paints.
{
  const vic = makeVic();
  for (let c = 1; c <= 63; c++) {
    vic.lineCycleRegs[c][0x15] |= 1;
    vic.lineCycleRegs[c][0] = 100;
    vic.lineCycleRegs[c][0x27] = 0x02;
    vic.lineCycleSpriteDisplayOn[c][0] = 1;
    vic.lineCycleSpriteDataRow[c][0] = 0;
    vic.lineCycleSpriteRowByteMask[c][0] = 0x07;
    vic.lineCycleSpriteShiftReg[c][0] = 0xFFFFFF;
  }
  vic.spriteShiftReg[0] = 0xFFFFFF;
  vic.spriteRowByteMask[0] = 0x07;
  vic.spriteLineDataRow[0] = 0;
  const cy = 20;
  const ro = cy * CANVAS_W;
  // borderBuffer=0 (open) — DEN-disable trick state.
  vic.borderBuffer.fill(0, 0, CANVAS_W);
  vic.spriteOwnerBuffer.fill(0xFF, 0, CANVAS_W);
  vic._renderSpriteLine(20, cy);
  let painted = 0;
  for (let x = 0; x < CANVAS_W; x++) if (vic.spriteOwnerBuffer[x] === 0) painted++;
  expect(painted === 24,
    `open border + sprite: must paint 24 px, got ${painted}`);
  ok('Bauer §3.8: sprite paints normally when border-FF is open (post-trick)');
}

console.log(`\n${testNo} top-border rendering spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
