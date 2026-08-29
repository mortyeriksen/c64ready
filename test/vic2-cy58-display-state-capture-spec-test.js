// Cycle-58 display-state capture order spec test.
//
// Bauer §3.7.2 rule 5: "The transition from display to idle state
// occurs in cycle 58 of a line if the RC contains the value 7 and
// there is no Bad Line Condition."
//
// In our master-cycle ordering (vic.clock=phi1 → cpu.clock=phi2 →
// vic.phi2), the cycle-58 transition fires in vic.phi2() — see
// `cycle58-live-badline-sampling-spec-test.js` for why this matches
// real-hardware FLI demos (CPU c57 phi2 STA $D011 must be visible
// to the c58 BL sample).
//
// Capture invariant for `lineCycleDisplayActive[58]` / `lineCycleRc[58]`:
// These arrays are populated by `_captureCycleState()` at phi1 of
// cycle 58, BEFORE the transition fires. They therefore reflect the
// PRE-transition state — which is correct: cycle 58's PIXELS are
// output using the pre-transition state (the renderer uses these
// captured values), and the transition affects cycles 59+.
//
// LIVE `vic.displayActive` / `vic.rc` after the master cycle reflect
// POST-transition state (since they're updated at phi2).

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';

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

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0;
  return vic;
}

// Drive full master cycles so vic.phi2() runs each cycle (= cycle-58
// transition fires, per the new master-cycle ordering).
function driveTo(vic, raster, cycle) {
  let safety = 312 * CYCLES_PER_LINE * 4;
  while (--safety && !(vic.raster === raster && vic.cycleInLine === cycle)) {
    vic.clock(1);
    vic.phi2();
  }
  if (safety <= 0) throw new Error(`drive timeout at L${vic.raster} c${vic.cycleInLine}`);
}

// ─── Test 1: cycle-58 transition (RC=7 + not bad line) → captured PRE-transition
//
// Scenario: YSCROLL=3 (bad lines at L51, L59, ...). Drive into display
// state at L51 (= bad line entry). Then drive RC through 0..7 by running
// through L51..L58. At L58 cy 58, RC=7 AND L58 is NOT a bad line (= L58
// & 7 == 2, not YS=3). Transition fires at c58 phi2.
//
// Captured arrays (phi1): displayActive=1, rc=7 (PRE-transition — cycle
// 58 pixels output as display-state using these values).
// Live vic state (post-phi2): displayActive=0, rc=7 (no increment since
// display went idle).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;             // DEN=1, RSEL=1, YS=3
  vic.regs[0x16] = 0x08;             // CSEL=1
  vic.displayEnabled = true;

  // Drive past L48 c14 (= displayEnabled latch already true from init).
  driveTo(vic, 51, 14);              // L51 c14: bad line condition fires, displayActive→true, RC→0
  expect(vic.displayActive === true,
    `L51 c14 (bad line): displayActive must be true`);
  expect(vic.rc === 0,
    `L51 c14 (bad line): RC must reset to 0, got ${vic.rc}`);

  // Drive across L51..L58 cycle 58 to increment RC each line.
  driveTo(vic, 52, 0);               // past L51 c58 → RC=1
  expect(vic.rc === 1, `after L51 c58: RC=1, got ${vic.rc}`);

  driveTo(vic, 58, 0);               // past L57 c58 → RC=7 (L51 + 7 advances)
  expect(vic.rc === 7, `after L57 c58: RC=7, got ${vic.rc}`);

  // Now drive through L58 c58 (= the transition point). L58 is NOT a
  // bad line (58 & 7 = 2, not 3). RC=7 + not bad → idle. displayActive
  // must clear.
  expect(vic.displayActive === true,
    `L58 pre-c58: displayActive still true`);
  driveTo(vic, 58, 58);              // process L58 c58 (phi1+phi2)
  // Live vic state reflects POST-transition (phi2 ran).
  expect(vic.displayActive === false,
    `L58 c58 (RC=7 + not bad line): live displayActive must clear per Bauer §3.7.2 r5, got ${vic.displayActive}`);
  // Captured arrays reflect PRE-transition state (cycle 58 pixels output
  // as display-state). The transition fires at phi2; capture is at phi1.
  expect(vic.lineCycleDisplayActive[58] === 1,
    `lineCycleDisplayActive[58] = PRE-transition (= 1, cycle 58 pixels output as display-state), got ${vic.lineCycleDisplayActive[58]}`);
  expect(vic.lineCycleRc[58] === 7,
    `lineCycleRc[58] = 7 (PRE-transition; rc not yet decided to stay/clear), got ${vic.lineCycleRc[58]}`);
  ok('Bauer §3.7.2 r5: cycle-58 capture is PRE-transition; live state is POST-transition');
}

// ─── Test 2: cycle 58 with RC=7 AND bad line → display stays + RC increments
//
// L59 (bad line for YS=3): RC=7 → check rule. Bad line → display STAYS.
// Then RC increments to 0 (next char row).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.displayEnabled = true;
  driveTo(vic, 51, 14);
  expect(vic.displayActive === true, `pre L51 c14: display true`);
  // Drive to L59 c57 (last cycle before c58). RC should be 7 here
  // (L51 + 8 lines = L59, but L59 is bad line which resets RC at c14
  // to 0 BEFORE c58 runs).
  driveTo(vic, 59, 57);
  expect(vic.rc === 0,
    `L59 c14 reset RC for bad-line entry; expect 0, got ${vic.rc}`);
  // Drive to L59 c58.
  driveTo(vic, 59, 58);
  // L59 is bad line, but RC=0 not 7 (was just reset). So cycle-58
  // transition doesn't fire (RC != 7 check). Display stays true, RC→1.
  expect(vic.displayActive === true,
    `L59 c58: bad line + RC=0 (post-reset) → display stays true`);
  expect(vic.lineCycleDisplayActive[58] === 1,
    `L59 c58 capture: displayActive=1 (in display state)`);
  expect(vic.rc === 1, `L59 c58: RC increments to 1, got ${vic.rc}`);
  ok('Bauer §3.7.2 r6: cycle 58 with RC=0 (no transition) → captured displayActive=1, RC increments');
}

// ─── Test 3: cycle-58 capture order — capture is PRE-transition (phi1)
//
// Canonical test: force displayActive=true, RC=7, drive to a non-bad
// cy 58. Verify lineCycleDisplayActive[58] = 1 (PRE-transition value
// captured at phi1, before the transition fires at phi2). Live state
// AFTER vic.phi2() reflects POST-transition (= 0).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.displayEnabled = true;

  // Hijack to controlled state: at L58 c57, force displayActive=true,
  // RC=7. Then drive one cycle to process c58 phi1+phi2.
  driveTo(vic, 58, 57);
  vic.displayActive = true;
  vic.rc = 7;
  vic.clock(1);                       // c58 phi1 (capture)
  vic.phi2();                         // c58 phi2 (transition)

  expect(vic.cycleInLine === 58 || vic.cycleInLine === 59,
    `after master cycle: at c58 or just past; got c${vic.cycleInLine}`);
  expect(vic.displayActive === false,
    `live displayActive after c58 transition (RC=7 + not bad): false; got ${vic.displayActive}`);
  expect(vic.lineCycleDisplayActive[58] === 1,
    `captured lineCycleDisplayActive[58] = PRE-transition (= 1). ` +
    `_captureCycleState runs at phi1, BEFORE _advanceDisplayStateCycle58 at phi2. ` +
    `Cycle 58 pixels are output using pre-transition state. Got ${vic.lineCycleDisplayActive[58]}.`);
  ok('Bauer §3.7.2 r5: lineCycleDisplayActive[58] captured BEFORE cycle-58 transition (phi1 = pixel output)');
}

console.log(`\n${testNo} cycle-58 display-state capture spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
