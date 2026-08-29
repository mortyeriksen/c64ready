// DEN bad-line-enable latch — raster line $30 phi2 boundary sample.
//
// Bauer §3.7.1: a Bad Line Condition for the whole frame is gated on the
// DEN bit ($D011 bit 4) being set during "an arbitrary cycle of raster
// line $30". Our model increments the raster counter at c63 phi1 (inside
// clock()), so a CPU $D011 write at the *phi2* of line $30's final cycle
// lands when this.raster already reads $31. The phi1 latch (vic2.js, only
// active while this.raster===$30) misses it; without a phi2 boundary
// sample, bad lines stay disabled for the entire frame → idle data
// instead of text.
//
// This is exactly the dentest/den01-49 family. With $D011=$1b (YSCROLL=3)
// the first bad line is raster $33, so latching at the $30→$31 boundary
// is still in time for the whole screen:
//   -0  DEN set within line $30 (e.g. c62)  → phi1 of c63 latches → TEXT
//   -1  DEN set at line $30's last phi2      → phi2 boundary latches → TEXT
//   -2  DEN set at line $31 c1 phi2          → never latches        → IDLE
//
// VICE renders -0 and -1 as text, -2 as idle. This test pins the three
// boundary positions directly.

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';

let testNo = 0, failing = 0, currentFails = [];
function expect(cond, msg) { if (!cond) currentFails.push(msg); }
function ok(label) {
  testNo++;
  if (currentFails.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else {
    failing++;
    console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFails) console.log(`     - ${m}`);
    currentFails = [];
  }
}

function makeVic() {
  const v = new VIC2();
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
    if (--safety <= 0) throw new Error(`drive timeout at r=${vic.raster} c=${vic.cycleInLine}`);
  }
}

// Enter line $30 with DEN=0 so the c1-of-$30 reset leaves displayEnabled
// false; the test then sets DEN at one of three boundary positions.
function setupAtLine30C62(vic) {
  vic.regs[0x11] = 0x08;          // RSEL=1, DEN=0, YSCROLL=0
  vic.displayEnabled = false;
  driveTo(vic, 0x30, 62);
  return vic;
}
const DEN_ON = 0x18;              // RSEL=1, DEN=1

// ── Variant -0: DEN set within line $30 (c62 phi2) → phi1 of c63 latches ─
{
  const vic = setupAtLine30C62(makeVic());
  expect(vic.displayEnabled === false, `precondition: DEN=0 through $30 → displayEnabled false (got ${vic.displayEnabled})`);
  vic.write(0x11, DEN_ON);        // c62 phi2 write
  vic.clock(1);                   // c63 phi1 samples raster=$30, DEN=1
  vic.phi2();
  expect(vic.raster === 0x31 && vic.cycleInLine === 0, `now at $31 c0 (got r=${vic.raster} c=${vic.cycleInLine})`);
  expect(vic.displayEnabled === true,
    `-0: DEN set at $30.c62 phi2 → c63 phi1 latch enables bad lines (got displayEnabled=${vic.displayEnabled})`);
  ok('-0: DEN set within line $30 → bad lines enabled (text)');
}

// ── Variant -1: DEN set at line $30's last phi2 → phi2 boundary latches ──
{
  const vic = setupAtLine30C62(makeVic());
  vic.clock(1);                   // advance to c63 → wraps to $31 c0, _lineJustEnded
  expect(vic.raster === 0x31 && vic.cycleInLine === 0, `wrapped to $31 c0 (got r=${vic.raster} c=${vic.cycleInLine})`);
  expect(vic.displayEnabled === false, `not yet latched (DEN still 0 through $30, got ${vic.displayEnabled})`);
  vic.write(0x11, DEN_ON);        // phi2 of the $30→$31 boundary cycle
  vic.phi2();                     // phi2 boundary sample must catch it
  expect(vic.displayEnabled === true,
    `-1: DEN set at line $30 boundary phi2 → still counts as line $30 (got displayEnabled=${vic.displayEnabled})`);
  ok('-1: DEN set at line $30 boundary phi2 → bad lines enabled (text)');
}

// ── Variant -2: DEN set at line $31 c1 phi2 → never latches (idle) ───────
{
  const vic = setupAtLine30C62(makeVic());
  vic.clock(1);                   // wrap to $31 c0, _lineJustEnded=true
  vic.phi2();                     // boundary: DEN still 0 → no latch; clears _lineJustEnded
  expect(vic.displayEnabled === false, `boundary saw DEN=0 → no latch (got ${vic.displayEnabled})`);
  vic.clock(1);                   // advance to $31 c1
  expect(vic.raster === 0x31 && vic.cycleInLine === 1, `at $31 c1 (got r=${vic.raster} c=${vic.cycleInLine})`);
  vic.write(0x11, DEN_ON);        // c1 phi2 write — one cycle too late
  vic.phi2();
  expect(vic.displayEnabled === false,
    `-2: DEN set at $31.c1 phi2 → NOT line $30 → bad lines stay disabled (got displayEnabled=${vic.displayEnabled})`);
  ok('-2: DEN set at line $31 c1 → bad lines stay disabled (idle)');
}

// ── Paired diff: -1 vs -2 differ only by one cycle of DEN-write timing ───
{
  const v1 = setupAtLine30C62(makeVic());
  const v2 = setupAtLine30C62(makeVic());
  // v1 = -1 (boundary phi2), v2 = -2 (next-cycle phi2)
  v1.clock(1);                    // $31 c0, _lineJustEnded
  v1.write(0x11, DEN_ON); v1.phi2();
  v2.clock(1); v2.phi2();         // boundary passes with DEN=0
  v2.clock(1);                    // $31 c1
  v2.write(0x11, DEN_ON); v2.phi2();
  expect(v1.displayEnabled === true && v2.displayEnabled === false,
    `one-cycle DEN-write shift flips the latch (v1=${v1.displayEnabled} v2=${v2.displayEnabled})`);
  ok('Paired: a single-cycle DEN-write shift across the $30 boundary flips text↔idle');
}

console.log(`\n${testNo - failing}/${testNo} passed${failing ? `, ${failing} FAILED` : ''}`);
if (failing) process.exit(1);
