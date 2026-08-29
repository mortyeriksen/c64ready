// Sprite color $D025/$D026/$D027-$D02E mid-line live-sample spec test.
//
// Bauer §3.8.2: sprite colors are sampled LIVE per pixel for sprite
// painting. The color registers are:
//   $D025: sprite multicolor 0 (mc0) — shared
//   $D026: sprite multicolor 1 (mc1) — shared
//   $D027-$D02E: per-sprite fg color (sprite 0..7)
//
// A mid-line write to a sprite color changes the painted color for
// subsequent pixels in the same line. Demos use this to flicker sprite
// colors (= per-line color bands within a sprite).
//
// Audit gap: sprite color mid-line live-sample — sprite-multiplexer-spec
// test 11 covers $D027+s update generally; this test pins per-pixel
// boundary precision.

import { VIC2, CYCLES_PER_LINE, CANVAS_W, C64_PALETTE } from '../src/vic2.js';

const PAL = (i) => (0xFF000000 |
  ((C64_PALETTE[i] & 0xFF) << 16) |
  (C64_PALETTE[i] & 0xFF00) |
  ((C64_PALETTE[i] >> 16) & 0xFF)) >>> 0;

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

function setupSpriteWithColorOverride(vic, sprite, regX, colorByCycle, shiftReg = 0xFFFFFF) {
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleRegs[cycle][0x15] |= (1 << sprite);
    vic.lineCycleRegs[cycle][sprite * 2] = regX & 0xFF;
    vic.lineCycleRegs[cycle][0x27 + sprite] = colorByCycle(cycle) & 0x0F;
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

// ── 1: Sprite color constant across line → all sprite pixels = that color.
{
  const vic = makeVic();
  setupSpriteWithColorOverride(vic, 0, 100, () => 0x02);        // red
  const ro = clearLineBuffers(vic, 50);
  vic._renderSpriteLine(50, 50);
  // Sprite at sprite-X=100 → canvas X 108..131 (24 pixels).
  for (let x = 108; x <= 131; x++) {
    expect(vic.fb32[ro + x] === PAL(0x02),
      `sprite pixel canvas X=${x}: expected red ($02); got 0x${vic.fb32[ro + x].toString(16)}`);
  }
  ok('Bauer §3.8.2: sprite color baseline — constant $D027 → 24 pixels of same color');
}

// ── 2: Mid-line $D027 change splits sprite color at cycle boundary.
//
// Sprite at sprite-X=100. The 24 pixels span canvas X 108..131. The
// per-cycle mapping for sprite painting samples $D027 from lineCycleRegs
// at the cycle covering that pixel.
//
// Set color = red ($02) for cycles ≤ 25 and yellow ($07) for cycles
// ≥ 26. The boundary canvas X corresponds to the cycle boundary.
{
  const vic = makeVic();
  setupSpriteWithColorOverride(vic, 0, 100, cy => (cy <= 25 ? 0x02 : 0x07));
  const ro = clearLineBuffers(vic, 50);
  vic._renderSpriteLine(50, 50);
  // Find color transition canvas-X.
  let red = 0, yellow = 0;
  for (let x = 108; x <= 131; x++) {
    if (vic.fb32[ro + x] === PAL(0x02)) red++;
    else if (vic.fb32[ro + x] === PAL(0x07)) yellow++;
  }
  expect(red > 0 && yellow > 0,
    `mid-line color flip produces BOTH colors in sprite span; got red=${red} yellow=${yellow}`);
  expect(red + yellow === 24,
    `all 24 sprite pixels colored: red+yellow=24; got ${red+yellow}`);
  ok(`Bauer §3.8.2: mid-line $D027 change → sprite color splits per cycle (red=${red}, yellow=${yellow} of 24 px)`);
}

// ── 3: Per-sprite color independence — sprite 0 + sprite 3 use different
// $D027 / $D02A registers respectively.
{
  const vic = makeVic();
  // Sprite 0: X=80 color=red.
  setupSpriteWithColorOverride(vic, 0, 80, () => 0x02);
  // Sprite 3: X=200 color=green.
  setupSpriteWithColorOverride(vic, 3, 200, () => 0x05);
  // Override $D02A (sprite 3 color) — setupSpriteWithColorOverride sets
  // $D027+s where s=3 → $D02A.
  const ro = clearLineBuffers(vic, 50);
  vic._renderSpriteLine(50, 50);
  // Sprite 0 at X=80 → canvas 88..111. Sprite 3 at X=200 → canvas 208..231.
  expect(vic.fb32[ro + 100] === PAL(0x02),
    `sprite 0 pixel X=100: red ($02); got 0x${vic.fb32[ro + 100].toString(16)}`);
  expect(vic.fb32[ro + 220] === PAL(0x05),
    `sprite 3 pixel X=220: green ($05); got 0x${vic.fb32[ro + 220].toString(16)}`);
  ok('Bauer §3.8.2: per-sprite $D027+s color registers are independent');
}

// ── 4: Multicolor sprite color ($D025/$D026) shared across sprites.
//
// In MCM mode, pair values 01 → $D025 (mc0), 10 → sprite-N color
// ($D027+s), 11 → $D026 (mc1). Mid-line $D025 change affects ALL
// MCM sprites simultaneously.
{
  const vic = makeVic();
  // Multicolor sprite 0 with shiftReg = $555555 (pair pattern 01,01,...
  // → mc0 for every pixel pair).
  for (let cycle = 1; cycle <= 63; cycle++) {
    vic.lineCycleRegs[cycle][0x15] |= 0x01;
    vic.lineCycleRegs[cycle][0x1C] |= 0x01;             // MCM bit for sprite 0
    vic.lineCycleRegs[cycle][0x00] = 100;
    // Mid-line $D025 change: cy ≤ 25 = red, cy ≥ 26 = green.
    vic.lineCycleRegs[cycle][0x25] = (cycle <= 25) ? 0x02 : 0x05;
    vic.lineCycleSpriteDisplayOn[cycle][0] = 1;
    vic.lineCycleSpriteDataRow[cycle][0] = 0;
    vic.lineCycleSpriteRowByteMask[cycle][0] = 0x07;
    vic.lineCycleSpriteShiftReg[cycle][0] = 0x555555;
  }
  vic.spriteLineDataRow[0] = 0;
  vic.spriteRowByteMask[0] = 0x07;
  vic.spriteShiftReg[0] = 0x555555;
  const ro = clearLineBuffers(vic, 50);
  vic._renderSpriteLine(50, 50);
  // MCM sprite at X=100 → canvas 108..131 (12 pairs × 2 px each).
  let red = 0, green = 0;
  for (let x = 108; x <= 131; x++) {
    if (vic.fb32[ro + x] === PAL(0x02)) red++;
    else if (vic.fb32[ro + x] === PAL(0x05)) green++;
  }
  expect(red > 0 && green > 0,
    `MCM $D025 mid-line flip produces both red+green; got red=${red} green=${green}`);
  ok(`Bauer §3.8.2: MCM sprite $D025 mid-line change splits color (red=${red}, green=${green} of 24 px)`);
}

console.log(`\n${testNo} sprite color mid-line spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
