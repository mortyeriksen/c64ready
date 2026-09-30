// VIC-II bad-line / DMA delay window spec tests (Bauer §3.14.6).
//
// The bad-line CONDITION (DEN=1, raster in $30-$F7, YSCROLL == raster&7)
// is sampled every cycle in the "DMA window" (Bauer §3.7.2 rule 3: "If
// there is a Bad Line Condition in cycles 12-54, BA is set low and the
// c-accesses are started. Once started, one c-access is done in the
// second phase of every clock cycle in the range 15-54."). If the
// condition becomes true at cycle N inside this window, a c-fetch phase
// is queued starting at max(15, N). If the condition becomes false BEFORE
// the queued phase starts, the pending bad line is cancelled. The window
// INCLUDES cycle 54 — the last c-access (col 39): a BL first raised at
// cy54 still does its single col-39 c-access (one invalid $ff read).
// After cycle 54 the window is closed.
//
// Demos exploit this for FLD / AGSP / colorsplit effects: write $D011
// mid-rasterline to delay or suppress the c-fetch.
//
// Each test sets up a fresh VIC at line $30 (any line in $30-$F7 works),
// drives `_updateBadLineStateForCycle` directly with the cycle number,
// and asserts the resulting queue / cancel state.
//
// Extracted from vic2-test.js (was tests DMA-1..9).

import { makeVic, assert } from './_vic2-helpers.js';

function newDmaWindowVic(yscroll = 0) {
  const vic = makeVic();
  vic.displayEnabled = true;
  vic.regs[0x11] = 0x10 | (yscroll & 0x07);  // DEN=1, YSCROLL=yscroll
  return vic;
}

// Test DMA-1: condition becoming true at the EARLIEST cycle (12) queues
// the fetch from cycle 15 (the lower bound — earliest c-access slot).
{
  const vic = newDmaWindowVic(0);
  const raster = 0x30;                       // raster & 7 = 0 = YSCROLL
  vic._updateBadLineStateForCycle(12, raster);
  assert(vic.lineBadLineDisplayPending === true,
    'Bauer §3.14.6: condition true at cycle 12 queues a bad-line fetch');
  assert(vic.lineBadLineStartCycle === 15,
    'queue clamps to cycle 15 (the lower edge of the c-fetch window)');
  console.log('ok  - DMA window: condition at cycle 12 queues fetch from cycle 15 (lower bound)');
}

// Test DMA-2: condition becoming true MID-WINDOW at observation cycle 25
// queues the fetch at that same cycle (Bauer §3.14.6: BA goes low AND
// c-accesses start in the observation cycle, which is itself one cycle
// past the CPU write). The number of c-accesses that actually run is
// therefore 54 - startCycle + 1, observable by clocking through the line.
{
  const vic = newDmaWindowVic(0);
  vic._updateBadLineStateForCycle(25, 0x30);
  assert(vic.lineBadLineStartCycle === 25,
    'Bauer §3.14.6: condition observed at cycle 25 queues a fetch starting at cycle 25 (same cycle as BA-low)');
  assert(vic.lineBadLineInvalidCReadsPending === 3,
    'late-start fetch reports 3 invalid c-reads per the BA-lead inertia rule');
  console.log('ok  - DMA window: condition observed at cycle 25 → fetch starts at cycle 25');
}

// Test DMA-3: condition becoming true at the LAST observation cycle of
// the window (cycle 53) still queues — fetch starts at cycle 53; only
// the AEC-lag invalid c-reads at c53/c54 fire (no valid c-access).
{
  const vic = newDmaWindowVic(0);
  vic._updateBadLineStateForCycle(53, 0x30);
  assert(vic.lineBadLineDisplayPending === true,
    'Bauer §3.14.6: cycle 53 is the last cycle that can queue a bad-line fetch');
  assert(vic.lineBadLineStartCycle === 53,
    'condition observed at cycle 53 queues fetch starting at cycle 53 (only 2 invalid c-reads fire, no valid)');
  console.log('ok  - DMA window: condition observed at cycle 53 queues fetch at cycle 53 (upper bound)');
}

// Test DMA-4: condition becoming true at cycle 54 — the LAST cycle of the
// window (Bauer §3.7.2 rule 3: c-accesses run "in the range 15-54") — still
// queues. The single col-39 c-access fires as ONE invalid $ff read (AEC
// still high). Validated by testprogs/VICII/fldscroll fldscroll-2B-60:
// readme "1 black $ff char on the right". Cutting the window at 53 dropped
// that char (rendered the real screen code instead).
{
  const vic = newDmaWindowVic(0);
  vic._updateBadLineStateForCycle(54, 0x30);
  assert(vic.lineBadLineDisplayPending === true,
    'Bauer §3.7.2 rule 3: cycle 54 is the last cycle that queues a bad-line fetch (last c-access = col 39)');
  assert(vic.lineBadLineStartCycle === 54,
    'condition observed at cycle 54 queues fetch starting at cycle 54');
  assert(vic.lineBadLineInvalidCReadsPending === 1,
    'only one invalid $ff c-read fits (min(3, 55-54)) — the col-39 "1 black $ff char on the right" (fldscroll-2B)');
  console.log('ok  - DMA window: condition at cycle 54 queues a single col-39 invalid c-read (upper bound)');
}

// Test DMA-5: condition becoming true ABOVE the window (cycle 60) is a
// no-op for bad-line generation.
{
  const vic = newDmaWindowVic(0);
  vic._updateBadLineStateForCycle(60, 0x30);
  assert(vic.lineBadLineDisplayPending === false,
    'Bauer §3.14.6: cycles 54-63 are outside the DMA window — no bad line possible');
  console.log('ok  - DMA window: condition at cycle 60 (well outside) is a no-op');
}

// Test DMA-6: cancellation BEFORE fetch starts. Queue at cycle 12
// (startCycle=15), then change YSCROLL away at cycle 13 — the pending
// bad line must be cancelled because the matrix fetch hasn't begun yet.
{
  const vic = newDmaWindowVic(0);
  vic._updateBadLineStateForCycle(12, 0x30);
  assert(vic.lineBadLineStartCycle === 15, 'queued at cycle 15');

  // CPU writes $D011 to break the YSCROLL match (yscroll now 5, raster&7 still 0).
  vic.regs[0x11] = 0x10 | 0x05;
  vic._updateBadLineStateForCycle(13, 0x30);

  assert(vic.lineBadLineDisplayPending === false,
    'Bauer §3.14.6: condition becoming false at cycle 13 cancels the pending fetch (still pre-start)');
  assert(vic.lineMatrixFetchCol === -1,
    'no matrix fetch ever ran for the cancelled bad line');
  console.log('ok  - DMA window: false-before-start cancels the queued bad line');
}

// Test DMA-7: once the matrix fetch has BEGUN, the bad line cannot be
// cancelled — clearing the YSCROLL match mid-fetch is a no-op for this
// line. Modeled by directly setting lineMatrixFetchCol >= 0 to simulate
// "fetch is live" state.
{
  const vic = newDmaWindowVic(0);
  vic._updateBadLineStateForCycle(12, 0x30);
  assert(vic.lineBadLineStartCycle === 15);

  // Simulate the fetch having actually started (cycle 15 reached, c-access fired).
  vic.lineMatrixFetchCol = 0;

  // Now break the match.
  vic.regs[0x11] = 0x10 | 0x05;
  vic._updateBadLineStateForCycle(20, 0x30);

  assert(vic.lineBadLineDisplayPending === true,
    'Bauer §3.14.6: bad line stays pending after fetch has started — no cancellation possible');
  assert(vic.lineMatrixFetchCol === 0,
    'in-flight matrix fetch column is preserved');
  console.log('ok  - DMA window: cancellation is impossible once the matrix fetch has begun');
}

// Test DMA-8: invalid-c-read accounting differs by start cycle. Per the
// impl comment in `_queueBadLineFetchPhase`: a fetch starting at cycle 15
// reports invalidFetches based on how late BA went low (cycleInLine - 12,
// clamped to 0); a fetch starting later always reports 3 invalid reads
// because BA wasn't low for the full 3-cycle lead window.
{
  // Early queue at cycle 12 (vic.cycleInLine remains 0 since we don't
  // clock — the impl reads cycleInLine for the inertia calc).
  const v1 = newDmaWindowVic(0);
  v1._updateBadLineStateForCycle(12, 0x30);
  assert(v1.lineBadLineInvalidCReadsPending === 0,
    'cycle-15 fetch with cycleInLine=0 reports zero invalid c-reads (BA went low in time)');

  // Late queue at cycle 30 — always 3 invalid reads.
  const v2 = newDmaWindowVic(0);
  v2._updateBadLineStateForCycle(30, 0x30);
  assert(v2.lineBadLineInvalidCReadsPending === 3,
    'late-cycle bad lines always report 3 invalid c-reads (BA-lead inertia)');
  console.log('ok  - DMA window: invalid-c-read accounting differs by start cycle (early vs late)');
}

// Test DMA-9: BA must go low across the full c-fetch window (cycles
// 15-54) once a bad line is committed and fetch has started. Verifies
// the BA gating rule that drives CPU stalls during the bad line.
{
  const vic = newDmaWindowVic(0);
  vic._updateBadLineStateForCycle(12, 0x30);
  vic.lineMatrixFetchCol = 0;                // simulate fetch live

  for (let cycle = 15; cycle <= 54; cycle++) {
    assert(vic._isBadLineBaLow(cycle) === true,
      `bad-line BA low across the c-fetch window (cycle ${cycle})`);
  }
  assert(vic._isBadLineBaLow(14) === false,
    'BA NOT low at cycle 14 — that is the BA-lead boundary, not the fetch window');
  assert(vic._isBadLineBaLow(55) === false,
    'BA released at cycle 55 — c-fetch window has closed');
  console.log('ok  - DMA window: BA stays low across cycles 15-54 once fetch is committed');
}

console.log('\nAll VIC-II bad-line DMA-window tests passed.');
