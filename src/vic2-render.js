// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/vic2-render.js – VIC-II graphics rendering (methods of VIC2): cycle
// segments to pixels for all text/bitmap/idle modes (Bauer §3.7), XSCROLL
// and border-edge handling, the per-cycle incremental render + deferred
// line-batch replay, and the end-of-line fixup passes.

import {
  CANVAS_H, CANVAS_W, CYCLES_PER_LINE, GRAPHICS_WINDOW_END, GRAPHICS_WINDOW_START, PALETTE_RGBA,
} from './vic2-tables.js';

// Method group installed onto VIC2.prototype by vic2.js — `this` is the
// VIC2 chip instance. See the partial-class assembly note there.
export const renderOps = {

  _splitRasterSegmentAtBorderEdges(seg) {
    // Fast path: cycle segments are 8-aligned and ≤8 px wide (start =
    // (cycle-11)*8, end = start+8 — see _buildCycleRasterSegment /
    // _getCycleStartX). Of the four possible CSEL edges (+8 canvas offset:
    // left 32/39, right 343/352), only 39 and 343 can fall STRICTLY inside
    // such a segment — i.e. only the segments starting at 32 or 336 can ever
    // split, whichever CSEL value was sampled. The geometry is re-checked
    // inline, so a hypothetical unaligned or wide segment still takes the
    // full path below.
    const s = seg.start;
    if (s !== 32 && s !== 336 && (s & 7) === 0 && seg.end > s && seg.end - s <= 8) {
      const parts = this._splitParts;
      parts[0] = seg;
      parts.length = 1;
      return parts;
    }
    // Split points use the per-cycle CSEL sample captured for this segment,
    // so rendering follows the border state snapshot taken by clock(). Falling
    // back to seg.regs CSEL would move the split to the newest $D016 value
    // and can put border pixels one 8-pixel segment away from the captured FF.
    const csel = seg.cselComparator !== undefined
      ? seg.cselComparator
      : ((seg.regs[0x16] >> 3) & 1);
    const left = (csel ? 24 : 31) + 8;
    const right = (csel ? 344 : 335) + 8;
    const parts = this._splitParts;
    const partA = this._splitPartA;
    const partB = this._splitPartB;

    if (left > seg.start && left < seg.end) {
      this._copyRasterSeg(seg, partA);
      partA.start = seg.start; partA.end = left;
      partA.hBorder = seg.hBorderBefore; partA.vBorder = seg.vBorderBefore;
      this._copyRasterSeg(seg, partB);
      partB.start = left; partB.end = seg.end;
      partB.hBorder = seg.hBorder; partB.vBorder = seg.vBorder;
      // Both parts have non-zero width because left ∈ (seg.start, seg.end).
      parts[0] = partA;
      parts[1] = partB;
      parts.length = 2;
      return parts;
    }

    if (right > seg.start && right < seg.end) {
      this._copyRasterSeg(seg, partA);
      partA.start = seg.start; partA.end = right;
      partA.hBorder = seg.hBorderBefore; partA.vBorder = seg.vBorderBefore;
      this._copyRasterSeg(seg, partB);
      partB.start = right; partB.end = seg.end;
      partB.hBorder = seg.hBorder; partB.vBorder = seg.vBorder;
      parts[0] = partA;
      parts[1] = partB;
      parts.length = 2;
      return parts;
    }

    if (seg.end <= seg.start) {
      parts.length = 0;
      return parts;
    }
    // No CSEL border edge inside this segment: the whole 8-pixel span uses
    // seg.hBorder / seg.vBorder, which are already the values on seg (the
    // split branches above only diverge to assign the *Before values to the
    // left part). Alias seg directly instead of cloning it into partA — the
    // copy would be a redundant 30-field duplicate of the scratch segment,
    // and the caller consumes the returned parts before the scratch is
    // rebuilt. This is the common case (most cycles per line don't straddle
    // a border edge).
    parts[0] = seg;
    parts.length = 1;
    return parts;
  },

  _getCycleCharacterCell(seg) {
    // Reuses _scratchCharCell to avoid per-cycle allocations. Caller
    // reads .row / .line synchronously before the next call.
    const out = this._scratchCharCell;
    if (!seg.displayColumnActive) {
      out.row = -1; out.line = 0;
      return out;
    }
    if (seg.rowVcBase < 0 || seg.rowVcBase > 0x03FF) {
      out.row = -1; out.line = 0;
      return out;
    }
    out.row = (seg.rowVcBase / 40) | 0;
    out.line = seg.rc & 0x07;
    return out;
  },

  _getFetchedMatrixCell(col, seg) {
    if (col < 0 || col >= 40 || !seg.rowFetchedCols[col]) return null;
    // Reuses _scratchMatrixCell to avoid per-column allocations in the
    // render hot path. Returning null in the "no cell" case keeps the
    // caller's `if (!cell) return;` guard working unchanged.
    const out = this._scratchMatrixCell;
    out.code = seg.rowCodes[col];
    out.color = seg.rowColors[col];
    return out;
  },

  _getSegmentSourceOrigin(compareStart) {
    return compareStart;
  },

  // First-pixel background color at a cycle boundary.
  // On 8565: colour-mux grey-dot artifact. Per the VIC-Addendum.txt,
  //   a grey dot (color 15, light grey
  //   $0F) appears at the first pixel of the cycle when a $D02x register
  //   currently displaying graphics is written. Independent of the prior
  //   color register value.
  // On 6569: no fractional-pixel artifact — the new value is visible
  //   from the first pixel of the next cycle (matches VICE). The
  //   "1-pixel pipeline delay" idea (from Linus Åkesson's "Nine") is
  //   ❌ NOT IN SPEC and produces a single-pixel artifact at canvas
  //   X=32 on FppScroller-style demos that VICE / real hardware does
  //   not show.
  // No change → returns curRGBA for both variants.
  _firstPixelBgColor(prevRegs, regIdx, curVal, curRGBA) {
    if (!prevRegs || prevRegs[regIdx] === curVal) return curRGBA;
    if (this._is8565) return PALETTE_RGBA[0x0F];
    return curRGBA;
  },

  // First-pixel background colour for the BORDER-TIMED fixup (seg.bgRegs set).
  // Here `curVal` is the bg register at cycle c+3 and `prevVal` the value at
  // c+2 (see _fixupColumns). Unlike the incremental _firstPixelBgColor, the
  // 6569 DOES take the 1-pixel step to prevVal — that's the sub-cycle floor
  // baked into _recolorBorderRow's pixel↦cycle map ((x+111)>>3), so the bg
  // boundary lands on the SAME pixel as a $D020 change. (The FppScroller
  // X=32 artifact that disabled the incremental 6569 first-pixel delay came
  // from comparing the border/blank cy15 vs cy16 at the display edge; the
  // border-timed snapshot compares c+2 vs c+3, both mid-display, so it
  // doesn't recur.) 8565 keeps the grey-dot (color 15) at the seam.
  _firstPixelBgColorShifted(prevVal, curVal) {
    if (prevVal === curVal) return PALETTE_RGBA[curVal & 0x0F];
    if (this._is8565) return PALETTE_RGBA[0x0F];
    return PALETTE_RGBA[prevVal & 0x0F];
  },

  // Overlay the 8565 same-value-write grey dots recorded this line by write().
  // Pure output-stage colour-mux artifact: paints colour 15 over whatever was
  // there (graphics/sprite/fixup), and does NOT touch the collision/priority
  // buffers. _greyDotCount is reset per line at cycleInLine 1.
  _applyGreyDots(canvasY) {
    const grey = PALETTE_RGBA[0x0F];
    const ro = canvasY * CANVAS_W;
    const fb = this.fb32;
    for (let i = 0; i < this._greyDotCount; i++) fb[ro + this._greyDotXs[i]] = grey;
  },

  _renderOpenBorderIdleSpan(seg, rowOffset, startX, endX) {
    if (endX <= startX) return;
    const regs = seg.regs;
    // Mode bits (ECM/BMM/MCM) are output-stage timed: a mid-line $D016/$D011
    // mode change takes effect on the graphics output ~2 cycles later (the
    // modesplit half-character boundary). The display path (_renderSourceColumn)
    // samples them from seg.modeRegs (+2, fallback nextRegs +1); the open-border
    // idle path must do the SAME or it applies the change at the wrong cycle.
    // The Hat disk-2 balloon row: a per-line side-border trick toggles $D016
    // MCM (cy56 MCM=1, cy18 MCM=0). With +0 sampling the first display cycles
    // saw the stale MCM=1 (invalid ECM+MCM → black) and the leftmost balloon
    // rendered corrupt; the +2 snapshot sees cy18's MCM=0 (ECM) like the rest.
    const mRegs = seg.modeRegs || seg.nextRegs || regs;
    // $D011 ECM/BMM stay on the live (seg.regs) snapshot — Nine's invalid $70
    // left-edge spans depend on the immediate ECM/BMM transition rendering
    // BLACK at the trigger cycle. Only $D016 MCM takes the output-stage (+2)
    // snapshot, which is what the Hat's per-line MCM side-border toggle needs.
    const d011 = regs[0x11];
    const d016 = mRegs[0x16];
    const ecm = (d011 >> 6) & 1;
    const bmm = (d011 >> 5) & 1;
    const mcm = (d016 >> 4) & 1;
    // Per Linus Åkesson's "Nine": $D016 horizontal scroll bits sub-pixel align the
    // idle-byte (ghost-byte) rendering when the side border is opened.
    // The shifter tap is offset by segXscroll within the 8-pixel cycle,
    // matching the open-text path (vic2.js: srcX = relX - segXscroll). XSCROLL
    // stays on the live (seg.regs) snapshot — only the mode bits are +2-timed.
    const segXscroll = regs[0x16] & 0x07;
    const shifterByte = seg.idleByte;
    const fb32 = this.fb32;
    const collisionBuf = this.graphicsCollisionBuffer;
    const priorityBuf = this.graphicsPriorityBuffer;
    const black = 0xFF000000 | 0;   // signed, so it shares PALETTE_RGBA's Smi representation

    // Bg colors are nominally segment-invariant — only the first pixel of
    // the segment can sample seg.prevRegs (the 1-cycle "delayed bg" effect
    // on writes that hit during the cycle's pixel slot). Pre-compute
    // current + first-pixel-overrides once instead of per-pixel.
    const prevRegs = seg.prevRegs;
    // Background colour is border-timed (output-stage, no 12px graphics
    // delay): the end-of-line _fixupColumns pass sets seg.bgRegs to the +3
    // snapshot; the incremental render leaves it null → live seg.regs.
    const bgRegs = seg.bgRegs || regs;
    const cycleStart = seg.cycleStart;
    // Opened idle graphics still use the output-stage background registers:
    // Nine's top-border ghost-byte bands rely on live $D021 colour splits
    // shining through transparent sprite pixels. Invalid $70 spans remain
    // black because the mode maps their pixel colour to black; once the line
    // flips back to text/ECM-text, zero bits take the current bg register.
    const reg21 = bgRegs[0x21];
    const reg22 = bgRegs[0x22], reg23 = bgRegs[0x23];
    const bg0Cur = PALETTE_RGBA[reg21 & 0x0F];
    const bg1Cur = PALETTE_RGBA[reg22 & 0x0F];
    const bg2Cur = PALETTE_RGBA[reg23 & 0x0F];
    // VIC-Addendum.txt / Linus Åkesson's "Nine" — 8565 grey-dot: on 8565 the colour-
    // multiplexer produces a half-pixel-wide artifact at the boundary
    // of a mid-line color-register change. We approximate at framebuffer
    // resolution by emitting color 15 (light grey, $0F) at the first
    // pixel of the cycle where the bg color just changed. On 6569 the
    // incremental render keeps its usual first-pixel rule; on the
    // border-timed fixup path the 6569 takes the c+2 step too.
    const shifted = !!seg.bgRegs;
    const bg0First = shifted
      ? this._firstPixelBgColorShifted(seg.bgPrevRegs[0x21], reg21)
      : this._firstPixelBgColor(prevRegs, 0x21, reg21, bg0Cur);
    const bg1First = shifted
      ? this._firstPixelBgColorShifted(seg.bgPrevRegs[0x22], reg22)
      : this._firstPixelBgColor(prevRegs, 0x22, reg22, bg1Cur);
    const bg2First = shifted
      ? this._firstPixelBgColorShifted(seg.bgPrevRegs[0x23], reg23)
      : this._firstPixelBgColor(prevRegs, 0x23, reg23, bg2Cur);

    // Mode dispatch: pre-decide which of the 8 (ECM,BMM,MCM) combinations
    // applies — it's segment-invariant. Mode codes:
    //   0 = standard text / ECM-only / standard bitmap (bit-driven, fg=BLACK)
    //   2 = MCM+ECM (always BLACK, fg from twoBit≥2)
    //   3 = MCM bitmap (BLACK for pair≥1, fg from twoBit≥2)
    //   4 = ECM+BMM bitmap (always BLACK, fg from bit)
    //   5 = ECM+BMM+MCM (always BLACK, fg from twoBit≥2)
    //
    // Per Bauer §3.7.3.2: MCM text mode renders the char as STANDARD TEXT
    // when c-data bit 11 (= color nibble bit 3) is 0. In idle state the
    // c-data is implicitly 0, so MCM text degrades to standard text mode
    // — i.e. (MCM=1, BMM=0, ECM=0) idle behaves identically to mode 0.
    // Only the BMM+MCM combinations keep their genuinely 2-bit-pair
    // interpretation in idle (modes 3, 5), since BMM rendering doesn't
    // gate on a matrix-color bit. The "invalid" modes (2, 4, 5) are
    // black under any matrix data per Bauer §3.7.3.5/§3.7.3.7/§3.7.3.8.
    let modeCode;
    if (!bmm && !mcm) {
      modeCode = 0;            // standard text or ECM-only text
    } else if (!bmm && mcm && !ecm) {
      modeCode = 0;            // MCM text + idle: c-data bit 11 = 0 → standard text
    } else if (!bmm && mcm && ecm) {
      modeCode = 2;            // invalid mode — always BLACK
    } else if (bmm && !mcm && !ecm) {
      // Standard (hi-res) bitmap idle: BOTH the '0' and '1' colours come from
      // the c-data nibbles (low/high), NOT from $D021 — unlike text mode where
      // the '0' bit maps to the $D021 background register. In idle state the
      // c-data is implicitly 0, so both nibbles are 0 → the whole span is
      // BLACK regardless of the idle byte's bits (Bauer §3.7.3.1 colour
      // assignment + §3.7.1 idle c-data=0). Matches VICE: border-250/251/252
      // and border-bm-idle/ysh/ysh2 show a black idle region, not blue $D021.
      // Render identically to the invalid-bitmap cases (bit-driven fg flag for
      // collision, colour always black) → modeCode 4.
      modeCode = 4;
    } else if (bmm && mcm && !ecm) {
      modeCode = 3;            // MCM bitmap (bg0/BLACK/BLACK/BLACK)
    } else if (bmm && !mcm && ecm) {
      modeCode = 4;            // invalid bitmap 1 — always BLACK
    } else /* bmm && mcm && ecm */ {
      modeCode = 5;            // invalid bitmap 2 — always BLACK
    }

    // The first-pixel override matters only when a first-pixel colour
    // actually differs from the current one (mirrors the A3 hoist in
    // _renderCycleSegmentGraphics): when all three pairs are equal, the
    // isFirst selects are no-ops, so disable the per-pixel test entirely.
    const firstX = (bg0First !== bg0Cur || bg1First !== bg1Cur || bg2First !== bg2Cur)
      ? cycleStart : -1;
    // Bauer §3.7.3: the shifter's reload is delayed by XSCROLL pixels, so the
    // segment's first XSCROLL pixels (x < reloadX) still drain the PREVIOUS
    // g-access byte; the current byte (seg.idleByte) takes over at reloadX.
    // reloadX - segXscroll ≡ 0 (mod 8), so the bit/pair phase below is
    // continuous across the switch. Identical bytes on steady idle lines —
    // observable only across a mid-line idle-fetch change (Codeboys D1
    // bird-flight last line: $00 → $FF between two g-accesses).
    const reloadX = cycleStart + segXscroll;
    const prevShifterByte = seg.idleBytePrev;
    for (let x = startX; x < endX; x++) {
      const isFirst = x === firstX;
      const bg0 = isFirst ? bg0First : bg0Cur;
      const pixel = (x - segXscroll) & 7;
      const srcByte = x < reloadX ? prevShifterByte : shifterByte;

      let color, fg;
      switch (modeCode) {
        case 0: { // bit-driven, fg=BLACK
          fg = (srcByte >> (7 - pixel)) & 1;
          color = fg ? black : bg0;
          break;
        }
        case 1: { // MCM text
          const twoBit = (srcByte >> (6 - (pixel >> 1) * 2)) & 0x03;
          fg = (twoBit >= 2) ? 1 : 0;
          if (twoBit === 0) color = bg0;
          else if (twoBit === 1) color = isFirst ? bg1First : bg1Cur;
          else if (twoBit === 2) color = isFirst ? bg2First : bg2Cur;
          else color = black;
          break;
        }
        case 2: { // MCM+ECM (invalid) — always BLACK
          const twoBit = (srcByte >> (6 - (pixel >> 1) * 2)) & 0x03;
          fg = (twoBit >= 2) ? 1 : 0;
          color = black;
          break;
        }
        case 3: { // MCM bitmap
          const twoBit = (srcByte >> (6 - (pixel >> 1) * 2)) & 0x03;
          fg = (twoBit >= 2) ? 1 : 0;
          color = (twoBit === 0) ? bg0 : black;
          break;
        }
        case 4: { // standard bitmap idle + ECM+BMM (invalid 1):
                  // bit-driven fg flag, colour always BLACK (c-data nibbles=0)
          fg = (srcByte >> (7 - pixel)) & 1;
          color = black;
          break;
        }
        default: { // case 5: ECM+BMM+MCM (invalid 2) — always BLACK
          const twoBit = (srcByte >> (6 - (pixel >> 1) * 2)) & 0x03;
          fg = (twoBit >= 2) ? 1 : 0;
          color = black;
          break;
        }
      }

      const pIdx = rowOffset + x;
      fb32[pIdx] = color;
      collisionBuf[x] = fg;   // line buffers (#1); collisionBuf === priorityBuf (#2)
      priorityBuf[x] = fg;
    }
  },

  // Bauer §3.9 + §3.14.1 Method 1: when main border FF is reset but the
  // vertical FF is set (or in the empty-shifter side zones), the graphics
  // data sequencer outputs its idle BACKGROUND colour, not the idle byte.
  // That background colour is MODE-DEPENDENT — it is exactly the colour
  // _renderOpenBorderIdleSpan would emit with a 0 idle byte:
  //   • text / ECM-text / MCM-text → $D021 (modeCode 0)
  //   • MCM bitmap                  → $D021 (modeCode 3, pair 00 → bg)
  //   • standard (hi-res) bitmap    → BLACK (modeCode 4: both c-data nibbles 0)
  //   • invalid ECM/BMM/MCM combos  → BLACK (modeCodes 2/4/5)
  // i.e. BLACK iff (BMM && !MCM) || (MCM && ECM). Earlier this always used
  // $D021, which painted hi-res-bitmap open borders blue instead of black
  // (border-250/251/252, border-bm-idle/ysh/ysh2). Mid-cycle $D021 writes
  // still pick up the 1-pixel delay at the segment boundary (per Linus
  // Åkesson's "Nine") in the $D021 (non-black) case.
  _fillSegmentBg0(seg, rowOffset, startX, endX) {
    if (endX <= startX) return;
    const regs = seg.regs;
    const d011 = regs[0x11];
    const ecm = (d011 >> 6) & 1;
    const bmm = (d011 >> 5) & 1;
    const mcm = (regs[0x16] >> 4) & 1;
    if ((bmm && !mcm) || (mcm && ecm)) {
      // Idle background is BLACK in this mode — the idle byte's bits are
      // irrelevant (no $D021 path), so fill solid black.
      const fb32b = this.fb32;
      const collisionBufB = this.graphicsCollisionBuffer;
      const priorityBufB = this.graphicsPriorityBuffer;
      const black = 0xFF000000 | 0;   // signed, so it shares PALETTE_RGBA's Smi representation
      for (let x = startX; x < endX; x++) {
        const pIdx = rowOffset + x;
        fb32b[pIdx] = black;
        collisionBufB[x] = 0;   // line buffers (#1)
        priorityBufB[x] = 0;
      }
      return;
    }
    const bgRegs = seg.bgRegs || regs;
    const prevRegs = seg.prevRegs;
    const cycleStart = seg.cycleStart;
    const reg21 = bgRegs[0x21];
    const bg0Cur = PALETTE_RGBA[reg21 & 0x0F];
    // Route through _firstPixelBgColor so 8565 grey-dot artifact applies
    // here too (Linus Åkesson's "Nine" / VIC-Addendum.txt). 6569 keeps the prevRegs
    // pipeline behavior; 8565 substitutes light grey at the seam. On the
    // border-timed fixup path (seg.bgRegs set) the 6569 DOES take the
    // 1-pixel step to the c+2 value — see _firstPixelBgColorShifted.
    const bg0First = seg.bgRegs
      ? this._firstPixelBgColorShifted(seg.bgPrevRegs[0x21], reg21)
      : this._firstPixelBgColor(prevRegs, 0x21, reg21, bg0Cur);
    const fb32 = this.fb32;
    const collisionBuf = this.graphicsCollisionBuffer;
    const priorityBuf = this.graphicsPriorityBuffer;
    for (let x = startX; x < endX; x++) {
      const pIdx = rowOffset + x;
      fb32[pIdx] = (x === cycleStart) ? bg0First : bg0Cur;
      collisionBuf[x] = 0;   // line buffers (#1)
      priorityBuf[x] = 0;
    }
  },

  _getDelayedBgColor(seg, reg, canvasX) {
    const regs = (seg.prevRegs && canvasX === seg.cycleStart &&
      seg.prevRegs[reg] !== seg.regs[reg]) ? seg.prevRegs : seg.regs;
    return PALETTE_RGBA[regs[reg] & 0x0F];
  },

  _renderSourceColumn(col, line, seg, outPixels, outFgMap, outOffset = 0) {
    // Bauer §3.7.3 defines the normal ECM/BMM/MCM g-access address
    // schemes and pixel colouring. $D018 CB / bitmap-base is sampled at the
    // g-access cycle (seg.nextRegs, = seg.cycle + 1): a CPU write at the
    // c-access cycle's phi2 is visible by the following g-access phi1.
    //
    // The VIC-Addendum.txt "Fetch" adds a 6569-only supplement for modesplit /
    // movesplit: on RAM -> char-ROM fetch transitions, part of the fetch
    // address is latched from the previous-cycle mode while upper bits use
    // the current mode. seg.modeRegs carries the later (+2) mode snapshot
    // needed for the visible split boundary.
    const regs = seg.regs;
    const gRegs = seg.nextRegs || regs;
    const mRegs = seg.modeRegs || gRegs;
    // Background colour registers ($D021-$D024) are output-stage: applied at
    // the beam position with NO 12px graphics-data delay (like the border).
    // The end-of-line _fixupColumns pass sets seg.bgRegs to the border-timed
    // (+3) snapshot; the incremental render leaves it null → live seg.regs.
    const bgRegs = seg.bgRegs || regs;
    const bank = seg.bank;
    const d011 = mRegs[0x11];
    const d016 = mRegs[0x16];
    const d018ForCB = gRegs[0x18];
    const ecm = (d011 >> 6) & 1;
    const bmm = (d011 >> 5) & 1;
    const mcm = (d016 >> 4) & 1;
    const bg0 = PALETTE_RGBA[bgRegs[0x21] & 0x0F];

    // Stale-row-data trace assertion (Bauer §3.7.1 idle-state invariant).
    // The caller (_renderCycleSegmentGraphics) gates on displayColumnActive,
    // which by construction (_isDisplayColumnPhase) implies displayActive.
    // If this assertion ever fires it means: the renderer is consuming
    // rowCodes/rowColors while the sequencer is in idle state — exactly the
    // structured-garbage path described in the prior review (stale matrix
    // codes against current $D018 char base). Gated on frameTraceEnabled
    // so the hot path is unaffected when tracing is off.
    if (this.frameTraceEnabled
        && !seg.displayActive
        && seg.rowFetchedCols[col]) {
      this._staleRowRenderHits = (this._staleRowRenderHits | 0) + 1;
      if (this._staleRowRenderHits <= 5) {
        console.warn(
          `[stale-row-render] L${this.raster} c${seg.cycle} col${col}: ` +
          `displayActive=false but rowFetchedCols[${col}]=1. ` +
          `rowCode=$${seg.rowCodes[col].toString(16).padStart(2,'0')} ` +
          `rowColor=$${seg.rowColors[col].toString(16).padStart(1,'0')} ` +
          `D018=$${d018ForCB.toString(16).padStart(2,'0')} ` +
          `(hit #${this._staleRowRenderHits})`
        );
      }
    }

    // Map the on-screen column to the line-buffer index the g-access actually
    // displays. Real silicon shares one counter (VMLI): the c-access at cycle K
    // writes buffer[VMLI] and the g-access at cycle K outputs buffer[VMLI]. Our
    // buffer write is VMLI-correct, but reading buffer[screen-column] only
    // matches when VMLI tracks the beam. On a LATE idle→display transition
    // (FLI / line-crunch) VMLI lags the beam by the idle gap, so the fetched
    // columns appear shifted right. lineCycleCWriteCol[K] is the buffer index
    // this segment's c-access wrote; subtracting the screen column it would
    // occupy at the canonical (cycle-15) mapping yields that shift (0 on every
    // normal bad line, where writeCol == cycle-15). See the colorfetchbug
    // testprog (Bauer §3.14.6): rasterline $30 then shows the retained
    // mid-grey $d800 colours instead of stale high-VC garbage.
    const cWriteCol = this.lineCycleCWriteCol[seg.cycle];
    const colShift = cWriteCol >= 0 ? (cWriteCol - (seg.cycle - 15)) : 0;
    const srcCol = col + colShift;

    // Direct row-data lookup (was via _getFetchedMatrixCell — that fn
    // returns null when a cell isn't fetched yet, in which case this
    // column fills with bg0+0). Inlining saves a function call per col.
    if (srcCol < 0 || srcCol >= 40 || !seg.rowFetchedCols[srcCol]) {
      for (let bit = 0; bit < 8; bit++) {
        outPixels[outOffset + bit] = bg0;
        outFgMap[outOffset + bit] = 0;
      }
      return;
    }
    const rawCode = seg.rowCodes[srcCol];
    const colorNib = seg.rowColors[srcCol];
    // VC is a 10-bit counter; (rowVcBase + col) can exceed $3FF when
    // rowVcBase is high (linecrunch / VSP). Mirror _fetchScreenRowColumn.
    const vc = (seg.rowVcBase + srcCol) & 0x03FF;
    // The g-byte address is decided at the g-access cycle (+1), while the
    // visible mode split is output-stage-retimed via modeRegs (+2).
    const fetchD011 = gRegs[0x11];
    const prevFetchD011 = regs[0x11];
    // Bauer §3.7.2/§3.14.6: in BITMAP mode the g-access ADDRESS is decided by
    // the live VC (CB + VC*8 + RC) — VC is the chip's video counter at the
    // g-access cycle, which equals (current line's VCBASE + column). In TEXT
    // mode the g-access address is the matrix char code, and VC only selects
    // the matrix cell (already retained in the line buffer). So bitmap uses
    // the LIVE base (seg.liveVcBase, = VCBASE this line) while text uses the
    // retained-buffer base (seg.rowVcBase). These are identical on every
    // normal/FLI line (a bad line refreshes the buffer at VCBASE), and only
    // diverge under the late-bad-line trick (display kept alive past cy54 so
    // VCBASE advances with no c-access to refresh rowVcBase — Lunatico's moon
    // overlay). There the bitmap must follow the advancing VCBASE.
    const bitmapVc = (seg.liveVcBase + srcCol) & 0x03FF;
    const gvc = ((fetchD011 | prevFetchD011) & 0x20) ? bitmapVc : vc;
    const fetchAddr = this._graphicsFetchAddr(fetchD011, prevFetchD011, d018ForCB, rawCode, gvc, line, bank);
    const black = 0xFF000000 | 0;   // signed, so it shares PALETTE_RGBA's Smi representation
    const o = outOffset;

    if (!bmm && !ecm && !mcm) {
      // Renderer reads use the non-bus-driving peek — real silicon
      // already drove the bus at g-access time and latched the byte;
      // re-fetching at render time is an emulator-side convenience.
      const charByte = this._vicMemRead(fetchAddr, bank);
      const fgRGBA = PALETTE_RGBA[colorNib];
      outPixels[o + 0] = (charByte & 0x80) ? fgRGBA : bg0; outFgMap[o + 0] = (charByte >> 7) & 1;
      outPixels[o + 1] = (charByte & 0x40) ? fgRGBA : bg0; outFgMap[o + 1] = (charByte >> 6) & 1;
      outPixels[o + 2] = (charByte & 0x20) ? fgRGBA : bg0; outFgMap[o + 2] = (charByte >> 5) & 1;
      outPixels[o + 3] = (charByte & 0x10) ? fgRGBA : bg0; outFgMap[o + 3] = (charByte >> 4) & 1;
      outPixels[o + 4] = (charByte & 0x08) ? fgRGBA : bg0; outFgMap[o + 4] = (charByte >> 3) & 1;
      outPixels[o + 5] = (charByte & 0x04) ? fgRGBA : bg0; outFgMap[o + 5] = (charByte >> 2) & 1;
      outPixels[o + 6] = (charByte & 0x02) ? fgRGBA : bg0; outFgMap[o + 6] = (charByte >> 1) & 1;
      outPixels[o + 7] = (charByte & 0x01) ? fgRGBA : bg0; outFgMap[o + 7] = charByte & 1;
    } else if (ecm && !bmm && !mcm) {
      const bgSel = (rawCode >> 6) & 0x03;
      const charByte = this._vicMemRead(fetchAddr, bank);
      const fgRGBA = PALETTE_RGBA[colorNib];
      // Pre-resolve bg by bgSel without allocating a 4-element lookup array.
      const bgRGBA = bgSel === 0 ? bg0 :
        bgSel === 1 ? PALETTE_RGBA[bgRegs[0x22] & 0x0F] :
        bgSel === 2 ? PALETTE_RGBA[bgRegs[0x23] & 0x0F] :
                      PALETTE_RGBA[bgRegs[0x24] & 0x0F];
      for (let bit = 0; bit < 8; bit++) {
        const px = (charByte >> (7 - bit)) & 1;
        outPixels[o + bit] = px ? fgRGBA : bgRGBA;
        outFgMap[o + bit] = px;
      }
    } else if (mcm && !bmm && !ecm) {
      const charByte = this._vicMemRead(fetchAddr, bank);
      const isMulti = (colorNib & 0x08) !== 0;
      if (!isMulti) {
        const fgRGBA = PALETTE_RGBA[colorNib & 0x07];
        for (let bit = 0; bit < 8; bit++) {
          const px = (charByte >> (7 - bit)) & 1;
          outPixels[o + bit] = px ? fgRGBA : bg0;
          outFgMap[o + bit] = px;
        }
      } else {
        const mc1 = PALETTE_RGBA[bgRegs[0x22] & 0x0F];
        const mc2 = PALETTE_RGBA[bgRegs[0x23] & 0x0F];
        const mc3 = PALETTE_RGBA[colorNib & 0x07];
        for (let pair = 0; pair < 4; pair++) {
          const twoBit = (charByte >> (6 - pair * 2)) & 0x03;
          const c = twoBit === 0 ? bg0 : twoBit === 1 ? mc1 : twoBit === 2 ? mc2 : mc3;
          const fg = (twoBit >= 2) ? 1 : 0;
          const idx = o + pair * 2;
          outPixels[idx] = c; outPixels[idx + 1] = c;
          outFgMap[idx] = fg; outFgMap[idx + 1] = fg;
        }
      }
    } else if (bmm && !mcm && !ecm) {
      const fg = PALETTE_RGBA[(rawCode >> 4) & 0x0F];
      const bg = PALETTE_RGBA[rawCode & 0x0F];
      const bitmapByte = this._vicMemRead(fetchAddr, bank);
      for (let bit = 0; bit < 8; bit++) {
        const px = (bitmapByte >> (7 - bit)) & 1;
        outPixels[o + bit] = px ? fg : bg;
        outFgMap[o + bit] = px;
      }
    } else if (bmm && mcm && !ecm) {
      const bitmapByte = this._vicMemRead(fetchAddr, bank);
      const c1 = PALETTE_RGBA[(rawCode >> 4) & 0x0F];
      const c2 = PALETTE_RGBA[rawCode & 0x0F];
      const c3 = PALETTE_RGBA[colorNib];
      for (let pair = 0; pair < 4; pair++) {
        const twoBit = (bitmapByte >> (6 - pair * 2)) & 0x03;
        const c = twoBit === 0 ? bg0 : twoBit === 1 ? c1 : twoBit === 2 ? c2 : c3;
        // Bauer §3.7.3.4: in MCM bitmap mode, pair 01 (the
        // high-nibble VM color) is BACKGROUND for sprite priority +
        // collision. Only pairs 10 and 11 are foreground.
        const fg = (twoBit >= 2) ? 1 : 0;
        const idx = o + pair * 2;
        outPixels[idx] = c; outPixels[idx + 1] = c;
        outFgMap[idx] = fg; outFgMap[idx + 1] = fg;
      }
    } else if (!bmm && mcm && ecm) {
      const charByte = this._vicMemRead(fetchAddr, bank);
      for (let pair = 0; pair < 4; pair++) {
        const twoBit = (charByte >> (6 - pair * 2)) & 0x03;
        const fg = (twoBit >= 2) ? 1 : 0;
        const idx = o + pair * 2;
        outPixels[idx] = black; outPixels[idx + 1] = black;
        outFgMap[idx] = fg; outFgMap[idx + 1] = fg;
      }
    } else if (bmm && !mcm && ecm) {
      // Bauer §3.7.3.7: g-access addr 13=CB13, 12=VC9, 11=VC8, 10-9=0,
      // 8-3=VC5..VC0. VC6 and VC7 are dropped — i.e. mask = $33F.
      const bitmapByte = this._vicMemRead(fetchAddr, bank);
      for (let bit = 0; bit < 8; bit++) {
        const px = (bitmapByte >> (7 - bit)) & 1;
        outPixels[o + bit] = black;
        outFgMap[o + bit] = px;
      }
    } else if (bmm && mcm && ecm) {
      // Bauer §3.7.3.8: same address scheme as invalid bitmap mode 1.
      const bitmapByte = this._vicMemRead(fetchAddr, bank);
      for (let pair = 0; pair < 4; pair++) {
        const twoBit = (bitmapByte >> (6 - pair * 2)) & 0x03;
        const fg = (twoBit >= 2) ? 1 : 0;
        const idx = o + pair * 2;
        outPixels[idx] = black; outPixels[idx + 1] = black;
        outFgMap[idx] = fg; outFgMap[idx + 1] = fg;
      }
    }
  },

  // Border-color timing correction (Bauer §3.6.1, §3.9, §3.6.3).
  //
  // The main border flip-flop (§3.9) gates the $D020 overlay on the raster
  // X coordinate and outputs the color directly. Unlike the graphics data
  // it is NOT subject to the 12-pixel display delay (§3.6.1: "the read
  // graphics data is not immediately displayed ... a delay of 12 pixels").
  // Our per-cycle segment timeline is aligned to that 12px-delayed graphics
  // output, so a mid-line $D020 change painted on the segment timeline lands
  // ~3 cycles too late (it inherits a delay the border doesn't have).
  //
  // This can't be corrected during the incremental per-cycle render: the
  // border at a segment's pixels reflects a register state from LATER cycles
  // (the border leads the graphics), which aren't captured yet when the
  // segment renders. So we repaint after the whole line is done and every
  // cycle's $D020 is in lineCycleRegs. The border at framebuffer pixel x
  // reflects the $D020 effective at that beam X coordinate: a write at
  // cycleInLine W changes the border at pixel 8·W−103 (with the standard
  // one-cycle write visibility, §3.6.3), so pixel x ← lineCycleRegs[
  // floor((x+111)/8)]. The floor lands the transition on the exact pixel
  // (the 1-pixel sub-cycle step, cf. VIC-Addendum.txt's first-pixel color rule).
  // Calibrated against VICE x64sc 6569 (VICII/lp-trigger/test1: the storm
  // bars line up with the screen char columns at x=33,81,…). Only pixels the
  // renderer marked as border (borderBuffer===1) are touched, so display and
  // sprite pixels are untouched and a static $D020 is a no-op.
  _recolorBorderRow(canvasY) {
    if (canvasY < 0 || canvasY >= CANVAS_H) return;
    const ro = canvasY * CANVAS_W;
    const bb = this.borderBuffer;
    const fb = this.fb32;
    const lcr = this.lineCycleRegs;
    for (let x = 0; x < CANVAS_W; x++) {
      if (bb[x] !== 1) continue;   // border buffer is line-sized (#1)
      let idx = (x + 111) >> 3;
      if (idx > CYCLES_PER_LINE) idx = CYCLES_PER_LINE;
      fb[ro + x] = PALETTE_RGBA[lcr[idx][0x20] & 0x0F];
    }
  },

  // One cycle's incremental render — seg K graphics + sprites + the
  // cycle-58 boundary/overscan passes. Extracted from the clock() dispatch
  // so the Tier-3 deferred replay runs EXACTLY the live code. `live` gates
  // only the phi2 same-cycle sprite-X snapshot: during replay all writes
  // are already captured, so no same-cycle fixup can occur (phi2() sees
  // _spritePreSegSnap = null for replayed segments).
  _renderCycleIncremental(renderCycle, canvasY, live) {
    const cyclSeg = this._buildCycleRasterSegment(renderCycle);
    this._renderCycleSegmentGraphics(cyclSeg, canvasY);
    this._renderSegSpritesIncremental(renderCycle, canvasY, live);
  },

  // Tier-3 line-batch replay: render every deferred segment of the current
  // line through the SAME per-cycle sequence the live dispatch runs, with
  // the collision-pipe drain interleaved as virtual cycles. Virtual cycle
  // N ∈ [12..cycleInLine] does drain-then-render(seg N−1), matching the
  // live loop's order (the machine-cycle drains that ran during deferral
  // were no-ops — the pipe only feeds from sprite paints, which were
  // deferred). Reaching virtual cycles past 59 replays the post-window
  // drains, so a line-end replay leaves the pipe and $D01E/$D01F/$D019
  // registers exactly where live rendering would have. After a mid-line
  // catch-up the rest of the line renders live (the caller's next machine
  // cycle continues at seg cycleInLine, one past our last replayed seg).
  // Arm the RAM fetch watch for the deferred line (see memory.js write()).
  // The renderer re-reads glyph (text) / bitmap bytes from RAM at paint time
  // — the ONLY live re-read in the segment pipeline (matrix codes, colours,
  // sprite shift registers and the idle byte are all captured per cycle).
  // Live paints re-read ~1 cycle after the true g-access; the line-end
  // replay re-reads up to ~50 cycles later, so a demo that beam-races its
  // charset/bitmap (oneder_oxyron's animated logo) would diverge. A CPU
  // write inside the window triggers catch-up BEFORE the byte lands,
  // reproducing the live path exactly. Window from the line-start fetch
  // config; mid-line fetch-config changes ($D018 base bits, $D011 BMM,
  // VIC bank) trigger catch-up instead of a re-arm (see write()).
  _armDeferredFetchWatch() {
    const mem = this.memory;
    if (!mem) return;   // bare-VIC tests: no CPU exists to race the fetch
    const bmm = (this.regs[0x11] & 0x20) !== 0;
    let lo, hi;
    if (bmm) {
      lo = this.currentVicBank + ((this.regs[0x18] & 0x08) << 10);
      hi = lo + 0x2000;
    } else {
      lo = this.currentVicBank + ((this.regs[0x18] & 0x0E) << 10);
      hi = lo + 0x0800;
    }
    mem._vicFetchWatchLo = lo;
    mem._vicFetchWatchHi = hi;
    mem._vicFetchWatchOn = true;
  },

  // Phase 2: can the graphics span [spanStart..c-1] absorb seg c? True when
  // seg c's captured render inputs are identical to the span's — checked as a
  // CHAIN against seg c-1 (induction keeps the whole span uniform). The regs
  // and idle-byte checks extend one slot past c (c+2) so both VIC variants'
  // sampling offsets (regs at +0/+1, modeRegs/next at +1/+2, idle at +1/+2)
  // stay inside the proven-equal run; captureDedup's snapshot aliasing makes
  // the pointer compares hit on any stretch with no CPU write in between.
  _spanExtends(c) {
    const p = c - 1;
    // Chain the regs-pointer run across [c-1 .. c+2]: seg c's own snapshot
    // (+0/+1 by variant), its g-access lookahead (+1/+2) AND the interior
    // prevRegs (first-pixel rule collapses to "no override" when equal).
    const lcr = this.lineCycleRegs;
    if (lcr[c] !== lcr[p] || lcr[c + 1] !== lcr[c] || lcr[c + 2] !== lcr[c + 1]) return false;
    const idle = this.lineCycleIdleByte;
    if (idle[c + 1] !== idle[c] || idle[c + 2] !== idle[c + 1]) return false;
    return this.lineCycleBanks[c] === this.lineCycleBanks[p]
      && this.lineCycleDisplayEnabled[c] === this.lineCycleDisplayEnabled[p]
      && this.lineCycleDisplayActive[c] === this.lineCycleDisplayActive[p]
      && this.lineCycleDisplayPending[c] === this.lineCycleDisplayPending[p]
      && this.lineCycleDisplayColumnActive[c] === this.lineCycleDisplayColumnActive[p]
      && this.lineCycleVBorderBefore[c] === this.lineCycleVBorderBefore[p]
      && this.lineCycleVBorder[c] === this.lineCycleVBorder[p]
      && this.lineCycleHBorderBefore[c] === this.lineCycleHBorderBefore[p]
      && this.lineCycleHBorder[c] === this.lineCycleHBorder[p]
      && this.lineCycleCselComparator[c] === this.lineCycleCselComparator[p]
      && this.lineCycleHInner[c] === this.lineCycleHInner[p]
      && this.lineCycleRc[c] === this.lineCycleRc[p]
      && this.lineCycleRowVcBase[c] === this.lineCycleRowVcBase[p]
      && this.lineCycleRowLiveVcBase[c] === this.lineCycleRowLiveVcBase[p]
      && this.lineCycleRowFetchedCols[c] === this.lineCycleRowFetchedCols[p]
      && this.lineCycleRowCodes[c] === this.lineCycleRowCodes[p]
      && this.lineCycleRowColors[c] === this.lineCycleRowColors[p];
  },

  _catchUpDeferredLine() {
    if (!this._lineDeferred) return;
    this._lineDeferred = false;
    if (this.memory) this.memory._vicFetchWatchOn = false;
    const canvasY = this._cycleRenderActiveCanvasY;
    if (canvasY < 0) return;
    const upto = this.cycleInLine;
    if (this._replayCoalesce) {
      // Graphics first, in maximal uniform spans (one wide seg per span —
      // _renderCycleSegmentGraphics derives its columns from seg geometry,
      // so widening seg.end is exact when _spanExtends holds). Pipe-neutral
      // reorder: graphics never feeds the collision pipe, sprite pixels are
      // seg-bounded, and each seg's graphics still lands before its sprites.
      // Segs 15, 53 and 54 stay solo: the CSEL border edges (x 39/343 — and
      // 32/352 as WIDE-span interiors) must stay single-edge per segment for
      // _splitRasterSegmentAtBorderEdges, which splits at most once.
      const lastSeg = Math.min(upto - 1, 58);
      let s = 11;
      while (s <= lastSeg) {
        let e = s;
        if (s !== 15 && s !== 53 && s !== 54) {
          while (e < lastSeg
                 && e + 1 !== 15 && e + 1 !== 53 && e + 1 !== 54
                 && this._spanExtends(e + 1)) {
            e++;
          }
        }
        const seg = this._buildCycleRasterSegment(s);
        if (e > s) seg.end = this._getCycleEndX(e) + 8;
        this._renderCycleSegmentGraphics(seg, canvasY);
        s = e + 1;
      }
      // Sprites + collision-pipe drains per virtual cycle, order-exact.
      for (let n = 12; n <= upto; n++) {
        this._drainSpriteCollisionCommit();
        if (n <= 59) this._renderSegSpritesIncremental(n - 1, canvasY, /*live=*/ false);
      }
    } else {
      for (let n = 12; n <= upto; n++) {
        this._drainSpriteCollisionCommit();
        if (n <= 59) this._renderCycleIncremental(n - 1, canvasY, /*live=*/ false);
      }
    }
  },

  _renderRasterLine(raster) {
    if (!this.ram || !this.colorRam) return;
    const canvasY = raster - 15;
    if (canvasY < 0 || canvasY >= CANVAS_H) return;

    // Phase 1 refactor: split end-of-line batch render into per-cycle
    // methods. The orchestrator runs init → graphics-per-segment →
    // sprites-per-segment → final. Tests that call _renderRasterLine
    // directly continue to work; the per-cycle methods are also
    // available individually for the cycle-incremental dispatch path.
    this._initRenderRasterLine(raster, canvasY);

    const cycleSegments = this._buildCycleRasterSegments();
    const spriteSegments = this._buildCycleSpriteSegments();
    for (let i = 0; i < cycleSegments.length; i++) {
      this._renderCycleSegmentGraphics(cycleSegments[i], canvasY);
    }
    for (let s = 0; s < 8; s++) {
      for (let i = 0; i < spriteSegments.length; i++) {   // (A2) indexed, not for-of
        this._renderSpriteSegmentForSprite(spriteSegments[i], s, canvasY);
      }
    }
    this._recolorBorderRow(canvasY);
  },

  // Per-line setup — clears row buffers, resets sprite line state.
  _initRenderRasterLine(raster, canvasY) {
    const rowOffset = canvasY * CANVAS_W;
    // Side buffers are line-sized (#1): clear the whole buffer each line.
    // graphicsCollision/Priority share one backing store (#2) → single fill.
    this.graphicsPriorityBuffer.fill(0);
    this.spriteCollisionBuffer.fill(0);
    this.spriteOwnerBuffer.fill(0xFF);
    this.spriteVisibleBuffer.fill(0);
    this.borderBuffer.fill(0);
    for (let s = 0; s < 8; s++) {
      this._spriteLineRenderState[s] = null;
      this._spriteLineStarted[s] = 0;
      this._spriteLinePrevSegDisplayOn[s] = 0;
      this._spriteLineLastShiftReg[s] = 0;
      this._spriteLineLastRowByteMask[s] = 0;
      this._spriteLineLastDataRow[s] = -1;
      this._spriteLineLeft[s] = 0;
      this._spriteLinePendingWrapValid[s] = 0;
      this._spriteLineSweptPreCanvas[s] = 0;
    }
    // Recycle the render-state arena: every slot reference was nulled just
    // above, so no previous-line renter is reachable (snapshots hold their own
    // _rsBuf copies, never arena objects).
    this._spriteRsArenaIdx = 0;
    this._renderRowOffset = rowOffset;
  },

  // Render graphics + open-border idle for one cycle's segment.
  _renderCycleSegmentGraphics(cycleSeg, canvasY) {
    const fb32 = this.fb32;
    const rowOffset = canvasY * CANVAS_W;
    const textStartX = GRAPHICS_WINDOW_START;
    const textEndX = GRAPHICS_WINDOW_END;
    const rasterSegments = this._splitRasterSegmentAtBorderEdges(cycleSeg);
    for (let ri = 0; ri < rasterSegments.length; ri++) {   // (A2) indexed, not for-of
      const seg = rasterSegments[ri];
      const segRenderStart = Math.max(seg.start, 0);
      const segRenderEnd = Math.min(seg.end, CANVAS_W);
      if (segRenderEnd <= segRenderStart) continue;

      const segXscrollRegs = seg.xscrollRegs || seg.regs;
      const segXscroll = segXscrollRegs[0x16] & 0x07;
      const segBorderRGBA = PALETTE_RGBA[seg.regs[0x20] & 0x0F];
      // Background colour is border-timed — seg.bgRegs (the +3 snapshot) when
      // set by _fixupColumns, else live seg.regs on the incremental render.
      const segBgRegs = seg.bgRegs || seg.regs;
      const segBg0 = PALETTE_RGBA[segBgRegs[0x21] & 0x0F];

      // Base fill: border color.
      fb32.fill(segBorderRGBA, rowOffset + segRenderStart, rowOffset + segRenderEnd);
      this.borderBuffer.fill(1, segRenderStart, segRenderEnd);   // line buffer (#1)

      // Bauer §3.9: main border FF (hBorder) controls the $D020 overlay;
      // when reset, the priority-multiplexer output replaces the fill.
      // Vertical FF (vBorder) gates ONLY the graphics data sequencer to
      // bg color when set — it does NOT itself paint border. Splitting
      // the cases here matches the spec's two-flip-flop model.
      if (!seg.hBorder) {
        this.borderBuffer.fill(0, segRenderStart, segRenderEnd);   // line buffer (#1)
        if (seg.vBorder) {
          // §3.14.1 Method 1: side-border opened in display zone, then
          // vBorder set normally at L251 — the sequencer outputs bg color
          // across the whole segment, no idle byte. Sprites still paint.
          this._fillSegmentBg0(seg, rowOffset, segRenderStart, segRenderEnd);
          continue;
        }
        // §3.7.2 graphics sequencer: in the side zones (cycles outside
        // 15..54) no g-access loads the shifter. By the time the side
        // zone is reached the shifter has emptied (left side: never
        // loaded for this line; right side: prior line's last byte
        // shifted out by cycle 56-57). Empty shifter → bg color.
        // The idle byte from $3FFF is only visible in the INNER zone
        // during display-state IDLE (g-access reads $3FFF) — handled
        // below. On the 6567/6569, open side zones show bg,
        // even with $3FFF != 0.
        if (!seg.hInner) {
          this._fillSegmentBg0(seg, rowOffset, segRenderStart, segRenderEnd);
          const priorCycle = seg.cycle - 1;
          if (priorCycle >= 15
              && this.lineCycleDisplayColumnActive[priorCycle]
              && segRenderStart <= GRAPHICS_WINDOW_END
              && segRenderEnd > GRAPHICS_WINDOW_END) {
            this._renderRightXscrollSpill(seg, rowOffset, segRenderStart, segRenderEnd);
          }
        }
      } else if (!seg.vBorder && seg.displayColumnActive) {
        // Main border CLOSED over a display column (the 38-column CSEL side
        // borders: canvas x 32-38 over col 0, x 343-351 over cols 38-39).
        // The main FF only selects the border colour at the output
        // multiplexer — the graphics sequencer keeps shifting underneath and
        // the collision unit sees its foreground bits (§3.9 overlay model;
        // sprite-data collisions fire under the border). Deliver the fg map
        // to the collision/priority line buffers WITHOUT touching fb32 (the
        // border fill stays visible) or borderBuffer (sprites stay hidden).
        // The vertical FF is different silicon — it gates the sequencer
        // itself (c-data forced 0 → background, no fg) — so vBorder
        // segments correctly contribute no collisions and are excluded.
        // Lunatico's dissolve engine reads exactly these bits: its
        // collision-feedback sprite crunch polls $D01F for sprite 7 whose
        // pixels sit at x 335/343 under the narrow right border.
        this._writeSegmentCollisionUnderBorder(seg, segRenderStart, segRenderEnd, segXscroll);
      }

      const segOpenText = seg.hInner && !seg.vBorder && !seg.hBorder;
      if (!segOpenText) continue;

      const idleStart = Math.max(segRenderStart, textStartX);
      const idleEnd = Math.min(segRenderEnd, textEndX);

      // When the segment is in display state with a valid matrix cell, the
      // character/bitmap column render below fully overwrites the text-window
      // span (identical pixel range, same buffers: fb32 + collision +
      // priority + border). Compute the cell up-front so the idle-byte span
      // can be SKIPPED in that case — it would be pure wasted work, painted
      // then immediately overpainted. The idle span is still drawn for non-
      // display segments and as the fallback when a display column has no
      // valid matrix cell (row < 0, e.g. rowVcBase out of range). The guard
      // matches the original call site exactly (displayColumnActive &&
      // idleEnd > idleStart == visibleEnd > visibleStart), so the number of
      // _getCycleCharacterCell calls is unchanged; it has no side effects
      // beyond filling the reused _scratchCharCell.
      let cellRow = -1, cellLine = 0;
      if (seg.displayColumnActive && idleEnd > idleStart) {
        const cell = this._getCycleCharacterCell(seg);
        cellRow = cell.row;
        cellLine = cell.line;
      }
      const columnsWillPaint = seg.displayColumnActive && cellRow >= 0;

      if (idleEnd > idleStart && !columnsWillPaint) {
        // Idle-state graphics: the sequencer clocks the live idle g-access
        // byte ($3FFF, or $39FF when ECM) through the shifter exactly as in
        // display state, but with the video-matrix c-data forced to 0 (Bauer
        // §3.7.3.9). _renderOpenBorderIdleSpan applies the per-mode colouring
        // for that byte:
        //   • text / ECM-text / MCM-text idle → bit pattern, fg=BLACK
        //   • MCM bitmap idle → pair 00 = $D021, pairs 01/10/11 = BLACK
        //     (c-data nibbles are 0), so the idle byte shows as a pattern
        //   • standard bitmap idle + invalid ECM+BMM modes → BLACK pixels,
        //     yet the fg/priority/collision bits still follow the real idle
        //     byte (nine.prg's $70 top border feeds $D01F from these bits)
        // so the real byte must reach the sequencer for every mode.
        // Left-edge XSCROLL preload (Bauer §3.7.3): the sequencer's 8-bit
        // shifter is reloaded after each g-access, and XSCROLL delays that
        // reload by 0-7 pixels. The line's FIRST reload therefore lands at
        // canvas 32+XSCROLL, and the pixels before it (canvas 32..31+XSCROLL,
        // inside the cycle-15 segment) drain an ALREADY-EMPTY shifter — "0"
        // bits → the mode's idle background, same silicon as the empty side
        // zones (hence _fillSegmentBg0). The span is anchored at the display
        // column start (textStartX), NOT at the segment's visible start: with
        // CSEL=0 the widened left border (canvas ≤38) covers the whole
        // preload, so nothing of it may leak into the visible x≥39 pixels
        // (WONDER D1 intro: FLD swing lines, $3FFF=$FF, $D021=white — real HW
        // shows solid black; an idleStart-anchored fill painted a white bar
        // at x=40..39+XSCROLL). With CSEL=1 the preload IS visible at
        // x=32..31+XSCROLL — the idle twin of the display-state left filler
        // (Coma 'GOOD THINGS' stripe, VICE-oracle-verified at those x).
        let idlePixelStart = idleStart;
        if (seg.cycle === 15 && segXscroll > 0) {
          const fillerEnd = Math.min(idleEnd, textStartX + segXscroll);
          if (fillerEnd > idleStart) {
            this._fillSegmentBg0(seg, rowOffset, idleStart, fillerEnd);
            idlePixelStart = fillerEnd;
          }
        }
        this._renderOpenBorderIdleSpan(seg, rowOffset, idlePixelStart, idleEnd);
        this.borderBuffer.fill(0, idleStart, idleEnd);   // line buffer (#1)
      }

      if (!seg.displayColumnActive) continue;

      const visibleStart = idleStart;
      const visibleEnd = idleEnd;
      if (visibleEnd <= visibleStart) continue;

      if (cellRow < 0) continue;
      const row = cellRow, line = cellLine;

      const sourceOriginX = this._getSegmentSourceOrigin(textStartX);
      const srcStart = (visibleStart - sourceOriginX) - segXscroll;
      const srcEnd = (visibleEnd - 1 - sourceOriginX) - segXscroll;
      const firstCol = Math.max(0, srcStart >> 3);
      const lastCol = Math.min(39, srcEnd >> 3);

      const spanPixels = this._spanPixels;
      const spanFgMap = this._spanFgMap;
      // Only [0, spanCols*8) is written by _renderSourceColumn below and read
      // back by the paint loop (the `spanX < spanLimit` gate); the tail up to
      // CANVAS_W (384) is never touched this call. Scope the reset to the used
      // width — byte-identical, and mirrors _writeSegmentCollisionUnderBorder's
      // already-scoped fill. spanCols == lastCol-firstCol+1 (0 when lastCol<firstCol,
      // where fill(...,0,<=0) is a no-op — matching spanLimit==0).
      const spanFillLen = (lastCol - firstCol + 1) * 8;
      spanPixels.fill(segBg0, 0, spanFillLen);
      spanFgMap.fill(0, 0, spanFillLen);
      let spanCols = 0;
      for (let col = firstCol; col <= lastCol; col++) {
        this._renderSourceColumn(col, line, seg, spanPixels, spanFgMap, spanCols * 8);
        spanCols++;
      }

      const spanBaseX = firstCol * 8;
      const spanLimit = spanCols * 8;
      // Pre-compute the segment's bg0 + the "delayed first-pixel" override
      // outside the per-pixel loop. _getDelayedBgColor returns the live
      // bg only at canvasX === cycleStart and only when prev/cur differ;
      // for all other pixels the answer is segBg0 we already have.
      const cycleStart = seg.cycleStart;
      const prevRegs = seg.prevRegs;
      // First pixel: border-timed fixup (seg.bgRegs set) takes the 6569 c+2
      // step so the bg boundary lands on the same pixel as a $D020 change;
      // the incremental render keeps the live _firstPixelBgColor rule.
      const segBg0First = seg.bgRegs
        ? this._firstPixelBgColorShifted(seg.bgPrevRegs[0x21], segBgRegs[0x21])
        : this._firstPixelBgColor(prevRegs, 0x21, seg.regs[0x21], segBg0);
      const collisionBuf = this.graphicsCollisionBuffer;
      const priorityBuf = this.graphicsPriorityBuffer;
      const borderBuf = this.borderBuffer;
      // (A3) The boundary-pixel bg override only differs from segBg0 when the
      // bg register changes at the cycle seam (or the 8565 grey-dot). Hoist
      // that test so the common case drops the per-pixel `canvasX === cycleStart`
      // compare — V8 short-circuits the loop-invariant false. Identical output:
      // when bgChangesAtStart is false, segBg0First === segBg0 anyway.
      const bgChangesAtStart = segBg0First !== segBg0;

      // Standard bitmap mode (BMM=1, MCM=0, ECM=0) has NO $D021 background —
      // a 0-bit's colour is the matrix byte's low nibble (handled per-pixel in
      // _renderSourceColumn). The XSCROLL edge-filler pixels (srcX outside the
      // rendered column span: the sequencer's pre/post-load output, visible at
      // the left edge in 40-col mode whenever XSCROLL>0) were painted with
      // segBg0/$D021, producing a spurious vertical stripe in the display zone
      // (Coma "GOOD THINGS COME TO" scene: an XSCROLL=4 light-blue $D021 column
      // on the purple bitmap). In standard bitmap the filler must follow the
      // adjacent column's bitmap background; every other mode keeps $D021. Mode
      // bits read from the same snapshot _renderSourceColumn uses (modeRegs).
      const fmRegs = seg.modeRegs || seg.nextRegs || seg.regs;
      const fmEcm = (fmRegs[0x11] >> 6) & 1;
      const fmBmm = (fmRegs[0x11] >> 5) & 1;
      const fmMcm = (fmRegs[0x16] >> 4) & 1;
      const isStdBitmap = fmBmm && !fmMcm && !fmEcm;
      // Invalid modes (ECM set together with BMM and/or MCM — Bauer
      // §3.7.3.5/§3.7.3.7/§3.7.3.8): the sequencer outputs BLACK for every
      // bit value, INCLUDING the "0" bits the empty/pre-load shifter emits
      // in the XSCROLL edge-filler zone — same mode table as the idle path
      // (_fillSegmentBg0 / _renderOpenBorderIdleSpan modeCodes 2/4/5).
      // WONDER D1 bands scene: ECM+BMM rows (d011=$7B) with $D021=8/10 and
      // XSCROLL swinging 1..7 — a $D021 filler painted a small flickering
      // block at canvas x=32..38 where hardware shows solid black.
      const isInvalidMode = fmEcm && (fmBmm || fmMcm);
      let fillerLeft = segBg0, fillerRight = segBg0;
      if (isInvalidMode) {
        fillerLeft = fillerRight = 0xFF000000 | 0;
      } else if (isStdBitmap) {
        const cWriteCol = this.lineCycleCWriteCol[seg.cycle];
        const colShift = cWriteCol >= 0 ? (cWriteCol - (seg.cycle - 15)) : 0;
        const sl = firstCol + colShift, sr = lastCol + colShift;
        if (sl >= 0 && sl < 40 && seg.rowFetchedCols[sl]) fillerLeft = PALETTE_RGBA[seg.rowCodes[sl] & 0x0F];
        if (sr >= 0 && sr < 40 && seg.rowFetchedCols[sr]) fillerRight = PALETTE_RGBA[seg.rowCodes[sr] & 0x0F];
      }
      const fillerActive = isStdBitmap || isInvalidMode;

      for (let canvasX = visibleStart; canvasX < visibleEnd; canvasX++) {
        const relX = canvasX - sourceOriginX;
        const srcX = relX - segXscroll;
        const pIdx = rowOffset + canvasX;
        const spanX = srcX - spanBaseX;
        const bgPixel = (bgChangesAtStart && canvasX === cycleStart) ? segBg0First : segBg0;

        if (spanX >= 0 && spanX < spanLimit) {
          const fgVal = spanFgMap[spanX];
          const pxVal = spanPixels[spanX];
          collisionBuf[canvasX] = fgVal;   // line buffers (#1); collisionBuf===priorityBuf (#2)
          priorityBuf[canvasX] = fgVal;
          fb32[pIdx] = (!fgVal && pxVal === segBg0) ? bgPixel : pxVal;
        } else {
          collisionBuf[canvasX] = 0;
          priorityBuf[canvasX] = 0;
          fb32[pIdx] = fillerActive ? (spanX < 0 ? fillerLeft : fillerRight) : bgPixel;
        }
        borderBuf[canvasX] = 0;
      }
    }
  },

  // XSCROLL delays the graphics-shifter reload without shortening the
  // 320-pixel stream. Its final XSCROLL pixels therefore land immediately
  // beyond the fixed display column. The normal right border overlays them;
  // an opened border exposes the tail before the side zone settles to its
  // empty-shifter background.
  _renderRightXscrollSpill(seg, rowOffset, segRenderStart, segRenderEnd) {
    const priorCycle = seg.cycle - 1;
    const lcr = this.lineCycleRegs;
    const corrected = seg.xscrollRegs !== null;
    const priorRegCycle = priorCycle + this._regOffset;
    const priorXscrollRegs = corrected
      ? lcr[Math.min(priorCycle + 2, CYCLES_PER_LINE)]
      : lcr[priorRegCycle];
    const spillWidth = priorXscrollRegs[0x16] & 0x07;
    const spillStart = Math.max(segRenderStart, GRAPHICS_WINDOW_END);
    const spillEnd = Math.min(segRenderEnd, GRAPHICS_WINDOW_END + spillWidth);
    if (spillEnd <= spillStart) return;

    // Reuse the current segment synchronously as the preceding display-column
    // segment. This preserves that column's fetch/mode timing without creating
    // a hot-path object; current-cycle output-stage background snapshots remain
    // attached so colour writes still follow the beam.
    const savedCycle = seg.cycle;
    const savedRegs = seg.regs;
    const savedNextRegs = seg.nextRegs;
    const savedModeRegs = seg.modeRegs;
    const savedBank = seg.bank;
    const savedDisplayActive = seg.displayActive;
    const savedRc = seg.rc;
    const savedRowVcBase = seg.rowVcBase;
    const savedLiveVcBase = seg.liveVcBase;
    const savedFetchedCols = seg.rowFetchedCols;
    const savedRowCodes = seg.rowCodes;
    const savedRowColors = seg.rowColors;

    seg.cycle = priorCycle;
    seg.regs = lcr[priorRegCycle];
    seg.nextRegs = lcr[Math.min(priorRegCycle + 1, CYCLES_PER_LINE)];
    seg.modeRegs = corrected
      ? lcr[Math.min(priorCycle + 2, CYCLES_PER_LINE)]
      : seg.nextRegs;
    seg.bank = this.lineCycleBanks[priorCycle];
    seg.displayActive = !!this.lineCycleDisplayActive[priorCycle];
    seg.rc = this.lineCycleRc[priorCycle];
    seg.rowVcBase = this.lineCycleRowVcBase[priorCycle];
    seg.liveVcBase = this.lineCycleRowLiveVcBase[priorCycle];
    seg.rowFetchedCols = this.lineCycleRowFetchedCols[priorCycle];
    seg.rowCodes = this.lineCycleRowCodes[priorCycle];
    seg.rowColors = this.lineCycleRowColors[priorCycle];

    const pixels = this._spanPixels;
    const fgMap = this._spanFgMap;
    this._renderSourceColumn(39, seg.rc & 0x07, seg, pixels, fgMap, 0);

    seg.cycle = savedCycle;
    seg.regs = savedRegs;
    seg.nextRegs = savedNextRegs;
    seg.modeRegs = savedModeRegs;
    seg.bank = savedBank;
    seg.displayActive = savedDisplayActive;
    seg.rc = savedRc;
    seg.rowVcBase = savedRowVcBase;
    seg.liveVcBase = savedLiveVcBase;
    seg.rowFetchedCols = savedFetchedCols;
    seg.rowCodes = savedRowCodes;
    seg.rowColors = savedRowColors;

    const sourceStart = 8 - spillWidth + (spillStart - GRAPHICS_WINDOW_END);
    const fb32 = this.fb32;
    const collisionBuf = this.graphicsCollisionBuffer;
    const priorityBuf = this.graphicsPriorityBuffer;
    for (let x = spillStart, source = sourceStart; x < spillEnd; x++, source++) {
      fb32[rowOffset + x] = pixels[source];
      collisionBuf[x] = fgMap[source];
      priorityBuf[x] = fgMap[source];
    }
  },

  // Collision-only render of a display column covered by the CLOSED main
  // border. Produces the same per-column fg map the open-window path would
  // (same _renderSourceColumn machinery, same xscroll/window mapping) but
  // writes ONLY the collision/priority line buffers — the framebuffer keeps
  // the border fill and borderBuffer stays 1. Columns outside the graphics
  // window are left untouched (side zones shift an empty sequencer, and the
  // per-line clear in _initRenderRasterLine already zeroed them). Idle-state
  // segments under a closed border are NOT handled here (the call site gates
  // on displayColumnActive): their idle-byte fg would need the
  // _renderOpenBorderIdleSpan colouring rules — a known residual with no
  // demo or testprog evidence yet.
  _writeSegmentCollisionUnderBorder(seg, segRenderStart, segRenderEnd, segXscroll) {
    const visibleStart = Math.max(segRenderStart, GRAPHICS_WINDOW_START);
    const visibleEnd = Math.min(segRenderEnd, GRAPHICS_WINDOW_END);
    if (visibleEnd <= visibleStart) return;
    const cell = this._getCycleCharacterCell(seg);
    if (cell.row < 0) return;
    const sourceOriginX = this._getSegmentSourceOrigin(GRAPHICS_WINDOW_START);
    const srcStart = (visibleStart - sourceOriginX) - segXscroll;
    const srcEnd = (visibleEnd - 1 - sourceOriginX) - segXscroll;
    const firstCol = Math.max(0, srcStart >> 3);
    const lastCol = Math.min(39, srcEnd >> 3);
    if (lastCol < firstCol) return;
    const spanPixels = this._spanPixels;
    const spanFgMap = this._spanFgMap;
    spanFgMap.fill(0, 0, (lastCol - firstCol + 1) * 8);
    let spanCols = 0;
    for (let col = firstCol; col <= lastCol; col++) {
      this._renderSourceColumn(col, cell.line, seg, spanPixels, spanFgMap, spanCols * 8);
      spanCols++;
    }
    const spanBaseX = firstCol * 8;
    const spanLimit = spanCols * 8;
    const collisionBuf = this.graphicsCollisionBuffer;
    const priorityBuf = this.graphicsPriorityBuffer;
    for (let canvasX = visibleStart; canvasX < visibleEnd; canvasX++) {
      const spanX = (canvasX - sourceOriginX) - segXscroll - spanBaseX;
      const fgVal = (spanX >= 0 && spanX < spanLimit) ? spanFgMap[spanX] : 0;
      collisionBuf[canvasX] = fgVal;   // line buffers (#1); collisionBuf===priorityBuf (#2)
      priorityBuf[canvasX] = fgVal;
    }
  },

  // Sub-character split pixel for a +2 -> +3 ECM/BMM/MCM transition, measured
  // against the 6569 modesplit reference. The output-mode boundary lands at
  // pixel 4 (half a character) when the +3 mode is a black "invalid" mode (no
  // graphics data to clock out), but entering a data-reading mode adds a
  // pipeline delay so the boundary slips 1-2px right. Mode code =
  // ECM<<2 | BMM<<1 | MCM; pairs not listed use the nominal 4.
  _modeSplitPixel(s2, s3) {
    const m2 = (((s2[0x11] >> 6) & 1) << 2) | (((s2[0x11] >> 5) & 1) << 1) | ((s2[0x16] >> 4) & 1);
    const m3 = (((s3[0x11] >> 6) & 1) << 2) | (((s3[0x11] >> 5) & 1) << 1) | ((s3[0x16] >> 4) & 1);
    if (m2 === 0b101 && m3 === 0b011) return 6;   // invalid -> MC bitmap
    if (m2 === 0b110 && m3 === 0b100) return 5;   // invalid -> ECM text
    if (m2 === 0b100 && m3 === 0b000) return 6;   // ECM text -> text
    return 4;
  },

  // Sub-column mode split (modesplit/movesplit). A mid-line ECM/BMM/MCM flip
  // takes effect on screen at a HALF-character (4-6px) boundary, not the full
  // column boundary: the transition column shows the +2 output mode in its
  // LEFT part and the +3 output mode in its RIGHT part (verified pixel-exact
  // against the 6569 modesplit reference for every clean-split flip column;
  // _modeSplitPixel gives the per-mode-pair boundary). The Pass-1 render has
  // already painted the span [xs,xe) with the +2 mode; this re-renders it with
  // the +3 mode/data and keeps only the right part, restoring the +2 left
  // part. No-op unless the mode bits change +2 -> +3, so static lines and
  // non-flip columns are untouched.
  _fixupModeSplitRightHalf(seg, c, canvasY, xs, xe) {
    const lcr = this.lineCycleRegs;
    const c2 = c + 2 <= CYCLES_PER_LINE ? c + 2 : CYCLES_PER_LINE;
    const c3 = c + 3 <= CYCLES_PER_LINE ? c + 3 : CYCLES_PER_LINE;
    const s2 = lcr[c2], s3 = lcr[c3];
    if (((s2[0x11] ^ s3[0x11]) & 0x60) === 0 && ((s2[0x16] ^ s3[0x16]) & 0x10) === 0) return;
    const off = this._modeSplitPixel(s2, s3);   // half-character output boundary
    const mid = xs + off < xe ? xs + off : xe;
    if (mid <= xs) return;
    const rowOffset = canvasY * CANVAS_W;
    const fb32 = this.fb32, pri = this.graphicsPriorityBuffer,
          coll = this.graphicsCollisionBuffer, bor = this.borderBuffer;
    const L = this._fixupSplitL, LP = this._fixupSplitLPri,
          LC = this._fixupSplitLCol, LB = this._fixupSplitLBor;
    for (let x = xs, i = 0; x < mid; x++, i++) {
      const p = rowOffset + x; L[i] = fb32[p]; LP[i] = pri[x]; LC[i] = coll[x]; LB[i] = bor[x];
    }
    seg.modeRegs = s3;
    seg.xscrollRegs = s3;
    seg.rowFetchedCols = this.lineCycleRowFetchedCols[c3];
    seg.rowCodes = this.lineCycleRowCodes[c3];
    seg.rowColors = this.lineCycleRowColors[c3];
    this._renderCycleSegmentGraphics(seg, canvasY);
    for (let x = xs, i = 0; x < mid; x++, i++) {
      const p = rowOffset + x; fb32[p] = L[i]; pri[x] = LP[i]; coll[x] = LC[i]; bor[x] = LB[i];
    }
  },

  // End-of-line column fixup. Corrects cycle-incremental render
  // approximations that can only be resolved once EVERY per-cycle register
  // snapshot for the line is captured (the defer-1 incremental render can't
  // read +2/+3 cycles ahead). Both re-render the line's graphics twice and
  // merge ONLY graphics-owned pixels (saved===gfx1), leaving sprite pixels
  // and the recoloured border untouched.
  //
  // (a) Mode transition (VIC-Addendum.txt "Fetch", modesplit/movesplit):
  //     the incremental render samples the ECM/BMM/MCM bits at the +1
  //     (g-access) snapshot, but real 6569 output shows the split boundary
  //     one column earlier. The governing snapshot for the visible split is
  //     +2 (the CPU write at the g-access cycle's phi2 lands in
  //     lineCycleRegs[seg.cycle+2]). Deferring the render by 2 instead fixes
  //     it but perturbs the cy56 hyperscreen sprite/border-veto path
  //     (FppScroller right border), so we correct it here, then split the
  //     transition column's right half to the +3 mode via
  //     _fixupModeSplitRightHalf. The Addendum's RAM->charROM address-latch
  //     glitch is a narrower fetch-byte issue handled in _graphicsFetchAddr.
  //
  // (b) Background-colour timing (spriteenable testprog): $D021-$D024 are
  //     OUTPUT-STAGE registers for active display columns, with NO 12px
  //     graphics-data delay. Idle inner-zone background is not retimed here;
  //     VICE/6569 keeps opened-idle $D021 rasterbars uniform across the line.
  //
  // Pass 1 re-renders with BOTH corrections (the fully spec-correct row);
  // Pass 2 re-renders with the defaults (deterministically reproducing the
  // incremental output). Gated on an actual mid-line mode OR bg change, so
  // static lines pay only a cheap scan.
  _fixupColumns(canvasY) {
    const lcr = this.lineCycleRegs;
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
      const a = lcr[c + 1], b = at(c + 2);
      // Alias fast path: captureDedup shares ONE regs array across cycles with
      // no CPU write between them, so pointer-equal snapshots prove every
      // masked xor below is zero without reading a byte.
      if (a === b && lcr[c] === a) continue;
      if (((a[0x11] ^ b[0x11]) & 0x60) ||
          ((a[0x16] ^ b[0x16]) & 0x10) ||
          ((lcr[c][0x16] ^ b[0x16]) & 0x07)) {
        needed = true;
        break;
      }
    }
    // …or a bg-showing-column bg-colour change in the c-vs-(c+3) border-timed window.
    if (!needed) {
      for (let c = 11; c <= 58; c++) {
        if (!showsBg(c)) continue;
        const cur = lcr[c], b3 = at(bgTargetCycle(c));
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
    const collisionBuf = this.graphicsCollisionBuffer;
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
    if (this.batchRender) {
      const ro = this._regOffset;
      for (let c = 11; c <= 58; c++) {
        const rc = c + ro;
        const rcRegs = lcr[rc];
        const nx = lcr[(rc + 1 <= CYCLES_PER_LINE) ? rc + 1 : rc];
        const s2 = at(c + 2);
        const s3 = at(c + 3);
        // Alias fast paths (both windows): captureDedup shares ONE regs array
        // across cycles with no CPU write between them, so pointer-equal
        // snapshots prove every byte compare below is equal without reading.
        let needFix = !(nx === s2 && rcRegs === s2 && s2 === s3)
                  && (((nx[0x11] ^ s2[0x11]) & 0x60) !== 0
                   || ((nx[0x16] ^ s2[0x16]) & 0x10) !== 0
                   || ((rcRegs[0x16] ^ s2[0x16]) & 0x07) !== 0
                   // Sub-column mode split needs the +2 -> +3 transition column too.
                   || ((s2[0x11] ^ s3[0x11]) & 0x60) !== 0
                   || ((s2[0x16] ^ s3[0x16]) & 0x10) !== 0);
        const cShowsBg = showsBg(c);
        if (cShowsBg && !needFix) {
          const h = lcr[c - 2];             // c >= 11 ⇒ c-2 >= 9, always a valid index
          const bt = bgTargetCycle(c);
          if (!(at(c - 1) === h && at(c) === h && at(c + 1) === h &&
                at(c + 2) === h && at(bt) === h)) {
            for (let r = 0x21; r <= 0x24 && !needFix; r++) {
              const v = h[r];
              for (let k = c - 1; k <= bt; k++) {
                if (at(k)[r] !== v) { needFix = true; break; }
              }
            }
          }
        }
        if (!needFix) continue;
        const seg0 = this._buildCycleRasterSegment(c);
        const xs = seg0.start < 0 ? 0 : seg0.start;
        const xe = seg0.end > CANVAS_W ? CANVAS_W : seg0.end;
        if (xe <= xs) continue;
        // Indexed copy, not .set(fb32.subarray(...)): subarray allocates a
        // view object, and this runs per triggered cycle — hot-path churn.
        for (let x = xs; x < xe; x++) saved[x] = fb32[rowOffset + x];
        // Pass 1 (spec-correct): seg0 is the shared scratch seg for cycle c.
        {
          const dc = Math.min(c + 2, CYCLES_PER_LINE);
          seg0.modeRegs = at(dc);
          seg0.xscrollRegs = at(dc);
          seg0.rowFetchedCols = this.lineCycleRowFetchedCols[dc];
          seg0.rowCodes = this.lineCycleRowCodes[dc];
          seg0.rowColors = this.lineCycleRowColors[dc];
        }
        if (cShowsBg) {
          const bt = bgTargetCycle(c);
          seg0.bgRegs = at(bt);
          seg0.bgPrevRegs = at(bgPrevCycle(c, bt));
        }
        this._renderCycleSegmentGraphics(seg0, canvasY);
        this._fixupModeSplitRightHalf(seg0, c, canvasY, xs, xe);
        for (let x = xs; x < xe; x++) {
          gfx2[x] = fb32[rowOffset + x];
          gfx2Fg[x] = priorityBuf[x];   // line buffer (#1)
        }
        // Pass 2 (reproduce incremental): rebuild resets modeRegs/xscrollRegs/
        // bgRegs/bgPrevRegs to their defaults, so this paints the incremental output.
        this._renderCycleSegmentGraphics(this._buildCycleRasterSegment(c), canvasY);
        for (let x = xs; x < xe; x++) {
          const g1 = fb32[rowOffset + x];
          const pIdx = rowOffset + x;
          fb32[pIdx] = spriteHiddenBySpecFg(pIdx, x)
            ? gfx2[x]
            : ((spriteVisible[x] || saved[x] !== g1) ? saved[x] : gfx2[x]);   // line buffers (#1)
          priorityBuf[x] = gfx2Fg[x];   // collisionBuf === priorityBuf (#2)
          collisionBuf[x] = gfx2Fg[x];
        }
      }
      return;
    }

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
      seg.rowFetchedCols = this.lineCycleRowFetchedCols[dc];
      seg.rowCodes = this.lineCycleRowCodes[dc];
      seg.rowColors = this.lineCycleRowColors[dc];
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
      priorityBuf[x] = gfx2Fg[x];   // collisionBuf === priorityBuf (#2)
      collisionBuf[x] = gfx2Fg[x];
    }
  },
};
