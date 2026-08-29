// Bauer §3.14.2 / §3.14.3 / §3.14.4 / §3.14.5 spec audit.
//
// Four "bad-line manipulation" effects that build on the YSCROLL match
// rule from §3.5:
//
//   §3.14.2 FLD (Flexible Line Distance): hold YSCROLL ≠ (raster & 7)
//     across multiple lines → no bad-line → sequencer in idle, no
//     text-line display. Re-enable YSCROLL match later → text-line
//     resumes from a chosen raster.
//
//   §3.14.3 FLI (Flexible Line Interpretation): force a bad-line on
//     EVERY raster (write YSCROLL = raster & 7 each line). RC resets
//     to 0 at c14 of every line → fresh c-access reads new color
//     info every raster instead of every 8th raster.
//
//   §3.14.4 Linecrunch: cancel an already-fired bad-line BEFORE c14
//     by changing YSCROLL away from a match. RC is NOT reset (stays
//     at its prior value), VC keeps incrementing through g-accesses,
//     so VCBASE advances by 40 at c58 (rc===7+!badline kills display)
//     while RC remains at 7 — effectively crunching the entire
//     8-raster text row into one raster line.
//
//   §3.14.5 Doubled text lines: assert a fresh bad-line in cycles
//     54-57 of a line where RC=7 entering c58. The cycle-58
//     evaluator sees badLine=true and SKIPS the rc===7+!badline
//     transition — RC overflows to 0 instead of vcBase being
//     captured. The next line then re-displays the same text row
//     (no new c-access fires since vc/vmli were not advanced).

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
    vic.phi2();  // cycle-58 transition fires at phi2 in master-cycle ordering
    if (--safety <= 0) throw new Error(`drive timeout at r=${vic.raster} c=${vic.cycleInLine}`);
  }
}

// ── 1: §3.14.2 FLD — YSCROLL holds back the next bad line ────────────────
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18;                  // DEN=1, RSEL=1, YSCROLL=0
  vic.displayEnabled = true;
  driveTo(vic, 0x30, 1);                  // L48 = $30, displayEnabled latches

  // Normal: bad line fires at L48 (YSCROLL=0, 48&7=0, match).
  driveTo(vic, 0x30, 14);                 // c14 of L48
  expect(vic._isBadLine(0x30, vic.regs) === true,
    `pre: YSCROLL=0 at L48 → bad line`);
  // Now suppress: change YSCROLL to 1 BEFORE the next L8N (L56=$38, 56&7=0).
  // Drive to L49 c0, then write YSCROLL=1.
  driveTo(vic, 49, 1);
  vic.regs[0x11] = 0x18 | 1;              // YSCROLL=1
  // L56 (= 56) check: 56 & 7 = 0, YSCROLL=1, mismatch → no bad line.
  driveTo(vic, 56, 14);
  expect(vic._isBadLine(56, vic.regs) === false,
    `FLD: YSCROLL=1 holds back L56 bad line`);
  // L64, L72, L80 likewise — drive through several lines, all mismatched.
  for (let l of [64, 72, 80]) {
    driveTo(vic, l, 14);
    expect(vic._isBadLine(l, vic.regs) === false,
      `FLD: YSCROLL=1 holds back L${l} bad line`);
  }
  // Re-enable: YSCROLL=0 again, next L8N (L88) fires.
  driveTo(vic, 87, 60);
  vic.regs[0x11] = 0x18 | 0;              // YSCROLL=0
  driveTo(vic, 88, 14);
  expect(vic._isBadLine(88, vic.regs) === true,
    `FLD: re-enabling YSCROLL=0 at L88 fires bad line again`);
  ok('Bauer §3.14.2 FLD: YSCROLL ≠ raster&7 holds back bad lines, restoring resumes them');
}

// ── 2: §3.14.3 FLI — force bad line every raster via mid-line YSCROLL ────
//
// Setup: YSCROLL=7 default (no match), latch displayEnabled at L$30.
// Then at c14 of each line, write YSCROLL = (raster & 7) — fires bad
// line every line. RC resets to 0 every c14.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18 | 7;              // DEN=1, YSCROLL=7
  vic.displayEnabled = true;
  driveTo(vic, 0x30, 1);                  // latch displayEnabled
  // Initial bad-line: 0x30 & 7 = 0 ≠ YSCROLL=7. Set YSCROLL=0 at c1.
  vic.regs[0x11] = 0x18;                  // YSCROLL=0 — match for L$30
  driveTo(vic, 0x30, 14);
  expect(vic._isBadLine(0x30, vic.regs) === true, `L$30 c14 bad-line`);
  // Now FLI: every line, set YSCROLL = raster&7 BEFORE c14, so each
  // line's c14 check matches.
  let goodResetCount = 0;
  for (let r = 0x31; r <= 0x40; r++) {
    driveTo(vic, r, 1);
    vic.regs[0x11] = 0x18 | (r & 7);      // force YSCROLL=raster&7
    driveTo(vic, r, 14);
    if (vic._isBadLine(r, vic.regs)) goodResetCount++;
    expect(vic.rc === 0,
      `FLI L${r}: RC must reset to 0 at c14 of forced bad line, got rc=${vic.rc}`);
    // Drive through end of line so c58 also runs.
    driveTo(vic, r, 60);
  }
  expect(goodResetCount === 16,
    `FLI: bad line fires on all 16 lines L$31..L$40, got ${goodResetCount}`);
  ok('Bauer §3.14.3 FLI: per-line YSCROLL=raster&7 forces bad line each raster, RC stays at 0');
}

// ── 3: §3.14.4 Linecrunch — cancel bad-line before c14 ───────────────────
//
// Setup: bad-line condition fires at L$30. Cancel at c12 by writing
// YSCROLL≠0. RC must NOT reset; but VC still advances (display state
// already entered when the bad-line condition was first noted).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18 | 0;              // DEN=1, YSCROLL=0
  vic.displayEnabled = true;
  // Drive past L$30 so display is up and running with rc=7 from prior line.
  driveTo(vic, 0x30, 1);
  // Run a normal frame through one bad-line cycle so RC settles to 7 by
  // end of L$30+7 = L$37.
  driveTo(vic, 0x37, 60);
  expect(vic.rc === 7, `pre: RC=7 at end of L$37 (8th line of text row), got rc=${vic.rc}`);
  // Now at L$38 (= 56), the condition re-fires (56&7=0=YSCROLL).
  // Cancel BEFORE c14: at c12 write YSCROLL=1.
  driveTo(vic, 0x38, 12);
  expect(vic.lineBadLineDisplayPending === true,
    `pre: bad-line was queued by c12 of L$38`);
  vic.regs[0x11] = 0x18 | 1;              // YSCROLL=1 → cancels condition
  // Now drive through c14: cancellation must mean rc NOT reset.
  driveTo(vic, 0x38, 15);
  expect(vic.rc === 7,
    `Linecrunch: RC must stay at 7 (cancellation prevents reset), got rc=${vic.rc}`);
  expect(vic._isBadLine(0x38, vic.regs) === false,
    `Linecrunch: bad-line condition cancelled by c12 YSCROLL change`);
  ok('Bauer §3.14.4 Linecrunch: cancelling bad-line before c14 leaves RC at prior value');
}

// ── 4: §3.14.5 Doubled text lines — assert bad-line c54-57 of RC=7 line ──
//
// Setup: a normal bad-line at L$30 starts a text row. RC progresses
// 0..7 across L$30..L$37. At L$37 (rc=7 by c58 evaluator), trigger a
// fresh bad-line condition between c54-57 by writing YSCROLL = raster&7.
// The c58 evaluator sees badLine=true → does NOT take the rc===7+
// !badline branch → display state stays active, RC increments to 0.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18 | 0;              // DEN=1, YSCROLL=0
  vic.displayEnabled = true;
  driveTo(vic, 0x30, 1);                  // displayEnabled latches
  // Drive through L$30..L$37. By end of L$37 (= raster 55), rc should
  // be 7 (counting from rc=0 reset at L$30 c14, then increments each
  // bad-line at c58 with rc<7).
  driveTo(vic, 0x37, 53);
  expect(vic.rc === 7,
    `pre: RC=7 at L$37 c53 (end of 8-raster text row), got rc=${vic.rc}`);
  // L$37 & 7 = 7. Default YSCROLL=0, no match. Set YSCROLL=7 at c54
  // → matches → bad-line condition true at c58.
  driveTo(vic, 0x37, 54);
  vic.regs[0x11] = 0x18 | 7;              // force bad-line at c58
  // Drive past c58 so the cycle-58 evaluator runs.
  driveTo(vic, 0x37, 60);
  // At c58 of L$37: rc was 7, badLine=true → skip the kill branch,
  // increment rc to 0 (overflow).
  expect(vic.rc === 0,
    `Doubled text: RC must overflow 7→0 (bad-line saves display state), got rc=${vic.rc}`);
  expect(vic.displayActive === true,
    `Doubled text: displayActive must remain true after c58 of L$37`);
  ok('Bauer §3.14.5 Doubled text lines: bad-line at c54-57 of RC=7 line keeps display active, RC→0');
}

console.log(`\n${testNo} bad-line tricks spec tests; ${failing} fail`);
if (failing) process.exit(1);
