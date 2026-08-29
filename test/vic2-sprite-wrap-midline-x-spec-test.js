// Sprite-X horizontal wrap — mid-line X rewrite positioning (Bauer §3.8).
//
// A high-X sprite that WRAPS around the line end (rawX near 504) paints its
// wrapped-over pixels at the START of the scanline (canvas X ~0..width, cycles
// ~11..17). Those pixels are emitted EARLY in the line — before a CPU mid-line
// write to $D000-$D00E/$D010 that repositions the sprite for its right-edge
// (cy57) appearance. So the wrap must be positioned from the sprite X sampled
// EARLY in the line, NOT from the end-of-line register snapshot.
//
// Regression target: The Hat disc-2 "hyperscreen" end scroller. It is a pure
// fullscreen sprite scroller with all borders open; sprite 0 is X-expanded and
// parked at rawX 496/497, wrapping to fill the left border. For sub-pixel
// scroll it rewrites $D000 496<->497 mid-line every raster (a marching write),
// holding X for blocks of rasters in between. Positioning the wrap from the
// end-of-line X sheared the wrapped left-border glyph by 1px per raster and
// garbled the leftmost character of every line; VICE (x64sc, cold boot) renders
// it clean. Fix: _renderSpriteEndOfLineWrap samples X from lineCycleRegs[11].
//
// For a sprite whose X is stable across the line the early and late samples are
// equal, so this is a no-op there — every other case in
// vic2-sprite-x-wrap-spec-test.js (constant X) is unaffected.

import { VIC2, CANVAS_W } from '../src/vic2.js';

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
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  return vic;
}

// Per-cycle sprite 0 setup with an X that changes mid-line: rawX = earlyX for
// cycles 1..(flip-1), lateX for cycles flip..63. Open borders, solid shifter.
function setupMidlineWrap(vic, { earlyX, lateX, flip = 15, xExpand = false, shiftReg = 0xFFFFFF }) {
  for (let cycle = 1; cycle <= 63; cycle++) {
    const rawX = cycle < flip ? earlyX : lateX;
    vic.lineCycleRegs[cycle].set(vic.regs);
    vic.lineCycleRegs[cycle][0x15] |= 0x01;          // enable sprite 0
    vic.lineCycleRegs[cycle][0] = rawX & 0xFF;        // $D000
    if (rawX > 255) vic.lineCycleRegs[cycle][0x10] |= 0x01;  // X-MSB
    else vic.lineCycleRegs[cycle][0x10] &= ~0x01;
    if (xExpand) vic.lineCycleRegs[cycle][0x1D] |= 0x01;
    vic.lineCycleRegs[cycle][0x27] = 0x02;
    vic.lineCycleSpriteDisplayOn[cycle][0] = 1;
    vic.lineCycleSpriteDataRow[cycle][0] = 0;
    vic.lineCycleSpriteRowByteMask[cycle][0] = 0x07;
    vic.lineCycleSpriteShiftReg[cycle][0] = shiftReg >>> 0;
    vic.lineCycleHBorderBefore[cycle] = 0;
    vic.lineCycleHBorder[cycle] = 0;
    vic.lineCycleVBorderBefore[cycle] = 0;
    vic.lineCycleVBorder[cycle] = 0;
  }
}

// ── 1: early rawX=496 (wrapStart 0), late rawX=497 (wrapStart 1) ──────────
// The wrap must paint from canvas X=0 (early X), NOT canvas X=1 (late X).
// Solid 24px shifter → early X paints canvas 0..23; late X would paint 1..24.
{
  const vic = makeVic();
  setupMidlineWrap(vic, { earlyX: 496, lateX: 497 });
  vic._renderSpriteLine(50, 35);
  expect(vic.spriteOwnerBuffer[0] === 0,
    `canvas X=0 painted (wrap positioned from early rawX=496), got owner=$${vic.spriteOwnerBuffer[0].toString(16)}`);
  expect(vic.spriteOwnerBuffer[23] === 0,
    `canvas X=23 painted (last of 24 from early rawX=496)`);
  expect(vic.spriteOwnerBuffer[24] === 0xFF,
    `canvas X=24 NOT painted — end-of-line rawX=497 (wrapStart 1) must NOT govern, got owner=$${vic.spriteOwnerBuffer[24].toString(16)}`);
  ok(`mid-line 496->497: wrap positions from early X (canvas 0..23), not end-of-line X (1..24)`);
}

// ── 2: reversed — early rawX=497 (wrapStart 1), late rawX=496 (wrapStart 0) ─
// Now the early X is 497, so the wrap paints canvas 1..24; canvas X=0 stays
// clear. The end-of-line X (496) would have painted canvas 0..23 — proving the
// test is sensitive to which sample is used in BOTH directions.
{
  const vic = makeVic();
  setupMidlineWrap(vic, { earlyX: 497, lateX: 496 });
  vic._renderSpriteLine(50, 35);
  expect(vic.spriteOwnerBuffer[0] === 0xFF,
    `canvas X=0 NOT painted — end-of-line rawX=496 must NOT govern, got owner=$${vic.spriteOwnerBuffer[0].toString(16)}`);
  expect(vic.spriteOwnerBuffer[1] === 0,
    `canvas X=1 painted (wrap positioned from early rawX=497)`);
  expect(vic.spriteOwnerBuffer[24] === 0,
    `canvas X=24 painted (last of 24 from early rawX=497)`);
  ok(`mid-line 497->496: wrap positions from early X (canvas 1..24), not end-of-line X (0..23)`);
}

// ── 3: X-expanded (the actual demo geometry) — early 496 vs late 497 ───────
// X-expanded solid sprite: early rawX=496 (sx=504, wrapStart 0) paints 48
// canvas pixels 0..47; late rawX=497 (sx=505, wrapStart 1) would paint 1..48.
// The discriminator is the leftmost pixel (canvas X=0) and the pixel past the
// end (canvas X=48).
{
  const vic = makeVic();
  setupMidlineWrap(vic, { earlyX: 496, lateX: 497, xExpand: true });
  vic._renderSpriteLine(50, 35);
  expect(vic.spriteOwnerBuffer[0] === 0,
    `X-expanded: canvas X=0 painted (early rawX=496), got owner=$${vic.spriteOwnerBuffer[0].toString(16)}`);
  expect(vic.spriteOwnerBuffer[47] === 0,
    `X-expanded: canvas X=47 painted (last of 48 from early rawX=496)`);
  expect(vic.spriteOwnerBuffer[48] === 0xFF,
    `X-expanded: canvas X=48 NOT painted — end-of-line rawX=497 must NOT govern, got owner=$${vic.spriteOwnerBuffer[48].toString(16)}`);
  ok(`X-expanded mid-line 496->497 (demo geometry): wrap from early X (canvas 0..47)`);
}

// ── 4: stable X (no mid-line change) is unaffected — no regression ─────────
// Guards the no-op claim: constant rawX=496 across the line paints canvas
// 0..23 exactly as before (early sample == end-of-line sample).
{
  const vic = makeVic();
  setupMidlineWrap(vic, { earlyX: 496, lateX: 496 });
  vic._renderSpriteLine(50, 35);
  let painted = 0;
  for (let x = 0; x < 24; x++) if (vic.spriteOwnerBuffer[x] === 0) painted++;
  expect(painted === 24, `stable rawX=496 paints 24px at canvas 0..23, got ${painted}`);
  expect(vic.spriteOwnerBuffer[24] === 0xFF, `stable rawX=496: canvas X=24 not painted`);
  ok(`stable X wrap unchanged (early sample == end-of-line sample)`);
}

console.log(`\n${testNo} sprite-wrap mid-line-X spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
