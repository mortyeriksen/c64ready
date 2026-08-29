// nine.prg top-border ghost-byte trick — opened-idle $D021 stays live.
//
// Nine starts each top-border digit raster in invalid $70, then flips $D011
// into text mode for the ghost-byte band while also changing $D021. The invalid
// spans render black, but the text-mode idle byte must use the live/output-stage
// background colour so transparent sprite gaps reveal the coloured ghost-byte
// pattern. Latching $D021 at line start leaves the priority/collision bits
// present but makes the visible idle layer black-on-black, so the upper-border
// digits look blocky.
//
// Pure synthetic per-cycle state; no nine.prg load.

import { VIC2, CYCLES_PER_LINE, CANVAS_W, C64_PALETTE } from '../src/vic2.js';

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
  return vic;
}

function paintNineModeFlipLine({ idleByte = 0x00, batchRender = true } = {}) {
  const vic = makeVic();
  vic.batchRender = batchRender;
  const invalidMode = 0x70;    // ECM=1, BMM=1, MCM=0: invalid, black pixels
  const textMode = 0x10;       // text mode, DEN set
  vic.regs[0x11] = invalidMode;
  vic.regs[0x16] = 0x08;      // CSEL=1, XSCROLL=0
  vic.regs[0x20] = 0x00;
  vic.regs[0x21] = 0x00;
  vic._lineStartD011 = invalidMode;
  vic._prevLineStartD011 = invalidMode;

  for (let c = 0; c <= CYCLES_PER_LINE; c++) {
    let d011 = invalidMode;
    let d021 = 0x00;
    if (c >= 19 && c <= 25) d021 = 0x04;                 // purple
    if (c >= 26 && c <= 32) { d011 = textMode; d021 = 0x04; }
    if (c >= 33 && c <= 36) { d011 = textMode; d021 = 0x0e; } // light blue
    if (c >= 37 && c <= 40) { d011 = textMode; d021 = 0x03; } // cyan
    if (c >= 41 && c <= 44) { d011 = textMode; d021 = 0x00; }
    if (c >= 45)            { d011 = invalidMode; d021 = 0x00; }
    vic.regs[0x11] = d011;
    vic.regs[0x21] = d021;
    vic.lineCycleRegs[c].set(vic.regs);
    vic.lineCycleVBorder[c] = 0;
    vic.lineCycleVBorderBefore[c] = 0;
    vic.lineCycleHBorder[c] = (c <= 14 || c >= 55) ? 1 : 0;
    vic.lineCycleHBorderBefore[c] = vic.lineCycleHBorder[c];
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
    vic.lineCycleDisplayColumnActive[c] = 0;
    vic.lineCycleDisplayActive[c] = 0;
    vic.lineCycleDisplayEnabled[c] = 1;
    vic.lineCycleBanks[c] = 0;
    vic.lineCycleVc[c] = 0;
    vic.lineCycleRc[c] = 0;
    vic.lineCycleRowVcBase[c] = 0;
    vic.lineCycleCselComparator[c] = 1;
    vic.lineCycleIdleByte[c] = idleByte;
  }

  const canvasY = 20;
  vic._initRenderRasterLine(20, canvasY);
  for (let cycle = 11; cycle <= 58; cycle++) {
    vic._renderCycleSegmentGraphics(vic._buildCycleRasterSegment(cycle), canvasY);
  }
  vic._fixupColumns(canvasY);
  return { vic, ro: canvasY * CANVAS_W };
}

// ─── 1: Invalid $70 stays black, text-mode ghost band uses live $D021 ───
{
  const { vic, ro } = paintNineModeFlipLine({ idleByte: 0x00 });
  const black = PAL_RGBA(0x00);
  const purple = PAL_RGBA(0x04);
  const lightBlue = PAL_RGBA(0x0e);
  const cyan = PAL_RGBA(0x03);

  // Invalid $70 span: black regardless of live $D021.
  expect(vic.fb32[ro + 96] === black,
    `invalid $70 span must stay black, got 0x${vic.fb32[ro + 96].toString(16).padStart(8, '0')}`);

  // Text-mode span: idle byte $00 means every bit is background, so the final
  // row must expose the output-stage-retimed $D021 colours. Use non-first
  // pixels inside the cycle to avoid the first-pixel boundary rule.
  expect(vic.fb32[ro + 137] === purple,
    `text ghost band cy28 should expose live purple $D021, got 0x${vic.fb32[ro + 137].toString(16).padStart(8, '0')}`);
  expect(vic.fb32[ro + 153] === lightBlue,
    `text ghost band cy30 should expose live light-blue $D021, got 0x${vic.fb32[ro + 153].toString(16).padStart(8, '0')}`);
  expect(vic.fb32[ro + 185] === cyan,
    `text ghost band cy34 should expose live cyan $D021, got 0x${vic.fb32[ro + 185].toString(16).padStart(8, '0')}`);
  ok('Nine opened-idle text ghost band uses live/output-stage $D021, not line-start black');
}

// ─── 2: Real ghost byte still mixes foreground black with live bg ───────
{
  const { vic, ro } = paintNineModeFlipLine({ idleByte: 0x81 });
  const black = PAL_RGBA(0x00);
  const lightBlue = PAL_RGBA(0x0e);
  let blackCount = 0, bgCount = 0;
  for (let x = 152; x < 160; x++) {
    if (vic.fb32[ro + x] === black) blackCount++;
    if (vic.fb32[ro + x] === lightBlue) bgCount++;
  }
  expect(blackCount > 0 && bgCount > 0,
    `ghost byte $81 should mix black fg with live bg in cy30 (black=${blackCount}, bg=${bgCount})`);
  ok('Nine ghost byte pattern remains visible after the $D011 mode flip');
}

// ─── 3: Non-batch fixup path preserves the same live-bg result ─────────
{
  const { vic, ro } = paintNineModeFlipLine({ idleByte: 0x00, batchRender: false });
  const lightBlue = PAL_RGBA(0x0e);
  expect(vic.fb32[ro + 153] === lightBlue,
    `non-batch fixup path should expose live light-blue $D021, got 0x${vic.fb32[ro + 153].toString(16).padStart(8, '0')}`);
  ok('Nine opened-idle live $D021 works in the non-batch fixup path');
}

console.log(`\n${testNo} top-border live-$D021 ghost-byte tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
