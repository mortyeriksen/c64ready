// Bad-line RC-reset timing (Bauer §3.7.2 rule 2 / 4).
//
// Spec recap:
//   • Rule 2: "In the first phase of cycle 14 of each line, VC ←
//     VCBASE and VMLI ← 0. If there is a Bad Line Condition in this
//     phase, RC ← 0 ALSO."
//   • Rule 4: "In the first phase of cycle 58, the VIC checks if RC =
//     7. If so, idle state is entered and VCBASE ← VC. Otherwise, RC
//     ← RC + 1."
//
// CRITICAL detail: RC reset is gated to **cycle 14 phi1**. A late
// bad line that becomes true mid-line (e.g. raster $30..$F7 with
// YSCROLL flipped by a CPU $D011 write at cycle 20+) does NOT reset
// RC, even though it still queues a partial c-access fetch. This is
// the property the FppScroller diagnostic surfaced: in the FLI band,
// every raster late-triggers a bad line and the c-access fetches 14
// cols, but RC increments 0→7 across the 8-raster group rather than
// pinning at 0.
//
// This test pins both halves of the rule.

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';

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

function makeVic() {
  const v = new VIC2();
  v.currentVicBank = 0;
  v.displayEnabled = true;       // latch enabled — bad lines can fire
  return v;
}

function driveTo(vic, raster, cycle) {
  let safety = 312 * CYCLES_PER_LINE * 2;
  while (!(vic.raster === raster && vic.cycleInLine === cycle)) {
    vic.clock(1);
    vic.phi2();  // cycle-58 transition fires at phi2
    if (--safety <= 0) throw new Error(`drive timeout (at r=${vic.raster} c=${vic.cycleInLine})`);
  }
}

// ── 1: canonical bad line at cycle 14 → RC resets to 0 ────────────────
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;          // DEN=1, RSEL=1, YSCROLL=3
  // RASTER $33 = 51. (51 & 7) === 3 == YSCROLL → bad line.
  // Pre-stage RC to a non-zero value before c14.
  driveTo(vic, 0x33, 1);
  vic.rc = 5;
  driveTo(vic, 0x33, 14);
  // The cycle-14 advance runs INSIDE vic.clock for that cycle. After
  // driveTo returns at c14, that cycle's body has run. RC should now
  // be 0 because the bad-line condition was true at c14 phi1.
  expect(vic.rc === 0, `canonical c14 bad-line resets RC to 0 (got ${vic.rc})`);
  ok('canonical bad line at cycle 14 phi1: RC ← 0');
}

// ── 2: cycle-14 check sees no bad line → RC is NOT reset ──────────────
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;          // YSCROLL=3
  driveTo(vic, 0x34, 1);          // raster 52 = $34. (52 & 7) === 4 ≠ 3 → NOT bad
  vic.rc = 5;
  driveTo(vic, 0x34, 14);
  expect(vic.rc === 5, `non-bad-line c14 leaves RC unchanged (got ${vic.rc})`);
  ok('cycle 14 phi1 with no bad-line condition: RC preserved');
}

// ── 3: late bad line (BL condition set AFTER c14) does NOT reset RC ───
//      This is the FLI-band scenario. At c14 the demo's $D011 has
//      YSCROLL that doesn't match (raster & 7). Later the CPU writes
//      a new $D011 with matching YSCROLL → late bad line fires → 14-
//      col c-access runs, but RC stays at its pre-line value because
//      cycle 14 phi1 has already passed.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18;          // YSCROLL=0, DEN=1, RSEL=1
  driveTo(vic, 0x33, 1);          // raster 51 = $33. (51 & 7) === 3
  vic.rc = 5;
  driveTo(vic, 0x33, 14);
  // YSCROLL=0 at c14, raster&7=3 → NOT bad line. RC stays at 5.
  expect(vic.rc === 5, `pre-late: RC=5 unchanged at c14 (got ${vic.rc})`);
  driveTo(vic, 0x33, 20);
  // Now flip YSCROLL to 3 — bad-line cond becomes true mid-line.
  vic.regs[0x11] = 0x1B;
  driveTo(vic, 0x33, 30);
  // RC must STILL be 5: late bad lines don't trigger the cycle-14
  // reset rule.
  expect(vic.rc === 5, `late bad-line trigger leaves RC at 5 (got ${vic.rc})`);
  // And the late-bad-line fetch IS queued — confirms the bad-line
  // pathway did run, RC was just outside its reset window.
  expect(vic.lineBadLineDisplayPending === true || vic.lineMatrixFetchCol >= 0,
    `late-bad-line c-access was triggered (pending=${vic.lineBadLineDisplayPending} fetchCol=${vic.lineMatrixFetchCol})`);
  ok('late bad-line (BL set after c14): RC NOT reset (matches Bauer rule 2)');
}

// ── 4: RC increments at cycle 58 (rule 4) when rc < 7 ─────────────────
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  driveTo(vic, 0x33, 1);
  // Drive normally — at this raster, c14 bad-line resets rc to 0,
  // then c58 should increment to 1.
  driveTo(vic, 0x33, 14);
  expect(vic.rc === 0, `c14 reset → RC=0`);
  driveTo(vic, 0x33, 58);
  // rc++ happens INSIDE vic.clock(58)'s body via _advanceDisplayStateCycle58.
  expect(vic.rc === 1, `c58 advance → RC=1 (got ${vic.rc})`);
  ok('cycle-58 rule 4: RC increments when rc < 7');
}

// ── 5: RC wraps to 0 + VCBASE←VC at cycle 58 when rc === 7 ────────────
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  driveTo(vic, 0x33, 1);
  // Force RC=7 at cycle 57 — c58 should wrap and update vcBase.
  driveTo(vic, 0x33, 57);
  vic.rc = 7;
  vic.vc = 0x42;
  vic.vcBase = 0x10;
  driveTo(vic, 0x33, 58);
  expect(vic.rc === 0, `c58 with rc=7: wraps to 0 (got ${vic.rc})`);
  expect(vic.vcBase === 0x42, `c58 wrap: vcBase ← vc ($42, got $${vic.vcBase.toString(16)})`);
  ok('cycle-58 rule 4: RC wrap 7→0 also commits VCBASE ← VC');
}

// ── 6: spec-shape pin for FppScroller's FLI band — rc walks 0..7 ──────
//      In an FLI band the demo triggers late bad lines on every raster
//      WITHOUT setting BL true at c14. So:
//        Line 1 c58: rc=0→1 (entered with rc=0 from before)
//        Line 2 c58: rc=1→2
//        ...
//        Line 8 c58: rc=7→0, vcBase advance.
//      That is the OBSERVED FppScroller pattern, and a deliberate
//      consequence of rule 2 + rule 4. Pin it so a future "always
//      reset rc on bad line" change can't slip in unnoticed.
{
  const vic = makeVic();
  // Use rasters 0x31..0x37 (raster & 7 ∈ {1,2,3,4,5,6,7}) so YSCROLL=0
  // at c14 NEVER matches — every bad line is a LATE one, not a c14
  // canonical match. This is the actual property under test: across
  // 7 contiguous late-bad-line rasters, RC walks 0..6 monotonically
  // because c14 phi1 never sees a match and rule 2 never fires.
  vic.regs[0x11] = 0x18;          // YSCROLL=0
  driveTo(vic, 0x31, 1);
  vic.rc = 0;
  const expectedRc = [1, 2, 3, 4, 5, 6, 7];
  for (let i = 0; i < 7; i++) {
    const ras = 0x31 + i;
    // Make sure YSCROLL is 0 at c14 (no canonical match).
    driveTo(vic, ras, 14);
    expect(vic.rc === i, `pre-c20 raster $${ras.toString(16)}: RC=${i} (got ${vic.rc})`);
    // Late-trigger: flip YSCROLL to match (ras & 7).
    driveTo(vic, ras, 20);
    vic.regs[0x11] = 0x18 | (ras & 0x07);
    // Drive past c58 so the cycle-58 advance fires.
    driveTo(vic, ras, 59);
    expect(vic.rc === expectedRc[i],
      `post-c58 raster $${ras.toString(16)}: RC=${expectedRc[i]} (got ${vic.rc})`);
    // Restore YSCROLL=0 BEFORE this raster ends so the next raster's
    // c14 sees no match.
    vic.regs[0x11] = 0x18;
  }
  ok('FLI band (7 late-bad-line rasters): RC walks 1..7 without c14 reset');
}

console.log(`\n${testNo - failing}/${testNo} passed${failing ? `, ${failing} FAILED` : ''}`);
if (failing) process.exit(1);
