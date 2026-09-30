// SID engine switch (Options ▸ Sound): reSID WASM ↔ reSID JS.
//
// Both engines are the same reSID model — 'wasm' renders inside the compiled
// Rust module, 'resid' in JS. The processor keeps a $D400-$D418 register-file
// shadow so a live switch replays the program state into whichever side takes
// over; the JS chip is always the standing fallback while (or in case) the
// module is not ready. Bit-identity of the two is locked by
// sid-wasm-engine-spec-test.js; this file covers the selection mechanics.

import { loadSidIntoContext } from './sid-test-loader.js';

const { SIDChip, SIDProcessor } = loadSidIntoContext({ sampleRate: 44100 });

let tests = 0;
let failures = 0;
const expect = (cond, msg) => {
  tests++;
  if (!cond) { failures++; console.log(`FAIL - ${msg}`); }
};

const TONE = [
  [0x18, 0x1F],                 // vol 15 + LP
  [0x15, 0x00], [0x16, 0x80],   // fc = $400
  [0x17, 0x51],                 // res 5, route v1
  [0x00, 0x45], [0x01, 0x1D],   // ~440 Hz
  [0x05, 0x00], [0x06, 0xF0],
  [0x04, 0x21],                 // SAW + gate
];

const acRms = (chip, n) => {
  let sum = 0, sq = 0;
  for (let i = 0; i < n; i++) { const s = chip.clock(); sum += s; sq += s * s; }
  const mean = sum / n;
  return Math.sqrt(sq / n - mean * mean);
};

// 1: the JS chip produces audible, sane output from a plain register set.
{
  const chip = new SIDChip(false);
  for (const [r, v] of TONE) chip.write(r, v);
  for (let i = 0; i < 30000; i++) chip.clock();
  const rms = acRms(chip, 60000);
  expect(rms > 0.005 && rms < 0.7, `reSID JS chip audible/sane (rms ${rms.toFixed(4)})`);
  expect(chip.filter.fc === 0x400 && chip.filter.res === 5 &&
         chip.filter.filt === 1 && chip.filter.vol === 15,
    `filter/volume registers land in the reSID chain (fc=$${chip.filter.fc.toString(16)}, res=${chip.filter.res}, filt=${chip.filter.filt}, vol=${chip.filter.vol})`);
}

// 2: the processor honors the engine named in 'init' — and knows only two.
{
  const shared = () => new SharedArrayBuffer(16 + 131072 * 8);
  const a = new SIDProcessor();
  a.port.onmessage({ data: { type: 'init', shared: shared(), is8580: false, engine: 'resid' } });
  expect(a.engineSel === 'resid', `init selects reSID JS`);
  const b = new SIDProcessor();
  b.port.onmessage({ data: { type: 'init', shared: shared(), is8580: false, engine: 'wasm' } });
  expect(b.engineSel === 'wasm', `init selects reSID WASM`);
  const c = new SIDProcessor();
  c.port.onmessage({ data: { type: 'init', shared: shared(), is8580: false, engine: 'legacy' } });
  expect(c.engineSel === 'resid', `an unknown engine name (a removed one) falls back to reSID JS`);
}

// 3: a live switch back to reSID JS replays the register shadow into the JS
// chip, and the selection survives a soft reset.
{
  const proc = new SIDProcessor();
  proc.port.onmessage({ data: { type: 'init', shared: new SharedArrayBuffer(16 + 131072 * 8), is8580: false, engine: 'wasm' } });
  for (const [r, v] of TONE) proc.regShadow[r] = v;
  proc.port.onmessage({ data: { type: 'engine', engine: 'resid' } });
  expect(proc.engineSel === 'resid', `live engine message switches to reSID JS`);
  expect(proc.sid.filter.fc === 0x400 && proc.sid.filter.res === 5 &&
         proc.sid.filter.filt === 1 && proc.sid.filter.vol === 15,
    `register shadow replayed into the JS chip (fc=$${proc.sid.filter.fc.toString(16)}, res=${proc.sid.filter.res}, filt=${proc.sid.filter.filt}, vol=${proc.sid.filter.vol})`);
  expect(proc.sid.v1.ctrl === 0x21, `voice registers replayed too (v1 ctrl=$${proc.sid.v1.ctrl.toString(16)})`);
  proc.port.onmessage({ data: { type: 'reset', is8580: false } });
  expect(proc.engineSel === 'resid', `engine selection survives a soft reset`);
}

if (failures === 0) {
  console.log(`ok - SID engine switch: ${tests} checks (reSID WASM ↔ reSID JS)`);
} else {
  console.log(`FAIL - SID engine switch: ${failures}/${tests} checks failed`);
  process.exit(1);
}
