// Open-bus (unconnected-I/O) idle g-access gate spec test.
//
// Reading an unconnected address on a C64 — IO1/IO2 ($DE00-$DFFF) or the
// upper nybble of color RAM ($D800-$DBFF) — returns the floating data bus:
// whatever the VIC-II last drove during phi1. The VIC drives the bus on its
// real memory accesses only: DRAM refresh (cycles 11..15, address $3F00|rc
// with rc decrementing 5×/line), the 40 g-accesses (cycles 16..55, idle
// source $3FFF / $39FF — Bauer §3.7.4: c-access at cy15 feeds g-access at
// cy16), and the pure-idle accesses at cycles 56 & 57 ($3FFF, ECM-independent,
// between the last g-access and sprite 0's p-access at cy58). On the OTHER
// cycles the VIC's p/s sprite accesses drive the bus, or it HOLDS its last
// real value.
//
// The bug this pins: _captureCycleState ran the idle g-access read on EVERY
// cycle of every line and let it drive the shared external bus, overwriting
// the held value (and the refresh bytes) with a constant $3FFF every cycle.
// That made open-I/O reads return a fixed 0x00 (idle source over the power-on
// RAM pattern) instead of the refresh-walked floating value real hardware
// exposes. testprogs/C64/openio/gauntlet.prg's anti-cart check reads $DE00/
// $DF00 30× and FAILS if the 16-byte signature is identical 20 reads running;
// a constant bus = guaranteed fail. The fix gates the external-bus drive to
// the g-access window only; vicInternalBus (renderer / sprite idle-fetch
// source) is updated every cycle exactly as before.
//
// The g-access window was originally modelled one cycle early (15..54). That
// passed openio (which reads in the refresh window) but failed
// testprogs/VICII/phi1timing, which measures the PHI1 fetch TYPE on every
// cycle via open-bus $DEAD reads: cy15 must stay the 5th REFRESH (not be
// clobbered by a g-access), cy55 must be the 40th G-access, and cy56/57 must
// be IDLE ($3FFF). Corrected to 16..55 + cy56/57 idle.
//
// Tests:
//   1. _readIdleGByte(driveExternal=false) updates vicInternalBus + returns
//      the idle byte but does NOT drive the external (open) bus.
//   2. _readIdleGByte(driveExternal=true) drives BOTH.
//   3. _captureCycleState on a non-g cycle (no refresh) does not clobber the
//      open bus; on a g-access cycle it drives the idle byte. Boundaries:
//      cy15 held (refresh's, not g), cy55 driven (last g), cy56/57 idle $3FFF.
//   4. Across consecutive border lines the open bus sampled mid-refresh is
//      NOT constant — the floating value walks $3Fxx (the property that lets
//      gauntlet's cart check pass).

import { VIC2, CYCLES_PER_LINE } from '../src/vic2.js';

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

// Seed RAM with the C64 power-on DRAM pattern (00 00 FF FF FF FF 00 00 …) so
// $3Fxx varies the way Memory.reset() sets it — same source the real test uses.
function powerOnByte(i) { return (((i >> 1) ^ (i >> 2)) & 1) ? 0xFF : 0x00; }

function makeVic() {
  const vic = new VIC2();
  vic.ram = new Uint8Array(0x10000);
  for (let i = 0; i < vic.ram.length; i++) vic.ram[i] = powerOnByte(i);
  vic.colorRam = new Uint8Array(0x0400);
  vic.charRom = new Uint8Array(0x1000);
  vic.currentVicBank = 0;
  // Mock the shared external data bus the CPU samples on open reads.
  vic.memory = { externalDataBus8: 0xFF };
  return vic;
}

const IDLE = 0x3FFF; // bank 0, non-ECM idle g-access source

// ── Test 1 + 2: _readIdleGByte external-drive contract ───────────────────────
{
  const vic = makeVic();
  const idleByte = vic.ram[IDLE] & 0xFF; // = powerOnByte(0x3FFF) = 0x00

  // driveExternal=false → internal latch + return value, open bus untouched.
  vic.memory.externalDataBus8 = 0x5A;
  vic.vicInternalBus = 0x00;
  const r1 = vic._readIdleGByte(vic.regs, 0, false);
  expect(r1 === idleByte, `returns idle byte; got 0x${r1.toString(16)} want 0x${idleByte.toString(16)}`);
  expect(vic.vicInternalBus === idleByte, `vicInternalBus updated; got 0x${vic.vicInternalBus.toString(16)}`);
  expect(vic.memory.externalDataBus8 === 0x5A,
    `open bus NOT driven (held 0x5A); got 0x${vic.memory.externalDataBus8.toString(16)}`);
  ok('_readIdleGByte(driveExternal=false): updates internal latch, holds open bus');

  // driveExternal=true → drives the open bus too.
  vic.memory.externalDataBus8 = 0x5A;
  const r2 = vic._readIdleGByte(vic.regs, 0, true);
  expect(r2 === idleByte, `returns idle byte; got 0x${r2.toString(16)}`);
  expect(vic.memory.externalDataBus8 === idleByte,
    `open bus driven to idle byte; got 0x${vic.memory.externalDataBus8.toString(16)}`);
  ok('_readIdleGByte(driveExternal=true): drives the open bus');
}

// ── Test 3: per-cycle gate in _captureCycleState ─────────────────────────────
{
  const vic = makeVic();
  vic.raster = 260;            // deep lower border — idle line
  const idleByte = vic.ram[IDLE] & 0xFF;

  // Non-g, non-refresh cycle (5): idle capture must NOT touch the open bus.
  vic.memory.externalDataBus8 = 0xA5;
  vic._captureCycleState(5);
  expect(vic.memory.externalDataBus8 === 0xA5,
    `cy5 (no VIC access): open bus held; got 0x${vic.memory.externalDataBus8.toString(16)} want 0xA5`);

  // g-access cycle (30): idle capture drives the open bus to the idle byte.
  vic.memory.externalDataBus8 = 0xA5;
  vic._captureCycleState(30);
  expect(vic.memory.externalDataBus8 === idleByte,
    `cy30 (g-access): open bus driven to idle byte; got 0x${vic.memory.externalDataBus8.toString(16)}`);

  // Boundary cy15: this is the 5th REFRESH cycle, NOT a g-access — the idle
  // capture must NOT drive the bus (refresh does, elsewhere). Off-by-one guard.
  vic.memory.externalDataBus8 = 0xA5;
  vic._captureCycleState(15);
  expect(vic.memory.externalDataBus8 === 0xA5,
    `cy15 (5th refresh, not g): open bus held; got 0x${vic.memory.externalDataBus8.toString(16)} want 0xA5`);

  // Boundary cy55: the 40th (last) g-access — must drive the idle byte.
  vic.memory.externalDataBus8 = 0xA5;
  vic._captureCycleState(55);
  expect(vic.memory.externalDataBus8 === idleByte,
    `cy55 (40th g-access): open bus driven to idle byte; got 0x${vic.memory.externalDataBus8.toString(16)}`);

  // Boundary cy56/57: pure-idle accesses to $3FFF (ECM-independent) — drive
  // the bus to $3FFF's content regardless of the (here non-ECM) idle source.
  for (const c of [56, 57]) {
    vic.memory.externalDataBus8 = 0xA5;
    vic._captureCycleState(c);
    expect(vic.memory.externalDataBus8 === (vic.ram[IDLE] & 0xFF),
      `cy${c} (idle $3FFF): open bus driven to $3FFF content; got 0x${vic.memory.externalDataBus8.toString(16)}`);
  }

  ok('_captureCycleState: idle g-access drives open bus only inside the g-access window');
}

// ── Test 4: floating value walks across border lines (the gauntlet property) ──
{
  const vic = makeVic();
  // Drive the VIC (no CPU) to the lower border and collect the open-bus value
  // right after each line's refresh window (cycle 13) over several lines.
  const samples = [];
  let guard = 312 * (CYCLES_PER_LINE + 1) * 3;
  let lastLineSampled = -1;
  while (samples.length < 12 && --guard) {
    vic.clock(1);
    vic.phi2();
    const r = vic.raster;
    if (r >= 252 && r <= 280 && vic.cycleInLine === 13 && r !== lastLineSampled) {
      samples.push(vic.memory.externalDataBus8 & 0xFF);
      lastLineSampled = r;
    }
  }
  expect(samples.length >= 6, `collected border-line samples; got ${samples.length}`);
  const distinct = new Set(samples);
  expect(distinct.size > 1,
    `open bus must vary line-to-line (refresh walk), not be constant; samples=[${samples.map(v=>v.toString(16)).join(',')}]`);
  ok('open bus floats / walks $3Fxx across border lines (not a constant idle byte)');
}

console.log(`\n${testNo} open-bus idle g-access gate spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
