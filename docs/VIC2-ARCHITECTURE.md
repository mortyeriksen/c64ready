<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->

# VIC-II (`src/vic2*.js`): Architecture Overview

How the MOS 6569 VIC-II emulation is structured: timing model, display/bad-line
state machine, sprites, collisions, borders, interrupts, rendering pipeline,
chip variants and performance gates. It describes *the implementation* and
names the real methods and fields, so it doubles as a guide into the source.

The chip is one `VIC2` class (~7k lines) split across five files; each sibling
installs its method group onto `VIC2.prototype` (partial-class assembly note at
the bottom of `vic2.js`), so every method below is reachable from the one class:

| File | Contents |
|------|----------|
| `vic2.js` | chip state + constructor, `clock()`/`phi2()`, register read/write, VIC bus fetches + banking, IRQ line, lightpen, frame trace, reset, save-state |
| `vic2-tables.js` | colour palettes + `PALETTE_RGBA`, canvas/display geometry, PAL timing, sprite p/s-access cycle tables |
| `vic2-line.js` | per-cycle state capture, cycle segment builders, display & text-window state, bad-line sequencing, DRAM refresh, border flip-flops |
| `vic2-sprites.js` | sprite DMA + MC/MCBASE bookkeeping, p/s-access fetches, sprite BA/AEC, per-cycle sequencer events, sprite rendering, collision pipeline |
| `vic2-render.js` | graphics rendering (text/bitmap/idle modes), XSCROLL/border edges, incremental render + deferred line replay, end-of-line fixups |

Hardware behaviour follows Christian Bauer's *"The MOS 6567/6569 video
controller (VIC-II)"* ([cebix.net/VIC-Article.txt](https://www.cebix.net/VIC-Article.txt))
and the community *VIC-Addendum* ([VICE techdocs](https://sourceforge.net/p/vice-emu/code/HEAD/tree/techdocs/VICII/VIC-Addendum.txt));
"§3.7.2 rule 3"-style references here and in code comments are Bauer sections.

> Scope: **PAL 6569 only** (63 cycles/line, 312 lines/frame); NTSC is
> deliberately out of scope. Two PAL revisions, `6569` and `8565`, are
> selectable at runtime (§12).

---

## 1. Big picture

`machine._runMasterCycle()` drives the VIC one master cycle at a time; a PAL
frame is `312 × 63 = 19656` cycles. The chip:

1. **Reads memory** it does not own: it shares the bus with the 6510 and steals
   cycles (asserting `BA`/`AEC`) for bad-line character fetches and sprite data.
2. **Runs a display state machine** (VC, VMLI, RC) deciding per cycle whether it
   is fetching the character matrix.
3. **Renders pixels** into a `384 × 272` RGBA framebuffer (`fb32`): the full PAL
   visible area, 320×200 active display plus border.
4. **Raises interrupts** (raster compare, two collision types, light-pen) on a
   shared IRQ line to the CPU.

The renderer is **cycle-incremental**: each cycle paints its own ~8-pixel slice
as the beam passes, so a mid-line CPU read of the collision registers sees
cycle-accurate state. That is what makes timing-critical demos (FLI, VSP,
sprite multiplexers, stable rasters) reproduce.

```
                 ┌───────────────────────────────────────┐
  CPU $D000-$D3FF│ register file  regs[0x40]             │
  ───────────────▶ read()/write()  + per-cycle snapshots │
                 │ lineCycleRegs[cycle]                  │
                 └───────────┬───────────────────────────┘
                             │ clock(1) per master cycle
              ┌──────────────▼────────────────────┐
              │ display state machine             │  VC / VCBASE / VMLI / RC
              │ bad-line logic                    │  displayActive, displayEnabled
              │ sprite DMA + sequencer            │  spriteDmaOn / spriteDisplayOn
              │ border flip-flops (H + V)         │  hBorderActive / vBorderActive
              └──────────────┬────────────────────┘
                             │ per-cycle segment
              ┌──────────────▼────────────────────┐
              │ renderer                          │  graphics + sprites + border
              │ _renderCycleSegmentGraphics       │  → fb32 (RGBA framebuffer)
              │ _renderSpriteSegmentForSprite     │  → collision/owner buffers
              │ _fixupColumns / _recolorBorderRow │
              └───────────────────────────────────┘
```

---

## 2. Timing model & master-cycle ordering

### Constants (top of file)
- `CYCLES_PER_LINE = 63`, `LINES_PER_FRAME = 312`, `CYCLES_PER_FRAME = 19656`.
- `CANVAS_W = 384`, `CANVAS_H = 272`. Active display at canvas `(32,36)`,
  `320×200`; graphics window X is `[32, 352)` (`GRAPHICS_WINDOW_START/END`).
- Canvas row = `raster - 15` (the first 15 lines fall above the visible crop).
  VICE PNGs are cropped one row differently: the recurring "row0 = raster16"
  gotcha in the test suite.

### phi1 / phi2 within one cycle
Hardware runs the **VIC during phi1** and the **CPU during phi2**.
`machine._runMasterCycle()` orders strictly:

```
_masterPhase = 'vic'      → vic2.clock(1)     // VIC phi1 logic, reads pre-CPU regs
              'cia'        → cia1/cia2.clock(1)
              'cpu'        → cpu.clock()        // CPU phi2: register writes land here
              'vic-phi2'   → vic2.phi2()        // VIC reconciles same-cycle CPU writes
              'cia-post'   → datasette, end-of-cycle
```

So **a CPU write on cycle N is not visible to VIC phi1 logic until cycle N+1**,
which is why much VIC logic is split between `clock()` (phi1) and `phi2()`:
- **Cycle-58 bad-line sample** (§3.7.2 rule 5): `clock()` samples the condition
  at phi1 into `_cycle58BadLineSample`; the idle→display transition
  (`_advanceDisplayStateCycle58`) runs in `phi2()`, so a *same-cycle* `$D011`
  write is correctly not seen while a cycle-57 write is.
- **Cycle-56 Y-expand FF** (§3.8.1 rule 3): the inversion runs at phi1 in
  `_spriteSequencerCycle56()`; `phi2()` folds in a same-cycle `$D017` write
  (level-sensitive `MxYE=0` force only; a phi2 *set* is too late to invert).

### CPU-visible raster lag
`raster` increments at cycle 63→0 (phi1, inside `clock()`), but a CPU read of
`$D011`/`$D012` in the boundary cycle must still see the **old** raster.
`_lineJustEnded` is a one-shot set at the wrap, consumed by
`_cpuVisibleRaster()` / `_cpuVisibleRasterAndCycleForWrite()`, cleared by
`phi2()` after the CPU step. The **raster-compare** edge detector uses the *true*
`this.raster` (the comparator is wired to the internal counter), so the two
paths deliberately disagree at the boundary.

---

## 3. Register file & CPU access

`regs` is the `0x40`-byte bank; `read(reg)` / `write(reg, val)` are the CPU
entry points and both update `vicInternalBus` (§13).

`_readRegRaw()` models the unconnected/partial registers:
- `$D02F-$D03F` read `$FF`.
- `$D016` bits 6-7, `$D018` bit 0, `$D019`/`$D01A` high bits, and the high
  nibble of `$D020-$D02E` read as 1.
- `$D011` bit 7 = raster bit 8, `$D012` = raster low 8, both via
  `_cpuVisibleRaster()`.
- **`$D01E`/`$D01F` reads clear the register** *and* the in-flight collision
  pipeline, phi-resolved (§10).

Timing tricks in `write()`:
- **`$D016` CSEL changes** are logged (`_lastCselChange*`) for the border
  comparator veto window (§9).
- **`$D011`/`$D012` raster compare is edge-triggered** (VIC-Addendum): the IRQ
  latches on the *rising* edge of `raster == target`. A HIGH→LOW dip arms
  `_rasterCompMidLineDip`; a LOW→HIGH write fires immediately
  (`_fireRasterIrqMidLine`), the OrbitUntold chained-IRQ mechanism. A
  `$D012`-follows-raster loop holds the comparator HIGH: no edge, no IRQ.
- **Late-line `$D011` YSCROLL → bad-line recovery** (raster_time_gp permanent
  bad-line trick): a write at cy 59-62 producing a fresh bad-line condition
  re-activates `displayActive` synchronously.
- **8565 grey-dot**: same-value `$D02x` writes are recorded (`_greyDotXs`) and
  overlaid at line end.

---

## 4. Memory access & VIC bank

VIC sees a 16 KB window selected by CIA2 port A (`currentVicBank`). Helpers:
`_vicBusRead` / `_vicRead` / `_vicReadWithBank` (char-ROM shadow at
`$1000-$1FFF` and `$9000-$9FFF` of each bank), and `_vicMemRead`, a
*non-bus-driving* peek the renderer uses to re-read g-bytes. Silicon latched
them at g-access time; re-fetching at render time is an emulator convenience
and must **not** disturb the open bus.

**Ultimax**: PLA table A.11 maps the upper 4 KB of active cartridge ROMH into
the VIC's local `$3000-$3FFF` window regardless of the CIA bank, while local
`$1000` reads DRAM instead of character ROM. `_vicMemRead` applies this to live
fetches and renderer peeks alike; freezers such as Action Replay and Final
Cartridge III use the ROMH window for their freeze code/display.

`noteBankChange(bank, delay)` applies a bank change with a 1-cycle pipeline
delay (visible to the next cycle's fetches). Two opt-in quirks, both default off:
- `nmosBankDelay` (6569): an extra-cycle delay when a CIA2 DDRA write turns a
  pin to output (the addendum calls it "unstable").
- `c64cBankGlitch` (8565): a 1-cycle blip through bank 3 on PA0/PA1 10↔01
  transitions.

**Refresh** (`_advanceRefreshAccess`, cycles 11-15): five DRAM-refresh accesses
walk `refreshCounter` down from `$FF`; with `vicRefreshDrivesBus` set they drive
the bus (open-I/O torture tests).

---

## 5. Display state machine: VC / VCBASE / VMLI / RC

Bauer's four counters (§3.7.2):

| Field | Meaning |
|-------|---------|
| `vcBase` | video counter base, reloaded from VC at cy 58 when RC=7; reset to 0 at top of frame |
| `vc` | video counter (which matrix cell), loaded from `vcBase` at cy 14 |
| `vmli` | video-matrix line index (0..39), the c-access write column |
| `rc` | row counter (0..7), pixel row within a character; reset to 0 at cy 14 on a bad line |

Two states, **idle** vs **display** (`displayActive`):
- **idle→display** "as soon as there is a Bad Line Condition" (§3.7.1): caught at
  cy 14 phi1 (`_advanceDisplayStateCycle14`) in the canonical case, or mid-line
  by `_onBadLineConditionEdge`.
- **display→idle** "in cycle 58 if RC=7 and there is no Bad Line Condition"
  (§3.7.2 rule 5, at phi2 in `_advanceDisplayStateCycle58`).

`displayEnabled` is the **latched DEN**: DEN set during *any* cycle of raster
`$30` enables bad lines for the whole frame (latched in `clock()` at raster $30
and at the `$30→$31` phi2 boundary). `_isBadLine` reads it, not the live bit.

The matrix line buffer (`rowScreenCodes`/`rowColorNibbles`/`rowFetchedCols` and
their per-cycle snapshots) is **retained across lines and frames**; only
c-accesses write it. A display row entered via a cy-58 idle→display transition
with no bad line shows the *previously* fetched codes (testprogs
`sequencer-bug`), so `_beginRasterLine` deliberately does not wipe it at the
frame boundary.

---

## 6. Bad lines

A **Bad Line Condition** (`_isBadLine`):

```
displayEnabled  AND  raster in [$30, $F7]  AND  (raster & 7) == (D011 & 7)   // YSCROLL
```

On a bad line the VIC steals 40+ cycles to fetch the character matrix:

- **Edge detection** (`_updateBadLineStateForCycle`, cycles 1-54) re-evaluates
  the condition each cycle and fires `_onBadLineConditionEdge` on a transition
  (rising = arises, falling = ceases). The window starts at cy 1, not 12, so a
  condition raised and cancelled inside cy 1-11 still registers, needed for the
  DMA-delay/VSP trick where a 1-cycle YSCROLL pulse lands at cy 0-1.
- **c-access fetch queue** (`_queueBadLineFetchPhase` → `_beginBadLineFetchPhase`
  → `_runTextPhase2Access`): one c-access per cycle in **15-54** (column 39 at
  cy 54). `_fetchScreenRowColumn` reads screen RAM + color RAM into the line
  buffer and records `lineCycleCWriteCol`, the buffer index this c-access wrote
  (the late-transition column shift, §8).
- **BA/AEC**: `_isBadLineBaLow` drives BA low across the fetch window, stalling
  the CPU; AEC follows 3 cycles later (§3.6.1). The rising edge can also patch
  the trigger-cycle idle g-access to the **VSP glitch address** (`$38FF` on
  6569 / `$3807` on 8565), the §3.14.6 DMA-delay idle-byte glitch.

Tricks this reproduces, all under registered spec tests: mid-line bad-line
cancel (FPP scrollers), late forced bad lines (FLI), line crunch / sprite-crunch
interactions, VSP (`dmadelay`, `vsp-tester`), and the `fldscroll` "1 `$ff` char
on the right" cy-54 edge case.

---

## 7. Sprites

Eight sprites, each with a full DMA + display lifecycle and an independent
24-pixel sequencer.

### DMA lifecycle (§3.8.1)
Per-sprite state: `spriteDmaOn`, `spriteDisplayOn`, `spriteMC`, `spriteMCBase`,
`spriteYExpandFF`, `spriteLineDataRow`, plus start/stop pending flags.

| Cycle | Method | Action |
|-------|--------|--------|
| 15 | `_spriteSequencerCycle15` | no-op; sprite-crunch detection lives in the `$D017` write hook |
| 16 | `_spriteSequencerCycle16` | if Y-expand FF set: `MCBASE := MC` (rule 7), or the **sprite-crunch** interleave formula (rule 7a); then `MCBASE==63 → DMA off` |
| 55 | `_spriteSequencerCycle55` | DMA-start check (`_tryStartSpriteDma`): Y match → `DMA on`, `MC=MCBASE=0`, FF=1 |
| 56 | `_spriteSequencerCycle56` | 2nd DMA-start check; **FF inversion** if `MxYE=1` (rule 3), or force FF=1 if `MxYE=0` (rule 1) |
| 58 | `_spriteSequencerCycle58` | `MC := MCBASE`; **display on** iff DMA on + Y match + still enabled; DMA off → **display off** (`_endSpriteDisplayLine`) |

- The **display flip-flop is owned exclusively by cy 58 rule 4**; DMA start at
  cy 55/56 never touches it. This is the "restart on the last display line"
  trick (`spriterestart`, nine.prg maskers).
- **MxE re-check at cy 58**: DMA start (cy 55/56) and display turn-on (cy 58)
  read `$D015` independently, so a CPU rewrite between them lets DMA run (and
  steal cycles) while the sprite never displays (testprogs `spriteenable` cores
  1/2/4).
- **Late-DMA open-bus byte 0** (`_spriteByte0Floats`): a sprite enabled so late
  that only the cy-56 check catches it has not completed the BA→AEC lead-in by
  its byte-0 fetch, so that byte reads the floating bus (`$FF`). Only sprite 0
  can hit this.

### Sprite memory fetch
Pointer p-access + 3 data s-accesses per sprite, scheduled by the fixed
`SPRITE_PTR_ACCESS` / `SPRITE_ROW_ACCESS` tables. Sprite `BA`/`AEC` come from
`_spriteBaLow` / `_spriteAecLow` (a c-3 lookback that wraps across the line
boundary via `prevLineExternalBaLow`). With DMA **off**, the three buffer bytes
come from three distinct half-cycles (VIC-Addendum "sprite idle fetch"): byte 0
= p-cycle phi2 bus, byte 1 = `$3FFF` ghost access, byte 2 = s-cycle phi2 bus
(`_spritePCyclePhi2Bus`, `_spriteSCyclePhi1Ghost`, `spriteIdleFetchLeakEnabled`).

### Sprite rendering
`_renderSpriteSegmentForSprite` drives a per-sprite sequencer state
(`_createSpriteRenderState` / `_advanceSpriteSequencerState`) that persists
across cycle segments, so the incremental render resumes the shifter at the
exact X the previous cycle left off. `_spriteSequencerPixelInfo` resolves a
pixel: **hires** 1 bit/pixel, sprite color; **multicolor** (`$D01C`) 2 bits →
transparent / `$D025` / sprite color / `$D026`; **X-expand** (`$D01D`) doubles
`pixelsPerUnit`. `_drawSpritePixel` enforces **priority/inheritance** via
`spriteOwnerBuffer` (a pixel claimed by a lower-index sprite masks lower ones,
even when the higher one was hidden behind foreground) and
`graphicsPriorityBuffer` (the `$D01B` bit). `spriteVisibleBuffer` marks pixels
that actually reached output, so the column fixup (§8) doesn't pull a background
color through a visible sprite that happens to match the gfx RGBA.

Edge/variant passes: `_paintSpriteBoundaryGarbage` (the X=`$163/$164`
re-trigger garbage, `spriteBoundaryGarbage`, default on for VICE-6569 parity),
`_renderSpriteSameLineHighX` / `_renderSpriteEndOfLineWrap` (high-X / wrap).

---

## 8. The rendering pipeline

The renderer never renders "from registers now"; it renders from **per-cycle
register snapshots** taken at phi1 with staggered sampling offsets.

### Per-cycle capture
`_captureCycleState(cycle)` snapshots, per cycle of the line, the register file
(`lineCycleRegs[cycle]`), display/border flags, counters, the c-access write
column and the sprite state; the segment builders read these arrays. Capture is
deduped (§14).

### Segments and the register-snapshot pipeline
`_buildCycleRasterSegment(cycle)` produces one cycle's 8-pixel render segment.
Which snapshot each field samples matters, because VIC subsystems latch at
different points in the pixel pipeline:

| Field on `seg` | Snapshot | Why |
|----------------|----------|-----|
| `seg.regs` | cycle (+`regOffset`) | base / border color / XSCROLL |
| `seg.nextRegs` | +1 | `$D018` CB & bitmap base, sampled at the **g-access** cycle (§3.7.4) |
| `seg.modeRegs` | +1 default, **+2** via fixup | ECM/BMM/MCM take effect one char *earlier on screen* than CB |
| `seg.bgRegs` | live default, **+3** via fixup | `$D021-$D024` are **output-stage** (beam-timed, no 12px gfx-data delay) |

`regOffset` is `0` on 6569 and `-1` on 8565 (its extra pipeline cycle). The
incremental render can't read +2/+3 in time, so it renders with the +1 default
and the end-of-line **`_fixupColumns`** pass re-renders only the columns whose
mode (+2) or background-color (+3) window actually changed, merging the
corrected pixels; the merge is gated on `spriteVisibleBuffer` so it never
overwrites a visible sprite.

### Graphics modes (`_renderSourceColumn`)
All eight `ECM:BMM:MCM` combinations: standard text, multicolor text,
extended-background text, hires bitmap, multicolor bitmap, and the "invalid"
ECM+BMM / ECM+MCM modes that render black. Idle-state graphics
(`_renderOpenBorderIdleSpan`, `_fillSegmentBg0`) clock the `$3FFF`/`$39FF` idle
byte through the same sequencer with matrix data forced to 0 (§3.7.3.9).
`lineCycleCWriteCol` supplies the **column shift** for late idle→display
transitions (FLI / line crunch): VMLI lags the beam by the idle gap, so freshly
fetched columns are read shifted (`colorfetchbug`).

### XSCROLL edge filler (§3.7.3 shifter model)
Bauer's sequencer is an 8-bit shift register "reloaded with new graphics data
after each g-access", XSCROLL delaying the reload 0-7 pixels. Modelled
explicitly:

- **Line-start preload.** The first reload lands at canvas `32 + XSCROLL`;
  before it the shifter is empty (drained since the previous line's last
  g-access) and emits "0" bits, which take the mode's **idle background**:
  `$D021` in text modes, the adjacent column's matrix low nibble in standard
  bitmap (VICE-oracle-verified), **black** in the invalid modes and hires-bitmap
  idle. Display state handles this in `_renderCycleSegmentGraphics`
  (`isStdBitmap` / `isInvalidMode` filler gates), idle state via the cycle-15
  `_fillSegmentBg0` preload. With CSEL=0 the widened left border (canvas ≤38)
  covers the whole preload; nothing may leak into x≥39.
- **Drain zone.** Inside the line, each 8-pixel group's first XSCROLL pixels
  still shift out the **previous** g-access byte before the delayed reload. In
  idle state the segment carries both (`seg.idleByte` fetched at `regCycle+1`,
  `seg.idleBytePrev` one g-access earlier) and `_renderOpenBorderIdleSpan`
  switches source at `cycleStart + XSCROLL` (bit phase 0, so bit/pair indexing
  is continuous). Steady idle lines make the two identical; the split is
  observable only across a mid-line idle-fetch change (ECM flip, VIC bank
  switch, or a VSP glitch flipping the idle byte `$00↔$FF` at both screen
  edges). In display state the same continuity falls out of the column span
  math (`srcX` offsets).
- **Opened-right-border tail.** XSCROLL moves the whole 320-pixel stream, so its
  last XSCROLL pixels land at canvas `352..351+XSCROLL`. The right border
  normally overlays them; when the cycle-56 CSEL trick keeps the border open,
  `_renderRightXscrollSpill` exposes the tail using the final display column's
  fetch/mode snapshot before the side zone settles to its empty-shifter
  background.

### Border re-color
Borders are painted on the **X-coordinate timeline** at line end by
`_recolorBorderRow` (incremental path), when the whole line's `$D020` history
is known, matching the border color's output-stage nature. Lines where `$D020`
never changes skip the pass (repainting every border pixel its existing color
is a provable no-op); a per-line latch `_d020WrittenThisLine`, armed only by a
value-changing write and sharing the grey-dot scratch's lifecycle, gates it.

---

## 9. Borders & flip-flops (§3.9)

- **Vertical border FF** (`vBorderActive`, `_advanceVerticalBorderFlipFlop`): a
  two-stage set/latch run every cycle. Bottom compare arms the latch; top
  compare + DEN opens it; cy 1 copies the latch into the live FF. Compare lines:
  RSEL=1 → 51/251, RSEL=0 → 55/247. Rule 4 (left-compare close on the same
  line) is the sole discriminator for the `vborder2-35/36` cycle-exact case.
- **Horizontal/main border FF** (`hBorderActive`, `_advanceHorizontalBorderState`):
  right-edge SET / left-edge RESET comparators, gated on the vertical FF.

The §3.14.1 **hyperscreen veto**: a right-edge SET pulse sits in a pre-FF latch
for 1-2 cycles, and a `$D016` CSEL write within that window that moves the
compare retroactively cancels it. Modelled as a **pending FF-transition queue**
(`_pendingFFTransitions`, evaluated at phi1 of the latch cycle by
`_evaluatePendingTransitions`); on invalidation `_vetoFFTransition` rewinds FF
state and re-renders the affected cycles (saving/restoring the sprite-line
snapshot so a re-render doesn't double-count). Segments straddling a border
edge are split by `_splitRasterSegmentAtBorderEdges`.

The queue is allocation-free by design: entries are **pooled** (rented from a
free-list by `_rentFFEntry`, which resets them to safe defaults so no field
leaks across the `hRightSet`/`hLeftReset` kinds, recycled on drain) and the
queue is a **stable-capacity array with a manual `_ffCount`**.
`_evaluatePendingTransitions` compacts in place over `[0, _ffCount)` and never
does `q.length = w`: the border pushes ~2 transitions per line (~500/frame)
that drain within ~3 cycles, and oscillating the length to 0 each line made V8
right-trim and reallocate the backing store every raster line, the dominant
idle allocation. A drained slot keeps its recycled entry with `kind` blanked
(scans and serialize skip it; the FF is never >1-deep, so a kept entry is never
slid over a live slot). The churn is invisible on V8 (escape analysis) but real
on JavaScriptCore/mobile; see the [performance doc](PERFORMANCE-ANALYSIS.md).

---

## 10. Collisions (§3.8.2, §3.12)

Per-pixel detection during the sprite render (`_processSpritePixelCollision`):
- **Sprite-sprite (`$D01E`)**: `_latchSpriteSpriteCollision` ORs the writing
  sprite's bit into `spriteCollisionBuffer[pixel]`; if another sprite already
  marked that pixel, both bits commit.
- **Sprite-background (`$D01F`)**: `_latchSpriteBackgroundCollision` fires on a
  *foreground* graphics pixel (`graphicsCollisionBuffer`).

Both feed a **2-cycle visibility pipeline** (`_collPipeE`/`_collPipeF`, drained
by `_drainSpriteCollisionCommit` once per cycle *before* the CPU step): the 6569
makes a collision CPU-readable ~2 cycles after the pixel. Each stage also
tracks a **phi2-half** subset (`_collLateE`/`_collLateF`, the late 4px of the
cycle), so a `$D01E`/`$D01F` read clears the elapsed stage and the phi1-half
but *retains* the current stage's phi2-half, letting a back-to-back double read
still catch the read-cycle's late pixels (`spritevssprite`). The register
update (`_applySpriteSpriteBits` / `_applySpriteBgBits`) raises IMMC/IMBC only
on the `0 → non-zero` transition (§3.12). The pipeline **persists across raster
lines** (registers are sticky until read), so `_initRenderRasterLine` must not
clear it.

**Final-row gap** (`spritegap3`): a sprite whose X is reached after the cycle-58
display-FF drop shows nothing on its last line, so two such sprites do not
collide there. `_offCanvasSpriteSpriteCollision` erases the latched row and
restarts collision at a sprite-slot-dependent X in the right border.

### Known-open sprite deviations

All reviewed, demo-neutral, left unfixed. Pixel counts are the real diff against
each testprog's 6569 reference (one-row crop offset excluded).

| Testprog | Status |
|----------|--------|
| `spritex` `testsuite` | 2/28 fail (7, 14): mid-line `$D000` sprite-X comparator latch |
| `spritegap` `gap2` | only PAL reference is 8565R2, whose double gap (`$170` on, `$173`+(m−1)·`$10` off, `$17f`+(m−1)·`$10` on) is unmodelled; `gap3` passes |
| `split-tests/spritescan` | 307 byte diffs, all at raw X ≥ `$14c`: sprite-sprite collision in the border/wrap zone |
| `spritesplit` | 16/17 diverge, 264–2200 px: mid-sprite sub-cycle register split; `ss-xpos` is exact |
| `spritebug` 104/105/106 | 4 / 4 / 12 px: mid-sprite `$D01D` X-expand sub-cycle |
| `sb_sprite_fetch` 163/164 | 163 exact; 164 leaves 12 px on one row: high-X display-end turn-off |
| `spritefetchbug` | 270 px: high-X X-expanded multicolor fetch tail |

> One deliberate deviation: a DMA-start clears the sprite shift register, as a
> bleed-avoidance shortcut. Bauer §3.8.1 says it should survive; it does for the
> same-line X≥`$164` case `sb_sprite_fetch` exercises
> (`test/vic2-sprite-sb-fetch-spec-test.js`), not for ordinary sprites.

---

## 11. Interrupts & light-pen

`irqStatus` (`$D019`) / `irqMask` (`$D01A`), four sources:
- **bit 0, raster**: `_checkRasterIrq` at cy 1 (cy 2 for line 0), plus
  `_fireRasterIrqMidLine` for the immediate LOW→HIGH write case; edge-triggered
  comparator (§3).
- **bit 1, sprite-bg (IMBC)** and **bit 2, sprite-sprite (IMMC)**: from the
  collision commit path.
- **bit 3, light-pen** (`_latchLightpen`).

`irqHandler(asserted)` is the line to the CPU; `irqStatus` bit 7 is the "any
enabled source active" flag; `clearRasterIrq` / the `$D019` write path
acknowledge.

**Light-pen** (§3.11): negative-edge triggered on the LP pin
(`setLightpenLevel`, wired to CIA1 port-B bit 4 in `machine.js`); one trigger
per frame (`_lpLatchedThisFrame`, re-armed at frame start); `$D013`/`$D014`
latch LPX/LPY. An LP input held low across the frame boundary re-triggers at
L0 c1. The light-pen testprogs pass; only an R1 silicon quirk at the exact frame
boundary is unmodelled.

---

## 12. Chip variants

Selectable at runtime (the UI button cycles them, no machine reset):

| `vicVariant` | Model | Distinguishing behaviour |
|--------------|-------|--------------------------|
| `6569` | original PAL NMOS (breadbin) | baseline; `regOffset = 0` |
| `8565` | late PAL HMOS (C64C/C128) | **1-cycle register-pipeline delay** (`regOffset = -1`); grey-dot artifact on same-value `$D02x` writes; VSP glitch address `$3807` |

The setter caches `_is8565` / `_regOffset` / `_vspIdleGlitchAddr` as primitives
so the hot path tests a boolean instead of comparing strings. `regOffset`
shifts every segment-builder snapshot read by one cycle: that is the entire
8565 pipeline-delay model.

---

## 13. Open bus & the internal data bus

`vicInternalBus` is the VIC's data-bus latch: reset to `$FF` at the start of
each master cycle, driven by VIC RAM/char-ROM fetches and CPU `$D000-$D3FF`
accesses. It sources the **sprite idle fetch** leak and open-I/O behaviour. The
idle-fetch sample point is in `phi2()` (after the CPU step), so a same-cycle
`STA $D0xx` leaks before the next cycle's reset. Scope is `vic-registers-only`
by default; a full "every CPU bus cycle" model would need extra wiring in
`memory.js`.

---

## 14. Performance gates

Optimisations sit behind boolean gates, each proven byte-identical (orbit
framebuffer hash + the full spec suite + a dedicated equivalence test) and kept
flippable for A/B bisection:

- **`batchRender`**: `_fixupColumns` re-renders only the columns whose +2 mode /
  +3 bg-color window changed, not all 48 cycles twice.
- **`captureDedup`**: `_captureCycleState` aliases the previous cycle's
  row/sprite snapshot buffers (`_rowSnapVersion`/`_sprSnapVersion`) when the
  source is unchanged instead of re-copying ~10 typed arrays per visible cycle;
  `_home*` buffers decouple the slot pointer from the owned write buffer so
  aliasing is safe. `captureDedupVerify` adds a runtime cross-check.
- **`spriteSkipIdle`**: skips `_renderSpriteSegmentForSprite` for sprites
  neither displaying nor started this line (a provable no-op).
- **Scratch objects**: `_scratchRasterSeg`, `_scratchSpriteSeg`, split parts and
  per-pixel/cell return objects are reused in place.
- **`lineBatchRender`**: the Tier-3 line-batch renderer (below). Default
  **on**; `?LINE_BATCH=0` (browser) / `LINE_BATCH=0` (node) forces the per-cycle
  live path for A/B or triage.

### Line-batch rendering (Tier-3, `lineBatchRender`)

The per-cycle render pays a fixed dispatch/build/split tax on every cycle
regardless of content (~28% of frame time, content-independent to within ~6%
across raster_time_gp's scenes). Line-batch mode **defers pixel emission**:
state capture, FF evaluation, the collision-pipe drain and every patch-up's
*state* rewrite still run per cycle, but nothing paints; the line is replayed
in one burst through the *same* incremental machinery (`_catchUpDeferredLine`):

- **At line end** (the common case): graphics are emitted as **maximal uniform
  spans**, one wide segment per stretch of cycles whose captured inputs are
  identical (`_spanExtends`: regs-snapshot pointer equality over `[c-1..c+2]`,
  courtesy of `captureDedup` aliasing, plus idle-byte and per-cycle scalar
  equality). `_renderCycleSegmentGraphics` derives its columns from segment
  geometry, so widening `seg.end` is exact. Segments 15/53/54 stay solo (the
  CSEL border edges must remain single-edge per segment for the splitter).
  Sprites and the collision-pipe drains replay strictly cycle-by-cycle after
  the spans (order-safe: graphics never feeds the pipe; sprite paints are
  segment-bounded).
- **Immediately on a mid-line observer**, i.e. anything that would let the CPU
  see render-derived state: a `$D019/$D01E/$D01F` read, a `$D01A` write arming
  the collision IRQs (armed lines render live outright), a fetch-config change
  (`$D018` base bits, `$D011` BMM, VIC bank), a CPU write into the line's
  g-access RAM window, or `serialize()` (save-states stay canonical). The RAM
  case is a fetch watch armed in `memory.js`: the renderer re-reads glyph/bitmap
  bytes at paint time, and beam-racing charset animation would otherwise reach
  the replay ~40 cycles later than the live paints saw it.

**Contract:** byte-identical to the live path at every *CPU-observable* point
(register read values, IRQ timing, line-end framebuffer rows). Mid-line
framebuffer state is not part of the contract (no C64 program can read pixels
back); spec tests that assert per-cycle render internals pin
`lineBatchRender = false` and say why. `vic2-line-batch-spec-test.js` locksteps
live vs deferred machines through collision reads at the detection cycle,
same-cycle sprite-X writes, rasterbars, armed IRQs and mid-line serialize.

Verified: full suite green in both modes, orbit framebuffer hash and all 195
reference screenshots byte-identical, demo-status board parity. Measured (clean
interleaved A/B): **orbit −14.5%, raster_time_gp −25.8% ms/frame**; the win
scales with how quiet the content's lines are (a line with a mid-line write or
observer simply renders live; FLI-class content keeps the per-cycle cost).

---

## 15. Debug / trace facilities

All behind `frameTraceEnabled` (off by default, ~zero overhead when off; toggle
via `window.c64Trace`):
- Per-cycle border traces (`frameTraceHBorder`/`VBorder`).
- Per-line scalar snapshots of every interesting register (D011/D016/D015/
  D01C/D01D/D017/D01B/D010/D021/D012/D019/D01A/D020), sprite pointers,
  MC/MCBASE, Y-expand FF, sprite XY/colors, VIC bank, DMA/display state.
- Per-write logs for raster-IRQ-relevant registers + IRQ assertion/acceptance
  timestamps (interrupt latency across two snapshots).
- `_staleRowRenderHits`: a §3.7.1 invariant counter (renderer consuming row data
  while idle).

The project's private VICE-compare tooling (headless trace scripts, not in the
shipped tree) builds on these hooks.

---

## 16. Key invariants & gotchas (quick reference)

- **VIC acts before CPU**: phi1 logic in `clock()`, same-cycle CPU-write
  reconciliation in `phi2()`; a cycle-N write is visible to VIC at N+1.
- **The matrix line buffer is retained** across lines *and* frames, never wiped
  at the frame boundary.
- **Snapshot offsets**: background colors are output-stage (+3), mode bits +2,
  `$D018` CB / bitmap base +1 (g-access). Get them wrong and mid-line splits
  shift by a character.
- **Collisions are visible ~2 cycles late**, sticky across lines, cleared
  phi-resolved by a read (the read cycle's late half is retained).
- **`displayEnabled` ≠ live DEN**: latched from raster `$30`.
- **Don't reset sprite DMA/display at the frame boundary**: a sprite mid-display
  when raster wraps 311→0 carries into the next frame's top border.
- **Canvas row `r` = raster `r+15`**; VICE reference PNGs are cropped one row
  off (`row0 = raster16`), a recurring source of "1px" false diffs.
