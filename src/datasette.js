// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/datasette.js — Commodore 1530 (C2N) Datasette emulation
// Plays back .tap files cycle-accurately via CIA1 FLAG interrupts.
// Each TAP byte produces one falling edge on FLAG → one CIA1 IRQ.
//
// TAP format:
//   Header: "C64-TAPE-RAW" + version(1) + reserved(3) + size(4LE)
//   Data (v0): byte N → N*8 cycles to next edge; 0 → 2048 cycles
//   Data (v1): byte N → N*8 cycles; 0 + 3LE bytes → exact cycle count
//   Data (v2): as v1, but each entry is a half-wave (FLAG toggles per entry)
//
// Five transport keys, one motor — and the *computer* switches that motor (CPU
// port $01 bit 5), so no key moves tape on its own, F.FWD and REW included. A real
// datasette sits still with a key down until the machine energises the line, which
// the KERNAL's interrupt handler does as soon as it sees SENSE go low.

import { switchOn } from './switches.js';
import { V0_ZERO_GAP_CYCLES } from './tap-audio.js';

const TAP_MAGIC = 'C64-TAPE-RAW';
const HEADER_SIZE = 20;
const CYCLES_PER_SECOND = 985248; // PAL C64

// Real 1530 takes ~300ms to reach stable capstan speed. Pulses delivered
// before that are likely to be misdecoded, so hold them back.
const MOTOR_STARTUP_CYCLES = Math.floor(CYCLES_PER_SECOND * 0.30);

// v0 stores "longer than 255*8 cycles" as a bare 0 with no length at all, so a
// player has to assume one. 2048 (= 256*8) is the smallest consistent reading,
// and it is shared with everything else that reads a tape — the speaker, the
// scope, the listing and the .wav export — so they all measure the same tape.
// (VICE assumes 2500; the difference is only visible as duration on a v0 tape.)

// F.FWD / REW wind at ~25x play speed on a 1530-class mechanism. Winding needs
// no per-cycle precision (nothing is being read), so it seeks in chunks.
const WIND_SPEED = 25;
const WIND_CHUNK_CYCLES = 2048;

// Position checkpoints, one per this many pulses, so REW can seek backwards
// without rescanning the whole stream (a .tap is only decodable forwards).
const INDEX_STRIDE = 2048;

// The mechanical counter is reel-driven and therefore non-linear on real
// hardware; modelled here as linear in tape time (999 over a C60 side).
const COUNTER_SECONDS_PER_UNIT = 1.8;

// A single TAP byte spans up to this many cycles; longer pulses need the
// v1/v2 long form (a 0 escape plus a 24-bit little-endian cycle count).
const MAX_BYTE_CYCLES = 0xFF * 8;
const MAX_LONG_CYCLES = 0xFFFFFF;
const REC_BUF_MIN = 1 << 16;

// Transport keys. The state itself is the small int `_mode` (indexes KEYS) so
// clock(), which runs once per master cycle while the motor turns, tests numbers
// rather than strings; `key` is the string view of it.
const KEYS = ['STOP', 'PLAY', 'REC', 'FF', 'REW'];
const MODE_STOP = 0, MODE_PLAY = 1, MODE_REC = 2, MODE_FF = 3, MODE_REW = 4;

// A complete, empty .tap file — what BLANK inserts. Standalone so the UI can
// cache one while the machine is powered off, before any deck exists.
export function blankTapBytes() {
  const deck = new Datasette();
  deck.newBlankTape();
  return deck.exportTapBytes();
}

export class Datasette {
  constructor() {
    this.tapData = null;
    this.tapVersion = 0;
    this.pos = 0;
    this.cyclesUntilEdge = 0;
    this.motorOn = false;
    // Transport: one key at a time, exactly like the mechanism. RECORD engages
    // the PLAY mechanism too, so 'REC' means record-and-play.
    this._mode = MODE_STOP;
    // Write protect is a property of the cassette shell (the tabs), and blocks
    // the RECORD key mechanically. The computer cannot read it.
    this.writeProtected = false;
    this.atEnd = false;
    this.flagCallback = null;
    // Recorder: while a session is open the tape lives in _recBuf (the kept
    // prefix plus everything written since), and is committed back to tapData
    // when RECORD is released.
    this.dirty = false;             // has recorded content not yet exported
    this._recStarted = false;
    this._recBuf = null;
    this._recLen = 0;
    this._recHalfwave = false;      // v2 records half-waves, v1 full waves
    this._lastEdgeCycle = -1;       // tape time of the last edge that counted
    this._encCarry = 0;             // ÷8 remainder carried to the next pulse
    this.zeroGapCycles = V0_ZERO_GAP_CYCLES;
    this._pulseCount = 0;
    this._tapeCycles = 0;           // absolute position, in tape cycles
    this._totalCycles = 0;          // total decodable length, in cycles
    this._indexOff = null;          // byte offset, one per INDEX_STRIDE pulses
    this._indexCyc = null;          // tape time at that offset (doubles)
    this._windAccum = 0;
    this._motorStartupRemaining = 0;
    this._flagLevel = 1;            // track current FLAG output state
    this._writeLevel = 1;           // track current WRITE pin state
  }

  loadTap(data) {
    if (data.length < HEADER_SIZE) throw new Error('TAP file too short');
    this._recDiscard();             // new media replaces any open recording
    let magic = '';
    for (let i = 0; i < 12; i++) magic += String.fromCharCode(data[i]);
    if (magic !== TAP_MAGIC) throw new Error('Not a valid TAP file');
    this.tapVersion = data[12];
    if (this.tapVersion > 2) throw new Error(`Unsupported TAP version: ${this.tapVersion}`);
    const size = data[16] | (data[17] << 8) | (data[18] << 16) | (data[19] << 24);
    this.tapData = data.slice(HEADER_SIZE, HEADER_SIZE + size);
    // Tabs out, like a mounted disk: recording over someone's tape takes a
    // deliberate click. An empty image has nothing to protect, so a blank tape
    // (including one cached while the machine was off) comes in writable.
    this.writeProtected = size > 0;
    this._resetPlayback();
    this._scanTape();
    this._loadNextPulse();
  }

  // Insert a fresh blank tape, ready to record onto — so writing is enabled.
  newBlankTape() {
    this._recDiscard();
    this.tapVersion = switchOn('tapeRecordHalfwave') ? 2 : 1;
    this.tapData = new Uint8Array(0);
    this.writeProtected = false;
    this._resetPlayback();
    this._scanTape();
    this.atEnd = true;              // nothing recorded yet, so nothing to play
  }

  get hasMedia() { return this.tapData !== null; }

  // Position as fraction 0..1 (by file offset — approximates tape position).
  get positionFraction() {
    if (!this.tapData || this.tapData.length === 0) return 0;
    return Math.min(1, this.pos / this.tapData.length);
  }

  // Tape time at the current position, in seconds (advances with playback and
  // with winding; reset by rewind()).
  get elapsedSeconds() {
    return this._tapeCycles / CYCLES_PER_SECOND;
  }

  // Total length of what is on the tape. While recording it grows with the
  // head, since the pulses being written have not been committed yet.
  get durationSeconds() {
    const cyc = this._recStarted && this._tapeCycles > this._totalCycles
      ? this._tapeCycles : this._totalCycles;
    return cyc / CYCLES_PER_SECOND;
  }

  // True while the head is actually laying down pulses.
  get recording() { return this._recStarted; }

  // Pulses read since the tape was loaded. tape-sound.js differentiates this to
  // recover the signal's frequency — the audible pitch of the loader.
  get pulseCount() { return this._pulseCount; }

  // Three-digit mechanical counter, 000..999.
  get counter() {
    return Math.floor(this.elapsedSeconds / COUNTER_SECONDS_PER_UNIT) % 1000;
  }

  // Which key is down, as a string: 'STOP' | 'PLAY' | 'REC' | 'FF' | 'REW'.
  get key() { return KEYS[this._mode]; }

  set key(name) {
    const m = KEYS.indexOf(name);
    if (m >= 0) this._mode = m;
  }

  setMotor(on) {
    on = !!on;
    if (on === this.motorOn) return;
    if (on) {
      // Motor just started — begin startup stabilization window.
      this._motorStartupRemaining = MOTOR_STARTUP_CYCLES;
    }
    this.motorOn = on;
    if (!on) this._restoreFlagHigh();
    // The KERNAL parks the motor between blocks, so a record session spans
    // motor stops: it opens on the first turn and stays open until the key
    // comes up. Tape time only accrues while the motor runs, so the pulse
    // straddling a stop measures the distance actually travelled.
    else this._maybeStartRecording();
  }

  // Press one transport key (or STOP to release). Returns false if the
  // mechanism refuses: RECORD needs a tape whose write-protect tabs are intact.
  pressKey(key) {
    const mode = KEYS.indexOf(key);
    if (mode < 0) throw new Error(`Unknown datasette key: ${key}`);
    // A protected cassette blocks the RECORD key mechanically, and RECORD is
    // interlocked with PLAY, so neither goes down.
    if (mode === MODE_REC && (!this.tapData || this.writeProtected)) return false;
    if (mode === this._mode) return true;
    const wasRecording = this._mode === MODE_REC;
    this._mode = mode;
    this._windAccum = 0;
    if (wasRecording) this._recStop();
    if (mode === MODE_STOP) {
      this._restoreFlagHigh();
    } else if (this.motorOn) {
      // Re-arm motor startup so the first pulse after a key press isn't early.
      this._motorStartupRemaining = MOTOR_STARTUP_CYCLES;
    }
    if (mode === MODE_REC) this._maybeStartRecording();
    return true;
  }

  // PLAY as a boolean, kept as the shorthand the machine and UI already use.
  // Reads true for RECORD too, since recording engages the PLAY mechanism.
  get playPressed() { return this._mode === MODE_PLAY || this._mode === MODE_REC; }

  setPlayPressed(pressed) {
    this.pressKey(pressed ? 'PLAY' : 'STOP');
  }

  // Cassette WRITE line (6510 P3) as the deck sees it. Only transitions carry
  // information: the interval between two consecutive rising edges is one
  // recorded pulse.
  setWriteLine(level) {
    level = level ? 1 : 0;
    if (level === this._writeLevel) return;
    this._writeLevel = level;
    // Stationary tape records nothing: with the motor off no cycles accrue, so
    // an edge here would measure a zero-length pulse. The head simply isn't
    // moving over the medium.
    if (!this._recStarted || !this.motorOn) return;
    // v1 entries are full waves, so only one polarity closes a pulse; v2 keeps
    // every half-wave. Either way the stream starts at a rising edge. A session
    // stamps its reference as it opens, so this only catches a save state from
    // a build that armed on the first edge instead.
    if (this._lastEdgeCycle < 0) {
      if (level === 1) this._lastEdgeCycle = this._tapeCycles;
      return;
    }
    if (!this._recHalfwave && level === 0) return;
    const t = this._tapeCycles;
    const len = t - this._lastEdgeCycle;
    this._lastEdgeCycle = t;
    // One $01 write starts the motor AND moves the write line, so an edge can
    // land on the very cycle recording opened. No tape has passed under the
    // head yet; that is a reference point, not a pulse.
    if (len > 0) this._emitPulse(len);
  }

  getSenseLevel() {
    // SENSE: 0 = a key is down (any key, the machine cannot tell which),
    // 1 = no button / no tape. Pulled up on the C64 side.
    return this._mode === MODE_STOP ? 1 : 0;
  }

  clock(cycles) {
    const mode = this._mode;
    if (mode === MODE_STOP || !this.motorOn || !this.tapData) return;
    if (mode >= MODE_FF) { this._wind(cycles, mode === MODE_FF ? 1 : -1); return; }
    if (mode === MODE_REC) {
      // Writing: the tape just moves and setWriteLine() does the recording. No
      // startup window here — withholding these cycles would collapse the
      // pulses a turbo saver writes immediately after motor-on into nothing,
      // and the KERNAL's ten-second leader makes the question academic.
      this._tapeCycles += cycles;
      return;
    }
    if (this.atEnd) return;

    // Motor stabilization window — tape is moving but not yet at stable speed.
    if (this._motorStartupRemaining > 0) {
      this._motorStartupRemaining -= cycles;
      if (this._motorStartupRemaining > 0) return;
      cycles = -this._motorStartupRemaining; // use remainder of this tick
      this._motorStartupRemaining = 0;
    }

    this._tapeCycles += cycles;
    this.cyclesUntilEdge -= cycles;
    while (this.cyclesUntilEdge <= 0) {
      if (this.tapVersion === 2) {
        // TAP v2: each pulse is a half-wave. Toggle the pin state.
        this._flagLevel = this._flagLevel === 1 ? 0 : 1;
        this.flagCallback?.(this._flagLevel);
      } else {
        // TAP v0/v1: each pulse is a full wave. Produce a falling edge and restore.
        this._flagLevel = 0;
        this.flagCallback?.(0);
        this._flagLevel = 1;
        this.flagCallback?.(1);
      }
      this._pulseCount++;
      this._loadNextPulse();
      if (this.atEnd) break;
    }
  }

  // F.FWD / REW. Nothing is read while winding, so the tape is moved in chunks
  // rather than pulse by pulse.
  _wind(cycles, dir) {
    this._windAccum += cycles;
    if (this._windAccum < WIND_CHUNK_CYCLES) return;
    const moved = this._windAccum * WIND_SPEED;
    this._windAccum = 0;
    const target = this._tapeCycles + dir * moved;
    this.seekToCycle(target);
    // Reaching an end pops the key up. A bare 1530 just stalls its motor against
    // the reel, but a latched key holds SENSE low, and the machine answers that by
    // keeping the motor energised with nowhere left to wind.
    if (dir > 0 ? target >= this._totalCycles : target <= 0) this.pressKey('STOP');
  }

  // Move the transport to an absolute tape time (in cycles), clamped to the
  // media. Seeks from the nearest checkpoint, since .tap decodes forwards only.
  seekToCycle(target) {
    if (this._recStarted) this._recStop();   // seeking needs a whole tape
    if (!this.tapData) return;
    const len = this.tapData.length;
    target = Math.max(0, Math.min(target, this._totalCycles));

    // Nearest checkpoint at or before the target.
    const cycs = this._indexCyc, offs = this._indexOff;
    const n = cycs ? cycs.length : 0;
    let lo = 0, hi = n - 1, k = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cycs[mid] <= target) { k = mid; lo = mid + 1; } else hi = mid - 1;
    }
    let cyc = n ? cycs[k] : 0;
    this.pos = n ? offs[k] : 0;
    this.atEnd = false;
    this.cyclesUntilEdge = 0;
    this._tapeCycles = target;

    // Walk pulses until the target falls inside one; what remains of that pulse
    // becomes the countdown to the next edge.
    while (this.pos < len) {
      const before = this.pos;
      const pulse = this._readPulse();
      if (pulse < 0) { this.pos = before; this.atEnd = true; return; }
      cyc += pulse;
      if (cyc > target) { this.cyclesUntilEdge = cyc - target; return; }
    }
    if (target >= this._totalCycles) this.atEnd = true;
  }

  // Move the transport to a byte offset — what the progress bar measures, so a
  // click on it lands where aimed. Seeking by tape time would drift instead: a
  // pulse's byte cost and cycle cost aren't proportional (a v1 long form is 4
  // bytes for one pulse).
  seekToByte(target) {
    if (!this.tapData) return;
    if (this._recStarted) this._recStop();
    this.seekToCycle(this._cyclesAtByte(target));
  }

  // Seek by a 0..1 fraction of the pulse stream — the progress bar's own scale.
  seekToFraction(fraction) {
    if (!this.tapData) return;
    // Commit first: with a session open, tapData is only the kept prefix, so a
    // fraction of *its* length would scale against the wrong tape.
    if (this._recStarted) this._recStop();
    const f = Math.max(0, Math.min(1, fraction));
    this.seekToByte(Math.round(f * this.tapData.length));
  }

  // Seek to a tape time. The byte stream and the clock are different scales — a
  // single gap entry can be twenty seconds — so anything that knows *when* it
  // wants to be has to come this way rather than through a fraction of the bytes.
  seekToSeconds(seconds) {
    this.seekToCycle(Math.round(seconds * CYCLES_PER_SECOND));
  }

  // Tape time at a 0..1 position, without moving anything — the hover readout.
  // Mid-write there is nothing to preview (and the recorded pulses are not indexed
  // yet), so it answers with where the head actually is.
  secondsAtFraction(fraction) {
    if (!this.tapData) return 0;
    if (this._recStarted) return this.elapsedSeconds;
    const f = Math.max(0, Math.min(1, fraction));
    return this._cyclesAtByte(Math.round(f * this.tapData.length)) / CYCLES_PER_SECOND;
  }

  // Tape time at a byte offset. Walks from the nearest checkpoint, so it costs at
  // most INDEX_STRIDE pulse decodes.
  _cyclesAtByte(target) {
    const len = this.tapData.length;
    target = Math.max(0, Math.min(target, len));

    const offs = this._indexOff, cycs = this._indexCyc;
    const n = offs ? offs.length : 0;
    let lo = 0, hi = n - 1, k = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (offs[mid] <= target) { k = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const savedPos = this.pos;
    this.pos = n ? offs[k] : 0;
    let cyc = n ? cycs[k] : 0;
    while (this.pos < target && this.pos < len) {
      const pulse = this._readPulse();
      if (pulse < 0) break;
      cyc += pulse;
    }
    this.pos = savedPos;
    return cyc;
  }

  // Decode the pulse at `pos` and advance past its bytes. Returns its length in
  // cycles, or -1 if the stream is exhausted or a v1/v2 long form is truncated.
  _readPulse() {
    const d = this.tapData;
    if (!d || this.pos >= d.length) return -1;
    const b = d[this.pos++];
    if (b !== 0) return b * 8;
    if (this.tapVersion === 0) return this.zeroGapCycles;
    if (this.pos + 2 < d.length) {
      const lo = d[this.pos++];
      const mi = d[this.pos++];
      const hi = d[this.pos++];
      return lo | (mi << 8) | (hi << 16);
    }
    return -1;
  }

  _loadNextPulse() {
    const pulse = this._readPulse();
    if (pulse < 0) { this.atEnd = true; return; }
    this.cyclesUntilEdge += pulse;
  }

  _restoreFlagHigh() {
    if (this._flagLevel !== 1) {
      this._flagLevel = 1;
      this.flagCallback?.(1);
    }
  }

  _resetPlayback() {
    this.pos = 0;
    this.atEnd = false;
    this._mode = MODE_STOP;
    this.motorOn = false;
    this.cyclesUntilEdge = 0;
    this._pulseCount = 0;
    this._tapeCycles = 0;
    this._windAccum = 0;
    this._motorStartupRemaining = 0;
    this._restoreFlagHigh();
  }

  // Rewind to the beginning of the tape (preserves loaded media — _resetPlayback
  // only touches the transport and the pulse cursor).
  rewind() {
    if (!this.tapData) return;
    this._recStop();                // whatever was written stays on the tape
    this._resetPlayback();
    this._loadNextPulse();
  }

  // One decode pass over the media: total length plus the position checkpoints
  // used for seeking.
  _scanTape() {
    this._indexOff = this._indexCyc = null;
    this._totalCycles = 0;
    if (!this.tapData) return;
    const savedPos = this.pos;
    this.pos = 0;
    const offs = [], cycs = [];
    let cyc = 0, n = 0;
    while (this.pos < this.tapData.length) {
      if ((n % INDEX_STRIDE) === 0) { offs.push(this.pos); cycs.push(cyc); }
      const pulse = this._readPulse();
      if (pulse < 0) break;
      cyc += pulse;
      n++;
    }
    this.pos = savedPos;
    // Flattened: one seek reads two typed arrays instead of chasing objects.
    this._indexOff = Int32Array.from(offs);
    this._indexCyc = Float64Array.from(cycs);
    this._totalCycles = cyc;
  }

  eject() {
    this._recDiscard();
    this.tapData = null;
    this.writeProtected = false;
    this._resetPlayback();
    this._indexOff = this._indexCyc = null;
    this._totalCycles = 0;
  }

  reset() {
    // A machine reset mid-write is like pulling the plug on the C64: whatever
    // reached the tape stays on it, so commit rather than discard.
    this._recStop();
    this.motorOn = false;
    this._motorStartupRemaining = 0;
    this._restoreFlagHigh();
    // Keep tapData and the pressed key so the KERNAL can re-detect SENSE and
    // reload.
  }

  // ── Recorder ────────────────────────────────────────────────────────────
  // The C64 writes tape by toggling 6510 P3 under its own timing, so recording
  // is nothing but timestamping those edges: one TAP entry per rising edge for
  // v1 (a full wave), one per edge for v2 (half-waves).

  // Open a session if the mechanism is in a state that lays down flux.
  _maybeStartRecording() {
    if (this._recStarted) return;
    if (this._mode !== MODE_REC || !this.motorOn) return;
    if (!this.tapData || this.writeProtected) return;

    // The head erases as it passes, so recording overwrites from here on and
    // whatever followed is gone — a spliced tail would be undecodable anyway.
    // `pos` is a pulse boundary (the in-flight pulse's bytes are consumed), so
    // the cut never lands inside a v1 long form.
    const keep = Math.min(this.pos, this.tapData.length);
    if (this.tapVersion === 0) {
      // v0 cannot express an exact long pulse, so the kept prefix is re-emitted
      // as v1 — otherwise its bare 0 bytes would read as v1 escapes.
      this._recBuf = new Uint8Array(Math.max(REC_BUF_MIN, keep * 4));
      this._recLen = 0;
      for (let i = 0; i < keep; i++) {
        const b = this.tapData[i];
        if (b !== 0) { this._recPush(b); continue; }
        const g = this.zeroGapCycles;
        this._recPush(0);
        this._recPush(g & 0xFF);
        this._recPush((g >> 8) & 0xFF);
        this._recPush((g >> 16) & 0xFF);
      }
      this.tapVersion = 1;
    } else {
      this._recBuf = new Uint8Array(Math.max(REC_BUF_MIN, keep * 2));
      this._recBuf.set(this.tapData.subarray(0, keep));
      this._recLen = keep;
    }

    this._recHalfwave = this.tapVersion === 2;
    this._recStarted = true;
    // The pulse stream is measured from where the head started laying flux, so
    // the silence before the first edge is a pulse of its own — that is what
    // holds the position on the tape. Arming on the first rising edge instead
    // dropped it whenever a recording opened with the write line already low.
    this._lastEdgeCycle = this._tapeCycles;
    this._encCarry = 0;
    this.dirty = true;
  }

  // Commit an open session back into tapData. Called when RECORD is released,
  // and by anything that needs the tape to be whole again.
  _recStop() {
    if (!this._recStarted) return;
    this.tapData = this._recBuf.slice(0, this._recLen);
    this._recBuf = null;
    this._recStarted = false;
    this._scanTape();
    // The head sits at the end of what was just written.
    this.pos = this.tapData.length;
    this.atEnd = true;
    this._tapeCycles = this._totalCycles;
  }

  // Throw an open session away (the media itself is going away).
  _recDiscard() {
    this._recStarted = false;
    this._recBuf = null;
    this._recLen = 0;
    this._lastEdgeCycle = -1;
    this._encCarry = 0;
    this.dirty = false;
  }

  _recPush(b) {
    if (this._recLen >= this._recBuf.length) {
      const bigger = new Uint8Array(this._recBuf.length * 2);
      bigger.set(this._recBuf);
      this._recBuf = bigger;
    }
    this._recBuf[this._recLen++] = b;
  }

  // Append one measured pulse, quantized to the container's 8-cycle unit. The
  // ÷8 remainder carries into the next pulse, so a long stream keeps its
  // absolute timing instead of drifting.
  _emitPulse(cycles) {
    let total = cycles + this._encCarry;
    while (total > MAX_BYTE_CYCLES) {
      // The long form is exact, so nothing is left to carry. A gap longer than
      // the 24-bit ceiling (~17 s) is split, which costs a phantom edge in a
      // blank stretch of tape where no loader is listening anyway.
      const exact = total > MAX_LONG_CYCLES ? MAX_LONG_CYCLES : total;
      this._recPush(0);
      this._recPush(exact & 0xFF);
      this._recPush((exact >> 8) & 0xFF);
      this._recPush((exact >> 16) & 0xFF);
      total -= exact;
      if (total <= 0) { this._encCarry = 0; return; }
    }
    let units = Math.round(total / 8);
    if (units < 1) units = 1;       // a pulse under 4 cycles: emit the minimum
    this._recPush(units);
    this._encCarry = total - units * 8;
  }

  // How much an open recording session has laid down, and a view of any stretch
  // of it — what the audio monitor transcribes to play a SAVE out loud as it is
  // written. A view, not a copy: read it now, it moves under you later. Both
  // ends land on pulse boundaries, since entries are only ever appended whole.
  get recordedLength() { return this._recStarted ? this._recLen : 0; }

  recordedSlice(from, to = this._recLen) {
    if (!this._recStarted || !this._recBuf) return null;
    const a = Math.max(0, Math.min(from | 0, this._recLen));
    const b = Math.max(a, Math.min(to | 0, this._recLen));
    return this._recBuf.subarray(a, b);
  }

  // The tape bytes as they stand, including an open recording session.
  _dataBytes() {
    if (this._recStarted) return this._recBuf.subarray(0, this._recLen);
    return this.tapData || new Uint8Array(0);
  }

  // A complete .tap file: the 20-byte header plus the pulse data.
  exportTapBytes() {
    const data = this._dataBytes();
    const out = new Uint8Array(HEADER_SIZE + data.length);
    for (let i = 0; i < 12; i++) out[i] = TAP_MAGIC.charCodeAt(i);
    out[12] = this.tapVersion;
    out[16] = data.length & 0xFF;
    out[17] = (data.length >> 8) & 0xFF;
    out[18] = (data.length >> 16) & 0xFF;
    out[19] = (data.length >>> 24) & 0xFF;
    out.set(data, HEADER_SIZE);
    return out;
  }

  // ── Save-state ──────────────────────────────────────────────────────────
  // The TAP bytes are captured by the machine (bundled media); this captures
  // the transport position + motor/key state. `flagCallback` is re-wired by
  // the machine.
  serialize() {
    // Mid-recording the cursor still sits at the splice point, but the media the
    // caller bundles (exportTapBytes) already holds everything written since —
    // so report the head where that data ends, which is where it physically is.
    const rec = this._recStarted;
    return {
      tapVersion: this.tapVersion,
      pos: rec ? this._recLen : this.pos,
      cyclesUntilEdge: rec ? 0 : this.cyclesUntilEdge,
      motorOn: this.motorOn,
      key: this.key,
      writeProtected: this.writeProtected,
      playPressed: this.playPressed,   // legacy readers
      atEnd: rec ? true : this.atEnd,
      dirty: this.dirty,
      _flagLevel: this._flagLevel,
      _writeLevel: this._writeLevel,
      _pulseCount: this._pulseCount,
      _tapeCycles: this._tapeCycles,
      _motorStartupRemaining: this._motorStartupRemaining,
      _lastEdgeCycle: this._lastEdgeCycle,
      _encCarry: this._encCarry,
    };
  }

  // Call AFTER the TAP bytes have been re-attached via loadTap().
  deserialize(s) {
    this.tapVersion = s.tapVersion | 0;
    this.pos = s.pos | 0;
    this.cyclesUntilEdge = s.cyclesUntilEdge | 0;
    this.motorOn = !!s.motorOn;
    // States written before the transport had keys carry playPressed only.
    const mode = KEYS.indexOf(s.key);
    this._mode = mode >= 0 ? mode : (s.playPressed ? MODE_PLAY : MODE_STOP);
    this.writeProtected = !!s.writeProtected;
    this.atEnd = !!s.atEnd;
    this.dirty = !!s.dirty;
    this._flagLevel = s._flagLevel;
    this._writeLevel = s._writeLevel ?? 1;
    this._pulseCount = s._pulseCount | 0;
    // Not `| 0`: a long tape passes 2^31 cycles (≈ 36 min).
    this._tapeCycles = +(s._tapeCycles ?? s._cyclesTotal ?? 0) || 0;
    this._motorStartupRemaining = s._motorStartupRemaining | 0;
    // The bytes restored by loadTap() already hold everything that had been
    // recorded, and `pos` points at their end, so reopening the session simply
    // continues appending. Restore the edge clock afterwards: _maybeStartRecording
    // arms a fresh one, and here the tape time it was measuring from is known.
    if (this._mode === MODE_REC && this.motorOn) this._maybeStartRecording();
    this._encCarry = s._encCarry | 0;
    this._lastEdgeCycle = s._lastEdgeCycle ?? -1;
  }
}
