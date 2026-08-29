// SID combined-waveform regression tests.
//
// These points are small black-box OSC3 samples captured from headless VICE
// x64sc reSID. They pin the 8580 pulse-combo retune without embedding GPL
// lookup tables.

import { COMBINED_6581, COMBINED_8580 } from '../src/sid-voice.js';

let tests = 0;
let failures = 0;

function expectEqual(actual, expected, msg) {
  tests++;
  if (actual !== expected) {
    failures++;
    console.log(`FAIL - ${msg}: expected ${expected}, got ${actual}`);
  }
}

const SAMPLES_8580 = {
  PT: [
    [0x0fc, 0], [0x3ba, 96], [0x6e8, 192],
    [0xa1e, 160], [0xd06, 0], [0xf03, 0],
  ],
  PS: [
    [0x380, 0], [0x3d0, 0], [0x700, 0],
    [0xada, 128], [0xcff, 207], [0xf28, 224],
  ],
  PST: [
    [0x7fe, 127], [0xbab, 0], [0xe5e, 128],
    [0xeb0, 128], [0xf00, 192], [0xf50, 192],
  ],
};

const SAMPLES_6581 = {
  ST: [
    [0xfe1, 56], [0xff0, 60], [0xffc, 127],
  ],
  PT: [
    [0x4ff, 159], [0x5b5, 128], [0x677, 192],
    [0x782, 0], [0x87d, 0], [0x984, 192],
  ],
};

for (const [combo, samples] of Object.entries(SAMPLES_6581)) {
  for (const [idx, expected] of samples) {
    const actual = (COMBINED_6581[combo][idx] >> 4) & 0xFF;
    expectEqual(actual, expected, `6581 ${combo} OSC3 byte at index $${idx.toString(16).padStart(3, '0')}`);
  }
}

for (const [combo, samples] of Object.entries(SAMPLES_8580)) {
  for (const [idx, expected] of samples) {
    const actual = (COMBINED_8580[combo][idx] >> 4) & 0xFF;
    expectEqual(actual, expected, `8580 ${combo} OSC3 byte at index $${idx.toString(16).padStart(3, '0')}`);
  }
}

if (failures === 0) {
  console.log(`ok - SID combined-waveform: ${tests} captured 6581/8580 OSC3 samples match`);
} else {
  console.log(`FAIL - SID combined-waveform: ${failures}/${tests} captured samples differ`);
  process.exit(1);
}
