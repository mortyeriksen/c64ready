// vic2-rc-carryover-screenpos-spec-test.js
//
// Locks the RC (row counter) carryover behavior that the
// testprogs/VICII/screenpos "screen shifts 2 chars right" effect depends on.
//
// Spec citations:
//   - Bauer §3.7.2 rule 2: "In the first phase of cycle 14 of each line, VC
//     is loaded from VCBASE and VMLI is cleared. If there is a Bad Line
//     Condition in this phase, RC is also reset to zero." → RC is reset ONLY
//     at cycle-14 phi1 when BL holds. There is NO frame-start / display-
//     enable RC reset on real silicon.
//   - Bauer §3.7.2: "in cycle 58 ... if RC == 7 ... VCBASE is loaded from VC".
//
// Consequence (the screenpos mechanism): RC carries its value (7, left by the
// previous frame's final display row) through the idle top border. When a Bad
// Line is forced LATE — after cycle 14, before the frame's first natural bad
// line (screenpos writes $D011 mid-L50) — that late bad line does NOT reset
// RC (the cy14 sample already passed). RC is therefore still 7 at cycle 58, so
// VCBASE←VC fires there, advancing VCBASE and shifting every subsequent row
// right by 2 chars. Zeroing RC at the frame boundary suppressed the shift.

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

// Step one master cycle: vic.clock(1) (phi1) then vic.phi2(), matching
// machine.js's ordering. The cycle-58 RC=7→VCBASE←VC transition lives in
// phi2() (so it can observe same-cycle $D011 writes), so a clock()-only
// harness would never exercise it.
function step(vic) {
  vic.clock(1);
  vic.phi2();
}

function driveTo(vic, raster, cycle) {
  let safety = 312 * CYCLES_PER_LINE * 2;
  while (!(vic.raster === raster && vic.cycleInLine === cycle)) {
    step(vic);
    if (--safety <= 0) throw new Error(`drive timeout at r=${vic.raster} c=${vic.cycleInLine}`);
  }
}

// ── 1: RC is NOT reset crossing the frame boundary (raster 0) ───────────
//   With display disabled (DEN=0) there are no bad lines, so nothing should
//   touch RC. A pre-set RC=7 (the idle carryover) must survive raster 0.
{
  const vic = makeVic();
  vic.write(0x11, 0x0B);              // DEN=0 (bit4 clear), YSCROLL=3 → no bad lines anywhere
  driveTo(vic, 300, 30);
  vic.rc = 7;                          // simulate carryover from a prior display frame
  driveTo(vic, 1, 30);                 // cross raster 311→0 into the next frame
  expect(vic.rc === 7, `RC survives the raster-0 frame boundary, got ${vic.rc}`);
  ok('RC carries over the frame boundary (no frame-start reset, Bauer §3.7.2)');
}

// ── 2: RC is NOT reset at raster 0x30 (the display-enable line) ──────────
{
  const vic = makeVic();
  vic.write(0x11, 0x0B);              // DEN=0 → no bad lines
  driveTo(vic, 0x2F, 30);
  vic.rc = 7;
  driveTo(vic, 0x31, 30);              // pass raster 0x30
  expect(vic.rc === 7, `RC survives the raster-0x30 setup line, got ${vic.rc}`);
  ok('RC is not cleared at the raster-0x30 display-enable line');
}

// ── 3: screenpos mechanism — late bad line with RC=7 fires VCBASE←VC ─────
//   Idle top border (display off), RC=7 carryover, VCBASE=0. At a display-
//   range line, force a bad line AFTER cycle 14 by writing $D011 so YSCROLL
//   matches (raster & 7). The late bad line must NOT reset RC; at cycle 58
//   RC==7 → VCBASE←VC, so the next natural bad line reads a shifted VCBASE.
{
  const vic = makeVic();
  // Idle entering the display range: DEN on for completeness, YSCROLL=3 so
  // raster 50 (50&7=2) is NOT a natural bad line at cycle 14.
  vic.write(0x11, 0x1B);              // DEN=1, YSCROLL=3
  vic.write(0x16, 0xC8);
  driveTo(vic, 49, 5);
  // Force idle carryover state: no bad line has occurred yet this frame.
  vic.displayActive = false;
  vic.rc = 7;
  vic.vc = 0; vic.vcBase = 0;

  driveTo(vic, 50, 16);
  expect(vic.rc === 7, `RC still 7 entering the late-trigger window`);
  vic.write(0x11, 0x1A);              // YSCROLL=2 → (50&7=2) bad line, recognized AFTER cy14

  // The late bad line must not have reset RC.
  driveTo(vic, 50, 57);
  expect(vic.rc === 7, `late bad line at cy16 does NOT reset RC (still 7 at cy57), got ${vic.rc}`);
  const vcAt57 = vic.vc;

  driveTo(vic, 51, 1);                // crossed cy58 of L50
  expect(vic.vcBase === vcAt57,
    `cycle-58 with RC==7 loaded VCBASE←VC (=${vcAt57}), got vcBase=${vic.vcBase}`);
  expect(vic.vcBase > 0,
    `VCBASE advanced past 0 (the 2-char screenpos shift), got ${vic.vcBase}`);

  ok('late bad line with RC=7 fires VCBASE←VC at cy58 (screenpos 2-char shift)');
}

console.log(`\n${testNo - failing}/${testNo} passed${failing ? `, ${failing} FAILED` : ''}`);
if (failing) process.exit(1);
