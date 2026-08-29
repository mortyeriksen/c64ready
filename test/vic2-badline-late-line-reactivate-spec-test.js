// Late-line Bad-Line edge → display re-activation spec test.
//
// Bauer §3.5 (Bad Line Condition):
//   "You can produce or cancel a Bad Line Condition multiple times within
//    an arbitrary raster line in the range of $30-$f7 by modifying YSCROLL."
//
//   The text is unambiguous: BL can be produced at ANY cycle. It does NOT
//   say "only at cycle 12-54" or any other restricted window.
//
// Bauer §3.7.1 (Idle / display state transitions):
//   "The transition from idle to display state occurs as soon as there is
//    a Bad Line Condition."
//
//   "As soon as" again means "at whatever cycle the BL condition appears".
//   The idle → display transition is not gated on a particular cycle.
//
// What this file pins:
//
//   raster_time_gp's permanent-bad-line trick writes $D011 at cy 58..62 of
//   every visible line with YSCROLL = raster & 7. When the cy 58 idle check
//   (Bauer §3.7.2 rule 5: "if rc=7 and no BL → idle") fires BEFORE the
//   STA $D011 data write lands, display goes idle on that line. Bauer §3.5
//   + §3.7.1 require that the LATER STA $D011 write — which makes BL true
//   at cy 58+ — must re-activate display immediately for that same line.
//
//   Without this, the bars in the visible region collapse to background
//   on every line where the demo's STA aligns to cy 59-62 (= 86% of
//   iterations, since cy 58 phi2 = the only "early enough" alignment).
//
//   These tests intentionally do NOT load raster_time_gp.prg — synthesize
//   the state with vic.regs[] / displayActive / rc directly, drive
//   clock(1) over the cy 58-62 window, and assert the spec invariant.

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

// Park at the start of a raster line whose 3 LSBs differ from the YSCROLL
// already in $D011, so BL is false through cy 14 and through cy 58. Then
// flip YSCROLL via a write at the chosen late cycle so BL becomes true at
// or after cy 58 — the very situation raster_time_gp's permanent-BL trick
// produces.
function setupLineNoBLThenLateWrite(vic, raster, cyOfBLProduction, newYscroll) {
  // raster 100 = $64. 100 & 7 = 4. Initial YSCROLL = 7 → BL false.
  vic.regs[0x11] = 0x18 | 7;              // DEN=1, RSEL=1, YSCROLL=7
  vic.regs[0x16] = 0x08;
  vic.displayEnabled = true;
  driveTo(vic, raster, 1);
  // Drive to the cycle BEFORE the chosen production cycle. At cy58 phi2
  // the idle check will fire — we want to land AFTER it for cy>=59.
  driveTo(vic, raster, cyOfBLProduction - 1);
  // Force shared pre-write state.
  vic.rc = 7;
  vic.vc = 40;
  vic.vcBase = 0;
  vic.lineMatrixFetchCol = -1;
  vic.lineBadLineDisplayPending = false;
  vic.lineBadLineStartCycle = -1;
  vic.displayActive = true;
  // Step one master cycle so cycleInLine = cyOfBLProduction. For
  // cyOfBLProduction = 58, this runs the cy58 idle check that drops
  // displayActive false (no BL yet). For cy >= 59 the cy58 check has
  // already fired in the previous master cycle.
  vic.clock(1);
  vic.phi2();
  if (cyOfBLProduction === 58) {
    // The cy58 idle check just fired with no BL → display went idle.
    // This is the precondition for the "late-line BL re-activation"
    // scenario we're pinning.
  }
}

// ── 1: $D011 write at cy 59 with matching YSCROLL → display re-activates ──
//
// The cy 58 idle check already fired (display→idle) because BL was false.
// Then at cy 59 phi2 the CPU writes YSCROLL such that (raster & 7) ==
// YSCROLL. BL transitions false→true. Per §3.5 + §3.7.1 display must
// re-activate. The recovery may fire synchronously inside write() or at
// the next phi1 — these tests assert the observable property, not the
// mechanism. By the time the next clock(1) completes, displayActive
// must be true.
{
  const vic = makeVic();
  // Park at cy 58 with no BL → idle check runs at cy 58 phi2.
  setupLineNoBLThenLateWrite(vic, 100, 58, null);
  expect(vic.displayActive === false,
    `precondition: cy58 idle check with no BL drops display state (got displayActive=${vic.displayActive})`);
  // Now at cy 59 phi2, the demo's STA $D011 lands with YSCROLL=4.
  vic.clock(1);                            // advance to cy 59 phi1
  vic.write(0x11, 0x18 | 4);              // YSCROLL=4 matches raster 100 & 7
  vic.phi2();                              // cy 59 phi2 — write is now in regs[]
  vic.clock(1);                            // cy 60 phi1 — BL edge detection runs here
  expect(vic.displayActive === true,
    `Bauer §3.5+§3.7.1: BL becomes true at cy 59 → next phi1 (cy 60) re-activates display (got displayActive=${vic.displayActive})`);
  ok('cy 59 $D011 write producing BL re-activates display by next phi1 (Bauer §3.5 + §3.7.1)');
}

// ── 2: $D011 write at cy 60 producing BL → display re-activates ───────
{
  const vic = makeVic();
  setupLineNoBLThenLateWrite(vic, 100, 58, null);
  expect(vic.displayActive === false, `precondition: idle after cy58 no-BL`);
  driveTo(vic, 100, 60);
  vic.write(0x11, 0x18 | 4);
  vic.phi2();
  vic.clock(1);                            // cy 61 phi1 — BL edge detection runs here
  expect(vic.displayActive === true,
    `cy 60 $D011 BL edge → next phi1 (cy 61) re-activates display (got displayActive=${vic.displayActive})`);
  ok('cy 60 $D011 write producing BL re-activates display');
}

// ── 3: $D011 write at cy 61 (within line) producing BL → re-activate ──
//
// Upper-bound test for the widened in-line window. cy 61 phi2 write →
// cy 62 phi1 edge detection. Both cycles are within the same line, so
// the recovery is fully owned by the late-line BL edge detection.
{
  const vic = makeVic();
  setupLineNoBLThenLateWrite(vic, 100, 58, null);
  expect(vic.displayActive === false, `precondition: idle after cy58 no-BL`);
  driveTo(vic, 100, 61);
  vic.write(0x11, 0x18 | 4);
  vic.phi2();
  vic.clock(1);                            // cy 62 phi1 — BL edge detection runs here
  expect(vic.displayActive === true && vic.raster === 100,
    `cy 61 $D011 BL edge → cy 62 phi1 re-activates display within same line (got displayActive=${vic.displayActive}, raster=${vic.raster}, cy=${vic.cycleInLine})`);
  ok('cy 61 $D011 write producing BL re-activates display within same line');
}

// ── 4: late-line BL also has next-line effect via vc/vcBase rules ─────
//
// Bauer §3.7.2 rule 5 (in our cy58 idle path) commits vcBase ← vc when
// rc=7 regardless of BL. If display re-activates after cy58, vcBase has
// already been committed — the cy 14 phi1 of next line will load vc from
// it (rule 2). This test pins that the re-activation does NOT mutate
// vcBase beyond what rule 5 already did.
{
  const vic = makeVic();
  setupLineNoBLThenLateWrite(vic, 100, 58, null);
  const vcBaseAfterC58 = vic.vcBase;
  expect(vcBaseAfterC58 === 40,
    `rule 5 committed vcBase ← vc=40 at cy58 (got vcBase=${vcBaseAfterC58})`);
  driveTo(vic, 100, 60);
  vic.write(0x11, 0x18 | 4);
  vic.phi2();
  expect(vic.vcBase === 40,
    `late-line BL re-activation must NOT mutate vcBase beyond rule 5 (got vcBase=${vic.vcBase})`);
  ok('late-line BL re-activation preserves vcBase as set by cy58 rule 5');
}

// ── 5: regression — STA $D011 with non-matching YSCROLL must NOT recover ──
//
// If the demo writes YSCROLL that does NOT match raster & 7 at cy 59-62
// AND would not match the NEXT raster either, BL stays false and display
// must stay idle. Distinguishes "any write recovers" (bug) from
// "BL-producing write recovers" (spec).
{
  const vic = makeVic();
  setupLineNoBLThenLateWrite(vic, 100, 58, null);
  expect(vic.displayActive === false, `precondition: idle after cy58 no-BL`);
  driveTo(vic, 100, 60);
  // YSCROLL=6: 100 & 7 = 4 (no match), 101 & 7 = 5 (no match) → BL false on both.
  vic.write(0x11, 0x18 | 6);
  vic.phi2();
  vic.clock(1);                            // cy 61 phi1 evaluates BL
  expect(vic.displayActive === false,
    `non-matching YSCROLL at cy 60 must NOT recover (got displayActive=${vic.displayActive})`);
  ok('cy 60 $D011 write with non-matching YSCROLL does NOT recover display');
}

// ── 6: paired diff — same setup, only difference is BL-producing write ──
//
// Synthesize two VICs in identical post-cy58-idle state, give one a
// BL-producing $D011 write at cy 60, the other a non-matching $D011
// write at cy 60. Asserts that the spec invariant — only BL-producing
// writes recover — is the ONLY axis of behavioral divergence.
{
  const vicA = makeVic(), vicB = makeVic();
  setupLineNoBLThenLateWrite(vicA, 100, 58, null);
  setupLineNoBLThenLateWrite(vicB, 100, 58, null);
  expect(vicA.displayActive === false && vicB.displayActive === false,
    `pre: both idle after cy58 no-BL`);
  driveTo(vicA, 100, 60);
  driveTo(vicB, 100, 60);
  vicA.write(0x11, 0x18 | 4);             // BL-producing (matches 100&7=4)
  vicB.write(0x11, 0x18 | 6);             // non-matching (neither 4 nor 5)
  vicA.phi2();
  vicB.phi2();
  vicA.clock(1);
  vicB.clock(1);
  expect(vicA.displayActive === true && vicB.displayActive === false,
    `divergence axis = BL-producing-ness; got A=${vicA.displayActive} B=${vicB.displayActive}`);
  ok('paired: only the BL-producing $D011 write at cy 60 recovers display');
}

console.log(`\n${testNo - failing}/${testNo} passed${failing ? `, ${failing} FAILED` : ''}`);
if (failing) process.exit(1);
