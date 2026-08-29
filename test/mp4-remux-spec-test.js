// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// fragmented MP4 → progressive MP4 remux (src/mp4-remux.js).
//
// MediaRecorder emits fragmented MP4, which carries no sample tables. Players
// that rebuild a track's timeline by accumulating the fragments' declared
// durations then get the video short — those durations don't cover capture
// stalls, while audio runs continuously — and sound drifts from picture by ~0.5 s
// even though every timestamp in the file is correct. Editors wanting an index
// (QuickTime) also refuse to trim it.
//
// The fixture here is built in-process rather than committed, and deliberately
// mixes the shapes different browsers produce: per-sample durations AND tfhd
// defaults, one trun per traf AND two, composition offsets (B-frames), an edit
// list (Safari's AAC priming skip), and a tfdt step wider than the durations
// declared for it — the stall that has to be recovered.
import { remuxFragmentedMp4, assembleRemuxPlan } from '../src/mp4-remux.js';

let tests = 0;
let failures = 0;
const expect = (cond, msg) => {
  tests++;
  if (!cond) { failures++; console.log(`FAIL - ${msg}`); }
};
const eq = (got, want, msg) => expect(got === want, `${msg} (got ${got}, want ${want})`);

// ── minimal box writer ─────────────────────────────────────────────────────

const u32 = (x) => [(x >>> 24) & 255, (x >>> 16) & 255, (x >>> 8) & 255, x & 255];
const u16 = (x) => [(x >>> 8) & 255, x & 255];
const ascii = (s) => [...s].map(c => c.charCodeAt(0));
const box = (type, ...payload) => {
  const body = payload.flat(Infinity);
  return [...u32(body.length + 8), ...ascii(type), ...body];
};
const full = (type, version, flags, ...payload) =>
  box(type, [(version & 255), ...u32(flags).slice(1)], payload.flat(Infinity));

// ── the fixture ────────────────────────────────────────────────────────────

const MOVIE_TS = 1000;
const A_TS = 8000;            // "audio" timescale
const V_TS = 3000;            // "video" timescale

// Audio: 4 + 4 samples, per-sample durations/sizes, an edit list on the track.
const A1 = [{ d: 1000, s: 11 }, { d: 1000, s: 12 }, { d: 1000, s: 13 }, { d: 1000, s: 14 }];
const A2 = [{ d: 1000, s: 15 }, { d: 1000, s: 16 }, { d: 1000, s: 17 }, { d: 1000, s: 18 }];
// Video fragment 1: per-sample durations + composition offsets, first is sync.
const V1 = [{ d: 100, s: 40, cto: 200 }, { d: 100, s: 21, cto: 0 }, { d: 100, s: 22, cto: 100 }];
// Video fragment 2: sizes/durations from tfhd DEFAULTS, split across two truns.
const V2A = [{ d: 100, s: 30 }, { d: 100, s: 30 }];
const V2B = [{ d: 100, s: 30 }, { d: 100, s: 30 }];

// The stall: fragment 1's video declares 300 ticks but the next fragment starts
// at 500, so 200 ticks (~67 ms) never made it into any sample's duration.
const V_FRAG2_TFDT = 500;
const V_STALL = V_FRAG2_TFDT - V1.reduce((a, s) => a + s.d, 0);

// Recognisable payload bytes, so the rebuilt offsets can be checked by reading
// each sample back out of the remuxed file.
let nextByte = 1;
const payloadFor = (samples) => samples.map(s => {
  const tag = nextByte++;
  return new Uint8Array(s.s).fill(tag);
});
const aPay1 = payloadFor(A1), vPay1 = payloadFor(V1);
const aPay2 = payloadFor(A2), vPay2a = payloadFor(V2A), vPay2b = payloadFor(V2B);
const flatten = (arrs) => arrs.flatMap(a => [...a]);

const sampleEntry = (fourcc) => box(fourcc, new Array(78).fill(0));

const trak = (id, ts, handler, mediaBox, entry, withEdts) => box('trak',
  full('tkhd', 0, 3, u32(0), u32(0), u32(id), u32(0), u32(0),
    u32(0), u32(0), u16(0), u16(0), u16(0x0100), u16(0),
    [0x00, 0x01, 0x00, 0x00].concat(new Array(32).fill(0)), u32(0), u32(0)),
  withEdts ? box('edts', full('elst', 0, 0, u32(1), u32(1234), u32(1024), u16(1), u16(0))) : [],
  box('mdia',
    full('mdhd', 0, 0, u32(0), u32(0), u32(ts), u32(0), u16(0x55c4), u16(0)),
    full('hdlr', 0, 0, u32(0), ascii(handler), u32(0), u32(0), u32(0), [0]),
    box('minf', mediaBox, box('dinf', full('dref', 0, 0, u32(0))),
      box('stbl', box('stsd', full('stsd', 0, 0, u32(1)).slice(8), sampleEntry(entry)),
        full('stts', 0, 0, u32(0)), full('stsc', 0, 0, u32(0)),
        full('stsz', 0, 0, u32(0), u32(0)), full('stco', 0, 0, u32(0))))));

const moov = box('moov',
  full('mvhd', 0, 0, u32(0), u32(0), u32(MOVIE_TS), u32(0), u32(0x00010000),
    u16(0x0100), u16(0), [0x00, 0x01, 0x00, 0x00].concat(new Array(32).fill(0)),
    new Array(24).fill(0), u32(3)),
  trak(1, A_TS, 'soun', box('smhd', u32(0)), 'mp4a', true),
  trak(2, V_TS, 'vide', box('vmhd', u32(0), u32(0), u32(0)), 'avc1', false),
  box('mvex', full('trex', 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0)),
    full('trex', 0, 0, u32(2), u32(1), u32(0), u32(0), u32(0))));

// trun with per-sample duration+size (+ optional composition offsets)
const trunExplicit = (samples, dataOffset, firstFlags) => {
  const hasCto = samples.some(s => 'cto' in s);
  const flags = 0x000001 | (firstFlags !== undefined ? 0x000004 : 0)
    | 0x000100 | 0x000200 | (hasCto ? 0x000800 : 0);
  return full('trun', hasCto ? 1 : 0, flags, u32(samples.length), u32(dataOffset),
    firstFlags !== undefined ? u32(firstFlags) : [],
    samples.flatMap(s => [...u32(s.d), ...u32(s.s), ...(hasCto ? u32(s.cto || 0) : [])]));
};
// trun relying on tfhd defaults for duration and size
const trunDefaults = (count, dataOffset) =>
  full('trun', 0, 0x000001, u32(count), u32(dataOffset));

const tfhd = (id, { defDur, defSize, defFlags } = {}) => {
  let flags = 0x020000;                       // default-base-is-moof
  const extra = [];
  if (defDur !== undefined) { flags |= 0x000008; extra.push(...u32(defDur)); }
  if (defSize !== undefined) { flags |= 0x000010; extra.push(...u32(defSize)); }
  if (defFlags !== undefined) { flags |= 0x000020; extra.push(...u32(defFlags)); }
  return full('tfhd', 0, flags, u32(id), extra);
};
const tfdt = (t) => full('tfdt', 0, 0, u32(t));

const NON_SYNC = 0x01010000;                  // sample_is_non_sync_sample set
const SYNC = 0x02000000;

// Two fragments. Sizes are computed by building the moof once to learn its
// length, since trun data offsets are relative to the moof start.
function buildFragment(trafs, payloads) {
  const mdatBody = flatten(payloads);
  const probe = box('moof', trafs(0));
  const moofLen = probe.length;
  const base = moofLen + 8;                   // + mdat header
  return { moof: box('moof', trafs(base)), mdat: box('mdat', mdatBody), mdatBody };
}

const frag1 = buildFragment((base) => [
  box('traf', tfhd(1), tfdt(0), trunExplicit(A1, base)),
  box('traf', tfhd(2, { defFlags: NON_SYNC }), tfdt(0),
    trunExplicit(V1, base + A1.reduce((a, s) => a + s.s, 0), SYNC)),
], [...aPay1, ...vPay1]);

const frag2 = buildFragment((base) => {
  const aBytes = A2.reduce((a, s) => a + s.s, 0);
  return [
    box('traf', tfhd(1), tfdt(4000), trunExplicit(A2, base)),
    box('traf', tfhd(2, { defDur: 100, defSize: 30, defFlags: NON_SYNC }), tfdt(V_FRAG2_TFDT),
      trunDefaults(V2A.length, base + aBytes),
      trunDefaults(V2B.length, base + aBytes + 60)),
  ];
}, [...aPay2, ...vPay2a, ...vPay2b]);

const fixture = new Uint8Array([
  ...box('ftyp', ascii('isom'), u32(0x200), ascii('isom'), ascii('iso2'), ascii('avc1'), ascii('mp41')),
  ...moov,
  ...frag1.moof, ...frag1.mdat,
  ...frag2.moof, ...frag2.mdat,
]);

// ── reading the result back ────────────────────────────────────────────────

function* boxes(b, start, end) {
  let p = start;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    let bodyStart = p + 8;
    if (size === 1) { size = Number(dv.getBigUint64(p + 8)); bodyStart = p + 16; }
    if (size < 8) return;
    yield { type, start: p, size, bodyStart, end: p + size };
    p += size;
  }
}
const find = (b, s, e, type) => { for (const x of boxes(b, s, e)) if (x.type === type) return x; return null; };
const dvOf = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

function readTable(b, bx, entryWords) {
  const dv = dvOf(b);
  const count = dv.getUint32(bx.bodyStart + 4);
  const rows = [];
  for (let i = 0; i < count; i++) {
    const row = [];
    for (let w = 0; w < entryWords; w++) row.push(dv.getUint32(bx.bodyStart + 8 + (i * entryWords + w) * 4));
    rows.push(row);
  }
  return rows;
}

function tracksOf(out) {
  const moovBox = find(out, 0, out.length, 'moov');
  const list = [];
  for (const trak of boxes(out, moovBox.bodyStart, moovBox.end)) {
    if (trak.type !== 'trak') continue;
    const dv = dvOf(out);
    const tkhd = find(out, trak.bodyStart, trak.end, 'tkhd');
    const id = dv.getUint32(tkhd.bodyStart + 12);
    const mdia = find(out, trak.bodyStart, trak.end, 'mdia');
    const mdhd = find(out, mdia.bodyStart, mdia.end, 'mdhd');
    const minf = find(out, mdia.bodyStart, mdia.end, 'minf');
    const stbl = find(out, minf.bodyStart, minf.end, 'stbl');
    list.push({
      id,
      trak,
      mdhdDuration: dv.getUint32(mdhd.bodyStart + 16),
      tkhdDuration: dv.getUint32(tkhd.bodyStart + 20),
      edts: find(out, trak.bodyStart, trak.end, 'edts'),
      stts: readTable(out, find(out, stbl.bodyStart, stbl.end, 'stts'), 2),
      stsc: readTable(out, find(out, stbl.bodyStart, stbl.end, 'stsc'), 3),
      stco: readTable(out, find(out, stbl.bodyStart, stbl.end, 'stco'), 1).map(r => r[0]),
      stszBox: find(out, stbl.bodyStart, stbl.end, 'stsz'),
      stss: find(out, stbl.bodyStart, stbl.end, 'stss'),
      ctts: find(out, stbl.bodyStart, stbl.end, 'ctts'),
    });
  }
  return list;
}

function sampleSizes(out, t) {
  const dv = dvOf(out);
  const count = dv.getUint32(t.stszBox.bodyStart + 8);
  const uniform = dv.getUint32(t.stszBox.bodyStart + 4);
  if (uniform) return new Array(count).fill(uniform);
  return Array.from({ length: count }, (_, i) => dv.getUint32(t.stszBox.bodyStart + 12 + i * 4));
}

// Walk stsc/stco/stsz the way a demuxer does, returning each sample's bytes.
function samplePayloads(out, t) {
  const sizes = sampleSizes(out, t);
  const perChunk = [];
  for (let i = 0; i < t.stsc.length; i++) {
    const [firstChunk, count] = t.stsc[i];
    const nextFirst = i + 1 < t.stsc.length ? t.stsc[i + 1][0] : t.stco.length + 1;
    for (let c = firstChunk; c < nextFirst; c++) perChunk.push(count);
  }
  const out2 = [];
  let s = 0;
  for (let c = 0; c < t.stco.length; c++) {
    let off = t.stco[c];
    for (let k = 0; k < perChunk[c]; k++, s++) {
      out2.push(out.subarray(off, off + sizes[s]));
      off += sizes[s];
    }
  }
  return out2;
}

// ── the assertions ─────────────────────────────────────────────────────────

// The remux returns a PLAN (header bytes + ranges of the source) and never reads
// the recording into memory, so realize it here to assert on actual bytes.
const result = await remuxFragmentedMp4(fixture);
expect(result !== null, 'a fragmented input is recognised and remuxed');

if (result) {
  const out = assembleRemuxPlan(result.parts, fixture);
  eq(out.length, result.stats.bytesOut, 'the assembled plan is exactly bytesOut long');
  // Every mdat byte must come from a range, never from an inline copy: the whole
  // point is that the recording is referenced, not materialized.
  const inlineBytes = result.parts
    .filter(p => p instanceof Uint8Array).reduce((a, p) => a + p.length, 0);
  expect(inlineBytes < result.stats.bytesOut,
    'the plan carries headers inline and the media as ranges');
  const top = [...boxes(out, 0, out.length)].map(b => b.type);
  expect(top.join(',') === 'ftyp,moov,mdat',
    `output is ftyp,moov,mdat with the index first — faststart (got ${top.join(',')})`);
  expect(!top.includes('moof'), 'no fragments remain in the output');

  // mvhd must be the spec's exact length — a short one shifts the matrix and
  // next_track_ID, which ffmpeg tolerates and real players reject outright.
  const moovBox = find(out, 0, out.length, 'moov');
  const mvhd = find(out, moovBox.bodyStart, moovBox.end, 'mvhd');
  eq(mvhd.size, 108, 'mvhd is the full 108 bytes for version 0');
  // body: verflags4 creation4 modification4 timescale4 …
  eq(dvOf(out).getUint32(mvhd.bodyStart + 12), MOVIE_TS, 'mvhd timescale is where it belongs');
  const matrixW = dvOf(out).getUint32(mvhd.bodyStart + 36);
  eq(matrixW, 0x00010000, 'the unity matrix starts at the spec offset');

  const [audio, video] = tracksOf(out).sort((a, b) => a.id - b.id);

  // The stall: the video timeline must span the full tfdt step, so it stays
  // aligned with audio in a player that accumulates durations.
  const vTicks = video.stts.reduce((a, [n, d]) => a + n * d, 0);
  const aTicks = audio.stts.reduce((a, [n, d]) => a + n * d, 0);
  eq(vTicks, V_FRAG2_TFDT + V2A.length * 100 + V2B.length * 100,
    'video timeline covers the tfdt step, stall included');
  eq(vTicks - (V1.length + V2A.length + V2B.length) * 100, V_STALL,
    'exactly the missing stall was added, nothing more');
  eq(aTicks, (A1.length + A2.length) * 1000, 'audio timeline is unchanged');
  // …and it lands on the LAST sample of the stalled fragment, not spread around:
  // sample 3 is the last of video fragment 1.
  const vDurations = video.stts.flatMap(([n, d]) => new Array(n).fill(d));
  eq(vDurations[V1.length - 1], 100 + V_STALL, 'the stall lands on the stalled fragment\'s last sample');
  expect(vDurations.filter((d, i) => i !== V1.length - 1).every(d => d === 100),
    'no other sample duration was touched');

  // Durations in the headers follow the rebuilt tables.
  eq(video.mdhdDuration, vTicks, 'video mdhd duration matches its table');
  eq(audio.mdhdDuration, aTicks, 'audio mdhd duration matches its table');
  eq(audio.tkhdDuration, Math.round(aTicks / A_TS * MOVIE_TS), 'audio tkhd duration is in movie timescale');

  // Sizes and offsets: read every sample back through the tables and compare
  // with what went in. This is the check that the index actually points at the
  // right bytes, in the right order.
  const wantAudio = [...aPay1, ...aPay2];
  const wantVideo = [...vPay1, ...vPay2a, ...vPay2b];
  const gotAudio = samplePayloads(out, audio);
  const gotVideo = samplePayloads(out, video);
  eq(gotAudio.length, wantAudio.length, 'audio sample count survives');
  eq(gotVideo.length, wantVideo.length, 'video sample count survives');
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  expect(wantAudio.every((w, i) => gotAudio[i] && same([...w], [...gotAudio[i]])),
    'every audio sample reads back byte-identical through stsc/stco/stsz');
  expect(wantVideo.every((w, i) => gotVideo[i] && same([...w], [...gotVideo[i]])),
    'every video sample reads back byte-identical through stsc/stco/stsz');

  // Sync samples: the first of each video fragment, and no stss for audio
  // (where every sample is a sync sample and the box is meaningless).
  expect(video.stss !== null, 'video carries a sync-sample table');
  if (video.stss) {
    const syncs = readTable(out, video.stss, 1).map(r => r[0]);
    expect(syncs.includes(1), `video sample 1 is sync (got ${syncs.join(',')})`);
  }
  expect(audio.stss === null, 'audio has no stss — all samples are sync');

  // Composition offsets from the source must survive, or reordered frames would
  // play at their decode times.
  expect(video.ctts !== null, 'video composition offsets are carried into ctts');
  if (video.ctts) {
    const rows = readTable(out, video.ctts, 2);
    const total = rows.reduce((a, [n, off]) => a + n * off, 0);
    eq(total, V1.reduce((a, s) => a + (s.cto || 0), 0), 'ctts preserves the offsets it was given');
  }
  expect(audio.ctts === null, 'audio has no ctts — nothing was reordered');

  // Safari writes an edit list to skip AAC priming; losing it would shift that
  // track by the priming length.
  expect(audio.edts !== null, 'the edit list is preserved');
  expect(video.edts === null, 'no edit list is invented for a track that had none');

  // Reported stalls, per track and in seconds.
  const vStall = result.stats.repairedSeconds.find(r => r.trackId === 2);
  expect(vStall && Math.abs(vStall.seconds - V_STALL / V_TS) < 1e-9,
    `stall is reported in seconds (got ${vStall && vStall.seconds})`);
}

// A progressive file must be left alone rather than half-rebuilt.
{
  const progressive = new Uint8Array([...box('ftyp', ascii('isom')), ...moov, ...box('mdat', [1, 2, 3, 4])]);
  expect(await remuxFragmentedMp4(progressive) === null, 'a file with no fragments is left untouched');
  expect(await remuxFragmentedMp4(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])) === null,
    'garbage input is refused, not crashed on');
}

// A ranged source with a window far smaller than the file: the multi-window path
// a real recording takes, where the scan must skip each mdat instead of reading
// it. The fixture is 1777 bytes, so the default 256 KB window would swallow it
// whole and prove nothing.
{
  const ranges = [];
  const drip = {
    size: fixture.length,
    async read(offset, length) {
      ranges.push([offset, offset + length]);
      return fixture.subarray(offset, offset + length);
    },
  };
  const viaSource = await remuxFragmentedMp4(drip, { windowSize: 64 });
  expect(viaSource !== null, 'a { size, read } source remuxes like a buffer');
  if (viaSource) {
    const a = assembleRemuxPlan(viaSource.parts, fixture);
    const b = assembleRemuxPlan(result.parts, fixture);
    expect(a.length === b.length && a.every((x, i) => x === b[i]),
      'a ranged source produces byte-identical output to an in-memory one');
    expect(viaSource.stats.metadataBytes < viaSource.stats.bytesIn,
      `the scan reads less than the whole file (${viaSource.stats.metadataBytes}`
      + ` of ${viaSource.stats.bytesIn} bytes, ${viaSource.stats.sourceReads} reads)`);

    // The guarantee is that reads do not SCALE with the recording. A window that
    // lands on an mdat header does spill a little way into the payload behind it,
    // but that spill is bounded by the window — never by the mdat's size — so a
    // multi-gigabyte payload costs the same as this fixture's.
    const top = [...boxes(fixture, 0, fixture.length)];
    const mdats = top.filter(b => b.type === 'mdat');
    expect(mdats.length > 0, 'the fixture has mdat boxes to skip past');
    const biggestMeta = Math.max(...top.filter(b => b.type !== 'mdat').map(b => b.size));
    const biggestRead = Math.max(...ranges.map(([s, e]) => e - s));
    expect(biggestRead <= Math.max(64, biggestMeta),
      `no read exceeds the window or a metadata box (biggest read ${biggestRead},`
      + ` window 64, biggest metadata box ${biggestMeta})`);
    // Total read is bounded by the metadata plus one window per box. Both terms
    // are independent of mdat size — which is the whole claim. (This fixture is
    // moov-heavy with only a few hundred bytes of mdat, the inverse of a real
    // recording, so the bound is what to assert here rather than a ratio.)
    const metaTotal = top.filter(b => b.type !== 'mdat').reduce((a, b) => a + b.size, 0);
    const bound = metaTotal + 64 * top.length;
    expect(viaSource.stats.metadataBytes <= bound,
      `reads stay within metadata + one window per box (${viaSource.stats.metadataBytes}`
      + ` <= ${metaTotal} + 64x${top.length} = ${bound})`);
  }
}

console.log(`\n${tests - failures}/${tests} passed`);
if (failures) process.exit(1);
