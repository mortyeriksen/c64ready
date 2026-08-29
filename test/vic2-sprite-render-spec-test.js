// Sprite pixel-precision spec audit. 10 tests derived from Bauer §3.8 +
// the C64 Programmer's Reference Guide §3.5. Each test exercises a sprite
// X/Y/expand/multicolor configuration through `_renderSpriteLine` and
// asserts the canvas-pixel ownership at the boundary.
//
// Sprite X coordinate maps to canvas X via X+offset where the offset is
// 0 in our model (sprite-X = canvas-X). The visible window with CSEL=1
// is canvas-X 24..344. With the side-border-open trick the visible band
// extends to roughly 0..383.

import { VIC2, CYCLES_PER_LINE, CANVAS_W } from '../src/vic2.js';

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

// Set up a sprite for a single rendering pass at a given canvas Y.
function setupSprite(vic, sprite, regX, { xExpand = false, multicolor = false, color = 2, priority = false, shiftReg = 0xFFFFFF } = {}) {
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleRegs[cycle][0x15] |= (1 << sprite);
    if (xExpand) vic.lineCycleRegs[cycle][0x1D] |= (1 << sprite);
    if (multicolor) vic.lineCycleRegs[cycle][0x1C] |= (1 << sprite);
    if (priority) vic.lineCycleRegs[cycle][0x1B] |= (1 << sprite);
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

function paintsOwner(vic, rowOffset, x, sprite) {
  return vic.spriteOwnerBuffer[x] === sprite;
}

// ── 1: Sprite X register decodes to 9-bit value (low + MSB) ──────────────
{
  const vic = makeVic();
  vic.regs[0x10] = 0x01;
  vic.regs[0x00] = 0x10;
  const x = vic.regs[0x00] | (((vic.regs[0x10] >> 0) & 1) << 8);
  expect(x === 0x110, `sp0 X-MSB set + X-LO=$10 → 9-bit X = 272 (0x110), got 0x${x.toString(16)}`);
  ok('Bauer §3.8: 9-bit sprite X = X-LO | (MSB<<8)');
}

// ── 2: Standard sprite spans exactly 24 canvas pixels ────────────────────
// Bauer: a sprite is 24 pixels wide × 21 pixels tall in standard mode.
{
  const vic = makeVic();
  const canvasY = 50;
  setupSprite(vic, 0, 100, { color: 2, shiftReg: 0xFFFFFF });
  const rowOffset = clearLineBuffers(vic, canvasY);
  vic._renderSpriteLine(50, canvasY);
  let painted = 0;
  for (let x = 0; x < CANVAS_W; x++) {
    if (paintsOwner(vic, rowOffset, x, 0)) painted++;
  }
  expect(painted === 24,
    `standard sprite must paint exactly 24 pixels, got ${painted}`);
  ok('Bauer §3.8: standard sprite spans 24 canvas pixels');
}

// ── 3: X-expanded sprite spans exactly 48 canvas pixels ──────────────────
{
  const vic = makeVic();
  const canvasY = 50;
  setupSprite(vic, 0, 100, { xExpand: true, color: 2, shiftReg: 0xFFFFFF });
  const rowOffset = clearLineBuffers(vic, canvasY);
  vic._renderSpriteLine(50, canvasY);
  let painted = 0;
  for (let x = 0; x < CANVAS_W; x++) {
    if (paintsOwner(vic, rowOffset, x, 0)) painted++;
  }
  expect(painted === 48,
    `X-expanded sprite must paint exactly 48 pixels, got ${painted}`);
  ok('Bauer §3.8: X-expanded sprite spans 48 canvas pixels');
}

// ── 4: Sprite at X=24 starts at canvas X = X+8 ──────────────────────────
// In our canvas model the +8 canvas offset (left-border 8 px wider than
// the spec's pixel-0 origin) means sprite-X register N maps to canvas-X
// N+8. Sprite-X=24 → canvas-X 32..55 (the leftmost edge of the 40-col
// inner display window).
{
  const vic = makeVic();
  const canvasY = 60;
  setupSprite(vic, 0, 24, { color: 2, shiftReg: 0xFFFFFF });
  const rowOffset = clearLineBuffers(vic, canvasY);
  vic._renderSpriteLine(50, canvasY);
  expect(paintsOwner(vic, rowOffset, 32, 0),
    `sprite-X=24: leftmost pixel must be at canvas-X=32 (with +8 offset)`);
  expect(paintsOwner(vic, rowOffset, 55, 0),
    `sprite-X=24: rightmost pixel at canvas-X=55 (32+23)`);
  expect(!paintsOwner(vic, rowOffset, 31, 0),
    `sprite-X=24: canvas-X=31 must NOT be sprite (one before)`);
  expect(!paintsOwner(vic, rowOffset, 56, 0),
    `sprite-X=24: canvas-X=56 must NOT be sprite (one after)`);
  ok('Bauer §3.8: sprite-X=24 paints canvas X=32..55 (canvas offset +8)');
}

// ── 5: Sprite at X=344 (right border boundary, CSEL=1) ──────────────────
// With +8 canvas offset: sprite-X=344 → canvas-X 352..375.
{
  const vic = makeVic();
  const canvasY = 60;
  setupSprite(vic, 0, 344, { color: 2, shiftReg: 0xFFFFFF });
  const rowOffset = clearLineBuffers(vic, canvasY);
  vic._renderSpriteLine(50, canvasY);
  expect(paintsOwner(vic, rowOffset, 352, 0),
    `sprite-X=344: leftmost pixel at canvas-X=352 (right of inner display)`);
  expect(paintsOwner(vic, rowOffset, 375, 0),
    `sprite-X=344: rightmost pixel at canvas-X=375`);
  ok('Bauer §3.8: sprite-X=344 paints canvas X=352..375 (right side border zone)');
}

// ── 6: Sprite at X=480 wraps to canvas X=0..7 via Bauer §3.8 same-line wrap
// Canvas width = 384, but the line wrap point is canvas X=504 (= raw X
// 504, the PAL line tick count). For X=480 → sx=488: pixels 0..15
// land at canvas X=488..503 (off-canvas-right), pixels 16..23 wrap to
// canvas X=0..7. 8 pixels visible after the wrap.
{
  const vic = makeVic();
  const canvasY = 60;
  setupSprite(vic, 0, 480, { color: 2, shiftReg: 0xFFFFFF });
  const rowOffset = clearLineBuffers(vic, canvasY);
  vic._renderSpriteLine(50, canvasY);
  let painted = 0;
  for (let x = 0; x < CANVAS_W; x++) {
    if (paintsOwner(vic, rowOffset, x, 0)) painted++;
  }
  expect(painted === 8,
    `sprite-X=480 (sx=488): wraps last 8 pixels to canvas X=0..7, got ${painted}`);
  let wrappedPixels = 0;
  for (let x = 0; x < 8; x++) {
    if (paintsOwner(vic, rowOffset, x, 0)) wrappedPixels++;
  }
  expect(wrappedPixels === 8,
    `wrap should land at canvas X=0..7, got ${wrappedPixels}/8`);
  ok('Bauer §3.8: sprite-X past canvas right but within line wraps to canvas X=0..7');
}

// ── 7: Multicolor sprite renders 12 pixel-pairs (2×12=24 canvas pixels)
// Multicolor sprites use 2-bit color codes per pixel-pair → 12 pairs ×
// 2 canvas pixels each = 24 canvas pixels (same total width as standard).
{
  const vic = makeVic();
  const canvasY = 60;
  // shiftReg pattern 0x555555 = 010101...0101 (every other bit) — in
  // multicolor that's pair pattern 01,01,01,... → pair value 1 → mc1 color.
  setupSprite(vic, 0, 100, { multicolor: true, color: 2, shiftReg: 0x555555 });
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleRegs[cycle][0x25] = 0x05;     // mc1
    vic.lineCycleRegs[cycle][0x26] = 0x06;     // mc2
  }
  const rowOffset = clearLineBuffers(vic, canvasY);
  vic._renderSpriteLine(50, canvasY);
  let painted = 0;
  for (let x = 0; x < CANVAS_W; x++) {
    if (paintsOwner(vic, rowOffset, x, 0)) painted++;
  }
  expect(painted === 24,
    `multicolor sprite spans 24 canvas pixels (12 pair × 2), got ${painted}`);
  ok('Bauer §3.8: multicolor sprite spans 24 pixels (12 pair × 2)');
}

// ── 8: Sprite priority $D01B=0 → sprite paints over graphics ────────────
// Bauer §3.8: $D01B bit N = 0 → sprite N has priority over background
// graphics. Bit N = 1 → graphics-foreground covers sprite.
{
  const vic = makeVic();
  const canvasY = 70;
  setupSprite(vic, 0, 100, { priority: false, color: 2, shiftReg: 0xFFFFFF });
  const rowOffset = clearLineBuffers(vic, canvasY);
  // Mark canvas-X 100..123 as foreground graphics (priority=1).
  for (let x = 100; x < 124; x++) vic.graphicsPriorityBuffer[x] = 1;
  vic._renderSpriteLine(50, canvasY);
  // With priority=false, sprite paints OVER fg graphics.
  expect(paintsOwner(vic, rowOffset, 110, 0),
    `priority=0 sprite must paint over foreground graphics`);
  ok('Bauer §3.8: $D01B=0 → sprite paints over foreground graphics');
}

// ── 9: Sprite priority $D01B=1 → foreground graphics covers sprite ──────
// Bauer §3.8: priority=1 lets foreground graphics SHOW THROUGH the sprite.
// The sprite still claims the pixel for collision purposes, but the
// rendered color (fb32) is left as whatever fg graphics drew. We test
// fb32: pre-fill with a sentinel, expect sentinel intact at fg pixels.
{
  const vic = makeVic();
  const canvasY = 70;
  setupSprite(vic, 0, 100, { priority: true, color: 2, shiftReg: 0xFFFFFF });
  const rowOffset = clearLineBuffers(vic, canvasY);
  // Sprite paints canvas-X 108..131 (X=100 + 8 offset). Mark fg in that range.
  const SENTINEL = 0xFF123456;
  for (let x = 108; x < 132; x++) {
    vic.graphicsPriorityBuffer[x] = 1;
    vic.fb32[rowOffset + x] = SENTINEL;       // simulated fg color
  }
  vic._renderSpriteLine(50, canvasY);
  expect(vic.fb32[rowOffset + 120] === SENTINEL,
    `priority=1 + fg-priority pixel: fb32 must keep fg color, got 0x${vic.fb32[rowOffset + 120].toString(16)}`);
  ok('Bauer §3.8: $D01B=1 → foreground graphics shows through sprite (fb32 unchanged)');
}

// ── 10: Sprite-sprite collision $D01E sets bits when sprites overlap ────
// Bauer §3.11: when two sprites' opaque pixels coincide, $D01E bits for
// both sprites are set.
{
  const vic = makeVic();
  const canvasY = 80;
  // Two overlapping sprites — sp0 at X=100, sp1 at X=110 (overlap at 110-123).
  setupSprite(vic, 0, 100, { color: 2, shiftReg: 0xFFFFFF });
  setupSprite(vic, 1, 110, { color: 3, shiftReg: 0xFFFFFF });
  const rowOffset = clearLineBuffers(vic, canvasY);
  vic._renderSpriteLine(50, canvasY);
  // Read $D01E to see collision bits.
  const collide = vic.regs[0x1E];
  expect((collide & 0x01) !== 0, `$D01E bit 0 must be set (sp0 collided)`);
  expect((collide & 0x02) !== 0, `$D01E bit 1 must be set (sp1 collided)`);
  ok('Bauer §3.11: sprite-sprite overlap sets $D01E bits for both sprites');
}

console.log(`\n${testNo} sprite-render spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
