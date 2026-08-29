// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// The filter/mixer/volume and external-filter stages are translations from
// reSID as distributed in VICE 3.10 src/resid (see src/sid-filter.js),
// Copyright (C) 2010 Dag Lem; see NOTICE.txt.
// src/sid-worklet.js – SID audio worklet (3 voices + filter + mixing).
// CPU runs in main thread; this worklet only does SID synthesis.
// SID register writes arrive via a SharedArrayBuffer ring buffer.
//
// Ring layout (Int32 indexed):
//   [0]   = writeIdx
//   [1]   = readIdx
//   [2]   = OSC3 byte (legacy snapshot; main thread now uses shadow SID)
//   [3]   = ENV3 byte (legacy snapshot; main thread now uses shadow SID)
//   [8+]  = ring entries (Uint32 view: cycle, packed reg/val per pair)
//
// SIDVoice + tables live in ./sid-voice.js so the main-thread shadow
// (machine.js) can clock the same voice code in lockstep for cycle-exact
// $D41B/$D41C reads; the reSID filter/mixer/volume + external-filter
// pipeline lives in ./sid-filter.js. AudioWorkletGlobalScope supports ES
// module imports in modern Chrome (76+); Vite serves the module graph.

import { SIDVoice, makeVoiceTrio, computeSyncPulses } from './sid-voice.js';
import { SIDFilter, SIDExternalFilter, clip16 } from './sid-filter.js';
import { sidWasmBytes } from './sid-wasm-blob.js';

const RING_CAPACITY = 131072;
// The main thread emits SID writes while it computes a video frame in a burst,
// but the audio thread consumes them continuously. Keep the audio event clock
// about one PAL frame plus a couple of AudioWorklet blocks behind the producer
// so high-rate $D418 sample streams arrive before playback reaches them.
const EVENT_LOOKAHEAD_CYCLES = 24576;
// Hard ceiling on how far the producer may run ahead of the audio event clock.
// The main loop runs its whole frame backlog in one tick rather than dropping it
// (pitch stays correct), so a stalled tick can legitimately hand us its 100 ms
// delta cap of events at once — the ceiling has to sit above that transient or
// ordinary load would trip it: 100 ms plus the ~25 ms lookahead is the worst
// legitimate reading, so the ceiling sits just above it.
//
// Only RUNAWAY is corrected, never mere depth. The main thread computes a whole
// frame of SID writes before that audio plays, so a queue several frames deep is
// normal buffering: the events still apply exactly on their stamps. Measured on
// real sessions, a game can sit 3-9 frames deep indefinitely with zero lateness
// while the producer and consumer clocks match to 0.4%. An earlier attempt to
// bleed such a lead away continuously mistook depth for lateness and skipped ~3%
// of the SID timeline during ordinary play. What it catches is
// ACCUMULATION: each stall the audio thread can only play back at 1× leaves its
// gap in place permanently, and a long recording stacks those into seconds of
// audio lateness. Excursions BELOW the ceiling are handled by the trim, so this
// only has to catch jumps too large to bleed off smoothly.
const MAX_BACKLOG_CYCLES = 147787;              // 0.15 s at 985248 Hz

class SIDChip {
  // is8580 picks which reSID filter model's tables are built (lazily per
  // model, cached for the session — see sid-filter.js). The analog chain is
  // the reSID transistor-level port: voices → filter/mixer/volume → external
  // RC filter.
  constructor(is8580 = false) {
    const [v1, v2, v3] = makeVoiceTrio();
    this.v1 = v1; this.v2 = v2; this.v3 = v3;
    // Power-on state matches real 6581/8580: all $D4xx registers = 0,
    // so VOL=0 (silent) and V3OFF=0.
    this.is8580 = !!is8580;
    v1.is8580 = this.is8580; v2.is8580 = this.is8580; v3.is8580 = this.is8580;
    this.filter = new SIDFilter(this.is8580 ? 1 : 0);
    this.extfilt = new SIDExternalFilter();
    this.scaleFactor = this.is8580 ? 5 : 3;
  }
  // /RESET pulse (reSID sid.cc reset()): registers, envelopes, noise
  // registers and filter state all clear — but the voice phase accumulators
  // SURVIVE (the chip's accumulator has no reset line; oscinit.prg).
  // A power cycle is `new SIDChip()` instead.
  reset() {
    this.v1.reset(); this.v2.reset(); this.v3.reset();
    this.filter.reset();
    this.extfilt.reset();
  }
  setModel(is8580) {
    this.is8580 = !!is8580;
    this.v1.is8580 = this.is8580; this.v2.is8580 = this.is8580; this.v3.is8580 = this.is8580;
    this.filter.setChipModel(this.is8580 ? 1 : 0);
    this.scaleFactor = this.is8580 ? 5 : 3;
  }
  write(reg, val) {
    reg &= 0x1F;
    if (reg < 7) this.v1.write(reg, val);
    else if (reg < 14) this.v2.write(reg - 7, val);
    else if (reg < 21) this.v3.write(reg - 14, val);
    else if (reg === 21) this.filter.writeFC_LO(val);
    else if (reg === 22) this.filter.writeFC_HI(val);
    else if (reg === 23) this.filter.writeRES_FILT(val);
    else if (reg === 24) this.filter.writeMODE_VOL(val);
  }
  read(reg) {
    if((reg&0x1F)===0x1B)return this.v3.getOscByte();
    if((reg&0x1F)===0x1C)return this.v3.env3;
    return 0;
  }
  clock() {
    // reSID ordering (sid.h clock): decide this cycle's hard-sync pulses
    // from pre-clock state, clock all oscillators/envelopes, THEN compute
    // waveform outputs so ring mod reads post-sync source phases.
    computeSyncPulses(this.v1, this.v2, this.v3);
    this.v1.clockCore(); this.v2.clockCore(); this.v3.clockCore();
    // Audio-only output: the worklet consumes the voice product; the OSC3
    // read pipeline is dead work here (the worklet's $D41B/$D41C publish is
    // unread — the main thread serves those from its shadow SID). The
    // floating waveform-0 DAC fade is clocked inside _outputPre on both
    // models (skip-equiv test locks the product match).
    const o1 = this.v1.outputStageAudio(), o2 = this.v2.outputStageAudio(), o3 = this.v3.outputStageAudio();
    // reSID pipeline: voices → filter/mixer/volume → external RC filter
    // (fused clockOut calls — the same math as reSID's clock()+output()
    // pairs, with the intermediates kept in locals). EXT IN is grounded
    // (stock C64; the filter's voice mask disconnects it), so $D417 bit 3
    // routing behaves like hardware with no source.
    const ext = this.extfilt.clockOut(this.filter.clockOut(o1, o2, o3));
    // reSID wrapper amplify(): clip(scaleFactor·out/2), normalized to ±1.0
    // float for the worklet output bus. C integer division truncates toward
    // zero — |0 after /2 matches.
    return clip16(((this.scaleFactor * ext) / 2) | 0) / 32768;
  }
  // reSID-engine raw per-cycle output for the SINC resampler: the clipped
  // 16-bit external-filter output BEFORE the wrapper's scaleFactor
  // amplification (reSID clock_resample stores clip(output()) and amplifies
  // the CONVOLVED sample). Voice/filter pipeline identical to clock().
  clockRaw() {
    computeSyncPulses(this.v1, this.v2, this.v3);
    this.v1.clockCore(); this.v2.clockCore(); this.v3.clockCore();
    const o1 = this.v1.outputStageAudio(), o2 = this.v2.outputStageAudio(), o3 = this.v3.outputStageAudio();
    return clip16(this.extfilt.clockOut(this.filter.clockOut(o1, o2, o3)));
  }
}

class SIDProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sid = new SIDChip();
    this.cyclesPerSample = 985248.0 / sampleRate;
    this.sidCtrl = null;
    this.sidRing32 = null;
    this.currentCycle = 0;

    // Preallocated typed mirror of drained-but-not-yet-applied ring events.
    // Replaces the old `pendingEvents` array of {cycle,reg,val} objects (which
    // allocated one object per event and periodically spliced — both GC sources
    // inside the real-time audio callback). This is a fixed circular buffer:
    //   pendHead  = index of the next event to apply
    //   pendCount = number of queued (unapplied) events
    // Capacity is 2× the ring so a full ring-drain on top of an existing backlog
    // still fits without overflow. Power-of-two for the index mask.
    this.PEND_CAP = RING_CAPACITY * 2;          // 262144 (2^18)
    this.pendCycle = new Uint32Array(this.PEND_CAP);
    this.pendPacked = new Uint32Array(this.PEND_CAP);
    this.pendHead = 0;
    this.pendCount = 0;

    // The analog output stage (extfilt: ~16 kHz LP + ~16 Hz HP) runs INSIDE
    // SIDChip as reSID's integer ExternalFilter.
    //
    // reSID-engine decimation: the reference SINC resampler (reSID sid.cc
    // clock_resample, SAMPLE_RESAMPLE — the mode the VICE oracle runs).
    // Per-cycle outputs enter a ring; each audio sample is a Kaiser-
    // windowed sinc FIR convolution with linear interpolation between
    // fir_RES phase-shifted tables. Built with the VICE runtime defaults:
    // passband = 0.45·Fs (SidResidPassband 90), filter_scale 0.97
    // (SidResidGain 97). Replaces the old boxcar + 3-pole reconstruction
    // cascade, whose ~-3 dB@8k/-7 dB@12k top-end sag was the last audible
    // gap vs VICE on wide-open filter sweeps.
    this._buildResampler(sampleRate);

    // Brief output fade-in (~6 ms) after init/reset so the DC blocker's
    // settling transient doesn't pop into the audio stream as a power-on
    // click. Real C64 analog stage takes a fraction of a second to settle
    // too; we use a short ramp because anything slower is perceptible.
    this.fadeInRemaining = 0;
    this.fadeInLen = Math.round(sampleRate * 0.006);
    this._needCycleSync = false;

    // Diagnostic stats (per ~1 s reporting period), posted via
    // port.postMessage('diag-period', …). These distinguish a SCHEDULING
    // problem (events arrive on time but apply late → lateMax/late spike) from
    // a TRANSPORT problem (producer outran the consumer → overrun rises), per
    // the SID-quality debug plan. Inert unless main.js opts in (c64Trace.sidDiag).
    this.diagApplied = 0;     // events applied this period
    this.diagFuture = 0;      // probes that found the head event still future
                              // (per-sample gated in process(), so this counts
                              // waiting cycles inside an OPEN gate, not all cycles)
    this.diagDrained = 0;     // ring entries pulled into the mirror
    this.diagLateMax = 0;     // worst lateness (cycles) of an applied event
    this.diagLate = 0;        // events applied > ~2 ms (2000 cy) after their stamp
    this.diagOverrun = 0;     // ring entries LOST to producer overwrite (backpressure failure)
    this.diagMaxDepth = 0;    // peak mirror depth (unapplied events queued)
    this.diagPendDrop = 0;    // mirror-overflow drops (should stay 0; safety net)
    this.diagBacklogFF = 0;   // backlog fast-forwards (audio lateness corrections)
    this._lastDrained = 0;    // ring entries drained by the most recent block
    this._backlogStreak = 0;  // producer writes seen while over the ceiling
    this.diagLastReportCycle = 0;

    // Engine selection: 'resid' or 'wasm' (the app default —
    // main.js persists and sends it at init) — carried across resets;
    // switchable live via the 'engine' message (Options ▸ Sound on the main
    // thread). 'resid' here is only the pre-init value, and what 'wasm'
    // downgrades to for the session if instantiation fails.
    this.engineSel = 'resid';

    // WASM engine: the compiled Rust translation of the JS
    // reSID engine (src/sid-wasm-blob.js; bit-identical output — the
    // equivalence spec test locks it). Instantiated lazily on first
    // selection; while instantiating — or if instantiation fails — the JS
    // reSID engine renders, so selecting WASM can never lose audio.
    this.wasm = null;        // module exports once ready
    this.wasmReady = null;   // instantiation promise (offline harness awaits)
    this.wasmFailed = false;
    this.wasmOutPtr = 0;
    this._wasmView = null;   // cached output view; rebuilt if memory grows
    // $D400-$D418 register-file shadow: every applied/forwarded write lands
    // here so an engine switch can replay the full file into the target.
    this.regShadow = new Uint8Array(25);

    this.port.onmessage = e => {
      if (e.data.type === 'init') {
        // 'init' = brand-new machine on the main thread → full reset,
        // currentCycle = 0 to match the freshly-zeroed sidCycleCounter.
        const ccBefore = this.currentCycle;
        if (e.data.engine) {
          this.engineSel = e.data.engine === 'wasm' ? 'wasm' : 'resid';
        }
        this._fullReset(e.data.is8580 ?? false);
        // sidCtrl: [0]=writeIdx, [1]=readIdx, [2]=OSC3, [3]=ENV3.
        // Ring entries start at byte 16 (4 × Int32 header).
        this.sidCtrl = new Int32Array(e.data.shared, 0, 4);
        this.sidRing32 = new Uint32Array(e.data.shared, 16);
        // Kick the wasm instantiation only AFTER the ring is wired: even a
        // hypothetical escape from _ensureWasm then can't cost the transport
        // (the JS engine renders regardless — see _wasmFail).
        if (this.engineSel === 'wasm') this._ensureWasm();
        this.port.postMessage({
          type: 'diag-init',
          ccBefore, ccAfter: this.currentCycle,
          wi: Atomics.load(this.sidCtrl, 0),
          ri: Atomics.load(this.sidCtrl, 1),
          is8580: this.sid.is8580,
        });
      } else if (e.data.type === 'model') {
        this.sid.setModel(e.data.is8580);
        if (this.wasm) this.wasm.sid_set_model(e.data.is8580 ? 1 : 0);
      } else if (e.data.type === 'engine') {
        // Live engine switch (Options ▸ Sound): reSID WASM ↔ reSID JS under
        // the running voices. The full register file replays from regShadow;
        // filter integrators and the resampler restart.
        const eng = e.data.engine === 'wasm' ? 'wasm' : 'resid';
        this.engineSel = eng;
        if (eng === 'wasm') {
          this._ensureWasm();
          // The JS chip keeps rendering until (and in case) the module is
          // ready; once ready the wasm side gets the register file + clock.
          if (this.wasm) this._wasmSyncFromShadow();
        } else if (this.sid) {
          // Returning from wasm: replay the register file so the JS chip's
          // voices/filter match the program state.
          for (let r = 0; r <= 24; r++) this.sid.write(r, this.regShadow[r]);
        }
        this._resetResampleState();
      } else if (e.data.type === 'reset') {
        // 'reset' = softReset / cart load on a still-running machine.
        // Wipe synth state + drop in-flight events, BUT keep currentCycle
        // free-running so it stays in sync with main thread's
        // sidCycleCounter (which also free-runs). Resetting only one
        // side's clock created a multi-second window where new events
        // looked "future" to the worklet and never applied — the
        // "second-cart-load makes WOTEF digi sound worse" bug.
        this._synthReset(e.data.is8580 ?? this.sid.is8580);
      } else if (e.data.type === 'resync') {
        // A main-thread stall + resume (fullscreen transition, background thaw)
        // lets this worklet's sample-driven currentCycle drift ahead of the
        // paused emulation's sidCycleCounter by LESS than the 0.5 s desync-snap
        // threshold below — a small but PERMANENT offset that makes subsequent
        // events (music/digi) apply early and bursty. Re-arm the one-shot
        // cycle-sync so the next event snaps currentCycle back into alignment,
        // WITHOUT wiping synth state (unlike 'reset' — voices keep playing, no
        // click).
        this._needCycleSync = true;
      }
    };
  }

  // Lazily instantiate the WASM engine. Async; the JS reSID engine renders
  // until the module is live. On failure the selection falls back to
  // 'resid' permanently for the session (diag message for visibility).
  _ensureWasm() {
    if (this.wasm || this.wasmFailed) return this.wasmReady;
    if (!this.wasmReady) {
      // The byte decode and instantiate() can also throw SYNCHRONOUSLY
      // (WebAssembly API absent or restricted, OOM in the base64 decode).
      // Route that into the same failure path as an async rejection so the
      // exception can never escape into the port message handler and abort
      // the rest of an 'init' (which would lose the ring wiring — silence
      // with no fallback).
      let inst;
      try {
        inst = WebAssembly.instantiate(sidWasmBytes());
      } catch (err) {
        this._wasmFail(err);
        return this.wasmReady;
      }
      this.wasmReady = inst
        .then(({ instance }) => {
          const ex = instance.exports;
          ex.sid_init(sampleRate, this.sid && this.sid.is8580 ? 1 : 0);
          this.wasm = ex;
          this.wasmOutPtr = ex.sid_out_ptr();
          this._wasmSyncFromShadow();
        })
        .catch((err) => this._wasmFail(err));
    }
    return this.wasmReady;
  }

  // Shared failure path for sync throws and async rejections: mark failed,
  // surface the diagnostic, and drop this session to the JS engine (the
  // persisted preference is untouched, so the next boot retries wasm).
  _wasmFail(err) {
    this.wasmFailed = true;
    this.port.postMessage({ type: 'diag-wasm-failed', error: String(err) });
    if (this.engineSel === 'wasm') this.engineSel = 'resid';
  }

  // Bring the wasm side up to date: model, full register file, clock.
  _wasmSyncFromShadow() {
    if (!this.wasm) return;
    this.wasm.sid_set_model(this.sid && this.sid.is8580 ? 1 : 0);
    for (let r = 0; r <= 24; r++) this.wasm.sid_write(r, this.regShadow[r]);
    this.wasm.sid_set_cycle(this.currentCycle);
  }

  // reSID sid.cc set_sampling_parameters() — SAMPLE_RESAMPLE branch, PAL
  // clock. Builds fir_RES phase-shifted Kaiser-windowed sinc tables for the
  // 985248 Hz → sampleRate conversion (16-bit quality: A = 96.33 dB).
  _buildResampler(rate) {
    const clock = 985248.0;
    const passFreq = rate * 90 / 200.0;    // VICE SidResidPassband default 90
    const filterScale = 0.97;              // VICE SidResidGain default 97
    const PI = Math.PI;

    const I0 = (x) => {
      // 0th-order modified Bessel function (resample-1.5/filterkit.c, J.O. Smith).
      const I0e = 1e-6;
      let sum = 1, u = 1, n = 1;
      const halfx = x / 2.0;
      do {
        const temp = halfx / n++;
        u *= temp * temp;
        sum += u;
      } while (u >= I0e * sum);
      return sum;
    };

    this.RINGSIZE = 1 << 14;
    this.RINGMASK = this.RINGSIZE - 1;
    this.FIXP_SHIFT = 16;
    this.FIXP_MASK = 0xffff;
    this.FIR_SHIFT = 15;

    this.cyclesPerSampleFx = Math.floor(clock / rate * (1 << this.FIXP_SHIFT) + 0.5);
    this.sampleOffset = 0;
    this.sampleIndex = 0;
    this.sampleRing = new Int16Array(this.RINGSIZE * 2);

    const A = -20 * Math.log10(1.0 / (1 << 16));
    const dw = (1 - 2 * passFreq / rate) * PI * 2;
    const wc = PI;
    const beta = 0.1102 * (A - 8.7);
    const I0beta = I0(beta);

    let N = Math.floor((A - 7.95) / (2.285 * dw) + 0.5);
    N += N & 1;

    const fSamplesPerCycle = rate / clock;
    const fCyclesPerSample = clock / rate;

    let firN = Math.floor(N * fCyclesPerSample) + 1;
    firN |= 1;
    const res = 285;                       // FIR_RES (interpolated mode)
    const n2 = Math.ceil(Math.log(res / fCyclesPerSample) / Math.log(2));
    const firRES = 1 << n2;

    this.firN = firN;
    this.firRES = firRES;
    this.fir = new Int16Array(firN * firRES);
    for (let i = 0; i < firRES; i++) {
      const firOffset = i * firN + (firN >> 1);
      const jOffset = i / firRES;
      for (let j = -(firN >> 1); j <= (firN >> 1); j++) {
        const jx = j - jOffset;
        const wt = wc * jx / fCyclesPerSample;
        const temp = jx / (firN >> 1);
        const kaiser = Math.abs(temp) <= 1 ? I0(beta * Math.sqrt(1 - temp * temp)) / I0beta : 0;
        const sincwt = Math.abs(wt) >= 1e-6 ? Math.sin(wt) / wt : 1;
        const val = (1 << this.FIR_SHIFT) * filterScale * fSamplesPerCycle * wc / PI * sincwt * kaiser;
        this.fir[firOffset + j] = Math.round(val);
      }
    }
  }

  _resetResampleState() {
    this.sampleOffset = 0;
    this.sampleIndex = 0;
    if (this.sampleRing) this.sampleRing.fill(0);
  }

  _fullReset(is8580) {
    // Power cycle: force a brand-new chip (fresh $555555 power-up
    // accumulators) — _synthReset alone is a /RESET pulse and would keep
    // the old accumulator phases.
    this.sid = null;
    this._synthReset(is8580);
    // Same power-cycle semantics on the wasm side: sid_init builds a fresh
    // chip with power-up accumulators and zeroes its clock/event queue
    // (filter-table caches carry over inside the module). The new chip is a
    // new allocation, so the output-buffer pointer MOVES — re-read it and
    // drop the cached view, or every later block copies from freed memory.
    if (this.wasm) {
      this.wasm.sid_init(sampleRate, is8580 ? 1 : 0);
      this.wasmOutPtr = this.wasm.sid_out_ptr();
      this._wasmView = null;
    }
    this.currentCycle = 0;
  }

  _synthReset(is8580) {
    // Drain whatever's in the ring before wiping the mirror so a racing
    // producer can't sneak an entry past us into the next process() tick with
    // a pre-reset cycle stamp.
    if (this.sidCtrl) this._drainRing();
    // /RESET-pulse semantics on a live chip: registers/envelopes/noise/
    // filter clear but the phase accumulators SURVIVE (reSID: "accumulator
    // is not changed on reset"). Only the very first init builds a chip —
    // that's the power cycle, seeding the $555555 power-up accumulators.
    // In WASM mode the JS chip stays the standing render fallback.
    if (this.sid) this.sid.reset();
    else this.sid = new SIDChip(is8580);
    this.sid.setModel(is8580);
    if (this.wasm) {
      this.wasm.sid_reset();
      this.wasm.sid_set_model(is8580 ? 1 : 0);
    }
    this.regShadow.fill(0);
    this.pendHead = 0;
    this.pendCount = 0;
    // Reset the resampler state and re-arm the fade-in so the SID's first
    // ~16 ms of extfilt settling doesn't audibly pop.
    this._resetResampleState();
    this.fadeInRemaining = this.fadeInLen;
    // Re-arm the cycle-sync hook so the next event from the main thread
    // snaps currentCycle into alignment. Without this, currentCycle keeps
    // ticking through process() blocks while the rafLoop is waiting for
    // the next animation frame; by the time CPU emits its first event,
    // worklet's clock is thousands of cycles ahead of the event stamp,
    // and the event applies in a burst at the block boundary instead of
    // at its intended cycle — corrupting digi timing.
    this._needCycleSync = true;
  }

  _drainRing() {
    let ri = Atomics.load(this.sidCtrl, 1);
    const wi = Atomics.load(this.sidCtrl, 0);
    // Backpressure check: the producer (machine._sidWrite) overwrites the ring
    // unconditionally. If we fell more than RING_CAPACITY events behind, the
    // oldest unread entries have been clobbered — count the loss and resync to
    // the newest RING_CAPACITY window (so we read valid, in-order entries).
    let depth = (wi - ri) & 0x7FFFFFFF;
    if (depth > RING_CAPACITY) {
      this.diagOverrun += depth - RING_CAPACITY;
      ri = (wi - RING_CAPACITY) & 0x7FFFFFFF;
      depth = RING_CAPACITY;
    }
    this.diagDrained += depth;
    this._lastDrained = depth;          // fresh arrivals this block (backlog bound)
    while (ri !== wi) {
      const off = (ri & (RING_CAPACITY - 1)) * 2;
      // Mirror full (should never happen: PEND_CAP = 2× ring). Drop the oldest
      // queued event to make room rather than overwrite the live head.
      if (this.pendCount === this.PEND_CAP) {
        this.pendHead = (this.pendHead + 1) & (this.PEND_CAP - 1);
        this.pendCount--;
        this.diagPendDrop++;
      }
      const w = (this.pendHead + this.pendCount) & (this.PEND_CAP - 1);
      this.pendCycle[w] = this.sidRing32[off] >>> 0;
      this.pendPacked[w] = this.sidRing32[off + 1] >>> 0;
      this.pendCount++;
      ri = (ri + 1) & 0x7FFFFFFF;
    }
    Atomics.store(this.sidCtrl, 1, ri);
    if (this.pendCount > this.diagMaxDepth) this.diagMaxDepth = this.pendCount;
  }

  _applyDueEvents() {
    while (this.pendCount > 0) {
      const cycle = this.pendCycle[this.pendHead];
      const delta = (this.currentCycle - cycle) >>> 0;
      if (delta > 0x7FFFFFFF) { this.diagFuture++; break; } // head still future
      const packed = this.pendPacked[this.pendHead];
      const reg = packed & 0x1F;
      const val = (packed >>> 8) & 0xFF;
      this.sid.write(reg, val);
      if (reg <= 24) this.regShadow[reg] = val;
      this.diagApplied++;
      if (delta > this.diagLateMax) this.diagLateMax = delta;
      if (delta > 2000) this.diagLate++; // applied > ~2 ms after its cycle stamp
      this.pendHead = (this.pendHead + 1) & (this.PEND_CAP - 1);
      this.pendCount--;
    }
  }

  _syncClockToEvent(cycle) {
    this.currentCycle = (cycle - EVENT_LOOKAHEAD_CYCLES) >>> 0;
  }

  // Collapse a backlog that the head-distance snap cannot see. That check reads
  // the OLDEST pending event, which stays due-now while a deep queue drains at
  // real-time rate — so a queue spanning seconds still reads as "in sync" there.
  // The lateness is in the TAIL.
  //
  // SID registers are state, not a signal, so fast-forwarding is folding every
  // queued write into the shadow (last write per register wins), dropping the
  // queue, and re-stamping the clock at the tail. The stale audio between here
  // and there is never rendered — which is the point: it is audio the listener
  // should already have heard. Gate edges inside the skipped span collapse to
  // their final state; a 6 ms fade covers the discontinuity.
  _fastForwardBacklog(tailCycle) {
    let i = this.pendHead;
    for (let n = 0; n < this.pendCount; n++) {
      const packed = this.pendPacked[i];
      const reg = packed & 0x1F;
      if (reg <= 24) this.regShadow[reg] = (packed >>> 8) & 0xFF;
      i = (i + 1) & (this.PEND_CAP - 1);
    }
    this.diagApplied += this.pendCount;
    this.pendHead = i;
    this.pendCount = 0;
    this._syncClockToEvent(tailCycle);
    // Replay the collapsed register file into whichever engine is live. The wasm
    // helper re-stamps the module's clock too, so its queue can't strand
    // old-domain events across the jump.
    if (this.engineSel === 'wasm' && this.wasm !== null) {
      this._wasmSyncFromShadow();
    } else if (this.sid) {
      for (let r = 0; r <= 24; r++) this.sid.write(r, this.regShadow[r]);
    }
    this.fadeInRemaining = this.fadeInLen;
    this.diagBacklogFF++;
  }

  // WASM block render: forward due-within-horizon events, render, copy out.
  _processWasm(left, right) {
    const w = this.wasm;
    // Align the wasm clock — no-op in steady state (the module advanced to
    // exactly this cycle last block); carries snaps/resets/switches.
    w.sid_set_cycle(this.currentCycle);
    // Horizon = exactly this render's cycle span (+ slack for fixed-point
    // rounding). Keeping it tight means the wasm queue drains to ~empty
    // every block, so a clock jump (desync snap / thaw resync) has at most
    // a couple of stranded old-domain events for sid_set_cycle to flush.
    const horizon = Math.ceil(left.length * this.cyclesPerSample) + 64;
    while (this.pendCount > 0) {
      const cyc = this.pendCycle[this.pendHead];
      const delta = (cyc - this.currentCycle) >>> 0;
      if (delta <= horizon || delta > 0x7FFFFFFF) {
        const packed = this.pendPacked[this.pendHead];
        const reg = packed & 0x1F;
        const val = (packed >>> 8) & 0xFF;
        w.sid_queue_write(cyc, reg, val);
        if (reg <= 24) this.regShadow[reg] = val;
        this.diagApplied++;
        this.pendHead = (this.pendHead + 1) & (this.PEND_CAP - 1);
        this.pendCount--;
      } else break;
    }
    w.sid_render(left.length);
    // Cached output view; a later sid_set_model() can grow wasm memory and
    // detach it, so rebuild whenever the backing buffer identity changes.
    let view = this._wasmView;
    if (view === null || view.buffer !== w.memory.buffer || view.byteOffset !== this.wasmOutPtr) {
      view = this._wasmView = new Int16Array(w.memory.buffer, this.wasmOutPtr, 512);
    }
    for (let i = 0; i < left.length; i++) {
      let out = view[i] / 32768;
      if (this.fadeInRemaining > 0) {
        out *= 1 - (this.fadeInRemaining / this.fadeInLen);
        this.fadeInRemaining--;
      }
      left[i] = out;
      if (right) right[i] = out;
    }
    this.currentCycle = w.sid_current_cycle() >>> 0;
  }

  process(_inputs, outputs) {
    const ch = outputs[0];
    const left = ch[0];
    const right = ch.length > 1 ? ch[1] : null;

    if (!this.sidCtrl) {
      left.fill(0); if (right) right.fill(0);
      return true;
    }

    this._drainRing();

    // One-shot cycle-sync after every init/reset: start currentCycle slightly
    // BEFORE the first event's cycle. The main thread produces SID writes in
    // frame bursts; the lookahead prevents dense digi writes from arriving
    // late and collapsing into block-boundary distortion.
    if (this._needCycleSync && this.pendCount > 0) {
      this._syncClockToEvent(this.pendCycle[this.pendHead]);
      this._needCycleSync = false;
    }

    // Desync recovery: if the oldest pending event is more than 0.5 s
    // away from currentCycle in either direction, the worklet's clock
    // and the main thread's sidCycleCounter have drifted apart. Snap
    // currentCycle to the head event's cycle so it applies on the
    // intended audio frame. Without this, after a power-cycle the
    // worklet's currentCycle could be tens of millions of cycles ahead
    // of (or behind) the freshly-zeroed main-thread counter — events
    // would apply in stale bursts at block boundaries, destroying the
    // digi timing for as long as it takes the slower clock to catch up
    // (sometimes a full minute of recovery, per user reports).
    if (this.pendCount > 0) {
      const headCycle = this.pendCycle[this.pendHead];
      const cc = this.currentCycle;
      const futureDelta = (headCycle - cc) >>> 0;
      const pastDelta = (cc - headCycle) >>> 0;
      const dist = Math.min(futureDelta, pastDelta);
      if (dist > 492624) {  // > 0.5 s
        this._syncClockToEvent(headCycle);
      }
    }

    // Backlog bound. The snap above measures the head, which a steadily draining
    // queue keeps at ~0 no matter how deep the queue is, so it cannot see
    // accumulated lateness — see _fastForwardBacklog.
    //
    // Depth alone is not enough to act on: a queue can also be deep because a
    // long horizon of events was handed over in one go and is now being played
    // out on their exact stamps, which is correct and must not be collapsed.
    // What identifies real lateness is that the producer KEEPS writing while we
    // are over the ceiling — we are behind a live stream, not working through a
    // batch. So require fresh arrivals over the ceiling on consecutive blocks.
    if (this.pendCount > 0) {
      const tailCycle = this.pendCycle[(this.pendHead + this.pendCount - 1) & (this.PEND_CAP - 1)];
      const ahead = (tailCycle - this.currentCycle) >>> 0;
      if (ahead <= 0x7FFFFFFF && ahead > MAX_BACKLOG_CYCLES) {
        // Count producer WRITES, not blocks: register bursts are one frame
        // apart, so consecutive blocks would almost never both see arrivals.
        // Three separate bursts while continuously over the ceiling is a live
        // stream we are behind; one burst is a pre-queued batch.
        if (this._lastDrained > 0) this._backlogStreak++;
        if (this._backlogStreak >= 3) {
          this._fastForwardBacklog(tailCycle);
          this._backlogStreak = 0;
        }
      } else {
        this._backlogStreak = 0;
      }
    } else {
      this._backlogStreak = 0;
    }

    // WASM engine: block-render path. Events forward into the wasm event
    // queue with their exact cycle stamps (the module applies them
    // per-cycle, same as _applyDueEvents); the JS pend mirror above keeps
    // the lookahead/desync-snap semantics identical for all engines. The
    // JS chip stays instantiated as the instant fallback (and renders
    // while the module is still instantiating).
    if (this.engineSel === 'wasm' && this.wasm !== null) {
      this._processWasm(left, right);
      this._postBlock();
      return true;
    }

    // Generate audio samples.
    //
    // Event-due gate (both engines): _applyDueEvents() runs once per SID
    // cycle; in steady state the queue head is future and every call does a
    // typed-array load + wrap-safe subtract only to conclude "nothing due".
    // Hoist that decision to once per audio SAMPLE: _drainRing() ran before
    // this loop, so no event can arrive mid-loop and the head is the
    // earliest pending stamp — if it is more than `count` cycles away it
    // cannot come due before the next sample (`<= count` inclusive: the
    // trailing call after the inner loop is the +count probe). The
    // `> 0x7FFFFFFF` term means the head is already in the PAST — without
    // it a past-due head reads as a ~2^32 distance and its events would be
    // silently dropped (audible).
    for (let i = 0; i < left.length; i++) {
      let out;
      // reSID sid.cc clock_resample (SAMPLE_RESAMPLE): fixed-point cycle
      // advance, raw chip output into the ring, then a dual-phase
      // Kaiser-sinc FIR convolution with linear interpolation between
      // adjacent phase tables.
      const nextOffset = this.sampleOffset + this.cyclesPerSampleFx;
      const count = nextOffset >> this.FIXP_SHIFT;
      let due = false;
      if (this.pendCount > 0) {
        const headDelta = (this.pendCycle[this.pendHead] - this.currentCycle) >>> 0;
        due = headDelta <= count || headDelta > 0x7FFFFFFF;
      }
      const ring = this.sampleRing, RS = this.RINGSIZE;
      for (let c = 0; c < count; c++) {
        if (due) this._applyDueEvents();
        const s = this.sid.clockRaw();
        ring[this.sampleIndex] = ring[this.sampleIndex + RS] = s;
        this.sampleIndex = (this.sampleIndex + 1) & this.RINGMASK;
        this.currentCycle = (this.currentCycle + 1) >>> 0;
      }
      if (due) this._applyDueEvents();
      this.sampleOffset = nextOffset & this.FIXP_MASK;

      const firOffset = (this.sampleOffset * this.firRES) >> this.FIXP_SHIFT;
      const firOffsetRmd = (this.sampleOffset * this.firRES) & this.FIXP_MASK;
      const fir = this.fir, firN = this.firN;
      const firStart = firOffset * firN;
      const smpStart = this.sampleIndex - firN - 1 + RS;
      let v1 = 0;
      let v2 = 0;
      if (firOffset + 1 !== this.firRES) {
        // Common case (15/16 samples): both phase tables convolve the SAME
        // sample window — fuse the loops so each ring sample loads once.
        const fB = firStart + firN;
        for (let j = 0; j < firN; j++) {
          const s = ring[smpStart + j];
          v1 += fir[firStart + j] * s;
          v2 += fir[fB + j] * s;
        }
      } else {
        // Phase wrap: the second convolution uses table 0 shifted one
        // sample later (reSID: ++fir_offset wraps, ++sample_start).
        for (let j = 0; j < firN; j++) v1 += fir[firStart + j] * ring[smpStart + j];
        const s2 = smpStart + 1;
        for (let k = 0; k < firN; k++) v2 += fir[k] * ring[s2 + k];
      }
      v1 |= 0;
      v2 |= 0;
      // Linear interpolation between the two convolutions (the unsigned
      // 32-bit wrap of the reference is reproduced with >>> 0).
      let v = (v1 + ((((firOffsetRmd * (v2 - v1)) >>> 0) >>> this.FIXP_SHIFT) | 0)) | 0;
      v >>= this.FIR_SHIFT;
      // reSID wrapper amplify(): clip(scaleFactor·v/2) → ±1.0 float.
      out = clip16(((this.sid.scaleFactor * v) / 2) | 0) / 32768;
      // Brief fade-in to mask the initial output-stage settling transient.
      if (this.fadeInRemaining > 0) {
        const gain = 1 - (this.fadeInRemaining / this.fadeInLen);
        out *= gain;
        this.fadeInRemaining--;
      }
      left[i] = out;
      if (right) right[i] = out;
    }

    this._postBlock();
    return true;
  }

  // Shared per-block tail (all engines): OSC3/ENV3 debug tap + diag report.
  _postBlock() {
    // Publish voice-3 OSC3 / ENV3 into the shared buffer (slots [2]/[3]).
    // NOTE: the main thread no longer reads these — $D41B/$D41C are served
    // cycle-exact by the main-thread shadow voices (machine.js), so this is a
    // worklet-side tap kept for debugging/inspection only. readOsc3() is the
    // clocked-pipeline value (getOscByte() is pure these days too, but the
    // pipeline tap is the hardware-correct read). In WASM mode the JS chip
    // idles, so the tap freezes — harmless for a debug-only channel.
    Atomics.store(this.sidCtrl, 2, this.sid.v3.readOsc3());
    Atomics.store(this.sidCtrl, 3, this.sid.v3.env3);

    // Diagnostic: every ~1 second, post stats summarizing event flow
    // so we can verify cycle-sync across power-cycles.
    if ((this.currentCycle - this.diagLastReportCycle) >>> 0 >= 985248) {
      const pendingDepth = this.pendCount;
      const oldestFuture = pendingDepth > 0
        ? ((this.pendCycle[this.pendHead] - this.currentCycle) | 0)
        : 0;
      this.port.postMessage({
        type: 'diag-period',
        currentCycle: this.currentCycle,
        wi: Atomics.load(this.sidCtrl, 0),
        ri: Atomics.load(this.sidCtrl, 1),
        applied: this.diagApplied,
        future: this.diagFuture,
        drained: this.diagDrained,
        pendingDepth,
        maxDepth: this.diagMaxDepth,
        oldestFutureΔ: oldestFuture,
        lateMax: this.diagLateMax,
        late: this.diagLate,
        overrun: this.diagOverrun,
        pendDrop: this.diagPendDrop,
        backlogFF: this.diagBacklogFF,
      });
      this.diagApplied = 0;
      this.diagFuture = 0;
      this.diagDrained = 0;
      this.diagLateMax = 0;
      this.diagLate = 0;
      this.diagOverrun = 0;
      this.diagMaxDepth = 0;
      this.diagPendDrop = 0;
      this.diagLastReportCycle = this.currentCycle;
    }
  }
}

registerProcessor('sid-processor', SIDProcessor);
