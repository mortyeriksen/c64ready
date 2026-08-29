// Sprite collision IRQ propagation spec audit. 10 tests derived from
// Bauer §3.11 (collision detection) and §3.12 (raster IRQ).
//
// $D01E: sprite-sprite collision register (read-and-clear).
// $D01F: sprite-graphics (foreground) collision register (read-and-clear).
// $D019 ICR status:
//   bit 0 = raster IRQ
//   bit 1 = sprite-graphics collision (IMBC)
//   bit 2 = sprite-sprite collision (IMMC)
//   bit 3 = light pen
//   bit 7 = combined IRQ pending
// $D01A: ICR mask (same bit layout, bit 7 unused for write)
//
// IRQ semantics:
//   - $D01E/$D01F bits set on opaque-pixel coincidence
//   - IRQ status bit set on 0→non-zero TRANSITION of $D01E/$D01F (one-shot)
//   - IRQ line raised when status & mask & 0x0F
//   - reading $D01E or $D01F clears the register but NOT the IRQ status
//   - $D019 W1C clears the IRQ status

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
  const { color = 2, shiftReg = 0xFFFFFF } = opts;
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

function clearLine(vic, cy) {
  const ro = cy * CANVAS_W;
  vic.borderBuffer.fill(0, 0, CANVAS_W);
  vic.graphicsPriorityBuffer.fill(0, 0, CANVAS_W);
  vic.graphicsCollisionBuffer.fill(0, 0, CANVAS_W);
  vic.spriteCollisionBuffer.fill(0, 0, CANVAS_W);
  vic.spriteOwnerBuffer.fill(0xFF, 0, CANVAS_W);
  return ro;
}

// ── 1: $D01E latches sprite-sprite collision on overlap ────────────────
{
  const vic = makeVic();
  setupSprite(vic, 0, 100);
  setupSprite(vic, 1, 110);
  clearLine(vic, 50);
  vic._renderSpriteLine(50, 50);
  expect((vic.regs[0x1E] & 0x03) === 0x03,
    `sp0+sp1 overlap: $D01E bits 0,1 must set, got $${vic.regs[0x1E].toString(16)}`);
  ok('Bauer §3.11: $D01E sets bits for both colliding sprites');
}

// ── 2: $D019 bit 2 (IMMC) latches on first sprite-sprite collision ─────
{
  const vic = makeVic();
  vic.irqStatus = 0;
  setupSprite(vic, 0, 100);
  setupSprite(vic, 1, 110);
  clearLine(vic, 50);
  vic._renderSpriteLine(50, 50);
  expect((vic.irqStatus & 0x04) !== 0,
    `IMMC: $D019 bit 2 must latch on 0→non-zero $D01E, got $${vic.irqStatus.toString(16)}`);
  ok('Bauer §3.12: $D019 bit 2 (IMMC) latches on sprite-sprite collision');
}

// ── 3: IRQ line raised when IMMC + mask bit 2 set ──────────────────────
{
  let irqAsserted = false;
  const vic = makeVic();
  vic.irqHandler = (s) => { if (s) irqAsserted = true; };
  vic.write(0x1A, 0x04);   // mask bit 2 → IMMC
  setupSprite(vic, 0, 100);
  setupSprite(vic, 1, 110);
  clearLine(vic, 50);
  vic._renderSpriteLine(50, 50);
  expect(irqAsserted === true,
    `IMMC + mask: IRQ line must assert on collision`);
  ok('Bauer §3.12: IMMC + $D01A mask bit 2 = IRQ asserted');
}

// ── 4: IRQ NOT re-fired on subsequent collisions while $D01E non-zero ──
// Bauer §3.12: ICR bit only sets on 0→non-zero transition. While
// $D01E remains non-zero, additional collisions do NOT re-set the
// IRQ status — preventing IRQ flooding.
{
  const vic = makeVic();
  vic.write(0x1A, 0x04);
  setupSprite(vic, 0, 100);
  setupSprite(vic, 1, 110);
  clearLine(vic, 50);
  vic._renderSpriteLine(50, 50);
  // Acknowledge IRQ via $D019 W1C but DON'T read $D01E.
  vic.write(0x19, 0x04);
  expect((vic.regs[0x1E] & 0x03) === 0x03,
    `pre: $D01E still has collision bits set`);
  expect((vic.irqStatus & 0x04) === 0, `IRQ status cleared by W1C`);
  // Render again — collision repeats but $D01E was non-zero, so no fresh IRQ.
  let secondIrq = false;
  vic.irqHandler = (s) => { if (s) secondIrq = true; };
  clearLine(vic, 51);
  vic._renderSpriteLine(50, 51);
  expect(secondIrq === false,
    `subsequent collision while $D01E≠0 must NOT re-fire IRQ`);
  ok('Bauer §3.12: collision IRQ fires only on 0→non-zero $D01E transition');
}

// ── 5: Reading $D01E clears it (read-and-clear) ────────────────────────
{
  const vic = makeVic();
  vic.regs[0x1E] = 0xAA;
  expect(vic.read(0x1E) === 0xAA, `first read returns latched value`);
  expect(vic.read(0x1E) === 0, `second read clears`);
  ok('Bauer §3.11: $D01E is read-and-clear');
}

// ── 6: Reading $D01E does NOT clear $D019 IRQ status ───────────────────
{
  const vic = makeVic();
  vic.regs[0x1E] = 0xAA;
  vic.irqStatus = 0x04;
  vic.read(0x1E);
  expect((vic.irqStatus & 0x04) === 0x04,
    `reading $D01E must NOT touch $D019 IRQ status`);
  ok('Bauer §3.11: $D01E read-clear does not affect $D019 status');
}

// ── 7: $D01F sprite-graphics collision register is read-and-clear ──────
{
  const vic = makeVic();
  vic.regs[0x1F] = 0x55;
  expect(vic.read(0x1F) === 0x55, `first read returns latched`);
  expect(vic.read(0x1F) === 0, `second read clears`);
  ok('Bauer §3.11: $D01F is read-and-clear');
}

// ── 8: Single sprite (no overlap) does not set $D01E ───────────────────
{
  const vic = makeVic();
  setupSprite(vic, 0, 100);
  vic.regs[0x1E] = 0;
  clearLine(vic, 50);
  vic._renderSpriteLine(50, 50);
  expect(vic.regs[0x1E] === 0,
    `single sprite no overlap: $D01E must stay 0`);
  ok('Bauer §3.11: single sprite without overlap leaves $D01E clear');
}

// ── 9: $D01A IRQ mask gates IRQ line, not status latch ─────────────────
{
  let irqAsserted = false;
  const vic = makeVic();
  vic.irqHandler = (s) => { if (s) irqAsserted = true; };
  vic.write(0x1A, 0x00);   // all IRQs masked off
  setupSprite(vic, 0, 100);
  setupSprite(vic, 1, 110);
  clearLine(vic, 50);
  vic._renderSpriteLine(50, 50);
  expect(irqAsserted === false,
    `IRQ mask=0: IRQ line must NOT assert`);
  expect((vic.irqStatus & 0x04) !== 0,
    `but $D019 status bit 2 still latches independently of mask`);
  ok('Bauer §3.12: $D01A mask gates IRQ line; $D019 status latches anyway');
}

// ── 10: $D019 W1C clears specific bits, not all ────────────────────────
{
  const vic = makeVic();
  vic.irqStatus = 0x07;        // bits 0, 1, 2 set
  vic.write(0x19, 0x02);        // clear bit 1 only
  expect((vic.irqStatus & 0x07) === 0x05,
    `W1C of bit 1: bits 0,2 must remain, got $${(vic.irqStatus & 0x07).toString(16)}`);
  ok('Bauer §3.12: $D019 W1C is per-bit (only bits with 1 written are cleared)');
}

console.log(`\n${testNo} sprite-collision IRQ spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
