// Vertical-border SET/RESET decision (Bauer §3.9 rules 2 & 3), modeled as the
// chip's two-stage per-cycle flip-flop (`_advanceVerticalBorderFlipFlop`): the
// compare is re-evaluated every cycle against live $D011, so a CPU write at
// cycle 62 phi2 — which has landed in regs[] before the next cycle's VIC phi1 —
// affects the same line's decision. (The top RESET actually fires at the start
// of the matching line; these isolation tests start mid-line, so they exercise
// the per-cycle eval at the cycle they drive.)

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.currentVicBank = 0x0000;
  vic.irqHandler = () => {};
  return vic;
}

// Drive the live two-stage vertical-border FF for one line at `raster` (and
// optional $D011), letting the cycle-1 latch copy apply the compare result.
function vBorderCompareLine(vic, raster, d011) {
  if (d011 !== undefined) vic.regs[0x11] = d011;
  vic.raster = raster;
  vic.cycleInLine = 1;
  vic._vBorderLatch = vic.vBorderActive;
  vic._advanceVerticalBorderFlipFlop();
}

let testNo = 0, failing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else { failing++; console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`);
    currentFailures = [];
  }
}

// ── 1: function takes a $D011 byte directly ──────────────────────────
{
  const vic = makeVic();
  vic.vBorderActive = true;
  // Top compare at raster 51 with DEN=1, RSEL=1 → reset vBorder.
  vBorderCompareLine(vic, 51, 0x18);
  expect(vic.vBorderActive === false, `DEN=1 RSEL=1 raster 51: vBorder cleared`);
  // Same with DEN=0 → no reset.
  vic.vBorderActive = true;
  vBorderCompareLine(vic, 51, 0x08);
  expect(vic.vBorderActive === true, `DEN=0 RSEL=1 raster 51: vBorder NOT cleared`);
  ok('top compare clears vBorder iff DEN=1 (live two-stage FF)');
}

// ── 2: cycle-62 phi2 write is visible to cycle-63 decision ─────────────
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18;
  vic.raster = 51;
  // Start at the post-cycle-62 boundary to isolate rule 3's cycle-63
  // comparator from the separate left-edge rule 5 comparator.
  vic.cycleInLine = 62;
  vic.vBorderActive = true;
  expect(vic.cycleInLine === 62, `at post-cycle-62 boundary (got ${vic.cycleInLine})`);
  vic.write(0x11, 0x08);     // DEN=0, RSEL=1
  expect(vic.regs[0x11] === 0x08, `regs[$D011] reflects the late write`);
  vic.clock(1);
  expect(vic.vBorderActive === true,
    `DEN=0 from cycle-62 phi2 suppresses same-line cycle-63 top reset`);
  ok('cycle-62 phi2 $D011 write is visible to cycle-63 vBorder reset');
}

// ── 3: late RSEL change can move the cycle-63 comparator ───────────────
{
  const vic = makeVic();
  // Start on raster 55, which is the top compare only when RSEL=0.
  // Change RSEL at cycle 62 phi2; cycle 63 phi1 must use the live value.
  vic.regs[0x11] = 0x18;     // DEN=1, RSEL=1: top compare would be 51
  vic.raster = 55;
  vic.cycleInLine = 0;
  vic.vBorderActive = true;
  for (let c = 0; c < 62; c++) vic.clock(1);
  expect(vic.cycleInLine === 62, `at cycle 62 (got ${vic.cycleInLine})`);
  vic.write(0x11, 0x10);     // DEN=1, RSEL=0: top compare becomes 55
  vic.clock(1);
  expect(vic.vBorderActive === false,
    `RSEL=0 from cycle-62 phi2 moves cycle-63 top reset to raster 55`);
  ok('cycle-63 vBorder comparator uses live RSEL');
}

console.log(`\n${testNo - failing}/${testNo} passed${failing ? `, ${failing} FAILED` : ''}`);
if (failing) process.exit(1);
