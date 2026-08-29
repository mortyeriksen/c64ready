// sid-outputstage-skip-equiv-spec-test.js — locks in the outputStage() split.
//
// SIDVoice.outputStage() computes TWO independent products from the same
// state: (a) the audio DAC sample (its return value) and (b) the OSC3 read
// pipeline (oscLatch / _oscLive / _triSawPipe, exposed via readOsc3()/env3),
// around shared per-cycle feedback (_outputPre: waveform latch + 6581 SAW
// pulldown; _outputPost: combined-noise writeback + pulse-rail latch). Each
// production consumer needs only one product and calls a lean variant that
// skips the other's dead work (same idiom as the shadow's clockPhaseOnly()):
//   - the audio worklet's 3 voices call outputStageAudio() (OSC3 read skipped);
//   - the main-thread shadow v3 calls outputStageOsc3() (audio sample skipped).
// The lean variants MUST stay byte-identical to the full outputStage() on the
// product they keep, or the split silently changes music / demo behavior.
//
// Each test drives IDENTICAL pseudo-random control/waveform writes into a FULL
// trio (outputStage) and a LEAN trio (over the sync/ring chain, both models):
//   1. outputStageAudio() → the audio sample stays byte-identical to full, AND
//      the OSC3 pipeline is genuinely skipped (_oscLive never advances while
//      full's does — proving the lean method really omits it).
//   2. outputStageOsc3() → OSC3/ENV3/env stay byte-identical to full.
// Pattern mirrors sid-shadow-phaseonly-spec-test.js.

import { makeVoiceTrio, computeSyncPulses } from '../src/sid-voice.js';

let testNo = 0, fails = 0, current = [];
function expect(cond, msg) { if (!cond) current.push(msg); }
function ok(label) {
  testNo++;
  if (current.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else { fails++; console.log(`FAIL test ${testNo}: ${label}`); for (const m of current) console.log(`     - ${m}`); current = []; }
}

// Deterministic LCG (no Math.random — reproducible across runs/engines).
function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s; }; }

// One SID cycle for a trio: reSID ordering (decide sync from pre-clock state,
// clock all cores, then output via `out(voice)`). Returns the 3 return values.
function clockTrio(t, out) {
  computeSyncPulses(t[0], t[1], t[2]);
  t[0].clockCore(); t[1].clockCore(); t[2].clockCore();
  return [out(t[0]), out(t[1]), out(t[2])];
}
const OUT_FULL = v => v.outputStage();
const OUT_AUDIO = v => v.outputStageAudio();
const OUT_OSC3 = v => { v.outputStageOsc3(); return 0; };

const CYCLES = 60000;

// ── 1: outputStageAudio() ≡ outputStage() on the audio sample ─────────────
for (const is8580 of [false, true]) {
  const model = is8580 ? '8580' : '6581';
  const A = makeVoiceTrio(), B = makeVoiceTrio();   // A = full, B = worklet (audio-only)
  for (const t of [A, B]) for (const v of t) v.is8580 = is8580;
  const rnd = lcg(0x1234 + (is8580 ? 1 : 0));
  let audioMism = 0, firstMism = -1, oscSkipProven = false, sawActive = false;
  for (let cy = 0; cy < CYCLES; cy++) {
    if ((rnd() & 7) === 0) {                          // ~1/8 cycles: a register write
      const vi = rnd() % 3, reg = rnd() % 7, val = rnd() & 0xFF;
      A[vi].write(reg, val); B[vi].write(reg, val);
    }
    const sa = clockTrio(A, OUT_FULL), sb = clockTrio(B, OUT_AUDIO);
    for (let vi = 0; vi < 3; vi++) if (sa[vi] !== sb[vi]) { audioMism++; if (firstMism < 0) firstMism = cy; }
    // outputStageAudio genuinely omits the OSC3 read iff full advanced _oscLive
    // while the audio-only trio left it at its init (0).
    if (A[2]._oscLive !== 0) { sawActive = true; if (B[2]._oscLive === 0) oscSkipProven = true; }
  }
  expect(audioMism === 0, `${model}: ${audioMism} audio-sample mismatches (first @cy ${firstMism}) — outputStageAudio diverged from outputStage`);
  expect(sawActive && oscSkipProven,
    `${model}: OSC3 read genuinely skipped by outputStageAudio (full _oscLive moved: ${sawActive}; audio-only _oscLive stayed 0: ${oscSkipProven})`);
  ok(`outputStageAudio() audio sample byte-identical to full over ${CYCLES} cycles (${model})`);
}

// ── 2: outputStageOsc3() ≡ outputStage() on OSC3 / ENV3 / env ─────────────
for (const is8580 of [false, true]) {
  const model = is8580 ? '8580' : '6581';
  const A = makeVoiceTrio(), B = makeVoiceTrio();   // A = full, B = shadow (osc3-only)
  for (const t of [A, B]) for (const v of t) v.is8580 = is8580;
  const rnd = lcg(0x9abc + (is8580 ? 1 : 0));
  let oscMism = 0, firstMism = -1;
  for (let cy = 0; cy < CYCLES; cy++) {
    if ((rnd() & 7) === 0) {
      const vi = rnd() % 3, reg = rnd() % 7, val = rnd() & 0xFF;
      A[vi].write(reg, val); B[vi].write(reg, val);
    }
    clockTrio(A, OUT_FULL); clockTrio(B, OUT_OSC3);
    for (let vi = 0; vi < 3; vi++) {
      if (A[vi].readOsc3() !== B[vi].readOsc3() || A[vi].env3 !== B[vi].env3 || A[vi].env !== B[vi].env) {
        oscMism++; if (firstMism < 0) firstMism = cy;
      }
    }
  }
  expect(oscMism === 0, `${model}: ${oscMism} OSC3/ENV3/env mismatches (first @cy ${firstMism}) — outputStageOsc3 diverged from outputStage`);
  ok(`outputStageOsc3() OSC3/ENV3/env byte-identical to full over ${CYCLES} cycles (${model})`);
}

console.log(`\n${testNo} outputStage split-equivalence spec tests; ${fails} fail`);
if (fails) process.exit(1);
