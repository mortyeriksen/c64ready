// test/iec-handshake-test.js — drive both halves of a C64+1541 system
// through actual KERNAL ROMs and verify the IEC handshake produces visible
// drive activity (LED + bus state changes) within reasonable wall-time.
//
// Why: when a fastloader fails at "Checking", the upload (M-W) and execute
// (M-E) over the *standard* CBM IEC protocol have already succeeded — the
// failure is in the bit-bang protocol that follows. So the first thing to
// verify is that the standard IEC handshake reaches a known live state. If
// even that breaks, fastloader compatibility is hopeless.
//
// We boot a real C64Machine with TDE on, mount a synthetic D64, and let the
// machine run for several PAL frames. We then confirm:
//   - Drive 6502 advanced through its boot ROM (PC moved past reset path)
//   - Drive's DOS scheduler is running (regular VIA2 T1 IRQs)
//   - Drive responded to ATN at least once (CA1 IFR has been touched)
//
// Skipped if the C64/1541 ROMs aren't available.

import fs from 'fs';
import { C64Machine } from '../src/machine.js';
import { D64 } from '../src/d64.js';

const ROOT = new URL('../roms/', import.meta.url).pathname;

function tryRead(p) { try { return new Uint8Array(fs.readFileSync(p)); } catch { return null; } }
const kernal  = tryRead(ROOT + 'kernal.bin');
const basic   = tryRead(ROOT + 'basic.bin');
const chargen = tryRead(ROOT + 'chargen.bin');
const drvRom  = tryRead(ROOT + '1541.bin');

if (!kernal || !basic || !chargen || !drvRom) {
  console.log('# SKIP C64/1541 ROMs not available under roms/');
  process.exit(0);
}

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
}

// Build a minimal valid D64: 35 tracks of zeroed sectors with a BAM at
// track 18 sector 0 that says "empty disk". Just enough that loadFile()
// doesn't blow up if the test KERNAL touches it.
function buildEmptyD64() {
  const d = new Uint8Array(174848);
  // BAM track 18 sector 0 starts at offset 91392 (track 18 = 17*21 sectors
  // before, each 256B). Diskname/id at $90 onwards.
  const bamOff = 17 * 21 * 256;
  d[bamOff + 0] = 18; d[bamOff + 1] = 1; d[bamOff + 2] = 0x41;
  d[bamOff + 0xA2] = 0x30; d[bamOff + 0xA3] = 0x30;            // disk ID "00"
  // Empty directory: T18S1 has next-track 0 (= no more entries)
  const dirOff = (17 * 21 + 1) * 256;
  d[dirOff + 0] = 0; d[dirOff + 1] = 0xFF;
  return d;
}

// ── 1. Boot the full machine with TDE on, run a few frames, observe ──────
{
  const m = new C64Machine();
  m.loadROMs({ kernal, basic, charRom: chargen });
  m.attachDrive(drvRom);
  m.setTrueDrive(true);
  m.setD64(new D64(buildEmptyD64()));
  m.reset();
  assert(m.truedriveEnabled === true, 'TDE enabled');
  assert(m.drive1541 !== null, 'drive attached');

  // Run ~3 PAL frames (~60k master cycles ≈ 60 ms wall-time of emulation).
  // Plenty for KERNAL boot + drive ROM boot + idle stabilization.
  for (let f = 0; f < 3; f++) m.runFrame();

  // The drive 6502 must be past its RAM zero-out loop and into the DOS
  // scheduler region.
  const drvPc = m.drive1541.cpu.pc;
  assert(drvPc >= 0xC000, `drive PC in ROM (got $${drvPc.toString(16)})`);
  assert(m.drive1541.totalCycles > 50_000,
    `drive ticked ≥50k cycles in 3 PAL frames (got ${m.drive1541.totalCycles})`);

  console.log('ok  – C64+1541 boot together; drive reaches steady state');
}

// ── 2. Drive's VIA2 Timer 1 keeps ticking — DOS scheduler heartbeat ─────────
{
  const m = new C64Machine();
  m.loadROMs({ kernal, basic, charRom: chargen });
  m.attachDrive(drvRom);
  m.setTrueDrive(true);
  m.setD64(new D64(buildEmptyD64()));
  m.reset();

  // Run for one frame to settle into idle.
  m.runFrame();

  // Sample VIA2 T1 counter across two short windows. It must be a moving
  // target (free-run mode) — a stuck T1 would mean the scheduler is wedged.
  const before = m.drive1541.via2.t1c;
  for (let i = 0; i < 500; i++) C64Machine.prototype._runMasterCycle.call(m);
  const after = m.drive1541.via2.t1c;
  assert(before !== after,
    `VIA2 T1 counter advanced (before=${before}, after=${after})`);

  console.log('ok  – VIA2 T1 keeps ticking (DOS scheduler alive)');
}

// ── 3. Drive responds to a host-driven ATN edge with a CA1 IRQ ──────────
{
  const m = new C64Machine();
  m.loadROMs({ kernal, basic, charRom: chargen });
  m.attachDrive(drvRom);
  m.setTrueDrive(true);
  m.setD64(new D64(buildEmptyD64()));
  m.reset();
  for (let f = 0; f < 2; f++) m.runFrame();

  const drv = m.drive1541;

  // Force a clean baseline: ack any pending CA1 IFR via IRA read.
  drv.read(0x1801);
  assert((drv.via1.ifr & 0x02) === 0, 'CA1 IFR cleared baseline');

  // Now have the host pull ATN low. We bypass the C64 CPU and write the
  // CIA2 PA register directly so the test isn't dependent on what KERNAL
  // happens to be doing.
  m.cia2.portADir = 0x3F;
  m.cia2.portA    = 0x08;             // PA3=1 → ATN bus low (asserted)
  m._syncIecBus();
  if (m.iecEdgeLatency) m._iecClock(); // C64 edge reaches the drive next cycle

  assert(drv.atnIn === 0, 'drive sees ATN asserted');
  assert((drv.via1.ifr & 0x02) !== 0, 'CA1 IFR latched on ATN edge');

  console.log('ok  – host ATN edge raises drive CA1 IRQ at the protocol layer');
}

// ── 4. Tight 8-cycle host-side STA $DD00 / drive-side LDA $1800 alignment ──
//      Probe whether sub-instruction bus visibility works under the live
//      master loop. We pulse the C64's ATN line from JS and verify the
//      drive's pin samples reflect the change within one master tick.
{
  const m = new C64Machine();
  m.loadROMs({ kernal, basic, charRom: chargen });
  m.attachDrive(drvRom);
  m.setTrueDrive(true);
  m.setD64(new D64(buildEmptyD64()));
  m.reset();
  m.runFrame();

  const drv = m.drive1541;

  // Cycle the ATN line repeatedly; the drive's atnIn pin must follow. With
  // iecEdgeLatency the edge lands after the next master cycle's pipeline
  // step, so sample AFTER stepping (the drive's own next sample).
  let mismatch = 0;
  for (let i = 0; i < 50; i++) {
    const want = (i & 1) ? 0 : 1;
    m.cia2.portA = want ? 0x00 : 0x08;
    m._syncIecBus();
    C64Machine.prototype._runMasterCycle.call(m);
    if (drv.atnIn !== want) mismatch++;
  }
  assert(mismatch === 0,
    `drive's atnIn tracks 50 host-driven ATN edges with no mismatch (got ${mismatch})`);

  console.log('ok  – drive line-state tracks host ATN edges 1:1');
}

console.log('\nAll IEC handshake integration tests passed.');
