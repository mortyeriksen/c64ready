// vic2-cy58-idle-display-entry-spec-test.js
//
// Locks the two VIC behaviors the testprogs/VICII/sequencer-bug ("Shards of
// Fancy" U64 data-sequencer demo) depends on:
//
//   (1) The cycle-58 display-state transition must be able to ENTER display
//       state from idle on a Bad Line Condition, not only stay/leave from an
//       already-active state.  Bauer §3.7.1: "the transition from idle to
//       display state occurs as soon as there is a Bad Line Condition."
//       §3.7.2 rule 5: at cycle 58, if RC==7 then VCBASE←VC; the chip is in
//       display state afterwards iff there is a Bad Line Condition, and RC is
//       then incremented.
//
//   (2) The 40-entry video-matrix/color line buffer is written ONLY by
//       c-accesses (bad lines) and otherwise RETAINS its contents across lines
//       AND frames.  Frame start resets the matrix COUNTERS (rowVcBase tracks
//       VCBASE←0) but must NOT wipe the buffer — a display row that runs before
//       the frame's first c-access shows the previous frame's data.
//
// Real-demo trigger: bug.prg writes $D011=$3B (YSCROLL=3) at cy54 of L51 — past
// the cy12-54 bad-line detection window — so display state never activated
// earlier.  With RC carried over as 7 (idle top border, see
// vic2-rc-carryover-screenpos-spec-test) the cy58 transition fires VCBASE←VC
// and RC→0, putting the first bitmap row on L52; that row has no c-access, so
// it renders from the retained line buffer (screen RAM $F6 → white-on-blue).

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

// One master cycle: clock(1) (phi1) then phi2(). _advanceDisplayStateCycle58
// runs in phi2(), so a clock()-only harness would never exercise it.
function step(v) { v.clock(1); v.phi2(); }
function driveTo(v, raster, cycle) {
  let safety = 312 * CYCLES_PER_LINE * 2;
  while (!(v.raster === raster && v.cycleInLine === cycle)) {
    step(v);
    if (--safety <= 0) throw new Error(`drive timeout r=${v.raster} c=${v.cycleInLine}`);
  }
}

// ── Direct truth table for _advanceDisplayStateCycle58 ──────────────────
// raster 100 (100&7=4); bad line ⇔ YSCROLL=4 ($1C), else YSCROLL=3 ($1B).
// Both keep DEN(bit4)=1 / RSEL(bit3)=1; displayEnabled forced (latched at 0x30).
function runCy58({ da, rc, vc, vcBase, bl }) {
  const v = makeVic();
  v.displayEnabled = true;
  v.displayActive = da;
  v.rc = rc; v.vc = vc; v.vcBase = vcBase;
  v.regs[0x11] = bl ? 0x1C : 0x1B;
  // The cy58 rule-5/6 transition consumes the bad-line condition SAMPLED at
  // phi1 of cycle 58 (captured in clock() before the same-cycle CPU write —
  // Bauer §3.7.2 "first phase of cycle 58"). This direct-call harness skips
  // clock(), so set the phi1 sample explicitly to the bad-line condition under
  // test. (regs[0x11] still drives the §3.7.1 same-cycle-write reactivation.)
  v._cycle58BadLineSample = bl;
  v._advanceDisplayStateCycle58(100);
  return { da: v.displayActive, rc: v.rc, vcBase: v.vcBase };
}

// 1: display active, RC<7 — stays display, RC++, VCBASE untouched (±bad line)
{
  const a = runCy58({ da: true, rc: 3, vc: 50, vcBase: 10, bl: false });
  expect(a.da === true && a.rc === 4 && a.vcBase === 10, `!BL: da=${a.da} rc=${a.rc} vcBase=${a.vcBase}`);
  const b = runCy58({ da: true, rc: 3, vc: 50, vcBase: 10, bl: true });
  expect(b.da === true && b.rc === 4 && b.vcBase === 10, `BL: da=${b.da} rc=${b.rc} vcBase=${b.vcBase}`);
  ok('cy58: display + RC<7 stays in display and advances RC (no VCBASE change)');
}

// 2: display active, RC==7, bad line — VCBASE←VC, stays display, RC→0
{
  const r = runCy58({ da: true, rc: 7, vc: 50, vcBase: 10, bl: true });
  expect(r.vcBase === 50, `VCBASE←VC, got ${r.vcBase}`);
  expect(r.da === true, `stays in display (bad line)`);
  expect(r.rc === 0, `RC 7→0, got ${r.rc}`);
  ok('cy58: display + RC==7 + bad line → VCBASE←VC, stays display, RC→0');
}

// 3: display active, RC==7, no bad line — VCBASE←VC, goes idle, RC held
{
  const r = runCy58({ da: true, rc: 7, vc: 50, vcBase: 10, bl: false });
  expect(r.vcBase === 50, `VCBASE←VC, got ${r.vcBase}`);
  expect(r.da === false, `display→idle (RC==7, no bad line)`);
  expect(r.rc === 7, `RC held at 7 (not incremented in idle), got ${r.rc}`);
  ok('cy58: display + RC==7 + no bad line → VCBASE←VC, display→idle');
}

// 4: THE FIX — idle, RC==7, bad line → enters display, VCBASE←VC, RC→0
//   (idle vc==vcBase, as on a line with no g-accesses)
{
  const r = runCy58({ da: false, rc: 7, vc: 0, vcBase: 0, bl: true });
  expect(r.da === true, `idle→DISPLAY entered on bad line (Bauer §3.7.1)`);
  expect(r.rc === 0, `RC 7→0, got ${r.rc}`);
  expect(r.vcBase === 0, `VCBASE←VC=0, got ${r.vcBase}`);
  ok('cy58: idle + RC==7 + bad line → ENTERS display, VCBASE←VC, RC→0 (the fix)');
}

// 5: idle, RC==7, no bad line — stays idle, RC held (VCBASE←VC is a no-op)
{
  const r = runCy58({ da: false, rc: 7, vc: 10, vcBase: 10, bl: false });
  expect(r.da === false, `stays idle (no bad line)`);
  expect(r.rc === 7, `RC held at 7, got ${r.rc}`);
  expect(r.vcBase === 10, `VCBASE←VC no-op in idle, got ${r.vcBase}`);
  ok('cy58: idle + RC==7 + no bad line → stays idle (no spurious display entry)');
}

// 6: idle, RC<7, bad line → enters display, RC++ (idle→display, §3.7.1)
{
  const r = runCy58({ da: false, rc: 3, vc: 0, vcBase: 0, bl: true });
  expect(r.da === true, `idle→display on bad line even with RC<7`);
  expect(r.rc === 4, `RC++ once display active, got ${r.rc}`);
  ok('cy58: idle + RC<7 + bad line → enters display, RC++');
}

// 7: idle, RC<7, no bad line → unchanged
{
  const r = runCy58({ da: false, rc: 3, vc: 0, vcBase: 0, bl: false });
  expect(r.da === false && r.rc === 3, `stays idle/unchanged: da=${r.da} rc=${r.rc}`);
  ok('cy58: idle + RC<7 + no bad line → no change');
}

// ── Integration: a late bad line in an idle line enters display at cy58 ──
// 8: paired — a bad line created at cy55 (past the cy12-54 bad-line fetch
//   window) is acted on ONLY by the cy58 transition. With RC=7 idle carryover
//   it enters display, RC→0, VCBASE←VC; the control (no late write) stays idle.
{
  // bad-line branch
  const v = makeVic();
  v.write(0x16, 0xC8);
  v.write(0x11, 0x1B);                 // DEN=1, YSCROLL=3 → L100 (100&7=4) not a bad line
  driveTo(v, 100, 55);
  v.displayActive = false; v.rc = 7; v.vc = 0; v.vcBase = 0;  // idle carryover
  expect(!v.displayActive, `idle before the late write`);
  v.write(0x11, 0x1C);                 // YSCROLL=4 at cy55 → bad line, past the detection window
  driveTo(v, 101, 1);                  // cross cy58 of L100
  expect(v.displayActive === true, `late bad line entered display at cy58`);
  expect(v.rc === 0, `RC 7→0 at cy58, got ${v.rc}`);
  expect(v.vcBase === 0, `VCBASE←VC=0, got ${v.vcBase}`);

  // control branch — same drive, no late write → must stay idle
  const c = makeVic();
  c.write(0x16, 0xC8);
  c.write(0x11, 0x1B);
  driveTo(c, 100, 55);
  c.displayActive = false; c.rc = 7; c.vc = 0; c.vcBase = 0;
  driveTo(c, 101, 1);
  expect(c.displayActive === false, `control (no bad line) stays idle`);

  ok('integration: cy55 late bad line enters display at cy58; control stays idle');
}

// ── Line-buffer retention vs. power-on clear ────────────────────────────
// 9: frame start retains the c-fetch buffer; only rowVcBase resets. DEN=0 so
//   no c-access overwrites the buffer during the drive.
{
  const v = makeVic();
  v.write(0x11, 0x0B);                 // DEN=0 → no bad lines / c-accesses
  v.rowScreenCodes.fill(0x37);
  v.rowColorNibbles.fill(0x0A);
  v.rowFetchedCols.fill(1);
  v.rowVcBase = 0x111;
  driveTo(v, 311, 60);
  for (let i = 0; i < 8; i++) step(v);
  expect(v.raster === 0, `at L0 (got ${v.raster})`);
  expect(v.rowScreenCodes.every(x => x === 0x37), `rowScreenCodes retained across frame`);
  expect(v.rowColorNibbles.every(x => x === 0x0A), `rowColorNibbles retained across frame`);
  expect(v.rowFetchedCols.every(x => x === 1), `rowFetchedCols retained across frame`);
  expect(v.rowVcBase === 0, `rowVcBase reset to 0 at frame start, got ${v.rowVcBase}`);
  ok('frame start retains the c-fetch line buffer, resets only rowVcBase');
}

// 10: reset() (power-on) still fully clears the buffer + counters
{
  const v = makeVic();
  v.rowScreenCodes.fill(0x55);
  v.rowColorNibbles.fill(0x0C);
  v.rowFetchedCols.fill(1);
  v.rowVcBase = 0x222;
  v.reset();
  expect(v.rowScreenCodes.every(x => x === 0), `reset clears rowScreenCodes`);
  expect(v.rowColorNibbles.every(x => x === 0), `reset clears rowColorNibbles`);
  expect(v.rowFetchedCols.every(x => x === 0), `reset clears rowFetchedCols`);
  expect(v.rowVcBase === 0, `reset clears rowVcBase`);
  ok('reset() fully clears the line buffer for a clean power-on');
}

console.log(`\n${testNo - failing}/${testNo} passed${failing ? `, ${failing} FAILED` : ''}`);
if (failing) process.exit(1);
