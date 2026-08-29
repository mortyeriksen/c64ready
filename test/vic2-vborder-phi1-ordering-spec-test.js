// Spec test: vertical-border-FF SET/RESET timing.
//
// Bauer §3.9 rules 2 & 3, modeled as the chip's two-stage flip-flop (the
// vertical FF is re-evaluated every cycle — validated against dentest
// den10-51-N / denrsel-* and VICE):
//   • SET (bottom compare): arms a latch that copies into the live FF at the
//     NEXT line's cycle 1. With RSEL=1 the bottom compare is L251 (so the FF
//     reads SET by L252 entry); with RSEL=0 it's L247.
//   • RESET (top compare, gated by DEN): clears the live FF immediately at the
//     START of the matching line (cycle 1). With RSEL=1 that's L51; RSEL=0 L55.
//     DEN is sampled at line start, so the "open vertical border" trick must
//     clear DEN BEFORE the top-compare line — a mid-line DEN=0 is too late.

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';

let testNo = 0, failing = 0;
function expect(cond, msg) { if (!cond) console.log(`     - ${msg}`); return cond; }
function ok(label) {
  testNo++;
  console.log(`ok  - test ${testNo}: ${label}`);
}
function fail(label) {
  testNo++; failing++;
  console.log(`FAIL test ${testNo}: ${label}`);
}

function makeVic() {
  const v = new VIC2();
  v.ram = new Uint8Array(0x10000);
  v.colorRam = new Uint8Array(0x0400);
  v.charRom = new Uint8Array(0x1000);
  v.currentVicBank = 0x0000;
  v.regs[0x11] = 0x1B;     // RSEL=1, DEN=1
  v.regs[0x16] = 0x08;     // CSEL=1
  return v;
}

function driveTo(v, raster, cycle = 0) {
  while (v.raster < raster) v.clock(1);
  while (v.cycleInLine < cycle) v.clock(1);
}

// ── 1: SET fires at cycle 63 of bottomCompare line (RSEL=1 → L251) ─────
// Bauer §3.9 rule 2. Drive past L251 c63 (= L252 entry) to observe.
{
  const v = makeVic();
  v.vBorderActive = false;
  driveTo(v, 252);
  if (expect(v.raster === 252, `at L252 entry, raster=${v.raster}`) &&
      expect(v.vBorderActive === true,
        `V-FF SET must latch by L252 entry (after L251 c63 fired)`)) {
    ok('V-FF SET fires at cycle 63 of L251 (RSEL=1)');
  } else fail('V-FF SET fires at cycle 63 of L251 (RSEL=1)');
}

// ── 2: SET fires at cycle 63 of bottomCompare line (RSEL=0 → L247) ─────
{
  const v = makeVic();
  v.regs[0x11] = 0x13;       // RSEL=0, DEN=1 — bottomCompare=247
  v.vBorderActive = false;
  driveTo(v, 248);
  if (expect(v.raster === 248, `at L248 entry, raster=${v.raster}`) &&
      expect(v.vBorderActive === true,
        `V-FF SET must latch by L248 entry (after L247 c63 fired)`)) {
    ok('V-FF SET fires at cycle 63 of L247 (RSEL=0)');
  } else fail('V-FF SET fires at cycle 63 of L247 (RSEL=0)');
}

// ── 3: $D011 write does not synchronously unset V-FF after rule-2 SET ──
// Stable-raster cart scenario (OrbitUntold): once rule 2 has fired SET
// at cycle 63 of the bottomCompare line, a subsequent CPU write to
// $D011 must NOT synchronously veto the latched FF — Bauer §3.9 has
// no post-detect veto for vBorder rules. Drive past L251 c63 to
// establish vBorder=SET, then write $D011=$00 mid-line of L252 and
// verify the FF stays SET.
{
  const v = makeVic();
  v.vBorderActive = false;
  driveTo(v, 252);
  expect(v.vBorderActive === true, `pre-write: V-FF latched after L251 c63`);
  // Cart writes $D011=$00 (DEN=0, RSEL=0) somewhere in L252.
  v.write(0x11, 0x00);
  if (expect(v.vBorderActive === true,
        `V-FF stays SET after $D011=$00 write — no post-detect veto`)) {
    ok('$D011 write does not synchronously unset V-FF after rule-2 SET (OrbitUntold pattern)');
  } else fail('$D011 write does not synchronously unset V-FF after rule-2 SET (OrbitUntold pattern)');
}

// ── 4: top-compare RESET fires at LINE START; mid-line DEN=0 is too late ──
// Two-stage model (validated vs dentest den10-51-N / VICE): the vertical FF is
// re-evaluated every cycle, so the top-compare reset fires at the start of L51
// (cycle 1) when DEN=1. A DEN=0 written mid-L51 cannot un-clear it — the "open
// vertical border" trick must clear DEN BEFORE L51 (on a prior line).
{
  const v = makeVic();
  v.vBorderActive = true;        // simulate post-L251 state (border closed)
  driveTo(v, 51, 0);
  expect(v.raster === 51, `at L51 entry`);
  expect(v.vBorderActive === true,
    `at L51 cycle 0 (pre line-start check): V-FF still set`);
  v.clock(1);                    // cycle 1: line-start top reset fires (DEN=1)
  expect(v.vBorderActive === false,
    `at L51 cycle 1: top-compare RESET fires at line start with DEN=1`);
  // A DEN=0 written mid-line cannot un-clear the FF (no post-clear SET).
  v.write(0x11, 0x0B);           // RSEL=1, DEN=0
  for (let i = 1; i < CYCLES_PER_LINE; i++) v.clock(1);
  if (expect(v.vBorderActive === false,
        `mid-L51 DEN=0 does not un-clear the FF (line-start reset already fired)`)) {
    ok('top-compare RESET fires at line start; mid-line DEN=0 too late');
  } else fail('top-compare RESET fires at line start; mid-line DEN=0 too late');
}

// ── 5: RESET fires normally over L51 with DEN=1 ───────────────────────
{
  const v = makeVic();
  v.vBorderActive = true;
  driveTo(v, 51);
  expect(v.vBorderActive === true, `L51 entry: still set`);
  for (let i = 0; i < CYCLES_PER_LINE; i++) v.clock(1);
  if (expect(v.vBorderActive === false,
        `L51 with DEN=1: top-compare RESET fires (cleared by end of line)`)) {
    ok('RESET fires on L51 with DEN=1');
  } else fail('RESET fires on L51 with DEN=1');
}

console.log(`\n${testNo} tests; ${failing} failing`);
if (failing) process.exit(1);
