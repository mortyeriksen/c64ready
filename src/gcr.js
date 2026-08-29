// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/gcr.js – GCR (Group Code Recording) encoder for 1541 disk images.
// The 1541 DOS ROM reads raw GCR bitstreams from the read head. To run the
// DOS ROM against a D64 image we must synthesise a plausible GCR track stream
// that the ROM can decode using its normal routines.
//
// Encoding: every 4 data bits → 5 GCR bits (4-to-5 table below). Five data
// bytes become 5 GCR bytes (after nibble interleave). Sync marks are runs of
// at least 10 consecutive 1-bits and are represented as contiguous 0xFF bytes
// in the stream.

import { SPT } from './d64.js';

// 4→5 GCR encoding table
const GCR_ENCODE = [
  0x0A, 0x0B, 0x12, 0x13, 0x0E, 0x0F, 0x16, 0x17,
  0x09, 0x19, 0x1A, 0x1B, 0x0D, 0x1D, 0x1E, 0x15,
];

// 5→4 GCR decoding table — the inverse of GCR_ENCODE. Indexed by the 5-bit GCR
// code (0..31); invalid codes (never emitted by a valid encoder) map to 0xFF so
// the decoder can reject a mis-framed or corrupt block instead of writing garbage.
const GCR_DECODE = (() => {
  const t = new Uint8Array(32).fill(0xFF);
  GCR_ENCODE.forEach((code, nibble) => { t[code] = nibble; });
  return t;
})();

// GCR bytes per track (index by zone 0..3)
// Derived from the 1541 hardware: 300 RPM × 4 speed zones.
// Approximations that sum close to one revolution of raw GCR.
const TRACK_SIZE = [7692, 7142, 6666, 6250];

/** Get the speed zone for a track (0 = fastest/outermost). */
export function zoneForTrack(track) {
  if (track <= 17) return 0;
  if (track <= 24) return 1;
  if (track <= 30) return 2;
  return 3;
}

/** Cycles-per-GCR-byte INDEXED BY THE VIA2 PB5/PB6 DENSITY BITS (0-3).
 * Real 1541: bit pattern 00 = innermost tracks 31-35 = 32 cyc/byte (slowest);
 *            bit pattern 11 = outermost tracks 1-17 = 26 cyc/byte (fastest).
 * Drive fastloaders set PB5/PB6 to the density value matching the current
 * track; the spindle must clock the GCR stream at that rate or the loader's
 * tight cycle-counted byte protocol drifts and rejects every header.
 *
 * Note: this is OPPOSITE indexing from zoneForTrack() above, which numbers
 * zones outer→inner (0..3). Don't conflate the two — zoneForTrack is for
 * sizing TRACK_SIZE / TAIL_GAP; this array is for VIA2-density lookup. */
export const CYCLES_PER_BYTE = [32, 30, 28, 26];

// Error-table codes (the format's own 1-based numbering) for the faults that
// change what the read head finds. An error table can't hold a custom track
// layout the way raw GCR can, but it does record which sectors refused to read —
// which is what a protection check looks for, since a sector that reads back
// perfectly is the mark of a copy.
//
// Codes not listed here are write failures reported when the image was made
// (24/25/26/28) or a drive that wasn't ready (74): the recorded sector is fine,
// so it reads normally.
const ERR_HEADER_NOT_FOUND = 2;   // DOS error 20
const ERR_NO_SYNC          = 3;   // DOS error 21
const ERR_DATA_NOT_FOUND   = 4;   // DOS error 22
const ERR_DATA_CHECKSUM    = 5;   // DOS error 23
const ERR_HEADER_CHECKSUM  = 9;   // DOS error 27
const ERR_DISK_ID_MISMATCH = 11;  // DOS error 29

// Inter-sector tail gap per zone, in GCR bytes, per the standard D64
// on-disk layout. Fastloaders that decode
// timing from gap-relative byte counts can wedge if our gap diverges.
//   zone 0 (tracks 1-17)  → 8
//   zone 1 (tracks 18-24) → 17
//   zone 2 (tracks 25-30) → 12
//   zone 3 (tracks 31-35) → 9
const TAIL_GAP = [8, 17, 12, 9];

/** Encode one 256-byte sector (plus header) into GCR bytes.
 *  `diskId` is the 2-byte BAM disk ID (used in sector header). */
function encodeGCRBlock(dataBytes) {
  // Input length must be multiple of 4. Pad if needed.
  const padded = dataBytes.length % 4 === 0
    ? dataBytes
    : (() => {
        const p = new Uint8Array(Math.ceil(dataBytes.length / 4) * 4);
        p.set(dataBytes);
        return p;
      })();

  const outLen = (padded.length / 4) * 5;
  const out = new Uint8Array(outLen);

  // Pack bits MSB-first into the output buffer
  let bitBuf = 0;
  let bitCount = 0;
  let outPos = 0;
  for (let i = 0; i < padded.length; i++) {
    const hi = (padded[i] >> 4) & 0x0F;
    const lo = padded[i] & 0x0F;
    bitBuf = (bitBuf << 5) | GCR_ENCODE[hi];
    bitCount += 5;
    bitBuf = (bitBuf << 5) | GCR_ENCODE[lo];
    bitCount += 5;
    while (bitCount >= 8) {
      bitCount -= 8;
      out[outPos++] = (bitBuf >> bitCount) & 0xFF;
    }
  }
  return out;
}

/** Build the GCR stream for one full track (all sectors + gaps + sync marks). */
function buildTrackStream(d64, track, diskId1, diskId2) {
  const zone = zoneForTrack(track);
  const size = TRACK_SIZE[zone];
  const out = new Uint8Array(size);
  out.fill(0x55);  // inter-sector gap filler

  const sectors = SPT[track] || 0;
  let pos = 0;

  for (let sec = 0; sec < sectors; sec++) {
    // A track the image doesn't reach (36-40 of a 35-track disk): leave the gap
    // filler, and the head finds an unformatted track — no sync, no header.
    const sectorData = d64.readSector(track, sec);
    if (!sectorData || sectorData.length < 256) continue;

    // Put back whatever the error table says went wrong here. `errorForSector` is
    // optional so the drive tests' disk-like doubles keep working.
    const err = typeof d64.errorForSector === 'function' ? d64.errorForSector(track, sec) : 1;
    // Error 21 = "no sync found": drop this sector's two sync marks and the head
    // sweeps past it. The gap bytes still go down, so the layout is unchanged.
    const sync = err === ERR_NO_SYNC ? 0x55 : 0xFF;

    // ── Header sync (5 bytes of 0xFF) ──
    for (let i = 0; i < 5; i++) if (pos < size) out[pos++] = sync;

    // ── Header block ────────────────────────────────────────────────────────
    // Standard 1541 GCR header block:
    //   [08, checksum, sector, track] + [id2, id1, $0F, $0F]
    // The trailing $0F $0F bytes are critical — some fastloaders (e.g.,
    // Next Level Performers / Oxyron-style decoders) parse the encoded
    // header through arithmetic pipelines that take the $0F-encoded GCR
    // pattern as a known terminator and reject $00-encoded headers.
    //
    // Error 29 = wrong disk ID in the header, so the ID goes in first and the
    // checksum covers what was written — else the drive reports a checksum error
    // (27) before it ever compares the ID.
    const id1 = err === ERR_DISK_ID_MISMATCH ? diskId1 ^ 0xFF : diskId1;
    const id2 = err === ERR_DISK_ID_MISMATCH ? diskId2 ^ 0xFF : diskId2;
    const headerData = new Uint8Array(8);
    headerData[0] = err === ERR_HEADER_NOT_FOUND ? 0x00 : 0x08;   // header ID
    headerData[1] = sec ^ track ^ id1 ^ id2;       // checksum
    headerData[2] = sec;
    headerData[3] = track;
    headerData[4] = id2;
    headerData[5] = id1;
    headerData[6] = 0x0F;
    headerData[7] = 0x0F;
    if (err === ERR_HEADER_CHECKSUM) headerData[1] ^= 0xFF;
    const headerGCR = encodeGCRBlock(headerData);  // 10 bytes
    for (let i = 0; i < headerGCR.length && pos < size; i++) out[pos++] = headerGCR[i];

    // ── Header-to-data gap (9 bytes on a 1541, per VICE) ──
    for (let i = 0; i < 9 && pos < size; i++) out[pos++] = 0x55;

    // ── Data sync (5 bytes of 0xFF) ──
    for (let i = 0; i < 5 && pos < size; i++) out[pos++] = sync;

    // ── Data block (1 ID + 256 data + 1 checksum + 2 pad = 260 bytes → 325 GCR) ──
    const dataBlock = new Uint8Array(260);
    dataBlock[0] = err === ERR_DATA_NOT_FOUND ? 0x00 : 0x07;   // data ID
    dataBlock.set(sectorData, 1);                  // 256 bytes
    let checksum = 0;
    for (let i = 0; i < 256; i++) checksum ^= sectorData[i];
    dataBlock[257] = err === ERR_DATA_CHECKSUM ? checksum ^ 0xFF : checksum;
    // dataBlock[258..259] = 0 already
    const dataGCR = encodeGCRBlock(dataBlock);    // 325 bytes
    for (let i = 0; i < dataGCR.length && pos < size; i++) out[pos++] = dataGCR[i];

    // ── Inter-sector tail gap (fixed per zone, matching VICE D64 layout) ──
    const tailGap = TAIL_GAP[zone];
    if (sec < sectors - 1) pos += Math.min(tailGap, size - pos);
  }

  return out;
}

// ── GCR decode (write-back): raw track bitstream → sectors ───────────────────
// The inverse of buildTrackStream. The drive's write head mutates the raw GCR
// track buffer in place (see drive1541.js); to fold those writes back into the
// D64 image we read the buffer exactly as a real read head would — hunt for a
// sync mark, then decode the following GCR bytes — and pair each header block
// with the data block that follows it.

/** Decode `nBytes` GCR-encoded bytes starting at absolute bit `startBit` of the
 *  circular stream (via `bitAt`). Returns {bytes, ok, endBit}; ok is false if any
 *  5-bit group is not a valid GCR code. Two 5-bit codes → one byte, MSB-first,
 *  matching encodeGCRBlock's bit packing. */
function decodeGCRBytes(bitAt, startBit, nBytes) {
  const bytes = new Uint8Array(nBytes);
  let bit = startBit;
  let ok = true;
  for (let b = 0; b < nBytes; b++) {
    let hiCode = 0;
    for (let k = 0; k < 5; k++) hiCode = (hiCode << 1) | bitAt(bit++);
    let loCode = 0;
    for (let k = 0; k < 5; k++) loCode = (loCode << 1) | bitAt(bit++);
    const hi = GCR_DECODE[hiCode];
    const lo = GCR_DECODE[loCode];
    if (hi === 0xFF || lo === 0xFF) ok = false;
    bytes[b] = ((hi & 0x0F) << 4) | (lo & 0x0F);
  }
  return { bytes, ok, endBit: bit };
}

/** Decode one block beginning at `startBit` (the first GCR bit after a sync).
 *  Sizes the block from its ID byte: $08 header (8 bytes) or $07 data (260).
 *  Returns {type, bytes} or null if the ID/codes are invalid. */
function decodeBlockAt(bitAt, startBit) {
  const head = decodeGCRBytes(bitAt, startBit, 1);
  if (!head.ok) return null;
  const type = head.bytes[0];
  const n = type === 0x08 ? 8 : type === 0x07 ? 260 : 0;
  if (n === 0) return null;
  const blk = decodeGCRBytes(bitAt, startBit, n);
  if (!blk.ok) return null;
  return { type, bytes: blk.bytes };
}

/**
 * Decode a full raw GCR track buffer into the sectors written on it.
 * Scans one revolution (circularly, so a block straddling the wrap is caught),
 * detecting sync (≥10 one-bits) exactly like the read head. Each `$08` header
 * supplies the (track, sector) for the `$07` data block that follows it; both
 * checksums are verified and any bad/invalid block is skipped — never written.
 * @param {Uint8Array} stream raw GCR bytes for one track
 * @returns {Array<{track:number, sector:number, data:Uint8Array}>}
 */
export function decodeTrackStream(stream) {
  if (!stream || stream.length === 0) return [];
  const totalBits = stream.length * 8;
  const bitAt = (i) => {
    i = ((i % totalBits) + totalBits) % totalBits;
    return (stream[i >> 3] >> (7 - (i & 7))) & 1;
  };

  const out = [];
  let onesInRow = 0;
  let pendTrack = -1, pendSector = -1;
  // Scan one full revolution plus a small overlap so a sync that wraps the seam
  // is still recognised. GCR data never contains 10 consecutive ones, so block
  // bytes cannot spoof a sync — re-scanning a decoded block is harmless.
  const limit = totalBits + 40;
  for (let i = 0; i < limit; i++) {
    if (bitAt(i) === 1) { onesInRow++; continue; }
    if (onesInRow >= 10) {
      // Sync just ended; bit `i` is the first GCR bit of the block.
      const blk = decodeBlockAt(bitAt, i);
      if (blk && blk.type === 0x08) {
        // Header: [08, checksum, sector, track, id2, id1, 0F, 0F].
        const chk = blk.bytes[2] ^ blk.bytes[3] ^ blk.bytes[4] ^ blk.bytes[5];
        if (chk === blk.bytes[1]) { pendTrack = blk.bytes[3]; pendSector = blk.bytes[2]; }
        else { pendTrack = -1; pendSector = -1; }
      } else if (blk && blk.type === 0x07 && pendSector >= 0) {
        // Data: [07, 256 data, xor-checksum, pad, pad].
        let chk = 0;
        for (let k = 0; k < 256; k++) chk ^= blk.bytes[1 + k];
        if (chk === blk.bytes[257]) {
          out.push({ track: pendTrack, sector: pendSector, data: blk.bytes.slice(1, 257) });
        }
        pendTrack = -1; pendSector = -1;
      }
    }
    onesInRow = 0;
  }
  return out;
}

/** Wraps a D64 instance and produces GCR track streams on demand. */
export class GCRDisk {
  constructor(d64) {
    this.d64 = d64;
    // Disk ID from BAM track 18 sector 0, bytes $A2/$A3
    const bam = d64.readSector(18, 0);
    this.diskId1 = bam ? bam[0xA2] : 0x30;
    this.diskId2 = bam ? bam[0xA3] : 0x30;
    // The head can step to track 42; how much an image describes is its own
    // business (35/40/42 tracks — a disk-like test double, none).
    this.maxTrack = d64.trackCount || 42;
    this._cache = new Array(43);  // 1..42
    // Tracks whose cached GCR buffer the write head has mutated and that have
    // not yet been decoded back into d64.img (see commitDirtyTracks).
    this._dirtyTracks = new Set();
  }

  getTrackStream(track) {
    if (track < 1 || track > this.maxTrack) return null;
    if (!this._cache[track]) {
      this._cache[track] = buildTrackStream(this.d64, track, this.diskId1, this.diskId2);
    }
    return this._cache[track];
  }

  getSectorCount(track) { return SPT[track] || 0; }

  /** Note that the write head mutated track `track`'s cached GCR buffer. */
  markTrackDirty(track) { if (track >= 1 && track <= this.maxTrack) this._dirtyTracks.add(track); }

  /** Whether any written track is waiting to be folded back into d64.img. */
  hasDirtyTracks() { return this._dirtyTracks.size > 0; }

  /**
   * Decode every dirty track's cached GCR buffer back into d64.img and clear the
   * dirty set. Because the encode↔decode round-trip is lossless, re-writing a
   * track's untouched sectors is idempotent; only genuinely changed sectors move.
   * Bad/garbage blocks are skipped by the decoder, so a half-written track can
   * never corrupt previously-good sectors. Returns the number of sectors written.
   */
  commitDirtyTracks() {
    if (this._dirtyTracks.size === 0) return 0;
    let written = 0;
    for (const track of this._dirtyTracks) {
      const stream = this._cache[track];
      if (!stream) continue;
      for (const blk of decodeTrackStream(stream)) {
        if (this.d64.writeSector(blk.track, blk.sector, blk.data)) written++;
      }
    }
    this._dirtyTracks.clear();
    return written;
  }
}
