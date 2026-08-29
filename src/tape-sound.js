// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/tape-sound.js – Playing the tape out loud, as the deck would.
//
// Not a sound effect: tap-audio.js transcribes the .tap back into the square
// wave that was on the cassette, pulse for pulse, and this plays that. Record
// what comes out and a C64 will load it. The signal is what you hear.
//
// The buffer is built once per tape, then played from wherever the head is and
// nudged back into line whenever the emulator's tape position drifts away from
// the audio position — seeking, rewinding and stopping all land that way.
//
// Recording has no such buffer: the tape is being written as it goes, one
// timestamped edge at a time. So a SAVE is transcribed the other way round —
// each frame takes the pulses laid down since the last one and queues them
// back-to-back, a fraction of a second behind the head.
import { tapToPcm } from './tap-audio.js';

// How far audio and tape may drift before the playback is re-seated. Tape is
// forgiving; re-seating too eagerly would chirp on every frame.
const DRIFT_TOLERANCE = 0.35;

// A very long tape would cost a lot of memory as float samples, so cap it and
// say so rather than quietly allocating hundreds of megabytes.
const MAX_SECONDS = 600;

// Live monitoring while recording. LEAD is how far ahead of the clock a slice
// is scheduled — enough to ride out a late frame without a gap. QUEUE_MAX caps
// how far the queue may run ahead at all: warp-speed emulation writes tape
// faster than real time, and without this the audio would fall minutes behind.
const LIVE_LEAD = 0.06;
const LIVE_QUEUE_MAX = 0.5;

export class TapeSound {
  constructor(audioCtx, destinationNode = audioCtx.destination) {
    this.ctx = audioCtx;
    this.master = audioCtx.createGain();
    this.master.gain.value = 0.25;
    this.master.connect(destinationNode);

    this._buffer = null;      // AudioBuffer of the whole tape
    this._forTape = null;     // which tapData it was built from
    this._src = null;         // live source node, or null when silent
    this.truncated = false;

    this._liveSrcs = new Set();  // slices of an in-progress recording, queued
    this._liveSent = null;       // how far into the recording has been played
    this._liveLevel = 1;         // where its square wave stands, across slices
    this._liveAt = 0;            // context time the next slice starts at
  }

  setVolume(v) { this.master.gain.value = Math.max(0, Math.min(1, v)); }

  /** Called once per frame with the live datasette. */
  update(ds) {
    // Writing: play what is being written, not what the tape used to hold.
    if (ds && ds.hasMedia && ds.motorOn && ds.recording) { this._stop(); this._live(ds); return; }
    this._stopLive();

    const audible = !!ds && ds.hasMedia && ds.motorOn && ds.playPressed && !ds.atEnd;
    if (!audible) { this._stop(); return; }

    if (this._forTape !== ds.tapData) this._build(ds);
    if (!this._buffer) return;

    const want = ds.elapsedSeconds;
    if (!this._src) { this._start(want); return; }
    // Where the audio has got to, versus where the head actually is.
    const at = this._startedAtOffset + (this.ctx.currentTime - this._startedAtCtxTime);
    if (Math.abs(at - want) > DRIFT_TOLERANCE) { this._stop(); this._start(want); }
  }

  _build(ds) {
    this._stop();
    this._forTape = ds.tapData;
    this._buffer = null;
    if (!ds.tapData || !ds.tapData.length) return;
    const { pcm, truncated } = tapToPcm(ds.tapData, {
      version: ds.tapVersion,
      zeroGapCycles: ds.zeroGapCycles,
      sampleRate: this.ctx.sampleRate,
      maxSeconds: MAX_SECONDS,
    });
    this.truncated = truncated;
    if (!pcm.length) return;
    const buf = this.ctx.createBuffer(1, pcm.length, this.ctx.sampleRate);
    buf.copyToChannel(pcm, 0);
    this._buffer = buf;
  }

  _start(offsetSeconds) {
    if (!this._buffer) return;
    const off = Math.max(0, Math.min(this._buffer.duration - 0.001, offsetSeconds || 0));
    const src = this.ctx.createBufferSource();
    src.buffer = this._buffer;
    src.connect(this.master);
    src.start(0, off);
    this._src = src;
    this._startedAtOffset = off;
    this._startedAtCtxTime = this.ctx.currentTime;
  }

  // ── Recording: the tail, as it is written ──────────────────────────────
  _live(ds) {
    const len = ds.recordedLength;
    // A session that just opened, or re-opened shorter after a splice: start
    // from where it is now rather than replaying what is already down.
    if (this._liveSent === null || len < this._liveSent) {
      this._liveSent = len;
      this._liveLevel = 1;
      this._liveAt = 0;
      return;
    }
    if (len === this._liveSent) return;

    const slice = ds.recordedSlice(this._liveSent, len);
    this._liveSent = len;
    if (!slice || !slice.length) return;

    const now = this.ctx.currentTime;
    if (this._liveAt - now > LIVE_QUEUE_MAX) return;      // running ahead of real time — let it go
    const { pcm, level } = tapToPcm(slice, {
      version: ds.tapVersion,
      zeroGapCycles: ds.zeroGapCycles,
      sampleRate: this.ctx.sampleRate,
      startLevel: this._liveLevel,
      maxSeconds: LIVE_QUEUE_MAX,
    });
    this._liveLevel = level;
    if (!pcm.length) return;

    const buf = this.ctx.createBuffer(1, pcm.length, this.ctx.sampleRate);
    buf.copyToChannel(pcm, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.master);
    if (this._liveAt < now + LIVE_LEAD) this._liveAt = now + LIVE_LEAD;   // underran — re-seat
    src.start(this._liveAt);
    this._liveAt += buf.duration;
    this._liveSrcs.add(src);
    src.onended = () => this._liveSrcs.delete(src);
  }

  _stopLive() {
    this._liveSent = null;
    this._liveAt = 0;
    if (!this._liveSrcs.size) return;
    for (const src of this._liveSrcs) {
      try { src.stop(); } catch { /* already ended */ }
      try { src.disconnect(); } catch { /* gone */ }
    }
    this._liveSrcs.clear();
  }

  _stop() {
    if (!this._src) return;
    try { this._src.stop(); } catch { /* already ended */ }
    try { this._src.disconnect(); } catch { /* gone */ }
    this._src = null;
  }

  dispose() {
    this._stop();
    this._stopLive();
    this._buffer = null;
    this._forTape = null;
    try { this.master.disconnect(); } catch { /* gone */ }
  }
}
