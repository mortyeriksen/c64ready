// Sprite multiplexer PIXEL POSITION spec test.
//
// Bauer §3.8.1 + §3.8.2: a single sprite can be re-used across multiple
// Y bands in one frame by repeatedly latching new sprite-Y / sprite-X /
// $D015 values between bands. The pixels of each band must appear at
// the X coordinate that was active when that band started its display.
//
// Coverage gap audit (2026-05-18): "actual sprite multiplexer positions"
// — ✗ before this file. sprite-multiplexer-spec-test.js covers DMA
// lifecycle (Y match, display FF, MC counter) at the state level;
// sprite-x-comparator-spec-test.js covers single-Y canvas-X placement.
// Neither covers the multiplexer END-TO-END: same sprite at multiple
// Y/X positions in one frame, all painting at the correct canvas X.

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
  // Sprite data: all 63 bytes = $FF (solid 24×21 sprite).
  // Sprite pointer at $07F8+s = $20 → sprite data at $0800.
  for (let b = 0; b < 64; b++) vic.ram[0x0800 + b] = 0xFF;
  vic.ram[0x07F8] = 0x20;    // sprite 0 pointer → $0800
  return vic;
}

function driveTo(vic, r, c) {
  let safety = 312 * CYCLES_PER_LINE * 4;
  while (!(vic.raster === r && vic.cycleInLine === c)) {
    vic.clock(1);
    if (--safety <= 0) throw new Error(`drive timeout reaching r${r} c${c}`);
  }
}

// Count canvas X positions on a given raster row where sprite 0 painted.
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

// ── 1: Band A (Y=80, X=100) — sprite paints at canvas X=108..131.
// Bauer §3.8.2: sprite-X N → canvas-X N+8. Sprite displays for 21 lines
// starting Y+1 (= raster 81..101).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18;
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x10;
  vic.regs[0x20] = 0x0E;
  vic.regs[0x21] = 0x06;
  vic.regs[0x27] = 0x02;     // sprite 0 colour = red
  vic.regs[0x00] = 100;      // sprite 0 X
  vic.regs[0x01] = 80;       // sprite 0 Y
  vic.regs[0x10] = 0x00;     // X MSB clear
  vic.regs[0x15] = 0x01;     // enable sprite 0
  vic.displayEnabled = true;

  // Drive past Y match + DMA-on cycles to a known display line in the
  // 21-line window (raster 90 = Y+10).
  driveTo(vic, 90, 1);
  driveTo(vic, 91, 0);   // cy0 of next line: line 90 rendered, not yet cleared (#1)

  const canvasY = 90 - 15;
  const span = spriteSpan(vic, canvasY);
  expect(span.count === 24,
    `band A: standard sprite must paint 24 pixels, got ${span.count}`);
  expect(span.first === 108,
    `band A sprite-X=100 → canvas-X first=108 (+8 offset), got ${span.first}`);
  expect(span.last === 131,
    `band A: canvas-X last=131 (108+23), got ${span.last}`);
  ok('Bauer §3.8.2: multiplex band A — sprite-X=100 at Y=80 paints canvas X=108..131');
}

// ── 2: Single-frame multiplex: band A (Y=50,X=80) then band B (Y=120,X=200).
// Real demos rewrite sprite-Y and sprite-X between bands. We do the same
// here mid-frame and assert pixels from each band land at their own
// expected canvas X.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18;
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x10;
  vic.regs[0x20] = 0x0E;
  vic.regs[0x21] = 0x06;
  vic.regs[0x27] = 0x02;
  vic.regs[0x10] = 0x00;
  vic.regs[0x15] = 0x01;
  vic.displayEnabled = true;
  // Band A setup: Y=50, X=80.
  vic.regs[0x01] = 50;
  vic.regs[0x00] = 80;

  // Drive to mid of band A (raster 60).
  driveTo(vic, 60, 1);
  driveTo(vic, 61, 0);   // cy0 of next line (#1)
  const spanA = spriteSpan(vic, 60 - 15);
  expect(spanA.first === 88,
    `band A multiplex: sprite-X=80 → canvas-X 88, got ${spanA.first}`);
  expect(spanA.count === 24,
    `band A multiplex: 24 px, got ${spanA.count}`);

  // After band A finishes (raster ≥ 71+1=72), CPU rewrites Y/X for band B.
  driveTo(vic, 80, 1);
  vic.write(0x01, 120);      // new Y
  vic.write(0x00, 200);      // new X
  // Drive into band B (raster ≥ 121).
  driveTo(vic, 130, 1);
  driveTo(vic, 131, 0);   // cy0 of next line (#1)
  const spanB = spriteSpan(vic, 130 - 15);
  expect(spanB.first === 208,
    `band B multiplex: sprite-X=200 → canvas-X 208, got ${spanB.first}`);
  expect(spanB.count === 24,
    `band B multiplex: 24 px, got ${spanB.count}`);
  // (Per-line side buffers (#1): band A's row and band B's row never share
  // buffer storage in time — cross-line corruption is structurally impossible;
  // spanA above already verified band A.)

  ok('Bauer §3.8.1 + §3.8.2: same sprite multiplexed at Y=50/X=80 and Y=120/X=200 → pixels at both expected canvas-X positions');
}

// ── 3: Mid-band X change is sampled per-pixel — moving sprite-X DURING
// the 21-line display window shifts the sprite for subsequent lines.
// Demos use this for smooth-X sprite motion. Bauer §3.8.2: $D000+s is
// sampled live by the X-comparator.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18;
  vic.regs[0x16] = 0x08;
  vic.regs[0x18] = 0x10;
  vic.regs[0x20] = 0x0E;
  vic.regs[0x21] = 0x06;
  vic.regs[0x27] = 0x02;
  vic.regs[0x10] = 0x00;
  vic.regs[0x15] = 0x01;
  vic.regs[0x01] = 50;
  vic.regs[0x00] = 80;
  vic.displayEnabled = true;

  driveTo(vic, 55, 1);
  driveTo(vic, 56, 0);   // cy0 of next line (#1)
  const spanEarly = spriteSpan(vic, 55 - 15);
  expect(spanEarly.first === 88,
    `mid-band start: X=80 → canvas 88, got ${spanEarly.first}`);

  // Move sprite X mid-display.
  driveTo(vic, 60, 1);
  vic.write(0x00, 120);      // X → 120
  driveTo(vic, 65, 1);
  driveTo(vic, 66, 0);   // cy0 of next line (#1)
  const spanLate = spriteSpan(vic, 65 - 15);
  expect(spanLate.first === 128,
    `mid-band post X-change: X=120 → canvas 128, got ${spanLate.first}`);
  ok('Bauer §3.8.2: mid-display sprite-X change shifts pixel position on subsequent lines (smooth X motion)');
}

console.log(`\n${testNo} sprite multiplexer pixel-position spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
