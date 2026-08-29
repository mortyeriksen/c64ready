// $D015 sprite-enable mid-line ENABLE spec test.
//
// Bauer §3.8.1 + VICE: $D015 (sprite enable bits) is sampled by the
// VIC's sprite-DMA latch at cycle 55 (DMA-on check). A mid-line write
// to $D015 to ENABLE a sprite has different semantics depending on
// when the write lands:
//
//   - Write at cy ≤ 54: $D015 sample at cy 55 sees new value → sprite
//     latches DMA on this line (if Y matched).
//   - Write at cy ≥ 56: sample already happened → no DMA on this line;
//     sprite turns on next line.
//
// (sprite-lifecycle-spec-test.js R "$D015 disable mid-display does not
// stop active DMA" covers the DISABLE case. This file covers ENABLE.)
//
// Audit gap: $D015 mid-line ENABLE (turn ON).

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';

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
  let safety = 312 * CYCLES_PER_LINE * 3;
  while (--safety && !(vic.raster === raster && vic.cycleInLine === cy)) vic.clock(1);
  if (safety <= 0) throw new Error(`driveTo timeout`);
}

// ── 1: $D015 enable at cy 50 (pre cycle-55 DMA-on check) + Y match → DMA
// latches THIS line.
//
// Setup: raster $50, sprite 0 Y matches at $50 (Y=$50). $D015 = 0 pre-line.
// Write $D015 = 0x01 at cy 50 phi2 (before cy 55 DMA-on check).
// Sprite 0 DMA should turn on this line.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x01] = 0x50;       // sprite 0 Y match for raster $50
  vic.regs[0x15] = 0x00;       // initially disabled
  vic.displayEnabled = true;
  driveTo(vic, 0x50, 50);
  expect(vic.spriteDmaOn[0] === 0,
    `pre-write at cy 50: sprite 0 DMA off`);
  vic.write(0x15, 0x01);
  driveTo(vic, 0x50, 56);
  expect(vic.spriteDmaOn[0] === 1,
    `post-cy 55: $D015 enable at cy 50 with Y match → sprite 0 DMA on (latched this line)`);
  ok('Bauer §3.8.1: $D015 enable at cy ≤ 54 + Y match → sprite DMA latches THIS line');
}

// ── 2: $D015 enable at cy 56 (post DMA-on check) → DMA does NOT turn on
// this line. Next line, with Y still matching, DMA also won't turn on
// (Y match only fires once per match raster).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x01] = 0x50;
  vic.regs[0x15] = 0x00;
  vic.displayEnabled = true;
  driveTo(vic, 0x50, 56);
  expect(vic.spriteDmaOn[0] === 0,
    `pre-write at cy 56: sprite 0 DMA off (Y match raster but $D015=0 at cy 55 check)`);
  vic.write(0x15, 0x01);
  // Drive to next line.
  driveTo(vic, 0x51, 56);
  expect(vic.spriteDmaOn[0] === 0,
    `next line: Y no longer matches ($51 ≠ $50) → DMA stays off`);
  ok('Bauer §3.8.1: $D015 enable at cy ≥ 55 misses this line\'s DMA-on check');
}

// ── 3: $D015 enable WITHOUT Y match — no DMA, sprite stays off.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x01] = 0xA0;       // Y=$A0, raster $50 doesn't match
  vic.regs[0x15] = 0x00;
  vic.displayEnabled = true;
  driveTo(vic, 0x50, 50);
  vic.write(0x15, 0x01);
  driveTo(vic, 0x50, 60);
  expect(vic.spriteDmaOn[0] === 0,
    `no Y match: enable bit alone does NOT turn DMA on; got DMA=${vic.spriteDmaOn[0]}`);
  ok('Bauer §3.8.1: $D015 enable without Y match → no DMA (Y match is mandatory)');
}

// ── 4: Multi-sprite — enable sprite 0 + 3 simultaneously via $D015=$09.
{
  const vic = makeVic();
  // Sprite 3 data setup.
  for (let b = 0; b < 64; b++) vic.ram[0x0840 + b] = 0xFF;
  vic.ram[0x07FB] = 0x21;
  vic.regs[0x11] = 0x1B;
  vic.regs[0x01] = 0x50;       // sprite 0 Y
  vic.regs[0x07] = 0x50;       // sprite 3 Y
  vic.regs[0x15] = 0x00;
  vic.displayEnabled = true;
  driveTo(vic, 0x50, 50);
  vic.write(0x15, 0x09);       // enable sprites 0 + 3
  driveTo(vic, 0x50, 56);
  expect(vic.spriteDmaOn[0] === 1, `sprite 0 DMA latched`);
  expect(vic.spriteDmaOn[3] === 1, `sprite 3 DMA latched`);
  expect(vic.spriteDmaOn[1] === 0, `sprite 1 not enabled, no DMA`);
  ok('Bauer §3.8.1: $D015 multi-bit enable latches all matched sprites simultaneously');
}

console.log(`\n${testNo} $D015 mid-line enable spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
