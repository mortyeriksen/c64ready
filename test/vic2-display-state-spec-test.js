// VIC display state machine spec audit. 15 tests derived from Bauer
// §3.7.2 (display state, VC/VCBASE/RC counters, rules 1..6) — the
// per-line counter cadence that drives bad-line c-fetches and character-
// row alignment. Off-by-one here produces the kind of "1 character cell
// shifts in/out" symptoms nine.prg occasionally shows.

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

// Drive VIC forward to (raster, cycle). Absolute target — uses current
// raster/cycleInLine to compute remaining cycles, so calling driveTo
// multiple times in sequence advances correctly.
//
// Drives FULL master cycles (vic.clock=phi1 + vic.phi2=phi2) so the
// cycle-58 transition (now in phi2 per master-cycle ordering) fires
// each line. See cycle58-live-badline-sampling-spec-test.js.
function driveTo(vic, raster, cycle = 0) {
  while (vic.raster < raster || (vic.raster === raster && vic.cycleInLine < cycle)) {
    vic.clock(1);
    vic.phi2();
  }
}

// Run one full master cycle (phi1 + phi2). Used after driveTo() to
// fire the cycle-58 phi2 transition.
function clockFull(vic) { vic.clock(1); vic.phi2(); }

// ── 1: VC := VCBASE at cycle 14 of every line ────────────────────────────
// Bauer §3.7.2 rule 2: at cycle 14 of every raster line, VC is loaded
// from VCBASE. This makes the same character row re-read from the same
// matrix location across multiple non-bad-line scanlines.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.displayEnabled = true;
  driveTo(vic, 51, 13);                  // L51.c13 (just before cycle 14)
  vic.vcBase = 0x100;
  vic.vc = 0x77;                          // dirty
  vic.clock(1);                            // cycle 14 fires
  expect(vic.vc === (vic.vcBase & 0x3FF),
    `Bauer §3.7.2 rule 2: VC := VCBASE at cycle 14, got VC=$${vic.vc.toString(16)}`);
  ok('Bauer §3.7.2 rule 2: VC := VCBASE at cycle 14');
}

// ── 2: VC increments by 1 per g-access (cycles 15..54) ───────────────────
// Bauer §3.7.2: each g-access advances VC. Over 40 c/g cycles VC moves by
// 40 positions.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.displayEnabled = true;
  driveTo(vic, 51);
  // Drive into bad-line, capture VC before and after the c-fetch window.
  driveTo(vic, 51, 14);                  // L51.c14: VC := VCBASE
  const vcStart = vic.vc;
  for (let i = 0; i < 40; i++) vic.clock(1);   // through c-access cycles
  const vcEnd = vic.vc;
  expect(vcEnd === ((vcStart + 40) & 0x3FF),
    `Bauer §3.7.2: VC must advance 40 positions across c/g window, got ${vcStart}→${vcEnd}`);
  ok('Bauer §3.7.2: VC advances by 1 per g-access (40 positions per row)');
}

// ── 3: RC := 0 at cycle 14 of bad-line (rule 5) ──────────────────────────
// Bauer §3.7.2 rule 5: a bad line resets RC to 0 at cycle 14 (= start of
// new character row). Non-bad-lines preserve RC.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.displayEnabled = true;
  driveTo(vic, 51, 13);
  vic.rc = 5;
  vic.clock(1);                            // cycle 14
  expect(vic.rc === 0,
    `Bauer rule 5: bad-line at L51 must reset RC=0 at cycle 14, got RC=${vic.rc}`);
  ok('Bauer §3.7.2 rule 5: RC := 0 at cycle 14 of bad-line');
}

// ── 4: RC unchanged at cycle 14 of non-bad-line ──────────────────────────
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.displayEnabled = true;
  driveTo(vic, 52, 13);                  // L52 not a bad line (52 & 7 != 3)
  vic.rc = 4;
  vic.clock(1);
  expect(vic.rc === 4,
    `non-bad-line: RC must be preserved at cycle 14, got RC=${vic.rc}`);
  ok('Bauer §3.7.2: non-bad-line preserves RC at cycle 14');
}

// ── 5: VCBASE := VC at cycle 58 when RC=7 (rule 4) ───────────────────────
// Bauer §3.7.2 rule 4: at cycle 58, if RC==7, VCBASE is updated to VC.
// This advances the matrix pointer to the next character row.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.displayEnabled = true;
  vic.displayActive = true;
  driveTo(vic, 100, 57);                 // L100.c57
  vic.rc = 7;
  vic.vc = 0x123;
  vic.vcBase = 0x000;
  clockFull(vic);                          // cycle 58 phi1+phi2 (transition fires at phi2)
  expect(vic.vcBase === 0x123,
    `Bauer rule 4: VCBASE := VC at cycle 58 when RC=7, got VCBASE=$${vic.vcBase.toString(16)}`);
  ok('Bauer §3.7.2 rule 4: VCBASE := VC at cycle 58 when RC=7');
}

// ── 6: VCBASE unchanged at cycle 58 when RC<7 ────────────────────────────
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.displayEnabled = true;
  vic.displayActive = true;
  driveTo(vic, 100, 57);
  vic.rc = 5;
  vic.vc = 0x123;
  vic.vcBase = 0x099;
  vic.clock(1);
  expect(vic.vcBase === 0x099,
    `RC=5 at cycle 58: VCBASE must NOT update, got VCBASE=$${vic.vcBase.toString(16)}`);
  ok('Bauer §3.7.2: VCBASE unchanged at cycle 58 when RC<7');
}

// ── 7: RC advances at cycle 58 if display still active ───────────────────
// Bauer §3.7.2 rule 6: at cycle 58, if RC was not 7 AND display stays
// active, RC := (RC+1) & 7.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.displayEnabled = true;
  vic.displayActive = true;
  driveTo(vic, 100, 57);
  vic.rc = 3;
  clockFull(vic);                          // cycle 58 phi1+phi2
  expect(vic.rc === 4,
    `Bauer rule 6: RC must advance 3→4 at cycle 58, got RC=${vic.rc}`);
  ok('Bauer §3.7.2 rule 6: RC advances at cycle 58 (3→4)');
}

// ── 8: RC=7 at cycle 58 + !badline → display goes off ────────────────────
// Bauer §3.7.2 rule 5: if RC==7 at cycle 58 AND the line is NOT a bad
// line, display is turned off. This ends the character-row.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18;                   // DEN=1, RSEL=1, YSCROLL=0 → bad-line at (raster & 7)==0
  vic.displayEnabled = true;
  vic.displayActive = true;
  // L100 has (100 & 7) == 4, NOT a bad line with YSCROLL=0.
  driveTo(vic, 100, 57);
  vic.rc = 7;
  clockFull(vic);                          // cycle 58 phi1+phi2 (transition fires at phi2)
  expect(vic.displayActive === false,
    `Bauer rule 5: RC=7 + !badline at cycle 58 → display=off`);
  ok('Bauer §3.7.2 rule 5: RC=7 at cycle 58 with non-bad-line ends display row');
}

// ── 9: VC wraps at 0x3FF (10-bit) ────────────────────────────────────────
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.displayEnabled = true;
  driveTo(vic, 51, 13);
  vic.vcBase = 0x3FF;
  vic.clock(1);                            // cycle 14: VC := VCBASE
  expect(vic.vc === 0x3FF, `pre: VC=$3FF`);
  for (let i = 0; i < 1; i++) vic.clock(1);
  // After 1 g-access cycle, VC should wrap to 0.
  expect(vic.vc === 0,
    `Bauer §3.7.2: VC is 10-bit, wraps $3FF→$000, got VC=$${vic.vc.toString(16)}`);
  ok('Bauer §3.7.2: VC is 10-bit (wraps at $3FF)');
}

// ── 10: Bad-line every 8 lines with YSCROLL=3 (lines 51, 59, 67, ...) ────
// Bauer §3.5: bad-line raster = $30..$F7 with (raster & 7) == YSCROLL.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;                   // YSCROLL=3
  vic.displayEnabled = true;
  for (const r of [51, 59, 67, 75, 83]) {
    expect(vic._isBadLine(r, vic.regs) === true,
      `L${r} (raster & 7 = ${r & 7}, YSCROLL=3): must be bad-line`);
  }
  for (const r of [50, 52, 60, 80]) {
    expect(vic._isBadLine(r, vic.regs) === false,
      `L${r} (raster & 7 = ${r & 7}): must NOT be bad-line`);
  }
  ok('Bauer §3.5: bad-line every 8 raster lines starting where (raster & 7) == YSCROLL');
}

// ── 11: Bad-line vertical range $30..$F7 only ────────────────────────────
// Bauer §3.5: bad-line condition only fires when raster is in the active
// display range $30..$F7 (48..247). Outside this range, even YSCROLL
// matches are ignored.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.displayEnabled = true;
  // YSCROLL=3, so raster 3, 11, 19, 27 would have (raster & 7) == 3 BUT
  // they're outside the active range so no bad-line.
  expect(vic._isBadLine(3, vic.regs) === false, `L3 outside active range`);
  expect(vic._isBadLine(27, vic.regs) === false, `L27 outside active range`);
  expect(vic._isBadLine(48, vic.regs) === false, `L48: matches range start but YSCROLL=3 doesn't match (48 & 7=0)`);
  expect(vic._isBadLine(248, vic.regs) === false, `L248: outside ($F7+1)`);
  expect(vic._isBadLine(51, vic.regs) === true, `L51: in range AND YSCROLL match`);
  expect(vic._isBadLine(243, vic.regs) === true, `L243: in range AND YSCROLL match`);
  ok('Bauer §3.5: bad-line range = raster $30..$F7 (48..247)');
}

// ── 12: Display goes inactive when DEN=0 mid-frame ───────────────────────
// Bauer §3.7.2: with DEN cleared, the bad-line condition can never fire
// (since rule 5 requires DEN). After the current row finishes (RC=7 at
// cycle 58), display turns off and stays off.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.displayEnabled = true;
  vic.displayActive = true;
  driveTo(vic, 70, 57);
  vic.rc = 7;
  vic.write(0x11, 0x0B);                   // DEN=0
  clockFull(vic);                          // cycle 58 phi1+phi2 (transition fires at phi2)
  expect(vic.displayActive === false,
    `DEN cleared + RC=7 at cycle 58: display must go off`);
  ok('Bauer §3.7.2: clearing DEN ends display when row completes');
}

// ── 13: VCBASE wraps at $3FF (10-bit) ────────────────────────────────────
{
  const vic = makeVic();
  vic.vcBase = 0x3FF;
  vic.vc = 0x000;
  // Force a VC=0, RC=7 cycle-58 update.
  vic.regs[0x11] = 0x1B;
  vic.displayEnabled = true;
  vic.displayActive = true;
  driveTo(vic, 100, 57);
  vic.rc = 7;
  vic.vc = 0x400;                          // out-of-range — should mask
  vic.clock(1);
  expect((vic.vcBase & 0x3FF) === vic.vcBase,
    `Bauer §3.7.2: VCBASE is 10-bit, must mask to $3FF, got $${vic.vcBase.toString(16)}`);
  ok('Bauer §3.7.2: VCBASE is 10-bit (masked to $3FF)');
}

// ── 14: RC increments mod 8 ──────────────────────────────────────────────
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.displayEnabled = true;
  vic.displayActive = true;
  // RC progression across 8 lines should be 0,1,2,3,4,5,6,7.
  driveTo(vic, 100, 57);
  for (let target = 0; target < 8; target++) {
    vic.rc = target;
    clockFull(vic);                        // cycle 58 phi1+phi2 (transition fires)
    const expected = target === 7 ? 0 : (target + 1);
    if (target !== 7) {
      // continuing in same row
      expect(vic.rc === expected,
        `RC ${target}→${expected} at cycle 58, got ${vic.rc}`);
    }
    // Skip to next L's cycle 57 (full master cycles).
    for (let i = 0; i < CYCLES_PER_LINE - 1; i++) clockFull(vic);
  }
  ok('Bauer §3.7.2: RC increments mod 8');
}

// ── 15: VC reload at cycle 14 makes character row repeat ─────────────────
// Bauer §3.7.2 rule 2: VC := VCBASE at cycle 14 of EVERY line. This is
// what makes the same character row data re-read on each of the 8 lines
// of the row (combined with RC determining which scanline of the
// character to show). Set VCBASE just before each line's cycle 14 to
// isolate the rule from rule 4 (cycle 58 VCBASE update).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.displayEnabled = true;
  vic.displayActive = true;
  for (let line of [52, 53, 54]) {
    driveTo(vic, line, 13);
    vic.vcBase = 0x42;                    // re-set after driveTo's intermediate state
    vic.vc = 0xFFF;                        // dirty
    vic.clock(1);                            // cycle 14 fires rule 2
    expect(vic.vc === 0x42,
      `L${line} cycle 14: VC must reload from VCBASE=$42, got $${vic.vc.toString(16)}`);
  }
  ok('Bauer §3.7.2 rule 2: VC reloads from VCBASE every line at cycle 14');
}

console.log(`\n${testNo} display-state spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
