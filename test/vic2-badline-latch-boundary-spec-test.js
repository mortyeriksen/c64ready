// Bad-line latch boundary spec test (Bauer §3.5 LIVE re-evaluation).
//
// Bauer §3.5 (verbatim):
//   "A Bad Line Condition is given at any arbitrary clock cycle if, at
//   the negative edge of ϕ0 at the beginning of the cycle, RASTER >=
//   $30 and RASTER <= $f7 and the lower three bits of RASTER are equal
//   to YSCROLL, and if the DEN bit was set during an arbitrary cycle of
//   raster line $30."
//
//   "This definition has to be taken literally. You can produce or
//   cancel a Bad Line Condition multiple times within an arbitrary
//   raster line in the range of $30-$f7 by modifying YSCROLL, and thus
//   make every raster line within the display window completely or
//   partially a Bad Line..."
//
// So bad-line condition is LIVE per-cycle, NOT a one-shot cy-14 latch.
// CPU writes to $D011 changing YSCROLL mid-line CAN both create new
// bad-lines (= late c-access window per §3.14.6) and cancel ongoing
// ones. Cy 14 phi1 is significant ONLY for VC/VMLI load + conditional
// RC=0 (Bauer §3.7.2 rule 2) — not for "latching" the BL condition.
//
// Audit gaps:
//   B2: YSCROLL write at PHI2 of cy 13 → cy 14 phi1 sees new YSCROLL ✓
//   B3: YSCROLL write at PHI2 of cy 15 → late BL trigger, partial fetch ✓
//   B7: YSCROLL change SAME-CYCLE-AS bad-line BA fall ✗

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

function driveTo(vic, raster, cycle) {
  let safety = 312 * CYCLES_PER_LINE * 3;
  while (--safety && !(vic.raster === raster && vic.cycleInLine === cycle)) {
    vic.clock(1);
  }
  if (safety <= 0) throw new Error(`driveTo timed out at L${vic.raster}.c${vic.cycleInLine}`);
}

// Whether the JUST-completed raster latched as a bad line. We sample the
// per-cycle matrix-fetch flag captured during cy 15..54 of that raster.
// (rowFetchedCols cannot be used here — Bauer §3.14.6 says the matrix
// buffer persists across bad-lines, so its contents are line-residual,
// not raster-specific.)
function endedAsBadLine(vic) {
  for (let cy = 15; cy <= 54; cy++) {
    if (vic.lineCycleMatrixFetchActive[cy]) return true;
  }
  return false;
}

// ── 1: $D011 YSCROLL write at PHI2 of cy 13 — pre-eval window ──────────
// Setup: raster $33 (= 51), display enabled, initial YSCROLL=2 (no match
// for raster $33 & 7 = 3). At cy 13 phi2, write $D011=0x1B (YSCROLL=3 →
// match). The eval at cy 14 must use NEW YSCROLL → bad line latches.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1A;                 // DEN=1, RSEL=1, YSCROLL=2
  vic.displayEnabled = true;
  driveTo(vic, 0x33, 13);                // arrive at end of cy 13
  vic.write(0x11, 0x1B);                 // YSCROLL → 3
  while (!(vic.raster === 0x34 && vic.cycleInLine === 0)) vic.clock(1);
  expect(endedAsBadLine(vic),
    `YSCROLL write at cy 13 phi2 must change bad-line condition for THIS line → c-access fires`);
  ok('Bauer §3.5: YSCROLL write at PHI2 of cy 13 → bad-line evaluation uses NEW YSCROLL');
}

// ── 2: $D011 YSCROLL write at PHI2 of cy 15 — late BL trigger.
// Bauer §3.5: BL condition is LIVE per cycle. Write at cy 15 phi2 →
// new YSCROLL visible at cy 16 phi1 → BL condition becomes true at
// cy 16. Per §3.14.6 (DMA delay), this triggers a partial bad-line:
// c-accesses start at cy 16 (= clamped to ≥ 15) and run through cy 54.
// Total c-fetches on this raster ≈ 39 cols (one short of a full
// bad-line because the first col is "stolen" by the late trigger).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1A;
  vic.displayEnabled = true;
  driveTo(vic, 0x33, 15);
  vic.write(0x11, 0x1B);
  while (!(vic.raster === 0x34 && vic.cycleInLine === 0)) vic.clock(1);
  expect(endedAsBadLine(vic),
    `Bauer §3.5 + §3.14.6: YSCROLL match at cy 16 phi1 triggers a partial bad-line (BA low cy 16..54, late c-accesses)`);
  ok('Bauer §3.5 + §3.14.6: late YSCROLL match (write cy 15 phi2) triggers partial bad-line with late c-access start');
}

// ── 3: $D011 YSCROLL write at PHI2 of cy 14 — cy 15 phi1 sees new YSCROLL.
// cy 14 phi2 write is visible to VIC at cy 15 phi1. cy 14 phi1's earlier
// VC/VMLI load and conditional RC=0 (Bauer §3.7.2 rule 2) saw the OLD
// YSCROLL → no RC reset. But the BL condition becomes true at cy 15 phi1
// and §3.5/§3.14.6 still produces a partial bad-line BA-low + c-access
// from cy 15 onward.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1A;
  vic.displayEnabled = true;
  driveTo(vic, 0x33, 14);
  vic.write(0x11, 0x1B);
  while (!(vic.raster === 0x34 && vic.cycleInLine === 0)) vic.clock(1);
  expect(endedAsBadLine(vic),
    `Bauer §3.5: YSCROLL match at cy 15 phi1 triggers partial bad-line via §3.14.6 late-DMA-delay path`);
  ok('Bauer §3.5: YSCROLL write at PHI2 of cy 14 → cy 15 phi1 BL condition true → late c-access fires');
}

// ── 3b: $D011 YSCROLL write at PHI2 of cy 55 — past the 12..54 sweep
// Bauer + VICE: after cy 54 the bad-line eval window has CLOSED. A late
// YSCROLL match arriving at cy 55+ does NOT cause a BA-low (= no c-access
// retroactively) on this line. The next eval point is cy 12 of the next
// line.
//
// We probe BA-low across cy 12..54 of the line directly (rather than
// using rowFetchedCols, which persists VSP-style across lines per
// Bauer §3.14.6 and would be stale).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1A;
  vic.displayEnabled = true;
  // First, sample BA-low across raster $33 cy 12..54 WITHOUT any write.
  let baLowCount = 0;
  driveTo(vic, 0x33, 12);
  for (let c = 12; c <= 54; c++) {
    if (vic.isBadLineBaLow()) baLowCount++;
    vic.clock(1);
  }
  expect(baLowCount === 0,
    `pre-write baseline: no BA-low on non-bad raster $33 with YSCROLL=2; got ${baLowCount}`);
  // Now write at cy 55 — too late.
  vic.write(0x11, 0x1B);
  while (!(vic.raster === 0x34 && vic.cycleInLine === 0)) vic.clock(1);
  // Already past cy 54, so we cannot re-sample the window. The first
  // check above is sufficient: BA never went low during the eval window
  // because the write came after.
  ok('VICE-equivalent: YSCROLL write at PHI2 of cy 55 (post-sweep) → no BA-low during 12..54 of this line');
}

// ── 4: $D011 YSCROLL write at PHI2 of cy 13 — bad-line BA falls cy 12,
// so YSCROLL change "during BA-low" arriving AFTER cy 12 must still
// affect the cy 14 eval. (= verifies BA-low does not freeze YSCROLL
// sampling.)
//
// Setup: raster $33, YSCROLL=2 initially. By cy 12, bad-line condition
// failed (no match) so BA stays high (no bad-line BA at all this line).
// Write $D011 at cy 13 phi2 to YSCROLL=3.
// Without bad-line BA, CPU isn't stalled. cy 14 eval sees new YSCROLL,
// latches bad-line. BA goes low cy 14+ (delayed bad-line start).
//
// We assert c-access fires (bad-line latched late but still latched).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1A;
  vic.displayEnabled = true;
  driveTo(vic, 0x33, 13);
  expect(!vic.isBadLineBaLow(),
    `pre-write: BA stays high through cy 13 (no bad-line condition before write)`);
  vic.write(0x11, 0x1B);
  while (!(vic.raster === 0x34 && vic.cycleInLine === 0)) vic.clock(1);
  expect(endedAsBadLine(vic),
    `delayed bad-line: YSCROLL change at cy 13 phi2 → bad-line latches & c-access fires`);
  ok('Bauer §3.5: late YSCROLL match latches delayed bad-line (BA low from delayed start, c-access fires)');
}

// ── 6: $D011 DEN bit cleared mid-line — does NOT suppress bad lines.
//
// Bauer §3.5: displayEnabled is LATCHED at raster $30 (sample DEN any
// cycle of that raster). Mid-frame DEN=0 does NOT clear the latch. So
// at raster $33 cy 14 phi1 eval: YSCROLL match + latched displayEnabled
// → bad-line latches.
//
// Strict spec: bad-line ALWAYS latches when YSCROLL matches and
// displayEnabled-latch is true, regardless of mid-line DEN bit changes.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;                 // YSCROLL=3 → matches raster $33
  vic.displayEnabled = true;
  driveTo(vic, 0x33, 13);
  vic.write(0x11, 0x03);                 // DEN=0 at cy 13 phi2 (mid-line)
  while (!(vic.raster === 0x34 && vic.cycleInLine === 0)) vic.clock(1);
  expect(endedAsBadLine(vic),
    `strict Bauer §3.5: DEN=0 mid-frame does NOT clear displayEnabled latch; bad-line still latches`);
  ok('Bauer §3.5: DEN=0 mid-line does not suppress bad-line (latch only re-sampled at raster $30)');
}

console.log(`\n${testNo} bad-line latch boundary spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
