// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/vic2-sprites.js – VIC-II sprite unit (methods of VIC2): sprite DMA
// start/stop and MC/MCBASE bookkeeping, p/s-access fetches, sprite BA/AEC
// timing, the fixed per-cycle sequencer events (Bauer §3.8), sprite pixel
// rendering with priority, and the sprite-sprite / sprite-background
// collision pipeline.

import {
  CANVAS_W, CYCLES_PER_LINE, PALETTE_RGBA, SPRITE_BA_BASE, SPRITE_BA_CANDIDATES,
  SPRITE_PTR_ACCESS, SPRITE_PTR_CYCLE, SPRITE_ROW_ACCESS,
} from './vic2-tables.js';

// Method group installed onto VIC2.prototype by vic2.js — `this` is the
// VIC2 chip instance. See the partial-class assembly note there.
export const spriteOps = {

  _clearSpriteFetchState() {
    this.spritePointerValue.fill(0);
    this.spriteRowByteMask.fill(0);
    this.spriteShiftReg.fill(0);
    for (let s = 0; s < 8; s++) this.spriteRowData[s].fill(0);
    this._sprSnapVersion++;   // capture-dedup: sprite source changed
  },

  _getSpritePointerAccessSprite(cycle) {
    return (cycle >= 0 && cycle <= CYCLES_PER_LINE) ? SPRITE_PTR_ACCESS[cycle] : -1;
  },

  _spriteSequencerPointerAccess(cycle) {
    const s = this._getSpritePointerAccessSprite(cycle);
    if (s < 0) return;
    const d018 = this.regs[0x18];
    const screenBase = ((d018 >> 4) & 0x0F) * 0x0400;
    const bank = this.currentVicBank;
    this._fetchSpritePointer(s, screenBase, bank);
  },

  _fetchSpritePointer(s, screenBase, bank) {
    const ptr = this._vicReadWithBank(screenBase + 0x3F8 + s, bank);
    this.spritePointerValue[s] = ptr;
    this.spritePointerFresh[s] = 1;
    this.spriteDataBase[s] = ptr * 64;
    this.spriteDataBank[s] = bank;
    this._sprSnapVersion++;   // capture-dedup: sprite source changed
    return ptr;
  },

  _clearSpriteRowBytes(s) {
    this.spriteRowData[s].fill(0);
    this.spriteRowByteMask[s] = 0;
    this.spriteShiftReg[s] = 0;
    this._sprSnapVersion++;   // capture-dedup: sprite source changed
  },

  _endSpriteDisplayLine(s) {
    if (this.spriteDisplayOn[s] && this.spriteLineDataRow[s] >= 0) {
      this.lastSpriteEndRaster[s] = this.raster;
      this.lastSpriteEndPtr[s] = this.spritePointerValue[s];
      this.lastSpriteEndRow[s] = this.spriteLineDataRow[s];
      this.lastSpriteEndShiftReg[s] = this.spriteShiftReg[s] >>> 0;
      this.lastSpriteEndMask[s] = this.spriteRowByteMask[s] & 0x07;
    }
    this.spriteDisplayOn[s] = 0;
    this.spriteStartPending[s] = 0;
    this.spriteStopPending[s] = 0;
    this.spriteLineDataRow[s] = -1;
    this._clearSpriteRowBytes(s);   // also bumps _sprSnapVersion (capture-dedup)
  },

  _updateSpriteShiftReg(s) {
    this.spriteShiftReg[s] =
      ((this.spriteRowData[s][0] << 16) |
        (this.spriteRowData[s][1] << 8) |
        this.spriteRowData[s][2]) >>> 0;
    this._sprSnapVersion++;   // capture-dedup: sprite source changed
  },

  _spriteDisplayRowFromMc(mc) {
    const value = mc & 0x3F;
    if (value >= 63) return -1;
    const row = (value / 3) | 0;
    return row > 20 ? 20 : row;
  },

  _fetchSpriteRowByte(s, byteIdx) {
    if (byteIdx < 0 || byteIdx > 2) return;

    const mc = this.spriteMC[s] & 0x3F;
    const base = this.spriteDataBase[s];
    const bank = this.spriteDataBank[s];

    // Fetch data even if MC wrapped. This pulls data from the beginning
    // of the sprite block again, producing the repeated texture.
    this.spriteRowData[s][byteIdx] = this._vicReadSprite(base + mc, bank);
    this.spriteRowByteMask[s] |= (1 << byteIdx);

    // Hardware MC is also a 6-bit counter. Allow it to wrap!
    this.spriteMC[s] = (mc + 1) & 0x3F;

    this._updateSpriteShiftReg(s);
  },

  _performSpriteRowSAccesses(s) {
    this._clearSpriteRowBytes(s);
    this._fetchSpriteRowByte(s, 0);
    this._fetchSpriteRowByte(s, 1);
    this._fetchSpriteRowByte(s, 2);
    if (this._spriteByte0Floats[s]) {
      // Late DMA start (see _tryStartSpriteDma): byte 0's fetch landed before
      // BA/AEC had stalled the CPU, so it read the open data bus ($FF). The
      // RAM fetch above still advanced MC (the access happens, only its data
      // is bogus); override the displayed byte and re-pack the shifter.
      this._spriteByte0Floats[s] = 0;
      this.spriteRowData[s][0] = 0xFF;
      this._updateSpriteShiftReg(s);
    }
  },

  _getSpriteRowAccessSprite(cycle) {
    return (cycle >= 0 && cycle <= CYCLES_PER_LINE) ? SPRITE_ROW_ACCESS[cycle] : -1;
  },

  _wrapLineCycle(cycle) {
    // Sole caller passes cycle ± lookahead (≤3) of a 1..63 in-line cycle, so
    // the value is within one period of the valid range — a single add/sub
    // suffices (no loop needed).
    if (cycle < 1) return cycle + CYCLES_PER_LINE;
    if (cycle > CYCLES_PER_LINE) return cycle - CYCLES_PER_LINE;
    return cycle;
  },

  _spriteBaLow(cycle) {
    // Per Bauer §3.6.1 + the bumbershootsoft article: BA goes low 3 cycles
    // before each enabled sprite's FIRST bus access (the p-access) and
    // stays low through both the p-access and the s-access. So for sp0
    // (p=58, s=59), BA spans cycles 55..59 (3 lead + 2 access). With the
    // standard `AEC = BA(c) && BA(c-3)` formula this gives AEC low at
    // cycles 58 and 59 — matching the article's "2 cycles per sprite".
    //
    // The lookahead must include both p-access and s-access cycles; otherwise
    // BA starts too late and AEC no longer accounts for the full two-cycle
    // sprite bus window Bauer specifies.
    //
    // The lookahead window's candidate sprite set is precomputed per base cycle
    // (SPRITE_BA_CANDIDATES) — this loop reduces to walking that list against
    // the live spriteDmaOn[]. Identical result to the original 4-iteration
    // wrap+table-lookup loop (a logical OR over the same (sprite, dmaOn) checks).
    const idx = cycle + SPRITE_BA_BASE;
    if (idx < 0 || idx >= SPRITE_BA_CANDIDATES.length) return false;
    const cands = SPRITE_BA_CANDIDATES[idx];
    const dma = this.spriteDmaOn;
    for (let i = 0; i < cands.length; i++) {
      if (dma[cands[i]]) return true;
    }
    return false;
  },

  _spriteAecLow(cycle) {
    // Per Bauer §3.6.1: AEC follows BA after 3 cycles of BA-low warning.
    // The BA signal is unified — sprite BA OR bad-line BA OR else. The
    // c-3 lookback must therefore consult the unified signal, not just
    // sprite BA, so overlapping bad-line and sprite windows still produce
    // the correct AEC-low interval.
    //
    // Live-state form: pure function of current spriteDmaOn/regs. Used
    // by synthetic tests that set state directly. For the master-cycle
    // hot path, prefer _spriteAecLowHistoric which reads the per-cycle
    // BA history captured by _captureCycleState (matters when BA state
    // changed across the c-3 line boundary).
    return this._isBaLowCycle(cycle) && this._isBaLowCycle(cycle - 3);
  },

  // Historical-lookback variant. The c-3 sample is read from the
  // per-cycle external-BA buffer captured in _captureCycleState (and
  // rotated to prevLineExternalBaLow at _beginRasterLine). At cy 1..3
  // the lookback wraps to cy 61..63 of the PREVIOUS line — using the
  // history avoids projecting current spriteDmaOn[]/raster state onto
  // a cycle that already happened with different state.
  _spriteAecLowHistoric(cycle) {
    if (!this._isBaLowCycle(cycle)) return false;
    // AEC is the BA *delay line* (Bauer §3.6.1): it drops only after BA has
    // been low for 3 CONTINUOUS cycles, and a single BA-high cycle resets the
    // delay. So require BA low at c-1, c-2 AND c-3 — not just the c-3 endpoint.
    // Endpoint-only (BA(c) && BA(c-3)) is identical for any contiguous BA-low
    // run (sprite DMA, natural bad line) but WRONG across a 1-cycle gap: e.g.
    // the cycle-11 lull between the sprite-DMA tail (…cy10) and a *cancelled*
    // bad line's cy12 BA. There BA is low at cy9,10 and cy12,13 but high at
    // cy11, so AEC must stay HIGH at cy12-13. The old test reported AEC low and
    // stalled the pending CPU write 2cy — which made Coma Light 13's per-line
    // STY $D011 store creep past its FLI bad-line cancel deadline and collapse
    // the plasma into flat bands.
    return this._historicExternalBaLow(cycle - 1)
      && this._historicExternalBaLow(cycle - 2)
      && this._historicExternalBaLow(cycle - 3);
  },

  // Historical external-BA (sprite || bad-line) at `cycle`, with prev-line
  // wrap for cycle < 1 — mirrors the c-3 lookback's boundary handling.
  _historicExternalBaLow(cycle) {
    if (cycle >= 1) return this.lineCycleExternalBaLow[cycle] === 1;
    return this.prevLineExternalBaLow[cycle + CYCLES_PER_LINE] === 1;
  },

  _spriteStealsCpuCycle(cycle) {
    // Hot path: use the historical-lookback AEC so the c-3 sample at
    // cy 1..3 of a line correctly reads the previous line's tail BA
    // (rather than today's spriteDmaOn[] / raster state projected onto
    // a cycle that already happened).
    return this._spriteAecLowHistoric(cycle);
  },

  _spriteSequencerRowAccess(cycle) {
    // Bauer §3.8.1 rule 5: s-accesses run when DMA is on, fetching the
    // 3 bytes for the current sprite row. Display state is set by
    // rule 4 at cycle 58 phi1, NOT here — keep this path data-only.
    //
    // The DMA-OFF / idle-fetch path runs in phi2() (see
    // _spriteSequencerRowAccessIdle) so the latch sees same-cycle CPU
    // writes to $D0xx — those land between vic.clock and vic.phi2.
    // We DO drive the bus here in the idle case to capture the s-cycle
    // phi1 ghost-byte ($3FFF) read in the CURRENT bank — before CPU's
    // phi2 has had a chance to flip $DD00.
    const s = this._getSpriteRowAccessSprite(cycle);
    if (s < 0) return;
    if (this.spriteDmaOn[s] && this.spritePointerFresh[s]) {
      this._performSpriteRowSAccesses(s);
    } else {
      this._spriteSCyclePhi1Ghost[s] = this._vicReadWithBank(0x3FFF, this.currentVicBank) & 0xFF;
      this._spriteSCyclePhi1GhostValid[s] = 1;
    }
  },

  _spriteSequencerRowAccessIdle(cycle) {
    // VIC-Addendum.txt "Sprite idle fetch" rule: an idle fetch shows whatever
    // is on the VIC-II internal bus ($FF if no access). Our model: when
    // DMA is off the sprite buffer's 3 bytes come from 3 distinct
    // halfcycles of the p+s fetch pair:
    //   byte 0 = p-cycle phi2 bus  (CPU phase of p-cycle, recorded earlier)
    //   byte 1 = $3FFF ghost byte  (read at s-cycle phi1 in vic.clock())
    //   byte 2 = s-cycle phi2 bus  (CPU phase of s-cycle, sampled now)
    // Captured even when displayOn=false: with X>=$164, rule-4 turns display
    // on at c58 of the same line AFTER c7/c8 fetches, and the buffer loaded
    // here is what gets displayed. byte 1 is read at phi1 (before CPU's
    // phi2 can flip the bank via $DD00) so it reflects the bank at the
    // moment the VIC actually owns the bus.
    const s = this._getSpriteRowAccessSprite(cycle);
    if (s < 0) return;
    if (this.spriteDmaOn[s]) return;        // real-fetch path handled in clock()
    const data = this.spriteRowData[s];
    if (this.spriteIdleFetchLeakEnabled) {
      data[0] = this._spritePCyclePhi2BusValid[s]
        ? this._spritePCyclePhi2Bus[s]
        : 0xFF;
      data[1] = this._spriteSCyclePhi1GhostValid[s]
        ? this._spriteSCyclePhi1Ghost[s]
        : this._vicMemRead(0x3FFF, this.currentVicBank);
      data[2] = this.vicInternalBus & 0xFF;
    } else {
      // Flag off: no bus leak, all bytes 0xFF (compare/bisect mode).
      data[0] = 0xFF;
      data[1] = 0xFF;
      data[2] = 0xFF;
    }
    this.spriteRowByteMask[s] = 0x07;
    this._updateSpriteShiftReg(s);
    this._spritePCyclePhi2BusValid[s] = 0;
    this._spriteSCyclePhi1GhostValid[s] = 0;
    this._spriteIdleFetchedThisLine[s] = 1;
  },

  _tryStartSpriteDma(s, enabled, rasterY, yExpMask) {
    if (!((enabled >> s) & 1)) return;
    if (this.spriteDmaOn[s]) return;
    if ((this.regs[s * 2 + 1] & 0xFF) !== rasterY) return;

    this.spriteDmaOn[s] = 1;
    this.spriteMC[s] = 0;
    this.spriteMCBase[s] = 0;

    // Open-bus first byte (testprogs/VICII/spriteenable core2): the DMA-start
    // check (Bauer §3.8.1 rule 2) fires at cy55 and again at cy56. If a
    // sprite is enabled so late (e.g. `dec $d015` landing at cy55) that the
    // cy55 check misses it and only the cy56 check turns DMA on, BA goes low
    // one cycle too late. The 3-cycle BA→AEC lead-in then hasn't completed by
    // the time the VIC fetches byte 0 (PHI2 of the p-access cycle), so that
    // first data byte reads the floating data bus ($FF) instead of RAM. Only
    // sprite 0 can hit this: its p-access (cy58) is just 2 cycles after a cy56
    // start; sprites 1-7 have >=3 cycles of lead (sprite 1's p-access is cy60,
    // sprites 3-7's are on the next line). The p-access (PHI1) and bytes 1-2
    // are unaffected, so only byte 0 of this first DMA row is corrupted.
    const pCycle = SPRITE_PTR_CYCLE[s];
    if (pCycle > this.cycleInLine && pCycle - this.cycleInLine < 3) {
      this._spriteByte0Floats[s] = 1;
    }

    // Bauer §3.8.1 rule 3 (cy 55/56 DMA-start) switches on DMA, clears
    // MCBASE, and resets the expand FF — it does NOT touch the display
    // flip-flop. The display FF is owned exclusively by rule 4 at cy 58
    // (DMA on + Y match → display ON; DMA off → display OFF). Clearing
    // spriteDisplayOn here was a non-spec heuristic that broke the
    // "restart on the last display line" trick (testprogs/VICII/
    // spriterestart, nine.prg maskers): when a sprite's DMA is re-armed
    // at cy 55 of its final display line — where the display is still on
    // (DMA went off at cy 16, addendum rule 7) — the display must REMAIN
    // on even if the CPU then moves $D001 so cy 58 no longer Y-matches.
    //
    // Bauer §3.8.1 (2024) rule 2: "the DMA is switched on, MCBASE is
    // cleared, and the advance line flip-flop is set." FF=1 always at
    // DMA start, regardless of MxYE. (Rule 3 then inverts FF in cycle 56
    // phi2 if MxYE is set, so MxYE-Y-expanded sprites end up with FF=0
    // for the next line — making row 0 repeat — while non-Y-expanded
    // sprites stay at FF=1 throughout.)
    this.spriteYExpandFF[s] = 1;

    this.spriteLineDataRow[s] = 0;
    this.spriteStartPending[s] = 1;
    this.spriteStopPending[s] = 0;
    // DMA-start clears the buffer so a reused sprite doesn't bleed stale data
    // before its s-accesses refill it. EXCEPTION (testprogs/VICII/
    // sb_sprite_fetch): a sprite at rawX >= $164 turns its display ON this
    // SAME line (rule 4 @cy58) and must show the idle-fetch "ghost"/bus bytes
    // it loaded at its OWN p+s fetch cycle EARLIER this line (sprites 3-7 fetch
    // before the cy55/56 DMA-start). Bauer rule 2/3: DMA-start does NOT clear
    // the shift register — so for that case PRESERVE the just-fetched bytes.
    const spriteX = this.regs[s * 2] | (((this.regs[0x10] >> s) & 1) << 8);
    if (spriteX >= 0x164 && this._spriteIdleFetchedThisLine[s]) {
      this._sprSnapVersion++;   // buffer unchanged; DMA state did change
    } else {
      this._clearSpriteRowBytes(s);   // also bumps _sprSnapVersion (capture-dedup)
    }
  },

  _spriteSequencerCycle15() {
    // Bauer §3.8.1 (2024) has no MCBASE update at cycle 15 — the old
    // "MCBASE += 2 if FF set" rule is gone. Cycle 15 only matters for
    // detecting the sprite-crunch trigger (rule 7a), which is handled in
    // the $D017 register-write hook the moment the bit clears: it sets
    // _spriteCrunchPending[s], consumed at the next cycle 16.
  },

  _spriteSequencerCycle16() {
    // Bauer §3.8.1 (2024) rule 7: at cycle 16 phi1, if the advance line
    // flip-flop is set, MCBASE := MC (LOAD, not increment). Then check
    // MCBASE == 63 to turn off DMA.
    //
    // Rule 7a (sprite crunch): if the CPU cleared MxYE in cycle 15 with
    // the FF previously unset, FF was force-set then; instead of MCBASE
    // := MC, MCBASE = (101010 & (MCBASE & MC)) | (010101 & (MCBASE | MC))
    // — an even/odd bit interleave. The MCBASE==63 stop check still
    // runs but with this surprising value.
    for (let s = 0; s < 8; s++) {
      // Latch-and-clear the crunch pending bit BEFORE the DMA gate. If
      // $D017 cleared MxYE during cycle 15 of a line where this sprite
      // had no DMA, the bit was set but never consumed — leaking into a
      // future line's cycle 16 (after DMA started) and applying the
      // crunch formula to an unrelated row.
      const crunch = this._spriteCrunchPending[s];
      this._spriteCrunchPending[s] = 0;

      if (!this.spriteDmaOn[s]) continue;
      if (this.spriteYExpandFF[s]) {
        const mcb = this.spriteMCBase[s] & 0x3F;
        const mc  = this.spriteMC[s] & 0x3F;
        if (crunch) {
          this.spriteMCBase[s] =
            ((0b101010 & (mcb & mc)) | (0b010101 & (mcb | mc))) & 0x3F;
        } else {
          this.spriteMCBase[s] = mc;
        }
      }

      if (this.spriteMCBase[s] === 63) {
        // Bauer §3.8.1 (per VIC-Addendum.txt): the cycle-16 path only turns
        // off DMA. Display disable happens at cycle 58 phi1 via rule 4
        // (DMA off → display off), so the sprite's last line is shown
        // right up to cycle 58 instead of being clipped at cycle 16.
        this.spriteDmaOn[s] = 0;
      }
    }
  },

  _spriteSequencerCycle55() {
    // Bauer §3.8.1 (2024) rule 2: cycle 55 phi1 runs the DMA-start check.
    // The FF inversion (old rule 2) moved to cycle 56 phi2 — see rule 3.
    const enabled = this.regs[0x15];
    const yExpMask = this.regs[0x17];
    const rasterY = this.raster & 0xFF;
    for (let s = 0; s < 8; s++) {
      this._tryStartSpriteDma(s, enabled, rasterY, yExpMask);
    }
  },

  _spriteSequencerCycle56() {
    // Bauer §3.8.1 (2024) rule 2 (cycle 56 phi1): second DMA-start check.
    // Rule 3 (cycle 56 phi2): if MxYE=1 AND DMA on, the advance-line FF is
    // inverted. Rule 1 is a level-sensitive hold: MxYE=0 forces the FF to
    // 1 here too, even if tests staged state by assigning regs[] directly.
    // phi2() runs after CPU phi2 and reconciles same-cycle $D017 writes.
    const enabled = this.regs[0x15];
    const yExpMask = this.regs[0x17];
    const rasterY = this.raster & 0xFF;
    for (let s = 0; s < 8; s++) {
      this._tryStartSpriteDma(s, enabled, rasterY, yExpMask);
    }
    for (let s = 0; s < 8; s++) {
      if ((yExpMask >> s) & 1) {
        if (this.spriteDmaOn[s]) this.spriteYExpandFF[s] ^= 1;     // rule 3
      } else {
        this.spriteYExpandFF[s] = 1;                                // rule 1
      }
    }
    this._c56MxYESnapshot = yExpMask;
  },

  _spriteSequencerCycle58() {
    // Bauer §3.8.1 rule 4: at cycle 58 phi1, MC := MCBASE. Then check
    // (DMA on AND Y matches lower 8 bits of RASTER) → display ON.
    // Otherwise if DMA off → display OFF. (DMA on with no Y match
    // preserves display state — neither rule clause fires.)
    const rasterY = this.raster & 0xFF;
    const enabled = this.regs[0x15];
    for (let s = 0; s < 8; s++) {
      this.spriteMC[s] = this.spriteMCBase[s];

      if (!this.spriteDmaOn[s]) {
        // Rule 4 second clause: DMA off → display off. Per VIC-Addendum.txt,
        // this is the canonical disable point — even when DMA was just
        // turned off at cycle 16 of the same line — so the sprite's
        // last line shows pixels up to cycle 58 phi1.
        this._endSpriteDisplayLine(s);
        continue;
      }

      // Rule 4 first clause: DMA on AND Y match → display on.
      //
      // The display turn-on additionally requires the MxE enable bit
      // ($D015) to still be set HERE. The cy55/56 DMA-start check and the
      // cy58 display check read $D015 independently, so the DMA flip-flop
      // and the display flip-flop can disagree when the CPU rewrites $D015
      // between them. testprogs/VICII/spriteenable proves this:
      //   • core1: INC $D015 $07->$08 at cy55 — sprites 0-2 get DMA at the
      //     cy55 check (pre-write $07) and steal CPU/bus cycles for their
      //     21 lines, but MxE is clear by cy58 so they NEVER display; only
      //     sprite 3 (enabled by the cy56 check) shows.
      //   • core2: DEC $D015 $08->$07 at cy55 — mirror image: only 0-2 show.
      //   • core4: DEC $D015 ->$07 just before cy58 — sprite 3 had DMA from
      //     cy55/56 but MxE is clear at cy58, so NO sprite displays.
      // Because the only Y-match line is the sprite's activation line,
      // gating the turn-on clause is sufficient: a sprite that misses its
      // turn-on never displays even though DMA runs (and steals cycles).
      if (((enabled >> s) & 1) &&
          (this.regs[s * 2 + 1] & 0xFF) === rasterY) {
        this.spriteDisplayOn[s] = 1;
        this.spriteStartPending[s] = 0;
        this._sprSnapVersion++;   // capture-dedup: sprite source changed
      }

      // Compute dataRow from MC for the upcoming render. (Display state
      // is already set per rule 4; here we only stage the row index.)
      const row = this._spriteDisplayRowFromMc(this.spriteMC[s]);
      if (this.spriteDisplayOn[s]) {
        if (row >= 0) {
          this.spriteLineDataRow[s] = row;
          this._sprSnapVersion++;   // capture-dedup: sprite source changed
        } else {
          // MC out of valid 0..62 range — shifter wraps off naturally.
          this._endSpriteDisplayLine(s);
        }
      } else {
        // DMA on, display off (sprite hasn't reached its Y match yet,
        // or display ended on a prior line). Clear stale row state.
        this._endSpriteDisplayLine(s);
      }
    }
  },

  _spriteSequencerCycle59() { },

  _spriteSequencerCycle60() { },

  // Capture the per-sprite line render state at FF-detect time so a
  // subsequent veto can roll back and re-paint sprites for the veto
  // window. Snapshots are stored per-pending-record on the FF-transition
  // queue (see _pendingFFTransitions).
  // Allocate one empty sprite-line snapshot, including 8 reusable inner
  // render-state objects (_rsBuf) so refilling a pooled snapshot allocates
  // nothing. The per-cycle render slot reuses a single pooled buffer
  // (_spritePreSegSnapBuf); the FF-transition queue path allocates a fresh
  // one per capture (those entries are retained across cycles + serialized).
  _allocSpriteLineSnapshot() {
    const snap = {
      renderState: new Array(8).fill(null),
      started: new Uint8Array(8),
      prevSegDisplayOn: new Uint8Array(8),
      lastShiftReg: new Uint32Array(8),
      lastRowByteMask: new Uint8Array(8),
      lastDataRow: new Int8Array(8),
      left: new Int16Array(8),
      sweptPreCanvas: new Uint8Array(8),
      pwValid: new Uint8Array(8),
      pwShiftReg: new Uint32Array(8),
      pwValidMask: new Uint32Array(8),
      pwUnitsRemaining: new Int32Array(8),
      pwPixelPhase: new Int32Array(8),
      pwPixelsPerUnit: new Int32Array(8),
      pwIsMulti: new Uint8Array(8),
      pwXExp: new Uint8Array(8),
      pwStartCanvasX: new Int32Array(8),
      _rsBuf: new Array(8),
    };
    for (let s = 0; s < 8; s++) {
      snap._rsBuf[s] = { shiftReg: 0, validMask: 0, unitsRemaining: 0, pixelPhase: 0, currentX: 0, pixelsPerUnit: 0 };
    }
    return snap;
  },

  // Populate `snap` in place from the live sprite-line render state. Reuses
  // snap._rsBuf for the inner render-state objects so a pooled buffer can be
  // refilled every cycle without allocating. Behaviour-identical to the prior
  // allocate-and-fill: the returned snapshot's fields are the same values.
  _fillSpriteLineSnapshot(snap) {
    for (let s = 0; s < 8; s++) {
      const rs = this._spriteLineRenderState[s];
      if (rs) {
        const t = snap._rsBuf[s];
        t.shiftReg = rs.shiftReg; t.validMask = rs.validMask;
        t.unitsRemaining = rs.unitsRemaining; t.pixelPhase = rs.pixelPhase;
        t.currentX = rs.currentX; t.pixelsPerUnit = rs.pixelsPerUnit;
        snap.renderState[s] = t;
      } else {
        snap.renderState[s] = null;
      }
      snap.started[s] = this._spriteLineStarted[s];
      snap.prevSegDisplayOn[s] = this._spriteLinePrevSegDisplayOn[s];
      snap.lastShiftReg[s] = this._spriteLineLastShiftReg[s];
      snap.lastRowByteMask[s] = this._spriteLineLastRowByteMask[s];
      snap.lastDataRow[s] = this._spriteLineLastDataRow[s];
      snap.left[s] = this._spriteLineLeft[s];
      snap.sweptPreCanvas[s] = this._spriteLineSweptPreCanvas[s];
      snap.pwValid[s] = this._spriteLinePendingWrapValid[s];
      snap.pwShiftReg[s] = this._spriteLinePendingWrapShiftReg[s];
      snap.pwValidMask[s] = this._spriteLinePendingWrapValidMask[s];
      snap.pwUnitsRemaining[s] = this._spriteLinePendingWrapUnitsRemaining[s];
      snap.pwPixelPhase[s] = this._spriteLinePendingWrapPixelPhase[s];
      snap.pwPixelsPerUnit[s] = this._spriteLinePendingWrapPixelsPerUnit[s];
      snap.pwIsMulti[s] = this._spriteLinePendingWrapIsMulti[s];
      snap.pwXExp[s] = this._spriteLinePendingWrapXExp[s];
      snap.pwStartCanvasX[s] = this._spriteLinePendingWrapStartCanvasX[s];
    }
    return snap;
  },

  // Snapshot for the _pendingFFTransitions queue. Reuses a pooled object when
  // one is free (released by _evaluatePendingTransitions when the transition
  // latches), else allocates. NOT serialized, so reuse is save-state-safe. The
  // hot per-cycle render slot does NOT use this; it refills _spritePreSegSnapBuf.
  _captureSpriteLineSnapshot() {
    const snap = this._spriteSnapPool.length ? this._spriteSnapPool.pop() : this._allocSpriteLineSnapshot();
    return this._fillSpriteLineSnapshot(snap);
  },

  // Return a queue snapshot to the pool once its transition is resolved. Capped
  // so the pool can't grow unbounded (queue depth is small in practice).
  _releaseSpriteSnapshot(snap) {
    if (snap && this._spriteSnapPool.length < 16) this._spriteSnapPool.push(snap);
  },

  _restoreSpriteLineSnapshot(snap) {
    if (!snap) return;
    for (let s = 0; s < 8; s++) {
      const rs = snap.renderState[s];
      if (rs) {
        // Copy INTO an arena rent — snap._rsBuf objects must never become the
        // live slot (the snapshot may be refilled while the slot still lives).
        const t = this._rentSpriteRenderState();
        t.shiftReg = rs.shiftReg; t.validMask = rs.validMask;
        t.unitsRemaining = rs.unitsRemaining; t.pixelPhase = rs.pixelPhase;
        t.currentX = rs.currentX; t.pixelsPerUnit = rs.pixelsPerUnit;
        this._spriteLineRenderState[s] = t;
      } else {
        this._spriteLineRenderState[s] = null;
      }
      this._spriteLineStarted[s] = snap.started[s];
      this._spriteLinePrevSegDisplayOn[s] = snap.prevSegDisplayOn[s];
      this._spriteLineLastShiftReg[s] = snap.lastShiftReg[s];
      this._spriteLineLastRowByteMask[s] = snap.lastRowByteMask[s];
      this._spriteLineLastDataRow[s] = snap.lastDataRow[s];
      this._spriteLineLeft[s] = snap.left[s];
      this._spriteLineSweptPreCanvas[s] = snap.sweptPreCanvas[s] | 0;
      this._spriteLinePendingWrapValid[s] = snap.pwValid[s];
      this._spriteLinePendingWrapShiftReg[s] = snap.pwShiftReg[s];
      this._spriteLinePendingWrapValidMask[s] = snap.pwValidMask[s];
      this._spriteLinePendingWrapUnitsRemaining[s] = snap.pwUnitsRemaining[s];
      this._spriteLinePendingWrapPixelPhase[s] = snap.pwPixelPhase[s];
      this._spriteLinePendingWrapPixelsPerUnit[s] = snap.pwPixelsPerUnit[s];
      this._spriteLinePendingWrapIsMulti[s] = snap.pwIsMulti[s];
      this._spriteLinePendingWrapXExp[s] = snap.pwXExp[s];
      this._spriteLinePendingWrapStartCanvasX[s] = snap.pwStartCanvasX[s];
    }
  },

  // Sprite-X same-cycle-write fixup (Bauer §3.6.1 X-counter + §3.8.1).
  //
  // The cycle-incremental render runs at phi1 and renders segment K (the 8
  // canvas pixels of cycle K+1) using lineCycleRegs[K] — i.e. the sprite X as
  // it stood BEFORE this machine cycle's CPU phi2 write. But on a real 6569
  // the per-pixel X-comparator sees a $D000-$D00E/$D010 write at phi2 of that
  // cycle for the phi2-half pixels of the cycle (proven by the spritex C64
  // column: at a fixed write cycle the old→new flip is exactly the phi1/phi2
  // boundary, e.g. X=95→96). So when such a write lands, the segment we just
  // rendered must be re-done with the corrected (post-write) X.
  //
  // Called from phi2() (after CPU writes). Rolls back the pre-render sprite
  // snapshot taken in the render loop, patches only the sprite-X bytes of the
  // segment's register snapshot to the live (post-write) values, clears the
  // segment's sprite buffers + this cycle's not-yet-drained collision
  // detections, and re-renders graphics + sprites for the segment. Collision
  // timing is preserved (detection stays in this cycle; visibility pipeline
  // unchanged) — only the X moves. The Hat "GENESIS" scene: sprite 0 (X=8,
  // match in cy14's phi2-half) is caught by the cy14 $D010 write → displays
  // HIGH (canvas 272) instead of LOW (canvas 16).
  _applySpriteXSameCycleFixup() {
    if (!this._spriteXWriteThisCycle) return;
    this._spriteXWriteThisCycle = false;
    if (!this._cycleIncrementalRender) return;
    // Tier-3 line-batch: on a deferred line nothing is painted yet, so the
    // re-render below is moot — but the CAPTURE-PATCHING contract must still
    // run: a write at this cycle's phi2 is only captured from [K+2] on, so
    // without the patch the replay would render segs K/K+1 with the stale X
    // (Bauer §3.8.1 phi2-half catch lost). Same detection gate as the live
    // path, with "sprite active" derived from the captured displayOn history
    // — equivalent to the live snapshot's started/renderState, which is
    // pristine while deferred. No rollback / pipe-drop / re-render: nothing
    // was painted or enqueued.
    if (this._lineDeferred) {
      const K = this._thisCycleInLine - 1;
      if (K < 11 || K > 58 || this._cycleRenderActiveCanvasY < 0) return;
      const lcr = this.lineCycleRegs[K];
      const regs = this.regs;
      let changed = false;
      for (let s = 0; s < 8 && !changed; s++) {
        let active = this.lineCycleSpriteDisplayOn[K][s] !== 0;
        for (let c = 11; c < K && !active; c++) {
          active = this.lineCycleSpriteDisplayOn[c][s] !== 0;
        }
        if (!active) continue;
        const oldX = lcr[s * 2] | (((lcr[0x10] >> s) & 1) << 8);
        const newX = regs[s * 2] | (((regs[0x10] >> s) & 1) << 8);
        if (oldX !== newX) changed = true;
      }
      if (!changed) return;
      const lcrP = this._unaliasRegSnapshot(K);
      const lcrNext = (K + 1 <= CYCLES_PER_LINE) ? this._unaliasRegSnapshot(K + 1) : null;
      for (let s = 0; s < 8; s++) {
        lcrP[s * 2] = regs[s * 2];
        if (lcrNext) lcrNext[s * 2] = regs[s * 2];
      }
      lcrP[0x10] = regs[0x10];
      if (lcrNext) lcrNext[0x10] = regs[0x10];
      return;
    }
    const snap = this._spritePreSegSnap;
    if (!snap) return;
    const K = this._spritePreSegCycle;
    // The snapshot must belong to the segment just rendered THIS machine cycle.
    if (K !== this._thisCycleInLine - 1 || K < 11 || K > 58) return;
    const canvasY = this._cycleRenderActiveCanvasY;
    if (canvasY < 0) return;

    // Re-render only if an active sprite's effective X actually changed vs the
    // value segment K rendered with.
    const lcr = this.lineCycleRegs[K];
    const regs = this.regs;
    const sprSeg = this._buildCycleSpriteSegment(K);
    let changed = false;
    for (let s = 0; s < 8; s++) {
      if (!(sprSeg.spriteDisplayOn[s] || snap.started[s] || snap.renderState[s])) continue;
      const oldX = lcr[s * 2] | (((lcr[0x10] >> s) & 1) << 8);
      const newX = regs[s * 2] | (((regs[0x10] >> s) & 1) << 8);
      if (oldX !== newX) { changed = true; break; }
    }
    if (!changed) return;

    this._restoreSpriteLineSnapshot(snap);
    // Patch ONLY the sprite-X bytes; leave colour/MC/priority/mode as captured.
    // A write at phi2 of machine cycle M is missing from BOTH lineCycleRegs[M-1]
    // (=K, the segment we re-render now) AND lineCycleRegs[M] (=K+1, captured at
    // phi1 of M, before this phi2 write) — only lineCycleRegs[M+1]+ capture it.
    // Segment K+1 renders next machine cycle reading lineCycleRegs[K+1], so it
    // must be patched too or it would retarget the sprite back to the stale X
    // (the even-line "overlap" + the sprite never reaching its high position).
    // (B2) The reg snapshot may be aliased (a shared, deduped buffer). Give K
    // and K+1 PRIVATE buffers before patching in place, so we don't mutate the
    // snapshot under earlier cycles that alias the same buffer (those get
    // re-read by the end-of-line _fixupColumns pass).
    const lcrP = this._unaliasRegSnapshot(K);
    const lcrNext = (K + 1 <= CYCLES_PER_LINE) ? this._unaliasRegSnapshot(K + 1) : null;
    for (let s = 0; s < 8; s++) {
      lcrP[s * 2] = regs[s * 2];
      if (lcrNext) lcrNext[s * 2] = regs[s * 2];
    }
    lcrP[0x10] = regs[0x10];
    if (lcrNext) lcrNext[0x10] = regs[0x10];
    // (B2) sprSeg was built from lineCycleRegs[K+regOffset] BEFORE the un-alias
    // above may have repointed that slot to a private buffer — refresh its reg
    // reference so the sprite re-render below reads the patched (post-write) X.
    sprSeg.regs = this.lineCycleRegs[K + this._regOffset];

    const x0 = sprSeg.start < 0 ? 0 : sprSeg.start;
    const x1 = sprSeg.end > CANVAS_W ? CANVAS_W : sprSeg.end;
    for (let x = x0; x < x1; x++) {
      this.spriteOwnerBuffer[x] = 0xFF;   // line buffers (#1)
      this.spriteVisibleBuffer[x] = 0;
      this.spriteCollisionBuffer[x] = 0;
    }
    // Drop this cycle's not-yet-drained sprite-collision detections; the
    // re-render re-emits them at the corrected positions.
    this._collPipeE[1] = 0; this._collLateE[1] = 0;
    this._collPipeF[1] = 0; this._collLateF[1] = 0;

    // Re-render graphics (restores the segment's framebuffer + priority/coll
    // buffers to graphics-only), then re-paint sprites with the corrected X.
    this._renderCycleSegmentGraphics(this._buildCycleRasterSegment(K), canvasY);
    this._deferCollisionCommit = true;
    for (let s = 0; s < 8; s++) {
      this._renderSpriteSegmentForSprite(sprSeg, s, canvasY);
    }
    this._deferCollisionCommit = false;
  },

  // The sprite half of one cycle's incremental render — split out so the
  // Phase-2 coalesced replay can emit graphics in wide spans while keeping
  // sprites (which feed the collision pipe) cycle-by-cycle.
  _renderSegSpritesIncremental(renderCycle, canvasY, live) {
    const sprSeg = this._buildCycleSpriteSegment(renderCycle);
    if (live) {
      // Snapshot the pre-render sprite state of this segment so phi2() can
      // roll back and re-render it if a same-cycle $D00x write (landing at
      // this machine cycle's phi2, AFTER this phi1 render) moves a sprite's
      // X (Bauer §3.6.1/§3.8.1 phi2-half catch). Gated to cycles where a
      // sprite is active — the only case a fixup can matter. See
      // _applySpriteXSameCycleFixup (called from phi2()).
      let spriteActive = false;
      for (let s = 0; s < 8; s++) {
        if (sprSeg.spriteDisplayOn[s] || this._spriteLineStarted[s]) { spriteActive = true; break; }
      }
      if (spriteActive) {
        this._spritePreSegSnap = this._fillSpriteLineSnapshot(this._spritePreSegSnapBuf);
        this._spritePreSegCycle = renderCycle;
      } else {
        this._spritePreSegSnap = null;
        this._spritePreSegCycle = -1;
      }
    }
    // Sprite pixels paint into the framebuffer / owner / collision
    // buffers as the beam passes the column (this cycle); the
    // resulting $D01E/$D01F bits are queued and become CPU-visible 2
    // cycles later via the pipeline above. _deferCollisionCommit
    // routes the register update there without changing the pixels.
    this._deferCollisionCommit = true;
    if (this.spriteSkipIdle) {
      // Equivalent to the internal early-out (segDisplayOn sets
      // _spriteLineStarted[s]; never-started ⇒ return): skip the call for
      // sprites that are neither displaying-now nor started this line.
      for (let s = 0; s < 8; s++) {
        if (sprSeg.spriteDisplayOn[s] || this._spriteLineStarted[s]) {
          this._renderSpriteSegmentForSprite(sprSeg, s, canvasY);
        }
      }
    } else {
      for (let s = 0; s < 8; s++) {
        this._renderSpriteSegmentForSprite(sprSeg, s, canvasY);
      }
    }
    // After the last rendered cycle's normal sprite paint, emit the
    // $163/$164 boundary garbage (Bauer §3.8.1 rule 4 re-trigger). Runs
    // once per line as a separate pass — not inside the per-sprite path
    // whose idle-skip can early-return once a sprite's shifter empties.
    // In sprite order so sprite N's garbage sees sprite <N's in the
    // collision buffer; still inside the deferred-commit window so the
    // resulting $D01E/$D01F bits follow the 2-cycle visibility pipeline.
    if (this.spriteBoundaryGarbage && renderCycle === 58) {
      for (let s = 0; s < 8; s++) {
        this._paintSpriteBoundaryGarbage(s, canvasY);
      }
    }
    // Sprite-sprite collisions in the right border / off-canvas strip.
    if (renderCycle === 58) {
      this._offCanvasSpriteSpriteCollision(canvasY);
    }
    this._deferCollisionCommit = false;
  },

  // Render one sprite (s) for one cycle's segment. Persists shifter
  // state across cycles via _spriteLine* arrays so callers can dispatch
  // per-cycle. Bauer §3.8.2 priority: this is invoked in sprite-priority
  // order (0..7) by the orchestrator, so sprite 0 claims pixels first.
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
    if (this.spriteSkipIdle
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
      // A line-start state in the pre-canvas sweep zone (raw X $1A0..$1F7,
      // swept at cycles 1..11 before canvas X=0) already matched: in line-time
      // EVERY later write is behind the beam, so it cannot reposition either —
      // its register survives for the end-of-line wrap / off-canvas collision
      // (The Hat "13 sprites scroller" left-exit columns).
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
        // Bauer §3.8.1: raw X $1A0..$1F7 (canvas 424..511) is swept by the
        // X counter at cycles 1..11, before canvas X=0. A line-start state
        // with X there has already had its comparator match this line — mark
        // it so the pre-start rewrite branch treats later low-X writes as
        // rule-6 beam-passed no-ops (shift register preserved for the
        // end-of-line wrap + off-canvas collision). Raw $1F8+ never matches
        // (skipped counter band) and remains repositionable.
        this._spriteLineSweptPreCanvas[s] =
          (seg.start === 0 && spriteLeft >= 424 && spriteLeft <= 511) ? 1 : 0;
        const pixelsPerUnit = (spriteIsMulti ? 2 : 1) * (spriteXExp ? 2 : 1);
        const spriteWidth = (spriteIsMulti ? 12 : 24) * pixelsPerUnit;
        // A high-X sprite only counts as already-started at canvas X=0 when its
        // body crossed the raw X=$1F7 -> $000 wrap point and emitted same-line
        // left-edge pixels. High-X sprites that do not reach the wrap point are
        // still pending; a later write ahead of the beam may legitimately move
        // their first comparator match.
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

  // One-shot full-sprite paint for the X>=$164 same-line display TURN-ON
  // (testprogs/VICII/sb_sprite_fetch — the "dotty" bogus line). Paints the
  // sprite from canvas column sx using the preserved idle-fetch bytes already
  // in the shifter, with per-column register sampling (mirrors
  // _paintSpriteSameLineWrap / _paintSpriteBoundaryGarbage). The cy58 display-FF
  // turn-on lands "after" the sprite's columns in the deferred per-cycle
  // capture, so the normal path skipped them — this catches them up in one pass.
  _renderSpriteSameLineHighX(seg, s, canvasY) {
    this._spriteLineStarted[s] = 1;
    const isMulti = (seg.regs[0x1C] >> s) & 1;
    const xExp = (seg.regs[0x1D] >> s) & 1;
    const sx = (seg.regs[s * 2] | (((seg.regs[0x10] >> s) & 1) << 8)) + 8;
    const regOffset = this._regOffset;
    const state = this._createSpriteRenderState(
      seg.spriteShiftReg[s] >>> 0, seg.spriteRowByteMask[s], sx, sx, !!isMulti, !!xExp
    );
    let cx = Math.max(0, sx);
    while (cx < CANVAS_W && state.unitsRemaining > 0) {
      const cycle = (cx >> 3) + 11;
      const cregs = this.lineCycleRegs[cycle + regOffset];
      const sprMcol0 = PALETTE_RGBA[cregs[0x25] & 0x0F];
      const sprMcol1 = PALETTE_RGBA[cregs[0x26] & 0x0F];
      const sprColor = PALETTE_RGBA[cregs[0x27 + s] & 0x0F];
      const pri = (cregs[0x1B] >> s) & 1;
      const info = this._spriteSequencerPixelInfo(
        state.shiftReg, state.validMask, !!isMulti, sprMcol0, sprMcol1, sprColor
      );
      if (info.draw) {
        this._processSpritePixelCollision(cx, canvasY, s);
        if (this._spriteVisibleAt(cx, canvasY)) {
          this._drawSpritePixel(cx, canvasY, info.color, s, pri);
        }
      }
      this._advanceSpriteSequencerState(state, !!isMulti, !!xExp);
      cx++;
    }
    // Persist for the end-of-line wrap + bookkeeping (mirror normal-path tail).
    this._spriteLineRenderState[s] = state;
    this._spriteLineLeft[s] = sx;
    this._spriteLineLastShiftReg[s] = seg.spriteShiftReg[s] >>> 0;
    this._spriteLineLastRowByteMask[s] = seg.spriteRowByteMask[s];
    this._spriteLineLastDataRow[s] = seg.spriteDataRow[s];
    this._spriteLinePrevSegDisplayOn[s] = 1;
    this._renderSpriteEndOfLineWrap(seg, s, canvasY, state, sx, !!isMulti, !!xExp);
  },

  // Bauer §3.8 sprite-X horizontal wrap (SAME line). The X counter
  // wraps at raw X=504 (PAL line width). With our canvas X = raw X + 8
  // mapping, that's canvas X=512 — but the wrap TARGET is canvas X=0
  // (= raw X=-8 = raw X=496 mod 504), since pixels at raw X=496..503
  // are physically on the same scanline at the END of the line and
  // those positions correspond to canvas X=0..7 in our mapping (the
  // overscan area visible to the left of the active display).
  //
  // For sp0 X=494 (sx=502, width=24): pixels 0..1 land at canvas
  // X=502..503 (off-canvas right of our 384-wide canvas), pixels
  // 2..23 wrap to canvas X=0..21 — 8 pixels in the cycle-11 segment
  // (canvas X=0..7) and 14 pixels in cycles 12-13 (canvas X=8..21).
  // This matches VICE's full-width FAIRLIGHT rendering where the F
  // glyph spans the entire left side of the canvas including the
  // overscan area.
  _renderSpriteEndOfLineWrap(seg, s, canvasY, renderState, sx, spriteIsMulti, spriteXExp) {
    if (seg.end === CANVAS_W) {
      if (this._spriteLinePendingWrapValid[s]) {
        this._paintSpriteSameLineWrapState(
          this._spriteLinePendingWrapShiftReg[s] >>> 0, this._spriteLinePendingWrapValidMask[s] >>> 0,
          this._spriteLinePendingWrapUnitsRemaining[s] | 0, this._spriteLinePendingWrapPixelPhase[s] | 0,
          this._spriteLinePendingWrapPixelsPerUnit[s] | 0, !!this._spriteLinePendingWrapIsMulti[s], !!this._spriteLinePendingWrapXExp[s],
          s, canvasY, this._spriteLinePendingWrapStartCanvasX[s] | 0
        );
        this._spriteLinePendingWrapValid[s] = 0;
        return;
      }
    }
    if (!(seg.end === CANVAS_W && renderState && renderState.unitsRemaining > 0)) return;
    // The wrapped-over pixels physically display at the START of this line
    // (canvas ~0..width ≈ cycles 11..17), which is BEFORE any mid-line
    // $D000-$D00E/$D010 write that repositions the sprite for its right-edge
    // (cy57) appearance. So position the wrap from the sprite X sampled EARLY
    // in the line, not the end-of-line snapshot (seg.regs) `sx` was built from.
    // Fullscreen "hyperscreen" sprite scrollers (The Hat disk-2 end scroller)
    // rewrite sprite 0's X 496↔497 mid-line every raster via a marching write;
    // using the end-of-line X shears the wrapped left-border glyph by 1px per
    // raster and garbles it. VICE positions the wrap from the early X → clean.
    // For a sprite whose X is stable across the line, the early sample equals
    // `sx`, so this is a no-op there (no regression to FAIRLIGHT/hvborder1-style
    // stable high-X wraps). Guarded on a valid early snapshot.
    const earlyRegs = this.lineCycleRegs[11 + this._regOffset];
    if (earlyRegs) {
      sx = (earlyRegs[s * 2] | (((earlyRegs[0x10] >> s) & 1) << 8)) + 8;
    }
    const pixelsPerUnit = (spriteIsMulti ? 2 : 1) * (spriteXExp ? 2 : 1);
    const spriteWidth = (spriteIsMulti ? 12 : 24) * pixelsPerUnit;
    // Real-hw raster line width = raw X 0..503 (504 ticks). With our
    // canvas X = raw X + 8 mapping, raw X wraps at canvas X=504 to
    // raw X=-8 = canvas X=0 (mod-504 of canvas X).
    const lineWrapPointInCanvas = 504;
    // Bauer §3.8 (closing paragraph): the horizontal counter skips raw
    // X $1F8..$1FF (504..511), wrapping $1F7→$000. A sprite whose
    // X-coordinate (= sx - 8) lands in that invisible band is never
    // reached by the X comparator, so it does not display at all — no
    // pixels, no collision. Without this guard the modular canvas
    // mapping aliases e.g. raw X=511 (sx=519) onto canvas X=15 and
    // paints a phantom sprite there, yielding a false sprite-sprite
    // collision (VICII/spritecollisions sprite-sprite.prg entry 9,
    // X=511 → expected no collision). A sprite that STARTS in the
    // reachable zone but extends past raw X=503 still wraps normally;
    // the canvas seam (503→0) skips the band mid-sprite on its own.
    const spriteXReachable = sx - 8 < lineWrapPointInCanvas;
    if (spriteXReachable && sx + spriteWidth > lineWrapPointInCanvas) {
      // Pixels off-canvas right (canvas X in [CANVAS_W, lineWrapPoint))
      // are skipped without painting, consuming shifter steps.
      const offCanvasCount = Math.max(0, lineWrapPointInCanvas - sx);
      // First wrapped pixel's canvas X = (sx + offCanvasCount) - 504.
      // For sx=502 → 0 (= canvas-X 0..21). For sx=512 → 8 (canvas-X
      // 8..31). For sx=508 → 4 (canvas-X 4..27).
      const wrapStartCanvasX = (sx + offCanvasCount) - lineWrapPointInCanvas;
      let shiftReg = renderState.shiftReg >>> 0;
      let validMask = renderState.validMask >>> 0;
      let unitsRemaining = renderState.unitsRemaining | 0;
      let pixelPhase = renderState.pixelPhase | 0;
      const isMulti = !!spriteIsMulti;
      const xExp = !!spriteXExp;
      for (let i = 0; i < offCanvasCount && unitsRemaining > 0; i++) {
        pixelPhase++;
        if (pixelPhase >= pixelsPerUnit) {
          pixelPhase = 0;
          if (isMulti) {
            shiftReg = ((shiftReg << 2) & 0xFFFFFF) >>> 0;
            validMask = ((validMask << 2) & 0xFFFFFF) >>> 0;
          } else {
            shiftReg = ((shiftReg << 1) & 0xFFFFFF) >>> 0;
            validMask = ((validMask << 1) & 0xFFFFFF) >>> 0;
          }
          unitsRemaining--;
        }
      }
      this._paintSpriteSameLineWrapState(
        shiftReg, validMask, unitsRemaining, pixelPhase,
        pixelsPerUnit, isMulti, xExp, s, canvasY, wrapStartCanvasX
      );
    }
  },

  // Paint a sprite's wrap-over pixels on the SAME scanline, starting at
  // canvas X=8 (= raw X=0 + 8 offset). Used at end-of-line when a sprite
  // at high X has unconsumed units after the line wrap. Pixels route
  // through the standard collision/owner/visibility paths so closed
  // borders still gate paint and sprite-priority/inheritance still hold.
  //
  // Sprite color registers ($D025/$D026/$D027+s) and the priority bit
  // ($D01B) are sampled PER CYCLE during paint — not at the cycle the
  // wrap was scheduled (cycle 58). The wrap pixels paint at canvas X=8+
  // which corresponds to cycles 12..14 of the same line, so we look up
  // lineCycleRegs[cycle] for that cycle's snapshot. This matches real
  // hardware: a CPU mid-line write to $D026 (e.g., OrbitUntold's cyl45
  // rasterbar update) takes effect for inner-display sprites painted
  // AFTER the write, but the same write does NOT retroactively change
  // the wrap pixels at canvas X=8..21 (which paint with regs sampled at
  // their respective early cycles, BEFORE cyl45's write).
  _paintSpriteSameLineWrap(wrap, s, canvasY, startCanvasX = 0) {
    if (wrap.unitsRemaining <= 0) return;
    this._paintSpriteSameLineWrapState(
      wrap.shiftReg >>> 0, wrap.validMask >>> 0, wrap.unitsRemaining | 0,
      wrap.pixelPhase | 0, wrap.pixelsPerUnit | 0, !!wrap.isMulti,
      !!wrap.xExp, s, canvasY, startCanvasX
    );
  },

  _paintSpriteSameLineWrapState(
    shiftReg, validMask, unitsRemaining, pixelPhase,
    pixelsPerUnit, isMulti, xExp, s, canvasY, startCanvasX = 0
  ) {
    if (unitsRemaining <= 0) return;
    const regOffset = this._regOffset;
    // Wrap starts at startCanvasX (= max(0, sx - 504)). Canvas X=0..7
    // = cycle 11 (overscan-left), 8..15 = cycle 12, 16..23 = cycle 13,
    // etc.
    let cx = startCanvasX;
    while (cx < CANVAS_W && unitsRemaining > 0) {
      // Canvas X → cycle: cx=0..7→11, 8..15→12, 16..23→13, ...
      const cycle = (cx >> 3) + 11;
      const cycleRegs = this.lineCycleRegs[cycle + regOffset];
      const sprMcol0 = PALETTE_RGBA[cycleRegs[0x25] & 0x0F];
      const sprMcol1 = PALETTE_RGBA[cycleRegs[0x26] & 0x0F];
      const sprColor = PALETTE_RGBA[cycleRegs[0x27 + s] & 0x0F];
      const pri = (cycleRegs[0x1B] >> s) & 1;

      const info = this._spriteSequencerPixelInfo(
        shiftReg, validMask, isMulti,
        sprMcol0, sprMcol1, sprColor
      );
      if (info.draw) {
        this._processSpritePixelCollision(cx, canvasY, s);
        if (this._spriteVisibleAt(cx, canvasY)) {
          this._drawSpritePixel(cx, canvasY, info.color, s, pri);
        }
      }
      pixelPhase++;
      if (pixelPhase >= pixelsPerUnit) {
        pixelPhase = 0;
        if (isMulti) {
          shiftReg = ((shiftReg << 2) & 0xFFFFFF) >>> 0;
          validMask = ((validMask << 2) & 0xFFFFFF) >>> 0;
        } else {
          shiftReg = ((shiftReg << 1) & 0xFFFFFF) >>> 0;
          validMask = ((validMask << 1) & 0xFFFFFF) >>> 0;
        }
        unitsRemaining--;
      }
      cx++;
    }
  },

  // Bauer §3.8.1 rule 4 + VIC-Addendum.txt "sprite idle fetch": at the cycle-58
  // ($164) boundary every sprite shift register is re-triggered and emits the
  // VIC bus contents ("1 byte $ff, 1 byte contents of $3fff, 1 byte $ff").
  // For an ENABLED sprite whose 24px display window reaches that boundary,
  // this paints a trailing garbage block at canvas BGX. Two overlapping such
  // sprites (VICII/spritex demusinterruptus: sprites 0+1 both at X $14C) thus
  // collide on $D01E even though their real pixel data never overlaps.
  //
  // Conservative trigger (boundary must fall within the sprite's own display
  // window) keeps the blast radius to sprites parked in the right ~24px — the
  // reference demos don't place collidable content there. Sampled per-pixel
  // from lineCycleRegs (colour/priority/enable) like _paintSpriteSameLineWrap.
  _paintSpriteBoundaryGarbage(s, canvasY) {
    if (canvasY < 0) return;
    if (!this._spriteLineStarted[s]) return;        // sprite displayed this line
    const regOffset = this._regOffset;
    const BGX = this.constructor._SPRITE_BG_GARBAGE_RAW_X + 8;   // canvas X of the boundary
    const bcyc = (BGX >> 3) + 11;                    // boundary's cycle column
    const bregs = this.lineCycleRegs[bcyc + regOffset];
    if (((bregs[0x15] >> s) & 1) === 0) return;      // MxE must be set
    const isMulti = (bregs[0x1C] >> s) & 1;
    const xExp = (bregs[0x1D] >> s) & 1;
    const sx = (bregs[s * 2] | (((bregs[0x10] >> s) & 1) << 8)) + 8;
    const widthPx = xExp ? 48 : 24;
    // Garbage appears ONLY when the sprite's 24 real pixels end right at the
    // $163/$164 re-trigger boundary — i.e. the shifter has JUST emptied there
    // (Bauer §3.8.1 rule 4 + readme). A sprite extending past $164 still has
    // real data in its shifter at the re-trigger (no garbage); one ending well
    // before is already display-off. demusinterruptus places its sprites so
    // their real data ends exactly at raw $164 (X $14C + 24 = $164). This
    // EXCLUDES ordinary right-edge sprites that legitimately render into an
    // open right border (FppScroller s5 ends canvas 376-383; OrbitUntold s7
    // x-expanded ends 368-382 — the "dent in the right-column raster bar").
    const spriteEnd = sx + widthPx;
    if (!(spriteEnd >= BGX && spriteEnd <= BGX + 1)) return;

    // COLLISION-ONLY (no visible pixels). VICE-6569 verification (solid
    // single-colour sprite at X=$14C, side border open via sb_sprite_fetch
    // patched to $14C): VICE shows the 24 real px (canvas 340..363) and NOTHING
    // past the $164 boundary — no visible garbage block. Painting one was a
    // false positive ("an extra block to the right of the sprite"). But the
    // boundary re-trigger DOES feed the sprite-collision logic: demusinterruptus
    // (two sprites at $14C ending exactly at raw $164) relies on the overlapping
    // garbage colliding on $D01E — verified collision-driven (suppressing this
    // COLLISION breaks demus's VICE-match diff 539->40248px, while dropping only
    // the visible paint barely moves it, 539->546px). So run the sequencer to
    // drive _processSpritePixelCollision but never _drawSpritePixel.
    const garbageShift = ((0xFF << 16) >>> 0);
    const state = this._createSpriteRenderState(
      garbageShift, 0x01, BGX, BGX, !!isMulti, !!xExp
    );
    state.pixelsPerUnit = (isMulti ? 2 : 1) * (xExp ? 2 : 1);

    let cx = BGX;
    while (cx < CANVAS_W && state.unitsRemaining > 0) {
      const info = this._spriteSequencerPixelInfo(
        state.shiftReg, state.validMask, !!isMulti, 0, 0, 0
      );
      if (info.draw) {
        this._processSpritePixelCollision(cx, canvasY, s);
      }
      this._advanceSpriteSequencerState(state, !!isMulti, !!xExp);
      cx++;
    }
  },

  // Sprite-sprite ($D01E) collisions in the right border / off-canvas strip
  // (canvas [CANVAS_W, 504) = raw X $178..$1F7). spriteCollisionBuffer is
  // cropped to the 384px canvas, so collisions there were dropped — but real
  // 6569/VICE (and the spritescan/spritegap testprogs) detect sprite-sprite
  // collisions across the FULL 504px line incl. the right border. Continue
  // each displaying sprite's shifter from where the canvas render left it
  // (rs.currentX) through the strip, COLLISION-ONLY (no visible paint off
  // canvas; sprite-vs-BACKGROUND $D01F stays canvas-bound — no graphics live
  // in the border). Each sprite's own bit is masked so it can't self-collide.
  // Same `late` (phi2-half) tagging as the inline path.
  _offCanvasSpriteSpriteCollision(canvasY) {
    if (canvasY < 0) return;
    const START = CANVAS_W, END = 504, WIDTH = END - START;
    if (!this._offCanvasColl) this._offCanvasColl = new Uint8Array(WIDTH);
    const ov = this._offCanvasColl;
    ov.fill(0);
    const probe = this.lineCycleRegs[58 + this._regOffset] || this.lineCycleRegs[58];
    const probeDataRow = this.lineCycleSpriteDataRow[58 + this._regOffset] || this.lineCycleSpriteDataRow[58];
    for (let s = 0; s < 8; s++) {
      if (!this._spriteLineStarted[s]) continue;
      const rs = this._spriteLineRenderState[s];
      if (!rs || rs.unitsRemaining <= 0) continue;
      const isMulti = (probe[0x1C] >> s) & 1;
      const xExp = (probe[0x1D] >> s) & 1;
      const sx = this._spriteLineLeft[s] | 0;
      const finalRowTail = probeDataRow[s] < 0 && this._spriteLineLastDataRow[s] >= 0;
      const rawX = sx - 8;
      const bit = 1 << s;
      let shiftReg = rs.shiftReg >>> 0;
      let validMask = rs.validMask >>> 0;
      let unitsRemaining = rs.unitsRemaining | 0;
      let pixelPhase = rs.pixelPhase | 0;
      const pixelsPerUnit = (isMulti ? 2 : 1) * (xExp ? 2 : 1);
      let startPos = rs.currentX | 0;
      if (finalRowTail) {
        // VICII/spritegap3: after the cycle-58 display-boundary gap, old PAL
        // restarts sprite-sprite collision in the physical right border at a
        // sprite-slot-dependent X. The shifter is not advanced through the
        // gap; it begins again with the row's first bits at this restart.
        // The branch below is the gap itself: the canvas sequencer already
        // latched this row's collision, so it is erased here ($D01E + the
        // visibility pipes). Only reachable while units remain.
        const restartRawX = 0x16f + 0x10 * s;
        const boundaryRawX = 0x162 + (s === 0 ? 0 : 1);
        const lowerEnabled = (probe[0x15] & ((1 << s) - 1)) !== 0;
        if (!lowerEnabled &&
            (this._spriteLineLastShiftReg[s] === 0x400000 ||
             this._spriteLineLastShiftReg[s] === 0x800000) &&
            rawX >= boundaryRawX && rawX < restartRawX) {
          this.regs[0x1E] = 0;
          this._collPipeE[0] = 0; this._collPipeE[1] = 0;
          this._collLateE[0] = 0; this._collLateE[1] = 0;
          continue;
        }
        startPos = Math.max(sx, START, restartRawX + 8);
        shiftReg = this._spriteLineLastShiftReg[s] >>> 0;
        validMask = this._spriteValidMask(this._spriteLineLastRowByteMask[s]);
        unitsRemaining = isMulti ? 12 : 24;
        pixelPhase = 0;
      }
      // Walk from where the canvas render stopped; emit only within the strip.
      for (let pos = startPos; pos < END && unitsRemaining > 0; pos++) {
        if (pos >= START &&
            this._spriteSequencerPixelInfo(shiftReg, validMask, !!isMulti, 0, 0, 0).draw) {
          const i = pos - START;
          const others = ov[i] & ~bit;
          ov[i] |= bit;
          if (others) this._commitSpriteSpriteBits(bit | others, (pos & 4) !== 0);
        }
        pixelPhase++;
        if (pixelPhase >= pixelsPerUnit) {
          pixelPhase = 0;
          if (isMulti) {
            shiftReg = ((shiftReg << 2) & 0xFFFFFF) >>> 0;
            validMask = ((validMask << 2) & 0xFFFFFF) >>> 0;
          } else {
            shiftReg = ((shiftReg << 1) & 0xFFFFFF) >>> 0;
            validMask = ((validMask << 1) & 0xFFFFFF) >>> 0;
          }
          unitsRemaining--;
        }
      }
    }
  },

  // Backward-compat wrapper — equivalent to running the orchestrator's
  // sprite phase. Some legacy tests may call this directly.
  _renderSpriteLine(raster, canvasY) {
    const spriteSegments = this._buildCycleSpriteSegments();
    for (let s = 0; s < 8; s++) {
      for (let i = 0; i < spriteSegments.length; i++) {   // (A2) indexed, not for-of
        this._renderSpriteSegmentForSprite(spriteSegments[i], s, canvasY);
      }
    }
  },

  _spriteValidMask(rowByteMask) {
    let mask = 0;
    if (rowByteMask & 0x01) mask |= 0xFF0000;
    if (rowByteMask & 0x02) mask |= 0x00FF00;
    if (rowByteMask & 0x04) mask |= 0x0000FF;
    return mask >>> 0;
  },

  _spriteSequencerPixelInfo(shiftReg, validMask, isMulti, sprMcol0, sprMcol1, sprColor) {
    // Reuses _scratchSpritePixOut to avoid per-pixel allocations.
    // Callers (and tests) read `.draw` / `.color` synchronously before
    // the next call, so a singleton return is safe.
    const out = this._scratchSpritePixOut;
    if (!isMulti) {
      if ((validMask & 0x800000) === 0) {
        out.draw = false; out.color = 0;
        return out;
      }
      out.draw = !!(shiftReg & 0x800000);
      out.color = sprColor;
      return out;
    }
    if ((validMask & 0xC00000) !== 0xC00000) {
      out.draw = false; out.color = 0;
      return out;
    }
    const twoBit = (shiftReg >>> 22) & 0x03;
    if (twoBit === 0) {
      out.draw = false; out.color = 0;
      return out;
    }
    out.draw = true;
    out.color = twoBit === 1 ? sprMcol0 : (twoBit === 2 ? sprColor : sprMcol1);
    return out;
  },

  // Rent a render-state object from the per-line arena (fresh literal only
  // while the arena grows to its per-line peak). Callers receive a fully
  // (re)initialized object — no field survives from a previous renter.
  _rentSpriteRenderState() {
    const arena = this._spriteRsArena;
    if (this._spriteRsArenaIdx < arena.length) return arena[this._spriteRsArenaIdx++];
    const st = { shiftReg: 0, validMask: 0, unitsRemaining: 0, pixelPhase: 0, currentX: 0, pixelsPerUnit: 0 };
    arena.push(st);
    this._spriteRsArenaIdx++;
    return st;
  },

  _createSpriteRenderState(shiftReg, rowByteMask, spriteX, currentX = spriteX, isMulti = false, xExp = false) {
    const pixelsPerUnit = (isMulti ? 2 : 1) * (xExp ? 2 : 1);
    const totalUnits = isMulti ? 12 : 24;
    const consumedPixels = Math.max(0, currentX - spriteX);
    const consumedUnits = Math.min(totalUnits, Math.floor(consumedPixels / pixelsPerUnit));
    // Arena-rented, every field assigned (same set, same shape as the rent
    // literal and the snapshot _rsBuf objects). pixelsPerUnit is initialized
    // here — not lazily on the first _advanceSpriteSequencerState call — so
    // every _spriteLineRenderState[s] object has one stable shape and the
    // _renderSpriteSameLineHighX path never reads it as undefined.
    const st = this._rentSpriteRenderState();
    st.shiftReg = shiftReg >>> 0;
    st.validMask = this._spriteValidMask(rowByteMask);
    st.unitsRemaining = Math.max(0, totalUnits - consumedUnits);
    st.pixelPhase = consumedPixels % pixelsPerUnit;
    st.currentX = currentX;
    st.pixelsPerUnit = pixelsPerUnit;
    return st;
  },

  _advanceSpriteSequencerState(state, isMulti, xExp) {
    state.pixelPhase++;
    if (state.pixelPhase < state.pixelsPerUnit) return;
    state.pixelPhase = 0;
    if (isMulti) {
      state.shiftReg = ((state.shiftReg << 2) & 0xFFFFFF) >>> 0;
      state.validMask = ((state.validMask << 2) & 0xFFFFFF) >>> 0;
    } else {
      state.shiftReg = ((state.shiftReg << 1) & 0xFFFFFF) >>> 0;
      state.validMask = ((state.validMask << 1) & 0xFFFFFF) >>> 0;
    }
    state.unitsRemaining--;
  },

  _renderSpriteSegmentSequencer(seg, spriteIdx, canvasY, state, isMulti, xExp, sprMcol0, sprMcol1, sprColor, pri) {
    const pixelsPerUnit = (isMulti ? 2 : 1) * (xExp ? 2 : 1);
    state.pixelsPerUnit = pixelsPerUnit;
    const startX = Math.max(seg.start, state.currentX);
    const endX = Math.min(seg.end, CANVAS_W);
    if (endX <= startX) return;

    // Thread the sequencer state through locals for the hot per-pixel loop (this
    // is the single hottest render function). Reading/writing the shared `state`
    // object and the `_scratchSpritePixOut` return object per pixel is real heap
    // traffic — both are instance-owned singletons, so neither V8 nor JSC can
    // scalar-replace them. No per-pixel callee (_processSpritePixelCollision /
    // _spriteVisibleAt / _drawSpritePixel) reads `state`, and the snapshot/
    // restore paths only read it BETWEEN segments, so writing back once at the
    // end is byte-identical. (Same shape the same-line paint paths already use.)
    let shiftReg = state.shiftReg >>> 0;
    let validMask = state.validMask >>> 0;
    let pixelPhase = state.pixelPhase | 0;
    let unitsRemaining = state.unitsRemaining | 0;

    // Skip-to-startX: advance over the columns before this segment.
    for (let skipX = state.currentX; skipX < startX && unitsRemaining > 0; skipX++) {
      pixelPhase++;
      if (pixelPhase >= pixelsPerUnit) {
        pixelPhase = 0;
        if (isMulti) {
          shiftReg = ((shiftReg << 2) & 0xFFFFFF) >>> 0;
          validMask = ((validMask << 2) & 0xFFFFFF) >>> 0;
        } else {
          shiftReg = ((shiftReg << 1) & 0xFFFFFF) >>> 0;
          validMask = ((validMask << 1) & 0xFFFFFF) >>> 0;
        }
        unitsRemaining--;
      }
    }

    let cx = startX;
    for (; cx < endX && unitsRemaining > 0; cx++) {
      // Inlined _spriteSequencerPixelInfo (no _scratchSpritePixOut round-trip).
      let draw = false;
      let color = 0;
      if (!isMulti) {
        if ((validMask & 0x800000) !== 0) {
          draw = (shiftReg & 0x800000) !== 0;
          color = sprColor;
        }
      } else if ((validMask & 0xC00000) === 0xC00000) {
        const twoBit = (shiftReg >>> 22) & 0x03;
        if (twoBit !== 0) {
          draw = true;
          color = twoBit === 1 ? sprMcol0 : (twoBit === 2 ? sprColor : sprMcol1);
        }
      }
      if (draw) {
        this._processSpritePixelCollision(cx, canvasY, spriteIdx);
        if (this._spriteVisibleAt(cx, canvasY)) {
          this._drawSpritePixel(cx, canvasY, color, spriteIdx, pri);
        }
      }
      // Inlined _advanceSpriteSequencerState.
      pixelPhase++;
      if (pixelPhase >= pixelsPerUnit) {
        pixelPhase = 0;
        if (isMulti) {
          shiftReg = ((shiftReg << 2) & 0xFFFFFF) >>> 0;
          validMask = ((validMask << 2) & 0xFFFFFF) >>> 0;
        } else {
          shiftReg = ((shiftReg << 1) & 0xFFFFFF) >>> 0;
          validMask = ((validMask << 1) & 0xFFFFFF) >>> 0;
        }
        unitsRemaining--;
      }
    }

    // Write the threaded state back exactly once.
    state.shiftReg = shiftReg >>> 0;
    state.validMask = validMask >>> 0;
    state.pixelPhase = pixelPhase;
    state.unitsRemaining = unitsRemaining;
    state.currentX = cx;
  },

  _spriteVisibleAt(cx, cy) {
    // If the border buffer has a 0, the border is open, so sprites can be seen!
    // borderBuffer is line-sized (#1): indexed by canvas column cx.
    return this.borderBuffer[cx] === 0;
  },

  // cx = canvas column (0..CANVAS_W-1); the phi2-half flag is (cx & 4).
  _latchSpriteBackgroundCollision(cx, spriteIdx) {
    this._commitSpriteBgBits(1 << spriteIdx, (cx & 4) !== 0);
  },

  // Route detected sprite-bg bits to the register: immediately for the
  // batch path and direct callers, or into the 2-cycle visibility pipeline
  // during the cycle-incremental render (see _drainSpriteCollisionCommit).
  // `late` tags detections in the phi2-half (canvas X & 4) of their cycle.
  _commitSpriteBgBits(bits, late) {
    if (this._deferCollisionCommit) {
      this._collPipeF[1] |= bits;
      if (late) this._collLateF[1] |= bits;
      return;
    }
    this._applySpriteBgBits(bits);
  },

  _applySpriteBgBits(bits) {
    const before = this.regs[0x1F];
    if ((before | bits) === before) return;
    this.regs[0x1F] = before | bits;
    // Bauer §3.12: IMBC fires only on the 0→non-zero transition of $D01F.
    if (before !== 0) return;
    this.irqStatus |= 0x02;
    if (this.irqMask & 0x02) {
      this.irqStatus |= 0x80;
      this.irqHandler(true);
    }
  },

  // cx = canvas column (0..CANVAS_W-1); collision buffer is line-sized (#1).
  _latchSpriteSpriteCollision(cx, spriteIdx) {
    // Idempotent under repeated calls for the same (cx, spriteIdx).
    // The veto/re-render path can replay sprite-pixel emission for cycles
    // already painted; a naïve `existingSpr !== 0` check would see this
    // sprite's own previously-written bit and latch a self-collision.
    // Mask the writing sprite's bit out of the "other sprites" test so a
    // duplicate pass is a no-op. The collision BUFFER is written
    // immediately (inter-sprite detection needs it within the line); only
    // the CPU-visible $D01E register update is deferred.
    const bit = 1 << spriteIdx;
    const existingSpr = this.spriteCollisionBuffer[cx];
    const otherSprites = existingSpr & ~bit;
    this.spriteCollisionBuffer[cx] = existingSpr | bit;
    if (otherSprites !== 0) {
      this._commitSpriteSpriteBits(bit | otherSprites, (cx & 4) !== 0);
    }
  },

  // `late` tags detections in the phi2-half (canvas X & 4) of their cycle —
  // see _collLateE and the $D01E read path.
  _commitSpriteSpriteBits(bits, late) {
    if (this._deferCollisionCommit) {
      this._collPipeE[1] |= bits;
      if (late) this._collLateE[1] |= bits;
      return;
    }
    this._applySpriteSpriteBits(bits);
  },

  _applySpriteSpriteBits(bits) {
    const before = this.regs[0x1E];
    if ((before | bits) === before) return;
    this.regs[0x1E] = before | bits;
    // Bauer §3.12: IMMC fires only on the 0→non-zero transition of $D01E.
    if (before === 0) {
      this.irqStatus |= 0x04;
      if (this.irqMask & 0x04) {
        this.irqStatus |= 0x80;
        this.irqHandler(true);
      }
    }
  },

  // Advance the sprite-collision visibility pipeline by one cycle. Sprite
  // pixels (and their collision DETECTION into the per-pixel buffers + the
  // framebuffer) are painted as the beam passes the column, but the 6569
  // surfaces the collision to a CPU read of $D01E/$D01F ~2 cycles later.
  // Bits detected during a cycle's sprite render are committed to the
  // registers two cycles afterwards. Drained once per cycle by the
  // cycle-incremental dispatch, BEFORE the CPU step, so a mid-line read
  // sees spec-timed state — the value VICII/spritecollisions sprite-
  // {sprite,gfx}-collision-cycle.prg measures (flip after 2 positions).
  // The pipeline persists across raster lines (the registers are sticky
  // until a CPU read); _initRenderRasterLine must not clear it.
  _drainSpriteCollisionCommit() {
    // Fast path: when ALL eight pipeline slots are already zero the body below
    // is a genuine no-op (no apply, and every shift is 0→0), so skip the per-
    // cycle array writes. Runs every master cycle, so this is the common case on
    // collision-light content (hot even on near-spriteless demos otherwise).
    if ((this._collPipeE[0] | this._collPipeE[1] | this._collPipeF[0] | this._collPipeF[1]
       | this._collLateE[0] | this._collLateE[1] | this._collLateF[0] | this._collLateF[1]) === 0) return;
    if (this._collPipeE[0]) this._applySpriteSpriteBits(this._collPipeE[0]);
    if (this._collPipeF[0]) this._applySpriteBgBits(this._collPipeF[0]);
    this._collPipeE[0] = this._collPipeE[1]; this._collPipeE[1] = 0;
    this._collPipeF[0] = this._collPipeF[1]; this._collPipeF[1] = 0;
    this._collLateE[0] = this._collLateE[1]; this._collLateE[1] = 0;
    this._collLateF[0] = this._collLateF[1]; this._collLateF[1] = 0;
  },

  _processSpritePixelCollision(cx, cy, spriteIdx) {
    // Side buffers are line-sized (#1): index by canvas column cx.
    if (this.graphicsCollisionBuffer[cx] === 1) {
      this._latchSpriteBackgroundCollision(cx, spriteIdx);
    }
    this._latchSpriteSpriteCollision(cx, spriteIdx);
  },

  _drawSpritePixel(cx, cy, color, spriteIdx, sprPri) {
    const pIdx = cy * CANVAS_W + cx;   // full-screen index for fb32

    // Bauer §3.8.2 sprite-vs-sprite + inheritance: a lower-priority sprite
    // (higher index) cannot overwrite a pixel a higher-priority sprite has
    // already claimed — even when the higher-priority sprite was hidden
    // behind foreground. That's the inheritance effect: foreground pixels
    // overlapping a hidden higher-priority sprite stay visible against
    // any lower-priority sprite that overlaps the same pixel.
    if (this.spriteOwnerBuffer[cx] !== 0xFF) return;   // line buffers (#1)
    this.spriteOwnerBuffer[cx] = spriteIdx;

    // If this sprite is behind foreground, skip the visible overwrite —
    // but ownership is already claimed above so lower-priority sprites
    // are masked. Collision latches already saw the sequencer output.
    if (sprPri && this.graphicsPriorityBuffer[cx] === 1) return;
    this.spriteVisibleBuffer[cx] = 1;
    this.fb32[pIdx] = color;
  },
};
