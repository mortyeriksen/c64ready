// test/frame-rate-guard-spec-test.js
//
// Locks the decision the attract demo makes about the GPU it is running on
// (src/frame-rate-guard.js). Judge too harshly and a perfectly good machine
// loses the demo; too leniently and the machines that prompted the guard keep
// dropping frames.
//
// The guard exists because static heuristics can't see this: the report that
// prompted it came from a desktop Core i7 — plenty of cores and memory, fine
// pointer, a real GPU — whose integrated graphics simply couldn't keep up.

import { frameRateVerdict, GUARD } from '../src/frame-rate-guard.js';

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

// n frames of `ms`, with the warm-up frames prepended (any value; they're dropped).
const run = (ms, n) => [...Array(GUARD.WARMUP).fill(999), ...Array(n).fill(ms)];

// ── Not enough frames yet ───────────────────────────────────────────────────

assert(frameRateVerdict([]) === 'wait', 'no frames yet is not a verdict');
assert(frameRateVerdict(run(16.7, GUARD.EARLY - 1)) === 'wait',
  'the early checkpoint needs its full sample');
assert(frameRateVerdict(run(16.7, GUARD.EARLY)) === 'wait',
  'a healthy machine is not cleared early — it must survive the full run');
assert(frameRateVerdict(run(16.7, GUARD.SAMPLES - 1)) === 'wait',
  'between the checkpoints there is no verdict');

// ── Machines that pass ──────────────────────────────────────────────────────

assert(frameRateVerdict(run(16.7, GUARD.SAMPLES)) === 'ok', '60fps passes');
assert(frameRateVerdict(run(8.3, GUARD.SAMPLES)) === 'ok', '120fps passes');
assert(frameRateVerdict(run(GUARD.MS, GUARD.SAMPLES)) === 'ok',
  'exactly at the threshold passes — the limit is what we give up ABOVE');
assert(frameRateVerdict(run(16.7, GUARD.SAMPLES * 3)) === 'ok',
  'a long run is judged the same way');

// A 120Hz panel rendering a comfortable 60fps must not read as "missing every
// other frame" — the reason the threshold is absolute, not relative.
const highRefresh = [...Array(GUARD.WARMUP).fill(8.3),
                     ...Array(GUARD.SAMPLES).fill(16.7)];
assert(frameRateVerdict(highRefresh) === 'ok',
  '60fps on a 120Hz display is fine, not a dropped-frame pattern');

// ── Machines that fail ──────────────────────────────────────────────────────

assert(frameRateVerdict(run(GUARD.MS_EARLY + 1, GUARD.EARLY)) === 'slow',
  'a hopeless machine is called at the early checkpoint, not made to wait');
assert(frameRateVerdict(run(40, GUARD.SAMPLES)) === 'slow', '25fps gives up');
assert(frameRateVerdict(run(GUARD.MS + 0.1, GUARD.SAMPLES)) === 'slow',
  'just over the threshold gives up');

// A uniformly mediocre machine still fails at the full checkpoint even though it
// cleared the early one — the early gate is a shortcut, never an acquittal.
const mediocre = run(40, GUARD.EARLY);
assert(frameRateVerdict(mediocre) === 'wait', '25fps survives the early gate');
assert(frameRateVerdict(run(40, GUARD.SAMPLES)) === 'slow', '…and fails the full one');

// ── The median is what makes it usable ──────────────────────────────────────

// One catastrophic hitch (a background tab, a GC pause) among good frames.
const hitch = run(16.7, GUARD.SAMPLES);
hitch[GUARD.WARMUP + 3] = 900;
assert(frameRateVerdict(hitch) === 'ok',
  'a single 900ms stall does not condemn an otherwise healthy machine');

// …but half the frames being bad does.
const halfBad = run(16.7, GUARD.SAMPLES);
for (let i = 0; i < GUARD.SAMPLES / 2 + 1; i++) halfBad[GUARD.WARMUP + i] = 80;
assert(frameRateVerdict(halfBad) === 'slow',
  'sustained bad frames are not smoothed away by the median');

// The warm-up really is discarded: shader compile and first paint are slow on
// every machine, healthy ones included.
const slowStart = [...Array(GUARD.WARMUP).fill(400), ...Array(GUARD.SAMPLES).fill(16.7)];
assert(frameRateVerdict(slowStart) === 'ok',
  'a slow first few frames is startup cost, not a verdict');

console.log('frame-rate-guard spec: OK');
