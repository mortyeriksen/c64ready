// Spec test for mending a turbo file from a second reading (src/wav-tape.js).
//
// A turbo loader writes its file to the tape once, so there is no repeat copy to
// mend it from the way the KERNAL's files are mended. What there is, is a second
// reading: the recording can be read again with the treble lifted, and the
// block's own XOR checksum says whether that reading is right. Only a reading
// that proves itself replaces anything, and what goes back on the tape is a
// block at the tape's own two widths — not the lifted pulses, which a real
// loader would refuse.
//
// The damage modelled here is spacing loss: the roll-off a dropout puts on the
// high end, which is exactly what rounds two symbols into one. It is a one-pole
// filter rather than a moving average because an average has a null at the
// symbol rate — that destroys the signal outright, and nothing can read it back.
import { turboTape64Files } from '../src/tap-turbo-formats.js';
import { ZERO, ONE, body, turboFile, tapBytesOf, pulsesOf } from './_tape-fixtures.js';
import { tapToPcm, pcmToWav, PAL_CPU_HZ } from '../src/tap-audio.js';
import { wavToTap } from '../src/wav-tape.js';

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

const SR = 48000;

const one = turboFile('TESTPROG', 0x0801, body(4000));
const two = turboFile('SECOND', 0x4000, body(1500));

const { pcm } = tapToPcm(tapBytesOf([...one.pulses, ...two.pulses]), { version: 1, sampleRate: SR });

/** Spacing loss over a stretch of the recording: high end rolled off, level cut. */
function dropout(source, at, span, { pole, gain = 1 }) {
  const out = Float32Array.from(source);
  let y = out[at];
  for (let i = 0; i < span; i++) {
    y += pole * (out[at + i] - y);
    out[at + i] = y * gain;
  }
  return out;
}

const found = (tap, name) => turboTape64Files(pulsesOf(tap)).find(f => f.name.trim() === name);

// Where the first file's data block sits in the recording, counted in cycles the
// way the tape itself is written rather than guessed at as a fraction.
const HURT_AT = (() => {
  let cycles = 0;
  const upTo = one.pulses.length - 1 - (one.data.length + 2) * 8 / 2;   // partway into the data block
  for (let i = 0; i < upTo; i++) cycles += one.pulses[i];
  return Math.floor(cycles * SR / PAL_CPU_HZ);
})();

// ── A dropout inside the first file's data block ─────────────────────────────
const hurt = pcmToWav(dropout(pcm, HURT_AT, 2000, { pole: 0.15 }), SR);

// Read as it stands, the block does not add up — this is the damage the listing
// would strike a row through for.
const plain = wavToTap(hurt, { mend: false });
const asRead = found(plain.tap, 'TESTPROG');
expect(asRead && asRead.data, 'the damaged file is still listed');
expect(!asRead.data.checksumOk, 'its checksum fails as the tape stands');

// Read again with the lift, it does.
const mended = wavToTap(hurt);
expect(mended.mended.includes('TESTPROG'), `the file is mended, got [${mended.mended}]`);
const fixed = found(mended.tap, 'TESTPROG');
expect(fixed && fixed.data.checksumOk, 'the mended block checks out');
expect(one.data.every((b, i) => fixed.data.bytes[i] === b), 'and holds the bytes that were written');

// What went back on the tape is two clean widths — the ones this tape measures
// at, not the lifted ones, which a loader from 1986 would refuse. They land near
// rather than on the nominal figures: a width is measured off the recording, and
// a .tap holds it in steps of 8 cycles.
const widths = new Set();
for (let i = fixed.data.dataBit; i < fixed.data.endBit; i++) widths.add(pulsesOf(mended.tap)[i]);
const seen = [...widths].sort((a, b) => a - b);
expect(seen.length === 2, `the block is written at two widths, got ${seen.join(', ')}`);
expect(Math.abs(seen[0] - ZERO) <= 24 && Math.abs(seen[1] - ONE) <= 24,
  `and they are the ones the tape uses, got ${seen.join(', ')}`);

// The rest of the tape is untouched, and stays where it was.
const other = found(mended.tap, 'SECOND');
expect(other && other.data.checksumOk, 'the file after it still reads');
expect(two.data.every((b, i) => other.data.bytes[i] === b), 'with its own bytes intact');
const cycles = t => pulsesOf(t).reduce((a, b) => a + b, 0);
// Within a rounding: a .tap holds a width in steps of 8 cycles, and the block
// put back is written at exact ones where the tape's own were measured. Nothing
// like the half-second gap that would go missing if the patch overran its block.
expect(Math.abs(cycles(mended.tap) - cycles(plain.tap)) < 60000,
  `the tape is the same length either way, off by ${cycles(mended.tap) - cycles(plain.tap)}`);

// ── Damage past recovering is left alone, not claimed ────────────────────────
// Rolled off and turned down: the edges are not in the samples to be found.
const gone = pcmToWav(dropout(pcm, HURT_AT, 2000, { pole: 0.15, gain: 0.5 }), SR);
const tried = wavToTap(gone);
expect(!tried.mended.includes('TESTPROG'), 'a file that cannot be proved is not claimed as mended');
const still = found(tried.tap, 'TESTPROG');
expect(still && !still.data.checksumOk, 'and it is still marked as not adding up');

// ── A tape with nothing wrong is not touched ─────────────────────────────────
const clean = wavToTap(pcmToWav(pcm, SR));
expect(clean.mended.length === 0, 'nothing to mend on a good tape');
for (const f of [one, two]) {
  const g = found(clean.tap, f.name);
  expect(g && g.data.checksumOk && f.data.every((b, i) => g.data.bytes[i] === b),
    `${f.name} reads back whole`);
}

console.log('turbo mend spec: OK');
