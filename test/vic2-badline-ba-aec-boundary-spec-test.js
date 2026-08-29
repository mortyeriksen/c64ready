// Bauer §3.6.3 BA/AEC stall window boundary spec test.
//
// Pins the EXACT cycle boundaries where BA and AEC change state on a
// bad line. Per Bauer §3.6.3:
//
//   "BA goes low 3 cycles before the VIC takes the bus to fetch
//    matrix data. AEC follows the BA signal with a delay of 3 cycles."
//
// For a bad line (40 c-accesses cy 15..54), this gives:
//   c1..c11   BA=high  AEC=high  CPU runs freely
//   c12..c14  BA=LOW   AEC=high  CPU READ stalls, CPU WRITE proceeds
//   c15..c54  BA=low   AEC=LOW   CPU fully halted (40 cy)
//   c55..c63  BA=HIGH  AEC=HIGH  CPU resumes
//
// Window summary:
//   - BA-low window:  c12..c54 (43 cycles)
//   - AEC-low window: c15..c54 (40 cycles)
//   - BA-low lead-in: c12..c14 (3 cycles, write-proceed)
//   - Release edge:   c55 (BOTH rise to high)
//
// Why this test exists separately from badline-ba-cycles-test.js:
// that test scans line 51 cycle-by-cycle and counts mismatches. This
// test pins the EXACT transition boundaries (c11→c12, c14→c15, c54→c55)
// with explicit assertions per cycle, so a 1-cycle drift in either
// direction fails with a clear pointer to which boundary moved.

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
  // DEN=1, RSEL=1, YSCROLL=3 → bad lines at raster (raster & 7) === 3
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x15] = 0x00; // sprites OFF (isolate bad-line BA from sprite BA)
  vic.displayEnabled = true;
  return vic;
}

function driveTo(vic, raster, cy) {
  let safety = 312 * CYCLES_PER_LINE * 3;
  while (--safety && !(vic.raster === raster && vic.cycleInLine === cy)) vic.clock(1);
  if (safety <= 0) throw new Error(`drive timeout at L${vic.raster}.c${vic.cycleInLine}`);
}

// ── Test 1: BA fall edge — c11 BA-high → c12 BA-low ─────────────────
//
// Bauer §3.6.3: BA falls 3 cy before c-access. With c-access at c15,
// BA must be HIGH at c11 and LOW at c12.
{
  const vic = makeVic();
  driveTo(vic, 51, 11);
  expect(vic.isBadLineBaLow() === false,
    `c11: BA-high (1 cycle before BA falls); got isBadLineBaLow=${vic.isBadLineBaLow()}`);
  vic.clock(1);
  expect(vic.cycleInLine === 12, `advanced to c12; got c${vic.cycleInLine}`);
  expect(vic.isBadLineBaLow() === true,
    `c12: BA-LOW (3-cy lead before c-access at c15); got isBadLineBaLow=${vic.isBadLineBaLow()}`);
  ok('Bauer §3.6.3: BA falls at c12 (3-cy lead before c-access at c15)');
}

// ── Test 2: AEC fall edge — c14 AEC-high → c15 AEC-low ──────────────
//
// Bauer §3.6.3: AEC follows BA with 3-cy delay. With BA-low from c12,
// AEC must be HIGH at c14 and LOW at c15.
{
  const vic = makeVic();
  driveTo(vic, 51, 14);
  const aecAtC14 = vic.isAecLowPhi2 ? vic.isAecLowPhi2() : vic.isAecLow();
  expect(aecAtC14 === false,
    `c14: AEC-high (3-cy delay from BA still in lead-in); got AEC-low=${aecAtC14}`);
  vic.clock(1);
  expect(vic.cycleInLine === 15, `advanced to c15; got c${vic.cycleInLine}`);
  const aecAtC15 = vic.isAecLowPhi2 ? vic.isAecLowPhi2() : vic.isAecLow();
  expect(aecAtC15 === true,
    `c15: AEC-LOW (VIC seizes bus for c-access); got AEC-low=${aecAtC15}`);
  ok('Bauer §3.6.3: AEC falls at c15 (3-cy delay after BA, matches c-access start)');
}

// ── Test 3: Release edge — c54 BA/AEC low → c55 BA/AEC high ─────────
//
// Bauer §3.6.3: 40 c-accesses run c15..c54. At c55 (first cycle after
// last c-access), both BA and AEC release to high.
{
  const vic = makeVic();
  driveTo(vic, 51, 54);
  expect(vic.isBadLineBaLow() === true,
    `c54: BA-low (last c-access cycle); got isBadLineBaLow=${vic.isBadLineBaLow()}`);
  const aecAtC54 = vic.isAecLowPhi2 ? vic.isAecLowPhi2() : vic.isAecLow();
  expect(aecAtC54 === true,
    `c54: AEC-low (last c-access cycle); got AEC-low=${aecAtC54}`);
  vic.clock(1);
  expect(vic.cycleInLine === 55, `advanced to c55; got c${vic.cycleInLine}`);
  expect(vic.isBadLineBaLow() === false,
    `c55: BA-HIGH (40 c-accesses done); got isBadLineBaLow=${vic.isBadLineBaLow()}`);
  const aecAtC55 = vic.isAecLowPhi2 ? vic.isAecLowPhi2() : vic.isAecLow();
  expect(aecAtC55 === false,
    `c55: AEC-HIGH (VIC releases bus); got AEC-low=${aecAtC55}`);
  ok('Bauer §3.6.3: BA + AEC release together at c55 (after 40 c-accesses c15..c54)');
}

// ── Test 4: BA-low window total = 43 cy, AEC-low window total = 40 cy ─
//
// Tally cycle counts across the full bad-line BA window. Per Bauer
// §3.6.3, BA-low spans c12..c54 (43 cy), AEC-low spans c15..c54 (40 cy).
{
  const vic = makeVic();
  driveTo(vic, 51, 1);
  let baLowCount = 0, aecLowCount = 0;
  // Step from cy 1 phi1 to cy 63 phi1 (one full line). Sample at phi1
  // (after vic.clock advances cycle counter).
  for (let i = 0; i < CYCLES_PER_LINE; i++) {
    const cy = vic.cycleInLine;
    if (cy >= 1 && cy <= 63) {
      if (vic.isBadLineBaLow()) baLowCount++;
      const aecLow = vic.isAecLowPhi2 ? vic.isAecLowPhi2() : vic.isAecLow();
      if (aecLow) aecLowCount++;
    }
    vic.clock(1);
  }
  expect(baLowCount === 43,
    `BA-low cycles on bad line = 43 (c12..c54 inclusive); got ${baLowCount}`);
  expect(aecLowCount === 40,
    `AEC-low cycles on bad line = 40 (c15..c54 inclusive); got ${aecLowCount}`);
  ok('Bauer §3.6.3: BA-low window = 43 cy, AEC-low window = 40 cy (40 c-accesses + 3 lead-in)');
}

// ── Test 5: 3-cy lead-in window c12..c14 — BA-low + AEC-high ────────
//
// The 3-cycle BA-low / AEC-high lead-in is critical for CPU WRITE
// timing: writes can proceed during c12..c14 (AEC-high), reads cannot
// (BA-low). This pins all three cycles explicitly so a 1-cy shift in
// either direction fails.
{
  const vic = makeVic();
  for (const cy of [12, 13, 14]) {
    driveTo(vic, 51, cy);
    expect(vic.isBadLineBaLow() === true,
      `c${cy} lead-in: BA-low; got isBadLineBaLow=${vic.isBadLineBaLow()}`);
    const aecLow = vic.isAecLowPhi2 ? vic.isAecLowPhi2() : vic.isAecLow();
    expect(aecLow === false,
      `c${cy} lead-in: AEC-high (writes can proceed); got AEC-low=${aecLow}`);
  }
  ok('Bauer §3.6.3: lead-in c12..c14 — BA-low + AEC-high (3-cy write-proceed window)');
}

// ── Test 6: CPU READ stalls c12..c54 (43 cy), WRITE stalls c15..c54 (40 cy) ─
//
// The CPU's bus-arbitration uses BA for reads (stalls on BA-low) and
// AEC for writes (stalls on AEC-low). Bauer §3.6.1 calls this
// asymmetric — and §3.6.3 anchors the cycle boundaries.
//
// We can't easily measure CPU stall directly without driving a CPU
// instruction; instead verify the BA/AEC flags align with the spec.
// Cross-coverage with ba-aec-matrix-spec-test (CPU read/write stall
// behavior tests) confirms the flags drive CPU stalls correctly.
{
  const vic = makeVic();
  driveTo(vic, 51, 1);
  let readStallCount = 0, writeStallCount = 0;
  for (let i = 0; i < CYCLES_PER_LINE; i++) {
    if (vic.isBadLineBaLow()) readStallCount++;
    const aecLow = vic.isAecLowPhi2 ? vic.isAecLowPhi2() : vic.isAecLow();
    if (aecLow) writeStallCount++;
    vic.clock(1);
  }
  expect(readStallCount === 43,
    `READ stall cycles = 43 (BA-low c12..c54); got ${readStallCount}`);
  expect(writeStallCount === 40,
    `WRITE stall cycles = 40 (AEC-low c15..c54); got ${writeStallCount}`);
  ok('Bauer §3.6.1+§3.6.3: CPU READ stalls 43 cy (BA-low c12..c54), WRITE stalls 40 cy (AEC-low c15..c54)');
}

console.log(`\n${testNo} bad-line BA/AEC boundary spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
