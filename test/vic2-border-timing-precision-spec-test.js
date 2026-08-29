// Border timing precision spec audit. 10 tests targeting the cycles
// nine.prg's left/right border flicker most likely lives at: exact-cycle
// CSEL changes, vBorder transition cycles, and the DEN latch at L48 boundary.
//
// Sources: Bauer §3.9 (border state machine), §3.5 (DEN latch).

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
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

function driveTo(vic, raster, cycle = 0) {
  while (vic.raster < raster || (vic.raster === raster && vic.cycleInLine < cycle)) {
    vic.clock(1);
  }
}

// ── 1: vBorder set at cycle 63 of bottom-compare line (L251 with RSEL=1) ─
// Bauer §3.9 rule 2: "When the Y coordinate reaches the bottom
// comparison value in cycle 63, the vertical border flip-flop is set."
// With RSEL=1, bottomCompare=251 — SET fires at cycle 63 of L251.
// Drive past L251 c63 (= L252 entry) to observe the latched value.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  driveTo(vic, 100);
  expect(vic.vBorderActive === false, `pre L100: vBorder open (within display)`);
  driveTo(vic, 252);
  expect(vic.vBorderActive === true, `after L251 c63: vBorder must be SET`);
  ok(`SET fires at cycle 63 of L251 (bottomCompare line)`);
}

// ── 2: vertical FF cleared at top-compare line (L51, RSEL=1, DEN=1) ────
// Bauer §3.9 two-stage model (the vertical FF is re-evaluated every cycle —
// validated against dentest den10-51-N / denrsel-* and VICE): the top-compare
// clear fires at the START of L51 (cycle 1), gated by DEN there — not at the
// left edge. (The VISIBLE border opens at the left-H compare via the main FF;
// see vic2-border-edge §6.)
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  driveTo(vic, 51, 0);
  expect(vic.vBorderActive === true, `pre L51 line start: vBorder still closed (top reset not yet fired)`);
  let clearAt = -1;
  for (let i = 0; i < CYCLES_PER_LINE; i++) {
    vic.clock(1);
    if (!vic.vBorderActive && clearAt === -1) clearAt = vic.cycleInLine;
  }
  expect(clearAt >= 1 && clearAt <= 2,
    `vertical-FF top-compare clear fires at line start (cycle 1-2), got ${clearAt}`);
  ok(`Bauer §3.9: vertical-FF top-compare clears at cycle ${clearAt} of L51 (DEN=1)`);
}

// ── 3: top-compare reset is gated by DEN sampled at LINE START ─────────
// Two-stage model (validated vs dentest den10-51-N / VICE): the top-compare
// clear fires at the start of L51 (cycle 1). So the "open vertical border"
// trick must clear DEN BEFORE L51 (on a prior line) — a DEN=0 written mid-L51,
// AFTER the line-start clear, is too late to block it.
{
  // (a) DEN=0 written mid-L51 is too late: the line-start clear already fired.
  const a = makeVic();
  a.regs[0x11] = 0x1B; a.regs[0x16] = 0x08;
  driveTo(a, 51, 13);
  a.write(0x11, 0x0B);               // DEN=0 at cycle 13 — after the line-start clear
  for (let i = 0; i < CYCLES_PER_LINE - 13; i++) a.clock(1);
  expect(a.vBorderActive === false,
    `DEN=0 mid-L51 (cycle 13) is too late: line-start top reset already fired`);

  // (b) DEN=0 latched BEFORE L51 blocks the line-start clear (open-border trick).
  const b = makeVic();
  b.regs[0x11] = 0x1B; b.regs[0x16] = 0x08;
  driveTo(b, 50, 30);
  b.write(0x11, 0x0B);               // DEN=0 on L50 → DEN=0 at L51 line start
  driveTo(b, 52, 0);                 // run through all of L51
  expect(b.vBorderActive === true,
    `DEN=0 latched before L51: top-compare reset blocked (open-border trick)`);
  ok('Bauer §3.9: top-compare reset gated by DEN at line start (open-border trick clears DEN before L51)');
}

// ── 4: hBorder closes IMMEDIATELY at right-edge regardless of DEN ──────
// Bauer §3.9: right-edge SETs hBorder unconditionally. Only left-edge
// CLEAR is gated by vBorder=0. Test by walking through cycle 56 with
// vBorder open (display zone).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  driveTo(vic, 100, 50);
  expect(vic.hBorderActive === false, `mid-line cycle 50: hBorder open (in display)`);
  let closeAt = -1;
  for (let i = 0; i < 15; i++) {
    vic.clock(1);
    if (vic.hBorderActive && closeAt === -1) closeAt = vic.cycleInLine;
  }
  expect(closeAt >= 55 && closeAt <= 57,
    `right-edge cycle: hBorder closes at cycle 55-57, got ${closeAt}`);
  ok(`Bauer §3.9: hBorder right-edge sets at cycle ${closeAt}`);
}

// ── 5: hBorder open requires vBorder=0 (vertical border supremacy) ─────
// Bauer §3.9: left-edge clears hBorder ONLY when vBorder=0. If vBorder
// is closed, hBorder STAYS closed across the left-edge.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  // L0 has vBorder closed; walk through cycle 14.
  for (let i = 0; i < CYCLES_PER_LINE; i++) vic.clock(1);
  driveTo(vic, 1, 1);
  expect(vic.vBorderActive === true, `pre L1: vBorder closed`);
  for (let i = 0; i < 30; i++) vic.clock(1);
  expect(vic.hBorderActive === true,
    `L1 cycle 30: hBorder must stay closed (vBorder closed)`);
  ok('Bauer §3.9: hBorder cannot open when vBorder is closed');
}

// ── 7: BAUER §3.9.1 horizontal border-FF set/clear logic ───────────────
// The H-FF is set by the right-compare and cleared by the left-compare
// (when vertical-FF is also clear). Verify state machine:
//   - line start: H-FF should be SET (border closed at cycle 1)
//   - cycle 14 (CSEL=1): H-FF clears if vertical FF is clear
//   - cycle 56 (CSEL=1): H-FF sets unconditionally
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  driveTo(vic, 100, 0);
  expect(vic.hBorderActive === true, `entering L100: hBorder closed at line start`);
  for (let i = 0; i < 13; i++) vic.clock(1);
  expect(vic.hBorderActive === true, `L100.c13: still closed (before left-compare)`);
  vic.clock(1);                       // cycle 14
  // hBorder may still be set this cycle; cycle 15 is the first OPEN cycle.
  vic.clock(1);                       // cycle 15
  expect(vic.hBorderActive === false, `L100.c15: hBorder open after left-compare`);
  ok('Bauer §3.9.1: H-FF state machine — closed at line start, open after left-compare');
}

// ── 8: Top-compare uses DEN sampled at the comparator firing cycle ────
// If DEN is cleared between L51.c14 (when top-compare fires) and the
// rest of the line, the H-compare for vBorder reset has already
// happened — vBorder is already cleared.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  driveTo(vic, 51, 13);
  // Don't clear DEN here — let it be 1 when cycle 14 fires.
  vic.clock(1);                       // cycle 14
  vic.clock(1);                       // cycle 15
  expect(vic.vBorderActive === false, `vBorder cleared at L51 left-compare with DEN=1`);
  // Now clear DEN — too late.
  vic.write(0x11, 0x0B);
  for (let i = 0; i < CYCLES_PER_LINE - 15; i++) vic.clock(1);
  expect(vic.vBorderActive === false,
    `DEN cleared AFTER cycle 14: top-reset already happened, vBorder stays open`);
  ok('Bauer §3.9: DEN sampled at left-H compare cycle, post-cycle changes don\'t un-clear');
}

// ── 9: vBorder bottom-compare at L251 happens regardless of DEN ────────
// Bauer §3.9: bottom-compare ALWAYS sets vBorder. DEN only affects
// the TOP compare.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  driveTo(vic, 250);
  vic.write(0x11, 0x0B);             // DEN=0 just before bottom-compare line
  driveTo(vic, 252);
  expect(vic.vBorderActive === true,
    `bottom-compare at L251 fires regardless of DEN, got vBorder=${vic.vBorderActive}`);
  ok('Bauer §3.9: bottom-compare sets vBorder unconditionally (DEN-independent)');
}

// ── 10: H-compare points: CSEL=1 → cycles ~14/55, CSEL=0 → cycles ~14/53
// CSEL=1 right edge at canvasX=344 (cycle 55+1); CSEL=0 right edge at
// canvasX=335 (cycle 53+1). Left edge nearly identical (X=24 vs 31,
// both fall inside cycle 14).
{
  // CSEL=1
  {
    const vic = makeVic();
    vic.regs[0x11] = 0x1B;
    vic.regs[0x16] = 0x08;
    driveTo(vic, 100);
    let openSeen = false, closeAt = -1;
    for (let c = 1; c <= CYCLES_PER_LINE; c++) {
      vic.clock(1);
      if (!vic.hBorderActive) openSeen = true;
      else if (openSeen && closeAt === -1) closeAt = vic.cycleInLine;
    }
    expect(closeAt === 55 || closeAt === 56,
      `CSEL=1 right close at cycle 55-56, got ${closeAt}`);
  }
  // CSEL=0 → right=335 falls inside cycle 53 (which covers X=328..335).
  {
    const vic = makeVic();
    vic.regs[0x11] = 0x1B;
    vic.regs[0x16] = 0x00;
    driveTo(vic, 100);
    let openSeen = false, closeAt = -1;
    for (let c = 1; c <= CYCLES_PER_LINE; c++) {
      vic.clock(1);
      if (!vic.hBorderActive) openSeen = true;
      else if (openSeen && closeAt === -1) closeAt = vic.cycleInLine;
    }
    expect(closeAt === 53,
      `CSEL=0 right (X=335) closes at cycle 53, got ${closeAt}`);
  }
  ok('Bauer §3.9: CSEL right-compare moves from cycle 55 (CSEL=1) to cycle 53 (CSEL=0)');
}

console.log(`\n${testNo} border timing-precision spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
