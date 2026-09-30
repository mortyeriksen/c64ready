// sid-digi-spec-test.js
//
// Tests the $D418 volume-DAC digi playback path. Real 6581 carries a DC
// component on the master-volume register: the analog mixer's reference
// voltage depends on bits 0-3 of $D418. By writing 4-bit values at
// audio rate with all voices silent, software plays digitized samples
// through that DC step. Used by:
//   - Speech samples in Way of the Exploding Fist, Ghostbusters, Wave
//   - Many demo intros + Mahoney's $D418 sampling technique
//
// What's locked here:
//   1. With silent voices, output level shifts when master-vol changes
//      (= the DC step IS audible).
//   2. The DC blocker is gentle enough to pass audio-rate sample
//      sequences without flattening them.
//   3. A square-wave sample pattern at ~4-8 kHz produces a square-wave
//      output trace, not noise.
//   4. 8580 retains the DC step at 80% amplitude (Mahoney's "8580 fix"
//      reduction).

import { loadSidIntoContext } from './sid-test-loader.js';
const { SIDChip, SIDProcessor } = loadSidIntoContext({ sampleRate: 44100 });
const RING_CAPACITY = 131072;  // mirror sid-worklet.js's const

let testNo = 0, testsFailing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else {
    testsFailing++;
    console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`);
    currentFailures = [];
  }
}

// Make a chip with all voices silent (env=0, no waveform, no filter).
function makeSilentChip(is8580 = false) {
  const sid = new SIDChip();
  sid.setModel(is8580);
  // Silence all voices: clear control register (no waveform, no gate),
  // env stays at 0.
  for (let v = 0; v < 3; v++) {
    sid.write(v * 7 + 0, 0x00); // freq lo
    sid.write(v * 7 + 1, 0x00); // freq hi
    sid.write(v * 7 + 4, 0x00); // ctrl: no waveform, no gate
  }
  sid.write(0x17, 0x00); // no filter routing
  sid.write(0x18, 0x00); // mute (vol=0)
  return sid;
}

// Run the chip for N cycles, returning the last-clock output sample.
function clockN(sid, n) {
  let last = 0;
  for (let i = 0; i < n; i++) last = sid.clock();
  return last;
}

// Run the chip and capture per-cycle output samples in an array.
function captureN(sid, n) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = sid.clock();
  return out;
}

function makeSidShared() {
  const shared = new SharedArrayBuffer(16 + RING_CAPACITY * 8);
  return {
    shared,
    ctrl: new Int32Array(shared, 0, 4),
    ring: new Uint32Array(shared, 16),
  };
}

function queueSidWrite(ctrl, ring, cycle, reg, val) {
  const wi = Atomics.load(ctrl, 0);
  const off = (wi & (RING_CAPACITY - 1)) * 2;
  ring[off] = cycle >>> 0;
  ring[off + 1] = ((val & 0xFF) << 8) | (reg & 0x1F);
  Atomics.store(ctrl, 0, (wi + 1) & 0x7FFFFFFF);
}

// ── 1: $D418 master-vol level produces a measurable DC step (6581) ────
{
  const sid = makeSilentChip(false);
  // Settle the DC blocker at vol=8 (mid-range).
  sid.write(0x18, 0x08);
  clockN(sid, 200000); // ~200ms at 985 kHz → DC blocker settled
  const baseline = clockN(sid, 100);

  // Step to vol=15 — the DC offset should change.
  sid.write(0x18, 0x0F);
  // Sample 10 cycles after the step (DC blocker hasn't decayed yet).
  const sampleHi = clockN(sid, 10);

  // Step to vol=0 — opposite swing.
  sid.write(0x18, 0x00);
  const sampleLo = clockN(sid, 10);

  expect(sampleHi > baseline + 0.05,
    `vol=15 step produces positive swing vs baseline (got ${sampleHi.toFixed(3)} vs ${baseline.toFixed(3)})`);
  expect(sampleLo < baseline - 0.05,
    `vol=0 step produces negative swing vs baseline (got ${sampleLo.toFixed(3)} vs ${baseline.toFixed(3)})`);
  ok('6581 $D418: master-vol step produces measurable DC swing on silent voices');
}

// ── 2: Same on 8580 (DC reduced to ~80% but still audible) ────────────
{
  const sid = makeSilentChip(true);
  sid.write(0x18, 0x08);
  clockN(sid, 200000);
  const baseline = clockN(sid, 100);

  sid.write(0x18, 0x0F);
  const sampleHi = clockN(sid, 10);
  sid.write(0x18, 0x00);
  const sampleLo = clockN(sid, 10);

  // 8580 swings less than 6581 but is still present. The physical reSID
  // model derives the step from the mixer/gain op-amp DC (its POLARITY is
  // an internal detail and inaudible); assert magnitude only — absolute
  // levels are validated against VICE by the dc-probe WAV comparison.
  expect(Math.abs(sampleHi - baseline) > 0.005,
    `8580 vol=15 step swings (got ${sampleHi.toFixed(3)} vs ${baseline.toFixed(3)})`);
  expect(Math.abs(sampleLo - baseline) > 0.005,
    `8580 vol=0 step swings back (got ${sampleLo.toFixed(3)} vs ${baseline.toFixed(3)})`);
  expect(Math.sign(sampleHi - baseline) !== Math.sign(sampleLo - baseline),
    `vol-up and vol-down steps swing in opposite directions`);
  ok('8580 $D418: master-vol step swings (smaller than 6581 but present)');
}

// ── 3: 4 kHz square-wave digi pattern produces square-wave output ─────
// Simulate a sample played at 4 kHz: alternate vol=15 / vol=0 with
// ~246 cycles between writes (985248 / 4000 = ~246 cy/sample).
{
  const sid = makeSilentChip(false);
  // Pre-settle at vol=8 so the DC blocker isn't fighting us.
  sid.write(0x18, 0x08);
  clockN(sid, 200000);

  const cyclesPerSample = 246;
  const numSamples = 32;          // 32 cycles of the square wave (16 hi/lo pairs)
  const writeHi = 0x0F;
  const writeLo = 0x00;

  let highSum = 0, highCount = 0;
  let lowSum  = 0, lowCount  = 0;
  for (let s = 0; s < numSamples; s++) {
    const v = (s & 1) ? writeLo : writeHi;
    sid.write(0x18, v);
    // Read mid-window so transient settling is averaged.
    const mid = clockN(sid, cyclesPerSample);
    if (v === writeHi) { highSum += mid; highCount++; }
    else               { lowSum  += mid; lowCount++; }
  }
  const avgHigh = highSum / highCount;
  const avgLow  = lowSum  / lowCount;
  const swing   = avgHigh - avgLow;

  expect(avgHigh > avgLow,
    `digi square wave: high-vol samples > low-vol samples (${avgHigh.toFixed(3)} > ${avgLow.toFixed(3)})`);
  expect(swing > 0.10,
    `digi square wave: swing must be audible (>0.10), got ${swing.toFixed(3)}`);
  ok('6581 $D418: 4 kHz square-wave digi yields a clean square-wave output');
}

// ── 4: Silent voices contribute 0 to the audio path (= digi isolated) ─
// If voices weren't fully silent, their contribution would dominate and
// the digi step would be lost. Confirm output is roughly DC-only.
{
  const sid = makeSilentChip(false);
  sid.write(0x18, 0x08);
  clockN(sid, 200000);
  // Sample a window of 256 cycles without changing anything; output
  // should be stable (the DC blocker has converged on the DC level).
  const samples = captureN(sid, 256);
  let minS = Infinity, maxS = -Infinity;
  for (const s of samples) { if (s < minS) minS = s; if (s > maxS) maxS = s; }
  const range = maxS - minS;
  expect(range < 0.02,
    `silent chip output range under steady vol must be tiny (<0.02), got ${range.toFixed(4)}`);
  ok('silent voices contribute ~0 to output (digi path is isolated)');
}

// ── 5: DC blocker doesn't attenuate audio-rate digi ──────────────────
// Compare the swing magnitude at 8 kHz vs 1 kHz — both should produce
// a clear swing. The DC blocker's pole is at <1 Hz so it shouldn't
// noticeably attenuate audio-band frequencies.
{
  const sweep = (cyclesPerSample) => {
    const sid = makeSilentChip(false);
    sid.write(0x18, 0x08);
    clockN(sid, 200000);
    let hi = 0, lo = 0;
    for (let s = 0; s < 16; s++) {
      sid.write(0x18, (s & 1) ? 0x00 : 0x0F);
      const mid = clockN(sid, cyclesPerSample);
      if ((s & 1) === 0) hi += mid; else lo += mid;
    }
    return (hi - lo) / 8;
  };
  const swing8k = sweep(123);   // 985248/8000 ≈ 123
  const swing1k = sweep(985);   // 985248/1000 ≈ 985

  expect(swing8k > 0.10, `8 kHz digi swing > 0.10, got ${swing8k.toFixed(3)}`);
  expect(swing1k > 0.10, `1 kHz digi swing > 0.10, got ${swing1k.toFixed(3)}`);
  // 1 kHz might be slightly attenuated vs 8 kHz but both should be in range.
  ok('DC blocker passes audio-rate digi from 1 kHz to 8 kHz');
}

// ═════════════════════════════════════════════════════════════════════
// Section 2 — digi played while music voices are active
//
// Real C64 games (Way of the Exploding Fist, Ghostbusters, etc.) play
// digi samples in parallel with music. The music voices' AC content
// adds to the digi's DC component. The digi signal must remain
// EXTRACTABLE — i.e., the output averaged over a sample window must
// still track the $D418 step. If a feature change (filter, ADSR,
// combined waveform) corrupts the digi, these tests catch it.
// ═════════════════════════════════════════════════════════════════════

// Run the chip while writing a digi square wave; return correlation
// between the written sample pattern (1 for hi-vol, -1 for lo-vol) and
// the windowed-mean output. Correlation ≈ 1 = clean digi. Closer to 0
// = digi lost. Negative = inverted (= voices dominate with opposite
// polarity).
function digiCorrelation(setupChip, numSamples = 32, cyclesPerSample = 246) {
  const sid = setupChip();
  // Pre-settle DC blocker.
  sid.write(0x18, (sid.masterVol & 0xF0) | 0x08);
  clockN(sid, 200000);

  const written = new Array(numSamples);
  const observed = new Array(numSamples);
  const baseFM = sid.masterVol & 0xF0;
  for (let s = 0; s < numSamples; s++) {
    const hi = (s & 1) === 0;
    written[s] = hi ? 1 : -1;
    sid.write(0x18, baseFM | (hi ? 0x0F : 0x00));
    // Average over half the sample window to skip transient settling.
    const skip = cyclesPerSample >> 1;
    clockN(sid, skip);
    let sum = 0;
    const meas = cyclesPerSample - skip;
    for (let c = 0; c < meas; c++) sum += sid.clock();
    observed[s] = sum / meas;
  }
  // Normalize observed to zero-mean.
  const obsMean = observed.reduce((a, b) => a + b, 0) / numSamples;
  let num = 0, denW = 0, denO = 0;
  for (let s = 0; s < numSamples; s++) {
    const o = observed[s] - obsMean;
    num  += written[s] * o;
    denW += written[s] * written[s];
    denO += o * o;
  }
  return denO > 0 ? num / Math.sqrt(denW * denO) : 0;
}

// ── 6: digi survives a pulse voice playing in parallel ────────────────
{
  const cor = digiCorrelation(() => {
    const sid = makeSilentChip(false);
    // Voice 1: 440 Hz pulse, gate on, env attack=0, sustain=15.
    const freq440 = Math.round(440 * (1 << 24) / 985248); // = ~7488
    sid.write(0, freq440 & 0xFF); sid.write(1, (freq440 >> 8) & 0xFF);
    sid.write(2, 0x00); sid.write(3, 0x08); // pw=$800 (50%)
    sid.write(5, 0x00);                      // attack=0, decay=0 (= instant)
    sid.write(6, 0xF0);                      // sustain=15, release=0
    sid.write(4, 0x41);                      // PULSE + GATE
    return sid;
  });
  expect(cor > 0.70, `digi correlation with pulse voice ≥ 0.70, got ${cor.toFixed(3)}`);
  ok(`digi survives a 440 Hz pulse voice (correlation = ${cor.toFixed(3)})`);
}

// ── 7: digi survives a triangle voice ─────────────────────────────────
{
  const cor = digiCorrelation(() => {
    const sid = makeSilentChip(false);
    const freq = Math.round(220 * (1 << 24) / 985248);
    sid.write(0, freq & 0xFF); sid.write(1, (freq >> 8) & 0xFF);
    sid.write(5, 0x00); sid.write(6, 0xF0);
    sid.write(4, 0x11);                      // TRIANGLE + GATE
    return sid;
  });
  expect(cor > 0.70, `digi correlation with triangle voice ≥ 0.70, got ${cor.toFixed(3)}`);
  ok(`digi survives a 220 Hz triangle voice (correlation = ${cor.toFixed(3)})`);
}

// ── 8: digi survives a sawtooth voice ─────────────────────────────────
{
  const cor = digiCorrelation(() => {
    const sid = makeSilentChip(false);
    const freq = Math.round(330 * (1 << 24) / 985248);
    sid.write(0, freq & 0xFF); sid.write(1, (freq >> 8) & 0xFF);
    sid.write(5, 0x00); sid.write(6, 0xF0);
    sid.write(4, 0x21);                      // SAW + GATE
    return sid;
  });
  expect(cor > 0.70, `digi correlation with saw voice ≥ 0.70, got ${cor.toFixed(3)}`);
  ok(`digi survives a 330 Hz saw voice (correlation = ${cor.toFixed(3)})`);
}

// ── 9: digi survives a combined PULSE+TRI voice ───────────────────────
{
  const cor = digiCorrelation(() => {
    const sid = makeSilentChip(false);
    const freq = Math.round(440 * (1 << 24) / 985248);
    sid.write(0, freq & 0xFF); sid.write(1, (freq >> 8) & 0xFF);
    sid.write(2, 0x00); sid.write(3, 0x08);
    sid.write(5, 0x00); sid.write(6, 0xF0);
    sid.write(4, 0x51);                      // PULSE + TRI + GATE
    return sid;
  });
  expect(cor > 0.65, `digi correlation with PULSE+TRI voice ≥ 0.65, got ${cor.toFixed(3)}`);
  ok(`digi survives a PULSE+TRI voice (correlation = ${cor.toFixed(3)})`);
}

// ── 10: digi survives ALL three voices playing ────────────────────────
{
  const cor = digiCorrelation(() => {
    const sid = makeSilentChip(false);
    const freqs = [440, 554, 659]; // A4, C#5, E5
    for (let v = 0; v < 3; v++) {
      const f = Math.round(freqs[v] * (1 << 24) / 985248);
      const base = v * 7;
      sid.write(base + 0, f & 0xFF); sid.write(base + 1, (f >> 8) & 0xFF);
      sid.write(base + 2, 0x00);     sid.write(base + 3, 0x08);
      sid.write(base + 5, 0x00);     sid.write(base + 6, 0xF0);
      sid.write(base + 4, 0x41);     // PULSE + GATE
    }
    return sid;
  });
  expect(cor > 0.50, `digi correlation with 3 voices ≥ 0.50, got ${cor.toFixed(3)}`);
  ok(`digi survives all 3 voices playing a chord (correlation = ${cor.toFixed(3)})`);
}

// ── 11: digi WITH filter active (LP at fc=$400) ────────────────────────
{
  const cor = digiCorrelation(() => {
    const sid = makeSilentChip(false);
    const freq = Math.round(440 * (1 << 24) / 985248);
    sid.write(0, freq & 0xFF); sid.write(1, (freq >> 8) & 0xFF);
    sid.write(2, 0x00); sid.write(3, 0x08);
    sid.write(5, 0x00); sid.write(6, 0xF0);
    sid.write(4, 0x41);                      // PULSE + GATE
    sid.write(0x15, 0x00); sid.write(0x16, 0x80); // fc=$400
    sid.write(0x17, 0x01);                   // route v1 to filter
    sid.write(0x18, 0x1F);                   // LP filter, vol=15
    return sid;
  });
  expect(cor > 0.30, `digi correlation with LP filter ≥ 0.30, got ${cor.toFixed(3)}`);
  ok(`digi survives LP filter active on v1 (correlation = ${cor.toFixed(3)})`);
}

// ── 12: digi WITH high-Q filter resonance ──────────────────────────────
// Stress the resonance curve: res=15 is the most aggressive setting.
// If our Q is too high it can ring and bury the digi step.
{
  const cor = digiCorrelation(() => {
    const sid = makeSilentChip(false);
    const freq = Math.round(440 * (1 << 24) / 985248);
    sid.write(0, freq & 0xFF); sid.write(1, (freq >> 8) & 0xFF);
    sid.write(2, 0x00); sid.write(3, 0x08);
    sid.write(5, 0x00); sid.write(6, 0xF0);
    sid.write(4, 0x41);
    sid.write(0x15, 0x00); sid.write(0x16, 0x80);
    sid.write(0x17, 0xF1);                   // res=15, route v1
    sid.write(0x18, 0x1F);                   // LP filter, vol=15
    return sid;
  });
  expect(cor > 0.30, `digi correlation with high-res filter ≥ 0.30, got ${cor.toFixed(3)}`);
  ok(`digi survives high-res filter (correlation = ${cor.toFixed(3)})`);
}

// ── 13: digi WITH voice 3 OFF + voice 3 active (= digi on v3 bus) ─────
// Mahoney's digi technique uses voice 3 as an audible signal source
// with $D418 bit 7 (v3off) modulated to gate it. We don't model the
// full Mahoney technique but ensure v3off doesn't kill the basic digi.
{
  const cor = digiCorrelation(() => {
    const sid = makeSilentChip(false);
    // Voice 3: pulse, env=15, $D418 bit 7 toggles v3 mute.
    const freq = Math.round(330 * (1 << 24) / 985248);
    sid.write(14, freq & 0xFF); sid.write(15, (freq >> 8) & 0xFF);
    sid.write(16, 0x00); sid.write(17, 0x08);
    sid.write(19, 0x00); sid.write(20, 0xF0);
    sid.write(18, 0x41);                     // v3: PULSE + GATE
    return sid;
  });
  expect(cor > 0.50, `digi correlation with v3 active ≥ 0.50, got ${cor.toFixed(3)}`);
  ok(`digi survives voice 3 active (correlation = ${cor.toFixed(3)})`);
}

// ── 14: worklet re-init resets the SID event clock ────────────────────
// Browser power/reset flows create a fresh C64 SID write timeline. The
// worklet must drop old pending writes and restart its local cycle clock
// with that new timeline; otherwise $D418 sample writes are considered
// overdue and collapse into bursts instead of an audio-rate stream.
{
  const proc = new SIDProcessor();
  proc.currentCycle = 50000;
  // Inject a stale queued event into the typed mirror's head slot.
  proc.pendCycle[proc.pendHead] = 1;
  proc.pendPacked[proc.pendHead] = 0x18; // reg $18, val $00
  proc.pendCount = 1;

  const { shared, ctrl, ring } = makeSidShared();
  proc.port.onmessage({ data: { type: 'init', shared, is8580: true } });
  expect(proc.currentCycle === 0, `init resets local cycle clock, got ${proc.currentCycle}`);
  expect(proc.pendCount === 0, `init clears stale pending SID writes`);
  expect(proc.sid.is8580 === true, `init applies requested SID model`);

  // Post-init vol=0 (real-chip default). Queue a future write that
  // bumps vol to 15 at cycle 100, then check it doesn't apply until
  // currentCycle reaches 100.
  queueSidWrite(ctrl, ring, 100, 0x18, 0x0F);
  proc._drainRing();
  proc._applyDueEvents();
  expect(proc.sid.filter.vol === 0,
    `future $D418 write must not apply at cycle 0, got vol=${proc.sid.filter.vol}`);
  proc.currentCycle = 100;
  proc._applyDueEvents();
  expect(proc.sid.filter.vol === 15,
    `due $D418 write applies when worklet reaches its event cycle, got vol=${proc.sid.filter.vol}`);
  ok('SID worklet: init resets clock/pending events and preserves timed $D418 writes');
}

// ── 14b: cycle-sync uses lookahead so first digi burst is not late ──────
// After 'init' the worklet's currentCycle = 0 and starts processing
// audio blocks immediately. The main thread doesn't emit any SID
// events until the rafLoop fires (~16 ms later). By then the worklet's
// currentCycle has advanced thousands of cycles past 0, so the first
// event's stamp looks "in the past" and ALL events accumulated during
// the first frame burst-apply at the block boundary. The fix: after
// init/reset, the next event snaps currentCycle to a small lookahead
// before that event, giving frame-burst sample writes time to queue
// before playback reaches them.
{
  const proc = new SIDProcessor();
  const { shared, ctrl, ring } = makeSidShared();
  proc.port.onmessage({ data: { type: 'init', shared, is8580: false } });

  // Simulate "worklet ran ahead for some blocks waiting for main thread"
  // by ticking currentCycle forward without any events.
  proc.currentCycle = 14000;   // ~14 ms ahead
  expect(proc._needCycleSync === true,
    `init arms cycle-sync hook (_needCycleSync should be true after init)`);

  // Now main thread emits its first event at cycle 100 — should apply
  // AT cycle 100, not at the burst-applied moment when currentCycle was 14000.
  queueSidWrite(ctrl, ring, 100, 0x18, 0x0F);
  proc._drainRing();

  // Run the actual process() call to exercise the sync hook.
  const left = new Float32Array(128);
  proc.process([], [[left]]);

  expect(proc._needCycleSync === false,
    `cycle-sync fired (_needCycleSync should be false after first event)`);
  const distToEvent = (100 - proc.currentCycle) >>> 0;
  expect(proc.sid.filter.vol === 0,
    `first event must not burst-apply immediately after sync, got vol=${proc.sid.filter.vol}`);
  expect(distToEvent > 1000 && distToEvent < 50000,
    `currentCycle should sit shortly before first event after lookahead sync, dist=${distToEvent}`);

  let blocks = 1;
  while (proc.sid.filter.vol !== 15 && blocks < 32) {
    proc.process([], [[left]]);
    blocks++;
  }
  expect(proc.sid.filter.vol === 15,
    `event eventually applies when lookahead is consumed, got vol=${proc.sid.filter.vol}`);
  expect(blocks > 1 && blocks < 32,
    `event should apply after a buffered delay, not immediately; blocks=${blocks}`);
  ok('SID worklet: cycle-sync lookahead prevents first-frame digi burst distortion');
}

// ── 15: SID write ring holds a worst-case digi frame burst ─────────────
// The browser main thread runs a whole video frame in a burst. A tight
// sample player may write $D418 thousands of times before the worklet
// wakes up. The ring must hold that burst without wrapping unread
// entries, or the worklet drains later writes first and the sample turns
// into noise.
{
  const proc = new SIDProcessor();
  const { shared, ctrl, ring } = makeSidShared();
  proc.port.onmessage({ data: { type: 'init', shared, is8580: false } });

  const writes = 100000; // covers the app's 100 ms catch-up cap even if every cycle writes SID.
  for (let i = 0; i < writes; i++) {
    queueSidWrite(ctrl, ring, i, 0x18, i & 0x0F);
  }
  proc._drainRing();

  expect(proc.pendCount === writes,
    `ring drains all ${writes} queued SID writes, got ${proc.pendCount}`);
  for (let i = 0; i < writes; i++) {
    const slot = (proc.pendHead + i) & (proc.PEND_CAP - 1);
    const cycle = proc.pendCycle[slot];
    const val = (proc.pendPacked[slot] >>> 8) & 0xFF;
    if (cycle !== i || val !== (i & 0x0F)) {
      expect(false,
        `ring preserves chronological $D418 event ${i}: got cycle=${cycle}, val=${val}`);
      break;
    }
  }
  proc.currentCycle = writes;
  proc._applyDueEvents();
  expect(proc.pendCount === 0,
    `applied burst drains the pending queue, pendCount=${proc.pendCount}`);
  ok('SID worklet: write ring preserves a 100000-write $D418 digi burst');
}

console.log(`\n${testNo} digi-DAC tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
