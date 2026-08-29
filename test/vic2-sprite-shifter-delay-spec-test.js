// Sprite shifter X-comparator delay + first-pixel landing spec test.
//
// Bauer §3.8.2: when the VIC's X counter matches a sprite's X register,
// the sprite shifter is loaded with the sprite data byte and shifts out
// 24 pixels (8 bits × 3 bytes = 24 pixels, expanded x2 with X-expand).
//
// The first painted pixel lands at canvas X = sprite-X + 8 (= canvas
// offset). Subsequent pixels at consecutive canvas-X positions.
//
// Common bug shapes:
//   - Off-by-one in canvas-X offset (= 7 or 9 instead of 8).
//   - Shifter starts ONE cycle late (= sprite shifted right by 1 px).
//   - Shifter loads from wrong sprite-data row.
//
// This test exercises the SPRITE-SHIFTER delay specifically, isolated
// from sprite-DMA setup state. Mirrors `sprite-x-comparator-spec-test`'s
// approach but focuses on the FIRST PIXEL position.

import { VIC2, CYCLES_PER_LINE, CANVAS_W } from '../src/vic2.js';

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
  vic.vicVariant = '6569';
  return vic;
}

function setupSprite(vic, sprite, regX, color = 2, shiftReg = 0xFFFFFF) {
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleRegs[cycle][0x15] |= (1 << sprite);
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

function spriteSpan(vic, canvasY, sprite = 0) {
  const ro = canvasY * CANVAS_W;
  let first = -1, last = -1, count = 0;
  for (let x = 0; x < CANVAS_W; x++) {
    if (vic.spriteOwnerBuffer[x] === sprite) {
      if (first < 0) first = x;
      last = x;
      count++;
    }
  }
  return { first, last, count };
}

// ── 1: Sprite-X = N → first pixel at canvas-X = N+8. Sweep N=24..200.
{
  const sweeps = [24, 50, 100, 150, 200];
  for (const x of sweeps) {
    const vic = makeVic();
    setupSprite(vic, 0, x);
    clearLineBuffers(vic, 50);
    vic._renderSpriteLine(50, 50);
    const span = spriteSpan(vic, 50);
    expect(span.first === x + 8,
      `sprite-X=${x}: first pixel at canvas X=${x+8}; got ${span.first}`);
    expect(span.count === 24,
      `sprite-X=${x}: 24-px sprite; got ${span.count}`);
  }
  ok('Bauer §3.8.2: sprite-X → first canvas X = sprite-X + 8 (sweep 24..200)');
}

// ── 2: Sprite-X = 0 → first pixel at canvas X = 8 (= left edge of CSEL=1).
{
  const vic = makeVic();
  setupSprite(vic, 0, 0);
  clearLineBuffers(vic, 50);
  vic._renderSpriteLine(50, 50);
  const span = spriteSpan(vic, 50);
  expect(span.first === 8,
    `sprite-X=0: first canvas X=8; got ${span.first}`);
  expect(span.last === 31,
    `sprite-X=0: last canvas X=31 (= 8+23); got ${span.last}`);
  ok('Bauer §3.8.2: sprite-X=0 paints from canvas X=8 (leftmost visible)');
}

// ── 3: Sprite-X = 256 (MSB set, low=0) → first pixel at canvas X=264.
{
  const vic = makeVic();
  setupSprite(vic, 0, 256);
  clearLineBuffers(vic, 50);
  vic._renderSpriteLine(50, 50);
  const span = spriteSpan(vic, 50);
  expect(span.first === 264,
    `sprite-X=256 (MSB set): first canvas X=264 (= 256+8); got ${span.first}`);
  ok('Bauer §3.8.2: sprite-X=256 (MSB) → first canvas X=264 (X-MSB respected)');
}

// ── 4: Shifter shifts left-to-right (bit 7 of byte = leftmost pixel).
//
// With shiftReg = $800000 (only bit 23 set), only the FIRST pixel
// should be sprite (rest = no paint).
{
  const vic = makeVic();
  setupSprite(vic, 0, 100, 2, 0x800000);
  clearLineBuffers(vic, 50);
  vic._renderSpriteLine(50, 50);
  const span = spriteSpan(vic, 50);
  expect(span.count === 1,
    `shiftReg=$800000 (one fg bit at MSB): 1 pixel painted; got ${span.count}`);
  expect(span.first === 108,
    `shiftReg MSB pixel lands at first sprite-X position (108); got ${span.first}`);
  ok('Bauer §3.8.2: sprite shifter is MSB-first (bit 23 = leftmost pixel)');
}

// ── 5: Shifter LSB lands at sprite-X + 23 (= last pixel).
//
// With shiftReg = $000001 (only bit 0 set), only the LAST pixel
// (= pixel 23) should paint.
{
  const vic = makeVic();
  setupSprite(vic, 0, 100, 2, 0x000001);
  clearLineBuffers(vic, 50);
  vic._renderSpriteLine(50, 50);
  const span = spriteSpan(vic, 50);
  expect(span.count === 1,
    `shiftReg=$000001 (one fg bit at LSB): 1 pixel painted; got ${span.count}`);
  expect(span.first === 131,
    `shiftReg LSB pixel lands at last sprite-X position (108+23=131); got ${span.first}`);
  ok('Bauer §3.8.2: sprite shifter LSB lands at pixel 23 of 24');
}

// ── 6: X-expanded sprite = 48 pixels (each shifter bit covers 2 canvas px).
{
  const vic = makeVic();
  setupSprite(vic, 0, 100);
  // Manually enable X-expand for sprite 0.
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleRegs[cycle][0x1D] |= 0x01;
  }
  clearLineBuffers(vic, 50);
  vic._renderSpriteLine(50, 50);
  const span = spriteSpan(vic, 50);
  expect(span.count === 48,
    `X-expanded sprite: 48 canvas pixels; got ${span.count}`);
  expect(span.first === 108 && span.last === 155,
    `X-expanded: canvas X 108..155; got ${span.first}..${span.last}`);
  ok('Bauer §3.8.2: X-expanded sprite spans 48 canvas pixels (2 px per shifter bit)');
}

console.log(`\n${testNo} sprite shifter X-comparator delay spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
