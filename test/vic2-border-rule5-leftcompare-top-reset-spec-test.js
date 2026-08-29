// Vertical-border RESET at the LEFT compare (Bauer §3.9 rule 5): "When the X
// coordinate reaches the left comparison value and the Y coordinate reaches the
// TOP comparison value and the DEN bit is set, the vertical border flip-flop is
// reset." This is the mirror of rule 4 (left-compare + BOTTOM compare → vert FF
// SET, see vic2-vborder-rule4-leftcompare-spec-test.js).
//
// In this model the top-compare RESET (_advanceVerticalBorderFlipFlop) is
// evaluated every cycle of the top line, so it already covers the cycle at
// which X reaches the left compare — rule 5 is subsumed by the continuous
// rule-3 top reset. This test pins the rule-5 condition explicitly at the
// left-compare cycle and the §3.10 DEN gate, neither of which had an isolated
// assertion.
//
// X→cycle mapping (Bauer §3.6.1, _getCycleStartX = (cycle-12)*8): the left
// comparison value is 24 (CSEL=1) / 31 (CSEL=0); both fall in cycle 15's pixel
// span (X 24..31), so "X reaches the left compare" == cycle 15. Top compare:
// RSEL=1 → raster 51, RSEL=0 → raster 55 (Bauer §3.9 / §3.4).

import { VIC2 } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.currentVicBank = 0x0000;
  vic.irqHandler = () => {};
  // Pin the pure FF logic — skip the cycle-incremental re-render path.
  vic._cycleRenderActiveCanvasY = -1;
  return vic;
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

// Drive the vertical-border FF at the LEFT-compare cycle (cy15) on the given
// line / $D011, with the FF starting CLOSED (border showing). The latch mirrors
// the live FF so the cy1-copy (not exercised here, cy!=1) would be a no-op.
function atLeftCompare(vic, raster, d011, { closed = true } = {}) {
  vic.regs[0x11] = d011;
  vic.raster = raster;
  vic.cycleInLine = 15;
  vic.vBorderActive = closed;
  vic._vBorderLatch = closed;
}

// ── 1: RSEL=1, top compare 51, DEN=1 → left compare RESETS vert FF ────────
{
  const vic = makeVic();
  atLeftCompare(vic, 51, 0x18);          // DEN=1, RSEL=1 ⇒ topCompare = 51
  vic._advanceVerticalBorderFlipFlop();
  expect(vic.vBorderActive === false,
    'vert FF reset at top compare (RSEL=1, raster 51, DEN=1)');
  expect(vic._vBorderLatch === false,
    'latch also cleared so the next line stays open');
  ok('rule 5: left compare at the top line (RSEL=1) opens the vertical border');
}

// ── 2: RSEL=0 moves the top compare to 55; reset keys off the live RSEL ───
{
  const vic = makeVic();
  atLeftCompare(vic, 55, 0x10);          // DEN=1, RSEL=0 ⇒ topCompare = 55
  vic._advanceVerticalBorderFlipFlop();
  expect(vic.vBorderActive === false,
    'vert FF reset at top compare (RSEL=0, raster 55, DEN=1)');
  // And raster 51 is NOT the top compare when RSEL=0 → no reset there.
  const vic2 = makeVic();
  atLeftCompare(vic2, 51, 0x10);         // RSEL=0 ⇒ topCompare 55 ≠ 51
  vic2._advanceVerticalBorderFlipFlop();
  expect(vic2.vBorderActive === true,
    'RSEL=0: raster 51 is not the top compare, vert FF stays set');
  ok('rule 5 keys off the live RSEL top compare (51 vs 55)');
}

// ── 3: DEN=0 at the top line → NO reset (Bauer §3.10 gate) ────────────────
{
  const vic = makeVic();
  atLeftCompare(vic, 51, 0x08);          // DEN=0, RSEL=1
  vic._advanceVerticalBorderFlipFlop();
  expect(vic.vBorderActive === true,
    'DEN=0: top-compare left reset is disabled, vert FF stays set');
  expect(vic._vBorderLatch === true, 'latch untouched when DEN=0');
  ok('rule 5 is gated on DEN=1 (§3.10): DEN=0 keeps the upper/lower border');
}

// ── 4: off the top line, left compare does NOT touch the vertical FF ──────
// (Reaching the left compare on a non-top line only affects the MAIN/horizontal
// border FF — rule 6 — which is out of scope here; the vertical FF must be
// unchanged.)
{
  const vic = makeVic();
  atLeftCompare(vic, 120, 0x18);         // mid-display line, DEN=1, RSEL=1
  vic._advanceVerticalBorderFlipFlop();
  expect(vic.vBorderActive === true,
    'left compare on a non-top line leaves the vertical FF set');
  ok('rule 5 fires only on the top-compare line, not every left compare');
}

// ── 5: idempotent — an already-open vert FF at the top line stays open ────
{
  const vic = makeVic();
  atLeftCompare(vic, 51, 0x18, { closed: false });  // FF already open
  vic._advanceVerticalBorderFlipFlop();
  expect(vic.vBorderActive === false,
    'already-open vert FF remains open at the top compare (no spurious set)');
  ok('rule 5 reset is idempotent on an already-open vertical border');
}

console.log(`\n${testNo - failing}/${testNo} passed${failing ? `, ${failing} FAILED` : ''}`);
if (failing) process.exit(1);
console.log('All Bauer §3.9 rule-5 (left-compare top reset) tests passed.');
