// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// Portions translated or derived from reSID as distributed in VICE 3.10's
// src/resid tree (wave.h/wave.cc, envelope.h/envelope.cc, dac.cc; voice
// output semantics from voice.h/voice.cc), Copyright (C) 2010 Dag Lem
// <resid@nimrod.no> (voice.cc portions (C) 2004), GNU GPL version 2 or (at
// your option) any later version; upstream pin and full attribution in
// NOTICE.txt.
// src/sid-voice.js — One SID voice (oscillator + envelope generator).
//
// Shared between the audio worklet (which uses 3 voices + filter + mixing
// inside an AudioWorkletProcessor) and the main thread shadow (which clocks
// 3 voices in lockstep with the CPU just to provide cycle-exact $D41B/$D41C
// readback for the SIDProxy — without re-running filter/mixing/saturator,
// which would be wasted work).

import { WAVETABLES_6581, WAVETABLES_8580 } from './sid-wavetables.js';
import { buildDacTableU16 } from './sid-dac.js';

// Standard ADSR rate periods (in cycles) for the 16 ADSR rate values — the
// EFFECTIVE (measured) period, e.g. resid-test/envrate reads $0009 for rate 0.
// Source: Bob Yannes SID Reference, reSID `envelope.cc`.
export const RATE_PERIODS = [9,32,63,95,149,220,267,313,392,977,1954,3126,3907,11720,19532,31251];

// reSID's rate_counter_period[] — the COMPARATOR value the rate counter is
// checked against. The effective period is this + 1 because the counter reset
// is deferred one cycle (see clockCore(): on match we set resetRateCounter and
// do NOT increment, so the reset lands next cycle). = RATE_PERIODS − 1.
const RATE_CMP = RATE_PERIODS.map(p => p - 1);

// Envelope state machine (reSID EnvelopeGenerator::State, remapped to our
// historical numbering so save-states stay compatible): release/idle = 0,
// attack = 1, decay/sustain = 2, freezed = 3.
const S_RELEASE = 0, S_ATTACK = 1, S_DECAY = 2, S_FREEZED = 3;

// LFSR bit positions that map to the 8 noise output bits (MSB first), per
// reSID / resid-test noisetest: noiseV bit 7 ← LFSR bit 20, bit 6 ← bit 18,
// bit 5 ← 14, bit 4 ← 11, bit 3 ← 9, bit 2 ← 5, bit 1 ← 2, bit 0 ← 0.
// The same positions carry the combined-NOISE "zero clobbering" writeback
// (_writeShiftRegister spells them out as a mask expression).
export const NOISE_TAPS = [20, 18, 14, 11, 9, 5, 2, 0];

// Floating waveform-DAC decay (waveform 0 selected): the DAC input holds its
// last value, then decays pairwise (out &= out >> 1) — first step after the
// START interval, further steps at the BIT interval until zero. Constants
// are reSID wave.cc FLOATING_OUTPUT_TTL_* (SOAS/C samplings of the analog
// output): ~200 ms hold on the 6581, ~5 s on the 8580. Replaced this
// project's earlier uniform ~0.37 s/step approximation — VICE 3.10 parity.
const FLOAT_TTL_START_6581 = 182000;
const FLOAT_TTL_BIT_6581 = 1500;
const FLOAT_TTL_START_8580 = 4400000;
const FLOAT_TTL_BIT_8580 = 50000;

// While the TEST bit is held, the noise shift register is not clocked; its
// SRAM cells slowly leak toward 1. VICE's resid models this as a measured
// GRADUAL fade (reSID 1.0 approximates it as one ~$8000-cycle jump): after
// START cycles of TEST the first fade step fires, then one step per BIT
// interval until the register reads all-ones. Each step lights bit 0 and
// every set bit pulls its left neighbour up (shiftreg_bitfade) — verified
// byte-exact against VICE x64sc reSID on both models (noise-run.mjs P4).
const LFSR_FADE_START_6581 = 35000;
const LFSR_FADE_BIT_6581 = 1000;
const LFSR_FADE_START_8580 = 2519864;
const LFSR_FADE_BIT_8580 = 315000;

// Measured combined-waveform tables (reSID wave.cc model_wave — OSC3
// samplings of real 6581/8580 chips; data + provenance in
// src/sid-wavetables.js). Entries are the 12-bit waveform-DAC input
// (8-bit OSC3 sample << 4, low 4 bits grounded). ST/PS/PST are indexed by
// the top 12 accumulator bits; PT by the same after the ring-mod MSB
// substitution — reSID wave.h computes one shared index
//   ix = (acc ^ (~sync_src_acc & ring_msb_mask)) >> 12
// where ring_msb_mask is nonzero only when RING is on and SAW is off (the
// saw selector blocks the MSB EOR on the chip), so for ST/PS/PST the index
// degenerates to acc >> 12. These replaced this project's fitted synthetic
// tables (residual OSC3 mean-abs-error 0.35-7.55 vs VICE) with the chip
// data itself — byte-exact against the VICE 3.10 oracle by construction.
export const COMBINED_6581 = WAVETABLES_6581;
export const COMBINED_8580 = WAVETABLES_8580;

// ── R-2R DAC models (reSID dac.cc tables) ────────────────────────────────
// The chip's DACs are R-2R ladders. The 6581's lacks the termination
// resistor at the LSB end and its effective 2R/R ratio is ~2.20 (resistor
// mismatch / NMOS output impedance), producing audible code discontinuities
// — part of the 6581 sound. The 8580's ladder is terminated with 2R/R ≈
// 2.00. reSID's builder additionally models subthreshold MOSFET leakage:
// an UNSET bit still contributes 0.75% (6581) / 0.35% (8580) of its weight,
// so code 0 sits above true zero (≈31 LSB on the 6581 wave DAC) — this
// leakage floor is part of the measured digi/DC behavior. Tables are the
// rounded uint16 values reSID uses (verified equivalent to this project's
// earlier nodal solver to 4.6e-13 LSB before leakage/rounding).
export const WAVE_DAC_6581 = buildDacTableU16(12, 2.20, false);
export const WAVE_DAC_8580 = buildDacTableU16(12, 2.00, true);
export const ENV_DAC_6581 = buildDacTableU16(8, 2.20, false);
export const ENV_DAC_8580 = buildDacTableU16(8, 2.00, true);
// Waveform-DAC "zero" level the envelope multiplier pivots around: measured
// $380 on the 6581 (reSID voice.cc — the analog zero sits at OSC3 $38, NOT
// mid-scale). The 8580 has no comparable DC offsets; reSID pivots it at
// $9E0, which cancels the DAC leakage floor of the terminated ladder (NOT
// the naive mid-scale $800 this project used before the port). The
// asymmetric 6581 pivot is what makes gate/waveform transitions thump.
export const WAVE_ZERO_6581 = 0x380;
export const WAVE_ZERO_8580 = 0x9e0;

export class SIDVoice {
  constructor() {
    this.freq=0; this.pw=0; this.ctrl=0;
    this.a=0; this.d=0; this.s=0; this.r=0;
    // Power-up oscillator accumulator = $555555 (all bits 1, odd bits stored
    // inverted), and it is NOT cleared by reset — oscinit.prg checks this.
    this.phase=0x555555; this.prevPhase=0x555555;
    // Envelope generator (reSID EnvelopeGenerator, cycle-accurate pipelined
    // model). `env` is the live envelope counter (feeds the audio multiplier);
    // `env3` is the value latched at the START of each clock — this is what
    // $D41C reads (a one-cycle readback delay, verified by env_test).
    this.env=0; this.env3=0; this.rateCounter=0; this.expCounter=0; this.state=S_RELEASE;
    // reSID reset state: comparator = release period, exp period 1, frozen at
    // zero until the first gate-on. ratePeriod is the stored comparator (reSID
    // rate_period); pipelines are all idle.
    this.ratePeriod=RATE_CMP[0]; this.expPeriod=1; this.holdZero=true;
    this.envPipeline=0; this.expPipeline=0; this.statePipeline=0;
    this.resetRateCounter=false; this.nextState=S_RELEASE;
    // Power-on LFSR = $7FFFFF clocked once when reset releases (reSID
    // wave.cc reset(): "when reset is released the shift register is
    // clocked once" → $7FFFFE). The noise OUTPUT is a latch refreshed only
    // when the register shifts / writes back / resets — not per cycle.
    this.lfsr=0x7FFFFE; this.noiseVal=0; this._setNoiseOutput();
    // 2-cycle shift pipeline: a bit-19 rise arms it at 2; the register
    // shifts when it counts down to 0 (reSID wave.h shift_pipeline).
    this.shiftPipeline=0;
    // Last waveform-selector output (12-bit) — reSID's waveform_output
    // latch; consumed by the TEST-fall pre-writeback.
    this._out12=0;
    // Countdown for the TEST-held slow fill-to-1s (armed on TEST 0→1).
    this._lfsrResetCtr=0;
    this.syncSrc=null;
    this.is8580=false;   // accessor: also resolves the per-model table refs
    // Floating waveform-DAC decay timer: while waveform 0 is selected the DAC
    // input (_out12, reSID waveform_output) is held and decays pairwise.
    // floatTtl counts down to the next fade step; 0 = idle / fully decayed.
    // Armed on the waveform-deselect write (reSID FLOATING_OUTPUT_TTL_START).
    this.floatTtl=0;
    // 8580 OSC3 tri/saw pipeline (reSID wave.h tri_saw_pipeline): the 8580
    // latches the tri/saw (table) component of the waveform in the first
    // clock phase, so OSC3 sees it one cycle late — while the pulse rail
    // and the noise latch mask it LIVE. Pulse-only/noise-only reads are NOT
    // delayed (chipmodel.prg / osc_topbit used saw, which is). Power-up
    // $555 like the accumulator's alternating-bit pattern. _oscLive holds
    // the current OSC3 read value on both models.
    this._triSawPipe=0x555;
    this._oscLive=0;
    // Pulse rail LATCH (reSID pulse_output): the PW compare is delayed one
    // cycle — outputStage pushes the next level at its end, PW writes and
    // TEST refresh it immediately, and TEST holds it high every clock.
    this.pulseOut=0xFFF;
    // Per-cycle transient (set by computeSyncPulses; never serialized):
    // hard-sync decision for THIS cycle.
    this.syncPulse=false;
  }

  // Chip model. A plain-looking property backed by an accessor so the many
  // existing `v.is8580 = …` write sites (machine shadow, worklet chip,
  // tests) keep working unchanged, while the hot per-cycle paths read
  // pre-resolved per-model refs (_wdac/_edac/_wz + the four measured
  // combined tables) instead of branching on the model ~6× per cycle.
  // Model writes are rare (power-on / Settings toggle) — cold setter.
  get is8580() { return this._is8580; }
  set is8580(v) {
    v = !!v;
    if (v === this._is8580 && this._wdac !== undefined) return;
    this._is8580 = v;
    if (v) {
      this._wdac = WAVE_DAC_8580; this._edac = ENV_DAC_8580; this._wz = WAVE_ZERO_8580;
      this._wtST = WAVETABLES_8580.ST; this._wtPT = WAVETABLES_8580.PT;
      this._wtPS = WAVETABLES_8580.PS; this._wtPST = WAVETABLES_8580.PST;
    } else {
      this._wdac = WAVE_DAC_6581; this._edac = ENV_DAC_6581; this._wz = WAVE_ZERO_6581;
      this._wtST = WAVETABLES_6581.ST; this._wtPT = WAVETABLES_6581.PT;
      this._wtPS = WAVETABLES_6581.PS; this._wtPST = WAVETABLES_6581.PST;
    }
  }

  // ── Noise shift register (reSID wave.h, P7) ──────────────────────────────
  // Normal shift: feedback bit0 = bit22 ⊕ bit17, register is 23 bits wide.
  _clockShiftRegister() {
    const b=((this.lfsr>>22)^(this.lfsr>>17))&1;
    this.lfsr=((this.lfsr<<1)|b)&0x7FFFFF;
    this._setNoiseOutput();
  }
  // Refresh the latched noise output from the register taps
  // {20,18,14,11,9,5,2,0} → output bits 7..0 (× 16 = waveform bits 11..4).
  _setNoiseOutput() {
    const l=this.lfsr;
    this.noiseVal=((l&0x100000)>>13)|((l&0x040000)>>12)|((l&0x004000)>>9)|
                  ((l&0x000800)>>7)|((l&0x000200)>>6)|((l&0x000020)>>3)|
                  ((l&0x000004)>>1)|(l&0x000001);
  }
  // Combined-noise writeback ("zero clobbering"): the waveform selector
  // output is connected back onto the shift register taps, so a low output
  // bit pulls the corresponding register bit low — a bit can be cleared,
  // never set. The latched noise output degrades the same way immediately.
  _writeShiftRegister(out12) {
    this.lfsr &= ~((1<<20)|(1<<18)|(1<<14)|(1<<11)|(1<<9)|(1<<5)|(1<<2)|(1<<0)) |
      ((out12&0x800)<<9) | ((out12&0x400)<<8) | ((out12&0x200)<<5) |
      ((out12&0x100)<<3) | ((out12&0x080)<<2) | ((out12&0x040)>>1) |
      ((out12&0x020)>>3) | ((out12&0x010)>>4);
    this.noiseVal &= (out12>>4)&0xFF;
  }
  // One TEST-held SRAM fade step (VICE resid shiftreg_bitfade): bit 0
  // lights, every set bit pulls its left neighbour up, and the fade re-arms
  // at the per-model BIT interval until the register reads all-ones.
  // Deliberately unmasked like the reference — a transient bit 23 is
  // swept away by the next (masked) shift and never reaches the taps.
  _shiftregBitfade() {
    this.lfsr|=1;
    this.lfsr|=this.lfsr<<1;
    this._setNoiseOutput();
    if(this.lfsr!==0x7FFFFF) this._lfsrResetCtr=this._is8580?LFSR_FADE_BIT_8580:LFSR_FADE_BIT_6581;
  }
  // Does a TEST-falling edge flush the selector output into the register
  // before the release shift? Empirical per-model rules (reSID wave.cc
  // do_pre_writeback): only from a combined-noise waveform, never INTO
  // plain noise, with model-specific exceptions for noise+pulse ($C) and
  // 6581 tri↔saw swaps.
  _doPreWriteback(wfPrev, wf) {
    if (wfPrev <= 8) return false;
    // NB: reSID gates "&& waveform != 8" behind `#if 0` ("needs more
    // investigation") — it is NOT active, so we don't gate it either. Writing
    // back INTO plain noise DOES happen: noiselfsrinit/simple's $F8→$80 init
    // dance relies on it (ours read $06 with the guard, $7F without — real
    // 8580 = $7F, VICE agrees). TRADE-OFF (intentional, VICE-aligned): dropping
    // the guard also makes the wb_testsuite/noisewriteback X→8 combined-noise
    // writeback cases fail — but VICE 3.10 fails them identically (a shared
    // reSID combined-waveform-model limit). The old guard was a local hack that
    // passed those 13 tests at the cost of noiselfsrinit; we choose reSID
    // fidelity.
    if (wfPrev === 0xC) {
      if (!this._is8580) return false;
      if (wf !== 0x9 && wf !== 0xE) return false;
    }
    if (!this._is8580 &&
        ((((wfPrev&3)===1) && ((wf&3)===2)) || (((wfPrev&3)===2) && ((wf&3)===1)))) return false;
    return true;
  }

  // /RESET pulse (reSID wave.cc + envelope.cc reset()): every register and
  // the envelope/noise state clear, but the PHASE ACCUMULATOR SURVIVES —
  // the chip's accumulator has no reset line (oscinit.prg checks this; only
  // a power cycle re-seeds the $555555 power-up pattern via the ctor).
  reset() {
    this.freq=0; this.pw=0; this.ctrl=0;
    this.a=0; this.d=0; this.s=0; this.r=0;
    // phase / prevPhase intentionally untouched.
    this.env=0; this.env3=0; this.rateCounter=0; this.expCounter=0; this.state=S_RELEASE;
    this.ratePeriod=RATE_CMP[0]; this.expPeriod=1; this.holdZero=true;
    this.envPipeline=0; this.expPipeline=0; this.statePipeline=0;
    this.resetRateCounter=false; this.nextState=S_RELEASE;
    this.lfsr=0x7FFFFE; this._setNoiseOutput();
    this.shiftPipeline=0; this._lfsrResetCtr=0;
    this.floatTtl=0;
    this._oscLive=0; this._out12=0; this.pulseOut=0xFFF;
    // _triSawPipe intentionally untouched (reSID reset() leaves
    // tri_saw_pipeline alone — 1-cycle-deep state, like the accumulator).
    this.syncPulse=false;
  }

  // Will this voice's accumulator MSB (bit 23) rise on the coming clock?
  // Depends only on the voice's own state — see computeSyncPulses().
  predictMsbRise() {
    if (this.ctrl & 0x08) return false;                 // TEST pins phase at 0
    return (this.phase & 0x800000) === 0 &&
           ((this.phase + this.freq) & 0x800000) !== 0;
  }

  // Latched exponential-counter period (reSID set_exponential_counter):
  // updated only when the envelope counter REACHES a comparator value —
  // between thresholds the period keeps its latched value. Reaching $00
  // also freezes the envelope (holdZero) until the next gate-on.
  _setExpPeriod() {
    switch (this.env) {
      case 0xFF: this.expPeriod = 1; break;
      case 0x5D: this.expPeriod = 2; break;
      case 0x36: this.expPeriod = 4; break;
      case 0x1A: this.expPeriod = 8; break;
      case 0x0E: this.expPeriod = 16; break;
      case 0x06: this.expPeriod = 30; break;
      case 0x00: this.expPeriod = 1; this.holdZero = true; break;
    }
  }

  // ── Save-state ──────────────────────────────────────────────────────────
  // Oscillator + envelope + LFSR state. `syncSrc` (a reference to the
  // ring-mod/sync source voice) and `is8580` are re-wired/re-applied by the
  // machine, so they are not captured here.
  serialize() {
    return {
      freq:this.freq, pw:this.pw, ctrl:this.ctrl,
      a:this.a, d:this.d, s:this.s, r:this.r,
      phase:this.phase, prevPhase:this.prevPhase,
      env:this.env, env3:this.env3, rateCounter:this.rateCounter, expCounter:this.expCounter, state:this.state,
      ratePeriod:this.ratePeriod, expPeriod:this.expPeriod, holdZero:this.holdZero,
      envPipeline:this.envPipeline, expPipeline:this.expPipeline, statePipeline:this.statePipeline,
      resetRateCounter:this.resetRateCounter, nextState:this.nextState,
      lfsr:this.lfsr, noiseVal:this.noiseVal, _lfsrResetCtr:this._lfsrResetCtr,
      shiftPipeline:this.shiftPipeline, _out12:this._out12,
      floatTtl:this.floatTtl,
      _oscLive:this._oscLive, _triSawPipe:this._triSawPipe, pulseOut:this.pulseOut,
    };
  }

  deserialize(o) {
    this.freq=o.freq|0; this.pw=o.pw|0; this.ctrl=o.ctrl|0;
    this.a=o.a|0; this.d=o.d|0; this.s=o.s|0; this.r=o.r|0;
    this.phase=o.phase>>>0; this.prevPhase=o.prevPhase>>>0;
    this.env=o.env|0; this.env3=o.env3 ?? this.env; this.rateCounter=o.rateCounter|0; this.expCounter=o.expCounter|0;
    // Legacy saves used a dedicated frozen sustain state (3); decay/sustain
    // is one state (2) now — see clockCore().
    this.state=(o.state|0)===3?2:(o.state|0);
    // Envelope fields, with legacy-save defaults: derive the latched exp period
    // from env via the threshold map (equivalent for monotonic envelopes),
    // freeze only a zeroed non-attacking envelope, idle pipelines. ratePeriod
    // (reSID comparator) is reconstructed from the current state's rate nibble.
    const e=this.env;
    this.expPeriod=o.expPeriod ?? (e<=6?30:e<=14?16:e<=26?8:e<=54?4:e<=93?2:1);
    this.holdZero=o.holdZero ?? (e===0 && this.state!==S_ATTACK);
    this.ratePeriod=o.ratePeriod ?? RATE_CMP[this.state===S_ATTACK?this.a:this.state===S_DECAY?this.d:this.r];
    this.expPipeline=o.expPipeline|0; this.statePipeline=o.statePipeline|0;
    this.resetRateCounter=o.resetRateCounter ?? false; this.nextState=o.nextState ?? this.state;
    this.envPipeline=o.envPipeline|0;
    this.lfsr=o.lfsr>>>0; this.noiseVal=o.noiseVal|0; this._lfsrResetCtr=o._lfsrResetCtr|0;
    // P7 fields. Legacy saves recomputed the noise output from the register
    // every cycle, so refresh the latch from the taps on load.
    this.shiftPipeline=o.shiftPipeline|0; this._out12=o._out12|0;
    if(o.shiftPipeline===undefined) this._setNoiseOutput();
    // Floating-DAC state. Legacy saves carried an 8-bit oscLatch plus a
    // uniform fade counter; map the byte back into the 12-bit floating DAC
    // input and re-arm a per-BIT fade so old saves keep decaying. (is8580 is
    // re-applied by the machine after deserialize; the BIT pick here is a
    // best-effort seed for a state that is approximate across saves anyway.)
    this.floatTtl = o.floatTtl ?? 0;
    if (o.floatTtl === undefined && (o.ctrl & 0xF0) === 0 && o.oscLatch) {
      this._out12 = (o.oscLatch << 4) & 0xFF0;
      this.floatTtl = this._is8580 ? FLOAT_TTL_BIT_8580 : FLOAT_TTL_BIT_6581;
    }
    this._oscLive=o._oscLive|0;
    // Legacy saves carry oscPrev (the old whole-byte 8580 delay tap) instead
    // of the tri/saw pipeline value; either way the pipe refills next cycle.
    this._triSawPipe=o._triSawPipe ?? 0x555;
    // Legacy saves have no pulse latch — seed it with the live compare
    // (equal to the latch except across a single in-flight edge cycle).
    this.pulseOut=o.pulseOut ?? (((o.ctrl&0x08) || (o.phase>>>0) >= ((o.pw&0x0FFF)<<12)) ? 0xFFF : 0x000);
  }

  write(reg,val) {
    switch(reg) {
      case 0: this.freq=(this.freq&0xFF00)|val; break;
      case 1: this.freq=(this.freq&0x00FF)|(val<<8); break;
      // PW writes push the new compare result into the pulse latch
      // immediately (reSID writePW_LO/HI — no test term; under TEST the
      // next clock re-forces the rail high anyway).
      case 2: this.pw=(this.pw&0x0F00)|val;
              this.pulseOut=this.phase>=((this.pw&0x0FFF)<<12)?0xFFF:0x000; break;
      case 3: this.pw=(this.pw&0x00FF)|((val&0x0F)<<8);
              this.pulseOut=this.phase>=((this.pw&0x0FFF)<<12)?0xFFF:0x000; break;
      case 4: {
        const prevGate=this.ctrl&1; const prevTest=this.ctrl&0x08;
        const prevWf=(this.ctrl>>4)&0x0F;
        this.ctrl=val; const gate=val&1; const test=val&0x08;
        if(!!gate!==!!prevGate) {
          // Gate transition (reSID writeCONTROL_REG). The rate counter is NOT
          // reset, so there's a delay before the envelope starts counting;
          // that delay + the state pipeline is what env_test measures.
          this.nextState = gate ? S_ATTACK : S_RELEASE;
          if(gate) {
            // The decay register is "accidentally" activated during the first
            // cycle of attack; the attack rate takes over when state_change
            // flips to ATTACK two cycles later.
            this.state=S_DECAY; this.ratePeriod=RATE_CMP[this.d]; this.statePipeline=2;
            if(this.resetRateCounter || this.expPipeline===2) {
              this.envPipeline = (this.expPeriod===1 || this.expPipeline===2) ? 2 : 4;
            } else if(this.expPipeline===1) { this.statePipeline=3; }
          } else {
            this.statePipeline = this.envPipeline>0 ? 3 : 2;
          }
        }
        if(test&&!prevTest) {
          // TEST set: hold the LFSR; arm the slow fade-to-1s countdown,
          // flush any in-flight pipelined shift, and force the pulse rail
          // high (reSID writeCONTROL_REG).
          this._lfsrResetCtr=this._is8580?LFSR_FADE_START_8580:LFSR_FADE_START_6581;
          this.shiftPipeline=0;
          this.pulseOut=0xFFF;
        } else if(!test&&prevTest) {
          // TEST released: during the held first shift phase the register
          // bits are interconnected, so a combined-noise selector output may
          // overwrite the latched values before the shift completes — the
          // model-dependent pre-writeback (reSID do_pre_writeback), using
          // the last selector output.
          if(this._doPreWriteback(prevWf,(val>>4)&0x0F)) this._writeShiftRegister(this._out12);
          // Then the held shift completes — clock the LFSR once with the
          // release feedback bit0 = (bit22|test)⊕bit17 = ¬bit17 (reSID
          // writeCONTROL_REG / noisetest), NOT the normal bit22⊕bit17.
          this.lfsr=((this.lfsr<<1)|((~this.lfsr>>17)&1))&0x7FFFFF;
          this._setNoiseOutput();
          this._lfsrResetCtr=0;
        }
        // Waveform deselected: the DAC input starts floating — arm the decay
        // countdown (reSID writeCONTROL_REG → FLOATING_OUTPUT_TTL_START_*).
        if(((val>>4)&0x0F)===0 && prevWf!==0) {
          this.floatTtl=this._is8580?FLOAT_TTL_START_8580:FLOAT_TTL_START_6581;
        }
        break;
      }
      // AD / SR writes reload the stored comparator if the current state's
      // rate nibble changed (reSID writeATTACK_DECAY / writeSUSTAIN_RELEASE).
      case 5: this.a=val>>4; this.d=val&0x0F;
              if(this.state===S_ATTACK) this.ratePeriod=RATE_CMP[this.a];
              else if(this.state===S_DECAY) this.ratePeriod=RATE_CMP[this.d];
              break;
      case 6: this.s=val>>4; this.r=val&0x0F;
              if(this.state===S_RELEASE) this.ratePeriod=RATE_CMP[this.r];
              break;
    }
  }
  // Stage 1 of a voice cycle: phase accumulator (applying this cycle's
  // hard-sync pulse), noise LFSR and envelope. The waveform output / OSC3
  // pipeline / noise writeback live in outputStage(), which must run AFTER
  // computeSyncPulses() + clockCore() of ALL THREE voices, so ring mod and
  // the PT table read post-sync source phases — reSID's ordering: clock all
  // oscillators, synchronize, then compute waveform outputs (sid.h clock).
  clockCore() {
    // Phase accumulator
    this.prevPhase=this.phase;
    const testBit=this.ctrl&0x08;
    if(testBit) {
      this.phase=0;
      // TEST holds the pulse rail high every clock (reSID) — the output
      // stage's end-of-cycle push is overwritten here before it is read.
      this.pulseOut=0xFFF;
      // TEST holds the noise shift register (no clocking); while held its
      // SRAM cells gradually fade toward all-1s (VICE resid
      // shiftreg_bitfade — START delay, then one step per BIT interval).
      if(this._lfsrResetCtr>0 && --this._lfsrResetCtr===0) this._shiftregBitfade();
    } else {
      // The noise register is clocked on the RISING edge of accumulator
      // bit 19 (reSID), not on the full 24-bit phase wrap — ~16× more
      // often. The edge comes from the ADD itself: a hard sync zeroing the
      // accumulator does not cancel the shift (reSID detects
      // accumulator_bits_set before synchronize runs). The shift itself is
      // DELAYED 2 CYCLES through shiftPipeline — detect, phase 1, phase 2 —
      // and the pipeline only counts on edge-free cycles (reSID's else-if).
      const added=(this.phase+this.freq)&0xFFFFFF;
      if(!(this.prevPhase&0x080000) && ((added&0x080000)!==0)) {
        this.shiftPipeline=2;
      } else if(this.shiftPipeline!==0 && --this.shiftPipeline===0) {
        this._clockShiftRegister();
      }
      // Hard sync per this cycle's trio decision (computeSyncPulses): the
      // source's MSB RISE with the mutual-sync exception. Replaces the old
      // wrap-of-source check, which fired half a source period late and saw
      // a one-cycle-stale v3 when v1 was the destination.
      this.phase = this.syncPulse ? 0 : added;
    }

    // ── Envelope generator: faithful reSID EnvelopeGenerator::clock() ─────
    // The cycle-accurate pipelined model (VICE's resid/envelope.h). ENV3 is
    // sampled at the FIRST phase of the clock — this one-cycle readback delay,
    // together with the state/envelope pipelines below, is exactly what the
    // env_test suite measures. `env3` is what $D41C reads; `env` is the live
    // counter that drives the audio multiplier.
    this.env3 = this.env;

    // State pipeline: a gate write schedules the ATTACK/RELEASE transition a
    // couple of cycles out (the chip doesn't switch immediately).
    if(this.statePipeline) this._stateChange();

    // Envelope-counter update, delayed via the envelope pipeline (the chip
    // spends an extra cycle before the counter actually steps).
    if(this.envPipeline!==0 && --this.envPipeline===0) {
      if(!this.holdZero) {
        if(this.state===S_ATTACK) {
          this.env=(this.env+1)&0xFF;
          if(this.env===0xFF) { this.state=S_DECAY; this.ratePeriod=RATE_CMP[this.d]; }
        } else if(this.state===S_DECAY || this.state===S_RELEASE) {
          this.env=(this.env-1)&0xFF;
        }
        this._setExpPeriod();
      }
    }

    // Exponential pipeline resolves first; otherwise a deferred rate-counter
    // reset from last cycle is serviced now (reSID's else-if ordering).
    if(this.expPipeline!==0 && --this.expPipeline===0) {
      this.expCounter=0;
      if((this.state===S_DECAY && this.env!==((this.s<<4)|this.s)) || this.state===S_RELEASE) {
        // env can flip 0x00→0xFF (attack→release) and keep counting down;
        // verified by ENV3 sampling.
        this.envPipeline=1;
      }
    } else if(this.resetRateCounter) {
      this.rateCounter=0;
      this.resetRateCounter=false;
      if(this.state===S_ATTACK) {
        // First attack step also resets the exponential counter (reSID).
        this.expCounter=0;
        this.envPipeline=2;
      } else if(!this.holdZero && ++this.expCounter===this.expPeriod) {
        this.expPipeline = this.expPeriod!==1 ? 2 : 1;
      }
    }

    // Rate counter: count up until it matches the comparator, wrapping past
    // 0x8000 by skipping zero (the ADSR delay bug). On match we DON'T
    // increment — we arm resetRateCounter so the reset lands next cycle,
    // giving the effective period comparator+1 (= RATE_PERIODS).
    if(this.rateCounter!==this.ratePeriod) {
      this.rateCounter=(this.rateCounter+1)&0xFFFF;
      if(this.rateCounter&0x8000) this.rateCounter=(this.rateCounter+1)&0x7FFF;
    } else {
      this.resetRateCounter=true;
    }
  }

  // reSID EnvelopeGenerator::state_change() — resolves a pipelined gate
  // transition. Runs at the top of clock() while statePipeline is nonzero.
  _stateChange() {
    this.statePipeline--;
    if(this.nextState===S_ATTACK) {
      if(this.statePipeline===0) {
        // Attack rate correctly takes over on the second cycle of attack.
        this.state=S_ATTACK; this.ratePeriod=RATE_CMP[this.a]; this.holdZero=false;
      }
    } else if(this.nextState===S_RELEASE) {
      if((this.state===S_ATTACK && this.statePipeline===0) ||
         (this.state===S_DECAY && this.statePipeline===1)) {
        this.state=S_RELEASE; this.ratePeriod=RATE_CMP[this.r];
      }
    }
    // DECAY_SUSTAIN / FREEZED next-states: no action here.
  }

  // Stage 2: waveform output, 6581 combined-saw accumulator pulldown, OSC3
  // latch/pipeline, combined-noise writeback, and the audio sample. Runs
  // after ALL voices' clockCore() so ring mod sees post-sync source phases.
  // outputStage() computes TWO independent per-cycle products — the audio DAC
  // sample (its return) and the OSC3 read pipeline — sharing the feedback each
  // depends on. Its two production consumers need only ONE, so each calls the
  // lean variant that skips the other's dead work (same idiom as the shadow's
  // clockPhaseOnly()): the audio worklet → outputStageAudio(); the main-thread
  // shadow v3 → outputStageOsc3(). All three keep reSID's ordering
  //   _outputPre → OSC3 read → _outputPost → audio sample
  // — the OSC3 read must see the PRE-writeback noise latch and the PREVIOUS
  // cycle's pulse rail, so it runs before _outputPost(). The lean variants are
  // byte-identical to outputStage() on the product they keep — locked by
  // sid-outputstage-skip-equiv-spec-test.js.

  // Shared pre-feedback: the reSID waveform_output latch + the 6581 combined-
  // saw MSB pulldown (feeds this.phase → BOTH products next cycle). Returns the
  // 12-bit selector output the tails consume. With waveform 0 selected the DAC
  // input floats instead: _out12 holds its last value and decays pairwise
  // (reSID wave.cc wave_bitfade) — audio and OSC3 read the same fading value
  // on BOTH models (the 8580 holds ~5 s; waveform-0 sample players use this).
  _outputPre() {
    if (this.ctrl & 0xF0) {
      const out12 = this._computeWaveform12();
      this._out12 = out12;
      // 6581 only: combined waveforms that include SAW can pull the accumulator's
      // MSB low through the waveform output (reSID wave.h — "the top bit of the
      // accumulator may be driven low by combined waveforms when the sawtooth is
      // selected").
      if (!this._is8580 && (this.ctrl & 0x20) && (this.ctrl & 0xD0)) {
        this.phase &= ((out12 << 12) | 0x7FFFFF);
      }
      return out12;
    }
    if (this.floatTtl !== 0 && --this.floatTtl === 0) {
      this._out12 &= this._out12 >> 1;
      if (this._out12 !== 0) this.floatTtl = this._is8580 ? FLOAT_TTL_BIT_8580 : FLOAT_TTL_BIT_6581;
    }
    return this._out12;
  }

  // Shared post-feedback: combined-NOISE writeback (→ this.lfsr) + the pulse-
  // rail latch (→ this.pulseOut). Both feed the NEXT cycle's audio AND OSC3, so
  // they always run — AFTER the OSC3 read, which samples the pre-writeback
  // noise latch and the previous cycle's pulse rail.
  _outputPost(out12) {
    // With noise + another waveform selected the selector output writes back
    // into the register EVERY cycle (not just on shifts), except under TEST and
    // except the cycle before a pipelined shift lands (reSID: waveform > 8 &&
    // !test && shift_pipeline != 1) — this is what collapses combined noise.
    if ((this.ctrl & 0x80) && (this.ctrl & 0x70) && !(this.ctrl & 0x08) &&
        this.shiftPipeline !== 1) {
      this._writeShiftRegister(out12);
    }
    // reSID pulse_output: "the result of the pulse width compare is delayed one
    // cycle" — everything above used the previous cycle's rail. Under TEST the
    // next clockCore overwrites it with the high rail.
    this.pulseOut = this.phase >= ((this.pw & 0x0FFF) << 12) ? 0xFFF : 0x000;
  }

  // OSC3 read pipeline ($D41B). Only the main-thread shadow v3 reads OSC3, so
  // the audio worklet skips this whole method (dead work on the audio thread —
  // notably _triSaw12()). Mutates _oscLive/_triSawPipe. The floating/fading
  // waveform-0 value arrives via out12 (_outputPre owns the fade).
  _osc3Read(out12) {
    // The 8580 latches the tri/saw (table) component through an extra clock
    // phase, so when TRI or SAW participates OSC3 shows LAST cycle's table value
    // masked by THIS cycle's pulse rail and noise latch (reSID tri_saw_pipeline).
    // Pulse-only / noise-only / waveform-0 reads are the live (or floating)
    // DAC input on both models; the 6581 is always live. (The 8580 pipe here
    // and the 6581 SAW pulldown in _outputPre are mutually exclusive by model,
    // so their relative order is a no-op.)
    if (this._is8580 && (this.ctrl & 0x30)) {
      const pulseMask = (this.ctrl & 0x40) ? this.pulseOut : 0xFFF;
      const noiseMask = (this.ctrl & 0x80) ? (this.noiseVal << 4) : 0xFFF;
      this._oscLive = ((this._triSawPipe & pulseMask & noiseMask) >> 4) & 0xFF;
      this._triSawPipe = this._triSaw12();
    } else {
      this._oscLive = (out12 >> 4) & 0xFF;
    }
  }

  // Voice output (reSID Voice::output()): the digital selector output — or
  // the floating/fading DAC input when no waveform is selected (both models;
  // reSID wave_bitfade) — goes through the model's (nonlinear on the 6581)
  // R-2R DAC, and the envelope-DAC multiplier pivots around the chip's
  // wave_zero ($380 on the 6581, $9E0 on the 8580), so envelope ramps pump a
  // waveform-dependent DC exactly like the hardware (gate thumps / click
  // digis / waveform-0 sample playback). Returns the 20-bit INTEGER product
  // (±2047×255) the filter stage's voice scaling consumes. Only the worklet
  // consumes it; the main-thread shadow skips it (pure — no side effects).
  _audioSample(out12) {
    return (this._wdac[out12] - this._wz) * this._edac[this.env];
  }

  // Full stage: both products. Standalone / tests / the lone-voice clock().
  outputStage() {
    const out12 = this._outputPre();
    this._osc3Read(out12);
    this._outputPost(out12);
    return this._audioSample(out12);
  }
  // Audio worklet: DAC sample only — the OSC3 read is unused on the audio
  // thread (its $D41B/$D41C publish is unread; the main thread uses the
  // shadow). The floating waveform-0 fade lives in _outputPre, so no extra
  // latch maintenance is needed here.
  outputStageAudio() {
    const out12 = this._outputPre();
    this._outputPost(out12);
    return this._audioSample(out12);
  }
  // Main-thread shadow v3: OSC3 read only — its audio sample is discarded in
  // _runMasterCycle, so skip it (dead work on the CPU hot loop).
  outputStageOsc3() {
    const out12 = this._outputPre();
    this._osc3Read(out12);
    this._outputPost(out12);
  }

  // Standalone convenience: both stages back-to-back. Fine for a lone voice
  // (syncPulse stays false unless a trio driver set it); the worklet chip and
  // the machine shadow use the split calls with computeSyncPulses() so sync
  // and ring follow reSID's clock-all-then-synchronize ordering.
  clock() {
    this.clockCore();
    return this.outputStage();
  }
  // Lightweight clock for the main-thread SHADOW voices 1 & 2 only.
  // The C64 exposes only voice 3's readback ($D41B OSC3 / $D41C ENV3); the
  // sole thing voice 3 consumes from voices 1/2 is their phase accumulator
  // (the sync/ring-mod chain v3.syncSrc=v2, v2.syncSrc=v1). So for the shadow
  // v1/v2 we advance ONLY the phase accumulator — skipping the envelope, the
  // noise LFSR, waveform-byte synthesis, the OSC latch/bit-fade and the
  // combined-NOISE writeback, all of which are dead work for an unread voice.
  // This reproduces the phase portion of clock() exactly, so v3's readback is
  // byte-identical (locked by test/sid-shadow-phaseonly-spec-test.js over 60k
  // random cycles on both models).
  // NOT for the worklet (it mixes all three voices) or for voice 3.
  clockPhaseOnly() {
    // 6581 combined-saw feeds the waveform output back into the accumulator
    // MSB — that needs the full waveform pipeline, so fall back to clock()
    // in exactly those (rare) modes; phase equivalence stays exact.
    if (!this._is8580 && (this.ctrl & 0x20) && (this.ctrl & 0xD0)) { this.clock(); return; }
    this.prevPhase = this.phase;
    if (this.ctrl & 0x08) {
      this.phase = 0;
    } else {
      // Same phase math as clockCore(): add, then this cycle's trio sync
      // pulse (computeSyncPulses must run before the trio is clocked).
      this.phase = this.syncPulse ? 0 : (this.phase + this.freq) & 0xFFFFFF;
    }
  }
  // Table index for the waveform selector: the top 12 accumulator bits, with
  // the ring-mod MSB substitution folded in when RING is on and SAW is off
  // (reSID wave.h: ix = (acc ^ (~sync_src_acc & ring_msb_mask)) >> 12, where
  // ring_msb_mask is nonzero only for ¬SAW∧RING — the saw selector blocks
  // the MSB EOR on the chip; "MSB EOR NOT sync_source MSB").
  _waveIx() {
    if (!(this.ctrl & 0x20) && (this.ctrl & 0x04) && this.syncSrc) {
      return ((this.phase ^ (~this.syncSrc.phase & 0x800000)) >> 12) & 0xFFF;
    }
    return (this.phase >> 12) & 0xFFF;
  }

  // The tri/saw ("wave[ix]") component of the selector output for waveform
  // bits w7 = waveform & 7, exactly reSID wave.cc model_wave: pure triangle
  // and saw are computed (bit-identical to reSID's generated tables 1/2 —
  // the fold reads the already-ring-substituted index MSB), the four
  // tri/saw/pulse combinations are the measured chip tables, and 0/4 (none /
  // pulse-only) are the all-ones mask — pulse rail and noise AND in at the
  // caller. Noise combinations (waveform 9..F) use the SAME tables per
  // w7 = waveform & 7, so e.g. noise+tri+saw reads the measured ST table.
  _waveTableComponent(w7, ix) {
    switch (w7) {
      case 1: return ((ix & 0x800) ? (~ix << 1) : (ix << 1)) & 0xFFE;
      case 2: return ix;
      case 3: return this._wtST[ix];
      case 5: return this._wtPT[ix];
      case 6: return this._wtPS[ix];
      case 7: return this._wtPST[ix];
      default: return 0xFFF; // 0 (no tri/saw) and 4 (pulse-only): mask identity
    }
  }

  // Full-resolution waveform value for the current phase, 12 bits (0..4095)
  // like the chip's waveform DAC — reSID wave.h set_waveform_output:
  //   waveform_output = wave[ix] & (no_pulse | pulse_output)
  //                              & no_noise_or_noise_output
  // The pulse rail is the one-cycle-delayed LATCH (pulseOut; TEST holds it
  // high at the latch updates), noise is the LFSR tap latch on bits 11..4.
  // The audio path consumes all 12 bits; OSC3 reads the top 8.
  _computeWaveform12() {
    const wf = (this.ctrl >> 4) & 0x0F;
    // Pulse low shorts the whole selector bus to ground on BOTH chips; the
    // noise+pulse laws below map 0 → 0, so the short-circuit is exact.
    if ((wf & 0x4) && this.pulseOut === 0) return 0;
    let out = this._waveTableComponent(wf & 0x07, this._waveIx());
    if (wf & 0x8) out &= this.noiseVal << 4;
    if ((wf & 0xC) === 0xC) {
      // NOISE+PULSE interconnects all noise bits through the pulse line —
      // measured laws (reSID wave.h noise_pulse6581/noise_pulse8580):
      // 6581 collapses to 0 below $F00 and erodes hard above; the 8580
      // erodes gently and saturates at $FC0.
      out = this._is8580
        ? (out < 0xFC0 ? (out & (out << 1)) & 0xFFF : 0xFC0)
        : (out < 0xF00 ? 0 : (out & (out << 1) & (out << 2)) & 0xFFF);
    }
    return out;
  }
  // The tri/saw (table) component of the current waveform — the term
  // _computeWaveform12 masks with the pulse rail / noise latch. Pure; only
  // meaningful when TRI or SAW is selected (feeds the 8580's OSC3
  // tri_saw_pipeline in outputStage — reSID stores wave[ix] there unmasked).
  _triSaw12() {
    return this._waveTableComponent((this.ctrl >> 4) & 0x07, this._waveIx());
  }
  // Live waveform byte for the current phase — a PURE function of state:
  // waveform selected → top 8 bits of the 12-bit selector output; waveform 0
  // → the held, fading DAC input (_out12; the fade itself is clocked by
  // _outputPre, not here).
  getOscByte() {
    return ((((this.ctrl & 0xF0) !== 0 ? this._computeWaveform12() : this._out12) >> 4) & 0xFF);
  }
  // Cycle-exact OSC3 ($D41B) register read. The 8580's tri/saw one-cycle
  // pipeline is already folded into _oscLive by outputStage (pulse-only /
  // noise-only reads are live on both models — reSID tri_saw_pipeline;
  // chipmodel.prg / osc_topbit measured the delay with saw). The machine's
  // shadow voices serve $D41B through this. (The worklet's OSC3 publish is
  // a legacy/unused path and stays on getOscByte().)
  readOsc3() { return this._oscLive & 0xFF; }
}

// Wire three voices together with the SID's per-voice sync/ring source
// chain (v1.syncSrc=v3, v2.syncSrc=v1, v3.syncSrc=v2). Used by the
// worklet's SIDChip and by the main-thread shadow.
export function makeVoiceTrio() {
  const v1 = new SIDVoice(), v2 = new SIDVoice(), v3 = new SIDVoice();
  v1.syncSrc = v3;
  v2.syncSrc = v1;
  v3.syncSrc = v2;
  return [v1, v2, v3];
}

// Hard-sync decisions for the trio, per reSID's synchronize(): a destination
// is synced when its source's accumulator MSB RISES this cycle (bit 23
// going 0→1 — NOT the 24-bit wrap, which is half a source period later),
// UNLESS the source is itself sync-enabled and its own source's MSB rises
// on the same cycle (the mutual-sync exception, verified on hardware by
// OSC3 sampling — reSID wave.h synchronize()).
// Each voice's MSB-rise depends only on its OWN pre-clock state (reSID
// computes msb_rising from the oscillator's own add, before the
// synchronize pass), so the pulses can be decided before any voice clocks —
// this also removes the old inline-clocking asymmetry where v1 saw a
// one-cycle-stale v3. Call once per cycle before clockCore()/
// clockPhaseOnly() on all three voices.
export function computeSyncPulses(v1, v2, v3) {
  // Fast path: when NO voice has hard-sync enabled (ctrl bit 1 clear on all
  // three), every syncPulse below is false by construction — the
  // `(vN.ctrl & 0x02) !== 0` factor is false in each assignment — so the three
  // predictMsbRise() probes are dead work (this runs ~985k/s on both the
  // worklet and the main-thread shadow). clockCore()/clockPhaseOnly() still read
  // syncPulse, so assign false explicitly. Bit-identical: predictMsbRise()
  // returns a boolean, so the originals also evaluate to the boolean `false` here.
  if (((v1.ctrl | v2.ctrl | v3.ctrl) & 0x02) === 0) {
    v1.syncPulse = v2.syncPulse = v3.syncPulse = false;
    return;
  }
  const r1 = v1.predictMsbRise(), r2 = v2.predictMsbRise(), r3 = v3.predictMsbRise();
  v1.syncPulse = r3 && (v1.ctrl & 0x02) !== 0 && !((v3.ctrl & 0x02) !== 0 && r2);
  v2.syncPulse = r1 && (v2.ctrl & 0x02) !== 0 && !((v1.ctrl & 0x02) !== 0 && r3);
  v3.syncPulse = r2 && (v3.ctrl & 0x02) !== 0 && !((v2.ctrl & 0x02) !== 0 && r1);
}
