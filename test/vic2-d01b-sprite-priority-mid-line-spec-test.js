// $D01B sprite-vs-bg priority mid-line PIXEL spec test.
//
// Bauer §3.8 + §3.11: $D01B (sprite priority) bit N controls whether
// sprite N paints OVER background-foreground pixels or UNDER them:
//   bit N = 0 → sprite OVER bg-fg (sprite wins overlap)
//   bit N = 1 → bg-fg OVER sprite (sprite hidden under fg pixels)
//
// Background-foreground (= fg-map=1) pixels are produced by the graphics
// shifter at fg bit positions. Background-background (= fg-map=0)
// pixels are always overpainted by sprites.
//
// $D01B is sampled LIVE per pixel for priority resolution (Bauer §3.8).
// A mid-line write changes priority for subsequent pixels in the same
// line. Demos use this to flicker a sprite "in front of" then "behind"
// graphics on a single scanline.
//
// Audit gap: $D01B mid-line priority pixel rendering — not previously
// tested. sprite-priority-collision-spec covers vBorder×collision; this
// covers $D01B mid-line pixel ordering.

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

// Set up a render scene: text-mode line with col K = $11 (all-fg
// glyph), sprite 0 enabled at sprite-X overlapping col K. Per-cycle
// state populated; renderer can paint based on per-cycle $D01B.
function setupSpriteOverGraphics(vic, priorityValueByCycle) {
  // Graphics: glyph $11 row 0 = $FF (all-fg). Char base 0.
  for (let b = 0; b < 8; b++) vic.ram[0x11 * 8 + b] = 0xFF;

  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x10;
  vic.regs[0x21] = 0x06;             // bg blue
  vic.regs[0x27] = 0x02;             // sprite 0 color = red
  vic.rowFetchD011 = 0x1B;
  vic.rowFetchD016 = 0x08;
  vic.rowFetchD018 = 0x10;

  for (let c = 0; c <= 63; c++) {
    vic.lineCycleRegs[c].set(vic.regs);
    // Sprite 0 X = 100 → canvas X 108..131 (covers cycles 25..27 inner display).
    vic.lineCycleRegs[c][0x00] = 100;
    vic.lineCycleRegs[c][0x15] = 0x01;
    vic.lineCycleRegs[c][0x1B] = priorityValueByCycle(c) ? 0x01 : 0x00;
    vic.lineCycleRowCodes[c].fill(0x11);
    vic.lineCycleRowColors[c].fill(0x07);     // fg yellow
    vic.lineCycleRowFetchedCols[c].fill(1);
    vic.lineCycleDisplayColumnActive[c] = 1;
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
    vic.lineCycleHBorder[c] = (c <= 14 || c >= 56) ? 1 : 0;
    vic.lineCycleHBorderBefore[c] = vic.lineCycleHBorder[c];
    vic.lineCycleVBorder[c] = 0;
    vic.lineCycleVBorderBefore[c] = 0;
    vic.lineCycleSpriteDisplayOn[c][0] = 1;
    vic.lineCycleSpriteDataRow[c][0] = 0;
    vic.lineCycleSpriteRowByteMask[c][0] = 0x07;
    vic.lineCycleSpriteShiftReg[c][0] = 0xFFFFFF;
    vic.lineCycleCselComparator[c] = 1;
    vic.lineCycleRowVcBase[c] = 0;
    vic.lineCycleRc[c] = 0;
    vic.lineCycleBanks[c] = 0;
  }
  vic.displayActive = true;
  vic.spriteLineDataRow[0] = 0;
  vic.spriteRowByteMask[0] = 0x07;
  vic.spriteShiftReg[0] = 0xFFFFFF;
}

const RED = PAL(0x02);
const YELLOW = PAL(0x07);

// ── 1: $D01B bit 0 = 0 throughout — sprite OVER bg-fg.
// Sprite 0 at canvas X 108..131. Glyph cols 10..16 (canvas X 112..143)
// are all-fg yellow. Overlap region (X 112..131) should show SPRITE color
// (red) under priority=0.
{
  const vic = makeVic();
  setupSpriteOverGraphics(vic, () => false);
  vic._renderRasterLine(60);
  const ro = (60 - 15) * CANVAS_W;
  // Sample X=120 (inside sprite + inside col 11 fg).
  expect(vic.fb32[ro + 120] === RED,
    `priority=0 (sprite over fg): X=120 should be sprite red; got 0x${vic.fb32[ro + 120].toString(16)}`);
  ok('Bauer §3.8: $D01B bit N = 0 → sprite N paints OVER background-foreground pixels');
}

// ── 2: $D01B bit 0 = 1 throughout — bg-fg OVER sprite.
// Sprite 0 hidden behind glyph fg pixels (yellow wins).
{
  const vic = makeVic();
  setupSpriteOverGraphics(vic, () => true);
  vic._renderRasterLine(60);
  const ro = (60 - 15) * CANVAS_W;
  expect(vic.fb32[ro + 120] === YELLOW,
    `priority=1 (fg over sprite): X=120 should be glyph yellow; got 0x${vic.fb32[ro + 120].toString(16)}`);
  ok('Bauer §3.8: $D01B bit N = 1 → background-foreground paints OVER sprite N');
}

// ── 3: Mid-line $D01B flip — first half priority=0 (sprite wins),
// second half priority=1 (fg wins). Two halves of the sprite paint
// differently.
//
// Sprite 0 spans canvas X 108..131 (24 px). Flip $D01B at cycle 26
// (canvas X 128). So X 108..127 (priority=0) = sprite red, X 128..131
// (priority=1) = glyph yellow.
{
  const vic = makeVic();
  setupSpriteOverGraphics(vic, c => c >= 27);    // priority=1 from cy 27+
  vic._renderRasterLine(60);
  const ro = (60 - 15) * CANVAS_W;
  expect(vic.fb32[ro + 115] === RED,
    `mid-line flip: X=115 (pre-flip) = sprite red; got 0x${vic.fb32[ro + 115].toString(16)}`);
  expect(vic.fb32[ro + 130] === YELLOW,
    `mid-line flip: X=130 (post-flip) = glyph yellow; got 0x${vic.fb32[ro + 130].toString(16)}`);
  ok('Bauer §3.8: mid-line $D01B flip — sprite/bg priority switches per-cycle');
}

// ── 4: Bg-background (fg-map=0) always shows sprite regardless of $D01B.
// Cols with all-bg glyph: sprite overlap with bg-bg pixels = sprite.
{
  const vic = makeVic();
  // Glyph $11 row 0 = $00 (all-bg). So col 11..16 = bg blue.
  for (let b = 0; b < 8; b++) vic.ram[0x11 * 8 + b] = 0x00;
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x10;
  vic.regs[0x21] = 0x06;
  vic.regs[0x27] = 0x02;
  vic.rowFetchD011 = 0x1B;
  vic.rowFetchD016 = 0x08;
  vic.rowFetchD018 = 0x10;
  for (let c = 0; c <= 63; c++) {
    vic.lineCycleRegs[c].set(vic.regs);
    vic.lineCycleRegs[c][0x00] = 100;
    vic.lineCycleRegs[c][0x15] = 0x01;
    vic.lineCycleRegs[c][0x1B] = 0x01;            // priority=1 throughout
    vic.lineCycleRowCodes[c].fill(0x11);
    vic.lineCycleRowColors[c].fill(0x07);
    vic.lineCycleRowFetchedCols[c].fill(1);
    vic.lineCycleDisplayColumnActive[c] = 1;
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
    vic.lineCycleHBorder[c] = (c <= 14 || c >= 56) ? 1 : 0;
    vic.lineCycleHBorderBefore[c] = vic.lineCycleHBorder[c];
    vic.lineCycleVBorder[c] = 0;
    vic.lineCycleVBorderBefore[c] = 0;
    vic.lineCycleSpriteDisplayOn[c][0] = 1;
    vic.lineCycleSpriteDataRow[c][0] = 0;
    vic.lineCycleSpriteRowByteMask[c][0] = 0x07;
    vic.lineCycleSpriteShiftReg[c][0] = 0xFFFFFF;
    vic.lineCycleCselComparator[c] = 1;
    vic.lineCycleRowVcBase[c] = 0;
    vic.lineCycleRc[c] = 0;
    vic.lineCycleBanks[c] = 0;
  }
  vic.displayActive = true;
  vic.spriteLineDataRow[0] = 0;
  vic.spriteRowByteMask[0] = 0x07;
  vic.spriteShiftReg[0] = 0xFFFFFF;
  vic._renderRasterLine(60);
  const ro = (60 - 15) * CANVAS_W;
  expect(vic.fb32[ro + 120] === RED,
    `bg-bg pixel under sprite (priority=1): sprite always wins; got 0x${vic.fb32[ro + 120].toString(16)}`);
  ok('Bauer §3.11: sprite paints OVER bg-bg (fg-map=0) regardless of $D01B priority');
}

console.log(`\n${testNo} $D01B priority mid-line spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
