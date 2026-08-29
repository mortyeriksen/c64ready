// A recording reads the same whatever rate it was digitised at.
//
// The detector judges level and centre over a window, and the lift takes a
// difference over a step; both are set in time, not samples, so a tape at 96 kHz
// is looked at over the same few milliseconds as one at 44.1. Asserted here the
// plain way: the same tape rendered at four rates lists the same files, sound.
import { tapToPcm, pcmToWav } from '../src/tap-audio.js';
import { wavToTap } from '../src/wav-tape.js';
import { tapDirectory } from '../src/tap-directory.js';
import { body, turboFile, tapBytesOf } from './_tape-fixtures.js';

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

const tape = tapBytesOf([...turboFile('FIRST', 0x0801, body(2000)).pulses,
  ...turboFile('SECOND', 0x4000, body(800)).pulses]);

for (const rate of [22050, 44100, 48000, 96000]) {
  const { pcm } = tapToPcm(tape, { version: 1, sampleRate: rate });
  const read = wavToTap(pcmToWav(pcm, rate));
  expect(read.sampleRate === rate, `the rate is read from the file (${read.sampleRate})`);
  const files = tapDirectory(read.tap.subarray(20), { version: read.tap[12] });
  const names = files.map(f => f.name.trim()).join(',');
  expect(names === 'FIRST,SECOND', `at ${rate} Hz both files are listed, got [${names}]`);
  expect(files.every(f => !f.damaged), `at ${rate} Hz both files are sound`);
  expect(read.mended.length === 0, `at ${rate} Hz nothing needed mending`);
}

console.log('wav tape rates spec: OK');
