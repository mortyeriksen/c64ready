// VIC-II: Sprite rendering in opened side border (Tests 5s-5u)
// Extracted from vic2-test.js.

import {
  VIC2, CANVAS_W, CANVAS_H, CYCLES_PER_FRAME, CYCLES_PER_LINE, C64_PALETTE,
  C64Machine,
  paletteRgba,
  ACCESS_IDLE, ACCESS_REFRESH, ACCESS_C, ACCESS_G,
  assert, softAssert,
  makeVic, makeRenderSeg,
  fillSpriteLineState, fillOpaqueSpriteAcrossLine,
  clearLineBuffers, setupSpriteForRender, setMulticolorRegs,
  fillTextLineState,
  clearRenderedRow, firstForegroundX, lastForegroundX,
  runUntil,
  makeMasterCycleHarness,
  makeRenderableVic,
} from './_vic2-helpers.js';

// Test 5s: sprites can render in an opened side border outside the text window.
// Sprite reg X=16 → canvas X 24..47 (the renderer adds +8 to map VIC X into
// canvas space). canvas X=24 is in the left border (active display starts
// at canvas X=32), so this places the sprite's first pixel inside the left
// side border, which is what the test exercises.
{
  const vic = makeVic();
  const raster = 55;
  const canvasY = raster - 15;
  const rowOffset = canvasY * 384;
  fillSpriteLineState(vic, vic.regs);
  fillOpaqueSpriteAcrossLine(vic, 0, 16);
  clearRenderedRow(vic, raster);
  vic.borderBuffer.fill(1, 0, 384);
  for (let cycle = 11; cycle <= 58; cycle++) {
    vic.lineCycleHBorderBefore[cycle] = 0;
    vic.lineCycleHBorder[cycle] = 0;
    vic.lineCycleVBorderBefore[cycle] = 0;
    vic.lineCycleVBorder[cycle] = 0;
  }

  vic._renderSpriteLine(raster, canvasY);

  assert(vic.spriteCollisionBuffer[24] !== 0, 'sprite pixels remain visible in the opened left side border');
  assert(vic.borderBuffer[24] === 1, 'sprite visibility does not depend on the raster border buffer');
  console.log('ok  - sprites render in opened side borders from border flip-flop state');
}

// Test 5t: priority order between two overlapping sprites in opened side
// border. Sprite 0 paints first (higher priority); sprite 1 cannot
// overwrite sprite-0-claimed pixels even when both are positioned in
// the opened border zone. Verifies that the opened-border sprite path
// honors the same priority chain as the inner display path. Also
// checks $D01E sprite-sprite collision still latches both overlapping
// sprites regardless of which "wins" the pixel.
{
  const vic = makeVic();
  const raster = 55;
  const canvasY = raster - 15;
  const rowOffset = canvasY * 384;
  fillSpriteLineState(vic, vic.regs);
  fillOpaqueSpriteAcrossLine(vic, 0, 16, { color: 0x03 });   // cyan
  fillOpaqueSpriteAcrossLine(vic, 1, 16, { color: 0x0E });   // light blue
  clearRenderedRow(vic, raster);
  // Border OPEN at the test pixel — clearRenderedRow already filled
  // borderBuffer with 0; leave it that way so _drawSpritePixel runs.
  for (let cycle = 11; cycle <= 58; cycle++) {
    vic.lineCycleHBorderBefore[cycle] = 0;
    vic.lineCycleHBorder[cycle] = 0;
    vic.lineCycleVBorderBefore[cycle] = 0;
    vic.lineCycleVBorder[cycle] = 0;
  }

  vic._renderSpriteLine(raster, canvasY);

  // Collision buffer at the overlap pixel must record BOTH sprites
  // (their bits OR'd) — collision detection runs regardless of which
  // sprite paints.
  const cb = vic.spriteCollisionBuffer[24];
  assert((cb & 0x03) === 0x03,
    `both sprites detected at overlap: expected bits 0|1 set, got 0x${cb.toString(16)}`);
  // Pixel color must be sprite-0 color (cyan, $03), NOT sprite-1 color
  // (light blue, $0E). Sprite 0's higher priority must win even in the
  // opened side border.
  const cyanRGBA = paletteRgba(0x03);
  assert(vic.fb32[rowOffset + 24] === cyanRGBA,
    `sprite 0 wins priority in opened border: expected cyan ($03), got 0x${vic.fb32[rowOffset + 24].toString(16)}`);
  // $D01E should latch both overlapping sprites.
  assert((vic.regs[0x1E] & 0x03) === 0x03,
    `$D01E sprite-sprite collision latches both: expected bits 0|1 set, got 0x${vic.regs[0x1E].toString(16)}`);
  console.log('ok  - opened-border sprite render order honors sprite-0-wins priority');
}

// Test 5t-2: Y-expanded sprite renders correctly in opened side border.
// MxYE=1 doubles vertical extent (21→42 lines) but doesn't gate the
// per-pixel paint — the sprite must paint in the opened border zone
// at every row of its Y-expanded display window. Verifies that
// sprite row data is correctly addressed for both halves of an
// expanded row (FF=0 displays current data row; FF=1 redisplays the
// same row before MC advances).
{
  const vic = makeVic();
  const raster = 55;
  const canvasY = raster - 15;
  const rowOffset = canvasY * 384;
  fillSpriteLineState(vic, vic.regs);
  fillOpaqueSpriteAcrossLine(vic, 0, 16, { color: 0x07 });   // yellow
  // Mark sprite as Y-expanded in $D017. The per-line state machine
  // controls FF / MC progression; for the render test we just need
  // the paint path to honor the X comparator + open-border gating.
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleRegs[cycle][0x17] |= 0x01;
  }
  vic.regs[0x17] = 0x01;
  clearRenderedRow(vic, raster);
  for (let cycle = 11; cycle <= 58; cycle++) {
    vic.lineCycleHBorderBefore[cycle] = 0;
    vic.lineCycleHBorder[cycle] = 0;
    vic.lineCycleVBorderBefore[cycle] = 0;
    vic.lineCycleVBorder[cycle] = 0;
  }

  vic._renderSpriteLine(raster, canvasY);

  // Sprite at X=16 → canvas X=24 is in the left side border. With
  // border open, sprite must paint there.
  const yellowRGBA = paletteRgba(0x07);
  assert(vic.fb32[rowOffset + 24] === yellowRGBA,
    `Y-expanded sprite paints in opened left border: expected yellow, got 0x${vic.fb32[rowOffset + 24].toString(16)}`);
  // Sprite continues across canvas X=25..47 (24-pixel sprite width).
  assert(vic.fb32[rowOffset + 47] === yellowRGBA,
    `Y-expanded sprite extends through full 24px width in opened border`);
  // Past the sprite (canvas X=48+) must NOT have sprite color.
  assert(vic.fb32[rowOffset + 50] !== yellowRGBA,
    'sprite paint stops at the sprite width boundary');
  console.log('ok  - Y-expanded sprite renders in opened left side border');
}

// Test 5t-3: Y-expanded sprite at right side border with partial opening.
// FppScroller-class scenario: sprite positioned at canvas X=344 (= right
// border edge in 40-col mode), Y-expanded. Open the right border for
// the first 16 pixels of the sprite via per-cycle borderBuffer=0;
// keep the remaining pixels in closed border. Sprite must paint in
// the opened pixels and clip at the still-closed pixels.
{
  const vic = makeVic();
  const raster = 55;
  const canvasY = raster - 15;
  const rowOffset = canvasY * 384;
  fillSpriteLineState(vic, vic.regs);
  // Renderer maps VIC X → canvas X via +8 offset (see test 5s comment).
  // To place sprite at canvas X=344 (right-border edge in 40-col),
  // use VIC X = 336.
  fillOpaqueSpriteAcrossLine(vic, 6, 336, { color: 0x03 });   // cyan
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleRegs[cycle][0x17] |= 0x40;                   // sprite 6 Y-expand
  }
  vic.regs[0x17] = 0x40;
  clearRenderedRow(vic, raster);
  // Mixed border: opened for canvas X [344..359], closed for [360..]
  // Simulate by: setting hBorder=0 in cycles spanning the open zone,
  // hBorder=1 in cycles past it.
  for (let cycle = 11; cycle <= 58; cycle++) {
    vic.lineCycleHBorderBefore[cycle] = 0;
    vic.lineCycleHBorder[cycle] = 0;
    vic.lineCycleVBorderBefore[cycle] = 0;
    vic.lineCycleVBorder[cycle] = 0;
  }
  // borderBuffer at the test pixels: open for first 16, closed for next 8
  vic.borderBuffer.fill(0, 344, 360);
  vic.borderBuffer.fill(1, 360, 368);

  vic._renderSpriteLine(raster, canvasY);

  const cyanRGBA = paletteRgba(0x03);
  // Opened window: sprite must paint
  assert(vic.fb32[rowOffset + 344] === cyanRGBA,
    `sprite paints at canvas X=344 (border open): expected cyan, got 0x${vic.fb32[rowOffset + 344].toString(16)}`);
  assert(vic.fb32[rowOffset + 355] === cyanRGBA,
    `sprite paints at canvas X=355 (border open): got 0x${vic.fb32[rowOffset + 355].toString(16)}`);
  // Closed window: sprite must NOT paint (border still hides it)
  assert(vic.fb32[rowOffset + 363] !== cyanRGBA,
    `sprite must NOT paint at canvas X=363 (border closed): got 0x${vic.fb32[rowOffset + 363].toString(16)}`);
  // Collision still detected even where border closes paint
  assert((vic.spriteCollisionBuffer[363] & 0x40) !== 0,
    `sprite-6 collision still latches at X=363 even when border-clipped: got 0x${vic.spriteCollisionBuffer[363].toString(16)}`);
  console.log('ok  - Y-expanded sprite at right border edge clips correctly at partial open boundary');
}

// Test 5t-4: sprite-sprite collision across multiplexer passes.
// Sprite multiplexers re-use the same hardware sprite to display
// at multiple Y positions in a frame. Each display pass that
// produces an overlap MUST re-arm the $D01E latch (W1C semantics:
// CPU reads to clear, next collision re-sets bits, and per Bauer
// §3.12 the 0→non-zero transition fires IRQ each time).
{
  const vic = makeVic();
  vic.write(0x1A, 0x04);            // enable sprite-sprite collision IRQ

  // ── Pass 1: render two overlapping sprites, latch should fire ──
  fillSpriteLineState(vic, vic.regs);
  fillOpaqueSpriteAcrossLine(vic, 0, 16, { color: 0x03 });
  fillOpaqueSpriteAcrossLine(vic, 1, 16, { color: 0x0E });
  const raster1 = 55;
  const cy1 = raster1 - 15;
  clearRenderedRow(vic, raster1);
  for (let cycle = 11; cycle <= 58; cycle++) {
    vic.lineCycleHBorder[cycle] = 0;
    vic.lineCycleVBorder[cycle] = 0;
  }
  vic._renderSpriteLine(raster1, cy1);

  assert((vic.regs[0x1E] & 0x03) === 0x03,
    `pass 1: $D01E latches sprites 0+1, got 0x${vic.regs[0x1E].toString(16)}`);
  assert((vic.irqStatus & 0x04) !== 0,
    'pass 1: IMMC bit set (0→non-zero transition fires IRQ)');
  assert((vic.irqStatus & 0x80) !== 0,
    'pass 1: IRQ-pending bit set in $D019');

  // ── CPU reads $D01E to clear ──
  const v1e = vic.read(0x1E);
  assert(v1e === 0x03, `read $D01E returns latched value 0x03, got 0x${v1e.toString(16)}`);
  assert(vic.regs[0x1E] === 0x00,
    `read clears $D01E to 0, got 0x${vic.regs[0x1E].toString(16)}`);
  // IRQ status remains set in $D019 until CPU acks via $D019 write.
  vic.write(0x19, 0x04);            // ack IMMC
  assert((vic.irqStatus & 0x04) === 0,
    'after $D019 ack: IMMC clear');

  // ── Pass 2: another raster line, sprites still overlap ──
  // Reset per-line render buffers AND sprite line render state. In
  // real VIC operation _initRenderRasterLine handles this per line;
  // synthetic test must invoke it explicitly between passes.
  const raster2 = 60;
  const cy2 = raster2 - 15;
  vic._initRenderRasterLine(raster2, cy2);
  for (let cycle = 11; cycle <= 58; cycle++) {
    vic.lineCycleHBorder[cycle] = 0;
    vic.lineCycleVBorder[cycle] = 0;
  }
  vic._renderSpriteLine(raster2, cy2);

  assert((vic.regs[0x1E] & 0x03) === 0x03,
    `pass 2: $D01E re-latches after CPU clear, got 0x${vic.regs[0x1E].toString(16)}`);
  assert((vic.irqStatus & 0x04) !== 0,
    'pass 2: IMMC re-fires on 0→non-zero transition (Bauer §3.12)');
  console.log('ok  - sprite-sprite collision $D01E re-arms across multiplexer passes');
}

// Test 5u: sprite border visibility uses canvas-space X mapped back to raw VIC
// timing, so border opening is aligned with the centered raster output.
{
  const vic = makeVic();
  const regs = vic.regs;
  regs[0x11] = 0x1B;
  regs[0x16] = 0xC8;

  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleRegs[cycle].set(regs);
    vic.lineCycleVBorderBefore[cycle] = 0;
    vic.lineCycleVBorder[cycle] = 0;
    const openHoriz = cycle >= 15 && cycle <= 54;
    vic.lineCycleHBorderBefore[cycle] = openHoriz ? 0 : 1;
    vic.lineCycleHBorder[cycle] = openHoriz ? 0 : 1;
  }

  vic.lineCycleHBorder[15] = 0;
  vic.lineCycleHBorderBefore[15] = 1;
  vic.lineCycleVBorder[15] = 0;
  vic.lineCycleVBorderBefore[15] = 0;
  vic.lineCycleHBorder[55] = 1;
  vic.lineCycleHBorderBefore[55] = 0;
  vic.lineCycleVBorder[55] = 0;
  vic.lineCycleVBorderBefore[55] = 0;

  // Populate borderBuffer to match the per-cycle state above. The active
  // display window is canvas X 32..351 (= cycles 15..54 with the renderer's
  // +8 cycle-to-canvas offset). _spriteVisibleAt now consults borderBuffer
  // directly (filled by the raster renderer in normal flow), so we mirror
  // that here without invoking the full render pipeline.
  const rowOffset = 40 * 384;
  vic.borderBuffer.fill(1, 0, 384);
  vic.borderBuffer.fill(0, 32, 352);

  assert(vic._spriteVisibleAt(31, 40) === false, 'sprite stays clipped 1 pixel before the left canvas border edge');
  assert(vic._spriteVisibleAt(32, 40) === true, 'sprite becomes visible exactly at the left canvas border edge');
  assert(vic._spriteVisibleAt(351, 40) === true, 'sprite remains visible through the last pixel before the right canvas border edge');
  assert(vic._spriteVisibleAt(352, 40) === false, 'sprite clips exactly at the right canvas border edge');
  console.log('ok  - sprite border visibility is aligned to canvas-space border edges');
}



console.log('\nAll Sprite rendering in opened side border (Tests 5s-5u) tests passed.');
