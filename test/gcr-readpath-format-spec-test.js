// test/gcr-readpath-format-spec-test.js
//
// Spec test for the on-disk GCR READ-PATH format the 1541 drive decodes.
// Maps "Die Floppy 1541" (Schramm) chapters 3.1.1, 7.1.1, 7.1.2, 7.2.1, 7.2.2.
//
// The synthetic D64→GCR stream (src/gcr.js buildTrackStream) is what the DOS
// ROM reads through the spindle. If its header/data framing, checksums, GCR
// 4→5 coding, SYNC marks, or sector layout diverge from spec, the drive
// mis-reads every sector — exactly the failure class we're hunting. This test
// decodes the stream using the CANONICAL 1541 GCR table (defined here from the
// spec, NOT imported from the implementation) and verifies the format.
//
// Spec points covered:
//   3.1.1  Sectors per track per zone: 21 / 19 / 18 / 17
//   7.1.1  Block header: $08, checksum(=T^S^ID1^ID2), S, T, ID2, ID1, $0F, $0F
//   7.1.2  Data block: $07, 256 data bytes, checksum(=XOR of 256)
//   7.2.1  SYNC mark = a run of consecutive 1-bits (≥10) ahead of header/data
//   7.2.2  GCR 4→5 group coding (round-trip: decode(encode(x)) == x)

import { GCRDisk } from '../src/gcr.js';
import { SPT } from '../src/d64.js';

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
}

// ── Canonical 1541 GCR 4→5 table (from the spec), and its 5→4 inverse. ──
// These are the hardware-defined codes; we DO NOT import the impl's table —
// decoding the impl's output with the spec table is the actual cross-check.
const GCR_ENCODE_SPEC = [
  0x0A, 0x0B, 0x12, 0x13, 0x0E, 0x0F, 0x16, 0x17,
  0x09, 0x19, 0x1A, 0x1B, 0x0D, 0x1D, 0x1E, 0x15,
];
const GCR_DECODE_SPEC = (() => {
  const t = new Array(32).fill(-1);
  for (let nib = 0; nib < 16; nib++) t[GCR_ENCODE_SPEC[nib]] = nib;
  return t;
})();

// ── Build a synthetic D64 with a recognisable sector at T18 S0. ──
function buildD64() {
  const img = new Uint8Array(196608);     // 40-track extended image (supports T36-40)
  const bam = (17 * 21) * 256;            // T18 S0 byte offset
  // Recognisable data pattern first...
  for (let i = 0; i < 256; i++) img[bam + i] = (i * 7 + 0x11) & 0xFF;
  // ...then the disk ID at $A2/$A3 (these ARE part of the 256-byte sector, so
  // they must be written AFTER the fill, and the header-ID assertions use them).
  img[bam + 0xA2] = 0x41;   // ID1 'A'
  img[bam + 0xA3] = 0x42;   // ID2 'B'
  return {
    img,
    readSector(track, sector) {
      let off = 0;
      for (let t = 1; t < track; t++) off += (SPT[t] || 17);
      off = (off + sector) * 256;
      return img.subarray(off, off + 256);
    },
  };
}

// ── Bit reader over the GCR byte stream (MSB-first within each byte). ──
function bitAt(stream, bitIndex) {
  const byte = stream[(bitIndex >> 3) % stream.length];
  return (byte >> (7 - (bitIndex & 7))) & 1;
}

// Find the first SYNC (run of ≥10 consecutive 1-bits) starting at `fromBit`;
// return the bit index of the first 0-bit after the run (= start of framed GCR).
function findSyncEnd(stream, fromBit, totalBits) {
  let ones = 0;
  for (let b = fromBit; b < totalBits; b++) {
    if (bitAt(stream, b) === 1) {
      ones++;
    } else {
      if (ones >= 10) return { syncStartOnes: ones, frameBit: b };
      ones = 0;
    }
  }
  return null;
}

// Like findSyncEnd but also reports `syncStart` (bit index where the ones-run
// began) so callers can measure the gap that precedes a SYNC.
function findSyncRun(stream, fromBit, totalBits) {
  let ones = 0, runStart = -1;
  for (let b = fromBit; b < totalBits; b++) {
    if (bitAt(stream, b) === 1) {
      if (ones === 0) runStart = b;
      ones++;
    } else {
      if (ones >= 10) return { syncStart: runStart, frameBit: b, ones };
      ones = 0;
    }
  }
  return null;
}

// Decode `nBytes` GCR-encoded bytes starting at bit `frameBit`. Returns the
// decoded raw bytes (each pair of 5-bit GCR codes → one byte).
function decodeGCR(stream, frameBit, nBytes, totalBits) {
  const nibbles = [];
  let bit = frameBit;
  for (let n = 0; n < nBytes * 2; n++) {       // 2 nibbles per byte
    let code = 0;
    for (let k = 0; k < 5; k++) {
      code = (code << 1) | bitAt(stream, bit % totalBits);
      bit++;
    }
    const nib = GCR_DECODE_SPEC[code];
    assert(nib >= 0, `GCR code %${code.toString(2).padStart(5,'0')} is a valid 1541 GCR symbol`);
    nibbles.push(nib);
  }
  const out = new Uint8Array(nBytes);
  for (let i = 0; i < nBytes; i++) out[i] = (nibbles[i * 2] << 4) | nibbles[i * 2 + 1];
  return out;
}

const d64 = buildD64();
const disk = new GCRDisk(d64);

// ──────────────────────────────────────────────────────────────────────────
// Spec [GCR-TABLE]: round-trip — decoding the impl's GCR with the canonical
// spec table recovers a known header marker. (Implicitly verifies the impl's
// 4→5 table equals the spec table; a wrong table yields invalid symbols.)
// ──────────────────────────────────────────────────────────────────────────
{
  console.log('Spec[7.2.2]: impl GCR stream decodes under the canonical 1541 4→5 table...');
  const stream = disk.getTrackStream(18);
  const totalBits = stream.length * 8;
  const sync = findSyncEnd(stream, 0, totalBits);
  assert(sync, 'a SYNC run (≥10 ones) exists on the track');
  const hdr = decodeGCR(stream, sync.frameBit, 8, totalBits);
  assert(hdr[0] === 0x08,
    `first decoded header byte is the $08 header mark (got $${hdr[0].toString(16)})`);
  console.log('ok  – impl GCR decodes cleanly with the spec table (header mark $08 recovered)');
}

// ──────────────────────────────────────────────────────────────────────────
// Spec [7.1.1]: block header = $08, checksum=T^S^ID1^ID2, S, T, ID2, ID1,
// $0F, $0F. Decode the first header and verify every field.
// ──────────────────────────────────────────────────────────────────────────
{
  console.log('Spec[7.1.1]: block header fields ($08, cks, S, T, ID2, ID1, $0F, $0F)...');
  const stream = disk.getTrackStream(18);
  const totalBits = stream.length * 8;
  const sync = findSyncEnd(stream, 0, totalBits);
  const hdr = decodeGCR(stream, sync.frameBit, 8, totalBits);
  const ID1 = 0x41, ID2 = 0x42, T = 18, S = 0;
  assert(hdr[0] === 0x08, `[0] header mark $08 (got $${hdr[0].toString(16)})`);
  assert(hdr[1] === (S ^ T ^ ID1 ^ ID2),
    `[1] checksum = T^S^ID1^ID2 = $${(S^T^ID1^ID2).toString(16)} (got $${hdr[1].toString(16)})`);
  assert(hdr[2] === S, `[2] sector = ${S} (got ${hdr[2]})`);
  assert(hdr[3] === T, `[3] track = ${T} (got ${hdr[3]})`);
  assert(hdr[4] === ID2, `[4] ID2 = $${ID2.toString(16)} (got $${hdr[4].toString(16)})`);
  assert(hdr[5] === ID1, `[5] ID1 = $${ID1.toString(16)} (got $${hdr[5].toString(16)})`);
  assert(hdr[6] === 0x0F, `[6] gap byte $0F (got $${hdr[6].toString(16)})`);
  assert(hdr[7] === 0x0F, `[7] gap byte $0F (got $${hdr[7].toString(16)})`);
  console.log('ok  – header matches the 1541 spec layout + checksum');
}

// ──────────────────────────────────────────────────────────────────────────
// Spec [7.1.2 / 7.2.2]: data block = $07 + 256 data bytes + checksum(XOR).
// Verify the data ID mark, that the 256 bytes round-trip the D64 sector
// content, and the checksum.
// ──────────────────────────────────────────────────────────────────────────
{
  console.log('Spec[7.1.2]: data block ($07 + 256 data + XOR checksum), round-trips D64 content...');
  const stream = disk.getTrackStream(18);
  const totalBits = stream.length * 8;
  // First sync = header sync; the SECOND sync after it = data sync.
  const hdrSync = findSyncEnd(stream, 0, totalBits);
  // Skip past the header's 8 decoded bytes (80 bits) before scanning for the
  // data sync, so we don't re-detect the header sync.
  const dataSync = findSyncEnd(stream, hdrSync.frameBit + 80, totalBits);
  assert(dataSync, 'a second SYNC (data block) follows the header');
  const blk = decodeGCR(stream, dataSync.frameBit, 259, totalBits); // 1 + 256 + checksum + ...
  assert(blk[0] === 0x07, `[0] data mark $07 (got $${blk[0].toString(16)})`);

  const sector = d64.readSector(18, 0);
  let mismatch = -1;
  for (let i = 0; i < 256; i++) if (blk[1 + i] !== sector[i]) { mismatch = i; break; }
  assert(mismatch < 0, `256 data bytes round-trip the D64 sector (first mismatch at ${mismatch})`);

  let cks = 0;
  for (let i = 0; i < 256; i++) cks ^= sector[i];
  assert(blk[257] === cks, `data checksum = XOR of 256 bytes = $${cks.toString(16)} (got $${blk[257].toString(16)})`);
  console.log('ok  – data block mark, payload round-trip, and checksum match spec');
}

// ──────────────────────────────────────────────────────────────────────────
// Spec [7.2.1]: SYNC mark is a run of ≥10 consecutive 1-bits. The header sync
// in the stream must be a long ones-run (the impl uses 5×$FF = 40 ones).
// ──────────────────────────────────────────────────────────────────────────
{
  console.log('Spec[7.2.1]: SYNC mark is a run of ≥10 consecutive 1-bits...');
  const stream = disk.getTrackStream(18);
  const totalBits = stream.length * 8;
  const sync = findSyncEnd(stream, 0, totalBits);
  assert(sync.syncStartOnes >= 10,
    `SYNC run length ≥10 ones (got ${sync.syncStartOnes})`);
  console.log(`ok  – SYNC run is ${sync.syncStartOnes} consecutive 1-bits`);
}

// ──────────────────────────────────────────────────────────────────────────
// Spec [3.1.1]: sectors per track per zone — 21 (1-17), 19 (18-24),
// 18 (25-30), 17 (31-35). Verify the stream contains exactly that many
// headers, and the SPT table matches.
// ──────────────────────────────────────────────────────────────────────────
{
  console.log('Spec[3.1.1]: sectors-per-track per zone (21/19/18/17) + header count on track...');
  assert(SPT[1] === 21 && SPT[17] === 21, 'tracks 1-17 → 21 sectors');
  assert(SPT[18] === 19 && SPT[24] === 19, 'tracks 18-24 → 19 sectors');
  assert(SPT[25] === 18 && SPT[30] === 18, 'tracks 25-30 → 18 sectors');
  assert(SPT[31] === 17 && SPT[35] === 17, 'tracks 31-35 → 17 sectors');

  // Count distinct header SYNC+$08 sequences on track 18 (expect 19).
  const stream = disk.getTrackStream(18);
  const totalBits = stream.length * 8;
  let headers = 0, bit = 0;
  while (bit < totalBits) {
    const sync = findSyncEnd(stream, bit, totalBits);
    if (!sync) break;
    const dec = decodeGCR(stream, sync.frameBit, 1, totalBits);
    if (dec[0] === 0x08) headers++;
    bit = sync.frameBit + 5;   // advance past this sync
  }
  assert(headers === SPT[18],
    `track 18 stream contains ${SPT[18]} headers (got ${headers})`);
  console.log(`ok  – ${headers} block headers on track 18 (= SPT)`);
}

// ──────────────────────────────────────────────────────────────────────────
// Spec [9.2]: sectors are located by their SELF-IDENTIFYING header (S + T),
// independent of physical order on the track. Decode every header on track 18
// and verify the sector numbers are exactly {0..18}, each with the right track
// and a self-consistent checksum — i.e. the drive can find any wanted sector
// by header regardless of where it sits. (This stays true under any future
// interleave/reorder; it asserts the spec property, not sequential layout.)
// ──────────────────────────────────────────────────────────────────────────
{
  console.log('Spec[9.2]: every sector is locatable by a self-identifying header (S/T)...');
  const stream = disk.getTrackStream(18);
  const totalBits = stream.length * 8;
  const ID1 = 0x41, ID2 = 0x42, T = 18;
  const seen = new Set();
  let bit = 0;
  while (bit < totalBits) {
    const sync = findSyncRun(stream, bit, totalBits);
    if (!sync) break;
    const hdr = decodeGCR(stream, sync.frameBit, 8, totalBits);
    if (hdr[0] === 0x08) {
      assert(hdr[3] === T, `header track = ${T} (got ${hdr[3]})`);
      assert(hdr[1] === (hdr[2] ^ hdr[3] ^ ID1 ^ ID2),
        `header checksum self-consistent for sector ${hdr[2]}`);
      seen.add(hdr[2]);
    }
    bit = sync.frameBit + 5;
  }
  for (let s = 0; s < SPT[18]; s++) assert(seen.has(s), `sector ${s} present via its header`);
  assert(seen.size === SPT[18], `exactly ${SPT[18]} distinct sectors (got ${seen.size})`);
  console.log(`ok  – all ${seen.size} sectors self-identify by header (S = {0..${SPT[18] - 1}})`);
}

// ──────────────────────────────────────────────────────────────────────────
// Spec [9.3]: gaps separate the on-disk structures — a header-to-data gap and
// an inter-sector gap (spec minimum 4 bytes). Verify the track carries 2 SYNCs
// per sector (header + data; their separation proves the header-to-data gap)
// and that every gap between a decoded block's end and the next SYNC's ones-run
// is ≥ 4 bytes (32 bits).
// ──────────────────────────────────────────────────────────────────────────
{
  console.log('Spec[9.3]: header-data + inter-sector gaps present and ≥4 bytes...');
  const stream = disk.getTrackStream(18);
  const totalBits = stream.length * 8;
  // Walk every SYNC; header ($08) frames 8 decoded bytes (80 GCR bits), data
  // ($07) frames 260 decoded bytes (2600 GCR bits). Record where each block
  // ends and where the following SYNC's ones-run begins.
  const syncs = [];
  let bit = 0;
  while (bit < totalBits) {
    const sync = findSyncRun(stream, bit, totalBits);
    if (!sync) break;
    const mark = decodeGCR(stream, sync.frameBit, 1, totalBits)[0];
    const blockBits = mark === 0x08 ? 80 : 2600;
    syncs.push({ start: sync.syncStart, mark, blockEnd: sync.frameBit + blockBits });
    bit = sync.frameBit + blockBits;   // skip the block to find the next SYNC
  }
  assert(syncs.length === SPT[18] * 2,
    `track 18 has 2 SYNCs/sector = ${SPT[18] * 2} (got ${syncs.length})`);
  let minGap = Infinity;
  for (let i = 0; i + 1 < syncs.length; i++) {
    const gap = syncs[i + 1].start - syncs[i].blockEnd;
    if (gap < minGap) minGap = gap;
  }
  assert(minGap >= 32, `every inter-structure gap ≥4 bytes (32 bits); min was ${minGap}`);
  console.log(`ok  – ${syncs.length} SYNCs (2/sector); min gap ${minGap} bits (≥32)`);
}

// ──────────────────────────────────────────────────────────────────────────
// Spec [9.4]: the 1541 head can position past track 35; D64 supports extended
// tracks 36-40 (17 sectors each). getTrackStream(40) must produce a valid
// stream whose headers all self-identify track 40, SPT[40] of them.
// ──────────────────────────────────────────────────────────────────────────
{
  console.log('Spec[9.4]: extended track 40 produces a valid GCR stream (17 headers, track=40)...');
  const stream = disk.getTrackStream(40);
  assert(stream && stream.length > 0, 'track 40 stream is non-empty');
  const totalBits = stream.length * 8;
  const seen = new Set();
  let bit = 0;
  while (bit < totalBits) {
    const sync = findSyncRun(stream, bit, totalBits);
    if (!sync) break;
    const hdr = decodeGCR(stream, sync.frameBit, 8, totalBits);
    if (hdr[0] === 0x08) {
      assert(hdr[3] === 40, `extended-track header track = 40 (got ${hdr[3]})`);
      seen.add(hdr[2]);
    }
    bit = sync.frameBit + 5;
  }
  assert(seen.size === SPT[40], `track 40 has ${SPT[40]} headers (got ${seen.size})`);
  console.log(`ok  – extended track 40: ${seen.size} headers, all track=40`);
}

console.log('\nAll GCR read-path format spec tests passed.');
