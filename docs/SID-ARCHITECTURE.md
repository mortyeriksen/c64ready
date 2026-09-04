<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->

# SID 6581/8580 (`src/sid-voice.js` + `src/sid-worklet.js`): Architecture Overview

How the emulator synthesises sound: three voices (oscillator + waveform DAC +
ADSR envelope), the analog filter, the master-volume DAC / digi path, and the
two consumers of register state: the **audio-worklet ring** (what you hear) and
the **main-thread shadow voices** (what `$D41B`/`$D41C` reads return,
cycle-exact).

| File | Role |
|------|------|
| `src/sid-voice.js` | One `SIDVoice`: oscillator, waveform generator, noise LFSR, ADSR envelope, OSC3 readback, reSID R-2R DAC tables. Pure DSP, no I/O; shared by the worklet and the shadow. |
| `src/sid-wavetables.js` | reSID's measured combined-waveform tables (OSC3 chip samplings, embedded verbatim from the pinned upstream data; provenance in NOTICE.txt), checksum-pinned by `test/sid-wavetables-spec-test.js`. |
| `src/sid-filter.js` | reSID transistor-level filter / mixer / nonlinear volume stage (`filter8580new` port) and the integer external RC filter: the JS engine's analog chain and, via its Rust translation, the WASM engine's. |
| `src/sid-worklet.js` | `SIDChip` (3 voices + analog chain) and `SIDProcessor` (the `AudioWorkletProcessor`: SAB ring transport, SINC resampler, WASM block renderer). |
| `src/sid-wasm-blob.js` | GENERATED: the WASM engine (whole chip + resampler compiled from `rust/sid/`), embedded base64 because worklets have no `fetch`/`atob`. Rebuild: `sh rust/sid/build.sh`. |
| `rust/sid/` | Rust translation of the JS engine (voice core, filter, external filter, SINC resampler, event queue), compiled to `wasm32-unknown-unknown`; the corresponding source for the blob. |
| `src/machine.js` | `SIDProxy` (the `$D400-$D7FF` bus device, mirrored every 32 bytes), the ring producer `_sidWrite`, the shadow voices, paddle POT sample-and-hold, model sync. |

> Scope: a **PAL** 6581/**8580** SID. Goal is demo fidelity: correct combined
> waveforms, ring-mod/sync, `$D418` volume-DAC digis, ADSR timing matched to
> reSID/Lorenz test programs, and cycle-exact OSC3/ENV3 readback for demos that
> poll voice 3. Offline verification: §14.

---

## 1. Big picture

```
 MAIN THREAD                                       AUDIO WORKLET THREAD
 ───────────                                       ────────────────────
 CPU writes $D400-$D418
        │
        ▼
   Memory ──► SIDProxy.write(reg,val)  ($D400 page)
        │
        ├─► _sidWrite(reg,val)
        │      ├─ push {sidCycleCounter, reg|val<<8} ──► SAB ring ─┐
        │      └─ mirror reg → shadow v1/v2/v3 (write)             │
        │                                                          │
        │   _runMasterCycle()  (once per master cycle, ~985 kHz)   │
        │      ├─ shadow v1.clockPhaseOnly()  (sync/ring source)   │
        │      ├─ shadow v2.clockPhaseOnly()                       │
        │      └─ shadow v3.clockCore()+outputStageOsc3()          │
        │            └─ serves $D41B/$D41C                         ▼
   CPU reads $D41B/$D41C ◄── shadowV3.readOsc3() / .env3  SIDProcessor.process()
   CPU reads $D419/$D41A ◄── potX/Y S&H, gated (§11)       (128-sample blocks)
                                                           _drainRing → pend ring
                                                           _applyDueEvents (by stamp)
                                                           engine: resid | wasm
                                                                │
                                                                ▼
                                                    masterGain (user vol)
                                                     → AudioContext → speakers
```

Two consumers of the same register writes: the **player** (worklet; two
selectable engines, Options ▸ Sound ▸ `ENGINE`) and the **shadow** (always
main-thread JavaScript, never switches). They share bus writes and chip model
so readback and sound describe the same chip, and are split so demos get
zero-latency register truth without running the filter or the worklet on the
CPU hot path: demos poll OSC3/ENV3 in tight loops (NOISE RNG, sample-trigger
timing, raster sync, chip-model detection), and serving those reads from the
worklet would smear them across an audio block.

| | **Player (worklet)** | **Shadow SID (main thread)** |
|--|----------------------|------------------------------|
| **Where** | `SIDProcessor` / `SIDChip` in `sid-worklet.js`; WASM blob from `rust/sid/` | `shadowV1` / `shadowV2` / `shadowV3` in `machine.js` |
| **Input** | Cycle-stamped writes on the SharedArrayBuffer ring | Same writes, applied **immediately** |
| **Runs** | ~985 kHz SID clocks (or one WASM block render), then host-rate samples | Every master cycle, in lockstep with the CPU |
| **Does** | Full chip audio: voices + filter/mixer/volume + ext. RC + decimation | Voice oscillators / envelopes, enough for OSC3 & ENV3 (`SIDVoice` JS only) |
| **Output** | Speaker samples (latency ≈ one audio block, ~2.7 ms at 48 kHz / 128 samples) | `$D41B` ← `shadowV3.readOsc3()`, `$D41C` ← `shadowV3.env3` |
| **Does not** | Serve CPU `$D41B`/`$D41C` (it still publishes OSC3/ENV3 into the SAB as a debug tap; main ignores them) | Filter, mix, volume DAC, digi path, any audible sample |

| Engine | UI label | Implementation | Notes |
|--------|----------|----------------|-------|
| **`resid`** | reSID JS | `SIDVoice` + `sid-filter.js` + SINC in `SIDProcessor`; per SID cycle `clockRaw()` → Kaiser-sinc FIR | Reference reSID port; what the shadow's voice math matches |
| **`wasm`** | reSID WASM (**default**) | Rust `rust/sid/` → `sid-wasm-blob.js`; `sid_render(n)` per 128-sample block; voices, filter, extfilt, SINC and event queue all inside the module | Bit-identical to `resid` (`test/sid-wasm-engine-spec-test.js`, which also fails if either side changes without the other: a stale-blob detector); ~6× less CPU. While the module instantiates, or if it fails, `resid` renders, so selecting WASM never drops audio |

Live engine switches replay the full `$D400-$D418` register file from a worklet-side shadow into the newly selected path.

### Lean clock paths (JS voice core)

This is the hot-path contract both consumers hold `SIDVoice` to; the chip model
itself follows in §2–§7. Both JS roles share `SIDVoice` but call different lean
methods; under `wasm` the module does the player's work and the shadow still
uses the JS column.

| Voice | Player (`resid`) | Shadow (always) |
|-------|------------------|-----------------|
| v1, v2 | Full `clockCore` + `outputStageAudio` (DAC product) | `clockPhaseOnly`: phase only, as sync/ring source for v3 |
| v3 | Full core + audio out | Full `clockCore` + `outputStageOsc3` (OSC3 pipeline, **no** audio DAC) |
| Filter / mix | Yes (`sid-filter`) | No |

`clockPhaseOnly` suffices for shadow v1/v2 because v3 only needs their
**phase** (hard-sync / ring-mod); v1/v2 envelope and noise never appear in
`$D41B`/`$D41C`.

`SIDVoice.outputStage()` yields two independent per-cycle products, the audio
DAC sample (its return) and the OSC3 read pipeline, around shared feedback
(waveform latch, 6581 SAW→phase pulldown, combined-noise writeback, pulse-rail
latch). Each consumer calls a lean variant that skips the other's dead work (a
dedicated method, not a runtime flag):

- **`outputStageAudio()`** (worklet `resid`): DAC sample only; still maintains
  the 6581 waveform-DAC latch used by waveform-0 audio.
- **`outputStageOsc3()`** (shadow v3): OSC3 read only; the DAC sample is skipped.
- **`outputStage()`**: both (standalone / tests / the lone-voice `clock()`).

The shared feedback runs in all three, so each lean variant is
**byte-identical** to `outputStage()` on the product it keeps. The internal
order `_outputPre → _osc3Read → _outputPost` is load-bearing: the OSC3 read must
see the pre-writeback noise latch and the previous cycle's pulse rail. Locked by
`test/sid-outputstage-skip-equiv-spec-test.js` (both models, 60k cycles, and it
asserts the skip genuinely happens); the savings are real on both sides, largest
on the 8580 tri/saw path (which skips `_triSaw12()`).

**Keep both sides in sync:** same bus writes; same chip model (`setSidModel` on
the shadow, the worklet `model` message, and `sid_set_model` when WASM is live);
the same free-running cycle notion (`sidCycleCounter` stamps ring events, the
worklet's `currentCycle` follows). Soft reset clears registers/envelopes/noise
but **phase survives** on both sides; only a power cycle reseeds `$555555`.

---

## 2. Register map (`$D400-$D41F`, mirrored every 32 bytes)

Per-voice block (voice 1 `$D400`, voice 2 `$D407`, voice 3 `$D40E`):

| Offset | Reg | Bits | Meaning |
|--------|-----|------|---------|
| +0 | FREQ LO | 8 | Phase increment low byte |
| +1 | FREQ HI | 8 | Phase increment high byte (16-bit total) |
| +2 | PW LO | 8 | Pulse width low byte |
| +3 | PW HI | 4 | Pulse width high nibble (12-bit total) |
| +4 | CTRL | 8 | `NOISE PULSE SAW TRI | TEST RING SYNC GATE` (bits 7..0) |
| +5 | ATK/DEC | 4+4 | Attack rate (hi), Decay rate (lo) |
| +6 | SUS/REL | 4+4 | Sustain level (hi), Release rate (lo) |

Global:

| Reg | Name | Bits | Meaning |
|-----|------|------|---------|
| `$D415` | FC LO | 3 | Filter cutoff low 3 bits |
| `$D416` | FC HI | 8 | Filter cutoff high 8 bits (11-bit total) |
| `$D417` | RES/FILT | 4+4 | Resonance (hi); route bits (lo): `EXT V3 V2 V1` |
| `$D418` | MODE/VOL | n/a | `V3OFF(b7) HP(b6) BP(b5) LP(b4) | master volume(b3-0)` |
| `$D419` | POTX | 8 | Paddle X (read; 512-cycle S&H, `$FF` when open, `potXOverride` wins) |
| `$D41A` | POTY | 8 | Paddle Y (read; `$FF` when open) |
| `$D41B` | OSC3 | 8 | Voice-3 oscillator MSB readback (read) |
| `$D41C` | ENV3 | 8 | Voice-3 envelope output readback (read) |

CTRL bits (`SIDVoice.write` / `_computeWaveform12`): GATE `0x01`, SYNC `0x02`,
RING `0x04`, TEST `0x08`, TRI `0x10`, SAW `0x20`, PULSE `0x40`, NOISE `0x80`.
Global-block decode lives in `SIDChip.write` (`sid-worklet.js`).

> **All registers except POTX/POTY/OSC3/ENV3 are write-only: reading one does
> not return the register.** It returns the **SID data-bus value**: the last
> byte written to *any* SID register, or returned by a readable-register read
> (which also loads the bus), fading to 0 after ~`$1D00` cycles on the 6581 and
> ~`$A2000` on the 8580 (reSID `sid.cc`, real-chip `bitfade`/`delayfrq0.prg`
> measurements). `SIDProxy.regs` still records current register values for
> save-states; CPU reads do not serve from it.

---

## 3. The oscillator (phase accumulator)

Each voice has a **24-bit phase accumulator** (`SIDVoice.phase`):

- **Power-up value `$555555`** (the chip stores alternate bits inverted). Not
  cleared by reset; `oscinit.prg` checks this.
- Per `clock()`: `phase = (phase + freq) & 0xFFFFFF`; output frequency
  `freq · 985248 / 2²⁴` Hz.
- **TEST (`$08`)** forces `phase = 0` and holds it (oscillator reset, silencing
  for `$D418` digis). It also holds the **pulse output high** regardless of PW
  (reSID `wave.h`), the rail test-bit digis and hard-restart routines park a
  gated voice on.
- **Hard SYNC (`$02`)**: phase is zeroed on the cycle the sync source's
  accumulator **MSB rises** (bit 23 going 0→1, not the 24-bit wrap, which is
  half a source period later). Hardware-verified **mutual-sync exception**: no
  sync when the source is itself sync-enabled and its own source's MSB rises
  the same cycle. Pulses are decided for the whole trio from pre-clock state
  (`computeSyncPulses`) and applied in `clockCore()`, then outputs are computed
  in `outputStage()`: reSID's clock-all → synchronize → output order. Source
  chain: `v1←v3`, `v2←v1`, `v3←v2` (`makeVoiceTrio`). Byte-exact vs VICE reSID
  over 4096-sample OSC3 series for sync / ring / ring+sync / mutual
  configurations (headless OSC3 sampler PRG vs a VICE monitor dump).
- **RING MOD (`$04`)**: the triangle's MSB is replaced by MSB ⊕ **¬**srcMSB
  (`triPhase ^= ~syncSrc.phase & 0x800000`, reSID "MSB EOR NOT sync_source
  MSB"); ring modulation affects only the triangle, as on the chip.

`prevPhase` is saved each clock for the noise-clock edge check (MSB transition).
SYNC's MSB-rise is predicted separately (`computeSyncPulses` / `predictMsbRise`
on the undelayed `phase`), since it runs before `clockCore`.

---

## 4. Waveforms (`_computeWaveform12`)

The waveform DAC produces a **12-bit value** (0..4095) from the top bits of
`phase`; audio consumes all 12 bits, OSC3 the top 8 (`>> 4`).

| Waveform | Exact expression | Notes |
|----------|------------------|-------|
| **Triangle** (`0x10`) | `((triPhase&0x800000 ? ~triPhase>>11 : triPhase>>11)) & 0xFFE` | 11 bits shifted left one (DAC LSB grounded, reSID `wave.h`); the MSB folds the ramp. `triPhase = phase`, ring-substituted first under RING (§3). |
| **Sawtooth** (`0x20`) | `(phase >> 12) & 0xFFF` | Rising ramp from the top 12 phase bits. |
| **Pulse** (`0x40`) | `pulseOut`, a one-cycle LATCH of `phase >= ((pw & 0x0FFF) << 12) ? 0xFFF : 0x000` | The PW compare is **delayed one cycle** (reSID `pulse_output`: pushed at the end of the output stage, refreshed immediately by PW writes, **held high every clock under TEST**). |
| **Noise** (`0x80`) | 8 LFSR taps on bits 11..4 (`noiseVal << 4`; low 4 bits grounded) | §5. |

With **no** waveform bit set the 8580 outputs 0; the 6581 plays the held
waveform-DAC latch (`oscLatch`) through the DAC (floating-DAC behaviour, §6).

### Combined waveforms

With two or more waveform bits set the chip does **not** AND them: the analog
selector short-circuits bits with neighbour coupling and a DAC threshold. The
eight tables (`COMBINED_6581` / `COMBINED_8580` × ST/PT/PS/PST) are reSID's
measured chip samplings (entry = OSC3 byte `<< 4`), embedded verbatim in
`src/sid-wavetables.js` (provenance and sample lineage in NOTICE.txt). The 6581
tables are heavily eroded (mostly zeros with occasional peaks; PT loudest), the
8580's fuller. The full combined-waveform OSC3 sweep is **byte-exact vs
headless VICE x64sc on both models** (0/32648 mismatches).

Routing in `_computeWaveform12`:

- **PT** is indexed by the ring-substituted triangle phase
  (`(triPhase >> 12) & 0xFFF`); the fold lives *inside* the table (`triInput`
  generation), so ring modulation flows through the index MSB like the chip.
  ST/PS/PST index by the raw `phase >> 12`.
- **Pulse low** shorts the selector bus to **0 on both chips**.
- **NOISE+PULSE** applies the measured erosion laws after the AND combine:
  6581 `out < $F00 ? 0 : out & (out<<1) & (out<<2)`;
  8580 `out < $FC0 ? out & (out<<1) : $FC0`.
- **6581 accumulator MSB pulldown**: combined waveforms including SAW can pull
  the accumulator's top bit low through the waveform output
  (`phase &= (out12 << 12) | 0x7FFFFF`); the shadow's `clockPhaseOnly()` falls
  back to the full `clock()` in exactly those modes so phase equivalence stays
  exact.
- Table reads are **pure**: no smoothing state between reads; `getOscByte()`
  mutates nothing.

---

## 5. Noise LFSR (`sid-voice.js`)

Byte-verified against headless VICE x64sc reSID on both models: a 16-cycle OSC3
sampler over five windows (slow walk, fast stream, both writeback modes,
TEST-held fade) matches 100.0%. The register never shifts before the first
non-zero frequency write, so the series is deterministic from power-on with no
alignment tricks.

The generator is reSID's **23-bit Fibonacci LFSR** (power-up `0x7FFFFE`,
feedback `bit22 ⊕ bit17`), ported bit-for-bit: tap positions, fade step curves
and shift-completion feedback are reSID's (`wave.cc`), not re-derived here. The
facts the rest of the chip model leans on:

- **Shift trigger: rising edge of phase bit 19** (detected from the ADD, so a
  hard sync cannot cancel it), ~16 shifts per phase cycle, and **the shift
  lands 2 cycles later** via `shiftPipeline`; a TEST rise flushes the pipeline.
- **The output is a LATCH** (`noiseVal`, 8 tap bits feeding waveform bits
  11..4), refreshed only on shift / writeback / fade, never recomputed per
  cycle.
- **TEST held** stops clocking and fades the register gradually toward all-1s
  (`_shiftregBitfade`; per-model timing in the §12 table). **TEST released**
  completes the held shift with the release feedback `¬bit17`, refreshing the
  latch. When the previous waveform combined noise with another, the release is
  preceded by the **pre-writeback** flush of the selector output into the
  register (`_doPreWriteback`; its per-model rules and the VICE-aligned
  trade-off are §13's).
- **Combined-NOISE zero-clobbering**: with NOISE + another waveform the selector
  output writes back into the register's tap bits **every cycle** (except under
  TEST and the single cycle before a pipelined shift lands). Bits can only be
  cleared, so combined noise collapses to silence within cycles, as on
  hardware; a TEST pulse or the fade recovers it.

---

## 6. Envelope generator (ADSR)

A port of reSID's **cycle-accurate pipelined** `EnvelopeGenerator` (VICE
`resid/envelope.h`+`.cc`): a three-state machine (attack, decay/sustain,
release), an 8-bit `env` counter (the per-voice amplitude multiplier), and a
**one-cycle readback latch `env3`**: `$D41C` returns the value sampled at the
START of each clock, so a CPU read sees the counter as it stood one cycle
earlier. Three deferred-work pipelines (`statePipeline`, `envPipeline`,
`expPipeline` plus the deferred rate-counter reset) model the extra cycle(s)
between a cause (a GATE write, a rate or exponential match) and its effect
landing on `env`; the pipeline orderings, the 16-entry rate table the ATK/DEC/
REL nibbles index, and the counter mechanics are reSID's, carried over
literally rather than re-derived here.

The consequences the tests gate on, each verified against reSID:

- **The ADSR delay bug.** The 15-bit rate prescaler is never reset by register
  writes or gate flips (only by its own deferred match-reset), and on wrap it
  skips zero, so shrinking the period below the running counter stalls the
  envelope up to 32767 cycles until the wrap comes around (vs VICE reSID: a
  1916-sample stall, ±1 boot-phase).
- **Decay/release divide through an exponential counter** whose divisor is
  latched when `env` lands **exactly** on a boundary value (`_setExpPeriod`,
  not `<=`; the `<=` cascade survives only as the save-state restore fallback,
  and a wrong boundary runs envelopes ~3% fast). A full A=D=R=15 envelope takes
  exactly `0x7E60` cycles (`envtime.prg`).
- **Counter wrap + freeze-at-zero** (reSID `hold_zero`): `env` wraps both ways,
  and landing on `$00` either way **freezes** it; only GATE 0→1 unlocks. So a
  re-gate with env at `$FF` snaps it to `$00` and mutes the voice until the
  next gate-off/on pair (the hard-restart interaction), and an unlocked release
  at env 0 runs a full `$FF`-down curve.
- **Sustain is not a separate state**: inside decay/sustain the compare
  `env === (s<<4)|s` re-evaluates on every exponential tick, so **lowering SR
  while gated resumes decay** to the new level (SR=`$00` drains to 0 at the
  decay rate: the GoatTracker/JCH *hard restart*), and **raising SR above the
  current env is never honoured** (the equality can't match on the way down).
- **Gate-on runs one "accidental" decay cycle** before attack takes over two
  cycles later (reSID quirk; `env_test` measures it). GATE 1→0 forces release
  via the state pipeline.

Verification: the full VICE `env_test/*` testprog suite passes (all 8;
`ra_0000 = 0/192` vs the real-HW table, `resid-test/envdelay` = `$8011`), and a
16-cycle ENV3 sampler over five windows gives identical step-value sequences
with run lengths within ±1 sample. Absolute edge timing between emulators is
not comparable at 1-cycle precision: the rate prescaler has no software reset,
so each emulator carries an uncontrollable power-on phase constant.

**Voice amplitude** = `(WAVE_DAC[out12] − wave_zero) · ENV_DAC[env]`, reSID's
integer voice product (±2047×255). The waveform passes through the model's R-2R
DAC (reSID `dac.cc` tables incl. the subthreshold-leakage floor; nonlinear on
the 6581, near-ideal on the 8580) and the envelope through its 8-bit model DAC.
The multiplier pivots around the measured **wave_zero**: `$380` on the 6581
(not mid-scale; reSID `voice.cc`) and `$9E0` on the 8580, which cancels the
terminated ladder's leakage floor. The asymmetric 6581 pivot makes envelope
ramps pump waveform-dependent DC (gate thumps, click digis).

**Waveform-0 float + bit-fade** (`_out12`, `floatTtl`; reSID `wave_bitfade`,
`FLOATING_OUTPUT_TTL`, SOAS/C samplings): with no waveform selected the 12-bit
DAC input holds the last selector value and decays pairwise (`out &= out >> 1`)
after the model TTL: ~200 ms to the first step on the 6581 then per-bit steps,
~5 s on the 8580. Audio and OSC3 consume the same float on both models; it is
the mechanism waveform-0 sample players rely on.

---

## 7. OSC3 / ENV3 readback (`$D41B` / `$D41C`)

Only **voice 3** is CPU-visible; demos read it heavily (NOISE RNG,
envelope-following, model detection).

- **`getOscByte()`** returns the live waveform byte when a waveform is
  selected, else the held float latch (§6). It is pure.
- **8580 tri/saw pipeline** (reSID `tri_saw_pipeline`, `_triSawPipe`): the 8580
  latches the tri/saw *table component* through an extra clock phase, so with
  TRI or SAW selected OSC3 shows last cycle's table value masked by THIS cycle's
  pulse rail and noise latch. Pulse-only / noise-only reads are live on both
  models; the 6581 is always live. (`chipmodel.prg` / `osc_topbit` measure the
  saw delay; a drift-frequency OSC3 sampler over pulse / saw / saw+pulse / tri /
  noise windows gives maxΔ0 vs VICE on both models; the combined sweep is
  byte-exact, §4.)
- **Served by the shadow voices, not the worklet.** `SIDProxy.read` routes
  `$D41B → shadowV3.readOsc3()` and `$D41C → shadowV3.env3` (the one-cycle
  latch, §6). The worklet's publish into `sidCtrl[2]/[3]` is a debug tap only
  (its ~3 ms block latency is unusable for cycle-exact reads); it uses the non-mutating
  `readOsc3()`, not `getOscByte()`, so it doesn't perturb the live voice.

---

## 8. `SIDChip`: the reSID filter / mixer / volume stage (`sid-filter.js`)

A JavaScript translation of reSID's transistor-level model
(`filter8580new.{h,cc}` as distributed in VICE 3.10 `src/resid`; attribution in
NOTICE.txt), shared by the JS engine and, via Rust, the WASM engine.
`SIDChip.clock()`/`clockRaw()` runs once per SID cycle:

1. **Clock the 3 voices** (`clockCore()` then `outputStageAudio()`): the
   integer voice products (§6).
2. **Voice scaling** (`SIDFilter.clock`): each 20-bit product is scaled into
   the op-amp voltage domain (`voice_scale_s14`, with a small deterministic
   dither decorrelating quantization) and offset by the model's **voice_DC**:
   on the 6581 every voice rides ~5 V up on a 1.5 V swing, the physical root of
   the `$D418` volume digi.
3. **Summer + integrators**: voices routed by `$D417` enter the filter summer,
   a pre-solved nonlinear op-amp lookup (`summer` tables from the measured 6581
   R4AR / 8580 R5 op-amp transfer curves, Newton-Raphson at init). Two
   integrators advance one fixpoint step per cycle. **6581**: VCR gate-voltage +
   EKV-model current tables ("snake" + `vcr_kVg`/`vcr_n_Ids_term`), cutoff DAC
   `f0_dac` carrying the chip's non-monotonic R-2R discontinuities, filter bias
   0.5 V like VICE's default. **8580**: parallel-NMOS ladder current
   (`n_dac·f0_dac[fc]`, linear in `fc`, temperature-divider gate voltage).
   Resonance is the physical resistor-ladder feedback (`resonance[res]` op-amp
   tables: 6581 die law `~res/8`, 8580 `2^((4−res)/8)`), bounded by the op-amp
   curves themselves; no synthetic saturator, DC tracker or damping floor.
4. **Mixer + volume** (`SIDFilter.output`): the `$D418`-selected taps and
   direct voices sum through the mixer op-amp tables (v3off only removes a
   voice 3 routed DIRECTLY to the mixer, the reSID rule), then the **nonlinear
   4-bit volume ladder** (`gain[vol]`, ~vol/12 on the 6581, ~vol/16 on the
   8580). `$D418` digis and Mahoney-style DAC tricks fall out of this physics,
   not calibrated constants.
5. **External filter** (`SIDExternalFilter`): reSID's integer C64 output RC
   model, ~16 kHz low-pass and a 15.9 Hz high-pass DC blocker, deliberately
   gentle so audio-rate sample streams pass.
6. **Output**: `clip16(scaleFactor·out/2)/32768` (VICE wrapper amplify;
   scaleFactor 3 on the 6581, 5 on the 8580), matching VICE's absolute scale.

Table memory is ~10.4 MiB per model (Uint16), built lazily on first use
(~1.2 s in JS) and cached; the per-cycle path is pure integer lookups
(deopt-free and allocation-free on the audio thread).

**Measured against headless VICE x64sc** (same PRGs through both): filter
sweep knees track VICE across the FC range, and the `$D418` digi/tone ratios
land at **+5.1 dB (6581) / −8.9 dB (8580) = VICE exactly**, absolute levels
matching to four decimals, with no calibration constants.

---

## 9. Decimation: the SINC resampler (`SIDProcessor`) and the WASM engine

Both engines downsample 985 kHz → host rate with reSID's own `clock_resample`
(SAMPLE_RESAMPLE, the mode the VICE oracle runs); there is no separate
reconstruction stage. Raw per-cycle chip output (`clockRaw()`,
pre-amplification) enters a 16 K ring; each audio sample is a Kaiser-windowed
sinc FIR (≈1273 taps × 16 phase tables at 48 kHz, built at init with A = 96 dB
stopband, passband 0.45·Fs, gain 0.97: VICE's runtime defaults), linearly
interpolated between adjacent phase tables. A ~6 ms **fade-in** after
init/reset masks the DC-blocker settling transient (the power-on click).

The **WASM engine** runs this exact pipeline (voice cores, filter, external
filter, SINC, cycle-stamped event queue) inside the module from `rust/sid/`, one
`sid_render(n)` call per 128-sample block instead of per-sample JS. The Rust is
a statement-for-statement translation with the same integer semantics
(`Math.imul` ↔ `wrapping_mul`, `|0` ↔ `as i32` wrap, `>>>` ↔ logical shift) and
the same table-build float order, so output is bit-identical rather than
merely close: the equivalence gate measured **0 differing samples** across
filter-sweep, digi and ring-mod/combined-waveform scenarios on both models.
Cost: ≈100 ms CPU per emulated second vs ≈660 ms for the JS engine (≈6.5×);
model table builds ≈0.2–0.36 s vs ≈1.2 s.

### User master volume (app-level, not `$D418`)

The **Options ▸ Sound** slider is a Web Audio `GainNode` (`masterGain` in
`main.js`) *downstream* of the worklet and outside the SID model: a square-law
perceptual taper on the slider position (default 70% ≈ −6 dB of headroom
against the authentically hot 0 dBFS chip mix). MUTE pins the same node to 0,
and the synthesised drive sounds route through it too. User-facing behaviour:
the [User Guide](USER-GUIDE.md), Sound section.

---

## 10. The worklet transport (`SIDProcessor`)

The CPU thread and the audio thread share one lock-free **SPSC ring** in a
`SharedArrayBuffer`:

```
 Int32 header:  [0]=writeIdx  [1]=readIdx  [2]=OSC3(unused)  [3]=ENV3(unused)
 Ring entries (from byte 16):  per slot = { u32 cycle, u32 packed(reg | val<<8) }
 RING_CAPACITY = 131072 slots   (indices masked & 0x7FFFFFFF)
```

- **Producer** (`machine.js _sidWrite`) writes `{sidCycleCounter, reg|val<<8}`
  at `writeIdx`, then `Atomics.store` advances it. It never checks fullness;
  the ring is large enough that the consumer always keeps up.
- **Consumer** (`process()`): `_drainRing()` copies pending entries into a
  preallocated typed ring (`pendCycle`/`pendPacked`, `pendHead`/`pendCount`);
  `_applyDueEvents()` applies those with stamp `≤ currentCycle` (unsigned-delta
  test), stopping at the first future event.
- **Cycle-sync + lookahead**: `currentCycle` (worklet) and `sidCycleCounter`
  (producer) free-run and can drift. After init/reset (`_needCycleSync`) the
  worklet snaps `currentCycle` to about 25 ms **before** the first pending
  event: a deliberate jitter buffer so the main thread can deliver a frame's
  burst of writes before playback reaches dense `$D418` sample streams. The same
  snap serves as **desync recovery** whenever the head event is >0.5 s away in
  either direction (power-cycle / second-load stale bursts).

---

## 11. Machine integration (`machine.js`)

- **`SIDProxy`** is the `$D400-$D7FF` device. `write` records the byte (data-bus
  shadow), forwards to the ring, and mirrors voice-register writes to the
  shadow voices. `read` serves POTX/POTY (latched), OSC3/ENV3 (shadowV3), and
  the decaying bus value for everything else (§2).
- **Shadow voices** come from `makeVoiceTrio()` and are clocked every
  `_runMasterCycle` as in §1: byte-identical OSC3/ENV3 at a fraction of the
  cost.
- **`sidCycleCounter`**: the free-running cycle stamp incremented in
  `_runMasterCycle`; the time base for ring events.
- **Paddle POT sample-and-hold**: `$D419/$D41A` return `potXSampled` /
  `potYSampled`, refreshed every **512 master cycles** from the live
  `paddleX/paddleY` (the successive-approximation timing; Arkanoid polls this
  tightly). Two gates sit in front of the latch:
  - **`potConnected`**: false when no device on either control port reports a
    position (paddle and 1351 do; nothing else does). Both registers then read
    `$FF`, the open-pin value software uses to detect a missing paddle;
    `input.js` re-asserts it every frame from the port selection.
  - **`potXOverride`**: a whole-byte value that takes `$D419` when non-null,
    ahead of both the latch and the open-pin default. The NEOS mouse uses it for
    its right button (`$FF` pressed, `$00` released) and connects nothing to
    POTY, so `$D41A` keeps reading open.
- **Model sync**: `setSidModel(is8580)` updates the shadow voices; `main.js`
  posts the matching `model` message to the worklet.

---

## 12. Chip variants: 6581 vs 8580

| Aspect | 6581 (original NMOS) | 8580 (HMOS-II, C64C), **default** |
|--------|----------------------|------------------------------------|
| Combined waveforms | measured tables, heavily eroded (mostly zero, PT loudest) | measured tables, fuller |
| Combined-wave index | full 12-bit (`idx & 0xFFF`), same as 8580 (pitch is model-independent) | full 12-bit |
| Pulse-zero w/ other wave | `0x000` (bus shorted) | `0x000` (bus shorted) |
| Filter cutoff | measured `f0_dac[fc]` through the FET/op-amp model, non-monotonic like the chip | linear `n_dac·f0_dac[fc]` (reSID `filter8580new`) |
| Filter resonance | die law ~`res/8` through the op-amp tables | `1/Q = 2^((4−res)/8)` |
| Filter shape | bounded by the measured 6581 op-amp curve (no separate saturator) | bounded by the measured 8580 curve |
| `$D418` DC step (digi) | per-voice DC through the nonlinear volume ladder (loud) | same mechanism, faint (hardware-true) |
| Write-only reg read (bus TTL) | ~`$1D00` cycles | ~`$A2000` cycles |
| Waveform/env DACs | R-2R, unterminated, 2R/R≈2.2 → discontinuities (major-carry drop at `$800`) | terminated, 2R/R=2.0 → ideal identity |
| wave_zero (env pivot) | `$380` (asymmetric, thumps) | `$9E0` (cancels the leakage floor) |
| Per-voice DC into mixer | `voiceDCVoltage` 5.075 V | 4.7975 V |
| OSC3 read latency | live | tri/saw table one cycle late, pulse/noise masks live (`_triSawPipe`) |
| Noise TEST-fade | first step @35000 cy, then /1000 | @2519864 cy, then /315000 |
| Waveform-0 float TTL | ~200 ms | ~5 s |

Default **8580** (`machine.js` `sidIs8580 = true`, matched in the UI). Demos
detect the model via the combined-waveform / pulse-zero / OSC3 differences
(e.g. lft's *Lunatico*).

---

## 13. Known limitations & open work

Everything not listed here is calibrated against VICE's reSID (per-topic
sections above) and is byte- or near-byte-exact.

- **13 combined-*noise* cases in VICE's `wb_testsuite` differ**, identically to
  VICE 3.10, the accepted pre-writeback trade-off. `_doPreWriteback` follows
  reSID's per-model rules (never from noise+pulse on the 6581, only into
  `$9`/`$E` from it on the 8580, never on 6581 tri↔saw swaps) but **does** fire
  when writing back into plain noise (`wf===8`), which reSID gates behind
  `#if 0` ("needs more investigation"): `noiselfsrinit/simple`'s `$F8→$80` init
  dance needs it (real 8580 + VICE = `$7F`). Firing it makes the 13
  `wb_testsuite/noisewriteback` X→8 combined-noise cases fail, but VICE 3.10
  fails them identically: a shared reSID combined-waveform-model limit; no
  waveform rule separates the two sets (§5).
- **`$D417` EXT IN routing (bit 3) is a no-op**: no expansion-port audio is
  mixed into the filter (EXT IN is grounded on a stock C64).

---

## 14. Offline testing & the A/B harness (no browser)

An offline SID render harness (developer tooling, not part of the shipped tree)
feeds an event stream through the real `SIDChip`/`SIDProcessor` and writes WAV
plus FFT metrics **without the browser, AudioContext or RAF**. Audio changes are
gated on its output (spectrum, aliasing energy, byte comparison; the WASM
engine's byte-identical WAV gate runs there), paired with headless VICE x64sc
captures of the same scenes.

What a contributor acts on: verify audio changes with
`test/sid-*-spec-test.js`, and give cycle-sync / second-load / power-cycle
behaviour a browser ear-check after transport changes. The harness has no
independent audio clock, so it can A/B the *mechanism* of a transport issue but
not measure how *often* drift-induced bursting happens live; that needs the
`c64Trace.sidDiag` counters in the browser.

---

## 15. Key invariants & gotchas (quick reference)

- **Two consumers, one source** (§1): audio = SAB ring → worklet; readback =
  shadow voices; keep them model-synced (`setSidModel`).
- **Shadow v1/v2 are phase-only**; never read envelope/OSC from them.
- **`outputStage()` has three variants** whose lean pair must stay
  byte-identical to the full one, and the `_outputPre → _osc3Read →
  _outputPost` order is load-bearing. A test double standing in for a shadow
  voice needs `outputStageOsc3()` too (the `_vic2-helpers.js` `stubVoice`).
- **`getOscByte()` is pure**; `readOsc3()` is the clocked-pipeline read.
- **Phase power-up is `$555555`**, not 0, and survives reset.
- **Noise** clocks on the phase-bit-19 rising edge, shifts 2 cycles late, and
  its output is a latch; TEST fades it to 1s, combined-NOISE clobbers it to 0.
- **Exponential-envelope divisors** are chosen by exact match (`_setExpPeriod`),
  not `<=`.
- **Two "master volumes"**: `$D418` is the chip's volume DAC (the digi path);
  the Options slider is a separate `masterGain` (`v²` taper, default 70%
  ≈ −6 dB) trimming all output incl. drive sounds; MUTE shares that node.
- **Cycle stamps are `sidCycleCounter`** (31-bit-masked in the ring); the
  worklet's `currentCycle` is a separate clock, reconciled by sync snaps and the
  lookahead buffer, never kept identical.
- **POTX/POTY** are a 512-cycle sample-and-hold, `$FF` when nothing reports a
  position, `potXOverride` can take `$D419` outright.

---

### Related docs
[master overview](ARCHITECTURE.md) (audio data flow §) ·
[machine orchestrator](MACHINE-ARCHITECTURE.md) (SIDProxy, ring producer, frame loop) ·
[6510 CPU](CPU-ARCHITECTURE.md) (the `_runMasterCycle` that clocks the shadow).
