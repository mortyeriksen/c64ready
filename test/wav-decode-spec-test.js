// Spec test for the edges of reading a recording (src/wav-tape.js,
// src/wav-import.js): every sample format a transfer might arrive in, a tape
// recorded on one channel of a stereo file, a silence longer than a .tap pulse
// can hold, and the import path when no worker can be had.
import { decodeWav, wavToTap } from '../src/wav-tape.js';
import { importWav, importProgress } from '../src/wav-import.js';

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

const RATE = 48000;
const PAL_CPU_HZ = 985248;

/**
 * A WAV holding the given per-channel signals.
 * @param {Float32Array[]} channels  one array per channel, all the same length
 */
function wav(channels, { format = 1, bits = 16, rate = RATE } = {}) {
  const frames = channels[0].length, step = bits >> 3, n = frames * channels.length;
  const bytes = new Uint8Array(44 + n * step);
  const dv = new DataView(bytes.buffer);
  const tag = (at, s) => { for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i); };
  tag(0, 'RIFF'); dv.setUint32(4, 36 + n * step, true); tag(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, format, true);
  dv.setUint16(22, channels.length, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * step * channels.length, true);
  dv.setUint16(32, step * channels.length, true);
  dv.setUint16(34, bits, true);
  tag(36, 'data'); dv.setUint32(40, n * step, true);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels.length; c++) {
      const at = 44 + (i * channels.length + c) * step;
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      if (format === 3) { if (bits === 64) dv.setFloat64(at, v, true); else dv.setFloat32(at, v, true); }
      else if (bits === 8) bytes[at] = Math.round(v * 127) + 128;
      else if (bits === 16) dv.setInt16(at, Math.round(v * 32767), true);
      else if (bits === 24) {
        const x = Math.round(v * 8388607) & 0xFFFFFF;
        bytes[at] = x & 255; bytes[at + 1] = (x >> 8) & 255; bytes[at + 2] = (x >> 16) & 255;
      } else dv.setInt32(at, Math.round(v * 2147483647), true);
    }
  }
  return bytes;
}

/** A square wave of `pulses` C64 pulses, each `cycles` long. */
function tone(cycles, pulses, level = 0.9) {
  const per = cycles * RATE / PAL_CPU_HZ;
  const out = new Float32Array(Math.round(per * pulses));
  for (let i = 0; i < out.length; i++) out[i] = (i % per) < per / 2 ? -level : level;
  return out;
}
const silence = (seconds) => new Float32Array(Math.round(seconds * RATE));
const join = (...parts) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

// ── Every sample format a transfer might arrive in ───────────────────────────
// Same signal, written eight ways: what comes back has to be the same tape.
const SIGNAL = tone(384, 200);
const shapes = [
  { bits: 8, format: 1 }, { bits: 16, format: 1 }, { bits: 24, format: 1 }, { bits: 32, format: 1 },
  { bits: 32, format: 3 }, { bits: 64, format: 3 },
];
for (const shape of shapes) {
  const label = `${shape.bits}-bit ${shape.format === 3 ? 'float' : 'PCM'}`;
  const { samples, sampleRate } = decodeWav(wav([SIGNAL], shape));
  expect(sampleRate === RATE, `${label}: sample rate survives`);
  expect(samples.length === SIGNAL.length, `${label}: every frame is read`);
  let worst = 0;
  for (let i = 0; i < samples.length; i++) worst = Math.max(worst, Math.abs(samples[i] - SIGNAL[i]));
  // 8-bit has 256 steps to say it in; the rest are far closer than this.
  expect(worst < (shape.bits === 8 ? 0.02 : 1e-4), `${label}: the waveform is the one written (off by ${worst})`);

  const { tap, pulses } = wavToTap(wav([SIGNAL], shape));
  expect(pulses > 150, `${label}: it decodes to a tape (${pulses} pulses)`);
  expect(tap[12] === 1, `${label}: a v1 .tap`);
}

// Stereo, and the tape only on one of them — a one-sided transfer, which is how
// a lot of decks are wired.
for (const [left, right, where] of [[SIGNAL, silence(SIGNAL.length / RATE), 'left'],
  [new Float32Array(SIGNAL.length), SIGNAL, 'right']]) {
  const { samples, channel } = decodeWav(wav([left, right]));
  expect(channel === (where === 'left' ? 0 : 1), `the tape is found on the ${where} channel`);
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  expect(peak > 0.5, `and it is not read as silence (peak ${peak.toFixed(3)})`);
  expect(wavToTap(wav([left, right])).pulses > 150, `a ${where}-channel recording still becomes a tape`);
}

// ── What is not supported says so ────────────────────────────────────────────
const refuses = [
  ['a 12-bit file', () => { const b = wav([SIGNAL]); new DataView(b.buffer).setUint16(34, 12, true); return b; }, /sample size/i],
  ['no sample rate', () => { const b = wav([SIGNAL]); new DataView(b.buffer).setUint32(24, 0, true); return b; }, /sample rate/i],
  ['no channels', () => { const b = wav([SIGNAL]); new DataView(b.buffer).setUint16(22, 0, true); return b; }, /channels/i],
  ['an encoding we cannot read', () => { const b = wav([SIGNAL]); new DataView(b.buffer).setUint16(20, 2, true); return b; }, /encoding/i],
  ['something that is not a WAV', () => new Uint8Array(64), /not a wav/i],
  ['a WAV with no data chunk', () => wav([SIGNAL]).slice(0, 36), /missing its fmt or data|not a wav/i],
];
for (const [what, make, says] of refuses) {
  let err = null;
  try { decodeWav(make()); } catch (e) { err = e; }
  expect(err, `${what} is refused`);
  expect(says.test(err.message), `${what} says why — got "${err.message}"`);
}

// ── A silence longer than a .tap pulse can hold ──────────────────────────────
// v1's escape carries 24 bits, about 17 s. Wrapped, an 18-second gap between
// two sides' files would come back as one second and the tape would lose the
// rest — so it goes out as more than one pulse.
const GAP = 18;
const long = wavToTap(wav([join(tone(384, 40), silence(GAP), tone(384, 40))]));
const cyclesOf = (tap) => {
  const d = tap.subarray(20);
  let total = 0, biggest = 0;
  for (let p = 0; p < d.length;) {
    const b = d[p++];
    const c = b ? b * 8 : (d[p++] | (d[p++] << 8) | (d[p++] << 16));
    total += c;
    biggest = Math.max(biggest, c);
  }
  return { total, biggest };
};
const got = cyclesOf(long.tap);
expect(got.biggest <= 0xFFFFFF, `no pulse claims more than the format holds (${got.biggest})`);
expect(Math.abs(got.total / PAL_CPU_HZ - long.seconds) < 0.5,
  `the tape is as long as the recording (${(got.total / PAL_CPU_HZ).toFixed(2)}s vs ${long.seconds.toFixed(2)}s)`);

// ── The import path with no worker to be had ─────────────────────────────────
// There is no Worker here, so importWav has to fall back to doing it in place —
// the same answer, only slower, which is what a locked-down browser gets.
const recording = wav([join(tone(384, 60), silence(0.2), tone(688, 60))]);
const seen = [];
const done = await importWav(recording, (stage, at) => seen.push([stage, at]));
expect(done.tap && done.tap[12] === 1, 'the fallback returns a tape');
expect(typeof done.seconds === 'number' && done.seconds > 0, 'and how long the recording was');
expect(Array.isArray(done.repaired) && Array.isArray(done.damagedNames), 'and what it had to say about it');
expect(seen.length > 0, 'progress is reported even without a worker');
expect(seen.some(([s]) => s === 'reading') && seen.some(([s]) => s === 'directory'),
  `first and last pass both report — got ${[...new Set(seen.map(s => s[0]))].join(', ')}`);

// The bar only ever moves forward, and each pass has its own name.
let last = -1;
for (const [stage, at] of seen) {
  const { value, text } = importProgress(stage, at);
  expect(value >= last - 1e-9, `progress does not go backwards at "${text}" (${value} after ${last})`);
  expect(text && text !== 'Working', `"${stage}" has a line of its own`);
  last = value;
}
expect(importProgress('directory', 1).value > 0.999, 'and it ends full');

// ── The import path with a worker ────────────────────────────────────────────
// The recording is handed to the worker, not copied, so nothing is sent until the
// worker says it loaded. Before that a failure falls back to doing it in place;
// after it a failure is final. A stand-in Worker plays both parts.
class FakeWorker {
  constructor(url, opts) {
    this.url = String(url); this.opts = opts;
    this.onmessage = null; this.onerror = null;
    this.posted = []; this.terminated = false;
    FakeWorker.last = this;
  }
  postMessage(msg, transfer) { this.posted.push({ msg, transfer }); }
  terminate() { this.terminated = true; }
  say(data) { this.onmessage({ data }); }
}
globalThis.Worker = FakeWorker;
try {
  // Ready → hand-over → progress → done.
  {
    const bytes = wav([tone(384, 20)]);
    const seen = [];
    const p = importWav(bytes, (s, a) => seen.push([s, a]));
    const w = FakeWorker.last;
    expect(w.opts.type === 'module' && /wav-import-worker\.js$/.test(w.url), 'the worker is the module next door');
    expect(w.posted.length === 0, 'nothing is sent before the worker says it loaded');
    w.say({ ready: true });
    expect(w.posted.length === 1 && w.posted[0].msg.bytes === bytes && w.posted[0].transfer[0] === bytes.buffer,
      'the recording is transferred, not copied');
    w.say({ stage: 'reading', at: 0.5 });
    expect(seen.length === 1 && seen[0][0] === 'reading' && seen[0][1] === 0.5, 'progress is relayed as it comes');
    const answer = { tap: new Uint8Array([1]), seconds: 2, repaired: [], unconfirmed: [], damagedNames: [], files: 0 };
    w.say({ done: answer });
    const got = await p;
    expect(got === answer && w.terminated, 'the answer comes back as sent and the worker is let go');
  }
  // A failure after the hand-over is final: the bytes are gone.
  {
    const p = importWav(wav([tone(384, 20)]), () => {});
    const w = FakeWorker.last;
    w.say({ ready: true });
    w.say({ error: 'boom' });
    let err = null;
    try { await p; } catch (e) { err = e; }
    expect(err instanceof Error && err.message === 'boom' && w.terminated, 'an error after the transfer rejects');
  }
  {
    const p = importWav(wav([tone(384, 20)]), () => {});
    const w = FakeWorker.last;
    w.say({ ready: true });
    w.onerror(null);
    let err = null;
    try { await p; } catch (e) { err = e; }
    expect(err instanceof Error, 'a bare onerror after the transfer still rejects with an Error');
  }
  // A worker that dies before it loads is replaced by the in-place import.
  {
    const bytes = wav([join(tone(384, 60), silence(0.2), tone(688, 60))]);
    const seen = [];
    const p = importWav(bytes, (s) => seen.push(s));
    const w = FakeWorker.last;
    w.onerror({ message: 'failed to fetch module' });
    const got = await p;
    expect(got.tap && got.tap[12] === 1 && w.terminated, 'a worker that never loads is replaced by the in-place import');
    expect(seen.includes('directory'), 'which reports its own progress');
  }
} finally {
  delete globalThis.Worker;
}

expect(importProgress('no-such-stage').text === 'Working', 'an unknown stage still has something to say');

console.log('wav decode spec: OK');
