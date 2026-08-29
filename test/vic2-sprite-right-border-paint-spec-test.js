// Sprite paint coverage across an opened right border (§3.14.1 hyperscreen).
//
// Bauer §3.14.1 cycle-56 trick: writing CSEL=1→0 at PHI2 of cycle 56
// vetoes the right-SET FF, leaving the main border flip-flop reset.
// Per Bauer §3.8.2 the sprite priority multiplexer paints sprite
// pixels everywhere they're emitted; the border overlay (§3.9) gates
// only the FINAL fb32 write. So once the border is opened by the
// trick, every sprite pixel in cycles 55..57 must paint VISIBLY.
//
// User-visible failure mode: a sprite that spans cycles 55..57 leaves
// a horizontal gap in its middle 1/3 (cycle 56's segment, canvas X
// 360..367) on demos that rely on this trick (FppScroller, demos with
// sprite-driven right-side bars). The existing csel-veto-sprite-
// rollback test T5 only checks "at least 1 pixel" — it cannot surface
// a middle-of-sprite gap.
//
// This test exercises the FULL pixel range of a sprite that straddles
// the cycle-55/56/57 boundary and asserts every pixel paints.

import { VIC2, CYCLES_PER_LINE, CANVAS_W, C64_PALETTE } from '../src/vic2.js';

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

const PAL = (i) => (0xFF000000 |
  ((C64_PALETTE[i] & 0xFF) << 16) |
  (C64_PALETTE[i] & 0xFF00) |
  ((C64_PALETTE[i] >> 16) & 0xFF)) >>> 0;

function makeVic() {
  const v = new VIC2();
  // This test asserts MID-LINE render internals (fb32 sampled at cycle 58),
  // which only the live incremental path exhibits — under the Tier-3
  // line-batch mode pixels land at line end or on a CPU observer event,
  // both byte-identical at every CPU-observable point. Pin the live path
  // so a LINE_BATCH=1 suite run still tests this contract.
  v.lineBatchRender = false;
  v.ram = new Uint8Array(0x10000);
  v.colorRam = new Uint8Array(0x0400);
  v.charRom = new Uint8Array(0x1000);
  v.currentVicBank = 0;
  return v;
}

function driveTo(vic, raster, cycle) {
  let safety = 312 * CYCLES_PER_LINE * 2;
  while (!(vic.raster === raster && vic.cycleInLine === cycle)) {
    vic.clock(1);
    if (--safety <= 0) throw new Error(`drive timeout`);
  }
}

// ── 1: Sprite straddling cy 55/56/57 — every pixel painted after veto.
//
// Sprite 0 X=344 (MSB=1, low=88 → 256+88=344). Canvas X start = 352.
// Span 24 px: canvas X 352..375.
//   cy 55 segment (X 352..359): sprite px 0..7
//   cy 56 segment (X 360..367): sprite px 8..15 ← user's reported gap zone
//   cy 57 segment (X 368..375): sprite px 16..23
// Sprite data all-1s (0xFF) on every row → every pixel must be yellow.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;            // DEN=1, RSEL=1, YSCROLL=3
  vic.regs[0x16] = 0x08;            // CSEL=1
  vic.displayEnabled = true;
  vic.regs[0x15] = 0x01;            // sp0 enabled
  vic.regs[0x27] = 0x07;            // sp0 yellow
  vic.regs[0x00] = 88;              // low byte of X
  vic.regs[0x10] = 0x01;            // X-MSB bit 0 → X=344
  vic.regs[0x01] = 99;              // Y=99 → DMA latches L99, display L100+
  vic.regs[0x21] = 0x06;            // bg blue
  vic.regs[0x20] = 0x0E;            // border lt blue
  // Sprite all-1s data block at $2000.
  for (let i = 0; i < 63; i++) vic.ram[0x2000 + i] = 0xFF;
  vic.ram[0x07F8] = 0x80;           // sp0 pointer → $2000

  driveTo(vic, 100, 55);
  vic.clock(1);                     // cy 56
  vic.write(0x16, 0x00);            // open right border (cy 56 phi2)
  vic.clock(1);                     // cy 57 — veto fires
  vic.clock(1);                     // cy 58

  const canvasY = 100 - 15;
  const ro = canvasY * CANVAS_W;
  const yellow = PAL(0x07);

  // Sprite spans canvas X 352..375 (24 pixels, sprite-color YELLOW).
  // After the veto, EVERY pixel must be yellow — no middle-of-sprite
  // gap allowed. This is the spec-correct prediction: the priority
  // multiplexer paints sprite over background, and the opened border
  // does not interpose.
  let gapsByCycle = { cy55: 0, cy56: 0, cy57: 0 };
  for (let x = 352; x < 376; x++) {
    const got = vic.fb32[ro + x];
    if (got !== yellow) {
      if (x < 360) gapsByCycle.cy55++;
      else if (x < 368) gapsByCycle.cy56++;
      else gapsByCycle.cy57++;
    }
  }
  expect(gapsByCycle.cy55 === 0,
    `cy 55 segment (X 352..359) sprite pixels must all be yellow (sprite px 0..7); ${gapsByCycle.cy55} gaps`);
  expect(gapsByCycle.cy56 === 0,
    `cy 56 segment (X 360..367) sprite pixels must all be yellow (sprite px 8..15); ${gapsByCycle.cy56} gaps — this is the "middle of right border" gap zone`);
  expect(gapsByCycle.cy57 === 0,
    `cy 57 segment (X 368..375) sprite pixels must all be yellow (sprite px 16..23); ${gapsByCycle.cy57} gaps`);
  ok('Bauer §3.14.1 + §3.8.2: sprite spanning cy 55..57 paints every pixel after hyperscreen veto');
}

// ── 2: spriteOwnerBuffer claimed for every pixel of the sprite span.
//
// Per Bauer §3.8.2 sprite-vs-sprite priority needs the lowest-index
// sprite's ownership to win at every emitted pixel. After the veto,
// the sprite's ownership claim must extend across the entire 24-px
// span — not just the segments rendered post-veto.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.displayEnabled = true;
  vic.regs[0x15] = 0x01;
  vic.regs[0x27] = 0x07;
  vic.regs[0x00] = 88;
  vic.regs[0x10] = 0x01;
  vic.regs[0x01] = 99;
  vic.regs[0x21] = 0x06;
  vic.regs[0x20] = 0x0E;
  for (let i = 0; i < 63; i++) vic.ram[0x2000 + i] = 0xFF;
  vic.ram[0x07F8] = 0x80;

  driveTo(vic, 100, 55);
  vic.clock(1);
  vic.write(0x16, 0x00);
  vic.clock(1);
  vic.clock(1);

  const canvasY = 100 - 15;
  const ro = canvasY * CANVAS_W;
  let ownedByCycle = { cy55: 0, cy56: 0, cy57: 0 };
  for (let x = 352; x < 376; x++) {
    if (vic.spriteOwnerBuffer[x] === 0) {
      if (x < 360) ownedByCycle.cy55++;
      else if (x < 368) ownedByCycle.cy56++;
      else ownedByCycle.cy57++;
    }
  }
  expect(ownedByCycle.cy55 === 8,
    `cy 55: 8 px owned by sp0; got ${ownedByCycle.cy55}`);
  expect(ownedByCycle.cy56 === 8,
    `cy 56: 8 px owned by sp0; got ${ownedByCycle.cy56} — this is the middle-of-right-border gap zone`);
  expect(ownedByCycle.cy57 === 8,
    `cy 57: 8 px owned by sp0; got ${ownedByCycle.cy57}`);
  ok('Bauer §3.8.2: sprite ownership claimed for ALL 24 pixels of a cy 55..57 span after veto');
}

// ── 3: Sprite straddling the cy 56 boundary (sprite starts AT canvas X 360).
//
// Edge case: sprite starts exactly at cy 56's leftmost canvas X
// (X = 360 = sprite-X 352 = MSB=1 + low=96). The first 8 px land in
// cy 56's segment (the gap zone), the next 16 px in cy 57+58. After
// the cy-56 veto, the FIRST sprite pixel must paint.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.displayEnabled = true;
  vic.regs[0x15] = 0x01;
  vic.regs[0x27] = 0x07;
  vic.regs[0x00] = 96;              // low byte: 96 → X = 352 with MSB
  vic.regs[0x10] = 0x01;
  vic.regs[0x01] = 99;
  vic.regs[0x21] = 0x06;
  vic.regs[0x20] = 0x0E;
  for (let i = 0; i < 63; i++) vic.ram[0x2000 + i] = 0xFF;
  vic.ram[0x07F8] = 0x80;

  driveTo(vic, 100, 55);
  vic.clock(1);
  vic.write(0x16, 0x00);
  vic.clock(1);
  vic.clock(1);

  const canvasY = 100 - 15;
  const ro = canvasY * CANVAS_W;
  const yellow = PAL(0x07);
  // Sprite spans canvas X 360..383 (24 px, last 4 off-canvas wraps).
  // First 8 px (X 360..367) are entirely in cy 56's segment — must paint.
  let cy56YellowCount = 0;
  for (let x = 360; x < 368; x++) {
    if (vic.fb32[ro + x] === yellow) cy56YellowCount++;
  }
  expect(cy56YellowCount === 8,
    `sprite at canvas X=360 (cy 56 start) → all 8 px of cy 56 segment must paint yellow; got ${cy56YellowCount}`);
  ok('Bauer §3.14.1: sprite starting AT cy 56 canvas X paints all 8 px in the segment');
}

console.log(`\n${testNo} sprite right-border paint coverage spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
