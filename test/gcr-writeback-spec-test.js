// test/gcr-writeback-spec-test.js
//
// Spec tests for D64 WRITE support (the GCR write-back path). No ROMs needed —
// these exercise the pure machinery:
//   - gcr.js  GCR encode↔decode round-trip and checksum rejection
//   - gcr.js  GCRDisk.commitDirtyTracks() (mutated track buffer → D64 image)
//   - d64.js  createBlankD64() (empty formatted image) + writeSector()
//   - drive1541.js  the write head shifting bytes onto the track buffer, and the
//                   write-protect PB4 polarity (0 = protected, 1 = write enabled)
//
// Spec sources: the 1541 GCR on-disk layout (header $08 / data $07 blocks, XOR
// checksums) and the VIA2 PB4 write-protect sense line (active low), per the
// 1541 schematic / DOS behavior (error 26 "WRITE PROTECT ON" on PB4 low).

import { createBlankD64, D64, SPT } from '../src/d64.js';
import { GCRDisk, decodeTrackStream } from '../src/gcr.js';
import { Drive1541 } from '../src/drive1541.js';

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
}

// ── 1. createBlankD64: a valid empty formatted disk ──────────────────────────
{
  const d = createBlankD64('MY DISK', '2A');
  assert(d.img.length === 174848, '35-track image is 174848 bytes');
  assert(d.diskName === 'MY DISK', `disk name parses back (got "${d.diskName}")`);
  assert(d.diskId === '2A', `disk id parses back (got "${d.diskId}")`);
  assert(d.freeBlocks === 664, `blank disk shows 664 blocks free (got ${d.freeBlocks})`);
  assert(d.entries.length === 0, 'blank disk has an empty directory');
  assert(d.writeProtected === false, 'a freshly created disk is write-enabled');
  assert(d.dirty === true, 'a freshly created disk is dirty (never persisted)');
  // Re-parsing the raw bytes standalone must yield the same empty disk.
  const d2 = new D64(d.img.slice());
  assert(d2.freeBlocks === 664 && d2.entries.length === 0, 'blank image re-parses clean');
}

// ── 2. GCR encode → decode round-trip (every sector, every zone) ─────────────
{
  const d = createBlankD64('TEST', '01');
  const poke = (t, s) => { const b = new Uint8Array(256); for (let i = 0; i < 256; i++) b[i] = (t * 7 + s * 13 + i * 3) & 0xFF; d.writeSector(t, s, b); };
  for (const [t, s] of [[1,0],[1,20],[17,10],[18,0],[18,5],[24,18],[30,0],[35,16]]) poke(t, s);
  const g = new GCRDisk(d);
  let checked = 0, mism = 0, wrongCount = 0;
  for (let t = 1; t <= 35; t++) {
    const blocks = decodeTrackStream(g.getTrackStream(t));
    if (blocks.length !== SPT[t]) wrongCount++;
    for (const b of blocks) {
      checked++;
      const orig = d.readSector(b.track, b.sector);
      for (let i = 0; i < 256; i++) if (orig[i] !== b.data[i]) { mism++; break; }
    }
  }
  assert(checked === 683, `all 683 sectors decode (got ${checked})`);
  assert(mism === 0, `round-trip is lossless (got ${mism} mismatches)`);
  assert(wrongCount === 0, `each track decodes its full sector count (${wrongCount} wrong)`);
}

// ── 3. Corrupt data block is rejected (checksum guard) ───────────────────────
{
  const g = new GCRDisk(createBlankD64('X', '04'));
  const st = g.getTrackStream(1);
  st[200] ^= 0xFF;                                   // flip bits inside a data region
  const decoded = decodeTrackStream(st);
  assert(decoded.length === SPT[1] - 1,
    `a corrupt block is skipped, never written (got ${decoded.length} of ${SPT[1]})`);
}

// ── 4. Write head: bytes shifted onto the surface decode back to sectors ──────
{
  const src = createBlankD64('SRC', '01');
  for (let s = 0; s < SPT[1]; s++) { const b = new Uint8Array(256); for (let i = 0; i < 256; i++) b[i] = (s * 17 + i * 5 + 3) & 0xFF; src.writeSector(1, s, b); }
  const track1 = new GCRDisk(src).getTrackStream(1);

  const drive = new Drive1541(new Uint8Array(16384), null);
  const dest = createBlankD64('DEST', '02');
  drive.setDisk(dest);
  drive.setWriteProtect(false);
  drive.motorOn = true;
  drive.currentHalfTrack = 2;                        // track 1
  drive.trackDirty = true;
  drive.currentSpeedZone = 3;                        // 26 cy/byte
  drive.via2.regs[0x03] = 0xFF;                      // DDRA = output
  drive.via2.regs[0x0C] = 0xCE;                      // PCR: CB2 write (110), CA2/SOE high
  assert(drive._isWriteMode() === true, 'CB2 low + DDRA output ⇒ write mode detected');

  const cyclesPerBit = 26 / 8;
  drive._lastWrittenByte = track1[0];                // prime byte 0
  for (let t = 0; t < track1.length * 8; t++) {
    if ((t + 1) % 8 === 0) { const k = (t + 1) / 8; if (k < track1.length) drive._lastWrittenByte = track1[k]; }
    drive._advanceSpindle(cyclesPerBit);
  }
  assert(drive.gcrDisk.hasDirtyTracks(), 'writing marks the track dirty');
  const wrote = drive.commitWrites();
  assert(wrote === SPT[1], `commit writes all ${SPT[1]} sectors (got ${wrote})`);
  let bad = 0;
  for (let s = 0; s < SPT[1]; s++) { const a = src.readSector(1, s), b = dest.readSector(1, s); for (let i = 0; i < 256; i++) if (a[i] !== b[i]) { bad++; break; } }
  assert(bad === 0, `written sectors match the source (got ${bad} mismatches)`);
  assert(dest.dirty === true, 'the head write marks the D64 dirty');
}

// ── 5. Write-protect PB4 polarity (the bug that blocked SAVE) ─────────────────
{
  const drive = new Drive1541(new Uint8Array(16384), null);
  drive.setDisk(createBlankD64('WP', '01'));         // write-enabled
  assert((drive.via2.readPortB() & 0x10) !== 0,
    'writable disk drives PB4 HIGH (write enabled)');
  drive.setWriteProtect(true);
  assert((drive.via2.readPortB() & 0x10) === 0,
    'write-protected disk drives PB4 LOW (the 1541 DOS reads low as protected)');
  drive.setWriteProtect(false);
  assert((drive.via2.readPortB() & 0x10) !== 0, 'unlock restores PB4 HIGH');
  drive.setDisk(null);
  assert((drive.via2.readPortB() & 0x10) !== 0, 'no disk ⇒ PB4 HIGH (nothing to protect)');
}

// ── 6. commitDirtyTracks folds a mutated cache into the image ─────────────────
{
  const src = createBlankD64('A', '01');
  for (let s = 0; s < SPT[1]; s++) { const b = new Uint8Array(256).fill((s + 1) & 0xFF); src.writeSector(1, s, b); }
  const gSrc = new GCRDisk(src);
  const blank = createBlankD64('B', '02');
  const gDest = new GCRDisk(blank);
  gDest.getTrackStream(1).set(gSrc.getTrackStream(1));   // simulate head laying src track 1
  gDest.markTrackDirty(1);
  const n = gDest.commitDirtyTracks();
  assert(n === SPT[1], `commit reports ${SPT[1]} sectors (got ${n})`);
  assert(!gDest.hasDirtyTracks(), 'dirty set cleared after commit');
  let bad = 0;
  for (let s = 0; s < SPT[1]; s++) { const a = src.readSector(1, s), b = blank.readSector(1, s); for (let i = 0; i < 256; i++) if (a[i] !== b[i]) { bad++; break; } }
  assert(bad === 0, 'committed image matches the source track');
}

console.log('\nAll GCR write-back spec tests passed.');
