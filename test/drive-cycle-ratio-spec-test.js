// 1541 drive ↔ C64 clock ratio spec test.
//
// PAL real hardware: C64 phi2 = 985248 Hz; the 1541's CPU runs at 1 MHz
// (16 MHz crystal / 16) — the drive is ~1.5% FASTER than the C64. TDE now
// models that with a 16.16 fixed-point accumulator (driveClockFactor =
// floor(65536 * 1e6 / 985248) = 66517, VICE drivesync.c parity) behind the
// 'driveTrueClockRatio' switch (default ON). The switch's OFF position pins
// the legacy 1:1 lockstep (factor 65536), which must stay a bit-exact no-op:
// 1:1 freezes the drive↔C64 phase at load start, and several fastloader
// behaviors were validated against it before the true ratio landed.
//
// This pins: (1) the OFF path is exactly 1:1 with a dormant accumulator,
// (2) the ON path advances the drive by exactly (N*66517)>>16 cycles over
// any window, i.e. the true ratio with no float jitter or drift.

import fs from 'fs';

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
const ROMS = { kernal: fs.readFileSync('roms/kernal.bin'), basic: fs.readFileSync('roms/basic.bin'), charRom: fs.readFileSync('roms/chargen.bin') };
if (!fs.existsSync('roms/1541.bin')) { console.log('# SKIP 1541 ROM not available'); process.exit(0); }
const DRIVE = fs.readFileSync('roms/1541.bin');

// The switch resolves at machine construction, so set the env per leg and
// import the machine after the first assignment.
async function makeMachine(ratioEnv) {
  process.env.DRIVE_TRUE_CLOCK_RATIO = ratioEnv;
  const { C64Machine } = await import('../src/machine.js');
  const m = new C64Machine();
  m.loadROMs(ROMS); m.attachDrive(DRIVE); m.setTrueDrive(true); m.reset();
  // Force the active (non-idle-skip) clocking path so every master cycle
  // clocks the drive — isolates the ratio from the idle-skip fast-forward.
  m.drive1541.canIdleSkip = () => false;
  for (let i = 0; i < 10; i++) m.runFrame();              // warm up (drive DOS boot/idle)
  return m;
}

function measure(m, frames) {
  let c64 = 0;
  const orig = m._runMasterCycle.bind(m);
  m._runMasterCycle = () => { c64++; return orig(); };
  const accum0 = m.driveCycleAccum;
  const d0 = m.drive1541.totalCycles;
  for (let i = 0; i < frames; i++) m.runFrame();
  m._runMasterCycle = orig;
  return { c64, accum0, drive: m.drive1541.totalCycles - d0 };
}

// ── 1: OFF path — exact legacy 1:1 lockstep, dormant accumulator ─────────────
{
  const m = await makeMachine('0');
  expect(m.driveClockFactor === 65536, `factor is 65536 (1:1); got ${m.driveClockFactor}`);
  const { c64, drive } = measure(m, 30);
  expect(c64 > 500000, `precondition: ran a meaningful window (${c64} master cycles)`);
  expect(drive === c64,
    `1:1 lockstep: drive=${drive} vs C64=${c64} (ratio ${(drive / c64).toFixed(5)})`);
  expect(m.driveCycleAccum === 0,
    `driveCycleAccum stays 0 on the 1:1 path; got ${m.driveCycleAccum}`);
  ok('1541 TDE, driveTrueClockRatio OFF: bit-exact legacy 1:1 lockstep');
}

// ── 2: ON path — exact 16.16 true ratio, VICE drivesync.c parity ─────────────
{
  const m = await makeMachine('1');
  expect(m.driveClockFactor === 66517,
    `factor is floor(65536*1e6/985248) = 66517; got ${m.driveClockFactor}`);
  const { c64, accum0, drive } = measure(m, 30);
  // Integer-exact expectation: popping (accum += 66517; accum >> 16) per master
  // cycle from a known start accumulates to floor((accum0 + N*66517) / 65536).
  const expected = Math.floor((accum0 + c64 * 66517) / 65536) - Math.floor(accum0 / 65536);
  expect(c64 > 500000, `precondition: ran a meaningful window (${c64} master cycles)`);
  expect(drive === expected,
    `true ratio, integer-exact: drive=${drive} expected=${expected} over ${c64} master cycles (ratio ${(drive / c64).toFixed(5)})`);
  expect(m.driveCycleAccum >= 0 && m.driveCycleAccum <= 0xffff,
    `accumulator stays a 16-bit fraction; got ${m.driveCycleAccum}`);
  ok('1541 TDE, driveTrueClockRatio ON: drive advances at exactly 66517/65536 per master cycle');
}

// ── 3: the 16.16 fraction survives save/restore — phase continuity ──────────
// driveCycleAccum rides the existing serialized field; a state saved
// mid-fraction must restore it exactly and keep advancing the drive on the
// same integer-exact schedule (no phase step at a save/restore boundary).
{
  const m = await makeMachine('1');
  const proto = Object.getPrototypeOf(m);
  for (let i = 0; i < 33; i++) proto._runMasterCycle.call(m);
  // serializeState() quiesces to an instruction boundary (may run a few more
  // master cycles), so capture the reference accumulator AFTER serializing.
  const state = m.serializeState();
  const accum = m.driveCycleAccum;
  expect(accum > 0 && accum <= 0xffff, `accumulator holds a nonzero fraction (got ${accum})`);
  process.env.DRIVE_TRUE_CLOCK_RATIO = '1';
  const { C64Machine } = await import('../src/machine.js');
  const m2 = new C64Machine();
  m2.loadROMs(ROMS); m2.attachDrive(DRIVE); m2.setTrueDrive(true); m2.reset();
  m2.restoreState(state);
  expect(m2.driveCycleAccum === accum, `driveCycleAccum restored exactly (${m2.driveCycleAccum} vs ${accum})`);

  m2.drive1541.canIdleSkip = () => false;
  const d0 = m2.drive1541.totalCycles;
  const K = 1000;
  const expected = Math.floor((accum + K * 66517) / 65536);
  for (let i = 0; i < K; i++) proto._runMasterCycle.call(m2);
  expect(m2.drive1541.totalCycles - d0 === expected,
    `post-restore advance continues the fraction integer-exactly (got ${m2.drive1541.totalCycles - d0}, expected ${expected})`);
  ok('16.16 accumulator phase survives save/restore with no step');
}

delete process.env.DRIVE_TRUE_CLOCK_RATIO;
console.log(`\n${testNo} 1541 drive clock-ratio spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
