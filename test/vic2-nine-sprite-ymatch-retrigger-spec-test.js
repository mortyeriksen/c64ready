// Sprite renderState preservation across mid-line Y-match re-trigger.
//
// nine.prg's "Magician + numbers orbiting" phase relies on Y-expanded
// "masker" sprites (5 and 7) that paint $D020 (black) over the §3.14.1
// open side-border zone. The maskers are kept continuously displaying
// by an IRQ chain that rewrites $D001/$D003/... so that rule 2 (Bauer
// §3.8.1, cy 55/56 Y-match) fires on the SAME line where rule 9 (cy 16,
// MCBASE==63 → display flag clear) and rule 4 (cy 58, re-arm on Y match)
// would otherwise end the display.
//
// On that re-trigger line, the per-cycle snapshots
// (lineCycleSpriteShiftReg / lineCycleSpriteRowByteMask) read as 0/0
// for a window — the cleared shifter has no fresh data until the NEXT
// line's DMA s-access fetches arrive. The renderer must NOT clobber a
// live _spriteLineRenderState with that empty snapshot, because the
// end-of-line X-wrap (Bauer §3.8 same-line wrap to canvas X 0..7) then
// renders nothing — exposing the side-border $D021 fill underneath as
// 3 spurious blue lines (r=99/141/183 in nine.prg).
//
// The fix at src/vic2.js _renderSpriteSegmentForSprite reseed branch:
// when incoming shiftReg=0 AND rowByteMask=0 AND existing renderState
// has validMask != 0, PRESERVE the renderState (do not clobber).
//
// What this file pins:
//
//   R1. Empty incoming snapshot (shiftReg=0, mask=0) + live renderState
//       (validMask != 0) → renderState preserved (object identity AND
//       shiftReg/validMask unchanged).
//
//   R2. Converse: non-empty incoming snapshot still updates renderState
//       (shiftReg replaced, validMask recomputed). The preservation
//       guard must not block legitimate mid-line shifter reseeds.
//
//   R3. Display-just-turning-on with a live renderState and empty
//       incoming (segDisplayOn=1, prevSegDisplayOn=0): the live state
//       is still preserved — the isNew branch must NOT clobber when
//       incoming is empty. This is the actual nine.prg case: cy 16
//       cleared the flag, cy 58 re-arms it, segDisplayOn 0→1 transition
//       happens on the empty-snapshot cycle.
//
// Does NOT load nine.prg.

import { VIC2, CYCLES_PER_LINE, CANVAS_W } from '../src/vic2.js';

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

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0x0000;
  vic.regs[0x11] = 0x1B;
  vic.regs[0x16] = 0x08;
  vic.displayEnabled = true;
  return vic;
}

// Build a synthetic per-cycle sprite segment for sprite `s` with the
// given snapshot values. Mirrors _buildCycleSpriteSegment / VIC's
// cycle-segment shape — small enough for _renderSpriteSegmentForSprite
// to consume without touching the rest of the pipeline.
function buildFakeSeg(vic, s, { shiftReg, rowByteMask, displayOn, dataRow, start, end, cycle }) {
  const shiftArr  = new Uint32Array(8); shiftArr[s]  = shiftReg >>> 0;
  const maskArr   = new Uint8Array(8);  maskArr[s]   = rowByteMask & 0xFF;
  const dispArr   = new Uint8Array(8);  dispArr[s]   = displayOn ? 1 : 0;
  const dataRowArr = new Int8Array(8);  dataRowArr[s] = dataRow;
  return {
    start, end,
    cycle, cycleStart: start,
    regs: vic.regs.slice(),
    prevRegs: vic.regs.slice(),
    bank: 0,
    spriteDisplayOn: dispArr,
    spriteDataRow: dataRowArr,
    spriteDataBase: new Uint16Array(8),
    spriteDataBank: new Uint8Array(8),
    spritePointerValue: new Uint8Array(8),
    spriteRowByteMask: maskArr,
    spriteShiftReg: shiftArr,
  };
}

// Snapshot renderState IMMEDIATELY after the reseed branch resolves —
// before _renderSpriteSegmentSequencer's pixel walk mutates shiftReg/
// validMask/unitsRemaining. We replace the sequencer with a no-op
// closure that captures `state` and `seg.spriteShiftReg[s]` references
// for the caller; restore on tearDown().
function hookSequencer(vic) {
  const orig = vic._renderSpriteSegmentSequencer.bind(vic);
  const cap = { state: null, stateRef: null, called: false };
  vic._renderSpriteSegmentSequencer = function(seg, spriteIdx, canvasY, state) {
    cap.called = true;
    cap.stateRef = state;
    cap.state = state ? {
      shiftReg: state.shiftReg >>> 0,
      validMask: state.validMask >>> 0,
      unitsRemaining: state.unitsRemaining,
      pixelPhase: state.pixelPhase,
      currentX: state.currentX,
    } : null;
    // no-op: do not mutate
  };
  return {
    cap,
    restore() { vic._renderSpriteSegmentSequencer = orig; },
  };
}

// ─── R1: empty incoming + live renderState → preserved ──────────────────
//
// Pre-condition: live renderState with a unique sentinel shiftReg + non-zero
// validMask + non-zero last-tracking (so shouldReseed fires when incoming
// reads 0/0). Display already ON the prior segment.
{
  const vic = makeVic();
  const s = 5;
  const SENTINEL_SHIFT = 0x123456;
  const SENTINEL_MASK = 0x07;
  const spriteLeft = 100;

  vic._spriteLineStarted[s] = 1;
  vic._spriteLinePrevSegDisplayOn[s] = 1;
  vic._spriteLineLeft[s] = spriteLeft;
  vic._spriteLineLastShiftReg[s] = SENTINEL_SHIFT;
  vic._spriteLineLastRowByteMask[s] = SENTINEL_MASK;
  vic._spriteLineLastDataRow[s] = 5;
  const live = vic._createSpriteRenderState(SENTINEL_SHIFT, SENTINEL_MASK, spriteLeft, spriteLeft + 4, false, false);
  vic._spriteLineRenderState[s] = live;

  const preValidMask = live.validMask;
  expect(preValidMask !== 0, `R1 setup: live renderState validMask must be non-zero`);

  // Build seg with empty incoming snapshot, display ON, dataRow valid.
  const seg = buildFakeSeg(vic, s, {
    shiftReg: 0, rowByteMask: 0, displayOn: 1, dataRow: 5,
    start: 200, end: 208, cycle: 30,
  });

  const hook = hookSequencer(vic);
  vic._renderSpriteSegmentForSprite(seg, s, 50);
  hook.restore();

  expect(hook.cap.called, `R1: sequencer reached (reseed branch did not early-return)`);
  expect(hook.cap.stateRef === live,
    `R1: renderState object identity preserved into sequencer (after !== live indicates clobber)`);
  expect(hook.cap.state.shiftReg === SENTINEL_SHIFT,
    `R1: renderState.shiftReg preserved at sequencer entry, got 0x${hook.cap.state.shiftReg.toString(16)} expected 0x${SENTINEL_SHIFT.toString(16)}`);
  expect(hook.cap.state.validMask === preValidMask,
    `R1: renderState.validMask preserved at sequencer entry, got 0x${hook.cap.state.validMask.toString(16)} expected 0x${preValidMask.toString(16)}`);
  ok('R1: empty incoming + live renderState → renderState preserved (not clobbered to empty)');
}

// ─── R2: non-empty incoming + live renderState → updated ────────────────
//
// Converse pin: the preservation guard must apply ONLY to empty incoming.
// When new shifter data arrives mid-line, the renderState's shiftReg is
// replaced and validMask recomputed (the existing reseed-when-changed
// behavior must remain intact).
{
  const vic = makeVic();
  const s = 5;
  const OLD_SHIFT = 0x111111;
  const OLD_MASK = 0x07;
  const NEW_SHIFT = 0xDEAD42;
  const NEW_MASK = 0x07;
  const spriteLeft = 100;

  vic._spriteLineStarted[s] = 1;
  vic._spriteLinePrevSegDisplayOn[s] = 1;
  vic._spriteLineLeft[s] = spriteLeft;
  vic._spriteLineLastShiftReg[s] = OLD_SHIFT;
  vic._spriteLineLastRowByteMask[s] = OLD_MASK;
  vic._spriteLineLastDataRow[s] = 5;
  const live = vic._createSpriteRenderState(OLD_SHIFT, OLD_MASK, spriteLeft, spriteLeft + 4, false, false);
  vic._spriteLineRenderState[s] = live;

  const seg = buildFakeSeg(vic, s, {
    shiftReg: NEW_SHIFT, rowByteMask: NEW_MASK, displayOn: 1, dataRow: 5,
    start: 200, end: 208, cycle: 30,
  });

  const hook = hookSequencer(vic);
  vic._renderSpriteSegmentForSprite(seg, s, 50);
  hook.restore();

  expect(hook.cap.called, `R2: sequencer reached`);
  expect(hook.cap.stateRef === live,
    `R2: renderState object identity preserved into sequencer (mid-line update mutates in place)`);
  expect(hook.cap.state.shiftReg === NEW_SHIFT,
    `R2: renderState.shiftReg updated to new value, got 0x${hook.cap.state.shiftReg.toString(16)} expected 0x${NEW_SHIFT.toString(16)}`);
  expect(hook.cap.state.validMask === vic._spriteValidMask(NEW_MASK),
    `R2: renderState.validMask recomputed from new mask`);
  ok('R2: non-empty incoming with changed shifter → renderState shifter/validMask updated');
}

// ─── R3: display 0→1 transition with empty incoming + live renderState ──
//
// This is the exact nine.prg cy 58 case. At cy 16 of the Y-match
// re-trigger line, rule 9 cleared the display flag (segDisplayOn=0 for
// cy 16..57 segments). At cy 58, rule 4 sets it back ON. The renderer
// then processes a segment with segDisplayOn=1 AND prevSegDisplayOn=0 —
// "isNew" triggers, but incoming snapshot is still 0/0 (data fetches
// on next line's DMA slots). Without preservation, isNew branch creates
// a FRESH state with empty data, clobbering the live one we still need
// for the end-of-line X-wrap.
{
  const vic = makeVic();
  const s = 5;
  const SENTINEL_SHIFT = 0xABCDEF;
  const SENTINEL_MASK = 0x07;
  const spriteLeft = 100;

  vic._spriteLineStarted[s] = 1;
  // segDisplayOn 0→1 transition: prev was off.
  vic._spriteLinePrevSegDisplayOn[s] = 0;
  vic._spriteLineLeft[s] = spriteLeft;
  vic._spriteLineLastShiftReg[s] = SENTINEL_SHIFT;
  vic._spriteLineLastRowByteMask[s] = SENTINEL_MASK;
  vic._spriteLineLastDataRow[s] = 5;
  const live = vic._createSpriteRenderState(SENTINEL_SHIFT, SENTINEL_MASK, spriteLeft, spriteLeft + 4, false, false);
  vic._spriteLineRenderState[s] = live;
  const preValidMask = live.validMask;

  const seg = buildFakeSeg(vic, s, {
    shiftReg: 0, rowByteMask: 0, displayOn: 1, dataRow: 5,
    start: 200, end: 208, cycle: 58,
  });

  const hook = hookSequencer(vic);
  vic._renderSpriteSegmentForSprite(seg, s, 50);
  hook.restore();

  expect(hook.cap.called, `R3: sequencer reached`);
  expect(hook.cap.stateRef === live,
    `R3: renderState object identity preserved across display 0→1 with empty incoming`);
  expect(hook.cap.state.shiftReg === SENTINEL_SHIFT,
    `R3: shiftReg preserved (isNew branch must not clobber with empty), got 0x${hook.cap.state.shiftReg.toString(16)} expected 0x${SENTINEL_SHIFT.toString(16)}`);
  expect(hook.cap.state.validMask === preValidMask,
    `R3: validMask preserved`);
  ok('R3: display 0→1 transition with empty incoming → live renderState preserved (the nine.prg Y-match re-trigger case)');
}

// ─── R4: empty incoming + EMPTY renderState → fresh state created ───────
//
// Edge case: validMask === 0 means the existing state has no valid pixel
// data either. Preservation must NOT fire (haveValidState is false) — the
// renderer must proceed with the normal reseed/isNew path. Otherwise a
// genuinely-empty sprite line would inherit stale empty state forever.
{
  const vic = makeVic();
  const s = 3;
  const spriteLeft = 50;

  vic._spriteLineStarted[s] = 1;
  vic._spriteLinePrevSegDisplayOn[s] = 0;
  vic._spriteLineLeft[s] = spriteLeft;
  vic._spriteLineLastShiftReg[s] = 0;
  vic._spriteLineLastRowByteMask[s] = 0;
  vic._spriteLineLastDataRow[s] = 5;
  // State exists but its validMask is 0 (was created from rowByteMask=0).
  const stale = vic._createSpriteRenderState(0, 0, spriteLeft, spriteLeft, false, false);
  vic._spriteLineRenderState[s] = stale;
  expect(stale.validMask === 0, `R4 setup: stale renderState validMask must be 0`);

  // shouldReseed: prev=0 + displayOn=1 → isNew transition (segDisplayOn && !prev).
  const seg = buildFakeSeg(vic, s, {
    shiftReg: 0, rowByteMask: 0, displayOn: 1, dataRow: 5,
    start: 200, end: 208, cycle: 30,
  });

  const hook = hookSequencer(vic);
  vic._renderSpriteSegmentForSprite(seg, s, 50);
  hook.restore();

  expect(hook.cap.called, `R4: sequencer reached`);
  expect(hook.cap.stateRef !== null, `R4: renderState created (not left null)`);
  // Preservation guard MUST NOT fire (no live data to preserve) — the
  // isNew branch took the else-if and created a fresh state.
  expect(hook.cap.stateRef !== stale,
    `R4: a fresh renderState was created (stale validMask=0 not preserved as live)`);
  ok('R4: empty incoming + validMask=0 existing → preservation guard does not block fresh-state creation');
}

console.log(`\n${testNo} sprite Y-match re-trigger spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
