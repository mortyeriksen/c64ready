// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/vic2.js – MOS 6569 VIC-II Video Interface Controller
// Implements: register bank, PAL raster counter, text mode renderer,
// multi-color text mode, extended background color, bitmap modes,
// hi-res bitmap, multicolor bitmap, sprites, smooth scrolling.
// Renders a 384×272 ImageData (full PAL visible area, border + active display).
//
// The chip is one class split across sibling files, each installing its
// method group onto VIC2.prototype (see the assembly note at the bottom):
//   vic2-tables.js  – shared constants, palettes, lookup tables
//   vic2-line.js    – raster-line state machine, bad lines, border unit
//   vic2-sprites.js – sprite DMA/sequencer, sprite render + collisions
//   vic2-render.js  – graphics (text/bitmap/idle) pixel rendering
// This file: chip state + constructor, clocking (clock/phi2), register
// bank ($D000-$D03F read/write), VIC bus fetches + banking, IRQ line,
// lightpen, frame trace, reset, and save-state.

import { switchOn } from './switches.js';
import {
  CANVAS_H, CANVAS_W, CYCLES_PER_LINE, GRAPHICS_WINDOW_END, GRAPHICS_WINDOW_START,
  LINES_PER_FRAME, VIC_VARIANT,
} from './vic2-tables.js';
import { lineOps } from './vic2-line.js';
import { spriteOps } from './vic2-sprites.js';
import { renderOps } from './vic2-render.js';

// Public façade — the palette / geometry / timing API lives in
// vic2-tables.js; re-export it so importers of vic2.js are unchanged.
export {
  PALETTES, PALETTE_NAMES, C64_PALETTE, setVicPalette, getVicPalette,
  CANVAS_W, CANVAS_H, VIC_VARIANT, VIC_VARIANTS,
  CYCLES_PER_LINE, LINES_PER_FRAME, CYCLES_PER_FRAME,
} from './vic2-tables.js';

export class VIC2 {
  constructor() {
    this.regs = new Uint8Array(0x40);
    this.regs[0x11] = 0x1B; // DEN=1, RSEL=1, YSCROLL=3
    this.regs[0x16] = 0xC8; // CSEL=1, XSCROLL=0
    this.regs[0x18] = 0x14; // screen=$0400, char=$1000
    this.regs[0x20] = 0x0E; // border = light blue
    this.regs[0x21] = 0x06; // bg = blue

    this.raster = 0;          // current raster line
    this.cycleInLine = 0;     // cycle position within raster line
    this.totalCycles = 0;
    // Set inside vic.clock for the single master cycle in which a
    // line-end transition happened (cycleInLine reset 63→0 + raster++).
    // Cleared at the start of the next master cycle. Used by
    // _cpuVisibleRaster() so $D011/$D012 reads in the immediately-
    // following CPU phi2 still see the OLD raster.
    this._lineJustEnded = false;

    // Opt-in: NMOS DDRA-bit-0→1 1-extra-cycle bank-change delay
    // (VIC-Addendum.txt, "Video bank and C64C"). When `nmosBankDelay` is
    // true and `vicVariant === '6569'`, a CIA2 DDRA write that turns
    // an input pin into an output (with PRA=0) defers the bank change
    // by one extra master cycle on top of the normal 1-cycle pipelined
    // visibility. Default OFF — VIC-Addendum.txt explicitly calls the
    // effect "unstable" / chip-variation, so modelling it can mismatch
    // hardware too.
    this.nmosBankDelay = false;

    // Opt-in: C64C / 8565 glue-logic glitch on PA0/PA1 10↔01
    // transitions — "will generate a glitch during 10 <-> 01 generating
    // 00 (in other words, bank 3) for one cycle" (VIC-Addendum.txt, "Video
    // bank and C64C"). When `c64cBankGlitch` is true and
    // `vicVariant === '8565'`, a bank-index transition between bank 1
    // ($4000) and bank 2 ($8000) inserts a 1-master-cycle blip through
    // bank 3 ($C000) regardless of which register (PRA or DDRA) drove
    // it. Default OFF — variant-specific, and most demos target 6569.
    this.c64cBankGlitch = false;

    this._pendingBankApplyCycle = -1;
    this._pendingBankValue = 0;

    // VIC chip variant. '6569' (NMOS, original PAL, breadbin C64) or
    // '8565' (HMOS-II, late C64C / C128 PAL). Per Bauer + the demo
    // author of nine.prg: 8565 has a 1-cycle additional delay in the
    // pixel pipeline, so a CPU register write that affects rendering
    // takes effect 1 cycle later on 8565 vs 6569. Demos that target
    // 8565 (or detect at runtime and pick the matching code branch)
    // expect this delay.
    this.vicVariant = VIC_VARIANT.V6569;

    // Open-bus profile flags.
    //  vicRefreshDrivesBus: r-access actually fetches and updates latches
    //    (otherwise refresh is address-only, the historical cheap model).
    //  spriteIdleFetchLeakEnabled: idle sprite fetch byte 2 samples
    //    vicInternalBus (VIC-Addendum.txt behavior). Off forces 0xFF.
    //  vicInternalBusCpuScope: which CPU bus events feed vicInternalBus.
    //    'vic-registers-only' (default — matches current code: only CPU
    //    accesses through vic.read/write at $D000-$D3FF update it).
    //    'all-cpu-bus' would also update on every CPU memory access; needs
    //    extra wiring in memory.js (not implemented yet — flag reserved).
    this.vicRefreshDrivesBus = true;
    this.spriteIdleFetchLeakEnabled = true;
    this.vicInternalBusCpuScope = 'vic-registers-only';

    // Sprite right-edge boundary garbage. Bauer §3.8.1 rule 4: the sprite
    // shifters are (re)triggered at sprite X-coordinate $164 (cycle 58, the
    // display turn-on point); per the VIC-Addendum.txt "sprite idle fetch", the
    // bus contents ($ff / contents of $3fff / $ff) are then emitted. For an
    // enabled sprite whose 24px display window reaches that boundary, this
    // appends a garbage block at raw X $163/$164 (canvas SPRITE_BG_GARBAGE_X)
    // which can collide with an overlapping sprite — the VICII/spritex
    // demusinterruptus.prg behaviour (VICE-6569 emits it). Default on for
    // VICE-6569 parity; gate-off available for bisection.
    this.spriteBoundaryGarbage = true;

    // Cycle-incremental rendering: when true, _renderRasterLine's work
    // is split across each cycle of the line as it executes, instead
    // of batched at end-of-line. This makes mid-line CPU reads of
    // $D01E / $D01F see cycle-accurate collision state (essential for
    // demos that poll collisions to detect VIC variant or pixel-
    // pipeline timing). Default ON.
    this._cycleIncrementalRender = true;
    this._cycleRenderActiveCanvasY = -1;

    // Tier-3 line-batch mode ('lineBatchRender' switch, Phase 1). When a
    // line is deferred, the per-cycle paints are skipped and the whole
    // line's segments are replayed in one burst through the SAME
    // incremental machinery (_catchUpDeferredLine) — at line end, or
    // immediately when the CPU observes render-derived state mid-line.
    // State capture (lineCycle* arrays), the collision-pipe drain, and all
    // FF/patch-up STATE mutations still run per cycle; only pixel emission
    // and the collision-pipe FEED are time-shifted. Lines with collision
    // IRQs armed (IMMC/IMBC, $D01A bits 1-2) or the frame trace active
    // render live.
    this.lineBatchRender = switchOn('lineBatchRender');
    this._lineDeferred = false;
    // Phase 2: coalesce the replay's graphics into wide spans (see
    // _catchUpDeferredLine). Internal A/B toggle, not a user switch —
    // false replays strictly cycle-by-cycle (the Phase-1 shape).
    this._replayCoalesce = true;

    // Batch-render optimisation. When true, _fixupColumns re-renders ONLY the
    // cycles whose +1/+2 mode (ECM/BMM/MCM) or c-2..c+3 background-colour
    // lookahead window actually changed, instead of re-rendering all 48 cycles
    // of the line twice. Byte-identical to the whole-line pass (same `needed`
    // gate; the per-cycle predicate is an exact superset of the cycles the
    // whole-line merge would touch). Proven byte-identical (orbit fb hash +
    // full spec suite + vic2-fixup-batch-equivalence-spec-test); kept as an
    // A/B gate.
    this.batchRender = true;

    // Capture-state snapshot dedup: when true, _captureCycleState aliases the
    // previous cycle's row/sprite snapshot buffers when the source is unchanged
    // (tracked by version counters) instead of re-copying 9 typed arrays every
    // visible cycle. Proven byte-identical (orbit fb hash across flag combos +
    // full spec suite + vic2-capture-dedup-equivalence-spec-test + a
    // captureDedupVerify soak across all reference demos); kept as an A/B gate.
    this.captureDedup = true;
    // Debug: when true, the alias branch also does a fresh copy into scratch and
    // asserts it equals the aliased buffer — turns "did we bump every writer?"
    // into a runtime check. Off in the hot path.
    this.captureDedupVerify = false;

    // Sprite idle-cycle skip: when true, _renderSpriteSegmentForSprite returns
    // early on cycles where a started sprite's state is steady and it neither
    // overlaps the current segment nor needs the end-of-line wrap — a provable
    // no-op (sprite shiftReg/rowByteMask only change at s-access cycles outside
    // the 12-58 display window). Also gates a never-started loop-level skip at
    // the clock() call site. Byte-identical (provable no-op under the gate);
    // kept as an A/B gate.
    this.spriteSkipIdle = true;

    // Cycle-58 bad-line sample phase. Bauer §3.7.2 rule 5's "first phase of
    // cycle 58" is phi1 — the VIC samples the bad-line condition BEFORE the
    // CPU's phi2 write of the SAME cycle (bumbershootsoft "VIC acts before CPU
    // on cycle 58"; see machine.js master-cycle ordering). A cycle-57 CPU write
    // is from the prior master cycle and is therefore already visible at phi1
    // (this is what the FLI demos / vic2-cycle58-live-badline-sampling test
    // need), but a cycle-58 write must NOT be. We capture the BL condition at
    // phi1 (in clock()) into _cycle58BadLineSample and feed it to the phi2
    // transition. Flag kept so the old phi2-live behaviour can be A/B'd.
    // Default true fixes raster_time_gp's periodic bottom-border garbage (a
    // jitter-frame per-line $D011 YSCROLL write lands at cy58 and otherwise
    // trips a spurious bad line).
    this.cycle58BadLinePhi1 = true;
    this._cycle58BadLineSample = false;

    this.irqStatus = 0;       // $D019
    this.irqMask = 0;       // $D01A

    // VIC-Addendum.txt: raster comparison is edge-triggered. The IRQ latches
    // on the rising edge of (raster == $D011.7:$D012). If $D012 is held
    // equal to raster (e.g. always-follow), the comparator output stays
    // continuously high — no rising edge — and no IRQ fires.
    //   _lastRasterMatch: comparator state captured at the last per-line
    //     sample (cycle 1, or cycle 2 of line 0).
    //   _rasterCompMidLineDip: a CPU write between samples changed the
    //     comparator state from match→no-match. The next match-at-sample
    //     therefore counts as a fresh rising edge even though the
    //     previous sample was already HIGH.
    this._lastRasterMatch = false;
    this._rasterCompMidLineDip = false;

    // Bauer §3.11: lightpen latches LPX/LPY on a NEGATIVE edge of the LP
    // input. Only one trigger is recognized per frame; subsequent edges
    // are ignored until the start of the next frame.
    //   _lpInputLevel: current level of the LP pin (0 = asserted/low, 1 = high)
    //   _lpLatchedThisFrame: true once a negative edge has fired this frame
    // The LP input is wired to CIA1 port B bit 4 in real hardware (also
    // joystick port 1 fire). The integrating layer in machine.js is
    // responsible for calling `setLightpenLevel` whenever that bit
    // changes; this VIC layer just observes the edge.
    this._lpInputLevel = 1;
    this._lpLatchedThisFrame = false;

    // Pre-allocated frame buffer (RGBA, 384×272)
    this.frameBuffer = new Uint8ClampedArray(CANVAS_W * CANVAS_H * 4);
    this.fb32 = new Uint32Array(this.frameBuffer.buffer); // fast 32-bit view
    // 8565 grey-dot bus artifact, same-value-write case (see write() /
    // _applyGreyDots). The snapshot-diff path in _firstPixelBgColor only
    // catches $D02x writes that CHANGE the value; a write of the SAME value
    // is invisible to the per-cycle register snapshots, so we mark its beam
    // pixel here at write time and overlay it at line-end. Per-line scratch.
    this._greyDotXs = new Int16Array(64);
    this._greyDotCount = 0;
    // Per-line latch: set by write() when a $D020 (border colour) write CHANGES
    // the value during the line. When it stays false across a whole line the
    // border colour is uniform, so the line-end _recolorBorderRow pass would
    // repaint every border pixel its existing colour — a provable no-op — and
    // the incremental path skips it. Same per-line lifecycle as _greyDotCount
    // (reset at cycleInLine 1). See _recolorBorderRow.
    this._d020WrittenThisLine = false;
    // Per-line side buffers. Each is read & written ONLY for the line
    // currently being rendered (cleared per line in _initRenderRasterLine,
    // never read across a line boundary), so a single CANVAS_W-wide line
    // buffer suffices — indexed by canvas column, not canvasY*CANVAS_W+x.
    // #2 merge: the graphics collision + priority buffers held bit-identical
    // data at every pixel, so they share ONE backing store. Both names alias
    // it (the collision-read site at _processSpritePixelCollision, the
    // priority-read site at _drawSpritePixel, and machine.js's debug snapshot
    // all keep working). The paired writes below thus target the same buffer.
    this.graphicsPriorityBuffer = new Uint8Array(CANVAS_W);  // foreground / collidable graphics pixels
    this.graphicsCollisionBuffer = this.graphicsPriorityBuffer; // alias — see above
    this.spriteCollisionBuffer = new Uint8Array(CANVAS_W); // tracks emitted sprite pixels for collision latches
    // Sprite-collision register ($D01E/$D01F) visibility pipeline. Sprite
    // pixels paint into the framebuffer + collision buffers as the beam
    // passes the column, but the 6569 makes the resulting collision
    // readable by the CPU only ~2 cycles later. We accumulate detected
    // register bits here during the cycle-incremental sprite render
    // (_deferCollisionCommit) and commit them two cycles afterwards in
    // _drainSpriteCollisionCommit. Each pipe is [due-now, detected-this-cycle].
    this._collPipeE = [0, 0];   // pending $D01E (sprite-sprite) bits
    this._collPipeF = [0, 0];   // pending $D01F (sprite-bg) bits
    // phi2-half subset of each pipe stage: bits whose detection pixel fell in
    // the second 4px (canvas X & 4) of its cycle. A collision-register read
    // clears the phi1-half but retains the phi2-half, so a back-to-back second
    // read still catches the read cycle's late-half pixels (VICII/spritevssprite).
    this._collLateE = [0, 0];
    this._collLateF = [0, 0];
    this._deferCollisionCommit = false;
    // Bauer §3.8.2: at each pixel only the highest-priority sprite (lowest
    // index) with an opaque pixel decides the sprite-vs-foreground outcome.
    // Lower-priority sprites are masked at any pixel a higher-priority
    // sprite has already claimed — that is also how the spec's "foreground
    // pixels inherit sprite priority" effect emerges (M0DP=1 hides sprite 0,
    // claims the pixel; M1DP=0 sprite 1 is then masked here, fg stays).
    // 0xFF = unclaimed.
    this.spriteOwnerBuffer = new Uint8Array(CANVAS_W);
    this.spriteOwnerBuffer.fill(0xFF);
    // Marks sprite pixels that actually reached the visible output. The owner
    // buffer also claims priority-hidden sprite pixels; the column fixup needs
    // this separate signal so visible sprites survive graphics-only retimes.
    this.spriteVisibleBuffer = new Uint8Array(CANVAS_W);
    this.borderBuffer = new Uint8Array(CANVAS_W);  // tracks pixels currently covered by border
    // Scratch single-row buffers for the end-of-line mid-line-mode-switch
    // fixup (_fixupColumns): the final row before the fixup,
    // the +2 graphics re-render, and that re-render's foreground map.
    this._fixupSavedRow = new Uint32Array(CANVAS_W);
    this._fixupGfx2Row = new Uint32Array(CANVAS_W);
    this._fixupGfx2FgRow = new Uint8Array(CANVAS_W);
    // Left-half (4px) save for the sub-column mode-split (_fixupModeSplitRightHalf):
    // a mid-line ECM/BMM/MCM flip takes effect on screen at the HALF-character
    // (4px) boundary, so the transition column shows the +2 mode in its left
    // half and the +3 mode in its right half. We render the right half with +3
    // and restore the left half from these scratch slots.
    this._fixupSplitL = new Uint32Array(8);
    this._fixupSplitLPri = new Uint8Array(8);
    this._fixupSplitLCol = new Uint8Array(8);
    this._fixupSplitLBor = new Uint8Array(8);
    this.imageData = null;    // created lazily by blit(), wrapping frameBuffer

    // References set by Machine. Initialised with empty placeholder arrays
    // so a clock() invocation before Machine wires the real backing stores
    // — e.g. unit tests that exercise the VIC in isolation, or the
    // narrow window between `new VIC2()` and the first machine.attach() —
    // doesn't NPE inside _fetchScreenRowColumn / _vicReadWithBank.
    this.ram = new Uint8Array(0x10000);
    this.colorRam = new Uint8Array(0x0400);
    this.charRom = new Uint8Array(0x1000);
    this.cia2 = null;     // for VIC bank

    // VIC internal data-bus latch — drives the "sprite idle fetch" leak
    // (the VIC-Addendum.txt). Updated on every VIC RAM/CHAR-ROM fetch and on
    // every CPU read/write to $D000-$D3FF. Cheap model only: real silicon
    // also reflects every CPU bus cycle (any RAM/IO/ROM access while AEC
    // is high), and matching that would require routing every CPU memory
    // cycle through here. Defaults to $FF when nothing has driven the bus.
    this.vicInternalBus = 0xFF;

    // Sized for a FULL-LINE span (40 columns × 8 px + xscroll spill): the
    // Tier-3 coalesced replay renders one wide segment across every column
    // whose captured state is uniform. (Was 24 — one segment's 3-column
    // worst case — which silently overflowed for wide spans.)
    this._spanPixels = new Int32Array(CANVAS_W);  // signed: holds PALETTE_RGBA values (Smi), compared to segBg0 per pixel
    this._spanFgMap = new Uint8Array(CANVAS_W);
    this.rowScreenCodes = new Uint8Array(40);
    this.rowColorNibbles = new Uint8Array(40);
    this.rowFetchedCols = new Uint8Array(40);
    this.rowVcBase = 0;
    this.lineMatrixFetchCol = -1;
    this.lineBadLineDisplayPending = false;
    this.lineBadLineStartCycle = -1;
    // Bauer §3.14.6 DMA-delay/VSP idle-byte glitch: lineCycleIdleByte index
    // whose idle g-access is sourced from the glitch address this line, or -1.
    // Latched on the bad-line rising edge (mid-line idle→display),
    // consumed by _captureCycleState. See testprogs/VICII/vsp-tester.
    this._vspGlitchGCycle = -1;
    this.lineBadLineInvalidCReadsPending = 0;
    this.lineBadLineInvalidCReadsActive = 0;
    // Line-local bad-line state, per the VIC-II bad-line rule.
    // _lineBadLineLatch is the LATCHED per-line bad-line flag (sticky
    // once set after the fetch cycle begins). _rcResetDoneThisLine
    // guards the once-per-line RC=0 side effect.
    // _prevBadLineCondition tracks the previous cycle's BL eval for
    // transition detection.
    this._lineBadLineLatch = false;
    this._rcResetDoneThisLine = false;
    this._prevBadLineCondition = false;
    // Seed the row-fetch line-invariants with canonical reset values so
    // the first frame's idle-mode raster band reads CSEL=1 / RSEL=1 / the
    // standard char-base. A 0-default leaves CSEL=0 (38-col) for any
    // segment that renders before the first bad-line fetch fires.
    this.rowFetchD011 = 0x1B;
    this.rowFetchD016 = 0xC8;
    this.rowFetchD018 = 0x14;
    this.lineCycleRegs = Array.from({ length: CYCLES_PER_LINE + 1 }, () => new Uint8Array(0x40));
    // Seed every per-cycle snapshot with the initial canonical register
    // file ($D011=$1B, $D016=$C8, $D018=$14, $D020=$0E, $D021=$06). Without
    // this, the very first frame after POWER ON renders some cycles using
    // an all-zero snapshot (CSEL=0 → 38-col mode), shifting the text by a
    // few pixels until each cycle's phi1 has populated its own snapshot.
    for (let i = 0; i <= CYCLES_PER_LINE; i++) this.lineCycleRegs[i].set(this.regs);
    this.lineCycleBanks = new Uint16Array(CYCLES_PER_LINE + 1);
    this.lineCycleDisplayEnabled = new Uint8Array(CYCLES_PER_LINE + 1);
    this.lineCycleDisplayActive = new Uint8Array(CYCLES_PER_LINE + 1);
    this.lineCycleDisplayPending = new Uint8Array(CYCLES_PER_LINE + 1);
    this.lineCycleDisplayColumnActive = new Uint8Array(CYCLES_PER_LINE + 1);
    this.lineCycleMatrixFetchActive = new Uint8Array(CYCLES_PER_LINE + 1);
    this.lineCycleAccessType = new Uint8Array(CYCLES_PER_LINE + 1);
    this.lineCycleTextAccessPhi1 = new Uint8Array(CYCLES_PER_LINE + 1);
    this.lineCycleTextAccessPhi2 = new Uint8Array(CYCLES_PER_LINE + 1);
    this.lineCycleSpriteBaLow = new Uint8Array(CYCLES_PER_LINE + 1);
    this.lineCycleSpriteAecLow = new Uint8Array(CYCLES_PER_LINE + 1);
    // Per-cycle unified external BA-low state (bad-line OR sprite source).
    // Populated every cycle in _captureCycleState (NOT gated on trace mode)
    // so the AEC c-3 lookback can read historical-rather-than-live state.
    // prevLine* holds the previous raster line's full window — needed for
    // c-3 lookbacks at cy 1..3 which wrap across the line boundary.
    this.lineCycleExternalBaLow = new Uint8Array(CYCLES_PER_LINE + 1);
    this.prevLineExternalBaLow = new Uint8Array(CYCLES_PER_LINE + 1);
    this.lineCycleVBorderBefore = new Uint8Array(CYCLES_PER_LINE + 1);
    this.lineCycleVBorder = new Uint8Array(CYCLES_PER_LINE + 1);
    this.lineCycleHBorderBefore = new Uint8Array(CYCLES_PER_LINE + 1);
    this.lineCycleHBorder = new Uint8Array(CYCLES_PER_LINE + 1);
    this.lineCycleHInner = new Uint8Array(CYCLES_PER_LINE + 1);
    // Per-cycle CSEL sample used by the raster segment splitter. The
    // border comparator itself is evaluated from the live $D016 state plus
    // the Bauer §3.14.1 exact-cycle veto rules below; this trace keeps
    // rendering splits aligned with the state captured for that cycle.
    this.lineCycleCselComparator = new Uint8Array(CYCLES_PER_LINE + 1);
    // Per-frame retained traces for snapshot()/debug. Indexed [raster][cycle].
    // Captured in clock() at end-of-line, after the renderer has consumed the
    // per-line buffers. Wrapped on raster=0.
    this.frameTraceHBorder = new Uint8Array(LINES_PER_FRAME * (CYCLES_PER_LINE + 1));
    this.frameTraceVBorder = new Uint8Array(LINES_PER_FRAME * (CYCLES_PER_LINE + 1));
    // Per-line scalar capture, end-of-line snapshot of key VIC state.
    this.frameTraceLineD011 = new Uint8Array(LINES_PER_FRAME);
    this.frameTraceLineD016 = new Uint8Array(LINES_PER_FRAME);
    this.frameTraceLineFlags = new Uint8Array(LINES_PER_FRAME); // bit0=badLine, bit1=displayActive
    // Per-line sprite state. We sample at cycle 30 (mid-display) to catch
    // values the demo just wrote in the IRQ handler for THIS line.
    this.frameTraceLineD015 = new Uint8Array(LINES_PER_FRAME); // enable mask
    this.frameTraceLineD01C = new Uint8Array(LINES_PER_FRAME); // multicolor mask
    this.frameTraceLineD01D = new Uint8Array(LINES_PER_FRAME); // X-expand mask
    this.frameTraceLineD017 = new Uint8Array(LINES_PER_FRAME); // Y-expand mask
    this.frameTraceLineD01B = new Uint8Array(LINES_PER_FRAME); // priority mask
    this.frameTraceLineD010 = new Uint8Array(LINES_PER_FRAME); // X-MSB mask
    this.frameTraceLineD021 = new Uint8Array(LINES_PER_FRAME); // bg color (per-line for color split)
    this.frameTraceLineD012 = new Uint8Array(LINES_PER_FRAME); // raster compare target
    this.frameTraceLineD019 = new Uint8Array(LINES_PER_FRAME); // IRQ status latch
    this.frameTraceLineD01A = new Uint8Array(LINES_PER_FRAME); // IRQ mask
    this.frameTraceLineD020 = new Uint8Array(LINES_PER_FRAME); // border color
    // Did D016 change vs the previous line? Each bit position useful: bit0=D016
    // changed, bit1=D011 changed, bit2=D015 changed, bit3=D018 changed.
    this.frameTraceLineRegChanges = new Uint8Array(LINES_PER_FRAME);
    this._frameTracePrevD016 = 0;
    this._frameTracePrevD011 = 0;
    this._frameTracePrevD015 = 0;
    this._frameTracePrevD018 = 0;
    // Per-line sprite pointer values — what the VIC actually fetched as
    // pointer for each of the 8 sprites on that line. Critical for sprite
    // multiplexers that re-use the same hardware sprite at different Y
    // positions with different shape pointers.
    this.frameTraceLineSpritePtrs = new Uint8Array(LINES_PER_FRAME * 8);
    // Per-line snapshot of sprite MC, MCBASE, and the Y-expand advance-line
    // flip-flop. Used to detect MC drift / Y-expand-FF state errors across
    // sprite multiplexer transitions (the most plausible cause of the
    // nine.prg "random wizard shape" symptom).
    this.frameTraceLineSpriteMC = new Uint8Array(LINES_PER_FRAME * 8);
    this.frameTraceLineSpriteMCBase = new Uint8Array(LINES_PER_FRAME * 8);
    this.frameTraceLineSpriteYExpFF = new Uint8Array(LINES_PER_FRAME); // bit s = sp s FF
    // Master gate for the per-line frame trace. Off by default — the trace
    // capture is ~30 typed-array writes per raster × 312 rasters = ~10K
    // writes per frame, which is measurable. Toggle from the JS console
    // (window.c64Trace.enable() / .disable()) only when collecting a snapshot.
    this.frameTraceEnabled = false;
    // Full-frame border/priority/owner debug maps. The live side buffers are
    // line-sized (#1); when tracing is on these accumulate each rendered line
    // into a CANVAS_W×CANVAS_H map so the machine snapshot can expose a whole-
    // frame view (the "garbage-in-side-border" workflow). Lazily allocated on
    // the first traced line → zero memory cost when tracing is off.
    this.frameTraceBorderMap = null;
    this.frameTracePriorityMap = null;
    this.frameTraceOwnerMap = null;
    // Counter for stale-row-data render warnings (Bauer §3.7.1 invariant).
    // Incremented in _renderSourceColumn when displayActive=false but
    // rowFetchedCols[col]=1. Inspect from JS console after a traced run.
    this._staleRowRenderHits = 0;
    // Per-CPU-write logs for raster-IRQ-relevant VIC registers. Used to
    // diagnose multiplexer IRQ-chain drift across two snapshots. Each entry:
    // { raster, cycleInLine, value, totalCycles }.
    //   $D012: raster compare target
    //   $D011: includes RST8 (raster compare bit 8) plus DEN/RSEL/ECM/BMM
    //          which the demo's IRQ handler typically touches at line 24
    //          and 251 for the border-open trick.
    //   $D01A: IRQ enable mask — useful to confirm the demo never disables
    //          raster IRQ between frames.
    // The public `frameTrace*Writes` arrays hold the most-recent completed
    // frame; the `_*WritesCurrent` shadows accumulate the in-progress frame
    // and are rotated into the public fields at raster wrap.
    this.frameTraceD012Writes = [];
    this._d012WritesCurrent = [];
    this.frameTraceD011Writes = [];
    this._d011WritesCurrent = [];
    this.frameTraceD01AWrites = [];
    this._d01AWritesCurrent = [];
    this.frameTraceD017Writes = [];
    this._d017WritesCurrent = [];
    this.frameTraceD018Writes = [];
    this._d018WritesCurrent = [];
    this.frameTraceD016Writes = [];
    this._d016WritesCurrent = [];
    // Each entry: {raster, cycleInLine, totalCycles}. Captured every time
    // the raster compare fires AND the IRQ mask permits assertion of the
    // CPU IRQ line. Lets us measure CPU response latency by subtracting
    // assertion cycle from D017 (or any other) write totalCycles.
    this.frameTraceIrqAssertions = [];
    this._irqAssertionsCurrent = [];
    // CPU-side counterpart: captured at the boundary where the CPU starts
    // vectoring an interrupt (the cycle of the first interrupt microop).
    // Entry: {kind: 'irq'|'nmi', raster, cycleInLine, totalCycles}.
    // (accept - assert) gives interrupt-acceptance latency.
    this.frameTraceIrqAccepts = [];
    this._irqAcceptsCurrent = [];
    // Per-line sprite XY: 8 sprites × 2 bytes = 16 bytes per line.
    this.frameTraceLineSpriteXY = new Uint8Array(LINES_PER_FRAME * 16);
    // Per-line sprite colors (D027..D02E): 8 bytes per line.
    this.frameTraceLineSpriteColors = new Uint8Array(LINES_PER_FRAME * 8);
    // Per-line VIC bank — captured because the bank can change mid-frame.
    this.frameTraceLineVicBank = new Uint16Array(LINES_PER_FRAME);
    // Per-line cycle-30 snapshot of which sprites have DMA on / display on.
    this.frameTraceLineSpriteDmaOn = new Uint8Array(LINES_PER_FRAME);
    this.frameTraceLineSpriteDisplayOn = new Uint8Array(LINES_PER_FRAME);
    this.lineCycleVc = new Uint16Array(CYCLES_PER_LINE + 1);
    this.lineCycleRc = new Uint8Array(CYCLES_PER_LINE + 1);
    this.lineCycleRowVcBase = new Uint16Array(CYCLES_PER_LINE + 1);
    // Per-cycle LIVE VC base (= VCBASE for this line). Used for the BITMAP
    // g-access address; equals rowVcBase except under the late-bad-line trick
    // where VCBASE advances with no c-access to refresh rowVcBase (Lunatico).
    this.lineCycleRowLiveVcBase = new Uint16Array(CYCLES_PER_LINE + 1);
    // Per-cycle c-access write column (the matrix/colour line-buffer index a
    // c-access stored into during this cycle, or -1 if no c-access ran). Used
    // by the renderer to map a display column back to the buffer position the
    // g-access actually displays: on real silicon the g-access at cycle K
    // outputs buffer[VMLI] and the c-access at cycle K wrote buffer[VMLI] —
    // one shared counter. Our buffer write is correct, but the display read
    // assumed buffer-index == screen-column, which only holds when VMLI tracks
    // the beam. On a LATE idle→display transition (FLI / line-crunch, Bauer
    // §3.14.6 colorfetchbug testprog) VMLI lags the beam by the idle gap, so
    // the freshly fetched columns must be read shifted. See _renderSourceColumn.
    this.lineCycleCWriteCol = new Int8Array(CYCLES_PER_LINE + 1).fill(-1);
    this.lineCycleRowFetchedCols = Array.from({ length: CYCLES_PER_LINE + 1 }, () => new Uint8Array(40));
    this.lineCycleRowCodes = Array.from({ length: CYCLES_PER_LINE + 1 }, () => new Uint8Array(40));
    this.lineCycleRowColors = Array.from({ length: CYCLES_PER_LINE + 1 }, () => new Uint8Array(40));
    this.lineCycleIdleByte = new Uint8Array(CYCLES_PER_LINE + 1);
    // rowFetchD011/D016/D018 are line-invariants — set once at bad-line
    // fetch begin (`_beginFetchedRowFromVcBase`) and read until the next
    // bad-line fetch. The renderer reads the scalar via `seg.rowFetchD0xx`
    // populated in `_buildCycleSegments`. Storing one per cycle was 3
    // typed-array writes per master cycle (~120 KB/s of redundant copy).
    this.lineCycleSpriteDisplayOn = Array.from({ length: CYCLES_PER_LINE + 1 }, () => new Uint8Array(8));
    this.lineCycleSpriteDataRow = Array.from({ length: CYCLES_PER_LINE + 1 }, () => new Int8Array(8));
    this.lineCycleSpriteDataBase = Array.from({ length: CYCLES_PER_LINE + 1 }, () => new Uint16Array(8));
    this.lineCycleSpriteDataBank = Array.from({ length: CYCLES_PER_LINE + 1 }, () => new Uint16Array(8));
    this.lineCycleSpritePointerValue = Array.from({ length: CYCLES_PER_LINE + 1 }, () => new Uint8Array(8));
    // lineCycleSpriteRowData is preserved (some tests populate it) but is
    // no longer captured per cycle by the runtime — the renderer never
    // reads seg.spriteRowData (only seg.spriteShiftReg, which IS captured
    // below). Skipping the capture drops the 8-iteration .set() loop from
    // the per-cycle hot path. The live `this.spriteRowData` is still
    // used by _updateSpriteShiftReg.
    this.lineCycleSpriteRowData = Array.from({ length: CYCLES_PER_LINE + 1 }, () => Array.from({ length: 8 }, () => new Uint8Array(3)));
    this.lineCycleSpriteRowByteMask = Array.from({ length: CYCLES_PER_LINE + 1 }, () => new Uint8Array(8));
    this.lineCycleSpriteShiftReg = Array.from({ length: CYCLES_PER_LINE + 1 }, () => new Uint32Array(8));

    // Capture-state snapshot dedup (gated by `captureDedup`, see _captureCycleState).
    // The row + sprite source arrays change only at discrete events within a
    // line, so most cycles re-copy identical bytes. When the source is unchanged
    // since the last captured cycle we ALIAS the previous snapshot buffer instead
    // of copying. To alias safely the slot pointer (lineCycle*[c], what consumers
    // read) is decoupled from the owned write buffer: _home*[c] keeps the
    // originally-allocated buffer so a dirty cycle always writes into its OWN
    // buffer (never one an earlier cycle of the same line still references).
    this._homeRowFetchedCols = this.lineCycleRowFetchedCols.slice();
    this._homeRowCodes = this.lineCycleRowCodes.slice();
    this._homeRowColors = this.lineCycleRowColors.slice();
    this._homeSpriteDisplayOn = this.lineCycleSpriteDisplayOn.slice();
    this._homeSpriteDataRow = this.lineCycleSpriteDataRow.slice();
    this._homeSpriteDataBase = this.lineCycleSpriteDataBase.slice();
    this._homeSpriteDataBank = this.lineCycleSpriteDataBank.slice();
    this._homeSpritePointerValue = this.lineCycleSpritePointerValue.slice();
    this._homeSpriteRowByteMask = this.lineCycleSpriteRowByteMask.slice();
    this._homeSpriteShiftReg = this.lineCycleSpriteShiftReg.slice();
    this._homeRegs = this.lineCycleRegs.slice();   // (B2) reg-snapshot home buffers
    // Monotonic version counters bumped at every row/sprite source-array writer;
    // a cycle whose version matches the last captured cycle's is byte-identical.
    this._rowSnapVersion = 0;
    this._sprSnapVersion = 0;
    this._regSnapVersion = 0;        // (B2) bumped on every CPU register write
    this._rowSnapLastVer = -1;
    this._sprSnapLastVer = -1;
    this._regSnapLastVer = -1;
    this._regSnapRef = null;
    this._rowFetchedRef = null; this._rowCodesRef = null; this._rowColorsRef = null;
    this._sprDisplayOnRef = null; this._sprDataRowRef = null; this._sprDataBaseRef = null;
    this._sprDataBankRef = null; this._sprPointerRef = null; this._sprByteMaskRef = null;
    this._sprShiftRef = null;

    this.spritePointerValue = new Uint8Array(8);
    this.spritePointerFresh = new Uint8Array(8);
    // Set when a sprite's s-access this line was an IDLE fetch (DMA off) that
    // loaded the "ghost"/bus bytes into the buffer. The X>=$164 same-line
    // display path (_tryStartSpriteDma) preserves those bytes through the cy55
    // DMA-start instead of clearing them — testprogs/VICII/sb_sprite_fetch.
    // Reset at line start.
    this._spriteIdleFetchedThisLine = new Uint8Array(8);
    // Set at DMA-start when a sprite turns DMA on too late (cy56) for BA/AEC
    // to have stalled the CPU before its byte-0 data fetch — that first byte
    // then comes off the floating data bus ($FF) instead of RAM. One-shot,
    // consumed by the next s-access. testprogs/VICII/spriteenable core2.
    this._spriteByte0Floats = new Uint8Array(8);
    // Per-line sprite render state — persists across cycle segments so
    // a cycle-incremental render can resume the shifter at exactly the
    // X position where the previous cycle's segment left off. Initialized
    // by _initRenderRasterLine, consumed by _renderCycleSegmentSprites.
    this._spriteLineRenderState = new Array(8).fill(null);
    this._spriteLineStarted = new Uint8Array(8);
    this._spriteLinePrevSegDisplayOn = new Uint8Array(8);
    this._spriteLineLastShiftReg = new Uint32Array(8);
    this._spriteLineLastRowByteMask = new Uint8Array(8);
    this._spriteLineLastDataRow = new Int8Array(8);
    this._spriteLineLeft = new Int16Array(8);
    // Pending end-of-line X-wrap tail per sprite. Flattened to parallel typed
    // arrays (was an 8-slot array of {…8 fields} object literals, allocated per
    // wrap event on the hottest sprite path — ~20 KiB/frame of nursery churn on
    // orbit that JSC does not elide). _spriteLinePendingWrapValid[s] = 1 marks a
    // live pending wrap (replaces the null slot). Do NOT pool an object here —
    // a pooled scratch object measures slower than the flat array.
    this._spriteLinePendingWrapValid = new Uint8Array(8);
    this._spriteLinePendingWrapShiftReg = new Uint32Array(8);
    this._spriteLinePendingWrapValidMask = new Uint32Array(8);
    this._spriteLinePendingWrapUnitsRemaining = new Int32Array(8);
    this._spriteLinePendingWrapPixelPhase = new Int32Array(8);
    this._spriteLinePendingWrapPixelsPerUnit = new Int32Array(8);
    this._spriteLinePendingWrapIsMulti = new Uint8Array(8);
    this._spriteLinePendingWrapXExp = new Uint8Array(8);
    this._spriteLinePendingWrapStartCanvasX = new Int32Array(8);
    // Bauer §3.8.1 pre-canvas sweep: the X counter passes raw X $1A0..$1F7
    // (canvas 424..511) during cycles 1..11, BEFORE canvas X=0. A sprite whose
    // render state is created at line start with X in that zone has already
    // been matched by the comparator this line, so a later mid-line rewrite to
    // a lower X is rule-6 beam-passed and must NOT reposition it (The Hat "13
    // sprites scroller": s1 parked at raw $1E8, $D010-cleared to $E8 at cy16).
    // Raw $1F8..$1FF (canvas 512+) never matches at all and stays movable.
    this._spriteLineSweptPreCanvas = new Uint8Array(8);
    // Sprite-line snapshots are now stored per-pending-record on the
    // _pendingFFTransitions queue (see _captureSpriteLineSnapshot /
    // _restoreSpriteLineSnapshot). No singleton slot needed.
    // Sprite-X same-cycle-write fixup (Bauer §3.6.1/§3.8.1): a $D00x write at
    // phi2 of the sprite render's machine cycle catches that cycle's phi2-half
    // X-comparison. _spriteXWriteThisCycle is set in write(); _spritePreSegSnap
    // holds the pre-render sprite state of the just-rendered segment so phi2()
    // can re-render it with the corrected X. See _applySpriteXSameCycleFixup.
    this._spriteXWriteThisCycle = false;
    this._spritePreSegSnap = null;
    // Pooled buffer for the per-cycle render slot: refilled (no allocation)
    // every sprite-active cycle by _fillSpriteLineSnapshot. Overwritten each
    // cycle and consumed only by the SAME cycle's phi2 _applySpriteXSameCycleFixup,
    // so a single reusable buffer is sufficient (and never aliases the
    // freshly-allocated FF-queue snapshots).
    this._spritePreSegSnapBuf = this._allocSpriteLineSnapshot();
    this._spritePreSegCycle = -1;
    this.spriteRowData = Array.from({ length: 8 }, () => new Uint8Array(3));
    this.spriteRowByteMask = new Uint8Array(8);
    this.spriteShiftReg = new Uint32Array(8);
    // Per-sprite p-cycle phi2 bus snapshot. The VIC-Addendum.txt
    // "Sprite idle fetch" rule: an idle fetch shows whatever is on the
    // VIC-II internal bus, or $FF if no access. We realize that as 3
    // halfcycles (DMA off) — byte 0 = p-cycle phi2 bus,
    // byte 1 = $3FFF ghost-byte idle access, byte 2 = s-cycle phi2 bus.
    // We record byte 0 at p-cycle phi2, then consume it at s-cycle phi2.
    // Default $FF matches the "no access" pull-up.
    this._spritePCyclePhi2Bus = new Uint8Array(8).fill(0xFF);
    this._spritePCyclePhi2BusValid = new Uint8Array(8);
    // Ghost byte ($3FFF) read at s-cycle phi1 — captured at the moment
    // the VIC owns the bus, BEFORE CPU's phi2 has had a chance to flip
    // VIC banks via $DD00. Holding it here avoids bank-skew if the demo
    // writes $DD00 at s-cycle phi2.
    this._spriteSCyclePhi1Ghost = new Uint8Array(8).fill(0xFF);
    this._spriteSCyclePhi1GhostValid = new Uint8Array(8);
    this.spriteDataBase = new Uint16Array(8);
    this.spriteDataBank = new Uint16Array(8);
    this.spriteDmaOn = new Uint8Array(8);
    this.spriteDisplayOn = new Uint8Array(8);
    this.spriteStartPending = new Uint8Array(8);
    this.spriteStopPending = new Uint8Array(8);
    this.spriteMC = new Uint8Array(8);
    this.spriteMCBase = new Uint8Array(8);
    this.spriteYExpandFF = new Uint8Array(8);
    // §3.8.1 rule 7a: when the CPU clears an MxYE bit during cycle 15 with
    // the corresponding FF unset, the FF is force-set and at the next
    // cycle 16 MCBASE is computed from the special sprite-crunch formula
    // instead of MCBASE := MC. This per-sprite latch carries that signal
    // from the $D017 write hook to _spriteSequencerCycle16.
    this._spriteCrunchPending = new Uint8Array(8);
    // Snapshot of $D017 captured during cycle 56 phi1 — phi2() compares
    // against the live mask and applies a delta toggle if CPU phi2 wrote.
    this._c56MxYESnapshot = 0;
    this.spriteLineDataRow = new Int8Array(8);
    this.lastSpriteEndRaster = new Int16Array(8).fill(-1);
    this.lastSpriteEndPtr = new Uint8Array(8);
    this.lastSpriteEndRow = new Int8Array(8).fill(-1);
    this.lastSpriteEndShiftReg = new Uint32Array(8);
    this.lastSpriteEndMask = new Uint8Array(8);
    this.vBorderActive = true;
    // Latched companion of the vertical border FF (Bauer §3.9). The bottom
    // compare arms this pending value; it copies into the live `vBorderActive`
    // at cycle 1 of each line. The top compare clears both at once. Models the
    // real chip's two-stage set/latch so a mid-line RSEL/DEN flip across a
    // compare line is honored (cross-checked against denrsel-s* on hardware).
    this._vBorderLatch = true;
    this.hBorderActive = true;
    // Previous-cycle CSEL sample retained for render segmentation and debug
    // traces. It is not the authority for the Bauer §3.9 comparator rules.
    this._cselComparator = 1;
    this._lastCselChangeRaster = -1;
    this._lastCselChangeCycle = -1;
    this._lastCselChangeFrom = 1;
    this._lastCselChangeTo = 1;
    // Bauer §3.14.1 hyperscreen veto: the right-edge SET pulse from the
    // comparator is held in a pre-FF latch for 1-2 cycles before it
    // commits to the main border FF. A CPU write to $D016 within that
    // window that changes CSEL such that the new right-compare value
    // lies outside the original detect cycle's segment retroactively
    // cancels the SET (the comparator output is re-evaluated and the
    // pulse is discarded). Symmetric for left-edge RESET.
    //
    // Unified pending FF-transition queue for the MAIN (horizontal) border FF.
    // Each entry: {kind, detectCycle, raster, latchCycle, ...kindSpecificFields}
    // where kind is one of:
    //   'hRightSet'    — Bauer §3.9 rule 1 (right comparator → main FF SET)
    //   'hLeftReset'   — Bauer §3.9 rule 6 (left comparator + !vBorder → main FF RESET)
    // (The VERTICAL border FF — Bauer §3.9 rules 2-5 — is not queued here; it
    // is advanced every cycle in `_advanceVerticalBorderFlipFlop` as a two-stage
    // set/latch, so there is no detect/veto window for it.)
    // Evaluated at phi1 of latchCycle in `_evaluatePendingTransitions` —
    // re-checks the trick condition against LIVE regs (which reflect any
    // CPU phi2 writes within the latch window). On invalidation, calls
    // `_vetoFFTransition` to rewind FF state and re-render affected cycles.
    this._pendingFFTransitions = [];
    // Live length of _pendingFFTransitions. We compact within a stable-capacity
    // array via this counter instead of `q.length = w`, so the backing store
    // never shrinks-to-0 and reallocates on the next push — that oscillation was
    // the single biggest idle allocation (see _evaluatePendingTransitions).
    this._ffCount = 0;
    // Free-list of pooled transition-entry objects. The border FF pushes ~2
    // entries per raster line (right SET + left RESET, ~500/frame); each was a
    // fresh object literal — pure GC churn (invisible on desktop V8, real on
    // mobile JSC). Entries latch + drain within ~3 cycles, so a small pool
    // recycles them; see _rentFFEntry / _evaluatePendingTransitions.
    this._ffFree = [];
    // (2a) Free-list of sprite-line snapshot objects reused by the FF-transition
    // queue. FPP/border demos push ~1 transition per raster line (312/frame),
    // each of which captured a freshly-allocated snapshot (~16 objects) — pure
    // GC pressure. Snapshots are short-lived (dropped when the transition
    // latches) and are NOT serialized, so reusing them is byte-identical and
    // save-state-safe.
    this._spriteSnapPool = [];
    // Pre-built _fixupColumns helpers, created ONCE here instead of as arrow
    // closures inside _fixupColumns — those allocated ~2-3 closures every raster
    // line even when the `needed` gate bailed early. Aliased in _fixupColumns
    // via `const at = this._fixupAt` etc. so the call sites stay unchanged.
    this._fixupAt = (c) => this.lineCycleRegs[c <= CYCLES_PER_LINE ? c : CYCLES_PER_LINE];
    this._fixupShowsBg = (c) => {
      const openBg = !this.lineCycleVBorder[c] && !this.lineCycleHBorder[c];
      return this.lineCycleDisplayColumnActive[c] ||
        (openBg && !this.lineCycleHInner[c]) ||
        (c >= 18 && openBg && this.lineCycleHInner[c]);
    };
    this._fixupBgTargetCycle = (c) => c + 3;
    this._fixupBgPrevCycle = (c) => c + 2;
    this._fixupSpriteHiddenBySpecFg = (pIdx, x) => {
      if (!this.spriteVisibleBuffer[x] || !this._fixupGfx2FgRow[x]) return false;
      const owner = this.spriteOwnerBuffer[x];
      if (owner === 0xFF) return false;
      const cycle = Math.min((x >> 3) + 11, CYCLES_PER_LINE);
      return ((this.lineCycleRegs[cycle][0x1B] >> owner) & 1) !== 0;
    };
    // Per-line arena of sprite render-state objects (see _createSpriteRenderState).
    // States never outlive their raster line — _initRenderRasterLine nulls every
    // _spriteLineRenderState slot AND resets the arena index together, so renting
    // wholesale each line is alias-safe. Grows once to the per-line peak
    // (8 slots + a few transient sequencer states), then allocates nothing.
    this._spriteRsArena = [];
    this._spriteRsArenaIdx = 0;
    this.currentVicBank = 0;
    this.displayEnabled = false;
    this.displayActive = false;
    this.vc = 0;
    this.vcBase = 0;
    this.vmli = 0;
    this.rc = 0;
    this.refreshCounter = 0xFF;
    this.lastRefreshAddr = 0x3FFF;
    this.lineIdleByte = 0x00;
    // Line-start $D011 snapshot (sampled at cy 1 by _beginRasterLine).
    // _isDisplayColumnPhase + _advanceDisplayStateLineEnd consult this to
    // detect "RSEL-only mid-line flip" — Bauer §3.9 has the border-FF
    // re-evaluate ONLY at cy 63, so a RSEL flip alone within a line in
    // flight should NOT retro-suppress matrix fetch (nine.prg's r249
    // ghost-byte trick at cy 39). But if BMM/ECM/MCM also changed
    // (raster_time_gp's r250 cy 19 bitmap→text mid-line flip), the demo
    // IS intentionally cutting the line; we honor the live bottom-compare
    // to keep that visual.
    this._lineStartD011 = 0x1B;
    // PREVIOUS line's start $D011. Used by _beginTextStateCycle1 which
    // fires at cy 1 of a new line *after* _beginRasterLine has already
    // overwritten _lineStartD011 with the new line's value. The cy 1
    // defensive clear must consult the PRIOR line's RSEL to detect the
    // same mid-line-flip pattern.
    this._prevLineStartD011 = 0x1B;
    this.baLow = false;
    this.aecLow = false;
    this.spriteBaLowOnly = false;

    // Reusable scratch segment objects — _buildCycleRasterSegment and
    // _buildCycleSpriteSegment populate these in place each call instead
    // of allocating a fresh literal per cycle. The cycle-incremental
    // dispatch path consumes them immediately and never holds a
    // reference across calls. Tests using these methods read fields
    // synchronously, so reuse is safe.
    this._scratchRasterSeg = this._makeEmptyRasterSeg();
    this._scratchSpriteSeg = this._makeEmptySpriteSeg();
    // Two scratch parts for _splitRasterSegmentAtBorderEdges (max 2 splits
    // ever) plus a fixed-length array. _splitParts.length is set to 1 or 2
    // per call; the caller iterates parts[0..length-1]. The parts share
    // the same shape as a raster seg so the renderer reads them
    // identically.
    this._splitPartA = this._makeEmptyRasterSeg();
    this._splitPartB = this._makeEmptyRasterSeg();
    this._splitParts = [this._splitPartA, this._splitPartB];
    // Scratch return objects for {row,line} / {code,color} / {draw,color}
    // — kill per-pixel and per-column allocations in the render hot path.
    this._scratchCharCell = { row: 0, line: 0 };
    this._scratchMatrixCell = { code: 0, color: 0 };
    this._scratchSpritePixOut = { draw: false, color: 0 };

    this.irqHandler = (state) => { };
  }

  // Build a zeroed raster seg with all fields the renderer reads. Used
  // both as the per-build scratch and the two split-parts. Keeping the
  // shape consistent lets V8 share the hidden class.
  _makeEmptyRasterSeg() {
    return {
      start: 0, end: 0, regs: null, bank: 0,
      displayEnabled: false, displayActive: false, displayPending: false,
      displayColumnActive: false, matrixFetchActive: false,
      vBorderBefore: false, vBorder: false,
      hBorderBefore: false, hBorder: false,
      cselComparator: 0, hInner: false,
      vc: 0, rc: 0, cycle: 0, cycleStart: 0,
      prevRegs: null, nextRegs: null, modeRegs: null, xscrollRegs: null,
      // Border-timed background-colour snapshot. NULL on the incremental
      // render path (→ bg colours read live seg.regs/prevRegs, unchanged);
      // SET only by the end-of-line _fixupColumns pass, which can look up
      // the +3/+2 register cycles once all lineCycleRegs are captured.
      bgRegs: null, bgPrevRegs: null,
      rowVcBase: 0, liveVcBase: 0, rowFetchedCols: null, rowCodes: null, rowColors: null,
      idleByte: 0, idleBytePrev: 0,
      rowFetchD011: 0, rowFetchD016: 0, rowFetchD018: 0,
    };
  }

  _makeEmptySpriteSeg() {
    return {
      start: 0, end: 0, regs: null, bank: 0,
      spriteDisplayOn: null, spriteDataRow: null, spriteDataBase: null,
      spriteDataBank: null, spritePointerValue: null,
      spriteRowByteMask: null, spriteShiftReg: null,
    };
  }

  get irqPending() {
    return (this.irqStatus & this.irqMask & 0x0F) !== 0;
  }

  // vicVariant is a string ('6569' / '8565'); the 8565's 1-cycle register
  // pipeline delay maps to regOffset = -1, sampled per cycle by the segment
  // builders. Cache that as a number via this setter so the hot path reads
  // this._regOffset instead of doing a string compare on every build call.
  get vicVariant() { return this._vicVariant; }
  set vicVariant(v) {
    this._vicVariant = v;
    // Cache variant predicates as primitives so the per-cycle / per-sprite hot
    // paths test a boolean instead of doing a string compare every call.
    this._is8565 = (v === VIC_VARIANT.V8565);
    this._regOffset = this._is8565 ? -1 : 0;
    // §3.14.6 DMA-delay/VSP idle-byte glitch source address. On 6569
    // the trigger-cycle idle g-access reads $38FF; on 8565/8566 it reads
    // $3807 (testprogs/VICII/vsp-tester readme; both addresses are among the
    // values the tester accepts as a pass).
    this._vspIdleGlitchAddr = this._is8565 ? 0x3807 : 0x38FF;
  }

  // Advance VIC-II by n cycles, returning the number of cycles where AEC stayed low.
  clock(cycles) {
    let stolen = 0;

    for (let i = 0; i < cycles; i++) {
      this.totalCycles++;
      // Clear _lineJustEnded at the start of each master cycle. The flag
      // is a one-shot set during the line-end vic.clock processing below
      // (cycleInLine 63→0 + raster++) and read by CPU phi2 _cpu*Write()
      // / _cpuVisibleRaster compensation in the SAME master cycle. In
      // machine.js, vic.phi2() also clears it after CPU phi2. In synthetic
      // harnesses that drive only vic.clock(), clearing here is the only
      // place that prevents the flag from persisting across many cycles.
      this._lineJustEnded = false;
      this.cycleInLine++;

      // VIC internal data-bus latch (sprite-idle-fetch source) resets at
      // the START of each master cycle to $FF. VIC bus fetches and CPU
      // $D000-$D3FF accesses during this cycle drive it; the sprite
      // idle-fetch sample point is in vic.phi2() — i.e. AFTER cpu.clock()
      // — so a same-cycle CPU write to $D0xx feeds the leak before the
      // next cycle's reset wipes it. Renderer reads use _vicMemRead and
      // do NOT drive this latch (the bus is for chip-bus actors, not for
      // emulator-side g-byte re-reads).
      this.vicInternalBus = 0xFF;
      this._thisCycleInLine = this.cycleInLine;

      // Apply any deferred VIC-bank change whose target cycle has been
      // reached. This is the NMOS DDRA-bit-set delay (gated by
      // `nmosBankDelay` in noteBankChange itself); the apply happens
      // BEFORE any VIC fetches this cycle so the new bank is visible
      // to matrix / sprite p+s accesses.
      if (this._pendingBankApplyCycle >= 0 && this.totalCycles >= this._pendingBankApplyCycle) {
        this.currentVicBank = this._pendingBankValue;
        this._pendingBankApplyCycle = -1;
      }

      // Bad-line enable latch: DEN only has to be set for one cycle somewhere
      // in raster line $30 to enable bad lines for the frame.
      if (this.raster === 0x30) {
        if (this.cycleInLine === 1) this.displayEnabled = false;
        if (this.regs[0x11] & 0x10) this.displayEnabled = true;
      }

      // Cycle 1: per-line setup. Raster compare normally fires here,
      // except for raster line 0 where it is delayed by one cycle (Bauer §3.12).
      if (this.cycleInLine === 1) {
        this._beginRasterLine(this.raster);
        this._advanceDisplayStateCycle1(this.raster);
        if (this.raster !== 0) this._checkRasterIrq();
      }
      if (this.cycleInLine === 2 && this.raster === 0) {
        this._checkRasterIrq();
      }
      if (this.cycleInLine === 14) {
        this._advanceDisplayStateCycle14(this.raster);
      }

      this._updateBadLineStateForCycle(this.cycleInLine, this.raster);

      // Cycle-55 DMA-start (Bauer §3.8.1 rule 2, 2024 revision) runs at
      // phi1 of cycle 55 — i.e. BEFORE BA is sampled this cycle. For
      // sprite 0, p-access is at cycle 58 and the BA-low window opens at
      // cycle 55 (3-cycle lead). If a sprite's Y matched this raster,
      // _spriteSequencerCycle55() flips spriteDmaOn[s]=1; BA sampling
      // must see that update so isSpriteBaLow()/baLow expose the
      // correct contour from the very first cycle of the window.
      // Cycle 56 also runs a redundant DMA-start check + the FF
      // inversion; we keep the pair together for a single phi1 ordering.
      if (this.cycleInLine === 55) {
        this._spriteSequencerCycle55();
      }
      if (this.cycleInLine === 56) {
        this._spriteSequencerCycle56();
      }

      let vicSeizesCpu = false;
      // Track sprite-only BA-low separately from total BA-low. The CPU
      // stall logic in machine.js applies a 1-cycle delay to SPRITE BA-low
      // (per WDC RDY semantics: read in flight on cycle of BA-low onset
      // completes before halt) but uses same-cycle observation for
      // BAD-LINE BA-low (= keeps stable-IRQ trick alignment unbroken for
      // rasterbar demos that don't use sprites).
      // _isBaLowCycle = badLineBaLow || spriteBaLow. Compute the sprite term
      // once here (it's also exposed as spriteBaLowOnly) and reuse it for the
      // unified baLow instead of letting _isBaLowCycle recompute _spriteBaLow
      // a second time. These two reads are adjacent with no state mutation
      // between them, so this is identical to the prior _isBaLowCycle call.
      this.spriteBaLowOnly = this._spriteBaLow(this.cycleInLine);
      this.baLow = this._isBadLineBaLow(this.cycleInLine) || this.spriteBaLowOnly;
      this.aecLow = false;
      this._runTextPhase1Access(this.cycleInLine);

      this._spriteSequencerPointerAccess(this.cycleInLine);

      if (this.cycleInLine === 15) {
        this._spriteSequencerCycle15();
      }

      if (this.cycleInLine === 16) {
        this._spriteSequencerCycle16();
      }

      if (this.cycleInLine === 58) {
        // Capture the bad-line condition at PHI1 of cycle 58 — Bauer §3.7.2
        // rule 5's "first phase of cycle 58". This is BEFORE the CPU's phi2
        // write of this cycle (cpu.clock() runs after vic.clock() in the
        // master cycle), so a cycle-57 write is visible (already landed last
        // master cycle) but a cycle-58 write is NOT — matching real hardware /
        // VICE. The phi2 transition (_advanceDisplayStateCycle58) consumes
        // this sample. Capturing live here even when the flag is off keeps the
        // field warm; the flag only chooses which value the transition uses.
        this._cycle58BadLineSample = this._isBadLine(this.raster, this.regs);
        this._spriteSequencerCycle58();
      }

      if (this.cycleInLine === 59) {
        this._spriteSequencerCycle59();
      }

      if (this.cycleInLine === 60) {
        this._spriteSequencerCycle60();
      }

      vicSeizesCpu = this._runTextPhase2Access(this.cycleInLine) || vicSeizesCpu;
      this._spriteSequencerRowAccess(this.cycleInLine);
      if (this._spriteStealsCpuCycle(this.cycleInLine)) {
        vicSeizesCpu = true;
      }
      this.aecLow = vicSeizesCpu;

      const vBorderBefore = this.vBorderActive;
      const hBorderBefore = this.hBorderActive;
      // Vertical border FF first (Bauer §3.9 rules 2-5) — the horizontal
      // border's left-edge open is gated on vBorder being clear, so it must
      // see this cycle's vBorder update.
      this._advanceVerticalBorderFlipFlop();
      this._advanceHorizontalBorderState(this.cycleInLine, this.regs);

      this._captureCycleState(this.cycleInLine, vBorderBefore, hBorderBefore);

      // Cycle-incremental render: as soon as a cycle's state is captured,
      // render that cycle's segment (graphics + sprite pixels). This
      // lets the CPU's mid-line reads of $D01E / $D01F see cycle-
      // accurate collision state, instead of the previous-line's
      // batched value. Required for nine.prg's runtime VIC-variant
      // detection (LDA $D01F at L51 c17) and similar timing-critical
      // collision polls.
      if (this._cycleIncrementalRender) {
        if (this.cycleInLine === 1) {
          this._greyDotCount = 0;   // per-line 8565 grey-dot scratch (write())
          this._d020WrittenThisLine = false;   // per-line border-recolor gate (write())
          const canvasY = this.raster - 15;
          if (canvasY >= 0 && canvasY < CANVAS_H) {
            this._initRenderRasterLine(this.raster, canvasY);
            this._cycleRenderActiveCanvasY = canvasY;
          } else {
            this._cycleRenderActiveCanvasY = -1;
          }
          // Tier-3 line-batch: defer this line's paints unless something
          // armed can observe render-derived state without a register read.
          // Collision IRQs (IMMC/IMBC unmasked) reach the CPU through the
          // IRQ line at commit time, so such lines render live; the frame
          // trace stays live conservatively. Mid-line observers ($D019 /
          // $D01E / $D01F reads, $D01A arming writes) trigger an immediate
          // catch-up replay instead — see _catchUpDeferredLine.
          this._lineDeferred = this.lineBatchRender
            && this._cycleRenderActiveCanvasY >= 0
            && (this.irqMask & 0x06) === 0
            && !this.frameTraceEnabled;
          if (this._lineDeferred) this._armDeferredFetchWatch();
          else if (this.memory) this.memory._vicFetchWatchOn = false;
        }
        // Advance the sprite-collision visibility pipeline every cycle,
        // BEFORE the CPU step, so a mid-line $D01E/$D01F read sees bits
        // detected 2 cycles ago (the 6569 surfaces sprite collisions to
        // the CPU ~2 cycles after the pixel is emitted). Runs every cycle
        // — bits detected at cy 58/59 commit at cy 60/61, past the render
        // window — and persists across the line boundary.
        this._drainSpriteCollisionCommit();
        // Render seg K at machine cy K+1 (deferred by 1). This lets the
        // renderer read lineCycleRegs[K+1] (just captured at the start of
        // THIS cycle) for $D018 CB / bitmap-base and the ECM/BMM/MCM mode
        // bits, which spec-correctly are sampled at the g-access cycle
        // (= K+1) per Bauer §3.7.2 + §3.6.3 visibility rule. Without the
        // defer, lineCycleRegs[K+1] would be stale (last frame's value).
        if (this._cycleRenderActiveCanvasY >= 0
            && this.cycleInLine >= 12 && this.cycleInLine <= 59
            && !this._lineDeferred) {
          this._renderCycleIncremental(
            this.cycleInLine - 1, this._cycleRenderActiveCanvasY, /*live=*/ true);
        }
      }

      if (this.cycleInLine === CYCLES_PER_LINE) {
        // Vertical border FF is now advanced every cycle in
        // _advanceVerticalBorderFlipFlop() (Bauer §3.9 two-stage model); the
        // old cycle-63-only set/reset is no longer needed here.
        this._advanceDisplayStateLineEnd(this.raster);
      }

      if (vicSeizesCpu) {
        stolen += 1;
      }

      // End of line: render and advance. With cycle-incremental render,
      // pixels and collision latches were already updated each cycle —
      // the per-cycle dispatch above did the work. Skip the batch.
      if (this.cycleInLine >= CYCLES_PER_LINE) {
        if (!this._cycleIncrementalRender) this._renderRasterLine(this.raster);
        // Incremental path: graphics/sprites were painted per-cycle; now that
        // the whole line's $D020 history is captured, repaint border pixels
        // on the X-coordinate timeline (Bauer §3.6.1/§3.9 — see
        // _recolorBorderRow). The batch path does this inside _renderRasterLine.
        else if (this._cycleRenderActiveCanvasY >= 0) {
          // Tier-3 line-batch: a still-deferred line replays in one burst
          // here, then the normal line-end passes below run unchanged.
          if (this._lineDeferred) this._catchUpDeferredLine();
          // Border recolor only does work when $D020 changed during the line;
          // otherwise the border colour is uniform and the pass is a no-op.
          if (this._d020WrittenThisLine) this._recolorBorderRow(this._cycleRenderActiveCanvasY);
          this._fixupColumns(this._cycleRenderActiveCanvasY);
          // 8565 grey-dot overlay (same-value $D02x writes recorded in
          // write()). Applied last so it wins over graphics/sprites/fixups,
          // matching the colour-mux output-stage nature of the artifact.
          if (this._greyDotCount > 0) this._applyGreyDots(this._cycleRenderActiveCanvasY);
        }

        // Frame trace capture — gated. Skipped entirely unless the user
        // explicitly enabled it from the JS console (zero overhead in the
        // off path: one boolean check per raster).
        if (this.frameTraceEnabled) this._captureFrameTraceLine();

        this.cycleInLine = 0;
        this.raster++;
        // One-shot: subsequent CPU phi2 register read (still inside this
        // master cycle, before the next vic.clock) should see OLD raster.
        // Cleared at the start of the next vic.clock master cycle.
        this._lineJustEnded = true;
        if (this.raster >= LINES_PER_FRAME) {
          this.raster = 0;
          if (this.frameTraceEnabled) {
            this.frameTraceD012Writes = this._d012WritesCurrent;
            this._d012WritesCurrent = [];
            this.frameTraceD011Writes = this._d011WritesCurrent;
            this._d011WritesCurrent = [];
            this.frameTraceD01AWrites = this._d01AWritesCurrent;
            this._d01AWritesCurrent = [];
            this.frameTraceD017Writes = this._d017WritesCurrent;
            this._d017WritesCurrent = [];
            this.frameTraceD018Writes = this._d018WritesCurrent;
            this._d018WritesCurrent = [];
            this.frameTraceD016Writes = this._d016WritesCurrent;
            this._d016WritesCurrent = [];
            this.frameTraceIrqAssertions = this._irqAssertionsCurrent;
            this._irqAssertionsCurrent = [];
            this.frameTraceIrqAccepts = this._irqAcceptsCurrent;
            this._irqAcceptsCurrent = [];
          }
        }
        // No line-transition vCompare — Bauer §3.9 rule 2/3 fires only
        // "in cycle 63". The cycle-63 detect at L_(N) c63 queued a
        // pending transition that the next master tick (c1 of L_(N+1))
        // evaluates via `_evaluatePendingTransitions`.
      }
    }

    return stolen;
  }

  // VIC phi2 hook. Called by machine._runMasterCycle AFTER cpu.clock()
  // (CPU's phi2 register writes have landed). Reconciles the cycle-56
  // advance-line FF (Bauer §3.8.1 rules 1 and 3) against the live $D017:
  // clock() ran the c56 path during phi1 using the pre-CPU mask, so a CPU
  // write in this same cycle must be folded in here.
  phi2() {
    // Sprite idle fetch (the VIC-Addendum.txt) — sample the bus AFTER CPU
    // phi2 writes have landed so a same-cycle STA $D0xx leaks. The
    // bus is reset to $FF at the start of the NEXT vic.clock(), so
    // sample here while the just-completed cycle's drivers are still
    // live. _thisCycleInLine preserves the cycle number across the
    // line wrap (cycleInLine wraps to 0 at end of clock(63)).
    if (this._thisCycleInLine !== undefined) {
      // Capture p-cycle phi2 bus per sprite (used as byte 0 of the
      // 3-byte idle fetch performed at the matching s-cycle one cycle
      // later — see _spriteSequencerRowAccessIdle).
      const sP = this._getSpritePointerAccessSprite(this._thisCycleInLine);
      if (sP >= 0 && !this.spriteDmaOn[sP]) {
        this._spritePCyclePhi2Bus[sP] = this.vicInternalBus & 0xFF;
        this._spritePCyclePhi2BusValid[sP] = 1;
      }
      this._spriteSequencerRowAccessIdle(this._thisCycleInLine);
    }

    // Re-render the just-painted segment if a same-cycle $D00x/$D010 write
    // (which landed at this phi2, AFTER the phi1 render) moved a sprite's X
    // into the phi2-half catch window (Bauer §3.6.1/§3.8.1).
    this._applySpriteXSameCycleFixup();

    // DEN bad-line-enable latch — phi2 boundary sample (Bauer §3.7.1:
    // "DEN set during an arbitrary cycle of raster line $30"). The raster
    // counter increments at c63 phi1 inside clock(), so a CPU DEN-set
    // write at the phi2 of line $30's FINAL cycle lands when this.raster
    // already reads $31 — the phi1 latch at line 784 (which only fires
    // while this.raster===$30) misses it, leaving bad lines disabled for
    // the whole frame (idle data instead of text). Per the _lineJustEnded
    // "the boundary phi2 still belongs to the line that just ended" model
    // (the same compensation the $D012-read path uses), that write must
    // count as line $30. Sample it here, before _lineJustEnded is cleared
    // below. Matches VICE (dentest/den01-49-1 = text). The -2 variant
    // (write one cycle later at $31.c1, _lineJustEnded already false)
    // correctly stays idle.
    if (this._lineJustEnded && this.raster === 0x31 && (this.regs[0x11] & 0x10)) {
      this.displayEnabled = true;
    }

    // Clear the line-just-ended one-shot. The CPU phi2 read for the
    // master cycle in which a line transition fired has now happened
    // (machine.js calls vic.phi2() AFTER cpu.clock()), so any
    // subsequent caller — including external synthetic harnesses that
    // only drive vic.clock() — should see the live raster.
    this._lineJustEnded = false;

    // Cycle 58 RC=7 / no-BL → idle transition (Bauer §3.7.2 rule 5).
    // Deferred to phi2 so a CPU same-cycle write to $D011 (e.g. the
    // FLI mid-line YSCROLL trick raster_time_gp / BCC#20 uses) is
    // visible to _isBadLine. Bauer's "first phase of cycle 58" maps
    // to OUR phi2 in the master-cycle ordering (vic clock → cpu
    // clock → vic.phi2()).
    if (this.cycleInLine === 58) {
      this._advanceDisplayStateCycle58(this.raster);
    }

    if (this.cycleInLine === 56) {
      const cur = this.regs[0x17];
      const delta = (this._c56MxYESnapshot ^ cur) & 0xFF;
      if (delta) {
        // Rule 3 (the FF inversion) samples MxYE at cycle 56 PHI1, BEFORE the
        // CPU's same-cycle $D017 write — that pass already ran in
        // _spriteSequencerCycle56() using the phi1 mask. A bit that the CPU
        // only SETS at phi2 is too late to participate in this cycle's
        // inversion, so phi2 must NOT toggle on it. (testprogs/VICII/
        // spritecrunch spritecrunch2 delays 38-41: a `sty $d017` re-set landing
        // at cy56 phi2 must leave FF untouched — toggling it here held the
        // sprite-crunch 8 rasterlines too long, releasing MCBASE at the
        // cy57-write block instead of VICE's cy56-write block.)
        //
        // Only rule 1 (level-sensitive: MxYE=0 forces FF=1) acts at phi2: a
        // bit the CPU CLEARS at phi2 still forces its FF to 1.
        for (let s = 0; s < 8; s++) {
          if (((delta >> s) & 1) === 0) continue;
          if (((cur >> s) & 1) === 0) this.spriteYExpandFF[s] = 1;   // rule 1
        }
        this._c56MxYESnapshot = cur;
      }
    }
  }

  // Per-raster snapshot capture for the frame-trace debug buffers.
  // Called only when this.frameTraceEnabled is true. Pulls cycle-30 register
  // samples (mid-display, after the IRQ has set up this line) plus the
  // current per-sprite DMA / pointer / MC state at end-of-line.
  _captureFrameTraceLine() {
    // Accumulate this line's line-sized side buffers into the full-frame debug
    // maps (#1). cy = the rendered line's canvas row; at this point (line end,
    // after render + fixups + recolor + grey-dots) the buffers hold its final
    // state — exactly what the old full-screen buffers held for this row.
    const cy = this._cycleRenderActiveCanvasY;
    if (cy >= 0 && cy < CANVAS_H) {
      if (!this.frameTraceBorderMap) {
        this.frameTraceBorderMap = new Uint8Array(CANVAS_W * CANVAS_H);
        this.frameTracePriorityMap = new Uint8Array(CANVAS_W * CANVAS_H);
        this.frameTraceOwnerMap = new Uint8Array(CANVAS_W * CANVAS_H);
      }
      const mb = cy * CANVAS_W;
      this.frameTraceBorderMap.set(this.borderBuffer, mb);
      this.frameTracePriorityMap.set(this.graphicsPriorityBuffer, mb);
      this.frameTraceOwnerMap.set(this.spriteOwnerBuffer, mb);
    }
    const traceBase = this.raster * (CYCLES_PER_LINE + 1);
    this.frameTraceHBorder.set(this.lineCycleHBorder, traceBase);
    this.frameTraceVBorder.set(this.lineCycleVBorder, traceBase);
    this.frameTraceLineD011[this.raster] = this.regs[0x11];
    this.frameTraceLineD016[this.raster] = this.regs[0x16];
    this.frameTraceLineFlags[this.raster] =
      (this._isBadLine(this.raster, this.regs) ? 1 : 0) |
      (this.displayActive ? 2 : 0);

    const cycle30Regs = this.lineCycleRegs[30];
    this.frameTraceLineD015[this.raster] = cycle30Regs[0x15];
    this.frameTraceLineD01C[this.raster] = cycle30Regs[0x1C];
    this.frameTraceLineD01D[this.raster] = cycle30Regs[0x1D];
    this.frameTraceLineD017[this.raster] = cycle30Regs[0x17];
    this.frameTraceLineD01B[this.raster] = cycle30Regs[0x1B];
    this.frameTraceLineD010[this.raster] = cycle30Regs[0x10];
    this.frameTraceLineD021[this.raster] = cycle30Regs[0x21];
    this.frameTraceLineD012[this.raster] = cycle30Regs[0x12];
    // $D019 / $D01A live state is in irqStatus / irqMask, not regs[].
    // regs[0x19] only ever holds the LAST CLEAR-MASK BYTE the CPU wrote
    // (W1C semantics); regs[0x1A] retains the unmasked high bits the CPU
    // wrote. Tracing those was misleading when diagnosing IRQ-chain
    // drift — capture the real chip state.
    this.frameTraceLineD019[this.raster] = this.irqStatus;
    this.frameTraceLineD01A[this.raster] = this.irqMask;
    this.frameTraceLineD020[this.raster] = cycle30Regs[0x20];
    this.frameTraceLineVicBank[this.raster] = this.lineCycleBanks[30];

    let regChanges = 0;
    if (cycle30Regs[0x16] !== this._frameTracePrevD016) regChanges |= 1;
    if (cycle30Regs[0x11] !== this._frameTracePrevD011) regChanges |= 2;
    if (cycle30Regs[0x15] !== this._frameTracePrevD015) regChanges |= 4;
    if (cycle30Regs[0x18] !== this._frameTracePrevD018) regChanges |= 8;
    this.frameTraceLineRegChanges[this.raster] = regChanges;
    this._frameTracePrevD016 = cycle30Regs[0x16];
    this._frameTracePrevD011 = cycle30Regs[0x11];
    this._frameTracePrevD015 = cycle30Regs[0x15];
    this._frameTracePrevD018 = cycle30Regs[0x18];

    const xyBase = this.raster * 16;
    for (let s = 0; s < 8; s++) {
      this.frameTraceLineSpriteXY[xyBase + s * 2]     = cycle30Regs[s * 2];
      this.frameTraceLineSpriteXY[xyBase + s * 2 + 1] = cycle30Regs[s * 2 + 1];
    }
    const colBase = this.raster * 8;
    for (let s = 0; s < 8; s++) {
      this.frameTraceLineSpriteColors[colBase + s] = cycle30Regs[0x27 + s];
    }

    let dmaMask = 0, dispMask = 0;
    for (let s = 0; s < 8; s++) {
      if (this.lineCycleSpriteDisplayOn[30] && this.lineCycleSpriteDisplayOn[30][s]) dispMask |= (1 << s);
      if (this.spriteDmaOn[s]) dmaMask |= (1 << s);
    }
    this.frameTraceLineSpriteDmaOn[this.raster] = dmaMask;
    this.frameTraceLineSpriteDisplayOn[this.raster] = dispMask;

    const ptrBase = this.raster * 8;
    let yeFFMask = 0;
    for (let s = 0; s < 8; s++) {
      this.frameTraceLineSpritePtrs[ptrBase + s] = this.spritePointerValue[s];
      this.frameTraceLineSpriteMC[ptrBase + s] = this.spriteMC[s];
      this.frameTraceLineSpriteMCBase[ptrBase + s] = this.spriteMCBase[s];
      if (this.spriteYExpandFF[s]) yeFFMask |= (1 << s);
    }
    this.frameTraceLineSpriteYExpFF[this.raster] = yeFFMask;
  }

  // Return raster line for $D012/$D011 bit 7
  getRaster() { return this.raster; }
  isBaLow() { return !!this.baLow; }
  isAecLow() { return !!this.aecLow; }
  // Canonical AEC formula for the current cycle's phi2: BA was low this
  // cycle AND BA was low 3 cycles ago. This is the spec definition (Bauer
  // §3.6.1: AEC follows BA after 3 cycles of BA-low lead-in). Differs
  // from isAecLow() which is `vicSeizesCpu` and over-reports during the
  // invalid-c-read window (cycles where a c-access fires but BA hasn't
  // been low for 3 cycles yet, so AEC is actually still high in real
  // silicon — and the CPU phi2 should still own the bus).
  //
  // Uses _thisCycleInLine (set at the START of clock() to the live
  // cycleInLine) rather than cycleInLine itself: at end of cycle 63,
  // clock() wraps cycleInLine to 0 BEFORE phi2() runs, so reading
  // cycleInLine here would query cy 0 of the next line. _thisCycleInLine
  // preserves the just-completed cycle's index across that wrap.
  isAecLowPhi2() {
    const cy = this._thisCycleInLine !== undefined ? this._thisCycleInLine : this.cycleInLine;
    return this._spriteAecLowHistoric(cy);
  }
  isSpriteBaLow() { return !!this.spriteBaLowOnly; }
  // Bad-line BA contribution alone — true when the current cycle's
  // bad-line c-access window pulls BA low, regardless of whether a
  // sprite is also pulling BA low at the same cycle. Required so the
  // CPU stall logic can distinguish "bad-line: same-cycle stall" from
  // "sprite-only: 1-cycle delay" even when both are simultaneously
  // active. Avoids the masking bug where the union signal lost the
  // bad-line component during overlap windows (e.g. c54 bad-line BA
  // adjacent to c55 sprite-0 lead BA).
  isBadLineBaLow() { return this._isBadLineBaLow(this.cycleInLine); }

  // CPU calls this when it starts vectoring an interrupt (the boundary at
  // which _queueInterruptMicroOps fires). Captured for frame trace only —
  // zero overhead when tracing is disabled. Wired in machine.js via
  // cpu.onInterruptAccept.
  noteInterruptAccepted(kind) {
    if (!this.frameTraceEnabled) return;
    this._irqAcceptsCurrent.push({
      kind,
      raster: this.raster,
      cycleInLine: this.cycleInLine,
      totalCycles: this.totalCycles,
    });
  }

  clearRasterIrq() {
    // Clear the raster latch (bit 0). Bit 7 (IRQ-asserted to CPU) must
    // be recomputed from the remaining enabled-and-latched sources —
    // unconditionally clearing it would deassert the line even though
    // another VIC IRQ source (sprite-collision, lightpen) is still
    // pending and unmasked. Mirrors the $D019 W1C / $D01A mask paths.
    this.irqStatus &= ~0x01;
    if ((this.irqStatus & this.irqMask & 0x0F) !== 0) this.irqStatus |= 0x80;
    else this.irqStatus &= ~0x80;
    this.irqHandler(this.irqPending);
  }

  // Bauer §3.11: drive the LP (lightpen) input pin level. A negative
  // edge (1 → 0) latches the current 9-bit X / 8-bit Y of the raster
  // beam into LPX ($D013) and LPY ($D014), and fires the LP IRQ
  // ($D019 bit 3) if enabled in $D01A. Only the FIRST negative edge
  // per frame is recognised — subsequent edges are ignored until the
  // start of the next frame (raster=0).
  //
  // The reference point is the END of the cycle in which LP went low.
  // Bauer's example "trigger LP in cycle 20 → LPX=$1E ($03C >> 1)"
  // gives the calibration point: end-of-cycle-N 9-bit X coordinate is
  //   ($194 + N*8) mod 504
  // (504 = 6569 PAL line length in pixels). LPX is the upper 8 bits of
  // that 9-bit X (resolution = 2 pixels), LPY is raster & $FF.
  //
  // The integrating layer (machine.js) is responsible for translating
  // CIA1 PB bit 4 changes (and any other LP-input source) into calls
  // here. This VIC layer just observes the edge and latches.
  setLightpenLevel(level) {
    const wasHigh = this._lpInputLevel === 1;
    const goingLow = level === 0;
    this._lpInputLevel = level ? 1 : 0;
    if (!wasHigh || !goingLow) return;
    // VIC-Addendum.txt: light pen does NOT trigger in line 311. The negative
    // edge is silently ignored on the very last raster of the frame.
    if (this.raster === LINES_PER_FRAME - 1) return;
    this._latchLightpen();
  }

  _latchLightpen() {
    if (this._lpLatchedThisFrame) return;
    this._lpLatchedThisFrame = true;

    const x9 = (0x194 + this.cycleInLine * 8) % 504;
    this.regs[0x13] = (x9 >> 1) & 0xFF;
    this.regs[0x14] = this.raster & 0xFF;

    // Bauer §3.12 bit 3: LP IRQ on the negative edge.
    const before = this.irqStatus;
    this.irqStatus |= 0x08;
    if (this.irqMask & 0x08) {
      this.irqStatus |= 0x80;
      if ((before & 0x80) === 0) this.irqHandler(true);
    }
  }

  // CPU-visible raster value. Real hardware ticks the raster counter
  // at the boundary between cycle 63 phi2 and cycle 1 phi1 of the next
  // line, so a CPU phi2 read at cycle 63 still sees the OLD raster.
  // Our master-cycle ordering runs vic.clock(1) BEFORE cpu.clock(),
  // and the line-end housekeeping inside vic.clock() resets cycleInLine
  // to 0 + increments raster at master cycle 63 — meaning by the time
  // the CPU reads a register at cycle 63 phi2, our `this.raster` has
  // already advanced. We set `_lineJustEnded` for exactly the master
  // cycle in which the line transition happened (set inside vic.clock,
  // cleared at the start of the next vic.clock master cycle), and
  // compensate at read time only during that window.
  _cpuVisibleRaster() {
    // VICE/real-HW: $D012 first reflects the NEW raster line at cycle 1, not
    // cycle 0 — the readable value lags the internal raster (which the raster-IRQ
    // compare uses at cycle 0) by one cycle at the line start. Our master-cycle
    // ordering increments `this.raster` + resets cycleInLine to 0 inside vic.clock
    // at the line-end transition (the _lineJustEnded window), and the subsequent
    // cycleInLine-0 master cycle would otherwise expose the new line one cycle
    // early. So hold the OLD raster for ALL of cycleInLine 0 (covers both the
    // _lineJustEnded transition read and the cy0 read). Verified vs VICE
    // (CYC reg): new $D012 value first visible at CYC 1. Fixes Coma Light's
    // timer-stable-raster sync doing one extra $D012-poll iteration (the mole
    // KIL) — see coma-sr-cyc.mjs / coma-vice-d012.mjs.
    if (this._lineJustEnded || this.cycleInLine === 0) {
      return this.raster === 0 ? (LINES_PER_FRAME - 1) : (this.raster - 1);
    }
    // Bauer §3.12: at L0.cy1 the raster counter still holds the previous
    // frame's final value (the internal 311→0 increment is deferred one cycle,
    // which is also why the raster-IRQ compare at raster 0 fires at cy 2 not cy 1).
    if (this.raster === 0 && this.cycleInLine === 1) {
      return LINES_PER_FRAME - 1;
    }
    return this.raster;
  }

  // Companion to _cpuVisibleRaster for CPU WRITES at the line-end boundary.
  // Master-cycle ordering: vic.clock runs first (and wraps cycleInLine 63→0
  // + raster++ at line end), then CPU phi2 runs. So a CPU write at "cy 63
  // phi2" lands while this.cycleInLine is already 0 and this.raster has
  // already advanced. Writes recorded with live this.raster/cycleInLine
  // get mis-timestamped as cy 0 of the NEW line. Real silicon treats the
  // write as happening at cy 63 of the OLD line for FF-compare / latch-
  // window interactions. Return the pre-wrap pair during the one master
  // cycle window where _lineJustEnded is set.
  // (B1) Returns the CPU-visible (raster, cycleInLine) for a WRITE packed as
  // (raster << 8) | cycleInLine — a Smi, so there is no per-write object
  // allocation and the call site stays monomorphic. This used to return a
  // {raster, cycleInLine} literal that deopted on "Insufficient type feedback
  // for object literal". cycleInLine ≤ 63 fits the low 8 bits; raster ≤ 311.
  // Decode at the caller: raster = v >> 8, cycleInLine = v & 0xFF.
  _cpuVisibleRasterAndCycleForWrite() {
    if (this._lineJustEnded) {
      const r = this.raster === 0 ? (LINES_PER_FRAME - 1) : (this.raster - 1);
      return (r << 8) | CYCLES_PER_LINE;
    }
    return (this.raster << 8) | this.cycleInLine;
  }

  read(reg) {
    reg &= 0x3F;
    const v = this._readRegRaw(reg);
    // CPU read drives the VIC internal data bus — feeds sprite idle fetch.
    this.vicInternalBus = v & 0xFF;
    return v;
  }

  _readRegRaw(reg) {
    // Per Bauer §3.2, $D02F-$D03F are unconnected and always read $FF.
    if (reg >= 0x2F) return 0xFF;
    switch (reg) {
      case 0x11: {
        // $D011 bit 7 = bit 8 of the raster counter. Same phase
        // adjustment as $D012 below: at the cycleInLine===0 boundary
        // (master cycle 63 phi2 in real-hardware sequencing) the CPU
        // should still see the OLD raster.
        const r = this._cpuVisibleRaster();
        const bit8 = (r > 255) ? 0x80 : 0x00;
        return (this.regs[0x11] & 0x7F) | bit8;
      }
      case 0x12: return this._cpuVisibleRaster() & 0xFF;
      case 0x13: return this.regs[0x13];        // LPX: read latched value (Bauer §3.11)
      case 0x14: return this.regs[0x14];        // LPY: read latched value
      case 0x16: return this.regs[0x16] | 0xC0; // bits 7,6 unused
      case 0x18: return this.regs[0x18] | 0x01; // bit 0 unused
      case 0x19:
        // Tier-3 line-batch: $D019 carries the collision IRQ flags (IMMC/
        // IMBC), which only commit when sprite pixels render — replay the
        // deferred line first so the read sees cycle-exact bits.
        if (this._lineDeferred) this._catchUpDeferredLine();
        return this.irqStatus | 0x70;
      case 0x1A: return this.irqMask | 0xF0;
      // Sprite-sprite ($D01E) and sprite-background ($D01F) collision
      // registers. Reading returns the latched bits and clears them, and on
      // silicon the collision flip-flops are cleared outright — so bits still
      // in flight in the visibility pipeline must not survive to a second read
      // a few cycles later. The clear is phi-resolved: the fully-elapsed stage
      // and the phi1-half of the current stage are dropped, but the current
      // stage's phi2-half (late 4px) is retained so a back-to-back double read
      // (VICII/spritevssprite) still catches collisions from the read cycle's
      // second half. Clearing the whole pipeline instead leaves the catch
      // window half a cycle (4px) too narrow.
      case 0x1E: { if (this._lineDeferred) this._catchUpDeferredLine(); const v = this.regs[0x1E]; this.regs[0x1E] = 0; this._collPipeE[0] = 0; this._collLateE[0] = 0; this._collPipeE[1] = this._collLateE[1]; return v; }
      case 0x1F: { if (this._lineDeferred) this._catchUpDeferredLine(); const v = this.regs[0x1F]; this.regs[0x1F] = 0; this._collPipeF[0] = 0; this._collLateF[0] = 0; this._collPipeF[1] = this._collLateF[1]; return v; }
      default:
        // Color registers $D020-$D02E: only low 4 bits connected, high nibble reads as 1.
        if (reg >= 0x20) return this.regs[reg] | 0xF0;
        return this.regs[reg];
    }
  }

  _isSpriteActiveOnLine(s, raster) {
    return !!(this.spriteDmaOn[s] || this.spriteDisplayOn[s]);
  }

  write(reg, val) {
    reg &= 0x3F;
    val &= 0xFF;
    // CPU write drives the VIC internal data bus — feeds sprite idle fetch.
    // Latched even for ignored registers ($D01E/$D01F/$D02F-$D03F) because
    // the bus byte is independent of whether the destination latches it.
    this.vicInternalBus = val;
    // Tier-3 line-batch mid-line observers/invalidators: arming a collision
    // IRQ (IMMC/IMBC) makes the IRQ line an observer of render timing, and a
    // change to the g-access fetch config ($D018 base bits, $D011 BMM)
    // invalidates the armed RAM fetch watch — replay the deferred line now;
    // the rest of the line renders live.
    if (this._lineDeferred) {
      if (reg === 0x1A && (val & 0x06) !== 0) this._catchUpDeferredLine();
      else if (reg === 0x18 && (((this.regs[0x18] ^ val) & 0x0E) !== 0)) this._catchUpDeferredLine();
      else if (reg === 0x11 && (((this.regs[0x11] ^ val) & 0x20) !== 0)) this._catchUpDeferredLine();
    }
    // Bauer §3.2: $D01E/$D01F (M-M and M-D collision) and $D02F-$D03F
    // (unconnected) are not CPU-writable. Return after updating the bus
    // latch so a STA $D01E doesn't poison the collision register.
    if (reg === 0x1E || reg === 0x1F || reg >= 0x2F) return;
    const oldVal = this.regs[reg];
    this.regs[reg] = val;
    // (B2) Any CPU register write changes the per-cycle reg snapshot, so bump
    // the version that _captureCycleState's dedup compares. (Writes to non-
    // rendered regs like $D019/$D01A bump too — harmless, just forces a copy.)
    this._regSnapVersion = (this._regSnapVersion + 1) | 0;
    // Sprite-X registers ($D000-$D00E even + $D010 MSBs): a CPU write at phi2
    // of a cycle catches the phi2-half pixels of that cycle's sprite
    // X-comparison (Bauer §3.6.1/§3.8.1; the spritex C64 column proves the
    // phi1/phi2 boundary). The cycle-incremental render runs at phi1 (before
    // this phi2 write), so the just-rendered segment used the pre-write X.
    // Flag it so phi2()'s _applySpriteXSameCycleFixup can re-render that
    // segment with the corrected (post-write) X. (The Hat "GENESIS" sprite 0.)
    if (val !== oldVal && (reg === 0x10 || (reg <= 0x0E && (reg & 1) === 0))) {
      this._spriteXWriteThisCycle = true;
    }
    // Border-colour ($D020) change latch — arms the line-end border recolor
    // (see _recolorBorderRow / the ctor). Only a value CHANGE matters: it makes
    // the recolor do real work. A same-value write (the 8565 grey-dot case,
    // handled below) leaves the border colour — and every per-cycle snapshot of
    // it — unchanged, so it stays a no-op and does not need to arm the pass.
    if (reg === 0x20 && val !== oldVal) this._d020WrittenThisLine = true;
    // Phase A: §3.14.1 hyperscreen/left-prevent veto is now evaluated at
    // phi1 of latchCycle (deferred latch model). The synchronous write-time
    // veto has been removed — see _evaluatePendingTransitions.
    //
    // Use the CPU-visible raster/cycle so writes at cy 63 phi2 land
    // logged at L_old.c63 (not L_new.c0) — symmetric to the read path's
    // _cpuVisibleRaster compensation.
    const writePos = this._cpuVisibleRasterAndCycleForWrite();
    const writePosRaster = writePos >> 8;     // (B1) decode the packed Smi once
    const writePosCycle = writePos & 0xFF;
    // 8565 grey-dot (VIC-Addendum.txt "Grey Dots on 856x"): writing a colour
    // register ($D020-$D02E) while it is displaying graphics emits a light-
    // grey (colour 15) pixel at the beam position — INDEPENDENT of the value
    // written. _firstPixelBgColor already models the value-CHANGE case (a
    // delta between adjacent per-cycle register snapshots), which is all
    // nine.prg needs. A write of the SAME value leaves the snapshots equal,
    // so it is invisible there — that is the case testprogs/VICII/greydot
    // exercises (it sprays identical $D021 writes). Mark it here instead.
    // The greyed pixel is the one under the beam at this write's phi2: canvas
    // X = (cycleInLine - 13) * 8 (calibrated to greydot.prg-8565.png). That
    // pixel was rendered ~1 cycle ago, so we record it and overlay it at
    // line-end (after _fixupColumns) rather than during a segment render.
    if (this._is8565 && reg >= 0x20 && reg <= 0x2E && val === oldVal &&
        this.displayActive && this._cycleRenderActiveCanvasY >= 0 &&
        this._greyDotCount < this._greyDotXs.length) {
      const dotX = (this.cycleInLine - 13) * 8;
      if (dotX >= GRAPHICS_WINDOW_START && dotX < GRAPHICS_WINDOW_END) {
        this._greyDotXs[this._greyDotCount++] = dotX;
      }
    }
    if (this.frameTraceEnabled &&
        (reg === 0x12 || reg === 0x11 || reg === 0x1A ||
         reg === 0x17 || reg === 0x18 || reg === 0x16)) {
      const entry = {
        raster: writePosRaster,
        cycleInLine: writePosCycle,
        value: val & 0xFF,
        totalCycles: this.totalCycles,
      };
      if (reg === 0x12) this._d012WritesCurrent.push(entry);
      else if (reg === 0x11) this._d011WritesCurrent.push(entry);
      else if (reg === 0x1A) this._d01AWritesCurrent.push(entry);
      else if (reg === 0x17) this._d017WritesCurrent.push(entry);
      else if (reg === 0x16) this._d016WritesCurrent.push(entry);
      else this._d018WritesCurrent.push(entry);
    }
    switch (reg) {
      case 0x16: {
        const oldCsel = (oldVal >> 3) & 1;
        const newCsel = (val >> 3) & 1;
        if (oldCsel !== newCsel) {
          this._lastCselChangeRaster = writePosRaster;
          this._lastCselChangeCycle = writePosCycle;
          this._lastCselChangeFrom = oldCsel;
          this._lastCselChangeTo = newCsel;
          // The CSEL=0 left compare is the late edge of cycle 15. A phi2
          // CSEL 0->1 write in that same cycle retargets the visible reset
          // split to the CSEL=1 edge even though the cycle snapshot was
          // captured earlier; segment 15 is rendered on the following cycle.
          if (oldCsel === 0 && newCsel === 1 &&
              writePosRaster === this.raster && writePosCycle === 15 &&
              this.lineCycleHBorderBefore[15] && !this.lineCycleHBorder[15]) {
            this.lineCycleCselComparator[15] = 1;
          }
        }
        break;
      }
      case 0x11: {
        // VIC-Addendum.txt + Bauer §3.12: edge-triggered raster compare.
        // Per Bauer literal: "It is possible to trigger an interrupt
        // immediately by writing to $d011/$d012, but the interrupt can
        // never occur more than once per raster line."
        //
        //   • HIGH→LOW dip: arms the next per-line sample to count as a
        //     fresh rising edge (existing _rasterCompMidLineDip).
        //   • LOW→HIGH transition: fires the IRQ IMMEDIATELY (this is
        //     OU's chain mechanism — $D012=$f8 written at L248.c3 must
        //     fire L248 IRQ same-cycle, since cy 1 already passed).
        //
        // Compare against the VIC's TRUE raster counter (`this.raster`),
        // NOT the CPU-visible raster. The comparator is wired to the
        // internal raster counter (Bauer §3.12); _cpuVisibleRaster's one-
        // cycle lag is purely a $D012-READ quirk and must not feed the
        // edge detector. `_checkRasterIrq` already samples raw `this.raster`
        // — the write path has to agree with it or the two disagree at the
        // c63→c0 boundary.
        //
        // VIC-Addendum.txt: "Raster comparison is edge triggered. If $d012 is
        // changed to always follow the raster counter it will never trigger
        // an IRQ condition." A loop that does `stx $d012` = current line at
        // cy0 each line (testprogs rasterirq_hold) holds the comparator
        // continuously HIGH (latch N == raster N across the boundary), so
        // there is no rising edge. Evaluating against the CPU-visible raster
        // (still N-1 at the cy0 boundary) misreads the boundary write as a
        // HIGH→LOW dip on line N-1, which falsely re-arms the cy1 sample and
        // fires every line. Using `this.raster`=N keeps it HIGH→HIGH.
        const oldTarget = this.regs[0x12] | ((oldVal & 0x80) << 1);
        const newTarget = this.regs[0x12] | ((val & 0x80) << 1);
        if (oldTarget !== newTarget) {
          const oldMatch = (this.raster === oldTarget);
          const newMatch = (this.raster === newTarget);
          if (oldMatch && !newMatch) this._rasterCompMidLineDip = true;
          if (!oldMatch && newMatch) this._fireRasterIrqMidLine();
        }
        // Late-line YSCROLL → BL recovery (raster_time_gp's permanent
        // bad-line trick): if the CPU writes $D011 at cy 59-62 with a
        // YSCROLL that produces a fresh BL condition AFTER the cy 58
        // idle check already pushed display state to idle, re-activate
        // display synchronously. Bauer §3.5 says BL can be produced at
        // any cycle; §3.7.1 says idle → display occurs "as soon as
        // there is a Bad Line Condition". The cy 58 idle transition
        // (Bauer §3.7.2 rule 5) is conditioned on "no BL here", not a
        // hard latch — a later same-line BL must immediately reverse it.
        const cyNow = writePosCycle;
        if (cyNow >= 59 && cyNow <= 62 &&
            !this.displayActive &&
            this._isBadLine(writePosRaster, this.regs)) {
          this.displayActive = true;
        }
        // Mid-line bad-line CANCEL (phi2-visible): if this write makes the
        // bad-line condition FALSE while a fetch is queued but not yet started,
        // cancel it immediately. Mirrors the cy58 phi2 deferral model — CPU
        // phi2 writes are visible before the NEXT cycle's phi1 bad-line check,
        // so a cancel write at cy14 phi2 must suppress the cy15 fetch start.
        // Spec: Bauer §3.5 "cancel a BL condition … by modifying YSCROLL";
        // cy58 precedent shows same-cycle CPU write is authoritative.
        if (cyNow >= 12 && cyNow <= 54 &&
            this.lineBadLineDisplayPending && this.lineMatrixFetchCol < 0 &&
            cyNow < this.lineBadLineStartCycle &&
            !this._isBadLine(writePosRaster, this.regs)) {
          this._cancelQueuedBadLineFetchPhase();
        }
        break;
      }
      case 0x12: {
        // Edge-detect against the TRUE raster counter — see the $D011 case
        // above for the rationale (VIC-Addendum.txt "follow never triggers" /
        // testprogs rasterirq_hold). `_checkRasterIrq` samples raw
        // `this.raster`; the write path must match it at the c63→c0 boundary.
        const oldTarget = oldVal | ((this.regs[0x11] & 0x80) << 1);
        const newTarget = val | ((this.regs[0x11] & 0x80) << 1);
        if (oldTarget !== newTarget) {
          const oldMatch = (this.raster === oldTarget);
          const newMatch = (this.raster === newTarget);
          if (oldMatch && !newMatch) this._rasterCompMidLineDip = true;
          if (!oldMatch && newMatch) this._fireRasterIrqMidLine();
        }
        break;
      }
      case 0x17: {
        // Bauer §3.8.1 rule 1: while the MxYE bit is cleared, the matching
        // advance-line FF is forced to 1. This is a level-sensitive hold,
        // so the CPU-visible $D017 write path applies it immediately.
        //
        // VIC-Addendum.txt (replacement for Bauer rules 7 + 8): "In the first
        // phase of cycle 16, it is checked if the expansion flip flop is
        // set. If so, MCBASE := MC, unless the CPU cleared the Y expansion
        // bit in $d017 in the second phase of cycle 15, in which case
        // MCBASE := X = (101010 & (MCBASE & MC)) | (010101 & (MCBASE | MC))."
        // The crunch latch fires on the EDGE (clear at c15 phi2) regardless
        // of the FF state — Bauer's original wording gates on FF=0, but
        // testprogs/VICII/sprite-crunch confirms VIC-Addendum.txt's no-FF-gate
        // behavior. Cycle 16 consumes the latch to apply the bit-interleave
        // formula instead of MCBASE := MC.
        //
        // The crunch trigger is a TRANSITION ("the CPU cleared MxYE"),
        // not a level — testing the level alone would latch on a redundant
        // cycle-15 store of $00 even though no clearing happened. The
        // explicit edge test (`cleared`) is robust against staged state.
        //
        // Use CPU-visible cycle so a write at the L_old.c63 phi2 boundary
        // is evaluated against c63 (where the CPU semantically wrote),
        // not c0 (where this.cycleInLine has already wrapped). Currently
        // c63 ≠ 15 either way so no behavioral change, but stays
        // symmetric with the trace + $D011/$D012 edge-detect paths.
        const inCrunchWindow = writePosCycle === 15;
        const cleared = oldVal & ~val & 0xFF;
        for (let s = 0; s < 8; s++) {
          const bit = 1 << s;
          if (((val >> s) & 1) === 0) {
            if (inCrunchWindow && (cleared & bit) && !this.spriteYExpandFF[s]) {
              this._spriteCrunchPending[s] = 1;
            }
            this.spriteYExpandFF[s] = 1;
          }
        }
        break;
      }
      case 0x19:
        // Writing clears status bits (W1C)
        this.irqStatus &= ~(val & 0x0F);
        if ((this.irqStatus & this.irqMask & 0x0F) === 0) this.irqStatus &= ~0x80;
        this.irqHandler(this.irqPending);
        break;
      case 0x1A:
        this.irqMask = val & 0x0F;
        if (this.irqMask & this.irqStatus & 0x0F) this.irqStatus |= 0x80;
        else this.irqStatus &= ~0x80;
        this.irqHandler(this.irqPending);
        break;
    }
  }

  // ── RENDERING ─────────────────────────────────────────────────────────────

  // Memory peek — does NOT drive vicInternalBus. Use this for emulator-
  // side fetches (e.g. the renderer re-reading the g-byte that real
  // silicon already latched at g-access time). For real chip-bus fetches
  // (matrix c-access, sprite p/s-access, refresh) call _vicBusRead*.
  //
  _vicMemRead(addr, bank) {
    // PLA Ultimax VIC map (C64 PLA Dissected, table A.11): the VIC sees
    // cartridge ROMH in its local $3000-$3FFF window in every CIA-selected
    // bank. A12-A15 float high during VIC ownership, so this addresses the
    // upper 4 KB of the active 8 KB ROMH. Character ROM is not selected in
    // Ultimax; all other VIC windows read DRAM.
    if (this.memory?.cartMode === 'ultimax') {
      if ((addr & 0x3000) === 0x3000 && this.memory.cartRomHi) {
        return this.memory.cartRomHi[0x1000 | (addr & 0x0FFF)];
      }
      return this.ram[bank + (addr & 0x3FFF)];
    }
    const physAddr = bank + (addr & 0x3FFF);
    if ((physAddr >= 0x1000 && physAddr < 0x2000) ||
      (physAddr >= 0x9000 && physAddr < 0xA000)) {
      return this.charRom[physAddr & 0x0FFF];
    }
    return this.ram[physAddr];
  }

  _isVicCharRomAddr(addr, bank) {
    const physAddr = bank + (addr & 0x3FFF);
    return (physAddr >= 0x1000 && physAddr < 0x2000) ||
      (physAddr >= 0x9000 && physAddr < 0xA000);
  }

  _graphicsFetchAddrForMode(d011, d018, rawCode, vc, line) {
    let addr;
    if (d011 & 0x20) {
      addr = ((((d018 >> 3) & 0x01) * 0x2000) + ((vc & 0x03FF) * 8) + line) & 0x3FFF;
    } else {
      addr = ((((d018 >> 1) & 0x07) * 0x0800) + ((rawCode & 0xFF) * 8) + line) & 0x3FFF;
    }
    if (d011 & 0x40) addr &= 0x39FF;
    return addr;
  }

  _graphicsFetchAddr(d011, prevD011, d018, rawCode, vc, line, bank) {
    // The VIC-Addendum.txt "Fetch": on 6569 a BMM change that flips the g-access
    // source from RAM (bitmap) to character ROM (text) latches the LOW byte
    // of the fetch address from the PREVIOUS-cycle mode while the upper bits
    // use the current mode. This is a one-directional RAM->charROM quirk; the
    // base address otherwise always follows the CURRENT (g-access) mode. The
    // 8565 does not exhibit it (current-mode address throughout).
    const addr = this._graphicsFetchAddrForMode(d011, d018, rawCode, vc, line);
    if (this._is8565 || ((d011 ^ prevD011) & 0x20) === 0) {
      return addr;
    }
    // BMM changed this g-access. The Addendum split fires ONLY on the
    // RAM->charROM direction (previous fetch addressed RAM, current addresses
    // char ROM); the charROM->RAM direction takes the plain current address.
    const addrFrom = this._graphicsFetchAddrForMode(prevD011, d018, rawCode, vc, line);
    if (!this._isVicCharRomAddr(addrFrom, bank) && this._isVicCharRomAddr(addr, bank)) {
      return (addrFrom & 0x00FF) | (addr & 0x3F00);
    }
    return addr;
  }

  _vicBusRead(addr, bank = this.currentVicBank) {
    const v = this._vicMemRead(addr, bank);
    this.vicInternalBus = v & 0xFF;
    // Drive the shared external data bus too. VIC chip-bus fetches happen
    // in phi1; the CPU sees the resulting byte on any open-read it does in
    // phi2 (Color RAM upper nybble, unmapped IO1/IO2). Memory ref is wired
    // in C64Machine.constructor; bare VIC2 instances (unit tests) leave it
    // null and only update vicInternalBus.
    if (this.memory) this.memory.externalDataBus8 = v & 0xFF;
    return v;
  }

  // Back-compat wrappers — keep the existing names so external callers
  // (tests, render path) don't break. _vicRead / _vicReadSprite /
  // _vicReadWithBank are real VIC chip-bus fetches and DO drive the
  // bus latch. The renderer uses _vicMemRead directly to peek without
  // mutating the bus (see _renderSourceColumn).
  _vicRead(addr) {
    return this._vicBusRead(addr, this.currentVicBank);
  }

  _vicReadSprite(addr, bank = this.currentVicBank) {
    return this._vicBusRead(addr, bank);
  }

  _vicReadWithBank(addr, bank) {
    return this._vicBusRead(addr, bank);
  }

  noteBankChange(bank, delay = 0) {
    bank &= 0xC000;
    // Tier-3 line-batch: a mid-line VIC bank change moves the g-access fetch
    // window — replay the deferred line now (see _armDeferredFetchWatch).
    if (this._lineDeferred && bank !== this.currentVicBank) {
      this._catchUpDeferredLine();
    }
    if (delay === 0) {
      // C64C / 8565 glue-logic glitch on PA0/PA1 10↔01 — bank 1 ($4000)
      // ↔ bank 2 ($8000) transitions pass through bank 3 ($C000) for
      // one cycle. Gated: only fires when the flag is on AND we're on
      // the 8565 variant AND the (currentBank, newBank) pair matches
      // the {$4000, $8000} swap pattern.
      if (this.c64cBankGlitch && this._is8565
          && bank !== this.currentVicBank
          && ((this.currentVicBank === 0x4000 && bank === 0x8000)
           || (this.currentVicBank === 0x8000 && bank === 0x4000))) {
        this.currentVicBank = 0xC000;          // 1-cycle blip
        this._pendingBankApplyCycle = this.totalCycles + 1;
        this._pendingBankValue = bank;
        return;
      }
      // Immediate path (default). Cancel any in-flight deferred change
      // — the latest CPU-side write supersedes a still-pending earlier
      // one (e.g. a PRA write following a DDRA write before its delay
      // expires).
      this._pendingBankApplyCycle = -1;
      if (bank !== this.currentVicBank) this.currentVicBank = bank;
      return;
    }
    // Deferred path: hold the new bank, apply at the top of the master
    // cycle whose totalCycles >= applyCycle. totalCycles is incremented
    // at the start of vic.clock(1), and at the moment this is called
    // we're inside cpu.clock() AFTER vic.clock(K) for the current
    // master cycle — so totalCycles is K. To make the bank visible at
    // VIC fetches of cycle K+1+delay, apply at totalCycles K+1+delay.
    if (bank === this.currentVicBank) {
      this._pendingBankApplyCycle = -1;
      return;
    }
    this._pendingBankApplyCycle = this.totalCycles + 1 + delay;
    this._pendingBankValue = bank;
  }

  // Fire raster IRQ on a mid-line LOW→HIGH comparator transition (per
  // Bauer §3.12: "It is possible to trigger an interrupt immediately by
  // writing to $d011/$d012, but the interrupt can never occur more than
  // once per raster line"). Called from $D011/$D012 write handlers when
  // the new value brings the comparator from no-match to match against
  // the CPU-visible raster.
  //
  // Once-per-line: gated by _lastRasterMatch. After firing, mark it so
  // the next cy 1 sample sees "already matched" and won't re-fire unless
  // a HIGH→LOW dip rearms (via _rasterCompMidLineDip).
  _fireRasterIrqMidLine() {
    if (this._lastRasterMatch) return; // already fired this line
    const wasAsserted = (this.irqStatus & 0x80) !== 0;
    this.irqStatus |= 0x01;
    this._lastRasterMatch = true;
    if (this.irqMask & 0x01) {
      this.irqStatus |= 0x80;
      this.irqHandler(true);
      if (this.frameTraceEnabled && !wasAsserted) {
        this._irqAssertionsCurrent.push({
          raster: this.raster,
          cycleInLine: this.cycleInLine,
          totalCycles: this.totalCycles,
          source: 'midline',
        });
      }
    }
  }

  _checkRasterIrq() {
    const targetRaster = this.regs[0x12] | ((this.regs[0x11] & 0x80) << 1);
    const match = (this.raster === targetRaster);
    // VIC-Addendum.txt: edge-triggered. The latch fires on a LOW→HIGH
    // transition of the comparator. From the per-line sample's POV that
    // is true if either the previous sample was LOW, or a CPU write
    // dipped the comparator since the last sample (so a HIGH at this
    // sample is a fresh rising edge even though the previous sample was
    // already HIGH).
    const fired = match && (!this._lastRasterMatch || this._rasterCompMidLineDip);
    this._lastRasterMatch = match;
    this._rasterCompMidLineDip = false;
    if (!fired) return;
    const wasAsserted = (this.irqStatus & 0x80) !== 0;
    this.irqStatus |= 0x01;
    if (this.irqMask & 0x01) {
      this.irqStatus |= 0x80;
      this.irqHandler(true);
      if (this.frameTraceEnabled && !wasAsserted) {
        this._irqAssertionsCurrent.push({
          raster: this.raster,
          cycleInLine: this.cycleInLine,
          totalCycles: this.totalCycles,
        });
      }
    }
  }

  // Raw sprite X-coordinate of the rule-4 / cycle-58 display turn-on point.
  // Bauer §3.8.1 note: "as long as the sprite is not positioned to the right
  // of sprite X coordinate $164 (cycle 58)". Empirically (VICE-6569 raw fb of
  // demusinterruptus) the emitted garbage byte begins one pixel earlier, at
  // raw X $163. Canvas X = raw X + 8.
  static get _SPRITE_BG_GARBAGE_RAW_X() { return 0x163; }


  // Blit frame buffer to canvas context. The ImageData WRAPS frameBuffer's
  // backing store (frameBuffer is allocated once in the constructor and never
  // reassigned), so renderer writes are already visible through
  // imageData.data — no per-frame copy needed before putImageData.
  blit(ctx) {
    if (!this.imageData) {
      this.imageData = new ImageData(this.frameBuffer, CANVAS_W, CANVAS_H);
    }
    ctx.putImageData(this.imageData, 0, 0);
  }

  reset() {
    this.raster = 0;
    this.cycleInLine = 0;
    // Pending FF entries embed `latchTotalCycles` as `totalCycles + N`, and
    // `_evaluatePendingTransitions` compares against the live counter — so
    // the queue and the counter must be cleared together. Same for the
    // frame-trace shadows, whose entries snapshot `totalCycles` at capture.
    this.totalCycles = 0;
    this._pendingFFTransitions.length = 0;
    this._ffCount = 0;
    this.irqStatus = 0;
    this.irqMask = 0;
    this._lastRasterMatch = false;
    this.vBorderActive = true;
    this._vBorderLatch = true;
    this.hBorderActive = true;
    this.baLow = false;
    this.aecLow = false;
    this.spriteBaLowOnly = false;
    this._cselComparator = 1;
    this._lastCselChangeRaster = -1;
    this._lastCselChangeCycle = -1;
    this._lastCselChangeFrom = 1;
    this._lastCselChangeTo = 1;
    this._d012WritesCurrent.length = 0;
    this._d011WritesCurrent.length = 0;
    this._d01AWritesCurrent.length = 0;
    this._d017WritesCurrent.length = 0;
    this._d018WritesCurrent.length = 0;
    this._d016WritesCurrent.length = 0;
    this._irqAssertionsCurrent.length = 0;
    this._irqAcceptsCurrent.length = 0;
    this.currentVicBank = this.cia2 ? this.cia2.vicBank : 0;
    this._pendingBankApplyCycle = -1;
    this._pendingBankValue = 0;
    this.displayEnabled = false;
    this._resetTextState();
    this._clearFetchedRowState();
    this._clearSpriteFetchState();
    this._clearCycleState();
    // prevLineExternalBaLow is no longer cleared by _clearCycleState (it is
    // historical, not per-cycle state). Explicitly zero it on hard reset.
    this.prevLineExternalBaLow.fill(0);
    this.regs.fill(0);
    this.regs[0x11] = 0x1B;
    this.regs[0x16] = 0xC8;
    this.regs[0x18] = 0x14;
    this.regs[0x20] = 0x0E;
    this.regs[0x21] = 0x06;
    // rowFetchD0xx must mirror the post-reset register defaults — capturing
    // them BEFORE the regs.fill(0) + writes above leaked the previous run's
    // pre-reset values into the row-fetch latch, breaking the very first
    // line after reset.
    this.rowFetchD011 = this.regs[0x11];
    this.rowFetchD016 = this.regs[0x16];
    this.rowFetchD018 = this.regs[0x18];
    // Per-frame / per-line phase latches. Leaving these set across reset
    // can leave the next frame stuck in "line just ended" raster-shift
    // mode, latch a stale raster-IRQ dip, or refuse to latch the lightpen
    // because the previous frame already did.
    this._lineJustEnded = false;
    this._rasterCompMidLineDip = false;
    this._lpLatchedThisFrame = false;
    // Bus latch + last-cycle marker. The latch resets to $FF at the
    // start of every clock() iteration anyway, but a fresh reset()
    // starts CPU code from cold and we shouldn't carry over stale
    // bus state from the previous run.
    this.vicInternalBus = 0xFF;
    this._thisCycleInLine = undefined;
    // Visible/collision buffers persist across frames; if reset happens
    // mid-frame they retain stale pixels from the prior session. Clear
    // them so a freshly-reset chip starts with a clean canvas.
    this.fb32.fill(0);
    this.graphicsPriorityBuffer.fill(0);  // shared collision/priority store (#2)
    this.spriteCollisionBuffer.fill(0);
    this.spriteOwnerBuffer.fill(0xFF);
    this.spriteVisibleBuffer.fill(0);
    this.borderBuffer.fill(0);
    this.vc = 0;
    this.vcBase = 0;
    this.vmli = 0;
    this.rc = 0;
    this.spriteDataBase.fill(0);
    this.spriteDataBank.fill(0);
    this.spriteDmaOn.fill(0);
    this.spriteDisplayOn.fill(0);
    this.spriteStartPending.fill(0);
    this.spriteStopPending.fill(0);
    this.spritePointerFresh.fill(0);
    this.spriteMC.fill(0);
    this.spriteMCBase.fill(0);
    this.spriteYExpandFF.fill(0);
    this._sprSnapVersion++;   // capture-dedup: sprite source reset
    this._rowSnapVersion++;
    this._spriteCrunchPending.fill(0);
    this._spritePCyclePhi2Bus.fill(0xFF);
    this._spritePCyclePhi2BusValid.fill(0);
    this._spriteSCyclePhi1Ghost.fill(0xFF);
    this._spriteSCyclePhi1GhostValid.fill(0);
    this._c56MxYESnapshot = 0;
    this.spriteLineDataRow.fill(-1);
    this.lastSpriteEndRaster.fill(-1);
    this.lastSpriteEndPtr.fill(0);
    this.lastSpriteEndRow.fill(-1);
    this.lastSpriteEndShiftReg.fill(0);
    this.lastSpriteEndMask.fill(0);
  }

  // ── Save-state ──────────────────────────────────────────────────────────
  // Captures the VIC state that persists across raster lines/frames, plus the
  // current framebuffer (so the restored frame is visible immediately) and the
  // in-progress row fetch (so the line being drawn at save time renders
  // correctly). The per-cycle scratch arrays (lineCycle*) are NOT captured —
  // they are rebuilt as each line is rendered. The chip VARIANT is applied
  // separately by the machine, and the large debug frameTrace* maps are
  // excluded (debug-only). A snapshot restored mid-frame may show a one-frame
  // seam; the next full frame is exact.
  serialize() {
    // Tier-3 line-batch: a mid-line save must not capture a framebuffer
    // missing the current line's deferred segments (fb32 is serialized but
    // the lineCycle* capture arrays are not). Replaying first makes the
    // state canonical — identical to what live rendering would have painted.
    if (this._lineDeferred) this._catchUpDeferredLine();
    const cp = (a) => a.slice();
    return {
      regs: cp(this.regs),
      raster: this.raster, cycleInLine: this.cycleInLine,
      totalCycles: this.totalCycles, _lineJustEnded: this._lineJustEnded,
      vc: this.vc, vcBase: this.vcBase, rc: this.rc, vmli: this.vmli,
      displayActive: this.displayActive, displayEnabled: this.displayEnabled,
      vBorderActive: this.vBorderActive, _vBorderLatch: this._vBorderLatch,
      hBorderActive: this.hBorderActive,
      irqStatus: this.irqStatus, irqMask: this.irqMask,
      currentVicBank: this.currentVicBank, lastRefreshAddr: this.lastRefreshAddr,
      lineBadLineDisplayPending: this.lineBadLineDisplayPending,
      lineBadLineStartCycle: this.lineBadLineStartCycle,
      lineMatrixFetchCol: this.lineMatrixFetchCol,
      _cselComparator: this._cselComparator,
      vicInternalBus: this.vicInternalBus,
      _vspGlitchGCycle: this._vspGlitchGCycle,
      // sprite state (persists line-to-line)
      spriteMC: cp(this.spriteMC), spriteMCBase: cp(this.spriteMCBase),
      spriteYExpandFF: cp(this.spriteYExpandFF),
      spriteDmaOn: cp(this.spriteDmaOn), spriteDisplayOn: cp(this.spriteDisplayOn),
      spritePointerValue: cp(this.spritePointerValue), spritePointerFresh: cp(this.spritePointerFresh),
      spriteDataBase: cp(this.spriteDataBase), spriteDataBank: cp(this.spriteDataBank),
      spriteLineDataRow: cp(this.spriteLineDataRow),
      spriteStartPending: cp(this.spriteStartPending), spriteStopPending: cp(this.spriteStopPending),
      // internal pipeline / bad-line / raster-compare state
      _prevBadLineCondition: this._prevBadLineCondition,
      _lineBadLineLatch: this._lineBadLineLatch,
      _rcResetDoneThisLine: this._rcResetDoneThisLine,
      _lastRasterMatch: this._lastRasterMatch,
      _rasterCompMidLineDip: this._rasterCompMidLineDip,
      baLow: this.baLow, aecLow: this.aecLow, spriteBaLowOnly: this.spriteBaLowOnly,
      _cycleRenderActiveCanvasY: this._cycleRenderActiveCanvasY,
      _pendingFFTransitions: this._pendingFFTransitions.slice(0, this._ffCount).map(p => ({
        kind: p.kind, detectCycle: p.detectCycle, detectRaster: p.detectRaster,
        latchTotalCycles: p.latchTotalCycles, cselAtFire: p.cselAtFire,
        raster: p.raster, vetoable: p.vetoable,
      })),
      // collision pipeline
      _collPipeE: [...this._collPipeE], _collPipeF: [...this._collPipeF],
      _collLateE: [...this._collLateE], _collLateF: [...this._collLateF],
      _deferCollisionCommit: this._deferCollisionCommit,
      // light pen
      _lpInputLevel: this._lpInputLevel, _lpLatchedThisFrame: this._lpLatchedThisFrame,
      // current row fetch (in-progress line)
      rowScreenCodes: cp(this.rowScreenCodes), rowColorNibbles: cp(this.rowColorNibbles),
      rowFetchedCols: cp(this.rowFetchedCols), rowVcBase: this.rowVcBase,
      rowFetchD011: this.rowFetchD011, rowFetchD016: this.rowFetchD016, rowFetchD018: this.rowFetchD018,
      // framebuffer (Uint32Array copy)
      fb32: this.fb32.slice(),
    };
  }

  deserialize(s) {
    this._lineDeferred = false;   // saved states are canonical (see serialize)
    this.regs.set(s.regs);
    this.raster = s.raster | 0; this.cycleInLine = s.cycleInLine | 0;
    this.totalCycles = s.totalCycles | 0; this._lineJustEnded = !!s._lineJustEnded;
    this.vc = s.vc | 0; this.vcBase = s.vcBase | 0; this.rc = s.rc | 0; this.vmli = s.vmli | 0;
    this.displayActive = !!s.displayActive; this.displayEnabled = !!s.displayEnabled;
    this.vBorderActive = !!s.vBorderActive; this._vBorderLatch = !!s._vBorderLatch;
    this.hBorderActive = !!s.hBorderActive;
    this.irqStatus = s.irqStatus | 0; this.irqMask = s.irqMask | 0;
    this.currentVicBank = s.currentVicBank | 0; this.lastRefreshAddr = s.lastRefreshAddr | 0;
    this.lineBadLineDisplayPending = !!s.lineBadLineDisplayPending;
    this.lineBadLineStartCycle = s.lineBadLineStartCycle | 0;
    this.lineMatrixFetchCol = s.lineMatrixFetchCol | 0;
    this._cselComparator = s._cselComparator | 0;
    this.vicInternalBus = s.vicInternalBus & 0xFF;
    this._vspGlitchGCycle = (s._vspGlitchGCycle ?? -1) | 0;
    this.spriteMC.set(s.spriteMC); this.spriteMCBase.set(s.spriteMCBase);
    this.spriteYExpandFF.set(s.spriteYExpandFF);
    this.spriteDmaOn.set(s.spriteDmaOn); this.spriteDisplayOn.set(s.spriteDisplayOn);
    this.spritePointerValue.set(s.spritePointerValue); this.spritePointerFresh.set(s.spritePointerFresh);
    this.spriteDataBase.set(s.spriteDataBase); this.spriteDataBank.set(s.spriteDataBank);
    this.spriteLineDataRow.set(s.spriteLineDataRow);
    this.spriteStartPending.set(s.spriteStartPending); this.spriteStopPending.set(s.spriteStopPending);
    this._prevBadLineCondition = !!s._prevBadLineCondition;
    this._lineBadLineLatch = !!s._lineBadLineLatch;
    // Accept the legacy key so pre-rename .c64state saves keep loading.
    this._rcResetDoneThisLine = !!(s._rcResetDoneThisLine ?? s._lineYCounterResetChecked);
    this._lastRasterMatch = !!s._lastRasterMatch;
    this._rasterCompMidLineDip = !!s._rasterCompMidLineDip;
    this.baLow = !!s.baLow; this.aecLow = !!s.aecLow; this.spriteBaLowOnly = !!s.spriteBaLowOnly;
    this._cycleRenderActiveCanvasY = s._cycleRenderActiveCanvasY ?? -1;
    this._pendingFFTransitions = (s._pendingFFTransitions || []).map(p => ({ ...p }));
    this._ffCount = this._pendingFFTransitions.length;
    this._collPipeE = [...(s._collPipeE || [0, 0])]; this._collPipeF = [...(s._collPipeF || [0, 0])];
    this._collLateE = [...(s._collLateE || [0, 0])]; this._collLateF = [...(s._collLateF || [0, 0])];
    this._deferCollisionCommit = !!s._deferCollisionCommit;
    this._lpInputLevel = s._lpInputLevel; this._lpLatchedThisFrame = !!s._lpLatchedThisFrame;
    this.rowScreenCodes.set(s.rowScreenCodes); this.rowColorNibbles.set(s.rowColorNibbles);
    this.rowFetchedCols.set(s.rowFetchedCols); this.rowVcBase = s.rowVcBase | 0;
    this.rowFetchD011 = s.rowFetchD011 | 0; this.rowFetchD016 = s.rowFetchD016 | 0; this.rowFetchD018 = s.rowFetchD018 | 0;
    if (s.fb32) this.fb32.set(s.fb32);
  }
}

// ── Partial-class assembly ────────────────────────────────────────────────
// Install the sibling files' method groups with class-method semantics
// (non-enumerable, writable, configurable) — one flat prototype, so cross-
// group `this._x()` dispatch is exactly as if declared in the class body.
for (const ops of [lineOps, spriteOps, renderOps]) {
  for (const name of Object.keys(ops)) {
    if (Object.prototype.hasOwnProperty.call(VIC2.prototype, name)) {
      throw new Error(`VIC2 split: duplicate method ${name}`);
    }
    Object.defineProperty(VIC2.prototype, name, {
      value: ops[name], writable: true, configurable: true, enumerable: false,
    });
  }
}
