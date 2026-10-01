// Test-only reference implementations for equivalence checks.
import { CANVAS_H, CANVAS_W, CYCLES_PER_LINE, GRAPHICS_WINDOW_END, GRAPHICS_WINDOW_START, PALETTE_RGBA, ACCESS_C, ACCESS_G, ACCESS_IDLE, ACCESS_REFRESH, SPRITE_BA_BASE, SPRITE_BA_CANDIDATES, SPRITE_PTR_ACCESS, SPRITE_PTR_CYCLE, SPRITE_ROW_ACCESS } from '../../src/vic2-tables.js';
export const referencePaths = {
_fixupColumns(canvasY) {
    const lcr = this._historyRegs;
    const regCycles = this._regCycle;
    const at = this._fixupAt;   // pre-built in ctor — no per-call closure alloc
    const bgTargetCycle = this._fixupBgTargetCycle;
    const bgPrevCycle = this._fixupBgPrevCycle;
    // A column SHOWS background colour (output-stage $D021-$D024) when it is an
    // active display column OR an opened-border idle inner-zone column (side
    // border opened → hInner, not in v/h border). The bg colour is an
    // output-stage register with NO graphics-pipeline delay, so its boundary
    // must be retimed to the +3 (border-timed) snapshot for BOTH cases — same
    // as the beam-position alignment that the sprites (also output-stage) use.
    // Opened-idle retime starts at cycle 18, after the left-edge startup
    // window; cycles 15..17 still use the segment-local idle colour. This
    // preserves early lower-border idle startup while keeping raster-wall seams
    // aligned to sprite mortar columns.
    // (The opened-idle path was previously left entirely un-retimed on the
    // mistaken belief that VICE keeps opened-idle rasterbars uniform; The Hat's
    // raster wall proves VICE changes $D021 at the beam position, +3 earlier
    // than the un-retimed idle render.)
    const showsBg = this._fixupShowsBg;   // pre-built in ctor — no per-call alloc
    // Mode change in the +1-vs-+2 window across the display g-accesses, or
    // XSCROLL changing before the shifter reload reaches the output stage.
    let needed = false;
    for (let c = 15; c <= 54; c++) {
      const a = lcr[regCycles[c + 1]], b = at(c + 2);
      // Alias fast path: captureDedup shares ONE regs array across cycles with
      // no CPU write between them, so pointer-equal snapshots prove every
      // masked xor below is zero without reading a byte.
      if (a === b && lcr[regCycles[c]] === a) continue;
      if (((a[0x11] ^ b[0x11]) & 0x60) ||
          ((a[0x16] ^ b[0x16]) & 0x10) ||
          ((lcr[regCycles[c]][0x16] ^ b[0x16]) & 0x07)) {
        needed = true;
        break;
      }
    }
    // …or a bg-showing-column bg-colour change in the c-vs-(c+3) border-timed window.
    if (!needed) {
      for (let c = 11; c <= 58; c++) {
        if (!showsBg(c)) continue;
        const cur = lcr[regCycles[c]], b3 = at(bgTargetCycle(c));
        if (cur === b3) continue;   // aliased snapshot ⇒ all four compares equal
        if (cur[0x21] !== b3[0x21] || cur[0x22] !== b3[0x22] ||
            cur[0x23] !== b3[0x23] || cur[0x24] !== b3[0x24]) {
          needed = true;
          break;
        }
      }
    }
    if (!needed) return;

    const fb32 = this.fb32;
    const rowOffset = canvasY * CANVAS_W;
    const saved = this._fixupSavedRow;
    const gfx2 = this._fixupGfx2Row;
    const gfx2Fg = this._fixupGfx2FgRow;
    const spriteVisible = this.spriteVisibleBuffer;
    const spriteOwner = this.spriteOwnerBuffer;
    const priorityBuf = this.graphicsPriorityBuffer;
    const spriteHiddenBySpecFg = this._fixupSpriteHiddenBySpecFg;   // pre-built in ctor

    // Batch-render fast path: instead of re-rendering all 48 cycles twice, touch
    // ONLY the cycles whose lookahead window actually changed. This is byte-
    // identical to the whole-line pass below — same `needed` gate, and the
    // per-cycle trigger is an exact superset of the cycles the whole-line merge
    // would change (Pass 1 vs Pass 2 differ only via seg.modeRegs/xscrollRegs/
    // bgRegs/bgPrevRegs; modeRegs feeds only $D011&0x60 / $D016&0x10,
    // xscrollRegs feeds $D016&0x07 shifter reload timing, bg feeds
    // $D021-$D024 over the c-2..c+3 segment+first-pixel window for active
    // display columns). Each cycle owns a disjoint 8px span [seg.start, seg.end),
    // so the per-cycle save/Pass1/Pass2/merge is equivalent to the batched
    // whole-row version.


    for (let x = 0; x < CANVAS_W; x++) saved[x] = fb32[rowOffset + x];

    // Pass 1: re-render with the spec-correct +2 mode/XSCROLL shifter-reload
    // samples, and with border-timed bg only for active display columns.
    // Opened idle inner-zone background uses the live-cycle sample already
    // produced by the incremental render.
    for (let c = 11; c <= 58; c++) {
      const seg = this._buildCycleRasterSegment(c);
      const dc = Math.min(c + 2, CYCLES_PER_LINE);
      seg.modeRegs = at(dc);
      seg.xscrollRegs = at(dc);
      seg.rowFetchedCols = this._historyRowFetchedCols[this._rowCycle[dc]];
      seg.rowCodes = this._historyRowCodes[this._rowCycle[dc]];
      seg.rowColors = this._historyRowColors[this._rowCycle[dc]];
      if (showsBg(c)) {
        const bt = bgTargetCycle(c);
        seg.bgRegs = at(bt);
        seg.bgPrevRegs = at(bgPrevCycle(c, bt));
      }
      this._renderCycleSegmentGraphics(seg, canvasY);
      const xs = seg.start < 0 ? 0 : seg.start;
      const xe = seg.end > CANVAS_W ? CANVAS_W : seg.end;
      if (xe > xs) this._fixupModeSplitRightHalf(seg, c, canvasY, xs, xe);
    }
    for (let x = 0; x < CANVAS_W; x++) gfx2[x] = fb32[rowOffset + x];
    gfx2Fg.set(priorityBuf);   // line buffer (#1) — whole row

    // Pass 2: re-render with the defaults (+1 mode, live-bg). This exactly
    // reproduces what the incremental render wrote (deterministic), so a
    // pixel still equal to it in `saved` is graphics-owned and safe to swap.
    for (let c = 11; c <= 58; c++) {
      const seg = this._buildCycleRasterSegment(c);
      this._renderCycleSegmentGraphics(seg, canvasY);
    }

    for (let x = 0; x < CANVAS_W; x++) {
      const gfx1 = fb32[rowOffset + x];
      const pIdx = rowOffset + x;
      fb32[pIdx] = spriteHiddenBySpecFg(pIdx, x)
        ? gfx2[x]
        : ((spriteVisible[x] || saved[x] !== gfx1) ? saved[x] : gfx2[x]);   // line buffers (#1)
      priorityBuf[x] = gfx2Fg[x];
    }
  },
_captureCycleState(cycle, vBorderBefore = this.vBorderActive, hBorderBefore = this.hBorderActive,
    externalBaLow = this._isBaLowCycle(cycle)) {
    if (cycle < 1 || cycle > CYCLES_PER_LINE) return;

    // Per-cycle unified BA sample — populated every cycle of EVERY line (not
    // gated on trace or visibility) so _spriteAecLowHistoric can read each
    // of the preceding three cycles, including prevLineExternalBaLow at a
    // line boundary. The sample reflects this cycle after memory fetches.
    this.lineCycleExternalBaLow[cycle] = externalBaLow ? 1 : 0;

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
    // Tracing force-copies payloads. Hardware scalar history stays cycle-indexed;
    // compact recording replaces repeated payload references with byte indices.
    if (cycle === 1) {
      this._sparseCaptureLine = false && !this.frameTraceEnabled;
      this._rowSnapLastVer = this._sprSnapLastVer = this._regSnapLastVer = -1;
    }
    const dedup = false && !this.frameTraceEnabled;

    const sparse = this._sparseCaptureLine;
    this._graphicsCycleVersion[cycle] = this._graphicsVersion;
    if (dedup && this._regSnapVersion === this._regSnapLastVer) {
      if (sparse) {
        this._historyIsSparse = true;
        this._regCycle[cycle] = this._regSnapCycle;
      } else {
        this._historyRegs[cycle] = this._regSnapRef;
        this._regCycle[cycle] = cycle;
      }
    } else {
      this._homeRegs[cycle].set(this.regs);
      this._historyRegs[cycle] = this._regSnapRef = this._homeRegs[cycle];
      this._regSnapLastVer = this._regSnapVersion;
      this._regCycle[cycle] = this._regSnapCycle = cycle;
    }
    if (dedup && this._rowSnapVersion === this._rowSnapLastVer) {
      if (sparse) {
        this._historyIsSparse = true;
        this._rowCycle[cycle] = this._rowSnapCycle;
      } else {
        this._historyRowFetchedCols[cycle] = this._rowFetchedRef;
        this._historyRowCodes[cycle] = this._rowCodesRef;
        this._historyRowColors[cycle] = this._rowColorsRef;
        this._rowCycle[cycle] = cycle;
      }
      if (this.captureDedupVerify) this._verifyRowAlias(cycle);
    } else {
      this._homeRowFetchedCols[cycle].set(this.rowFetchedCols);
      this._historyRowFetchedCols[cycle] = this._rowFetchedRef = this._homeRowFetchedCols[cycle];
      this._homeRowCodes[cycle].set(this.rowScreenCodes);
      this._historyRowCodes[cycle] = this._rowCodesRef = this._homeRowCodes[cycle];
      this._homeRowColors[cycle].set(this.rowColorNibbles);
      this._historyRowColors[cycle] = this._rowColorsRef = this._homeRowColors[cycle];
      this._rowSnapLastVer = this._rowSnapVersion;
      this._rowCycle[cycle] = this._rowSnapCycle = cycle;
    }
    if (dedup && this._sprSnapVersion === this._sprSnapLastVer) {
      if (sparse) {
        this._historyIsSparse = true;
        this._sprCycle[cycle] = this._sprSnapCycle;
      } else {
        this._historySpriteDisplayOn[cycle] = this._sprDisplayOnRef;
        this._historySpriteDataRow[cycle] = this._sprDataRowRef;
        this._historySpriteDataBase[cycle] = this._sprDataBaseRef;
        this._historySpriteDataBank[cycle] = this._sprDataBankRef;
        this._historySpritePointerValue[cycle] = this._sprPointerRef;
        this._historySpriteRowByteMask[cycle] = this._sprByteMaskRef;
        this._historySpriteShiftReg[cycle] = this._sprShiftRef;
        this._sprCycle[cycle] = cycle;
      }
      if (this.captureDedupVerify) this._verifySpriteAlias(cycle);
    } else {
      if (sparse) {
        this._homeSpriteCapture[cycle].set(this._spriteCaptureBytes);
      } else {
        this._homeSpriteDisplayOn[cycle].set(this.spriteDisplayOn);
        this._homeSpriteDataRow[cycle].set(this.spriteLineDataRow);
        this._homeSpriteDataBase[cycle].set(this.spriteDataBase);
        this._homeSpriteDataBank[cycle].set(this.spriteDataBank);
        this._homeSpritePointerValue[cycle].set(this.spritePointerValue);
        this._homeSpriteRowByteMask[cycle].set(this.spriteRowByteMask);
        this._homeSpriteShiftReg[cycle].set(this.spriteShiftReg);
      }
      this._historySpriteDisplayOn[cycle] = this._sprDisplayOnRef = this._homeSpriteDisplayOn[cycle];
      this._historySpriteDataRow[cycle] = this._sprDataRowRef = this._homeSpriteDataRow[cycle];
      this._historySpriteDataBase[cycle] = this._sprDataBaseRef = this._homeSpriteDataBase[cycle];
      this._historySpriteDataBank[cycle] = this._sprDataBankRef = this._homeSpriteDataBank[cycle];
      this._historySpritePointerValue[cycle] = this._sprPointerRef = this._homeSpritePointerValue[cycle];
      this._historySpriteRowByteMask[cycle] = this._sprByteMaskRef = this._homeSpriteRowByteMask[cycle];
      this._historySpriteShiftReg[cycle] = this._sprShiftRef = this._homeSpriteShiftReg[cycle];
      this._sprSnapLastVer = this._sprSnapVersion;
      this._sprCycle[cycle] = this._sprSnapCycle = cycle;
    }
    this.lineCycleIdleByte[cycle] = idleByte;
  },
_renderSpriteSegmentForSprite(seg, s, canvasY) {
    const segDisplayOn = !!seg.spriteDisplayOn[s];

    // X>=$164 same-line display TURN-ON (testprogs/VICII/sb_sprite_fetch — the
    // "dotty" bogus line above an X=$164 sprite). The sprite's display FF turns
    // on at cy58 (rule 4), and because rawX>=$164 its render position is past
    // cy58, so it shows THIS line — displaying the idle-fetch ghost bytes it
    // loaded at its own p+s cycle (preserved through DMA-start above). But the
    // deferred per-cycle renderer captured the sprite's columns BEFORE cy58
    // (displayOn=0) and skips them, so the normal path only catches the sprite's
    // tail. Paint the whole sprite from sx in one shot here. (This is the
    // turn-ON mirror; the turn-OFF / wrap cases are handled by the normal path.)
    // dataRow must be 0: rule 4 enters display at MC := MCBASE = 0, so a
    // turn-on line shows row 0. A FINAL display line idle-fetches too (rule 8
    // cleared DMA at cy16), so the fetch flag alone does not identify a turn-on.
    if (segDisplayOn && !this._spriteLinePrevSegDisplayOn[s]
        && this._spriteIdleFetchedThisLine[s]
        && seg.spriteDataRow[s] === 0
        && (seg.regs[s * 2] | (((seg.regs[0x10] >> s) & 1) << 8)) >= 0x164) {
      this._renderSpriteSameLineHighX(seg, s, canvasY);
      return;
    }

    if (segDisplayOn) this._spriteLineStarted[s] = 1;
    if (!this._spriteLineStarted[s]) return;

    // Sprite colours + priority are needed only by the two _renderSpriteSegment-
    // Sequencer call sites below, NOT by the ~74%-hit idle-skip between here and
    // them — so compute them lazily in each of those paths (seg.regs is an
    // immutable per-segment snapshot, so the values are identical to computing
    // them here). Keeps the common idle-skip path off 3 palette lookups + a shift.
    const dataRow = seg.spriteDataRow[s];

    if (dataRow < 0 || dataRow >= 21) {
      // End-of-line X-wrap salvage: a high-X sprite whose display turned OFF
      // at cy58 of THIS line (rule 4, dataRow now -1) can still owe wrap-over
      // pixels from the row it showed during cy1-57. The normal wrap call sits
      // after this early-return, so without this the sprite's bottom row is
      // dropped when it wraps into the left overscan — VICE shows it (hvborder1
      // sprite 0, X=496, last row r276). Guarded to a sprite that actually
      // displayed this line (_spriteLineLastDataRow >= 0) and still has unconsumed
      // wrap units, so non-wrapping sprites (units fully painted on-canvas → 0
      // remaining) never trigger it.
      const rs = this._spriteLineRenderState[s];
      const rawXend = seg.regs[s * 2] | (((seg.regs[0x10] >> s) & 1) << 8);
      // cy57/58 display-FF-at-X (testprogs/VICII/sb_sprite_fetch): a sprite
      // whose X is reached BEFORE the cy58 display-FF drop (rawX < $164) was
      // already shifting when the beam passed it, so it emits its FULL 24px on
      // its final display line — the cy58 dataRow→-1 must NOT clip the tail
      // columns (renderCyc 58 / canvas ~376..383). Continue the on-canvas paint
      // from the persisted shifter. (rawX >= $164 is the mirror case — its X is
      // reached AFTER the FF drops, so it shows nothing this line — handled by
      // the high-X line-tail path; here it falls through to the wrap salvage.)
      if (rs && rs.unitsRemaining > 0 && this._spriteLineLastDataRow[s] >= 0 &&
          rawXend < 0x164) {
        const isMulti = (seg.regs[0x1C] >> s) & 1;
        const xExp = (seg.regs[0x1D] >> s) & 1;
        const sprMcol0 = PALETTE_RGBA[seg.regs[0x25] & 0x0F];
        const sprMcol1 = PALETTE_RGBA[seg.regs[0x26] & 0x0F];
        const sprColor = PALETTE_RGBA[seg.regs[0x27 + s] & 0x0F];
        const pri = (seg.regs[0x1B] >> s) & 1;
        this._renderSpriteSegmentSequencer(
          seg, s, canvasY, rs, !!isMulti, !!xExp, sprMcol0, sprMcol1, sprColor, pri
        );
      }
      if (seg.end === CANVAS_W && this._spriteLinePendingWrapValid[s]) {
        const isMulti = (seg.regs[0x1C] >> s) & 1;
        const xExp = (seg.regs[0x1D] >> s) & 1;
        const sxw = (seg.regs[s * 2] | (((seg.regs[0x10] >> s) & 1) << 8)) + 8;
        this._renderSpriteEndOfLineWrap(seg, s, canvasY, rs, sxw, !!isMulti, !!xExp);
      } else if (seg.end === CANVAS_W && rs && rs.unitsRemaining > 0 &&
          this._spriteLineLastDataRow[s] >= 0) {
        const isMulti = (seg.regs[0x1C] >> s) & 1;
        const xExp = (seg.regs[0x1D] >> s) & 1;
        const sxw = (seg.regs[s * 2] | (((seg.regs[0x10] >> s) & 1) << 8)) + 8;
        this._renderSpriteEndOfLineWrap(seg, s, canvasY, rs, sxw, !!isMulti, !!xExp);
      }
      this._spriteLinePrevSegDisplayOn[s] = segDisplayOn ? 1 : 0;
      return;
    }

    const shiftReg = seg.spriteShiftReg[s] >>> 0;
    const rowByteMask = seg.spriteRowByteMask[s];
    const spriteIsMulti = (seg.regs[0x1C] >> s) & 1;
    const spriteXExp = (seg.regs[0x1D] >> s) & 1;
    const rawSpriteX = seg.regs[s * 2] | (((seg.regs[0x10] >> s) & 1) << 8);
    const sx = rawSpriteX + 8;

    let renderState = this._spriteLineRenderState[s];
    let spriteLeft = this._spriteLineLeft[s];
    const prevSegDisplayOn = this._spriteLinePrevSegDisplayOn[s];

    // Idle-cycle fast skip: when a started sprite's state is steady (no reseed,
    // no pending X-rewrite) and it neither overlaps this cycle's segment nor
    // needs the end-of-line wrap, the entire body below is a no-op — see the
    // per-side-effect proof in the plan. Sprite shiftReg/rowByteMask only change
    // at s-access cycles ({2,4,6,8,10}/{59,61,63}) OUTSIDE the 12-58 display
    // window, so within the window steady state is the common case (~74% of
    // calls on sprite-heavy demos). We replicate only the body's two surviving
    // side effects (the dataRow tracker + prevSegDisplayOn) and return.
    if (false
        && renderState !== null
        && !(segDisplayOn && !prevSegDisplayOn)
        && shiftReg === this._spriteLineLastShiftReg[s]
        && rowByteMask === this._spriteLineLastRowByteMask[s]
        && sx === spriteLeft
        && !this._spriteLinePendingWrapValid[s]
        && (renderState.unitsRemaining === 0
            || Math.max(seg.start, renderState.currentX) >= Math.min(seg.end, CANVAS_W))
        && !(seg.end === CANVAS_W && renderState.unitsRemaining > 0)) {
      this._spriteLineLastDataRow[s] = dataRow;
      this._spriteLinePrevSegDisplayOn[s] = segDisplayOn ? 1 : 0;
      return;
    }

    if (renderState === null || (segDisplayOn && !prevSegDisplayOn)) {
      spriteLeft = sx;
    } else if (renderState !== null && renderState.currentX === spriteLeft && sx !== spriteLeft) {
      // Pre-start X rewrite (Bauer §3.8.1 rule 6: a sprite only begins shifting
      // when the beam first MATCHES its X, and the beam only moves left→right).
      // A rewrite that puts the new X still AHEAD of the beam (sx >= seg.start)
      // repositions the pending start. But a rewrite to an X the beam has
      // ALREADY PASSED (sx < seg.start) can no longer match this line, so it
      // must be a no-op: leaving the sprite untriggered here preserves its shift
      // register (unitsRemaining) for a later match or the end-of-line X=$1F8
      // wrap. Without this guard, a multiplexed wrap-zone sprite (X=$1F7) that
      // the CPU rewrites mid-line to a low reposition X had its register drained
      // by the skip-loop, so the end-of-line wrap painted nothing and the glyph
      // vanished at the left edge instead of clipping (The Hat "12 sprites wide
      // scroller"; see vic2-sprite-wrap-lowx-rewrite-preserve spec).
      // A pre-canvas match blocks repositioning only when it consumes the
      // current fetched row. A full DMA reload after completed emission
      // leaves fresh data available for a later comparator match.
      if (sx >= seg.start && !this._spriteLineSweptPreCanvas[s]) {
        spriteLeft = sx;
        renderState.currentX = sx;
      }
    }

    // Reseed when shifter contents actually change (new g-access loaded
    // fresh data) or when display has just begun. dataRow alone changing
    // mid-line is just MC counter advance for the NEXT line's prep — the
    // current line's shifter still holds row N's data, so reseeding here
    // would clobber the shift progress and mis-render the final cycles
    // (FAIRLIGHT sprite right-edge BLACK/GREEN flicker bug).
    const shouldReseed =
      renderState === null ||
      (segDisplayOn && !prevSegDisplayOn) ||
      shiftReg !== this._spriteLineLastShiftReg[s] ||
      rowByteMask !== this._spriteLineLastRowByteMask[s];

    if (shouldReseed) {
      const isNew = renderState === null || (segDisplayOn && !prevSegDisplayOn);
      // Y-match re-trigger mid-line: when rule 9 (MCBASE=63 at cy 16) clears
      // a sprite's display flag and rule 4 (cy 58) re-arms it on the same
      // line, the shifter/mask snapshots within that line briefly read as
      // empty (data fetched at next line's DMA slots). Without preservation,
      // a live renderState gets clobbered to empty, and the end-of-line
      // X-wrap (Bauer §3.8 same-line wrap to canvas X 0..7) renders nothing
      // — exposing the §3.14.1 side-border $D021 fill underneath. This is
      // the nine.prg "3 blue lines in side borders" symptom on r=99/141/183
      // for Y-expanded masker sprites 5 and 7.
      const incomingEmpty = (shiftReg === 0 && rowByteMask === 0);
      const haveValidState = renderState !== null && renderState.validMask !== 0;
      if (incomingEmpty && haveValidState) {
        // Preserve current renderState; do not clobber with empty data.
      } else if (isNew) {
        const stateStartX = Math.max(seg.start, spriteLeft);
        renderState = this._createSpriteRenderState(
          shiftReg, rowByteMask, spriteLeft, stateStartX, !!spriteIsMulti, !!spriteXExp
        );
        const pixelsPerUnit = (spriteIsMulti ? 2 : 1) * (spriteXExp ? 2 : 1);
        const spriteWidth = (spriteIsMulti ? 12 : 24) * pixelsPerUnit;
        // Bauer §3.8.1 rules 5/6: an early X match can consume the old row,
        // then s-accesses refill it before a later X match. PAL starts at
        // raw X=404; the first s-access is p-cycle phi2 (four pixels later).
        // Release only a row whose entire old emission ended before that
        // first access. Overlapping fetch/emission retains the wrap guard.
        const firstFetchX = 408 + 8 * (SPRITE_PTR_CYCLE[s] - 1);
        const freshAfterSweep = (this._spriteEarlyDmaFetched & (1 << s)) !== 0
          && rawSpriteX + spriteWidth <= firstFetchX;
        this._spriteLineSweptPreCanvas[s] =
          (seg.start === 0 && spriteLeft >= 424 && spriteLeft <= 511
            && !freshAfterSweep) ? 1 : 0;
        // Preserve the wrapped tail separately: later X writes cannot erase
        // left-edge pixels already emitted by the pre-canvas match.
        const lineWrapPointInCanvas = 504;
        if (rawSpriteX < lineWrapPointInCanvas && sx + spriteWidth > lineWrapPointInCanvas
            && (spriteXExp || rawSpriteX >= 0x1F0)) {
          const offCanvasCount = Math.min(spriteWidth, Math.max(0, lineWrapPointInCanvas - sx));
          const wrapStartCanvasX = Math.max(0, sx + offCanvasCount - lineWrapPointInCanvas);
          let shiftReg = renderState.shiftReg >>> 0;
          let validMask = renderState.validMask >>> 0;
          let unitsRemaining = renderState.unitsRemaining | 0;
          let pixelPhase = renderState.pixelPhase | 0;
          for (let i = 0; i < offCanvasCount && unitsRemaining > 0; i++) {
            pixelPhase++;
            if (pixelPhase >= pixelsPerUnit) {
              pixelPhase = 0;
              if (spriteIsMulti) {
                shiftReg = ((shiftReg << 2) & 0xFFFFFF) >>> 0;
                validMask = ((validMask << 2) & 0xFFFFFF) >>> 0;
              } else {
                shiftReg = ((shiftReg << 1) & 0xFFFFFF) >>> 0;
                validMask = ((validMask << 1) & 0xFFFFFF) >>> 0;
              }
              unitsRemaining--;
            }
          }
          this._spriteLinePendingWrapValid[s] = 1;
          this._spriteLinePendingWrapShiftReg[s] = shiftReg;
          this._spriteLinePendingWrapValidMask[s] = validMask;
          this._spriteLinePendingWrapUnitsRemaining[s] = unitsRemaining;
          this._spriteLinePendingWrapPixelPhase[s] = pixelPhase;
          this._spriteLinePendingWrapPixelsPerUnit[s] = pixelsPerUnit;
          this._spriteLinePendingWrapIsMulti[s] = spriteIsMulti ? 1 : 0;
          this._spriteLinePendingWrapXExp[s] = spriteXExp ? 1 : 0;
          this._spriteLinePendingWrapStartCanvasX[s] = wrapStartCanvasX;
          renderState.unitsRemaining = 0;
          renderState.currentX = CANVAS_W;
        }
        this._spriteLineRenderState[s] = renderState;
      } else {
        renderState.shiftReg = shiftReg >>> 0;
        renderState.validMask = this._spriteValidMask(rowByteMask);
      }
    }

    this._spriteLineLastShiftReg[s] = shiftReg;
    this._spriteLineLastRowByteMask[s] = rowByteMask;
    this._spriteLineLastDataRow[s] = dataRow;
    this._spriteLineLeft[s] = spriteLeft;

    const sprMcol0 = PALETTE_RGBA[seg.regs[0x25] & 0x0F];
    const sprMcol1 = PALETTE_RGBA[seg.regs[0x26] & 0x0F];
    const sprColor = PALETTE_RGBA[seg.regs[0x27 + s] & 0x0F];
    const pri = (seg.regs[0x1B] >> s) & 1;
    this._renderSpriteSegmentSequencer(
      seg, s, canvasY, renderState, spriteIsMulti, spriteXExp, sprMcol0, sprMcol1, sprColor, pri
    );
    this._spriteLinePrevSegDisplayOn[s] = segDisplayOn ? 1 : 0;

    this._renderSpriteEndOfLineWrap(seg, s, canvasY, renderState, sx, !!spriteIsMulti, !!spriteXExp);
  },
};
