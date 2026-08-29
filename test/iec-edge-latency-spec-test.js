// IEC edge-latency spec — locks the propagation model behind the
// 'iecEdgeLatency' switch (src/switches.js):
//
//  • drive→C64: drive output-pin changes reach the C64's $DD00 read view one
//    master cycle later than the run order inherently gives — a read at
//    cycle S sees drive writes from ≤ S−2. This is the NOSDOS reception fix:
//    the loader's drive-release-to-last-sample margin is designed against
//    real hardware's asynchronous CIA input latching; without the stage the
//    true drive-clock ratio's phase sweep periodically lands the release one
//    cycle before the sample and the received byte reads bit 7/6 HIGH.
//  • C64→drive: INSTANT. Delaying this direction was tried and corrupts the
//    NOSDOS install stage — locked here so it can't quietly come back.
//  • Own pulls: each side sees its own line contribution live.
//  • IEC_EDGE_LATENCY=0: the legacy instant wiring, both directions.
//
// Register bit map: C64 $DD00 PA3/4/5 = ATN/CLK/DATA out (set = pull),
// PA6/PA7 = CLK/DATA in (read 0 = line pulled). Drive VIA1 $1800 PB1 = DATA
// out, PB3 = CLK out (set = pull), PB4 = ATNA.

import fs from 'fs';

const ROOT = new URL('../roms/', import.meta.url).pathname;
function tryRead(p) { try { return new Uint8Array(fs.readFileSync(p)); } catch { return null; } }
const kernal = tryRead(ROOT + 'kernal.bin');
const basic = tryRead(ROOT + 'basic.bin');
const chargen = tryRead(ROOT + 'chargen.bin');
const drvRom = tryRead(ROOT + '1541.bin');
if (!kernal || !basic || !chargen || !drvRom) { console.log('# SKIP C64/1541 ROMs not available'); process.exit(0); }

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

// The switch resolves at machine construction — set the env per leg.
async function makeMachine(latencyEnv) {
  process.env.IEC_EDGE_LATENCY = latencyEnv;
  const { C64Machine } = await import('../src/machine.js');
  const m = new C64Machine();
  m.loadROMs({ kernal, basic, charRom: chargen });
  m.attachDrive(drvRom);
  m.setTrueDrive(true);
  m.reset();
  // Park both CPUs in JMP-self loops so neither touches the IEC lines.
  m.mem.ram[0xC000] = 0x4C; m.mem.ram[0xC001] = 0x00; m.mem.ram[0xC002] = 0xC0;
  m.cpu.pc = 0xC000; m.cpu.I = 1;
  const drv = m.drive1541;
  drv.ram[0x0500] = 0x4C; drv.ram[0x0501] = 0x00; drv.ram[0x0502] = 0x05;
  drv.cpu.pc = 0x0500; drv.cpu.I = 1;
  drv.motorOn = false;
  // C64 side: ATN/CLK/DATA outputs, all released.
  m.cia2.write(2, 0x38); m.cia2.write(0, 0x00);
  // Drive side: PB1/PB3/PB4 outputs, all released. PB4 (ATNA) stays 0: with
  // ATN released that XORs to no auto-pull, so DATA is purely PB1's to drive.
  drv.write(0x1802, 0x1A); drv.write(0x1800, 0x00);
  for (let i = 0; i < 4; i++) m._runMasterCycle();      // settle everything
  return m;
}
const step = (m) => m._runMasterCycle();
const dataIn = (m) => (m.cia2.readPortA() & 0x80) ? 1 : 0;  // 1 = released, 0 = pulled
const clkIn = (m) => (m.cia2.readPortA() & 0x40) ? 1 : 0;

// ── 1: drive→C64 assert direction — pin pull visible at +2, not before ──────
{
  const m = await makeMachine('1');
  const drv = m.drive1541;
  expect(dataIn(m) === 1, `baseline: DATA released, C64 reads high`);
  drv.write(0x1800, 0x02);                    // PB1=1 → drive pulls DATA
  expect(drv.dataOut === 0, 'drive pin itself is low immediately (own view live)');
  expect(dataIn(m) === 1, 'C64 does NOT see the pull before the next master cycle');
  step(m);
  expect(dataIn(m) === 1, 'C64 does NOT see the pull one cycle later (read-side +1 stage)');
  step(m);
  expect(dataIn(m) === 0, 'C64 sees the pull two cycles after the pin change');
  ok('drive→C64 pull propagates through the one-cycle read-side stage');
}

// ── 2: drive→C64 release direction — the NOSDOS margin case in miniature ────
// The drive holds a bit (DATA low), then releases; the C64's next-cycle
// sample must still read the HELD value. This is exactly the 2-bit loader's
// release-vs-last-sample race: without the stage, a release landing one
// cycle before the sample makes received bytes read bit 7/6 HIGH.
{
  const m = await makeMachine('1');
  const drv = m.drive1541;
  drv.write(0x1800, 0x02);                    // pull DATA (the "held pair")
  step(m); step(m);
  expect(dataIn(m) === 0, 'held bit visible');
  drv.write(0x1800, 0x00);                    // RELEASE (end of bit cell)
  step(m);
  expect(dataIn(m) === 0, 'sample one cycle after the release still reads the HELD bit');
  step(m);
  expect(dataIn(m) === 1, 'release lands two cycles after the pin change');
  ok('drive→C64 release is invisible to the next-cycle sample (NOSDOS margin)');
}

// ── 3: C64→drive stays INSTANT — the install-stage constraint ───────────────
// A symmetric delay on this direction corrupts the NOSDOS install stage
// (measured; see switches.js). Locked: the drive sees C64 edges without any
// master-cycle stepping.
{
  const m = await makeMachine('1');
  const drv = m.drive1541;
  m.cia2.write(0, 0x08);                      // PA3=1 → ATN asserted
  expect(drv.atnIn === 0, 'drive sees ATN asserted with NO master cycle in between');
  m.cia2.write(0, 0x00);                      // release
  expect(drv.atnIn === 1, 'drive sees ATN released with NO master cycle in between');
  m.cia2.write(0, 0x10);                      // PA4=1 → CLK pulled
  expect(drv.clkIn === 0, 'drive sees C64 CLK pull instantly');
  m.cia2.write(0, 0x00);
  expect(drv.clkIn === 1, 'drive sees C64 CLK release instantly');
  ok('C64→drive direction is instant (delaying it breaks the NOSDOS install)');
}

// ── 4: the C64 sees its OWN pulls live through the pipelined read view ──────
{
  const m = await makeMachine('1');
  m.cia2.write(0, 0x10);                      // C64 pulls CLK
  expect(clkIn(m) === 0, 'own CLK pull reads back low with no pipeline delay');
  m.cia2.write(0, 0x00);
  expect(clkIn(m) === 1, 'own CLK release reads back high with no pipeline delay');
  ok('own line contributions bypass the drive-pin delay stage');
}

// ── 5: legacy wiring (IEC_EDGE_LATENCY=0) — instant both ways ────────────────
{
  const m = await makeMachine('0');
  const drv = m.drive1541;
  drv.write(0x1800, 0x02);                    // drive pulls DATA
  expect(dataIn(m) === 0, 'legacy: drive pull visible to the C64 immediately');
  drv.write(0x1800, 0x00);                    // release
  expect(dataIn(m) === 1, 'legacy: drive release visible to the C64 immediately');
  m.cia2.write(0, 0x08);
  expect(drv.atnIn === 0, 'legacy: C64 ATN visible to the drive immediately');
  ok('IEC_EDGE_LATENCY=0 restores the instant wiring bit-exactly');
}

delete process.env.IEC_EDGE_LATENCY;
console.log(`\n${testNo} IEC edge-latency spec tests; ${testsFailing} fail`);
if (testsFailing) process.exit(1);
