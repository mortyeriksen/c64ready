// Spec test for mending a turbo file by splicing readings (src/wav-tape.js).
//
// A stereo transfer is two readings of the same tape, and damage need not fall
// in the same place on both: a burst of noise on one channel here, another on
// the other channel there. Neither reading checks out on its own, nor does any
// treatment of either — a burst is not a roll-off, so no lift undoes it, and the
// channels averaged carry both bursts. What is left is the splice: each
// reading's sound stretch, cut together at a margin from the damage, and the
// block's checksum says whether the result is the file. Nothing else has seen
// those bytes, so the mend is reported as unconfirmed.
import { turboTape64Files } from '../src/tap-turbo-formats.js';
import { ZERO, ONE, body, turboFile, tapBytesOf, pulsesOf } from './_tape-fixtures.js';
import { tapToPcm, PAL_CPU_HZ } from '../src/tap-audio.js';
import { wavToTap } from '../src/wav-tape.js';

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

const SR = 44100;

const one = turboFile('TESTPROG', 0x0801, body(4000));
const two = turboFile('SECOND', 0x4000, body(1500));

const { pcm } = tapToPcm(tapBytesOf([...one.pulses, ...two.pulses]), { version: 1, sampleRate: SR });

// Where the first file's data block sits, in samples: a fraction of the way in.
const sampleAt = (share) => {
  const dataStart = one.pulses.length - 1 - (one.data.length + 2) * 8;
  let cycles = 0;
  for (let i = 0; i < dataStart; i++) cycles += one.pulses[i];
  cycles += (one.data.length + 2) * 8 * ((ZERO + ONE) / 2) * share;
  return Math.floor(cycles * SR / PAL_CPU_HZ);
};

/** A burst of the wrong signal: full-scale, at a period that is no symbol. */
function burst(source, at, span) {
  const out = Float32Array.from(source);
  for (let i = 0; i < span; i++) out[at + i] = ((i / 19) | 0) & 1 ? 0.9 : -0.9;
  return out;
}

/** 16-bit stereo, the shape a sound card writes when digitising a deck. */
function stereoWav(left, right) {
  const n = left.length;
  const bytes = new Uint8Array(44 + n * 4);
  const dv = new DataView(bytes.buffer);
  const tag = (off, s) => { for (let i = 0; i < s.length; i++) bytes[off + i] = s.charCodeAt(i); };
  tag(0, 'RIFF'); dv.setUint32(4, 36 + n * 4, true); tag(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
  dv.setUint32(24, SR, true); dv.setUint32(28, SR * 4, true);
  dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
  tag(36, 'data'); dv.setUint32(40, n * 4, true);
  const s16 = (v) => { v = Math.max(-1, Math.min(1, v)); return v < 0 ? v * 0x8000 : v * 0x7FFF; };
  for (let i = 0; i < n; i++) {
    dv.setInt16(44 + i * 4, s16(left[i]), true);
    dv.setInt16(46 + i * 4, s16(right[i]), true);
  }
  return bytes;
}

const found = (tap, name) => turboTape64Files(pulsesOf(tap)).find(f => f.name.trim() === name);

// The left channel loses a stretch a third of the way into the block, the right
// one a stretch two thirds in.
const left = burst(pcm, sampleAt(0.33), 1500);
const right = burst(pcm, sampleAt(0.66), 1500);
const wav = stereoWav(left, right);

// No single reading has the file: each channel, and their average, fails.
for (const channel of [0, 1, 'mix', 'aligned']) {
  const alone = found(wavToTap(wav, { mend: false, channel }).tap, 'TESTPROG');
  expect(alone && alone.data && !alone.data.checksumOk, `reading ${channel} alone does not check out`);
}

// Spliced, it does — and it is the file that was written.
const mended = wavToTap(wav);
expect(mended.mended.includes('TESTPROG'), `the file is mended, got [${mended.mended}]`);
const fixed = found(mended.tap, 'TESTPROG');
expect(fixed && fixed.data.checksumOk, 'the spliced block checks out');
expect(one.data.every((b, i) => fixed.data.bytes[i] === b), 'and holds the bytes that were written');

// Nothing else has read those bytes, so the mend says so.
expect(mended.unconfirmed.includes('TESTPROG'), `a splice is reported as unconfirmed, got [${mended.unconfirmed}]`);

// The undamaged file is untouched.
const other = found(mended.tap, 'SECOND');
expect(other && other.data.checksumOk, 'the file after it still reads');
expect(two.data.every((b, i) => other.data.bytes[i] === b), 'with its own bytes intact');

console.log('turbo splice spec: OK');
