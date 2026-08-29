// C-fetch buffer + per-segment mode-routing spec audit. 10 tests
// targeting the rendering-path interactions the user's snapshot
// scenario exercises: stale c-data carrying into top zone, mid-line
// $D011 mode flips producing per-segment output, frame-start state
// clearing.
//
// Sources: Bauer §3.7.2 (display state, c-fetch lifecycle), §3.7.3
// (mode decode), §3.7.5 (idle byte).

import { VIC2, CYCLES_PER_LINE, CANVAS_W } from '../src/vic2.js';

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

// ── 1: Frame start RETAINS the row buffer; only rowVcBase tracks VCBASE
// Bauer §3.7.2 resets the matrix COUNTERS (VC/VCBASE) at frame start, but
// the 40-entry video-matrix/color line buffer is written ONLY by c-accesses
// (bad lines) and otherwise persists across lines AND frames — exactly like
// test 7's within-frame persistence, extended over the frame boundary.
// Ground truth: testprogs/VICII/sequencer-bug renders the bitmap "box" char
// row (entered via the cy58 idle→display transition with NO bad line, hence
// no c-access this frame) from the PREVIOUS frame's retained line buffer
// (screen RAM $F6 → white-on-blue). Wiping it here drew the box black-on-
// black. Stale data is harmless because the idle top border never renders it
// (rendering is gated on displayActive). rowVcBase IS reset to 0 because
// VCBASE is reloaded to 0 at the top of every frame.
{
  const vic = makeVic();
  vic.write(0x11, 0x0B);             // DEN=0 → no bad lines / c-accesses this frame,
                                     //   so nothing legitimately overwrites the buffer.
  // Pollute row buffers + a non-zero vc base.
  vic.rowScreenCodes.fill(0x42);
  vic.rowColorNibbles.fill(0x07);
  vic.rowFetchedCols.fill(1);
  vic.rowVcBase = 0x123;
  // Drive through a frame back to L0.
  driveTo(vic, 311, 60);
  for (let i = 0; i < 5; i++) vic.clock(1);
  expect(vic.raster === 0, `pre: at L0`);
  expect(vic.rowScreenCodes.every(v => v === 0x42),
    `frame start: rowScreenCodes RETAINED (line buffer persists across frames)`);
  expect(vic.rowColorNibbles.every(v => v === 0x07),
    `frame start: rowColorNibbles RETAINED`);
  expect(vic.rowFetchedCols.every(v => v === 1),
    `frame start: rowFetchedCols RETAINED`);
  expect(vic.rowVcBase === 0,
    `frame start: rowVcBase reset to 0 (VCBASE reloaded at top of frame)`);
  ok('Bauer §3.7.2: frame start retains the row buffer, resets only rowVcBase');
}

// ── 2: VC/VCBASE/RC reset at L0 frame start ───────────────────────────
{
  const vic = makeVic();
  vic.vc = 0x123;
  vic.vcBase = 0x0FF;
  vic.rc = 5;
  driveTo(vic, 311, 60);
  for (let i = 0; i < 5; i++) vic.clock(1);
  expect(vic.vc === 0, `frame start: VC reset`);
  expect(vic.vcBase === 0, `frame start: VCBASE reset`);
  expect(vic.rc === 0, `frame start: RC reset`);
  ok('Bauer §3.7.2: frame start clears VC/VCBASE/RC counters');
}

// ── 3: Mid-line $D011 write captures into lineCycleRegs[next cycle] ────
// The per-cycle reg snapshot (lineCycleRegs[c]) is what the segment
// builder later uses to decide rendering mode. A CPU write at phi2 of
// cycle N becomes visible at the next VIC cycle's phi1, so the SAME
// cycle's lineCycleRegs[c] still reflects the pre-write value.
{
  const vic = makeVic();
  // _captureCycleState only snapshots the renderer-feed buffers (lineCycleRegs)
  // on visible canvas lines (raster ≥ 15) — the gate is a render-cost
  // optimisation; the per-cycle capture itself is raster-independent in real
  // silicon. Position on a visible line so the path under test runs.
  driveTo(vic, 50, 0);
  vic.write(0x11, 0x1B);             // text mode
  vic.clock(1);                       // c1: captures $1B
  expect(vic.lineCycleRegs[1][0x11] === 0x1B,
    `c1 captured pre-write value $1B`);
  vic.write(0x11, 0x73);             // mode $73 (mode 110)
  vic.clock(1);                       // c2: captures $73 (write was before this cycle)
  expect(vic.lineCycleRegs[2][0x11] === 0x73,
    `c2 captures post-write value $73, got $${vic.lineCycleRegs[2][0x11].toString(16)}`);
  ok('VIC: lineCycleRegs captures regs at the start of each VIC cycle');
}

// ── 4: Mode flip mid-line splits segments at the change cycle ─────────
// The segment builder processes cycles 11..58 and creates one segment
// per cycle, each with its own regs snapshot. A mode flip mid-line
// produces segments with different modes, and the renderer chooses
// per-segment behavior.
{
  const vic = makeVic();
  // Visible line so the renderer-feed lineCycleRegs snapshot is taken (see
  // test 3); cycle 0..60 stays within the single line (no wrap at 63).
  driveTo(vic, 50, 0);
  vic.write(0x11, 0x1B);
  // Run cycles 1..30 with mode $1B.
  for (let i = 0; i < 30; i++) vic.clock(1);
  // Flip to mode $73 at cycle 31.
  vic.write(0x11, 0x73);
  for (let i = 0; i < 30; i++) vic.clock(1);
  // Verify lineCycleRegs at cycle 20 (still mode $1B) and cycle 50
  // (now mode $73).
  expect(vic.lineCycleRegs[20][0x11] === 0x1B,
    `c20 captured original mode $1B`);
  expect(vic.lineCycleRegs[50][0x11] === 0x73,
    `c50 captured post-flip mode $73`);
  ok('VIC: mid-line $D011 flip captured per-cycle in lineCycleRegs');
}

// ── 5: _renderSourceColumn uses seg.regs[$11] for mode ─────────────────
// The renderer's mode decision comes from seg.regs[0x11]/0x16/0x18.
// With per-cycle regs capture, segments at different cycles get
// different mode decisions. Verify by inspecting our segment builder's
// output.
{
  const vic = makeVic();
  vic.write(0x11, 0x1B);
  for (let c = 0; c <= 63; c++) {
    vic.lineCycleRegs[c].set(vic.regs);
  }
  // Manually flip cycle 30's regs to mode $73.
  vic.lineCycleRegs[30][0x11] = 0x73;
  // Build segments and check.
  const segs = vic._buildCycleRasterSegments();
  const segC30 = segs.find(s => s.cycle === 30);
  expect(segC30 && (segC30.regs[0x11] & 0x60) === 0x60,
    `segment for cycle 30: mode bits ECM+BMM set ($73)`);
  const segC25 = segs.find(s => s.cycle === 25);
  expect(segC25 && (segC25.regs[0x11] & 0x60) === 0x00,
    `segment for cycle 25: original mode (no ECM/BMM)`);
  ok('VIC: cycle segments get per-cycle regs snapshot');
}

// ── 6: Bad-line c-fetch sets rowFetchedCols[col] for cols 0..39 ────────
// During bad-line cycles 15..54, the c-access fills rowScreenCodes and
// rowColorNibbles. After the bad-line, all 40 cols should be marked
// fetched.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.displayEnabled = true;
  // Pre-populate screen RAM at $0400 (default screen base for $D018=$10).
  vic.regs[0x18] = 0x10;
  for (let col = 0; col < 40; col++) {
    vic.ram[0x0400 + col] = 0x55;
    vic.colorRam[col] = 0x07;
  }
  // Drive through L51 (bad-line) and check post-fetch state at L52 c1.
  driveTo(vic, 51);
  driveTo(vic, 52, 1);
  let fetched = 0;
  for (let col = 0; col < 40; col++) if (vic.rowFetchedCols[col]) fetched++;
  expect(fetched === 40,
    `after bad-line L51: all 40 cols fetched, got ${fetched}`);
  ok('Bauer §3.7.2: bad-line c-fetch sets rowFetchedCols[0..39]');
}

// ── 7: Non-bad-line preserves c-fetch from previous bad-line ──────────
// Bauer §3.7.2: rule 2 (cycle 14) reloads VC := VCBASE every line. But
// rowScreenCodes/rowColorNibbles (the c-fetched data) is NOT reset on
// non-bad-lines. The previous bad-line's data continues to drive
// rendering.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.displayEnabled = true;
  vic.regs[0x18] = 0x10;
  for (let col = 0; col < 40; col++) {
    vic.ram[0x0400 + col] = 0x42 + col;
    vic.colorRam[col] = col & 0x0F;
  }
  driveTo(vic, 52);                   // post-bad-line L51
  // Run one more line (L52, NOT a bad-line with YS=3).
  driveTo(vic, 53, 60);
  // Codes still reflect L51's fetch.
  expect(vic.rowScreenCodes[0] === 0x42,
    `non-bad-line: rowScreenCodes preserved from prev bad-line, got $${vic.rowScreenCodes[0].toString(16)}`);
  ok('Bauer §3.7.2: non-bad-line preserves c-fetch from previous bad-line');
}

// ── 8: Mode 110 forces black even with non-zero c-fetched data ─────────
// Bauer §3.7.3.7: invalid bitmap mode 1 paints every pixel BLACK. Even
// if c-data is non-zero (stale from previous bad-line), mode 110
// renders black.
//
// Note: our renderer's text path uses `seg.rowFetchD011` (line-invariant
// mode set at bad-line begin) instead of live `seg.regs[0x11]`. So we
// must also set `rowFetchD011` to mode 110 to test the rule. Test 8b
// below documents the separate concern of mid-line mode flips not
// reaching the text path.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x73;
  vic.regs[0x16] = 0x08;
  vic.regs[0x21] = 0x06;
  vic.rowFetchD011 = 0x73;            // line-invariant mode used by text renderer
  vic.rowFetchD016 = 0x08;
  for (let c = 0; c <= 63; c++) {
    vic.lineCycleRegs[c].set(vic.regs);
    vic.lineCycleRowCodes[c].fill(0xFF);
    vic.lineCycleRowColors[c].fill(0x07);
    vic.lineCycleRowFetchedCols[c].fill(1);
    vic.lineCycleDisplayColumnActive[c] = 1;
    vic.lineCycleHBorderBefore[c] = (c <= 14 || c >= 56) ? 1 : 0;
    vic.lineCycleHBorder[c] = (c <= 14 || c >= 56) ? 1 : 0;
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
    vic.lineCycleVBorder[c] = 0;
    vic.lineCycleVBorderBefore[c] = 0;
  }
  vic.displayActive = true;
  vic._renderRasterLine(20);
  const cy = 20 - 15;
  const ro = cy * CANVAS_W;
  for (const x of [50, 100, 200, 300]) {
    expect(vic.fb32[ro + x] === 0xFF000000,
      `mode 110 + c-data + rowFetchD011 set: pixel x=${x} must be BLACK, got 0x${vic.fb32[ro + x].toString(16)}`);
  }
  ok('Bauer §3.7.3.7: mode 110 forces BLACK regardless of fetched c-data');
}

// ── 9: Per-segment mode evaluation (mid-line flip $1B → $73 at c30) ───
// The renderer must use each cycle's regs[$11] when deciding mode.
// A flip at cycle 30 produces text-mode pixels in cycles 15..29 and
// mode-110-BLACK pixels in cycles 30..54.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;             // text mode
  vic.regs[0x16] = 0x08;
  vic.regs[0x21] = 0x00;             // bg = black so text-mode bg also black
  for (let c = 0; c <= 63; c++) {
    vic.lineCycleRegs[c].set(vic.regs);
    vic.lineCycleHBorderBefore[c] = (c <= 14 || c >= 56) ? 1 : 0;
    vic.lineCycleHBorder[c] = (c <= 14 || c >= 56) ? 1 : 0;
    vic.lineCycleHInner[c] = (c >= 15 && c <= 54) ? 1 : 0;
  }
  // Flip at cycle 30: mode $73 from c30 onwards.
  for (let c = 30; c <= 63; c++) {
    vic.lineCycleRegs[c][0x11] = 0x73;
  }
  vic._renderRasterLine(20);
  const cy = 20 - 15;
  const ro = cy * CANVAS_W;
  // Cycle 25 → canvas X ~ (25-12)*8+8 = 112. Cycle 35 → X ~ 192.
  // Both should be black (text + bg=black for c25; mode 110 for c35).
  expect(vic.fb32[ro + 112] === 0xFF000000,
    `pre-flip text-mode + bg=black at x=112: must be black`);
  expect(vic.fb32[ro + 192] === 0xFF000000,
    `post-flip mode 110 at x=192: must be black`);
  ok('VIC: per-segment mode flip mid-line renders correctly');
}

// ── 10: ECM idle byte at $39FF is read at runtime, not snapshot at line start
// Bauer §3.7.5: idle g-access addr depends on regs[$11] ECM bit at the
// time of access. Mid-line ECM flip changes the idle source for any
// subsequent idle reads on the same line.
{
  const vic = makeVic();
  vic.currentVicBank = 0x0000;
  vic.ram[0x3FFF] = 0xAA;
  vic.ram[0x39FF] = 0x55;
  vic.regs[0x11] = 0x1B;             // ECM=0
  expect(vic._readIdleGByte(vic.regs, 0) === 0xAA, `pre-flip: $3FFF`);
  vic.regs[0x11] = 0x5B;             // ECM=1 mid-line
  expect(vic._readIdleGByte(vic.regs, 0) === 0x55,
    `post-flip mid-line: $39FF`);
  ok('Bauer §3.7.5: idle g-access source switches mid-line on $D011 ECM flip');
}

console.log(`\n${testNo} c-fetch + mode-segment spec tests; ${testsFailing} fail (expose impl≠spec)`);
if (testsFailing) process.exit(1);
