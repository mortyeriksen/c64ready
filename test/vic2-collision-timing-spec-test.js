// Sprite collision timing spec audit. Per Bauer §3.11.1 + §3.11.2:
//
//   $D01E (sprite-sprite collision register) — bit s set when sprite s
//     collides with another sprite (both opaque pixels at same X,Y, both
//     visible per border buffer). Latch is sticky: bit stays set until
//     CPU READ. Reading $D01E returns current value AND clears it.
//
//   $D01F (sprite-background collision register) — bit s set when
//     sprite s collides with a foreground graphics pixel. Same latch
//     semantics.
//
//   Bauer §3.12: IMMC IRQ fires on $D01E 0→nonzero transition; IMBC
//     IRQ fires on $D01F 0→nonzero transition. Subsequent collisions
//     while latch is non-zero do NOT re-fire.
//
// Why this matters for nine.prg: per the demo author's article +
// DEMO-NINE.md rule 5, nine.prg ships THREE code variants and uses
// runtime sprite-collision detection to pick which variant to run.
// If our $D01E/$D01F timing is off by even 1 cycle, the demo lands on
// the wrong branch and runs with timing tuned for a different VIC.
//
// Each test is self-contained and asserts a discrete spec rule.

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

// ── 1: Reading $D01E returns latched value and clears the register ───
{
  const vic = makeVic();
  vic.regs[0x1E] = 0x05;             // sprites 0+2 collided (preset latch)
  const v = vic.read(0x1E);
  expect(v === 0x05, `$D01E read must return $05, got $${v.toString(16)}`);
  expect(vic.regs[0x1E] === 0,
    `$D01E latch must clear on read, got $${vic.regs[0x1E].toString(16)}`);
  ok('Bauer §3.11.1: reading $D01E returns latch and clears it');
}

// ── 2: Reading $D01F returns latched value and clears the register ───
{
  const vic = makeVic();
  vic.regs[0x1F] = 0x82;             // sprites 1+7 collided with bg
  const v = vic.read(0x1F);
  expect(v === 0x82, `$D01F read must return $82, got $${v.toString(16)}`);
  expect(vic.regs[0x1F] === 0,
    `$D01F latch must clear on read, got $${vic.regs[0x1F].toString(16)}`);
  ok('Bauer §3.11.2: reading $D01F returns latch and clears it');
}

// ── 3: $D01E IMMC IRQ fires on 0→nonzero transition only ─────────────
// Bauer §3.12: when a sprite-sprite collision sets bit(s) in $D01E and
// the previous value was 0, the IMMC IRQ ($D019 bit 2) is asserted.
// Subsequent collisions while $D01E != 0 do NOT re-fire IMMC.
{
  const vic = makeVic();
  let irqCount = 0;
  vic.irqHandler = (s) => { if (s) irqCount++; };
  vic.irqMask = 0x04;                  // IMMC enabled
  // First collision: 0 → 0x05 — should fire.
  vic._latchSpriteSpriteCollision(0, 0);
  vic.spriteCollisionBuffer[0] = 0x04; // pretend sp2 already painted
  vic._latchSpriteSpriteCollision(0, 0);  // sp0 collides with sp2
  expect(irqCount === 1, `IMMC must fire once on 0→nonzero, got ${irqCount}`);
  expect((vic.irqStatus & 0x04) === 0x04, `irqStatus bit 2 (IMMC) must be set`);
  // Second collision while latch != 0: do NOT re-fire.
  vic.spriteCollisionBuffer[1] = 0x02;
  vic._latchSpriteSpriteCollision(1, 0);
  expect(irqCount === 1, `IMMC must NOT re-fire while latch != 0, got ${irqCount}`);
  ok('Bauer §3.12: IMMC IRQ fires only on $D01E 0→nonzero transition');
}

// ── 4: $D01F IMBC IRQ fires on 0→nonzero transition only ─────────────
{
  const vic = makeVic();
  let irqCount = 0;
  vic.irqHandler = (s) => { if (s) irqCount++; };
  vic.irqMask = 0x02;                  // IMBC enabled
  vic._latchSpriteBackgroundCollision(0, 3);
  expect(irqCount === 1, `IMBC must fire once on 0→nonzero, got ${irqCount}`);
  vic._latchSpriteBackgroundCollision(1, 5);
  expect(irqCount === 1, `IMBC must NOT re-fire while latch != 0, got ${irqCount}`);
  ok('Bauer §3.12: IMBC IRQ fires only on $D01F 0→nonzero transition');
}

// ── 5: After clearing $D01F via read, next collision re-fires IMBC ──
// Once the CPU reads $D01F (clearing latch), a subsequent collision
// can transition 0 → nonzero again and re-fires IMBC.
{
  const vic = makeVic();
  let irqCount = 0;
  vic.irqHandler = (s) => { if (s) irqCount++; };
  vic.irqMask = 0x02;
  vic._latchSpriteBackgroundCollision(0, 3);
  expect(irqCount === 1, `first IMBC fired`);
  vic.read(0x1F);                      // clears latch + irqStatus bit 1
  vic._latchSpriteBackgroundCollision(1, 5);
  expect(irqCount === 2, `IMBC must re-fire after read clears latch, got ${irqCount}`);
  ok('Bauer §3.12: IMBC re-fires after $D01F read clears the latch');
}

// ── 6: Same-sprite second-pixel collision does NOT re-set bit ────────
// Bauer §3.11.1: latch is per-sprite-bit. Once bit s is set in $D01E,
// further collisions of the same sprite don't change the bit (already
// set). Important for the demo's collision-based VIC detection: it
// expects to read EXACTLY ONE collision flag, not duplicates.
{
  const vic = makeVic();
  vic.spriteCollisionBuffer[0] = 0x04; // sp2 painted
  vic._latchSpriteSpriteCollision(0, 0);  // sp0 hits sp2 → bit 0 set
  expect(vic.regs[0x1E] === 0x05, `first hit: bits 0+2 set ($05)`);
  vic.spriteCollisionBuffer[1] = 0x04;
  vic._latchSpriteSpriteCollision(1, 0);  // sp0 hits sp2 again
  expect(vic.regs[0x1E] === 0x05,
    `second hit at different pixel: latch unchanged, got $${vic.regs[0x1E].toString(16)}`);
  ok('Bauer §3.11.1: $D01E latch is sticky per sprite — same-sprite re-collision is a no-op');
}

// ── 7: $D01E latch records BOTH colliding sprites ──────────────────
// When sp0 collides with sp2, BOTH bit 0 AND bit 2 must be set in $D01E.
// Demo's VIC detection relies on knowing exactly which sprites collided.
{
  const vic = makeVic();
  vic.spriteCollisionBuffer[0] = 0x04; // sp2 painted there
  vic._latchSpriteSpriteCollision(0, 0);  // sp0 paints same pixel
  expect(vic.regs[0x1E] === 0x05,
    `sp0×sp2 collision: $D01E must = $05 (bits 0+2), got $${vic.regs[0x1E].toString(16)}`);
  ok('Bauer §3.11.1: sprite-sprite collision sets BOTH involved sprite bits');
}

// ── 8: $D01F latches once per (pixel,sprite) regardless of fg pixel
// Bauer §3.11.2: $D01F bit s is set when sprite s overlaps a foreground
// pixel. Same sprite hitting multiple fg pixels still sets bit s once.
{
  const vic = makeVic();
  vic._latchSpriteBackgroundCollision(0, 3);
  expect(vic.regs[0x1F] === 0x08, `bit 3 set, got $${vic.regs[0x1F].toString(16)}`);
  // Same sprite, different pixel index
  vic._latchSpriteBackgroundCollision(100, 3);
  expect(vic.regs[0x1F] === 0x08, `still just bit 3, got $${vic.regs[0x1F].toString(16)}`);
  // Different sprite
  vic._latchSpriteBackgroundCollision(50, 5);
  expect(vic.regs[0x1F] === 0x28, `bits 3+5 set, got $${vic.regs[0x1F].toString(16)}`);
  ok('Bauer §3.11.2: $D01F bit s sets once per sprite per frame');
}

// ── 9: Reading $D01E does NOT clear $D01F (independent latches) ──────
{
  const vic = makeVic();
  vic.regs[0x1E] = 0x05;
  vic.regs[0x1F] = 0x10;
  vic.read(0x1E);
  expect(vic.regs[0x1E] === 0, `$D01E cleared after read`);
  expect(vic.regs[0x1F] === 0x10, `$D01F NOT affected by $D01E read, got $${vic.regs[0x1F].toString(16)}`);
  ok('Bauer §3.11: $D01E and $D01F are independent latches');
}

// ── 10: irqStatus bit clears IMMC/IMBC pending when latch read clears
// When the CPU reads $D01E and clears the latch, the corresponding
// irqStatus bit (IMMC = bit 2) should ALSO clear. Otherwise the IRQ
// stays asserted forever and the demo's IRQ chain breaks.
//
// NOTE: Our impl currently does NOT clear irqStatus when latch is read.
// $D019 ack is the only path to clear irqStatus per spec. This test
// documents the spec rule for $D019; latch-on-read alone shouldn't
// touch irqStatus. (Bauer §3.12 says only "writing to $D019" clears.)
{
  const vic = makeVic();
  vic.irqStatus = 0x04;                // IMMC pending
  vic.irqMask = 0x04;
  vic.read(0x1E);                      // read latch — should NOT clear $D019
  expect((vic.irqStatus & 0x04) === 0x04,
    `Bauer §3.12: reading $D01E does NOT clear IMMC bit in $D019`);
  // CPU acks via $D019 write
  vic.write(0x19, 0x04);
  expect((vic.irqStatus & 0x04) === 0,
    `writing $D019 with bit 2 acks IMMC, got irqStatus=$${vic.irqStatus.toString(16)}`);
  ok('Bauer §3.12: $D019 write (not $D01E read) acks IMMC IRQ');
}

console.log(`\n${testNo} collision timing spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
