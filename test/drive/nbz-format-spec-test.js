// test/drive/nbz-format-spec-test.js
//
// Nibbler dumps to G64, per nibtools' formats and nibconv's default rules:
// the LZ77 stream, the NIB table, the track cycle and its start, killer,
// unformatted and fat tracks, and shortening over-long tracks. Dumps come
// from test/drive/_nbz-fixtures.js; real c64pp dumps convert too when present.
// No ROMs needed.

import { existsSync, readFileSync } from 'fs';
import { lzUncompress, parseNib, isNib, isNbz, extractTrackCycle, nibToG64, nibFileToG64 } from '../../src/media/nib.js';
import { parseG64, G64 } from '../../src/media/g64.js';
import { decodeTrackStream } from '../../src/gcr.js';
import { createBlankD64, SPT } from '../../src/media/d64.js';
import { tracksFromD64 } from './_g64-fixtures.js';
import { buildNib, rawRead, lzCompress, NIB_TRACK } from './_nbz-fixtures.js';
import { collectionFile, assetPath, missingNote } from '../external-assets.js';

let failed = 0;
function assert(cond, msg) {
  if (cond) console.log(`ok  - ${msg}`);
  else { console.error(`FAIL: ${msg}`); failed++; }
}
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
// Whether `track` is `revolution` begun at another point.
function isRotationOf(track, revolution) {
  if (track.length !== revolution.length) return false;
  const doubled = new Uint8Array(track.length * 2);
  doubled.set(track); doubled.set(track, track.length);
  for (let at = 0; at < track.length; at++) {
    let i = 0;
    while (i < revolution.length && doubled[at + i] === revolution[i]) i++;
    if (i === revolution.length) return true;
  }
  return false;
}

// A disk with one program on it; its GCR revolutions are the raw material.
function sourceDisk() {
  const d = createBlankD64('NBZ TEST', 'NB');
  const prg = new Uint8Array(900);
  prg[0] = 0x00; prg[1] = 0xC0;
  for (let i = 2; i < prg.length; i++) prg[i] = (i * 11 + 3) & 0xFF;
  d.writePRG('HELLO', prg);
  return { d, prg, revolutions: tracksFromD64(d) };   // entry index (track-1)*2 → bytes
}
const zoneOf = t => t <= 17 ? 3 : t <= 24 ? 2 : t <= 30 ? 1 : 0;

// ── The LZ77 stream ──────────────────────────────────────────────────────────
{
  const text = s => Uint8Array.from([...s].map(c => c.charCodeAt(0)));
  assert(same(lzUncompress(Uint8Array.from([5, 0x41, 0x42, 0x43])), text('ABC')),
    'bytes other than the marker are literals');
  assert(same(lzUncompress(Uint8Array.from([5, 0x41, 5, 0, 0x42])), Uint8Array.from([0x41, 5, 0x42])),
    'the marker followed by 0 is one literal marker byte');
  assert(same(lzUncompress(Uint8Array.from([5, 0x41, 0x42, 0x43, 5, 3, 3])), text('ABCABC')),
    'the marker, a length and an offset copy that many bytes from that far back');
  assert(same(lzUncompress(Uint8Array.from([5, 0x41, 0x42, 5, 4, 2])), text('ABABAB')),
    'a copy longer than its offset repeats what it has written (overlapping copy)');
  // 300 = 2·128 + 44: two groups, the first with its top bit set.
  const long = lzUncompress(Uint8Array.from([5, 0x41, 5, 0x82, 0x2C, 1]));
  assert(long.length === 301 && long.every(v => v === 0x41),
    'a length or offset spans bytes of 7 bits, most significant first, the top bit meaning more follow');
  assert(lzUncompress(new Uint8Array(0)).length === 0, 'an empty stream inflates to nothing');
  let threw = false;
  try { lzUncompress(Uint8Array.from([5, 0x41, 5, 2, 9])); } catch { threw = true; }
  assert(threw, 'a copy from before the start of the output is refused');
}

// ── The NIB file ─────────────────────────────────────────────────────────────
{
  const { revolutions } = sourceDisk();
  const nib = buildNib([
    { halfTrack: 2, zone: 3, raw: rawRead(revolutions.get(0)) },
    { halfTrack: 37, zone: 2, raw: rawRead(revolutions.get(34)) },
    { halfTrack: 84, zone: 0, raw: rawRead(revolutions.get(68)) },
  ]);
  assert(isNib(nib) && !isNbz(nib), 'a file beginning MNIB-1541-RAW is a NIB dump');
  const p = parseNib(nib);
  assert(p.version === 3, 'the version is header byte 13');
  assert(p.tracks.size === 3 && [...p.tracks.keys()].join() === '2,37,84',
    'the track table at $10 pairs each half-track with its density, ending at a zero half-track');
  assert(p.tracks.get(37).zone === 2 && p.tracks.get(84).zone === 0, 'the density byte\'s low two bits are the zone');
  assert(p.tracks.get(2).raw.length === NIB_TRACK && p.tracks.get(2).raw[0] === revolutions.get(0)[0],
    'each entry is an 8 KB raw read from $100 on, in table order');
  const flagged = buildNib([{ halfTrack: 2, zone: 0x42, raw: rawRead(revolutions.get(0)) }]);
  assert(parseNib(flagged).tracks.get(2).zone === 2, 'flag bits above the zone are discarded');
  let threw = false;
  try { parseNib(nib.subarray(0, 0x100 + NIB_TRACK)); } catch { threw = true; }
  assert(threw, 'a table naming more tracks than the file holds is refused');
}

// ── One revolution out of a raw read ─────────────────────────────────────────
{
  const { d, prg, revolutions } = sourceDisk();
  // Every track read from a different point of its revolution.
  const entries = [];
  for (let t = 1; t <= 35; t++) {
    entries.push({ halfTrack: t * 2, zone: zoneOf(t), raw: rawRead(revolutions.get((t - 1) * 2), (t * 977) % 6000) });
  }
  const { g64, report } = nibToG64(parseNib(buildNib(entries)));
  const parsed = parseG64(g64);
  let rotations = 0, syncStarts = 0, zones = 0, gaps = 0;
  for (let t = 1; t <= 35; t++) {
    const track = parsed.tracks[(t - 1) * 2];
    if (track && isRotationOf(track, revolutions.get((t - 1) * 2))) rotations++;
    if (track && track[0] === 0xFF) syncStarts++;
    if (parsed.speedZones[(t - 1) * 2] === zoneOf(t)) zones++;
    if (report.find(r => r.halfTrack === t * 2)?.align === 'gap') gaps++;
  }
  assert(rotations === 35, `every track is its revolution, cut once round wherever the read began (${rotations}/35)`);
  assert(gaps === 35, `a track with a clear tail gap starts at the sector after it (${gaps}/35 gap-aligned)`);
  assert(syncStarts === 35, 'an aligned track begins on the first byte of a sync');
  assert(zones === 35, 'the G64 speed entry is the NIB density');
  assert(parsed.halfTrackCount === 84 && parsed.tracks[1] === null, 'the G64 has 84 half-track slots, the unrecorded ones empty');
  const view = new G64(g64);
  assert(view.diskName === 'NBZ TEST' && view.entries.length === 1, 'the directory reads off the converted tracks');
  const got = view.loadFile('HELLO');
  assert(got && got.length === prg.length && got.every((v, i) => v === prg[i]), 'a file loads byte for byte');
  assert(d.freeBlocks === view.freeBlocks, 'the free-block count survives the conversion');
}

// ── Tracks that are not plain data ───────────────────────────────────────────
{
  const { revolutions } = sourceDisk();
  const t1 = revolutions.get(0);
  // A revolution longer than a disk holds at 295 rpm: one sync run made 200
  // bytes long. It must lose sync bytes, never data.
  const firstSync = t1.indexOf(0xFF);
  const long = new Uint8Array(t1.length + 200);
  long.set(t1.subarray(0, firstSync)); long.fill(0xFF, firstSync, firstSync + 200); long.set(t1.subarray(firstSync), firstSync + 200);
  const killer = new Uint8Array(NIB_TRACK).fill(0xFF);
  const entries = [
    { halfTrack: 2, zone: 3, raw: rawRead(long, 1234) },
    { halfTrack: 10, zone: 3, raw: rawRead(revolutions.get(8), 100) },   // track 5 …
    { halfTrack: 12, zone: 3, raw: rawRead(revolutions.get(8), 3000) },  // … read again on track 6: a fat track
    { halfTrack: 36, zone: 2, raw: rawRead(revolutions.get(34), 500) },
    { halfTrack: 37, zone: 2, raw: rawRead(revolutions.get(36), 700) },  // half-track 18.5 with its own data
    { halfTrack: 60, zone: 1, raw: new Uint8Array(NIB_TRACK) },          // nothing recorded on track 30
    { halfTrack: 72, zone: 0, raw: killer },                             // track 36 is all sync
  ];
  const { g64, report } = nibToG64(parseNib(buildNib(entries)));
  const parsed = parseG64(g64);
  const row = ht => report.find(r => r.halfTrack === ht);

  const cut = parsed.tracks[0];
  assert(row(2).syncCut > 0 && cut.length <= 7822, `a track longer than 7822 bytes (zone 3 at 295 rpm) loses sync bytes (${row(2).syncCut} cut, ${cut.length} left)`);
  const blocks = decodeTrackStream(cut);
  assert(blocks.filter(b => b.track === 1).length === SPT[1], 'every sector of the shortened track still decodes');
  assert(parsed.maxTrackSize >= cut.length && parsed.maxTrackSize <= long.length,
    'the image\'s track size is the longest revolution found');

  assert(parsed.tracks[9] && same(parsed.tracks[9], parsed.tracks[8]) && row(11).align === 'fat track 5',
    'two whole tracks that read alike are one fat track: the half-track between gets the same data');

  assert(parsed.tracks[35] && isRotationOf(parsed.tracks[35], revolutions.get(36)),
    'a half-track with its own recording is converted like any other');
  assert(parsed.tracks[34] && isRotationOf(parsed.tracks[34], revolutions.get(34)),
    'the whole track next to it is unaffected');

  assert(row(60).length === 0 && parsed.tracks[58] === null && row(60).align === 'unformatted',
    'a read without sixteen good GCR bytes in a row is unformatted: nothing is written for it');

  const k = parsed.tracks[70];
  assert(k && k.every(v => v === 0xFF) && k.length <= 6355 && row(72).align === 'killer',
    `a track that is all sync stays all sync, shortened to what zone 0 holds (${k?.length} bytes)`);
}

// ── The .nbz container ───────────────────────────────────────────────────────
{
  const { revolutions } = sourceDisk();
  const entries = [];
  for (let t = 1; t <= 35; t++) entries.push({ halfTrack: t * 2, zone: zoneOf(t), raw: rawRead(revolutions.get((t - 1) * 2), t * 50) });
  const nib = buildNib(entries);
  const nbz = lzCompress(nib);
  assert(isNbz(nbz) && !isNib(nbz), 'a compressed dump starts with the marker byte, then the NIB signature');
  assert(same(lzUncompress(nbz), nib), 'inflating the stream gives the NIB back byte for byte');
  const direct = nibToG64(parseNib(nib)).g64;
  const viaNbz = nibFileToG64(nbz);
  assert(same(viaNbz.g64, direct) && viaNbz.version === 3, 'a .nbz converts to the same G64 as the .nib it holds');
}

// ── Real dumps ───────────────────────────────────────────────────────────────
{
  const dumps = [
    ['candidate[mastertronic_1984].nbz', 'MR CHIP'],
    ['nemesis_the_warlock[martech_1987](!).nbz', null],
    ['buggy_boy[elite_1987].nbz', null],
    ['bomb_jack[elite_1986](pal)(!).nbz', 'BOMBDISK'],
    ['double_dragon[mastertronic_1988](to)(!).nbz', null],
  ];
  if (!assetPath('c64pp')) {
    console.log(`ok  - real C64 Preservation Project dumps convert # SKIP ${missingNote('c64pp')}`);
  } else {
    for (const [file, diskName] of dumps) {
      const p = collectionFile('c64pp', file);
      if (!existsSync(p)) { console.log(`ok  - ${file} converts # SKIP not in the c64pp collection`); continue; }
      const { g64, report } = nibFileToG64(new Uint8Array(readFileSync(p)));
      const parsed = parseG64(g64);
      const whole = report.filter(r => r.length && !(r.halfTrack & 1)).length;
      const view = new G64(g64);
      const named = diskName ? view.diskName.trim() === diskName : true;
      assert(parsed.halfTrackCount === 84 && whole >= 35 && view.entries.length >= 1 && named,
        `${file}: ${whole} tracks, ${view.entries.length} directory entries, "${view.diskName.trim()}"`);
    }
  }
}

if (failed) { console.error(`\n${failed} NBZ format check(s) failed.`); process.exit(1); }
console.log('\nAll NBZ format spec tests passed.');
