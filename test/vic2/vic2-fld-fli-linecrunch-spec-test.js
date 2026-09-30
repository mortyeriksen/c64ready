// VIC-II: FLD / FLI / Linecrunch (Bauer §3.14.2-3.14.4)
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
// FLD / FLI / Linecrunch — Bauer §3.14.2-3.14.4. These are software effects
// driven by YSCROLL ($D011) manipulation against the bad-line predicate
// `(raster & 7) === yscroll`. We assert the observable spec invariants on
// vc/vcBase/rc/displayActive rather than pinning specific cycle order.
// ============================================================================

// FLD-1: §3.14.2 Flexible Line Distance. Holding YSCROLL such that no
// raster matches lets the sequencer stay idle: no bad lines fire and
// displayActive stays false. Then a single matching raster fires exactly
// one bad line and starts a text line.
{
  const vic = makeVic();
  vic.displayEnabled = true;
  // Pre-state: out of any text line. displayActive=false, rc=0.
  vic.displayActive = false;
  vic.rc = 0;
  vic.vc = 0;
  vic.vcBase = 0;

  // YSCROLL=7 — only matches rasters with (raster & 7) === 7.
  vic.regs[0x11] = 0x10 | 0x07;

  // Walk rasters $30..$36 — none match yscroll=7, so no bad line fires.
  for (let r = 0x30; r <= 0x36; r++) {
    assert(vic._isBadLine(r, vic.regs) === false,
      `FLD: raster $${r.toString(16)} is not a bad line with yscroll=7`);
  }

  // Raster $37 matches. Run the cycle-14 transition and verify rc reset
  // (a bad line genuinely fires here).
  const raster = 0x37;
  vic.lineBadLineDisplayPending = false;
  vic._updateBadLineStateForCycle(13, raster);
  assert(vic.lineBadLineDisplayPending === true,
    `FLD: a single matching raster ($37, yscroll=7) does fire a bad line`);
  vic._advanceDisplayStateCycle14(raster);
  assert(vic.rc === 0, `FLD: bad line at the matched raster resets rc to 0`);

  // Now demonstrate the "delayed first bad line" form: skip raster $30
  // (would normally start the text area with yscroll=0), run with
  // yscroll=7 instead, and verify NO bad lines fire on $30..$36.
  {
    const v = makeVic();
    v.displayEnabled = true;
    v.regs[0x11] = 0x10 | 0x07;
    let badLineCount = 0;
    for (let r = 0x30; r <= 0x36; r++) {
      if (v._isBadLine(r, v.regs)) badLineCount++;
    }
    assert(badLineCount === 0,
      `FLD: yscroll=7 across $30..$36 produces zero bad lines (got ${badLineCount})`);
  }

  console.log('ok  - FLD-1: §3.14.2 — YSCROLL holdoff suppresses bad lines until a matched raster');
}

// FLD-2: §3.14.2 — within an active text line, changing YSCROLL so the
// next raster doesn't match delays the next text-line start. Verifies that
// vcBase is captured at cycle 58 of an rc=7 line (normal end-of-text-line
// behavior) but is then NOT reloaded into a new text line until a bad
// line eventually fires.
{
  const vic = makeVic();
  vic.displayEnabled = true;
  vic.displayActive = true;
  vic.rc = 7;
  vic.vc = 200;
  vic.vcBase = 0;
  vic.regs[0x11] = 0x10 | 0x03;          // yscroll=3, but...
  // Pretend the next raster's lower 3 bits are 4, so no bad line fires.
  const raster = 0x34;                    // (0x34 & 7) === 4 ≠ 3 → not bad

  // Cycle 58 of this raster: rc==7 → vcBase = vc, displayActive becomes
  // false because no bad line.
  vic._advanceDisplayStateCycle58(raster);
  assert(vic.vcBase === 200,
    `FLD: cycle 58 with rc=7 captures vc into vcBase (got ${vic.vcBase})`);
  assert(vic.displayActive === false,
    `FLD: cycle 58 turns displayActive off when not a bad line — sequencer goes idle`);

  console.log('ok  - FLD-2: §3.14.2 — sequencer goes idle between text lines when YSCROLL holds off bad lines');
}

// FLI-1: §3.14.3 Flexible Line Interpretation. Forcing a bad line on every
// raster (YSCROLL = raster & 7 in cycle 14) keeps rc resetting to 0 every
// line, so cycle 58 NEVER sees rc==7 → vcBase is NEVER updated → every
// line reads the same screen-row addresses.
{
  const vic = makeVic();
  vic.displayEnabled = true;
  vic.displayActive = true;
  vic.rc = 0;
  vic.vc = 0;
  vic.vcBase = 0x100;                     // arbitrary starting vcBase

  for (let line = 0; line < 8; line++) {
    const raster = 0x30 + line;
    // CPU writes YSCROLL = raster & 7 to force a bad line every line.
    vic.regs[0x11] = 0x10 | (raster & 7);

    vic._advanceDisplayStateCycle14(raster);
    assert(vic.rc === 0,
      `FLI line ${line}: cycle 14 bad line resets rc to 0`);
    assert(vic.vc === 0x100,
      `FLI line ${line}: vc reloaded from vcBase=0x100 every cycle 14 (got 0x${vic.vc.toString(16)})`);

    // Simulate cycles 15-54 g-accesses (40 increments).
    for (let g = 0; g < 40; g++) vic._advanceDisplayStateGAccess();

    vic._advanceDisplayStateCycle58(raster);
    assert(vic.vcBase === 0x100,
      `FLI line ${line}: vcBase NEVER updates because rc was 0, not 7 (got 0x${vic.vcBase.toString(16)})`);
  }

  console.log('ok  - FLI-1: §3.14.3 — every-line bad line keeps vcBase pinned (same matrix row repeats)');
}

// Linecrunch-1: §3.14.4. Begin a bad line, then negate the bad-line
// condition before cycle 14. rc stays at its previous value (7 from end
// of last frame). displayActive is already true (set when bad line
// queued), so cycles 15-54 increment vc 40×, and cycle 58 with rc==7
// captures that into vcBase — effectively `vcBase += 40`. The text line
// was "crunched" into one raster.
{
  const vic = makeVic();
  vic.displayEnabled = true;
  // Pre-state: end-of-previous-frame style. rc=7, displayActive=true,
  // vcBase=N, vc=N.
  vic.displayActive = true;
  vic.rc = 7;
  const startVcBase = 0x40;
  vic.vc = startVcBase;
  vic.vcBase = startVcBase;

  const raster = 0x37;
  // Step 1: bad-line condition true → fetch queued + displayActive set.
  vic.regs[0x11] = 0x10 | 0x07;          // yscroll=7 matches raster $37
  vic._updateBadLineStateForCycle(13, raster);
  assert(vic.lineBadLineDisplayPending === true,
    `linecrunch: bad-line fetch queued at cycle 13`);

  // Step 2: CPU writes YSCROLL ≠ raster&7 between cycles 13 and 14.
  vic.regs[0x11] = 0x10 | 0x06;          // yscroll=6, no longer matches
  vic._updateBadLineStateForCycle(14, raster);
  assert(vic.lineBadLineDisplayPending === false,
    `linecrunch: queued fetch cancelled by cycle-14 bad-line negation`);

  // Step 3: cycle 14 — rc not reset because not a bad line at this point.
  vic._advanceDisplayStateCycle14(raster);
  assert(vic.rc === 7,
    `linecrunch: rc NOT reset (stays at 7); got ${vic.rc}`);
  assert(vic.vc === startVcBase,
    `linecrunch: vc reloaded from vcBase at cycle 14 (got 0x${vic.vc.toString(16)})`);

  // Step 4: cycles 15-54 — displayActive is true → 40 g-accesses bump vc.
  for (let g = 0; g < 40; g++) vic._advanceDisplayStateGAccess();
  assert(vic.vc === startVcBase + 40,
    `linecrunch: vc advances 40 during display-active line (got 0x${vic.vc.toString(16)})`);

  // Step 5: cycle 58 — rc==7 → vcBase = vc. The text line was crunched
  // to one raster; vcBase has effectively jumped ahead 40.
  vic._advanceDisplayStateCycle58(raster);
  assert(vic.vcBase === startVcBase + 40,
    `Bauer §3.14.4: vcBase += 40 after linecrunch (got 0x${vic.vcBase.toString(16)}, want 0x${(startVcBase + 40).toString(16)})`);

  console.log('ok  - Linecrunch-1: §3.14.4 — bad-line negation before cycle 14 jumps vcBase ahead by 40');
}

// Linecrunch-2: §3.14.4 wrap. "VCBASE wraps around to zero when reaching
// 1024." Verify the masking by setting vcBase near 1024 and running one
// crunched line.
{
  const vic = makeVic();
  vic.displayEnabled = true;
  vic.displayActive = true;
  vic.rc = 7;
  vic.vc = 1000;
  vic.vcBase = 1000;
  vic.regs[0x11] = 0x10 | 0x06;          // not a bad line at raster $37

  const raster = 0x37;
  vic._advanceDisplayStateCycle14(raster);
  for (let g = 0; g < 40; g++) vic._advanceDisplayStateGAccess();
  // vc = (1000 + 40) & 0x3FF = 1040 & 0x3FF = 16.
  assert(vic.vc === 16,
    `linecrunch wrap: vc wraps mod 1024 (got ${vic.vc})`);
  vic._advanceDisplayStateCycle58(raster);
  assert(vic.vcBase === 16,
    `Bauer §3.14.4: vcBase wraps mod 1024 once crossing 1024 (got ${vic.vcBase})`);

  console.log('ok  - Linecrunch-2: §3.14.4 — vcBase wraps mod 1024 across the matrix-end boundary');
}


console.log('\nAll FLD / FLI / Linecrunch (Bauer §3.14.2-3.14.4) tests passed.');
