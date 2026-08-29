// vic2-cy58-write-no-spurious-badline-spec-test.js
//
// A CPU $D011 YSCROLL write that lands at CYCLE 58 must NOT make that line a
// bad line. Bauer §3.7.2 rule 5 ("first phase of cycle 58") samples the bad-
// line condition at PHI1 — BEFORE the CPU's phi2 write of the same cycle (the
// VIC acts before the CPU on cycle 58: bumbershootsoft "VIC-II interrupt
// timing"; see machine.js master-cycle ordering vic.clock → cpu.clock →
// vic.phi2). So:
//
//   • The rule-5/6 idle decision + RC increment use the PHI1 value: with
//     RC==7 and no phi1 bad line, the line goes idle and RC is NOT incremented.
//   • The same-cycle write then creates a bad-line condition, and §3.7.1
//     ("idle → display as soon as there is a Bad Line Condition") reactivates
//     display — WITHOUT a further RC increment. The bars keep rendering, RC
//     stays frozen.
//
// This is exactly raster_time_gp's bottom-border behaviour: on IRQ-jitter
// frames the per-line YSCROLL write lands at cy58 instead of cy59. The OLD
// phi2-live sample wrongly counted the cy58 write as a bad line, incrementing
// RC → the row counter started cycling → 2 extra display lines + a garbled
// bottom line. The fix (cycle58BadLinePhi1, default on) restores the phi1
// sample so RC stays frozen.
//
// Paired control: identical drive but the write lands at cy59 (the non-jitter
// frame) — the cy58 idle transition already ran with no bad line, then the
// cy59 write reactivates via the $D011 write hook. Both arms must end with
// RC frozen at 7 and display active.

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

// One full master cycle of a VIC-only harness: clock (phi1) then phi2. A
// $D011 write injected BETWEEN them models a CPU phi2 write of that cycle.
function step(v) { v.clock(1); v.phi2(); }
function driveTo(v, raster, cycle) {
  let safety = 312 * CYCLES_PER_LINE * 2;
  while (!(v.raster === raster && v.cycleInLine === cycle)) {
    step(v);
    if (--safety <= 0) throw new Error(`drive timeout r=${v.raster} c=${v.cycleInLine}`);
  }
}

// Raster 100, 100&7 = 4. YSCROLL=3 (0x1B) ⇒ no bad line; YSCROLL=4 (0x1C) ⇒
// bad line. We arrive at cy57 in display state with RC=7 and no bad line, then
// flip YSCROLL to the matching value at a chosen cycle (58 = jitter, 59 =
// normal) by injecting the write between that cycle's clock() and phi2().
function arriveAtCy57Idle(v) {
  v.write(0x16, 0xC8);
  v.write(0x11, 0x1B);                 // DEN=1, RSEL=1, YSCROLL=3 (no BL on L100)
  v.displayEnabled = true;
  driveTo(v, 100, 57);
  v.displayActive = true;
  v.rc = 7; v.vc = 40; v.vcBase = 0;
  v.lineMatrixFetchCol = -1;
  v.lineBadLineDisplayPending = false;
  v.lineBadLineStartCycle = -1;
}

// ── Test 1: write lands at CYCLE 58 → no spurious bad line, display reactivates
{
  const v = makeVic();
  arriveAtCy57Idle(v);
  v.clock(1);                          // → cy58 (phi1 sample taken: no bad line)
  expect(v.cycleInLine === 58, `at cy58 (got ${v.cycleInLine})`);
  v.write(0x11, 0x1C);                 // cy58 phi2 CPU write: YSCROLL=4 matches 100&7
  v.phi2();                            // rule-5/6 (phi1) + §3.7.1 reactivation
  expect(v.rc === 7,
    `cy58 write must NOT increment RC — phi1 had no bad line (got rc=${v.rc})`);
  expect(v.displayActive === true,
    `§3.7.1: same-cycle bad-line write reactivates display (got da=${v.displayActive})`);
  ok('cy58 $D011 YSCROLL write: RC frozen at 7 (no spurious bad line) + display reactivated');
}

// ── Test 2 (control): write lands at CYCLE 59 → also RC frozen, display active
{
  const v = makeVic();
  arriveAtCy57Idle(v);
  v.clock(1);                          // → cy58 (no bad line at phi1)
  v.phi2();                            // cy58 transition: rc=7 + no BL → idle, RC held
  expect(v.rc === 7 && v.displayActive === false,
    `cy58 with no write → idle, RC held (rc=${v.rc} da=${v.displayActive})`);
  v.clock(1);                          // → cy59
  v.write(0x11, 0x1C);                 // cy59 phi2 write: YSCROLL match
  v.phi2();                            // $D011 write hook (cy59-62) reactivates display
  expect(v.rc === 7,
    `cy59 write must not touch RC (got rc=${v.rc})`);
  expect(v.displayActive === true,
    `cy59 YSCROLL write reactivates display (got da=${v.displayActive})`);
  ok('cy59 $D011 YSCROLL write (control): RC frozen at 7 + display reactivated');
}

// ── Test 3: legacy phi2-live model (flag off) DOES trip the spurious bad line
// Documents the bug the fix removes: with cycle58BadLinePhi1=false the cy58
// write is counted as a bad line and RC increments 7→0.
{
  const v = makeVic();
  v.cycle58BadLinePhi1 = false;
  arriveAtCy57Idle(v);
  v.clock(1);                          // → cy58
  v.write(0x11, 0x1C);                 // cy58 write
  v.phi2();                            // legacy: live (post-write) sample sees the BL
  expect(v.rc === 0,
    `legacy phi2-live: cy58 write trips bad line, RC 7→0 (got rc=${v.rc})`);
  ok('legacy model (flag off) reproduces the spurious cy58 bad line — RC 7→0');
}

console.log(`\n${testNo - failing}/${testNo} passed${failing ? `, ${failing} FAILED` : ''}`);
if (failing) process.exit(1);
