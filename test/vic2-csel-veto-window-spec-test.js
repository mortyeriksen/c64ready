// CSEL veto-window spec audit — proves the §3.14.1 hyperscreen + left-
// prevent rules are implemented correctly at the cycle level.
//
// Multiple external reviewers (May 2026) have proposed adjusting the
// latch-delay or regs-sampling logic in `_evalLatchedTransition` to
// chase a 2-cycle border deficit observed in sb_sprite_fetch and
// vborder. Independent characterization showed that the deficit
// originates UPSTREAM in CIA timer / set_timer cycle accounting — the
// veto-evaluation layer itself is correct: when a CPU $D016 write lands
// at the asm-intended cycle, the veto fires; when it lands elsewhere,
// it doesn't.
//
// This file pins those invariants directly so any future change to the
// veto / latch path that violates Bauer §3.14.1 will fail these tests
// rather than silently masking the real bug.
//
// Spec invariants (Bauer §3.14.1, "the change has to be exactly in
// cycle 56" / "exactly cycle 17"):
//
//   hRightSet (hyperscreen):
//     - SET fires at phi1 of cycle 55 (X=344 in CSEL=1 mode hits
//       cycle 55's X-segment 344..351).
//     - Latch evaluates 2 master cycles later (phi1 of cycle 57).
//     - CPU writes during phi2 of cycles 55 or 56 propagate to phi1 of
//       56 / 57 respectively. Per Bauer "exactly cycle 56", only a
//       cycle-56 phi2 transition vetoes — the cycle-55 phi2 window is
//       too early (write hasn't propagated past detect-phi1) and
//       cycle-57 phi2 is too late (latch already fired).
//     - Direction: CSEL must be 1 at detect (= SET fires) and 0 at
//       latch (= CPU wrote 1→0). Reverse direction is not a defined
//       trick.
//
//   hLeftReset (left-prevent / un-RESET):
//     - RESET-detect fires at phi1 of cycle 15 (X=24 in CSEL=1 mode
//       hits cycle 15's X-segment 24..31).
//     - Latch evaluates 3 master cycles later (phi1 of cycle 18) — one
//       more than hRightSet because the left X-compare value (24) is
//       at the END of its segment (24..31) while the right (344) is at
//       the START of its segment (344..351). This 1-cycle asymmetry is
//       intrinsic to real-hardware register pipelining.
//     - CPU writes during phi2 of cycle 17 propagate to phi1 of 18.
//     - Direction: CSEL=0 at detect, CSEL=1 at latch.
//
// The tests below drive vic.clock() synthetically to land vic.write()
// calls at exact phi2-of-cycle-K targets (each vic.clock() is one
// master cycle, so the cycle of any write is precisely cycleInLine
// after that many drives). This is the same pattern as
// side-border-open-spec-test.js and csel-boundary-cycles-spec-test.js — proven
// to model real CPU phi2 writes correctly when the CPU's bus access
// reaches vic.write() at the matching master cycle.

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  vic.regs[0x11] = 0x1B;        // DEN=1, RSEL=1, YS=3
  vic.regs[0x16] = 0x08;        // CSEL=1
  return vic;
}

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

// Drive vic to a specific (raster, cycle) point. After this, the next
// vic.write() acts as a CPU phi2 write at that master cycle.
function driveTo(vic, raster, cycle = 0) {
  while (vic.raster < raster || (vic.raster === raster && vic.cycleInLine < cycle)) {
    vic.clock(1);
  }
}

// Run a CSEL=1→0 hyperscreen attempt at the given cycle of a display
// line, then walk to end-of-line + 1 cycle to let the latch fire and
// any pending border eval commit. Returns the final hBorderActive.
function runRightVetoAttempt(writeCycle) {
  const vic = makeVic();
  driveTo(vic, 100, writeCycle);
  vic.write(0x16, 0x00);                      // CSEL=1→0
  // Drive past the latch (cycle 57) and to the next line so all pending
  // FF transitions commit.
  while (vic.raster === 100) vic.clock(1);
  vic.clock(1);
  return vic.hBorderActive;
}

function runLeftVetoAttempt(writeCycle) {
  // Set up a line that ENTERS with hBorder=1 (= line-start) and
  // vBorder=0 (= display zone). The natural left-RESET detect at
  // phi1 of cycle 15 (with CSEL=0, left=31 in cycle 15's segment) then
  // fires; a CSEL=0→1 write at cycle 17 phi2 vetoes it.
  //
  // We must sample hBorder MID-LINE — between the latch eval (cycle 18)
  // and the right-edge SET (~cycle 53-55) — because the right-SET
  // re-closes hBorder at end-of-line regardless of what happened at
  // the left compare. We sample at cycle 30 (well clear of both edges).
  const vic = makeVic();
  vic.regs[0x16] = 0x00;                       // CSEL=0 (left=31, right=335)
  driveTo(vic, 100, 0);
  driveTo(vic, 100, writeCycle);
  vic.write(0x16, 0x08);                       // CSEL=0→1 at writeCycle phi2
  driveTo(vic, 100, 30);                       // walk to mid-line sample point
  return vic.hBorderActive;
}

// ── 1: hRightSet veto fires at exactly cycle 56 (canonical) ─────────────
{
  const result = runRightVetoAttempt(56);
  expect(result === false,
    `cycle-56 CSEL=1→0 must veto right SET (border opens), got hBorder=${result}`);
  ok('hRightSet veto: cycle 56 (canonical)');
}

// ── 2: hRightSet veto does NOT fire at cycle 53 (catch-all boundary) ────
{
  const result = runRightVetoAttempt(53);
  expect(result === true,
    `cycle-53 CSEL=1→0 must NOT veto (write before catch-all range), got hBorder=${result}`);
  ok('hRightSet veto: cycle 53 (too early — outside catch-all)');
}

// ── 3: hRightSet veto does NOT fire at cycle 54 (Bauer too-early) ───────
// Per midline-register-spec test 3 + cycle-edge test 18 + border-timing-
// precision test 6 + csel-veto-sprite-rollback test 14: cycle-54 writes
// land in the "gap between CSEL=0 right (X=335) and CSEL=1 right (X=344)"
// and per Bauer must not be the canonical hyperscreen trick. Re-pinned
// here for completeness within this file.
{
  const result = runRightVetoAttempt(54);
  expect(result === true,
    `cycle-54 CSEL=1→0 must NOT veto right SET (border closes), got hBorder=${result}`);
  ok('hRightSet veto: cycle 54 (too early per Bauer §3.14.1)');
}

// ── 4: hRightSet veto does NOT fire at cycle 55 (too early per Bauer) ──
// Bauer §3.14.1 (verbatim): "the change from CSEL=1 to CSEL=0 has to be
// exactly in cycle 56." A CPU write at cycle 55 phi2 is one cycle early
// and must NOT veto. Mechanically the write does propagate to phi1 of
// cycle 56 (before the FF latches at phi1 of 57), but real silicon
// rejects it — Bauer's "exactly" rule is the spec.
//
// If demos (e.g. FppScroller's `sty $d016`) land at cycle 55 in our
// model when they should land at cycle 56, that 1-cycle deficit must
// be fixed upstream (CPU/CIA/IRQ-entry calibration), NOT papered over
// by widening this window. Widening conflates "what the latch math
// permits" with "what real silicon accepts" — the former is broader.
{
  const result = runRightVetoAttempt(55);
  expect(result === true,
    `cycle-55 CSEL=1→0 must NOT veto right SET (too early per Bauer §3.14.1 "exactly cycle 56"), got hBorder=${result}`);
  ok('hRightSet veto: cycle 55 (too early per Bauer §3.14.1)');
}

// ── 5: hRightSet veto does NOT fire at cycle 57 (latch already fired) ───
// Latch eval is at phi1 of cycle 57. A CPU write at cycle 57 phi2
// happens AFTER the latch — too late to affect the SET commit.
{
  const result = runRightVetoAttempt(57);
  expect(result === true,
    `cycle-57 CSEL=1→0 must NOT veto right SET (latch already committed), got hBorder=${result}`);
  ok('hRightSet veto: cycle 57 (too late — latch already fired)');
}

// ── 6: hRightSet veto does NOT fire at cycle 58 (well past the window) ──
{
  const result = runRightVetoAttempt(58);
  expect(result === true,
    `cycle-58 CSEL=1→0 must NOT veto right SET, got hBorder=${result}`);
  ok('hRightSet veto: cycle 58 (well past the window)');
}

// ── 7: Latch delay for hRightSet is exactly 2 master cycles ─────────────
// We assert the queued pending transition's latchTotalCycles is exactly
// detect_total + 2 — not +1 (would let cycle-55 writes succeed) or +3
// (would let cycle-57 writes succeed). This pins the +2 invariant that
// external review proposals have suggested unifying with hLeftReset's +3.
{
  const vic = makeVic();
  driveTo(vic, 100, 54);
  // Step into cycle 55 — the detect cycle. After this clock(1), the
  // pending hRightSet has been pushed.
  vic.clock(1);
  expect(vic.cycleInLine === 55, `must be at cycle 55 to capture detect`);
  const pending = vic._pendingFFTransitions
    .filter(p => p.kind === 'hRightSet' && p.raster === 100);
  expect(pending.length >= 1, `hRightSet must be queued after cycle-55 detect`);
  if (pending.length >= 1) {
    const p = pending[pending.length - 1];
    const detectTotalAtPush = vic.totalCycles - 1; // before this advance? Actually pushed during this clock; latchTotalCycles is recorded at push, totalCycles is now post-push.
    // Reconstruct expected latch delay: from detectCycle of 55 to latch
    // of 57 = exactly 2 master cycles. We compare via the relation
    // latchTotalCycles - totalCycles_at_detect = 2 (detect runs during
    // this clock; totalCycles == detect's totalCycles immediately after
    // the in-cycle increment).
    const delay = p.latchTotalCycles - vic.totalCycles;
    expect(delay === 2,
      `hRightSet latch delay must be exactly 2 master cycles (Bauer §3.14.1, write window = detectCycle+1 = cycle 56), got ${delay}`);
  }
  ok('hRightSet latch delay = +2 master cycles');
}

// ── 8: hLeftReset veto fires at exactly cycle 17 (canonical) ────────────
// Run a 38-col-mode line (CSEL=0). Switch to CSEL=1 at cycle 17 — that
// vetoes the left-RESET, leaving hBorder closed across the entire line.
{
  const result = runLeftVetoAttempt(17);
  expect(result === true,
    `cycle-17 CSEL=0→1 must veto left RESET (border stays closed), got hBorder=${result}`);
  ok('hLeftReset veto: cycle 17 (canonical)');
}

// ── 9: hLeftReset veto does NOT fire at cycle 16 (too early per Bauer) ──
// Bauer §3.14.1 (verbatim): "the horizontal border can be prevented from
// turning off by switching from CSEL=0 to CSEL=1 in cycle 17." A CPU
// write at cycle 16 phi2 is one cycle early and must NOT veto. Mechanically
// the write does propagate to phi1 of cycle 17 (before the FF latches at
// phi1 of 18), but Bauer's "exactly cycle 17" rule is the spec — real
// silicon rejects c16 phi2 writes for this trick.
//
// Same caveat as test 4: if a demo's `$D016` write lands at cycle 16 in
// our model when it should land at cycle 17, fix that 1-cy deficit
// upstream rather than widening this veto window.
{
  const result = runLeftVetoAttempt(16);
  expect(result === false,
    `cycle-16 CSEL=0→1 must NOT veto left RESET (too early per Bauer §3.14.1 "exactly cycle 17"), got hBorder=${result}`);
  ok('hLeftReset veto: cycle 16 (too early per Bauer §3.14.1)');
}

// ── 10: hLeftReset veto does NOT fire at cycle 18 (latch already fired) ─
{
  const result = runLeftVetoAttempt(18);
  expect(result === false,
    `cycle-18 CSEL=0→1 must NOT veto (latch fired at phi1 of 18 already), got hBorder=${result}`);
  ok('hLeftReset veto: cycle 18 (too late — latch already fired)');
}

// ── 11: Latch delay for hLeftReset is exactly 3 master cycles ───────────
// Pinned alongside hRightSet's +2 to lock down the asymmetry. External
// reviewers have proposed unifying both to +2; that would shift left's
// trick window from cycle 17 to cycle 16 and break Bauer's "exactly
// cycle 17" rule. This test fails if anyone unifies them.
{
  const vic = makeVic();
  vic.regs[0x16] = 0x00;                       // CSEL=0 (left=31)
  driveTo(vic, 100, 14);
  vic.clock(1);                                // step into cycle 15 (detect)
  expect(vic.cycleInLine === 15, `must be at cycle 15 to capture left-RESET detect`);
  const pending = vic._pendingFFTransitions
    .filter(p => p.kind === 'hLeftReset' && p.raster === 100);
  expect(pending.length >= 1, `hLeftReset must be queued after cycle-15 detect`);
  if (pending.length >= 1) {
    const p = pending[pending.length - 1];
    const delay = p.latchTotalCycles - vic.totalCycles;
    expect(delay === 3,
      `hLeftReset latch delay must be exactly 3 master cycles (write window = detectCycle+2 = cycle 17), got ${delay}`);
  }
  ok('hLeftReset latch delay = +3 master cycles (asymmetric to hRightSet by design)');
}

// ── 12: regs at latch eval has phi2-of-detect-plus-1 writes, not detect-plus-2
// Pin the bus-cycle-ordering invariant: when _evalLatchedTransition runs
// for hRightSet at phi1 of cycle 57, regs reflects CPU writes through
// phi2 of cycle 56 — NOT phi2 of cycle 57. This is the exact regs
// observation point that Bauer's "exactly cycle 56" trick relies on.
//
// We test by writing CSEL=1→0 at cycle 56 phi2 (= via vic.write inside
// the master cycle 56 sequence) and verifying the veto fires. The
// canonical test 1 already does this directly; this test additionally
// verifies a same-cycle race: a SECOND write at cycle 57 phi2 should
// NOT be visible to the cycle-57 latch eval (since the eval ran at
// phi1, before phi2). We write at cycle 56 phi2 (vetoes), then again
// at cycle 57 phi2 (back to CSEL=1 — should not un-veto).
{
  const vic = makeVic();
  driveTo(vic, 100, 56);
  vic.write(0x16, 0x00);                       // CSEL=1→0 at cycle 56 phi2
  vic.clock(1);                                // → cycle 57 (latch eval here)
  expect(vic.hBorderActive === false,
    `latch at cycle 57 phi1 sees CSEL=0 (= post-cycle-56-write), veto fires`);
  vic.write(0x16, 0x08);                       // back to CSEL=1 at cycle 57 phi2
  vic.clock(1);
  expect(vic.hBorderActive === false,
    `cycle-57 phi2 CSEL=0→1 must NOT un-veto (latch already committed at phi1), got hBorder=${vic.hBorderActive}`);
  ok('regs sampling at latch is post-phi2-of-(detect+1), not phi2-of-(detect+2)');
}

console.log(`\n${testNo} CSEL veto-window spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
