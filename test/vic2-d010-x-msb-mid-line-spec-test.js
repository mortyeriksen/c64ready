// $D010 sprite X-MSB mid-line change PIXEL spec test.
//
// Bauer §3.8.2: each sprite's X coordinate is 9-bit. The low 8 bits
// live in $D000 + (sprite*2); the high bit (MSB) lives in $D010 bit N.
// Effective X = $D000+s | ($D010 bit N << 8). With +8 canvas offset,
// canvas-X = sprite-X + 8.
//
// $D010 is sampled LIVE per pixel by the sprite X-comparator. A mid-
// frame $D010 write moves the sprite's effective X by 256 pixels (with
// canvas-X wrap if it crosses $1F8 = the line-tick boundary).
//
// Demo use: nine.prg's multiplexer flips $D010 bits per line to push
// sprites across the X=256 boundary. If our impl uses a stale snapshot
// of $D010, the sprite positions drift.
//
// Audit gap: $D010 mid-line MSB change — sprite-x-comparator-spec-test
// tests static MSB values; this tests DYNAMIC MSB writes between sprite
// display lines.

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
  for (let b = 0; b < 64; b++) vic.ram[0x0800 + b] = 0xFF;
  vic.ram[0x07F8] = 0x20;
  return vic;
}

function driveTo(vic, raster, cy) {
  let safety = 312 * CYCLES_PER_LINE * 4;
  while (--safety && !(vic.raster === raster && vic.cycleInLine === cy)) vic.clock(1);
  if (safety <= 0) throw new Error(`driveTo timed out`);
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

// ── 1: Sprite-X = 100, MSB=0 → canvas X 108..131. Sanity.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18;
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x10;
  vic.regs[0x21] = 0x06;
  vic.regs[0x27] = 0x02;
  vic.regs[0x00] = 100;
  vic.regs[0x01] = 80;
  vic.regs[0x10] = 0x00;
  vic.regs[0x15] = 0x01;
  vic.displayEnabled = true;
  driveTo(vic, 90, 1);
  driveTo(vic, 91, 0);   // cy0 of next line: line 90 rendered, not yet cleared (#1)
  const span = spriteSpan(vic, 90 - 15);
  expect(span.first === 108, `MSB=0: first=108; got ${span.first}`);
  expect(span.count === 24, `width=24; got ${span.count}`);
  ok('Bauer §3.8.2: MSB=0 → sprite-X 100 paints canvas X=108..131');
}

// ── 2: Sprite-X = 356 (low=100, MSB=1) → sequencer fires at canvas X 364..383.
//
// Bauer §3.8.2: the sprite-X comparator runs across the entire raster
// (including borders). The sequencer's pixel-emit + sprite-sprite
// collision latch is therefore unaffected by border visibility. fb32
// paint IS gated by the border, so we probe the always-populated
// spriteCollisionBuffer to verify the sprite logic ran at the expected
// canvas X under the closed right border.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18;
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x10;
  vic.regs[0x21] = 0x06;
  vic.regs[0x27] = 0x02;
  vic.regs[0x00] = 100;             // low=100
  vic.regs[0x01] = 80;
  vic.regs[0x10] = 0x01;            // MSB=1 → effective X=356
  vic.regs[0x15] = 0x01;
  vic.displayEnabled = true;
  driveTo(vic, 90, 1);
  driveTo(vic, 91, 0);   // cy0 of next line: line 90 rendered, not yet cleared (#1)
  const ro = (90 - 15) * CANVAS_W;
  // Effective X=356 + 8 (canvas offset) = 364. Width=24 non-X-expand
  // sprite. Pixels 364..387 — the last 4 are off-canvas (CANVAS_W=384).
  let first = -1, last = -1, count = 0;
  for (let x = 0; x < CANVAS_W; x++) {
    if ((vic.spriteCollisionBuffer[x] & 0x01) !== 0) {
      if (first < 0) first = x;
      last = x;
      count++;
    }
  }
  expect(first === 364,
    `Bauer §3.8.2: MSB=1 effective X=356 → sequencer first fires at canvas X=364; got ${first}`);
  expect(count === 20,
    `MSB=1 X=356: 20 in-canvas sequencer emits (364..383, last 4 off-canvas); got ${count}`);
  ok('Bauer §3.8.2: MSB=1 effective X=356 → sprite sequencer fires at canvas 364..383 (collision latch unaffected by border)');
}

// ── 3: Mid-frame $D010 MSB flip — sprite jumps 256 pixels between bands.
//
// Band A: raster 50..70, MSB=0, low=100 → canvas 108..131.
// Band B: raster 120..140, MSB=1, low=44 → effective X=300 → canvas 308..331.
//
// Verify both bands paint at expected positions in their own row range.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18;
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x10;
  vic.regs[0x21] = 0x06;
  vic.regs[0x27] = 0x02;
  vic.regs[0x10] = 0x00;
  vic.regs[0x15] = 0x01;
  vic.regs[0x00] = 100;
  vic.regs[0x01] = 50;
  vic.displayEnabled = true;
  driveTo(vic, 60, 1);
  driveTo(vic, 61, 0);   // cy0 of next line (#1)
  const spanA = spriteSpan(vic, 60 - 15);
  expect(spanA.first === 108,
    `band A (MSB=0, low=100): first=108; got ${spanA.first}`);
  // Mid-frame: flip MSB=1 + new sprite-X-low + new Y for band B.
  driveTo(vic, 80, 1);
  vic.write(0x01, 120);             // new Y
  vic.write(0x00, 44);              // new X-low
  vic.write(0x10, 0x01);            // MSB → 1
  driveTo(vic, 130, 1);
  driveTo(vic, 131, 0);   // cy0 of next line (#1)
  const spanB = spriteSpan(vic, 130 - 15);
  expect(spanB.first === 308,
    `band B (MSB=1, low=44, effective X=300): first=308; got ${spanB.first}`);
  // (Per-line side buffers (#1): band A's row no longer coexists with band B's
  // — cross-line corruption is structurally impossible; spanA verified band A.)
  ok('Bauer §3.8.2: mid-frame $D010 MSB flip → sprite jumps 200 px between bands');
}

// ── 4: Multi-sprite $D010 — bits 0..7 are independent. Setting bit 3
// only affects sprite 3.
//
// Sprite 0 X-low=50, MSB=0 → effective 50, canvas 58.
// Sprite 3 X-low=44, MSB=1 → effective 300, canvas 308.
//
// Sprite pointer addresses: $07F8..$07FF (VM $0400 + $3F8 + sprite).
{
  const vic = makeVic();
  // Need sprite 3 data setup too. Sprite pointer at $07FB → $0840 (= $21 * 64).
  for (let b = 0; b < 64; b++) vic.ram[0x0840 + b] = 0xFF;
  vic.ram[0x07FB] = 0x21;
  vic.regs[0x11] = 0x18;
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x10;
  vic.regs[0x21] = 0x06;
  vic.regs[0x00] = 50;              // sprite 0 X-low
  vic.regs[0x06] = 44;              // sprite 3 X-low ($D006 = sprite 3 X)
  vic.regs[0x01] = 80;              // sprite 0 Y
  vic.regs[0x07] = 80;              // sprite 3 Y ($D007)
  vic.regs[0x10] = 0x08;            // bit 3 set → sprite 3 MSB=1; sprite 0 MSB=0
  vic.regs[0x15] = 0x09;            // sprites 0 + 3 enabled
  vic.regs[0x27] = 0x02;            // sprite 0 = red
  vic.regs[0x2A] = 0x05;            // sprite 3 = green ($D027+3)
  vic.displayEnabled = true;
  driveTo(vic, 90, 1);
  driveTo(vic, 91, 0);   // cy0 of next line: line 90 rendered, not yet cleared (#1)
  const span0 = spriteSpan(vic, 90 - 15, 0);
  const span3 = spriteSpan(vic, 90 - 15, 3);
  expect(span0.first === 58,
    `sprite 0 (MSB=0, low=50): canvas 58; got ${span0.first}`);
  expect(span3.first === 308,
    `sprite 3 (MSB=1, low=44, effective=300): canvas 308; got ${span3.first}`);
  ok('Bauer §3.8.2: $D010 bits are independent — bit 3 → sprite 3 MSB only');
}

console.log(`\n${testNo} $D010 X-MSB mid-line spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
