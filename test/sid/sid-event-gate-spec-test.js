// sid-event-gate-spec-test.js — locks in the per-sample event-due gate.
//
// sid-worklet.js process() used to call _applyDueEvents() once per SID cycle
// (~985k/s). In steady state the queue head is future, so each of those calls
// was a typed-array load + wrap-safe subtract that concluded "nothing due". The
// gate hoists that decision to once per audio SAMPLE: _drainRing() runs before
// the sample loop, so no event can arrive mid-loop and the head is the earliest
// pending stamp — if it is more than `count` cycles away it cannot come due
// before the next sample, and all `count` probes are provably dead work.
//
// Two ways the gate can silently break the audio, both pinned here:
//   • A head stamped in the PAST reads as a ~2^32 distance under >>> 0. Without
//     the `> 0x7FFFFFFF` term the gate stays shut and those events are dropped
//     — silently, and only under load (that IS the late-event case), which is
//     exactly when digi playback matters most.
//   • The gate's span must cover the probes, which run over currentCycle ..
//     currentCycle+count inclusive (the call after the inner loop is the +count
//     one) — hence `<= count`. A bound narrower than the probe span defers
//     events by whole samples. (`< count` alone is output-neutral: the trailing
//     probe of sample i and the leading probe of sample i+1 sit at the same
//     currentCycle, before the same sid.clock(). `<=` is kept because matching
//     the probe span exactly is what makes the gate obviously correct, and test
//     2 pins the apply CYCLE so any real deferral is caught.)
//
// So the contract is: every queued event applies EXACTLY once, in order, never
// before its stamp, and never later than the sample boundary that follows it.
// Test 4 verifies that over a dense pseudo-random stream through the real ring
// (init → _drainRing → pendingEvents → _applyDueEvents), which is also the path
// the offline renderer harness's worklet-transport renders.

import { loadSidIntoContext } from './sid-test-loader.js';

const { SIDProcessor } = loadSidIntoContext();
const RING_CAPACITY = 131072;   // mirrors sid-worklet.js / machine.js

let testNo = 0, fails = 0, current = [];
function expect(cond, msg) { if (!cond) current.push(msg); }
function ok(label) {
  testNo++;
  if (current.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else { fails++; console.log(`FAIL test ${testNo}: ${label}`); for (const m of current) console.log(`     - ${m}`); current = []; }
}

// Deterministic LCG (no Math.random — reproducible across runs/engines).
function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s; }; }

// A processor wired to a real SharedArrayBuffer ring, exactly as the worklet is
// initialised in the browser (and in the offline renderer).
function makeProc(is8580 = false) {
  const proc = new SIDProcessor();
  const shared = new SharedArrayBuffer(16 + RING_CAPACITY * 8);
  const ctrl = new Int32Array(shared, 0, 4);
  const ring = new Uint32Array(shared, 16);
  proc.port.onmessage({ data: { type: 'init', shared, is8580 } });
  const push = (cycle, reg, val) => {
    const wi = Atomics.load(ctrl, 0);
    const off = (wi & (RING_CAPACITY - 1)) * 2;
    ring[off] = cycle >>> 0;
    ring[off + 1] = ((val & 0xFF) << 8) | (reg & 0x1F);
    Atomics.store(ctrl, 0, (wi + 1) & 0x7FFFFFFF);
  };
  return { proc, push };
}
const block = proc => proc.process([], [[new Float32Array(128)]]);

// Pin the clock instead of letting the one-shot lookahead sync move it, so the
// tests below can reason about exact cycle distances. (Test 4 keeps the natural
// sync — it asserts relative timing, not absolute.)
function pinClock(proc, cycle) {
  proc._needCycleSync = false;
  proc.currentCycle = cycle >>> 0;
}

// ── 1: a head stamped in the PAST still applies (the `> 0x7FFFFFFF` term) ────
// Includes the 2^32 wrap, where the past stamp is numerically LARGER than
// currentCycle and only the wrap-safe compare gets it right.
for (const [label, start] of [['mid-range', 5_000_000], ['across the 2^32 wrap', 0xFFFFFF00]]) {
  const { proc, push } = makeProc();
  pinClock(proc, start);
  push((start - 50_000) >>> 0, 24, 0x0F);      // $D418 master volume, stamped 50k cycles ago
  block(proc);
  expect(proc.sid.filter.vol === 0x0F,
    `${label}: past-due event dropped (vol=${proc.sid.filter.vol}, expected 15)`);
  ok(`past-due head applies on the next block (${label})`);
}

// ── 2: an event at the sample boundary applies AT its stamp, not a sample late ─
// The gate opens per sample, so the failure mode is a whole-sample deferral.
// Recording the currentCycle at apply time catches it: the event must reach the
// chip on the cycle it is stamped for, never on a later one.
// Sweeps EVERY offset in the span, not just the boundary: a stamp sitting
// exactly on the sample boundary is the one alignment where a too-narrow gate
// is invisible (the next sample's first probe still lands on the stamp cycle),
// so testing only that offset would pass a gate that defers everything else.
{
  const count = Math.floor(makeProc().proc.cyclesPerSample);   // sample cycle budget
  let deferred = 0, missing = 0, firstBad = -1;
  for (let off = 0; off <= count; off++) {
    const { proc, push } = makeProc();
    pinClock(proc, 2_000_000);
    const stamp = 2_000_000 + off;
    push(stamp, 24, 0x0C);
    let at = -1;
    const realWrite = proc.sid.write.bind(proc.sid);
    proc.sid.write = (reg, val) => { if (at < 0) at = proc.currentCycle >>> 0; realWrite(reg, val); };
    block(proc);
    if (proc.sid.filter.vol !== 0x0C) { missing++; if (firstBad < 0) firstBad = off; }
    else if (at !== stamp) { deferred++; if (firstBad < 0) firstBad = off; }
  }
  expect(missing === 0, `${missing} of ${count + 1} span offsets never applied (first +${firstBad})`);
  expect(deferred === 0,
    `${deferred} of ${count + 1} span offsets applied off their stamp cycle (first +${firstBad}) — gate span narrower than the probe span`);
  ok(`events apply on their exact stamp cycle across the whole sample span (+0..+${count})`);
}

// ── 3: a far-future event must NOT be applied early ─────────────────────────
{
  const { proc, push } = makeProc();
  pinClock(proc, 3_000_000);
  push(3_000_000 + 200_000, 24, 0x09);         // ~0.2 s away, well past this block
  block(proc);
  expect(proc.sid.filter.vol === 0,
    `far-future event applied early (vol=${proc.sid.filter.vol}, expected 0)`);
  ok('far-future event stays queued (gate shut)');
}

// ── 4: dense random stream — every event applies once, in order, on time ────
// The strong check: the gate must not skip, duplicate, reorder or defer past
// the sample that contains the stamp. Runs the natural init path (one-shot
// lookahead sync included), so this is the shipping flow end to end.
for (const is8580 of [false, true]) {
  const model = is8580 ? '8580' : '6581';
  const { proc, push } = makeProc(is8580);
  const rnd = lcg(0xC64 + (is8580 ? 1 : 0));

  // Stamp events across ~0.4 s of SID time at irregular gaps (some sharing a
  // cycle, some many cycles apart) — dense enough that gate openings overlap
  // sample boundaries in every alignment.
  const events = [];
  let cy = 1_000_000;
  for (let i = 0; i < 3000; i++) {
    cy = (cy + (rnd() % 260)) >>> 0;             // 0 = same-cycle burst (digi)
    const reg = rnd() % 25, val = rnd() & 0xFF;
    events.push({ cycle: cy, reg, val });
    push(cy, reg, val);
  }

  // Record what the chip actually receives, and when.
  const applied = [];
  const realWrite = proc.sid.write.bind(proc.sid);
  proc.sid.write = (reg, val) => { applied.push({ reg, val, at: proc.currentCycle >>> 0 }); realWrite(reg, val); };

  // Run past the last stamp (plus the lookahead the init sync backs off by).
  const spanCycles = ((events[events.length - 1].cycle - 1_000_000) >>> 0) + 60_000;
  const blocks = Math.ceil(spanCycles / (proc.cyclesPerSample * 128)) + 2;
  for (let b = 0; b < blocks; b++) block(proc);

  expect(applied.length === events.length,
    `${model}: applied ${applied.length} of ${events.length} events — gate skipped or duplicated`);

  // Exact, not "within a sample": once the gate opens, the surviving per-cycle
  // probes apply each event on the very cycle it is stamped for, so any nonzero
  // lateness means the gate swallowed a probe it should have allowed.
  let offStamp = 0, wrongPayload = 0, worst = 0, firstBad = -1;
  for (let i = 0; i < Math.min(applied.length, events.length); i++) {
    const a = applied[i], e = events[i];
    if (a.reg !== e.reg || a.val !== e.val) { wrongPayload++; if (firstBad < 0) firstBad = i; continue; }
    const lateness = (a.at - e.cycle) | 0;           // stamps stay well inside int32 here
    if (lateness !== 0) {
      offStamp++;
      if (Math.abs(lateness) > Math.abs(worst)) worst = lateness;
      if (firstBad < 0) firstBad = i;
    }
  }
  expect(wrongPayload === 0, `${model}: ${wrongPayload} events applied out of order / wrong payload (first #${firstBad})`);
  expect(offStamp === 0,
    `${model}: ${offStamp} events applied off their stamp cycle (first #${firstBad}, worst ${worst} cy)`);
  ok(`${events.length} random events apply once, in order, on their exact stamp cycle (${model})`);
}

console.log(`\n${testNo} SID event-gate spec tests; ${fails} fail`);
if (fails) process.exit(1);
