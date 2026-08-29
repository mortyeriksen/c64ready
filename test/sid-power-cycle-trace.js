// sid-power-cycle-trace.js — headless test for the "noise after second
// power-on" bug. Drives the real SIDProcessor through a simulated
// power-cycle and inspects whether currentCycle / sidCtrl / pendingEvents
// are properly reset on the second 'init'.
//
// Scenario:
//   1. First 'init' with shared buffer #1 (sidCycleCounter=0).
//   2. Run ~30 seconds of simulated SID time (~30M worklet currentCycles).
//      During this, main thread is also running — emit a sparse stream of
//      $D418 writes so the ring is in a realistic state.
//   3. "Power-off" — machine destroyed. Worklet keeps running with
//      shared buffer #1 (no producer; ring quiet). Worklet's currentCycle
//      continues to advance.
//   4. Second 'init' with NEW shared buffer #2 (fresh machine, sidCycleCounter=0).
//   5. Send the WOTEF $D418 pulse pattern starting at cycle 0 on buffer #2.
//   6. Inspect: does the worklet apply these at the correct cycles? Or does
//      it treat them as "future" or apply them in bursts?

import { C64Machine } from '../src/machine.js';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const RING_CAPACITY = 131072;
const PAL_HZ = 985248;
const FS = 44100;
const CYC_PER_SAMP = PAL_HZ / FS;

import { loadSidIntoContext } from './sid-test-loader.js';
const diagLog = [];
const { SIDProcessor } = loadSidIntoContext({
  sampleRate: FS,
  // Override the AudioWorkletProcessor stub so diag messages get captured
  // into our log instead of dropped.
  AudioWorkletProcessor: class {
    constructor() {
      this.port = { onmessage: null, postMessage: (msg) => diagLog.push(msg) };
    }
  },
});

function makeShared() {
  const shared = new SharedArrayBuffer(16 + RING_CAPACITY * 8);
  return { shared, ctrl: new Int32Array(shared, 0, 4), ring: new Uint32Array(shared, 16) };
}

function queueWrite(ctrl, ring, cycle, reg, val) {
  const wi = Atomics.load(ctrl, 0);
  const off = (wi & (RING_CAPACITY - 1)) * 2;
  ring[off]     = cycle >>> 0;
  ring[off + 1] = ((val & 0xFF) << 8) | (reg & 0x1F);
  Atomics.store(ctrl, 0, (wi + 1) & 0x7FFFFFFF);
}

function runBlocks(proc, numBlocks) {
  let totalRms = 0, totalSamples = 0, minS = Infinity, maxS = -Infinity;
  for (let b = 0; b < numBlocks; b++) {
    const left = new Float32Array(128);
    proc.process([], [[left]]);
    for (let i = 0; i < 128; i++) {
      totalRms += left[i] * left[i];
      if (left[i] < minS) minS = left[i];
      if (left[i] > maxS) maxS = left[i];
    }
    totalSamples += 128;
  }
  return {
    rms: Math.sqrt(totalRms / totalSamples),
    min: minS, max: maxS, samples: totalSamples,
  };
}

// ── Step 1: First 'init' ──────────────────────────────────────────────────
console.log('━━━ FIRST POWER-ON ━━━');
const proc = new SIDProcessor();
const s1 = makeShared();
proc.port.onmessage({ data: { type: 'init', shared: s1.shared, is8580: false } });

const initMsgs1 = diagLog.filter(m => m?.type === 'diag-init');
console.log(`After first 'init': currentCycle = ${proc.currentCycle}, sidCtrl set = ${!!proc.sidCtrl}`);
if (initMsgs1.length > 0) {
  const m = initMsgs1[initMsgs1.length - 1];
  console.log(`  diag-init: cc ${m.ccBefore} → ${m.ccAfter}, wi=${m.wi}, ri=${m.ri}, is8580=${m.is8580}`);
}

// ── Step 2: Run 30 seconds of simulated SID with sparse events ────────────
// During this period, currentCycle increments toward ~30M.
console.log('\n━━━ FIRST SESSION (30 s) ━━━');
// Queue a few periodic $D418 writes per second.
for (let t = 0; t < 30; t++) {
  for (let p = 0; p < 8; p++) {
    queueWrite(s1.ctrl, s1.ring, t * PAL_HZ + p * (PAL_HZ / 8), 0x18, (p & 1) ? 0x0F : 0x00);
  }
}
const blocksFor30s = Math.ceil(30 * FS / 128);
const stats1 = runBlocks(proc, blocksFor30s);
console.log(`30s session: currentCycle=${proc.currentCycle} (~${(proc.currentCycle/PAL_HZ).toFixed(2)} s)`);
console.log(`  audio rms=${stats1.rms.toFixed(4)}, range=[${stats1.min.toFixed(3)}, ${stats1.max.toFixed(3)}]`);
console.log(`  pendingDepth=${proc.pendingEvents.length - proc.pendingEventReadIndex}`);
console.log(`  s1 wi=${Atomics.load(s1.ctrl, 0)} ri=${Atomics.load(s1.ctrl, 1)}`);

// ── Step 3: Power-off (machine destroyed, worklet keeps running) ──────────
// Simulate by simply running another block or two with no events.
console.log('\n━━━ POWER-OFF (worklet idles for 0.5 s) ━━━');
const ccBeforeOff = proc.currentCycle;
runBlocks(proc, Math.ceil(0.5 * FS / 128));
console.log(`After idle: currentCycle=${proc.currentCycle} (advanced ${proc.currentCycle - ccBeforeOff})`);

// ── Step 4: Second 'init' with fresh shared buffer ────────────────────────
console.log('\n━━━ SECOND POWER-ON ━━━');
diagLog.length = 0;
const s2 = makeShared();
const ccBefore2 = proc.currentCycle;
proc.port.onmessage({ data: { type: 'init', shared: s2.shared, is8580: false } });
const ccAfter2 = proc.currentCycle;
const initMsgs2 = diagLog.filter(m => m?.type === 'diag-init');
console.log(`After second 'init': currentCycle ${ccBefore2} → ${ccAfter2}`);
if (ccAfter2 !== 0) {
  console.log(`  ⚠ currentCycle was NOT reset to 0 — this is the bug if it leads to event misapplication.`);
}
if (initMsgs2.length > 0) {
  const m = initMsgs2[initMsgs2.length - 1];
  console.log(`  diag-init: cc ${m.ccBefore} → ${m.ccAfter}, wi=${m.wi}, ri=${m.ri}, is8580=${m.is8580}`);
}
console.log(`  proc.sidCtrl === s2.ctrl? ${(new Uint8Array(proc.sidCtrl.buffer))[0] === (new Uint8Array(s2.ctrl.buffer))[0] ? '(same buffer)' : 'check'} — pointing to NEW = ${proc.sidCtrl.buffer === s2.shared}`);
console.log(`  pendingEvents now: ${proc.pendingEvents.length}`);
console.log(`  recon1=${proc.recon1}, fadeInRemaining=${proc.fadeInRemaining}`);

// ── Step 5: Queue WOTEF-style pulse train on NEW buffer at low cycles ─────
console.log('\n━━━ NEW SESSION: queue WOTEF pulses at cycles 0..600000 ━━━');
// Reproduce WOTEF's actual pulse pattern (alternating $00 / $0F with median ~350 cy spacing).
const pulses = [];
let pulseCy = 0;
for (let i = 0; i < 1500; i++) {
  const dt = 200 + Math.round(Math.random() * 400); // 200-600 cycles
  pulseCy += dt;
  pulses.push([pulseCy, (i & 1) ? 0x00 : 0x0F]);
}
for (const [cy, v] of pulses) queueWrite(s2.ctrl, s2.ring, cy, 0x18, v);

console.log(`  queued ${pulses.length} pulses, last cy=${pulseCy} (~${(pulseCy/PAL_HZ*1000).toFixed(0)} ms)`);
console.log(`  s2 wi=${Atomics.load(s2.ctrl, 0)} ri=${Atomics.load(s2.ctrl, 1)}`);

// ── Step 6: Run blocks covering the pulse range and inspect ──────────────
const blocksForPulses = Math.ceil(pulseCy / CYC_PER_SAMP / 128) + 5;
const ccBeforeRun = proc.currentCycle;
const stats2 = runBlocks(proc, blocksForPulses);
console.log(`\nRan ${blocksForPulses} blocks of audio:`);
console.log(`  currentCycle: ${ccBeforeRun} → ${proc.currentCycle} (advanced ${proc.currentCycle - ccBeforeRun})`);
console.log(`  audio rms=${stats2.rms.toFixed(4)}, range=[${stats2.min.toFixed(3)}, ${stats2.max.toFixed(3)}]`);
console.log(`  pendingDepth final=${proc.pendingEvents.length - proc.pendingEventReadIndex}`);

// Inspect diag-period messages emitted during the new session.
const periodMsgs = diagLog.filter(m => m?.type === 'diag-period');
console.log(`\n${periodMsgs.length} diag-period messages captured during new session:`);
console.log('cy           wi      ri      applied   future   pending  oldestFutureΔ');
for (const m of periodMsgs.slice(0, 12)) {
  console.log(`${String(m.currentCycle).padStart(11)}  ${String(m.wi).padStart(6)}  ${String(m.ri).padStart(6)}  ${String(m.applied).padStart(7)}  ${String(m.future).padStart(6)}  ${String(m.pendingDepth).padStart(7)}  ${String(m['oldestFutureΔ']).padStart(13)}`);
}

console.log('\n━━━ VERDICT ━━━');
if (ccAfter2 === 0) {
  console.log('✓ currentCycle correctly reset to 0 on second init');
} else {
  console.log(`✗ currentCycle = ${ccAfter2} after second init (expected 0) — RESET FAILED`);
}
const futureRate = periodMsgs.length > 0 ? periodMsgs[0].future : 0;
if (futureRate > 100) {
  console.log(`⚠ ${futureRate} events were "future" in first second — main thread is ahead of worklet`);
}
if (proc.pendingEvents.length - proc.pendingEventReadIndex > 100) {
  console.log(`⚠ ${proc.pendingEvents.length - proc.pendingEventReadIndex} pending events at end — worklet behind`);
}
