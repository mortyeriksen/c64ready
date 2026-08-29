// Sprite-X comparator / shifter-start cycle precision spec audit. 10
// tests targeting the exact moment a sprite's shifter starts emitting
// pixels — the boundary case behind nine.prg's right-border 2-pixel
// blue strips and 8-pixel intrusion symptoms.
//
// Bauer §3.8.2: when the canvas pixel beam reaches the sprite's X
// register value, the sprite's shifter starts clocking. Width is 24
// canvas pixels (or 48 with X-expand). In our model there's an 8-pixel
// canvas offset (sprite-X N → canvas-X N+8) — codified in
// sprite-render-spec-test.js test 4.

import { VIC2, CANVAS_W } from '../src/vic2.js';

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

function setupSprite(vic, sprite, regX, opts = {}) {
  const { color = 2, shiftReg = 0xFFFFFF, multicolor = false, xExpand = false } = opts;
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleRegs[cycle][0x15] |= (1 << sprite);
    if (xExpand) vic.lineCycleRegs[cycle][0x1D] |= (1 << sprite);
    if (multicolor) vic.lineCycleRegs[cycle][0x1C] |= (1 << sprite);
    vic.lineCycleRegs[cycle][sprite * 2] = regX & 0xFF;
    if (regX > 255) vic.lineCycleRegs[cycle][0x10] |= (1 << sprite);
    vic.lineCycleRegs[cycle][0x27 + sprite] = color & 0x0F;
    vic.lineCycleSpriteDisplayOn[cycle][sprite] = 1;
    vic.lineCycleSpriteDataRow[cycle][sprite] = 0;
    vic.lineCycleSpriteRowByteMask[cycle][sprite] = 0x07;
    vic.lineCycleSpriteShiftReg[cycle][sprite] = shiftReg >>> 0;
  }
  vic.spriteLineDataRow[sprite] = 0;
  vic.spriteRowByteMask[sprite] = 0x07;
  vic.spriteShiftReg[sprite] = shiftReg >>> 0;
}

function clearLineBuffers(vic, canvasY) {
  const rowOffset = canvasY * CANVAS_W;
  vic.borderBuffer.fill(0, 0, CANVAS_W);
  vic.graphicsPriorityBuffer.fill(0, 0, CANVAS_W);
  vic.graphicsCollisionBuffer.fill(0, 0, CANVAS_W);
  vic.spriteCollisionBuffer.fill(0, 0, CANVAS_W);
  vic.spriteOwnerBuffer.fill(0xFF, 0, CANVAS_W);
  return rowOffset;
}

function spriteFirstCanvasX(vic, sprite, canvasY) {
  const rowOffset = canvasY * CANVAS_W;
  for (let x = 0; x < CANVAS_W; x++) {
    if (vic.spriteOwnerBuffer[x] === sprite) return x;
  }
  return -1;
}

function spriteLastCanvasX(vic, sprite, canvasY) {
  const rowOffset = canvasY * CANVAS_W;
  for (let x = CANVAS_W - 1; x >= 0; x--) {
    if (vic.spriteOwnerBuffer[x] === sprite) return x;
  }
  return -1;
}

// ── 1: sprite-X register N maps to canvas-X N+8 ────────────────────────
{
  const vic = makeVic();
  const cy = 50;
  setupSprite(vic, 0, 100);
  clearLineBuffers(vic, cy);
  vic._renderSpriteLine(50, cy);
  expect(spriteFirstCanvasX(vic, 0, cy) === 108,
    `sprite-X=100 → canvas-X=108 (with +8 canvas offset)`);
  ok('Bauer §3.8.2: sprite-X register N → canvas-X N+8');
}

// ── 2: sprite spans exactly 24 canvas pixels (no X-expand, no MC) ──────
{
  const vic = makeVic();
  const cy = 50;
  setupSprite(vic, 0, 100);
  clearLineBuffers(vic, cy);
  vic._renderSpriteLine(50, cy);
  const first = spriteFirstCanvasX(vic, 0, cy);
  const last = spriteLastCanvasX(vic, 0, cy);
  expect(last - first + 1 === 24,
    `standard sprite spans 24 px, got first=${first} last=${last} → ${last-first+1}`);
  ok('Bauer §3.8.2: standard sprite spans exactly 24 canvas pixels');
}

// ── 3: X-expanded sprite spans exactly 48 canvas pixels ────────────────
{
  const vic = makeVic();
  const cy = 50;
  setupSprite(vic, 0, 100, { xExpand: true });
  clearLineBuffers(vic, cy);
  vic._renderSpriteLine(50, cy);
  const first = spriteFirstCanvasX(vic, 0, cy);
  const last = spriteLastCanvasX(vic, 0, cy);
  expect(last - first + 1 === 48,
    `X-expanded sprite spans 48 px, got ${last-first+1}`);
  ok('Bauer §3.8.2: X-expanded sprite spans exactly 48 canvas pixels');
}

// ── 4: sprite at sprite-X=0 starts at canvas-X 8 ───────────────────────
{
  const vic = makeVic();
  const cy = 50;
  setupSprite(vic, 0, 0);
  clearLineBuffers(vic, cy);
  vic._renderSpriteLine(50, cy);
  expect(spriteFirstCanvasX(vic, 0, cy) === 8,
    `sprite-X=0 → canvas-X=8 (offset)`);
  ok('Bauer §3.8.2: sprite-X=0 paints from canvas-X=8 (left edge)');
}

// ── 5: sprite-X=255 + MSB=0 paints at canvas-X=263 ─────────────────────
{
  const vic = makeVic();
  const cy = 50;
  setupSprite(vic, 0, 255);
  clearLineBuffers(vic, cy);
  vic._renderSpriteLine(50, cy);
  expect(spriteFirstCanvasX(vic, 0, cy) === 263,
    `sprite-X=255 → canvas-X=263 (255+8)`);
  ok('Bauer §3.8.2: sprite-X=255 lands at canvas-X=263');
}

// ── 6: sprite-X=256 (MSB set, X-LO=0) → canvas-X 264 ───────────────────
{
  const vic = makeVic();
  const cy = 50;
  setupSprite(vic, 0, 256);
  clearLineBuffers(vic, cy);
  vic._renderSpriteLine(50, cy);
  expect(spriteFirstCanvasX(vic, 0, cy) === 264,
    `sprite-X=256 (MSB) → canvas-X=264 (256+8)`);
  ok('Bauer §3.8.2: sprite-X with MSB=1 (X≥256) lands +8 in canvas');
}

// ── 7: sprite at sprite-X=375 paints near the canvas right edge ───────
// sprite-X=375 → canvas-X 383 (last valid column). 24-px wide sprite
// would extend to 383+23=406, but canvas-W=384 truncates the rest.
{
  const vic = makeVic();
  const cy = 50;
  setupSprite(vic, 0, 375);
  clearLineBuffers(vic, cy);
  vic._renderSpriteLine(50, cy);
  expect(spriteFirstCanvasX(vic, 0, cy) === 383,
    `sprite-X=375 → canvas-X=383 (last column)`);
  // Only 1 pixel visible (the leftmost one); rest off-canvas.
  const last = spriteLastCanvasX(vic, 0, cy);
  expect(last === 383,
    `sprite-X=375: only 1 pixel visible at canvas-X=383, got last=${last}`);
  ok('Bauer §3.8.2: sprite at right canvas edge clips correctly');
}

// ── 8: sprite-X=376 → canvas-X=384 = off-canvas, paints zero ──────────
{
  const vic = makeVic();
  const cy = 50;
  setupSprite(vic, 0, 376);
  clearLineBuffers(vic, cy);
  vic._renderSpriteLine(50, cy);
  expect(spriteFirstCanvasX(vic, 0, cy) === -1,
    `sprite-X=376 → canvas-X=384 (off): 0 pixels`);
  ok('Bauer §3.8.2: sprite past canvas-W paints zero pixels');
}

// ── 9: sprite-X=480 wraps to canvas X=0..7 (Bauer §3.8 same-line wrap) ──
// sprite-X=480 → canvas X=488. Pixels 0..15 land off-canvas-right
// (canvas X=488..503, between visible 384 and line-wrap 504). Pixels
// 16..23 wrap to canvas X=0..7 of the SAME line.
{
  const vic = makeVic();
  const cy = 50;
  setupSprite(vic, 0, 480);
  clearLineBuffers(vic, cy);
  vic._renderSpriteLine(50, cy);
  expect(spriteFirstCanvasX(vic, 0, cy) === 0,
    `sprite-X=480 wraps last 8 pixels to canvas X=0..7`);
  ok('Bauer §3.8.2: sprite-X in wrap zone (480) wraps to canvas X=0..7');
}

// ── 10: Two sprites at same X with shifted-by-1 → 1 column overlap ─────
{
  const vic = makeVic();
  const cy = 50;
  setupSprite(vic, 0, 100);
  setupSprite(vic, 1, 123);                  // first sp1 px at canvas-X 131 (1 past sp0 last)
  clearLineBuffers(vic, cy);
  vic._renderSpriteLine(50, cy);
  // sp0 paints 108..131. sp1 paints 131..154. Overlap at 131. Lower-index
  // wins, so sp0 owns 131.
  expect(vic.spriteOwnerBuffer[131] === 0,
    `overlap at canvas-X=131: sp0 wins (lower index)`);
  expect(vic.spriteOwnerBuffer[132] === 1,
    `canvas-X=132: sp1 owns`);
  ok('Bauer §3.8.2: lower-index sprite wins single-pixel overlap');
}

console.log(`\n${testNo} sprite-X comparator spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
