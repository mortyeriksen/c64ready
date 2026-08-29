// VIC-II: DMA delay / VSP (Bauer §3.14.6)
// Extracted from vic2-test.js.

import {
  VIC2,
  CANVAS_W,
  CANVAS_H,
  CYCLES_PER_FRAME,
  CYCLES_PER_LINE,
  C64_PALETTE,
  C64Machine,
  paletteRgba,
  ACCESS_IDLE,
  ACCESS_REFRESH,
  ACCESS_C,
  ACCESS_G,
  assert,
  softAssert,
  makeVic,
  makeRenderSeg,
  fillSpriteLineState,
  fillOpaqueSpriteAcrossLine,
  clearLineBuffers,
  setupSpriteForRender,
  setMulticolorRegs,
  fillTextLineState,
  clearRenderedRow,
  firstForegroundX,
  lastForegroundX,
  runUntil,
  makeMasterCycleHarness,
} from './_vic2-helpers.js';

// ============================================================================
// Bauer §3.14.6: DMA delay / VSP.
// A bad-line condition raised mid-line (cycles 15-53) starts c-accesses late.
// Fewer than 40 c-accesses fire, so VC ends not at a 40-boundary; that
// misalignment is captured into vcBase at cycle 58 if rc==7, scrolling the
// next line right by `40 - (cycles-fetched)` characters. Builds on the
// existing DMA-window queue/cancel infrastructure.
// ============================================================================

// Local helper used by the DMA-delay / VSP tests below. (The standalone
// DMA-window test suite moved to vic2-bad-line-window-spec-test.js but
// the VSP tests still want the same setup.)
function newDmaWindowVic(yscroll = 0) {
  const vic = makeVic();
  vic.displayEnabled = true;
  vic.regs[0x11] = 0x10 | (yscroll & 0x07);  // DEN=1, YSCROLL=yscroll
  return vic;
}

// VSP-1: a bad-line queued mid-window only fetches (54 - startCycle + 1)
// c-accesses, so VC advances by that many instead of 40 — the screen
// scrolls right by the missed-character count.
{
  // Start with YSCROLL=5 so raster $30 (raster&7=0) is NOT a bad line at
  // cycle 14. The CPU will rewrite $D011 mid-line to engage the VSP.
  const vic = newDmaWindowVic(5);
  vic.displayActive = false;
  vic.vcBase = 0;
  vic.vc = 0;
  vic.rc = 7;  // pre-state: end of a text line; cycle 58 will capture vc into vcBase
  const raster = 0x30;

  // Cycle 14: no bad line yet → vc reloads from vcBase=0, rc keeps 7,
  // sequencer stays idle.
  vic._advanceDisplayStateCycle14(raster);
  assert(vic.vc === 0, 'cycle 14 reloaded vc from vcBase=0');
  assert(vic.rc === 7, 'cycle 14 keeps rc=7 (no bad line)');
  assert(vic.displayActive === false, 'no bad line at cycle 14 → sequencer stays idle');

  // CPU writes $D011 at cycle 24 (write_cycle); _updateBadLineStateForCycle
  // observes the trigger at cycle 25 (= write+1), queues startCycle=25
  // (same cycle as BA-low per Bauer §3.14.6). 54-25+1 = 30 c-accesses fire.
  // displayActive becomes true in the observation cycle before the g-access
  // phase, so VC advances for all 30 late c/g-access cycles.
  vic.regs[0x11] = 0x10 | 0x00;  // DEN=1, YSCROLL=0 — raster&7=0 now matches
  vic._updateBadLineStateForCycle(25, raster);
  assert(vic.lineBadLineStartCycle === 25,
    'Bauer §3.14.6: observation at cycle 25 queues fetch starting at cycle 25 (BA-low + c-access same cycle)');
  assert(vic.displayActive === true,
    'Bauer §3.14.6: displayActive true at observation cycle');

  // Drive the 30 c/g-access cycles (25..54). vc advances per g-access.
  const fetchCycles = 54 - 25 + 1;
  for (let i = 0; i < fetchCycles; i++) vic._advanceDisplayStateGAccess();

  assert(vic.vc === fetchCycles,
    `Bauer §3.14.6: after ${fetchCycles} g-accesses vc=${fetchCycles} (got ${vic.vc}) — not a 40-boundary`);

  // Cycle 58 with rc==7 captures vc into vcBase → next line starts mid-row.
  vic._advanceDisplayStateCycle58(raster);
  assert(vic.vcBase === fetchCycles,
    `Bauer §3.14.6: cycle 58 captures the misaligned vc=${fetchCycles} into vcBase — screen scrolls right`);

  console.log('ok  - VSP-1: §3.14.6 — late mid-line bad line yields VC misalignment captured into vcBase');
}

// VSP-2: invalid-c-read accounting. A late-queued bad line reports 3 invalid
// c-fetches (the BA→AEC propagation lag), independent of how late within
// the window. A cycle-15 (canonical) bad line reports 0.
{
  const a = newDmaWindowVic(0);
  a._updateBadLineStateForCycle(12, 0x30);
  assert(a.lineBadLineStartCycle === 15,
    'canonical bad line queues at cycle 15');
  assert(a.lineBadLineInvalidCReadsPending === 0,
    'Bauer §3.14.6: canonical (cycle-15) bad line has 0 invalid c-reads');

  // Cycles 16..51 leave room for the full 3-cycle BA-lead window (55 - start >= 3).
  for (const cyc of [16, 25, 40, 51]) {
    const b = newDmaWindowVic(0);
    b._updateBadLineStateForCycle(cyc, 0x30);
    assert(b.lineBadLineInvalidCReadsPending === 3,
      `Bauer §3.14.6: VSP at cycle ${cyc} reports 3 invalid c-reads (BA-lead inertia)`);
  }
  // Near the end of the window the invalid-c-read count is clamped by the
  // few remaining cycles before fetch-window close at 55.
  {
    const b = newDmaWindowVic(0);
    b._updateBadLineStateForCycle(53, 0x30);
    assert(b.lineBadLineInvalidCReadsPending === 2,
      `Bauer §3.14.6: cycle-53 queue starts at cycle 53 (only c53/c54 fit before the fetch window closes), so invalid-c-reads clamps to 2`);
  }
  console.log('ok  - VSP-2: §3.14.6 — VSP carries 3 invalid c-reads, clamped by remaining fetch-window cycles');
}

// VSP-3: the offset is STICKY and ACCUMULATES — the actual "Variable Screen
// Position" scroll. Per Bauer §3.7.2 rule 2 the first phase of cycle 14
// reloads VC←VCBASE every line, and rule 5 captures VCBASE←VC at cycle 58
// when RC==7. So a DMA-delayed char-row (fewer than 40 g-accesses) leaves
// VCBASE short of a 40-boundary, and because the NEXT char-row starts from
// that same VCBASE the deficit carries forward and grows with each delayed
// row. Two 30-fetch char-rows therefore leave VCBASE=60 (not the aligned
// 80) — the screen has scrolled right by 20 characters. The single-line
// VSP-1 case proves capture; this proves the multi-line accumulation that
// makes VSP a usable scroll.
{
  const vic = newDmaWindowVic(0);   // DEN=1, YSCROLL=0, displayEnabled=true
  vic.vcBase = 0;
  let expected = 0;
  for (let row = 0; row < 2; row++) {
    vic.vc = vic.vcBase;            // rule 2: each char-row reloads VC from VCBASE
    vic.rc = 7;                     // char-row-end line: cycle 58 will capture
    vic.displayActive = true;
    // DMA-delayed bad line — only 30 g-accesses fire instead of the full 40.
    for (let i = 0; i < 30; i++) vic._advanceDisplayStateGAccess();
    // raster 0x40, 0x48: both (&7)==0==YSCROLL → live bad line at c58, so the
    // sequencer stays in display state (rc wraps 7→0) for the next char-row.
    vic._advanceDisplayStateCycle58(0x40 + row * 8);
    expected += 30;
    assert(vic.vcBase === expected,
      `row ${row}: §3.7.2 rule 5 captures VCBASE=${vic.vcBase} (expected ${expected}) — each DMA-delay advances VCBASE by 30, not 40`);
  }
  assert(vic.vcBase === 60,
    'Bauer §3.7.2 rules 2+5 / §3.14.6: two DMA-delayed char-rows leave VCBASE=60 (vs an aligned 80) — the deficit accumulated, scrolling the screen right 20 chars (Variable Screen Position)');
  console.log('ok  - VSP-3: §3.7.2/§3.14.6 — repeated DMA-delays ACCUMULATE the VC deficit (Variable Screen Position scroll)');
}


console.log('\nAll DMA delay / VSP (Bauer §3.14.6) tests passed.');
