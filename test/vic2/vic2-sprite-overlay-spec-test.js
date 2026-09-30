// VIC-II: Sprite overlay rendering (multi-sprite layout)
// Extracted from vic2-test.js.

import {
  VIC2,
  CANVAS_W,
  CANVAS_H,
  CYCLES_PER_FRAME,
  CYCLES_PER_LINE,
  C64_PALETTE,
  C64Machine,
  paletteRgba,
  ACCESS_IDLE,
  ACCESS_REFRESH,
  ACCESS_C,
  ACCESS_G,
  assert,
  softAssert,
  makeVic,
  makeRenderSeg,
  fillSpriteLineState,
  fillOpaqueSpriteAcrossLine,
  clearLineBuffers,
  setupSpriteForRender,
  setMulticolorRegs,
  fillTextLineState,
  clearRenderedRow,
  firstForegroundX,
  lastForegroundX,
  runUntil,
  makeMasterCycleHarness,
  makeRenderableVic,
} from './_vic2-helpers.js';

// ============================================================================
// Sprite overlay rendering tests — directly exercise the multi-sprite layout
// the nine.prg wizard relies on: sp1 (regular 24-wide) + sp3 (X-expanded
// 48-wide) overlaid at the same canvas X, both at the same Y range.
//
// Per Bauer §3.8.2 the lower-numbered sprite "wins" at any pixel both want
// to draw. Our impl uses spriteOwnerBuffer for first-claim semantics, with
// the draw loop running in priority order (s=0..7).
// ============================================================================

// OVERLAY-1: sp1 (solid cross-shape) overlaid on sp3 (X-expanded full block).
// At pixels where sp1 has a solid bit AND sp3 has a solid bit, sp1 wins.
// At pixels where sp1 is blank but sp3 is solid, sp3 fills.
// This is the wizard composition: sp1 = head/legs detail, sp3 = body fill.
{
  const vic = makeRenderableVic();
  vic.regs[0x15] = 0x0A;        // sp1 + sp3 enabled
  vic.regs[0x1D] = 0x08;        // sp3 X-expanded (bit 3)

  // sp1: positioned at X=$80, Y=$70 — vertical bar shape (col 11..12 only).
  vic.regs[0x02] = 0x80;        // sp1 X = 128
  vic.regs[0x03] = 0x70;        // sp1 Y = 112
  vic.regs[0x28] = 0x01;        // sp1 color = white (D028)
  // sp3: positioned at X=$80 too, Y=$70 — solid block.
  vic.regs[0x06] = 0x80;        // sp3 X = 128 (same as sp1)
  vic.regs[0x07] = 0x70;        // sp3 Y = 112 (same as sp1)
  vic.regs[0x2A] = 0x05;        // sp3 color = green (D02A)

  // sp1 shape at ptr $0E ($0380): vertical bar at columns 11-12 of each row.
  for (let row = 0; row < 21; row++) {
    vic.ram[0x0380 + row*3 + 0] = 0x00;
    vic.ram[0x0380 + row*3 + 1] = 0x18;  // bits 3,4 = pixel cols 11,12
    vic.ram[0x0380 + row*3 + 2] = 0x00;
  }
  // sp3 shape at ptr $0F ($03C0): solid 24×21 block.
  for (let i = 0; i < 63; i++) vic.ram[0x03C0 + i] = 0xFF;

  // Sprite pointers in screen RAM at $0400 + $3F8 = $07F8..$07FF.
  vic.ram[0x07F9] = 0x0E;       // sp1 ptr
  vic.ram[0x07FB] = 0x0F;       // sp3 ptr

  vic.clock(CYCLES_PER_FRAME);

  const WHITE = paletteRgba(0x01);
  const GREEN = paletteRgba(0x05);
  const BG = paletteRgba(0x06);
  // Canvas X for both sprites starts at X=128+8 = 136. sp1 spans 136..159,
  // sp3 spans 136..183 (X-expanded 48 wide).
  const sp1L = 0x80 + 8;         // 136
  const sp3R = sp1L + 48;        // 184
  const yT = 0x70 - 14;          // canvas Y = 98 (sprite first visible line)

  // Inspect a single line for the overlay pattern.
  const dy = 5;
  let whiteCount = 0, greenCount = 0;
  for (let dx = 0; dx < 48; dx++) {
    const px = vic.fb32[(yT + dy) * CANVAS_W + (sp1L + dx)];
    if (px === WHITE) whiteCount++;
    else if (px === GREEN) greenCount++;
  }
  // sp1 shape byte 1 = 0x18 = bits 3,4 set = pixel cols 11,12. So white
  // pixels at sp1 X-offsets 11 and 12 only (2 pixels per line).
  assert(whiteCount === 2,
    `sp1 contributes 2 white pixels per line (got ${whiteCount})`);
  // The remaining 46 pixels of sp3's 48-wide span should be green (sp3 owns
  // them since sp1 didn't claim them).
  assert(greenCount === 46,
    `sp3 fills the 46 pixels sp1 did not own (got ${greenCount})`);

  console.log('ok  - OVERLAY-1: sp1 + sp3 overlay — sp1 wins solid-vs-solid, sp3 fills the rest');
}

// OVERLAY-2: same overlay but verify sp3 X-expand doubled-pixel behavior.
// Each shape bit of sp3 paints TWO consecutive canvas pixels.
{
  const vic = makeRenderableVic();
  vic.regs[0x15] = 0x08;        // only sp3 enabled
  vic.regs[0x1D] = 0x08;        // sp3 X-expanded
  vic.regs[0x06] = 0x40;
  vic.regs[0x07] = 0x60;
  vic.regs[0x2A] = 0x07;        // yellow

  // sp3 shape: alternating solid/blank columns (10101010 in byte 0).
  for (let row = 0; row < 21; row++) {
    vic.ram[0x03C0 + row*3 + 0] = 0xAA;  // 10101010
    vic.ram[0x03C0 + row*3 + 1] = 0x00;
    vic.ram[0x03C0 + row*3 + 2] = 0x00;
  }
  vic.ram[0x07FB] = 0x0F;       // sp3 ptr

  vic.clock(CYCLES_PER_FRAME);

  const YELLOW = paletteRgba(0x07);
  const xL = 0x40 + 8;          // 72
  const yT = 0x60 - 14;         // 82

  // X-expand: each shape bit becomes 2 canvas pixels. So byte $AA pattern
  // 10101010 becomes 11001100 11001100 — pairs of yellow then pairs of bg.
  // First 8 shape-bits → 16 canvas pixels: YYbbYYbbYYbbYYbb.
  for (let dx = 0; dx < 16; dx++) {
    const px = vic.fb32[(yT + 5) * CANVAS_W + (xL + dx)];
    const expected = ((dx >> 1) & 1) === 0 ? YELLOW : null;
    if (expected) {
      assert(px === YELLOW,
        `sp3 X-expand pixel pair: dx=${dx} should be yellow`);
    } else {
      assert(px !== YELLOW,
        `sp3 X-expand pixel pair: dx=${dx} should NOT be yellow (gap)`);
    }
  }

  console.log('ok  - OVERLAY-2: sp3 X-expand renders each shape bit as 2 consecutive canvas pixels');
}

// OVERLAY-3: per-line pointer rewrite with TWO sprites overlaid. The wizard
// pattern: sp1 shape changes per Y-instance while sp3 holds a different
// per-instance shape. Verify both sprites' rendered pixels follow their
// respective per-line pointers — no cross-contamination between sprites.
{
  const vic = makeRenderableVic();
  vic.regs[0x15] = 0x0A;
  vic.regs[0x02] = 0x80; vic.regs[0x03] = 0x50;       // sp1 X=128 Y=80
  vic.regs[0x06] = 0x80; vic.regs[0x07] = 0x50;       // sp3 X=128 Y=80
  vic.regs[0x28] = 0x01;                              // sp1 white
  vic.regs[0x2A] = 0x02;                              // sp3 red
  // No X-expand for sp3 here so we can compare exact pixels.

  // Plant 2 shapes for each sprite. sp1: $0E (top), $10 (bottom).
  // sp3: $0F (top), $11 (bottom).
  for (let i = 0; i < 63; i++) vic.ram[0x0380 + i] = 0x80;  // sp1 first ptr — leftmost bit
  for (let i = 0; i < 63; i++) vic.ram[0x0400 + i] = 0x40;  // sp1 second ptr — bit 6 (col 1)
  for (let i = 0; i < 63; i++) vic.ram[0x03C0 + i] = 0x20;  // sp3 first ptr — bit 5 (col 2)
  for (let i = 0; i < 63; i++) vic.ram[0x0440 + i] = 0x10;  // sp3 second ptr — bit 4 (col 3)
  vic.ram[0x07F9] = 0x0E;       // sp1 initial
  vic.ram[0x07FB] = 0x0F;       // sp3 initial

  // Run until raster 90 (10 lines into both sprites).
  vic.clock(CYCLES_PER_LINE * 91);
  // Swap BOTH pointers. Lines from now on use new shapes for both sprites.
  vic.ram[0x07F9] = 0x10;
  vic.ram[0x07FB] = 0x11;
  vic.clock(CYCLES_PER_FRAME - CYCLES_PER_LINE * 91);

  const WHITE = paletteRgba(0x01);
  const RED = paletteRgba(0x02);
  const xL = 0x80 + 8;
  const yT = 0x50 - 14;         // 66

  // Wait — sp1 Y=$50=80, displays at canvas Y 66..86 (21 lines). Pre-swap
  // covers canvas dy 0..(91-15-66-1) ≈ 0..9. Post-swap covers dy 10..20.
  // That math: pre-swap means we've finished raster 90, so sprite line 24
  // is the next to render — actually sprite is 21 lines so it ended at
  // raster 80+20=100. Pre-swap covers rasters 81..90 = lines 1..10. Hmm.
  // To keep this simple, just check first and last lines.

  // Pre-swap (line 0, canvas dy=0): sp1 paints col 0 (bit 7) white, sp3 paints col 2 (bit 5) red.
  let line0px0 = vic.fb32[(yT + 0) * CANVAS_W + (xL + 0)];
  let line0px2 = vic.fb32[(yT + 0) * CANVAS_W + (xL + 2)];
  assert(line0px0 === WHITE,
    `pre-swap line 0: sp1 col 0 is white (got ${line0px0.toString(16)})`);
  assert(line0px2 === RED,
    `pre-swap line 0: sp3 col 2 is red (got ${line0px2.toString(16)})`);

  // Post-swap (line 20, canvas dy=20): sp1 paints col 1 white, sp3 paints col 3 red.
  let line20px1 = vic.fb32[(yT + 20) * CANVAS_W + (xL + 1)];
  let line20px3 = vic.fb32[(yT + 20) * CANVAS_W + (xL + 3)];
  assert(line20px1 === WHITE,
    `post-swap line 20: sp1 col 1 is white (got ${line20px1.toString(16)})`);
  assert(line20px3 === RED,
    `post-swap line 20: sp3 col 3 is red (got ${line20px3.toString(16)})`);

  // No cross-contamination: post-swap col 0 (old sp1 location) is NOT white.
  let line20px0 = vic.fb32[(yT + 20) * CANVAS_W + (xL + 0)];
  assert(line20px0 !== WHITE,
    `post-swap line 20: col 0 is no longer white (sp1 ptr changed away from $80 shape)`);

  console.log('ok  - OVERLAY-3: per-line ptr rewrites for two overlaid sprites do not cross-contaminate');
}

// OVERLAY-4: spriteOwnerBuffer reset between rasters. A pixel position that
// sp1 owned on raster N must NOT block sp3 from drawing at the same pixel
// position on raster N+1.
{
  const vic = makeRenderableVic();
  vic.regs[0x15] = 0x0A;
  vic.regs[0x02] = 0x80; vic.regs[0x03] = 0x50;       // sp1 21-line tall
  vic.regs[0x06] = 0x80; vic.regs[0x07] = 0x70;       // sp3 starts later, NO overlap with sp1 in Y
  vic.regs[0x28] = 0x01;
  vic.regs[0x2A] = 0x02;

  // sp1 shape: solid block (so it claims pixel ownership at all dx, dy 0..20).
  for (let i = 0; i < 63; i++) vic.ram[0x0380 + i] = 0xFF;
  // sp3 shape: solid block.
  for (let i = 0; i < 63; i++) vic.ram[0x03C0 + i] = 0xFF;
  vic.ram[0x07F9] = 0x0E;
  vic.ram[0x07FB] = 0x0F;
  vic.clock(CYCLES_PER_FRAME);

  const WHITE = paletteRgba(0x01);
  const RED = paletteRgba(0x02);
  const xL = 0x80 + 8;
  const sp1Y = 0x50 - 14;
  const sp3Y = 0x70 - 14;

  // sp1's last visible row sits at canvas dy=20 of its band. The pixel at
  // (xL, sp1Y+20) should be WHITE. Then sp3 starts later at sp3Y; its row 0
  // pixel at (xL, sp3Y) should be RED — owner buffer must reset between
  // rasters or sp3 would be masked.
  assert(vic.fb32[(sp1Y + 20) * CANVAS_W + xL] === WHITE,
    'sp1 paints its last row');
  assert(vic.fb32[(sp3Y + 0) * CANVAS_W + xL] === RED,
    'sp3 paints its first row at the same canvas X — owner buffer reset works across rasters');

  console.log('ok  - OVERLAY-4: spriteOwnerBuffer resets per raster — does not leak ownership');
}


console.log('\nAll Sprite overlay rendering (multi-sprite layout) tests passed.');
