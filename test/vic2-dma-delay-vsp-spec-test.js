// dma-delay-vsp-spec-test.js
//
// Bauer §3.14.6 DMA delay / VSP (Virtual Screen Position):
//
//   "The most sophisticated Bad Line manipulation is to create a Bad
//    Line Condition in cycles 15-53 of a raster line of display window,
//    in which the graphics data sequencer is in idle state, for example
//    by modifying register $d011 so that YSCROLL is now equal to the
//    lower three bits of RASTER."
//
// Mechanism per spec:
//   1. CPU writes $D011 mid-line, changing YSCROLL to match (raster &
//      7) of the current line. The bad-line condition fires.
//   2. VIC sets BA low immediately (next cycle), starts c-accesses.
//   3. AEC follows BA after 3 cycles. During those 3 cycles, VIC reads
//      $FF for char pointers + opcode-derived data for color bits
//      (= "invalid" c-reads).
//   4. c-accesses continue until cycle 54. Starting late means fewer
//      than 40 fetches → VC ends < 40.
//   5. The VC misalignment carries to subsequent lines = horizontal
//      virtual screen scroll.
//
// This test exercises the full DMA-delay path through our impl's
// `_updateBadLineStateForCycle` + `_queueBadLineFetchPhase` machinery.

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

function driveToCycle(vic, raster, cycle) {
  let safety = 312 * CYCLES_PER_LINE * 2;
  while (!(vic.raster === raster && vic.cycleInLine === cycle)) {
    vic.clock(1);
    if (--safety <= 0) throw new Error(`drive timeout at r=${vic.raster} c=${vic.cycleInLine}`);
  }
}

// ─── 1: Mid-line YSCROLL change at cycle 30 of L52 → bad line fires ──────
//
// Setup: YSCROLL=0, raster L52. (L52 & 7) = 4 ≠ 0 → not a bad line.
// At cycle 30, write $D011 to set YSCROLL=4. Now (L52 & 7) = YSCROLL → bad
// line condition true. Per Bauer §3.14.6, BA goes low NEXT cycle (c31)
// AND c-accesses start in that same cycle — the first 3 are invalid
// while AEC settles, then valid c-reads run from c34 onward.
//
// In master-cycle ordering (vic.clock=phi1, cpu.clock=phi2, vic.phi2),
// the write at c30 phi2 becomes visible to VIC at c31 phi1. So the
// observation cycle IS already Bauer's "next cycle" — queue startCycle
// = observation cycle, NOT observation+1. The begin path
// (_runTextPhase2Access at phi2 of the same cycle) consumes the pending
// flag, begins the c-access, and leaves 2 invalid c-reads to drain at
// c32/c33.
//
// WHERE the burst lands: L48 (= $30, YSCROLL=0) was a bad line, so the
// sequencer is in DISPLAY state through L52 (RC=4) and g-accesses have
// advanced VMLI mid-line. Per §3.7.2 rule 3 the c-access is "stored ...
// at the position specified by VMLI" — NOT at column 0. (Column 0 is
// only the §3.14.6 VSP case "in which the graphics data sequencer is in
// idle state", VMLI run empty.) After the begin sets the fetch pointer
// to VMLI-1 and the first c-read advances it, the pointer equals the
// live VMLI.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18;                  // DEN=1, RSEL=1, YSCROLL=0
  vic.displayEnabled = true;
  // Drive to L30 to latch displayEnabled, then to L52 c30.
  driveToCycle(vic, 0x30, 1);
  driveToCycle(vic, 52, 30);
  expect(vic._isBadLine(52, vic.regs) === false,
    `pre: L52 with YSCROLL=0 must NOT be bad line (52 & 7 = 4 ≠ 0)`);
  expect(vic.lineBadLineDisplayPending === false,
    `pre: no bad-line pending at L52 c30`);
  // CPU writes $D011 with YSCROLL=4 — sets bad-line condition.
  vic.regs[0x11] = 0x18 | 4;
  // Advance one cycle. _updateBadLineStateForCycle observes the change at
  // c31 phi1 (queue at startCycle=31); _runTextPhase2Access at c31 phi2
  // consumes the pending flag and runs the first invalid c-read.
  vic.clock(1);
  expect(vic._isBadLine(52, vic.regs) === true,
    `post-write: L52 with YSCROLL=4 must now be bad line`);
  expect(vic.lineMatrixFetchCol === vic.vmli && vic.vmli > 1,
    `display-state late bad-line stores at the VMLI position (§3.7.2 r3), not col 0: lineMatrixFetchCol=${vic.lineMatrixFetchCol}, vmli=${vic.vmli}`);
  expect(vic.lineBadLineInvalidCReadsActive === 2,
    `1 of 3 initial invalid c-reads consumed at c31, 2 remaining (drain at c32/c33), got ${vic.lineBadLineInvalidCReadsActive}`);
  expect(vic.displayActive === true,
    `display state activated at c31 phi2 by _beginBadLineFetchPhase, got displayActive=${vic.displayActive}`);
  ok('Bauer §3.7.2/§3.14.6: mid-line YSCROLL match begins fresh bad-line c-access at observation cycle (stores at VMLI)');
}

// ─── 2: Delayed bad-line leaves cols N..39 holding stale matrix data ─────
//
// Spec: the matrix-row buffer persists across bad-lines. A normal
// bad-line refills cols 0..39. A *delayed* bad-line only performs N
// c-accesses (= 55 - startCycle), refilling cols 0..N-1; cols N..39
// retain codes/colors from the previous bad-line — that stale data is
// what produces the visual horizontal shift (VSP).
//
// Setup: First, run a normal bad-line at L48 with screen[0..39]=0xAA.
// Then change screen RAM to 0xBB and trigger a delayed bad-line at L56
// (next bad-line: 56 & 7 = 0 = YSCROLL=0). Trigger it via DEN-flip
// trick at c30 to force a late start. Cols 0..N-1 should hold 0xBB,
// cols N..39 must still hold 0xAA from the previous bad-line.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18;
  vic.regs[0x18] = 0x14;                  // screen at $0400
  vic.displayEnabled = true;
  // Plant 0xAA across the whole 1KB screen area so any VC offset reads 0xAA.
  for (let i = 0; i < 0x0400; i++) vic.ram[0x0400 + i] = 0xAA;
  // Drive through the normal bad-line at L48 (= 0x30) to populate the
  // buffer with 0xAA. Reach L49 c1 (just past L48).
  driveToCycle(vic, 49, 1);
  expect(vic.rowScreenCodes[39] === 0xAA,
    `pre: normal bad-line filled all 40 cols with 0xAA, got col39=${vic.rowScreenCodes[39].toString(16)}`);
  expect(vic.rowFetchedCols[39] === 1,
    `pre: col 39 marked fetched after normal bad-line`);
  // Repaint the whole screen area with 0xBB so any new c-access loads 0xBB.
  for (let i = 0; i < 0x0400; i++) vic.ram[0x0400 + i] = 0xBB;
  // Next bad-line line is L56 (56 & 7 = 0 = YSCROLL). Force a delayed
  // start via YSCROLL-flip: at L56 c1 set YSCROLL=1 (suppresses bad-line
  // at c14), then at c30 set YSCROLL=0 (re-enables → late bad-line).
  driveToCycle(vic, 56, 1);
  vic.regs[0x11] = 0x18 | 1;               // YSCROLL=1 → 56&7=0 ≠ 1, not bad
  driveToCycle(vic, 56, 30);
  vic.regs[0x11] = 0x18 | 0;               // YSCROLL=0 → 56&7=0 = 0, late bad-line
  // Drive past cycle 54 of L56 — c-accesses complete by now.
  while (!(vic.raster === 56 && vic.cycleInLine === 55)) vic.clock(1);
  // Late c-accesses ran a partial range. Per Bauer §3.14.6, the first
  // three AEC-transition reads store $FF character pointers, then valid
  // late c-accesses store fresh matrix data, and the unfetched tail
  // retains prior-line data.
  let invalidRead = 0, staleHeld = 0, freshLoaded = 0, other = 0;
  for (let col = 0; col < 40; col++) {
    const v = vic.rowScreenCodes[col];
    if (v === 0xFF) invalidRead++;
    else if (v === 0xAA) staleHeld++;
    else if (v === 0xBB) freshLoaded++;
    else other++;
  }
  expect(invalidRead === 3,
    `delayed bad-line: first three invalid c-reads store $FF, got ${invalidRead}`);
  expect(staleHeld > 0,
    `delayed bad-line: stale 0xAA tail cols must remain, none found`);
  expect(freshLoaded > 0,
    `delayed bad-line: fresh 0xBB cols must exist from valid late c-accesses, none found`);
  expect(other === 0,
    `delayed bad-line: no non-spec c-buffer values, got ${other}`);
  expect(invalidRead + staleHeld + freshLoaded === 40,
    `delayed bad-line: cols accounted for (${invalidRead} invalid + ${freshLoaded} fresh + ${staleHeld} stale)`);
  ok(`Bauer §3.14.6: delayed bad-line stores ${invalidRead} invalid + ${freshLoaded} fresh + ${staleHeld} stale`);
}

// ─── 2b: Late c-accesses store at the VMLI position (§3.7.2 rule 3) ───────
//
// §3.7.2 rule 3: c-access data "is stored ... at the position specified by
// VMLI"; rule 4: VMLI "is incremented after each g-access in display state".
// So WHERE a late c-access burst lands depends on the sequencer state when
// the bad line fires:
//
//   - IDLE state (the §3.14.6 VSP case, "in which the graphics data
//     sequencer is in idle state"): no g-accesses ran, VMLI has run empty
//     (= 0), so the burst starts at column 0 — Bauer's "stored ... at the
//     start of the internal video matrix/color line".
//   - DISPLAY state (e.g. spritecrunch2's bad-line-every-line, where prior
//     lines kept the sequencer in display state): g-accesses have advanced
//     VMLI mid-line, so the burst stores at that VMLI position, putting the
//     three invalid $FF reads at the RIGHT edge of the buffer. Filling from
//     column 0 here was the spritecrunch2-07 "checker on the wrong (left)
//     side" bug.
{
  // DISPLAY state, VMLI advanced to 27 → burst starts at the VMLI position
  // (the begin sets the fetch pointer to VMLI-1; the first c-read then
  // advances it to VMLI).
  const vic = makeVic();
  vic.displayActive = true;
  vic.vc = 471;
  vic.vmli = 27;
  vic.lineBadLineDisplayPending = true;
  vic.lineBadLineStartCycle = 41;
  vic.lineBadLineInvalidCReadsPending = 3;
  vic._beginBadLineFetchPhase();
  expect(vic.lineMatrixFetchCol === 26,
    `display-state late c-access starts at the VMLI position (27-1), got ${vic.lineMatrixFetchCol}`);

  // IDLE state, VMLI run empty (0) → burst starts at column 0 (the §3.14.6
  // VSP case Bauer's "stored at the start" describes).
  const vicIdle = makeVic();
  vicIdle.displayActive = false;
  vicIdle.vc = 471;
  vicIdle.vmli = 0;
  vicIdle.lineBadLineDisplayPending = true;
  vicIdle.lineBadLineStartCycle = 41;
  vicIdle.lineBadLineInvalidCReadsPending = 3;
  vicIdle._beginBadLineFetchPhase();
  expect(vicIdle.lineMatrixFetchCol === 0,
    `idle-state (VSP) late c-access starts at column 0, got ${vicIdle.lineMatrixFetchCol}`);
  ok('§3.7.2 r3: late c-access burst stores at the VMLI position (display) / col 0 (idle VSP)');
}

// ─── 3: $D011 with YSCROLL=raster_lo at cycle 50+ — no late bad line ─────
//
// Spec: bad lines can be created at cycles 15-53. After cycle 53, the
// fetch window is closed (c-accesses end at cycle 54, BA-low warning
// can't reach c54 anymore from c53+).
//
// Impl: _updateBadLineStateForCycle has `cycle >= 54 && cycle <= 57: return`,
// so bad-line queueing is blocked in that range.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18;
  vic.displayEnabled = true;
  driveToCycle(vic, 0x30, 1);
  driveToCycle(vic, 52, 55);              // past c54 — fetch window closed
  vic.regs[0x11] = 0x18 | 4;
  vic.clock(1);
  expect(vic.lineBadLineDisplayPending === false,
    `bad-line queue blocked past c53, got ${vic.lineBadLineDisplayPending}`);
  ok('Bauer §3.14.6: late YSCROLL change past c53 does NOT queue fresh bad-line');
}

// ─── 4: DEN-flip DMA delay variant (alternative trigger) ─────────────────
//
// Spec final paragraph: "DMA Delay can not only be achieved by
// manipulating YSCROLL but also with the DEN bit of register $d011".
// Set YSCROLL=0 so L $30 is a bad-line candidate; clear DEN; drive past
// L $30 cycle 1 (which clears displayEnabled latch); set DEN=1
// mid-L$30 → fresh bad-line condition.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x08;                  // DEN=0, RSEL=1, YSCROLL=0
  vic.displayEnabled = false;
  // Drive to L $30 c1 with DEN=0 → displayEnabled latches false. No
  // bad lines fire.
  driveToCycle(vic, 0x30, 1);
  expect(vic.displayEnabled === false,
    `pre: displayEnabled=false (DEN=0 at $30 cycle 1)`);
  driveToCycle(vic, 0x30, 25);
  // CPU sets DEN=1 mid-L$30. _updateBadLineStateForCycle observes the
  // displayEnabled re-latch + bad-line condition at c26 phi1 (queue
  // startCycle=26); _runTextPhase2Access at c26 phi2 begins the late
  // c-fetch the same cycle (Bauer §3.14.6: BA low and c-accesses start
  // in the same cycle the trigger is observed).
  vic.regs[0x11] = 0x18;                   // DEN=1, RSEL=1, YSCROLL=0
  vic.clock(1);
  expect(vic.displayEnabled === true,
    `post DEN=1 set during L$30: displayEnabled latched`);
  expect(vic._isBadLine(0x30, vic.regs) === true,
    `L$30 with DEN=1 + YSCROLL=0 → (raster & 7) = 0 = YSCROLL → bad line`);
  expect(vic.lineMatrixFetchCol === 1,
    `DEN-trigger DMA delay: c-fetch began same cycle as observation, col advanced 0→1 after first invalid c-read, got col=${vic.lineMatrixFetchCol}`);
  expect(vic.lineBadLineInvalidCReadsActive === 2,
    `1 of 3 initial invalid c-reads consumed at c26, 2 remaining, got ${vic.lineBadLineInvalidCReadsActive}`);
  ok('Bauer §3.14.6: DEN=0→1 mid-L\\$30 triggers fresh bad-line (DMA-delay variant)');
}

// ─── 5: c-access state does NOT carry across line boundary ──────────────
//
// Regression for the FPP-scroller class of demos that force a late
// bad-line on EVERY raster line: a partial c-access on line N (e.g.
// matched at c50, only cols 0..4 fetched before c54) must NOT continue
// fetching cols 5..39 within the c-access window of line N+1. The
// matrix buffer of line N+1 belongs to whatever bad-line line N+1
// itself queues (or stays stale otherwise).
//
// Without the fix, lineMatrixFetchCol persists across the line
// boundary, so line N+1's c-access window reads cols 5..39 under line
// N+1's $D018 — stomping the buffer with cross-line data and breaking
// the FPP "stale-tail" invariant the demo relies on.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x18;
  vic.regs[0x18] = 0x14;
  vic.displayEnabled = true;
  // Fill screen at $0400 with 0xAA to populate the matrix buffer via a
  // normal bad-line at L48.
  for (let i = 0; i < 0x0400; i++) vic.ram[0x0400 + i] = 0xAA;
  driveToCycle(vic, 49, 1);
  // Repaint with 0xBB. Force a very late bad-line at L56 c50 — leaves
  // only ~4-5 valid c-accesses before c54.
  for (let i = 0; i < 0x0400; i++) vic.ram[0x0400 + i] = 0xBB;
  driveToCycle(vic, 56, 1);
  vic.regs[0x11] = 0x18 | 1;               // suppress c14 bad-line
  driveToCycle(vic, 56, 50);
  vic.regs[0x11] = 0x18 | 0;               // very late match → bad-line at c51
  // Run to end of L56.
  while (!(vic.raster === 57 && vic.cycleInLine === 1)) vic.clock(1);
  const colAtLineEnd = vic.lineMatrixFetchCol;
  expect(colAtLineEnd === -1,
    `lineMatrixFetchCol must reset at line boundary so partial c-access on L56 does not leak into L57. Got ${colAtLineEnd}`);
  expect(vic.lineBadLineDisplayPending === false,
    `lineBadLineDisplayPending must reset at line boundary, got ${vic.lineBadLineDisplayPending}`);
  // L57 has no bad-line of its own (YSCROLL=0 from the c50 write,
  // 57 & 7 = 1 ≠ 0). Repaint screen RAM with 0xCC; if the c-access
  // state leaked across the boundary, c15..54 of L57 would refresh
  // cols 5..39 with 0xCC. With the fix, those cols stay at 0xBB/0xAA.
  for (let i = 0; i < 0x0400; i++) vic.ram[0x0400 + i] = 0xCC;
  while (!(vic.raster === 58 && vic.cycleInLine === 1)) vic.clock(1);
  let leakedCC = 0;
  for (let col = 0; col < 40; col++) {
    if (vic.rowScreenCodes[col] === 0xCC) leakedCC++;
  }
  expect(leakedCC === 0,
    `no c-access on L57 (not a bad-line) must leave matrix buffer untouched, got ${leakedCC} cols with 0xCC`);
  ok('Bauer §3.14.6: c-access state resets at line boundary (FPP-scroller cross-line invariant)');
}

console.log(`\n${testNo} DMA-delay / VSP spec tests; ${failing} fail`);
if (failing) process.exit(1);
