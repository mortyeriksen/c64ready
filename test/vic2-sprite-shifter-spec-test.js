// Sprite shifter sub-pixel cadence spec audit. 10 tests derived from
// Bauer §3.8.2 / §3.8.3 — the per-pixel shift rate of the sprite shift
// register based on multicolor / X-expand mode.
//
// Cadence rules:
//   standard          : 1 bit per canvas pixel, 24 bits = 24 px
//   X-expanded        : 1 bit per 2 canvas pixels, 24 bits = 48 px
//   multicolor        : 2 bits per 2 canvas pixels (pair), 12 pairs = 24 px
//   multicolor+X-exp  : 2 bits per 4 canvas pixels, 12 pairs = 48 px

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

// ── 1: Standard sprite consumes 1 bit per canvas pixel (24 bits = 24 px)
{
  const vic = makeVic();
  const state = vic._createSpriteRenderState(0xFFFFFF, 0x07, 100, 100, false, false);
  expect(state.unitsRemaining === 24,
    `standard: 24 bit-units total, got ${state.unitsRemaining}`);
  ok('Bauer §3.8.2: standard sprite has 24 single-bit units (24-pixel width)');
}

// ── 2: Multicolor sprite uses 12 pair-units ────────────────────────────
{
  const vic = makeVic();
  const state = vic._createSpriteRenderState(0xFFFFFF, 0x07, 100, 100, true, false);
  expect(state.unitsRemaining === 12,
    `multicolor: 12 pair-units, got ${state.unitsRemaining}`);
  ok('Bauer §3.8.2: multicolor sprite has 12 pair-units (24 px = 12 × 2)');
}

// ── 3: X-expanded standard sprite still 24 units (each 2 px wide) ──────
{
  const vic = makeVic();
  const state = vic._createSpriteRenderState(0xFFFFFF, 0x07, 100, 100, false, true);
  expect(state.unitsRemaining === 24,
    `X-expanded: 24 bit-units (each 2 px wide), got ${state.unitsRemaining}`);
  ok('Bauer §3.8.2: X-expanded standard sprite = 24 units × 2 px = 48 canvas px');
}

// ── 4: Multicolor + X-expanded = 12 units × 4 px = 48 canvas pixels ────
{
  const vic = makeVic();
  const state = vic._createSpriteRenderState(0xFFFFFF, 0x07, 100, 100, true, true);
  expect(state.unitsRemaining === 12,
    `MC+X-exp: 12 units, got ${state.unitsRemaining}`);
  ok('Bauer §3.8.2: multicolor + X-exp = 12 pairs × 4 px = 48 canvas px');
}

// ── 5: pixelPhase starts at 0 when currentX == spriteX ─────────────────
{
  const vic = makeVic();
  const state = vic._createSpriteRenderState(0xFFFFFF, 0x07, 100, 100, true, true);
  expect(state.pixelPhase === 0,
    `currentX = spriteX: pixelPhase must start at 0`);
  ok('Bauer §3.8.2: shifter pixelPhase = 0 when sprite first appears');
}

// ── 6: Skipped pixels reduce unitsRemaining via consumedUnits ──────────
// If currentX > spriteX (some pixels were already drawn elsewhere), the
// state must reflect that progress: unitsRemaining < total.
{
  const vic = makeVic();
  // Standard sprite at X=100, currentX=110 → 10 pixels skipped = 10 units.
  const state = vic._createSpriteRenderState(0xFFFFFF, 0x07, 100, 110, false, false);
  expect(state.unitsRemaining === 14,
    `currentX 10 ahead of spriteX: 24-10=14 units left, got ${state.unitsRemaining}`);
  ok('Bauer §3.8.2: shifter advance reflects already-drawn pixels');
}

// ── 7: Multicolor consumes 2 pixels per unit; consumedUnits divides ────
{
  const vic = makeVic();
  // MC sprite at X=100, currentX=104 → 4 pixels skipped = 2 pair-units.
  const state = vic._createSpriteRenderState(0xFFFFFF, 0x07, 100, 104, true, false);
  expect(state.unitsRemaining === 10,
    `MC: 4 px = 2 pair-units consumed; 12-2=10 left, got ${state.unitsRemaining}`);
  ok('Bauer §3.8.2: MC shifter consumes 2 px per pair-unit');
}

// ── 8: X-expand consumes 2 pixels per bit; advance state across 2 px ───
// _advanceSpriteSequencerState bumps pixelPhase first; at threshold, shifts.
{
  const vic = makeVic();
  const state = vic._createSpriteRenderState(0x800000, 0x07, 100, 100, false, true);
  state.pixelsPerUnit = 2;
  expect(state.unitsRemaining === 24, `pre: 24 units`);
  // Advance once: pixelPhase goes 0→1, no shift yet.
  vic._advanceSpriteSequencerState(state, false, true);
  expect(state.unitsRemaining === 24,
    `X-exp: pixel 1 doesn't shift (pixelPhase 0→1)`);
  // Advance again: pixelPhase 1→2 ≥ 2, shift fires, unitsRemaining decreases.
  vic._advanceSpriteSequencerState(state, false, true);
  expect(state.unitsRemaining === 23,
    `X-exp: pixel 2 shifts (pixelPhase reset, units 24→23)`);
  ok('Bauer §3.8.2: X-expanded shifter shifts every 2nd canvas pixel');
}

// ── 9: Multicolor + X-expand: shift every 4 canvas pixels ──────────────
{
  const vic = makeVic();
  const state = vic._createSpriteRenderState(0xC00000, 0x07, 100, 100, true, true);
  state.pixelsPerUnit = 4;
  expect(state.unitsRemaining === 12, `pre: 12 units`);
  for (let i = 0; i < 3; i++) vic._advanceSpriteSequencerState(state, true, true);
  expect(state.unitsRemaining === 12,
    `MC+X-exp: 3 pixels in, no shift yet`);
  vic._advanceSpriteSequencerState(state, true, true);
  expect(state.unitsRemaining === 11,
    `MC+X-exp: 4th pixel shifts (12→11)`);
  ok('Bauer §3.8.2: MC + X-exp shifter shifts every 4th canvas pixel');
}

// ── 10: Multicolor pair decode rules (Bauer §3.8.3) ────────────────────
// Pair value 00 → transparent; 01 → mc1; 10 → sprColor; 11 → mc2.
{
  const vic = makeVic();
  const validMask = 0xFFFFFF;
  const sprColor = 0x42, mc0 = 0x01, mc1 = 0x99;
  // 00 → transparent
  let info = vic._spriteSequencerPixelInfo(0x000000, validMask, true, mc0, mc1, sprColor);
  expect(info.draw === false, `MC pair 00: transparent`);
  // 01 → mc1
  info = vic._spriteSequencerPixelInfo(0x400000, validMask, true, mc0, mc1, sprColor);
  expect(info.draw === true && info.color === mc0, `MC pair 01 → mc0`);
  // 10 → sprColor
  info = vic._spriteSequencerPixelInfo(0x800000, validMask, true, mc0, mc1, sprColor);
  expect(info.draw === true && info.color === sprColor, `MC pair 10 → sprColor`);
  // 11 → mc2
  info = vic._spriteSequencerPixelInfo(0xC00000, validMask, true, mc0, mc1, sprColor);
  expect(info.draw === true && info.color === mc1, `MC pair 11 → mc1`);
  ok('Bauer §3.8.3: multicolor pair decode 00=trans 01=mc0 10=spr 11=mc1');
}

console.log(`\n${testNo} sprite-shifter sub-pixel spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
