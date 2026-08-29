// sid-shadow-spec-test.js — Locks down the cycle-exact $D41B / $D41C
// shadow on the main thread. The shadow SID voices in C64Machine are
// clocked alongside sidCycleCounter so demos that read OSC3/ENV3 in
// tight loops see the same byte the worklet would have emitted at
// that same simulated cycle. Latency-bound shared-buffer reads
// (previous behavior) smeared cycle-precise tricks.

import { C64Machine } from '../src/machine.js';
import { SIDVoice, makeVoiceTrio } from '../src/sid-voice.js';

let testNo = 0, fails = 0, current = [];
function expect(cond, msg) { if (!cond) current.push(msg); }
function ok(label) {
  testNo++;
  if (current.length === 0) console.log(`ok  - test ${testNo}: ${label}`);
  else {
    fails++;
    console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of current) console.log(`     - ${m}`);
    current = [];
  }
}

// Helper: build a C64Machine without bringing up the full ROM/CPU.
// We only need the SID write path + shadow voice clocking.
function makeMachine() {
  const m = new C64Machine();
  return m;
}

// Helper: run a fresh standalone SIDVoice trio for the same number of
// cycles with the same writes, and return v3's state. The shadow in
// C64Machine should match this byte-for-byte.
function runReferenceVoices(writes, totalCycles) {
  const [v1, v2, v3] = makeVoiceTrio();
  const voices = [v1, v2, v3];
  for (let cy = 0; cy <= totalCycles; cy++) {
    // Apply any writes due at this cycle, *before* clocking — matches
    // the order in C64Machine: writes go through _sidWrite (which calls
    // voice.write) before the next _runMasterCycle.
    for (const w of writes) if (w.cycle === cy) {
      const r = w.reg & 0x1F;
      if (r < 7)       v1.write(r, w.val);
      else if (r < 14) v2.write(r - 7, w.val);
      else if (r < 21) v3.write(r - 14, w.val);
    }
    if (cy < totalCycles) {
      v1.clock(); v2.clock(); v3.clock();
    }
  }
  return { osc3: v3.getOscByte(), env3: v3.env, lfsr: v3.lfsr, phase: v3.phase };
}

// Helper: drive C64Machine's shadow by calling _runMasterCycle directly
// and _sidWrite at the specified cycles. Returns the shadow v3 state.
function runShadow(machine, writes, totalCycles) {
  for (let cy = 0; cy < totalCycles; cy++) {
    for (const w of writes) if (w.cycle === cy) machine._sidWrite(w.reg, w.val);
    // _runMasterCycle does a lot more than just shadow clocks (CIA, VIC,
    // CPU) — but those should be no-ops or harmless when ready=false.
    // For determinism, only step the shadow voices directly here.
    machine.shadowV1.clock();
    machine.shadowV2.clock();
    machine.shadowV3.clock();
    machine.sidCycleCounter = (machine.sidCycleCounter + 1) >>> 0;
  }
  // Apply any writes scheduled exactly at totalCycles before reading.
  for (const w of writes) if (w.cycle === totalCycles) machine._sidWrite(w.reg, w.val);
  return {
    osc3: machine.shadowV3.getOscByte(),
    env3: machine.shadowV3.env,
    lfsr: machine.shadowV3.lfsr,
    phase: machine.shadowV3.phase,
  };
}

// ── 1: A bare voice 3 SAW oscillator produces the expected $D41B ──────
// Set v3 to SAW with a known freq and clock for N cycles; OSC3 should
// equal (phase >> 16) & 0xFF.
{
  const m = makeMachine();
  // V3 freq lo/hi at reg offsets 14/15 ($D40E/$D40F); ctrl at 18 ($D412).
  const freqLo = 0x00, freqHi = 0x10;  // freq = 0x1000
  const writes = [
    { cycle: 0, reg: 0x0E, val: freqLo },
    { cycle: 0, reg: 0x0F, val: freqHi },
    { cycle: 0, reg: 0x12, val: 0x21 },  // SAW + GATE
  ];
  const cycles = 1000;
  const ref    = runReferenceVoices(writes, cycles);
  const shadow = runShadow(m, writes, cycles);
  expect(shadow.osc3 === ref.osc3,
    `OSC3 matches reference: shadow=$${shadow.osc3.toString(16)}, ref=$${ref.osc3.toString(16)}`);
  expect(shadow.env3 === ref.env3,
    `ENV3 matches reference: shadow=${shadow.env3}, ref=${ref.env3}`);
  ok('shadow SID: $D41B / $D41C match a synchronous SAW voice reference after 1000 cycles');
}

// ── 2: Voice 3 NOISE LFSR advances at the same rate as the reference ──
// Demos use $D41B with V3=NOISE as a cheap RNG. The shadow must clock
// the LFSR at the same phase-wrap moments the worklet would, so reads
// in tight loops see the same random byte sequence.
{
  const m = makeMachine();
  const writes = [
    { cycle: 0, reg: 0x0E, val: 0xFF },   // V3 freq lo
    { cycle: 0, reg: 0x0F, val: 0x0F },   // V3 freq hi  → freq=$0FFF
    { cycle: 0, reg: 0x12, val: 0x81 },   // V3 NOISE + GATE
  ];
  // Run for enough cycles that the LFSR shifts multiple times.
  for (let cycles of [200, 2000, 20000]) {
    const ref    = runReferenceVoices(writes, cycles);
    const shadow = runShadow(makeMachine(), writes, cycles);
    expect(shadow.lfsr === ref.lfsr,
      `LFSR matches at cy=${cycles}: shadow=$${shadow.lfsr.toString(16)}, ref=$${ref.lfsr.toString(16)}`);
    expect(shadow.osc3 === ref.osc3,
      `OSC3 matches at cy=${cycles}: shadow=$${shadow.osc3.toString(16)}, ref=$${ref.osc3.toString(16)}`);
  }
  ok('shadow SID: NOISE LFSR + $D41B byte match the reference across many phase wraps');
}

// ── 3: ENV3 read tracks the envelope counter through attack ───────────
// A demo polling $D41C in a tight loop should observe the env counter
// monotonically rising during attack, not a stale snapshot.
{
  const m = makeMachine();
  const writes = [
    { cycle: 0, reg: 0x13, val: 0x00 },   // V3 attack=0, decay=0
    { cycle: 0, reg: 0x14, val: 0xF0 },   // V3 sustain=15, release=0
    { cycle: 0, reg: 0x12, val: 0x11 },   // V3 TRI + GATE
  ];
  const samples = [];
  // Step through the attack phase reading ENV3 every 100 cycles.
  for (let c = 0; c <= 2400; c += 100) {
    const ref = runReferenceVoices(writes, c);
    const shadow = runShadow(makeMachine(), writes, c);
    samples.push({ c, shadow: shadow.env3, ref: ref.env3 });
    expect(shadow.env3 === ref.env3,
      `ENV3 at cy=${c}: shadow=${shadow.env3}, ref=${ref.env3}`);
  }
  // Sanity: env actually climbs from 0 toward 255 over the window.
  expect(samples[0].shadow === 0, `ENV3 starts at 0`);
  expect(samples[samples.length - 1].shadow > 200,
    `ENV3 climbs through attack: final=${samples[samples.length - 1].shadow}`);
  ok('shadow SID: $D41C tracks attack-phase envelope counter cycle-by-cycle');
}

// ── 4: Sync chain — v3 sees v2 phase wraps as ring-mod / sync source ──
// Voice 3's syncSrc is v2 (per makeVoiceTrio). The shadow's v3 must
// observe v2's phase wraps at the same cycle the worklet would,
// because that's where v3's ring-modulated triangle phase folds.
{
  const m = makeMachine();
  // V2 fast saw (drives ring source), V3 TRI+RING (reads v2 MSB).
  const writes = [
    { cycle: 0, reg: 0x07, val: 0xFF },   // V2 freq lo
    { cycle: 0, reg: 0x08, val: 0x10 },   // V2 freq hi
    { cycle: 0, reg: 0x0B, val: 0x21 },   // V2 SAW + GATE

    { cycle: 0, reg: 0x0E, val: 0x00 },   // V3 freq lo
    { cycle: 0, reg: 0x0F, val: 0x08 },   // V3 freq hi
    { cycle: 0, reg: 0x12, val: 0x15 },   // V3 TRI + RING + GATE
  ];
  // Step through several v2 phase wraps and verify shadow.v3.phase
  // (which the ring source folds) matches the reference at each
  // sample point.
  for (let c of [500, 1500, 3000, 7500]) {
    const ref    = runReferenceVoices(writes, c);
    const shadow = runShadow(makeMachine(), writes, c);
    expect(shadow.phase === ref.phase,
      `v3 phase at cy=${c}: shadow=$${shadow.phase.toString(16)}, ref=$${ref.phase.toString(16)}`);
    expect(shadow.osc3 === ref.osc3,
      `OSC3 at cy=${c} (ring-mod TRI): shadow=$${shadow.osc3.toString(16)}, ref=$${ref.osc3.toString(16)}`);
  }
  ok('shadow SID: ring-modulated v3 phase tracks v2 sync source across the chain');
}

// ── 5: Mid-stream register write changes ENV3 immediately on next clock ─
// Real demos write $D40D mid-note then poll $D41C to detect when the
// new release rate kicks in. The shadow must see the write at the
// exact cycle it occurred, not one block later.
{
  const m = makeMachine();
  const writes = [
    { cycle: 0,    reg: 0x13, val: 0x00 },  // V3 attack=0 → fast ramp
    { cycle: 0,    reg: 0x14, val: 0xF0 },  // V3 sustain=15
    { cycle: 0,    reg: 0x12, val: 0x11 },  // V3 TRI + GATE
    { cycle: 2300, reg: 0x12, val: 0x10 },  // V3 gate OFF mid-attack
  ];
  // At cycle 2305 (5 cycles after gate-off), the voice is in RELEASE.
  // ENV3 should be ≤ peak, > 0 (release hasn't fully decayed).
  const shadow = runShadow(makeMachine(), writes, 2305);
  expect(shadow.env3 > 0 && shadow.env3 <= 255,
    `ENV3 mid-release: ${shadow.env3}`);
  // Compare against reference.
  const ref = runReferenceVoices(writes, 2305);
  expect(shadow.env3 === ref.env3, `ENV3 matches ref after mid-stream gate-off`);
  ok('shadow SID: mid-stream $D412 (gate-off) reflects in $D41C on the next clock');
}

// ═════════════════════════════════════════════════════════════════════
// SID data-bus value: reading a write-only register returns the last byte
// that crossed the SID data bus (any register write, or a readable-register
// read result), fading to 0 after ~$1D00 cycles (6581) / ~$A2000 (8580) —
// reSID sid.cc, measured on real chips (bitfade/delayfrq0.prg). regs[] is
// no longer served to the CPU for write-only registers.
// ═════════════════════════════════════════════════════════════════════

function runCycles(m, n) { for (let i = 0; i < n; i++) m._runMasterCycle(); }

// ── bus value: any write is visible on ANY write-only register ─────────
{
  const m = makeMachine();                    // default model: 8580
  m.mem.sid.write(0x12, 0x37);                // write v3 ctrl
  expect(m.mem.sid.read(0x04) === 0x37,       // read v1 ctrl (write-only)
    `read $D404 after $D412=$37 → $37, got $${m.mem.sid.read(0x04).toString(16)}`);
  expect(m.mem.sid.read(0x1F) === 0x37,       // unmapped SID reg too
    `read $D41F returns the bus value`);
  m.mem.sid.write(0x00, 0x99);                // newer write replaces it
  expect(m.mem.sid.read(0x12) === 0x99,
    `bus holds the LAST write ($99), not the per-register value`);
  ok('SID bus: write-only reads return the last byte written to any register');
}

// ── bus value fades: 6581 ≈ $1D00 cycles, 8580 ≈ $A2000 ────────────────
{
  const m = makeMachine();                    // 8580
  m.mem.sid.write(0x12, 0x42);
  runCycles(m, 0x2000);                       // > 6581 TTL, ≪ 8580 TTL
  expect(m.mem.sid.read(0x04) === 0x42,
    `8580: bus value survives $2000 cycles`);
  runCycles(m, 0xA2000);                      // now past the 8580 TTL
  expect(m.mem.sid.read(0x04) === 0x00,
    `8580: bus value fades to 0 after ~$A2000 cycles`);

  const m6 = makeMachine();
  m6.setSidModel(false);                      // 6581
  m6.mem.sid.write(0x12, 0x55);
  runCycles(m6, 0x1C00);
  expect(m6.mem.sid.read(0x04) === 0x55,
    `6581: bus value still visible at $1C00 cycles`);
  runCycles(m6, 0x200);                       // total $1E00 > $1D00
  expect(m6.mem.sid.read(0x04) === 0x00,
    `6581: bus value fades to 0 after ~$1D00 cycles (write-only reads do not refresh the TTL)`);
  ok('SID bus: value fades after the model TTL ($1D00 / $A2000)');
}

// ── readable-register reads load the bus with the returned byte ────────
{
  const m = makeMachine();
  // Give v3 a deterministic nonzero OSC3: SAW, freq hi $40, run a bit.
  m.mem.sid.write(0x0F, 0x40);                // v3 freq hi
  m.mem.sid.write(0x12, 0x20);                // v3 SAW
  runCycles(m, 1000);
  const osc = m.mem.sid.read(0x1B);           // OSC3 read → loads the bus
  expect(osc !== 0, `OSC3 nonzero (got $${osc.toString(16)})`);
  expect(m.mem.sid.read(0x07) === osc,
    `write-only read after OSC3 returns the OSC3 byte ($${osc.toString(16)})`);
  const env = m.mem.sid.read(0x1C);           // ENV3 (0 here) → bus = 0
  expect(m.mem.sid.read(0x07) === env,
    `write-only read after ENV3 returns the ENV3 byte`);
  const pot = m.mem.sid.read(0x19);           // POTX sample → bus
  expect(m.mem.sid.read(0x07) === pot,
    `write-only read after POTX returns the POT byte ($${pot.toString(16)})`);
  ok('SID bus: POT/OSC3/ENV3 reads refresh the bus with their value');
}

console.log(`\n${testNo} shadow-SID tests; ${fails} fail`);
if (fails > 0) process.exit(1);
