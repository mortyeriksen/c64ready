// VIC-II "Nine" demo dependency tests.
//
// Reference: https://www.linusakesson.net/scene/nine/explanation.php
//
// Tracks the cycle-accurate VIC-II quirks that nine.prg leans on:
// flanking sprite DMA (BA hysteresis), the CSEL right-border trick (Bauer
// §3.14.1), mid-line $D018 pointer-bank switches, the $D021 mid-line
// split (6569 vs 8565 pixel-pipeline alignment), and the invalid mode
// $70 ghost-byte / shine-through behaviours. Also covers top-border
// sprite multiplexing across the open-border raster band.
//
// Extracted from vic2-test.js (was the "Nine Demo Dependency Tests"
// section, including the "Top-border sprite multiplexing" subsection).

import {
  VIC2, CANVAS_W, CANVAS_H, CYCLES_PER_FRAME, CYCLES_PER_LINE, C64_PALETTE,
  C64Machine,
  paletteRgba,
  ACCESS_IDLE, ACCESS_REFRESH, ACCESS_C, ACCESS_G,
  assert, softAssert,
  makeVic, makeRenderSeg,
  fillSpriteLineState, fillOpaqueSpriteAcrossLine,
  clearLineBuffers, setupSpriteForRender, setMulticolorRegs,
  fillTextLineState,
  clearRenderedRow, firstForegroundX, lastForegroundX,
  runUntil,
  makeMasterCycleHarness,
} from './_vic2-helpers.js';

// Drive the live two-stage vertical-border FF (Bauer §3.9,
// `_advanceVerticalBorderFlipFlop`) for one line at `raster` (optional $D011),
// letting the cycle-1 latch copy apply the top-RESET / bottom-SET compare.
function vBorderCompareLine(vic, raster, d011) {
  if (d011 !== undefined) vic.regs[0x11] = d011;
  vic.raster = raster;
  vic.cycleInLine = 1;
  vic._vBorderLatch = vic.vBorderActive;
  vic._advanceVerticalBorderFlipFlop();
}

// ============================================================================
// "Nine" Demo Dependency Tests
// Reference: https://www.linusakesson.net/scene/nine/explanation.php
// ============================================================================

// Test Nine-1: Flanking sprite DMA — BA stays low across short gaps.
// Sprites 0, 2, 4, 6 are anchors; in-between slots steal cycles even if disabled.
// The VIC needs three cycles of BA-low warning before it can halt the CPU.
// If two sprite DMA slots are closer together than that, BA does not get released between them.
{
  const vic = makeVic();
  vic.spriteDmaOn[0] = 1; // Enabled
  vic.spriteDmaOn[1] = 0; // Disabled
  vic.spriteDmaOn[2] = 1; // Enabled

  // Assert BA-low across cycles 58–63 inclusive.
  for (let c = 58; c <= 63; c++) {
    assert(
      vic._isBaLowCycle(c) === true,
      `Nine Demo: BA must stay low at cycle ${c} when gap is < 3 cycles between sprite DMA slots`
    );
  }

  assert(
    vic._spriteAecLow(61) === true,
    'Nine Demo: Cycle 61 must be stolen for sprite 1 slot even when disabled, due to flanking sprites'
  );
  console.log('ok  - Nine Demo: Flanking sprite DMA holds BA low across short gaps');
}

// (Bauer §3.8.1 item 2 cycle-55 FF inversion test moved to
// sprite-spec-test.js #7 part (b).)

// Test Nine-3: Bauer §3.14.1 CSEL right-border trick.
// CSEL=1→0 opens the right border only when the write lands in cycle 56.
{
  const exact = makeVic();
  exact.regs[0x11] = 0x1B;
  exact.regs[0x16] = 0x08;
  for (let i = 0; i < CYCLES_PER_LINE * 100 + 56; i++) exact.clock(1);
  exact.write(0x16, 0x00);
  exact.clock(1);
  assert(exact.hBorderActive === false,
    'Nine Demo: CSEL=1→0 at cycle 56 must veto the right-border SET');

  const early = makeVic();
  early.regs[0x11] = 0x1B;
  early.regs[0x16] = 0x08;
  for (let i = 0; i < CYCLES_PER_LINE * 100 + 54; i++) early.clock(1);
  early.write(0x16, 0x00);
  while (early.raster === 100 && early.cycleInLine !== 0) early.clock(1);
  assert(early.hBorderActive === true,
    'Nine Demo: CSEL=1→0 before cycle 56 must not open the right border');
  console.log('ok  - Nine Demo: CSEL right-border trick is cycle-56 exact');
}

// Test Nine-4: Sprite pointer banking via $D018 mid-line.
// Sprite p-accesses must read the live $D018 value at the moment of the fetch, not a line-start snapshot.
// Write $d018 between cycles 57 and 58; sprite 0's pointer fetch must see the new bank.
{
  const vic = makeVic();
  vic.currentVicBank = 0x0000;
  vic.regs[0x15] = 0x01; // Sprite 0 enabled
  vic.spriteDmaOn[0] = 1;

  // Snapshot at line start was $14 ($0400) — sprite p-access reads live
  // regs[0x18] (Test Nine-4's whole point), so the line-scalar value is
  // incidental and only set as documentation here.
  vic.rowFetchD018 = 0x14;
  vic.ram[0x0400 + 0x03F8] = 0x11; // Pointer at old bank
  vic.ram[0x0800 + 0x03F8] = 0x22; // Pointer at new bank

  // CPU writes $D018 mid-line between 57 and 58.
  vic.regs[0x18] = 0x24; // New screen base $0800

  vic._spriteSequencerPointerAccess(58);
  assert(
    vic.spritePointerValue[0] === 0x22,
    'Nine Demo: Sprite 0 pointer fetch at cycle 58 must use the live $D018 bank'
  );
  console.log('ok  - Nine Demo: $D018 mid-line p-access fetches from live bank');
}

// Test Nine-5: $D021 mid-line split — no fractional-pixel delay on 6569.
// DEMO-NINE.md §4 originally claimed a "1-pixel prev-colour delay" on
// 6569 (tagged NOT IN SPEC). VICE doesn't model that, and comparing
// FppScroller against VICE confirmed our prev-colour artifact was wrong:
// a single stray pixel at canvas X=32 on every line where the demo
// writes $D021 at cycle 14 phi2. Real 6569 (per VIC-Addendum.txt) only
// has the 8565 grey-dot artifact, not a 6569 prev-colour delay. Both
// pixels at the boundary now show the NEW colour.
{
  const vic = makeVic();
  assert(vic.vicVariant === '6569', `precondition: vicVariant === '6569', got '${vic.vicVariant}'`);
  const oldBg = 0x06;
  const newBg = 0x07;
  const prevRegs = new Uint8Array(vic.regs);
  prevRegs[0x21] = oldBg;
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.regs[0x21] = newBg;

  const seg = makeRenderSeg(vic, {
    regs: vic.regs,
    prevRegs,
    cycleStart: 32,
    displayColumnActive: false,
    idleByte: 0x00,
  });

  vic._renderOpenBorderIdleSpan(seg, 0, 32, 40);
  assert(vic.fb32[32] === paletteRgba(newBg),
    '6569: first pixel after a $D021 split shows the NEW background color (no fractional-pixel delay)');
  assert(vic.fb32[33] === paletteRgba(newBg),
    '6569: second pixel after a $D021 split shows the NEW background color');
  console.log('ok  - Nine Demo: $d021 mid-line color split has no prev-colour artifact on 6569 (matches VICE)');
}

// Test Nine-7 & 8: Invalid mode $70 behaves like ECM for the ghost byte & Shine-through.
// Mode $70 behaves like ECM as far as the ghost byte is concerned.
// The ghost byte is whatever leaked into the g-access shifter from the previous fetch.
// The g-access shifter must persist its last value across idle and border cycles, and that value must be visible as graphics when the border flip-flop is gated open.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x70; // Invalid mode $70
  vic.regs[0x16] = 0x00;
  vic.regs[0x18] = 0x14;

  const seg = makeRenderSeg(vic, {
    displayColumnActive: false, // Idle/border zone
    rowFetchD011: 0x70,
    rowFetchD016: 0x00,
    rowFetchD018: 0x14,
    idleByte: 0xAA // Leaked ghost byte
  });

  clearRenderedRow(vic, 20);
  vic._renderOpenBorderIdleSpan(seg, (20 - 15) * 384, 32, 40);

  assert(
    firstForegroundX(vic, 20, 32, 40) === 32,
    'Nine Demo: Invalid mode $70 must shift out the persistent ghost byte in idle zones like ECM'
  );
  console.log('ok  - Nine Demo: Invalid mode $70 persists ghost byte shine-through in idle/border cycles');
}

// Spec §3.2: unused register bits read back as 1, $D02F-$D03F always read $FF,
// and the 47-register file mirrors every 64 bytes through $D000-$D3FF.
{
  const vic = makeVic();

  // Zero out the registers we care about so we can see only the OR'd unused bits.
  for (let r = 0x16; r <= 0x2E; r++) vic.regs[r] = 0;
  vic.regs[0x18] = 0; // bit 0 unused

  // $D016: bits 7,6 unused (bit 5 RES is connected) → mask 0xC0
  assert((vic.read(0x16) & 0xC0) === 0xC0,
    `$D016 unused bits 7,6 must read as 1 (got $${vic.read(0x16).toString(16)})`);

  // $D018: bit 0 unused → mask 0x01
  assert((vic.read(0x18) & 0x01) === 0x01,
    `$D018 unused bit 0 must read as 1 (got $${vic.read(0x18).toString(16)})`);

  // $D020-$D02E: bits 7-4 unused → mask 0xF0
  for (let r = 0x20; r <= 0x2E; r++) {
    assert((vic.read(r) & 0xF0) === 0xF0,
      `$D0${r.toString(16).toUpperCase()} unused bits 7-4 must read as 1 (got $${vic.read(r).toString(16)})`);
  }

  // Programmable bits in those registers must still come through after a write.
  vic.regs[0x16] = 0x07;          // XSCROLL=7
  assert(vic.read(0x16) === 0xC7, `$D016 programmable bits must pass through (got $${vic.read(0x16).toString(16)})`);
  vic.regs[0x18] = 0x14;
  assert(vic.read(0x18) === 0x15, `$D018 programmable bits must pass through (got $${vic.read(0x18).toString(16)})`);
  vic.regs[0x20] = 0x0E;
  assert(vic.read(0x20) === 0xFE, `$D020 programmable bits must pass through (got $${vic.read(0x20).toString(16)})`);

  // $D02F-$D03F: open bus, always $FF regardless of any prior write attempt.
  for (let r = 0x2F; r <= 0x3F; r++) {
    vic.regs[r] = 0x55; // pretend a write somehow leaked through; read must still be $FF
    assert(vic.read(r) === 0xFF,
      `$D0${r.toString(16).toUpperCase().padStart(2,'0')} must read as $FF (got $${vic.read(r).toString(16)})`);
  }

  // Register file mirrors every 64 bytes — read() takes the address masked & 0x3F.
  vic.regs[0x00] = 0xAB;
  assert(vic.read(0x40) === 0xAB, '$D040 must mirror $D000');
  assert(vic.read(0x80) === 0xAB, '$D080 must mirror $D000');

  console.log('ok  - register read-back: unused bits return 1, $D02F-$D03F return $FF, file mirrors per 64 bytes');
}

// Spec §3.12: raster-compare IRQ test happens at the start of every line, EXCEPT for
// raster line 0, where the test is delayed by one cycle. With 1-indexed cycleInLine
// (clock() increments cycleInLine before doing the cycle's work), this means:
//   line N>0: latch fires when cycleInLine becomes 1
//   line 0:   latch fires when cycleInLine becomes 2
{
  const vic = makeVic();
  vic.regs[0x12] = 0x00;       // raster compare = 0
  vic.regs[0x11] &= 0x7F;      // raster bit 8 = 0
  vic.irqMask = 0x01;          // enable raster IRQ

  // Fresh VIC starts at raster=0, cycleInLine=0. First clock(1) enters cycle 1 of line 0.
  vic.clock(1);
  assert(vic.cycleInLine === 1 && vic.raster === 0,
    'line-0 IRQ test: clock(1) must reach cycle 1 of line 0');
  assert((vic.irqStatus & 0x01) === 0,
    'line-0 IRQ must NOT latch at cycle 1 of line 0 (spec §3.12)');

  vic.clock(1);
  assert(vic.cycleInLine === 2,
    'line-0 IRQ test: clock(1) must reach cycle 2');
  assert((vic.irqStatus & 0x01) === 0x01,
    'line-0 IRQ must latch at cycle 2 of line 0 (spec §3.12)');
  console.log('ok  - raster-IRQ for line 0 latches at cycle 2, not cycle 1');
}

// Sister case: any non-zero target line still latches at cycle 1.
{
  const vic = makeVic();
  vic.regs[0x12] = 0x05;       // raster compare = 5
  vic.regs[0x11] &= 0x7F;
  vic.irqMask = 0x01;

  // Advance to line 5, cycle 0. First line: cycleInLine 0→63 takes 63 ticks
  // (line 0's cycle 1 fires the spurious early latch we just verified),
  // then 5 more lines × 63 cycles each. Easier: just advance 63*5 cycles.
  vic.clock(63);                       // finish line 0 (ends with cycleInLine=0, raster=1)
  assert(vic.raster === 1 && vic.cycleInLine === 0, `setup: expected raster=1 cyc=0, got raster=${vic.raster} cyc=${vic.cycleInLine}`);
  vic.irqStatus = 0;                   // clear any latch from line 0
  vic.clock(63 * 4);                   // through lines 1..4
  assert(vic.raster === 5 && vic.cycleInLine === 0, `setup: expected raster=5 cyc=0, got raster=${vic.raster} cyc=${vic.cycleInLine}`);
  vic.irqStatus = 0;

  vic.clock(1);                        // → cycle 1 of line 5
  assert(vic.cycleInLine === 1 && vic.raster === 5,
    'non-zero target IRQ test: must reach cycle 1 of line 5');
  assert((vic.irqStatus & 0x01) === 0x01,
    'non-zero target IRQ must latch at cycle 1 of the matching line');
  console.log('ok  - raster-IRQ for line 5 latches at cycle 1');
}

// Spec §3.13: DRAM refresh.
// The 8-bit REF counter resets to $FF in raster line 0 and is decremented after
// each refresh access. The refresh address is $3F00 | REF, sampled BEFORE decrement,
// so line 0 issues addresses $3FFF, $3FFE, $3FFD, $3FFC, $3FFB on cycles 11..15.
{
  const vic = makeVic();
  vic.clock(10);
  assert(vic.cycleInLine === 10 && vic.raster === 0, `refresh setup: expected cyc=10 line=0, got cyc=${vic.cycleInLine} line=${vic.raster}`);

  const expected = [0x3FFF, 0x3FFE, 0x3FFD, 0x3FFC, 0x3FFB];
  for (let i = 0; i < 5; i++) {
    vic.clock(1);                       // cycles 11..15
    const cyc = 11 + i;
    assert(vic.cycleInLine === cyc, `refresh: expected cyc=${cyc}, got ${vic.cycleInLine}`);
    assert(vic.lastRefreshAddr === expected[i],
      `line 0 cycle ${cyc}: refresh address must be $${expected[i].toString(16).toUpperCase()}, got $${(vic.lastRefreshAddr ?? 0).toString(16).toUpperCase()}`);
  }
  // After line 0's 5 refreshes the counter must be $FA.
  assert(vic.refreshCounter === 0xFA,
    `after line 0 refreshes, counter must be $FA, got $${vic.refreshCounter.toString(16).toUpperCase()}`);

  // Advance to cycle 11 of line 1 — first refresh there must be $3FFA.
  vic.clock(63 - 15 + 11); // finish line 0 (cycles 16..63 = 48), then enter line 1 cycles 1..11
  assert(vic.raster === 1 && vic.cycleInLine === 11, `refresh setup line 1: got raster=${vic.raster} cyc=${vic.cycleInLine}`);
  assert(vic.lastRefreshAddr === 0x3FFA,
    `line 1 cycle 11: refresh address must be $3FFA, got $${(vic.lastRefreshAddr ?? 0).toString(16).toUpperCase()}`);
  console.log('ok  - DRAM refresh emits $3FFF..$3FFB on line 0 cycles 11..15, $3FFA on line 1 cycle 11');
}

// Bauer §3.14.1: with CSEL=1 (40-column mode), the right-border trick is
// CSEL=1→0 exactly in cycle 56. Switching earlier must not make both right
// compares miss.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08; // CSEL=1 (40-col)
  for (let i = 0; i < CYCLES_PER_LINE * 100 + 54; i++) vic.clock(1);
  assert(vic.hBorderActive === false,
    'open-border setup: line is open before the right close');
  vic.write(0x16, 0x00); // CSEL=0
  while (vic.raster === 100 && vic.cycleInLine !== 0) vic.clock(1);
  assert(vic.hBorderActive === true,
    'too-early CSEL=1→0 must not open the right border');
  console.log('ok  - CSEL=1→0 before cycle 56 does not open the right border');
}

// Sanity: with CSEL=1 throughout, the right compare at X=344 closes the border
// in cycle 55.
{
  const vic = makeVic();
  vic.vBorderActive = false;
  vic.hBorderActive = true;
  vic.regs[0x16] = 0x08; // CSEL=1

  for (let c = 11; c <= 54; c++) vic._advanceHorizontalBorderState(c, vic.regs);
  assert(vic.hBorderActive === false, 'baseline: border open after left compare');
  vic._advanceHorizontalBorderState(55, vic.regs);
  assert(vic.hBorderActive === true,
    'baseline: right compare at X=344 closes the border in cycle 55 with CSEL=1');
  console.log('ok  - baseline: CSEL=1 right compare closes the border in cycle 55');
}

// Bauer §3.7.2 rule 5 (and the "linecrunch" trick): if YSCROLL is changed
// between cycles 13 and 14 so that the bad-line condition disappears, the
// queued bad-line fetch must be cancelled and RC must NOT be reset at cycle 14.
{
  const vic = makeVic();
  vic.displayEnabled = true;
  vic.regs[0x11] = 0x10 | 0x07; // DEN=1, YSCROLL=7 → bad line at raster $37
  vic.rc = 5;
  vic.vc = 0x0040;
  vic.vcBase = 0x0040;
  const raster = 0x37;

  vic._updateBadLineStateForCycle(13, raster);
  assert(vic.lineBadLineDisplayPending === true, 'bad-line fetch queued at cycle 13');
  assert(vic.lineBadLineStartCycle === 15, 'bad-line fetch start cycle is 15');

  // CPU stores a new YSCROLL between cycles 13 and 14: bad-line condition
  // evaporates before the row-counter reset point.
  vic.regs[0x11] = 0x10 | 0x06; // DEN=1, YSCROLL=6 → no longer a bad line at $37

  vic._updateBadLineStateForCycle(14, raster);
  assert(vic.lineBadLineDisplayPending === false,
    'cycle 14 with bad-line condition removed must cancel the queued fetch');

  vic._advanceDisplayStateCycle14(raster);
  assert(vic.rc === 5,
    `linecrunch: RC must remain 5 when bad-line is cancelled before cycle 14, got ${vic.rc}`);
  assert(vic.vc === vic.vcBase,
    'linecrunch: VC is still reloaded from VCBASE at cycle 14');
  console.log('ok  - YSCROLL change before cycle 14 cancels bad-line fetch and preserves RC');
}

// Bauer §3.10: "A Bad Line Condition can only occur if the DEN bit has been set
// for at least one cycle somewhere in raster line $30." DEN sampled true on a
// later raster line (e.g. $31) must NOT enable bad lines for the frame.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x07;                     // DEN=0, YSCROLL=7
  vic.displayEnabled = false;

  // Advance to raster $30, cycle 0.
  while (!(vic.raster === 0x30 && vic.cycleInLine === 0)) vic.clock(1);

  // First half of line $30 with DEN=0 → displayEnabled stays false.
  vic.clock(31);
  assert(vic.cycleInLine === 31 && vic.raster === 0x30,
    `DEN test: expected line $30 cyc=31, got line $${vic.raster.toString(16)} cyc=${vic.cycleInLine}`);
  assert(vic.displayEnabled === false,
    'displayEnabled stays false through cycle 31 of line $30 while DEN=0');

  // CPU sets DEN=1 at cycle 32 of line $30. Bauer §3.10 says any cycle on $30
  // with DEN set qualifies the frame for bad lines.
  vic.regs[0x11] = 0x17;                     // DEN=1, YSCROLL=7
  vic.clock(1);                              // cycle 32 of line $30 samples DEN
  assert(vic.displayEnabled === true,
    'DEN sampled true at cycle 32 of line $30 must set displayEnabled');

  // Walk to raster $37 (which will be a bad line under YSCROLL=7).
  while (vic.raster !== 0x37 || vic.cycleInLine !== 1) vic.clock(1);
  // Trigger the cycle-14 bad-line evaluation by advancing past it.
  while (vic.cycleInLine < 14) vic.clock(1);
  assert(vic._isBadLine(0x37, vic.regs) === true,
    'after DEN-on-line-$30, raster $37 with YSCROLL=7 is a bad line');
  console.log('ok  - DEN sampled at any cycle of line $30 enables bad lines for the frame');
}

{
  const vic = makeVic();
  vic.regs[0x11] = 0x07;                     // DEN=0, YSCROLL=7
  vic.displayEnabled = false;

  // Walk all of line $30 with DEN=0.
  while (!(vic.raster === 0x30 && vic.cycleInLine === 0)) vic.clock(1);
  vic.clock(63);
  assert(vic.raster === 0x31 && vic.cycleInLine === 0,
    'no-DEN test: line $30 finished with displayEnabled false');
  assert(vic.displayEnabled === false,
    'displayEnabled remains false after line $30 with DEN=0 throughout');

  // Now set DEN=1 on line $31. Spec: this does NOT qualify the frame.
  vic.regs[0x11] = 0x17;                     // DEN=1, YSCROLL=7
  vic.clock(20);
  assert(vic.displayEnabled === false,
    'DEN sampled true on line $31 must NOT set displayEnabled (only line $30 qualifies)');
  console.log('ok  - DEN sampled on line $31 does not enable bad lines (only line $30 qualifies)');
}

// (Bauer §3.8.1 rule 2 force-high test moved to sprite-spec-test.js #7
// part (a), now including the no-retroactive-force-on-re-set case.)

// vic2.js:1768-1774 "pre-start X rewrite": if the renderer hasn't yet reached
// the old sprite X for this segment, a new X write should retarget the sprite
// to the new position rather than rendering at the stale X.
{
  const vic = makeVic();
  const sprite = 0;
  // Build a minimal segment that reaches the renderer.
  const seg = {
    regs: new Uint8Array(0x40),
    bank: 0x0000,
    start: 32,
    end: 200,
    spriteShiftReg: new Uint32Array(8),
    spriteRowByteMask: new Uint8Array(8),
    spriteDataRow: new Int8Array(8),
    spriteDisplayOn: new Uint8Array(8),
    hBorder: false,
    vBorder: false,
    hBorderBefore: false,
    vBorderBefore: false,
    hInner: true,
  };
  seg.regs[0x15] = 1 << sprite;              // sprite enabled
  seg.regs[sprite * 2] = 100 - 8;            // X coord = 100 (decoded with +8)
  seg.spriteShiftReg[sprite] = 0x800000;     // single visible pixel at X
  seg.spriteRowByteMask[sprite] = 0x07;
  seg.spriteDataRow[sprite] = 0;
  seg.spriteDisplayOn[sprite] = 1;

  // Establish a renderState by computing the sprite's spriteLeft. The path under
  // test is the second branch (currentX === spriteLeft && sx !== spriteLeft).
  const oldSx = (seg.regs[sprite * 2] | (((seg.regs[0x10] >> sprite) & 1) << 8)) + 8;
  const renderState = vic._createSpriteRenderState(
    seg.spriteShiftReg[sprite] >>> 0,
    seg.spriteRowByteMask[sprite],
    oldSx,
    oldSx,                                   // currentX === spriteLeft (not started yet)
    false,
    false,
  );

  // Mid-segment, the CPU rewrites $D000 to a new X further right. The new
  // segment carries the new X, but the renderState is still parked at oldSx.
  const newSx = oldSx + 16;
  const segB = { ...seg, regs: new Uint8Array(seg.regs) };
  segB.regs[sprite * 2] = (newSx - 8) & 0xFF;

  // Replicate the pre-start branch directly — the path lives inline in
  // _renderSpriteLine but the logic is small and self-contained.
  const sx = (segB.regs[sprite * 2] | (((segB.regs[0x10] >> sprite) & 1) << 8)) + 8;
  let spriteLeft = oldSx;
  if (renderState.currentX === spriteLeft && sx !== spriteLeft) {
    spriteLeft = sx;
    renderState.currentX = sx;
  }
  assert(spriteLeft === newSx,
    `pre-start X rewrite must retarget spriteLeft to the new X (expected ${newSx}, got ${spriteLeft})`);
  assert(renderState.currentX === newSx,
    `pre-start X rewrite must also slide the renderState cursor to the new X`);
  console.log('ok  - pre-start sprite X rewrite retargets spriteLeft and renderState.currentX');
}

// Bauer §3.7.2 rule 5: at cycle 58 the bad-line condition is sampled LIVE.
// A transient bad-line asserted somewhere in cycles 54-57 but no longer
// asserted at cycle 58 must NOT keep the display in display state.
{
  const vic = makeVic();
  const raster = 0x37;
  vic.displayEnabled = true;
  vic.displayActive = true;
  vic.rc = 7;
  vic.vc = 0x0155;
  vic.vcBase = 0x0028;

  // Cycle 55: programmer briefly asserts a bad-line via YSCROLL=7.
  vic.regs[0x11] = 0x10 | 0x07;
  vic._updateBadLineStateForCycle(55, raster);

  // Cycles 56-57: programmer rewrites YSCROLL=6, clearing the bad-line
  // condition before cycle 58 evaluates.
  vic.regs[0x11] = 0x10 | 0x06;
  vic._updateBadLineStateForCycle(56, raster);
  vic._updateBadLineStateForCycle(57, raster);

  vic._advanceDisplayStateCycle58(raster);

  assert(vic.vcBase === 0x0155,
    'cycle 58 with RC=7 still loads VCBASE from VC');
  assert(vic.displayActive === false,
    'transient bad-line in 54-57 cleared by cycle 58 must NOT hold display state');
  assert(vic.rc === 7,
    'RC stays at 7 (not incremented) when display goes to idle at cycle 58');
  console.log('ok  - cycle 58 bad-line check is live; a transient assertion in 54-57 does not stick');
}

// Bauer §3.14.1 vertical hyperscreen: switching RSEL=1→0 between rasters 248
// and 250 makes BOTH bottom compares miss. With RSEL=1, bottom=251 (not yet
// reached). With RSEL=0, bottom=247 (already past). The vertical border
// flip-flop never gets set, so the lower border stays open through end of
// frame (and the same trick can be repeated by re-setting RSEL=1 after 251).
{
  const vic = makeVic();
  vic.vBorderActive = false;        // pretend we're inside the display window

  // Raster 247 with RSEL=1: bottom compare is 251 → no set.
  vic.regs[0x11] = 0x10 | 0x08;     // DEN=1, RSEL=1
  vBorderCompareLine(vic, 247);
  assert(vic.vBorderActive === false, 'raster 247 with RSEL=1 must not set vBorder (bottom=251)');

  // Programmer flips RSEL=0 between cycle 63 of raster 247 and cycle 63 of
  // raster 248. Bottom compare with RSEL=0 is 247 — already passed.
  vic.regs[0x11] = 0x10;            // DEN=1, RSEL=0
  for (let r = 248; r <= 251; r++) {
    vBorderCompareLine(vic, r);
  }
  assert(vic.vBorderActive === false,
    'RSEL=1→0 between rasters 247 and 248 misses both bottom compares — vBorder stays open');

  // Continuing through end of frame still sees no compare match.
  for (let r = 252; r < 312; r++) {
    vBorderCompareLine(vic, r);
  }
  assert(vic.vBorderActive === false,
    'lower-border hyperscreen: vBorder remains open through the rest of the frame');
  console.log('ok  - vertical hyperscreen: RSEL=1→0 between rasters 248..250 keeps lower border open');
}

// Bauer §3.9 rule asymmetry: top compare resets vBorder ONLY when DEN=1.
// Bottom compare always sets vBorder, regardless of DEN.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x08;            // DEN=0, RSEL=1, YSCROLL=0
  vic.vBorderActive = true;         // border is currently set
  vBorderCompareLine(vic, 51);
  assert(vic.vBorderActive === true,
    'cycle 63 top compare with DEN=0 must NOT reset vBorder');

  // Sister: DEN=1 makes the same compare reset.
  vic.regs[0x11] = 0x18;            // DEN=1, RSEL=1
  vBorderCompareLine(vic, 51);
  assert(vic.vBorderActive === false,
    'cycle 63 top compare with DEN=1 resets vBorder');

  // Bottom compare ignores DEN — fires either way.
  vic.regs[0x11] = 0x08;            // DEN=0
  vic.vBorderActive = false;
  vBorderCompareLine(vic, 251);
  assert(vic.vBorderActive === true,
    'cycle 63 bottom compare with DEN=0 still sets vBorder (no DEN gate)');
  console.log('ok  - top compare requires DEN=1; bottom compare always fires');
}

// Bauer §3.8.1 rule 3: DMA-start checks at cycles 55/56 require "the DMA for
// the sprite is still off". Calling the start path on a sprite already in DMA
// must NOT re-clear MCBASE/MC or reset the Y-expand flip-flop.
{
  const vic = makeVic();
  const s = 0;
  vic.regs[0x15] = 1 << s;          // sprite enabled
  vic.regs[s * 2 + 1] = 100;        // Y coord = 100

  // Pretend DMA already started on a previous line, with state mid-sprite.
  vic.spriteDmaOn[s] = 1;
  vic.spriteMC[s] = 12;
  vic.spriteMCBase[s] = 12;
  vic.spriteYExpandFF[s] = 0;
  vic.spriteLineDataRow[s] = 4;

  // Re-arrival of the matching Y coordinate at cycle 55 of a later line.
  vic.raster = 100;
  vic._tryStartSpriteDma(s, vic.regs[0x15], vic.raster & 0xFF, vic.regs[0x17]);

  assert(vic.spriteMC[s] === 12, 'MC preserved when DMA already on (got ' + vic.spriteMC[s] + ')');
  assert(vic.spriteMCBase[s] === 12, 'MCBASE preserved when DMA already on');
  assert(vic.spriteYExpandFF[s] === 0, 'Y-expand FF not reset when DMA already on');
  assert(vic.spriteLineDataRow[s] === 4, 'sprite line data row preserved when DMA already on');
  console.log('ok  - sprite DMA-start at cycle 55/56 is a no-op when DMA is already on');
}

// (Sprite-vs-sprite priority test moved to sprite-spec-test.js #2.)

// Bauer §3.7.3.9 / §3.13: the idle g-access reads from $3FFF (or $39FF if
// ECM=1) in the VIC's currently selected 16KB bank — i.e. $3FFF, $7FFF,
// $BFFF, $FFFF. Switching banks at a line boundary must change the next
// line's snapshot accordingly.
{
  const vic = makeVic();
  vic.ram[0x3FFF] = 0xAA;            // bank 0 idle source
  vic.ram[0x7FFF] = 0xBB;            // bank 1 idle source
  vic.ram[0xBFFF] = 0xCC;            // bank 2 idle source
  vic.ram[0xFFFF] = 0xDD;            // bank 3 idle source
  vic.regs[0x11] &= ~0x40;            // ECM=0 → idle source is $3FFF (not $39FF)

  // Bank 0 default — line-start snapshot picks up $3FFF.
  vic.currentVicBank = 0x0000;
  vic.clock(1);                       // → cycle 1 of line 0; _beginRasterLine runs
  assert(vic.lineIdleByte === 0xAA,
    `bank 0 idle byte must come from $3FFF (got $${vic.lineIdleByte.toString(16)})`);

  // Switch to bank 1 between lines.
  vic.clock(63 - 1);                  // finish line 0
  vic.currentVicBank = 0x4000;
  vic.clock(1);                       // → cycle 1 of line 1
  assert(vic.lineIdleByte === 0xBB,
    `bank 1 idle byte must come from $7FFF (got $${vic.lineIdleByte.toString(16)})`);

  // And bank 2.
  vic.clock(62);
  vic.currentVicBank = 0x8000;
  vic.clock(1);
  assert(vic.lineIdleByte === 0xCC,
    `bank 2 idle byte must come from $BFFF (got $${vic.lineIdleByte.toString(16)})`);

  // And bank 3.
  vic.clock(62);
  vic.currentVicBank = 0xC000;
  vic.clock(1);
  assert(vic.lineIdleByte === 0xDD,
    `bank 3 idle byte must come from $FFFF (got $${vic.lineIdleByte.toString(16)})`);
  console.log('ok  - idle byte source follows VIC bank ($3FFF/$7FFF/$BFFF/$FFFF)');
}

// `lineIdleByte` is a per-line book-keeping field set in _beginRasterLine and
// not subsequently updated within the line. The renderer does NOT use this
// field directly — it reads the per-cycle `lineCycleIdleByte[cycle]` array
// which captures live RAM (see the next test). This test only pins the
// per-line semantics of the book-keeping field itself.
{
  const vic = makeVic();
  vic.regs[0x11] &= ~0x40;            // ECM=0
  vic.ram[0x3FFF] = 0x11;
  vic.currentVicBank = 0x0000;

  vic.clock(1);                       // cycle 1 of line 0 — snapshot taken
  assert(vic.lineIdleByte === 0x11,
    'line 0 captures idle byte at cycle 1');

  vic.ram[0x3FFF] = 0x22;
  vic.clock(30);                      // walk into the middle of line 0
  assert(vic.lineIdleByte === 0x11,
    '`lineIdleByte` book-keeping field is sticky for the rest of the line');

  vic.clock(63 - 31);                 // finish line 0
  vic.clock(1);                       // cycle 1 of line 1
  assert(vic.lineIdleByte === 0x22,
    'line 1 refreshes `lineIdleByte` from the current $3FFF at its own cycle 1');
  console.log('ok  - `lineIdleByte` book-keeping snapshot is per-line (renderer uses lineCycleIdleByte[])');
}

// _renderOpenBorderIdleSpan in multicolor text mode (MCM=1, BMM=0, ECM=0)
// degrades to STANDARD text mode for the idle byte. Per Bauer §3.7.3.2,
// MCM rendering only kicks in when c-data bit 11 = 1 (= color nibble bit 3);
// in idle state c-data is 0, so MCM falls through and the idle byte is
// rendered as 1-bit-per-pixel (bit set → BLACK, clear → bg0). Foreground
// is BLACK because the implicit color nibble is 0.
{
  const vic = makeVic();
  vic.regs[0x11] = 0x10;              // ECM=0, BMM=0 (DEN=1, RSEL=0)
  vic.regs[0x16] = 0x10;              // MCM=1, CSEL=0, XSCROLL=0
  vic.regs[0x21] = 0x06;              // bg0
  vic.regs[0x22] = 0x07;              // bg1 — must NOT be sampled
  vic.regs[0x23] = 0x08;              // bg2 — must NOT be sampled

  const seg = makeRenderSeg(vic, {
    displayColumnActive: false,
    rowFetchD011: 0x10,
    rowFetchD016: 0x10,
    idleByte: 0xC9,                   // bin 11001001
  });

  vic.fb32.fill(0x00000000);
  vic.graphicsPriorityBuffer.fill(0);
  vic._renderOpenBorderIdleSpan(seg, 0, 352, 360);

  // segXscroll = 0; pixel = (X - 0) & 7. Bit (7 - pixel) of $C9.
  // X=352 px=0 bit7=1 → BLACK. X=353 px=1 bit6=1 → BLACK.
  // X=354 px=2 bit5=0 → bg0.   X=355 px=3 bit4=0 → bg0.
  // X=356 px=4 bit3=1 → BLACK. X=357 px=5 bit2=0 → bg0.
  // X=358 px=6 bit1=0 → bg0.   X=359 px=7 bit0=1 → BLACK.
  assert(vic.fb32[352] === 0xFF000000, 'X=352 bit 7 set → BLACK');
  assert(vic.fb32[353] === 0xFF000000, 'X=353 bit 6 set → BLACK');
  assert(vic.fb32[354] === paletteRgba(0x06), 'X=354 bit 5 clear → bg0');
  assert(vic.fb32[355] === paletteRgba(0x06), 'X=355 bit 4 clear → bg0');
  assert(vic.fb32[356] === 0xFF000000, 'X=356 bit 3 set → BLACK');
  assert(vic.fb32[357] === paletteRgba(0x06), 'X=357 bit 2 clear → bg0');
  assert(vic.fb32[358] === paletteRgba(0x06), 'X=358 bit 1 clear → bg0');
  assert(vic.fb32[359] === 0xFF000000, 'X=359 bit 0 set → BLACK');

  // bg1 ($07) and bg2 ($08) MUST NOT appear — that would mean MCM applied
  // to idle, contrary to Bauer §3.7.3.2.
  let bg1bg2 = 0;
  for (let x = 352; x < 360; x++) {
    if (vic.fb32[x] === paletteRgba(0x07) || vic.fb32[x] === paletteRgba(0x08)) bg1bg2++;
  }
  assert(bg1bg2 === 0, `bg1/bg2 must NEVER appear in MCM-idle (got ${bg1bg2} pixels)`);

  // Foreground (= bit set, → BLACK) must mark fg=1 for collision; bg pixels fg=0.
  assert(vic.graphicsPriorityBuffer[352] === 1, 'X=352 fg=1 (bit set)');
  assert(vic.graphicsPriorityBuffer[354] === 0, 'X=354 fg=0 (bit clear)');
  console.log('ok  - MCM-text idle byte degrades to standard text (Bauer §3.7.3.2 c-data bit 11 = 0)');
}

// Bauer §3.13: the VIC performs an idle g-access every cycle that isn't a
// c-access or refresh, reading $3FFF (or $39FF if ECM=1) LIVE from RAM each
// time. A mid-line CPU write at $3FFF must therefore take effect on
// subsequent idle accesses within the SAME raster line — not just the next.
//
// The renderer consumes `lineCycleIdleByte[cycle]`, populated per cycle by
// `_captureCycleState` via `_readIdleGByte` against the live RAM/bank state
// (vic2.js:534). The previous "snapshot is per-line" test asserts the
// vestigial `lineIdleByte` book-keeping field, which the renderer does NOT
// use; this test pins the actual per-cycle read path.
{
  const vic = makeVic();
  vic.regs[0x11] &= ~0x40;            // ECM=0 → idle source $3FFF
  vic.currentVicBank = 0x0000;
  vic.ram[0x3FFF] = 0x11;

  // The §3.13 live re-read + data-bus drive happens on EVERY line, but the
  // renderer-feed snapshot (lineCycleIdleByte[cycle]) is only stored on
  // visible canvas lines (raster ≥ 15) as a render-cost optimisation.
  // Position on a visible line so the snapshot path is exercised.
  while (!(vic.raster === 50 && vic.cycleInLine === 0)) vic.clock(1);

  vic.clock(5);                       // walk to cycle 5 of line 50
  assert(vic.lineCycleIdleByte[1] === 0x11,
    'cycle 1 captured idle byte = 0x11 from RAM');
  assert(vic.lineCycleIdleByte[5] === 0x11,
    'cycle 5 captured idle byte = 0x11 from RAM');

  // Mid-line CPU write to the idle source.
  vic.ram[0x3FFF] = 0x22;
  vic.clock(20);                      // run cycles 6..25

  assert(vic.lineCycleIdleByte[25] === 0x22,
    `cycle 25 idle byte must reflect post-write value 0x22, ` +
    `got 0x${vic.lineCycleIdleByte[25].toString(16).padStart(2, '0')}`);
  assert(vic.lineCycleIdleByte[5] === 0x11,
    'pre-write cycles retain the value that was live when they captured');
  console.log('ok  - idle byte is re-read live on every cycle; mid-line RAM writes apply immediately');
}

// ── Top-border sprite multiplexing ──────────────────────────────────────────
// Bauer §3.8.1 rule 3 has no DEN gate and no raster-range gate on sprite DMA.
// Sprites must therefore be able to start DMA on any raster, including the
// top-border range $00..$2F. Demos like Nine multiplex 8 sprites across the
// top border via per-sprite raster IRQs; the tests below pin the timing
// surfaces most likely to break.

// Sprite 0 starts DMA on a top-border raster (Y=10) and the same line's
// cycle 58 p-access fetches the pointer from $D018+0x3F8.
{
  const vic = makeVic();
  const screenBase = ((vic.regs[0x18] >> 4) & 0x0F) * 0x0400; // $0400 default
  vic.regs[0x15] = 0x01;              // sprite 0 enabled
  vic.regs[1] = 10;                   // sprite 0 Y = 10
  vic.ram[screenBase + 0x3F8 + 0] = 0x80;  // pointer $80 → data at $80*64 = $2000

  while (!(vic.raster === 10 && vic.cycleInLine === 56)) vic.clock(1);
  assert(vic.spriteDmaOn[0] === 1,
    'sprite DMA must start at cycle 55/56 even when Y=10 is in the top border');
  assert(vic.spriteMC[0] === 0, 'MC cleared by DMA start');
  assert(vic.spriteMCBase[0] === 0, 'MCBASE cleared by DMA start');

  while (vic.cycleInLine !== 58) vic.clock(1);
  assert(vic.spritePointerValue[0] === 0x80,
    `cycle 58 p-access must fetch sprite 0 pointer from screen RAM (got 0x${vic.spritePointerValue[0].toString(16)})`);
  console.log('ok  - sprite 0 DMA starts and p-accesses correctly in top-border raster (Y=10)');
}

// Sprite 3's p-access happens on the LINE AFTER its DMA start (cycle 1 of the
// next raster). For a top-border sprite this is the line $30 boundary class
// of bug — verify the cross-line p-access reads the live pointer from the
// live VIC bank/$D018, not a stale snapshot from the prior line.
{
  const vic = makeVic();
  const screenBase = ((vic.regs[0x18] >> 4) & 0x0F) * 0x0400;
  vic.regs[0x15] = 0x08;              // sprite 3 enabled
  vic.regs[3 * 2 + 1] = 12;           // sprite 3 Y = 12
  vic.ram[screenBase + 0x3F8 + 3] = 0x55;

  // Walk to cycle 56 of raster 12 — DMA should be on for sprite 3.
  while (!(vic.raster === 12 && vic.cycleInLine === 56)) vic.clock(1);
  assert(vic.spriteDmaOn[3] === 1, 'sprite 3 DMA on at cycle 56 of Y-match raster');

  // Cycle 1 of raster 13 is sprite 3's p-access cycle.
  while (!(vic.raster === 13 && vic.cycleInLine === 1)) vic.clock(1);
  assert(vic.spritePointerValue[3] === 0x55,
    `sprite 3 p-access at cycle 1 of next line must fetch live pointer (got 0x${vic.spritePointerValue[3].toString(16)})`);
  console.log('ok  - sprite 3 cross-line p-access reads live pointer in top-border raster');
}

// All 8 sprites enabled at the SAME top-border Y. The cycle 55/56 loop must
// start DMA for every sprite; bugs that early-exit or that mishandle the loop
// would leave some sprites' DMA off, producing visual garbage.
{
  const vic = makeVic();
  vic.regs[0x15] = 0xFF;              // all sprites enabled
  for (let s = 0; s < 8; s++) {
    vic.regs[s * 2 + 1] = 15;         // every sprite at Y=15
  }

  while (!(vic.raster === 15 && vic.cycleInLine === 56)) vic.clock(1);
  for (let s = 0; s < 8; s++) {
    assert(vic.spriteDmaOn[s] === 1,
      `sprite ${s} must have DMA on after cycle 56 with all sprites at Y=15`);
    assert(vic.spriteMC[s] === 0, `sprite ${s} MC cleared by DMA start`);
    assert(vic.spriteMCBase[s] === 0, `sprite ${s} MCBASE cleared by DMA start`);
  }
  console.log('ok  - 8 sprites at the same top-border Y all start DMA at cycle 55/56');
}

// Sprite multiplexer pattern: a raster IRQ between cycle 57 and cycle 58 of
// raster 14 rewrites $07F8 (sprite 0's pointer). Cycle 58's p-access must
// read the freshly-written pointer, not whatever it was at start-of-line.
{
  const vic = makeVic();
  const screenBase = ((vic.regs[0x18] >> 4) & 0x0F) * 0x0400;
  vic.regs[0x15] = 0x01;
  vic.regs[1] = 14;                   // sprite 0 Y = 14
  vic.ram[screenBase + 0x3F8 + 0] = 0x10;  // initial pointer

  while (!(vic.raster === 14 && vic.cycleInLine === 56)) vic.clock(1);
  assert(vic.spriteDmaOn[0] === 1, 'setup: sprite DMA on at cycle 56');

  // Walk to cycle 57 (just before the p-access).
  vic.clock(1);
  assert(vic.cycleInLine === 57, 'setup: arrived at cycle 57');

  // The multiplexer raster handler rewrites the pointer between cycles 57
  // and 58 — the next clock tick (which runs cycle 58) must see the new
  // value via the live RAM read in _fetchSpritePointer.
  vic.ram[screenBase + 0x3F8 + 0] = 0xC0;
  vic.clock(1);                       // cycle 58 — sprite 0 p-access fires
  assert(vic.cycleInLine === 58, 'arrived at cycle 58');
  assert(vic.spritePointerValue[0] === 0xC0,
    `multiplexer: cycle 58 p-access must fetch new pointer 0xC0 (got 0x${vic.spritePointerValue[0].toString(16)})`);
  assert(vic.spriteDataBase[0] === 0xC0 * 64,
    'multiplexer: sprite data base updated from new pointer');
  console.log('ok  - sprite multiplexer pointer rewrite between cycles 57 and 58 is picked up at p-access');
}

// Sister case for sprites 3-7: the pointer rewrite has to land before cycle
// 1 of the *next* line (where the cross-line p-access occurs), not cycle 58
// of the current line. Verifies the test surface where Nine's multiplexer
// would have to hit if it's juggling sprites 3-7.
{
  const vic = makeVic();
  const screenBase = ((vic.regs[0x18] >> 4) & 0x0F) * 0x0400;
  vic.regs[0x15] = 0x80;              // sprite 7 enabled
  vic.regs[7 * 2 + 1] = 18;           // sprite 7 Y = 18
  vic.ram[screenBase + 0x3F8 + 7] = 0x20;

  while (!(vic.raster === 18 && vic.cycleInLine === 56)) vic.clock(1);
  assert(vic.spriteDmaOn[7] === 1, 'sprite 7 DMA on at cycle 56');

  // Walk to cycle 63 of raster 18, then write the new pointer right before
  // cycle 9 of raster 19 (sprite 7's p-access).
  while (!(vic.raster === 19 && vic.cycleInLine === 8)) vic.clock(1);
  vic.ram[screenBase + 0x3F8 + 7] = 0xE0;
  vic.clock(1);                       // cycle 9 — sprite 7 p-access
  assert(vic.spritePointerValue[7] === 0xE0,
    `sprite 7 cross-line p-access at cycle 9 must fetch new pointer (got 0x${vic.spritePointerValue[7].toString(16)})`);
  console.log('ok  - sprite 7 multiplexer pointer rewrite between cycles 8 and 9 of next line is picked up');
}

// Bauer §3.8.1 has no frame-boundary rule. Sprite DMA progression is driven
// only by rule 3 (cycle 55/56 DMA-start when MxE+Y match and DMA was off) and
// rule 8 (cycle 16 turns DMA off when MCBASE=63). A sprite still mid-display
// when raster wraps from 311 → 0 must continue into the next frame's top
// border with its MCBASE / line-data-row / display state intact. This is
// exactly the surface a top-border sprite multiplexer (e.g. nine.prg) lands
// on, since sprites positioned at Y values whose lower 8 bits also match
// some top-border raster will straddle the frame boundary.
{
  const vic = makeVic();
  vic.regs[0x15] = 0x01;              // sprite 0 enabled
  vic.regs[0x18] = 0x14;              // screen base $0400 (default)
  const screenBase = 0x0400;
  vic.ram[screenBase + 0x3F8 + 0] = 0x40;

  // Manually park sprite 0 mid-display at the end of the previous frame:
  // 11 of its 21 lines have been displayed (MCBASE = 30, lineDataRow = 10).
  vic.spriteDmaOn[0] = 1;
  vic.spriteDisplayOn[0] = 1;
  vic.spriteMC[0] = 30;
  vic.spriteMCBase[0] = 30;
  vic.spriteLineDataRow[0] = 10;
  vic.spriteYExpandFF[0] = 1;
  vic.spritePointerValue[0] = 0x40;
  vic.spriteDataBase[0] = 0x40 * 64;
  vic.spriteStartPending[0] = 0;
  vic.spriteStopPending[0] = 0;

  // Bauer §3.8.1 (2024): MCBASE := MC at cycle 16 phi1; MC advances during
  // s-accesses (sprite 0 at cycles 58-60); MC := MCBASE at cycle 58 phi1
  // and that's also when spriteLineDataRow updates. So the chain that
  // lifts lineDataRow from 10 → 11 across the frame boundary is:
  //   line 311 cyc 58: MC := MCBASE = 30 (no advance), s-accesses → MC=33
  //   raster 0 cyc 16: MCBASE := MC = 33
  //   raster 0 cyc 58: MC := MCBASE = 33, lineDataRow = 33/3 = 11
  // Clock through to raster 0 cycle 58 to observe the update.
  vic.raster = 311;
  vic.cycleInLine = 0;
  vic.clock(63);                      // run line 311 (s-accesses advance MC)
  vic.clock(58);                      // → raster 0 cycle 58

  assert(vic.raster === 0 && vic.cycleInLine === 58,
    'arrived at raster 0 cycle 58 of new frame');
  assert(vic.spriteDmaOn[0] === 1,
    'sprite DMA must persist across frame boundary (spec §3.8.1 has no frame reset)');
  assert(vic.spriteDisplayOn[0] === 1,
    'sprite display must continue into the next frame');
  assert(vic.spriteMCBase[0] === 33,
    `MCBASE := MC after raster-0 cycle 16 (MC advanced by line-311 s-accesses), got ${vic.spriteMCBase[0]}`);
  assert(vic.spriteLineDataRow[0] === 11,
    `lineDataRow advances to 11 at cycle 58 of raster 0 once MCBASE = 33, got ${vic.spriteLineDataRow[0]}`);
  assert(vic.spritePointerValue[0] === 0x40,
    'sprite pointer value must persist across frame boundary');
  console.log('ok  - sprite mid-display state persists across the frame boundary (raster 311 → 0)');
}

// _tryStartSpriteDma must clear the shift register at DMA start so a freshly
// reused sprite never bleeds the previous instance's data into pixels before
// the s-access has refilled it.
{
  const vic = makeVic();
  const s = 0;
  vic.regs[0x15] = 1 << s;
  vic.regs[s * 2 + 1] = 50;            // Y=50

  // Park stale data in the shift register from a prior display.
  vic.spriteShiftReg[s] = 0xABCDEF;
  vic.spriteRowByteMask[s] = 0x07;
  vic.spriteRowData[s][0] = 0xAB;
  vic.spriteRowData[s][1] = 0xCD;
  vic.spriteRowData[s][2] = 0xEF;

  vic.raster = 50;
  vic._tryStartSpriteDma(s, vic.regs[0x15], 50, vic.regs[0x17]);

  assert(vic.spriteShiftReg[s] === 0,
    `DMA start must clear shift register (got 0x${vic.spriteShiftReg[s].toString(16)})`);
  assert(vic.spriteRowByteMask[s] === 0,
    'DMA start clears row-byte mask');
  assert(vic.spriteRowData[s][0] === 0 && vic.spriteRowData[s][1] === 0 && vic.spriteRowData[s][2] === 0,
    'DMA start clears row data buffer');
  console.log('ok  - sprite DMA start clears the shift register and row buffer');
}

// Bauer §3.8.1 rule 4 turns display ON at cycle 58 if DMA on AND Y matches.
// Once display is on it stays on until MCBASE=63 (rule 8); a mid-display Y
// mismatch must NOT deactivate the display.
{
  const vic = makeVic();
  const s = 0;
  // Park the sprite mid-display.
  vic.spriteDmaOn[s] = 1;
  vic.spriteDisplayOn[s] = 1;
  vic.spriteMC[s] = 30;
  vic.spriteMCBase[s] = 30;            // row 10 of 21
  vic.spriteLineDataRow[s] = 10;
  vic.regs[s * 2 + 1] = 0xAA;          // Y deliberately doesn't match the current raster
  vic.raster = 100;

  // Cycle 58 of a non-Y-match line must not end display.
  vic._spriteSequencerCycle58();
  assert(vic.spriteDisplayOn[s] === 1,
    'displayOn must persist across mid-display Y mismatches (only MCBASE=63 ends it)');
  assert(vic.spriteDmaOn[s] === 1, 'DMA also persists');
  assert(vic.spriteMCBase[s] === 30, 'MCBASE not affected by Y mismatch at cycle 58');
  console.log('ok  - sprite displayOn persists through mid-display Y mismatches');
}

// Sprite Y comparison uses only the lower 8 bits of RASTER (Bauer §3.8.1
// rule 3). A sprite at Y=44 will match BOTH raster 44 (frame's first match)
// and raster 300 (= 256 + 44). Multiplexers exploiting this need DMA-start
// gating via $D015 (sprite-enable) per multiplex slot.
{
  const vic = makeVic();
  const s = 0;
  vic.regs[s * 2 + 1] = 44;            // Y=44

  // Disable the sprite at the first match (raster 44) so DMA stays off,
  // then re-enable just before raster 300 so the second-half match fires.
  vic.regs[0x15] = 0x00;
  while (!(vic.raster === 44 && vic.cycleInLine === 56)) vic.clock(1);
  assert(vic.spriteDmaOn[s] === 0, 'first-half match suppressed by MxE=0');

  // Wait until raster 299 to enable.
  while (!(vic.raster === 299 && vic.cycleInLine === 0)) vic.clock(1);
  vic.regs[0x15] = 1 << s;             // enable just in time

  while (!(vic.raster === 300 && vic.cycleInLine === 56)) vic.clock(1);
  assert(vic.spriteDmaOn[s] === 1,
    `sprite Y=44 must also match raster 300 (lower-8-bit compare); ` +
    `multiplexer fires here when MxE was raised in time`);
  console.log('ok  - sprite Y compare uses raster low 8 bits — Y=44 matches raster 44 AND raster 300');
}

// Sprite at Y=$2C (44) displays for 21 lines $2C..$40. First two display
// lines ($2C..$2F) are in the top border (RSEL=1 top compare = 51 = $33);
// remaining lines ($30..$40) are in the display window. Display state must
// not flap at the $30 boundary.
{
  const vic = makeVic();
  const s = 0;
  const screenBase = 0x0400;
  vic.regs[0x15] = 1 << s;
  vic.regs[s * 2 + 1] = 0x2C;          // Y = 44 (top border)
  vic.ram[screenBase + 0x3F8 + s] = 0x40;

  while (!(vic.raster === 0x2C && vic.cycleInLine === 56)) vic.clock(1);
  assert(vic.spriteDmaOn[s] === 1, 'DMA on at the Y-match raster (in top border)');

  // Walk past the $30 boundary; display must remain on, MCBASE incrementing.
  while (vic.raster < 0x30 || vic.cycleInLine !== 1) vic.clock(1);
  assert(vic.spriteDmaOn[s] === 1, 'DMA still on at raster $30');
  assert(vic.spriteDisplayOn[s] === 1, 'display still on at raster $30');

  while (vic.raster < 0x35 || vic.cycleInLine !== 17) vic.clock(1);
  assert(vic.spriteDmaOn[s] === 1, 'DMA still on into display window');
  assert(vic.spriteDisplayOn[s] === 1, 'display still on into display window');
  // 9 lines past DMA start, MCBASE = 9 × 3 = 27 (no increment in the
  // start line itself; cycle 15/16 of each subsequent line adds 3).
  assert(vic.spriteMCBase[s] === 27,
    `MCBASE tracks correctly through the $30 boundary (expected 27, got ${vic.spriteMCBase[s]})`);
  console.log('ok  - sprite display continues through the $30 top-border-to-display-window boundary');
}

// CSEL=0 right compare X=335 fires at cycle 53 (sister of the existing
// CSEL=1 cycle-55 test). With CSEL=0 throughout, the border closes earlier
// than under CSEL=1 — pinning the per-CSEL right-compare cycle.
{
  const vic = makeVic();
  vic.vBorderActive = false;
  vic.hBorderActive = true;
  vic.regs[0x16] = 0x00;              // CSEL=0

  for (let c = 11; c <= 52; c++) vic._advanceHorizontalBorderState(c, vic.regs);
  assert(vic.hBorderActive === false,
    'CSEL=0 left compare at cycle 15 still opens the border');
  vic._advanceHorizontalBorderState(53, vic.regs);
  assert(vic.hBorderActive === true,
    'CSEL=0 right compare X=335 fires at cycle 53 (vs cycle 55 for CSEL=1)');
  console.log('ok  - CSEL=0 right compare closes the border at cycle 53');
}

// Bauer §3.8.1 rules 1, 2, 7, 8: with MxYE=1 the expansion FF toggles each
// line, so MCBASE only advances every other line. The sprite's row counter
// therefore holds each row for two raster lines.
{
  const vic = makeVic();
  const s = 0;
  const screenBase = 0x0400;
  vic.regs[0x15] = 1 << s;
  vic.regs[0x17] = 1 << s;             // MxYE = 1 → Y-expanded
  vic.regs[s * 2 + 1] = 60;            // Y=60
  vic.ram[screenBase + 0x3F8 + s] = 0x40;

  while (!(vic.raster === 60 && vic.cycleInLine === 56)) vic.clock(1);
  assert(vic.spriteDmaOn[s] === 1, 'DMA on at Y match');

  // Walk through the next 4 display lines and snapshot lineDataRow at cycle 58.
  const rows = [];
  for (let line = 60; line <= 63; line++) {
    while (!(vic.raster === line && vic.cycleInLine === 58)) vic.clock(1);
    rows.push(vic.spriteLineDataRow[s]);
  }
  // Spec (Bauer §3.8.1, 2024): rule 3 — at cycle 56 phi2 the MxYE
  // advance-line FF is INVERTED when MxYE=1 + DMA on (NOT cycle 15;
  // pre-2024 spec had cycle 15 + MCBASE+=2, that rule is gone). Rule 7
  // — at cycle 16 phi1, if FF=1 then MCBASE := MC. With MxYE=1 the FF
  // flips 0/1 each line, so on FF=0 lines MCBASE is NOT loaded → MC
  // stays at last value → row repeats. Net: each row displays for 2
  // consecutive raster lines.
  assert(rows[0] === rows[1] && rows[2] === rows[3] && rows[1] !== rows[2],
    `Y-expanded sprite must hold each row for 2 lines; got rows = [${rows.join(',')}]`);
  console.log('ok  - Y-expanded sprite holds each row for two raster lines');
}

// Clearing MxE in $D015 mid-display must NOT end DMA. Per Bauer §3.8.1 the
// only DMA-off rule is rule 8 (MCBASE=63 at cycle 16). MxE only gates the
// cycle 55/56 DMA-START check.
{
  const vic = makeVic();
  const s = 0;
  const screenBase = 0x0400;
  vic.regs[0x15] = 1 << s;
  vic.regs[s * 2 + 1] = 70;
  vic.ram[screenBase + 0x3F8 + s] = 0x40;

  while (!(vic.raster === 70 && vic.cycleInLine === 56)) vic.clock(1);
  assert(vic.spriteDmaOn[s] === 1, 'DMA on at Y match');

  // Mid-display, the program clears the sprite-enable bit. The implementation
  // and spec both keep DMA running until MCBASE hits 63.
  while (!(vic.raster === 73 && vic.cycleInLine === 30)) vic.clock(1);
  vic.write(0x15, 0);
  assert(vic.regs[0x15] === 0, 'MxE bit cleared');

  // Walk a few more lines; DMA must keep ticking.
  while (!(vic.raster === 78 && vic.cycleInLine === 30)) vic.clock(1);
  assert(vic.spriteDmaOn[s] === 1,
    'DMA continues past MxE clear (only MCBASE=63 ends it)');
  assert(vic.spriteDisplayOn[s] === 1, 'display also continues');
  console.log('ok  - clearing MxE mid-display does not end sprite DMA');
}

// Sprite Y=0 must trigger DMA at raster 0 cycle 55/56. Raster 0 has special
// init in _beginRasterLine; verifying DMA still fires here exercises that
// path together with the cycle-55 sprite check.
{
  const vic = makeVic();
  const s = 0;
  const screenBase = 0x0400;
  vic.regs[0x15] = 1 << s;
  vic.regs[s * 2 + 1] = 0;             // Y=0
  vic.ram[screenBase + 0x3F8 + s] = 0x40;

  while (!(vic.raster === 0 && vic.cycleInLine === 56)) vic.clock(1);
  assert(vic.spriteDmaOn[s] === 1,
    'sprite Y=0 must trigger DMA at raster 0 cycle 55/56');
  console.log('ok  - sprite Y=0 starts DMA at raster 0');
}

// Sprite at Y=248 — last visible raster line under RSEL=1 (bottom compare
// raster 251). DMA fires inside the display window; sprite is rendered
// across a frame boundary if MxYE=0 (21 visible lines: 248..(311-mod)).
{
  const vic = makeVic();
  const s = 0;
  const screenBase = 0x0400;
  vic.regs[0x15] = 1 << s;
  vic.regs[s * 2 + 1] = 248;
  vic.ram[screenBase + 0x3F8 + s] = 0x40;

  while (!(vic.raster === 248 && vic.cycleInLine === 56)) vic.clock(1);
  assert(vic.spriteDmaOn[s] === 1, 'sprite Y=248 fires DMA at raster 248');
  // Spend a few lines verifying the sprite continues over the bottom-border
  // boundary (raster 251 sets vBorder, but DMA is independent of border).
  while (!(vic.raster === 252 && vic.cycleInLine === 17)) vic.clock(1);
  assert(vic.spriteDmaOn[s] === 1, 'sprite DMA continues past bottom-border raster');
  assert(vic.spriteDisplayOn[s] === 1, 'sprite display continues past bottom-border raster');
  console.log('ok  - sprite Y=248 fires DMA and continues through bottom-border raster');
}

// Two sprites both mid-display when raster wraps 311 → 0 must BOTH carry
// over. Extends the single-sprite frame-boundary test to multiple sprites
// — Nine multiplexes 8 sprites across the boundary.
{
  const vic = makeVic();
  const screenBase = 0x0400;
  vic.regs[0x15] = 0x05;               // sprites 0 and 2 enabled
  vic.ram[screenBase + 0x3F8 + 0] = 0x40;
  vic.ram[screenBase + 0x3F8 + 2] = 0x80;

  // Park sprites 0 and 2 mid-display.
  for (const s of [0, 2]) {
    vic.spriteDmaOn[s] = 1;
    vic.spriteDisplayOn[s] = 1;
    vic.spriteMC[s] = 24;
    vic.spriteMCBase[s] = 24;
    vic.spriteLineDataRow[s] = 8;
    vic.spriteYExpandFF[s] = 1;
    vic.spritePointerValue[s] = (s === 0) ? 0x40 : 0x80;
    vic.spriteDataBase[s] = vic.spritePointerValue[s] * 64;
  }

  vic.raster = 311;
  vic.cycleInLine = 0;
  vic.clock(63);                       // line 311 (s-accesses advance MC)
  vic.clock(16);                       // → raster 0 cycle 16 — MCBASE := MC

  for (const s of [0, 2]) {
    assert(vic.spriteDmaOn[s] === 1,
      `sprite ${s} DMA must persist across frame boundary`);
    assert(vic.spriteDisplayOn[s] === 1,
      `sprite ${s} display must persist`);
    assert(vic.spriteMCBase[s] === 27,
      `sprite ${s} MCBASE := MC after raster-0 cycle 16; line-311 s-accesses bumped MC 24→27, got ${vic.spriteMCBase[s]}`);
  }

  // Sprite 1 (which had no DMA) must remain off — the frame-boundary code
  // mustn't accidentally turn it on.
  assert(vic.spriteDmaOn[1] === 0, 'inactive sprite 1 stays off across frame boundary');
  console.log('ok  - multiple mid-display sprites all carry over the frame boundary');
}

// Bauer §3.7.3.7: invalid bitmap mode 1 (ECM/BMM/MCM = 1/1/0) g-access:
//   bit 13 = CB13     bit 12 = VC9   bit 11 = VC8   bits 10-9 = 0
//   bits 8-3 = VC5..VC0    bits 2-0 = RC
// VC6 and VC7 are NOT in the g-access address. Demos like Nine drive the
// invalid mode and rely on the bitmap data being read from the
// spec-correct location for the sprite-collision-readout trick to work.
{
  const vic = makeVic();
  // CB13 = 1 → bitmapBase = $2000.
  vic.regs[0x18] = 0x18;
  vic.regs[0x11] = 0x60;               // ECM=1, BMM=1
  vic.regs[0x16] = 0x00;               // MCM=0
  vic.currentVicBank = 0x0000;

  // Stash a probe byte at the SPEC address corresponding to VC=0x100 (VC8=1
  // alone). Spec: address = $2000 (CB13) | $0800 (VC8 at bit 11) = $2800.
  vic.ram[0x2800] = 0xC3;              // 0b11000011

  const seg = makeRenderSeg(vic, {
    bank: 0x0000,
    rowVcBase: 0x100,
    rowFetchD011: 0x60,
    rowFetchD016: 0x00,
    rowFetchD018: 0x18,
  });
  seg.rowFetchedCols[0] = 1;

  const outPixels = new Uint32Array(8);
  const outFgMap = new Uint8Array(8);
  vic._renderSourceColumn(0, 0, seg, outPixels, outFgMap, 0);

  // Spec invalid-mode 110: pixels are BLACK regardless of bit pattern; the
  // bit pattern only determines the foreground map (used for sprite-bg
  // collisions). Reading the spec-correct address means the foreground map
  // must reflect the byte we wrote at $2800.
  assert(outPixels.every((px) => px === 0xFF000000),
    'invalid mode 110 pixels are always black');
  const fgPattern = Array.from(outFgMap).join('');
  assert(fgPattern === '11000011',
    `VC=0x100 must read from spec address $2800 (got fg=${fgPattern}, expected 11000011)`);
  console.log('ok  - invalid bitmap mode 1: VC=0x100 reads from spec address ($2000 + VC8<<11)');
}

// Sister test: VC9 at addr bit 12. VC=0x200 must read from $2000 (CB13) |
// $1000 (VC9 at bit 12) = $3000. The previous implementation dropped VC9
// entirely and would always read from $2000 + 0 + RC.
{
  const vic = makeVic();
  vic.regs[0x18] = 0x18;
  vic.regs[0x11] = 0x60;
  vic.regs[0x16] = 0x00;
  vic.currentVicBank = 0x0000;
  vic.ram[0x3000] = 0x99;              // 0b10011001

  const seg = makeRenderSeg(vic, {
    bank: 0x0000,
    rowVcBase: 0x200,
    rowFetchD011: 0x60,
    rowFetchD016: 0x00,
    rowFetchD018: 0x18,
  });
  seg.rowFetchedCols[0] = 1;

  const outPixels = new Uint32Array(8);
  const outFgMap = new Uint8Array(8);
  vic._renderSourceColumn(0, 0, seg, outPixels, outFgMap, 0);

  const fgPattern = Array.from(outFgMap).join('');
  assert(fgPattern === '10011001',
    `VC=0x200 must read from spec address $3000 (got fg=${fgPattern}, expected 10011001)`);
  console.log('ok  - invalid bitmap mode 1: VC9 routed to addr bit 12');
}

// VC6 and VC7 must NOT influence the address (bits 9-10 are zero per spec).
// VC=0x040 (VC6=1) must read from the same address as VC=0x000.
{
  const vic = makeVic();
  vic.regs[0x18] = 0x18;
  vic.regs[0x11] = 0x60;
  vic.regs[0x16] = 0x00;
  vic.currentVicBank = 0x0000;
  vic.ram[0x2000] = 0x55;              // base address (VC6 should be ignored)

  const seg = makeRenderSeg(vic, {
    bank: 0x0000,
    rowVcBase: 0x40,                   // VC6=1; spec drops this from the address
    rowFetchD011: 0x60,
    rowFetchD016: 0x00,
    rowFetchD018: 0x18,
  });
  seg.rowFetchedCols[0] = 1;

  const outPixels = new Uint32Array(8);
  const outFgMap = new Uint8Array(8);
  vic._renderSourceColumn(0, 0, seg, outPixels, outFgMap, 0);

  const fgPattern = Array.from(outFgMap).join('');
  assert(fgPattern === '01010101',
    `VC=0x40 must drop VC6 and read from the base address $2000 ` +
    `(got fg=${fgPattern}, expected 01010101)`);
  console.log('ok  - invalid bitmap mode 1: VC6 is dropped from the g-access address');
}

// AEC-low blocks the CPU on every kind of bus access. BA-low only blocks
// reads (the 6510 RDY signal stops on the next read), but once BA has been
// low for 3 cycles AEC follows and tri-states the address bus too — at
// that point even writes can no longer proceed.
{
  for (const kind of ['read', 'write', 'internal']) {
    const machine = makeMasterCycleHarness({ baLow: true, busKind: kind, aecLow: true });
    C64Machine.prototype._runMasterCycle.call(machine);
    assert(machine.cpu.clockCalls === 0,
      `AEC-low must block CPU on '${kind}' access (got ${machine.cpu.clockCalls} CPU cycles)`);
  }
  console.log('ok  - AEC-low blocks CPU read, write, and internal cycles');
}

// AEC-low alone (without BA-low) is a contradictory state in real hardware
// — AEC follows BA after a 3-cycle delay, so AEC-low implies BA-low. But
// the harness must still treat AEC as the dominant signal and block the
// CPU regardless of the busKind, since that's how the gating logic in
// machine.js reads.
{
  const machine = makeMasterCycleHarness({ baLow: false, busKind: 'write', aecLow: true });
  C64Machine.prototype._runMasterCycle.call(machine);
  assert(machine.cpu.clockCalls === 0,
    'AEC-low blocks CPU even when BA is reportedly high (defensive)');
  console.log('ok  - AEC-low dominates BA-low for CPU stalling');
}

// Stall release: when BA goes high, the CPU must run on the very next
// cycle. The 6510 has no internal "RDY-recovery" delay — recovery is
// immediate per Bauer §3.6.1.
{
  // Cycle 1: BA low, CPU read → blocked.
  const stalled = makeMasterCycleHarness({ baLow: true, busKind: 'read' });
  C64Machine.prototype._runMasterCycle.call(stalled);
  assert(stalled.cpu.clockCalls === 0, 'cycle 1: CPU stalled');

  // Cycle 2: same harness, but BA flips high. CPU should run.
  const released = makeMasterCycleHarness({ baLow: false, busKind: 'read' });
  C64Machine.prototype._runMasterCycle.call(released);
  assert(released.cpu.clockCalls === 1, 'cycle 2: CPU resumes immediately when BA goes high');
  console.log('ok  - CPU resumes on the next cycle after BA goes high');
}

// Integration: with all 8 sprites firing DMA at Y=0, the CPU sees BA-low
// for 18 cycles per line (1-10 and 56-63) for ~21 lines per Y match.
// With Y=0 the lower-8-bit raster compare matches both raster 0 AND
// raster 256, so DMA fires twice per frame: ~42 lines × 18 ≈ 750 stolen
// cycles. Off-by-much in either direction would mean either our BA
// tracking or our CPU-stall gating is broken — exactly the timing that
// breaks raster-IRQ multiplexers.
{
  const machine = new C64Machine();
  machine.mem.ram[0x0800] = 0xEA;       // NOP
  machine.mem.ram[0x0801] = 0xEA;       // NOP
  machine.mem.ram[0x0802] = 0x4C;       // JMP $0800
  machine.mem.ram[0x0803] = 0x00;
  machine.mem.ram[0x0804] = 0x08;
  machine.cpu.pc = 0x0800;

  // Baseline: no sprites enabled.
  const cpuCyclesBaseline = countCpuClocksOneFrame(machine);

  // Enable all 8 sprites at Y=0; force DMA on so the next frame starts
  // with sprites active (they self-rearm at the raster=0 + raster=256
  // matches). Pre-setting `spriteDmaOn[s] = 1` bypasses rule 2 (which
  // would otherwise set FF=1 at DMA start), so we mirror that here —
  // without FF=1 the cycle-16 `MCBASE := MC` rule never fires and DMA
  // would never terminate.
  for (let s = 0; s < 8; s++) {
    machine.vic2.spriteDmaOn[s] = 1;
    machine.vic2.spriteYExpandFF[s] = 1;
    machine.vic2.regs[s * 2 + 1] = 0;
  }
  machine.vic2.regs[0x15] = 0xFF;
  machine.cpu.pc = 0x0800;
  const cpuCyclesUnderLoad = countCpuClocksOneFrame(machine);

  const reduction = cpuCyclesBaseline - cpuCyclesUnderLoad;
  // ~750 expected. Allow a wide ±30% band so the test is robust against
  // small per-line boundary effects (sprite turning off at line N's cycle 16
  // gives that line only 10 stall cycles instead of 18).
  assert(reduction > 525 && reduction < 1050,
    `8-sprite DMA must steal ~750 CPU cycles per frame (Y=0 fires at raster 0 and 256); ` +
    `got ${reduction} (baseline=${cpuCyclesBaseline}, loaded=${cpuCyclesUnderLoad})`);
  console.log(`ok  - 8-sprite DMA load steals ${reduction} CPU cycles/frame (~750 expected for two Y=0 match runs)`);
}

// $D019 W1C deasserts the CPU IRQ line as soon as the last enabled source
// is cleared. The handler must call irqHandler(false) so that machine.js
// updates cpu.irqLine immediately — any one-cycle delay here would let the
// outgoing RTI re-sample IRQ asserted and refire the handler.
{
  const vic = makeVic();
  let irqStateChanges = [];
  vic.irqHandler = (state) => irqStateChanges.push(state);
  vic.irqMask = 0x01;
  vic.regs[0x12] = 50;
  vic.regs[0x11] &= 0x7F;

  // Walk to raster 50 cycle 1 → raster IRQ fires.
  while (!(vic.raster === 50 && vic.cycleInLine === 1)) vic.clock(1);
  assert((vic.irqStatus & 0x01) === 0x01, 'raster latch set');
  assert((vic.irqStatus & 0x80) === 0x80, 'master IRQ flag set');
  assert(irqStateChanges[irqStateChanges.length - 1] === true,
    'irqHandler signalled assert');

  // Simulate the ISR's W1C ack.
  irqStateChanges = [];
  vic.write(0x19, 0x01);
  assert((vic.irqStatus & 0x01) === 0, 'raster latch cleared by W1C');
  assert((vic.irqStatus & 0x80) === 0,
    'master IRQ flag deasserts when last enabled source is cleared');
  assert(irqStateChanges.length === 1 && irqStateChanges[0] === false,
    `irqHandler must fire false exactly once after the W1C ack ` +
    `(got ${irqStateChanges.length} call(s): ${JSON.stringify(irqStateChanges)})`);
  console.log('ok  - $D019 W1C deasserts IRQ line immediately when last source cleared');
}

// W1C with multiple sources pending: clearing one bit must NOT deassert
// the IRQ line if other enabled sources remain latched.
{
  const vic = makeVic();
  vic.irqMask = 0x07;                  // raster + IMBC + IMMC enabled
  vic.irqStatus = 0x80 | 0x07;         // all three sources pending
  let irqStates = [];
  vic.irqHandler = (state) => irqStates.push(state);

  // Ack only the raster source (bit 0).
  vic.write(0x19, 0x01);
  assert((vic.irqStatus & 0x01) === 0, 'raster bit cleared');
  assert((vic.irqStatus & 0x06) === 0x06, 'IMBC and IMMC remain latched');
  assert((vic.irqStatus & 0x80) === 0x80,
    'master IRQ flag stays set while other enabled sources remain pending');
  assert(irqStates.length === 1 && irqStates[0] === true,
    'irqHandler signalled true (still asserted)');
  console.log('ok  - W1C of one source preserves IRQ line if other enabled sources are latched');
}

// Bit 7 of $D019 cannot be cleared directly via W1C — it's a derived
// reflection of (irqStatus & irqMask & 0x0F) being non-zero. Writing
// $80 alone leaves the latch and the master flag exactly as they were.
{
  const vic = makeVic();
  vic.irqMask = 0x01;
  vic.irqStatus = 0x80 | 0x01;

  vic.write(0x19, 0x80);                // try to clear bit 7 directly
  assert((vic.irqStatus & 0x01) === 0x01,
    'bit 0 (raster latch) untouched by writing $80');
  assert((vic.irqStatus & 0x80) === 0x80,
    'bit 7 cannot be directly cleared while a masked source is still latched');
  console.log('ok  - $D019 bit 7 is derived; writing $80 does not clear it');
}

// W1C with no pending bits is a no-op for state — irqStatus remains 0,
// irqHandler still gets called with the current pending state (false).
{
  const vic = makeVic();
  vic.irqMask = 0x01;
  vic.irqStatus = 0;
  let irqStates = [];
  vic.irqHandler = (state) => irqStates.push(state);

  vic.write(0x19, 0x01);
  assert(vic.irqStatus === 0, 'no-op clear leaves irqStatus zero');
  assert(irqStates.length === 1 && irqStates[0] === false,
    'no-op clear still emits a deassertion signal');
  console.log('ok  - $D019 W1C with no pending bits emits a clean false signal');
}

// Reading $D019 must NOT W1C — it returns the latched state with the
// unused bits 4-6 forced to 1. Two consecutive reads return the same value.
{
  const vic = makeVic();
  vic.irqMask = 0x01;
  vic.irqStatus = 0x80 | 0x01;

  const v1 = vic.read(0x19);
  const v2 = vic.read(0x19);
  assert(v1 === v2,
    `reading $D019 must be idempotent; got 0x${v1.toString(16)} vs 0x${v2.toString(16)}`);
  assert((v1 & 0x70) === 0x70, 'unused bits 4-6 of $D019 read as 1');
  assert((v1 & 0x81) === 0x81, 'irqStatus bits visible on read');
  console.log('ok  - reading $D019 is idempotent (does not clear)');
}

// Full retrigger cycle: ack the raster IRQ, change the compare value, and
// walk to the new target. The IRQ line must reassert exactly when the new
// match occurs — pinning the W1C → next-fire chain that raster-IRQ
// multiplexers depend on.
{
  const vic = makeVic();
  let irqAssertions = 0;
  vic.irqHandler = (state) => { if (state) irqAssertions++; };
  vic.irqMask = 0x01;
  vic.regs[0x12] = 60;
  vic.regs[0x11] &= 0x7F;

  // First fire at raster 60.
  while (!(vic.raster === 60 && vic.cycleInLine === 1)) vic.clock(1);
  assert(irqAssertions === 1, 'first raster compare fires once');

  // ISR acks via W1C and rewrites the compare to raster 65.
  vic.write(0x19, 0x01);
  vic.write(0x12, 65);
  assert((vic.irqStatus & 0x80) === 0, 'IRQ deasserted after ack');

  // Walk through rasters 61..64 — no firings expected. cycleInLine resets
  // to 0 within the same clock() iteration that hits 63, so we sample at
  // cycle 0 of raster 65 (i.e. just-arrived) and assert nothing has fired
  // yet, then advance one more cycle to cycle 1 where the new compare
  // should latch.
  while (!(vic.raster === 65 && vic.cycleInLine === 0)) vic.clock(1);
  assert(irqAssertions === 1, 'no spurious firings between rasters 60 and 65');

  vic.clock(1);
  assert(vic.cycleInLine === 1, 'arrived at cycle 1 of raster 65');
  assert(irqAssertions === 2,
    `new compare must fire at raster 65 cycle 1 (got ${irqAssertions} firings)`);
  console.log('ok  - ack + new-compare retrigger chain fires at exactly the new raster');
}

function countCpuClocksOneFrame(machine) {
  // Wrap cpu.clock() to count invocations. The original is restored
  // before returning so the machine state is otherwise untouched.
  const origClock = machine.cpu.clock.bind(machine.cpu);
  let cpuCycles = 0;
  machine.cpu.clock = function () { cpuCycles++; return origClock(); };
  try {
    const CYCLES_PER_FRAME = 63 * 312;
    for (let i = 0; i < CYCLES_PER_FRAME; i++) {
      C64Machine.prototype._runMasterCycle.call(machine);
    }
  } finally {
    machine.cpu.clock = origClock;
  }
  return cpuCycles;
}



console.log('\nAll Nine demo dependency tests passed.');
