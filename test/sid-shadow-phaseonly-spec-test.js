// sid-shadow-phaseonly-spec-test.js — Locks in the shadow-voice phase-only
// optimization: the main-thread shadow clocks voices 1 & 2 with
// clockPhaseOnly() (phase accumulator only) and voice 3 with the full
// clock(). The C64 exposes only voice 3's readback ($D41B OSC3 / $D41C ENV3),
// and the ONLY thing v3 consumes from v1/v2 is their phase (the sync/ring-mod
// chain v3.syncSrc=v2, v2.syncSrc=v1). So v3's OSC3/ENV3 must be byte-identical
// whether v1/v2 are clocked fully or phase-only.
//
// This guards against a future edit to clock()'s phase math that isn't
// mirrored into clockPhaseOnly() (which would silently desync OSC3 readback).

import { SIDVoice, makeVoiceTrio } from '../src/sid-voice.js';

let testNo = 0, fails = 0, current = [];
function expect(cond, msg) { if (!cond) current.push(msg); }
function ok(label) {
  testNo++;
  if (current.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else { fails++; console.log(`FAIL test ${testNo}: ${label}`); for (const m of current) console.log(`     - ${m}`); current = []; }
}

// ── 1: clockPhaseOnly() reproduces the phase portion of clock() exactly ──
// Drive two sync chains (so the hard-sync branch has a real source) with the
// same control writes; the phase-only voice's phase/prevPhase must match the
// fully-clocked voice's at every cycle, including TEST (phase→0) and hard-sync.
{
  // Trio A: full clock. Trio B: phase-only on the SAME voice index.
  const A = makeVoiceTrio();
  const B = makeVoiceTrio();
  // Voice under test = index 1 (its syncSrc is index 0 → exercises hard sync).
  for (const trio of [A, B]) {
    trio[0].write(0, 0x21); trio[0].write(1, 0x11); // v0 freq
    trio[0].write(4, 0x21);                          // v0 SAW+GATE (drives sync src)
    trio[1].write(0, 0x00); trio[1].write(1, 0x30); // v1 freq
    trio[1].write(4, 0x23);                          // v1 SAW+SYNC+GATE
  }
  let diffs = 0;
  for (let cy = 0; cy < 5000; cy++) {
    // Mid-stream toggles: pulse TEST and flip sync on/off to stress branches.
    if (cy === 1500) { A[1].write(4, 0x2B); B[1].write(4, 0x2B); } // +TEST
    if (cy === 1700) { A[1].write(4, 0x23); B[1].write(4, 0x23); } // -TEST
    if (cy === 3000) { A[1].write(4, 0x21); B[1].write(4, 0x21); } // sync off
    A[0].clock(); A[1].clock();
    B[0].clockPhaseOnly(); B[1].clockPhaseOnly();
    if (A[1].phase !== B[1].phase || A[1].prevPhase !== B[1].prevPhase) diffs++;
  }
  expect(diffs === 0, `phase/prevPhase diverged on ${diffs} of 5000 cycles`);
  ok('clockPhaseOnly() reproduces clock() phase math (saw + sync + TEST)');
}

// ── 2: v3 OSC3/ENV3 byte-identical with phase-only v1/v2 (6581 & 8580) ──
// Full reference trio vs (phase-only v1/v2 + full v3), identical writes,
// exercising sync + ring-mod + noise on the chain. Compare the only two
// observable outputs every cycle.
function fuzzEquiv(is8580) {
  const A = makeVoiceTrio(); // full all three
  const B = makeVoiceTrio(); // phase-only v1/v2, full v3
  for (const v of A) v.is8580 = is8580;
  for (const v of B) v.is8580 = is8580;
  let seed = 0x9e3779b1 >>> 0;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed; };
  let mism = 0, firstMism = -1;
  for (let cy = 0; cy < 60000; cy++) {
    if ((rnd() % 1000) < 40) {
      const vi = rnd() % 3, reg = rnd() % 7, val = rnd() & 0xFF;
      A[vi].write(reg, val); B[vi].write(reg, val);
    }
    A[0].clock(); A[1].clock(); A[2].clock();
    B[0].clockPhaseOnly(); B[1].clockPhaseOnly(); B[2].clock();
    if (A[2].readOsc3() !== B[2].readOsc3() || A[2].env !== B[2].env) {
      mism++; if (firstMism < 0) firstMism = cy;
    }
  }
  return { mism, firstMism };
}
for (const is8580 of [false, true]) {
  const { mism, firstMism } = fuzzEquiv(is8580);
  expect(mism === 0, `${is8580 ? '8580' : '6581'}: ${mism} OSC3/ENV3 mismatches (first @${firstMism})`);
  ok(`v3 OSC3/ENV3 byte-identical with phase-only v1/v2 over 60k random cycles (${is8580 ? '8580' : '6581'})`);
}

console.log(`\n${testNo} phase-only shadow tests; ${fails} fail`);
if (fails > 0) process.exit(1);
