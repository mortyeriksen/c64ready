// Sprite sub-pixel phase / shifter cadence spec audit. Per Bauer
// §3.8.2 + §3.8.3:
//
//   Standard sprite (24 px wide):       1 bit per canvas pixel,
//                                       24 single-bit "units" total
//   X-expanded standard (48 px wide):   1 bit per 2 canvas pixels,
//                                       still 24 bit-units total
//   Multicolor (24 px wide):            1 pair per 2 canvas pixels,
//                                       12 pair-units total (24 px)
//   X-expanded multicolor (48 px wide): 1 pair per 4 canvas pixels,
//                                       12 pair-units total (48 px)
//
// Across segment boundaries (the renderer chunks the line into VIC
// cycle segments), the shifter MUST advance continuously — splitting
// across segments must not skip or repeat a unit. This test exercises
// the per-pixel state machine to verify cadence correctness.
//
// nine.prg / Commando relevance: sprites that span segment boundaries
// (most do, since segments are 8-pixel-wide) need consistent shifter
// state across the boundary. A bug in the boundary-handoff would
// produce off-by-one or doubled pixels.

import { VIC2 } from '../src/vic2.js';

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

// ── 1: Standard sprite — 24 single-bit units across 24 canvas pixels ─
{
  const vic = makeVic();
  // shiftReg with all 24 bits valid; rowByteMask=0x07 means 3 bytes valid
  const state = vic._createSpriteRenderState(0xFFFFFF, 0x07, 100, 100, false, false);
  expect(state.unitsRemaining === 24,
    `standard: 24 units expected, got ${state.unitsRemaining}`);
  // Advance through 24 single-bit units
  for (let i = 0; i < 24; i++) {
    vic._advanceSpriteSequencerState(state, false, false);
  }
  expect(state.unitsRemaining === 0,
    `after 24 advances: 0 remaining, got ${state.unitsRemaining}`);
  ok('Bauer §3.8.2: standard sprite — 24 single-bit units = 24 px');
}

// ── 2: X-expanded standard — 24 units across 48 canvas pixels ───────
// Each unit consumes 2 canvas pixels (xExp doubles width).
{
  const vic = makeVic();
  const state = vic._createSpriteRenderState(0xFFFFFF, 0x07, 100, 100, false, true);
  state.pixelsPerUnit = 2;             // x-exp: 2 px per unit (set by renderer)
  expect(state.unitsRemaining === 24, `x-exp standard: 24 units`);
  // Each call advances by 1 canvas pixel; need 48 calls total to consume.
  for (let i = 0; i < 48; i++) {
    vic._advanceSpriteSequencerState(state, false, true);
  }
  expect(state.unitsRemaining === 0,
    `x-exp standard: 48 px advances → 0 units, got ${state.unitsRemaining}`);
  ok('Bauer §3.8.2: X-exp standard — 24 units × 2 px each = 48 px');
}

// ── 3: Multicolor sprite — 12 pair-units across 24 px ────────────────
{
  const vic = makeVic();
  const state = vic._createSpriteRenderState(0xFFFFFF, 0x07, 100, 100, true, false);
  state.pixelsPerUnit = 2;             // mc: 2 px per pair-unit
  expect(state.unitsRemaining === 12, `mc: 12 pair-units`);
  for (let i = 0; i < 24; i++) {
    vic._advanceSpriteSequencerState(state, true, false);
  }
  expect(state.unitsRemaining === 0,
    `mc: 24 px advances → 0 units, got ${state.unitsRemaining}`);
  ok('Bauer §3.8.2: multicolor — 12 pair-units × 2 px each = 24 px');
}

// ── 4: X-expanded multicolor — 12 pair-units across 48 px ────────────
{
  const vic = makeVic();
  const state = vic._createSpriteRenderState(0xFFFFFF, 0x07, 100, 100, true, true);
  state.pixelsPerUnit = 4;             // mc + x-exp: 4 px per pair-unit
  expect(state.unitsRemaining === 12, `mc+xexp: 12 pair-units`);
  for (let i = 0; i < 48; i++) {
    vic._advanceSpriteSequencerState(state, true, true);
  }
  expect(state.unitsRemaining === 0,
    `mc+xexp: 48 px advances → 0 units, got ${state.unitsRemaining}`);
  ok('Bauer §3.8.2: MC+X-exp — 12 pair-units × 4 px each = 48 px');
}

// ── 5: currentX-resume mid-sprite (segment boundary handoff) ─────────
// When the renderer crosses a segment boundary mid-sprite, it creates
// a new render state with currentX > spriteX. The state must correctly
// account for already-consumed pixels.
{
  const vic = makeVic();
  // Standard sprite at X=100. Resume at X=108 (8 pixels into sprite).
  const state = vic._createSpriteRenderState(0xFFFFFF, 0x07, 100, 108, false, false);
  // 8 px consumed = 8 units. 16 units remaining.
  expect(state.unitsRemaining === 16,
    `standard sprite resumed at +8 px: 16 units remaining, got ${state.unitsRemaining}`);
  ok('Bauer §3.8.2: segment-boundary resume preserves sprite progress');
}

// ── 6: X-exp resume mid-sprite — units = ceil((48-consumed)/2) ──────
// X-exp doubles pixel width. Consumed 8 canvas pixels = 4 units. 20 left.
{
  const vic = makeVic();
  const state = vic._createSpriteRenderState(0xFFFFFF, 0x07, 100, 108, false, true);
  // 8 canvas pixels at 2-per-unit = 4 units consumed. 24-4 = 20 remaining.
  expect(state.unitsRemaining === 20,
    `x-exp std resumed at +8 px: 20 units remaining, got ${state.unitsRemaining}`);
  ok('Bauer §3.8.2: x-exp sprite resume math = (24 - floor(consumed/2)) units');
}

// ── 7: MC resume mid-pair — pixel phase odd preserves pair ──────────
// In multicolor mode, the pair lasts 2 canvas pixels. Resuming at an
// odd offset (e.g., +1 or +3) should retain the in-progress pair.
{
  const vic = makeVic();
  const state = vic._createSpriteRenderState(0xFFFFFF, 0x07, 100, 101, true, false);
  // 1 canvas pixel consumed = 0 full units; pair partially in flight.
  expect(state.unitsRemaining === 12,
    `mc resumed at +1 px: 12 units (pair not yet consumed), got ${state.unitsRemaining}`);
  expect(state.pixelPhase === 1,
    `mc pair half-consumed: pixelPhase=1, got ${state.pixelPhase}`);
  ok('Bauer §3.8.3: MC resume mid-pair retains in-flight pair (phase=1)');
}

// ── 8: Sprite shifter validMask mirrors rowByteMask ─────────────────
// The rowByteMask tracks which bytes of the 3-byte row are valid (e.g.,
// after a partial sprite-DMA fetch). The validMask gates which bits of
// the 24-bit shiftReg are emitted.
{
  const vic = makeVic();
  // All 3 bytes valid → top 24 bits valid
  const fullState = vic._createSpriteRenderState(0xFFFFFF, 0x07, 0, 0, false, false);
  expect((fullState.validMask & 0x800000) !== 0, `rowByteMask=0x07: bit 23 valid`);
  // Only first byte valid → only top 8 bits valid
  const partialState = vic._createSpriteRenderState(0xFF0000, 0x01, 0, 0, false, false);
  expect((partialState.validMask & 0x800000) !== 0,
    `rowByteMask=0x01: top byte (bits 16-23) valid`);
  expect((partialState.validMask & 0x008000) === 0,
    `rowByteMask=0x01: middle byte (bits 8-15) NOT valid`);
  ok('Bauer §3.8.2: sprite validMask gates output to fetched bytes only');
}

// ── 9: Pixel-info: fully transparent sprite returns draw=false ──────
// A sprite row with shiftReg=0 and rowByteMask=0x07 (all bytes "valid"
// but all zeros) outputs no pixels. This is the standard transparent-
// background behavior.
{
  const vic = makeVic();
  const info = vic._spriteSequencerPixelInfo(0x000000, vic._spriteValidMask(0x07), false, 0, 0, 0xFFFF0000);
  expect(info.draw === false,
    `transparent standard pixel: draw=false, got ${info.draw}`);
  ok('Bauer §3.8.2: standard sprite pixel with shifter bit = 0 is transparent');
}

// ── 10: MC pair=00 returns draw=false (transparent), pair !=00 draws
{
  const vic = makeVic();
  const validMask = vic._spriteValidMask(0x07);
  // Pair 00: bits 23,22 = 00 → transparent
  expect(vic._spriteSequencerPixelInfo(0x000000, validMask, true, 0, 0, 0).draw === false,
    `MC pair 00: transparent`);
  // Pair 01: bits 23,22 = 01 → opaque (sprMcol0)
  expect(vic._spriteSequencerPixelInfo(0x400000, validMask, true, 0, 0, 0).draw === true,
    `MC pair 01: opaque`);
  // Pair 10: bits 23,22 = 10 → opaque (sprite color)
  expect(vic._spriteSequencerPixelInfo(0x800000, validMask, true, 0, 0, 0).draw === true,
    `MC pair 10: opaque`);
  // Pair 11: bits 23,22 = 11 → opaque (sprMcol1)
  expect(vic._spriteSequencerPixelInfo(0xC00000, validMask, true, 0, 0, 0).draw === true,
    `MC pair 11: opaque`);
  ok('Bauer §3.8.2: MC pair 00 transparent, pairs 01/10/11 opaque');
}

console.log(`\n${testNo} sprite sub-pixel phase spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
