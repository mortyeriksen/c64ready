// Spec test for turning a .tap back into audio (src/tap-audio.js).
//
// The point of this conversion is that it is the real signal: a C64 tape stores
// data in the WIDTH of its pulses, so a recording only loads again if those
// widths survive. These assertions measure the widths back out of the waveform
// and check they land within one audio sample of what went in — far inside the
// margin a loader uses to tell a short pulse from a long one.
import { tapToPcm, pcmToWav, PAL_CPU_HZ } from '../src/tap-audio.js';

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

const SR = 44100;
const cyclesPerSample = PAL_CPU_HZ / SR;

// Pulse starts are falling edges, so fall-to-fall is exactly one pulse.
function pulseWidths(pcm) {
  const falls = [];
  for (let i = 1; i < pcm.length; i++) if (pcm[i - 1] > 0 && pcm[i] < 0) falls.push(i);
  const out = [];
  for (let i = 1; i < falls.length; i++) out.push((falls[i] - falls[i - 1]) * cyclesPerSample);
  return out;
}

// ── Widths survive the round trip ────────────────────────────────────────────
// The three pulse lengths a C64 loader distinguishes, interleaved.
const WIDTHS = [0x30, 0x42, 0x56];               // *8 = 384, 528, 688 cycles
const tap = [];
for (let i = 0; i < 150; i++) for (const w of WIDTHS) tap.push(w);
const { pcm, seconds, truncated } = tapToPcm(new Uint8Array(tap), { version: 1, sampleRate: SR });

expect(!truncated, 'a short tape is not truncated');
expect(pcm.length > 0, 'something was produced');
const totalCycles = tap.reduce((a, b) => a + b * 8, 0);
expect(Math.abs(seconds - totalCycles / PAL_CPU_HZ) < 0.01,
  `duration matches the tape's own length (${seconds.toFixed(3)}s vs ${(totalCycles / PAL_CPU_HZ).toFixed(3)}s)`);

const got = pulseWidths(pcm);
expect(got.length > 400, `every pulse produced an edge pair, got ${got.length}`);
for (let i = 0; i < got.length; i++) {
  const want = WIDTHS[(i + 1) % 3] * 8;          // first fall starts pulse 2
  expect(Math.abs(got[i] - want) <= cyclesPerSample + 1,
    `pulse ${i}: ${got[i].toFixed(0)} cycles vs ${want} — within one sample`);
}
// The three lengths must stay distinguishable, which is the whole game.
const rounded = [...new Set(got.map((c) => Math.round(c / 100)))].sort();
expect(rounded.length === 3, `three distinct pulse classes survive, saw ${rounded.length}`);

// ── The level really is a square wave ────────────────────────────────────────
expect(pcm.every((v) => v === 1 || v === -1), 'every sample sits at one rail or the other');

// ── v2 pulses are half waves ─────────────────────────────────────────────────
// Same byte stream read as v2 covers twice the time per full cycle, so the tape
// runs the same length but each pulse toggles instead of making a whole wave.
const v2 = tapToPcm(new Uint8Array(tap), { version: 2, sampleRate: SR });
expect(Math.abs(v2.seconds - seconds) < 0.01, 'v2 spans the same tape time');
const v2w = pulseWidths(v2.pcm);
expect(v2w.length > 0 && v2w[0] > got[0], 'a v2 full cycle spans two pulses, so it is longer');

// ── v0 uses its fixed gap for a zero byte ────────────────────────────────────
const gap = 20000;
const v0 = tapToPcm(new Uint8Array([0x30, 0, 0x30]), { version: 0, zeroGapCycles: gap, sampleRate: SR });
const v0cycles = 0x30 * 8 * 2 + gap;
expect(Math.abs(v0.seconds - v0cycles / PAL_CPU_HZ) < 0.01, 'a v0 zero byte spends the fixed gap');

// ── Overlong tapes are capped, not allowed to eat memory ─────────────────────
const long = new Uint8Array(200000).fill(0xFF);
const capped = tapToPcm(long, { version: 1, sampleRate: SR, maxSeconds: 1 });
expect(capped.truncated, 'a tape past the cap reports truncation');
expect(capped.pcm.length === SR, 'and stops at exactly the cap');

// ── WAV container ────────────────────────────────────────────────────────────
const wav = pcmToWav(pcm, SR);
const str = (o, n) => String.fromCharCode(...wav.slice(o, o + n));
const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
expect(str(0, 4) === 'RIFF' && str(8, 4) === 'WAVE', 'it is a RIFF/WAVE file');
expect(dv.getUint32(4, true) === wav.length - 8, 'the RIFF size covers the rest of the file');
expect(dv.getUint16(20, true) === 1 && dv.getUint16(22, true) === 1, 'mono PCM');
expect(dv.getUint32(24, true) === SR, 'sample rate is carried');
expect(dv.getUint16(34, true) === 16, '16 bits per sample');
expect(dv.getUint32(40, true) === pcm.length * 2, 'the data chunk holds every sample');
expect(wav.length === 44 + pcm.length * 2, 'and the file is exactly header plus data');
// Full scale, so a deck driving a real C64 has the level to work with.
expect(dv.getInt16(44, true) < -30000, 'samples reach the rails');

console.log('tap-audio spec: PASS');
