// Bauer §3.14.1 vertical-hyperscreen / RSEL-trick spec test.
//
// Two sequence tests pin the spec's two RSEL-based vBorder tricks:
//
//   A. Open the top/bottom border (the trick nine.prg uses for its
//      upper-border effect): write RSEL=1→0 (25-row → 24-row) anywhere
//      in raster 248..250. With RSEL=1, bottomCompare=251; rule 2 would
//      SET vBorder at L251 c63. After RSEL=0, bottomCompare=247 — but
//      raster 248..250 have already passed 247, and L251 ≠ 247, so the
//      cycle-63 SET never fires for the rest of the frame. vBorder
//      stays cleared → bottom border opens, and the next frame's top
//      border opens too (rule 3's RESET at L55 with RSEL=0 is a no-op
//      since vBorder is already 0).
//
//   B. Whole-screen border (per spec §3.14.1: "If you switch from
//      RSEL=0 to RSEL=1 in the raster line range 52-54, the border
//      never turns off and covers the whole screen"). With RSEL=0,
//      topCompare=55; rule 3 would RESET vBorder at L55 c63. After
//      RSEL=0→1, topCompare=51 — but raster 52..54 has already passed
//      51, and L55 ≠ 51, so the cycle-63 RESET never fires. vBorder
//      stays SET → whole frame is border colour.

import { C64Machine } from '../src/machine.js';

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

// Drive the machine until it reaches a target (raster, cycleInLine).
// Stops at the FIRST tick where both match.
function driveTo(machine, raster, cycle) {
  for (let safety = 0; safety < 25000; safety++) {
    if (machine.vic2.raster === raster && machine.vic2.cycleInLine === cycle) return;
    machine._runMasterCycle();
  }
  throw new Error(`driveTo(${raster}, ${cycle}) timeout — at ${machine.vic2.raster}:${machine.vic2.cycleInLine}`);
}

function makeMachine() {
  const m = new C64Machine();
  // Skip ROM load — start with bare RAM. The VIC needs to clock; CPU
  // executes whatever's in RAM (default $00 = BRK, but we don't care
  // about CPU side effects for vBorder timing tests).
  // Set a clean baseline state on regs we care about.
  m.vic2.regs[0x11] = 0x1B;             // DEN=1, RSEL=1, YSCROLL=3
  m.vic2.regs[0x16] = 0x08;             // CSEL=1
  m.vic2.regs[0x20] = 0x00;
  m.vic2.regs[0x21] = 0x06;
  m.vic2.displayEnabled = true;          // bypass the L48 latch — we
                                         // want vBorder rules to fire
                                         // without depending on it.
  return m;
}

// ─────────────────────────────────────────────────────────────────────
// 1: Standard-frame baseline — vBorder transitions normally.
// With RSEL=1 throughout: vBorder=true at frame start (init), RESETs
// at L51 c63 (DEN=1), SETs at L251 c63. After L251 c63 vBorder=true.
// ─────────────────────────────────────────────────────────────────────
{
  const m = makeMachine();
  // Drive past L51 c63 — top RESET should fire.
  driveTo(m, 52, 1);
  expect(m.vic2.vBorderActive === false,
    `after L51 c63 RESET (RSEL=1, DEN=1): vBorder=false, got ${m.vic2.vBorderActive}`);
  // Drive past L251 c63 — bottom SET should fire.
  driveTo(m, 252, 1);
  expect(m.vic2.vBorderActive === true,
    `after L251 c63 SET (RSEL=1): vBorder=true, got ${m.vic2.vBorderActive}`);
  ok('Bauer §3.9 baseline: RSEL=1 — RESET at L51, SET at L251');
}

// ─────────────────────────────────────────────────────────────────────
// 2: §3.14.1 trick A — RSEL=1→0 at L248 bypasses bottom SET.
// vBorder stays cleared through L251..L311 and L0..L51 of next frame.
// ─────────────────────────────────────────────────────────────────────
{
  const m = makeMachine();
  // Drive past L51 c63 — top RESET fires; vBorder=0.
  driveTo(m, 52, 1);
  expect(m.vic2.vBorderActive === false, `setup: vBorder cleared after L51 RESET`);
  // Drive to L248 c10 (well within the trick window of raster 248..250).
  driveTo(m, 248, 10);
  // CPU writes $D011 = 0x13 (DEN=1, RSEL=0). The trick.
  m.vic2.write(0x11, 0x13);
  // Drive past L251 c63 — bottomCompare(RSEL=0)=247, raster=251 → no SET.
  driveTo(m, 252, 1);
  expect(m.vic2.vBorderActive === false,
    `§3.14.1 trick A: after L251 c63 with RSEL=0 → no SET, got vBorder=${m.vic2.vBorderActive}`);
  // Drive into next frame past L51 c63.
  driveTo(m, 52, 1);                     // driveTo loops past frame end
  expect(m.vic2.vBorderActive === false,
    `next frame's L51 c63 RESET is a no-op (already 0); top zone stays open, got vBorder=${m.vic2.vBorderActive}`);
  // Verify vBorder=0 across the full top zone (L0..L50).
  // We're already at L52 c1; vBorder must have been 0 throughout L0..L50.
  ok('Bauer §3.14.1 trick A: RSEL=1→0 at L248 → vBorder bypassed for the rest of frame and next frame');
}

// ─────────────────────────────────────────────────────────────────────
// 3: §3.14.1 trick B — RSEL=0→1 at L53 bypasses top RESET.
// With RSEL=0 setup: bottom SET at L247. RSEL flipped to 1 at L53 →
// new topCompare=51 → L55 c63 with RSEL=1 misses (raster=55 ≠ 51).
// vBorder stays SET; whole frame is border.
// ─────────────────────────────────────────────────────────────────────
{
  const m = makeMachine();
  m.vic2.regs[0x11] = 0x13;             // DEN=1, RSEL=0 — bottomCompare=247
  // Drive past L247 c63 — bottom SET fires (RSEL=0, raster=247=247).
  driveTo(m, 248, 1);
  expect(m.vic2.vBorderActive === true,
    `setup: after L247 c63 SET (RSEL=0): vBorder=true, got ${m.vic2.vBorderActive}`);
  // Drive past frame wrap into next frame's L53.
  driveTo(m, 53, 10);
  // CPU writes $D011 = 0x1B (DEN=1, RSEL=1). Top compare flips to L51.
  m.vic2.write(0x11, 0x1B);
  // Drive past L55 c63 — would have been topCompare for RSEL=0, but
  // now RSEL=1 → topCompare=51 ≠ 55. RESET doesn't fire.
  driveTo(m, 56, 1);
  expect(m.vic2.vBorderActive === true,
    `§3.14.1 trick B: after L55 c63 with RSEL=1 → no RESET, vBorder stays SET, got ${m.vic2.vBorderActive}`);
  // Drive deep into "display zone" — should still be border.
  driveTo(m, 150, 1);
  expect(m.vic2.vBorderActive === true,
    `whole-screen border: vBorder still SET at L150, got ${m.vic2.vBorderActive}`);
  ok('Bauer §3.14.1 trick B: RSEL=0→1 at L53 → vBorder stays SET → whole frame border');
}

// ─────────────────────────────────────────────────────────────────────
// 4: §3.14.1 trick A reverse-direction — RSEL=0→1 at L243 bypasses
// the L247 bottom SET symmetrically. Starting RSEL=0 (24-row mode),
// bottomCompare=247; rule 2 would SET vBorder at L247 c63. By writing
// RSEL=0→1 anywhere in raster 243..245, the new bottomCompare=251 —
// but raster 243..245 has already passed... actually it hasn't passed
// 251. So the new bottomCompare=251 is in the FUTURE; the next L251
// c63 will check raster=251 vs bottomCompare=251 and SET. That makes
// the symmetric trick differ: with RSEL=0→1 mid-frame the bottom-set
// at L251 STILL fires. The "skip" only works when the new compare is
// already in the past, which is what 25-row → 24-row achieves.
//
// To get the actual reverse — RSEL=0 baseline with no L247 SET — the
// CPU must flip RSEL=0→1 BEFORE L247 c63 such that the OLD compare
// (247) is in the past with the NEW compare (251). That requires
// flipping at L248..L250 with starting RSEL=0 — which is impossible
// since the OLD compare (247) was already at L247 (past), not in the
// future. So the trick is asymmetric by spec design.
//
// We instead test the SYMMETRIC top-RESET-skip: RSEL=1→0 at L52..L54
// (with RSEL=1 baseline → topCompare=51 already passed → switch to
// RSEL=0 → new topCompare=55 in the future, but the rule-3 check at
// L55 c63 fires normally since 55=55). Ends up firing RESET — not a
// skip. So the only top-RESET-skip is trick B (RSEL=0→1 at L52..L54
// with RSEL=0 baseline).
//
// CONCLUSION: §3.14.1 names two RSEL tricks (A: 25→24 at L248-250 to
// skip bottom-SET; B: 24→25 at L52-54 to skip top-RESET). Both are
// directionally specific. There is no symmetric reverse pair — covered
// by tests 2 and 3 above.
//
// This test pins the asymmetry: a CPU write of the OPPOSITE direction
// (RSEL=0→1 at L248) does NOT skip the bottom SET — it fires normally.
{
  const m = makeMachine();
  m.vic2.regs[0x11] = 0x13;             // DEN=1, RSEL=0 baseline
  // Drive past L51 c63 — top RESET would fire if RSEL=1; with RSEL=0,
  // topCompare=55 → no fire at L51. Drive deeper.
  driveTo(m, 200, 1);
  // vBorder may still be SET from frame init — that's fine; we want to
  // check that L247 c63 SET fires when RSEL=0.
  m.vic2.vBorderActive = false;          // force a clean state to observe
  // Drive to L243 (within the candidate "trick window" for opposite dir).
  driveTo(m, 243, 10);
  // Write RSEL=0→1. This is the OPPOSITE direction of trick A.
  m.vic2.write(0x11, 0x1B);              // DEN=1, RSEL=1
  // Drive past L247 c63. With RSEL=1 now → bottomCompare=251, raster=247
  // ≠ 251 → no fire at L247.
  driveTo(m, 248, 1);
  expect(m.vic2.vBorderActive === false,
    `at L248 entry: bottomCompare check at L247 c63 with RSEL=1 misses, vBorder stays 0, got ${m.vic2.vBorderActive}`);
  // But L251 c63 with RSEL=1 → bottomCompare=251 = raster → fires.
  driveTo(m, 252, 1);
  expect(m.vic2.vBorderActive === true,
    `L251 c63 with RSEL=1 fires SET (asymmetry — opposite-direction "trick" doesn't skip), got ${m.vic2.vBorderActive}`);
  ok('Bauer §3.14.1: opposite-direction RSEL flip (0→1 at L243) does NOT skip — bottom SET still fires at L251');
}

console.log(`\n${testNo} vertical-hyperscreen spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
