// test/drive/g64-format-spec-test.js
//
// G64 image format spec (VICE manual, "G64 disk image format"): header, the
// half-track offset and speed-zone tables, and each track's u16 length + raw GCR
// bytes. Images are built by test/drive/_g64-fixtures.js straight from that layout.
// No ROMs needed.

import { G64, parseG64, isG64 } from '../../src/media/g64.js';
import { createBlankD64, SPT } from '../../src/media/d64.js';
import { validateMedia } from '../../src/media/open.js';
import { allowedActions, SUPPORTED_MEDIA } from '../../src/media/formats.js';
import { buildG64, tracksFromD64, MAX_TRACK_SIZE, HALF_TRACKS } from './_g64-fixtures.js';

let failed = 0;
function assert(cond, msg) {
  if (cond) console.log(`ok  - ${msg}`);
  else { console.error(`FAIL: ${msg}`); failed++; }
}
function throws(fn, msg) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  assert(threw, msg);
}

// A disk with one program on it, the source for most images below.
function sourceDisk() {
  const d = createBlankD64('G64 TEST', 'GT');
  const prg = new Uint8Array(600);
  prg[0] = 0x00; prg[1] = 0xC0;
  for (let i = 2; i < prg.length; i++) prg[i] = (i * 7 + 1) & 0xFF;
  d.writePRG('HELLO', prg);
  return { d, prg };
}

// ── Header and tables ────────────────────────────────────────────────────────
{
  const { d } = sourceDisk();
  const bytes = buildG64(tracksFromD64(d));
  const p = parseG64(bytes);
  assert(isG64(bytes), 'an image beginning "GCR-1541" is recognised as G64');
  assert(p.halfTrackCount === HALF_TRACKS, 'the half-track count is header byte 9');
  assert(p.maxTrackSize === MAX_TRACK_SIZE, 'the maximum track size is the u16 at $0A');
  assert(p.tracks[0] && p.tracks[0].length === tracksFromD64(d).get(0).length,
    'a track entry holds exactly its u16 length of bytes');
  assert(p.tracks[1] === null, 'offset 0 means no track is recorded there');
  assert(p.speedZones[0] === 3 && p.speedZones[34] === 2 && p.speedZones[68] === 0,
    'a speed entry of 0-3 is the zone of the whole track');
}

// ── Malformed images are refused ─────────────────────────────────────────────
{
  const good = () => buildG64(tracksFromD64(sourceDisk().d));
  throws(() => parseG64(new Uint8Array([...'GCR-1571'].map(c => c.charCodeAt(0)).concat(Array(20).fill(0)))),
    'a signature other than GCR-1541 is refused');
  { const b = good(); b[8] = 1; throws(() => parseG64(b), 'a version other than 0 is refused'); }
  { const b = good(); b[9] = 0; throws(() => parseG64(b), 'a half-track count of 0 is refused'); }
  { const b = good(); b[9] = 85; throws(() => parseG64(b), 'a half-track count above 84 is refused'); }
  throws(() => parseG64(good().slice(0, 100)), 'tables cut short by the end of the file are refused');
  { const b = good(); new DataView(b.buffer).setUint32(12, b.length + 10, true);
    throws(() => parseG64(b), 'a track offset past the end of the file is refused'); }
  { const b = good(); const off = new DataView(b.buffer).getUint32(12, true);
    new DataView(b.buffer).setUint16(off, MAX_TRACK_SIZE + 1, true);
    throws(() => parseG64(b), 'a track longer than the maximum track size is refused'); }
  { const b = good(); throws(() => parseG64(b.slice(0, b.length - MAX_TRACK_SIZE)),
    'a track running past the end of the file is refused'); }
  { const b = good(); new DataView(b.buffer).setUint32(12 + HALF_TRACKS * 4, b.length + 4, true);
    throws(() => parseG64(b), 'a speed-zone map outside the file is refused'); }
  throws(() => validateMedia(new Uint8Array(64), 'g64'), 'validateMedia refuses a non-G64 as g64');
}

// ── Per-byte speed maps ──────────────────────────────────────────────────────
{
  const track = new Uint8Array(400).fill(0x55);
  const map = new Uint8Array(100).fill(0b10_11_11_11);   // first byte zone 2, then 3s
  const p = parseG64(buildG64(new Map([[0, track]]), { speedMaps: new Map([[0, map]]) }));
  assert(p.speedZones[0] === 2, 'a speed entry above 3 points at a per-byte map (first byte in the top two bits)');
}

// ── Drive-facing view: half-tracks, live buffers, byte-identical export ───────
{
  const { d } = sourceDisk();
  const tracks = tracksFromD64(d);
  const marker = new Uint8Array(5000).fill(0xA5);
  tracks.set(35, marker);                           // entry 35 = track 18.5
  const bytes = buildG64(tracks);
  const copy = bytes.slice();
  const g = new G64(bytes);
  assert(g.getTrackStream(18, 36).length === tracks.get(34).length,
    'drive half-track 36 is entry 34 (track 18)');
  assert(g.getTrackStream(18, 37)[0] === 0xA5 && g.getTrackStream(18, 37).length === 5000,
    'drive half-track 37 is entry 35 (track 18.5), recorded separately from track 18');
  assert(g.getTrackStream(19, 39) === null, 'an unrecorded half-track reads as nothing');
  assert(g.getTrackStream(1, 1) === null && g.getTrackStream(43, 86) === null,
    'half-tracks outside the image read as nothing');
  assert(g.img.length === copy.length && g.img.every((v, i) => v === copy[i]),
    'the exported image is byte-identical to the file it was read from');
  g.getTrackStream(18, 37)[0] = 0x5A;
  const off = new DataView(g.img.buffer).getUint32(12 + 35 * 4, true);
  assert(g.img[off + 2] === 0x5A, 'the track stream is the image: a head write lands in the exported bytes');
  assert(g.writeProtected === true && g.dirty === false, 'a mounted G64 starts write-protected and clean');
}

// ── Sector view: directory and files decoded from the whole tracks ───────────
{
  const { d, prg } = sourceDisk();
  const g = new G64(buildG64(tracksFromD64(d, { padTo: 7900 })));
  assert(g.diskName === 'G64 TEST' && g.diskId === 'GT', 'disk name and ID come from the decoded BAM');
  assert(g.entries.length === 1 && g.entries[0].name === 'HELLO', 'the directory decodes from track 18');
  assert(g.freeBlocks === d.freeBlocks, 'the free-block count matches the source disk');
  const got = g.loadFile('HELLO');
  assert(got && got.length === prg.length && got.every((v, i) => v === prg[i]),
    'a file loads by name from sectors decoded off tracks longer than standard');
  assert(g.buildDirectoryPRG()[0] === 0x01, 'LOAD"$" is served from the decoded directory');

  // The two off bytes after a data block's checksum are decoded and discarded
  // by the DOS, so a mastered disk's junk there must not cost the sector.
  const junk = tracksFromD64(d);
  const t18 = junk.get(34);
  // The 325 GCR bytes of a data block end with the off bytes; a data block
  // starts after the 5-byte sync that follows the header's 9-byte gap.
  const firstData = 5 + 10 + 9 + 5;
  t18[firstData + 323] = 0x00; t18[firstData + 324] = 0x00;   // 00000 groups: not GCR
  const junked = new G64(buildG64(junk));
  assert(junked.diskName === 'G64 TEST' && junked.readSector(18, 0)[0xA2] === 'G'.charCodeAt(0),
    'a data block whose off bytes are not valid GCR still decodes (the DOS discards them)');

  // A header naming another track is ignored: a protection's decoy must not
  // overwrite that track's real sector in the view.
  const tracks = tracksFromD64(d);
  tracks.set(0, tracksFromD64(createBlankD64('DECOY', 'DD')).get(34));   // track 18's blocks on track 1
  const decoyed = new G64(buildG64(tracks));
  assert(decoyed.diskName === 'G64 TEST', 'blocks whose header names a different track are not taken for that track');
  assert(decoyed.readSector(1, 0).every(b => b === 0), 'a track with no blocks of its own leaves its sectors empty');
}

// ── Track-shifted dumps ──────────────────────────────────────────────────────
// Some dumps hold every track one slot late: track 1 in the slot the format
// gives track 2, the first slot empty. The DOS finds a track by its headers, so
// the drive reads such a dump as it is; the view must find the directory by the
// headers too, while the drive-facing slots stay where the file has them.
{
  const { d, prg } = sourceDisk();
  const late = new Map();
  for (const [i, data] of tracksFromD64(d)) late.set(i + 2, data);
  const g = new G64(buildG64(late));
  assert(g.getTrackStream(1, 2) === null && g.getTrackStream(2, 4)?.length === late.get(2).length,
    'the drive still reads each slot as the file has it');
  assert(g.diskName === 'G64 TEST' && g.entries.length === 1 && g.trackCount === 35,
    'the directory is found where the headers say track 18 is, one slot late');
  const got = g.loadFile('HELLO');
  assert(got && got.length === prg.length && got.every((v, i) => v === prg[i]),
    'a file loads through the shifted view');
  // The DOS steps to half-track 38 for track 18 here (it follows the headers),
  // so that is the slot a head write lands on.
  g.getTrackStream(19, 38).set(tracksFromD64(createBlankD64('RENAMED', 'GT')).get(34));
  g.markTrackDirty(19, 38);
  g.commitDirtyTracks();
  assert(g.diskName === 'RENAMED', 'a head write on the late slot reaches the track its headers name');
}

// ── Head writes reach the sector view on commit ──────────────────────────────
{
  const { d } = sourceDisk();
  const g = new G64(buildG64(tracksFromD64(d)));
  const renamed = createBlankD64('RENAMED', 'GT');
  const fresh = tracksFromD64(renamed).get(34);
  g.getTrackStream(18, 36).set(fresh);              // what a head laying track 18 leaves
  g.markTrackDirty(18, 36);
  assert(g.dirty && g.hasDirtyTracks(), 'a head write marks the image dirty with a track to re-read');
  const n = g.commitDirtyTracks();
  assert(n === SPT[18], `commit decodes the written track's ${SPT[18]} sectors (got ${n})`);
  assert(g.diskName === 'RENAMED' && !g.hasDirtyTracks(), 'the directory shows what the head wrote');
  assert(new G64(g.img.slice()).diskName === 'RENAMED', 'the exported image carries the write');
}

// ── Media registry ───────────────────────────────────────────────────────────
{
  assert(SUPPORTED_MEDIA.includes('g64'), 'g64 is a supported media type');
  assert(['mount', 'run', 'save', 'download'].every(a => allowedActions('g64').includes(a)),
    'a G64 can be mounted, run, saved to the Library and downloaded, like a D64');
  const g = validateMedia(buildG64(tracksFromD64(sourceDisk().d)), 'g64');
  assert(g instanceof G64, 'validateMedia returns the parsed G64 disk');
}

if (failed) { console.error(`\n${failed} G64 format check(s) failed.`); process.exit(1); }
console.log('\nAll G64 format spec tests passed.');
