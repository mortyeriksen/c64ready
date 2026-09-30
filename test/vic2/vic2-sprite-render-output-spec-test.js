// VIC-II: Sprite render-output (full-frame drives)
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
// Sprite render-output tests — drive vic.clock() through a full frame and
// inspect fb32 to verify the actual pixels the renderer wrote, at the canvas
// coordinates the sprite is supposed to occupy. These complement the
// state-only MUX/PTR/YE tests above by closing the loop on visible output.
//
// Coordinate convention used by the renderer:
//   canvas X = sprite_X_register + 8        (left border offset)
//   canvas Y_first_visible = sprite_Y - 14
//     Sprite Y is the DMA-start raster. s-accesses happen at cycle 59+ of
//     that raster, so the first DISPLAYED line is raster Y+1 → canvas Y =
//     (Y+1) - 15 = Y - 14. (`canvas Y = raster - 15`: raster $33/51 → 36.)
// ============================================================================


// SPR-RENDER-1: a single sprite renders a solid 24×21 block at the canvas
// position determined by its X/Y registers. Verifies the basic sprite path
// (pointer fetch → s-access → shifter → fb32 write) by reading framebuffer
// pixels at the expected location.
{
  const vic = makeRenderableVic();
  vic.regs[0x15] = 0x01;   // sp0 enabled
  vic.regs[0x00] = 0xC0;   // sp0 X = 192
  vic.regs[0x01] = 0x80;   // sp0 Y = 128
  vic.regs[0x27] = 0x01;   // sp0 color = white

  // Plant a solid 24×21 block at sprite-data ptr $0D → bank 0 offset $0340.
  for (let i = 0; i < 63; i++) vic.ram[0x0340 + i] = 0xFF;
  vic.ram[0x07F8] = 0x0D;  // sp0 pointer in screen RAM ($0400 + $3F8)

  vic.clock(CYCLES_PER_FRAME);

  const WHITE = paletteRgba(0x01);
  const xL = 0xC0 + 8;     // canvas X start
  const yT = 0x80 - 14;    // canvas Y start (sprite displays one line after Y-match)

  // Top-left corner pixel of the rendered sprite must be white.
  assert(vic.fb32[yT * CANVAS_W + xL] === WHITE,
    `sprite top-left at canvas (${xL}, ${yT}) is white`);
  // Sample 24 pixels wide × 21 lines tall — every pixel should be white.
  for (let dy = 0; dy < 21; dy++) {
    for (let dx = 0; dx < 24; dx++) {
      const idx = (yT + dy) * CANVAS_W + (xL + dx);
      assert(vic.fb32[idx] === WHITE,
        `sprite pixel at (${xL+dx}, ${yT+dy}) is white (dy=${dy} dx=${dx})`);
    }
  }
  // One pixel beyond the right edge must NOT be sprite color.
  assert(vic.fb32[yT * CANVAS_W + (xL + 24)] !== WHITE,
    `pixel just past sprite right edge is not white (sprite is exactly 24 wide)`);

  console.log('ok  - SPR-RENDER-1: simple sprite paints 24×21 solid block at canvas (X+8, Y-15)');
}

// SPR-RENDER-2: sprite shape pattern (not solid) — verify per-pixel that the
// rendered output matches the bits in the shape data.
{
  const vic = makeRenderableVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x00] = 0x40;   // X = 64
  vic.regs[0x01] = 0x90;   // Y = 144
  vic.regs[0x27] = 0x07;   // sp0 color = yellow

  // Plant a striped pattern: row N has bytes [N&0xFF, ~N&0xFF, N&0xFF].
  for (let row = 0; row < 21; row++) {
    vic.ram[0x0340 + row * 3 + 0] = row * 11;
    vic.ram[0x0340 + row * 3 + 1] = ~(row * 11) & 0xFF;
    vic.ram[0x0340 + row * 3 + 2] = (row * 7) & 0xFF;
  }
  vic.ram[0x07F8] = 0x0D;
  vic.clock(CYCLES_PER_FRAME);

  const YELLOW = paletteRgba(0x07);
  const BG = paletteRgba(0x06);
  const xL = 0x40 + 8;
  const yT = 0x90 - 14;
  let mismatches = 0;
  for (let dy = 0; dy < 21; dy++) {
    for (let dx = 0; dx < 24; dx++) {
      const byteIdx = (dx >> 3);
      const bitInByte = 7 - (dx & 7);
      const shapeByte = vic.ram[0x0340 + dy * 3 + byteIdx];
      const shapeBit = (shapeByte >> bitInByte) & 1;
      const px = vic.fb32[(yT + dy) * CANVAS_W + (xL + dx)];
      const expected = shapeBit ? YELLOW : BG;
      if (px !== expected) mismatches++;
    }
  }
  assert(mismatches === 0,
    `every shape bit drives the matching framebuffer pixel (mismatches=${mismatches})`);

  console.log('ok  - SPR-RENDER-2: sprite shape bits match fb32 pixels exactly');
}

// MUX-RENDER-1: sprite multiplexed at TWO Y positions in the same frame
// using DIFFERENT shape pointers. Verify that BOTH instances render at
// their respective canvas positions with the shape from THEIR pointer.
{
  const vic = makeRenderableVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x00] = 0xA0;   // sp0 X = 160 (constant)
  vic.regs[0x01] = 0x40;   // sp0 Y = 64 → first instance, rasters 64..84
  vic.regs[0x27] = 0x01;   // white

  // Two distinct shapes: solid block at ptr $0D, top-half stripe at ptr $0E.
  for (let i = 0; i < 63; i++) vic.ram[0x0340 + i] = 0xFF;        // ptr $0D
  for (let i = 0; i < 21; i++) {                                  // ptr $0E
    vic.ram[0x0380 + i*3 + 0] = (i < 10) ? 0xFF : 0x00;
    vic.ram[0x0380 + i*3 + 1] = (i < 10) ? 0xFF : 0x00;
    vic.ram[0x0380 + i*3 + 2] = (i < 10) ? 0xFF : 0x00;
  }
  vic.ram[0x07F8] = 0x0D;  // initial ptr → solid block

  // Drive the VIC raster-by-raster so we can rewrite Y/ptr mid-frame.
  // Run from cycle 0 to end of raster 90 (well past the first sprite which
  // ends at raster 85).
  vic.clock(CYCLES_PER_LINE * 91);

  // Now flip the pointer to $0E and program a NEW Y position. Cycle 16 will
  // have already terminated the first DMA when MCBASE reached 63.
  vic.ram[0x07F8] = 0x0E;
  vic.regs[0x01] = 0xA0;   // sp0 Y = 160 → rasters 160..180

  // Run to end of frame.
  vic.clock(CYCLES_PER_FRAME - CYCLES_PER_LINE * 91);

  const WHITE = paletteRgba(0x01);
  const xL = 0xA0 + 8;     // 168
  const y1 = 0x40 - 14;    // first instance at canvas Y 49
  const y2 = 0xA0 - 14;    // second instance at canvas Y 145

  // First instance: solid block — every pixel of all 21 rows is white.
  for (let dy = 0; dy < 21; dy++) {
    for (let dx = 0; dx < 24; dx++) {
      assert(vic.fb32[(y1 + dy) * CANVAS_W + (xL + dx)] === WHITE,
        `first instance pixel (${xL+dx}, ${y1+dy}) is white`);
    }
  }

  // Second instance: top-10 rows white, bottom 11 rows not white.
  for (let dy = 0; dy < 10; dy++) {
    assert(vic.fb32[(y2 + dy) * CANVAS_W + (xL + 0)] === WHITE,
      `second instance row ${dy} is white (top half)`);
  }
  for (let dy = 10; dy < 21; dy++) {
    assert(vic.fb32[(y2 + dy) * CANVAS_W + (xL + 0)] !== WHITE,
      `second instance row ${dy} is NOT white (bottom half is blank, fed bg)`);
  }

  console.log('ok  - MUX-RENDER-1: same sprite multiplexed at two Y positions renders both shapes correctly');
}

// PTR-RENDER-1: per-line pointer rewrite WHILE a sprite is mid-display.
// The shape data fetched on line N+1 must come from the new pointer's
// address, NOT a cache of the old base. This is the demo's wizard
// composition pattern.
{
  const vic = makeRenderableVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x00] = 0x80;
  vic.regs[0x01] = 0x60;   // Y = 96, sprite spans rasters 96..116
  vic.regs[0x27] = 0x02;   // red

  // Plant TWO shapes: ptr $0D = "first-half-only", ptr $0E = "second-half-only".
  // After 5 lines, the demo will swap the pointer. Lines 0..4 should render
  // ptr $0D's bytes for rows 0..4. Lines 5..20 should render ptr $0E's bytes
  // for rows 5..20 (MC keeps advancing).
  for (let i = 0; i < 63; i++) vic.ram[0x0340 + i] = 0x80;  // ptr $0D — leftmost bit
  for (let i = 0; i < 63; i++) vic.ram[0x0380 + i] = 0x01;  // ptr $0E — rightmost bit
  vic.ram[0x07F8] = 0x0D;

  // Run until end of raster 100 (5 lines into the sprite).
  vic.clock(CYCLES_PER_LINE * 101);

  // Swap the pointer. At cycle 58 of the next line, the new ptr is fetched.
  vic.ram[0x07F8] = 0x0E;

  // Run to end of frame.
  vic.clock(CYCLES_PER_FRAME - CYCLES_PER_LINE * 101);

  const RED = paletteRgba(0x02);
  const xL = 0x80 + 8;     // canvas X = 136
  const yT = 0x60 - 14;    // canvas Y = 81

  // Lines 0..4 (rasters 96..100) drew before ptr swap → leftmost-bit shape.
  // Pixel at canvas X = 136 (bit 7 of byte 0) should be RED.
  for (let dy = 0; dy < 5; dy++) {
    assert(vic.fb32[(yT + dy) * CANVAS_W + (xL + 0)] === RED,
      `pre-swap line ${dy}: leftmost pixel is RED (ptr $0D = $80)`);
  }
  // Lines 5..20 drew after ptr swap → rightmost-bit shape. Pixel at canvas
  // X = 136 + 23 (bit 0 of byte 2) should be RED.
  for (let dy = 5; dy < 21; dy++) {
    assert(vic.fb32[(yT + dy) * CANVAS_W + (xL + 23)] === RED,
      `post-swap line ${dy}: rightmost pixel is RED (ptr $0E = $01)`);
    // And the leftmost should NOT be RED.
    assert(vic.fb32[(yT + dy) * CANVAS_W + (xL + 0)] !== RED,
      `post-swap line ${dy}: leftmost pixel is not RED (different shape)`);
  }

  console.log('ok  - PTR-RENDER-1: mid-display ptr rewrite changes the shape rendered on subsequent lines');
}

// YE-RENDER-1: Y-expanded sprite renders each shape row TWICE on consecutive
// rasters. With YE=1 and shape row 0 = $FF, rasters Y..Y+1 should both be
// solid; row 1 = $00 produces blanks at rasters Y+2..Y+3; etc.
{
  const vic = makeRenderableVic();
  vic.regs[0x15] = 0x01;
  vic.regs[0x17] = 0x01;   // sp0 Y-expand ON
  vic.regs[0x00] = 0x60;
  vic.regs[0x01] = 0x70;   // Y = 112, expanded → 42 lines tall
  vic.regs[0x27] = 0x05;   // green

  // Alternating pattern: row N is $FF if N even, else $00.
  for (let row = 0; row < 21; row++) {
    const v = (row & 1) ? 0x00 : 0xFF;
    vic.ram[0x0340 + row*3]     = v;
    vic.ram[0x0340 + row*3 + 1] = v;
    vic.ram[0x0340 + row*3 + 2] = v;
  }
  vic.ram[0x07F8] = 0x0D;
  vic.clock(CYCLES_PER_FRAME);

  const GREEN = paletteRgba(0x05);
  const xL = 0x60 + 8;
  const yT = 0x70 - 14;

  // Y-expand row-doubling: each shape row N takes 2 rasters (canvas dy = 2N
  // and 2N+1). Row 0 = $FF → 2 lines green; row 1 = $00 → 2 lines bg; ...
  for (let row = 0; row < 21; row++) {
    const expectedSolid = !(row & 1);
    for (let line = 0; line < 2; line++) {
      const dy = row * 2 + line;
      const px = vic.fb32[(yT + dy) * CANVAS_W + xL];
      if (expectedSolid) {
        assert(px === GREEN, `YE row ${row} line ${line} (canvas dy=${dy}): green`);
      } else {
        assert(px !== GREEN, `YE row ${row} line ${line} (canvas dy=${dy}): not green`);
      }
    }
  }

  console.log('ok  - YE-RENDER-1: Y-expanded sprite renders each shape row across 2 consecutive rasters');
}


console.log('\nAll Sprite render-output (full-frame drives) tests passed.');
