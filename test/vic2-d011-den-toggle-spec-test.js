// $D011 DEN (Display Enable) toggle mid-frame spec test.
//
// Bauer §3.5: the bad-line latch (`displayEnabled` internal flag) is
// sampled FROM $D011 bit 4 (DEN) at any cycle of raster line $30 (48).
// If DEN was high at any point during raster $30, displayEnabled is
// latched true for the whole frame. Subsequent mid-frame $D011 writes
// that clear DEN do NOT suppress bad lines until the next raster $30
// re-samples.
//
// Common bug shapes:
//   - Treating live $D011 DEN bit as the bad-line gate (= mid-frame
//     DEN=0 wrongly suppresses bad lines for current frame).
//   - Failing to re-sample at raster $30 (= one-frame stale latch).
//
// Audit gap: badline-latch-spec-test test R6 ("clearing DEN mid-frame
// does NOT suppress bad lines until next $30 sample") covers this
// generally. This test pins specific scenarios (mid-line DEN clear,
// DEN re-set at $30, DEN flipping rapidly).

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
  vic.regs[0x11] = 0x1B;                    // DEN=1 at start
  vic.displayEnabled = true;
  return vic;
}

function driveTo(vic, raster, cy) {
  let safety = 312 * CYCLES_PER_LINE * 3;
  while (--safety && !(vic.raster === raster && vic.cycleInLine === cy)) vic.clock(1);
  if (safety <= 0) throw new Error(`driveTo timeout`);
}

// ── 1: DEN=0 mid-frame after raster $30 latch — current frame's bad
// lines KEEP firing (latch sticky).
{
  const vic = makeVic();
  // Drive past raster $30 to latch displayEnabled.
  driveTo(vic, 0x35, 0);
  expect(vic.displayEnabled === true,
    `pre-write: displayEnabled latched true (DEN=1 at $30)`);
  // Clear DEN bit mid-frame at raster $35.
  vic.write(0x11, 0x0B);                    // DEN=0
  expect((vic.regs[0x11] & 0x10) === 0,
    `regs[0x11] DEN=0 after write`);
  // displayEnabled latch should still be true.
  expect(vic.displayEnabled === true,
    `displayEnabled latch sticky (Bauer §3.5: only $30 re-samples DEN)`);
  // Bad line at raster $33 ($33 & 7 = 3, YSCROLL=3) — wait, raster $33
  // already passed. Next bad line under YSCROLL=3 = $3B.
  driveTo(vic, 0x3B, 30);
  expect(vic.isBadLineBaLow(),
    `raster $3B: bad-line BA still fires despite DEN=0 (latched)`);
  ok('Bauer §3.5: DEN=0 mid-frame does NOT suppress bad lines (per-frame latch sticky)');
}

// ── 2: DEN=0 ACROSS raster $30 — frame has NO bad lines.
{
  const vic = makeVic();
  // Pre-clear DEN before $30.
  driveTo(vic, 0x20, 0);
  vic.write(0x11, 0x0B);
  vic.displayEnabled = false;               // simulate as if latch was reset
  // Drive past $30 with DEN=0 throughout.
  driveTo(vic, 0x35, 0);
  expect(vic.displayEnabled === false,
    `DEN=0 across $30: displayEnabled stays false`);
  // No bad-line BA at $3B.
  driveTo(vic, 0x3B, 30);
  expect(!vic.isBadLineBaLow(),
    `raster $3B: no bad-line BA (latched off); got isBadLineBaLow=${vic.isBadLineBaLow()}`);
  ok('Bauer §3.5: DEN=0 across raster $30 → latch false → no bad lines this frame');
}

// ── 3: DEN re-enabled MID-frame, then next-frame $30 re-latches.
//
// Setup: DEN=0 across raster $30 (frame has no bad lines). Mid-frame
// set DEN=1. Bad lines should STILL be suppressed (latch not re-sampled).
// Drive to next frame's $30 — DEN=1 latches displayEnabled true.
{
  const vic = makeVic();
  driveTo(vic, 0x20, 0);
  vic.write(0x11, 0x0B);
  vic.displayEnabled = false;
  driveTo(vic, 0x35, 0);
  // Mid-frame re-set DEN=1.
  vic.write(0x11, 0x1B);
  expect(vic.displayEnabled === false,
    `mid-frame DEN=1 does NOT immediately latch displayEnabled`);
  // Drive to NEXT frame's raster $30 cy 0.
  driveTo(vic, 0, 1);                       // frame wrap
  driveTo(vic, 0x30, 0);
  // Now displayEnabled should re-sample DEN. With DEN=1 at $30,
  // displayEnabled latches true.
  driveTo(vic, 0x30, 5);
  expect(vic.displayEnabled === true,
    `next frame $30: displayEnabled re-latches from DEN=1`);
  ok('Bauer §3.5: displayEnabled re-samples DEN at every frame\'s raster $30');
}

// ── 4: DEN bit position in $D011 — verify only bit 4 controls DEN.
{
  const vic = makeVic();
  driveTo(vic, 0x20, 0);
  // Write $D011 with various bit 4 settings; others vary.
  vic.write(0x11, 0x10);                    // DEN=1, rest 0
  vic.displayEnabled = false;
  driveTo(vic, 0x30, 5);
  expect(vic.displayEnabled === true,
    `$D011 = 0x10 (DEN=1 only): latches displayEnabled`);

  // Reset, write $D011 = 0xEF (everything EXCEPT DEN).
  const vic2 = makeVic();
  driveTo(vic2, 0x20, 0);
  vic2.write(0x11, 0xEF);                   // DEN=0, all other bits 1
  vic2.displayEnabled = false;
  driveTo(vic2, 0x30, 5);
  expect(vic2.displayEnabled === false,
    `$D011 = 0xEF (everything but DEN): displayEnabled stays false`);
  ok('Bauer §3.5: only $D011 bit 4 (DEN) gates the per-frame displayEnabled latch');
}

console.log(`\n${testNo} $D011 DEN toggle spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
