// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/vic2-line.js – VIC-II raster-line state machine (methods of VIC2):
// per-cycle register/state capture, the cycle raster/sprite segment builders,
// display & text-window state, bad-line DMA sequencing (Bauer §3.5/§3.7),
// DRAM refresh, and the vertical/horizontal border flip-flops (Bauer §3.9).

import {
  ACCESS_C, ACCESS_G, ACCESS_IDLE, ACCESS_REFRESH, CANVAS_H, CYCLES_PER_LINE,
  GRAPHICS_WINDOW_END, GRAPHICS_WINDOW_START,
} from './vic2-tables.js';

// Method group installed onto VIC2.prototype by vic2.js — `this` is the
// VIC2 chip instance. See the partial-class assembly note there.
export const lineOps = {

  _captureCycleState(cycle, vBorderBefore = this.vBorderActive, hBorderBefore = this.hBorderActive) {
    if (cycle < 1 || cycle > CYCLES_PER_LINE) return;

    // Per-cycle unified BA sample — populated every cycle of EVERY line (not
    // gated on trace or visibility) so _spriteAecLow's c-3 lookback (which
    // crosses line boundaries via prevLineExternalBaLow) can read historical
    // state. Live evaluation here is correct because we're recording the
    // present cycle's BA, not a back-reference.
    this.lineCycleExternalBaLow[cycle] =
      (this._isBadLineBaLow(cycle) || this._spriteBaLow(cycle)) ? 1 : 0;

    // Idle g-access ($3FFF / $39FF). Bauer §3.13: the VIC re-reads the idle
    // source LIVE every cycle, so a mid-line CPU write to it applies on the
    // next idle access in the SAME line. This read also drives the VIC
    // internal + shared external data bus as a SIDE EFFECT (open-bus reads /
    // sprite idle-fetch), so it must run on EVERY line regardless of canvas
    // visibility and from the LIVE registers (ECM bit selects the address).
    // Computed before the visibility gate; the renderer-only store into
    // lineCycleIdleByte[cycle] happens inside the gate below.
    //
    // The 40 g-accesses are at cycles 16..55 (Bauer §3.7.2: the c-access at
    // cycle 15 feeds the g-access at cycle 16) — ONLY then does the VIC drive
    // the shared open bus with the (ECM-aware) g-byte. Cycles 56 & 57 are
    // pure-idle DRAM accesses to $3FFF (ECM-INDEPENDENT — NOT $39FF) that also
    // drive the bus. Outside [16,57] the bus is driven by refresh (11..15) /
    // sprite p+s accesses, or holds its last real value (the DRAM-refresh byte
    // from cycles 11..15, which walks $3Fxx). This per-cycle PHI1 fetch type is
    // exactly what testprogs/VICII/phi1timing measures via open-bus $DEAD reads,
    // and the surviving refresh-walk is what testprogs/C64/openio needs.
    const gAccessCycle = (cycle >= 16 && cycle <= 55);
    let idleByte = this._readIdleGByte(this.regs, this.currentVicBank, gAccessCycle);

    // Pure-idle bus drive (cycles 56 & 57): between the last g-access (cy55)
    // and sprite 0's p-access (cy58) the VIC performs idle accesses to $3FFF
    // and drives them onto the open bus — independent of ECM (a g-access would
    // read $39FF here). phi1timing reads 'i' (= $3FFF content) on these.
    if ((cycle === 56 || cycle === 57) && this.memory) {
      this.memory.externalDataBus8 = this._vicMemRead(0x3FFF, this.currentVicBank) & 0xFF;
    }

    // Bauer §3.14.6 (DMA delay / VSP): when a Bad Line Condition is raised
    // mid-line while the sequencer is in idle state, the idle g-access of the
    // trigger cycle is sourced from a glitch address ($38FF on 6569,
    // $3807 on 8565) instead of $3FFF/$39FF. The rising edge latches the
    // affected lineCycleIdleByte index on the idle→display transition; when
    // that index is the CURRENT (not-yet-captured) cycle — the 6569 case,
    // where the renderer samples idle bytes with regOffset 0 — we consume it
    // here so the glitch byte is the one stored. (The 8565 case targets the
    // PREVIOUS, already-captured cycle and is patched directly in
    // _onBadLineConditionEdge.) See testprogs/VICII/vsp-tester.
    if (this._vspGlitchGCycle === cycle) {
      idleByte = this._vicReadWithBank(this._vspIdleGlitchAddr, this.currentVicBank);
    }

    // Everything below feeds ONLY the renderer (visible canvas lines, raster
    // 15..15+CANVAS_H-1) or the gated frame-trace path. On lines that emit no
    // canvas pixels the ~220-element per-cycle snapshot is never consumed, so
    // skip it. (lineCycleExternalBaLow + the idle-bus read above already ran
    // unconditionally.) Spec tests that probe these renderer-feed buffers run
    // on a visible raster so they still exercise this path.
    const canvasY = this.raster - 15;
    if ((canvasY < 0 || canvasY >= CANVAS_H) && !this.frameTraceEnabled) return;

    // (B2) The register snapshot is deduped below (alongside the row/sprite
    // snapshots); the in-capture HInner reader uses live this.regs, identical
    // to whatever the snapshot buffer will hold this cycle.
    const displayColumnActive = this._isDisplayColumnPhase(cycle);
    this.lineCycleBanks[cycle] = this.currentVicBank;
    this.lineCycleDisplayEnabled[cycle] = this.displayEnabled ? 1 : 0;
    this.lineCycleDisplayActive[cycle] = this.displayActive ? 1 : 0;
    this.lineCycleDisplayPending[cycle] = this.lineBadLineDisplayPending ? 1 : 0;
    this.lineCycleDisplayColumnActive[cycle] = displayColumnActive ? 1 : 0;
    this.lineCycleMatrixFetchActive[cycle] = this._isBadLineFetchPhase(cycle) ? 1 : 0;
    // These fields are only consumed by debug snapshots / trace dumps —
    // never by the renderer. Skip them when tracing is disabled to avoid
    // ~5 function calls + array writes per CPU cycle in the hot path.
    if (this.frameTraceEnabled) {
      this.lineCycleAccessType[cycle] = this._getTextAccessType(cycle);
      this.lineCycleTextAccessPhi1[cycle] = this._getTextPhase1AccessType(cycle);
      this.lineCycleTextAccessPhi2[cycle] = this._getTextPhase2AccessType(cycle);
      this.lineCycleSpriteBaLow[cycle] = this._spriteBaLow(cycle) ? 1 : 0;
      this.lineCycleSpriteAecLow[cycle] = this._spriteAecLow(cycle) ? 1 : 0;
    }
    this.lineCycleVBorderBefore[cycle] = vBorderBefore ? 1 : 0;
    this.lineCycleVBorder[cycle] = this.vBorderActive ? 1 : 0;
    this.lineCycleHBorderBefore[cycle] = hBorderBefore ? 1 : 0;
    this.lineCycleHBorder[cycle] = this.hBorderActive ? 1 : 0;
    this.lineCycleHInner[cycle] = this._computeHorizontalInnerWindow(cycle, this.regs) ? 1 : 0;
    const matrixVc = this._getCycleMatrixVc(cycle);
    this.lineCycleVc[cycle] = matrixVc;
    this.lineCycleRc[cycle] = this.rc;
    this.lineCycleRowVcBase[cycle] = this.rowVcBase;
    // VCBASE is stable across the c-access/g-access window (it only updates at
    // cy58 when RC==7), so sampling it live here gives this line's bitmap base.
    this.lineCycleRowLiveVcBase[cycle] = this.vcBase & 0x03FF;

    // Capture-state snapshot dedup. The row + sprite source arrays change only
    // at discrete events within a line, so most cycles would re-copy identical
    // bytes. When the version counter is unchanged since the last captured
    // cycle, ALIAS the previous snapshot buffer (slot ← lastRef) instead of
    // copying; otherwise copy into this cycle's OWN home buffer (never one an
    // earlier cycle of this line still references — see ctor) and become the
    // new lastRef. Line-start reset forces cy1 to copy so no alias spans a line.
    // Gated; frame-trace force-copies. The register snapshot (above) and all
    // scalar stores are NOT deduped (regs is dirtied mid-line by $D01E/$D01F).
    if (cycle === 1) { this._rowSnapLastVer = -1; this._sprSnapLastVer = -1; this._regSnapLastVer = -1; }
    const dedup = this.captureDedup && !this.frameTraceEnabled;

    // (B2) Register snapshot: alias the previous cycle's buffer when no CPU
    // register write has happened since (version unchanged), else copy into
    // this cycle's OWN home buffer. Mirrors the row/sprite dedup below; cy1
    // forces a copy (lastVer reset above) so no alias spans a line boundary.
    // When dedup is off (or frame-trace), the else-branch copies every cycle —
    // identical to the old unconditional regs.set(this.regs).
    if (dedup && this._regSnapVersion === this._regSnapLastVer) {
      this.lineCycleRegs[cycle] = this._regSnapRef;
    } else {
      const rg = this._homeRegs[cycle];
      rg.set(this.regs);
      this.lineCycleRegs[cycle] = this._regSnapRef = rg;
      this._regSnapLastVer = this._regSnapVersion;
    }

    if (dedup && this._rowSnapVersion === this._rowSnapLastVer) {
      this.lineCycleRowFetchedCols[cycle] = this._rowFetchedRef;
      this.lineCycleRowCodes[cycle]       = this._rowCodesRef;
      this.lineCycleRowColors[cycle]      = this._rowColorsRef;
      if (this.captureDedupVerify) this._verifyRowAlias(cycle);
    } else {
      const fc = this._homeRowFetchedCols[cycle];
      const cd = this._homeRowCodes[cycle];
      const cl = this._homeRowColors[cycle];
      fc.set(this.rowFetchedCols); cd.set(this.rowScreenCodes); cl.set(this.rowColorNibbles);
      this.lineCycleRowFetchedCols[cycle] = this._rowFetchedRef = fc;
      this.lineCycleRowCodes[cycle]       = this._rowCodesRef   = cd;
      this.lineCycleRowColors[cycle]      = this._rowColorsRef  = cl;
      this._rowSnapLastVer = this._rowSnapVersion;
    }
    this.lineCycleIdleByte[cycle] = idleByte;
    // rowFetchD011/D016/D018 are line-invariant; consumed via the line
    // scalars in `_buildCycleSegments`. No per-cycle copy needed.
    if (dedup && this._sprSnapVersion === this._sprSnapLastVer) {
      this.lineCycleSpriteDisplayOn[cycle]    = this._sprDisplayOnRef;
      this.lineCycleSpriteDataRow[cycle]      = this._sprDataRowRef;
      this.lineCycleSpriteDataBase[cycle]     = this._sprDataBaseRef;
      this.lineCycleSpriteDataBank[cycle]     = this._sprDataBankRef;
      this.lineCycleSpritePointerValue[cycle] = this._sprPointerRef;
      this.lineCycleSpriteRowByteMask[cycle]  = this._sprByteMaskRef;
      this.lineCycleSpriteShiftReg[cycle]     = this._sprShiftRef;
      if (this.captureDedupVerify) this._verifySpriteAlias(cycle);
    } else {
      const a = this._homeSpriteDisplayOn[cycle];    a.set(this.spriteDisplayOn);
      const b = this._homeSpriteDataRow[cycle];      b.set(this.spriteLineDataRow);
      const c2 = this._homeSpriteDataBase[cycle];    c2.set(this.spriteDataBase);
      const d = this._homeSpriteDataBank[cycle];     d.set(this.spriteDataBank);
      const e = this._homeSpritePointerValue[cycle]; e.set(this.spritePointerValue);
      const f = this._homeSpriteRowByteMask[cycle];  f.set(this.spriteRowByteMask);
      const g = this._homeSpriteShiftReg[cycle];     g.set(this.spriteShiftReg);
      this.lineCycleSpriteDisplayOn[cycle]    = this._sprDisplayOnRef = a;
      this.lineCycleSpriteDataRow[cycle]      = this._sprDataRowRef   = b;
      this.lineCycleSpriteDataBase[cycle]     = this._sprDataBaseRef  = c2;
      this.lineCycleSpriteDataBank[cycle]     = this._sprDataBankRef  = d;
      this.lineCycleSpritePointerValue[cycle] = this._sprPointerRef   = e;
      this.lineCycleSpriteRowByteMask[cycle]  = this._sprByteMaskRef  = f;
      this.lineCycleSpriteShiftReg[cycle]     = this._sprShiftRef     = g;
      this._sprSnapLastVer = this._sprSnapVersion;
    }
  },

  // captureDedupVerify helpers: assert an aliased snapshot still equals the live
  // source. A failure means a writer mutated a source array without bumping the
  // version counter (the dedup would then serve a stale snapshot).
  _verifyRowAlias(cycle) {
    this._assertSnapEq(this._rowFetchedRef, this.rowFetchedCols, cycle, 'rowFetchedCols');
    this._assertSnapEq(this._rowCodesRef, this.rowScreenCodes, cycle, 'rowCodes');
    this._assertSnapEq(this._rowColorsRef, this.rowColorNibbles, cycle, 'rowColors');
  },
  _verifySpriteAlias(cycle) {
    this._assertSnapEq(this._sprDisplayOnRef, this.spriteDisplayOn, cycle, 'spriteDisplayOn');
    this._assertSnapEq(this._sprDataRowRef, this.spriteLineDataRow, cycle, 'spriteDataRow');
    this._assertSnapEq(this._sprDataBaseRef, this.spriteDataBase, cycle, 'spriteDataBase');
    this._assertSnapEq(this._sprDataBankRef, this.spriteDataBank, cycle, 'spriteDataBank');
    this._assertSnapEq(this._sprPointerRef, this.spritePointerValue, cycle, 'spritePointerValue');
    this._assertSnapEq(this._sprByteMaskRef, this.spriteRowByteMask, cycle, 'spriteRowByteMask');
    this._assertSnapEq(this._sprShiftRef, this.spriteShiftReg, cycle, 'spriteShiftReg');
  },
  _assertSnapEq(aliased, live, cycle, name) {
    for (let i = 0; i < live.length; i++) {
      if (aliased[i] !== live[i]) {
        throw new Error(`[captureDedupVerify] L${this.raster}.c${cycle} ${name}[${i}] ` +
          `aliased=${aliased[i]} live=${live[i]} — a writer didn't bump the version counter`);
      }
    }
  },

  // (B2) Ensure lineCycleRegs[cycle] points to its OWN home buffer (not a
  // shared/aliased one), copying the current contents across if it was aliased.
  // Used before any in-place patch of a captured reg snapshot so the patch can
  // never leak into another cycle that shares the buffer.
  _unaliasRegSnapshot(cycle) {
    const home = this._homeRegs[cycle];
    const cur = this.lineCycleRegs[cycle];
    if (cur !== home) {
      home.set(cur);
      this.lineCycleRegs[cycle] = home;
      return home;
    }
    return cur;
  },

  _getCycleMatrixVc(cycle) {
    return this.vc & 0x03FF;
  },

  _getVerticalDisplayRange(regs) {
    const rsel = (regs[0x11] >> 3) & 1;
    const top = rsel ? 51 : 55;
    // Returns a fresh object — a shared scratch would alias across callers that
    // hold the result (a test does). The two HOT callers (_beginRasterLine,
    // _canOpenVerticalDisplayPhase) inline this math instead so they allocate
    // nothing on JSC/mobile; this method is retained for tests / non-hot use.
    return {
      top,
      bottom: top + (rsel ? 200 : 192),
    };
  },

  _isDisplayColumnPhase(cycle) {
    // Bauer §3.7.1: in DISPLAY STATE the VIC fetches g-data from the video
    // matrix in the visible column window (cycles 15..54), unless the vertical
    // border FF covers the line. Display state is exactly `displayActive` —
    // set at the top bad line, cleared at cycle 58 of the rc==7 line
    // (_advanceDisplayStateCycle58). The legacy `raster >= top && raster <
    // bottom` clamp that used to gate this was the same emulator-only
    // heuristic removed from the display-state END logic; it clipped programs
    // that extend the display past the RSEL window to render extra text rows
    // (frodotests/text26 — RSEL=0 at L248 made the clamp end at 247). For
    // normal frames displayActive already bounds the display region; open
    // (idle) border zones have displayActive=0, so they still render idle.
    if (!this.displayEnabled || !this.displayActive || this.vBorderActive) return false;
    if (cycle < 15 || cycle > 54) return false;
    return true;
  },

  _canOpenVerticalDisplayPhase(raster) {
    // Inlined _getVerticalDisplayRange: its {top,bottom} object is escape-
    // analyzed away on V8 but allocates on every call on JSC/mobile (no EA).
    // This runs per bad-line check — see the perf doc's idle-alloc notes.
    const rsel = (this.regs[0x11] >> 3) & 1;
    const top = rsel ? 51 : 55, bottom = top + (rsel ? 200 : 192);
    return this.displayEnabled &&
      (this.displayActive || this.lineBadLineDisplayPending) &&
      raster >= top &&
      raster < bottom;
  },

  _clearBadLineFetchPhase() {
    this.lineBadLineDisplayPending = false;
    this.lineBadLineStartCycle = -1;
    this.lineBadLineInvalidCReadsPending = 0;
    this.lineMatrixFetchCol = -1;
  },

  _resetTextState() {
    this.displayActive = false;
    this.vc = 0;
    this.vcBase = 0;
    this.vmli = 0;
    // RC is deliberately NOT reset here. Per Bauer §3.7.2 rule 2, RC is
    // cleared ONLY in phase 1 of cycle 14 when there is a Bad Line Condition
    // — there is no frame-start / display-enable RC reset on real silicon.
    // RC therefore carries its value (7, left by the previous frame's final
    // display row) through the idle top border. This matters when a Bad Line
    // is forced LATE (after cycle 14) before the frame's first natural bad
    // line: the late bad line does not reset RC, so RC is still 7 at cycle
    // 58, which makes VCBASE←VC fire and shifts every subsequent row. That is
    // exactly the testprogs/VICII/screenpos "screen shifts 2 chars right"
    // effect. Zeroing RC here suppressed the shift. Power-on RC=0 is set in
    // reset(); this method runs only at raster 0 (frame start) and reset().
    this._clearBadLineFetchPhase();
  },

  _deactivateTextDisplay() {
    this.displayActive = false;
  },

  _activateBadLineTextState() {
    this.displayActive = true;
  },

  _clearFetchedRowState() {
    this.rowScreenCodes.fill(0);
    this.rowColorNibbles.fill(0);
    this.rowFetchedCols.fill(0);
    this.rowVcBase = 0;
    this._rowSnapVersion++;   // capture-dedup: row source changed
  },

  _beginFetchedRowFromVcBase() {
    // Bauer §3.14.6 (DMA delay / VSP): the matrix-row buffer persists
    // across bad-lines. A delayed bad-line that performs only N c-accesses
    // refreshes cols 0..N-1 only; cols N..39 retain codes/colors from the
    // previous bad-line, producing a horizontal screen shift. Do NOT
    // reset rowFetchedCols here — frame-boundary _clearFetchedRowState
    // is the only legitimate clearer.
    this.rowVcBase = (this.vc - this.vmli) & 0x03FF;
    this.rowFetchD011 = this.regs[0x11];
    this.rowFetchD016 = this.regs[0x16];
    this.rowFetchD018 = this.regs[0x18];
  },

  _beginBadLineFetchPhase() {
    this.lineBadLineInvalidCReadsActive = this.lineBadLineInvalidCReadsPending;
    this._activateBadLineTextState();
    this._clearBadLineFetchPhase();
    // Bauer §3.7.2/§3.14.6: the c-accesses store into the internal
    // video-matrix/color line buffer at the CURRENT VMLI position, not at
    // column 0. VMLI is reset to 0 at cycle 14 and then incremented by every
    // g-access while in display state (_advanceDisplayStateGAccess). So a
    // bad-line that begins at the canonical cycle 15 has VMLI=1 here (cycle
    // 15's g-access already ran) → fetch starts at column 0 (normal/FLI/VSP
    // case, unchanged). But a bad-line triggered LATE — e.g. spritecrunch2's
    // "bad line every line" forced by a YSCROLL write near cycle 50 — has had
    // ~35 g-accesses advance VMLI first, so its handful of late c-accesses
    // (the three invalid $FF open-bus reads + valid data) store at the RIGHT
    // edge of the buffer (cols ~35-39), matching VICE. Filling from column 0
    // put that artifact on the LEFT edge instead (spritecrunch2-07 checker).
    // The unfetched columns keep the previous bad-line's codes/colors.
    this.lineMatrixFetchCol = Math.max(0, this.vmli - 1);
    this._beginFetchedRowFromVcBase();
  },

  _computeHorizontalInnerWindow(cycle, regs) {
    if (cycle < 11 || cycle > 58) return false;
    const segStart = this._getCycleStartX(cycle) + 8;
    const segEnd = this._getCycleEndX(cycle) + 8;
    return segEnd > GRAPHICS_WINDOW_START && segStart < GRAPHICS_WINDOW_END;
  },

  _clearCycleState() {
    // The single-byte per-cycle arrays use cheap vectorized fills.
    // Cycle 0 retains these defaults (it is never written by
    // _captureCycleState, which gates on cycle ≥ 1). Cycles 1..63 will be
    // overwritten by per-cycle captures during the upcoming line, so the
    // line-start init for those slots is redundant — but the fills below
    // are O(64 bytes) memsets, negligible in practice.
    this.lineCycleBanks.fill(this.currentVicBank);
    this.lineCycleDisplayEnabled.fill(0);
    this.lineCycleDisplayActive.fill(0);
    this.lineCycleDisplayPending.fill(0);
    this.lineCycleDisplayColumnActive.fill(0);
    this.lineCycleMatrixFetchActive.fill(0);
    if (this.frameTraceEnabled) {
      this.lineCycleAccessType.fill(ACCESS_IDLE);
      this.lineCycleTextAccessPhi1.fill(ACCESS_IDLE);
      this.lineCycleTextAccessPhi2.fill(ACCESS_IDLE);
      this.lineCycleSpriteBaLow.fill(0);
      this.lineCycleSpriteAecLow.fill(0);
    }
    this.lineCycleCWriteCol.fill(-1);
    this.lineCycleExternalBaLow.fill(0);
    // NOTE: prevLineExternalBaLow is INTENTIONALLY not cleared here. It is
    // the previous-line BA history snapshot, written by _beginRasterLine
    // (line 1590) and consumed by _spriteAecLowHistoric at cy 1..3 of each
    // line. Clearing it here corrupts the c-3 lookback across line
    // boundaries — AEC then glitches HIGH for cycles 1..3 of every raster
    // line while BA is still low (verified by
    // test/ba-contour-3ad-spec-test.js).
    this.lineCycleVBorderBefore.fill(1);
    this.lineCycleVBorder.fill(1);
    this.lineCycleHBorderBefore.fill(1);
    this.lineCycleHBorder.fill(1);
    this.lineCycleHInner.fill(0);
    this.lineCycleVc.fill(0);
    this.lineCycleRc.fill(0);
    this.lineCycleRowVcBase.fill(0);
    this.lineCycleRowLiveVcBase.fill(0);
    this.lineCycleIdleByte.fill(this.lineIdleByte);
    // The per-cycle outer-fill loop that initialized
    //   lineCycleRegs[cycle].set(this.regs)
    //   lineCycleRowFetchedCols/Codes/Colors[cycle].fill(0)
    //   lineCycleSpriteDisplayOn/DataRow/DataBase/DataBank[cycle].fill(...)
    //   lineCycleSpritePointerValue/RowByteMask/ShiftReg[cycle].fill(...)
    // was previously dropped here — those slots are fully overwritten by
    // _captureCycleState every cycle 1..63 of the upcoming line, and
    // cycle 0 is never read by the runtime. Removing this loop saves
    // ~10 KB of redundant typed-array work per line.
  },

  _buildCycleRasterSegments() {
    // Batch path (legacy / tests). Snapshot the scratch into fresh
    // objects per cycle so the array can be held across calls — the
    // single-cycle path mutates _scratchRasterSeg.
    const segments = [];
    for (let cycle = 11; cycle <= 58; cycle++) {
      this._buildCycleRasterSegment(cycle);
      segments.push(this._cloneRasterSeg(this._scratchRasterSeg));
    }
    return segments;
  },

  // Build the cycle raster-segment object for a single cycle. Used by
  // both the batch-build (above) and the cycle-incremental dispatch
  // path which needs to build a segment ONLY for the current cycle.
  // Mutates and returns this._scratchRasterSeg — the caller must
  // consume it before the next call.
  _buildCycleRasterSegment(cycle) {
    // 8565 pipeline delay: register samples reach the rendering stage
    // ONE cycle later than on 6569. We model this by reading from the
    // previous cycle's snapshot. cycle-1 ≥ 10 within this loop's range
    // (cycle 11..58), so lineCycleRegs[cycle-1] is always valid.
    const regOffset = this._regOffset;
    const regCycle = cycle + regOffset;
    const cycleStartX = this._getCycleStartX(cycle) + 8;
    const seg = this._scratchRasterSeg;
    seg.start = cycleStartX;
    seg.end = this._getCycleEndX(cycle) + 8;
    seg.regs = this.lineCycleRegs[regCycle];
    seg.bank = this.lineCycleBanks[cycle];
    seg.displayEnabled = !!this.lineCycleDisplayEnabled[cycle];
    seg.displayActive = !!this.lineCycleDisplayActive[cycle];
    seg.displayPending = !!this.lineCycleDisplayPending[cycle];
    seg.displayColumnActive = !!this.lineCycleDisplayColumnActive[cycle];
    seg.matrixFetchActive = !!this.lineCycleMatrixFetchActive[cycle];
    seg.vBorderBefore = !!this.lineCycleVBorderBefore[cycle];
    seg.vBorder = !!this.lineCycleVBorder[cycle];
    seg.hBorderBefore = !!this.lineCycleHBorderBefore[cycle];
    seg.hBorder = !!this.lineCycleHBorder[cycle];
    seg.cselComparator = this.lineCycleCselComparator[cycle];
    seg.hInner = !!this.lineCycleHInner[cycle];
    seg.vc = this.lineCycleVc[cycle];
    seg.rc = this.lineCycleRc[cycle];
    seg.cycle = cycle;
    seg.cycleStart = cycleStartX;
    seg.prevRegs = cycle > 0 ? this.lineCycleRegs[cycle - 1 + regOffset] : this.lineCycleRegs[regCycle];
    // CB and bitmap-base are sampled at the g-access cycle (= seg cycle + 1
    // per Bauer §3.7.2): c-access at cy 15+K phi2 fetches VM/code; g-access
    // at cy 16+K phi1 fetches bitmap using $D018 CB bits. A CPU write at
    // cy N phi2 is visible to VIC from cy N+1 phi1 (Bauer §3.6.3), so a
    // write at cy (15+K) phi2 lands in time for col K's g-access.
    // nextRegs is the snapshot captured at the START of cy (cycle+1) =
    // state at (cycle+1) phi1 = AFTER any cycle-K phi2 CPU write.
    seg.nextRegs = (regCycle + 1 <= CYCLES_PER_LINE)
      ? this.lineCycleRegs[regCycle + 1]
      : this.lineCycleRegs[regCycle];
    // Default mode source = the g-access snapshot (seg.nextRegs, +1). The
    // end-of-line mode-transition fixup (_fixupColumns) overrides this with
    // the +2 snapshot for the columns that need it.
    seg.modeRegs = seg.nextRegs;
    // XSCROLL gates graphics-shifter reload timing. The incremental render
    // uses the live-cycle snapshot; _fixupColumns can override with the
    // delayed output-stage sample after the whole line has been captured.
    seg.xscrollRegs = null;
    // Reset the border-timed bg snapshot every build: the scratch segment
    // is reused, and a stale snapshot left by a prior _fixupColumns Pass 1
    // would otherwise leak into the incremental render / Pass 2. NULL means
    // "read bg live from seg.regs" (the incremental render's behaviour).
    seg.bgRegs = null;
    seg.bgPrevRegs = null;
    seg.rowVcBase = this.lineCycleRowVcBase[cycle];
    seg.liveVcBase = this.lineCycleRowLiveVcBase[cycle];
    seg.rowFetchedCols = this.lineCycleRowFetchedCols[cycle];
    seg.rowCodes = this.lineCycleRowCodes[cycle];
    seg.rowColors = this.lineCycleRowColors[cycle];
    // The idle g-access reads $3FFF (or $39FF when ECM=1) — its ADDRESS
    // tracks ECM, so the fetched byte must be sampled at the same g-access
    // cycle (+1, = nextRegs / seg.modeRegs) as the mode bits, not at the
    // render cycle (+0). Sampling at +0 left the idle ghost byte one column
    // behind a mid-line ECM flip: nine's pixel-pipeline probe flips
    // $D011 $5C->$1C (ECM 1->0) mid-line, and the +0 sampling kept the ECM
    // idle byte ($39FF = foreground) one column too long. That stray fg
    // column collided with sprite 0, flipping $D01F bit0 and mis-selecting
    // the demo's timed-code variant. (Bauer §3.7.2 / §3.6.3: g-access at
    // cy 16+K phi1 sees a cy (15+K) phi2 write.)
    const idleCycle = (regCycle + 1 <= CYCLES_PER_LINE) ? regCycle + 1 : regCycle;
    seg.idleByte = this.lineCycleIdleByte[idleCycle];
    // The byte the shifter is still DRAINING during this segment's first
    // XSCROLL pixels (Bauer §3.7.3: the reload is delayed by XSCROLL, so
    // until it happens the previous g-access byte keeps shifting out). That
    // is the byte fetched one g-access earlier = this segment's own cycle.
    // Identical to seg.idleByte on steady idle lines; differs only across a
    // mid-line idle-fetch change (ECM flip, VIC bank switch, VSP glitch).
    seg.idleBytePrev = this.lineCycleIdleByte[regCycle];
    seg.rowFetchD011 = this.rowFetchD011;
    seg.rowFetchD016 = this.rowFetchD016;
    seg.rowFetchD018 = this.rowFetchD018;
    return seg;
  },

  // Copy all raster-seg fields from src to dst. Used by the batch
  // builder (legacy) and by the splitter to mirror seg into scratch
  // parts before overriding the 4 split-mutable fields.
  _copyRasterSeg(src, dst) {
    dst.start = src.start;
    dst.end = src.end;
    dst.regs = src.regs;
    dst.bank = src.bank;
    dst.displayEnabled = src.displayEnabled;
    dst.displayActive = src.displayActive;
    dst.displayPending = src.displayPending;
    dst.displayColumnActive = src.displayColumnActive;
    dst.matrixFetchActive = src.matrixFetchActive;
    dst.vBorderBefore = src.vBorderBefore;
    dst.vBorder = src.vBorder;
    dst.hBorderBefore = src.hBorderBefore;
    dst.hBorder = src.hBorder;
    dst.cselComparator = src.cselComparator;
    dst.hInner = src.hInner;
    dst.vc = src.vc;
    dst.rc = src.rc;
    dst.cycle = src.cycle;
    dst.cycleStart = src.cycleStart;
    dst.prevRegs = src.prevRegs;
    dst.nextRegs = src.nextRegs;
    dst.modeRegs = src.modeRegs;
    dst.xscrollRegs = src.xscrollRegs;
    dst.bgRegs = src.bgRegs;
    dst.bgPrevRegs = src.bgPrevRegs;
    dst.rowVcBase = src.rowVcBase;
    dst.liveVcBase = src.liveVcBase;
    dst.rowFetchedCols = src.rowFetchedCols;
    dst.rowCodes = src.rowCodes;
    dst.rowColors = src.rowColors;
    dst.idleByte = src.idleByte;
    dst.idleBytePrev = src.idleBytePrev;
    dst.rowFetchD011 = src.rowFetchD011;
    dst.rowFetchD016 = src.rowFetchD016;
    dst.rowFetchD018 = src.rowFetchD018;
  },

  _cloneRasterSeg(src) {
    const dst = this._makeEmptyRasterSeg();
    this._copyRasterSeg(src, dst);
    return dst;
  },

  _buildCycleSpriteSegments() {
    const segments = [];
    for (let cycle = 11; cycle <= 58; cycle++) {
      this._buildCycleSpriteSegment(cycle);
      segments.push(this._cloneSpriteSeg(this._scratchSpriteSeg));
    }
    return segments;
  },

  _buildCycleSpriteSegment(cycle) {
    // 8565 pipeline delay applies to sprite-segment regs too — sprite
    // X-position / color / multicolor / X-expand registers are sampled
    // for emission with the same 1-cycle delay as the graphics pipeline.
    const regOffset = this._regOffset;
    const seg = this._scratchSpriteSeg;
    seg.start = this._getCycleStartX(cycle) + 8;
    seg.end = this._getCycleEndX(cycle) + 8;
    seg.regs = this.lineCycleRegs[cycle + regOffset];
    seg.bank = this.lineCycleBanks[cycle];
    seg.spriteDisplayOn = this.lineCycleSpriteDisplayOn[cycle];
    seg.spriteDataRow = this.lineCycleSpriteDataRow[cycle];
    seg.spriteDataBase = this.lineCycleSpriteDataBase[cycle];
    seg.spriteDataBank = this.lineCycleSpriteDataBank[cycle];
    seg.spritePointerValue = this.lineCycleSpritePointerValue[cycle];
    seg.spriteRowByteMask = this.lineCycleSpriteRowByteMask[cycle];
    seg.spriteShiftReg = this.lineCycleSpriteShiftReg[cycle];
    return seg;
  },

  _cloneSpriteSeg(src) {
    const dst = this._makeEmptySpriteSeg();
    dst.start = src.start;
    dst.end = src.end;
    dst.regs = src.regs;
    dst.bank = src.bank;
    dst.spriteDisplayOn = src.spriteDisplayOn;
    dst.spriteDataRow = src.spriteDataRow;
    dst.spriteDataBase = src.spriteDataBase;
    dst.spriteDataBank = src.spriteDataBank;
    dst.spritePointerValue = src.spritePointerValue;
    dst.spriteRowByteMask = src.spriteRowByteMask;
    dst.spriteShiftReg = src.spriteShiftReg;
    return dst;
  },

  _beginRasterLine(raster) {
    const d011 = this.regs[0x11];
    const den = (d011 >> 4) & 1;
    // Inlined _getVerticalDisplayRange — called every raster line; its
    // {top,bottom} object is EA'd on V8 but allocates each line on JSC/mobile.
    const rsel = (d011 >> 3) & 1;
    const topCompare = rsel ? 51 : 55, bottomCompare = topCompare + (rsel ? 200 : 192);
    // Snapshot $D011 for the mid-line mode-flip checks in
    // _isDisplayColumnPhase + _advanceDisplayStateLineEnd. Save the prior
    // line's snapshot to _prevLineStartD011 first so _beginTextStateCycle1
    // (which fires after this) can consult it.
    this._prevLineStartD011 = this._lineStartD011;
    this._lineStartD011 = d011;
    // Clear the §3.14.6 VSP idle-byte glitch latch each line (set on the
    // bad-line rising edge by a mid-line idle→display trigger, consumed the
    // same line by _captureCycleState).
    this._vspGlitchGCycle = -1;
    // Snapshot the just-completed line's BA history before we start
    // overwriting it this line. _spriteAecLow's c-3 lookback at cy 1..3
    // reads from prevLineExternalBaLow to get the correct historical
    // (rather than current-state-projected) BA at cy 61..63 of the
    // previous line. Cheap: 64-byte array copy per line.
    this.prevLineExternalBaLow.set(this.lineCycleExternalBaLow);
    this.lineCycleExternalBaLow.fill(0);

    if (raster === 0) {
      this._clearCycleState();
      this.displayEnabled = false;
      this._resetTextState();
      this.refreshCounter = 0xFF;
      this.lineIdleByte = 0x00;
      // Do NOT wipe the video-matrix/color line buffer at the frame boundary.
      // On real silicon the 40-entry line buffer is only written by c-accesses
      // (bad lines) and otherwise RETAINS its content across lines AND frames.
      // A display row that runs before this frame's first c-access therefore
      // shows the previous frame's last-fetched codes/colors, not zeros. This
      // is exactly testprogs/VICII/sequencer-bug: the bitmap "box" char row
      // (L52-59) is entered via the cy58 idle→display transition with no bad
      // line, so it has no c-access — VICE renders it from the retained buffer
      // (screen RAM $F6 → white-on-blue), and wiping it here rendered the box
      // black-on-black (invisible). Only rowVcBase is reset to track VCBASE,
      // which IS reloaded to 0 at the top of every frame (_resetTextState).
      // (reset() still does a full _clearFetchedRowState for a clean power-on.)
      this.rowVcBase = 0;
      this.rowFetchD011 = this.regs[0x11];
      this.rowFetchD016 = this.regs[0x16];
      this.rowFetchD018 = this.regs[0x18];
      // Bauer §3.11: lightpen one-shot trigger re-arms at frame start.
      this._lpLatchedThisFrame = false;
      // VIC-Addendum.txt: if the LP input is held LOW across the frame
      // boundary, the latch retriggers at the start of the new frame
      // even though no fresh negative edge occurred. Latches at L0 c1
      // (= the natural start-of-frame sample), giving LPX = ($194 +
      // 1*8) % 504 = $19C.
      if (this._lpInputLevel === 0) this._latchLightpen();
      // Sprite DMA / display state is NOT reset at the frame boundary. Per
      // Bauer §3.8.1 only rule 3 (DMA-start at cycle 55/56) and rule 8
      // (MCBASE=63 at cycle 16) drive the DMA lifecycle; a sprite that is
      // still mid-display when raster wraps 311 → 0 carries over into the
      // next frame's top border. Forcibly clearing here cuts off such
      // sprites and produces visible "garbage" with top-border multiplexers.
      this.hBorderActive = true;
    }

    // No _resetTextState() at raster $30. Bauer §3.7.2 rule 1 resets VCBASE
    // only OUTSIDE the $30-$f7 bad-line range (done at raster 0 above). At
    // raster $30 cycle 1 VC/VCBASE/displayActive are provably already at
    // their reset values — no Bad Line Condition is possible in lines
    // $00-$2f, so nothing can have advanced them since the raster-0 reset.
    // (Re-running it here was a redundant no-op that did not match the spec.)
    // Line-start render default only — not a real bus cycle, so don't drive
    // the open bus (no VIC g-access happens here).
    this.lineIdleByte = this._readIdleGByte(this.regs, this.currentVicBank, false);
    this.lineBadLineInvalidCReadsActive = 0;
    // Line-local bad-line state — reset per line.
    this._lineBadLineLatch = false;
    this._rcResetDoneThisLine = false;
    this._prevBadLineCondition = false;
    // The c-access state machine is line-local. A partial fetch from a
    // late forced bad-line (matched YSCROLL late in c12-53) that runs out
    // of room before col 40 must NOT continue on the next line — the new
    // line's c-access window is owned by whatever bad-line state the new
    // line establishes. Without this, FPP-style demos that force late
    // bad-lines every line stomp the matrix buffer cross-line, fetching
    // residual cols under the wrong $D018 VM/CB.
    this._clearBadLineFetchPhase();
    this._clearCycleState();
    this.spritePointerFresh.fill(0);
    this._spriteIdleFetchedThisLine.fill(0);
    this._spriteByte0Floats.fill(0);
    for (let s = 0; s < 8; s++) {
      if (this.spriteStopPending[s]) {
        this._endSpriteDisplayLine(s);
      }
    }
  },

  _advanceDisplayStateCycle1(raster) {
    this._beginTextStateCycle1(raster);
  },

  _advanceDisplayStateCycle14(raster) {
    this.vc = this.vcBase & 0x03FF;
    this.vmli = 0;
    if (this._isBadLine(raster, this.regs)) {
      this.rc = 0;
      // Mark the RC=0 side effect done for this line so the ceasing-edge
      // branch doesn't re-fire it later.
      this._rcResetDoneThisLine = true;
    }
  },

  _advanceDisplayStateGAccess() {
    if (!this.displayActive) return;
    this.vc = (this.vc + 1) & 0x03FF;
    this.vmli = (this.vmli + 1) & 0x3F;
  },

  _getTextPhase1AccessType(cycle) {
    if (cycle >= 15 && cycle <= 54 && this.displayActive) return ACCESS_G;
    if (cycle >= 11 && cycle <= 15) return ACCESS_REFRESH;
    return ACCESS_IDLE;
  },

  _getTextPhase2AccessType(cycle) {
    if (this._isBadLineFetchPhase(cycle)) return ACCESS_C;
    return ACCESS_IDLE;
  },

  _getTextAccessType(cycle) {
    const phi2 = this._getTextPhase2AccessType(cycle);
    return phi2 !== ACCESS_IDLE ? phi2 : this._getTextPhase1AccessType(cycle);
  },

  _runTextPhase1Access(cycle) {
    if (cycle >= 11 && cycle <= 15) {
      this._advanceRefreshAccess();
    }
    switch (this._getTextPhase1AccessType(cycle)) {
      case ACCESS_G:
        this._advanceDisplayStateGAccess();
        break;
    }
  },

  _runTextPhase2Access(cycle) {
    switch (this._getTextPhase2AccessType(cycle)) {
      case ACCESS_C:
        if (this.lineBadLineDisplayPending && cycle === this.lineBadLineStartCycle) {
          this._beginBadLineFetchPhase();
        }
        if (this.lineMatrixFetchCol >= 0 && this.lineMatrixFetchCol < 40) {
          const writeCol = this.lineMatrixFetchCol;
          this._fetchScreenRowColumn(writeCol, this.regs, this.currentVicBank);
          // Record the buffer index this cycle's c-access wrote, so the
          // renderer can map screen-column → displayed buffer position (the
          // g-access at this cycle outputs exactly this buffer entry). On
          // normal bad lines writeCol == screen-column (cycle-15); on a late
          // idle→display crunch it lags, which is the displayed shift.
          this.lineCycleCWriteCol[this.cycleInLine] = writeCol;
          this.lineMatrixFetchCol++;
          if (this.lineMatrixFetchCol >= 40) {
            this.lineMatrixFetchCol = -1;
          }
        }
        return true;
      default:
        return false;
    }
  },

  _advanceDisplayStateCycle58(raster) {
    // Bauer §3.7.2 rule 5 + §3.7.1, evaluated at OUR phi2 so a same-cycle CPU
    // $D011 write is visible. The bad-line condition is sampled LIVE here.
    //   - If RC == 7, VCBASE ← VC.
    //   - The video logic is in display state afterwards iff there is a Bad
    //     Line Condition (§3.7.1: "the transition from idle to display state
    //     occurs as soon as there is a Bad Line Condition"). Only then is RC
    //     incremented; an RC==7 line with no bad line drops to idle.
    //
    // This MUST be able to enter display state FROM IDLE — that is the whole
    // point of §3.7.1. A $D011 write late in an otherwise-idle line creates a
    // Bad Line whose only surviving effect is this cy58 transition. In
    // testprogs/VICII/sequencer-bug, bug.prg writes $3B (YSCROLL=3) at cy54 of
    // L51 — past the cy12-54 bad-line fetch window — so display state never
    // activated earlier. With RC carried over as 7 (idle top border), cy58
    // fires VCBASE←VC and RC→0, putting the first bitmap row on the NEXT line
    // (L52), exactly where a real 6569/VICE shows it. The old `if
    // (!this.displayActive) return` guard suppressed that, pushing the first
    // row 8 rasters down to the first *natural* bad line.
    // Bad-line condition for the cy58 transition. Sampled at PHI1 of cycle 58
    // (in clock(), before this cycle's CPU write) when cycle58BadLinePhi1 is
    // set — so a cy57 write counts but a cy58 write does not (real-HW / VICE).
    // The legacy phi2-live read (which incorrectly let a cy58 $D011 write trip
    // a spurious bad line — raster_time_gp bottom-border garbage) is retained
    // behind the flag for A/B.
    const badLine = this.cycle58BadLinePhi1
      ? this._cycle58BadLineSample
      : this._isBadLine(raster, this.regs);

    if (this.rc === 7) {
      this.vcBase = this.vc & 0x03FF;
    }
    if (badLine) {
      this.displayActive = true;
    } else if (this.rc === 7) {
      this.displayActive = false;
    }

    if (this.displayActive) {
      this.rc = (this.rc + 1) & 0x07;
    }

    // §3.7.1: "the transition from idle to display state occurs as soon as
    // there is a Bad Line Condition." A CPU $D011 YSCROLL write at cy58 phi2
    // creates a BL only AFTER the rule-5/6 block above (which used the phi1
    // sample) has run — so reactivate display here from the LIVE condition,
    // WITHOUT a further RC increment (rule 6 already ran while idle). This is
    // what keeps the raster_time_gp / FLI bars rendering on jitter frames
    // whose per-line write lands at cy58: display momentarily idles at cy58
    // phi1 (so RC is NOT incremented → no spurious bad line) then re-enters
    // display state on the same-cycle write (so the next line still draws).
    // Only under the phi1 model; the legacy path already used the live value.
    if (this.cycle58BadLinePhi1 && !badLine && this._isBadLine(raster, this.regs)) {
      this.displayActive = true;
    }
  },

  _isBadLineFetchPhase(cycle) {
    return cycle >= 15 &&
      cycle <= 54 &&
      ((this.lineBadLineDisplayPending && cycle >= this.lineBadLineStartCycle) ||
        this.lineMatrixFetchCol >= 0);
  },

  _isBadLineBaLow(cycle) {
    // Bauer §3.5/§3.6.1. Three sources, in priority order so the most
    // specific (currently-active state) wins for the present-cycle answer
    // and the invariant fallback supplies historical-cycle answers after
    // the transient state has been cleared.
    //
    //   (a) Active matrix fetch (`lineMatrixFetchCol >= 0`): BA low across
    //       the c-access window 15..54.
    //   (b) Pending delayed bad-line (`lineBadLineDisplayPending`): BA low
    //       from `startCycle - 3` (or 12, whichever is later) to 54. This
    //       handles the rare case of a bad-line whose first c-access is
    //       pushed past cycle 15 by some external delay.
    //   (c) Invariant fallback: this raster IS a bad-line per Bauer §3.5
    //       (raster in $30..$F7, YSCROLL match, displayEnabled latched),
    //       so historically BA was low 12..54 regardless of where the
    //       transient counters stand right now. AEC's c-3 lookback depends
    //       on that historical answer after cycle 54 has cleared the live
    //       matrix-fetch counters.
    if (this.lineMatrixFetchCol >= 0) {
      return cycle >= 15 && cycle <= 54;
    }
    if (this.lineBadLineDisplayPending) {
      const baLeadStart = Math.max(12, this.lineBadLineStartCycle - 3);
      return cycle >= baLeadStart && cycle <= 54;
    }
    if (this._isBadLine(this.raster, this.regs)) {
      return cycle >= 12 && cycle <= 54;
    }
    return false;
  },

  _isBaLowCycle(cycle) {
    return this._isBadLineBaLow(cycle) || this._spriteBaLow(cycle);
  },

  _queueBadLineFetchPhase(startCycle) {
    if (startCycle < 15 || startCycle > 54) return;
    let invalidFetches = 0;
    if (startCycle === 15) {
      // If BA wasn't low early enough before cycle 15, the first c-accesses
      // see the open bus instead of matrix data.
      invalidFetches = Math.max(0, this.cycleInLine - 12);
    } else {
      // Late-created bad lines pull BA low in the next cycle and need three
      // cycles before AEC remains low.
      invalidFetches = 3;
    }
    invalidFetches = Math.min(invalidFetches, 55 - startCycle);
    this.lineBadLineDisplayPending = true;
    this.lineBadLineStartCycle = startCycle;
    this.lineBadLineInvalidCReadsPending = invalidFetches;
  },

  _cancelQueuedBadLineFetchPhase() {
    if (this.lineMatrixFetchCol >= 0) return;
    this.lineBadLineDisplayPending = false;
    this.lineBadLineStartCycle = -1;
    this.lineBadLineInvalidCReadsPending = 0;
  },

  _updateBadLineStateForCycle(cycle, raster) {
    const badLine = this._isBadLine(raster, this.regs);

    // Bad-line transition detection: we re-evaluate BL each
    // cycle 1-54 and fire transition handlers on edge. The cy 55-62
    // window is handled separately: see the case 0x11 hook in write()
    // which synchronously re-activates display state when a $D011 write
    // at cy 59-62 produces a fresh BL condition (raster_time_gp's
    // permanent-bad-line trick).
    //
    // The window starts at cycle 1 (not 12) so a Bad Line Condition that
    // is both raised AND cancelled inside cycles 1-11 is still seen as an
    // edge. Bauer §3.7.1: "the transition from idle to display state
    // occurs as soon as there is a Bad Line Condition" — at ANY cycle, not
    // only the c-access window. The DMA-delay/VSP "delay before badline
    // forcing" trick (testprogs/VICII/dmadelay test1/2/3) forces a one-
    // cycle YSCROLL=0 pulse near line $30; for the latest forcing offsets
    // the pulse lands at cy0-1 of line $30, so the ceasing edge that
    // sets displayActive must be caught there. `_prevBadLineCondition` is
    // reset to false by `_beginRasterLine` (cy1, before this call), so a
    // line whose BL is merely carried over from the prior line shows no
    // rising edge here — only a genuine in-line edge fires a transition.
    // The c-access fetch-queue block below keeps its own cycle 12-53 guard,
    // so fetch timing is unaffected.
    const inBLWindow = cycle >= 1 && cycle <= 54;
    if (inBLWindow) {
      const wasBL = this._prevBadLineCondition;
      if (badLine !== wasBL) this._onBadLineConditionEdge(badLine, cycle);
      this._prevBadLineCondition = badLine;
    }

    // Bauer §3.7.2 rule 2: "In the first phase of cycle 14 of each line,
    // VC is loaded from VCBASE and VMLI is cleared. If there is a Bad
    // Line Condition in this phase, RC is also reset to zero." This
    // cycle-14 phi1 sample is the canonical idle → display entry
    // (§3.7.1: "The transition from idle to display state occurs as
    // soon as there is a Bad Line Condition.").
    //
    // Late mid-line transitions (CPU enables BL via $D011 write after
    // cycle 14, or aborts before cycle 14 then re-enables) are picked
    // up by the `_onBadLineConditionEdge` handler.
    //
    // Earlier this set `displayActive = true` at every cycle 1..14
    // where BL was naturally true (residual YSCROLL from the prior
    // line still matching RASTER&7). That made FPP/scroller demos
    // re-enter display state on every line whose BL was aborted by a
    // cycle-12 $D011 write — Bauer §3.5 says BL can be cancelled
    // mid-line by modifying YSCROLL, and the cycle-14 phi1 sample is
    // what governs RC reset. Without an actual BL at cycle-14 the
    // chip should remain in whatever state it was in (idle or
    // display) until a real transition.
    if (badLine && cycle === 14) {
      this.displayActive = true;
    }

    // Cycles 55-57: no fetch can be queued anymore. The cycle-58 evaluation
    // samples the bad-line condition live, so nothing to latch here.
    if (cycle >= 55 && cycle <= 57) return;

    // Bauer §3.7.2 rule 3: "If there is a Bad Line Condition in cycles 12-54,
    // BA is set low and the c-accesses are started. Once started, one c-access
    // is done in the second phase of every clock cycle in the range 15-54."
    // The window therefore INCLUDES cycle 54 (the last c-access = col 39): a
    // BL first raised at cy54 still does its single col-39 c-access. §3.14.6
    // agrees from the write side — a VSP $D011 write "in cycles 15-53" sets BA
    // low "in the next cycle" and "the c- and g-accesses are continued until
    // cycle 54", so the latest write (cy53 → observed here at cy54, since our
    // observation cycle is already Bauer's "next cycle") yields exactly one
    // crunch c-access at col 39. (testprogs/VICII/fldscroll fldscroll-2B-60:
    // "1 black $ff char on the right" — was dropped when the guard cut at 53.)
    if (cycle < 12 || cycle > 54) return;

    if (badLine) {
      if (this.lineMatrixFetchCol < 0 && !this.lineBadLineDisplayPending) {
        // EXPERIMENT: the observation cycle is already the first VIC phi1
        // after the CPU's $D011 phi2 write — i.e., it IS Bauer's "next
        // cycle". Queuing at `cycle + 1` adds a second cycle of delay,
        // pushing c-fetch start (and total c-access count) one cycle late.
        // Bauer §3.14.6 says BA goes low AND video matrix reads start at
        // the same cycle (first 3 invalid while AEC lags). Try `cycle` for
        // late triggers; canonical cycle 14 still maps to startCycle=15
        // via the max(15, ...) clamp.
        this._queueBadLineFetchPhase(Math.max(15, cycle));
      }
      return;
    }

    if (this.lineBadLineDisplayPending && cycle < this.lineBadLineStartCycle) {
      this._cancelQueuedBadLineFetchPhase();
    }
  },

  // Bad-line condition edge handler — the BL condition just flipped to
  // `nowBL` at observed `cycle`. Bauer §3.5: "You can produce or cancel a
  // Bad Line Condition multiple times within an arbitrary raster line in
  // the range of $30-$f7 by modifying YSCROLL"; §3.7.1: "The transition
  // from idle to display state occurs as soon as there is a Bad Line
  // Condition. The transition from display to idle state occurs in cycle
  // 58 of a line if the RC contains the value 7 and there is no Bad Line
  // Condition."
  //
  // The evaluator samples the condition once per cycle, so a change caused
  // by a phi2 $D011/$D012 write is observed on the FOLLOWING cycle — this
  // observation point is Bauer's "next cycle" (see the §3.14.6 note in
  // _updateBadLineStateForCycle). The observed-cycle bounds below (≤10 for
  // the latch drop, ≥14 for the late RC reset) encode §3.7.2 rule 3's
  // cycle-12 BA/fetch-window entry and rule 2's cycle-14 phi1 RC sample as
  // seen from this observation point; both are pinned byte-exact by
  // testprogs/VICII dmadelay 1-3, vsp-tester, fldscroll and linecrunch.
  _onBadLineConditionEdge(nowBL, cycle) {
    if (nowBL) {
      // Condition arises. Per Bauer §3.14.4 Linecrunch, a BL that fires
      // and cancels BEFORE c14 must leave RC unchanged — so RC is
      // deliberately NOT reset here; the cycle-14 phi1 path
      // (_advanceDisplayStateCycle14) owns the canonical RC=0. Arming
      // _rcResetDoneThisLine keeps a later ceasing edge from re-firing
      // RC=0. The latch is the sticky per-line BL flag; the display-state
      // switch handles late transitions before this cycle's g-access phase.
      this._lineBadLineLatch = true;
      this._rcResetDoneThisLine = true;
      if (cycle > 14 && !this.displayActive && cycle < CYCLES_PER_LINE) {
        this.displayActive = true;
        // §3.14.6 DMA delay / VSP: this is a Bad Line raised mid-line while the
        // sequencer was in idle state — the trigger cycle's idle g-access is
        // sourced from the glitch address. The renderer samples idle bytes with
        // the variant register-pipeline offset, so the affected lineCycleIdleByte
        // index is `cycle + regOffset`: index == cycle on 6569 (consumed by the
        // current cycle's _captureCycleState, which runs after this), index ==
        // cycle-1 on 8565 (that prior cycle is already captured, so patch its
        // stored byte now — still before the column that reads it is rendered
        // this same master cycle). Verified column-exact vs testprogs/vsp-tester.
        const glitchIdx = cycle + this._regOffset;
        if (glitchIdx === cycle) {
          this._vspGlitchGCycle = glitchIdx;
        } else if (glitchIdx >= 0) {
          this.lineCycleIdleByte[glitchIdx] =
            this._vicReadWithBank(this._vspIdleGlitchAddr, this.currentVicBank);
        }
      }
      return;
    }

    // Condition ceases (the YSCROLL write cancelled BL mid-line). Per §3.5
    // the cancellation is real and immediate, but per §3.7.1 the chip stays
    // in display state until the cycle-58 RC=7+!BL check — displayActive
    // stays set once any portion of the line saw BL.
    //
    // Latch drop: §3.7.2 rule 3 arms BA and the c-accesses only inside
    // cycles 12-54. A condition gone before ever reaching that window can
    // never have led to a c-fetch, so the per-line latch is fully cleared.
    if (cycle <= 10) this._lineBadLineLatch = false;
    this.displayActive = true;
    // Late RC reset: §3.7.2 rule 2 fires RC=0 at cycle 14 phi1 if BL. A
    // false→true→false round trip whose condition was still true at that
    // sample point needs the RC=0 side effect even though the canonical
    // cycle-14 check sees no condition by then — per §3.5 the "at any
    // arbitrary cycle" semantics apply to all BL-driven side effects, not
    // just the cycle-14 sample. One-shot per line via _rcResetDoneThisLine.
    if (cycle >= 14 && !this._rcResetDoneThisLine) {
      this.rc = 0;
      this._rcResetDoneThisLine = true;
    }
  },

  _fetchScreenRowColumn(col, regs, bank) {
    const vc = (this.rowVcBase + col) & 0x03FF;
    const d018 = regs[0x18];
    const screenBase = ((d018 >> 4) & 0x0F) * 0x0400;
    const screenIdx = vc;
    if (this.lineBadLineInvalidCReadsActive > 0) {
      // BA-low but AEC still high: VIC tries to fetch but the CPU still owns
      // the bus. Per Bauer §3.14.6, character-pointer bits D0-D7 read as
      // $FF (VIC drivers tri-stated), while the color bits D8-D13 come from
      // the CPU's D0-D3 through the U16 analog switch — i.e. the low nibble
      // of the byte the stalled CPU is driving, which is its pending opcode
      // fetch at PC. (spritecrunch2: the opcode after `sta $d011` is
      // `stx $d017` = $8E -> colour $0E, matching VICE.) Without a wired
      // CPU/memory (synthetic unit tests) fall back to the $0F pull-up.
      this.rowScreenCodes[col] = 0xFF;
      this.rowColorNibbles[col] = (this.cpu && this.memory)
        ? (this.memory.peek(this.cpu.pc) & 0x0F)
        : 0x0F;
      this.lineBadLineInvalidCReadsActive--;
    } else {
      this.rowScreenCodes[col] = this._vicReadWithBank(screenBase + screenIdx, bank);
      this.rowColorNibbles[col] = this.colorRam[screenIdx] & 0x0F;
    }
    this.rowFetchedCols[col] = 1;
    this._rowSnapVersion++;   // capture-dedup: row source changed
  },

  _advanceRefreshAccess() {
    // Bauer §3.13: REF is sampled, then decremented. Line 0 begins with REF=$FF
    // and emits addresses $3FFF, $3FFE, $3FFD, $3FFC, $3FFB on cycles 11..15.
    const refAddr = 0x3F00 | this.refreshCounter;
    this.lastRefreshAddr = refAddr;
    this.refreshCounter = (this.refreshCounter - 1) & 0xFF;
    // r-access is a real DRAM read on hardware — it drives both the VIC
    // internal bus and the shared external bus. _vicBusRead handles both.
    if (this.vicRefreshDrivesBus) this._vicBusRead(refAddr, this.currentVicBank);
  },

  // Read the idle g-access source ($3FFF, or $39FF when ECM is set).
  //
  // driveExternal=true  → a real idle g-access: drives BOTH the VIC internal
  //   latch (renderer / sprite idle-fetch source) and the shared external
  //   ("open") data bus. Correct on the 40 g-access cycles (16..55) where the
  //   VIC physically reads $3FFF every line, idle or display.
  // driveExternal=false → update ONLY the VIC internal latch and return the
  //   byte for the renderer, WITHOUT driving the open bus. On cycles with no
  //   VIC g-access (0..15, 56..62; cy56/57 idle-$3FFF handled in
  //   _captureCycleState) the open bus is not driven by this access, so
  //   it must keep holding the last real access (DRAM refresh $3Fxx from
  //   cycles 11..15, a sprite/c access, or the CPU). Overwriting it with
  //   $3FFF every cycle is what made unconnected-I/O reads ($DE00/$DF00 and
  //   the color-RAM upper nybble) read a constant 0 instead of the
  //   refresh-walked floating value real hardware exposes — see
  //   testprogs/C64/openio (gauntlet/trivial).
  _readIdleGByte(regs, bank, driveExternal = true) {
    const ecm = (regs[0x11] >> 6) & 1;
    const idleAddr = ecm ? 0x39FF : 0x3FFF;
    if (driveExternal) return this._vicReadWithBank(idleAddr, bank);
    const v = this._vicMemRead(idleAddr, bank) & 0xFF;
    this.vicInternalBus = v;
    return v;
  },

  _isTextDisplayRaster(raster) {
    return raster >= 0x30 && raster <= 0xF7;
  },

  _beginTextStateCycle1(_raster) {
    // Retired (was a cycle-1 `raster >= bottomCompare` displayActive clear, the
    // line-start companion of the cycle-63 check). Same reason as
    // _advanceDisplayStateLineEnd: the `raster >= bottom` heuristic is not in
    // the spec and clips RSEL/YSCROLL mid-screen extra-row tricks. End-of-
    // display is the Bauer §3.7.2 rc==7 + cycle-58 rule
    // (_advanceDisplayStateCycle58). Nothing to do here.
  },

  _advanceDisplayStateLineEnd(_raster) {
    // Retired (was a cycle-63 `raster >= bottomCompare` displayActive clear).
    // That was emulator-only defensive logic, NOT in the spec, and it clipped
    // programs that switch RSEL/YSCROLL mid-screen to render extra text rows
    // in the opened border (frodotests/text26: RSEL=0 at L248 makes the
    // RSEL-based bottom read 247, so raster 249 >= 247 falsely ended the
    // display mid-row). Per Bauer §3.7.2 rule 5 the display ends
    // ONLY at cycle 58 of the line where rc==7 and it is not a bad line —
    // handled by _advanceDisplayStateCycle58. Nothing to do here.
  },

  _isBadLine(raster, regs) {
    const d011 = regs[0x11];
    const yscroll = d011 & 0x07;
    // Bauer §3.5: bad-line condition uses ONLY the latched `displayEnabled`
    // (set when DEN was high any cycle of raster $30), NOT the live DEN bit.
    // Clearing DEN mid-frame doesn't suppress bad lines until the next raster
    // $30 sample.
    return !!(this.displayEnabled && raster >= 0x30 && raster <= 0xF7 && (raster & 0x07) === yscroll);
  },

  // Bauer §3.9 vertical border flip-flop, modeled per-cycle as the two-stage
  // set/latch the real chip uses (rules 2-5 collapse into this):
  //   • bottom compare (Y reaches stop line)  → ARM the latch (close pending)
  //   • top compare (Y reaches start line AND DEN) → open the FF now AND clear
  //     the pending close
  //   • at cycle 1 the latch copies into the live FF (a pending close becomes
  //     visible at the next line; the top open is already immediate)
  // Run every cycle against live $D011, so a mid-line RSEL/DEN flip across a
  // compare line is honored. Evaluated at VIC phi1 (sees $D011 writes through
  // the previous cycle), matching the chip ordering where the border unit is
  // sampled before the CPU's same-cycle write. Compare lines: RSEL=1 → 51/251
  // (25 rows), RSEL=0 → 55/247 (24 rows). Cross-checked against VICE/hardware
  // on the dentest denrsel-s* programs, whose open/closed outcome depends on
  // exactly which cycle DEN/RSEL settle relative to these compares.
  _advanceVerticalBorderFlipFlop() {
    const d011 = this.regs[0x11];
    const rsel = (d011 >> 3) & 1;
    const den = (d011 >> 4) & 1;
    const topCompare = rsel ? 51 : 55;
    const bottomCompare = topCompare + (rsel ? 200 : 192);
    if (this.raster === bottomCompare) {
      this._vBorderLatch = true;
    }
    if (this.raster === topCompare && den) {
      this.vBorderActive = false;
      this._vBorderLatch = false;
    }
    if (this.cycleInLine === 1) {
      this.vBorderActive = this._vBorderLatch;
    }
    // Bauer §3.9 rule 4: at the LEFT compare, if the Y coordinate reaches the
    // bottom comparison value the vertical border FF is set — closing the
    // bottom border on THIS line (vs rule 2's cycle-63 set, which the latch +
    // cy1-copy above models as a close on the NEXT line). Sampled at cy17, the
    // phi1 cycle by which a CPU RSEL write landing at the left-compare dot is
    // visible to our register read. This is the sole discriminator between
    // vborder2-35 (RSEL=0 from cy17 → bottom compare reached → close 247) and
    // -36 (RSEL=0 from cy18 → rule-4 misses, falls through to rule-2 → 248).
    //
    // The horizontal left compare (rule 6) already opened the main border FF
    // 2 cycles ago at cy15 (it could not yet see RSEL=0), so re-close it here
    // and re-border the two display columns it opened. With the deferred-by-1
    // cycle-incremental render (seg K painted at machine cy K+1):
    //   • render-seg 16 (canvas x>=40) is still PENDING this very cy17, so
    //     rewriting its captured hBorder to 1 is enough — it paints as border.
    //   • render-seg 15 (canvas x32..39, the first display column) was already
    //     painted at cy16, so rewrite its capture AND re-render it here.
    // Guarded on !vBorderActive so normal r251 / 24-row r247 (already closed by
    // the cy1-copy) is untouched, and on raster===bottomCompare which only an
    // active RSEL/Y-compare match satisfies (open-border demos dodge it via
    // RSEL=0, so raster !== bottomCompare there).
    if (this.cycleInLine === 17 && this.raster === bottomCompare &&
        !this.vBorderActive) {
      this.vBorderActive = true;
      this._vBorderLatch = true;
      this.hBorderActive = true;
      this.lineCycleHBorder[15] = 1;
      this.lineCycleHBorderBefore[15] = 1;
      this.lineCycleHBorder[16] = 1;
      this.lineCycleHBorderBefore[16] = 1;
      if (this._cycleIncrementalRender && this._cycleRenderActiveCanvasY >= 0
          && !this._lineDeferred) {   // deferred line: replay reads the corrected arrays
        this._renderCycleSegmentGraphics(
          this._buildCycleRasterSegment(15), this._cycleRenderActiveCanvasY);
      }
    }
    // KNOWN LIMITATION (hvborder1, 28px): the diagonal top/bottom boundary of
    // the idle gfx shown INSIDE the open side border (the $D016 CSEL side-
    // border-open timing × idle-gfx vertical extent at the left/right corners,
    // rasters 255/256/276). Not a vertical-FF close — RSEL is held 0 across the
    // whole open region — so rule 4 above does not apply. Fixing it touches the
    // shared side-border/idle-gfx render path that real demos exercise, so it
    // is left unfixed (demo-neutral testprog residual: vborder2-35 / hvborder1).
  },

  _getHorizontalGraphicsWindow() {
    // Kept for back-compat with anything that still calls it. Hot paths
    // read GRAPHICS_WINDOW_START / GRAPHICS_WINDOW_END constants directly.
    return { start: GRAPHICS_WINDOW_START, end: GRAPHICS_WINDOW_END };
  },

  _getCycleStartX(cycle) {
    return (cycle - 12) * 8;
  },

  _getCycleEndX(cycle) {
    return (cycle - 11) * 8;
  },

  _getHorizontalDisplayWindow(regs) {
    return this._getHorizontalGraphicsWindow();
  },

  _getHorizontalBorderCompareX(regs) {
    const csel = (regs[0x16] >> 3) & 1;
    return {
      left: csel ? 24 : 31,
      right: csel ? 344 : 335,
    };
  },

  _getCanvasHorizontalBorderCompareX(regs) {
    const { left, right } = this._getHorizontalBorderCompareX(regs);
    return {
      left: left + 8,
      right: right + 8,
    };
  },

  _cselChangedAt(raster, cycle, from, to) {
    return this._lastCselChangeRaster === raster &&
      this._lastCselChangeCycle === cycle &&
      this._lastCselChangeFrom === from &&
      this._lastCselChangeTo === to;
  },

  _cselChangedInRange(raster, firstCycle, lastCycle, from, to) {
    return this._lastCselChangeRaster === raster &&
      this._lastCselChangeCycle >= firstCycle &&
      this._lastCselChangeCycle <= lastCycle &&
      this._lastCselChangeFrom === from &&
      this._lastCselChangeTo === to;
  },

  _advanceHorizontalBorderState(cycle, regs) {
    // Deferred-latch model: at phi1 of `cycle`, evaluate any pending
    // border FF flips that have reached their latchCycle. The eval observes
    // LIVE regs (which reflect all CPU writes through phi2 of (cycle-1))
    // — what Bauer §3.14.1's "exactly cycle 56 / cycle 17" requires.
    this._evaluatePendingTransitions(cycle, regs);

    // Snapshot the prior CSEL sample before updating it. The renderer uses
    // this for segment splitting; the comparator checks below use live regs
    // plus the exact-cycle CSEL-change history.
    if (cycle >= 0 && cycle <= CYCLES_PER_LINE) {
      this.lineCycleCselComparator[cycle] = this._cselComparator;
    }
    if (cycle < 11 || cycle > 58) {
      // Even outside the active border window, keep the render/debug sample
      // tracking regs[0x16].
      this._cselComparator = (regs[0x16] >> 3) & 1;
      return;
    }
    const segStart = this._getCycleStartX(cycle);
    const segEnd = this._getCycleEndX(cycle);
    // Border comparator uses LIVE regs[0x16] CSEL bit (Bauer §3.14.1).
    // No 1-cycle latch: a CPU write at phi2 of cycle N propagates to the
    // comparator by phi1 of cycle N+1. Bauer's "exactly cycle 56" trick
    // requires this — earlier CSEL=1→0 writes (e.g., nine.prg cy52) make
    // the next phi1 see new CSEL=0 → right=335 → X=328..335 includes 335
    // → SET fires (the trick fails as spec intends). Only writes at
    // exactly cy56 phi2 catch the post-detect / pre-latch window for
    // veto. Same logic for the left-prevent trick at cy17. Computed as two
    // scalars — this runs every cycle 11..58, an object here is churn.
    const cselCmp = (regs[0x16] >> 3) & 1;
    const left = cselCmp ? 24 : 31;
    const right = cselCmp ? 344 : 335;
    let rightSetFired = false;
    if (right >= segStart && right < segEnd) {
      rightSetFired = true;
      // Capture the main-FF state BEFORE this SET so a later §3.14.1 veto can
      // restore it. The right-edge pulse only SETS the FF — vetoing it must
      // undo the SET, i.e. return the FF to what it was, NOT force it open.
      // Normally that prior value is 0 (display line: FF was reset at the
      // left edge), so a veto opens the right border. But in the vertical
      // border (vBorder set → rule 6 never reset the FF → it is already 1),
      // the SET is redundant and a veto must keep it CLOSED (1). Hardcoding
      // open here wrongly let the cycle-56 trick "open" the bottom border one
      // line too late (border-251/252: the trick starts on the bottom-compare
      // line itself, where vBorder is already set → must stay closed).
      const priorHBorder = this.hBorderActive;
      this.hBorderActive = true;
      // Bauer §3.14.1 veto window. The right-pulse fires at phi1 of the
      // detect cycle (= cycle 55 when CSEL=1); FF latches 2 cycles later
      // at phi1 of (detect+2)=57. Bauer requires the CSEL=1→0 change to
      // happen "exactly in cycle 56" — i.e. CPU write at phi2 of
      // (detect+1)=56. Writes at phi2 of detect=55 are too early and
      // are handled by the separate non-vetoable path below.
      // Pooled entry (see _rentFFEntry): vetoable defaults true; the sprite
      // snapshot is captured BEFORE this cycle's sprite render so a veto can
      // restore it and re-paint sprites into the now-open right-border zone.
      {
        const e = this._rentFFEntry();
        e.kind = 'hRightSet';
        e.detectCycle = cycle;
        e.raster = this.raster;
        e.latchTotalCycles = this.totalCycles + 2;
        e.cselAtFire = (regs[0x16] >> 3) & 1;
        e.restorePriorHBorder = priorHBorder;
        e.spriteSnapshot = this._captureSpriteLineSnapshot();
        this._pendingFFTransitions[this._ffCount++] = e;
      }
    }
    // Bauer §3.14.1 says the CSEL=1→0 right-border trick must happen
    // exactly in cycle 56. A write in cycle 53 or 54 is after the CSEL=0
    // right compare (X=335) but before the CSEL=1 right compare (X=344);
    // letting that miss both compares is outside Bauer's exact-cycle rule.
    // Treat that too-early transition as a non-vetoable right-edge SET at
    // the normal CSEL=1 close cycle.
    if (!rightSetFired &&
        cycle === 55 &&
        this._cselChangedInRange(this.raster, 53, 54, 1, 0)) {
      this.hBorderActive = true;
      {
        const e = this._rentFFEntry();
        e.kind = 'hRightSet';
        e.detectCycle = cycle;
        e.raster = this.raster;
        e.latchTotalCycles = this.totalCycles + 2;
        e.cselAtFire = 1;
        e.vetoable = false;
        e.spriteSnapshot = this._captureSpriteLineSnapshot();
        this._pendingFFTransitions[this._ffCount++] = e;
      }
    }
    if (left >= segStart && left < segEnd) {
      // Bauer §3.9 rule 6: the left compare opens the main border FF only when
      // the vertical FF is clear (updated this cycle by
      // _advanceVerticalBorderFlipFlop, called earlier in the dispatch).
      if (!this.vBorderActive) {
        this.hBorderActive = false;
        // Align the render-split CSEL sample for THIS segment with the live
        // CSEL the FF compare just used. A $d016 CSEL change at (cycle-1) phi2
        // is visible to this live left compare but not to the cycle-(cycle-1)
        // `_cselComparator` snapshot captured above; without this, the render
        // split would place the open edge 8px right of where the FF actually
        // opened (hvborder1 r256 left-edge sliver — VICE opens at x32 with the
        // CSEL=1 from the cy14 write, we were splitting at the stale CSEL=0).
        this.lineCycleCselComparator[cycle] = (regs[0x16] >> 3) & 1;
        // Left-pulse fires LATER in the detect cycle (X last equals
        // left=31 at cycle 15 phi2, vs right's X first equals 344 at
        // cycle 55 phi1). Same 2-cycle latch delay puts the FF latch
        // at phi1 of (detect+3). CPU writes at phi2 of (detect+2) =
        // cycle 17 propagate by then — Bauer's "exactly cycle 17."
        {
          const e = this._rentFFEntry();
          e.kind = 'hLeftReset';
          e.detectCycle = cycle;
          e.raster = this.raster;
          e.latchTotalCycles = this.totalCycles + 3;
          e.cselAtFire = (regs[0x16] >> 3) & 1;
          this._pendingFFTransitions[this._ffCount++] = e;
        }
      }
    }
    // Advance the render/debug CSEL sample at the end of this VIC phase.
    // CPU writes happen later in phi2, so writes from this master cycle are
    // visible to this sample on the next clock.
    this._cselComparator = (regs[0x16] >> 3) & 1;
  },

  // Unified deferred-latch evaluator. Called at phi1 of each VIC tick.
  // For each pending FF transition whose latchCycle has been reached,
  // evaluate whether a Bauer §3.14.1 spec-defined trick fired during
  // the window. Dispatches by `kind`:
  //   • hRightSet   (rule 1): CSEL=1→0 in window → §3.14.1 hyperscreen
  //   • hLeftReset  (rule 6): CSEL=0→1 in window → §3.14.1 left-prevent
  //   • vBottomSet  (rule 2): RSEL change invalidating Y=bottomCompare
  //   • vTopReset   (rule 3): RSEL/DEN change invalidating top RESET
  //   • vBottomSetX (rule 4) / vTopResetX (rule 5): same for left-compare path
  // Reverse-direction CSEL writes are NOT spec-defined tricks; the FF
  // commits as detected.
  // Rent a transition entry from the free-list (or fresh), reset to safe
  // defaults so no field leaks across kinds when reused. Push sites overwrite
  // kind/detectCycle/raster/latchTotalCycles/cselAtFire; the three optional
  // fields default here (matching the old literals' omitted → undefined).
  _rentFFEntry() {
    const e = this._ffFree.pop();
    if (!e) {
      return { kind: '', detectCycle: 0, raster: 0, latchTotalCycles: 0,
               cselAtFire: 0, restorePriorHBorder: false, vetoable: true, spriteSnapshot: null };
    }
    e.restorePriorHBorder = false;
    e.vetoable = true;
    e.spriteSnapshot = null;
    return e;
  },

  _evaluatePendingTransitions(cycle, regs) {
    const q = this._pendingFFTransitions;
    const n = this._ffCount;
    if (n === 0) return;
    // Compact in place over the active [0, _ffCount) range: kept (not-yet-latched)
    // entries slide to the front; latched ones are evaluated, their sprite
    // snapshot released, and the entry recycled to the free-list. The live length
    // rides in _ffCount rather than `q.length = w` — shrinking the array to 0 each
    // line and re-growing on the next push made V8 right-trim + realloc the
    // backing store every raster line, the dominant idle allocation. No reentrant
    // push happens during the loop (render helpers don't queue FF flips), so
    // caching n is exact; stale refs left in [_ffCount, oldLen) are pooled
    // entries, never read, and serialize/reset respect _ffCount.
    let w = 0;
    for (let i = 0; i < n; i++) {
      const p = q[i];
      if (this.totalCycles < p.latchTotalCycles) { q[w++] = p; continue; }
      // Latch reached — dispatch by kind (reads p.spriteSnapshot synchronously),
      // then release the snapshot and recycle the entry.
      this._evalLatchedTransition(p, cycle, regs);
      this._releaseSpriteSnapshot(p.spriteSnapshot);
      p.spriteSnapshot = null;
      // Blank kind on recycle: a stale slot in [_ffCount, len) still references
      // this (now pooled) entry, and inspectors/tests scan the raw array by
      // kind. A blanked kind makes a drained entry invisible there without
      // nulling (which would break `.filter(p => p.kind...)`) or truncating the
      // array (the length-oscillation realloc churn we removed). Re-push resets
      // kind. Safe because the border FF is never >1-deep, so no kept entry ever
      // slides over a live slot.
      p.kind = '';
      if (this._ffFree.length < 32) this._ffFree.push(p);
    }
    this._ffCount = w;
  },

  _evalLatchedTransition(p, cycle, regs) {
    switch (p.kind) {
      case 'hRightSet': {
        // Hyperscreen: cselAtFire=1, current=0 → §3.14.1 §1.
        // Bauer §3.14.1: "the change from CSEL=1 to CSEL=0 has to be
        // exactly in cycle 56." For detectCycle=55, that's a CPU write
        // at phi2 of (detect+1)=56, propagating to phi1 of (detect+2)=57
        // where the FF latches. Writes at phi2 of detect=55 (one cycle
        // early) are explicitly rejected by Bauer's "exactly" rule and
        // are handled separately as a non-vetoable too-early SET at
        // _advanceHorizontalBorderState below.
        const curCsel = (regs[0x16] >> 3) & 1;
        const exactC56 = this._cselChangedAt(p.raster, p.detectCycle + 1, 1, 0);
        if (p.vetoable !== false && p.cselAtFire === 1 && curCsel === 0 && exactC56) {
          // Segment of (latch-1 in cycle-of-line terms): the cycle whose
          // phi2 is the last CPU-write opportunity inside the trick window.
          // For hRightSet: detect=cycle, latch=detect+2 → probe = detect+1.
          const probeCycle = p.detectCycle + 1;
          const segStart = this._getCycleStartX(probeCycle);
          const segEnd = this._getCycleEndX(probeCycle);
          const newRight = 335; // CSEL=0 right comparator
          if (!(newRight >= segStart && newRight < segEnd)) {
            // Restore the pre-SET FF value (0 on a display line → opens; 1 in
            // the vertical border → stays closed). See restorePriorHBorder.
            this._vetoFFTransition(p, /*restoreTo=*/!!p.restorePriorHBorder, /*upToCycle=*/cycle - 1);
          }
        } else if (p.vetoable !== false && p.cselAtFire === 1 && curCsel === 0 &&
                   this._cselChangedAt(p.raster, p.detectCycle, 1, 0)) {
          // NARROW close (hvborder1 r255): CSEL 1→0 written at the detect cycle
          // itself (cy55 phi2) — one cycle too early for Bauer's "exactly cy56"
          // open. VICE then closes the right border at the NARROW (CSEL=0)
          // comparator X=335 (canvas x343), not the wide CSEL=1 X=344 (x352)
          // the cy55 SET used (confirmed by VICE per-cycle $d016 trace + PNG
          // calibration: r255 closes at x343, r256+ open). Re-border the two
          // render-segs between the comparators.
          this._narrowRightClose(p);
        }
        return;
      }
      case 'hLeftReset': {
        // Bauer §3.14.1: the left-prevent trick fires "exactly in
        // cycle 17." Left-pulse latches 3 cycles after detect=15, so
        // latch is at phi1 of cycle 18; the CPU-write opportunity that
        // makes it is phi2 of cycle 17 = (detect+2). Writes at phi2 of
        // cycle 16 = (detect+1) are too early per Bauer's "exactly"
        // rule and must not veto.
        const curCsel = (regs[0x16] >> 3) & 1;
        const exactC17 = this._cselChangedAt(p.raster, p.detectCycle + 2, 0, 1);
        if (p.cselAtFire === 0 && curCsel === 1 && exactC17) {
          const probeCycle = p.detectCycle + 2; // latch=detect+3 → probe=detect+2
          const segStart = this._getCycleStartX(probeCycle);
          const segEnd = this._getCycleEndX(probeCycle);
          const newLeft = 24; // CSEL=1 left comparator
          if (!(newLeft >= segStart && newLeft < segEnd)) {
            this._vetoFFTransition(p, /*restoreTo=*/true, /*upToCycle=*/cycle - 1);
          }
        }
        return;
      }
    }
  },

  // Narrow the right-border close to the CSEL=0 comparator (canvas x343) when a
  // CSEL 1→0 write landed at the right-detect cycle (cy55) itself. The cy55 SET
  // already closed the border at the wide CSEL=1 X (canvas x352), leaving the
  // intervening columns as idle/display; re-border render-seg detect-1 (full)
  // and detect-2 (split at the CSEL=0 X). Only re-renders already-painted
  // pixels — no FF/state change beyond the per-cycle border capture.
  _narrowRightClose(p) {
    if (!(this._cycleIncrementalRender && this._cycleRenderActiveCanvasY >= 0)) return;
    const canvasY = this._cycleRenderActiveCanvasY;
    const wideSeg = p.detectCycle - 1;    // render-seg 54: fully border now
    const narrowSeg = p.detectCycle - 2;  // render-seg 53: split at CSEL=0 X
    if (wideSeg <= CYCLES_PER_LINE) {
      this.lineCycleHBorder[wideSeg] = 1;
      this.lineCycleHBorderBefore[wideSeg] = 1;
    }
    if (narrowSeg >= 0) {
      // partA (idle gfx) keeps hBorderBefore; partB borders from the CSEL=0 X.
      this.lineCycleHBorder[narrowSeg] = 1;
      this.lineCycleCselComparator[narrowSeg] = 0;
    }
    // (A2) Inline both segments — avoids allocating a 2-element array literal
    // every call on this border-edge re-render path.
    // Tier-3 line-batch: on a deferred line nothing is painted yet — the
    // lineCycle* corrections above are enough; the replay reads them.
    if (this._lineDeferred) return;
    if (narrowSeg >= 11 && narrowSeg <= 58) {
      this._renderCycleSegmentGraphics(this._buildCycleRasterSegment(narrowSeg), canvasY);
    }
    if (wideSeg >= 11 && wideSeg <= 58) {
      this._renderCycleSegmentGraphics(this._buildCycleRasterSegment(wideSeg), canvasY);
    }
  },

  _vetoFFTransition(p, restoreTo, upToCycle) {
    this.hBorderActive = restoreTo;
    // Retroactively rewrite per-cycle border captures so the renderer
    // sees the corrected state if it (re-)samples them.
    const lim = Math.min(upToCycle, CYCLES_PER_LINE);
    for (let c = p.detectCycle; c <= lim; c++) {
      this.lineCycleHBorder[c] = restoreTo ? 1 : 0;
      if (c > p.detectCycle) {
        this.lineCycleHBorderBefore[c] = restoreTo ? 1 : 0;
      }
    }
    // Re-render any cycles already painted with the wrong hBorder state.
    // For a right-SET veto (restoreTo=false → border now OPEN), restore
    // sprite state to the SET-fire-time snapshot before re-running the
    // per-cycle render. Without that, sprite pixels that were gated by
    // the closed border at cycles [detectCycle..lim] stay missing —
    // visible as a 16-px gap on demos that scroll sprites past the
    // right edge under the cycle-56 hyperscreen trick.
    const hasSpriteRollback = !!p.spriteSnapshot;
    if (hasSpriteRollback) {
      this._restoreSpriteLineSnapshot(p.spriteSnapshot);
    }
    // Tier-3 line-batch: on a deferred line the wrong-state paints never
    // happened (and the sprite line-state is still pristine, so the rollback
    // above is a no-op) — the lineCycle* rewrites above are all the replay
    // needs. Skip the re-render.
    if (this._cycleIncrementalRender && this._cycleRenderActiveCanvasY >= 0
        && !this._lineDeferred) {
      const canvasY = this._cycleRenderActiveCanvasY;
      // Defer-by-1 interaction: the deferred cycle-incremental render
      // (in vic.clock's master-cycle loop) paints seg K at machine cy
      // K+1. When the latch eval fires at machine cy `cycle`, segs
      // [detect..cycle-2] have already been painted with the wrong
      // border state — but seg (cycle-1) is still PENDING and will be
      // painted next by the deferred render with the now-corrected
      // state. So we must NOT re-render seg (cycle-1) here, or the
      // deferred render's graphics fill will overwrite the sprite
      // pixels we just painted (the sprite render-state machine has
      // already advanced past the seg by the time the deferred path
      // runs).
      const rerenderLim = Math.min(lim - 1, CYCLES_PER_LINE);
      for (let c = p.detectCycle; c <= rerenderLim; c++) {
        if (c >= 11 && c <= 58) {
          const cyclSeg = this._buildCycleRasterSegment(c);
          this._renderCycleSegmentGraphics(cyclSeg, canvasY);
          if (hasSpriteRollback) {
            // Re-run sprite render for this cycle so sprites paint with
            // the now-open border. Uses the restored pre-SET sprite
            // state, so the in-cycle sequencer advance lands at the
            // same shifter offsets as the original render.
            const sprSeg = this._buildCycleSpriteSegment(c);
            for (let s = 0; s < 8; s++) {
              this._renderSpriteSegmentForSprite(sprSeg, s, canvasY);
            }
          }
        }
      }
    }
  },
};
