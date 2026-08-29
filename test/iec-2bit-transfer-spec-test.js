// test/iec-2bit-transfer-spec-test.js
//
// Spec guards for the C64<->1541 IEC bus coupling that Sparkle's (and Krill's)
// 2-bit transfer protocol relies on. The protocol (Krill loader doc,
// "2-Bit Send ATN Protocol", rev >= 58):
//
//   ATN  = clock line, driven by the C64 (host).
//   CLK  = data line bit, driven by the drive.
//   DATA = data line bit, driven by the drive.
//   Per byte, 4 ATN-clocked pairs carry (CLK,DATA) = (b0,b1)(b2,b3)(b4,b5)(b6,b7).
//
// For that to work the underlying IEC electrical model must hold:
//   1. Open-collector WIRED-AND: a line is LOW (asserted) if ANY device pulls
//      it; HIGH (released) only if all release.
//   2. VISIBILITY both directions: a line change by one device is seen by the
//      other. The C64's ATN must reach the drive (the protocol clock); the
//      drive's CLK/DATA must reach the C64 (the protocol data).
//   3. ATNA: while the C64 asserts ATN and the drive's ATN-ACK is transparent
//      (VIA1 PB4 register bit = 0), the drive auto-pulls DATA. The >= 2.0
//      request handshake depends on this.
//
// These tests drive the SPEC SURFACE — the registers the protocol uses
// ($DD00 / DDRA on the C64; $1800 / DDRB on the drive) — and assert the bus
// observables. They do NOT poke internal pin fields. If the coupling has a
// visibility/wired-AND/ATNA bug, a test here fails and pins it without
// tracing a whole demo.
//
// Register bit map (used below):
//   C64 $DD00 (CIA2 PRA): PA3=ATN out, PA4=CLK out, PA5=DATA out,
//                         PA6=CLK in,  PA7=DATA in.  DDRA at reg 2.
//     Output bit SET (=1) pulls the line; CLEAR (=0) releases (DDR=output).
//     Input bit reads 0 when the bus line is pulled (low), 1 when released.
//   Drive $1800 (VIA1 PRB): PB1=DATA out, PB3=CLK out, PB4=ATN-ACK,
//                           PB0=DATA in,  PB2=CLK in,  PB7=ATN in.  DDRB at reg 2.
//     Output bit SET (=1) pulls; CLEAR (=0) releases (DDR=output).

import fs from 'fs';
import { C64Machine } from '../src/machine.js';

const ROOT = new URL('../roms/', import.meta.url).pathname;
function tryRead(p) { try { return new Uint8Array(fs.readFileSync(p)); } catch { return null; } }
const kernal = tryRead(ROOT + 'kernal.bin');
const basic  = tryRead(ROOT + 'basic.bin');
const chargen = tryRead(ROOT + 'chargen.bin');
const drvRom = tryRead(ROOT + '1541.bin');
if (!kernal || !basic || !chargen || !drvRom) { console.log('# SKIP C64/1541 ROMs not available'); process.exit(0); }

let failures = 0;
function assert(cond, msg) { if (!cond) { console.error(`FAIL: ${msg}`); failures++; } }
function ok(msg) { console.log(`ok  – ${msg}`); }

// ── Bus harness ────────────────────────────────────────────────────────────
// Build a machine + drive, then PARK both CPUs in a JMP-self loop so neither
// fights us for the IEC lines. We then drive the lines purely via register
// writes and observe via register reads — that is the protocol's spec surface.
function buildHarness() {
  const m = new C64Machine();
  m.loadROMs({ kernal, basic, charRom: chargen });
  m.attachDrive(drvRom);
  m.setTrueDrive(true);
  m.reset();
  // Park C64 CPU: JMP $C000 at $C000.
  m.mem.ram[0xC000] = 0x4C; m.mem.ram[0xC001] = 0x00; m.mem.ram[0xC002] = 0xC0;
  m.cpu.pc = 0xC000; m.cpu.I = 1;
  // Park drive CPU: JMP $0500 at $0500.
  const drv = m.drive1541;
  drv.ram[0x0500] = 0x4C; drv.ram[0x0501] = 0x00; drv.ram[0x0502] = 0x05;
  drv.cpu.pc = 0x0500; drv.cpu.I = 1;
  drv.motorOn = false;
  return m;
}

// Register writes settle the IEC edge-latency pipeline (three _iecClock
// steps cover the longest chain: C64 edge → drive ATNA reaction → drive pins
// back through the C64-facing delay line) so the assertions below stay
// steady-state wired-AND checks; the 1-cycle edge latency itself is
// spec-locked in fastloader-test.
const settle = (m) => { if (m.iecEdgeLatency) { m._iecClock(); m._iecClock(); m._iecClock(); } };
const cia = {
  ddr(m, v) { m.cia2.write(2, v); settle(m); },
  pra(m, v) { m.cia2.write(0, v); settle(m); },
  read(m)   { return m.cia2.read(0); },
};
const drive = {
  ddrb(m, v) { m.drive1541.write(0x1802, v); settle(m); },
  prb(m, v)  { m.drive1541.write(0x1800, v); settle(m); },
  read(m)    { return m.drive1541.read(0x1800); },
};

// C64 helpers (ATN=PA3 0x08, CLK=PA4 0x10, DATA=PA5 0x20; IN: CLK=PA6 0x40, DATA=PA7 0x80)
function c64ReleaseAll(m) { cia.ddr(m, 0x38); cia.pra(m, 0x00); }      // ATN/CLK/DATA output, all released
function c64SetOut(m, atn, clk, data) {                                // 1 = pull, 0 = release
  cia.ddr(m, 0x38);
  cia.pra(m, (atn ? 0x08 : 0) | (clk ? 0x10 : 0) | (data ? 0x20 : 0));
}
const c64ClkIn  = (v) => (v & 0x40) === 0;   // true => CLK line pulled (low)
const c64DataIn = (v) => (v & 0x80) === 0;   // true => DATA line pulled (low)

// Drive helpers (DATA=PB1 0x02, CLK=PB3 0x08, ATNA=PB4 0x10; IN: ATN=PB7 0x80)
// ATNA transparent = PB4 register bit 0. To DISABLE the ATN->DATA auto-pull set PB4=1.
function driveReleaseAll(m, { atnaOff = false } = {}) {
  drive.ddrb(m, 0x1A);                                  // PB1, PB3, PB4 outputs
  drive.prb(m, atnaOff ? 0x10 : 0x00);                  // all released (PB4=1 turns ATNA off)
}
function driveSetData(m, { clk = 0, data = 0, atnaOff = false } = {}) { // 1 = pull
  drive.ddrb(m, 0x1A);
  drive.prb(m, (data ? 0x02 : 0) | (clk ? 0x08 : 0) | (atnaOff ? 0x10 : 0));
}
const driveAtnIn = (v) => (v & 0x80) !== 0;  // VIA1 PB7: how the drive reads ATN-in

// ── Test 1: WIRED-AND on the CLK data line (drive-driven) ───────────────────
{
  const m = buildHarness();
  c64ReleaseAll(m);                         // ATN released throughout (ATNA stays transparent, DATA = PB1)
  driveReleaseAll(m);
  assert(!c64ClkIn(cia.read(m)), 'T1 baseline: CLK released => C64 reads CLK-in high');

  driveSetData(m, { clk: 1 });
  assert(c64ClkIn(cia.read(m)), 'T1: drive pulls CLK => C64 sees CLK-in low (drive->C64 visibility)');

  driveSetData(m, { clk: 0 });
  assert(!c64ClkIn(cia.read(m)), 'T1: drive releases CLK => C64 sees CLK-in high');

  // C64 also pulls CLK while drive releases -> still low (wired-AND).
  c64SetOut(m, 0, 1, 0);
  assert(c64ClkIn(cia.read(m)), 'T1: C64 pulls CLK (drive released) => bus low (wired-AND)');

  // Both pull -> low; both release -> high.
  driveSetData(m, { clk: 1 });
  assert(c64ClkIn(cia.read(m)), 'T1: both pull CLK => bus low');
  c64SetOut(m, 0, 0, 0); driveSetData(m, { clk: 0 });
  assert(!c64ClkIn(cia.read(m)), 'T1: both release CLK => bus high');
  ok('T1: CLK line wired-AND + drive->C64 visibility');
}

// ── Test 2: ATN propagation C64 -> drive (the protocol CLOCK line) ──────────
{
  const m = buildHarness();
  c64ReleaseAll(m);
  driveReleaseAll(m, { atnaOff: true });
  assert(!driveAtnIn(drive.read(m)), 'T2 baseline: ATN released => drive reads ATN-in released');

  c64SetOut(m, 1, 0, 0);    // C64 pulls ATN
  assert(driveAtnIn(drive.read(m)), 'T2: C64 pulls ATN => drive sees ATN-in asserted (C64->drive visibility)');

  c64SetOut(m, 0, 0, 0);    // C64 releases ATN
  assert(!driveAtnIn(drive.read(m)), 'T2: C64 releases ATN => drive sees ATN-in released');
  ok('T2: ATN clock line propagates C64 -> drive');
}

// ── Test 3: ATNA auto-pull of DATA while ATN asserted ───────────────────────
// Spec: with ATN asserted by the C64 and the drive's ATN-ACK transparent
// (PB4=0), the drive hardware pulls DATA. The >=2.0 request handshake relies
// on "drive sets CLK + clears ATNA (=> DATA set) when ready".
{
  const m = buildHarness();
  c64ReleaseAll(m);
  driveReleaseAll(m);                       // ATNA transparent (PB4=0), DATA released by reg
  assert(!c64DataIn(cia.read(m)), 'T3 baseline: ATN released, ATNA transparent => DATA high');

  c64SetOut(m, 1, 0, 0);                    // C64 asserts ATN
  assert(c64DataIn(cia.read(m)), 'T3: ATN asserted + ATNA transparent => drive auto-pulls DATA (C64 sees DATA low)');

  // Drive turns ATNA off (PB4=1) -> auto-pull released even though ATN still asserted.
  driveReleaseAll(m, { atnaOff: true });
  assert(!c64DataIn(cia.read(m)), 'T3: drive disables ATNA => DATA released despite ATN asserted');
  ok('T3: ATNA auto-pull of DATA tracks ATN + PB4');
}

// ── Test 4: drive view stays correct across machine clocking (re-sync) ──────
// The drive polls $1800 between C64 $DD00 accesses. Its view of ATN must
// remain correct after cycles elapse (the drive CPU is parked, so only the
// bus model is exercised). A stale cached wired-AND here deadlocks real
// loaders — the drive must re-sync its bus view on every VIA1 PB read.
{
  const m = buildHarness();
  c64ReleaseAll(m);
  driveReleaseAll(m, { atnaOff: true });
  c64SetOut(m, 1, 0, 0);                    // C64 pulls ATN (writes $DD00)
  // Clock a chunk of cycles via the drive (CPU parked); bus view must persist.
  m.drive1541.clock(2000);
  assert(driveAtnIn(drive.read(m)), 'T4: ATN-in still asserted at the drive after 2000 drive cycles (no spurious release)');

  c64SetOut(m, 0, 0, 0);                    // release ATN
  m.drive1541.clock(2000);
  assert(!driveAtnIn(drive.read(m)), 'T4: ATN-in released at the drive after the C64 releases (no stuck-low)');
  ok('T4: drive ATN view persists/updates across clocking (no stale-cache deadlock)');
}

// ── Test 5: full 2-bit data path — all four (CLK,DATA) pair values ──────────
// Each ATN clock the drive presents (CLK,DATA) = (bA,bB); the C64 must read
// exactly those two bits. ATN released throughout so ATNA doesn't perturb DATA.
{
  const m = buildHarness();
  c64ReleaseAll(m);                         // ATN released => ATNA transparent => DATA = PB1 (manual)
  for (const [clkBit, dataBit] of [[0,0],[0,1],[1,0],[1,1]]) {
    driveSetData(m, { clk: clkBit, data: dataBit });
    const v = cia.read(m);
    assert(c64ClkIn(v) === !!clkBit,
      `T5: pair CLK=${clkBit} DATA=${dataBit} -> C64 CLK-in correct (got ${c64ClkIn(v)?1:0})`);
    assert(c64DataIn(v) === !!dataBit,
      `T5: pair CLK=${clkBit} DATA=${dataBit} -> C64 DATA-in correct (got ${c64DataIn(v)?1:0})`);
  }
  ok('T5: all four 2-bit (CLK,DATA) pair values transfer drive -> C64');
}

if (failures) { console.error(`\n${failures} IEC 2-bit transfer spec assertion(s) FAILED`); process.exit(1); }
console.log('\nAll IEC 2-bit transfer spec tests passed.');
