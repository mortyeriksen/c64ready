// Sprite-data collisions under the CLOSED main (CSEL side) border.
//
// Bauer §3.9: the main border flip-flop only selects the border colour at
// the output multiplexer — the graphics sequencer keeps shifting underneath
// and the collision unit sees its foreground bits. In 38-column mode
// (CSEL=0) the side borders cover canvas x 32-38 (col 0's first pixels)
// and x 343-351 (col 38's last pixel + col 39): a sprite over those pixels
// must still latch $D01F when the covered graphics are foreground, even
// though nothing of either is visible.
//
// The VERTICAL flip-flop is different silicon: it gates the sequencer
// itself (c-data forced 0 → background, no fg), so vBorder produces no
// collisions.
//
// Demo evidence: Lunatico's dissolve engine drives its sprite-crunch from
// $D01F collision feedback (LDA $D01F / STA $D017 per line); sprite 7's
// only foreground overlaps sit at x 335/343 under the narrow right border.
// Missing them starved the crunch, killed the sprite DMA, and let the
// cycle-timed chain slip into the fetch window — the "gray block".

import { VIC2, CANVAS_W, C64_PALETTE } from '../src/vic2.js';

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

// Standard-bitmap line in 38-column mode (CSEL=0), mirroring the Lunatico
// scene: BMM, xscroll 0, bitmap base $0000, display state. Border edges at
// canvas x 39 (left) and x 343 (right) — per-cycle captures follow the
// split contract: the edge-straddling cycles carry hBorderBefore (state
// left of the edge) + hBorder (state right of it).
//   left  edge 39  ∈ render-seg 15 [32,40):  before=1 (border), after=0
//   right edge 343 ∈ render-seg 53 [336,344): before=0, after=1 (border)
// Sprite 0: X raw 320 → canvas 328-351, all 24 pixels opaque, so it spans
// the open window's last columns AND the covered 343-351 strip.
function setupBmm38Col(vic, { spriteOn = true, vBorder = false } = {}) {
  vic.regs[0x11] = 0x3B;             // DEN+BMM+RSEL, ys=3
  vic.regs[0x16] = 0x00;             // CSEL=0 (38 col), xscroll 0
  vic.regs[0x18] = 0x70;             // VM=7; bitmap base bit3=0 → $0000
  vic.regs[0x20] = 0x06;             // border blue
  vic.regs[0x27] = 0x02;             // sprite 0 red
  vic.rowFetchD011 = 0x3B;
  vic.rowFetchD016 = 0x00;
  vic.rowFetchD018 = 0x70;
  for (let c = 0; c <= 63; c++) {
    vic.lineCycleRegs[c].set(vic.regs);
    vic.lineCycleRegs[c][0x00] = 320 & 0xFF;      // sprite 0 X low = $40
    vic.lineCycleRegs[c][0x10] = 0x01;            // sprite 0 X MSB → raw 320
    vic.lineCycleRegs[c][0x15] = spriteOn ? 0x01 : 0x00;
    vic.lineCycleRowCodes[c].fill(0x10);          // BMM colours: fg 1, bg 0
    vic.lineCycleRowColors[c].fill(0x00);
    vic.lineCycleRowFetchedCols[c].fill(1);
    vic.lineCycleDisplayColumnActive[c] = (c >= 15 && c <= 54) ? 1 : 0;
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
    // 38-col side borders: closed left of x39 and right of x343.
    // Segs: 15 straddles the left edge, 53 the right edge.
    if (c < 15) { vic.lineCycleHBorder[c] = 1; vic.lineCycleHBorderBefore[c] = 1; }
    else if (c === 15) { vic.lineCycleHBorder[c] = 0; vic.lineCycleHBorderBefore[c] = 1; }
    else if (c < 53) { vic.lineCycleHBorder[c] = 0; vic.lineCycleHBorderBefore[c] = 0; }
    else if (c === 53) { vic.lineCycleHBorder[c] = 1; vic.lineCycleHBorderBefore[c] = 0; }
    else { vic.lineCycleHBorder[c] = 1; vic.lineCycleHBorderBefore[c] = 1; }
    vic.lineCycleVBorder[c] = vBorder ? 1 : 0;
    vic.lineCycleVBorderBefore[c] = vBorder ? 1 : 0;
    vic.lineCycleSpriteDisplayOn[c][0] = spriteOn ? 1 : 0;
    vic.lineCycleSpriteDataRow[c][0] = 0;
    vic.lineCycleSpriteRowByteMask[c][0] = 0x07;
    vic.lineCycleSpriteShiftReg[c][0] = 0xFFFFFF;
    vic.lineCycleCselComparator[c] = 0;           // narrow comparators (39/343)
    vic.lineCycleRowVcBase[c] = 0;
    vic.lineCycleRowLiveVcBase[c] = 0;
    vic.lineCycleRc[c] = 0;
    vic.lineCycleBanks[c] = 0;
  }
  vic.displayActive = true;
  vic.spriteLineDataRow[0] = 0;
  vic.spriteRowByteMask[0] = 0x07;
  vic.spriteShiftReg[0] = 0xFFFFFF;
}

const BORDER_BLUE = PAL(0x06);

// ── 1: fg under the CSEL right border collides ($D01F) but stays covered ──
{
  const vic = makeVic();
  setupBmm38Col(vic);
  // Bitmap bytes (base $0000, vc*8+rc): col 38 → $01 (fg pixel at x 343,
  // exactly the border-covered pixel), col 39 → $FF (fg x 344-351).
  vic.ram[38 * 8] = 0x01;
  vic.ram[39 * 8] = 0xFF;
  vic._renderRasterLine(60);
  const ro = (60 - 15) * CANVAS_W;
  expect((vic.regs[0x1F] & 0x01) === 0x01,
    `$D01F bit0 must latch from fg under the right border; got $${vic.regs[0x1F].toString(16)}`);
  expect(vic.graphicsCollisionBuffer[343] === 1, 'fg map at x343 (col 38 bit0) must be 1');
  expect(vic.graphicsCollisionBuffer[344] === 1 && vic.graphicsCollisionBuffer[351] === 1,
    'fg map at x344..351 (col 39) must be 1');
  expect(vic.borderBuffer[343] === 1 && vic.borderBuffer[350] === 1,
    'border overlay must stay closed over the covered columns');
  expect(vic.fb32[ro + 343] === BORDER_BLUE && vic.fb32[ro + 348] === BORDER_BLUE,
    `covered pixels must still show border colour; got 0x${vic.fb32[ro + 343].toString(16)} / 0x${vic.fb32[ro + 348].toString(16)}`);
  ok('Bauer §3.9: fg under the CSEL right border latches $D01F; border overlay + visibility unchanged');
}

// ── 2: no fg under the border → no collision (no blanket latching) ──
{
  const vic = makeVic();
  setupBmm38Col(vic);
  // All bitmap bytes 0 — sequencer output under the border is background.
  vic._renderRasterLine(60);
  expect(vic.regs[0x1F] === 0,
    `$D01F must stay clear with no fg under the border; got $${vic.regs[0x1F].toString(16)}`);
  expect(vic.graphicsCollisionBuffer[343] === 0 && vic.graphicsCollisionBuffer[348] === 0,
    'fg map under border must be 0 for background pixels');
  ok('background under the border produces no collision');
}

// ── 3: fg under the CSEL LEFT border collides too ──
{
  const vic = makeVic();
  setupBmm38Col(vic);
  // Col 0 → $FE: fg at x 32-38, all under the left border (open from 39).
  vic.ram[0] = 0xFE;
  // Sprite 0 over the left strip: X raw 30 → canvas 38-61.
  for (let c = 0; c <= 63; c++) {
    vic.lineCycleRegs[c][0x00] = 30;
    vic.lineCycleRegs[c][0x10] = 0x00;
  }
  vic._renderRasterLine(60);
  expect((vic.regs[0x1F] & 0x01) === 0x01,
    `$D01F bit0 must latch from fg under the left border; got $${vic.regs[0x1F].toString(16)}`);
  expect(vic.graphicsCollisionBuffer[38] === 1, 'fg map at x38 (col 0 bit1) must be 1');
  ok('fg under the CSEL left border latches $D01F');
}

// ── 4: vertical border produces NO collision (sequencer gated) ──
{
  const vic = makeVic();
  setupBmm38Col(vic, { vBorder: true });
  vic.ram[38 * 8] = 0x01;
  vic.ram[39 * 8] = 0xFF;
  vic._renderRasterLine(60);
  expect(vic.regs[0x1F] === 0,
    `vBorder must gate the sequencer — no $D01F latch; got $${vic.regs[0x1F].toString(16)}`);
  expect(vic.graphicsCollisionBuffer[343] === 0, 'fg map must be 0 under vBorder');
  ok('Bauer §3.9: vertical border gates the sequencer — no fg, no collision');
}

// ── 5: same scene in 40-column mode — x343 is open window; collision AND
// visible graphics (sanity that the open path is untouched) ──
{
  const vic = makeVic();
  setupBmm38Col(vic);
  vic.ram[38 * 8] = 0x01;
  vic.ram[39 * 8] = 0xFF;
  for (let c = 0; c <= 63; c++) {
    vic.lineCycleRegs[c][0x16] = 0x08;            // CSEL=1
    vic.lineCycleCselComparator[c] = 1;           // wide comparators (32/352)
    // 40-col: whole inner window open, borders outside cycles 15..54.
    if (c >= 15 && c <= 54) { vic.lineCycleHBorder[c] = 0; vic.lineCycleHBorderBefore[c] = 0; }
    else { vic.lineCycleHBorder[c] = 1; vic.lineCycleHBorderBefore[c] = 1; }
  }
  vic.rowFetchD016 = 0x08;
  vic._renderRasterLine(60);
  const ro = (60 - 15) * CANVAS_W;
  expect((vic.regs[0x1F] & 0x01) === 0x01,
    `40-col: $D01F bit0 must latch in the open window; got $${vic.regs[0x1F].toString(16)}`);
  expect(vic.graphicsCollisionBuffer[343] === 1, '40-col: fg map at x343 must be 1');
  expect(vic.borderBuffer[343] === 0, '40-col: x343 must be open (no border)');
  expect(vic.fb32[ro + 348] !== BORDER_BLUE,
    '40-col: col 39 fg must be visible graphics, not border');
  ok('40-column control: open-window collision + visible graphics unchanged');
}

console.log(`\n${testNo} collision-under-CSEL-border spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
