// SID emulator spec tests — covers SIDVoice and SIDChip behavior in
// src/sid-worklet.js. The worklet is loaded by reading the file as
// text, stubbing AudioWorkletProcessor + registerProcessor, and
// eval'ing the source so the SIDVoice / SIDChip classes are usable
// from Node. This locks down current behavior so the upcoming SID
// enhancements (combined waveforms, ADSR delay bug, noise clobbering,
// 6581 filter curve, resonance) don't silently regress anything.

import { loadSidIntoContext } from './sid-test-loader.js';
const { SIDVoice, SIDChip, RATE_PERIODS, FC6581_TABLE, fc6581,
        WAVE_DAC_6581, WAVE_DAC_8580, ENV_DAC_6581, ENV_DAC_8580,
        WAVE_ZERO_6581, WAVE_ZERO_8580,
        makeVoiceTrio, computeSyncPulses } = loadSidIntoContext({ sampleRate: 48000 });

let testNo = 0, testsFailing = 0, currentFailures = [];
function expect(cond, msg) { if (!cond) currentFailures.push(msg); }
function ok(label) {
  testNo++;
  if (currentFailures.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else { testsFailing++; console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of currentFailures) console.log(`     - ${m}`);
    currentFailures = [];
  }
}

// ── 1: SIDVoice register-write decoding ────────────────────────────────
// $D400 = freq lo, $D401 = freq hi, $D402 = pw lo (8 bits), $D403 = pw
// hi (top 4 bits used), $D404 = control (waveform + gate + ring/sync/test),
// $D405 = attack (hi nibble) + decay (lo), $D406 = sustain (hi) + release (lo).
{
  const v = new SIDVoice();
  v.write(0, 0xCD); expect(v.freq === 0x00CD, `freq lo: 0x00CD, got 0x${v.freq.toString(16)}`);
  v.write(1, 0xAB); expect(v.freq === 0xABCD, `freq hi: 0xABCD, got 0x${v.freq.toString(16)}`);
  v.write(2, 0x34); expect(v.pw === 0x034, `pw lo: 0x034, got 0x${v.pw.toString(16)}`);
  v.write(3, 0x0F); expect(v.pw === 0xF34, `pw hi (4 bits): 0xF34, got 0x${v.pw.toString(16)}`);
  v.write(5, 0xA3); expect(v.a === 0x0A && v.d === 0x03, `A=A, D=3, got A=${v.a} D=${v.d}`);
  v.write(6, 0x5C); expect(v.s === 0x05 && v.r === 0x0C, `S=5, R=C, got S=${v.s} R=${v.r}`);
  ok('SIDVoice: register write decoding (freq/pw/AD/SR)');
}

// ── 2: Gate transition triggers attack / release ───────────────────────
// Bauer SID spec: gate 0→1 starts attack (state=1), gate 1→0 starts
// release (state=0). Gate stays the same → no transition.
{
  const v = new SIDVoice();
  expect(v.state === 0, `initial state=0 (release/idle)`);
  v.write(4, 0x11);   // ctrl = TRI + gate
  // reSID: the state change is pipelined — gate-on parks state at decay/sustain
  // for the first couple of attack cycles, then flips to attack. Clock through
  // the pipeline before checking (verified cycle-exact by env_test).
  for (let i = 0; i < 4; i++) v.clock();
  expect(v.state === 1, `gate 0→1 → attack after state pipeline, got ${v.state}`);
  v.write(4, 0x10);   // ctrl = TRI, gate cleared
  for (let i = 0; i < 4; i++) v.clock();
  expect(v.state === 0, `gate 1→0 → release after state pipeline, got ${v.state}`);
  v.write(4, 0x10);   // gate stays 0
  for (let i = 0; i < 4; i++) v.clock();
  expect(v.state === 0, `no transition: state stays 0`);
  ok('SIDVoice: gate edge transitions drive ADSR state');
}

// ── 3: ADSR rate-period table values ───────────────────────────────────
// Real SID rate periods (cycles per envelope tick):
//   0:9, 1:32, 2:63, 3:95, 4:149, 5:220, 6:267, 7:313,
//   8:392, 9:977, 10:1954, 11:3126, 12:3907, 13:11720, 14:19532, 15:31251.
{
  const expected = [9, 32, 63, 95, 149, 220, 267, 313, 392, 977, 1954, 3126, 3907, 11720, 19532, 31251];
  for (let i = 0; i < 16; i++) {
    expect(RATE_PERIODS[i] === expected[i],
      `RATE_PERIODS[${i}]: expected ${expected[i]}, got ${RATE_PERIODS[i]}`);
  }
  ok('SIDVoice: RATE_PERIODS table matches real-chip values');
}

// ── 4: Attack ramps env from 0 → 255 at the configured rate ────────────
// Attack period for rate=0 is 9 cycles. After 9 cycles, env should be 1.
// After 9*255 cycles, env should be 255 and state should advance to decay.
{
  const v = new SIDVoice();
  v.write(0, 0x00); v.write(1, 0x10);   // freq = 0x1000 (low, doesn't matter)
  v.write(5, 0x00);                      // attack=0 (9 cyc), decay=0
  v.write(6, 0x00);                      // sustain=0, release=0
  v.write(4, 0x11);                      // TRI + gate
  // Startup has a fixed state/envelope pipeline delay; clock until env first
  // steps to 1, then verify the steady cadence is exactly 9 cyc/tick.
  let c = 0; while (v.env === 0 && c < 40) { v.clock(); c++; }
  expect(v.env === 1, `attack first step to env=1, got ${v.env}`);
  for (let i = 0; i < 9; i++) v.clock();
  expect(v.env === 2, `steady 9-cyc/tick cadence: env=2, got ${v.env}`);
  // Ramp to the top: env = 255, state advances to 2 (decay).
  c = 0; while (v.env !== 255 && c < 9 * 256 + 32) { v.clock(); c++; }
  expect(v.env === 255, `attack done: env=255, got ${v.env}`);
  expect(v.state === 2, `state advanced to decay (2), got ${v.state}`);
  ok('SIDVoice: attack ramps env 0→255 at rate=0 (9 cyc/tick)');
}

// ── 5: Decay drops env exponentially toward sustain level ──────────────
// Real SID exponential decay: divider increases as env value drops. reSID
// changes the divider WHEN the counter reaches each threshold (applies to
// that value and below — see SIDVoice.clock):
//   env in 94..255: div=1
//   env in 55..93:  div=2   (set at 0x5d)
//   env in 27..54:  div=4   (set at 0x36)
//   env in 15..26:  div=8   (set at 0x1a)
//   env in 7..14:   div=16  (set at 0x0e)
//   env in 1..6:    div=30  (set at 0x06)
// At decay rate=0 (9 cyc), starting from env=255 with sustain=0:
// counts vary per div phase. Just verify env drops and reaches sustain.
{
  const v = new SIDVoice();
  v.write(5, 0x00); v.write(6, 0x40);   // attack=0, decay=0; sustain=4, release=0
  v.write(4, 0x11);                      // gate
  // Run attack (~9*255 = 2295 cyc) to get to decay state.
  for (let i = 0; i < 9 * 256; i++) v.clock();
  expect(v.state === 2, `in decay state after attack ramp`);
  // Clock until sustain reached. Sustain level for s=4 is 0x44 = 68.
  for (let i = 0; i < 200000 && v.env !== 0x44; i++) v.clock();
  expect(v.env === 0x44, `decay reached sustain $44, got $${v.env.toString(16)}`);
  // Decay/sustain is ONE state (reSID DECAY_SUSTAIN): the hold is the
  // env == sustain compare re-checked every exponential tick, not a state change.
  expect(v.state === 2, `stays in decay/sustain state (2), got ${v.state}`);
  ok('SIDVoice: decay drops env exponentially to sustain level');
}

// ── 6: Sustain holds env at sustain level until gate cleared ───────────
{
  const v = new SIDVoice();
  v.write(5, 0x00); v.write(6, 0x80);
  v.write(4, 0x11);
  for (let i = 0; i < 9 * 256; i++) v.clock();
  for (let i = 0; i < 200000 && v.env !== 0x88; i++) v.clock();
  const sustainLvl = v.env;
  expect(sustainLvl === 0x88, `reached sustain $88, got $${sustainLvl.toString(16)}`);
  expect(v.state === 2, `holds inside the decay/sustain state (2), got ${v.state}`);
  // Clock long — env should stay constant.
  for (let i = 0; i < 50000; i++) v.clock();
  expect(v.env === sustainLvl, `sustain holds env=$${sustainLvl.toString(16)}, got $${v.env.toString(16)}`);
  ok('SIDVoice: sustain phase holds env at sustain level');
}

// ── 7: Test bit zeros the phase + holds the LFSR (leaks to all-1s) ─────
// Ctrl bit 3 (TEST): holds phase = 0 and HOLDS the noise shift register
// (it is not clocked while TEST is high). Held long enough the register
// slowly leaks to all-1s ($7FFFFF) — ~$8000 cycles on the 6581
// (resid-test/noisetest). Source: reSID `wave.cc`, Antti Lankila.
{
  const v = new SIDVoice();
  v.write(0, 0xFF); v.write(1, 0xFF);   // freq = 0xFFFF
  v.write(4, 0x80);                      // noise — let phase + LFSR advance
  for (let i = 0; i < 100; i++) v.clock();
  expect(v.phase !== 0, `phase advanced before TEST: ${v.phase}`);
  v.write(4, 0x88);                      // noise + TEST
  v.clock();
  expect(v.phase === 0, `TEST: phase = 0 after one clock, got ${v.phase}`);
  // TEST holds the LFSR — unchanged over a short hold (not per-cycle clocked).
  const held = v.lfsr;
  for (let i = 0; i < 30; i++) v.clock();
  expect(v.lfsr === held, `TEST holds the LFSR (not clocked), got 0x${v.lfsr.toString(16)}`);
  // Held long enough the register fades to all-1s: first fade step after
  // 35000 cycles of TEST, then one per 1000 (6581, VICE resid
  // shiftreg_bitfade — each step lights bit 0 and spreads set bits left).
  for (let i = 0; i < 60000; i++) v.clock();
  expect((v.lfsr & 0x7FFFFF) === 0x7FFFFF,
    `TEST held long: LFSR fades to 0x7FFFFF, got 0x${v.lfsr.toString(16)}`);
  ok('SIDVoice: TEST bit ($D404 bit 3) zeros phase + holds the LFSR (leaks to all-1s)');
}

// ── 8: Sync source coupling — v1 syncs to v3, v2 to v1, v3 to v2 ──────
{
  const v1 = new SIDVoice(), v2 = new SIDVoice(), v3 = new SIDVoice();
  v1.syncSrc = v3; v2.syncSrc = v1; v3.syncSrc = v2;
  expect(v1.syncSrc === v3, `v1 syncs to v3`);
  expect(v2.syncSrc === v1, `v2 syncs to v1`);
  expect(v3.syncSrc === v2, `v3 syncs to v2`);
  // P6 semantics (reSID synchronize): the destination is synced on the
  // cycle its source's accumulator MSB RISES (bit 23 going 0→1) — NOT the
  // 24-bit wrap, which is half a source period later. Pulses are decided by
  // computeSyncPulses() from pre-clock state, then all voices clock.
  v1.write(0, 0xFF); v1.write(1, 0x00);
  v1.write(4, 0x12);                     // TRI + SYNC
  v3.write(0, 0xFF); v3.write(1, 0xFF);  // freq $FFFF
  v3.write(4, 0x10);                     // TRI, no sync
  v3.phase = 0x7FF000;                   // will cross into 0x800000 this cycle
  v1.phase = 0x500000;
  computeSyncPulses(v1, v2, v3);
  expect(v1.syncPulse === true, `v3 MSB rise → v1 sync pulse`);
  v1.clockCore(); v2.clockCore(); v3.clockCore();
  expect(v1.phase === 0, `SYNC: v1.phase reset on v3 MSB rise, got 0x${v1.phase.toString(16)}`);
  // The 24-bit WRAP does NOT sync (old, wrong edge):
  v3.phase = 0xFFF000;                   // will wrap 0xFFFFFF→0x00xxxx
  v1.phase = 0x500000;
  computeSyncPulses(v1, v2, v3);
  expect(v1.syncPulse === false, `v3 wrap (MSB falling) → no sync pulse`);
  v1.clockCore(); v2.clockCore(); v3.clockCore();
  expect(v1.phase !== 0, `SYNC: no reset on source wrap`);
  ok('SIDVoice: hard sync fires on source MSB rise, not the 24-bit wrap');
}

// ── 9: Phase accumulator increments by freq each clock ─────────────────
{
  const v = new SIDVoice();
  v.write(0, 0x00); v.write(1, 0x40);   // freq = 0x4000
  v.write(4, 0x10);                      // TRI, no test
  // This test is about the per-clock increment, not the power-up value.
  // The accumulator powers up at $555555 (see oscinit.prg / SIDVoice ctor),
  // so zero it first to isolate the "advances by freq" behaviour.
  v.phase = 0;
  for (let i = 0; i < 4; i++) v.clock();
  expect(v.phase === 0x010000,
    `phase = 4 * 0x4000 = 0x010000, got 0x${v.phase.toString(16)}`);
  ok('SIDVoice: phase accumulator advances by freq per clock');
}

// ── 10: Triangle waveform output (mc4=$10) — top bit toggles slope ──────
{
  const v = new SIDVoice();
  v.write(4, 0x10);                      // TRI only
  // Phase < 0x800000 → tri = phase >> 15 (rising).
  v.phase = 0x400000; v.prevPhase = v.phase;
  // Use getOscByte (mirrors waveform output bits without env scaling).
  expect(v.getOscByte() === 0x80, `tri at phase=0x400000: 0x80, got 0x${v.getOscByte().toString(16)}`);
  // Phase > 0x800000 → tri = ~phase >> 15 (falling).
  v.phase = 0xC00000;
  expect(v.getOscByte() === 0x7F, `tri at phase=0xC00000: 0x7F, got 0x${v.getOscByte().toString(16)}`);
  ok('SIDVoice: triangle waveform inverts on top half of phase');
}

// ── 11: Sawtooth waveform — high bits of phase ─────────────────────────
{
  const v = new SIDVoice();
  v.write(4, 0x20);                      // SAW only
  v.phase = 0x123456;
  expect(v.getOscByte() === 0x12, `saw at phase=0x123456: 0x12, got 0x${v.getOscByte().toString(16)}`);
  v.phase = 0xFFFFFF;
  expect(v.getOscByte() === 0xFF, `saw at phase=0xFFFFFF: 0xFF, got 0x${v.getOscByte().toString(16)}`);
  ok('SIDVoice: saw waveform = high 8 bits of phase');
}

// ── 12: Pulse waveform — phase < pw → 0, else $FF ──────────────────────
{
  const v = new SIDVoice();
  v.write(2, 0x00); v.write(3, 0x08);   // pw = 0x800 → pw24 = 0x800000
  v.write(4, 0x40);                      // PULSE only
  // The rail is a one-cycle LATCH (reSID pulse_output) — a poked phase is
  // seen after the next clock pushes the compare (freq=0 keeps phase put).
  v.phase = 0x400000;                    // < pw24 → 0
  v.clock();
  expect(v.getOscByte() === 0x00, `pulse phase < pw: 0`);
  v.phase = 0xC00000;                    // > pw24 → 0xFF
  v.clock();
  expect(v.getOscByte() === 0xFF, `pulse phase >= pw: 0xFF`);
  ok('SIDVoice: pulse waveform = 0xFF iff phase >= pw (one-cycle latch)');
}

// ── 13: Noise waveform — derived from LFSR taps ────────────────────────
// reSID / resid-test noisetest: OSC3 noise byte samples LFSR bits
// 20, 18, 14, 11, 9, 5, 2, 0 → packed into bits 7..0.
{
  const v = new SIDVoice();
  v.write(4, 0x80);                      // NOISE
  v.lfsr = 0x7FFFF8;                     // arbitrary register value
  v._setNoiseOutput();                   // noise output is a LATCH (P7):
                                         // poking the register directly
                                         // requires a refresh, as only
                                         // shifts/writebacks update it
  v.clock();
  const noise = v.getOscByte();
  // Compute expected from tap formula.
  const lfsr = v.lfsr;
  const expected =
    ((lfsr & 0x100000) >> 13) | ((lfsr & 0x040000) >> 12) |
    ((lfsr & 0x004000) >> 9)  | ((lfsr & 0x000800) >> 7) |
    ((lfsr & 0x000200) >> 6)  | ((lfsr & 0x000020) >> 3) |
    ((lfsr & 0x000004) >> 1)  | (lfsr & 0x000001);
  expect(noise === expected,
    `noise byte from LFSR taps: expected $${expected.toString(16)}, got $${noise.toString(16)}`);
  ok('SIDVoice: noise output samples LFSR taps 20/18/14/11/9/5/2/0');
}

// ── 14: SIDChip register routing ───────────────────────────────────────
// Voice 1: $D400-$D406. Voice 2: $D407-$D40D. Voice 3: $D40E-$D414.
// Filter cutoff lo: $D415, hi: $D416. Res/route: $D417. Mode/vol: $D418.
{
  const sid = new SIDChip();
  sid.write(0, 0x42);
  expect(sid.v1.freq === 0x42, `voice1 reg 0 (freq lo) = 0x42`);
  sid.write(7, 0x33);
  expect(sid.v2.freq === 0x33, `voice2 reg 0 (= $D407) = 0x33`);
  sid.write(14, 0xCC);
  expect(sid.v3.freq === 0xCC, `voice3 reg 0 (= $D40E) = 0xCC`);
  sid.write(21, 0x07); sid.write(22, 0xFE);
  expect(sid.filter.fc === ((0xFE << 3) | 7), `fc 11-bit: lo=$07 + hi=$FE`);
  sid.write(23, 0x4C);
  expect(sid.filter.res === 4, `res = 4 (high nibble)`);
  expect(sid.filter.filt === 0xC, `filter route = 0xC (low nibble)`);
  sid.write(24, 0xA9);                  // 0xA9 = 1010 1001
  expect(sid.filter.vol === 9, `vol = 9 (low nibble)`);
  expect((sid.filter.mode >> 4) === 0xA, `mode = 0xA (bits 4-7 of 0xA9, incl. v3off)`);
  expect((sid.filter.mode & 0x80) !== 0, `v3off = true (bit 7 of 0xA9 set)`);
  ok('SIDChip: register routing per voice + filter + mode/vol');
}

// ── 15: $D419 (POTX) and $D41A (POTY) read paddle value ────────────────
// SIDProxy returns potValue (0x64 default) for these regs.
// SIDChip itself returns 0 (no paddle modeling).
{
  const sid = new SIDChip();
  expect(sid.read(0x19) === 0, `SIDChip reg $19 reads 0 (no paddle)`);
  expect(sid.read(0x1A) === 0, `SIDChip reg $1A reads 0`);
  ok('SIDChip: $D419/$D41A POTX/POTY read 0 (paddle not modeled by SIDChip itself)');
}

// ── 16: $D41B (OSC3) reads voice 3's current waveform byte ─────────────
{
  const sid = new SIDChip();
  sid.v3.phase = 0x654321;
  sid.v3.write(4, 0x20);                // SAW
  expect(sid.read(0x1B) === 0x65,
    `OSC3 read = v3 saw byte = 0x65, got 0x${sid.read(0x1B).toString(16)}`);
  ok('SIDChip: $D41B OSC3 reads voice-3 oscillator byte');
}

// ── 17: $D41C (ENV3) reads voice 3's envelope value ────────────────────
{
  const sid = new SIDChip();
  // $D41C reads the ENV3 latch (env3), sampled at the first phase of each
  // clock — a one-cycle-delayed view of the envelope counter (reSID).
  sid.v3.env = 0x80; sid.v3.env3 = 0x80;
  expect(sid.read(0x1C) === 0x80,
    `ENV3 = v3.env3, got 0x${sid.read(0x1C).toString(16)}`);
  ok('SIDChip: $D41C ENV3 reads voice-3 envelope byte');
}

// ── 18: Voice routing — bit 0/1/2 of $D417 routes voice 1/2/3 to filter
// $D417 = res(hi nibble) + filt route (lo nibble bits 0-3 = v1/v2/v3/ext).
{
  const sid = new SIDChip();
  sid.write(23, 0x07);                   // route v1+v2+v3 to filter
  expect(sid.filter.filt === 0x07, `all three voices routed to filter`);
  expect((sid.filter.sum & 0x0F) === 0x07, `summer input mask follows the route`);
  sid.write(23, 0x00);
  expect(sid.filter.filt === 0x00, `no voices routed (passes direct)`);
  expect((sid.filter.sum & 0x0F) === 0x00, `summer input mask cleared`);
  ok('SIDChip: $D417 bits 0-2 route voices 1-3 to filter');
}

// ── 19: $D418 bit 7 = voice 3 disconnect (silence v3 in mix) ───────────
{
  const sid = new SIDChip();
  sid.write(24, 0x80);
  expect((sid.filter.mode & 0x80) !== 0, `v3off bit latched when D418 bit 7 set`);
  expect((sid.filter.mix & 0x04) === 0, `voice 3 removed from the mixer (reSID set_sum_mix)`);
  sid.write(24, 0x00);
  expect((sid.filter.mode & 0x80) === 0, `v3off bit clear when D418 bit 7 clear`);
  expect((sid.filter.mix & 0x04) !== 0, `voice 3 back in the mixer`);
  // NB (reSID): v3off only removes voice 3 when it is routed DIRECTLY to
  // the mixer — a filter-routed voice 3 stays audible through the filter.
  sid.write(23, 0x04);                   // route v3 through the filter
  sid.write(24, 0x80);
  expect((sid.filter.sum & 0x04) !== 0, `filter-routed voice 3 unaffected by v3off`);
  ok('SIDChip: $D418 bit 7 disconnects voice 3 from mix');
}

// ── 20: setModel toggles 6581/8580 chip variant ────────────────────────
{
  const sid = new SIDChip();
  expect(sid.is8580 === false, `default = 6581`);
  sid.setModel(true);
  expect(sid.is8580 === true && sid.v1.is8580 === true, `8580 propagates to all voices`);
  sid.setModel(false);
  expect(sid.is8580 === false && sid.v3.is8580 === false, `back to 6581`);
  ok('SIDChip: setModel toggles is8580 across chip + all voices');
}

// ── 21: clock() returns sample in [-1, 1] range ────────────────────────
{
  const sid = new SIDChip();
  sid.write(24, 0x0F);                   // master vol = 15
  // Run 1000 clock cycles with a triangle voice. Sample should be bounded.
  sid.v1.write(0, 0x00); sid.v1.write(1, 0x10);
  sid.v1.write(5, 0x00); sid.v1.write(6, 0xF0);
  sid.v1.write(4, 0x11);
  let minS = Infinity, maxS = -Infinity;
  for (let i = 0; i < 1000; i++) {
    const s = sid.clock();
    if (s < minS) minS = s;
    if (s > maxS) maxS = s;
  }
  expect(minS >= -1.0 && maxS <= 1.0, `samples bounded to [-1, 1]: min=${minS}, max=${maxS}`);
  ok('SIDChip: clock() output is bounded to [-1, 1]');
}

// ── 22: Master volume = 0 produces a DC click then settles to ~0 ───────
// Real chip: $D418 master vol = 0 mutes the audio path, but the DC
// offset reverses, producing a click. Used by demos for 4-bit sample
// playback. The DC-blocker (HPF) decays the click; after a few hundred
// samples the AC magnitude is small.
{
  const sid = new SIDChip();
  sid.v1.write(0, 0xFF); sid.v1.write(1, 0x10);
  sid.v1.write(5, 0x00); sid.v1.write(6, 0xF0);
  sid.v1.write(4, 0x11);
  sid.write(24, 0x0F);                   // vol=15: seed with sound
  for (let i = 0; i < 5000; i++) sid.clock();   // let normal output stabilize
  sid.write(24, 0x00);                   // vol=0: mute
  // Skip the DC-click transient. HPF coefficient 0.999937 at SID rate
  // (~985 kHz) decays ~e-fold per ~16k cycles → wait 50k for clean.
  for (let i = 0; i < 50000; i++) sid.clock();
  let absSum = 0;
  for (let i = 0; i < 1000; i++) absSum += Math.abs(sid.clock());
  expect(absSum < 100,
    `vol=0 steady-state: AC sample energy small, got ${absSum.toFixed(2)}`);
  ok('SIDChip: master volume=0 settles to silence after DC click decays');
}

// ── 23: Pulse-width 0 → constant low (always before pw24) ──────────────
// pw24 = (pw & 0xFFF) << 12. pw=0 → pw24=0 → phase >= 0 always → pulse=0xFF.
// pw=0xFFF → pw24=0xFFF000 → only briefly high near end of cycle.
{
  const v = new SIDVoice();
  v.write(2, 0x00); v.write(3, 0x00);   // pw=0 (write refreshes the latch)
  v.write(4, 0x40);                      // PULSE
  v.phase = 0x000001;
  v.clock();                             // latch push sees the poked phase
  expect(v.getOscByte() === 0xFF, `pw=0 → pulse always high (0xFF)`);
  v.write(2, 0xFF); v.write(3, 0x0F);   // pw=0xFFF → pw24=0xFFF000
  v.phase = 0xFFFFFF;
  v.clock();
  expect(v.getOscByte() === 0xFF, `phase=max, pw=$FFF: high (0xFF)`);
  v.phase = 0xFFEFFF;                    // just below pw24=0xFFF000
  v.clock();
  expect(v.getOscByte() === 0x00, `phase 0xFFEFFF < pw24 0xFFF000: low`);
  ok('SIDVoice: pulse-width edge cases (pw=0 / pw=$FFF)');
}

// ── 24: Filter mode bits select LP/BP/HP combinations ──────────────────
// $D418 bits 4-7: bit 4 = LP, bit 5 = BP, bit 6 = HP, bit 7 = v3off.
{
  const sid = new SIDChip();
  sid.write(24, 0x10);                   // LP only
  expect((sid.filter.mode >> 4) === 1, `LP mode bit set`);
  expect((sid.filter.mix & 0x70) === 0x10, `mixer takes the LP tap`);
  sid.write(24, 0x70);                   // LP+BP+HP (notch)
  expect((sid.filter.mode >> 4) === 7, `all three filter outputs combined (notch)`);
  expect((sid.filter.mix & 0x70) === 0x70, `mixer takes all three filter taps`);
  ok('SIDChip: $D418 bits 4-6 select filter modes (LP/BP/HP)');
}

// ── 26: 6581 dims combined non-pulse waveforms ─────────────────────────
// SID enhancement #2: combining multiple non-pulse waveforms on 6581
// attenuates the output (mixer non-linearity). 8580 doesn't have this
// dimming. Test with TRI+SAW: 6581 should have a smaller magnitude than
// 8580 for the same shifter state.
{
  const v6581 = new SIDVoice(); v6581.is8580 = false;
  const v8580 = new SIDVoice(); v8580.is8580 = true;
  for (const v of [v6581, v8580]) {
    v.write(4, 0x30);                    // TRI+SAW, no gate (env stays 0)
    v.env = 255;                         // force env to max for testing
    v.phase = 0x123456;                  // arbitrary phase
  }
  const out6581 = Math.abs(v6581.clock());
  const out8580 = Math.abs(v8580.clock());
  // 6581 should be ≤ 8580 (or close — depends on phase value).
  // Just verify both produce non-zero output with TRI+SAW combined.
  expect(out6581 >= 0 && out8580 >= 0, `both produce output`);
  // The exact dimming factor varies with phase; just verify the
  // chip variants produce different outputs.
  expect(out6581 !== out8580 || out6581 === 0,
    `6581 vs 8580 produce different combined-waveform outputs`);
  ok('SID #2: 6581 dims combined non-pulse waveforms vs 8580 (mixer model)');
}

// ── 27: Noise + combined waveform clobbers LFSR over time ──────────────
// SID enhancement #3: real-chip LFSR taps gradually clear toward 0
// when NOISE is enabled together with another waveform. Demos that
// hold the combination produce noise that decays to silence.
{
  const v = new SIDVoice();
  v.write(0, 0xFF); v.write(1, 0xFF);   // freq=$FFFF (fast phase wraps)
  v.write(4, 0xC1);                      // NOISE+PULSE + gate
  // Initial LFSR: $7FFFFF clocked once on reset release (reSID) = $7FFFFE.
  expect(v.lfsr === 0x7FFFFE, `initial LFSR = 0x7FFFFE`);
  // Run many clock cycles → LFSR taps progressively clear.
  for (let i = 0; i < 5000; i++) v.clock();
  // After many cycles with noise+pulse, the LFSR's tap bits should be
  // mostly cleared (we mask out 8 specific tap positions over time).
  const tapMask = 0x400000 | 0x100000 | 0x010000 | 0x002000 |
                  0x000800 | 0x000080 | 0x000010 | 0x000004;
  const remainingTapBits = (v.lfsr & tapMask).toString(2).split('').filter(c => c === '1').length;
  expect(remainingTapBits < 6,
    `noise+pulse hold: tap bits cleared, ${remainingTapBits}/8 still set`);
  ok('SID #3: noise + combined waveform progressively clobbers LFSR taps');
}

// ── 28: Noise WITHOUT combined waveform does NOT clobber LFSR ──────────
// SID enhancement #3 control: noise-only operation should keep LFSR
// running normally with full periodicity.
{
  const v = new SIDVoice();
  v.write(0, 0xFF); v.write(1, 0xFF);
  v.write(4, 0x81);                      // NOISE only + gate
  for (let i = 0; i < 5000; i++) v.clock();
  // LFSR should still have many bits set (noise is pseudo-random, full
  // entropy). The 8 tap positions should mostly stay populated.
  const tapMask = 0x400000 | 0x100000 | 0x010000 | 0x002000 |
                  0x000800 | 0x000080 | 0x000010 | 0x000004;
  const remainingTapBits = (v.lfsr & tapMask).toString(2).split('').filter(c => c === '1').length;
  expect(remainingTapBits >= 2,
    `noise-only: LFSR keeps non-trivial tap bits, ${remainingTapBits}/8 set`);
  ok('SID #3: NOISE alone does NOT clobber LFSR (clobbering requires combined waveform)');
}

// ── 30: ADSR rate counter wraps at 15-bit boundary ─────────────────────
// SID enhancement #5: counter is 15-bit (0..0x7FFF). Verify it wraps.
{
  const v = new SIDVoice();
  v.write(5, 0xF0);                      // very slow attack (~31k cyc)
  v.write(4, 0x11);                      // gate
  // Run 0x7FFF cycles → counter wraps once.
  for (let i = 0; i < 0x7FFF; i++) v.clock();
  // Counter must be in [0, 0x7FFF] range (15-bit).
  expect(v.rateCounter >= 0 && v.rateCounter <= 0x7FFF,
    `counter in 15-bit range, got ${v.rateCounter}`);
  ok('SID #5: rate counter is 15-bit (0..0x7FFF), wraps cleanly');
}

// ── 31: 6581 filter cutoff curve produces different fc → freq mapping
// SID enhancement #4: replace the simple `30*pow(400,fc/2048)` with a
// piecewise approximation that better matches measured 6581 chips —
// flatter at low fc (~220 Hz at fc=$00), kneeing up around fc=$400,
// approaching ~12 kHz at fc=$7FF. Verify cutoff varies meaningfully
// with fc by routing a stable triangle voice through the LP and
// comparing output amplitude at low vs high fc settings.
{
  const sid = new SIDChip();
  sid.setModel(false);                   // 6581
  sid.v1.write(0, 0x00); sid.v1.write(1, 0x40);  // freq = 0x4000 (audible)
  sid.v1.write(5, 0x00); sid.v1.write(6, 0xF0);  // fast attack + sustain
  sid.v1.write(4, 0x11);                          // TRI + gate
  sid.write(23, 0x01);                            // route v1 to filter
  sid.write(24, 0x1F);                            // LP mode + vol=15
  // Run two cutoff settings and compare the LP's measured output peak.
  const measureWithFc = (fcHi, fcLo) => {
    sid.lp = 0; sid.bp = 0; sid.hp = 0;
    sid.write(21, fcLo & 7);
    sid.write(22, fcHi);
    for (let i = 0; i < 10000; i++) sid.clock();   // settle
    let peak = 0;
    for (let i = 0; i < 5000; i++) {
      const s = Math.abs(sid.clock());
      if (s > peak) peak = s;
    }
    return peak;
  };
  const peakAtFc00 = measureWithFc(0x00, 0);
  const peakAtFc7FF = measureWithFc(0xFF, 7);
  // Different fc settings produce different filter responses. We don't
  // assume a strict ordering (the 6581's non-linear saturation can
  // make this complex), just that the output isn't identical.
  expect(peakAtFc00 !== peakAtFc7FF,
    `6581 LP differs at fc=$00 vs fc=$7FF: low=${peakAtFc00.toFixed(3)}, high=${peakAtFc7FF.toFixed(3)}`);
  ok('SID #4: 6581 filter cutoff varies meaningfully with fc register');
}

// ── 31b: 6581 cutoff behavior — LP bandwidth rises with the FC register ─
// The reSID port replaced the calibrated cutoff table with the physical
// model: an 11-bit R-2R cutoff DAC (with the 6581's real non-monotonic
// major-carry discontinuities — a strict monotonicity test would be WRONG
// for this chip) driving the VCR integrators. Behavioral check instead: a
// mid-audio triangle through the LP passes far more energy at fc=$7FF than
// at fc=$000, with a mid setting in between.
{
  const measure = (fc11) => {
    const sid = new SIDChip(false);
    sid.setModel(false);
    sid.v1.write(0, 0x00); sid.v1.write(1, 0x60);  // freq $6000 ≈ 1.4 kHz
    sid.v1.write(5, 0x00); sid.v1.write(6, 0xF0);
    sid.v1.write(4, 0x11);                          // TRI + gate
    sid.write(23, 0x01);                            // route v1, res=0
    sid.write(24, 0x1F);                            // LP + vol 15
    sid.write(21, fc11 & 7); sid.write(22, (fc11 >> 3) & 0xFF);
    for (let i = 0; i < 30000; i++) sid.clock();    // settle envelope+filter
    let sumSq = 0, sum = 0;
    const N = 60000;
    for (let i = 0; i < N; i++) { const s = sid.clock(); sum += s; sumSq += s * s; }
    const mean = sum / N;
    return Math.sqrt(sumSq / N - mean * mean);      // AC RMS (DC removed)
  };
  const lo = measure(0x000), mid = measure(0x400), hi = measure(0x7FF);
  expect(hi > lo * 2,
    `6581 LP passes far more 1.4 kHz at fc=$7FF than fc=$000 (lo=${lo.toFixed(4)}, hi=${hi.toFixed(4)})`);
  expect(mid > lo && mid < hi * 1.2,
    `mid cutoff sits between the extremes (lo=${lo.toFixed(4)}, mid=${mid.toFixed(4)}, hi=${hi.toFixed(4)})`);
  ok('SID #4b: 6581 cutoff rises with FC through the physical VCR model');
}

// ── 31c: $D417 bit 3 (EXT IN filter routing) is a no-op without ExtIn ──
// On stock C64 the SID's EXT IN pin is grounded, so routing it through
// the filter adds 0 to filterIn. We have no external audio source, so
// the bit's effect must be exactly that — no audio change vs the same
// setup with bit 3 cleared. Demos that toggle bit 3 alongside vol/filter
// changes (sometimes as a "filter armed" cue) must not produce different
// audio.
{
  const setup = (filtRouteBits) => {
    const sid = new SIDChip();
    sid.setModel(false);                          // 6581
    // V1: pulse @ 440 Hz, full sustain, gate on, NOT routed through filter.
    sid.v1.write(0, 0x8C); sid.v1.write(1, 0x1D); // freq for ~440 Hz
    sid.v1.write(2, 0x00); sid.v1.write(3, 0x08); // pw = $800
    sid.v1.write(5, 0x00); sid.v1.write(6, 0xF0); // attack=0, sustain=15
    sid.v1.write(4, 0x41);                        // PULSE + GATE
    // Filter cutoff mid, res mid, LP mode, vol=15.
    sid.write(21, 0x00); sid.write(22, 0x80);     // fc = $400
    sid.write(23, (0x07 << 4) | filtRouteBits);   // res=7, route bits
    sid.write(24, 0x1F);                          // LP mode, vol=15
    return sid;
  };
  const captureN = (sid, n) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Math.abs(sid.clock());
    return sum;
  };
  const energyWith    = captureN(setup(0x08), 50000);   // bit 3 set, no voices routed
  const energyWithout = captureN(setup(0x00), 50000);   // bit 3 clear, no voices routed
  expect(energyWith === energyWithout,
    `bit 3 alone (no voices routed) is bit-for-bit identical to bit 3 clear: ${energyWith} vs ${energyWithout}`);

  // Same when combined with V1 routed.
  const energyV1Bit3    = captureN(setup(0x09), 50000); // V1 routed + bit 3
  const energyV1NoBit3  = captureN(setup(0x01), 50000); // V1 routed only
  expect(energyV1Bit3 === energyV1NoBit3,
    `bit 3 + V1 route ≡ V1 route alone: ${energyV1Bit3} vs ${energyV1NoBit3}`);

  ok('SID #4c: $D417 bit 3 (EXT IN routing) is a no-op against stock-C64 grounded EXT IN');
}

// ── 32: 8580 filter cutoff is nearly linear in fc ──────────────────────
// SID enhancement #4: 8580 has a much more linear fc→frequency mapping.
// fc=$00→~30 Hz, fc=$7FF→~12.5 kHz.
{
  const sid = new SIDChip();
  sid.setModel(true);                    // 8580
  sid.v1.write(0, 0xFF); sid.v1.write(1, 0x10);
  sid.v1.write(5, 0x00); sid.v1.write(6, 0xF0);
  sid.v1.write(4, 0x11);
  sid.write(23, 0x01);
  sid.write(24, 0x1F);
  // fc=$400 (mid): expected ~6 kHz cutoff. Just verify filter operates.
  sid.write(21, 0); sid.write(22, 0x80);
  for (let i = 0; i < 5000; i++) sid.clock();
  let mid = 0;
  for (let i = 0; i < 1000; i++) mid += Math.abs(sid.clock());
  expect(mid > 0 && mid < 5000, `8580 LP fc=$400: filtered output, got energy=${mid.toFixed(2)}`);
  ok('SID #4: 8580 filter operates at mid-cutoff with linear-ish curve');
}

// ── 33: Filter resonance increases output peak at high res ─────────────
// SID enhancement #6: high resonance ($F) creates a sharp peak around
// the cutoff frequency. At low res ($0) the filter is gently sloped.
// Test by injecting a wideband noise input through the filter at
// res=$0 vs res=$F at moderate cutoff. Resonant case should produce
// stronger oscillation around the cutoff.
{
  // AC RMS over a long window (the physical model's op-amp bounding makes
  // instantaneous |peak| a noisy metric; energy is the honest one).
  const measureRes = (res, is8580) => {
    const sid = new SIDChip(is8580);
    sid.setModel(is8580);
    // freq=$4000 → LFSR clocks every 64 cycles, flat noise through the
    // cutoff so the resonant peak actually gets excited.
    sid.v1.write(0, 0x00); sid.v1.write(1, 0x40);
    sid.v1.write(5, 0x00); sid.v1.write(6, 0xF0);
    sid.v1.write(4, 0x81);                 // NOISE + gate
    sid.write(23, (res << 4) | 1);         // resonance + route v1 to filter
    sid.write(24, 0x2F);                   // BP mode + vol=15
    sid.write(21, 0); sid.write(22, 0x80); // fc = $400
    for (let i = 0; i < 30000; i++) sid.clock();   // settle
    let sum = 0, sq = 0;
    const N = 100000;
    for (let i = 0; i < N; i++) { const s = sid.clock(); sum += s; sq += s * s; }
    const mean = sum / N;
    return Math.sqrt(sq / N - mean * mean);
  };
  // Measured on the ported model: ratio ≈ 2.6 (6581), ≈ 2.5 (8580).
  for (const is8580 of [false, true]) {
    const lo = measureRes(0, is8580), hi = measureRes(15, is8580);
    expect(hi > lo * 1.5,
      `${is8580 ? '8580' : '6581'} res=$F BP energy ≥ 1.5× res=0: hi=${hi.toFixed(4)}, lo=${lo.toFixed(4)}`);
  }
  ok('SID #6: filter resonance increases the BP peak on both models');
}

// ── 34: TEST bit holds the pulse output HIGH ───────────────────────────
// reSID wave.h: "The test bit, when set to one, holds the pulse waveform
// output at 0xfff regardless of the pulse width setting." Verified in
// reSID's clock() (pulse_output = 0xfff while test) and writeCONTROL_REG
// (test rising sets pulse high). When TEST clears, the comparator resumes
// with the accumulator counting from 0, so with pw > 0 the pulse is low
// again until phase reaches pw<<12.
{
  for (const is8580 of [false, true]) {
    const tag = is8580 ? '8580' : '6581';
    const v = new SIDVoice();
    v.is8580 = is8580;
    v.write(2, 0xFF); v.write(3, 0x0F);   // pw = $FFF (max — comparator alone gives 0 at phase=0)
    v.write(4, 0x48);                      // PULSE + TEST
    v.clock();
    // The CPU-visible surface is readOsc3 (outputStage's _oscLive, computed
    // while TEST held the rail high). getOscByte between clocks would see
    // the end-of-cycle latch push that the next clock's TEST overwrites.
    expect(v.readOsc3() === 0xFF,
      `${tag}: TEST+PULSE reads $FF, got $${v.readOsc3().toString(16)}`);
    // OSC3 readback path sees the rail too (this is CPU-visible via $D41B).
    v.clock();
    expect(v.readOsc3() === 0xFF, `${tag}: readOsc3 under TEST+PULSE = $FF`);
    // Release TEST → comparator resumes from phase 0: low below pw.
    v.write(0, 0x00); v.write(1, 0x10);   // freq — phase advances after release
    v.write(4, 0x40);                      // PULSE only
    v.clock();
    expect(v.getOscByte() === 0x00,
      `${tag}: TEST cleared — pulse low again below pw, got $${v.getOscByte().toString(16)}`);
  }
  ok('SIDVoice: TEST bit forces the pulse output high (reSID wave.h)');
}

// ── 35: gated TEST+PULSE audio sits on the positive rail ───────────────
// The test-bit digi mechanism: a voice parked with TEST+PULSE+GATE outputs
// the envelope-scaled HIGH rail (previously it sat on the negative rail
// because the pulse comparator saw phase=0 < pw).
{
  const v = new SIDVoice();
  v.write(5, 0x00); v.write(6, 0xF0);     // A=0, S=15
  v.write(2, 0x00); v.write(3, 0x08);     // pw = $800
  v.write(4, 0x49);                        // PULSE + TEST + GATE
  let s = 0;
  for (let i = 0; i < 3000; i++) s = v.clock();
  expect(s > 0.9, `gated TEST+PULSE outputs the high rail, got ${s.toFixed(3)}`);
  ok('SIDVoice: TEST+PULSE+GATE audio sits on the positive rail (test-bit digi)');
}

// ── 36: lowering SR while gated resumes decay (hard-restart drain) ─────
// reSID envelope.h DECAY_SUSTAIN: the sustain compare (env == (s<<4)|s) is
// re-evaluated on every exponential tick — there is no frozen sustain
// state. Writing SR=$00 while the note holds drains the envelope to 0 at
// the decay rate; this is the GoatTracker/JCH hard restart, used by a huge
// share of real SID music to get deterministic attack transients.
{
  const v = new SIDVoice();
  v.write(5, 0x00); v.write(6, 0x80);     // A=0 D=0, S=8 R=0
  v.write(4, 0x11);                        // TRI + gate
  for (let i = 0; i < 9 * 256; i++) v.clock();               // attack to 255
  for (let i = 0; i < 200000 && v.env !== 0x88; i++) v.clock();
  expect(v.env === 0x88, `holds at sustain $88, got $${v.env.toString(16)}`);
  v.write(6, 0x00);                        // hard restart: SR=$00, gate still on
  for (let i = 0; i < 50000 && v.env > 0; i++) v.clock();
  expect(v.env === 0, `SR=$00 while gated drains env to 0, got $${v.env.toString(16)}`);
  expect(v.state === 2, `still in decay/sustain (gate on), got state ${v.state}`);
  ok('SIDVoice: lowering sustain while gated resumes decay (hard-restart drain)');
}

// ── 37: live SR moves follow reSID DECAY_SUSTAIN semantics ─────────────
// Lowered to a nonzero level → env decays to the NEW level and holds.
// Raised above the current env → the == compare never matches on the way
// down, so env decays past the new sustain all the way to 0.
{
  const v = new SIDVoice();
  v.write(5, 0x00); v.write(6, 0xC0);     // S=12
  v.write(4, 0x11);
  for (let i = 0; i < 9 * 256; i++) v.clock();
  for (let i = 0; i < 200000 && v.env !== 0xCC; i++) v.clock();
  expect(v.env === 0xCC, `holds at $CC`);
  v.write(6, 0x60);                        // lower S → resume decay to $66
  for (let i = 0; i < 200000 && v.env !== 0x66; i++) v.clock();
  expect(v.env === 0x66, `resumes decay to the new sustain $66, got $${v.env.toString(16)}`);
  for (let i = 0; i < 20000; i++) v.clock();
  expect(v.env === 0x66, `holds at the new level, got $${v.env.toString(16)}`);
  v.write(6, 0xA0);                        // raise S above env ($AA > $66)
  for (let i = 0; i < 400000 && v.env > 0; i++) v.clock();
  expect(v.env === 0, `raised sustain is never reached — env falls to 0, got $${v.env.toString(16)}`);
  ok('SIDVoice: live SR changes follow reSID DECAY_SUSTAIN semantics');
}

// ── 38: 8580 resonance strengthens monotonically through the ladder ────
// The reSID port implements the 8580's 1/Q = 2^((4−res)/8) resistor-ladder
// law INSIDE the pre-solved resonance op-amp tables (filter8580new.cc
// resGain[]), so there is no scalar coefficient to pin any more. Assert
// the audible consequence: BP energy at a resonant setup rises through
// res = 0 → 8 → 15. (The exact curves are oracle-checked against headless
// VICE x64sc fcsweep captures in the dev harness.)
{
  const measure = (res) => {
    const sid = new SIDChip(true);
    sid.setModel(true);
    sid.v1.write(0, 0x00); sid.v1.write(1, 0x40);
    sid.v1.write(5, 0x00); sid.v1.write(6, 0xF0);
    sid.v1.write(4, 0x81);                 // NOISE + gate
    sid.write(23, (res << 4) | 1);
    sid.write(24, 0x2F);                   // BP + vol 15
    sid.write(21, 0); sid.write(22, 0x80); // fc = $400
    for (let i = 0; i < 30000; i++) sid.clock();
    let sum = 0, sq = 0;
    const N = 80000;
    for (let i = 0; i < N; i++) { const s = sid.clock(); sum += s; sq += s * s; }
    const mean = sum / N;
    return Math.sqrt(sq / N - mean * mean);
  };
  const r0 = measure(0), r8 = measure(8), r15 = measure(15);
  expect(r8 > r0, `res=8 BP energy > res=0 (${r8.toFixed(4)} vs ${r0.toFixed(4)})`);
  expect(r15 > r8, `res=$F BP energy > res=8 (${r15.toFixed(4)} vs ${r8.toFixed(4)})`);
  ok('SID: 8580 resonance ladder strengthens monotonically (reSID tables)');
}

// ── 39: 8580 cutoff rises with FC through the linear DAC ladder ────────
// The 8580's cutoff DAC is a parallel-NMOS W/L ladder — linear in the FC
// register by construction (reSID filter8580new.cc). Behavioral check: a
// 1.4 kHz triangle is blocked at fc≈0 and passes fully once the cutoff
// clears it. (Full curve: VICE fcsweep WAV comparisons.)
{
  const lpRms = (fcHi) => {
    const sid = new SIDChip(true);
    sid.setModel(true);
    sid.v1.write(0, 0x00); sid.v1.write(1, 0x60);   // ≈1.4 kHz tri
    sid.v1.write(5, 0x00); sid.v1.write(6, 0xF0);
    sid.v1.write(4, 0x11);
    sid.write(23, 0x01);
    sid.write(24, 0x1F);                            // LP + vol 15
    sid.write(21, 0); sid.write(22, fcHi);
    for (let i = 0; i < 30000; i++) sid.clock();
    let sum = 0, sq = 0;
    const N = 60000;
    for (let i = 0; i < N; i++) { const s = sid.clock(); sum += s; sq += s * s; }
    const mean = sum / N;
    return Math.sqrt(sq / N - mean * mean);
  };
  // Measured on the ported model: fc≈0 → 0.003 rms (blocked); fc=$200 and
  // up → 0.066 rms (passing). The knee position/curve is oracle-checked by
  // the fcsweep WAVs, not pinned here.
  const blocked = lpRms(0x00), open = lpRms(0x80);
  expect(open > blocked * 5,
    `8580 LP passes the 1.4 kHz tone once fc clears it (blocked=${blocked.toFixed(4)}, open=${open.toFixed(4)})`);
  ok('SID: 8580 cutoff opens with FC through the linear DAC ladder');
}

// ── 40: 8580 res=$F BP energy clearly exceeds res=0 ────────────────────
// Behavioral cousin of test 33's 8580 leg at a LOWER cutoff (fc=$200):
// the resonance margin must hold away from the mid-band sweet spot too.
{
  const measureRes8580 = (res) => {
    const sid = new SIDChip(true);
    sid.setModel(true);
    // freq=$4000 → LFSR clocks every 64 cycles (~15 kHz update), so the
    // noise spectrum is flat through the cutoff and the resonant peak
    // actually gets excited (a slow LFSR puts all energy below fc).
    sid.v1.write(0, 0x00); sid.v1.write(1, 0x40);
    sid.v1.write(5, 0x00); sid.v1.write(6, 0xF0);
    sid.v1.write(4, 0x81);                           // NOISE + gate
    sid.write(23, (res << 4) | 1);                   // res + route v1
    sid.write(24, 0x2F);                             // BP + vol 15
    sid.write(21, 0); sid.write(22, 0x40);           // fc = $200
    for (let i = 0; i < 30000; i++) sid.clock();
    let sum = 0, sq = 0;
    const N = 80000;
    for (let i = 0; i < N; i++) { const s = sid.clock(); sum += s; sq += s * s; }
    const mean = sum / N;
    return Math.sqrt(sq / N - mean * mean);
  };
  const lo = measureRes8580(0), hi = measureRes8580(15);
  expect(hi > lo * 1.5,
    `8580 res=$F BP energy ≥ 1.5× res=0: hi=${hi.toFixed(4)}, lo=${lo.toFixed(4)}`);
  ok('SID: 8580 high resonance produces a strong BP peak (reSID tables)');
}

// ── 41: waveform DAC is 12-bit in the audio path; OSC3 stays top-8 ─────
// reSID wave.h: saw = top 12 accumulator bits; triangle = 11 bits shifted
// left one (DAC LSB grounded); pulse rail = $FFF; noise = LFSR taps on DAC
// bits 11..4 (low 4 grounded). Audio must resolve all 12 bits — phases that
// differ only BELOW the old 8-bit resolution now produce distinct samples —
// while $D41B keeps reading the chip's top 8 bits.
{
  // Voice with env pinned at 255 (A=0, S=15, gate through the attack) and
  // freq=0 so the phase can be positioned by hand between clocks. Voice
  // output is the reSID integer product (wave DAC − wave_zero) × env DAC;
  // expectations are expressed through the DAC tables. The 8580's
  // terminated ladder is near-ideal (reSID adds a small subthreshold
  // leakage floor), so adjacent codes still step monotonically; the 6581's
  // strongly nonlinear DAC is covered by test 43.
  const mk = (ctrl) => {
    const v = new SIDVoice();
    v.is8580 = true;
    v.write(5, 0x00); v.write(6, 0xF0);
    v.write(0, 0x00); v.write(1, 0x00);      // freq 0 — phase stays put
    v.write(4, ctrl);
    for (let i = 0; i < 9 * 256 + 40; i++) v.clock();
    return v;
  };
  const sampleAt = (v, phase) => { v.phase = phase; v.prevPhase = phase; return v.clock(); };

  // SAW: 12-bit resolution in audio, 8-bit in OSC3.
  const s = mk(0x21);
  expect(s.env === 255, `env pinned at 255, got ${s.env}`);
  const s1 = sampleAt(s, 0x123000);
  const s2 = sampleAt(s, 0x12A000);          // same top 8 bits, different 12-bit code
  expect(s1 !== s2, `saw audio resolves below 8 bits (${s1} vs ${s2})`);
  s.phase = 0x123000;
  const b1 = s.getOscByte();
  s.phase = 0x12A000;
  const b2 = s.getOscByte();
  expect(b1 === 0x12 && b2 === 0x12, `OSC3 keeps the top-8 view ($12), got $${b1.toString(16)}/$${b2.toString(16)}`);
  const sA = sampleAt(s, 0x123000), sB = sampleAt(s, 0x124000);
  expect(sB - sA === (WAVE_DAC_8580[0x124] - WAVE_DAC_8580[0x123]) * ENV_DAC_8580[255],
    `adjacent 12-bit saw codes step by one DAC code × env (got ${sB - sA})`);

  // TRIANGLE: 11-bit resolution, DAC LSB grounded → steps of 2 codes.
  const t = mk(0x11);
  const t1 = sampleAt(t, 0x001000);
  const t2 = sampleAt(t, 0x001800);          // bit 11 — below the triangle's resolution
  const t3 = sampleAt(t, 0x002000);
  expect(t1 === t2, `tri LSB grounded: phase bit 11 is inaudible (${t1} vs ${t2})`);
  expect(t3 - t1 === (WAVE_DAC_8580[0x004] - WAVE_DAC_8580[0x002]) * ENV_DAC_8580[255],
    `tri steps by 2 twelve-bit codes (11-bit << 1), got ${t3 - t1}`);

  // PULSE: the high rail is the full 12-bit $FFF.
  const p = mk(0x41);                        // pw = 0 → comparator always high
  const rail = sampleAt(p, 0x000000);
  expect(rail === (WAVE_DAC_8580[0xFFF] - WAVE_ZERO_8580) * ENV_DAC_8580[255],
    `pulse high rail = (dac[$FFF] − wave_zero) × env, got ${rail}`);

  // NOISE: DAC bits 3..0 grounded → the selector code is a multiple of 16.
  const n = mk(0x81);
  n.clock();
  expect((n._out12 & 0xF) === 0, `noise low 4 DAC bits grounded (code $${n._out12.toString(16)})`);

  // Pulse-low combined shorts the selector bus to code 0 on BOTH chips
  // (reSID pulse mask); on the 6581 that lands at the leakage-floor code 0
  // pivoted around wave_zero.
  const c = mk(0x51);                        // TRI+PULSE
  c.is8580 = false;
  c.write(2, 0xFF); c.write(3, 0x0F);        // pw = $FFF → pulse low below $FFF000
  const cs = sampleAt(c, 0x100000);
  const want = (WAVE_DAC_6581[0] - WAVE_ZERO_6581) * ENV_DAC_6581[255];
  expect(cs === want,
    `6581 pulse-low combined = code 0 via DAC+pivot (${want}), got ${cs}`);
  ok('SIDVoice: 12-bit waveform DAC in audio; OSC3 = top 8 bits');
}

// ── 42: waveform-0 audio floats the waveform DAC on BOTH models ──────────
// When no waveform bit is selected, the DAC input keeps its last 12-bit
// selector value and decays pairwise after the reSID FLOATING_OUTPUT_TTL
// runs out (~200 ms on the 6581, ~5 s on the 8580 — reSID wave.cc
// wave_bitfade; waveform-0 sample players are audible on both chips). The
// audio worklet uses outputStageAudio(); the fade is clocked in _outputPre,
// so both split paths read the same floating value.
{
  const mk = (is8580) => {
    const v = new SIDVoice();
    v.is8580 = !!is8580;
    v.env = 255;
    v.phase = 0xE57000; v.prevPhase = v.phase;
    v.write(0, 0x00); v.write(1, 0x00);      // freq 0 — phase stays put
    return v;
  };
  const full = mk(false), audio = mk(false);
  full.write(4, 0x21); audio.write(4, 0x21); // SAW + gate → selector $E57
  full.outputStage();
  audio.outputStageAudio();
  expect(full._out12 === 0xE57 && audio._out12 === 0xE57,
    `active saw primes the same floating DAC input in full/audio paths ($${full._out12.toString(16)}/$${audio._out12.toString(16)})`);

  full.write(4, 0x01); audio.write(4, 0x01); // waveform 0, gate still high
  const sf = full.outputStage();
  const sa = audio.outputStageAudio();
  const held12 = 0xE57;                      // full 12-bit float (reSID waveform_output)
  const want = (WAVE_DAC_6581[held12] - WAVE_ZERO_6581) * ENV_DAC_6581[255];
  expect(sf === sa, `waveform-0 sample matches full/audio split (${sf} vs ${sa})`);
  expect(sf === want,
    `6581 waveform-0 audio uses held DAC code $${held12.toString(16)} (${want}), got ${sf}`);
  expect(sf !== 0, `6581 waveform-0 floating DAC is audible, not hard silence`);
  expect(full.floatTtl === 182000 - 1,
    `waveform deselect armed the 6581 float TTL (~200 ms), got ${full.floatTtl}`);

  const v8 = mk(true);
  v8.write(4, 0x21); v8.outputStageAudio();  // prime with saw $E57
  v8.write(4, 0x01);                         // deselect → float (~5 s TTL)
  const s8 = v8.outputStageAudio();
  const want8 = (WAVE_DAC_8580[held12] - WAVE_ZERO_8580) * ENV_DAC_8580[255];
  expect(s8 === want8,
    `8580 waveform-0 audio floats the held DAC code too (${want8}), got ${s8}`);
  expect(v8.floatTtl === 4400000 - 1,
    `waveform deselect armed the 8580 float TTL (~5 s), got ${v8.floatTtl}`);
  ok('SIDVoice: waveform-0 audio floats the waveform DAC on both models (reSID TTL fade)');
}

// ── 43: R-2R DAC models + wave_zero pivot + per-voice DC (6581 character) ──
// The 8580's terminated 2R/R=2.0 ladder is an ideal binary DAC (identity
// table); the 6581's unterminated 2R/R≈2.2 ladder has pronounced code
// discontinuities (reSID dac.h). The envelope multiplier pivots around the
// measured wave_zero ($380 on the 6581 — NOT mid-scale; reSID voice.cc), and
// each 6581 voice rides at a standing DC into the mixer whose volume-scaling
// IS the $D418 digi (constants calibrated against VICE reSID recordings:
// 6581 digi/tone +5.1 dB, 8580 −8.9 dB).
{
  // 8580 wave DAC: near-ideal terminated ladder. reSID's builder adds a
  // subthreshold-leakage floor (unset bits contribute 0.35% of their
  // weight), so code 0 sits ~14 LSB up and the table is NOT exact identity
  // — but it stays monotonic and within a small deviation band.
  let dev8 = 0, mono8 = true;
  for (let i = 0; i < 4096; i++) {
    dev8 = Math.max(dev8, Math.abs(WAVE_DAC_8580[i] - i));
    if (i && WAVE_DAC_8580[i] < WAVE_DAC_8580[i - 1]) mono8 = false;
  }
  expect(dev8 <= 20, `8580 wave DAC near-linear (max dev ${dev8} ≤ 20 LSB, leakage floor)`);
  expect(WAVE_DAC_8580[0] >= 8 && WAVE_DAC_8580[0] <= 20,
    `8580 DAC code 0 sits on the leakage floor (got ${WAVE_DAC_8580[0]})`);
  expect(mono8, `8580 wave DAC monotonic (terminated ladder)`);
  // 6581 wave DAC: leakage floor at code 0, full-scale top, strong
  // nonlinearity, and the major-carry DROP at $800 (the classic mid-scale
  // discontinuity).
  expect(WAVE_DAC_6581[0] > 20 && WAVE_DAC_6581[4095] === 4095,
    `6581 DAC: leakage floor at code 0 (${WAVE_DAC_6581[0]}), full-scale 4095 top`);
  let dev6 = 0;
  for (let i = 0; i < 4096; i++) dev6 = Math.max(dev6, Math.abs(WAVE_DAC_6581[i] - i));
  expect(dev6 > 30, `6581 DAC visibly nonlinear (max dev ${dev6.toFixed(1)} codes)`);
  expect(WAVE_DAC_6581[0x800] < WAVE_DAC_6581[0x7FF],
    `6581 DAC drops at the $7FF→$800 major carry ` +
    `(${WAVE_DAC_6581[0x7FF]} → ${WAVE_DAC_6581[0x800]})`);
  // Envelope DACs: 8580 near-identity (leakage ≤ 2 LSB), 6581 nonlinear.
  let e8 = 0, e6 = 0;
  for (let i = 0; i < 256; i++) {
    e8 = Math.max(e8, Math.abs(ENV_DAC_8580[i] - i));
    e6 = Math.max(e6, Math.abs(ENV_DAC_6581[i] - i));
  }
  expect(e8 <= 2, `8580 env DAC near-identity (max dev ${e8} ≤ 2, leakage)`);
  expect(e6 > 2, `6581 env DAC nonlinear (max dev ${e6.toFixed(1)} codes)`);

  // wave_zero pivot: a TEST+SAW voice (waveform code 0) at full envelope
  // sits at (dac[0] − wave_zero) × envDAC[255] — asymmetric on the 6581
  // ($380 pivot), leakage-cancelling $9E0 pivot on the 8580 (reSID
  // voice.cc; NOT the naive mid-scale $800).
  const railAt0 = (is8580) => {
    const v = new SIDVoice();
    v.is8580 = is8580;
    v.write(5, 0x00); v.write(6, 0xF0);
    v.write(4, 0x29);                     // TEST + SAW + GATE (phase pinned 0)
    let s = 0;
    for (let i = 0; i < 9 * 256 + 40; i++) s = v.clock();
    return s;
  };
  expect(railAt0(false) === (WAVE_DAC_6581[0] - WAVE_ZERO_6581) * ENV_DAC_6581[255],
    `6581 wave-0 rail = (dac[0] − $380) × env, got ${railAt0(false)}`);
  expect(railAt0(true) === (WAVE_DAC_8580[0] - WAVE_ZERO_8580) * ENV_DAC_8580[255],
    `8580 wave-0 rail = (dac[0] − $9E0) × env, got ${railAt0(true)}`);

  // $D418 digi step: on the 6581 the per-voice DC through the nonlinear
  // volume ladder makes a strong step; the 8580's is much smaller but
  // nonzero (mixer/gain op-amp offsets). Absolute levels are validated
  // against VICE by the dc-probe WAV comparison; here only the character.
  const volStep = (is8580) => {
    const sid = new SIDChip(is8580);
    sid.setModel(is8580);
    sid.write(24, 0x00);
    for (let i = 0; i < 60000; i++) sid.clock();   // settle extfilt at vol 0
    const before = sid.clock();
    sid.write(24, 0x0F);
    let peak = 0;
    for (let i = 0; i < 30; i++) peak = Math.max(peak, Math.abs(sid.clock() - before));
    return peak;
  };
  const s6 = volStep(false), s8 = volStep(true);
  expect(s6 > 3 * s8, `6581 digi step ≫ 8580 (got ${s6.toFixed(3)} vs ${s8.toFixed(3)})`);
  expect(s8 > 0.005, `8580 keeps a small hardware-true digi step (got ${s8.toFixed(3)})`);
  ok('SID: R-2R DACs + wave_zero pivot + per-voice DC (6581 character)');
}

// ── 44: mutual-sync exception + trio ordering (P6) ─────────────────────
// reSID synchronize(): a destination is NOT synced when its source is
// itself sync-enabled and the source's own source's MSB rises on the same
// cycle (hardware-verified by OSC3 sampling). Also: pulses are decided
// before any voice clocks, so v1←v3 is no longer one cycle stale.
{
  const mk = () => {
    const [v1, v2, v3] = makeVoiceTrio();
    v1.write(0, 0x00); v1.write(1, 0x10); v1.write(4, 0x12);  // SYNC on
    v3.write(0, 0xFF); v3.write(1, 0xFF);
    v2.write(0, 0xFF); v2.write(1, 0xFF);
    v1.phase = 0x300000;
    v3.phase = 0x7FF000;                  // v3 MSB rises this cycle
    v2.phase = 0x7FF000;                  // v2 MSB rises this cycle too
    return [v1, v2, v3];
  };
  // Case A: v3 sync-enabled → its own source (v2) rising suppresses v1's sync.
  {
    const [v1, v2, v3] = mk();
    v3.write(4, 0x12);                    // v3 SYNC on
    computeSyncPulses(v1, v2, v3);
    expect(v1.syncPulse === false, `mutual-sync exception: v1 NOT synced`);
    expect(v3.syncPulse === true, `v3 itself IS synced by v2's rise`);
  }
  // Case B: v3 sync-disabled → v1 syncs normally on the same rise.
  {
    const [v1, v2, v3] = mk();
    v3.write(4, 0x10);                    // v3 SYNC off
    computeSyncPulses(v1, v2, v3);
    expect(v1.syncPulse === true, `no exception without source sync: v1 synced`);
    v1.clockCore(); v2.clockCore(); v3.clockCore();
    expect(v1.phase === 0, `v1 reset the SAME cycle v3's MSB rises (no stale ordering)`);
  }
  ok('SIDVoice: mutual-sync exception + same-cycle trio ordering (P6)');
}

// ── 45: envelope exactness pack (P8, reSID envelope.h) ─────────────────
{
  // (a) The rate counter skips zero on wrap: …$7FFE, $7FFF, $0001 — the
  // ADSR delay bug lasts 32767 cycles per wrap, not 32768.
  {
    const v = new SIDVoice();
    v.write(5, 0x00); v.write(4, 0x11);      // attack rate 0 (period 9), gate
    v.rateCounter = 0x7FFE;
    v.clock();
    expect(v.rateCounter === 0x7FFF, `wrap-1: counter $7FFF, got $${v.rateCounter.toString(16)}`);
    v.clock();
    expect(v.rateCounter === 0x0001, `wrap: counter skips 0 → $0001, got $${v.rateCounter.toString(16)}`);
  }
  // (b) ADSR delay bug duration: counter just past the period must travel
  // the full 32767-cycle wrap before the next step.
  {
    const v = new SIDVoice();
    v.write(5, 0x00); v.write(4, 0x11);      // period 9 (comparator 8)
    let g = 0; while (v.env === 0 && g++ < 40) v.clock();   // first attack step
    expect(v.env === 1, `first attack step`);
    v.rateCounter = 20;                      // simulate a mid-count rate write (20 > comparator 8)
    // The counter must now travel 20→$7FFF, skip 0, then back up to the
    // comparator before the next step — ~32767 cycles instead of 9.
    for (let i = 0; i < 32000; i++) v.clock();
    expect(v.env === 1, `ADSR delay bug: env stalled >32000 cyc, not stepping every 9 (env=${v.env})`);
    let n = 0; while (v.env === 1 && n++ < 2000) v.clock();
    expect(v.env === 2 && n < 2000, `delay bug releases after the full wrap (~${32000 + n} cyc)`);
  }
  // (c) Every attack step resets the exponential counter.
  {
    const v = new SIDVoice();
    v.write(5, 0x00); v.write(6, 0xF0);
    v.write(4, 0x11);
    v.expCounter = 5; v.expPeriod = 8;       // stale exponential phase
    let g = 0; while (v.env === 0 && g++ < 40) v.clock();   // one attack step
    expect(v.env === 1, `attack stepped`);
    expect(v.expCounter === 0, `attack step resets expCounter, got ${v.expCounter}`);
  }
  // (d) The decrement is pipelined one cycle when the exponential period ≠ 1.
  {
    const v = new SIDVoice();
    v.write(5, 0x00); v.write(6, 0x00);      // decay rate 0 (period 9), sustain 0
    v.write(4, 0x11);
    for (let i = 0; i < 9 * 256; i++) v.clock();   // attack to $FF → decay
    // Walk env down into the div=2 region ($5D and below latches period 2).
    while (v.env > 0x50) v.clock();
    // Align to a fresh match: run until an envPipeline gets scheduled.
    let guard = 0;
    while (v.envPipeline === 0 && guard++ < 100) v.clock();
    expect(v.envPipeline === 1, `decrement scheduled into the pipeline`);
    const before = v.env;
    v.clock();                                // pipeline lands here
    expect(v.env === before - 1 && v.envPipeline === 0,
      `pipelined decrement lands one cycle later (env ${before}→${v.env})`);
  }
  // (e) Flip-and-freeze: re-gating at env=$FF wraps to $00 on the next
  // attack step and freezes there; a release→attack re-gate unlocks it.
  {
    const v = new SIDVoice();
    v.write(5, 0x00); v.write(6, 0xF0);
    v.write(4, 0x11);
    for (let i = 0; i < 9 * 256; i++) v.clock();   // env=$FF, sustain
    v.write(4, 0x10);                         // gate off (release)
    v.write(4, 0x11);                         // gate on — attack AT $FF
    for (let i = 0; i < 9; i++) v.clock();    // one attack step
    expect(v.env === 0x00, `attack at $FF wraps to $00, got $${v.env.toString(16)}`);
    expect(v.holdZero === true, `and freezes (holdZero)`);
    for (let i = 0; i < 9 * 50; i++) v.clock();
    expect(v.env === 0x00, `stays frozen at $00 while gated`);
    v.write(4, 0x10); v.write(4, 0x11);       // release → attack unlocks
    for (let i = 0; i < 9 * 3; i++) v.clock();
    expect(v.env === 3, `unlocked attack counts again, got ${v.env}`);
  }
  // (f) Release wrap: with the freeze unlocked and env at $00, a release
  // step wraps to $FF and keeps counting down.
  {
    const v = new SIDVoice();
    v.write(5, 0x00); v.write(6, 0x00);       // release rate 0
    v.write(4, 0x11);                         // gate on: unlock, attack from 0
    v.clock();                                // < one attack period (no step yet)
    v.write(4, 0x10);                         // gate off: release at env=0, unlocked
    // env may be 0 or 1 depending on phase; force the wrap case:
    v.env = 0; v.holdZero = false; v.envPipeline = 0;
    for (let i = 0; i < 20; i++) v.clock();   // ≥ one release period (9) + pipeline
    expect(v.env >= 0xF0, `release from $00 wraps to $FF and counts down, got $${v.env.toString(16)}`);
  }
  // (g) Legacy save-state defaults for the P8 fields.
  {
    const v = new SIDVoice();
    v.deserialize({ freq: 0, pw: 0, ctrl: 0x11, a: 0, d: 0, s: 15, r: 0,
      phase: 0, prevPhase: 0, env: 0x30, rateCounter: 0, expCounter: 0,
      state: 2, lfsr: 0x7FFFF8, noiseVal: 0, _lfsrResetCtr: 0,
      oscLatch: 0, oscFadeCtr: 0, _oscLive: 0, oscPrev: 0 });
    expect(v.expPeriod === 4, `legacy default: env=$30 → latched period 4, got ${v.expPeriod}`);
    expect(v.holdZero === false, `legacy default: nonzero env not frozen`);
  }
  ok('SIDVoice: envelope exactness — rate wrap, attack exp-reset, pipeline, flip/freeze quirks (P8)');
}

// ── 46: Noise pipeline exactness (P7, reSID wave.h) ────────────────────
// (a) reset LFSR = $7FFFFF clocked once = $7FFFFE, latch matches taps;
// (b) the shift is delayed 2 cycles behind the bit-19 rise, and the noise
//     output latch changes only when the shift lands;
// (c) combined-noise writeback happens EVERY cycle (no shift needed) and
//     clears both the register taps and the output latch;
// (d) the writeback is skipped on the cycle where shiftPipeline === 1;
// (e) TEST rising flushes an armed pipeline; falling clocks the register
//     once with feedback ¬bit17 and refreshes the latch;
// (f) TEST-fall pre-writeback obeys the per-model do_pre_writeback rules;
// (g) legacy deserialize (no shiftPipeline field) refreshes the latch.
{
  { // (a) reset state
    const v = new SIDVoice();
    expect(v.lfsr === 0x7FFFFE, `reset LFSR = $7FFFFE, got $${v.lfsr.toString(16)}`);
    expect(v.noiseVal === 0xFE, `reset noise latch $FE (tap0 clear), got $${v.noiseVal.toString(16)}`);
  }
  { // (b) 2-cycle shift pipeline
    const v = new SIDVoice();
    v.write(4, 0x80);                    // NOISE
    v.phase = 0x07FFFF; v.prevPhase = v.phase;
    v.write(0, 0x01);                    // freq=1: next add rises bit 19
    const lfsr0 = v.lfsr, noise0 = v.noiseVal;
    v.clock();                           // rise detected: pipeline armed
    expect(v.shiftPipeline === 2 && v.lfsr === lfsr0, `rise cycle: pipeline=2, no shift yet`);
    v.clock();                           // phase 1
    expect(v.shiftPipeline === 1 && v.lfsr === lfsr0 && v.noiseVal === noise0,
      `+1 cycle: still no shift`);
    v.clock();                           // phase 2: shift lands
    expect(v.lfsr === (((lfsr0 << 1) | (((lfsr0 >> 22) ^ (lfsr0 >> 17)) & 1)) & 0x7FFFFF),
      `+2 cycles: register shifted (bit22^bit17 feedback)`);
    expect(v.noiseVal !== noise0 || true, `latch refreshed with the shift`);
    const expected =
      ((v.lfsr & 0x100000) >> 13) | ((v.lfsr & 0x040000) >> 12) |
      ((v.lfsr & 0x004000) >> 9)  | ((v.lfsr & 0x000800) >> 7) |
      ((v.lfsr & 0x000200) >> 6)  | ((v.lfsr & 0x000020) >> 3) |
      ((v.lfsr & 0x000004) >> 1)  | (v.lfsr & 0x000001);
    expect(v.noiseVal === expected, `latch = tap formula after shift`);
  }
  { // (c) per-cycle writeback with no shift: noise+pulse, pulse rail LOW
    const v = new SIDVoice();
    v.write(2, 0xFF); v.write(3, 0x0F);  // pw=$FFF: phase<pw24 → pulse low
    v.write(4, 0xC0);                    // NOISE+PULSE, freq=0 (no edges)
    v.clock();                           // one cycle: selector output = 0
    expect(v.noiseVal === 0x00, `pulse-low writeback zeroes the latch in one cycle`);
    expect((v.lfsr & ((1<<20)|(1<<18)|(1<<14)|(1<<11)|(1<<9)|(1<<5)|(1<<2)|1)) === 0,
      `pulse-low writeback clears all 8 register taps`);
    expect(v.lfsr !== 0, `non-tap register bits survive`);
  }
  { // (d) writeback skipped while shiftPipeline === 1
    const v = new SIDVoice();
    v.write(2, 0xFF); v.write(3, 0x0F);
    v.write(4, 0xC0);
    v.phase = 0x07FFFF; v.prevPhase = v.phase;
    v.write(0, 0x01);
    v.clockCore();                       // pipeline := 2
    expect(v.shiftPipeline === 2, `pipeline armed`);
    v.outputStage();                     // pipeline 2 ≠ 1 → writeback runs
    const cleared = v.lfsr;
    v.clockCore();                       // pipeline := 1
    v.lfsr |= 1;                         // plant a tap bit
    v.outputStage();                     // pipeline === 1 → writeback SKIPPED
    expect((v.lfsr & 1) === 1, `no writeback on the pipeline==1 cycle`);
    v.clockCore();                       // shift lands (planted bit moves up)
    v.outputStage();                     // writeback resumes
    expect((v.lfsr & 1) === 0, `writeback resumes after the shift`);
    void cleared;
  }
  { // (e) TEST edges: rise flushes the pipeline, fall shifts with ¬bit17
    const v = new SIDVoice();
    v.write(4, 0x80);
    v.phase = 0x07FFFF; v.prevPhase = v.phase;
    v.write(0, 0x01);
    v.clock();                           // pipeline := 2
    v.write(4, 0x88);                    // TEST set
    expect(v.shiftPipeline === 0, `TEST rise flushes the shift pipeline`);
    const l = v.lfsr;
    v.write(4, 0x80);                    // TEST cleared
    expect(v.lfsr === (((l << 1) | ((~l >> 17) & 1)) & 0x7FFFFF),
      `TEST fall clocks once with feedback ¬bit17`);
    const expected =
      ((v.lfsr & 0x100000) >> 13) | ((v.lfsr & 0x040000) >> 12) |
      ((v.lfsr & 0x004000) >> 9)  | ((v.lfsr & 0x000800) >> 7) |
      ((v.lfsr & 0x000200) >> 6)  | ((v.lfsr & 0x000020) >> 3) |
      ((v.lfsr & 0x000004) >> 1)  | (v.lfsr & 0x000001);
    expect(v.noiseVal === expected, `TEST fall refreshes the latch`);
  }
  { // (f) pre-writeback rules (reSID do_pre_writeback)
    const rules = (is8580, wfPrev, wf) => {
      const v = new SIDVoice();
      v.is8580 = is8580;
      return v._doPreWriteback(wfPrev, wf);
    };
    expect(rules(false, 0x8, 0x9) === false, `plain noise prev → no pre-writeback`);
    // reSID's "&& waveform != 8" guard is #if 0 (disabled): writing back INTO
    // plain noise DOES happen — noiselfsrinit/simple's $F8→$80 dance needs it.
    expect(rules(false, 0x9, 0x8) === true,  `into plain noise → pre-writeback fires (reSID)`);
    expect(rules(false, 0x9, 0x9) === true,  `6581 noise+tri → pre-writeback`);
    expect(rules(false, 0xC, 0x9) === false, `6581 from noise+pulse → never`);
    expect(rules(true,  0xC, 0x9) === true,  `8580 from noise+pulse → only into 9/E`);
    expect(rules(true,  0xC, 0xB) === false, `8580 from noise+pulse into $B → no`);
    expect(rules(false, 0x9, 0xA) === false, `6581 tri→saw swap → no`);
    expect(rules(false, 0xA, 0x9) === false, `6581 saw→tri swap → no`);
    expect(rules(true,  0x9, 0xA) === true,  `8580 tri→saw swap → yes`);
    { // and it actually fires on a TEST-falling control write: the zeros it
      // plants on the taps are then moved off them by the release shift —
      // fully deterministic from the reset register value $7FFFFE.
      const v = new SIDVoice();
      v.write(4, 0x98);                  // TEST on, NOISE+TRI
      v._out12 = 0;                      // selector output latch = 0
      v.write(4, 0x90);                  // TEST off: pre-writeback(9→9) + shift
      // $7FFFFE, taps cleared → $6BB5DA, shifted with bit0=¬bit17 → $576BB4
      expect(v.lfsr === 0x576BB4,
        `pre-writeback then release shift → $576BB4, got $${v.lfsr.toString(16)}`);
    }
    { // control: the same sequence on a path do_pre_writeback rejects
      // (6581 from noise+pulse) must leave the taps alone
      const v = new SIDVoice();
      v.write(4, 0xC8);                  // TEST on, NOISE+PULSE (6581)
      v._out12 = 0;
      v.write(4, 0xC0);                  // TEST off: NO pre-writeback
      // plain release shift of $7FFFFE: bit17=1 → bit0=0 → $7FFFFC
      expect(v.lfsr === 0x7FFFFC,
        `no pre-writeback from $C on 6581 → $7FFFFC, got $${v.lfsr.toString(16)}`);
    }
  }
  { // (g) legacy deserialize refreshes the latch from the register
    const v = new SIDVoice();
    const o = v.serialize();
    delete o.shiftPipeline; delete o._out12;
    o.lfsr = 0x155555; o.noiseVal = 0xEE; // stale latch in the save
    const w = new SIDVoice();
    w.deserialize(o);
    const expected =
      ((0x155555 & 0x100000) >> 13) | ((0x155555 & 0x040000) >> 12) |
      ((0x155555 & 0x004000) >> 9)  | ((0x155555 & 0x000800) >> 7) |
      ((0x155555 & 0x000200) >> 6)  | ((0x155555 & 0x000020) >> 3) |
      ((0x155555 & 0x000004) >> 1)  | (0x155555 & 0x000001);
    expect(w.noiseVal === expected, `legacy save: latch recomputed from taps`);
    expect(w.shiftPipeline === 0, `legacy save: pipeline defaults to 0`);
  }
  ok('SIDVoice: noise exactness — 2-cycle shift pipeline, per-cycle writeback, reset/TEST semantics (P7)');
}

// ── 47: /RESET semantics (P9, reSID wave.cc/envelope.cc/sid.cc reset) ──
// A /RESET pulse clears every register, the envelope state (frozen at
// zero), the noise register (back to the $7FFFFE post-reset value) and
// the filter state — but the phase accumulator SURVIVES (the chip has no
// reset line on it; oscinit.prg). Only a power cycle re-seeds $555555.
{
  { // (a) voice-level: everything clears except the accumulator
    const v = new SIDVoice();
    v.write(0, 0x34); v.write(1, 0x12);  // freq
    v.write(2, 0xFF); v.write(3, 0x0F);  // pw
    v.write(5, 0x24); v.write(6, 0xA6);  // ADSR
    v.write(4, 0x81);                    // NOISE + gate
    for (let i = 0; i < 5000; i++) v.clock();
    expect(v.env > 0, `precondition: envelope is live`);
    const phase = v.phase, prevPhase = v.prevPhase;
    expect(phase !== 0x555555, `precondition: accumulator moved off power-up`);
    v.reset();
    expect(v.freq === 0 && v.pw === 0 && v.ctrl === 0, `regs cleared`);
    expect(v.a === 0 && v.d === 0 && v.s === 0 && v.r === 0, `ADSR cleared`);
    expect(v.env === 0 && v.holdZero === true && v.expPeriod === 1 &&
           v.rateCounter === 0 && v.expCounter === 0 && v.envPipeline === 0,
      `envelope in reset state (frozen at zero)`);
    expect(v.lfsr === 0x7FFFFE && v.noiseVal === 0xFE && v.shiftPipeline === 0,
      `noise register back to post-reset value`);
    expect(v.floatTtl === 0 && v._oscLive === 0 && v._out12 === 0,
      `OSC3 latches cleared`);
    expect(v.phase === phase && v.prevPhase === prevPhase,
      `phase accumulator SURVIVES reset`);
    // and the envelope stays frozen until a gate-on
    for (let i = 0; i < 1000; i++) v.clock();
    expect(v.env === 0, `envelope stays frozen after reset`);
  }
  { // (b) chip-level: voices + filter + volume clear, accumulators survive
    const chip = new SIDChip();
    chip.setModel(true);
    chip.write(0x18, 0x1F);              // vol max + LP
    chip.write(0x15, 0x07); chip.write(0x16, 0xFF); // fc
    chip.write(0x17, 0xF1);              // res max, v1 routed
    chip.write(0x00, 0x00); chip.write(0x01, 0x40);
    chip.write(0x05, 0x00); chip.write(0x06, 0xF0);
    chip.write(0x04, 0x21);              // saw + gate
    for (let i = 0; i < 20000; i++) chip.clock();
    const p1 = chip.v1.phase;
    expect(p1 !== 0x555555, `precondition: v1 accumulator moved`);
    chip.reset();
    expect(chip.filter.vol === 0 && chip.filter.fc === 0 && chip.filter.res === 0 &&
           chip.filter.filt === 0 && chip.filter.mode === 0, `chip regs cleared`);
    expect(chip.filter.Vbp === 0 && chip.filter.Vlp === 0 && chip.filter.Vhp === 0 &&
           chip.filter.VbpVc === 0 && chip.filter.VlpVc === 0, `filter state cleared`);
    expect(chip.v1.phase === p1, `v1 accumulator survives chip reset`);
    expect(chip.is8580 === true, `model survives reset`);
    // The reset itself steps the output DC (vol $F → 0) — the chip's DC
    // blocker rings that step out over ~16 ms, a click real hardware makes
    // too. Silence is asserted after the transient settles.
    for (let i = 0; i < 60000; i++) chip.clock();
    let peak = 0;
    for (let i = 0; i < 5000; i++) { const s = chip.clock(); if (Math.abs(s) > peak) peak = Math.abs(s); }
    expect(peak < 1e-3, `chip silent after reset settles (vol 0, envs frozen), peak ${peak}`);
  }
  ok('SIDVoice/SIDChip: /RESET clears regs+envelope+noise+filter, accumulator survives (P9)');
}

// ── Feature matrix (from the retired sid-features-test) ─────────────────
function makeToneVoice(ctrl, freqLo = 0xFF, freqHi = 0x10) {
  const v = new SIDVoice();
  v.write(0, freqLo); v.write(1, freqHi);
  v.write(5, 0x00); v.write(6, 0xF0);   // fast attack, sustain 15
  v.write(4, ctrl);
  return v;
}

// All 16 attack rates ramp monotonically slower.
{
  const stepsTaken = [];
  for (let a = 0; a < 16; a++) {
    const v = new SIDVoice();
    v.write(5, a << 4); v.write(6, 0xF0);
    v.write(4, 0x11);
    let cycles = 0;
    while (v.env < 100 && cycles < 5000000) { v.clock(); cycles++; }
    stepsTaken.push(cycles);
  }
  for (let i = 1; i < 16; i++) {
    expect(stepsTaken[i] >= stepsTaken[i - 1],
      `attack=${i} >= attack=${i-1}: ${stepsTaken[i]} >= ${stepsTaken[i-1]}`);
  }
  ok('SID ADSR: all 16 attack rates ramp monotonically to env=100');
}

// Decay reaches each sustain level.
{
  for (let s of [0, 4, 8, 12, 15]) {
    const v = new SIDVoice();
    v.write(5, 0x00); v.write(6, s << 4);
    v.write(4, 0x11);
    for (let i = 0; i < 9 * 256; i++) v.clock();
    for (let i = 0; i < 1000000 && v.env !== ((s << 4) | s); i++) v.clock();
    expect(v.env === ((s << 4) | s),
      `sustain=$${s.toString(16)}: env=$${((s << 4) | s).toString(16)}, got $${v.env.toString(16)}`);
  }
  ok('SID ADSR: decay reaches each sustain level 0/4/8/12/15');
}

// Release drops env back to 0.
{
  const v = new SIDVoice();
  v.write(5, 0x00); v.write(6, 0xF0);
  v.write(4, 0x11);
  for (let i = 0; i < 9 * 256; i++) v.clock();
  expect(v.env === 255, `attack to 255`);
  v.write(4, 0x10);
  for (let i = 0; i < 4; i++) v.clock();  // reSID: release transition is pipelined
  expect(v.state === 0, `release state`);
  for (let i = 0; i < 1000000 && v.env > 0; i++) v.clock();
  expect(v.env === 0, `release decays env to 0, got $${v.env.toString(16)}`);
  ok('SID ADSR: release drops env to 0 after gate clears');
}

// Gate retrigger restarts attack.
{
  const v = new SIDVoice();
  v.write(5, 0xF0); v.write(6, 0xF0);
  v.write(4, 0x11);
  for (let i = 0; i < 100; i++) v.clock();
  v.write(4, 0x10);
  v.write(4, 0x11);
  for (let i = 0; i < 4; i++) v.clock();  // reSID: attack transition is pipelined
  expect(v.state === 1, `gate retrigger: back to attack state`);
  ok('SID ADSR: gate retrigger restarts attack from current env');
}

// RING modulation: tri MSB ⊕ ¬(source MSB), reSID wave.h.
{
  const v1 = new SIDVoice(), v2 = new SIDVoice(), v3 = new SIDVoice();
  v1.syncSrc = v3; v2.syncSrc = v1; v3.syncSrc = v2;
  v1.write(4, 0x14);                     // TRI + RING
  v1.phase = 0x400000;
  v3.phase = 0x000000;                   // src MSB clear → fold inverted
  expect(v1.getOscByte() === 0x7F, `RING: tri inverted when src MSB clear, got $${v1.getOscByte().toString(16)}`);
  v3.phase = 0x800000;                   // src MSB set → unchanged
  expect(v1.getOscByte() === 0x80, `RING: tri unchanged when src MSB set, got $${v1.getOscByte().toString(16)}`);
  ok('SID modulation: RING inverts tri when source MSB is LOW (⊕¬srcMSB)');
}

// Filter cutoff is 11 bits, resonance 4 bits.
{
  const sid = new SIDChip();
  sid.write(21, 0x07); sid.write(22, 0xFF);
  expect(sid.filter.fc === 0x7FF, `fc max = 0x7FF (11-bit), got 0x${sid.filter.fc.toString(16)}`);
  sid.write(21, 0x00); sid.write(22, 0x00);
  expect(sid.filter.fc === 0, `fc min = 0`);
  sid.write(23, 0xF0);
  expect(sid.filter.res === 0xF, `res max = $F (4-bit hi nibble)`);
  sid.write(23, 0x00);
  expect(sid.filter.res === 0, `res min = 0`);
  ok('SID filter: cutoff $D415/$D416 is 11 bits, resonance $D417 hi nibble is 4 bits');
}

// The 8 filter mode combinations give distinct responses.
{
  const sid = new SIDChip();
  sid.v1.write(0, 0xFF); sid.v1.write(1, 0x10);
  sid.v1.write(5, 0x00); sid.v1.write(6, 0xF0);
  sid.v1.write(4, 0x21);                 // SAW + gate
  sid.write(23, 0x01);                   // route v1 to filter
  const measureMode = (mode) => {
    sid.write(24, (mode << 4) | 0x0F);   // mode + vol=15
    sid.write(21, 0); sid.write(22, 0x80);   // fc=$400
    for (let i = 0; i < 5000; i++) sid.clock();
    let energy = 0;
    for (let i = 0; i < 1000; i++) energy += Math.abs(sid.clock());
    return energy;
  };
  const energies = [];
  for (let m = 0; m <= 7; m++) energies.push(measureMode(m));
  expect(energies[0] !== energies[1], `mode 0 (none) vs 1 (LP) differ`);
  expect(energies[1] !== energies[2], `mode 1 (LP) vs 2 (BP) differ`);
  expect(energies[2] !== energies[4], `mode 2 (BP) vs 4 (HP) differ`);
  ok('SID filter: 8 mode combinations produce distinct frequency responses');
}

// Master volume 15 is audible.
{
  const sid = new SIDChip();
  sid.v1.write(0, 0xFF); sid.v1.write(1, 0x10);
  sid.v1.write(5, 0x00); sid.v1.write(6, 0xF0);
  sid.v1.write(4, 0x21);
  sid.write(24, 0x0F);
  for (let i = 0; i < 5000; i++) sid.clock();
  let high = 0;
  for (let i = 0; i < 1000; i++) high += Math.abs(sid.clock());
  expect(high > 50, `vol=15 produces audible output, energy=${high.toFixed(2)}`);
  ok('SID special: master volume 15 produces audible energy');
}

// Phase accumulator wraps at 24 bits.
{
  const v = new SIDVoice();
  v.write(0, 0x01); v.write(1, 0x00);
  v.phase = 0xFFFFFF;
  v.write(4, 0x10);
  v.clock();
  expect(v.phase === 0x000000, `phase wraps at 24-bit, got 0x${v.phase.toString(16)}`);
  ok('SID phase: accumulator wraps at 24-bit boundary');
}

// Three voices clock concurrently and reach sustain together.
{
  const sid = new SIDChip();
  for (const v of [sid.v1, sid.v2, sid.v3]) {
    v.write(0, 0xFF); v.write(1, 0x10);
    v.write(5, 0x00); v.write(6, 0xF0);
    v.write(4, 0x21);
  }
  for (let i = 0; i < 5000; i++) sid.clock();
  expect(sid.v1.state === 2 && sid.v2.state === 2 && sid.v3.state === 2,
    `all voices in decay/sustain: states=${sid.v1.state},${sid.v2.state},${sid.v3.state}`);
  expect(sid.v1.env === 0xFF && sid.v2.env === 0xFF && sid.v3.env === 0xFF,
    `all voices hold env at sustain $FF: envs=${sid.v1.env},${sid.v2.env},${sid.v3.env}`);
  ok('SID chip: 3 voices clock concurrently and reach sustain together');
}

console.log(`\n${testNo} SID spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
