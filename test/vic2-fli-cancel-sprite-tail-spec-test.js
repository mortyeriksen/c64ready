// Integration spec test for the Coma Light 13 FLI-cancel plasma setup — the
// scenario the AEC delay-line model exists to serve. Unlike the
// synthetic vic2-aec-ba-gap-contiguity test (which hand-pokes the BA history),
// this drives the REAL sprite-DMA + bad-line machinery over a raster line and
// asserts the spec-correct BA/AEC contour and the bad-line cancel.
//
// The effect, per line:
//   1. A Bad Line Condition is armed at cy0 (YSCROLL == RASTER&7), set by the
//      previous line's write.  (Bauer §3.5)
//   2. The 8 sprites are in DMA, so sprite BA holds low through the line head
//      and releases by ~cy10.  (Bauer §3.6.1/§3.8)  → BA is HIGH at cy11.
//   3. The bad line pulls BA low again from cy12 (3-cy lead before the c-access
//      at cy15).  (Bauer §3.6.3)
//   4. The per-line `STY $D011` store lands at ~cy12 and rewrites YSCROLL to a
//      NON-matching value, cancelling the Bad Line before any c-access.
//      (Bauer §3.5: "you can produce or cancel a Bad Line ... by modifying
//      YSCROLL"; §3.7.1: c-accesses only run while the condition holds.)
//
// The critical spec property (Bauer §3.6.1): AEC is the BA *delay line* — it
// only drops after BA has been low for 3 CONTINUOUS cycles, and a single
// BA-high cycle resets the delay. So the sprite tail (low …cy10) and the
// bad-line BA (low cy12+) are SEPARATE low-runs: the gap at cy11 means AEC must
// stay HIGH across the cy12-14 bad-line lead-in. That high window is exactly
// what lets the cy12 `STY $D011` *write* complete on time (writes proceed when
// AEC is high) and cancel the bad line — keeping the FLI loop phase-locked.
// The old endpoint-only AEC test (BA(c) && BA(c-3)) wrongly read AEC low at
// cy12-13 (because the sprite tail sat at c-3), stalling the store 2cy and
// collapsing the plasma.

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';

let testNo = 0, testsFailing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else {
    testsFailing++; console.log(`FAIL test ${testNo}: ${label}`);
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
  // DEN=1, RSEL=1, YSCROLL=3 → raster 51 (51&7=3) is a Bad Line.
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x15] = 0x80; // sprite 7 enabled
  vic.displayEnabled = true;
  return vic;
}

function driveTo(vic, raster, cy) {
  let safety = 312 * CYCLES_PER_LINE * 3;
  while (--safety && !(vic.raster === raster && vic.cycleInLine === cy)) vic.clock(1);
  if (safety <= 0) throw new Error(`drive timeout at L${vic.raster}.c${vic.cycleInLine}`);
}
const aec = (vic) => (vic.isAecLowPhi2 ? vic.isAecLowPhi2() : vic.isAecLow());

// ── Test 1: BA/AEC contour — sprite-DMA tail + gap + bad-line lead-in ───
// Sprite 7 DMA (p@9 / s@10) → sprite BA low cy6..10. Gap at cy11. Bad-line BA
// cy12..54. AEC (3-contiguous) must be: low at cy9,10; HIGH at cy11..14; low
// from cy15.
{
  const vic = makeVic();
  driveTo(vic, 51, 1);
  vic.spriteDmaOn[7] = 1;        // synthesize sprite-7 DMA (AGENTS.md: ok to set directly)

  const rec = {};
  // sample cy1, then step. Keep DMA asserted through the sprite-tail cycles
  // (the sprite sequencer would otherwise clear it at cy16, after the tail).
  for (let n = 0; n < 18; n++) {
    const cy = vic.cycleInLine;
    if (cy <= 10) vic.spriteDmaOn[7] = 1;
    rec[cy] = {
      spr: vic._spriteBaLow(cy),
      bad: vic.isBadLineBaLow(),
      aec: aec(vic),
    };
    vic.clock(1);
  }

  // BA sources are separate low-runs with a gap at cy11.
  expect(rec[10] && rec[10].spr === true, `cy10: sprite-DMA BA low (sprite 7 s-access); got ${rec[10] && rec[10].spr}`);
  expect(rec[11] && rec[11].spr === false && rec[11].bad === false,
    `cy11: BA HIGH (sprite tail ended cy10, bad-line BA not until cy12); got spr=${rec[11] && rec[11].spr} bad=${rec[11] && rec[11].bad}`);
  expect(rec[12] && rec[12].bad === true, `cy12: bad-line BA low (3-cy lead before c-access@15); got ${rec[12] && rec[12].bad}`);

  // AEC delay-line: low only after 3 CONTIGUOUS BA-low cycles.
  expect(rec[10] && rec[10].aec === true, `cy10: AEC LOW (sprite BA low cy7..10 = 3+ contiguous); got aecLow=${rec[10] && rec[10].aec}`);
  expect(rec[11] && rec[11].aec === false, `cy11: AEC HIGH (BA rose); got aecLow=${rec[11] && rec[11].aec}`);
  expect(rec[12] && rec[12].aec === false,
    `cy12: AEC HIGH despite sprite tail at cy9,10 — the cy11 gap reset the delay line; got aecLow=${rec[12] && rec[12].aec}`);
  expect(rec[13] && rec[13].aec === false, `cy13: AEC HIGH (only 2 contiguous bad-line BA-low cycles); got aecLow=${rec[13] && rec[13].aec}`);
  expect(rec[14] && rec[14].aec === false, `cy14: AEC HIGH (bad-line lead-in, write-proceed window); got aecLow=${rec[14] && rec[14].aec}`);
  expect(rec[15] && rec[15].aec === true, `cy15: AEC LOW (bad-line BA low cy12,13,14,15 = 3-cy delay elapsed); got aecLow=${rec[15] && rec[15].aec}`);
  ok('Bauer §3.6.1: sprite-DMA tail + cy11 gap + bad-line lead-in — AEC stays HIGH cy11..14 (the FLI cy12 STY $D011 write-proceed window)');
}

// ── Test 2: the cy12 STY $D011 store cancels the bad line (no c-accesses) ──
// With AEC high at cy12 the write proceeds; rewriting YSCROLL to a NON-matching
// value at cy12 cancels the Bad Line before the c-access window (cy15..54), so
// the matrix is NOT fetched and the CPU is never stalled for 40 cycles. This is
// the per-line FLI cancel that keeps Coma's plasma loop phase-locked.
{
  const vic = makeVic();
  let cAcc = 0;
  const origFetch = vic._fetchScreenRowColumn.bind(vic);
  vic._fetchScreenRowColumn = function (...a) { cAcc++; return origFetch(...a); };

  driveTo(vic, 51, 1);
  vic.spriteDmaOn[7] = 1;

  // advance to cy12, keeping the sprite tail asserted
  while (vic.cycleInLine !== 12) { if (vic.cycleInLine <= 10) vic.spriteDmaOn[7] = 1; vic.clock(1); }

  // sanity: bad line is armed/queued at this point
  expect(vic._isBadLine(51, vic.regs) === true, `cy12 pre-write: raster 51 is still a Bad Line (YSCROLL matches); got ${vic._isBadLine(51, vic.regs)}`);
  // the cy12 store: rewrite YSCROLL to a non-matching value (4 != 51&7=3)
  vic.write(0x11, 0x1C);
  expect(vic._isBadLine(51, vic.regs) === false, `cy12 post-write: Bad Line Condition cancelled (YSCROLL now 4); got ${vic._isBadLine(51, vic.regs)}`);

  // run out the c-access window
  for (let target = 13; target <= 60; target++) vic.clock(1);

  expect(cAcc === 0, `no c-accesses run after the cy12 cancel (matrix not fetched); got ${cAcc}`);
  expect(vic.lineMatrixFetchCol < 0, `matrix-fetch column never armed after cancel; got ${vic.lineMatrixFetchCol}`);
  ok('Bauer §3.5/§3.7.1: a cy12 YSCROLL store cancels the armed Bad Line — 0 c-accesses, no 40-cycle CPU stall (FLI per-line cancel)');
}

// ── Test 3: contrast — NO gap (sprite tail abuts the bad line) → AEC low ──
// If sprite DMA instead held BA low right up to cy11 (no gap), the bad-line BA
// at cy12 would continue a contiguous run and AEC WOULD be low at cy12 — i.e.
// the test above is discriminating, not vacuous. Sprite 6 (p@7/s@8) + sprite 7
// (p@9/s@10) give BA low cy4..10; to abut cy12 we additionally hold cy11 by
// poking the external-BA history (models a sprite whose access reaches cy11).
{
  const vic = makeVic();
  driveTo(vic, 51, 1);
  vic.spriteDmaOn[7] = 1;
  for (let n = 0; n < 14; n++) { if (vic.cycleInLine <= 10) vic.spriteDmaOn[7] = 1; vic.clock(1); }
  // now at ~cy15; force a contiguous low run into cy11 and re-evaluate cy12.
  // Drive a fresh line is overkill — assert the delay-line rule directly on the
  // history helper for the no-gap case to prove discrimination.
  vic.lineCycleExternalBaLow[9] = 1; vic.lineCycleExternalBaLow[10] = 1;
  vic.lineCycleExternalBaLow[11] = 1;             // NO gap
  vic.cycleInLine = 12; vic._thisCycleInLine = 12;
  vic.lineBadLineDisplayPending = true; vic.lineBadLineStartCycle = 15; vic.lineMatrixFetchCol = -1;
  expect(aec(vic) === true,
    `no-gap control: BA low cy9,10,11 + bad-line cy12 = 4 contiguous → AEC must be LOW at cy12; got aecLow=${aec(vic)}`);
  ok('discrimination: with NO cy11 gap (contiguous BA-low into the bad line) AEC IS low at cy12 — the cy11-gap result is real, not vacuous');
}

console.log(`\n${testNo} FLI-cancel sprite-tail spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
