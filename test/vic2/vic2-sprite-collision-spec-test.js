// VIC-II sprite collision spec tests.
//
// Reference: Christian Bauer's VIC Article + C64 Programmer's Reference
// Guide. Covers $D01E (sprite-sprite), $D01F (sprite-background), the
// IMMC / IMBC IRQ latching, multicolor rules (only the foreground pair
// 11 and the screen-color pair 10 collide; pair 01 / 00 are background),
// and visibility-independent collision detection.
//
// Subsections:
//   • Unit tests on _processSpritePixelCollision
//   • Render-pipeline integration tests via _renderSpriteLine
//   • Sprite pointer switching
//
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
} from './_vic2-helpers.js';

// ============================================================================
// Sprite collision tests (merged from vic2-sprite-collision-test.js)
//
// Pinned to the spec semantics described in Christian Bauer's VIC Article
// and the C64 Programmer's Reference Guide. Covers $D01E (sprite-sprite),
// $D01F (sprite-bg), IMMC/IMBC IRQ latching, multicolor rules, and
// visibility-independent collision detection.
// ============================================================================

// ── Unit tests on _processSpritePixelCollision ──────────────────────────────

// Sprite-background: each sprite index sets its own bit in $D01F.
{
  for (let s = 0; s < 8; s++) {
    const vic = makeVic();
    vic.graphicsCollisionBuffer[200] = 1;
    vic._processSpritePixelCollision(200, 0, s);
    assert(vic.regs[0x1F] === (1 << s),
      `$D01F bit ${s} latches when sprite ${s} hits foreground`);
  }
  console.log('ok  - $D01F latches the correct bit per sprite index');
}

// Sprite-background: a non-foreground pixel (collision buffer == 0) does not latch.
{
  const vic = makeVic();
  // graphicsCollisionBuffer left as 0 (background).
  vic._processSpritePixelCollision(50, 0, 3);
  assert(vic.regs[0x1F] === 0x00, 'transparent background does not latch $D01F');
  assert((vic.irqStatus & 0x02) === 0x00, 'no IMBC flag without a background hit');
  console.log('ok  - sprite-background collision ignores background-only pixels');
}

// Sprite-background: reading $D01F returns latched value and clears the register.
{
  const vic = makeVic();
  vic.graphicsCollisionBuffer[10] = 1;
  vic.graphicsCollisionBuffer[11] = 1;
  vic._processSpritePixelCollision(10, 0, 1);
  vic._processSpritePixelCollision(11, 0, 4);
  assert(vic.regs[0x1F] === 0x12, 'multiple sprite hits accumulate in $D01F');

  const v = vic.read(0x1F);
  assert(v === 0x12, 'reading $D01F returns the latched value');
  assert(vic.regs[0x1F] === 0x00, 'reading $D01F clears the register');
  console.log('ok  - reading $D01F returns and clears latched bits');
}

// Sprite-background IRQ: IMBC flag is latched even when the IRQ mask is 0.
{
  const vic = makeVic();
  let irqCalls = 0;
  vic.irqMask = 0x00; // IMBC mask off
  vic.irqHandler = (state) => { if (state) irqCalls++; };
  vic.graphicsCollisionBuffer[20] = 1;
  vic._processSpritePixelCollision(20, 0, 0);

  assert((vic.irqStatus & 0x02) === 0x02, 'IMBC latched independent of mask');
  assert((vic.irqStatus & 0x80) === 0x00, 'IRQ line not asserted when mask is clear');
  assert(irqCalls === 0, 'irqHandler not called when mask is clear');
  console.log('ok  - IMBC latches independent of $D01A mask');
}

// Sprite-background IRQ: an already-latched sprite bit must not re-fire IMBC
// at subsequent pixels. After the latch is cleared (via $D01F read), a new
// collision on that same sprite must re-fire IMBC. This pins the
// per-sprite-bit edge that both spec readings agree on.
{
  const vic = makeVic();
  let irqCalls = 0;
  vic.irqMask = 0x02;
  vic.irqHandler = (state) => { if (state) irqCalls++; };
  vic.graphicsCollisionBuffer[30] = 1;
  vic.graphicsCollisionBuffer[31] = 1;

  vic._processSpritePixelCollision(30, 0, 0);
  vic._processSpritePixelCollision(31, 0, 0); // same sprite, different pixel
  assert(irqCalls === 1, 'IMBC IRQ does not refire on an already-latched bit');

  vic.read(0x1F); // clears $D01F
  vic._processSpritePixelCollision(30, 0, 0);
  assert(irqCalls === 2, 'IMBC IRQ fires again after $D01F is cleared');
  console.log('ok  - IMBC IRQ requires $D01F clear to refire on the same bit');
}

// Sprite-sprite: two sprites colliding set both bits in $D01E.
{
  const vic = makeVic();
  vic._processSpritePixelCollision(100, 0, 2);
  vic._processSpritePixelCollision(100, 0, 5);
  assert(vic.regs[0x1E] === ((1 << 2) | (1 << 5)),
    'two-sprite collision sets both bits in $D01E');
  console.log('ok  - sprite-sprite collision sets bits for both sprites');
}

// Sprite-sprite: three overlapping sprites set all three bits.
{
  const vic = makeVic();
  vic._processSpritePixelCollision(150, 0, 0);
  vic._processSpritePixelCollision(150, 0, 3);
  vic._processSpritePixelCollision(150, 0, 7);
  assert(vic.regs[0x1E] === ((1 << 0) | (1 << 3) | (1 << 7)),
    '3-sprite collision sets all three bits in $D01E');
  console.log('ok  - 3-way sprite-sprite collision latches all participants');
}

// Sprite-sprite: a single sprite at a pixel never sets $D01E.
{
  const vic = makeVic();
  vic._processSpritePixelCollision(60, 0, 4);
  assert(vic.regs[0x1E] === 0x00, 'single sprite alone never latches $D01E');
  // Sanity: a lone hit must also leave IMMC clear.
  assert((vic.irqStatus & 0x04) === 0x00, 'lone sprite hit does not set IMMC');
  console.log('ok  - lone sprite at a pixel does not latch sprite-sprite');
}

// Sprite-sprite: reading $D01E returns and clears.
{
  const vic = makeVic();
  vic._processSpritePixelCollision(70, 0, 1);
  vic._processSpritePixelCollision(70, 0, 6);
  const v = vic.read(0x1E);
  assert(v === ((1 << 1) | (1 << 6)), 'reading $D01E returns the latched value');
  assert(vic.regs[0x1E] === 0x00, 'reading $D01E clears the register');
  console.log('ok  - reading $D01E returns and clears latched bits');
}

// Sprite-sprite IRQ: a sprite pair already latched in $D01E must not re-fire
// IMMC when the same pair collides at later pixels. After $D01E is cleared,
// the pair colliding again re-fires IMMC.
{
  const vic = makeVic();
  let irqCalls = 0;
  vic.irqMask = 0x04;
  vic.irqHandler = (state) => { if (state) irqCalls++; };

  vic._processSpritePixelCollision(80, 0, 2);
  vic._processSpritePixelCollision(80, 0, 3);
  assert((vic.irqStatus & 0x04) === 0x04, 'IMMC latched on first sprite-sprite hit');
  assert(irqCalls === 1, 'IMMC IRQ fires on the first latching');

  // Second collision pixel for the same pair: bits already set in $D01E.
  vic._processSpritePixelCollision(81, 0, 2);
  vic._processSpritePixelCollision(81, 0, 3);
  assert(irqCalls === 1, 'IMMC IRQ does not refire while the same bits are latched');

  vic.read(0x1E);             // clear $D01E
  vic.irqStatus &= ~0x80;     // simulate CPU-side IRQ ack
  vic._processSpritePixelCollision(82, 0, 2);
  vic._processSpritePixelCollision(82, 0, 3);
  assert(irqCalls === 2, 'IMMC IRQ fires again after $D01E is cleared');
  console.log('ok  - IMMC IRQ requires $D01E clear to refire on the same pair');
}

// Per-sprite indexing for $D01E: every sprite index pairs cleanly with sprite 0.
{
  for (let s = 1; s < 8; s++) {
    const vic = makeVic();
    vic._processSpritePixelCollision(120, 0, 0);
    vic._processSpritePixelCollision(120, 0, s);
    assert(vic.regs[0x1E] === ((1 << 0) | (1 << s)),
      `$D01E bit ${s} latches when sprite ${s} collides with sprite 0`);
  }
  console.log('ok  - $D01E latches the correct bit per sprite index');
}

// Both registers latch independently in the same pixel.
{
  const vic = makeVic();
  vic.graphicsCollisionBuffer[200] = 1;
  vic._processSpritePixelCollision(200, 0, 0);
  vic._processSpritePixelCollision(200, 0, 4);
  assert(vic.regs[0x1F] === 0x11, '$D01F captures both sprites that hit foreground');
  assert(vic.regs[0x1E] === 0x11, '$D01E captures the sprite-sprite collision at the same pixel');
  console.log('ok  - sprite-background and sprite-sprite latches are independent');
}

// ── Render-pipeline integration tests via _renderSpriteLine ─────────────────

// Hi-res opaque sprite over a foreground pixel sets $D01F.
{
  const vic = makeVic();
  const canvasY = 40;
  const rowOffset = clearLineBuffers(vic, canvasY);
  fillSpriteLineState(vic);

  // Mark a foreground pixel that the sprite will cover.
  for (let x = 30; x < 54; x++) vic.graphicsCollisionBuffer[x] = 1;

  fillOpaqueSpriteAcrossLine(vic, 2, 30);
  vic._renderSpriteLine(55, canvasY);

  assert(vic.regs[0x1F] === (1 << 2),
    'rendered hi-res sprite over a foreground pixel sets $D01F bit 2');
  console.log('ok  - rendered opaque sprite vs foreground sets $D01F');
}

// Multicolor sprite "01" pair (multicolor 0 = $D025) is non-transparent and
// must trigger sprite-background collision.
{
  const vic = makeVic();
  const canvasY = 41;
  const rowOffset = clearLineBuffers(vic, canvasY);
  fillSpriteLineState(vic);

  for (let x = 50; x < 74; x++) vic.graphicsCollisionBuffer[x] = 1;
  // Shift register filled with 01-pairs throughout 24 bits: 0x555555
  fillOpaqueSpriteAcrossLine(vic, 1, 50, { multicolor: true, shiftReg: 0x555555 });
  vic._renderSpriteLine(56, canvasY);

  assert(vic.regs[0x1F] === (1 << 1),
    'multicolor "01" pixel still latches $D01F (non-transparent)');
  console.log('ok  - multicolor "01" pixel triggers sprite-background collision');
}

// Multicolor sprite "00" pairs are transparent and must NOT trigger collisions.
{
  const vic = makeVic();
  const canvasY = 42;
  const rowOffset = clearLineBuffers(vic, canvasY);
  fillSpriteLineState(vic);

  for (let x = 60; x < 84; x++) vic.graphicsCollisionBuffer[x] = 1;
  // All-zero shift register: every 2-bit pair is "00" -> transparent.
  fillOpaqueSpriteAcrossLine(vic, 0, 60, { multicolor: true, shiftReg: 0x000000 });
  vic._renderSpriteLine(57, canvasY);

  assert(vic.regs[0x1F] === 0x00,
    'fully transparent multicolor sprite never latches $D01F');
  assert(vic.regs[0x1E] === 0x00,
    'fully transparent multicolor sprite never latches $D01E');
  console.log('ok  - multicolor "00" pixels do not trigger collisions');
}

// Sprite hidden behind foreground (priority = 1) still latches the collision,
// even though the visible pixel is the foreground.
{
  const vic = makeVic();
  const canvasY = 43;
  const rowOffset = clearLineBuffers(vic, canvasY);
  fillSpriteLineState(vic);

  for (let x = 24; x < 48; x++) {
    vic.graphicsCollisionBuffer[x] = 1;
    vic.graphicsPriorityBuffer[x] = 1;
  }
  fillOpaqueSpriteAcrossLine(vic, 5, 24, { priority: true });
  vic._renderSpriteLine(58, canvasY);

  assert(vic.regs[0x1F] === (1 << 5),
    'priority-hidden sprite still latches $D01F');
  console.log('ok  - priority-hidden sprite still latches sprite-background collision');
}

// Two sprites that don't overlap must not set $D01E.
{
  const vic = makeVic();
  const canvasY = 44;
  clearLineBuffers(vic, canvasY);
  fillSpriteLineState(vic);

  fillOpaqueSpriteAcrossLine(vic, 0, 24);   // covers x=24..47
  fillOpaqueSpriteAcrossLine(vic, 1, 100);  // covers x=100..123 (no overlap)
  vic._renderSpriteLine(59, canvasY);

  assert(vic.regs[0x1E] === 0x00,
    'non-overlapping sprites do not latch $D01E');
  console.log('ok  - non-overlapping sprites do not trigger sprite-sprite collision');
}

// Two overlapping rendered sprites latch both bits in $D01E.
{
  const vic = makeVic();
  const canvasY = 45;
  clearLineBuffers(vic, canvasY);
  fillSpriteLineState(vic);

  fillOpaqueSpriteAcrossLine(vic, 0, 80);
  fillOpaqueSpriteAcrossLine(vic, 4, 90); // overlaps sprite 0 from x=90..103
  vic._renderSpriteLine(60, canvasY);

  assert(vic.regs[0x1E] === ((1 << 0) | (1 << 4)),
    'rendered overlapping sprites latch both bits in $D01E');
  console.log('ok  - rendered overlapping sprites set $D01E for both sprites');
}

// X-expanded sprite covers double the canvas width (48 px) for collision
// purposes. We prove the doubled reach with a spec-only assertion: place
// foreground only in the [x+24, x+48) range that a hi-res sprite cannot
// reach. If the collision latches, the sprite must have extended past x+24.
{
  const vic = makeVic();
  const canvasY = 46;
  const rowOffset = clearLineBuffers(vic, canvasY);
  fillSpriteLineState(vic);

  for (let x = 24 + 24; x < 24 + 48; x++) vic.graphicsCollisionBuffer[x] = 1;
  fillOpaqueSpriteAcrossLine(vic, 3, 24, { xExpand: true });
  vic._renderSpriteLine(61, canvasY);

  assert(vic.regs[0x1F] === (1 << 3),
    'x-expanded sprite collides with foreground beyond x+24');
  console.log('ok  - x-expanded sprite collides over double the canvas width');
}

// All eight sprites piling up on the same pixel set $D01E to $FF.
{
  const vic = makeVic();
  for (let s = 0; s < 8; s++) {
    vic._processSpritePixelCollision(160, 0, s);
  }
  assert(vic.regs[0x1E] === 0xFF,
    'eight-way sprite pile-up sets every bit of $D01E');
  console.log('ok  - 8-way sprite-sprite collision sets $D01E to $FF');
}

// Sprite-sprite collisions still latch when both sprites are fully behind the
// border. The border flip-flops gate visible pixels, not the sequencer-driven
// collision latch.
{
  const vic = makeVic();
  const canvasY = 47;
  clearLineBuffers(vic, canvasY);
  fillSpriteLineState(vic);

  // Force the entire raster line into both horizontal and vertical border.
  for (let cycle = 0; cycle <= 63; cycle++) {
    vic.lineCycleHBorder[cycle] = 1;
    vic.lineCycleHBorderBefore[cycle] = 1;
    vic.lineCycleVBorder[cycle] = 1;
    vic.lineCycleVBorderBefore[cycle] = 1;
  }

  fillOpaqueSpriteAcrossLine(vic, 2, 80);
  fillOpaqueSpriteAcrossLine(vic, 6, 90);
  vic._renderSpriteLine(62, canvasY);

  assert(vic.regs[0x1E] === ((1 << 2) | (1 << 6)),
    'sprite-sprite collision latches even with both sprites fully in border');
  console.log('ok  - sprite-sprite collision is independent of border visibility');
}

// Reading $D01F clears the latch but leaves IMBC ($D019 bit 1) untouched.
// Per spec, only a write to $D019 acks the IRQ flag.
{
  const vic = makeVic();
  vic.irqMask = 0x02;
  vic.irqHandler = () => {};
  vic.graphicsCollisionBuffer[10] = 1;
  vic._processSpritePixelCollision(10, 0, 0);

  assert((vic.irqStatus & 0x02) === 0x02, 'IMBC latched after collision');
  vic.read(0x1F);
  assert(vic.regs[0x1F] === 0x00, '$D01F cleared after read');
  assert((vic.irqStatus & 0x02) === 0x02,
    'reading $D01F does not clear IMBC in $D019');
  console.log('ok  - reading $D01F leaves IMBC in $D019 untouched');
}

// $D01E and $D01F latches are independent on read.
{
  const vic = makeVic();
  vic.graphicsCollisionBuffer[40] = 1;
  vic._processSpritePixelCollision(40, 0, 0); // latches $D01F bit 0
  vic._processSpritePixelCollision(50, 0, 1);
  vic._processSpritePixelCollision(50, 0, 2); // latches $D01E bits 1 and 2

  assert(vic.regs[0x1F] === 0x01, '$D01F has the expected latched value');
  assert(vic.regs[0x1E] === 0x06, '$D01E has the expected latched value');

  const v1f = vic.read(0x1F);
  assert(v1f === 0x01, 'reading $D01F returns its own latched value');
  assert(vic.regs[0x1E] === 0x06, 'reading $D01F does not affect $D01E');

  const v1e = vic.read(0x1E);
  assert(v1e === 0x06, 'reading $D01E returns its own latched value');
  console.log('ok  - $D01E and $D01F reads are independent');
}

// Reading $D01E or $D01F when no collisions have occurred returns $00.
{
  const vic = makeVic();
  assert(vic.read(0x1E) === 0x00, 'idle $D01E reads as $00');
  assert(vic.read(0x1F) === 0x00, 'idle $D01F reads as $00');
  console.log('ok  - idle collision registers read as $00');
}

// Hi-res sprite with an all-zero shift register has no opaque pixels and so
// can never latch a collision. Counterpart to the multicolor "00" test.
{
  const vic = makeVic();
  const canvasY = 49;
  const rowOffset = clearLineBuffers(vic, canvasY);
  fillSpriteLineState(vic);

  for (let x = 24; x < 48; x++) vic.graphicsCollisionBuffer[x] = 1;
  fillOpaqueSpriteAcrossLine(vic, 0, 24, { shiftReg: 0x000000 });
  vic._renderSpriteLine(64, canvasY);

  assert(vic.regs[0x1F] === 0x00,
    'hi-res sprite with empty shift register does not latch $D01F');
  console.log('ok  - empty hi-res shift register produces no collisions');
}

// Bauer §3.12: "only the first collision will trigger an interrupt (i.e. if the
// collision registers $d01e resp. $d01f contained the value zero before the
// collision)". A new pair of sprites colliding while $D01E is already non-zero
// must NOT refire IMMC, even though $D01E gains new bits. Same rule for IMBC.
{
  const vic = makeVic();
  let irqCalls = 0;
  vic.irqMask = 0x04;
  vic.irqHandler = (state) => { if (state) irqCalls++; };

  // First pair: sprites 0+1 collide → $D01E goes 0→0x03 → IMMC fires once.
  vic._processSpritePixelCollision(50, 0, 0);
  vic._processSpritePixelCollision(50, 0, 1);
  assert(vic.regs[0x1E] === 0x03, 'first pair latches into $D01E');
  assert((vic.irqStatus & 0x04) === 0x04, 'IMMC latched on first pair');
  assert(irqCalls === 1, 'IMMC IRQ fires once on the first 0→non-zero transition');

  // Different pair at a different pixel: sprites 2+3 → $D01E becomes 0x0F.
  // $D01E was already non-zero → IMMC must NOT refire (spec §3.12).
  vic._processSpritePixelCollision(60, 0, 2);
  vic._processSpritePixelCollision(60, 0, 3);
  assert(vic.regs[0x1E] === 0x0F, '$D01E gains the new pair bits');
  assert(irqCalls === 1, 'IMMC must not refire while $D01E is already non-zero');

  // Clear $D01E by reading. Next collision should fire IMMC again.
  vic.read(0x1E);
  vic.irqStatus &= ~0x80;
  vic._processSpritePixelCollision(70, 0, 4);
  vic._processSpritePixelCollision(70, 0, 5);
  assert(irqCalls === 2, 'IMMC fires again on the next 0→non-zero transition');
  console.log('ok  - IMMC fires only on the 0→non-zero transition of $D01E (spec §3.12)');
}

{
  const vic = makeVic();
  let irqCalls = 0;
  vic.irqMask = 0x02;
  vic.irqHandler = (state) => { if (state) irqCalls++; };
  vic.graphicsCollisionBuffer[40] = 1;
  vic.graphicsCollisionBuffer[41] = 1;
  vic.graphicsCollisionBuffer[42] = 1;

  // First sprite-foreground hit: $D01F goes 0→0x01 → IMBC fires.
  vic._processSpritePixelCollision(40, 0, 0);
  assert(vic.regs[0x1F] === 0x01, 'first sprite hit latches $D01F');
  assert(irqCalls === 1, 'IMBC fires on the first 0→non-zero transition');

  // A different sprite hits foreground while $D01F is non-zero. New bit added,
  // but IMBC must NOT refire.
  vic._processSpritePixelCollision(41, 0, 3);
  assert(vic.regs[0x1F] === 0x09, '$D01F gains the new sprite bit');
  assert(irqCalls === 1, 'IMBC must not refire while $D01F is already non-zero');

  // Clear $D01F. Next hit refires.
  vic.read(0x1F);
  vic.irqStatus &= ~0x80;
  vic._processSpritePixelCollision(42, 0, 5);
  assert(irqCalls === 2, 'IMBC fires again on the next 0→non-zero transition');
  console.log('ok  - IMBC fires only on the 0→non-zero transition of $D01F (spec §3.12)');
}


// X-expanded hi-res sprite: each shift-register bit covers 2 canvas pixels.
// The sprite's first pixel lands at canvas X = regX + 8 (renderer's offset).
{
  const vic = makeVic();
  const canvasY = 50;
  const rowOffset = clearLineBuffers(vic, canvasY);
  fillSpriteLineState(vic);

  // shiftReg top byte = 0xC0 = 0b1100_0000 → 4 sprite-color pixels (2 bits × 2),
  // then 16 transparent pixels (8 zero bits × 2). Remaining 16 bits zeroed.
  const sprColorIdx = 5;             // C64 palette index 5 = green
  setupSpriteForRender(vic, 0, 92, {
    xExpand: true,
    color: sprColorIdx,
    shiftReg: 0xC00000,
  });

  vic._renderSpriteLine(65, canvasY);

  const expectedColor = paletteRgba(sprColorIdx);
  const baseX = 92 + 8;              // canvas X where sprite begins
  // Bit 23 = 1 → cx baseX..baseX+1 (pixels 0,1)
  assert(vic.fb32[rowOffset + baseX] === expectedColor, 'pixel 0 (bit 23) is sprite color');
  assert(vic.fb32[rowOffset + baseX + 1] === expectedColor, 'pixel 1 (bit 23 doubled) is sprite color');
  assert(vic.fb32[rowOffset + baseX + 2] === expectedColor, 'pixel 2 (bit 22) is sprite color');
  assert(vic.fb32[rowOffset + baseX + 3] === expectedColor, 'pixel 3 (bit 22 doubled) is sprite color');
  // Bit 21 = 0 → next 2 pixels transparent (background — fb32 was zeroed).
  assert(vic.fb32[rowOffset + baseX + 4] === 0, 'pixel 4 (bit 21) is transparent');
  assert(vic.fb32[rowOffset + baseX + 5] === 0, 'pixel 5 (bit 21 doubled) is transparent');

  // X-expanded sprite covers 48 canvas pixels regardless of bit pattern.
  // The first transparent pixel after the colored block is the start of the
  // post-bit-21 zero run, not past the sprite end.
  console.log('ok  - X-expanded hi-res sprite produces 2-pixel-wide bits');
}

// Multicolor sprite pair-color mapping. 2-bit pair semantics:
//   00 → transparent      01 → $D025 (sprMcol0)
//   10 → $D027+s (color)  11 → $D026 (sprMcol1)
// Each pair is 2 canvas pixels wide for hi-res-multicolor; 4 wide if X-expanded.
{
  const vic = makeVic();
  const canvasY = 51;
  const rowOffset = clearLineBuffers(vic, canvasY);
  fillSpriteLineState(vic);

  const mc0Idx = 4, mc1Idx = 7, sprColorIdx = 1;
  setMulticolorRegs(vic, mc0Idx, mc1Idx);
  // Pairs from MSB: 00, 01, 10, 11, then 8 zero bits.
  // Binary: 0001 1011 0000 0000 ...
  const shiftReg = 0x1B0000;
  setupSpriteForRender(vic, 0, 100, {
    multicolor: true,
    color: sprColorIdx,
    shiftReg,
  });

  vic._renderSpriteLine(66, canvasY);

  const baseX = 100 + 8;
  // Pair 0 = 00 → transparent (canvas X baseX, baseX+1).
  assert(vic.fb32[rowOffset + baseX] === 0,         'pair 00 pixel 0 transparent');
  assert(vic.fb32[rowOffset + baseX + 1] === 0,     'pair 00 pixel 1 transparent');
  // Pair 1 = 01 → $D025 (mc0).
  assert(vic.fb32[rowOffset + baseX + 2] === paletteRgba(mc0Idx), 'pair 01 → $D025');
  assert(vic.fb32[rowOffset + baseX + 3] === paletteRgba(mc0Idx), 'pair 01 doubled');
  // Pair 2 = 10 → sprite color ($D027+s).
  assert(vic.fb32[rowOffset + baseX + 4] === paletteRgba(sprColorIdx), 'pair 10 → $D027+s');
  assert(vic.fb32[rowOffset + baseX + 5] === paletteRgba(sprColorIdx), 'pair 10 doubled');
  // Pair 3 = 11 → $D026 (mc1).
  assert(vic.fb32[rowOffset + baseX + 6] === paletteRgba(mc1Idx), 'pair 11 → $D026');
  assert(vic.fb32[rowOffset + baseX + 7] === paletteRgba(mc1Idx), 'pair 11 doubled');
  console.log('ok  - multicolor sprite maps "01"/"10"/"11" to $D025/$D027+s/$D026');
}

// X-expanded multicolor sprite: pairs are 4 canvas pixels wide.
{
  const vic = makeVic();
  const canvasY = 52;
  const rowOffset = clearLineBuffers(vic, canvasY);
  fillSpriteLineState(vic);

  const mc0Idx = 3, mc1Idx = 8, sprColorIdx = 14;
  setMulticolorRegs(vic, mc0Idx, mc1Idx);
  const shiftReg = 0xE40000;          // pairs from MSB: 11, 10, 01, 00
  setupSpriteForRender(vic, 0, 120, {
    multicolor: true,
    xExpand: true,
    color: sprColorIdx,
    shiftReg,
  });

  vic._renderSpriteLine(67, canvasY);

  const baseX = 120 + 8;
  // Pair 0 = 11 → $D026, 4 pixels wide.
  for (let dx = 0; dx < 4; dx++) {
    assert(vic.fb32[rowOffset + baseX + dx] === paletteRgba(mc1Idx),
      `xexp+mc pair 11 pixel ${dx} → $D026`);
  }
  // Pair 1 = 10 → sprite color, 4 pixels.
  for (let dx = 4; dx < 8; dx++) {
    assert(vic.fb32[rowOffset + baseX + dx] === paletteRgba(sprColorIdx),
      `xexp+mc pair 10 pixel ${dx} → $D027+s`);
  }
  // Pair 2 = 01 → $D025, 4 pixels.
  for (let dx = 8; dx < 12; dx++) {
    assert(vic.fb32[rowOffset + baseX + dx] === paletteRgba(mc0Idx),
      `xexp+mc pair 01 pixel ${dx} → $D025`);
  }
  // Pair 3 = 00 → transparent, 4 pixels.
  for (let dx = 12; dx < 16; dx++) {
    assert(vic.fb32[rowOffset + baseX + dx] === 0,
      `xexp+mc pair 00 pixel ${dx} transparent`);
  }
  console.log('ok  - X-expanded multicolor sprite produces 4-pixel-wide pairs');
}

// 8 sprites all rendered in the same line at distinct X positions with
// distinct colors. Lower-numbered sprites overwrite higher-numbered ones
// where they overlap (renderer iterates s=7→0). All 8 pixels must be visible.
{
  const vic = makeVic();
  const canvasY = 53;
  const rowOffset = clearLineBuffers(vic, canvasY);
  fillSpriteLineState(vic);

  // Place 8 sprites at canvas X = 50, 80, 110, 140, 170, 200, 230, 260
  // (regX = canvas-X minus 8). Each gets a different palette color.
  const positions = [42, 72, 102, 132, 162, 192, 222, 252];
  const colors = [1, 2, 3, 4, 5, 6, 7, 8];
  for (let s = 0; s < 8; s++) {
    setupSpriteForRender(vic, s, positions[s], {
      color: colors[s],
      shiftReg: 0x800000,             // single visible pixel at sprite X
    });
  }

  vic._renderSpriteLine(68, canvasY);

  for (let s = 0; s < 8; s++) {
    const cx = positions[s] + 8;
    assert(vic.fb32[rowOffset + cx] === paletteRgba(colors[s]),
      `sprite ${s} at canvas X=${cx} renders with color ${colors[s]}`);
  }
  console.log('ok  - 8 sprites at distinct X positions all render');
}

// 8 sprites enabled with mixed multicolor/X-expand configurations — the
// "all sprites in top border" Nine scenario. Verifies the rendering loop
// handles every config combination on the same line without losing data.
{
  const vic = makeVic();
  const canvasY = 54;
  const rowOffset = clearLineBuffers(vic, canvasY);
  fillSpriteLineState(vic);

  const mc0Idx = 4, mc1Idx = 5;
  setMulticolorRegs(vic, mc0Idx, mc1Idx);

  // Sprites 0-3 hi-res, 4-5 multicolor, 6-7 X-expanded multicolor.
  // (Mirrors $D01C=$F0, $D01D=$C0 patterns common in Nine.)
  const cases = [
    { x:  40, mc: false, xe: false, color: 1, shift: 0x800000 },
    { x:  64, mc: false, xe: false, color: 2, shift: 0x800000 },
    { x:  88, mc: false, xe: false, color: 3, shift: 0x800000 },
    { x: 112, mc: false, xe: false, color: 6, shift: 0x800000 },
    { x: 140, mc: true,  xe: false, color: 7, shift: 0x800000 }, // pair 10 → color
    { x: 164, mc: true,  xe: false, color: 8, shift: 0xC00000 }, // pair 11 → mc1
    { x: 200, mc: true,  xe: true,  color: 9, shift: 0x400000 }, // pair 01 → mc0
    { x: 240, mc: true,  xe: true,  color:10, shift: 0xC00000 }, // pair 11 → mc1
  ];
  for (let s = 0; s < 8; s++) {
    setupSpriteForRender(vic, s, cases[s].x, {
      multicolor: cases[s].mc,
      xExpand: cases[s].xe,
      color: cases[s].color,
      shiftReg: cases[s].shift,
    });
  }

  vic._renderSpriteLine(69, canvasY);

  const expectedColors = [
    paletteRgba(1), paletteRgba(2), paletteRgba(3), paletteRgba(6),
    paletteRgba(7),                  // sprite 4 multicolor pair 10 → color
    paletteRgba(mc1Idx),             // sprite 5 multicolor pair 11 → mc1
    paletteRgba(mc0Idx),             // sprite 6 xexp+mc pair 01 → mc0
    paletteRgba(mc1Idx),             // sprite 7 xexp+mc pair 11 → mc1
  ];
  for (let s = 0; s < 8; s++) {
    const cx = cases[s].x + 8;
    assert(vic.fb32[rowOffset + cx] === expectedColors[s],
      `mixed-config sprite ${s} at canvas X=${cx} renders with expected color`);
  }
  console.log('ok  - 8 sprites with mixed hi-res/multicolor/X-expand all render correctly');
}

// Bauer §3.6.1 + bumbershootsoft: BA goes low 3 cycles before each enabled
// sprite's FIRST bus access (the p-access), and stays low through both p
// and s. With all 8 sprites DMA on, BA must be low for cycles 1-10
// (sp 3-7 p+s accesses at cycles 1-10) and 55-63 (sp 0-2 lead-in starts at
// cycle 55, three cycles before sp0's p-access at cycle 58). Cycles 11-54
// must NOT be BA-low. If our cycle-stall accounting is wrong, raster IRQ
// multiplexer code drifts by 1 cycle/sprite and demos like nine.prg
// produce visual garbage.
{
  const vic = makeVic();
  for (let s = 0; s < 8; s++) vic.spriteDmaOn[s] = 1;

  // Cycles 1-10: BA must be low (sprites 3-7 + lead).
  for (let c = 1; c <= 10; c++) {
    assert(vic._spriteBaLow(c) === true,
      `cycle ${c}: BA must be low under 8-sprite load (sprites 3-7 active)`);
  }
  // Cycles 11-54: BA must be high (no sprite cycles within ±3 cycles).
  for (let c = 11; c <= 54; c++) {
    assert(vic._spriteBaLow(c) === false,
      `cycle ${c}: BA must be HIGH (no sprite p/s access nearby)`);
  }
  // Cycles 55-63: BA low (lead-in for sp0 starts at cycle 55, 3 cycles
  // before its p-access at 58; sp 0,1,2 p+s accesses span 58-63; sp 3
  // lead-in pulls BA low at cycle 63 already).
  for (let c = 55; c <= 63; c++) {
    assert(vic._spriteBaLow(c) === true,
      `cycle ${c}: BA must be low under 8-sprite load (sp 0-2 + sp 3 lead)`);
  }
  console.log('ok  - 8-sprite BA-low extent: cycles 1-10 and 55-63 (19 cycles/line; AEC-stall = 16 = 2 × 8 sprites)');
}

// Sister case: only sprite 7 DMA on. Sprite 7 has p-access at cycle 9 and
// s-access at cycle 10. BA goes low 3 cycles before the p-access (cycle 6),
// covering cycles 6..10 = 5 cycles total. Outside that range BA must be
// free.
{
  const vic = makeVic();
  vic.spriteDmaOn[7] = 1;             // only sprite 7
  for (let c = 1; c <= 5; c++) {
    assert(vic._spriteBaLow(c) === false,
      `cycle ${c} must NOT be BA-low with only sprite 7 active`);
  }
  for (let c = 6; c <= 10; c++) {
    assert(vic._spriteBaLow(c) === true,
      `cycle ${c} must be BA-low for sprite 7 lead/p/s accesses`);
  }
  for (let c = 11; c <= 63; c++) {
    assert(vic._spriteBaLow(c) === false,
      `cycle ${c} must NOT be BA-low with only sprite 7 active`);
  }
  console.log('ok  - single sprite 7 BA-low extent confined to cycles 6-10 (3 lead + p + s)');
}

// Bauer §3.7.3.7: invalid mode 110 renders all pixels BLACK but the bitmap
// data still drives the foreground priority map. A sprite drawn ON TOP of
// invalid-mode background:
//   - With priority bit 0 (sprite over graphics): sprite always visible.
//   - With priority bit 1 (sprite under graphics): sprite hidden where the
//     bitmap byte's bit at this canvas X was 1.
{
  const vic = makeVic();
  const canvasY = 60;
  const rowOffset = clearLineBuffers(vic, canvasY);
  fillSpriteLineState(vic);

  // Simulate invalid-mode 110 having already rendered a row: pixels black,
  // priority/foreground buffer reflects bitmap foreground bits. Bits 4-7 of
  // the simulated bitmap byte are set → canvas X 200..203 are foreground.
  for (let x = 200; x < 224; x++) {
    vic.fb32[rowOffset + x] = 0xFF000000;          // mode-110 black
    const isFg = x < 204;
    vic.graphicsPriorityBuffer[x] = isFg ? 1 : 0;
    vic.graphicsCollisionBuffer[x] = isFg ? 1 : 0;
  }

  // Sprite 0 at canvas X=200, hi-res, priority=0 (drawn ON TOP).
  setupSpriteForRender(vic, 0, 192, {
    color: 5,                                       // distinct sprite color
    priority: false,
    shiftReg: 0xFFFFFF,                             // all bits set → 24 visible
  });

  vic._renderSpriteLine(75, canvasY);

  // Priority=0 → sprite must overwrite the mode-110 black pixels everywhere
  // it draws, including at "foreground" pixels.
  for (let x = 200; x < 224; x++) {
    assert(vic.fb32[rowOffset + x] === paletteRgba(5),
      `priority=0 sprite must overwrite black at X=${x}`);
  }
  console.log('ok  - sprite priority=0 over invalid mode 110 always visible');
}

// Sister: priority=1 sprite hidden where bitmap foreground bit was 1.
{
  const vic = makeVic();
  const canvasY = 61;
  const rowOffset = clearLineBuffers(vic, canvasY);
  fillSpriteLineState(vic);

  for (let x = 200; x < 224; x++) {
    vic.fb32[rowOffset + x] = 0xFF000000;
    const isFg = x < 204;                           // first 4 px are fg
    vic.graphicsPriorityBuffer[x] = isFg ? 1 : 0;
    vic.graphicsCollisionBuffer[x] = isFg ? 1 : 0;
  }

  setupSpriteForRender(vic, 0, 192, {
    color: 5,
    priority: true,                                 // sprite UNDER graphics
    shiftReg: 0xFFFFFF,
  });

  vic._renderSpriteLine(76, canvasY);

  // Priority=1 → sprite hidden behind foreground pixels (X 200..203) but
  // visible where there was no foreground (X 204..223).
  for (let x = 200; x < 204; x++) {
    assert(vic.fb32[rowOffset + x] === 0xFF000000,
      `priority=1 sprite hidden at fg pixel X=${x} (still mode-110 black)`);
  }
  for (let x = 204; x < 224; x++) {
    assert(vic.fb32[rowOffset + x] === paletteRgba(5),
      `priority=1 sprite visible at non-fg pixel X=${x}`);
  }
  // Collision still latches at the fg pixels even though the sprite was hidden.
  assert((vic.regs[0x1F] & 0x01) === 0x01,
    'sprite-bg collision latches even when sprite is hidden by priority');
  console.log('ok  - sprite priority=1 over invalid mode 110 hidden by bitmap fg bits');
}

// (Mid-line $D025 per-segment test moved to sprite-spec-test.js #4 with
// the same canvas-X precision.)

// Sprite display starting at line $30 with mode 110 ($73) active. The line
// $30 boundary is also the first display-window line under RSEL=1. Both the
// invalid-mode background and the sprite need to render correctly at this
// boundary — a top-border multiplexer entering the display area.
{
  const vic = makeVic();
  const canvasY = 63;
  const rowOffset = clearLineBuffers(vic, canvasY);
  fillSpriteLineState(vic);

  // Pre-fill the row with what mode 110 would produce: black pixels with
  // foreground bits set per the simulated bitmap byte 0xF0 (bits 7..4 set).
  // 8-pixel column at X 100..107.
  for (let x = 100; x < 108; x++) {
    vic.fb32[rowOffset + x] = 0xFF000000;
    const bitIdx = x - 100;
    const isFg = (0xF0 >> (7 - bitIdx)) & 1;
    vic.graphicsPriorityBuffer[x] = isFg;
    vic.graphicsCollisionBuffer[x] = isFg;
  }

  // Sprite 0 hi-res at canvas X=100 (regX=92), priority=0, color 14.
  // shiftReg upper 8 bits = 0xFF → all 8 pixels visible across X 100..107.
  setupSpriteForRender(vic, 0, 92, {
    color: 14,
    priority: false,
    shiftReg: 0xFF0000,
  });

  vic._renderSpriteLine(48 /* raster $30 */, canvasY);

  for (let x = 100; x < 108; x++) {
    assert(vic.fb32[rowOffset + x] === paletteRgba(14),
      `sprite must render over mode-110 black at $30 boundary X=${x}`);
  }
  // Collisions latch on the bitmap-fg bits (the 0xF0 high nibble).
  assert((vic.regs[0x1F] & 0x01) === 0x01,
    'sprite-bg collision latches against mode-110 foreground bits');
  console.log('ok  - sprite + mode-110 at $30 boundary renders correctly with collisions');
}

// CIA1 + VIC raster IRQ are wired-OR onto the same CPU IRQ line. Demos like
// Nine drive raster effects from the VIC and music from CIA1 timer-A; the
// handler dispatches by reading both ICRs. The machine-level OR must
// preserve assertion until ALL sources are acked, regardless of order.
{
  const machine = new C64Machine();
  let cpuIrqState = false;
  machine.cpu.setIrqLine = (s) => { cpuIrqState = !!s; };

  // Park CIA1 with timer-A IRQ latched + enabled. The /IRQ output is the IR
  // latch (datasheet sheet 7); set it asserted directly here.
  machine.cia1.icrStatus = 0x01;
  machine.cia1.icrMask = 0x01;
  machine.cia1._irLatch = true;
  // VIC raster IRQ pending too.
  machine.vic2.irqStatus = 0x80 | 0x01;
  machine.vic2.irqMask = 0x01;

  machine._updateC64Irq();
  assert(cpuIrqState === true, 'CIA1 + VIC both pending → CPU IRQ asserted');

  machine.vic2.write(0x19, 0x01);    // ack VIC
  machine._updateC64Irq();
  assert(cpuIrqState === true,
    'CPU IRQ stays asserted while CIA1 still has timer-A latched');

  machine.cia1.icrStatus = 0;        // ack CIA1: clear data + IR latch
  machine.cia1._irLatch = false;
  machine._updateC64Irq();
  assert(cpuIrqState === false,
    'CPU IRQ deasserts when both VIC and CIA1 sources are cleared');
  console.log('ok  - VIC + CIA1 IRQs share the CPU line; both must be acked to deassert');
}

// Reverse order: ack CIA1 first, VIC still pending.
{
  const machine = new C64Machine();
  let cpuIrqState = false;
  machine.cpu.setIrqLine = (s) => { cpuIrqState = !!s; };
  machine.cia1.icrStatus = 0x01;
  machine.cia1.icrMask = 0x01;
  machine.vic2.irqStatus = 0x80 | 0x01;
  machine.vic2.irqMask = 0x01;
  machine._updateC64Irq();
  assert(cpuIrqState === true, 'both pending');

  machine.cia1.icrStatus = 0;        // CIA1 status read clears it
  machine._updateC64Irq();
  assert(cpuIrqState === true, 'CPU IRQ stays while VIC still latched');

  machine.vic2.write(0x19, 0x01);
  machine._updateC64Irq();
  assert(cpuIrqState === false, 'CPU IRQ finally deasserts');
  console.log('ok  - VIC + CIA1 IRQ ack order independence');
}

// CSEL=0 left compare (X=31) fires at cycle 15 just like CSEL=1 (X=24).
// Both fall in segment [24,32). Sister to the right-compare timing tests:
// confirms there's no CSEL transition between cycles 14 and 15 that
// suppresses the cycle-15 left compare.
{
  const vic = makeVic();
  vic.vBorderActive = false;
  vic.hBorderActive = true;
  vic.regs[0x16] = 0x08;             // CSEL=1
  vic._advanceHorizontalBorderState(14, vic.regs);
  assert(vic.hBorderActive === true, 'cycle 14 does not yet fire left compare');

  vic.regs[0x16] = 0x00;             // flip to CSEL=0 between 14 and 15
  vic._advanceHorizontalBorderState(15, vic.regs);
  assert(vic.hBorderActive === false,
    'cycle-15 left compare still opens border under CSEL=0 (left=31 in [24,32))');
  console.log('ok  - CSEL=1→0 between cycles 14 and 15 still opens border at cycle 15');
}

// Multiple sprites with mixed priority over invalid mode 110: priority=0
// sprites overwrite black, priority=1 sprites are hidden where bitmap
// foreground bits are 1 — the iteration order (s=7→0) and per-sprite
// priority gating must compose cleanly.
{
  const vic = makeVic();
  const canvasY = 80;
  const rowOffset = canvasY * 384;
  vic.borderBuffer.fill(0, 0, 384);
  vic.fb32.fill(0xFF000000, rowOffset, rowOffset + 384);   // mode-110 black
  vic.graphicsPriorityBuffer.fill(0, 0, 384);
  vic.graphicsCollisionBuffer.fill(0, 0, 384);
  vic.spriteCollisionBuffer.fill(0, 0, 384);
  fillSpriteLineState(vic, vic.regs);

  // Pretend the bitmap had bit pattern 0xCC (binary 11001100) at canvas X
  // 100..107 — i.e. fg pixels at 100,101,104,105.
  for (let i = 0; i < 8; i++) {
    const isFg = (0xCC >> (7 - i)) & 1;
    vic.graphicsPriorityBuffer[100 + i] = isFg;
    vic.graphicsCollisionBuffer[100 + i] = isFg;
  }

  // Sprite 0 priority=0 at X=92 (canvas 100) — visible everywhere.
  fillOpaqueSpriteAcrossLine(vic, 0, 92, { color: 1 });
  // Sprite 7 priority=1 at X=92 (canvas 100) — hidden where bitmap fg=1.
  // Use a different shiftReg so we can distinguish; keep all pixels visible.
  fillOpaqueSpriteAcrossLine(vic, 7, 92, { color: 6, priority: true });

  // Force lineCycleSpriteShiftReg for sprite 7 to also be 0xFFFFFF
  // (fillOpaqueSpriteAcrossLine sets it to 0xFFFFFF by default).

  vic._renderSpriteLine(80, canvasY);

  // s=7→0 iteration: sprite 7 draws first (priority=1, hidden at fg pixels),
  // sprite 0 draws second (priority=0, overwrites everything). Result at
  // every X in 100..107: sprite 0's color wins.
  for (let x = 100; x < 108; x++) {
    assert(vic.fb32[rowOffset + x] === paletteRgba(1),
      `mixed-priority over mode 110: sprite 0 (priority=0) must overwrite at X=${x}`);
  }
  // Both sprites latch sprite-bg collision against the bitmap fg bits.
  assert((vic.regs[0x1F] & 0x81) === 0x81,
    'both sprite 0 and sprite 7 latch sprite-bg collision against bitmap fg bits');
  // The two sprites also collide with each other at every visible pixel.
  assert((vic.regs[0x1E] & 0x81) === 0x81,
    'sprite 0 and sprite 7 latch sprite-sprite collision');
  console.log('ok  - 2 sprites with mixed priority over invalid mode 110: collisions latch correctly');
}

// Multicolor sprite over invalid mode 110: the multicolor "01" pair colors
// are NOT foreground for sprite priority gating (they're sprMcol0). Spec
// §3.8.2: any non-transparent multicolor pair counts as foreground for
// collision; for priority, the SAME applies — any non-"00" pixel is drawn.
{
  const vic = makeVic();
  const canvasY = 81;
  const rowOffset = canvasY * 384;
  vic.borderBuffer.fill(0, 0, 384);
  vic.fb32.fill(0xFF000000, rowOffset, rowOffset + 384);
  vic.graphicsPriorityBuffer.fill(0, 0, 384);
  vic.graphicsCollisionBuffer.fill(0, 0, 384);
  vic.spriteCollisionBuffer.fill(0, 0, 384);
  fillSpriteLineState(vic, vic.regs);

  // Bitmap fg at all 8 pixels in X 200..207.
  for (let x = 200; x < 208; x++) {
    vic.graphicsPriorityBuffer[x] = 1;
    vic.graphicsCollisionBuffer[x] = 1;
  }

  // Multicolor sprite with priority=0 — must be visible everywhere.
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleRegs[cycle][0x25] = 4;
    vic.lineCycleRegs[cycle][0x26] = 7;
  }
  vic.regs[0x25] = 4; vic.regs[0x26] = 7;
  fillOpaqueSpriteAcrossLine(vic, 0, 192, { multicolor: true, color: 5 });
  // Override shiftReg to all "01" pairs (drives $D025=4).
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleSpriteShiftReg[cycle][0] = 0x555555;
  }
  vic.spriteShiftReg[0] = 0x555555;

  vic._renderSpriteLine(81, canvasY);

  // Every visible pixel in X 200..223 should be $D025 (color 4) since
  // priority=0 means sprite always wins.
  for (let x = 200; x < 224; x++) {
    assert(vic.fb32[rowOffset + x] === paletteRgba(4),
      `multicolor "01" pair over mode 110 must render mc0 ($D025) at X=${x}`);
  }
  // Collision still latches at the bitmap-fg bits (the first 8 pixels).
  assert((vic.regs[0x1F] & 0x01) === 0x01,
    'multicolor sprite latches sprite-bg collision against mode-110 fg bits');
  console.log('ok  - multicolor sprite "01" pairs render and collide over invalid mode 110');
}

// Bauer §3.7.3.7-8: invalid bitmap modes 110 and 111 render every pixel BLACK
// regardless of bit value. The display path is correct, but the idle path
// (used inside the open border / hyperscreen) was rendering bg0 for "0"
// bits — visible in nine.prg's mode-$73 hyperscreen scene as a flood of
// background-color pixels where they should be black.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x60;             // ECM=1, BMM=1 → mode 110
  vic.regs[0x16] = 0x00;             // MCM=0
  vic.regs[0x21] = 0x06;             // bg0 = blue (anything non-black)

  const seg = makeRenderSeg(vic, {
    displayColumnActive: false,
    rowFetchD011: 0x60,
    rowFetchD016: 0x00,
    idleByte: 0xAA,                  // alternating bits
  });

  vic._renderOpenBorderIdleSpan(seg, 0, 32, 40);

  // Every pixel must render BLACK regardless of which bit is set.
  for (let x = 32; x < 40; x++) {
    assert(vic.fb32[x] === 0xFF000000,
      `mode 110 idle pixel at X=${x} must be BLACK regardless of bit value, ` +
      `got 0x${vic.fb32[x].toString(16)}`);
  }
  // Foreground map must reflect the actual bit pattern (for sprite priority/collision).
  assert(vic.graphicsPriorityBuffer[32] === 1, 'bit 7 of 0xAA → fg=1');
  assert(vic.graphicsPriorityBuffer[33] === 0, 'bit 6 of 0xAA → fg=0');
  console.log('ok  - mode 110 idle path renders all pixels BLACK (spec §3.7.3.7)');
}

// Mode 111 (BMM+MCM+ECM) — same rule, every pixel BLACK.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x60;             // ECM=1, BMM=1
  vic.regs[0x16] = 0x10;             // MCM=1 → mode 111
  vic.regs[0x21] = 0x06;             // bg0 = blue

  const seg = makeRenderSeg(vic, {
    displayColumnActive: false,
    rowFetchD011: 0x60,
    rowFetchD016: 0x10,
    idleByte: 0xC9,                  // pairs 11, 00, 10, 01
  });

  vic._renderOpenBorderIdleSpan(seg, 0, 32, 40);

  for (let x = 32; x < 40; x++) {
    assert(vic.fb32[x] === 0xFF000000,
      `mode 111 idle pixel at X=${x} must be BLACK regardless of pair value, ` +
      `got 0x${vic.fb32[x].toString(16)}`);
  }
  console.log('ok  - mode 111 idle path renders all pixels BLACK (spec §3.7.3.8)');
}

// ── Sprite pointer switching ────────────────────────────────────────────────
// Demos with sprite multiplexers retarget pointers per raster — either by
// rewriting screen RAM at $vM+$3F8..$3FF, or by pointing $D018 at a
// different screen base whose pointer area holds different values.

// 1. P-access uses LIVE $D018 high nibble — different sprites in the same
//    line can read pointers from different screen bases if $D018 is
//    rewritten between their p-access cycles.
{
  const vic = makeVic();
  vic.regs[0x18] = 0x14;              // screen base $0400 default
  vic.ram[0x07F8] = 0x10;             // sprite 0 pointer at default base
  vic.ram[0x23F9] = 0x77;             // sprite 1 pointer at $D018=$84 base

  vic._spriteSequencerPointerAccess(58);
  assert(vic.spritePointerValue[0] === 0x10,
    `sprite 0 p-access reads live $D018=$14 → $07F8 = 0x10, got 0x${vic.spritePointerValue[0].toString(16)}`);

  // Flip $D018 high nibble before sprite 1's p-access at cycle 60.
  vic.regs[0x18] = 0x84;              // screen base $2000 (avoiding char-ROM shadow at $1000)
  vic._spriteSequencerPointerAccess(60);
  assert(vic.spritePointerValue[1] === 0x77,
    `sprite 1 p-access uses LIVE $D018=$84 → $23F9 = 0x77, got 0x${vic.spritePointerValue[1].toString(16)}`);
  console.log('ok  - sprite p-access reads live $D018 (different sprites, different screen bases)');
}

// 2. P-access uses LIVE VIC bank.
{
  const vic = makeVic();
  vic.regs[0x18] = 0x14;
  // Bank 0 pointer area: $0400+$3F8 = $07F8 absolute = ram[$07F8].
  vic.ram[0x07F8] = 0xAA;
  // Bank 1 ($4000) pointer area: $4400+$3F8 = $47F8 absolute.
  vic.ram[0x47F8] = 0xBB;

  vic.currentVicBank = 0x0000;
  vic._spriteSequencerPointerAccess(58);
  assert(vic.spritePointerValue[0] === 0xAA,
    `bank 0 → reads $07F8 = 0xAA, got 0x${vic.spritePointerValue[0].toString(16)}`);

  vic.currentVicBank = 0x4000;
  vic._spriteSequencerPointerAccess(58);
  assert(vic.spritePointerValue[0] === 0xBB,
    `bank 1 → reads $47F8 = 0xBB, got 0x${vic.spritePointerValue[0].toString(16)}`);
  console.log('ok  - sprite p-access reads live VIC bank');
}

// 3. Multiplexer pattern: rewrite the pointer in screen RAM between two
//    consecutive sprite p-accesses on the same line. Each p-access reads
//    the live RAM byte.
{
  const vic = makeVic();
  vic.regs[0x18] = 0x14;
  vic.ram[0x07F8] = 0x10;             // sprite 0 pointer
  vic.ram[0x07F9] = 0x10;             // sprite 1 pointer (initially same)

  vic._spriteSequencerPointerAccess(58);
  assert(vic.spritePointerValue[0] === 0x10, 'sprite 0 reads 0x10');

  // The multiplexer's IRQ writes a new pointer for sprite 1 between cycle
  // 58 and cycle 60.
  vic.ram[0x07F9] = 0x40;
  vic._spriteSequencerPointerAccess(60);
  assert(vic.spritePointerValue[1] === 0x40,
    `sprite 1 picks up the rewritten pointer (got 0x${vic.spritePointerValue[1].toString(16)})`);
  console.log('ok  - mid-line pointer RAM rewrite is read by the next p-access');
}

// 4. P-access fires REGARDLESS of sprite DMA state (spec §3.8.1 rule 5):
//    "p-accesses are always done, even if the sprite is turned off". Only
//    s-accesses are gated by DMA. spritePointerValue must update even for
//    a disabled sprite.
{
  const vic = makeVic();
  vic.regs[0x18] = 0x14;
  vic.regs[0x15] = 0x00;              // ALL sprites disabled
  vic.ram[0x07F8] = 0xCD;
  vic.spriteDmaOn[0] = 0;

  vic._spriteSequencerPointerAccess(58);
  assert(vic.spritePointerValue[0] === 0xCD,
    'p-access fires for disabled sprite per spec rule 5');
  assert(vic.spritePointerFresh[0] === 1, 'freshness flag set');
  // s-access path must early-return: DMA off.
  vic._spriteSequencerRowAccess(59);
  assert(vic.spriteRowByteMask[0] === 0,
    's-access does NOT fire for disabled sprite (DMA gate)');
  console.log('ok  - p-access fires unconditionally; s-access still DMA-gated');
}

// 5. spritePointerValue persists across line boundaries — _beginRasterLine
//    only clears the FRESHNESS flag, not the value. The next p-access
//    always overwrites the value anyway, but in-between, the old pointer
//    is preserved (relevant if the demo reads $D000+ via debug or chains).
{
  const vic = makeVic();
  vic.regs[0x18] = 0x14;
  vic.ram[0x07F8] = 0x55;
  vic._spriteSequencerPointerAccess(58);
  assert(vic.spritePointerValue[0] === 0x55, 'pointer fetched');
  assert(vic.spritePointerFresh[0] === 1, 'fresh flag set');

  // Simulate next-line _beginRasterLine clearing freshness.
  vic.spritePointerFresh.fill(0);
  assert(vic.spritePointerValue[0] === 0x55,
    'pointer value persists across freshness clear');
  console.log('ok  - sprite pointer value persists across line boundary, freshness flag does not');
}

// 6. All 8 sprites' p-access cycles read independently — sprite N reading
//    pointer N at the right offset.
{
  const vic = makeVic();
  vic.regs[0x18] = 0x14;
  for (let s = 0; s < 8; s++) vic.ram[0x07F8 + s] = 0xA0 + s;

  // Run all 8 p-accesses (sprite 0-2 same line, sprite 3-7 next-line cycles).
  vic._spriteSequencerPointerAccess(58);   // sprite 0 → 0xA0
  vic._spriteSequencerPointerAccess(60);   // sprite 1 → 0xA1
  vic._spriteSequencerPointerAccess(62);   // sprite 2 → 0xA2
  vic._spriteSequencerPointerAccess(1);    // sprite 3 → 0xA3
  vic._spriteSequencerPointerAccess(3);    // sprite 4 → 0xA4
  vic._spriteSequencerPointerAccess(5);    // sprite 5 → 0xA5
  vic._spriteSequencerPointerAccess(7);    // sprite 6 → 0xA6
  vic._spriteSequencerPointerAccess(9);    // sprite 7 → 0xA7

  for (let s = 0; s < 8; s++) {
    assert(vic.spritePointerValue[s] === 0xA0 + s,
      `sprite ${s} reads its own pointer slot ($07F${(8 + s).toString(16)} → 0x${(0xA0+s).toString(16)}); got 0x${vic.spritePointerValue[s].toString(16)}`);
  }
  console.log('ok  - all 8 sprites independently fetch from their own pointer slot');
}

// 7. spriteDataBase = pointer × 64. Used as the sprite data origin for
//    s-accesses. Pointer 0xFF → base $3FC0. Pointer 0x00 → base $0000.
{
  const vic = makeVic();
  vic.regs[0x18] = 0x14;

  vic.ram[0x07F8] = 0xFF;
  vic._spriteSequencerPointerAccess(58);
  assert(vic.spriteDataBase[0] === 0xFF * 64,
    `pointer 0xFF → spriteDataBase $${(0xFF * 64).toString(16).padStart(4, '0')}, got $${vic.spriteDataBase[0].toString(16).padStart(4, '0')}`);

  vic.ram[0x07F8] = 0x00;
  vic._spriteSequencerPointerAccess(58);
  assert(vic.spriteDataBase[0] === 0x0000, 'pointer 0x00 → base $0000');
  console.log('ok  - sprite data base computed as pointer × 64 (covers full $0000-$3FC0 range)');
}

// 8. p-access captures the VIC bank into spriteDataBank — the s-access
//    later uses this captured bank, NOT the live bank. This is a known
//    simplification (real VIC reads s-access live, but mid-sprite-fetch
//    bank changes are rare in real demos).
{
  const vic = makeVic();
  vic.regs[0x18] = 0x14;
  vic.currentVicBank = 0x0000;
  vic.ram[0x07F8] = 0x10;             // sprite data starts at $0400 (10*64)
  vic.ram[0x0400] = 0x55;             // first sprite byte in bank 0
  vic.ram[0x4400] = 0xAA;             // first sprite byte in bank 1

  vic._spriteSequencerPointerAccess(58);
  assert(vic.spriteDataBank[0] === 0x0000, 'p-access captured bank 0');

  // CPU swaps VIC bank between p-access and s-access.
  vic.currentVicBank = 0x4000;

  // Force MC=0 + DMA on so the s-access reads a byte.
  vic.spriteMC[0] = 0;
  vic.spriteDmaOn[0] = 1;
  vic._fetchSpriteRowByte(0, 0);

  // Implementation captures bank at p-access; s-access uses captured bank 0
  // → reads ram[0x0400] = 0x55 (NOT live bank 1's 0xAA).
  assert(vic.spriteRowData[0][0] === 0x55,
    `s-access uses captured bank from p-access (got 0x${vic.spriteRowData[0][0].toString(16)})`);
  console.log('ok  - sprite s-access uses bank captured at p-access time (impl simplification)');
}

console.log('\nAll sprite collision tests passed.');
