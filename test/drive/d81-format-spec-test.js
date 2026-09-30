// test/drive/d81-format-spec-test.js
//
// Spec test for the 1581's D81 image: size variants, geometry, the header and
// BAM bytes a formatted disk carries, allocation across the two BAM sectors,
// the directory's 296-entry limit, partitions, the error table, and the rule
// that a 1541 cannot hold one.
//
// Spec basis: Peter Schepers, "D81 (Electronic form of a physical 1581 disk)":
// 80 tracks of 40 sectors (819200 bytes, 822400 with one error byte per
// sector); header at 40/0 (first directory sector, DOS byte $44, name at $04,
// ID at $16, "3D" at $19); BAM at 40/1 for tracks 1-40 and 40/2 for 41-80, six
// bytes per track from $10 (free count + 40-bit map), version $44 and its
// complement $BB, the ID again, the I/O byte; directory from 40/3, interleave
// 1; file type 5 = CBM partition. The 1581 User's Guide gives a formatted disk
// 3160 blocks free. The drive rule is physical: a 1541 has no head for a 3.5"
// MFM disk.
//
// Observed surface: d64Variant, the D64 class over a D81 image (kind,
// readableBy1541, trackCount, hasErrorInfo, readSector/writeSector,
// errorForSector, freeBlocks, entries, writePRG, loadFile, scratch,
// buildDirectoryPRG), createBlankD81/createBlankDisk, and Drive1541.setDisk.

import { D64, createBlankD64, createBlankD81, createBlankDisk, d64Variant } from '../../src/media/d64.js';
import { Drive1541 } from '../../src/drive1541.js';

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failed++; }
}
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const off = (t, s) => ((t - 1) * 40 + s) * 256;

/** The directory listing as LIST would show it: [{ num, text }]. */
function listing(disk, pattern) {
  const prg = disk.buildDirectoryPRG(pattern);
  const lines = [];
  let p = 2;
  for (;;) {
    const next = prg[p] | (prg[p + 1] << 8);
    if (!next) break;
    const num = prg[p + 2] | (prg[p + 3] << 8);
    let q = p + 4, text = '';
    while (prg[q]) text += String.fromCharCode(prg[q++]);
    lines.push({ num, text });
    p = q + 1;
  }
  return lines;
}

function somePrg(size, seed) {
  const b = new Uint8Array(size);
  b[0] = 0x01; b[1] = 0x08;
  for (let i = 2; i < size; i++) { seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF; b[i] = seed & 0xFF; }
  return b;
}

// ── 1. the two lengths a D81 can have ────────────────────────────────────────
{
  const v = d64Variant(819200);
  assert(v && v.kind === 'd81' && v.tracks === 80 && v.errorInfo === false,
    '819200 bytes is a D81: 80 tracks, no error table');
  const e = d64Variant(822400);
  assert(e && e.kind === 'd81' && e.tracks === 80 && e.errorInfo === true,
    '822400 bytes is a D81 with a 3200-byte error table');
  assert(d64Variant(819201) === null && d64Variant(822399) === null,
    'a length no 1581 image has is not a disk image');
  assert(d64Variant(174848).kind === 'd64', 'a D64 length still answers as d64');
}

// ── 2. geometry: 80 tracks of 40 sectors ─────────────────────────────────────
{
  const d = new D64(new Uint8Array(819200));
  assert(d.kind === 'd81' && d.trackCount === 80 && d.readableBy1541 === false,
    'a D81 parses as 80 tracks a 1541 cannot read');
  assert(d.readSector(80, 39) !== null, 'track 80 sector 39 is the last sector');
  assert(d.readSector(81, 0) === null, 'there is no track 81');
  assert(d.readSector(1, 40) === null, 'every track has sectors 0-39 only');
  const marker = new Uint8Array(256).fill(0x5A);
  assert(d.writeSector(60, 7, marker), 'writeSector reaches the second half of the disk');
  assert(d.img[off(60, 7)] === 0x5A && d.img[off(60, 7) + 255] === 0x5A,
    'sector (t, s) lives at ((t-1)*40+s)*256');
  assert(d.img[off(60, 6) + 255] === 0 && d.img[off(60, 8)] === 0, 'and its neighbours are untouched');
}

// ── 3. what a formatted disk carries ─────────────────────────────────────────
{
  const d = createBlankD81('SPEC DISK', 'SD');
  const hdr = d.img.subarray(off(40, 0), off(40, 0) + 256);
  assert(hdr[0] === 40 && hdr[1] === 3, 'header points at the first directory sector, 40/3');
  assert(hdr[2] === 0x44 && hdr[3] === 0x00, 'header DOS byte is $44, followed by $00');
  assert(String.fromCharCode(...hdr.subarray(4, 13)) === 'SPEC DISK' && hdr.subarray(13, 20).every(b => b === 0xA0),
    'the name sits at $04, shift-space padded to 16');
  assert(hdr[0x14] === 0xA0 && hdr[0x15] === 0xA0, '$14-$15 are shift-spaces');
  assert(hdr[0x16] === 0x53 && hdr[0x17] === 0x44, 'the disk ID sits at $16');
  assert(hdr[0x18] === 0xA0 && hdr[0x19] === 0x33 && hdr[0x1A] === 0x44 && hdr[0x1B] === 0xA0 && hdr[0x1C] === 0xA0,
    'DOS type "3D" sits at $19 between shift-spaces');
  assert(hdr.subarray(0x1D).every(b => b === 0), 'the rest of the header is unused');

  const bam1 = d.img.subarray(off(40, 1), off(40, 1) + 256);
  const bam2 = d.img.subarray(off(40, 2), off(40, 2) + 256);
  assert(bam1[0] === 40 && bam1[1] === 2, '40/1 links to 40/2');
  assert(bam2[0] === 0 && bam2[1] === 0xFF, '40/2 ends the BAM chain');
  for (const [name, bam] of [['40/1', bam1], ['40/2', bam2]]) {
    assert(bam[2] === 0x44 && bam[3] === 0xBB, `${name} carries version $44 and its complement $BB`);
    assert(bam[4] === 0x53 && bam[5] === 0x44, `${name} repeats the disk ID`);
    assert(bam[6] === 0xC0, `${name} I/O byte: verify on, header CRC check on`);
    assert(bam[7] === 0 && bam.subarray(8, 16).every(b => b === 0), `${name}: no autoboot, reserved bytes zero`);
  }
  const entry = (bam, i) => Array.from(bam.subarray(0x10 + i * 6, 0x16 + i * 6));
  const whole = [40, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF];
  assert(same(entry(bam1, 0), whole), 'track 1: 40 free, all 40 bits set');
  assert(same(entry(bam1, 39), [36, 0xF0, 0xFF, 0xFF, 0xFF, 0xFF]),
    'track 40 gives up sectors 0-3: header, two BAM sectors, first directory sector');
  assert(same(entry(bam2, 0), whole) && same(entry(bam2, 39), whole), 'tracks 41 and 80 are free in 40/2');

  const dir = d.img.subarray(off(40, 3), off(40, 3) + 256);
  assert(dir[0] === 0 && dir[1] === 0xFF && dir.subarray(2).every(b => b === 0),
    'the first directory sector is empty and ends the chain');

  assert(d.diskName === 'SPEC DISK' && d.diskId === 'SD' && d.dosType === '3D',
    'the header parses back: name, ID, "3D"');
  assert(d.freeBlocks === 3160 && d.entries.length === 0, 'a formatted 1581 disk has 3160 blocks free');
  assert(d.writeProtected === false && d.dirty === true, 'a fresh disk is writable and unsaved');
  const lines = listing(d);
  assert(lines[0].text === '\x12"SPEC DISK' + '\xA0'.repeat(7) + '" SD 3D',
    'LOAD"$" heads with the shift-space-padded name, the ID and 3D');
  assert(lines.at(-1).num === 3160 && lines.at(-1).text === 'BLOCKS FREE.', 'and ends with 3160 BLOCKS FREE.');
  assert(createBlankDisk('d81', 'K', '01').kind === 'd81' && createBlankDisk('d64', 'K', '01').kind === 'd64',
    'createBlankDisk picks the layout by kind');
}

// ── 4. allocation: interleave 1, outward from track 40, across both BAM sectors ─
{
  const d = createBlankD81('ALLOC', 'AL');
  const three = somePrg(3 * 254 - 10, 1);
  assert(d.writePRG('THREE', three) === 3, 'a 752-byte file takes 3 blocks');
  const e = d.entries[0];
  assert(e.startTrack === 39 && e.startSector === 0, 'allocation starts beside the directory track, at 39/0');
  const s0 = d.readSector(39, 0), s1 = d.readSector(39, 1), s2 = d.readSector(39, 2);
  assert(s0[0] === 39 && s0[1] === 1 && s1[0] === 39 && s1[1] === 2 && s2[0] === 0,
    'the chain steps one sector at a time: the 1581 interleave is 1');
  const bam1 = d.readSector(40, 1);
  const t39 = 0x10 + 38 * 6;
  assert(bam1[t39] === 37 && bam1[t39 + 1] === 0xF8, 'track 39 in 40/1: count 37, bits 0-2 cleared');
  assert(d.freeBlocks === 3157, 'the free count drops by three');
  assert(same(Array.from(d.loadFile('THREE')), Array.from(three)), 'the file loads back byte for byte');

  // With tracks 1-39 full, the next file crosses into the second BAM sector.
  for (let t = 1; t <= 39; t++) { const o = 0x10 + (t - 1) * 6; bam1.fill(0, o, o + 6); }
  const before = Array.from(d.readSector(40, 2));
  const two = somePrg(400, 2);
  assert(d.writePRG('TWO', two) === 2, 'a file still fits on tracks 41-80');
  const f = d.entries[1];
  assert(f.startTrack === 41 && f.startSector === 0, 'it lands on 41/0, the first track past the directory');
  const bam2 = d.readSector(40, 2);
  assert(bam2[0x10] === 38 && bam2[0x11] === 0xFC, 'track 41 in 40/2: count 38, bits 0-1 cleared');
  assert(same(Array.from(bam2).slice(0x16), before.slice(0x16)), 'no other entry in 40/2 moved');
  assert(same(Array.from(d.loadFile('TWO')), Array.from(two)), 'and it loads back');

  const r = d.scratch('TWO');
  assert(r.scratched.length === 1 && r.blocks === 2, 'scratch reports the two blocks');
  assert(bam2[0x10] === 40 && bam2[0x11] === 0xFF, 'track 41 is whole again in 40/2');
  assert(d.entries[1].deleted && d.loadFile('TWO') === null, 'the entry is DEL and no longer loads');
}

// ── 5. the directory: 37 sectors of track 40, 296 entries ────────────────────
{
  const d = createBlankD81('FULL DIR', 'FD');
  const tiny = new Uint8Array([0x01, 0x08, 0x00]);
  let written = 0;
  for (let i = 0; i < 296; i++) if (d.writePRG(`F${i}`, tiny) === 1) written++;
  assert(written === 296, `track 40 holds 37 directory sectors of 8 entries: 296 files (got ${written})`);
  let t = 40, s = 3, n = 0, onTrack = true;
  const seen = new Set();
  while (t) {
    if (t !== 40) onTrack = false;
    const sec = d.readSector(t, s);
    if (!sec || seen.has(s)) break;
    seen.add(s); n++;
    t = sec[0]; s = sec[1];
  }
  assert(onTrack && n === 37, `the directory chain stays on track 40 and fills its 37 sectors (got ${n})`);
  const free = d.freeBlocks;
  assert(d.writePRG('ONE MORE', tiny) === 0, 'the 297th file is refused');
  assert(d.freeBlocks === free && d.entries.length === 296, 'and takes nothing with it');
}

// ── 6. a CBM partition is an entry, not a file ───────────────────────────────
{
  const d = createBlankD81('PARTS', 'PT');
  const dir = d.readSector(40, 3);
  dir[2] = 0x85; dir[3] = 50; dir[4] = 0;
  for (let i = 0; i < 16; i++) dir[5 + i] = 0xA0;
  'PART'.split('').forEach((c, i) => { dir[5 + i] = c.charCodeAt(0); });
  dir[30] = 40; dir[31] = 0;
  d._parse();
  assert(d.entries[0].type === 'CBM' && d.entries[0].typeCode === 5, 'type 5 lists as CBM');
  assert(listing(d).some(l => l.text.includes('"PART"') && l.text.includes('CBM')), 'and LOAD"$" shows it as CBM');
  assert(d.loadFile('PART') === null && d.loadFile('*') === null,
    'a partition does not LOAD: the DOS answers FILE TYPE MISMATCH, the C64 sees FILE NOT FOUND');
  const r = d.scratch('PART');
  assert(r.scratched.length === 0 && d.entries[0].type === 'CBM', 'scratch skips a partition: its blocks are not a chain');
}

// ── 7. the error table: one byte per sector, in image order ──────────────────
{
  const img = new Uint8Array(822400);
  img.set(createBlankD81('ERR', 'E1').img, 0);
  img.fill(1, 819200);
  const d = new D64(img);
  assert(d.hasErrorInfo && d.kind === 'd81' && d.freeBlocks === 3160, 'the error-table variant parses as the same disk');
  img[819200 + (60 - 1) * 40 + 7] = 5;
  assert(d.errorForSector(60, 7) === 5, 'the table is indexed (track-1)*40+sector');
  assert(d.errorForSector(60, 6) === 1 && d.errorForSector(60, 8) === 1, 'its neighbours read clean');
  d.writeSector(60, 7, new Uint8Array(256));
  assert(d.errorForSector(60, 7) === 1, 'writing a sector clears its error');
  assert(new D64(new Uint8Array(819200)).errorForSector(60, 7) === 1, 'an image without a table reads clean throughout');
}

// ── 8. a chain that leaves the disk ends the file ────────────────────────────
{
  const d = createBlankD81('OFF', '01');
  d.writePRG('OFF', new Uint8Array(600));
  const e = d.entries[0];
  d.readSector(e.startTrack, e.startSector)[0] = 81;
  assert(d.loadFile('OFF').length === 254, 'a link past track 80 ends the file');
}

// ── 9. a 1541 cannot hold a 1581 disk ────────────────────────────────────────
{
  const drive = new Drive1541(new Uint8Array(16384));
  const d81 = createBlankD81('MFM', '35');
  drive.setDisk(d81);
  assert(drive.disk === null && drive.gcrDisk === null,
    'a 1541 handed a D81 holds no disk: it has no head for 3.5" MFM media');
  assert(drive.writeProtected === false, 'and reports nothing to protect');
  const d64 = createBlankD64('GCR', '01');
  drive.setDisk(d64);
  assert(drive.disk === d64 && drive.gcrDisk !== null, 'a D64 still goes in');
}

if (failed > 0) { console.error(`${failed} assertion(s) failed`); process.exit(1); }
console.log('PASS – D81 image: variants, header, BAM, allocation, directory, partitions, error table, 1541 rule');
