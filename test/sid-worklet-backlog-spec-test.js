// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// SID worklet event-backlog bound.
//
// The worklet's event clock is driven by rendered SAMPLES — real time, at the
// audio device's rate. The producer's stamps come from the main loop, which runs
// its whole frame backlog after a stall instead of dropping it (so pitch and
// speed stay correct). A stalled tick therefore hands the worklet a burst of
// future-stamped events that can only be played back at 1×, and the gap that
// opens does NOT close again once both sides are back at real-time rate: every
// stall leaves its own duration of audio lateness behind, permanently.
//
// The 0.5 s desync snap cannot see this: it measures the distance to the OLDEST
// pending event, which a steadily draining queue keeps at ~0 however deep the
// queue is. The lateness lives in the TAIL. Left unbounded it reached seconds in
// a long screen recording (heavy encoder load → many small stalls).
//
// Verified here for every engine, since the transport is shared: a stall storm
// leaves lateness bounded, an ordinary catch-up burst does NOT trigger a
// correction, and register state written inside a collapsed span survives.
import { loadSidIntoContext } from './sid-test-loader.js';

const RATE = 44100;
const CLOCK = 985248;
const CPS = CLOCK / RATE;
const BLOCK = 128;
const CYCLES_PER_BLOCK = BLOCK * CPS;
const FRAME_CY = 19656;                     // PAL frame
const MAX_BACKLOG_CYCLES = 147787;          // mirrors src/sid-worklet.js
const LOOKAHEAD_S = 24576 / CLOCK;          // the intended steady-state lateness

const ctx = loadSidIntoContext({ sampleRate: RATE });

let tests = 0;
let failures = 0;
const expect = (cond, msg) => {
  tests++;
  if (!cond) { failures++; console.log(`FAIL - ${msg}`); }
};

async function makeRig(engine, { neuter = false } = {}) {
  const proc = new ctx.SIDProcessor();
  const shared = new SharedArrayBuffer(16 + 131072 * 8);
  const ctrl = new Int32Array(shared, 0, 4);
  const ring = new Uint32Array(shared, 16);
  proc.port.onmessage({ data: { type: 'init', shared, is8580: false, engine } });
  if (engine === 'wasm') await proc.wasmReady;
  proc._needCycleSync = false;
  proc.currentCycle = 0;
  proc.fadeInRemaining = 0;
  // Neutered guard = the pre-fix worklet, so the canary below proves the bound
  // is what holds the lateness down (and not some incidental drain).
  if (neuter) proc._fastForwardBacklog = () => {};

  const left = new Float32Array(BLOCK);
  let machineCycle = 0;
  let budget = 0;
  const rig = {
    proc,
    blocks: 0,
    push(c, r, v) {
      const wi = Atomics.load(ctrl, 0);
      const off = (wi & (131072 - 1)) * 2;
      ring[off] = c >>> 0;
      ring[off + 1] = ((v & 0xFF) << 8) | (r & 0x1F);
      Atomics.store(ctrl, 0, (wi + 1) & 0x7FFFFFFF);
    },
    get machineCycle() { return machineCycle; },
    // Emit whole PAL frames. The real producer writes a frame's worth of
    // registers in ONE burst and then goes quiet for ~20 ms — seven audio
    // blocks — so anything that keys off "writes arrived this block" has to be
    // exercised against this cadence, not a steady per-block trickle.
    produce(cycles) {
      budget += cycles;
      while (budget >= FRAME_CY) {
        budget -= FRAME_CY;
        const frameStart = machineCycle;
        for (let i = 1; i <= 24; i++) {                 // one frame's writes
          rig.push(frameStart + i * (FRAME_CY / 25), 0x01, 0x20 + (i % 3));
        }
        machineCycle = frameStart + FRAME_CY;
      }
    },
    render(n) {
      const out = [];
      for (let b = 0; b < n; b++) {
        proc.process([], [[left]]);
        for (let i = 0; i < BLOCK; i++) out.push(left[i]);
        rig.blocks++;
      }
      return out;
    },
    lag() { return ((machineCycle - proc.currentCycle) | 0) / CLOCK; },
    // Trough of the lag across `seconds` of ordinary running — the burst-free
    // reading, and the one that says whether the clock is drifting ahead.
    lagTrough(seconds) {
      let min = Infinity;
      for (let i = 0; i < Math.round(seconds * RATE / BLOCK); i++) {
        rig.produce(CYCLES_PER_BLOCK);
        rig.render(1);
        min = Math.min(min, rig.lag());
      }
      return min;
    },
  };

  // A loud sustained sawtooth so "went quiet" is unambiguous.
  rig.push(10, 0x18, 0x0F);
  rig.push(20, 0x05, 0x00);
  rig.push(30, 0x06, 0xF0);
  rig.push(40, 0x00, 0x00);
  rig.push(50, 0x01, 0x20);
  rig.push(60, 0x04, 0x11);
  return rig;
}

const lockstep = (rig, seconds) => {
  for (let i = 0; i < Math.round(seconds * RATE / BLOCK); i++) {
    rig.produce(CYCLES_PER_BLOCK);
    rig.render(1);
  }
};

// Ten 200 ms stalls: the main thread was blocked, then ran the backlog.
const stallStorm = (rig, n = 10) => {
  for (let s = 0; s < n; s++) {
    rig.produce(Math.round(0.2 * CLOCK));
    rig.render(1);
  }
};

// 1: a stall storm leaves lateness bounded, on every engine.
for (const engine of ['wasm', 'resid']) {
  const rig = await makeRig(engine);
  lockstep(rig, 0.3);
  stallStorm(rig);
  lockstep(rig, 0.3);
  const lag = rig.lag();
  expect(lag < MAX_BACKLOG_CYCLES / CLOCK + LOOKAHEAD_S,
    `${engine}: lateness bounded after a stall storm (${lag.toFixed(3)}s, ceiling ${(MAX_BACKLOG_CYCLES / CLOCK).toFixed(2)}s)`);
  expect(rig.proc.diagBacklogFF > 0,
    `${engine}: the backlog bound actually fired (${rig.proc.diagBacklogFF} corrections)`);
  expect(rig.proc.diagOverrun === 0, `${engine}: no ring overruns (${rig.proc.diagOverrun})`);
}

// 2: canary — with the bound removed, the same storm buries the audio clock
// seconds behind and nothing recovers it. Guards against a future "cleanup"
// dropping the check because the head-distance snap looks like it covers this.
{
  const rig = await makeRig('resid', { neuter: true });
  lockstep(rig, 0.3);
  stallStorm(rig);
  const lagAfterStalls = rig.lag();
  lockstep(rig, 0.5);
  const lagAfterCalm = rig.lag();
  expect(lagAfterStalls > 1.5,
    `unbounded: stall storm buries the clock (${lagAfterStalls.toFixed(3)}s)`);
  expect(lagAfterCalm >= lagAfterStalls - 0.05,
    `unbounded: calm running does not recover it (${lagAfterCalm.toFixed(3)}s)`);
  expect(rig.proc.diagBacklogFF === 0, 'unbounded: no corrections counted');
}

// 3: the worst LEGITIMATE transient must not trigger a correction. The main
// loop's delta cap is 100 ms, so one stalled tick can hand over that much at
// once; with the ~25 ms event lookahead on top, the ceiling has to clear ~125 ms
// or ordinary load would chop the audio. (Several such bursts in a row DO stack
// past the ceiling and get corrected — that is the accumulation being caught,
// not a false positive: nothing drains a gap once it exists.)
for (const engine of ['wasm', 'resid']) {
  const rig = await makeRig(engine);
  lockstep(rig, 0.2);
  rig.produce(Math.round(0.1 * CLOCK));   // one capped catch-up tick
  rig.render(1);
  lockstep(rig, 0.2);
  expect(rig.proc.diagBacklogFF === 0,
    `${engine}: one 100 ms catch-up tick does not trip the bound (${rig.proc.diagBacklogFF} fired)`);

  // Ordinary ticks — one or two PAL frames of events each — never trip it.
  const before = rig.proc.diagBacklogFF;
  for (let i = 0; i < 40; i++) {
    rig.produce(19656 * (i % 2 ? 2 : 1));
    rig.render(Math.round((i % 2 ? 2 : 1) * 19656 / CYCLES_PER_BLOCK));
  }
  expect(rig.proc.diagBacklogFF === before,
    `${engine}: ordinary 1-2 frame ticks never trip the bound (${rig.proc.diagBacklogFF - before} fired)`);
}

// 4: register state written inside a collapsed span survives the fast-forward —
// the writes are folded into the shadow and replayed, so a volume-off issued
// during the skipped audio still takes effect.
for (const engine of ['wasm', 'resid']) {
  const rig = await makeRig(engine);
  lockstep(rig, 0.3);
  // Bury a volume-off deep inside a burst the bound will collapse.
  rig.produce(Math.round(0.4 * CLOCK));
  rig.push(rig.machineCycle + 1, 0x18, 0x00);
  rig.produce(Math.round(0.4 * CLOCK));
  rig.render(1);
  const tail = [];
  for (let i = 0; i < Math.round(0.4 * RATE / BLOCK); i++) {
    rig.produce(CYCLES_PER_BLOCK);
    for (const v of rig.render(1)) tail.push(v);
  }
  let quiet = 0, quietAt = null;
  for (let i = 0; i < tail.length; i++) {
    if (Math.abs(tail[i]) < 0.002) {
      if (++quiet >= 400) { quietAt = (i - 399) / RATE; break; }
    } else quiet = 0;
  }
  expect(quietAt !== null && quietAt < 0.30,
    `${engine}: volume-off inside the collapsed span still lands (${quietAt === null ? 'never' : quietAt.toFixed(3) + 's'})`);
}

// 5: a queue several frames deep is BUFFERING, not lateness, and must be left
// alone. The main thread computes a whole frame of SID writes before that audio
// plays, so the producer's newest stamp legitimately leads the audio clock; the
// events still apply exactly on their stamps. Real sessions sit 3-9 frames deep
// for minutes with zero lateness while the two clocks match to 0.4%.
//
// This is the invariant an earlier continuous "drift correction" broke: it
// triggered on how far the producer led, mistook that depth for lateness, and
// reclaimed it by skipping SID cycles — ~3% of the timeline during ordinary
// play. Only RUNAWAY may be corrected, which is what the ceiling is for.
for (const engine of ['wasm', 'resid']) {
  const rig = await makeRig(engine);
  lockstep(rig, 0.2);
  rig.produce(Math.round(0.1 * CLOCK));      // one capped catch-up tick: sub-ceiling
  rig.render(1);
  const opened = rig.lag();
  lockstep(rig, 2.0);
  const after = rig.lag();
  expect(opened > 0.09, `${engine}: a sub-ceiling lead opened (${(opened * 1000).toFixed(0)}ms)`);
  expect(rig.proc.diagBacklogFF === 0,
    `${engine}: the ceiling leaves a sub-ceiling lead alone (${rig.proc.diagBacklogFF} fired)`);
  expect(after > 0.07,
    `${engine}: the lead simply persists, uncorrected (${(after * 1000).toFixed(0)}ms)`);
  // diagLate counts events applied >2 ms after their stamp. The wasm path hands
  // events to the module rather than applying them here, so it cannot report
  // this — assert it where it is actually measured.
  if (engine !== 'wasm') {
    expect(rig.proc.diagLate === 0,
      `${engine}: nothing is applied late while the lead persists (${rig.proc.diagLate})`);
  }
}

// 6: a PRE-QUEUED batch is not lateness and must survive intact. Depth alone
// cannot tell the two apart — what marks real lateness is the producer still
// writing while we are over the ceiling. Here everything arrives up front and
// nothing follows, so the queue must be played out on its exact stamps.
// (test/sid-event-gate-spec-test.js locks the stamp-exactness itself.)
for (const engine of ['wasm', 'resid']) {
  const rig = await makeRig(engine);
  rig.produce(Math.round(1.0 * CLOCK));     // one second of events, all at once
  for (let i = 0; i < Math.round(0.5 * RATE / BLOCK); i++) rig.render(1);
  expect(rig.proc.diagBacklogFF === 0,
    `${engine}: a pre-queued batch is not collapsed (${rig.proc.diagBacklogFF} fired)`);
  expect(rig.proc.pendCount > 0,
    `${engine}: the batch's future events are still queued (${rig.proc.pendCount} left)`);
}

// 7: the OPPOSITE direction — the machine frozen while the audio thread keeps
// rendering, which is what SAVE STATE does while its naming dialog is open. The
// worklet's clock ends up AHEAD of the producer, so arriving events are already
// past due and apply in a burst at block boundaries: harmless for sustained
// music, audible as garbled digi, where a $D418 stream collapses onto those
// boundaries. The drift trim cannot help — it only reclaims lateness, and audio
// already played cannot be un-rendered — so 'resync' is the only cure.
for (const engine of ['wasm', 'resid']) {
  const rig = await makeRig(engine);
  lockstep(rig, 0.3);
  // Machine frozen: render on, produce nothing (0.25 s — under the 0.5 s snap,
  // so nothing self-corrects).
  rig.render(Math.round(0.25 * RATE / BLOCK));
  const aheadBy = -rig.lag();
  expect(aheadBy > 0.2,
    `${engine}: a frozen machine leaves the clock ahead (${(aheadBy * 1000).toFixed(0)}ms)`);

  // Resume without a resync: the offset is permanent.
  lockstep(rig, 0.5);
  expect(-rig.lag() > 0.2,
    `${engine}: and it does NOT self-correct (${(-rig.lag() * 1000).toFixed(0)}ms still ahead)`);

  // Resume WITH one: the next event snaps the clock back into alignment.
  rig.proc.port.onmessage({ data: { type: 'resync' } });
  lockstep(rig, 0.2);
  // Realigned means back at the intended lookahead — behind the producer, not
  // ahead of it — within one frame of the rig's burst granularity.
  expect(Math.abs(rig.lag() - LOOKAHEAD_S) < 0.025,
    `${engine}: resync realigns it to the lookahead (${(rig.lag() * 1000).toFixed(1)}ms, target ${(LOOKAHEAD_S * 1000).toFixed(0)}ms)`);
}

// 8: what 'resync' COSTS, and therefore where it may be posted from.
//
// resync re-arms the one-shot cycle sync, which snaps currentCycle to the OLDEST
// pending event minus the lookahead. With a queue several frames deep that moves
// the audio clock BACKWARDS by the queue depth — it does not realign, it adds
// exactly that much audio-behind-picture lag. It is the right cure after a freeze
// (where the clock ran on with nothing to play) and actively harmful anywhere
// else: posting it from a per-keypress path injected lag continuously while a
// game was played, and never in a demo, because a demo takes no input.
for (const engine of ['wasm', 'resid']) {
  const rig = await makeRig(engine);
  lockstep(rig, 0.2);
  rig.produce(Math.round(0.1 * CLOCK));        // a few frames of queue
  rig.render(1);
  const before = rig.lag();
  rig.proc.port.onmessage({ data: { type: 'resync' } });
  rig.render(1);                               // the snap lands on the next event
  const after = rig.lag();
  expect(after > before + 0.02,
    `${engine}: resync on a deep queue moves the clock BACK by the depth `
    + `(${(before * 1000).toFixed(0)}ms → ${(after * 1000).toFixed(0)}ms)`);
}

console.log(`\n${tests - failures}/${tests} passed`);
if (failures) process.exit(1);
