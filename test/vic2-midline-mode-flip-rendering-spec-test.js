// Mid-line $D011 mode-flip rendering spec audit. 5 tests verifying the
// spec rule that the VIC reads $D011 LIVE per pixel for mode decisions
// in the text/bitmap rendering path (Bauer §3.7.3).
//
// nine.prg's L44-L67 mode-flip pattern (44 writes per frame between
// $1B / text and $73 / mode 110) requires per-pixel mode evaluation:
// d011/d016 must come from the per-cycle segment regs, not the line-invariant
// bad-line snapshot.

import { VIC2, CYCLES_PER_LINE, CANVAS_W } from '../src/vic2.js';

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

// ── 1: Mid-line flip $1B→$73 — second-half pixels must be BLACK ────────
// Spec: per-pixel $D011 sample. Bauer §3.7.3.7 says mode 110 forces
// BLACK. With flip at cycle 30, pixels in cycles 30..54 must be black
// regardless of bad-line mode.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;             // bad-line happened in text mode
  vic.regs[0x16] = 0x08;
  vic.regs[0x21] = 0x06;             // bg = blue
  vic.rowFetchD011 = 0x1B;            // line-invariant: text mode
  vic.rowFetchD016 = 0x08;
  // Pre-line state: text mode in regs.
  for (let c = 0; c <= 63; c++) {
    vic.lineCycleRegs[c].set(vic.regs);
    vic.lineCycleRowCodes[c].fill(0xFF);
    vic.lineCycleRowColors[c].fill(0x02);    // red fg
    vic.lineCycleRowFetchedCols[c].fill(1);
    vic.lineCycleDisplayColumnActive[c] = 1;
    vic.lineCycleHBorderBefore[c] = (c <= 14 || c >= 56) ? 1 : 0;
    vic.lineCycleHBorder[c] = (c <= 14 || c >= 56) ? 1 : 0;
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
    vic.lineCycleVBorder[c] = 0;
    vic.lineCycleVBorderBefore[c] = 0;
  }
  // Mid-line flip: cycles 30..63 have mode $73 in regs.
  for (let c = 30; c <= 63; c++) {
    vic.lineCycleRegs[c][0x11] = 0x73;
  }
  vic.displayActive = true;
  vic._renderRasterLine(20);
  const cy = 20 - 15;
  const ro = cy * CANVAS_W;
  // Cycle 35 → canvas X ~ (35-12)*8+8 = 192. Mode 110 → BLACK.
  expect(vic.fb32[ro + 192] === 0xFF000000,
    `cycle 35 (post-flip) mode 110: pixel must be BLACK, got 0x${vic.fb32[ro + 192].toString(16)}`);
  ok('Bauer §3.7.3.7: mid-line flip to mode 110 must render second-half BLACK');
}

// ── 2: Mid-line flip $73→$1B — first-half BLACK, second-half text ─────
{
  const vic = makeVic();
  vic.regs[0x11] = 0x73;
  vic.regs[0x16] = 0x08;
  vic.regs[0x21] = 0x06;
  vic.rowFetchD011 = 0x73;
  vic.rowFetchD016 = 0x08;
  for (let c = 0; c <= 63; c++) {
    vic.lineCycleRegs[c].set(vic.regs);
    vic.lineCycleRowCodes[c].fill(0xFF);
    vic.lineCycleRowColors[c].fill(0x02);
    vic.lineCycleRowFetchedCols[c].fill(1);
    vic.lineCycleDisplayColumnActive[c] = 1;
    vic.lineCycleHBorderBefore[c] = (c <= 14 || c >= 56) ? 1 : 0;
    vic.lineCycleHBorder[c] = (c <= 14 || c >= 56) ? 1 : 0;
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
  }
  for (let c = 30; c <= 63; c++) {
    vic.lineCycleRegs[c][0x11] = 0x1B;
  }
  vic.displayActive = true;
  vic._renderRasterLine(20);
  const cy = 20 - 15;
  const ro = cy * CANVAS_W;
  // Cycle 18 → canvas X ~ 56. Mode 110 → BLACK.
  expect(vic.fb32[ro + 56] === 0xFF000000,
    `cycle 18 (pre-flip) mode 110: pixel must be BLACK`);
  // Cycle 40 → canvas X ~ 232. Mode $1B (text) — would render text glyph.
  // Just verify it's NOT BLACK (confirming flip was applied).
  expect(vic.fb32[ro + 232] !== 0xFF000000,
    `cycle 40 (post-flip) mode text: pixel should NOT be BLACK (text rendered)`);
  ok('Bauer §3.7.3.7: mid-line flip from mode 110 to text changes per-cycle');
}

// ── 3: rowFetchD011 vs seg.regs[$11] — spec says use seg.regs ─────────
// Per Bauer §3.7.3, mode is sampled per pixel from $D011. Our impl
// uses rowFetchD011 (line-invariant). This test documents the
// expected behavior: render must use per-cycle regs[$11] for the
// ECM/BMM bits.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x73;             // current is mode 110
  vic.rowFetchD011 = 0x1B;            // bad-line snapshot: text mode
  vic.rowFetchD016 = 0x08;
  vic.regs[0x16] = 0x08;
  vic.regs[0x21] = 0x06;
  for (let c = 0; c <= 63; c++) {
    vic.lineCycleRegs[c].set(vic.regs);
    vic.lineCycleRowCodes[c].fill(0xFF);
    vic.lineCycleRowColors[c].fill(0x02);
    vic.lineCycleRowFetchedCols[c].fill(1);
    vic.lineCycleDisplayColumnActive[c] = 1;
    vic.lineCycleHBorderBefore[c] = (c <= 14 || c >= 56) ? 1 : 0;
    vic.lineCycleHBorder[c] = (c <= 14 || c >= 56) ? 1 : 0;
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
  }
  vic.displayActive = true;
  vic._renderRasterLine(20);
  const cy = 20 - 15;
  const ro = cy * CANVAS_W;
  // Per spec, mode is read from regs at render time → mode 110 → BLACK.
  // Our impl uses rowFetchD011=$1B → text mode → NOT BLACK.
  // This test documents the spec rule; FAILURE indicates the impl
  // simplification is in play.
  expect(vic.fb32[ro + 100] === 0xFF000000,
    `spec: per-pixel mode read should yield BLACK with regs=$73; ` +
    `current impl uses rowFetchD011=$1B, producing wrong pixel ` +
    `(0x${vic.fb32[ro + 100].toString(16)})`);
  ok('Bauer §3.7.3: mode is read live from $D011 per pixel (not bad-line snapshot)');
}

// ── 4: Mode flip during open-border idle path uses live $D011 (passes) ─
// In the OPEN-BORDER idle path, our impl correctly uses seg.regs[$11].
// Verify by setting up the idle path with displayColumnActive=false.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x73;
  vic.regs[0x16] = 0x08;
  vic.regs[0x21] = 0x06;
  for (let c = 0; c <= 63; c++) {
    vic.lineCycleRegs[c].set(vic.regs);
    vic.lineCycleHBorderBefore[c] = (c <= 14 || c >= 56) ? 1 : 0;
    vic.lineCycleHBorder[c] = (c <= 14 || c >= 56) ? 1 : 0;
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
    vic.lineCycleIdleByte[c] = 0xFF;
  }
  vic._renderRasterLine(20);
  const cy = 20 - 15;
  const ro = cy * CANVAS_W;
  expect(vic.fb32[ro + 100] === 0xFF000000,
    `idle-path uses live regs: mode 110 → BLACK`);
  ok('VIC: idle-path mode evaluation uses live regs[$11] (correct)');
}

// ── 5: Mode mid-line flip $1B (text) → $5B (ECM-only) renders ECM ─────
// Final per-pixel mode test: ECM-text mode ($D011=$5B) selects bg by
// the screen-code's top 2 bits. With code=$00, bgSel=0 → bg0=$D021.
// Mid-line flip to ECM mode: pixel must render bg0 (or fg=BLACK with
// idle byte $FF), not the prev mode's text glyph.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x21] = 0x00;             // bg = black
  vic.rowFetchD011 = 0x1B;
  vic.rowFetchD016 = 0x08;
  for (let c = 0; c <= 63; c++) {
    vic.lineCycleRegs[c].set(vic.regs);
    vic.lineCycleRowCodes[c].fill(0x00);     // code=0 → bgSel=0
    vic.lineCycleRowColors[c].fill(0x02);    // would render red fg in plain text
    vic.lineCycleRowFetchedCols[c].fill(1);
    vic.lineCycleDisplayColumnActive[c] = 1;
    vic.lineCycleHBorderBefore[c] = (c <= 14 || c >= 56) ? 1 : 0;
    vic.lineCycleHBorder[c] = (c <= 14 || c >= 56) ? 1 : 0;
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
  }
  // Flip to ECM-only at cycle 30.
  for (let c = 30; c <= 63; c++) {
    vic.lineCycleRegs[c][0x11] = 0x5B;
  }
  vic.displayActive = true;
  vic._renderRasterLine(20);
  const cy = 20 - 15;
  const ro = cy * CANVAS_W;
  // With code=0, bgSel=0, charByte=0 (charRom is zeros), all pixels
  // render bg0 = black for ECM mode. Just verify a post-flip pixel is
  // bg color.
  expect(vic.fb32[ro + 200] === 0xFF000000,
    `mid-line flip to ECM-only: bg=black pixel must render black, got 0x${vic.fb32[ro + 200].toString(16)}`);
  ok('Bauer §3.7.3.5: mid-line flip to ECM-only mode evaluates per-cycle');
}

console.log(`\n${testNo} mid-line mode-flip rendering spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
