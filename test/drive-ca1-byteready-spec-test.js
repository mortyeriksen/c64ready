// test/drive-ca1-byteready-spec-test.js
//
// Spec test for the 1541's BYTE-READY → VIA2 CA1 interrupt-flag latch.
//
// Per "Die Floppy 1571" §8.2 (1541-inherited hardware): the disk
// controller's BYTE-READY line is wired to BOTH the 6502 SO pin AND VIA2
// CA1. The CA1 connection latches VIA2 IFR bit 1 on each assembled byte,
// INDEPENDENT of SOE (which only gates the SO pin). Reading the VIA2 ports
// ($1C01 PA / $1C00 PB) clears the CA1 flag (handshake). It only raises a
// drive IRQ if VIA2 IER bit 1 is enabled.
//
// Observable surface only: VIA2 IFR ($1C0D), PA ($1C01), PB ($1C00), PCR
// ($1C0C), and the GCR stream input.

import { Drive1541 } from '../src/drive1541.js';
import fs from 'fs';

function tryRead(p) { try { return new Uint8Array(fs.readFileSync(p)); } catch { return null; } }
const drvRom = tryRead(new URL('../roms/1541.bin', import.meta.url).pathname);
if (!drvRom) { console.log('# SKIP 1541 ROM not available'); process.exit(0); }

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
}

// Build a drive with a GCR stream; caller chooses the PCR (SOE) state.
function buildDrive(streamBytes, pcr) {
  const drive = new Drive1541(drvRom.buffer);
  drive.gcrDisk = { getTrackStream: () => streamBytes, getSectorCount: () => 17 };
  drive.motorOn = true;
  drive.currentSpeedZone = 1;        // 30 cy/byte
  drive.write(0x1C0C, pcr);          // PCR: CA2/SOE + CA1-edge config
  return drive;
}

// Advance the spindle until VIA2 IFR bit 1 (CA1) latches, or give up.
function advanceUntilCa1(drive, maxCycles) {
  for (let cy = 0; cy < maxCycles; cy++) {
    drive._advanceSpindle(1);
    if ((drive.via2.ifr & 0x02) !== 0) return cy + 1;
  }
  return -1;
}

const STREAM = new Uint8Array(64).fill(0x55);  // 01010101 — no sync

// ---------------------------------------------------------------------------
// Spec [CA1-1]: BYTE-READY latches VIA2 IFR bit 1 — even with SOE OFF.
// (CA1 is independent of the SO pin / SOE gate.)
// ---------------------------------------------------------------------------
{
  console.log('Spec[CA1-1]: byte-ready latches VIA2 IFR bit 1 with SOE OFF...');
  // PCR CA2=110 (PCR & 0x0E = 0x0C) → SOE off, so the SO pin / V flag stay
  // clear; the CA1 latch must STILL set on byte-ready.
  const drive = buildDrive(STREAM, 0x0C);
  const cy = advanceUntilCa1(drive, 2 * 30);
  assert(cy > 0, `IFR bit 1 latched on byte-ready (cy=${cy})`);
  assert(drive.cpu.V === 0, `SO pin/V stayed clear with SOE off (V=${drive.cpu.V})`);
  console.log(`ok  – CA1 IFR bit 1 set at cy ${cy} while SOE off (V remained 0)`);
}

// ---------------------------------------------------------------------------
// Spec [CA1-2]: reading $1C01 (VIA2 PA) clears the CA1 flag (handshake).
// ---------------------------------------------------------------------------
{
  console.log('Spec[CA1-2]: reading $1C01 clears the CA1 IFR flag...');
  const drive = buildDrive(STREAM, 0x0C);
  assert(advanceUntilCa1(drive, 2 * 30) > 0, 'CA1 latched first');
  assert((drive.via2.ifr & 0x02) !== 0, 'IFR bit 1 set before read');
  drive.read(0x1C01);                                   // PA read → handshake clear
  assert((drive.via2.ifr & 0x02) === 0, 'IFR bit 1 cleared after $1C01 read');
  console.log('ok  – $1C01 read clears CA1 flag');
}

// ---------------------------------------------------------------------------
// Spec [CA1-3]: reading $1C00 (VIA2 PB) does NOT clear the CA1 flag. Per the
// 6522 spec, CA1 (IFR bit 1) is cleared only by Port A access; Port B access
// clears the CB1/CB2 flags (bits 3-4). So the CA1 byte-ready flag survives a
// $1C00 read and is cleared only by reading $1C01.
// ---------------------------------------------------------------------------
{
  console.log('Spec[CA1-3]: reading $1C00 does NOT clear CA1 (Port-A-only handshake)...');
  const drive = buildDrive(STREAM, 0x0C);
  assert(advanceUntilCa1(drive, 2 * 30) > 0, 'CA1 latched first');
  drive.read(0x1C00);                                   // PB read: CA1 must persist
  assert((drive.via2.ifr & 0x02) !== 0, 'IFR bit 1 still set after $1C00 read');
  drive.read(0x1C01);                                   // PA read clears it
  assert((drive.via2.ifr & 0x02) === 0, 'IFR bit 1 cleared after $1C01 read');
  console.log('ok  – CA1 survives $1C00 read, cleared by $1C01');
}

// ---------------------------------------------------------------------------
// Spec [CA1-4]: CA1 latches once per assembled byte and re-latches after the
// handshake clears it — one latch per byte cadence.
// ---------------------------------------------------------------------------
{
  console.log('Spec[CA1-4]: CA1 re-latches once per byte after handshake clear...');
  const drive = buildDrive(STREAM, 0x0C);
  let latches = 0;
  for (let cy = 0; cy < 10 * 30 + 30; cy++) {
    drive._advanceSpindle(1);
    if ((drive.via2.ifr & 0x02) !== 0) { latches++; drive.read(0x1C01); }  // count + clear
  }
  // ~10 bytes in 10 byte-times (±1 for fractional cycles-per-bit)
  assert(latches >= 9 && latches <= 11,
    `CA1 latched ~10x per 10 byte-times (got ${latches})`);
  console.log(`ok  – CA1 latched ${latches} times in 10 byte-times`);
}

// ---------------------------------------------------------------------------
// Spec [CA1-5]: with SOE ON (PCR=$EE), byte-ready latches CA1 AND sets V.
// (Both paths fire — the CA1 latch is not suppressed by SOE being on.)
// ---------------------------------------------------------------------------
{
  console.log('Spec[CA1-5]: SOE on → byte-ready latches CA1 and sets the SO/V flag...');
  const drive = buildDrive(STREAM, 0xEE);   // DOS read config: CA2=111 (SOE on)
  const cy = advanceUntilCa1(drive, 2 * 30 + 30);
  assert(cy > 0, 'CA1 latched with SOE on');
  // With SOE on and the (gated) SO-delay, V also rises within the byte window.
  let vRose = drive.cpu.V === 1;
  for (let i = 0; i < 30 && !vRose; i++) { drive._advanceSpindle(1); if (drive.cpu.V === 1) vRose = true; }
  assert(vRose, 'SO pin/V also rose with SOE on');
  console.log('ok  – CA1 + SO both fire when SOE enabled');
}

console.log('\nAll CA1 byte-ready latch spec tests passed.');
