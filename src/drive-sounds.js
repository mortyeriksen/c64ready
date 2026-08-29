// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/drive-sounds.js – Synthesized 1541 disk drive sounds.
// Runs on the main thread via plain WebAudio nodes (no worklet needed).
// Motor = low sawtooth + filtered white noise + 5 Hz rotation tremolo.
// Stepper click = short bandpass-filtered noise burst.

export class DriveSounds {
  constructor(audioCtx, destinationNode = audioCtx.destination) {
    this.ctx = audioCtx;

    // Master bus for all drive sounds – keeps us from drowning out SID output.
    // Routed through the caller's destination (the app's master-gain node, so
    // the global MUTE reaches drive sounds too) — defaults to the context's
    // final destination for standalone use.
    this.master = audioCtx.createGain();
    this.master.gain.value = 0.35;
    this.master.connect(destinationNode);

    this._motor = null;       // active motor graph or null
    this._clickBuf = this._buildClickBuffer();
    this._noiseBuf = this._buildNoiseBuffer();
  }

  setVolume(v) { this.master.gain.value = Math.max(0, Math.min(1, v)); }

  // ── Stepper click ────────────────────────────────────────────────────────
  _buildClickBuffer() {
    const dur = 0.03;
    const len = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      // Sharp attack, exponential decay — the characteristic "tick"
      const env = Math.exp(-t * 28) * (1 - Math.exp(-t * 200));
      data[i] = (Math.random() * 2 - 1) * env;
    }
    return buf;
  }

  click({ rate = 1, gain = 1, when = 0 } = {}) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._clickBuf;
    src.playbackRate.value = rate * (0.9 + Math.random() * 0.2);

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2400 + (Math.random() - 0.5) * 800;
    bp.Q.value = 3.5;

    const g = ctx.createGain();
    g.gain.value = gain;

    src.connect(bp).connect(g).connect(this.master);
    const t = Math.max(ctx.currentTime + when, ctx.currentTime);
    src.start(t);
    src.stop(t + 0.08);
  }

  // ── Motor hum ────────────────────────────────────────────────────────────
  _buildNoiseBuffer() {
    const len = this.ctx.sampleRate * 2;   // 2 s of looping noise
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  motorOn() {
    if (this._motor) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;

    // Two slightly detuned sawtooths give the motor its beating character.
    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.value = 58;

    const osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.value = 62;

    const oscMix = ctx.createGain();
    oscMix.gain.value = 0.08;
    osc1.connect(oscMix);
    osc2.connect(oscMix);

    // Low-pass–filtered noise — the "whirring" drive surface sound.
    const noise = ctx.createBufferSource();
    noise.buffer = this._noiseBuf;
    noise.loop = true;
    const lpf = ctx.createBiquadFilter();
    lpf.type = 'lowpass';
    lpf.frequency.value = 320;
    lpf.Q.value = 1.2;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.22;
    noise.connect(lpf).connect(noiseGain);

    // 5 Hz LFO modulating overall level — simulates 300 RPM rotation.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.06;
    lfo.connect(lfoDepth);

    // Master motor gain with fade-in.
    const motorGain = ctx.createGain();
    motorGain.gain.setValueAtTime(0, now);
    motorGain.gain.linearRampToValueAtTime(1, now + 0.15);
    lfoDepth.connect(motorGain.gain);

    oscMix.connect(motorGain);
    noiseGain.connect(motorGain);
    motorGain.connect(this.master);

    osc1.start(); osc2.start(); noise.start(); lfo.start();
    this._motor = { osc1, osc2, noise, lfo, motorGain };
  }

  motorOff() {
    if (!this._motor) return;
    const { osc1, osc2, noise, lfo, motorGain } = this._motor;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    motorGain.gain.cancelScheduledValues(now);
    motorGain.gain.setValueAtTime(motorGain.gain.value, now);
    motorGain.gain.linearRampToValueAtTime(0, now + 0.25);
    const stopAt = now + 0.3;
    [osc1, osc2, noise, lfo].forEach(n => { try { n.stop(stopAt); } catch {} });
    this._motor = null;
  }

  // ── Canned "fake load" burst for trap-mode loads ────────────────────────
  // Spins motor for ~1.5 s, sprinkles clicks like a short head seek + read.
  simulateLoad() {
    const ctx = this.ctx;
    this.motorOn();
    // 8–12 stepper clicks in the first 400 ms (seek)
    const n = 8 + Math.floor(Math.random() * 5);
    for (let i = 0; i < n; i++) {
      this.click({ when: i * 0.04 + Math.random() * 0.01, gain: 0.9 });
    }
    // A couple of scattered later clicks (head re-align)
    this.click({ when: 0.8 + Math.random() * 0.1, gain: 0.7 });
    this.click({ when: 1.1 + Math.random() * 0.1, gain: 0.6 });
    // Stop motor after ~1.6 s
    const stopAt = ctx.currentTime + 1.6;
    setTimeout(() => this.motorOff(), 1600);
    // Guard: if a real motorOn comes during the fake load, keep it running.
    this._fakeLoadUntil = stopAt;
  }

  isFakeLoading() {
    return this._fakeLoadUntil && this.ctx.currentTime < this._fakeLoadUntil;
  }
}
