// test/drive-soe-gating-spec-test.js
//
// This file locks in the spec for SOE (Serial Output Enable) gating of the
// 1541's BYTE-READY → 6502 SO pin: the drive drives SO only while SOE
// (VIA2 CA2) is high. drive1541.js implements this by gating setOverflow()
// on (via2.regs[0x0C] & 0x0E) === 0x0E at the byte-ready site.
//
// Spec sources (two independent confirmations):
//   1. VICE (observed) — byte-ready propagation is gated by the CA2/SOE
//      state.
//   2. "Die Floppy 1570/1571", §8.2: VIA2 CA2 is the SOE (serial output
//      enable) line — SOE is on while CA2 is driven high.
//      PCR ($1C0C) bit-field table — CA2 control = PCR bits 1-3:
//        110 → CA2 output Lo (SOE off)
//        111 → CA2 output Hi (SOE on)
//   The standard 1541 DOS writes PCR=$EE during sector reads ($EE → CA2
//   bits 1-3 = 111 → SOE on), so legitimate reads keep firing byte-ready.
//
// Observable surface only (no impl internals): VIA2 PCR via drive.write,
// 6502 V flag, GCR stream input, drive cycle counts.

import { Drive1541 } from '../src/drive1541.js';
import fs from 'fs';

function tryRead(p) { try { return new Uint8Array(fs.readFileSync(p)); } catch { return null; } }
const drvRom = tryRead(new URL('../roms/1541.bin', import.meta.url).pathname);
if (!drvRom) { console.log('# SKIP 1541 ROM not available'); process.exit(0); }

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
}

// PCR CA2 encodings (bits 1-3). SOE is high only when CA2 = 111.
const PCR_SOE_ON   = 0x0E; // CA2 = 111 (output high)  → SOE on
const PCR_SOE_OFF  = 0x0C; // CA2 = 110 (output low)   → SOE off
const PCR_CA2_PULSE = 0x0A; // CA2 = 101 (low pulse)   → SOE off (not sustained high)
const PCR_DOS_READ = 0xEE; // what the 1541 DOS actually writes during reads

function buildDrive(streamBytes, zone, pcr) {
  const drive = new Drive1541(drvRom.buffer);
  drive.gcrDisk = {
    getTrackStream: () => streamBytes,
    getSectorCount: () => 17,
  };
  drive.motorOn = true;
  drive.currentSpeedZone = zone;
  drive.write(0x1C0C, pcr);   // VIA2 PCR — sets CA2/SOE state
  return drive;
}

// Count V flag 0→1 transitions over a cycle window, clearing V on each rise
// (= emulating the CLV the DOS does after each byte read).
function countVRises(drive, cycles) {
  let prev = drive.cpu.V & 1;
  let count = 0;
  for (let cy = 0; cy < cycles; cy++) {
    drive._advanceSpindle(1);
    const v = drive.cpu.V & 1;
    if (prev === 0 && v === 1) { count++; drive.cpu.V = 0; prev = 0; }
    else prev = v;
  }
  return count;
}

const STREAM = new Uint8Array(64).fill(0x55); // 01010101 — no sync, steady bytes

// ---------------------------------------------------------------------------
// Spec [SOE-1]: with SOE ON (CA2=111), byte-ready DOES set V — one rise per
// assembled byte. (This already holds with the current unconditional impl.)
// ---------------------------------------------------------------------------
{
  console.log('Spec[SOE-1]: SOE on (PCR CA2=111) → byte-ready sets V once per byte...');
  const drive = buildDrive(STREAM, 1, PCR_SOE_ON);  // zone 1 = 30 cy/byte
  const N = 20;
  const rises = countVRises(drive, N * 30 + 25);
  assert(rises >= N - 1 && rises <= N + 1,
    `SOE on → ~${N} V rises in ${N} byte-times (got ${rises})`);
  console.log(`ok  – ${rises} V rises with SOE enabled`);
}

// ---------------------------------------------------------------------------
// Spec [SOE-2]: with SOE OFF (CA2=110), byte-ready must NOT set V at all.
// ---------------------------------------------------------------------------
{
  console.log('Spec[SOE-2]: SOE off (PCR CA2=110) → byte-ready does NOT set V...');
  const drive = buildDrive(STREAM, 1, PCR_SOE_OFF);
  const N = 20;
  const rises = countVRises(drive, N * 30 + 25);
  assert(rises === 0,
    `SOE off → 0 V rises (got ${rises}); setOverflow() must gate on ` +
    `(via2.regs[0x0C] & 0x0E) === 0x0E.`);
  console.log('ok  – V suppressed while SOE disabled');
}

// ---------------------------------------------------------------------------
// Spec [SOE-3]: CA2 pulse modes (e.g. 101) are not sustained-high, so SOE is
// off and byte-ready must NOT set V.
// ---------------------------------------------------------------------------
{
  console.log('Spec[SOE-3]: CA2 pulse mode (PCR bits 1-3 = 101) → SOE off, V not set...');
  const drive = buildDrive(STREAM, 1, PCR_CA2_PULSE);
  const rises = countVRises(drive, 20 * 30 + 25);
  assert(rises === 0,
    `CA2 pulse mode → SOE off → 0 V rises (got ${rises}).`);
  console.log('ok  – V suppressed in CA2 pulse mode');
}

// ---------------------------------------------------------------------------
// Spec [SOE-4]: toggling SOE off→on resumes byte-ready. Run with SOE off
// (expect no V), then enable SOE mid-stream (expect V rises resume).
// ---------------------------------------------------------------------------
{
  console.log('Spec[SOE-4]: SOE off→on transition gates then resumes byte-ready...');
  const drive = buildDrive(STREAM, 1, PCR_SOE_OFF);
  const risesOff = countVRises(drive, 10 * 30);
  assert(risesOff === 0,
    `phase 1 (SOE off) → 0 V rises (got ${risesOff}).`);

  drive.write(0x1C0C, PCR_SOE_ON);     // enable SOE
  const risesOn = countVRises(drive, 10 * 30 + 25);
  assert(risesOn >= 9 && risesOn <= 11,
    `phase 2 (SOE on) → ~10 V rises (got ${risesOn})`);
  console.log(`ok  – SOE off: ${risesOff} rises; SOE on: ${risesOn} rises`);
}

// ---------------------------------------------------------------------------
// Spec [SOE-5]: the exact PCR value the 1541 DOS uses for reads ($EE) keeps
// SOE enabled. This guards against an over-aggressive gate that would break
// the normal read path. (Passes now; must keep passing after the fix.)
// ---------------------------------------------------------------------------
{
  console.log('Spec[SOE-5]: PCR=$EE (DOS read config) keeps SOE enabled...');
  const drive = buildDrive(STREAM, 1, PCR_DOS_READ);
  const rises = countVRises(drive, 20 * 30 + 25);
  assert(rises >= 19 && rises <= 21,
    `PCR=$EE → SOE on → ~20 V rises (got ${rises}); the gate must accept $EE`);
  console.log(`ok  – PCR=$EE keeps byte-ready firing (${rises} rises)`);
}

console.log('\nAll SOE-gating spec tests passed (feature implemented).');
