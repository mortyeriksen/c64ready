// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/wav-tape.js – Reading a recorded cassette back in.
//
// The inverse of tap-audio.js: where that turns pulse widths into a waveform,
// this recovers the widths from one. A C64 tape encodes its data in the distance
// between edges, so decoding is edge detection — find where the signal crosses,
// measure the gaps, write them out as TAP pulses.
//
// Real recordings are the hard case. A digitised cassette drifts in level, may
// carry a DC offset from the sound card, and has hiss, so a plain zero-crossing
// test produces phantom edges wherever the signal loiters near the middle. The
// detector here is a Schmitt trigger: it only accepts a fall once the signal has
// gone clearly negative, and only re-arms once it has gone clearly positive, with
// the threshold taken from the recording's own level. Speed drift needs no
// special handling — every pulse is measured on its own, so a tape running a few
// percent slow just yields slightly longer pulses, exactly as the C64 would hear
// from that deck.
//
// The pulses go out through tap-encode.js as a v1 .tap.

import { PAL_CPU_HZ } from './tap-audio.js';
import { encodeTap } from './tap-encode.js';

import { turboTape64Files, turboTape64Widths, renderTurboTape64Block } from './tap-turbo-formats.js';
import { tapDirectoryOfPulses } from './tap-directory.js';

// How far past the centre a swing must go before a crossing counts. Measured
// against real transfers: at 0.30 and above the second copy of a file on one of
// them stops decoding, while every value from 0.15 down to 0.25 reads it — and a
// clean tape is unaffected either way. 0.25 sits in the middle of that range,
// well clear of hiss.
const HYSTERESIS = 0.25;

// Level and centre line are both taken locally: a tape half an hour long holds
// neither. Under one threshold set by the loud parts, a weak passage loses the
// crossing between two pulses and they merge — fatal where one pulse is one bit.
// Measured on such a passage: 520-cycle pulses on a tape that writes 216 and 328.
// In time rather than samples, or the same tape digitised at 96 kHz would be
// judged over a third of the stretch: 128 samples at 44.1 kHz, about 3 ms, a
// dozen or so symbols.
const LEVEL_WINDOW_SECONDS = 128 / 44100;
const LEVEL_FLOOR = 0.05;     // …but not so local that silence tracks the hiss
// The treble lift's difference is taken over this much time for the same reason.
const LIFT_STEP_SECONDS = 1 / 44100;
// How much of a recording the detector holds at once: this many level windows,
// so a window never straddles two pieces. About a million samples at 44.1 kHz.
const CHUNK_WINDOWS = 8192;

// A silence this long separates two recordings, and two recordings need not be
// the same way up — people recorded on different decks, and the pairing of edges
// that reads one garbles the other. So each stretch between such gaps chooses
// its own pairing, when it holds enough pulses to be sure and the two pairings
// are not close; the rest follow the tape as a whole.
const SEGMENT_GAP_SECONDS = 1;
const SEGMENT_MIN_CROSSINGS = 4000;
const SEGMENT_CLEAR = 0.75;   // the winning pairing's spread, as a share of the other's

/**
 * Parse a RIFF/WAVE container into one channel of float samples.
 * Handles PCM (8/16/24/32-bit), IEEE float (32/64) and WAVE_FORMAT_EXTENSIBLE,
 * mono or multi-channel — the first channel is taken, since both sides of a
 * tape recording carry the same signal.
 * @param {Uint8Array} bytes
 * @returns {{ samples: Float32Array, sampleRate: number, channels: number, bits: number }}
 */
/**
 * A recording, ready to be read from — parsed once, sampled on demand. A stereo
 * transfer is two readings of the same tape, and mending a file may want the
 * other one, so nothing is committed to a channel here. Besides a channel
 * number, `span` reads 'mix' (the channels averaged), 'aligned' (the second
 * shifted onto the first before averaging) and 'diff' (their difference).
 * @returns {{ frames: number, channels: number, sampleRate: number, bits: number,
 *   span: (channel: number|string, from: number, to: number, onProgress?: Function) => Float32Array,
 *   loudest: () => number, lag: () => { lag: number, sign: number, r: number, lags: Array } }}
 */
export function wavReader(bytes) {
  if (bytes.length < 12) throw new Error('Not a WAV file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');

  let fmt = null, data = null;
  for (let p = 12; p + 8 <= bytes.length;) {
    const id = tag(p);
    const size = dv.getUint32(p + 4, true);
    const body = p + 8;
    if (id === 'fmt ' && size >= 16) {
      fmt = {
        format: dv.getUint16(body, true),
        channels: dv.getUint16(body + 2, true),
        rate: dv.getUint32(body + 4, true),
        bits: dv.getUint16(body + 14, true),
      };
      // EXTENSIBLE hides the real format in the first two bytes of its GUID.
      if (fmt.format === 0xFFFE && size >= 40) fmt.format = dv.getUint16(body + 24, true);
    } else if (id === 'data') {
      data = { off: body, size: Math.min(size, bytes.length - body) };
    }
    p = body + size + (size & 1);      // chunks are word-aligned
  }
  if (!fmt || !data) throw new Error('WAV is missing its fmt or data chunk');
  if (fmt.format !== 1 && fmt.format !== 3) throw new Error(`Unsupported WAV encoding (${fmt.format})`);
  // Say which part is unsupported rather than reading past the end of a buffer
  // and reporting whatever the DataView complains about.
  const widths = fmt.format === 3 ? [32, 64] : [8, 16, 24, 32];
  if (!widths.includes(fmt.bits)) {
    throw new Error(`Unsupported WAV sample size (${fmt.bits}-bit ${fmt.format === 3 ? 'float' : 'PCM'})`);
  }
  if (!fmt.channels) throw new Error('WAV says it has no channels');
  if (!fmt.rate) throw new Error('WAV says it has no sample rate');

  const step = fmt.bits >> 3;
  const frame = step * fmt.channels;
  const frames = Math.floor(data.size / frame);
  if (!frames) throw new Error('WAV has no audio');

  const read = (at) => {
    if (fmt.format === 3) return fmt.bits === 64 ? dv.getFloat64(at, true) : dv.getFloat32(at, true);
    if (fmt.bits === 8) return (bytes[at] - 128) / 128;                // 8-bit PCM is unsigned
    if (fmt.bits === 16) return dv.getInt16(at, true) / 32768;
    if (fmt.bits === 24) return ((bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)) << 8 >> 8) / 8388608;
    return dv.getInt32(at, true) / 2147483648;
  };
  // Sample i of channel c. Chosen once for the file's format rather than
  // branching on it per sample — this runs for every sample of every reading —
  // and read through a typed view over the data chunk where it is aligned,
  // which the common 16-bit file always is.
  const chans = fmt.channels, off = bytes.byteOffset + data.off;
  const fits = (unit) => off % unit === 0 && off + frames * chans * unit <= bytes.buffer.byteLength;
  let sample;
  if (fmt.format === 1 && fmt.bits === 16 && fits(2)) {
    const v = new Int16Array(bytes.buffer, off, frames * chans);
    sample = (i, c) => v[i * chans + c] / 32768;
  } else if (fmt.format === 1 && fmt.bits === 8) {
    sample = (i, c) => (bytes[data.off + i * frame + c] - 128) / 128;
  } else if (fmt.format === 3 && fmt.bits === 32 && fits(4)) {
    const v = new Float32Array(bytes.buffer, off, frames * chans);
    sample = (i, c) => v[i * chans + c];
  } else if (fmt.format === 1 && fmt.bits === 32 && fits(4)) {
    const v = new Int32Array(bytes.buffer, off, frames * chans);
    sample = (i, c) => v[i * chans + c] / 2147483648;
  } else {
    sample = (i, c) => read(data.off + i * frame + c * step);
  }

  // How far the second channel trails the first, in samples, and which way up it
  // is. A stereo transfer of a mono tape is one track read by two head gaps, and
  // any azimuth error puts a delay between them — measured here, one to four
  // samples on every tape, none inverted. Averaged as they stand the two half
  // cancel: on one tape the plain average lists one file in eight where the
  // aligned one lists twelve of fourteen. The delay is not one figure for a side
  // either: it steps between recording sessions (−1.9, −0.2, −2.1 and +0.6
  // samples along one tape) and drifts within one (3.5 to 1.2 along another),
  // so it is measured once a minute — by correlation over the loudest ten
  // seconds of the minute, placed between samples from the peak's neighbours —
  // and drawn straight between the measurements. A minute with no signal takes
  // its neighbours' figure.
  const LAG_WINDOW = 60 * fmt.rate, LAG_SPAN = 10 * fmt.rate, LAG_MAX = 8;
  let lags = null;              // [{ at, lag, r }], at = the window's centre
  let sign = 1;
  const measureLags = () => {
    if (lags) return lags;
    lags = [];
    if (fmt.channels !== 2) return lags;
    const found = [];
    for (let w0 = 0; w0 < frames; w0 += LAG_WINDOW) {
      const w1 = Math.min(frames, w0 + LAG_WINDOW);
      if (w1 - w0 < LAG_SPAN) break;
      // The loudest ten seconds of the minute, by a coarse energy scan.
      let at = w0, loud = -1;
      for (let s = w0; s + LAG_SPAN <= w1; s += fmt.rate) {
        let e = 0;
        for (let i = s; i < s + LAG_SPAN; i += 16) { const v = sample(i, 0); e += v * v; }
        if (e > loud) { loud = e; at = s; }
      }
      const a = new Float32Array(LAG_SPAN), b = new Float32Array(LAG_SPAN);
      let ma = 0, mb = 0;
      for (let i = 0; i < LAG_SPAN; i++) {
        ma += (a[i] = sample(at + i, 0));
        mb += (b[i] = sample(at + i, 1));
      }
      ma /= LAG_SPAN; mb /= LAG_SPAN;
      let energy = 0;
      for (let i = 0; i < LAG_SPAN; i++) energy += (a[i] - ma) ** 2;
      if (Math.sqrt(energy / LAG_SPAN) < 0.02) continue;          // silence: nothing to line up
      const corr = (l) => {
        let acc = 0, ea = 0, eb = 0;
        for (let i = LAG_MAX; i < LAG_SPAN - LAG_MAX; i++) {
          const x = a[i] - ma, y = b[i + l] - mb;
          acc += x * y; ea += x * x; eb += y * y;
        }
        return ea && eb ? acc / Math.sqrt(ea * eb) : 0;
      };
      const r = [];
      for (let l = -LAG_MAX; l <= LAG_MAX; l++) r.push(corr(l));
      let k = LAG_MAX;
      for (let i = 0; i < r.length; i++) if (Math.abs(r[i]) > Math.abs(r[k])) k = i;
      let lag = k - LAG_MAX;
      const sgn = r[k] < 0 ? -1 : 1;
      if (k > 0 && k < r.length - 1) {
        const y0 = sgn * r[k - 1], y1 = sgn * r[k], y2 = sgn * r[k + 1];
        const curve = y0 - 2 * y1 + y2;
        if (curve < 0) lag += 0.5 * (y0 - y2) / curve;
      }
      found.push({ at: (w0 + w1) / 2, lag, r: Math.abs(r[k]), sgn });
    }
    // One way up for the whole recording — the wiring does not change mid-tape.
    let up = 0;
    for (const f of found) up += f.sgn * f.r;
    sign = up < 0 ? -1 : 1;
    lags = found.filter(f => f.sgn === sign);
    return lags;
  };
  const lagAt = (i) => {
    const t = lags;
    if (!t.length) return 0;
    if (i <= t[0].at) return t[0].lag;
    let k = 1;
    while (k < t.length && t[k].at < i) k++;
    if (k === t.length) return t[t.length - 1].lag;
    const a = t[k - 1], b = t[k];
    return a.lag + (b.lag - a.lag) * (i - a.at) / (b.at - a.at);
  };
  // What the tape as a whole says: the median delay, and how well the channels
  // agree there. What span() uses is the table behind it.
  const lagOf = () => {
    const t = measureLags();
    if (!t.length) return { lag: 0, sign: 1, r: fmt.channels === 2 ? 0 : 1, lags: t };
    const sorted = t.map(f => f.lag).sort((x, y) => x - y);
    return { lag: sorted[sorted.length >> 1], sign, r: t.reduce((p, f) => p + f.r, 0) / t.length, lags: t };
  };

  return {
    frames, channels: fmt.channels, sampleRate: fmt.rate, bits: fmt.bits,
    lag: lagOf,
    // A run of samples read in pieces, so nothing the length of the tape is
    // ever held: `fill(at, out)` writes samples [at, at + out.length) of the run
    // [from, to). The treble lift, where asked for, is applied here as it goes:
    // y = x + k·(x − x⁻ˢ) over a fixed stretch of time — one sample at 44.1 kHz,
    // two at 88.2 — with what is left over folded into k, so a lift of 2.5 is
    // the same treatment whatever rate the tape was digitised at. It puts back
    // edges a dropout rounded off; it also shifts widths a little, which is why
    // it is only ever used to recover bytes, never to write the tape a loader
    // will read. The first `step` samples of a run are left as they are.
    source(channel, from = 0, to = frames, { lift = 0 } = {}) {
      const a = Math.max(0, Math.min(frames, Math.floor(from)));
      const b = Math.max(a, Math.min(frames, Math.ceil(to)));
      // A mono file has only the one reading, whatever was asked for; alignment
      // and difference are between two channels and no more.
      const kind = fmt.channels === 1 ? 0
        : (channel === 'aligned' || channel === 'diff') && fmt.channels !== 2 ? 'mix'
          : channel;
      const two = kind === 'aligned' || kind === 'diff';
      if (kind === 'aligned') measureLags();
      const sgn = kind === 'aligned' ? sign : -1;
      // The delay along the run, looked up with a cursor: a fill goes forwards,
      // so the knot to interpolate from is almost always the one used last.
      let cursor = 1;
      const lagHere = (i) => {
        const t = lags, m = t.length;
        if (kind !== 'aligned' || !m) return 0;
        if (i <= t[0].at) return t[0].lag;
        if (i < t[cursor - 1].at) cursor = 1;
        while (cursor < m && t[cursor].at < i) cursor++;
        if (cursor === m) return t[m - 1].lag;
        const p = t[cursor - 1], q = t[cursor];
        return p.lag + (q.lag - p.lag) * (i - p.at) / (q.at - p.at);
      };
      const rawAt = two
        ? (i) => {
          const lag = lagHere(i);
          const whole = Math.floor(lag), frac = lag - whole;
          const j = i + whole;
          const v0 = j >= 0 && j < frames ? sample(j, 1) : 0;
          const v1 = frac && j + 1 >= 0 && j + 1 < frames ? sample(j + 1, 1) : v0;
          return (sample(i, 0) + sgn * (v0 + (v1 - v0) * frac)) / 2;
        }
        : kind === 'mix'
          ? (i) => { let acc = 0; for (let c = 0; c < chans; c++) acc += sample(i, c); return acc / chans; }
          : (i) => sample(i, kind);
      const per = fmt.rate * LIFT_STEP_SECONDS;
      const step = Math.max(1, Math.round(per));
      const gain = lift * per / step;
      return {
        length: b - a,
        fill(at, out) {
          const len = out.length, base = a + at;
          if (!lift) {
            // The plain readings inline the sampler: this is the loop the whole
            // tape goes through, twice per reading.
            if (!two && kind !== 'mix') for (let j = 0; j < len; j++) out[j] = sample(base + j, kind);
            else for (let j = 0; j < len; j++) out[j] = rawAt(base + j);
            return;
          }
          // Rounded to what a stored sample would have been before the lift, so
          // the result is the one a lifted buffer would hold.
          for (let j = 0; j < len; j++) {
            const k = at + j;
            const x = Math.fround(rawAt(a + k));
            out[j] = k >= step ? x + gain * (x - Math.fround(rawAt(a + k - step))) : x;
          }
        },
      };
    },
    /** The samples of a run, as one array — for tools and tests; the importer
     *  reads through source() and never holds a whole tape. */
    span(channel, from = 0, to = frames, onProgress = null) {
      const src = this.source(channel, from, to);
      const out = new Float32Array(src.length);
      const CHUNK = 1 << 22;
      for (let at = 0; at < out.length; at += CHUNK) {
        if (onProgress) onProgress(at / Math.max(1, out.length));
        src.fill(at, out.subarray(at, Math.min(out.length, at + CHUNK)));
      }
      return out;
    },
    // Which channel to read first. Decks are wired both ways and a transfer is
    // often one-sided, so a stereo file with silence on the left is common. It
    // is only a starting point: loud is not the same as sound, and a file the
    // loud channel cannot prove is read again from the other one.
    loudest() {
      if (fmt.channels < 2) return 0;
      const stride = Math.max(1, Math.floor(frames / 20000));
      let best = -1, pick = 0;
      for (let c = 0; c < fmt.channels; c++) {
        let acc = 0, seen = 0;
        for (let i = 0; i < frames; i += stride) { const v = sample(i, c); acc += v * v; seen++; }
        const rms = Math.sqrt(acc / Math.max(1, seen));
        if (rms > best) { best = rms; pick = c; }
      }
      return pick;
    },
  };
}

/**
 * The samples of one channel of a recording.
 * @param {Uint8Array} bytes
 * @param {object} opts  `channel` to read a particular one, else the loudest
 */
export function decodeWav(bytes, { onProgress = null, channel = null } = {}) {
  const wav = wavReader(bytes);
  const pick = channel === null ? wav.loudest()
    : typeof channel === 'string' ? channel : Math.max(0, Math.min(wav.channels - 1, channel));
  return {
    samples: wav.span(pick, 0, wav.frames, onProgress),
    sampleRate: wav.sampleRate, channels: wav.channels, bits: wav.bits, channel: pick,
  };
}


/** A whole array of samples, read as if in pieces. */
const arraySource = (arr) => ({
  length: arr.length,
  fill(at, out) { for (let j = 0; j < out.length; j++) out[j] = arr[at + j]; },
});

/**
 * The pulse widths in a run of samples, and the crossings they were measured
 * between — kept, because a cycle count cannot be mapped back to a sample and
 * mending a file means going back to the ones it came from.
 *
 * `input` is a chunked source (wavReader.source) or a Float32Array. The run is
 * read twice, a piece at a time — once for what the tape and each window say of
 * themselves, once for the crossings — so a half-hour side never sits in memory
 * as samples: at 44.1 kHz that is 300 MB a channel, which is what put a phone's
 * worker at risk.
 */
export function detectPulses(input, sampleRate, cpuHz, onProgress = null) {
  const src = typeof input.fill === 'function' && typeof input.length === 'number' && !(input instanceof Float32Array)
    ? input : arraySource(input);
  const n = src.length;
  const tick = (stage, at) => { if (onProgress) onProgress(stage, at); };
  const win = Math.max(8, Math.round(sampleRate * LEVEL_WINDOW_SECONDS));
  const windows = Math.ceil(n / win);
  const CHUNK = win * CHUNK_WINDOWS;
  const buf = new Float32Array(Math.min(n, CHUNK));
  const piece = (at) => {
    const len = Math.min(CHUNK, n - at);
    const x = len === buf.length ? buf : buf.subarray(0, len);
    src.fill(at, x);
    return x;
  };

  // Centre the signal and size the trigger from it: a sound card's DC offset
  // would otherwise bias every threshold, and a quiet transfer needs a lower bar
  // than a hot one. And the centre line and the level, window by window. Both
  // are local for the same reason: a recording this old does not hold either
  // one. The centre wanders — measured here, by a twentieth of full scale
  // across a few milliseconds — and a wave that swings less than that never
  // crosses the recording's average at all, so its crossings are simply not
  // seen. The level is smoothed across neighbours so the threshold drifts with
  // the tape rather than stepping at a window edge.
  tick('reading', 0);
  const centre = new Float32Array(windows);
  const level = new Float32Array(windows);
  let sum = 0, sumSq = 0;
  for (let at = 0; at < n; at += CHUNK) {
    const x = piece(at), len = x.length;
    tick('reading', at / n);
    for (let i = 0; i < len; i++) { sum += x[i]; sumSq += x[i] * x[i]; }
    for (let w0 = 0; w0 < len; w0 += win) {
      const to = Math.min(len, w0 + win);
      let acc = 0;
      for (let i = w0; i < to; i++) acc += x[i];
      const mid = acc / Math.max(1, to - w0);
      acc = 0;
      for (let i = w0; i < to; i++) { const v = x[i] - mid; acc += v * v; }
      const w = (at + w0) / win;
      centre[w] = mid;
      level[w] = Math.sqrt(acc / Math.max(1, to - w0));
    }
  }
  const dc = sum / n;
  const rms = Math.sqrt(Math.max(0, sumSq / n - dc * dc));
  const floor = Math.max(1e-4, rms * LEVEL_FLOOR);
  tick('level', 0);
  const gates = new Float32Array(windows);
  for (let w = 0; w < windows; w++) {
    const a = level[Math.max(0, w - 1)], b = level[w], c = level[Math.min(windows - 1, w + 1)];
    gates[w] = Math.max(floor, ((a + b + c) / 3) * HYSTERESIS);
  }
  // Between window centres the line is drawn straight, so it bends with the
  // recording instead of stepping.
  const half = win / 2;
  const centreAt = (i) => {
    const t = (i - half) / win;
    const w0 = t <= 0 ? 0 : t >= windows - 1 ? windows - 1 : Math.floor(t);
    const w1 = w0 + 1 < windows ? w0 + 1 : w0;
    const f = t - w0;
    return f <= 0 ? centre[w0] : f >= 1 ? centre[w1] : centre[w0] + (centre[w1] - centre[w0]) * f;
  };

  // Where the wave crosses the centre line, interpolated between the two samples
  // that straddle it, and counted only once the swing past the gate confirms it —
  // hiss around the centre would otherwise invent an edge on every sample.
  //
  // Crossings rather than the gate itself: what carries the data is the interval
  // between like edges, and a played-back tape does not hold its shape. The head
  // differentiates the signal and any azimuth error skews it, so the two halves
  // of a wave stop being equal — measured on tapes here, one half ran 156 cycles
  // against the other's 290. Timing from where the gate is crossed folds all of
  // that skew into the width and pushes pulses across the class boundaries a
  // loader reads; timing from the centre crossings does not.
  const cyclesPerSample = cpuHz / sampleRate;
  // Seeded with the start of the recording: that is a boundary too, and a
  // rendering that begins exactly on a symbol would otherwise lose its first one.
  tick('pulses', 0);
  const crossings = [0];
  {
    let sign = 0, pending = -1, prev = 0;
    for (let at = 0; at < n; at += CHUNK) {
      const x = piece(at), len = x.length;
      tick('pulses', at / n);
      let j = 0;
      if (at === 0) { prev = x[0] - centreAt(0); j = 1; }
      for (; j < len; j++) {
        const i = at + j;
        const v = x[j] - centreAt(i);
        if ((prev <= 0 && v > 0) || (prev >= 0 && v < 0)) {
          const span = Math.abs(prev) + Math.abs(v);
          pending = i - 1 + (span ? Math.abs(prev) / span : 0);
        }
        if (pending >= 0 && Math.abs(v) > gates[(i / win) | 0] && Math.sign(v) !== sign) {
          crossings.push(pending);
          sign = Math.sign(v);
          pending = -1;
        }
        prev = v;
      }
    }
  }

  // A pulse is one whole wave, so it spans two crossings — and which of the two
  // pairings is the real one is the same question polarity used to ask. Pair the
  // wrong way and the second half of one symbol joins the first half of the next:
  // every width lands between two real ones, none is long enough for the KERNAL's
  // byte marker, and the tape decodes to garbage. Both ways, keep the cleaner.
  //
  // The trigger records a crossing only when the sign has changed, so crossings
  // alternate strictly and an index's parity is its edge's polarity: a dropout
  // loses crossings in pairs and cannot turn the pairing over. What can is a
  // tape holding recordings made the other way up, which is why the choice is
  // made per stretch between long silences as well as for the tape.
  //
  // How wide a pairing's widths are spread, counted as it goes: the losing
  // pairing is millions of entries that would only be thrown away.
  const firstOf = (phase, i0) => {
    let i = i0 + ((i0 & 1) === phase ? 0 : 1);
    while (i < 2) i += 2;
    return i;
  };
  const spreadBetween = (phase, i0, i1) => {
    const seen = new Map();
    let n = 0;
    for (let i = firstOf(phase, i0); i < i1; i += 2) {
      const k = Math.round((crossings[i] - crossings[i - 2]) * cyclesPerSample / 8);
      seen.set(k, (seen.get(k) || 0) + 1);
      n++;
    }
    return spreadOf(seen, n);
  };

  // A correctly paired tape lands on a handful of pulse widths — the two or
  // three symbols its encoding uses. Mis-paired, each symbol smears into a pair
  // of wrong ones, so the count of widths needed to cover the bulk roughly
  // doubles. Fewest widths wins; a tie goes to the pairing that starts at the
  // first crossing, which is what this project's own .wav export produces.
  const phase = spreadBetween(1, 0, crossings.length) < spreadBetween(0, 0, crossings.length) ? 1 : 0;

  // Each stretch between long gaps, paired its own way when it holds enough
  // pulses to be sure and the pairings are clearly apart; otherwise as the tape.
  // The sample each pulse began at stays reachable (startOf): a cycle count
  // cannot be mapped back to a sample, and mending a file means going back to
  // the ones it came from.
  const gap = SEGMENT_GAP_SECONDS * sampleRate;
  const pulses = [];
  // Where each stretch's pulses begin, as a pulse number and a crossing index,
  // so the sample a pulse started at is arithmetic rather than a second array
  // the size of the first.
  const segments = [];
  for (let i0 = 0; i0 < crossings.length;) {
    let i1 = i0 + 1;
    while (i1 < crossings.length && crossings[i1] - crossings[i1 - 1] < gap) i1++;
    let p = phase;
    if (i1 - i0 >= SEGMENT_MIN_CROSSINGS) {
      const even = spreadBetween(0, i0, i1), odd = spreadBetween(1, i0, i1);
      if (odd < even * SEGMENT_CLEAR) p = 1;
      else if (even < odd * SEGMENT_CLEAR) p = 0;
    }
    const first = firstOf(p, i0);
    if (first < i1) segments.push({ k0: pulses.length, i: first });
    for (let i = first; i < i1; i += 2) pulses.push((crossings[i] - crossings[i - 2]) * cyclesPerSample);
    i0 = i1;
  }
  const count = pulses.length;
  const startOf = (k) => {
    if (!(k >= 0 && k < count)) return undefined;
    let lo = 0, hi = segments.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (segments[m].k0 <= k) lo = m; else hi = m - 1; }
    const seg = segments[lo];
    return crossings[seg.i + 2 * (k - seg.k0) - 2];
  };

  return { pulses, startOf, crossings, phase };
}

// Lifts to try on a file the tape did not give up first time. There is no point
// being shy about the high ones: what they are used for is the bytes, and those
// are either right or the checksum says they are not.
const MEND_LIFTS = [1.5, 2.5, 3.5, 5];
// And with no lift at all on the tape's other channel, which is a second reading
// of the same signal rather than a treated one — measured on these transfers,
// each channel proves files the other cannot.
const MEND_PLAIN = [0, ...MEND_LIFTS];
const MEND_MARGIN_SECONDS = 0.25;
// How far short of a fault a splice cuts, in seconds. Measured on these tapes
// both ways: some files come right only given a wide berth (the damage upsets
// the level tracking around it), others only a narrow one. Each is tried and
// the checksum picks.
const SPLICE_MARGINS_SECONDS = [0.03, 0.01, 0.0015];
// What each pass over the recording is worth, for a bar that only goes forward.
const PASS_SHARE = { reading: 0.4, level: 0.2, pulses: 0.4 };
const PASS_BEFORE = { reading: 0, level: 0.4, pulses: 0.6 };
// What a gap has to keep after a longer block is fitted into it: a rewritten
// block runs a little long or short of the one it replaces, because its widths
// are measured off the recording rather than assumed.
const GAP_KEEP = 20000;   // cycles the gap must still have left

/** How many 8-cycle buckets it takes to cover 99% of a pairing's widths. */
function spreadOf(seen, total) {
  const counts = [...seen.values()].sort((a, b) => b - a);
  const target = total * 0.99;
  let acc = 0, k = 0;
  while (k < counts.length && acc < target) acc += counts[k++];
  return k;
}

/** The pulse whose own reading began at that sample, by binary search. */
function pulseAt(startOf, count, sample) {
  let lo = 0, hi = Math.max(0, count - 1);
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (startOf(mid) < sample) lo = mid + 1; else hi = mid;
  }
  return lo;
}

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Is a pulse one of the two widths this block is written at? */
const isSymbol = (c, w) => Math.abs(c - w.zero) <= w.zero * 0.2 || Math.abs(c - w.one) <= w.one * 0.2;

/**
 * One file's block, read every way at once and taken in pieces: where a reading
 * is damaged, another one covers that stretch. The readings share a clock — they
 * are the same recording, so a pulse in one has the same sample position as the
 * pulse in another — which is what makes them spliceable at all. The cut lands
 * between faults, never inside one, and the block's checksum says whether the
 * result is the file.
 *
 * @param {Array} readings  each { block, pulses, sampleAt } for the same span
 * @param {number} margin  samples of clearance to keep either side of a cut
 * @returns {Array|null} pulses for the whole span, pieced together
 */
function spliceReadings(readings, widths, margin) {
  // What each reading can be trusted for: everything but the pulses inside its
  // blocks that are neither symbol. A gap is not a fault, so only the blocks are
  // looked at.
  const parts = [];
  for (const r of readings) {
    const faults = [];
    for (let i = r.block.from; i < r.block.to && i < r.pulses.length; i++) {
      if (!isSymbol(r.pulses[i], widths)) faults.push(r.sampleAt(i));
    }
    parts.push({ r, faults, next: (from) => faults.find(f => f >= from) ?? Infinity });
  }

  const start = Math.min(...parts.map(p => p.r.sampleAt(0)));
  const end = Math.max(...parts.map(p => p.r.sampleAt(p.r.pulses.length - 1))) + 1;

  // A seam lands midway between two of a reading's pulses. The reading taking
  // over has the same pulses a fraction of a sample away — a lift moves every
  // crossing a little — and a seam on a pulse's own start would repeat it or
  // drop it, either of which is a bit.
  const seam = (r, to) => {
    let lo = 0, hi = r.pulses.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (r.sampleAt(m) < to) lo = m + 1; else hi = m; }
    const mid = lo > 0 ? (r.sampleAt(lo - 1) + r.sampleAt(lo)) / 2 : to;
    return Number.isFinite(mid) ? mid : to;
  };

  // Walk the span, each time taking the reading that stays clean longest from
  // here and cutting a margin short of its next fault. Fewest cuts, and none of
  // them near damage. Where every reading has a fault within the margin, the
  // walk goes straight through it on the reading that lasts longest — a pulse
  // no reading likes may still decode, and the checksum has the last word —
  // rather than creeping towards it a sample at a time.
  const cuts = [];
  let at = start;
  while (at < end) {
    let best = null, until = -Infinity;
    for (const p of parts) {
      const stop = p.next(at);
      if (stop > until) { until = stop; best = p; }
    }
    if (!best) return null;
    let to = end;
    if (until !== Infinity) {
      const cut = seam(best.r, until - margin > at ? until - margin : until + 1);
      to = cut > at ? cut : until + 1;
    }
    cuts.push({ p: best, from: at, to: Math.min(to, end) });
    at = Math.min(to, end);
  }

  const out = [], where = [];
  for (const cut of cuts) {
    const { pulses, sampleAt } = cut.p.r;
    for (let i = 0; i < pulses.length; i++) {
      const s = sampleAt(i);
      if (s >= cut.from && s < cut.to) { out.push(pulses[i]); where.push(s); }
    }
  }
  return out.length ? { pulses: out, sampleOf: (i) => where[i] } : null;
}

/**
 * A turbo file is written to the tape once, so there is no second copy to mend
 * it from — but there is a second *reading*. Where a block's checksum fails, its
 * own stretch of the recording is read again — the channels lined up, the
 * treble lifted, the other channel — and a reading that checks out puts the
 * block back at the widths the tape uses elsewhere. What the loader sees is a
 * clean block; what proves it is the checksum and a second reading agreeing.
 */
function mendTurbo({ pulses, startOf }, source, sampleRate, cpuHz, say = () => {}) {
  const { wav, base } = source;
  const files = turboTape64Files(pulses);
  const broken = files.filter(f => f.data && !f.data.checksumOk);
  // No early return when nothing is broken: the proved blocks still go back
  // clean (below), and a tape with every file sound is exactly where a loader
  // was found choking on a stretched pulse the checksum had no quarrel with.
  if (!files.some(f => f.data)) return { pulses, mended: [], unconfirmed: [] };

  // What to try, in order. A stereo transfer is two passes of the same head and
  // the noise on them differs, so a file one channel cannot prove the other
  // often can — and the two combined is a third reading again: lined up and
  // averaged, or averaged as they stand, or the one taken from the other, which
  // is a treble lift with the noise the channels share cancelled. Measured on
  // these tapes each of them proves files nothing else does, and each also
  // fails outright on some tape. Which is why they are candidates and not the
  // default: the checksum picks, nothing else. The reading the tape was decoded
  // from is not tried again unlifted — it is the one that failed.
  const tries = [];
  const seen = new Set();
  const add = (channel, k) => {
    const key = `${channel}:${k}`;
    if ((channel === base && k === 0) || seen.has(key)) return;
    seen.add(key);
    tries.push({ channel, k });
  };
  if (wav.channels > 1) { add('aligned', 0); add('mix', 0); }
  for (const k of MEND_LIFTS) add(base, k);
  for (let c = 0; c < wav.channels; c++) if (c !== base) for (const k of MEND_PLAIN) add(c, k);
  if (wav.channels > 1) for (const k of MEND_LIFTS) { add('aligned', k); add('mix', k); }
  if (wav.channels === 2) for (const k of MEND_PLAIN) add('diff', k);

  const widths = turboTape64Widths(pulses, files);
  const startSample = k => startOf(k) ?? wav.frames;
  const patches = [], mended = [], unconfirmed = [];

  for (const [done, f] of broken.entries()) {
    say('mending', done / broken.length);
    // From the header, not the data block: a file is named by its header, and a
    // stretch of tape holding only the second half of one is anonymous. Pulses
    // are lost and gained where a tape is damaged, so the block's own pulse
    // numbers place it only roughly — hence the margin either side as well.
    const at = startSample(f.headerSync), till = startSample(f.data.endBit);
    const margin = MEND_MARGIN_SECONDS * sampleRate + (till - at) * 0.05;
    const from = Math.max(0, Math.floor(at - margin));
    const to = Math.min(wav.frames, Math.ceil(till + margin));
    if (to - from < 2) continue;

    // Every reading of this file's stretch of tape. One that checks out is a
    // candidate, not the answer: an 8-bit checksum lets one wrong reading in
    // 256 through — measured on these tapes, one in 159 — so the reading goes
    // on until a second one agrees with it. A file only one reading vouches for
    // still goes back, but is said to be unconfirmed; readings that check out
    // and disagree cannot both be right, and with no two agreeing the file is
    // left as it was. Readings that fail are kept for the splice.
    const readings = [], proofs = [];
    let again = null, source = null, confirmed = false;
    for (const [n, { channel, k }] of tries.entries()) {
      say('mending', (done + n / tries.length) / broken.length);
      const read = detectPulses(wav.source(channel, from, to, { lift: k }), sampleRate, cpuHz);
      const got = turboTape64Files(read.pulses).find(g => g.name === f.name && g.size === f.size && g.data);
      // A reading that cannot find the file at all is still evidence for the
      // stretch it covers, and it is often the only reading that is. A dropout
      // long enough to swallow a countdown loses the whole file in that channel
      // while the other channel plays cleanly straight through the same
      // moment: measured on these tapes, at two thirds of the dropouts in a
      // failing file the other channel is at full level. Discarding it left the
      // splice with one reading and nothing to splice against. Where the block
      // sits is known from the reading that did find it, since they share a
      // clock, so the span is taken from there in samples and turned back into
      // this reading's own pulse numbers.
      if (!got) {
        const a = pulseAt(read.startOf, read.pulses.length, startSample(f.data.syncBit) - from);
        const b = pulseAt(read.startOf, read.pulses.length, startSample(f.data.endBit) - from);
        // Only when the span really covers the block. A reading the window
        // clipped, or one whose own damage moved everything, gives back a few
        // pulses that hold no faults because they hold nothing, and the splice
        // would then take the whole file from the one reading that never found
        // it.
        if (b - a > (f.data.endBit - f.data.syncBit) / 2) {
          readings.push({
            block: { from: a, to: b },
            pulses: read.pulses,
            sampleAt: (i) => read.startOf(i) ?? Infinity,
          });
        }
        continue;
      }
      if (!got.data.checksumOk) {
        readings.push({
          block: { from: got.data.syncBit, to: got.data.endBit },
          pulses: read.pulses,
          sampleAt: (i) => read.startOf(i) ?? Infinity,
        });
        continue;
      }
      const twin = proofs.find(p => sameBytes(p.got.data.bytes, got.data.bytes));
      if (twin) { again = twin.got; source = twin.source; confirmed = true; break; }
      proofs.push({ got, source: { sampleOf: (i) => read.startOf(i) } });
    }
    if (!again && proofs.length === 1) ({ got: again, source } = proofs[0]);

    // None of them whole, so take the sound stretches of each. The readings are
    // of the same audio, so a cut in one lands in the same place in the others.
    if (!again && !proofs.length && readings.length > 1) {
      for (const seconds of SPLICE_MARGINS_SECONDS) {
        const spliced = spliceReadings(readings, widths, seconds * sampleRate);
        if (!spliced) continue;
        const got = turboTape64Files(spliced.pulses)
          .find(g => g.name === f.name && g.size === f.size && g.data && g.data.checksumOk);
        if (got) { again = got; source = spliced; break; }
      }
    }
    if (again) {
      // Which pulses to replace is answered in samples, not in pulse numbers: a
      // damaged block holds fewer pulses than it was written with, so counting
      // bytes from its start walks off the end of it and into the next gap. The
      // good reading says where the block sits in the recording; the crossings
      // say which pulses that is. A spliced reading has no crossings of its own,
      // so its block is placed where the damaged one was.
      const till = from + (source.sampleOf(again.data.endBit) ?? (to - from));
      patches.push({
        // The block's own countdown, exactly: this is the block being replaced,
        // so its position in this reading is known and must not be re-derived.
        // Going through samples and back put the patch one pulse late on three
        // files here, and one pulse is one bit — the countdown then sits a bit
        // out of step with the lead-in the loader framed its bytes on, so the
        // loader reads for ever and writes nothing. Measured: every misaligned
        // mend failed on the machine, every aligned one loaded.
        from: f.data.syncBit,
        to: pulseAt(startOf, pulses.length, till),
        block: renderTurboTape64Block(again.data.bytes, { ...widths, countdownFrom: again.data.countdownFrom }),
      });
      mended.push(f.name.trim());
      if (!confirmed) unconfirmed.push(f.name.trim());
    }
  }

  // And every block that already checks out is written back at those same two
  // widths. The reading this tape was decoded from was chosen for what *this*
  // decoder can read — a lifted or averaged signal shifts the widths, and a 1986
  // loader's threshold is fixed where ours adapts. Measured: files with sound
  // checksums answering ?LOAD ERROR on the machine. Their bytes are proved, so
  // handing the loader a clean block costs nothing and settles it.
  for (const f of files) {
    if (!f.data || !f.data.checksumOk) continue;
    patches.push({
      from: f.data.syncBit,
      to: f.data.endBit,
      block: renderTurboTape64Block(f.data.bytes, { ...widths, countdownFrom: f.data.countdownFrom }),
    });
  }

  if (!patches.length) return { pulses, mended, unconfirmed };

  // In tape order, and in one pass: a tape can have a patch per file, and
  // rebuilding the whole pulse stream for each of them copies millions of
  // entries a dozen times over.
  patches.sort((a, b) => a.from - b.from);
  const out = [];
  let at = 0;
  for (const patch of patches) {
    if (patch.from < at) continue;                  // overlaps one already written
    for (let i = at; i < patch.from; i++) out.push(pulses[i]);
    let was = 0;
    for (let i = patch.from; i < patch.to && i < pulses.length; i++) was += pulses[i];
    let now = 0;
    for (const c of patch.block) { out.push(c); now += c; }
    // A rewritten block runs a little long or short of the one it replaces — its
    // widths are measured off the recording, not assumed — so the difference is
    // settled with the gap that follows and nothing after it moves.
    at = patch.to;
    const slack = was - now;
    if (slack > 0) out.push(slack);
    else if (slack < 0 && pulses[at] > -slack + GAP_KEEP) { out.push(pulses[at] + slack); at++; }
  }
  for (let i = at; i < pulses.length; i++) out.push(pulses[i]);
  return { pulses: out, mended, unconfirmed };
}

/**
 * Turn a recording of a tape into a .tap.
 * @param {Uint8Array} wavBytes  a RIFF/PCM file
 * @param {object} opts
 * @param {number} opts.cpuHz  the machine the tape is destined for
 * @param {number} opts.preEmphasis  treble lift applied to the whole recording
 * @param {boolean} opts.mend  read damaged turbo files again and put back what checks out
 * @returns {{ tap: Uint8Array, pulses: number, seconds: number, sampleRate: number,
 *   mended: string[], unconfirmed: string[] }}  `unconfirmed` names the mended
 *   files only one reading vouches for
 */
export function wavToTap(wavBytes, { cpuHz = PAL_CPU_HZ, preEmphasis = 0, mend = true, onProgress = null, channel = null } = {}) {
  const say = (stage, at) => { if (onProgress) onProgress(stage, at); };
  const wav = wavReader(wavBytes);
  const sampleRate = wav.sampleRate;

  // Which reading of the tape to work from. A stereo transfer offers four — the
  // two channels, their average, and their average with the second lined up on
  // the first — and they are not equivalent: on one tape here the plain average
  // reads every block where the louder channel reads five of thirteen, on
  // another it cancels the signal and reads one of eight where the lined-up one
  // reads twelve of fourteen, and on a third the lined-up one loses two the
  // plain one has. So all of them are read and the one that hands over the most
  // files wins. It costs a pass of the recording each; the alternative is
  // guessing. Not the difference of the channels: it shifts the widths, and
  // what is decoded here is what a loader will be handed.
  const asked = channel === null ? null
    : typeof channel === 'string' ? channel : Math.max(0, Math.min(wav.channels - 1, channel));
  const candidates = asked !== null ? [asked]
    : wav.channels > 1 ? [wav.loudest(), ...[...Array(wav.channels).keys()].filter(c => c !== wav.loudest()), 'mix']
      : [0];
  if (asked === null && wav.channels === 2) {
    say('aligning', 0);
    wav.lag();
    candidates.push('aligned');
  }

  let base = candidates[0], read = null, best = null;
  for (const [i, candidate] of candidates.entries()) {
    // The first reading is the one the bar is named for; the rest are the
    // comparison, which is a stage of its own. Each reading is three passes over
    // the recording, so the fraction is of all three — reporting each pass's own
    // 0-to-1 into one slot would walk the bar backwards twice per reading.
    const stage = (name, at) => {
      if (i === 0) return say(name, at);
      const done = PASS_BEFORE[name] ?? 0;
      const inner = done + (PASS_SHARE[name] ?? 0) * Math.max(0, Math.min(1, at));
      say('comparing', (i - 1 + inner) / (candidates.length - 1));
    };
    // Read in pieces (see detectPulses): no reading's samples are ever held
    // whole, let alone two readings' at once.
    if (!wav.frames) throw new Error('WAV has no audio');
    const tried = detectPulses(wav.source(candidate, 0, wav.frames, { lift: preEmphasis }), sampleRate, cpuHz, stage);
    if (candidates.length === 1) { base = candidate; read = tried; break; }
    const score = scoreReading(tried.pulses);
    if (!best || score.sound > best.sound || (score.sound === best.sound && score.files > best.files)) {
      best = score; base = candidate; read = tried;
    }
  }

  const { pulses, mended, unconfirmed } = mend
    ? mendTurbo(read, { wav, base }, sampleRate, cpuHz, say)
    : { pulses: read.pulses, mended: [], unconfirmed: [] };

  return {
    tap: encodeTap(pulses), pulses: pulses.length,
    seconds: wav.frames / sampleRate, sampleRate, channel: base, mended, unconfirmed,
  };
}

/**
 * How good a reading of the tape is: what it can hand over, and what it can find
 * at all. Read off the tape itself — a turbo block's checksum, a CBM block's —
 * rather than from how the waveform looks, because what separates two readings
 * of a stereo transfer is a handful of pulses in a file ninety seconds long, and
 * no measure taken from a sample of the audio can see them.
 */
function scoreReading(pulses) {
  try {
    const files = tapDirectoryOfPulses(pulses);
    return { sound: files.filter(f => !f.damaged).length, files: files.length };
  } catch {
    return { sound: 0, files: 0 };      // a reading nothing can be listed from
  }
}
