// SID measured wave-table integrity checks.
//
// src/sid-wavetables.js is GENERATED from the pinned reSID wave sample data
// (the wave*.dat files of the src/resid tree in the official VICE 3.10
// source release; upstream pin in NOTICE.txt). These checks pin the decoded
// tables to that upstream content via FNV-1a checksums computed at
// extraction time, plus structural invariants, so a regeneration mistake or
// base64-decoder regression cannot slip through silently.

import { WAVETABLES_6581, WAVETABLES_8580 } from '../src/sid-wavetables.js';

let tests = 0;
let failures = 0;

function expect(cond, msg) {
  tests++;
  if (!cond) {
    failures++;
    console.log(`FAIL - ${msg}`);
  }
}

// FNV-1a over the 8-bit samples, as printed by extract-wavetables.mjs.
const FNV = {
  ST_6581: 0x46ca5671, PT_6581: 0x256cb2c9, PS_6581: 0xf09a7bac, PST_6581: 0x1095e781,
  ST_8580: 0x37bb756c, PT_8580: 0x3b00c0bd, PS_8580: 0x59ec3a89, PST_8580: 0xb9a2fbcb,
};

function fnv1a8(table) { // over the 8-bit OSC3 samples (entries >> 4)
  let h = 0x811c9dc5;
  for (let i = 0; i < table.length; i++) {
    h ^= (table[i] >> 4) & 0xFF;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

for (const [model, tabs] of [['6581', WAVETABLES_6581], ['8580', WAVETABLES_8580]]) {
  for (const combo of ['ST', 'PT', 'PS', 'PST']) {
    const t = tabs[combo];
    expect(t instanceof Uint16Array && t.length === 4096, `${model} ${combo}: Uint16Array[4096]`);
    let lowBits = 0, over = 0;
    for (let i = 0; i < 4096; i++) {
      lowBits |= t[i] & 0xF;
      if (t[i] > 0xFF0) over++;
    }
    expect(lowBits === 0, `${model} ${combo}: low 4 DAC bits grounded (sample << 4 layout)`);
    expect(over === 0, `${model} ${combo}: all entries ≤ $FF0`);
    const h = fnv1a8(t);
    expect(h === FNV[`${combo}_${model}`],
      `${model} ${combo}: fnv1a matches upstream .dat (got 0x${h.toString(16).padStart(8, '0')})`);
  }
}

if (failures === 0) {
  console.log(`ok - SID wavetables: ${tests} integrity checks on 8 measured reSID tables`);
} else {
  console.log(`FAIL - SID wavetables: ${failures}/${tests} checks failed`);
  process.exit(1);
}
