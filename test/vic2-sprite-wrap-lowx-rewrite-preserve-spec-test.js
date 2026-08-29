// Sprite-X horizontal wrap — register survival across a mid-line X rewrite to a
// LOW (beam-passed) coordinate (Bauer §3.8.1).
//
// Bauer §3.8.1 rule 6: a sprite's 24-bit shift register begins shifting "as soon
// as the current X coordinate of the raster beam HAS MATCHED the X coordinate of
// the sprite" — i.e. a match is required to start emission, and the beam only
// moves left→right. A mid-line write that puts the sprite's X *behind* the beam
// (a coordinate it has already passed) therefore CANNOT match this line, so it
// must be a no-op: it neither emits pixels nor consumes the shift register.
//
// A sprite parked in the wrap zone (X=$1F7=503 — Bauer: "to place a sprite one
// pixel to the left of X position 0 it has to be at X position $1f7") paints its
// wrapped-over pixels at the left overscan (canvas x=7..30 for a solid 24px
// sprite). Those pixels are emitted EARLY in the line (see the companion
// vic2-sprite-wrap-midline-x spec). So a LATER mid-line rewrite to a low,
// already-passed X must NOT retroactively wipe them.
//
// Regression target: "12 sprites wide scroller" (The Hat, disc 1). It is a
// multiplexed fullscreen sprite scroller with the side border open. Each hardware
// sprite is reused at two X positions per frame; a cell that has scrolled to the
// left edge sits at X=503 (early in the line) and is then rewritten mid-line to a
// low X (~247) to reposition it for the next multiplex row. On hardware the low-X
// write lands after the beam has passed that column, so it does not match and the
// register survives for the end-of-line X=503 wrap → the glyph clips smoothly off
// the left edge. Our per-segment renderer instead treated the low-X rewrite as a
// "pre-start reposition", moved the render state there and consumed all 24 units,
// so the end-of-line wrap found unitsRemaining==0 and painted nothing — the glyph
// vanished at the left edge instead of clipping. These tests pin the correct
// behavior (wrap preserved) using only our own emulator: the target output is the
// stable-X=503 baseline, which the existing wrap suite already validates.
//
// The companion phantom case is also pinned here now: a high-X sprite that
// crosses the raw X=$1F7->$000 wrap point has already emitted same-line
// left-edge pixels. A later mid-line $D010 rewrite to a low on-screen X must
// not start it a second time. A high-X sprite that does NOT reach that wrap
// point is still pending and remains repositionable before the beam reaches the
// new X.

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

// Per-cycle sprite 0 setup with an X that changes mid-line at `flip`: rawX =
// earlyX for cycles 1..(flip-1), lateX for cycles flip..63. Open borders, solid
// 24px shifter (matches the companion wrap spec's helper).
function setupMidlineWrap(vic, { earlyX, lateX, flip, xExpand = false, shiftReg = 0xFFFFFF, lateShiftReg = shiftReg }) {
  for (let cycle = 1; cycle <= 63; cycle++) {
    const rawX = cycle < flip ? earlyX : lateX;
    const rowShiftReg = cycle < flip ? shiftReg : lateShiftReg;
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
    vic.lineCycleSpriteShiftReg[cycle][0] = rowShiftReg >>> 0;
    vic.lineCycleHBorderBefore[cycle] = 0;
    vic.lineCycleHBorder[cycle] = 0;
    vic.lineCycleVBorderBefore[cycle] = 0;
    vic.lineCycleVBorder[cycle] = 0;
  }
}

// Canvas columns [lo,hi) owned by sprite 0.
function paintedCols(vic, lo, hi) {
  const cols = [];
  for (let x = lo; x < hi; x++) if (vic.spriteOwnerBuffer[x] === 0) cols.push(x);
  return cols;
}
function allPainted(vic, lo, hi) {
  for (let x = lo; x < hi; x++) if (vic.spriteOwnerBuffer[x] !== 0) return false;
  return true;
}
function nonePainted(vic, lo, hi) {
  for (let x = lo; x < hi; x++) if (vic.spriteOwnerBuffer[x] === 0) return false;
  return true;
}

// ── 1: baseline — stable X=$1F7 (503) wraps to canvas 7..30 ─────────────────
// Establishes the target output for this suite entirely within our emulator.
{
  const vic = makeVic();
  setupMidlineWrap(vic, { earlyX: 503, lateX: 503, flip: 15 });
  vic._renderSpriteLine(50, 35);
  expect(allPainted(vic, 7, 31),
    `stable X=503 must wrap-paint canvas 7..30, got [${paintedCols(vic, 0, 40)}]`);
  expect(vic.spriteOwnerBuffer[6] === 0xFF, `canvas x=6 clear (left of wrap start)`);
  expect(vic.spriteOwnerBuffer[31] === 0xFF, `canvas x=31 clear (right of 24px wrap)`);
  ok(`baseline: stable X=$1F7 wraps to canvas 7..30`);
}

// ── 2: X=503 rewritten mid-line to a low, beam-passed X (100) at cycle 55 ────
// The write lands with the beam ~canvas 352, far past canvas 108 (X=100), so it
// cannot match → no-op per Bauer rule 6. The early-emitted wrap must survive
// unchanged: canvas 7..30, identical to the stable baseline.
{
  const vic = makeVic();
  setupMidlineWrap(vic, { earlyX: 503, lateX: 100, flip: 55 });
  vic._renderSpriteLine(50, 35);
  expect(allPainted(vic, 7, 31),
    `beam-passed low-X rewrite must be a no-op — wrap stays at canvas 7..30, got [${paintedCols(vic, 0, 40)}]`);
  expect(nonePainted(vic, 0, 7) && vic.spriteOwnerBuffer[31] === 0xFF,
    `no stray pixels outside the 7..30 wrap span`);
  ok(`X=503 -> 100 @cy55 (beam-passed): wrap register preserved (canvas 7..30)`);
}

// ── 3: the demo's exact values — X=503 rewritten to 247 at cycle 51 ─────────
// This is the "12 sprites wide scroller" geometry. Same requirement: the
// left-edge wrap must survive the low-X reposition write.
{
  const vic = makeVic();
  setupMidlineWrap(vic, { earlyX: 503, lateX: 247, flip: 51 });
  vic._renderSpriteLine(50, 35);
  expect(allPainted(vic, 7, 31),
    `demo geometry (503->247): wrap must stay at canvas 7..30, got [${paintedCols(vic, 0, 300)}]`);
  // The low-X reposition (247 -> canvas 255) is behind the beam, so it must NOT
  // emit a phantom sprite mid-screen either.
  expect(nonePainted(vic, 255, 279),
    `no phantom emission at the beam-passed low X (canvas 255..278), got [${paintedCols(vic, 255, 279)}]`);
  ok(`X=503 -> 247 @cy51 (demo geometry): left wrap preserved, no phantom mid-screen sprite`);
}

// ── 4: guard — a legit reposition AHEAD of the beam still repositions ───────
// earlyX=50 rewritten to 200 at cycle 12, BEFORE the beam reaches canvas 58.
// Bauer rule 6: the sprite has not matched yet, so it starts at the new X. Must
// paint canvas 208..231 (X=200) and NOT canvas 58 (old X=50). Guards that the
// beam-passed no-op rule does not over-block genuine pre-start repositions.
{
  const vic = makeVic();
  setupMidlineWrap(vic, { earlyX: 50, lateX: 200, flip: 12 });
  vic._renderSpriteLine(50, 35);
  expect(allPainted(vic, 208, 232),
    `ahead-of-beam reposition 50->200 must paint at new X (canvas 208..231), got [${paintedCols(vic, 40, 240)}]`);
  expect(nonePainted(vic, 58, 82),
    `old X=50 (canvas 58..81) must NOT paint after a pre-start reposition`);
  ok(`guard: pre-start reposition ahead of the beam (50->200) still moves the sprite`);
}

// ── 5: X=464, X-expanded, rewritten to X=208 does not re-trigger ────────────
// The Hat frame-585 phantom: sprite 0 begins the line at raw X=$1D0. With
// X-expand, the sprite has already matched before canvas X=0 and only the
// wrapped tail can remain. Rewriting $D010 mid-line to raw X=$0D0 is a
// post-start retarget, not a second start.
{
  const vic = makeVic();
  setupMidlineWrap(vic, { earlyX: 464, lateX: 208, flip: 16, xExpand: true });
  vic._renderSpriteLine(50, 35);
  expect(allPainted(vic, 0, 16),
    `pre-canvas X=464 x-expanded sprite must preserve its wrapped tail at canvas 0..15, got [${paintedCols(vic, 0, 48)}]`);
  expect(nonePainted(vic, 216, 264),
    `post-start rewrite 464->208 must not draw a second sprite at canvas 216..263, got [${paintedCols(vic, 200, 280)}]`);
  ok(`X=464 x-expanded -> 208 mid-line: no second start / no mid-screen phantom`);
}

// ── 6: X=497 rewritten early to X=241 does not re-trigger after wrap ────────
// The Hat 13-sprite scroller: the high-X sprite has already started before the
// framebuffer and wraps at the left edge. A later $D010 clear happens before
// the beam reaches raw X=241, but it is still a post-start write for this
// sprite, so even changed fetched bytes must not restart it around canvas 249.
{
  const vic = makeVic();
  setupMidlineWrap(vic, {
    earlyX: 497,
    lateX: 241,
    flip: 16,
    shiftReg: 0xFFFFFF,
    lateShiftReg: 0xAAAAAA,
  });
  vic._renderSpriteLine(50, 35);
  expect(allPainted(vic, 1, 25),
    `pre-framebuffer X=497 sprite must wrap-paint canvas 1..24, got [${paintedCols(vic, 0, 48)}]`);
  expect(nonePainted(vic, 249, 273),
    `post-start rewrite 497->241 must not reseed/draw a second sprite at canvas 249..272, got [${paintedCols(vic, 232, 280)}]`);
  ok(`X=497 -> 241 with changed fetched bytes: no second start at x=249`);
}

// ── 7: high off-canvas X without wrap may still move ahead of the beam ──────
// The Hat frame-538 blink: raw X=415, X-expanded, emits only in off-canvas-right
// (canvas X=423..470) and never crosses the 504-tick wrap point. A mid-line
// rewrite to raw X=159 before the visible beam reaches canvas X=167 is therefore
// a legitimate pre-start reposition.
{
  const vic = makeVic();
  setupMidlineWrap(vic, { earlyX: 415, lateX: 159, flip: 16, xExpand: true });
  vic._renderSpriteLine(50, 35);
  expect(allPainted(vic, 167, 215),
    `non-wrapping high-X sprite 415->159 before beam reaches new X must paint canvas 167..214, got [${paintedCols(vic, 150, 224)}]`);
  expect(nonePainted(vic, 0, 32),
    `non-wrapping high-X sprite must not invent left-edge wrap pixels, got [${paintedCols(vic, 0, 48)}]`);
  ok(`X=415 x-expanded -> 159 before beam reaches new X: reposition still starts the sprite`);
}

// ── 8: Hat13 left-exit column — X=488 unexpanded wraps, rewrite is a no-op ──
// The Hat "13 sprites scroller": s1 parks at raw X=$1E8 (488). Bauer §3.8.1:
// the X counter sweeps raw $1A0..$1F7 during cycles 1..11, so the comparator
// matched BEFORE canvas X=0 — raw 488..495 emit invisibly, raw 496..503 land
// at canvas 0..7 and the wrap continues to canvas 8..15. The demo's cy16 $D010
// clear to raw X=$E8 (232) is behind the beam in line-time: no second start at
// canvas 240..263, and the left-edge tail must survive (this was BOTH visible
// bugs at once: glyphs vanishing at the left edge instead of clipping, plus a
// phantom column ~2/3 across the screen).
{
  const vic = makeVic();
  setupMidlineWrap(vic, { earlyX: 488, lateX: 232, flip: 16 });
  vic._renderSpriteLine(50, 35);
  expect(allPainted(vic, 0, 16),
    `swept X=488 sprite must wrap-paint its tail at canvas 0..15, got [${paintedCols(vic, 0, 48)}]`);
  expect(nonePainted(vic, 240, 264),
    `swept X=488 rewritten to 232 must not draw a phantom at canvas 240..263, got [${paintedCols(vic, 224, 280)}]`);
  ok(`X=488 -> 232 @cy16 (Hat13): left tail preserved, no 2/3-screen phantom`);
}

// ── 9: swept but non-wrapping — X=472 consumed invisibly, rewrite no-op ─────
// Raw X=$1D8 (472), unexpanded: body 472..495 is swept at cycles 8..11 and
// never reaches the $1F7->$000 wrap, so on hardware the whole sprite emits in
// the invisible right overscan. A later rewrite to a low X must stay a no-op
// (no phantom) and there is no left-edge tail to paint. This is the late-scroll
// Hat13 state (parked X drops below the wrap-reach as the glyph exits).
{
  const vic = makeVic();
  setupMidlineWrap(vic, { earlyX: 472, lateX: 232, flip: 16 });
  vic._renderSpriteLine(50, 35);
  expect(nonePainted(vic, 0, CANVAS_W),
    `swept non-wrapping X=472 must not paint anywhere on canvas, got [${paintedCols(vic, 0, CANVAS_W)}]`);
  ok(`X=472 -> 232 @cy16: swept invisibly, no left tail, no phantom`);
}

// ── 10: sweep boundary — raw X=$1A0 is swept, $19F is not ───────────────────
// Cycle 1 covers raw X 416..423, so $1A0 (416) is the FIRST coordinate the
// pre-canvas sweep reaches; $19F (415) is only passed at cycle 63 (why the Hat
// 12-sprite scroller parks its repositionable sprites at exactly 415).
{
  const vic = makeVic();
  setupMidlineWrap(vic, { earlyX: 416, lateX: 232, flip: 16 });
  vic._renderSpriteLine(50, 35);
  expect(nonePainted(vic, 0, CANVAS_W),
    `swept X=416 rewritten low must not paint, got [${paintedCols(vic, 0, CANVAS_W)}]`);
  ok(`X=416 ($1A0, first swept coordinate) -> 232: rewrite is a no-op`);
}
{
  const vic = makeVic();
  setupMidlineWrap(vic, { earlyX: 415, lateX: 232, flip: 16 });
  vic._renderSpriteLine(50, 35);
  expect(allPainted(vic, 240, 264),
    `unswept X=415 rewritten ahead of the beam must draw at canvas 240..263, got [${paintedCols(vic, 224, 280)}]`);
  ok(`X=415 ($19F, below the sweep) -> 232: reposition still starts the sprite`);
}

// ── 11: dead zone stays movable — X=$1F8 never matches, may reposition ──────
// Bauer §3.8 (closing): the counter skips raw $1F8..$1FF entirely, so a sprite
// parked there was NOT matched by the sweep; a mid-line rewrite ahead of the
// beam is a legitimate first match.
{
  const vic = makeVic();
  setupMidlineWrap(vic, { earlyX: 504, lateX: 232, flip: 30 });
  vic._renderSpriteLine(50, 35);
  expect(allPainted(vic, 240, 264),
    `dead-zone X=$1F8 rewritten ahead of the beam must draw at canvas 240..263, got [${paintedCols(vic, 224, 280)}]`);
  ok(`X=$1F8 (dead zone, never swept) -> 232: reposition still starts the sprite`);
}

console.log(`\n${testNo} sprite-wrap low-X-rewrite preservation spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
