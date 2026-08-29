// Sprite-X horizontal wrap (Bauer §3.8) — spec audit.
//
// Sprite-X is a 9-bit register (0..511 via $D000+2N + bit N of $D010).
// With the X-MSB set, the sprite is positioned past X=255 — STILL on
// the same scanline. The 24 (or 48 with X-expand) pixels paint at
// canvas X=sx, sx+1, ..., wrapping AT the line-wrap boundary back to
// canvas X=8 (= raw X=0 + 8 offset) of the SAME scanline.
//
// In our impl the per-line sprite render covers cycles 11..58 ≡ canvas
// X=0..383. Sprites at canvas X ≥ 384 don't paint within that range
// directly. Without wrap modeling, those sprites are invisible —
// breaking demos like OrbitUntold (FAIRLIGHT 2025) that intentionally
// position a sprite at X=494 to wrap-paint the F glyph into the same
// scanline's left side border.
//
// Tests verify:
//   1.  No-wrap baseline: sprite at moderate X paints normally, no wrap.
//   2.  Wrap render: sprite at canvas X=502 paints remaining 14 pixels
//       at canvas X=8..21 of the SAME line (after the 10 off-canvas
//       pixels are consumed by the wrap advance).
//   3.  Wrap pixels reflect post-off-canvas shifter state (10 advances).
//   4.  X-expanded sprite (width=48) does not wrap from very high X.
//   5.  Sprite at canvas X just under 384: no wrap (paints fully on line).
//   6.  Sprite at canvas X exactly at line-wrap boundary (512): full
//       sprite wraps to canvas X=8..31 of the same line.
//   7.  Wrap painted only when border is OPEN. With closed-left
//       borderBuffer=1, wrap is gated by _spriteVisibleAt.
//   10. X-expanded wrap sprite latches $D01F against REAL text-mode fg in
//       the display window (integration through _renderRasterLine — no
//       graphicsCollisionBuffer poking).
//   11. Wrap pixels of one sprite collide with another sprite's pixels at
//       the same canvas X (sprite-sprite latch $D01E).

import { VIC2, CYCLES_PER_LINE, CANVAS_W } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
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

// Build full per-cycle sprite state for a single sprite at given regs-X
// with all-1s shift register. Returns canvas-X start.
function setupSprite(vic, s, regX, { xExpand = false, color = 2, shiftReg = 0xFFFFFF } = {}) {
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleRegs[cycle].set(vic.regs);
    vic.lineCycleRegs[cycle][0x15] |= (1 << s);
    vic.lineCycleRegs[cycle][s * 2] = regX & 0xFF;
    if (regX > 255) vic.lineCycleRegs[cycle][0x10] |= (1 << s);
    if (xExpand) vic.lineCycleRegs[cycle][0x1D] |= (1 << s);
    vic.lineCycleRegs[cycle][0x27 + s] = color & 0x0F;
    vic.lineCycleSpriteDisplayOn[cycle][s] = 1;
    vic.lineCycleSpriteDataRow[cycle][s] = 0;
    vic.lineCycleSpriteRowByteMask[cycle][s] = 0x07;
    vic.lineCycleSpriteShiftReg[cycle][s] = shiftReg >>> 0;
    vic.lineCycleHBorderBefore[cycle] = 0;
    vic.lineCycleHBorder[cycle] = 0;
    vic.lineCycleVBorderBefore[cycle] = 0;
    vic.lineCycleVBorder[cycle] = 0;
  }
  return regX + 8;
}

function spritegap3Collision(n, m, x) {
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x15] = (1 << n) | (1 << m);
  const mx = (x + 1) & 0x1FF;
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleRegs[cycle].set(vic.regs);
    vic.lineCycleRegs[cycle][0x15] = (1 << n) | (1 << m);
    vic.lineCycleRegs[cycle][n * 2] = x & 0xFF;
    vic.lineCycleRegs[cycle][m * 2] = mx & 0xFF;
    if (x > 255) vic.lineCycleRegs[cycle][0x10] |= (1 << n);
    if (mx > 255) vic.lineCycleRegs[cycle][0x10] |= (1 << m);

    // spritegap3's only nonzero shape bytes are on row 20. The collision
    // window is cleared before that row and read after display has ended, so
    // this models the final row directly: display is on through cycle 57 and
    // rule 4 drops it at cycle 58.
    vic.lineCycleSpriteDisplayOn[cycle][n] = cycle < 58 ? 1 : 0;
    vic.lineCycleSpriteDisplayOn[cycle][m] = cycle < 58 ? 1 : 0;
    vic.lineCycleSpriteDataRow[cycle][n] = cycle < 58 ? 20 : -1;
    vic.lineCycleSpriteDataRow[cycle][m] = cycle < 58 ? 20 : -1;
    vic.lineCycleSpriteRowByteMask[cycle][n] = 0x01;
    vic.lineCycleSpriteRowByteMask[cycle][m] = 0x01;
    vic.lineCycleSpriteShiftReg[cycle][n] = 0x400000; // bit 6 of byte 0
    vic.lineCycleSpriteShiftReg[cycle][m] = 0x800000; // bit 7 of byte 0
    vic.lineCycleHBorderBefore[cycle] = 0;
    vic.lineCycleHBorder[cycle] = 0;
    vic.lineCycleVBorderBefore[cycle] = 0;
    vic.lineCycleVBorder[cycle] = 0;
  }
  vic._renderSpriteLine(149, 134);
  vic._offCanvasSpriteSpriteCollision(134);
  return vic.regs[0x1E];
}

// ── 1: No-wrap baseline — sprite at canvas X=100 paints fully on line ──
{
  const vic = makeVic();
  setupSprite(vic, 0, 92);  // canvas X = 100
  vic._renderSpriteLine(50, 35);
  const ro = 35 * CANVAS_W;
  let painted = 0;
  for (let x = 100; x < 124; x++) {
    if (vic.spriteOwnerBuffer[x] === 0) painted++;
  }
  expect(painted === 24, `sprite at X=100: full 24px on line, got ${painted}`);
  // No spurious left-border paint from a non-wrapping sprite.
  for (let x = 0; x < 32; x++) {
    expect(vic.spriteOwnerBuffer[x] === 0xFF,
      `no left-border paint for non-wrapping sprite at canvas X=${x}`);
  }
  ok(`no-wrap baseline: sprite at canvas X=100 paints 24 pixels on this line`);
}

// ── 2: Wrap renders remaining pixels at canvas X=0..21 of SAME line ────
// Sprite at canvas X=502 (raw X=494): 502 + 24 = 526 > 504 (PAL line
// wrap point in canvas-X). Pixels 0..1 land at canvas X=502..503 —
// off-canvas-right (between visible 384 and line-wrap 504). Pixels
// 2..23 wrap to canvas X=0..21 of the SAME line. The first 8 pixels
// (canvas X=0..7) are in the overscan-left zone (cycle 11 / raw
// X=496..503 mod 504), the next 14 (canvas X=8..21) are at the start
// of the active line.
{
  const vic = makeVic();
  setupSprite(vic, 0, 494);     // canvas X=502
  vic._renderSpriteLine(50, 35);
  const ro = 35 * CANVAS_W;
  let painted = 0;
  for (let x = 0; x < 22; x++) {
    if (vic.spriteOwnerBuffer[x] === 0) painted++;
  }
  expect(painted === 22,
    `wrap paints 22 pixels at canvas X=0..21 of SAME line, got ${painted}`);
  expect(vic.spriteOwnerBuffer[22] === 0xFF,
    `no paint at canvas X=22 (after wrap range)`);
  // Same-scanline behavior (Bauer §3.8 9-bit X-MSB): the wrap stays on this
  // line. With per-line side buffers (#1) there is no next-line storage to
  // bleed into — vertical bleed is structurally impossible — so the wrap is
  // fully characterized by the same-line checks above (22px at X 0..21, none
  // at X≥22).
  ok(`Bauer §3.8: sprite at canvas X=502 wraps 22 pixels to canvas X=0..21 SAME line`);
}

// ── 3: Wrap pixels reflect post-off-canvas shifter state (2 advances) ──
// Shifter = 0xFEDCBA. Off-canvas advance of 2 pixels (single-color
// non-x-expand → 1 pixel-per-unit, so shifter shifts 2 bits).
// Visible bits = (0xFEDCBA << 2) & 0xFFFFFF = 0xFB72E8.
//   Bit 23 = 1 → canvas X=0 is fg.
//   Bit 22 = 1 → canvas X=1 is fg.
//   Bit 21 = 1 → canvas X=2 is fg.
//   ... etc.
{
  const vic = makeVic();
  setupSprite(vic, 0, 494, { shiftReg: 0xFEDCBA });
  vic._renderSpriteLine(50, 35);
  const ro = 35 * CANVAS_W;
  // 0xFB72E8 = 1111 1011 0111 0010 1110 1000
  // Bit 23 down: 1,1,1,1, 1,0,1,1, 0,1,1,1, 0,0,1,0, ...
  expect(vic.spriteOwnerBuffer[0] === 0, `wrap pixel 0 at X=0: bit-23=1, paint`);
  expect(vic.spriteOwnerBuffer[1] === 0, `wrap pixel 1 at X=1: bit-22=1, paint`);
  expect(vic.spriteOwnerBuffer[5] === 0xFF, `wrap pixel 5 at X=5: bit-18=0, no paint`);
  ok(`Bauer §3.8: off-canvas advance correctly shifts the wrap state`);
}

// ── 4: X-expanded high-X sprite DOES wrap (Bauer §3.8 rule 6, no expand exemption)
//
// Sprite at raw X=462 (canvas X=470), X-expanded → 48-tick emission.
// Canvas geometry (matching test 2's same-line wrap convention):
//   - canvas X 0..7   ← raw X 496..503 (overscan-left, VISIBLE)
//   - canvas X 8..383 ← raw X 0..375  (canvas-visible)
//   - canvas X 384..503 ← raw X 376..495 (off-canvas-right)
//   - canvas X 504..511 ← raw X 504..511 = $1F8..$1FF invisible band
// Per Bauer §3.8 closing paragraph the X counter skips $1F8..$1FF,
// wrapping $1F7 → $000.
//
// 48-tick emission walk for raw X=462:
//   - ticks  0..33 at raw X 462..495 → canvas X 470..503 (off-canvas right) — 0 visible
//   - ticks 34..41 at raw X 496..503 → canvas X 0..7 (overscan-left, VISIBLE) — 8 visible
//   - counter wraps $1F7→$000, skipping $1F8..$1FF
//   - ticks 42..47 at raw X 0..5    → canvas X 8..13 — 6 visible
// → Total 14 visible pixels at canvas X 0..13.
//
// Bauer §3.8 rule 6 (verbatim): "the shift register is shifted left by
// one bit with every pixel … If the MxXE bit … is set, the register is
// only shifted every second pixel and the sprite thus appears twice as
// wide." NO exemption from the wrap mechanism — X-expand only changes
// the SHIFT RATE.
{
  const vic = makeVic();
  setupSprite(vic, 0, 462, { xExpand: true });   // canvas X=470
  vic._renderSpriteLine(50, 35);
  const ro = 35 * CANVAS_W;
  let painted = 0;
  const paintedX = [];
  for (let x = 0; x < 32; x++) {
    if (vic.spriteOwnerBuffer[x] === 0) { painted++; paintedX.push(x); }
  }
  expect(painted === 14,
    `Bauer §3.8 r6 + same-line wrap: X-expanded sprite at raw X=462 emits 48 ticks: ` +
    `34 off-canvas + 8 overscan-left (canvas X 0..7, raw X 496..503) + 6 wrapped past ` +
    `$1F8..$1FF skip (canvas X 8..13, raw X 0..5) = 14 visible. ` +
    `Got ${painted} at X=[${paintedX.join(',')}].`);
  // Verify the contiguous visible span is canvas X 0..13.
  for (let x = 0; x < 14; x++) {
    expect(vic.spriteOwnerBuffer[x] === 0,
      `X-expanded wrap: canvas X=${x} must be painted`);
  }
  // And no paint at canvas X 14..31.
  for (let x = 14; x < 32; x++) {
    expect(vic.spriteOwnerBuffer[x] === 0xFF,
      `X-expanded wrap: canvas X=${x} must NOT be painted (past shifter end)`);
  }
  ok(`Bauer §3.8 rule 6: X-expanded sprite at raw X=462 wraps 14 pixels to canvas X 0..13 (no expand exemption)`);
}

// ── 5: Sprite ending exactly at canvas-right (X=360, end=384): no wrap
{
  const vic = makeVic();
  setupSprite(vic, 0, 352);   // canvas X=360
  vic._renderSpriteLine(50, 35);
  const ro = 35 * CANVAS_W;
  let painted = 0;
  for (let x = 360; x < 384; x++) {
    if (vic.spriteOwnerBuffer[x] === 0) painted++;
  }
  expect(painted === 24, `sprite at X=360 paints all 24 pixels, got ${painted}`);
  for (let x = 0; x < 32; x++) {
    expect(vic.spriteOwnerBuffer[x] === 0xFF, `no wrap paint at X=${x}`);
  }
  ok(`sprite ending at canvas-right boundary doesn't wrap`);
}

// ── 6: Sprite at canvas X exactly = line-wrap (504): full sprite wraps
// Sprite at canvas X=504 has 0 off-canvas pixels; all 24 pixels paint
// at canvas X=0..23 of the SAME line (504 mod 504 = 0).
{
  const vic = makeVic();
  setupSprite(vic, 0, 496);  // canvas X=504
  vic._renderSpriteLine(50, 35);
  const ro = 35 * CANVAS_W;
  let painted = 0;
  for (let x = 0; x < 24; x++) {
    if (vic.spriteOwnerBuffer[x] === 0) painted++;
  }
  expect(painted === 24,
    `full wrap paints 24 pixels at canvas X=0..23, got ${painted}`);
  ok(`sprite at canvas X=line-wrap boundary: full sprite wraps to canvas X=0..23`);
}

// ── 7: Wrap pixel paint gated by borderBuffer (closed-border check) ────
{
  const vic = makeVic();
  setupSprite(vic, 0, 494);
  // Force closed border in left side BEFORE sprite render.
  const ro = 35 * CANVAS_W;
  vic._initRenderRasterLine(50, 35);
  vic.borderBuffer.fill(1, 0, 32);
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleHBorderBefore[cycle] = 1;
    vic.lineCycleHBorder[cycle] = 1;
  }
  setupSprite(vic, 0, 494);
  // Re-set borders to closed in left side (setupSprite cleared them).
  for (let cycle = 1; cycle <= 14; cycle++) {
    vic.lineCycleHBorderBefore[cycle] = 1;
    vic.lineCycleHBorder[cycle] = 1;
  }
  vic.borderBuffer.fill(1, 0, 32);
  vic._renderSpriteLine(50, 35);
  let painted = 0;
  for (let x = 0; x < 22; x++) {
    if (vic.spriteOwnerBuffer[x] === 0) painted++;
  }
  expect(painted === 0,
    `closed left border: wrap pixels NOT painted (visibility-gated), got ${painted}`);
  ok(`wrap render respects borderBuffer (closed-side gating)`);
}

// ── 8: Wrap color sampled per-cycle, NOT from the wrap-detect cycle ────
// Real hw: sprite color registers ($D025/$D026/$D027+s) are sampled at
// the cycle each pixel paints. The wrap pixels paint at canvas X=8..21
// = cycles 12..14, so they pick up lineCycleRegs[12..14], not the
// cycle-58 capture. This matches a CPU mid-line write to $D026 (e.g.,
// OrbitUntold's cycle-45 rasterbar update) — the write affects later
// inner-display sprite paints AFTER cycle 45, but does NOT retroactively
// change the wrap pixels at canvas X=8..21 (which already sampled their
// colors at cycles 12..14, BEFORE cycle 45's write).
{
  const vic = makeVic();
  // Multi-color sprite at canvas X=502 → wraps 14 pixels at X=8..21.
  // mc0 (D025) and mc1 (D026) chosen distinctly per cycle so we can
  // verify the per-cycle sampling.
  vic.regs[0x1C] = 0x01;             // sp0 multicolor
  setupSprite(vic, 0, 494);
  // Override D026 PER CYCLE: cycles 12..14 use $0e (LightRed),
  // cycles 45..58 use $05 (Green). Wrap should paint LightRed.
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleRegs[cycle][0x1C] = 0x01;
    vic.lineCycleRegs[cycle][0x25] = 0x00;
    if (cycle <= 14) vic.lineCycleRegs[cycle][0x26] = 0x0e;     // LightRed
    else if (cycle >= 45) vic.lineCycleRegs[cycle][0x26] = 0x05;  // Green
    else vic.lineCycleRegs[cycle][0x26] = 0x0e;
  }
  vic._renderSpriteLine(50, 35);
  const ro = 35 * CANVAS_W;
  // Idx 14 (LightRed in our palette) — verify by computing expected.
  // Sampler uses lineCycleRegs[12][0x26] for canvas X=8..15.
  const C64_PALETTE_LIGHTRED = 0xff_eb6d70 >>> 0;     // PAL_RGBA(14)
  const C64_PALETTE_GREEN = 0xff_4dac56 >>> 0;        // PAL_RGBA(5)
  // Wrap pixels at X=8..15 should be LightRed (cycle 12's mc1).
  expect(vic.fb32[ro + 8] === C64_PALETTE_LIGHTRED,
    `wrap X=8 uses cycle-12's D026 (LightRed), got 0x${(vic.fb32[ro+8]&0xFFFFFF).toString(16)}`);
  expect(vic.fb32[ro + 15] === C64_PALETTE_LIGHTRED,
    `wrap X=15 uses cycle-12's D026 (LightRed), got 0x${(vic.fb32[ro+15]&0xFFFFFF).toString(16)}`);
  // Wrap pixels at X=16..21 use cycle-13's D026 (also LightRed in this setup).
  expect(vic.fb32[ro + 16] === C64_PALETTE_LIGHTRED,
    `wrap X=16 uses cycle-13's D026 (LightRed), got 0x${(vic.fb32[ro+16]&0xFFFFFF).toString(16)}`);
  ok(`Bauer §3.8: wrap samples sprite color registers PER CYCLE during paint`);
}

// ── 9: Mid-line $D026 write does NOT retroactively change wrap pixels ──
// OrbitUntold pattern: D026 is written at cycle 45 with the rasterbar
// color for the NEXT line. The wrap pixels (canvas X=8..21 = cycles
// 12..14) sample D026 from THOSE cycles' captures, which still hold
// the PRIOR D026 value (= color intended for THIS line). This makes
// the rasterbar's left-border wrap visually align with the current
// line's inner display + right border.
{
  const vic = makeVic();
  vic.regs[0x1C] = 0x01;
  setupSprite(vic, 0, 494);
  // Cycles 12..14 capture D026=$0a (= "this line's color"), cycle 45+
  // captures D026=$0d (= "next line's color"). Wrap should use $0a.
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleRegs[cycle][0x1C] = 0x01;
    vic.lineCycleRegs[cycle][0x25] = 0x00;
    vic.lineCycleRegs[cycle][0x26] = (cycle >= 45) ? 0x0d : 0x0a;
  }
  vic._renderSpriteLine(50, 35);
  const ro = 35 * CANVAS_W;
  const PAL_0A = 0xff_716cc4 >>> 0;     // PAL_RGBA(10) — Light Purple
  const PAL_0D = 0xff_9fffa9 >>> 0;     // PAL_RGBA(13) — Light Green
  // Wrap pixels at canvas X=8..21 use cycles 12..14 — pre-cycle-45 D026 = $0a.
  expect(vic.fb32[ro + 8] === PAL_0A,
    `wrap X=8: D026 from cycle 12 = $0a, got 0x${(vic.fb32[ro+8]&0xFFFFFF).toString(16)}`);
  expect(vic.fb32[ro + 20] === PAL_0A,
    `wrap X=20: D026 from cycle 13 = $0a, got 0x${(vic.fb32[ro+20]&0xFFFFFF).toString(16)}`);
  // Verify cycle 12+ regs do reflect this (sanity check the test setup).
  expect(vic.lineCycleRegs[12][0x26] === 0x0a,
    `setup sanity: lineCycleRegs[12][0x26] = $0a`);
  expect(vic.lineCycleRegs[45][0x26] === 0x0d,
    `setup sanity: lineCycleRegs[45][0x26] = $0d (the late write)`);
  ok(`OrbitUntold rasterbar: cycle-45 D026 update does NOT retroactively color wrap`);
}

// ── 10: Wrap pixels latch $D01F against REAL foreground graphics
// Integration test (no graphicsCollisionBuffer poking). X-expanded
// sprite 0 at raw X=488 (canvas X=496) emits 48 ticks: 8 off-canvas
// (4 units consumed @ 2 px/unit) + 40 wrapped at canvas X=0..39. The
// last 8 wrap pixels (canvas X=32..39) overlap the FIRST column of the
// active display window, where glyph $01 row 0 = 0xFF makes the graphics
// data sequencer emit fg=1. Sprite + fg coincidence latches $D01F bit 0
// — Bauer §3.11.2 verified end-to-end through `_renderRasterLine`.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;             // text mode, DEN=1, RSEL=1
  vic.regs[0x16] = 0x08;             // CSEL=1
  vic.regs[0x18] = 0x10;             // CB=0, screen=$0400
  vic.regs[0x21] = 0x06;
  vic.ram[8] = 0xFF;                 // glyph $01 row 0 — all fg in std text
  // Per-cycle text-display state across the line (open borders).
  for (let cycle = 0; cycle <= 63; cycle++) {
    vic.lineCycleRegs[cycle].set(vic.regs);
    vic.lineCycleHBorderBefore[cycle] = 0;
    vic.lineCycleHBorder[cycle]       = 0;
    vic.lineCycleVBorderBefore[cycle] = 0;
    vic.lineCycleVBorder[cycle]       = 0;
    vic.lineCycleDisplayActive[cycle] = 1;
    vic.lineCycleDisplayColumnActive[cycle] = 1;
    vic.lineCycleBanks[cycle] = 0;
    vic.lineCycleHInner[cycle] = 1;
  }
  // Plant glyph $01 with color $07 at every column for the c-access window.
  for (let cycle = 15; cycle <= 58; cycle++) {
    for (let col = 0; col < 40; col++) {
      vic.lineCycleRowFetchedCols[cycle][col] = 1;
      vic.lineCycleRowCodes[cycle][col] = 1;
      vic.lineCycleRowColors[cycle][col] = 0x07;
    }
  }
  // X-expanded sprite 0 at raw X=488 (canvas X=496 → wraps to canvas X=0..39).
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleRegs[cycle][0x15] |= 0x01;
    vic.lineCycleRegs[cycle][0]     = 488 & 0xFF;
    vic.lineCycleRegs[cycle][0x10] |= 0x01;      // X-MSB
    vic.lineCycleRegs[cycle][0x1D] |= 0x01;      // X-expand for sp0
    vic.lineCycleRegs[cycle][0x27]  = 0x07;
    vic.lineCycleSpriteDisplayOn[cycle][0]   = 1;
    vic.lineCycleSpriteDataRow[cycle][0]     = 0;
    vic.lineCycleSpriteRowByteMask[cycle][0] = 0x07;
    vic.lineCycleSpriteShiftReg[cycle][0]    = 0xFFFFFF;
  }
  const raster = 60;
  vic._renderRasterLine(raster);
  expect(vic.regs[0x1F] === 0x01,
    `wrap-region sprite over real fg latches $D01F=$01, got $${vic.regs[0x1F].toString(16)}`);
  expect(vic.regs[0x1E] === 0,
    `no other sprite present → $D01E stays 0, got $${vic.regs[0x1E].toString(16)}`);
  ok('Bauer §3.11.2: X-expanded wrap sprite vs real text-mode fg in display window latches $D01F');
}

// ── 11: Wrap pixels collide with another sprite at the same canvas X
// Sprite 0 wraps to canvas X=0..21. Sprite 1 at raw X=0 paints at canvas
// X=8..31 (no wrap). They overlap at canvas X=8..21. The renderer iterates
// s=0..7, so sprite 0's wrap pixels write spriteCollisionBuffer bit 0 first,
// then sprite 1's sequencer sees it and latches $D01E bits 0+1.
{
  const vic = makeVic();
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleRegs[cycle].set(vic.regs);
    // Sprite 0 at raw X=494 (canvas X=502 → wraps).
    vic.lineCycleRegs[cycle][0x15] |= 0x01;
    vic.lineCycleRegs[cycle][0]    = 494 & 0xFF;
    vic.lineCycleRegs[cycle][0x10] |= 0x01;       // X-MSB for sprite 0
    vic.lineCycleRegs[cycle][0x27] = 0x02;
    vic.lineCycleSpriteDisplayOn[cycle][0]    = 1;
    vic.lineCycleSpriteDataRow[cycle][0]      = 0;
    vic.lineCycleSpriteRowByteMask[cycle][0]  = 0x07;
    vic.lineCycleSpriteShiftReg[cycle][0]     = 0xFFFFFF;
    // Sprite 1 at raw X=0 (canvas X=8, no wrap).
    vic.lineCycleRegs[cycle][0x15] |= 0x02;
    vic.lineCycleRegs[cycle][2]    = 0;
    vic.lineCycleRegs[cycle][0x28] = 0x07;
    vic.lineCycleSpriteDisplayOn[cycle][1]    = 1;
    vic.lineCycleSpriteDataRow[cycle][1]      = 0;
    vic.lineCycleSpriteRowByteMask[cycle][1]  = 0x07;
    vic.lineCycleSpriteShiftReg[cycle][1]     = 0xFFFFFF;
    vic.lineCycleHBorderBefore[cycle] = 0;
    vic.lineCycleHBorder[cycle]       = 0;
    vic.lineCycleVBorderBefore[cycle] = 0;
    vic.lineCycleVBorder[cycle]       = 0;
  }
  vic._renderSpriteLine(50, 35);
  // Tight latch assertions — no other sprites enabled, no graphics fg set.
  expect(vic.regs[0x1E] === 0x03,
    `$D01E === $03 (sp0+sp1 only, no spurious bits), got $${vic.regs[0x1E].toString(16)}`);
  expect(vic.regs[0x1F] === 0,
    `no graphics fg → $D01F stays 0, got $${vic.regs[0x1F].toString(16)}`);
  ok('Bauer §3.11.1: wrap-region sprite vs non-wrap sprite at same canvas X latches sprite-sprite collision');
}

// ── 12: Sprite-X in the $1F8..$1FF invisible band paints zero ──────────
// Bauer §3.8 (closing paragraph): the horizontal counter skips raw X
// $1F8..$1FF (504..511), wrapping $1F7→$000. A sprite whose X-coordinate
// is in that band is never reached by the comparator → not displayed.
// raw X=504 ($1F8) is the first dead-zone coordinate.
{
  const vic = makeVic();
  setupSprite(vic, 0, 504);   // $1F8 — first invisible-band coordinate
  vic._renderSpriteLine(50, 35);
  const ro = 35 * CANVAS_W;
  let painted = 0;
  for (let x = 0; x < CANVAS_W; x++) {
    if (vic.spriteOwnerBuffer[x] === 0) painted++;
  }
  expect(painted === 0,
    `sprite-X=504 ($1F8): X counter skips this coordinate → 0 pixels, got ${painted}`);
  ok(`Bauer §3.8: sprite-X=504 ($1F8, invisible band) paints zero pixels`);
}

// ── 13: raw X=511 ($1FF) paints zero — no modular alias onto canvas X=15
// The modular canvas mapping would alias raw X=511 (sx=519) onto canvas
// X=(519 mod 504)=15. The dead-zone guard must prevent that phantom.
{
  const vic = makeVic();
  setupSprite(vic, 0, 511);   // $1FF — last invisible-band coordinate
  vic._renderSpriteLine(50, 35);
  const ro = 35 * CANVAS_W;
  let painted = 0;
  for (let x = 0; x < CANVAS_W; x++) {
    if (vic.spriteOwnerBuffer[x] === 0) painted++;
  }
  expect(painted === 0,
    `sprite-X=511 ($1FF): 0 pixels (no canvas X=15 alias), got ${painted}`);
  expect(vic.spriteOwnerBuffer[15] === 0xFF,
    `no phantom paint at the modular-alias target canvas X=15`);
  ok(`Bauer §3.8: sprite-X=511 ($1FF) paints zero — no modular alias onto canvas X=15`);
}

// ── 14: Two sprites at raw X=511 do NOT collide ($D01E stays 0) ────────
// Direct regression for VICII/spritecollisions sprite-sprite.prg entry 9
// (X=511 → expected no collision). Both single-pixel sprites sit in the
// invisible band, so neither displays and the sprite-sprite latch ($D01E)
// must remain 0.
{
  const vic = makeVic();
  setupSprite(vic, 0, 511);
  setupSprite(vic, 1, 511);
  vic._renderSpriteLine(50, 35);
  expect(vic.regs[0x1E] === 0,
    `two sprites at X=511 (invisible band): no collision, $D01E=$${vic.regs[0x1E].toString(16)}`);
  ok(`Bauer §3.8/§3.11: two sprites in the $1F8..$1FF band do not collide`);
}

// ── 15: Boundary — raw X=503 ($1F7, last reachable) STILL displays ─────
// 503 is the last coordinate the X counter reaches; its 24-px body wraps
// (pixel 0 at canvas X=(511 mod 504)=7). Pins the band edge: 503 paints,
// 504 does not.
{
  const vic = makeVic();
  setupSprite(vic, 0, 503);   // $1F7 — last reachable coordinate
  vic._renderSpriteLine(50, 35);
  const ro = 35 * CANVAS_W;
  let painted = 0;
  for (let x = 0; x < CANVAS_W; x++) {
    if (vic.spriteOwnerBuffer[x] === 0) painted++;
  }
  expect(painted === 24,
    `sprite-X=503 ($1F7): last reachable coord wraps & paints 24 px, got ${painted}`);
  expect(vic.spriteOwnerBuffer[7] === 0,
    `sprite-X=503: pixel 0 at canvas X=7 (511 mod 504)`);
  ok(`Bauer §3.8: sprite-X=503 ($1F7) is the last reachable coordinate — still displays`);
}

// ── 16: spritegap3 final-row collision gap starts before the PRG log edge ─
// VICII/spritegap3's old-PAL dumps show the final sprite row stops colliding
// at logged X=$163/$164. This direct helper observes the internal collision
// window one pixel earlier than the CPU-visible PRG log.
{
  expect(spritegap3Collision(0, 1, 0x161) === 0x03,
    `sp0+sp1: X=$161 still collides before the direct $162 boundary`);
  expect(spritegap3Collision(0, 1, 0x162) === 0x00,
    `sp0+sp1: X=$162 enters the direct no-collision spritegap window`);
  expect(spritegap3Collision(1, 2, 0x162) === 0x06,
    `sp1+sp2: X=$162 still collides; nonzero lower sprite has the +1 boundary`);
  expect(spritegap3Collision(1, 2, 0x163) === 0x00,
    `sp1+sp2: X=$163 enters the direct no-collision spritegap window`);
  ok('VICII/spritegap3: direct final-row collision gap front edge precedes the PRG log by one pixel');
}

// ── 17: spritegap3 right-border restart is sprite-slot dependent ───────
// After the no-collision window, old PAL restarts final-row sprite-sprite
// collision in the physical right border. This direct helper sees the
// internal restart one pixel before spritegap3's CPU-visible log: sp1 at
// $17e, sp2 at $18e, ... sp7 at $1de. The PRG comparison pins the logged
// $17f/$18f/... values after the collision visibility pipeline.
{
  const cases = [
    [0, 1, 0x17e, 0x03],
    [0, 2, 0x18e, 0x05],
    [1, 2, 0x18e, 0x06],
    [0, 7, 0x1de, 0x81],
    [6, 7, 0x1de, 0xc0],
  ];
  for (const [n, m, restart, mask] of cases) {
    expect(spritegap3Collision(n, m, restart - 1) === 0x00,
      `sp${n}+sp${m}: X=$${(restart - 1).toString(16)} is still inside the gap`);
    expect(spritegap3Collision(n, m, restart) === mask,
      `sp${n}+sp${m}: X=$${restart.toString(16)} restarts collision with mask $${mask.toString(16)}`);
  }
  ok('VICII/spritegap3: right-border collision restart follows the later sprite slot');
}

// ── 18: spritegap3 still respects the $1F8..$1FF unreachable band ──────
// The restart never overrides Bauer §3.8's skipped X-counter range.
{
  expect(spritegap3Collision(0, 1, 0x1f6) === 0x03,
    `sp0+sp1: X=$1f6 is the last colliding position before the dead band`);
  expect(spritegap3Collision(0, 1, 0x1f7) === 0x00,
    `sp0+sp1: X=$1f7 leaves no collision because sprite m is at $1f8`);
  expect(spritegap3Collision(6, 7, 0x1f6) === 0xc0,
    `sp6+sp7: X=$1f6 is the last colliding position before the dead band`);
  expect(spritegap3Collision(6, 7, 0x1f7) === 0x00,
    `sp6+sp7: X=$1f7 leaves no collision because sprite m is at $1f8`);
  ok('Bauer §3.8 + spritegap3: right-border restart does not make $1F8..$1FF reachable');
}

console.log(`\n${testNo} sprite-X-wrap spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
