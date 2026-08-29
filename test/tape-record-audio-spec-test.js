// Spec test for hearing a SAVE as it is written (src/tape-sound.js's live path).
//
// Playback has the whole .tap to transcribe at once; a recording does not exist
// yet, so it is transcribed in slices — the pulses laid down since the last
// frame — and those slices are played back-to-back. Two things have to hold or
// the result is not the signal any more: a slice boundary must not disturb the
// waveform, and the datasette must only ever hand out whole pulses.
import { tapToPcm, PAL_CPU_HZ } from '../src/tap-audio.js';
import { Datasette } from '../src/datasette.js';
import { TapeSound } from '../src/tape-sound.js';

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

const SR = 44100;

// ── A tape transcribed in slices still sounds like the tape ─────────────────
// Slicing restarts the fractional sample cursor, so a seam may round by up to
// one sample — inaudible, and the pulse WIDTHS are what a loader reads. What a
// seam must never do is flip the wave over, which is what carrying the level
// across a slice prevents; v2 is the version that needs it, since there the
// level runs from pulse to pulse rather than resetting inside one.
const SLICE = 7;                                  // not a multiple of the pattern
const WIDTHS = [0x30, 0x42, 0x56];

const transitions = pcm => {
  let n = 0;
  for (let i = 1; i < pcm.length; i++) if (Math.sign(pcm[i]) !== Math.sign(pcm[i - 1])) n++;
  return n;
};
// Where one pulse ends and the next begins: a full-wave pulse (v0/v1) shows it
// as a fall, a half-wave pulse (v2) as any change of level.
const falls = pcm => {
  const out = [];
  for (let i = 1; i < pcm.length; i++) if (pcm[i - 1] > 0 && pcm[i] < 0) out.push(i);
  return out;
};
const boundaries = (pcm, version) => {
  if (version !== 2) return falls(pcm);
  const out = [];
  for (let i = 1; i < pcm.length; i++) if (Math.sign(pcm[i]) !== Math.sign(pcm[i - 1])) out.push(i);
  return out;
};
const joinSlices = (tap, version, thread) => {
  const parts = [];
  let level = 1;
  for (let at = 0; at < tap.length; at += SLICE) {
    const r = tapToPcm(tap.subarray(at, Math.min(at + SLICE, tap.length)),
                       { version, sampleRate: SR, ...(thread ? { startLevel: level } : {}) });
    level = r.level;
    parts.push(r.pcm);
  }
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return { pcm: out, slices: parts.length };
};

for (const version of [1, 2]) {
  const tap = new Uint8Array(300);
  for (let i = 0; i < tap.length; i++) tap[i] = WIDTHS[i % 3];

  const whole = tapToPcm(tap, { version, sampleRate: SR }).pcm;
  const { pcm: joined, slices } = joinSlices(tap, version, true);

  expect(Math.abs(joined.length - whole.length) <= slices,
    `v${version}: slicing costs at most a rounding sample per seam ` +
    `(${joined.length} vs ${whole.length} over ${slices} slices)`);
  expect(transitions(joined) === transitions(whole),
    `v${version}: the wave changes level exactly as often as it does whole ` +
    `(${transitions(joined)} vs ${transitions(whole)})`);

  // Widths are the data. Measure them back out of the reassembled audio.
  const f = boundaries(joined, version);
  const cyclesPerSample = PAL_CPU_HZ / SR;
  for (let i = 1; i < f.length; i++) {
    const got = (f[i] - f[i - 1]) * cyclesPerSample;   // one pulse, boundary to boundary
    const want = WIDTHS[i % 3] * 8;
    expect(Math.abs(got - want) <= 3 * cyclesPerSample,
      `v${version} pulse ${i}: ${got.toFixed(0)} cycles vs ${want} — the width survives the seams`);
  }
}

// Without the level carried across, v2 seams flip the wave and the transition
// count no longer matches. (v1 does not care: every pulse there is a full wave.)
{
  const tap = new Uint8Array(300);
  for (let i = 0; i < tap.length; i++) tap[i] = WIDTHS[i % 3];
  const whole = tapToPcm(tap, { version: 2, sampleRate: SR }).pcm;
  const naive = joinSlices(tap, 2, false).pcm;
  expect(transitions(naive) !== transitions(whole),
    'v2 without startLevel really does come out wrong — the thread is load-bearing');
}

// ── The live tail is whole pulses, and it is the recording ──────────────────
// The monitor reads recordedLength each frame and transcribes what appeared
// since the last one, so a slice that cut an entry in half would desync the
// rest of the tape's audio.
const t = new Datasette();
t.newBlankTape();
t.setMotor(true);
expect(t.pressKey('REC') === true, 'RECORD engages on a blank tape');

const writeWave = cycles => {
  const half = cycles >> 1;
  t.setWriteLine(1); t.clock(half);
  t.setWriteLine(0); t.clock(cycles - half);
};

const seen = [];
let sent = 0;
t.setWriteLine(0);
for (let i = 0; i <= 60; i++) {
  writeWave(WIDTHS[i % 3] * 8);
  if (i % 7 === 0) {                                   // a frame boundary
    const len = t.recordedLength;
    const slice = t.recordedSlice(sent, len);
    if (slice && slice.length) seen.push(...slice);
    sent = len;
  }
}
const rest = t.recordedSlice(sent, t.recordedLength);
if (rest) seen.push(...rest);

expect(t.recordedLength > 0, 'the session records something');
expect(seen.length === t.recordedLength,
  `the slices together are the whole recording (${seen.length} vs ${t.recordedLength})`);
const exported = Array.from(t.exportTapBytes().subarray(20));
expect(seen.every((b, i) => b === exported[i]) && seen.length === exported.length,
  'and they are the same bytes the tape exports');

// Pulse-aligned: the reassembled bytes transcribe to as many pulses as were
// written, so no slice cut an entry in half.
const { pcm } = tapToPcm(Uint8Array.from(seen), { version: 1, sampleRate: SR });
const edges = falls(pcm).length;
expect(edges >= 55, `every pulse survives as an edge pair (${edges} falls for 60 pulses)`);

// Nothing to hand out when no session is open.
const idle = new Datasette();
expect(idle.recordedLength === 0, 'an idle deck has recorded nothing');
expect(idle.recordedSlice(0, 10) === null, 'and offers no slice');

// ── Slices are queued back-to-back, and never run away ──────────────────────
// The emulator can write tape faster than real time (warp, a catch-up burst),
// and audio queued at that rate would drift minutes behind the machine.
class FakeCtx {
  constructor() { this.currentTime = 0; this.sampleRate = SR; this.started = []; this.stopped = 0; }
  createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
  createBuffer(_ch, len, sr) { return { duration: len / sr, length: len, copyToChannel() {} }; }
  createBufferSource() {
    const ctx = this;
    return { buffer: null, connect() {}, disconnect() {},
             start(t) { ctx.started.push({ at: t, dur: this.buffer.duration }); },
             stop() { ctx.stopped++; } };
  }
}

const ctx = new FakeCtx();
const sound = new TapeSound(ctx, { connect() {} });

// A deck that is recording, whose tail grows when we say so.
const written = [];
const deck = {
  hasMedia: true, motorOn: true, recording: true, atEnd: false, playPressed: true,
  tapVersion: 1, zeroGapCycles: 20000, tapData: null,
  get recordedLength() { return written.length; },
  recordedSlice(a, b) { return Uint8Array.from(written.slice(a, b)); },
};
const writePulses = n => { for (let i = 0; i < n; i++) written.push(WIDTHS[i % 3]); };

writePulses(40);
sound.update(deck);
expect(ctx.started.length === 0, 'the first frame of a session only takes the mark — no replay of what is already down');

writePulses(40);
sound.update(deck);
expect(ctx.started.length === 1, 'the next frame plays what appeared since');
expect(ctx.started[0].at > 0, 'scheduled a little ahead of the clock, not in the past');

ctx.currentTime += 0.02;
writePulses(40);
sound.update(deck);
expect(ctx.started.length === 2, 'and the frame after that');
const seam = ctx.started[0].at + ctx.started[0].dur;
expect(Math.abs(ctx.started[1].at - seam) < 1e-9,
  `slices are back-to-back with no gap (${ctx.started[1].at} vs ${seam})`);

// Now write far faster than the clock advances: the queue must stop growing.
for (let i = 0; i < 200; i++) { writePulses(40); sound.update(deck); }
const queued = ctx.started[ctx.started.length - 1].at + ctx.started[ctx.started.length - 1].dur - ctx.currentTime;
expect(queued <= 1, `the queue stays within a second of the clock (${queued.toFixed(2)}s)`);

// Falling behind re-seats rather than piling up in the past.
ctx.currentTime += 10;
writePulses(40);
sound.update(deck);
const last = ctx.started[ctx.started.length - 1];
expect(last.at >= ctx.currentTime, 'a late frame is re-seated ahead of the clock, never behind it');

// Stopping the recording takes the queued slices with it.
const before = ctx.stopped;
deck.recording = false;
deck.tapData = new Uint8Array(0);
sound.update(deck);
expect(ctx.stopped > before, 'ending the recording stops what was still queued');

// ── Playback follows the head ───────────────────────────────────────────────
// The tape is transcribed once, then played from wherever the head is: PLAY down
// with the motor on starts it at the head's position, a seek beyond the drift
// tolerance re-seats it, and PLAY up, the end of the tape or no deck at all
// stop it.
{
  class PlayCtx extends FakeCtx {
    createBufferSource() {
      const ctx = this;
      return { buffer: null, connect() {}, disconnect() {},
               start(when, off) { ctx.started.push({ at: when, off, dur: this.buffer.duration }); },
               stop() { ctx.stopped++; } };
    }
  }
  const pctx = new PlayCtx();
  const sound = new TapeSound(pctx, { connect() {} });

  sound.setVolume(2);   expect(sound.master.gain.value === 1, 'volume clamps at 1');
  sound.setVolume(-1);  expect(sound.master.gain.value === 0, 'and at 0');
  sound.setVolume(0.5); expect(sound.master.gain.value === 0.5, 'in between it is taken as is');

  // 3000 pulses of $FF (2040 cycles each) — a tape of about six seconds.
  const tape = new Uint8Array(3000).fill(0xFF);
  const deck = {
    hasMedia: true, motorOn: true, recording: false, atEnd: false, playPressed: false,
    tapVersion: 1, zeroGapCycles: 20000, tapData: tape, elapsedSeconds: 0,
  };
  sound.update(null);
  sound.update(deck);
  expect(pctx.started.length === 0, 'no deck, or PLAY up: silence');

  deck.playPressed = true;
  sound.update(deck);
  expect(pctx.started.length === 1 && pctx.started[0].off === 0, 'PLAY down: the tape plays from the head');
  const total = pctx.started[0].dur;
  expect(total > 5 && total < 7, `the whole tape is one buffer (${total.toFixed(2)}s)`);

  pctx.currentTime += 0.1; deck.elapsedSeconds = 0.1;
  sound.update(deck);
  expect(pctx.started.length === 1, 'while audio and tape agree, nothing is restarted');

  deck.elapsedSeconds = 3;                          // a seek
  sound.update(deck);
  expect(pctx.started.length === 2 && pctx.stopped === 1 && Math.abs(pctx.started[1].off - 3) < 1e-9,
    'a head that has moved out of tolerance re-seats the audio at the new position');

  deck.elapsedSeconds = 100;                        // beyond the end
  sound.update(deck);
  expect(pctx.started.length === 3 && pctx.started[2].off <= total && pctx.started[2].off > total - 0.01,
    'a position past the end is clamped to the last moment of the tape');

  deck.atEnd = true;
  sound.update(deck);
  expect(pctx.stopped === 3 && sound._src === null, 'the end of the tape stops playback');

  deck.atEnd = false; deck.tapData = new Uint8Array(0); deck.elapsedSeconds = 0;
  sound.update(deck);
  expect(pctx.started.length === 3 && sound._buffer === null, 'an empty tape builds nothing and stays silent');

  deck.tapData = new Uint8Array(500).fill(0x40);
  sound.update(deck);
  expect(pctx.started.length === 4 && sound._buffer && sound._forTape === deck.tapData, 'a new tape is transcribed afresh and plays');

  sound.dispose();
  expect(sound._src === null && sound._buffer === null && sound._forTape === null, 'dispose lets go of everything');
}

console.log('tape record audio spec: PASS');
