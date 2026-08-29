// $D012/$D011 raster compare mid-line write spec test.
//
// Bauer §3.12 + VICE addendum: the raster IRQ comparator is
// EDGE-TRIGGERED. It fires when `match` transitions from FALSE to
// TRUE (low-to-high edge of the comparator output). The latch
// state is `_lastRasterMatch` — once true, the comparator must
// see a "dip" (match goes false) before it can re-fire on the
// same line.
//
// Mid-line writes can:
//   (a) Change target away from current raster → match goes
//       FALSE → next match opportunity is when raster reaches
//       new target.
//   (b) Change target TO current raster → match goes TRUE,
//       but if it was already TRUE just before (no dip), the
//       edge detector should NOT re-fire.
//   (c) Change target with $D011 RST8 bit toggle → 9-bit target
//       shifts by 256 → match changes accordingly.
//
// Stable-IRQ chains rely on (a) — handler ACKs $D019, sets
// $D012 to next target raster, RTI; next match fires at the
// new target.
//
// Audit gap: mid-line $D012/$D011-RST8 raster compare write
// timing — `raster-compare-9bit-spec-test.js` covers TARGET
// VALUES but not mid-line WRITES.

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
  return vic;
}

function driveTo(vic, raster, cy) {
  let safety = 312 * CYCLES_PER_LINE * 3;
  while (--safety && !(vic.raster === raster && vic.cycleInLine === cy)) vic.clock(1);
  if (safety <= 0) throw new Error(`driveTo timeout`);
}

// ── 1: Match at raster $50, ack, change target to $60 mid-line.
// Verify next IRQ fires at $60, NOT a spurious re-fire on $50.
{
  const vic = makeVic();
  vic.write(0x12, 0x50);
  vic.write(0x1A, 0x01);
  // Drive past the cy 1 raster-IRQ check of raster $50 so IRQ has fired.
  driveTo(vic, 0x50, 5);
  expect((vic.irqStatus & 0x01) === 0x01,
    `raster $50: IRQ fired at cy 1; latched in irqStatus`);
  // Ack via $D019 write and change target to $60.
  vic.write(0x19, 0x01);                 // ack
  vic.write(0x12, 0x60);                 // new target
  expect((vic.irqStatus & 0x01) === 0,
    `post-ack: irqStatus bit 0 cleared`);
  // Drive past cy 1 of raster $51..$5F — none should fire.
  for (let r = 0x51; r < 0x60; r++) {
    driveTo(vic, r, 5);
    expect((vic.irqStatus & 0x01) === 0,
      `raster $${r.toString(16)}: no spurious raster IRQ (target=$60); got irqStatus=0x${vic.irqStatus.toString(16)}`);
  }
  // Drive to raster $60 cy 5. IRQ should fire there.
  driveTo(vic, 0x60, 5);
  expect((vic.irqStatus & 0x01) === 0x01,
    `raster $60: IRQ fires at new target; irqStatus=0x${vic.irqStatus.toString(16)}`);
  ok('Bauer §3.12: mid-line $D012 write changes target; next IRQ fires at new raster');
}

// ── 2: Set target = current raster mid-line, BEFORE the cy-1 fire.
//
// At raster $50 cy 0, IRQ has NOT yet fired (fires at cy 1). Write
// $D012 = $50 (= matching current raster) at cy 0. Then cy 1 check
// fires IRQ as expected.
{
  const vic = makeVic();
  vic.write(0x12, 0x40);                 // pre-line target
  vic.write(0x1A, 0x01);
  // Drive past raster $40 IRQ to clear it.
  driveTo(vic, 0x40, 5);
  vic.write(0x19, 0x01);                 // ack
  driveTo(vic, 0x50, 0);
  // At cy 0 of $50, check that no IRQ fired yet.
  expect((vic.irqStatus & 0x01) === 0,
    `cy 0 raster $50: IRQ not yet fired (no target match)`);
  // Change target to $50 at cy 0.
  vic.write(0x12, 0x50);
  driveTo(vic, 0x50, 5);
  expect((vic.irqStatus & 0x01) === 0x01,
    `cy 1+: IRQ fires for newly-matched target $50; got irqStatus=0x${vic.irqStatus.toString(16)}`);
  ok('Bauer §3.12: mid-line $D012 write THIS-raster (pre-cy-1) fires THIS line IRQ');
}

// ── 3: $D011 RST8 mid-line write shifts target by 256.
//
// Target = $50 (RST8=0). At cy 5 of raster $50 (IRQ already fired,
// acked), write $D011 with RST8=1 → new target = $150. IRQ should NOT
// fire again until raster reaches $150 (= 336, which is past PAL line
// 311, so wraps around → never on this frame).
{
  const vic = makeVic();
  vic.write(0x12, 0x50);
  vic.write(0x1A, 0x01);
  driveTo(vic, 0x50, 5);
  expect((vic.irqStatus & 0x01) === 0x01, `IRQ fired at $50`);
  vic.write(0x19, 0x01);                 // ack
  // Set RST8 in $D011. Preserve other bits.
  const oldD011 = vic.regs[0x11];
  vic.write(0x11, oldD011 | 0x80);
  // Now target = $150. Drive to end of frame (raster 311) and verify
  // no spurious IRQ.
  driveTo(vic, 311, 60);
  expect((vic.irqStatus & 0x01) === 0,
    `target $150 (RST8=1) — no raster in this PAL frame matches; got 0x${vic.irqStatus.toString(16)}`);
  ok('Bauer §3.12: $D011 RST8 write shifts target by 256 (no match in frames where new target out of range)');
}

// ── 4: Repeated same-target write does NOT cause spurious re-fire
// (edge-trigger).
{
  const vic = makeVic();
  vic.write(0x12, 0x50);
  vic.write(0x1A, 0x01);
  driveTo(vic, 0x50, 5);
  vic.write(0x19, 0x01);                 // ack first fire
  // Re-write same target $50. Should NOT re-fire (raster already at
  // $50, comparator was last seen as match, ack cleared the latch but
  // did not reset _lastRasterMatch).
  vic.write(0x12, 0x50);
  // Drive a few cycles, no IRQ.
  driveTo(vic, 0x50, 30);
  expect((vic.irqStatus & 0x01) === 0,
    `same-target re-write: no spurious re-fire (edge-triggered); got 0x${vic.irqStatus.toString(16)}`);
  ok('Bauer §3.12 + VICE: edge-triggered comparator — same-target write does not re-fire same line');
}

console.log(`\n${testNo} raster compare mid-line write spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
