// VIC-II: Sprite collision IRQ latching (Tests 9-10)
// Extracted from vic2-test.js.

import fs from 'fs';
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
  makeRenderableVic,
} from './_vic2-helpers.js';

// Test 9: sprite-background collision IRQ latches only once until register clear.
{
  const vic = makeVic();
  let irqCalls = 0;
  vic.irqMask = 0x02;
  vic.irqHandler = (state) => { if (state) irqCalls++; };
  vic.graphicsCollisionBuffer[123] = 1;

  vic._processSpritePixelCollision(123, 0, 2);
  vic._processSpritePixelCollision(123, 0, 2);

  assert(vic.regs[0x1F] === 0x04, 'sprite-background collision latches sprite bit');
  assert((vic.irqStatus & 0x82) === 0x82, 'sprite-background collision sets IRQ status bits');
  assert(irqCalls === 1, 'sprite-background collision IRQ fires only once before clear');

  const latched = vic.read(0x1F);
  assert(latched === 0x04, 'reading $D01F returns latched collision bits');
  assert(vic.regs[0x1F] === 0x00, 'reading $D01F clears latched collision bits');

  vic._processSpritePixelCollision(123, 0, 2);
  assert(irqCalls === 2, 'sprite-background collision can re-fire after latch clear');
  console.log('ok  - sprite-background collision latch requires clear before re-fire');
}

// Test 10: sprite-sprite collision IRQ latches only once until register clear.
{
  const vic = makeVic();
  let irqCalls = 0;
  vic.irqMask = 0x04;
  vic.irqHandler = (state) => { if (state) irqCalls++; };

  vic._processSpritePixelCollision(40, 0, 0);
  vic._processSpritePixelCollision(40, 0, 1);
  vic._processSpritePixelCollision(40, 0, 1);

  assert(vic.regs[0x1E] === 0x03, 'sprite-sprite collision latches both sprite bits');
  assert((vic.irqStatus & 0x84) === 0x84, 'sprite-sprite collision sets IRQ status bits');
  assert(irqCalls === 1, 'sprite-sprite collision IRQ fires only once before clear');

  const latched = vic.read(0x1E);
  assert(latched === 0x03, 'reading $D01E returns latched sprite-sprite bits');
  assert(vic.regs[0x1E] === 0x00, 'reading $D01E clears sprite-sprite collision latch');

  vic._processSpritePixelCollision(41, 0, 0);
  vic._processSpritePixelCollision(41, 0, 1);
  assert(irqCalls === 2, 'sprite-sprite collision can re-fire after latch clear');
  console.log('ok  - sprite-sprite collision latch requires clear before re-fire');
}


console.log('\nAll Sprite collision IRQ latching (Tests 9-10) tests passed.');
