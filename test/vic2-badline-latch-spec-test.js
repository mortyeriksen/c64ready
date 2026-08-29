// badline-latch-spec-test.js
//
// Spec-derived bad-line latch coverage. Does NOT load nine.prg or
// orbituntold.prg — drives the VIC directly via `clock(1)` with
// synthetic register state.
//
// Bauer §3.5 "Bad Lines":
//   "A Bad Line Condition can only occur if the DEN bit has been set
//    for at least one cycle somewhere in raster line $30 (see section
//    3.5.)."
//   "A Bad Line Condition is given at any arbitrary clock cycle if at
//    the negative edge of φ0 at the beginning of the cycle RASTER >=
//    $30 and RASTER <= $f7 and the lower three bits of RASTER are
//    equal to YSCROLL and if the DEN bit was set during an arbitrary
//    cycle of raster line $30."
//
// Derived rules (do NOT consult vic2.js for these — read spec only):
//   R1. Rasters 0..47 ($00..$2F): NEVER bad lines (raster < $30).
//   R2. Rasters 248..311 ($F8..$137): NEVER bad lines (raster > $F7).
//   R3. Within $30..$F7: bad line iff (raster & 7) == yscroll AND
//       displayEnabled latched (DEN seen during raster $30).
//   R4. If DEN is 0 throughout raster $30, displayEnabled latches
//       FALSE → NO bad lines fire for the rest of the frame.
//   R5. If DEN is 1 for any cycle of raster $30, displayEnabled
//       latches TRUE → bad lines fire on YSCROLL-match rasters.
//   R6. Clearing DEN AFTER raster $30 does NOT immediately suppress
//       bad lines (latch is only re-sampled at next frame's $30).
//
// The user-visible relevance: Nine's "side border opening on bad
// lines" question — does our impl agree with spec on WHICH rasters
// fire bad lines? The §3.14.1 cycle-56 trick is spec-blocked on
// (bad-line + sprite) rasters per the trace-screen-to-topborder-ba
// trace's TRACE 7. So a test that pins the bad-line set per spec
// is load-bearing for diagnosing trick-line collisions.

import { VIC2, CYCLES_PER_LINE, LINES_PER_FRAME } from '../src/vic2.js';

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

// Drive to start of raster R (cycleInLine === 1) without depending on
// the test under analysis. Resets displayEnabled latch state ONLY at
// the explicit raster-$30 sample window — same as hardware.
function driveToRaster(vic, targetRaster) {
  let safety = LINES_PER_FRAME * CYCLES_PER_LINE * 2;
  while (!(vic.raster === targetRaster && vic.cycleInLine === 1)) {
    vic.clock(1);
    if (--safety <= 0) throw new Error('drive timeout');
  }
}

// Spec-derived predicate. Does NOT call vic._isBadLine — re-derives
// from inputs so the test asserts the spec rule, not the impl rule.
function specIsBadLine({ displayEnabled, raster, yscroll }) {
  if (!displayEnabled) return false;        // R4
  if (raster < 0x30 || raster > 0xF7) return false; // R1, R2
  return (raster & 0x07) === yscroll;       // R3
}

// ─── Rule R1: rasters 0..47 are NEVER bad lines ──────────────────────────
// Spec: "if RASTER >= $30" — strict lower bound. Below $30 the bad-line
// condition is inactive regardless of DEN, YSCROLL, or any other state.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;        // DEN=1, RSEL=1, YSCROLL=3
  for (let r = 0; r < 0x30; r++) {
    driveToRaster(vic, r);
    const bad = vic._isBadLine(r, vic.regs);
    const spec = specIsBadLine({ displayEnabled: vic.displayEnabled, raster: r, yscroll: 3 });
    expect(spec === false, `spec sanity: raster $${r.toString(16)} < $30 must be non-bad`);
    expect(bad === false,
      `R1: raster ${r} ($${r.toString(16)}) must not be a bad line (< $30)`);
  }
  ok('R1: rasters 0..47 ($00..$2F) are never bad lines (Bauer §3.5)');
}

// ─── Rule R2: rasters 248..311 are NEVER bad lines ───────────────────────
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  // Drive past raster $30 with DEN=1 to latch displayEnabled true, so
  // we're testing the upper-bound pure ($F7) rule, not DEN.
  driveToRaster(vic, 0x30);
  expect(vic.displayEnabled === true, 'pre-condition: DEN latched at raster $30');
  for (let r = 0xF8; r < LINES_PER_FRAME; r++) {
    driveToRaster(vic, r);
    const bad = vic._isBadLine(r, vic.regs);
    expect(bad === false,
      `R2: raster ${r} ($${r.toString(16)}) must not be a bad line (> $F7)`);
  }
  ok('R2: rasters 248..311 ($F8..) are never bad lines (Bauer §3.5)');
}

// ─── Rule R3: within $30..$F7, bad line iff (raster & 7) == YSCROLL ──────
//
// This is the core spec rule. For yscroll=0..7, exactly ONE in every 8
// rasters in $30..$F7 fires. Total per yscroll = (247-48+1)/8 = 25 lines.
for (let ys = 0; ys < 8; ys++) {
  const vic = makeVic();
  vic.regs[0x11] = (1 << 4) | (1 << 3) | ys;   // DEN=1, RSEL=1, YSCROLL=ys
  driveToRaster(vic, 0x30);
  expect(vic.displayEnabled === true,
    `pre: DEN latched for ys=${ys}`);

  // Sample every raster in $30..$F7 and tally matches.
  let matches = 0, mismatches = [];
  for (let r = 0x30; r <= 0xF7; r++) {
    driveToRaster(vic, r);
    const bad = vic._isBadLine(r, vic.regs);
    const spec = specIsBadLine({ displayEnabled: true, raster: r, yscroll: ys });
    if (bad !== spec) mismatches.push({ r, bad, spec });
    if (spec) matches++;
  }
  expect(matches === 25,
    `R3 spec check: yscroll=${ys} expects 25 bad lines in $30..$F7, derived ${matches}`);
  expect(mismatches.length === 0,
    `R3 impl: yscroll=${ys} ${mismatches.length} mismatches: ${mismatches.slice(0,3).map(m => `r${m.r}(spec=${m.spec},impl=${m.bad})`).join(',')}`);
  ok(`R3: YSCROLL=${ys} fires bad lines on (raster & 7) == ${ys} within $30..$F7 (25 lines)`);
}

// ─── Rule R4: DEN=0 throughout raster $30 → displayEnabled stays false ───
{
  const vic = makeVic();
  vic.regs[0x11] = 0x0B;        // DEN=0, RSEL=1, YSCROLL=3
  // Drive through raster $30 with DEN=0.
  driveToRaster(vic, 0x30);
  expect(vic.displayEnabled === false, 'raster $30 cycle 1: displayEnabled=false (DEN=0)');
  for (let i = 0; i < CYCLES_PER_LINE; i++) vic.clock(1);
  expect(vic.displayEnabled === false, 'raster $30 end: displayEnabled still false');

  // Now sweep the rest of the frame. NO raster should be a bad line.
  let badLinesObserved = 0;
  for (let r = 0x31; r <= 0xF7; r++) {
    driveToRaster(vic, r);
    if (vic._isBadLine(r, vic.regs)) badLinesObserved++;
  }
  expect(badLinesObserved === 0,
    `R4: DEN=0 at $30 latch → no bad lines this frame, observed ${badLinesObserved}`);
  ok('R4: DEN=0 throughout raster $30 suppresses all bad lines for the frame');
}

// ─── Rule R5: DEN=1 set DURING raster $30 latches displayEnabled true ────
//
// Set DEN=0 at the start of raster $30, then set DEN=1 mid-line
// (before raster $30 ends). The latch must fire — Bauer §3.5 says
// "DEN bit was set during an arbitrary cycle of raster line $30".
{
  const vic = makeVic();
  vic.regs[0x11] = 0x0B;        // DEN=0
  driveToRaster(vic, 0x30);
  expect(vic.displayEnabled === false, 'pre: DEN=0 at $30 cycle 1');
  // Walk to cycle 30 of raster $30 with DEN still 0.
  while (!(vic.raster === 0x30 && vic.cycleInLine === 30)) vic.clock(1);
  expect(vic.displayEnabled === false, 'mid-line: still false');
  // CPU phi2 sets DEN=1 mid-line.
  vic.regs[0x11] = 0x1B;
  vic.clock(1); // next vic tick observes DEN=1 inside raster $30
  expect(vic.displayEnabled === true,
    'R5: DEN=1 mid-raster-$30 must latch displayEnabled');

  // Verify bad lines now fire on YSCROLL-match within range.
  let badFired = 0;
  for (let r = 0x31; r <= 0xF7; r++) {
    driveToRaster(vic, r);
    if (vic._isBadLine(r, vic.regs)) badFired++;
  }
  // 25 lines per yscroll, but we've already passed $30 itself; from
  // $31..$F7 the yscroll=3 matches are: $33, $3B, ... , $F3, $FB? No,
  // $FB > $F7. Last is $F3. From $33 stepping by 8: 25 - 1 = 24 lines
  // remaining (we passed $33 only if it had been visited; $30 itself
  // is not a yscroll=3 match since 0x30&7=0, not 3).
  // Actual range $31..$F7 yscroll=3: rasters where (r&7)==3.
  let specRemaining = 0;
  for (let r = 0x31; r <= 0xF7; r++) if ((r & 7) === 3) specRemaining++;
  expect(badFired === specRemaining,
    `R5: YSCROLL=3 latched, expect ${specRemaining} bad lines in $31..$F7, got ${badFired}`);
  ok('R5: DEN=1 anywhere in raster $30 latches displayEnabled — bad lines fire');
}

// ─── Rule R6: clearing DEN after $30 does NOT suppress this-frame bad lines ─
//
// Bauer §3.5 + the impl comment at vic2.js:1683-1686. The latch is
// sampled ONLY at raster $30. CPU writes that clear DEN later in the
// frame don't reset the latch.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;        // DEN=1
  driveToRaster(vic, 0x30);
  expect(vic.displayEnabled === true, 'pre: latched true at $30');

  // Drive to raster $50 (mid-display) and clear DEN.
  driveToRaster(vic, 0x50);
  vic.regs[0x11] = 0x0B;        // DEN=0 mid-frame
  vic.clock(1);
  // Latch must persist.
  expect(vic.displayEnabled === true,
    'R6: DEN cleared at raster $50 must NOT clear displayEnabled latch');

  // Bad lines should still fire for the rest of the frame.
  let badAfter = 0;
  for (let r = 0x51; r <= 0xF7; r++) {
    driveToRaster(vic, r);
    if (vic._isBadLine(r, vic.regs)) badAfter++;
  }
  let specAfter = 0;
  for (let r = 0x51; r <= 0xF7; r++) if ((r & 7) === 3) specAfter++;
  expect(badAfter === specAfter,
    `R6: bad lines persist after mid-frame DEN clear, want ${specAfter} got ${badAfter}`);
  ok('R6: clearing DEN mid-frame does NOT suppress bad lines until next $30 sample');
}

// ─── Screen → top-border transition matrix ────────────────────────────────
//
// Concrete Nine-relevant scan: enumerate every (yscroll, raster) pair
// across rasters 0..60 (the full screen→top-border zone for RSEL=1)
// and assert the spec verdict equals the impl verdict.
//
// Why this matters for the user's bug: if our `_isBadLine` decision
// disagrees with spec on EVEN ONE raster in this band, the §3.14.1
// trick analysis (TRACE 7) is wrong and the demo's trick-line
// alignment cannot be diagnosed. This is the load-bearing test.
{
  let mismatches = [];
  for (let ys = 0; ys < 8; ys++) {
    const vic = makeVic();
    vic.regs[0x11] = 0x18 | ys; // DEN=1, RSEL=1, YSCROLL=ys
    driveToRaster(vic, 0x30);   // latch
    for (let r = 0; r <= 60; r++) {
      driveToRaster(vic, r);
      const impl = vic._isBadLine(r, vic.regs);
      const spec = specIsBadLine({ displayEnabled: true, raster: r, yscroll: ys });
      if (impl !== spec) mismatches.push({ ys, r, impl, spec });
    }
  }
  expect(mismatches.length === 0,
    `screen→top-border matrix: ${mismatches.length} mismatches: ${
      mismatches.slice(0, 5).map(m => `ys=${m.ys},r=${m.r}(spec=${m.spec},impl=${m.impl})`).join(' | ')
    }`);
  ok('screen→top-border matrix: every (yscroll, raster 0..60) bad-line decision matches spec');
}

// ─── Rasters 48..50 sanity (the screen→top-border boundary zone) ─────────
//
// Specific to Nine's question: rasters 48, 49, 50 are in the top-border
// zone for RSEL=1 (top-compare = 51) but are >= $30, so they ARE
// candidate bad lines. Verify:
//   raster $30 (=48): bad iff yscroll == 0
//   raster $31 (=49): bad iff yscroll == 1
//   raster $32 (=50): bad iff yscroll == 2
//   raster $33 (=51): bad iff yscroll == 3 — first display line, RSEL=1
//
// This is the cycle-56-trick collision zone Nine cares about.
for (const targetRaster of [0x30, 0x31, 0x32, 0x33]) {
  const matchYs = targetRaster & 7;
  const vic = makeVic();
  vic.regs[0x11] = 0x18 | matchYs;     // YSCROLL = match
  driveToRaster(vic, 0x30);
  driveToRaster(vic, targetRaster);
  expect(vic._isBadLine(targetRaster, vic.regs) === true,
    `raster $${targetRaster.toString(16)} with yscroll=${matchYs}: must be bad line`);

  // Adjacent yscroll values must NOT fire.
  for (const otherYs of [0, 1, 2, 3, 4, 5, 6, 7]) {
    if (otherYs === matchYs) continue;
    const vic2 = makeVic();
    vic2.regs[0x11] = 0x18 | otherYs;
    driveToRaster(vic2, 0x30);
    driveToRaster(vic2, targetRaster);
    expect(vic2._isBadLine(targetRaster, vic2.regs) === false,
      `raster $${targetRaster.toString(16)} with yscroll=${otherYs} (no match): must NOT be bad`);
  }
  ok(`top-border boundary raster $${targetRaster.toString(16)} bad-line decision matches spec for all 8 YSCROLL values`);
}

// ─── R7: latch is RE-SAMPLED each frame at raster $30 ────────────────────
//
// Bauer §3.5: the latch sample happens "at an arbitrary cycle of raster
// line $30". Implication: the latch is per-frame; clearing DEN before
// the NEXT frame's $30 produces NO bad lines that frame even if the
// previous frame had bad lines. Conversely, setting DEN before $30 of
// a fresh frame re-enables bad lines.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;        // DEN=1, YSCROLL=3
  driveToRaster(vic, 0x30);
  expect(vic.displayEnabled === true, 'frame 1: latched true');

  // Drive past frame end. Before next frame's $30, clear DEN.
  driveToRaster(vic, 0);        // frame 2 raster 0
  vic.regs[0x11] = 0x0B;        // DEN=0
  driveToRaster(vic, 0x30);     // frame 2 latch sample
  expect(vic.displayEnabled === false,
    'R7: frame 2 latch must re-sample DEN=0 → displayEnabled false');

  // No bad lines for the rest of frame 2.
  let bad2 = 0;
  for (let r = 0x31; r <= 0xF7; r++) {
    driveToRaster(vic, r);
    if (vic._isBadLine(r, vic.regs)) bad2++;
  }
  expect(bad2 === 0, `R7: frame 2 with DEN=0 at $30 must produce no bad lines, got ${bad2}`);

  // Re-enable DEN before frame 3's $30.
  driveToRaster(vic, 0);        // frame 3 raster 0
  vic.regs[0x11] = 0x1B;
  driveToRaster(vic, 0x30);
  expect(vic.displayEnabled === true,
    'R7: frame 3 latch re-samples DEN=1 → displayEnabled true');
  ok('R7: latch is per-frame — re-samples DEN at each frame\'s raster $30');
}

// ─── R8: single-cycle DEN=1 pulse anywhere in raster $30 latches true ────
//
// Bauer says "DEN bit was set during an arbitrary cycle of raster line
// $30". A 1-cycle DEN=1 pulse at any cycle of $30 must be enough. We
// verify cycles 5..63 by walking to (cycle-1), pulsing DEN at the tick
// that observes cycle. Cycle 1 is special: the impl resets and then
// re-checks DEN within the same tick, so DEN must be high BEFORE that
// tick — drive to ($2F end) with DEN=1 then enter $30.
for (const pulseCycle of [5, 15, 30, 45, 55, 63]) {
  const vic = makeVic();
  vic.regs[0x11] = 0x0B;        // DEN=0
  driveToRaster(vic, 0x30);
  expect(vic.displayEnabled === false, `pre c${pulseCycle}: false at $30 cycle 1`);

  while (vic.cycleInLine !== pulseCycle - 1) vic.clock(1);
  vic.regs[0x11] = 0x1B;        // DEN=1 pulse
  vic.clock(1);                  // VIC tick observes DEN=1
  vic.regs[0x11] = 0x0B;         // CPU clears DEN immediately

  expect(vic.displayEnabled === true,
    `R8: pulseCycle=${pulseCycle}, DEN=1 latch must fire even with single-cycle pulse`);
  driveToRaster(vic, 0x33);
  expect(vic._isBadLine(0x33, vic.regs) === true,
    `R8: pulseCycle=${pulseCycle}, raster $33 must be a bad line after pulse`);
  ok(`R8: single-cycle DEN=1 pulse at raster $30 cycle ${pulseCycle} latches displayEnabled`);
}

// R8 — cycle 1 case: DEN must be high BEFORE entry to raster $30 c1
// because the cycle-1 tick atomically resets-then-checks. Verify the
// same latch happens for the cycle-1 path.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x0B;        // DEN=0
  // Drive almost to $30 (drive to raster 0x2F first).
  driveToRaster(vic, 0x2F);
  // Walk to end of $2F so the next tick enters $30 c1.
  while (vic.cycleInLine !== CYCLES_PER_LINE - 1) vic.clock(1);
  vic.regs[0x11] = 0x1B;        // DEN=1 just before $30 c1
  vic.clock(1);                  // last tick of $2F (c63 → reset to c0+raster++)
  vic.clock(1);                  // first tick of $30 (c1) — latch observes DEN=1
  expect(vic.raster === 0x30 && vic.cycleInLine === 1,
    `cycle-1 case setup: at $30 c1, got r=${vic.raster} c=${vic.cycleInLine}`);
  expect(vic.displayEnabled === true,
    'R8 cycle-1 case: DEN=1 entering $30 c1 must latch (atomic reset-then-set)');
  ok('R8: DEN=1 latched on cycle-1 entry to raster $30 (atomic reset-then-set behavior)');
}

// ─── R9: YSCROLL is sampled LIVE (not latched) ──────────────────────────
//
// Bauer §3.5: YSCROLL is read from $D011 LIVE on each comparison cycle.
// CPU writes that change YSCROLL mid-frame change WHICH rasters fire
// bad lines from that point onward. Verify by changing YSCROLL between
// two raster checks.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18 | 3;    // DEN=1, RSEL=1, YSCROLL=3
  driveToRaster(vic, 0x30);
  expect(vic.displayEnabled === true, 'pre: latched true');

  // At raster 0x33 (yscroll=3 match), bad line.
  driveToRaster(vic, 0x33);
  expect(vic._isBadLine(0x33, vic.regs) === true, 'r$33 with ys=3: bad');

  // Change YSCROLL to 5 between rasters $34 and $35.
  driveToRaster(vic, 0x34);
  vic.regs[0x11] = 0x18 | 5;    // YSCROLL=5
  // Now at raster $35, (0x35 & 7) = 5 — NEW yscroll match.
  driveToRaster(vic, 0x35);
  expect(vic._isBadLine(0x35, vic.regs) === true,
    'R9: r$35 with new YSCROLL=5 must be a bad line (live YSCROLL sample)');
  expect(vic._isBadLine(0x33, vic.regs) === false,
    'R9: r$33 retroactively no longer matches new YSCROLL=5 (consistent with live read)');
  ok('R9: YSCROLL is sampled live — mid-frame changes shift bad-line cadence');
}

// ─── R10: edge rasters $30 and $F7 ───────────────────────────────────────
//
// Spec range is inclusive: raster $30 is first valid bad-line candidate,
// raster $F7 is last. Verify both edges fire when YSCROLL matches.
{
  for (const [r, ys] of [[0x30, 0], [0xF7, 7]]) {
    const vic = makeVic();
    vic.regs[0x11] = 0x18 | ys;
    driveToRaster(vic, 0x30);
    expect(vic.displayEnabled === true, `pre edge r$${r.toString(16)}: latched`);
    driveToRaster(vic, r);
    expect(vic._isBadLine(r, vic.regs) === true,
      `R10: edge raster $${r.toString(16)} with matching ys=${ys} must be bad line`);
  }
  // And one cycle outside each edge: $2F (= 47, < $30) and $F8 (> $F7).
  for (const [r, ys] of [[0x2F, 7], [0xF8, 0]]) {
    const vic = makeVic();
    vic.regs[0x11] = 0x18 | ys;
    driveToRaster(vic, 0x30);
    if (r > 0x30) driveToRaster(vic, r);
    // Note: r=$2F is BEFORE $30, so we can't drive forward to it within
    // the same frame. Just probe the predicate directly.
    expect(vic._isBadLine(r, vic.regs) === false,
      `R10: edge-outside raster $${r.toString(16)} must NOT be bad line`);
  }
  ok('R10: edge rasters $30 (lower) and $F7 (upper) are inclusive bad-line bounds');
}

// ─── R11: bad-line BA-low cycles 12..54 (Bauer §3.6.1) ───────────────────
//
// On a bad-line raster, BA goes low at cycle 12 (3 cycles before c-access
// at 15) and stays low through cycle 54 (last c-access). Verify our
// `_isBadLineBaLow(c)` predicate matches spec.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18 | 3;
  driveToRaster(vic, 0x30);
  driveToRaster(vic, 0x33);     // yscroll=3 → bad line

  // Drive into the bad line so the matrix-fetch state is live.
  while (vic.cycleInLine !== 14) vic.clock(1);
  // From cycle 15 the matrix fetch is active; sample BA at every cycle.
  // Walk back: probe the impl predicate for c=1..63.
  for (let c = 1; c <= 63; c++) {
    const expected = (c >= 12 && c <= 54);
    const got = vic._isBadLineBaLow(c);
    expect(got === expected,
      `R11: bad-line BA-low at c=${c}: spec=${expected} got=${got}`);
  }
  ok('R11: bad-line BA-low spans cycles 12..54 (Bauer §3.6.1)');
}

// ─── R12: NON-bad-line raster has no bad-line BA-low ─────────────────────
//
// At a raster where (raster & 7) != yscroll, no bad line → no BA-low
// from the bad-line source. (Sprite BA is independent.)
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18 | 3;
  driveToRaster(vic, 0x30);
  driveToRaster(vic, 0x34);     // (0x34 & 7) = 4, NOT match
  expect(vic._isBadLine(0x34, vic.regs) === false, 'pre: r$34 not a bad line');

  // BA from bad-line source must be high all line.
  for (let c = 1; c <= 63; c++) {
    expect(vic._isBadLineBaLow(c) === false,
      `R12: non-bad raster c=${c} must NOT show bad-line BA-low`);
  }
  ok('R12: non-bad raster has no bad-line BA-low contribution at any cycle');
}

// ─── R13: bad-line condition can be CREATED mid-line via YSCROLL write ──
//
// Bauer §3.5: "It is even possible to start the Bad Line Condition
// multiple times within an arbitrary raster line in the range of
// $30-$f7 by modifying YSCROLL". A late YSCROLL change can fire a
// fresh bad line on the same raster. Verify the predicate registers
// the new condition immediately on regs change (it's pure-of-state).
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18 | 5;    // YSCROLL=5, raster $33 (& 7 = 3) NOT match
  driveToRaster(vic, 0x30);
  driveToRaster(vic, 0x33);
  expect(vic._isBadLine(0x33, vic.regs) === false,
    'pre: r$33 with ys=5 is not a bad line');
  // Walk to mid-line, change YSCROLL.
  while (vic.cycleInLine !== 25) vic.clock(1);
  vic.regs[0x11] = 0x18 | 3;    // YSCROLL=3 — now (0x33 & 7) = 3 matches
  expect(vic._isBadLine(0x33, vic.regs) === true,
    'R13: post-write predicate sees new YSCROLL — r$33 now a bad line');
  ok('R13: mid-line YSCROLL write retroactively makes the predicate true (live read)');
}

// ─── R14: exhaustive predicate sweep ─────────────────────────────────────
// Every (yscroll 0..7, raster 0..255) pair against the spec predicate, with
// the DEN latch both set and cleared:
//   bad line ⇔ displayEnabled ∧ raster ∈ [$30,$F7] ∧ (raster & 7) === yscroll
{
  const vic = makeVic();
  for (const latched of [true, false]) {
    vic.displayEnabled = latched;
    let mismatches = 0;
    for (let ys = 0; ys < 8; ys++) {
      vic.regs[0x11] = 0x10 | ys;
      for (let raster = 0; raster < 256; raster++) {
        const want = latched && raster >= 0x30 && raster <= 0xF7 && (raster & 7) === ys;
        if (vic._isBadLine(raster, vic.regs) !== want) mismatches++;
      }
    }
    expect(mismatches === 0,
      `R14: displayEnabled=${latched}: ${mismatches} mismatches across 8×256 (yscroll, raster) pairs`);
  }
  ok('R14: bad-line predicate exact across every (yscroll, raster) pair, latch on and off');
}

console.log(`\n${testNo} bad-line latch spec tests; ${failing} fail`);
if (failing) process.exit(1);
