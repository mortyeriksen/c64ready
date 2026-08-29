// test/d64-format-spec-test.js
//
// Spec test for the parts of the D64 container that sit either side of the
// standard directory: the image-size variants, the appended error table and
// what the GCR encoder does with it, the BAM extension a 40-track image needs,
// and CBM DOS name matching.
//
// Why this test is not a duplicate:
//   - test/d64-write-prg-spec-test.js writes a PRG onto a blank 35-track disk
//     and checks the chain, BAM accounting and directory entry.
//   - test/d64-petscii-directory-spec-test.js checks that control-byte
//     filenames survive parsing and reach the synthesized LOAD"$" listing.
//   - test/d64-del-directory-spec-test.js covers scratched (DEL) entries.
//   - test/gcr-writeback-spec-test.js round-trips written tracks back into the
//     image; it uses clean disks, so no error table is involved.
//   None of them look at a non-35-track image, an error table, or a pattern
//   that isn't an exact filename.
//
// Spec basis: Peter Schepers, "D64 (Electronic form of a physical 1541 disk)" —
// image sizes (683/768/802 sectors, with or without one error byte per sector),
// the error-code numbering, the BAM layout and the DOS-variant locations of the
// tracks 36-40 entries. CBM DOS name matching ('*' from there on, '?' any one
// byte, "0:" drive prefix, ",P"/",S,R" type-and-mode suffix) is the 1541 User's
// Manual. The 4-to-5 GCR table used by the header reader below is the format's.
//
// Observed surface: the D64 public API (d64Variant, trackCount, hasErrorInfo,
// errorForSector, freeBlocks, entries, loadFile, buildDirectoryPRG,
// readSector/writeSector) and the raw GCR track bytes the read head would see.

import { D64, createBlankD64, createPRGDisk, d64Variant, SPT } from '../src/d64.js';
import { GCRDisk, decodeTrackStream } from '../src/gcr.js';

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failed++; }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function sectorOffset(track, sector) {
  let off = 0;
  for (let t = 1; t < track; t++) off += SPT[t];
  return (off + sector) * 256;
}

/** A formatted 35-track disk carried in an image that has an error table. */
function diskWithErrorTable(name = 'ERRORS') {
  const src = createBlankD64(name, 'E1');
  const img = new Uint8Array(175531);
  img.set(src.img, 0);
  img.fill(1, 174848);            // 1 = "no error" for every sector
  return new D64(img);
}

/** Set the error code for one sector of an image built above. */
function setError(disk, track, sector, code) {
  disk.img[174848 + sectorOffset(track, sector) / 256] = code;
}

// Minimal GCR reader, for looking at header blocks the way the read head does:
// find a sync (10+ one-bits), then read 5-bit codes back through the 4-to-5
// table. Only used to inspect what the encoder wrote into sector headers.
const GCR_ENCODE = [
  0x0A, 0x0B, 0x12, 0x13, 0x0E, 0x0F, 0x16, 0x17,
  0x09, 0x19, 0x1A, 0x1B, 0x0D, 0x1D, 0x1E, 0x15,
];
const GCR_DECODE = (() => {
  const t = new Uint8Array(32).fill(0xFF);
  GCR_ENCODE.forEach((code, nib) => { t[code] = nib; });
  return t;
})();

/** Every header block (8 decoded bytes) found on a raw track stream. */
function headersOn(stream) {
  const bits = stream.length * 8;
  const bitAt = (i) => (stream[((i % bits) + bits) % bits >> 3] >> (7 - (i & 7))) & 1;
  const out = [];
  let ones = 0;
  for (let i = 0; i < bits; i++) {
    if (bitAt(i) === 1) { ones++; continue; }
    if (ones >= 10) {
      const bytes = new Uint8Array(8);
      let bit = i, ok = true;
      for (let b = 0; b < 8; b++) {
        let hi = 0, lo = 0;
        for (let k = 0; k < 5; k++) hi = (hi << 1) | bitAt(bit++);
        for (let k = 0; k < 5; k++) lo = (lo << 1) | bitAt(bit++);
        if (GCR_DECODE[hi] === 0xFF || GCR_DECODE[lo] === 0xFF) { ok = false; break; }
        bytes[b] = (GCR_DECODE[hi] << 4) | GCR_DECODE[lo];
      }
      if (ok && bytes[0] === 0x08) out.push(bytes);
    }
    ones = 0;
  }
  return out;
}

/** How many sync marks the read head would find on a track. */
function syncCount(stream) {
  const bits = stream.length * 8;
  const bitAt = (i) => (stream[i >> 3] >> (7 - (i & 7))) & 1;
  let ones = 0, syncs = 0;
  for (let i = 0; i < bits; i++) {
    if (bitAt(i) === 1) { ones++; continue; }
    if (ones >= 10) syncs++;
    ones = 0;
  }
  return syncs;
}

const readable = (t, s) => (blocks) => blocks.some(b => b.track === t && b.sector === s);

// ── 1. image-size variants ───────────────────────────────────────────────────
{
  const cases = [
    [174848, 35, false], [175531, 35, true],
    [196608, 40, false], [197376, 40, true],
    [205312, 42, false], [206114, 42, true],
  ];
  for (const [len, tracks, err] of cases) {
    const v = d64Variant(len);
    assert(v && v.tracks === tracks && v.errorInfo === err,
      `d64Variant(${len}) = ${tracks} tracks, errorInfo ${err}`);
    const d = new D64(new Uint8Array(len));
    assert(d.trackCount === tracks && d.hasErrorInfo === err,
      `D64(${len}) parses as ${tracks} tracks, errorInfo ${err} (got ${d.trackCount}/${d.hasErrorInfo})`);
  }
  for (const len of [0, 64, 174000, 174849, 250000]) {
    assert(d64Variant(len) === null, `d64Variant(${len}) is not a disk image`);
  }
}

// ── 2. a track past the end of the image is unformatted, not empty ───────────
{
  const d = createBlankD64('SHORT', '01');
  assert(d.readSector(36, 0) === null, 'readSector(36,0) on a 35-track image = null');
  assert(new GCRDisk(d).getTrackStream(36) === null,
    'no GCR stream for track 36 of a 35-track image (the head finds nothing there)');
  const forty = new D64(new Uint8Array(196608));
  assert(forty.readSector(40, 16) !== null, 'track 40 reads on a 40-track image');
  assert(forty.readSector(41, 0) === null, 'track 41 does not');
}

// ── 3. error table → what the read head finds ────────────────────────────────
{
  // Codes that make a sector unreadable, each on its own sector of track 20.
  const unreadable = [
    [2, 'error 20, header block not found'],
    [3, 'error 21, no sync'],
    [4, 'error 22, data block not found'],
    [5, 'error 23, data checksum'],
    [9, 'error 27, header checksum'],
  ];
  const disk = diskWithErrorTable();
  unreadable.forEach(([code], i) => setError(disk, 20, i + 1, code));
  // Codes describing a write failure or a drive that wasn't ready: the sector
  // itself is fine and must still read.
  [6, 7, 8, 10, 15].forEach((code, i) => setError(disk, 20, i + 10, code));

  const stream = new GCRDisk(disk).getTrackStream(20);
  const blocks = decodeTrackStream(stream);
  assert(readable(20, 0)(blocks), 'a sector with no recorded error reads back');
  unreadable.forEach(([code, what], i) => {
    assert(!readable(20, i + 1)(blocks), `sector ${i + 1} is unreadable — ${what} (code ${code})`);
  });
  [6, 7, 8, 10, 15].forEach((code, i) => {
    assert(readable(20, i + 10)(blocks), `sector ${i + 10} still reads — code ${code} is not a read fault`);
  });

  // Error 21 removes exactly that sector's two sync marks and nothing else.
  const clean = new GCRDisk(diskWithErrorTable()).getTrackStream(20);
  assert(syncCount(clean) - syncCount(stream) === 2,
    `error 21 costs two sync marks (${syncCount(clean)} → ${syncCount(stream)})`);

  // Error 29: the header carries an ID that isn't the disk's, and its checksum
  // is over what was written — so the drive faults on the ID, not the checksum.
  const idDisk = diskWithErrorTable();
  setError(idDisk, 20, 3, 11);
  const idHeaders = headersOn(new GCRDisk(idDisk).getTrackStream(20));
  const h = idHeaders.find(b => b[2] === 3 && b[3] === 20);
  assert(!!h, 'error 29 leaves a readable header behind');
  if (h) {
    assert(h[5] !== 0x45 || h[4] !== 0x31, `header ID differs from the BAM's "E1" (got ${h[5]},${h[4]})`);
    assert(h[1] === (h[2] ^ h[3] ^ h[4] ^ h[5]), 'error 29 header checksum matches the bytes written');
  }
  // Error 27, by contrast, is a header whose checksum does not match.
  const ckDisk = diskWithErrorTable();
  setError(ckDisk, 20, 4, 9);
  const bad = headersOn(new GCRDisk(ckDisk).getTrackStream(20)).find(b => b[2] === 4 && b[3] === 20);
  assert(bad && bad[1] !== (bad[2] ^ bad[3] ^ bad[4] ^ bad[5]),
    'error 27 header checksum does not match the bytes written');
}

// ── 4. writing a sector clears the error recorded for it ─────────────────────
{
  const disk = diskWithErrorTable();
  setError(disk, 21, 5, 5);
  assert(disk.errorForSector(21, 5) === 5, 'error table read back through errorForSector');
  disk.writeSector(21, 5, new Uint8Array(256).fill(0xAA));
  assert(disk.errorForSector(21, 5) === 1,
    'a sector that has just been written no longer reports an error');
  assert(readable(21, 5)(decodeTrackStream(new GCRDisk(disk).getTrackStream(21))),
    'and it reads back cleanly');
  assert(disk.errorForSector(21, 6) === 1, 'neighbouring sectors are untouched');
}

// ── 5. 40-track BAM extension ────────────────────────────────────────────────
{
  // No extension: tracks 36-40 are not described, so they are neither counted
  // nor written to — and above all the disk name, which shares those bytes,
  // survives a disk that has run out of room everywhere else.
  const plain = new Uint8Array(196608);
  plain.set(createBlankD64('MY GREAT DISK', 'ID').img, 0);
  const noExt = new D64(plain);
  assert(noExt.freeBlocks === 664, `undescribed tracks are not counted free (got ${noExt.freeBlocks})`);
  const bam = noExt.readSector(18, 0);
  for (let t = 1; t <= 35; t++) { const o = 4 + (t - 1) * 4; bam[o] = bam[o + 1] = bam[o + 2] = bam[o + 3] = 0; }
  assert(noExt.writePRG('BIG', new Uint8Array(600)) === 0, 'a full disk refuses the write');
  noExt._parse();
  assert(noExt.diskName === 'MY GREAT DISK', `disk name survives (got "${noExt.diskName}")`);
  assert(noExt.diskId === 'ID' && noExt.dosType === '2A', 'so do the ID and DOS type');

  // DolphinDOS-style extension at $AC: five tracks of 17 free sectors.
  const dolphin = new Uint8Array(196608);
  dolphin.set(createBlankD64('DOLPHIN', 'DD').img, 0);
  const ext = new D64(dolphin);
  const eb = ext.readSector(18, 0);
  for (let t = 36; t <= 40; t++) {
    const o = 0xAC + (t - 36) * 4;
    eb[o] = 17; eb[o + 1] = 0xFF; eb[o + 2] = 0xFF; eb[o + 3] = 0x01;
  }
  ext._parse();
  assert(ext.freeBlocks === 664 + 85, `extension blocks are counted (got ${ext.freeBlocks})`);
  const eb2 = ext.readSector(18, 0);
  for (let t = 1; t <= 35; t++) { const o = 4 + (t - 1) * 4; eb2[o] = eb2[o + 1] = eb2[o + 2] = eb2[o + 3] = 0; }
  const blocks = ext.writePRG('BIG', new Uint8Array(600));
  assert(blocks === 3, `a described track 36-40 takes the write (got ${blocks} blocks)`);
  ext._parse();
  assert(ext.diskName === 'DOLPHIN', `the disk name is still the disk name (got "${ext.diskName}")`);
  assert(ext.entries.length === 1 && ext.entries[0].startTrack >= 36,
    'and the file landed on the extended tracks');
}

// ── 6. names: shift-space is padding at the end, a character in the middle ───
{
  const disk = createBlankD64('NAMES', '01');
  const artName = String.fromCharCode(0x41, 0xA0, 0x42);   // A, shift-space, B
  disk.writePRG(artName, new Uint8Array([1, 8, 0, 0]));
  assert(disk.entries[0].name === artName,
    `an embedded shift-space survives (got ${[...disk.entries[0].name].map(c => c.charCodeAt(0).toString(16))})`);
  assert(disk.entries[0].name.length === 3, 'and the trailing padding does not');
  assert(disk.loadFile(artName) !== null, 'the file still loads by its own name');
}

// ── 7. a file whose chain loops is not an endless file ───────────────────────
{
  const disk = createBlankD64('LOOP', '01');
  disk.writePRG('LOOP', new Uint8Array(600));
  const e = disk.entries[0];
  const first = disk.readSector(e.startTrack, e.startSector);
  first[0] = e.startTrack; first[1] = e.startSector;       // link to itself
  const got = disk.loadFile('LOOP');
  assert(got !== null && got.length === 254, `a self-linking chain stops after one block (got ${got && got.length})`);

  const off = createBlankD64('OFF', '01');
  off.writePRG('OFF', new Uint8Array(600));
  const oe = off.entries[0];
  off.readSector(oe.startTrack, oe.startSector)[0] = 99;   // link off the disk
  assert(off.loadFile('OFF').length === 254, 'a link past the last track ends the file');
}

// ── 8. CBM DOS name matching ─────────────────────────────────────────────────
{
  const disk = createBlankD64('MATCH', '01');
  disk.writePRG('ALPHA', new Uint8Array([1, 8, 1, 1]));
  disk.writePRG('ALBUM', new Uint8Array([1, 8, 2, 2]));
  disk.writePRG('A,B', new Uint8Array([1, 8, 3, 3]));
  const hit = (q) => disk.loadFile(q) !== null;
  const which = (q) => { const d = disk.loadFile(q); return d ? d[2] : null; };

  assert(hit('ALPHA'), 'an exact name matches');
  assert(which('AL*') === 1, "'*' matches from there on, first entry wins");
  assert(which('AL*ZZZ') === 1, "anything after '*' is ignored, as DOS does");
  assert(which('ALB*') === 2, "'*' after a longer prefix picks the other file");
  assert(which('A?PHA') === 1, "'?' matches any single byte");
  assert(which('?LPHA') === 1, "'?' works at the front too");
  assert(hit('*'), "'*' alone matches the first entry");
  assert(which('0:ALPHA') === 1, 'a drive prefix is stripped');
  assert(which('ALPHA,P') === 1, 'a type suffix is stripped');
  assert(which('ALPHA,P,R') === 1, 'a type and mode suffix is stripped');
  assert(which('alpha') === 1, 'host lowercase still finds its file');
  assert(which('A,B') === 3, 'a comma inside a name is not a type suffix');
  assert(!hit('AL'), 'a short pattern without a wildcard does not match');
  assert(!hit('ALPHAX'), 'a longer pattern does not match either');
  assert(!hit('ZZZ'), 'and an absent name is absent');
}

// ── 9. USR files hold programs too ───────────────────────────────────────────
{
  const disk = createBlankD64('USR', '01');
  disk.writePRG('LOADER', new Uint8Array([0x01, 0x08, 0x99, 0x99]));
  disk.readSector(18, 1)[2] = 0x83;        // closed USR
  disk._parse();
  assert(disk.entries[0].type === 'USR' && disk.entries[0].typeCode === 3, 'entry parses as USR');
  const data = disk.loadFile('LOADER');
  assert(data !== null && data[2] === 0x99, 'a USR file loads by name, like DOS LOADs it');
  const listing = String.fromCharCode(...disk.buildDirectoryPRG());
  assert(listing.includes('USR'), 'and lists as USR');
}

// ── 9b. a GEOS disk says so in its BAM ───────────────────────────────────────
// GEOS writes its names in ASCII, not PETSCII, and its USR files are VLIR
// record structures rather than programs — both of which the UI needs to know
// before it draws or offers to load anything. The disk announces itself with
// "GEOS format" at BAM $AD (Peter Schepers' D64 document).
{
  const plain = createBlankD64('PLAIN', '01');
  assert(plain.isGEOS === false, 'an ordinary disk is not a GEOS disk');

  const geos = createBlankD64('System', 'LJ');
  const bam = geos.readSector(18, 0);
  'GEOS format V1.0'.split('').forEach((c, i) => { bam[0xAD + i] = c.charCodeAt(0); });
  geos._parse();
  assert(geos.isGEOS === true, 'the BAM marker identifies a GEOS disk');

  // The name bytes GEOS writes are ASCII, so they must survive parsing intact
  // for the ASCII renderer to have anything to draw.
  geos.writePRG('preference mgr', new Uint8Array([1, 8, 0, 0]));
  assert(geos.entries[0].name === 'preference mgr',
    `lowercase ASCII names round-trip (got "${geos.entries[0].name}")`);
}

// ── 10. the synthesized listing ──────────────────────────────────────────────
{
  const disk = createBlankD64('LISTING', 'L1');
  disk.writePRG('ONE', new Uint8Array([1, 8, 0, 0]));
  disk.writePRG('TWO', new Uint8Array([1, 8, 0, 0]));
  const dir = disk.readSector(18, 1);
  dir[2] = 0x02;                            // ONE: PRG left open by a dead SAVE
  dir[32 + 2] = 0xC2;                       // TWO: closed and locked
  disk._parse();

  const text = String.fromCharCode(...disk.buildDirectoryPRG());
  assert(text.includes('"ONE"             *PRG'), 'an unclosed file takes a splat before its type');
  assert(text.includes('"TWO"              PRG<'), 'a locked file takes a < after it, in the same columns');
  assert(text.includes('BLOCKS FREE.'), 'the free-block line is there');

  const filtered = String.fromCharCode(...disk.buildDirectoryPRG('T*'));
  assert(filtered.includes('"TWO"') && !filtered.includes('"ONE"'),
    'LOAD"$:T*" lists only what matches');
  assert(filtered.includes('BLOCKS FREE.'), 'a filtered listing still ends with the free blocks');
  const prefixed = String.fromCharCode(...disk.buildDirectoryPRG('0:O*'));
  assert(prefixed.includes('"ONE"') && !prefixed.includes('"TWO"'), 'and understands a drive prefix');
}

// ── 11. the PRG-wrapper disk is unchanged by all of the above ────────────────
{
  const prg = new Uint8Array(600);
  prg[0] = 0x01; prg[1] = 0x08; prg[2] = 0x42;
  const disk = createPRGDisk('Commando (1985).prg', prg);
  assert(disk && disk.diskName === 'COMMANDO', `wrapper disk is named for the file (${disk?.diskName})`);
  const back = disk.loadFile('COMMANDO');
  assert(back && back.length === 600 && back[2] === 0x42, 'and hands the program back byte for byte');
  assert(disk.writeProtected === true && disk.dirty === false, 'write-protected and clean');
}

if (failed > 0) { console.error(`${failed} assertion(s) failed`); process.exit(1); }
console.log('PASS – D64 image variants, error table, BAM extension, names and matching');
