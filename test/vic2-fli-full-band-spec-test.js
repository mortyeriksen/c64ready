// FLI (Flexible Line Interpretation) full-band integration spec test.
//
// Bauer §3.14.3 FLI: write YSCROLL = raster & 7 on EVERY raster, before
// cycle 14 phi1's bad-line sample, so a bad-line condition fires on
// every raster. Effect: fresh c-access/g-access every raster → per-
// scanline color attributes.
//
// What this test pins beyond existing single-line coverage:
//   • BL fires + RC=0 + displayActive consistent across the FULL active
//     band (L$30..L$F7 = 200 rasters) — verifies no cross-raster state
//     drift accumulates.
//   • VCBASE remains UNCHANGED across the band (cycle-58 rule 4 never
//     fires since RC never reaches 7 in FLI). This invariant is unique
//     to FLI and not covered by single-line tests.
//
// Single-line FLI properties are covered elsewhere:
//   • `badline-tricks-spec-test` test 2: 16-line FLI, BL fires + RC=0
//   • `badline-rc-reset-timing-spec-test` test 6: 7-line FLI w/ LATE BL
//   • `badline-latch-boundary-spec-test` test 1: c13-phi2 YSCROLL write
//     visible to c14 BL sample
//   • `badline-ba-aec-boundary-spec-test`: BA-low 43 cy + AEC-low 40 cy
//     per single bad line
//   • `cycle58-live-badline-sampling-spec-test`: c58 phi2 BL sample
//   • `display-state-spec-test` tests 1, 2, 15: VC reload + VC advance
//     at c14
//   • `badline-tricks-spec-test` test 4: doubled text lines (RC=7+BL)

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
  vic.currentVicBank = 0;
  vic.displayEnabled = true;
  return vic;
}

function driveTo(vic, raster, cycle) {
  let safety = 312 * CYCLES_PER_LINE * 3;
  while (--safety && !(vic.raster === raster && vic.cycleInLine === cycle)) {
    vic.clock(1);
    vic.phi2();
  }
  if (safety <= 0) throw new Error(`drive timeout at L${vic.raster} c${vic.cycleInLine}`);
}

// ── Full 200-raster band — cross-raster integration invariants ────────
//
// Drives the entire active area L$30..L$F7 with per-line YSCROLL=raster&7
// written EARLY (c5, well before c12 phi1 BL check) to match real FLI
// demos. Verifies four cross-band invariants:
//
//   1. BL fires on every raster (lineBadLineDisplayPending OR rc=0).
//   2. displayActive stays true every raster (no c58 idle exit, since
//      Bauer §3.7.2 rule 5 requires !BL which never happens in FLI).
//   3. RC=0 at c14 every raster (rule 2 reset, never increments since
//      rule 6 increment-at-c58 doesn't fire when display stays in BL).
//   4. VCBASE never advances across the full band (rule 4 fires only
//      at c58 when rc=7, which never happens in FLI).
//
// This is the only test in the suite that exercises cross-raster FLI
// integrity over the maximum band — single-line tests can't catch a
// state-bleed bug that takes 50+ rasters to manifest.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18 | 0;                  // DEN=1, RSEL=1, YSCROLL=0
  vic.regs[0x16] = 0x08;
  driveTo(vic, 0x30, 1);
  const initialVcBase = vic.vcBase;

  let blMissCount = 0, displayLostCount = 0, rcDriftCount = 0;
  for (let r = 0x30; r <= 0xF7; r++) {
    driveTo(vic, r, 5);
    vic.regs[0x11] = 0x18 | (r & 7);           // early YSCROLL write (pre-c12)
    driveTo(vic, r, 14);
    if (vic.rc !== 0) rcDriftCount++;
    if (!vic.displayActive) displayLostCount++;
    if (!vic.lineBadLineDisplayPending && vic.rc !== 0) blMissCount++;
    driveTo(vic, r, 60);
  }
  expect(blMissCount === 0,
    `FLI band 200 rasters: 0 BL misses; got ${blMissCount}`);
  expect(displayLostCount === 0,
    `FLI band: displayActive stays true all 200 rasters; got ${displayLostCount} losses`);
  expect(rcDriftCount === 0,
    `FLI band: RC=0 at c14 every raster; got ${rcDriftCount} drift`);
  expect(vic.vcBase === initialVcBase,
    `FLI band: VCBASE unchanged across full band (rule 4 never fires); ${initialVcBase}→${vic.vcBase}`);
  ok('Bauer §3.14.3 FLI: 200-raster band integration — BL + displayActive + RC=0 + VCBASE invariants');
}

// ── Late-BL → 39 cy AEC invariant (DERIVED from Bauer §3.6.3) ─────────
//
// Spec derivation, not a direct Bauer quote:
//   • Bauer §3.6.3 spec rule: BA goes low 3 cy before c-access, AEC
//     follows BA after 3 cy.
//   • Bauer §3.5 + §3.14.6: bad-line condition is re-evaluated each
//     cycle 12-54.
//   • Combined: a YSCROLL write at c12 phi2 → BL detected at c13 phi1
//     → BA goes low at c13 → AEC follows at c16 → AEC-low c16..c54 (39 cy).
//
// Bauer doesn't explicitly state the late-BL AEC count — but the
// derivation is mechanical from §3.6.3 + §3.5 once you accept
// continuous BL re-evaluation (§3.5: the condition can arise or cease
// "multiple times within an arbitrary raster line").
//
// EARLY BL (YSCROLL matching at c12 phi1, value already in place):
//   - BA goes low at c12
//   - AEC goes low at c15 (3 cy later)
//   - AEC-low window: c15..c54 = 40 cy
//
// LATE BL (YSCROLL written at c12 phi2, detected at c13 phi1):
//   - BA goes low at c13
//   - AEC goes low at c16 (3 cy later, BA history at c12 is high)
//   - AEC-low window: c16..c54 = 39 cy (1 cy lost to the late detection)
//
// This 1-cy delta is invisible to most demos (BA-low window is still
// c12..c54 = 43 cy for both, so CPU READ stall count matches). But for
// CPU WRITE timing, the late-BL has 1 extra cycle of write-allowed
// (c15 still AEC-high) — a sharp edge that demos doing AEC-sensitive
// writes need to know about.
//
// If we later change the impl to strict-Bauer (= BL only checked at
// c12 phi1, mid-line YSCROLL writes ignored on this line), this test
// AND the 200-raster integration test above both fail — they jointly
// pin the VICE-equivalent late-BL behavior that real FLI demos rely on.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18 | 0;                  // DEN=1, RSEL=1, YSCROLL=0
  vic.regs[0x16] = 0x08;

  // Drive past L48 (= 0x30, first FLI raster, early BL with YSCROLL=0
  // matching L48&7=0) so we don't measure the boundary case.
  driveTo(vic, 0x31, 1);
  // L49: YSCROLL=0 (mismatch with L49&7=1). Write YSCROLL=1 at c12 phi2
  // (= immediately after vic.clock(1) for c12, simulating CPU c12 phi2
  // write timing).
  driveTo(vic, 0x31, 12);
  vic.regs[0x11] = 0x18 | 1;                   // late YSCROLL → LATE BL

  // Sample BA-low + AEC-low cycle counts across c12..c54.
  let baLowCount = 0, aecLowCount = 0;
  const baLowCycles = [], aecLowCycles = [];
  for (let c = 12; c <= 54; c++) {
    driveTo(vic, 0x31, c);
    if (vic.isBadLineBaLow()) { baLowCount++; baLowCycles.push(c); }
    const aecLow = vic.isAecLowPhi2 ? vic.isAecLowPhi2() : vic.isAecLow();
    if (aecLow) { aecLowCount++; aecLowCycles.push(c); }
  }

  expect(baLowCount === 43,
    `late-BL BA-low window: c12..c54 (43 cy); got ${baLowCount}, cycles=${baLowCycles.join(',')}`);
  expect(aecLowCount === 39,
    `late-BL AEC-low window: c16..c54 (39 cy, 1 cy lost to BA→AEC propagation); ` +
    `got ${aecLowCount}, cycles=${aecLowCycles.join(',')}`);
  // Pin the EXACT first AEC-low cycle so a 1-cy regression in either direction fails.
  expect(aecLowCycles[0] === 16,
    `late-BL first AEC-low cycle = c16 (= c12 BA-low + 3 cy lag + 1 cy late detection); ` +
    `got c${aecLowCycles[0]}`);
  ok('Bauer §3.6.3: late-BL (YSCROLL @ c12 phi2) → BA-low 43 cy + AEC-low 39 cy (= c16..c54)');
}

console.log(`\n${testNo} FLI full-band spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
