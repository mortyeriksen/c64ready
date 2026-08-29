// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/mp4-remux.js – turn MediaRecorder's fragmented MP4 into a plain indexed one.
//
// MediaRecorder emits fragmented MP4: an init segment followed by moof+mdat
// pairs, with no sample tables. Two consequences bite:
//
//   * Players that rebuild each track's timeline by accumulating the fragments'
//     sample durations get the VIDEO track wrong, because those durations do not
//     account for capture stalls — a 100 s recording measured 0.31 s short. Audio
//     is continuous, so the two tracks slide apart and the sound ends up ~0.5 s
//     from the picture even though every timestamp in the file is correct.
//   * Editors that expect an index (QuickTime among them) refuse to trim.
//
// Both are the same missing thing: a real `moov` with sample tables. This walks
// the fragments, rebuilds stts/stsz/stsc/stco/stss per track, and writes
// ftyp + moov + mdat with the moov first (faststart). The encoded samples and
// their sample-entry boxes (avcC / esds) are copied byte for byte — no codec
// work happens here, only timing.
//
// Where the durations are recovered: each fragment carries `tfdt`
// (baseMediaDecodeTime), so the true span of fragment N is the next fragment's
// tfdt minus its own. When the fragment's per-sample durations fall short of
// that span, the shortfall IS the stall, and it belongs on that fragment's last
// sample. That is what makes the rebuilt video timeline match the audio's.
//
// The recording is never held in memory, which two properties of the format
// allow — keep both intact:
//
//   * Sample tables come from moov/moof metadata alone, so the input is scanned
//     by ranged reads that seek past every mdat instead of reading it.
//   * The output mdat is a concatenation of input ranges, so the result is a PLAN
//     (header bytes + `{ offset, size }` refs) that the caller stitches with
//     `blob.slice()` parts — by reference, never through the JS heap.
//
// Peak memory is the metadata: single-digit MB for an hour of capture.
//
// Structure per ISO/IEC 14496-12 (ISO base media file format); the AVC sample
// entry it copies is ISO/IEC 14496-15. See docs/SPECIFICATIONS.md.

const U32_MAX = 0xFFFFFFFF;

// ── reading ────────────────────────────────────────────────────────────────

class Reader {
  constructor(bytes) {
    this.b = bytes;
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.p = 0;
  }
  u8() { return this.v.getUint8(this.p++); }
  u16() { const x = this.v.getUint16(this.p); this.p += 2; return x; }
  u24() { return (this.u8() << 16) | this.u16(); }
  u32() { const x = this.v.getUint32(this.p); this.p += 4; return x; }
  i32() { const x = this.v.getInt32(this.p); this.p += 4; return x; }
  u64() { const hi = this.u32(), lo = this.u32(); return hi * 4294967296 + lo; }
  skip(n) { this.p += n; }
  type() { const s = String.fromCharCode(this.u8(), this.u8(), this.u8(), this.u8()); return s; }
}

// Iterate the boxes in [start, end) as { type, start, size, bodyStart }.
function* boxes(bytes, start, end) {
  let p = start;
  while (p + 8 <= end) {
    const r = new Reader(bytes);
    r.p = p;
    let size = r.u32();
    const type = r.type();
    let bodyStart = p + 8;
    if (size === 1) { size = r.u64(); bodyStart = p + 16; }
    else if (size === 0) size = end - p;
    if (size < 8 || p + size > end) return;
    yield { type, start: p, size, bodyStart, end: p + size };
    p += size;
  }
}

function findBox(bytes, start, end, type) {
  for (const b of boxes(bytes, start, end)) if (b.type === type) return b;
  return null;
}

// ── reading the source by range ────────────────────────────────────────────

// A source is { size, read(offset, length) -> Promise<Uint8Array> }. Blobs and
// in-memory buffers both adapt to it, so the remux runs identically over a
// recording on disk and over a fixture in a test.
function toSource(input) {
  if (input && typeof input.read === 'function' && typeof input.size === 'number') return input;
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    return {
      size: input.size,
      async read(offset, length) {
        return new Uint8Array(await input.slice(offset, offset + length).arrayBuffer());
      },
    };
  }
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return {
    size: bytes.length,
    async read(offset, length) { return bytes.subarray(offset, offset + length); },
  };
}

// One read serves a box header and the moof behind it; the cursor only moves
// forward, so a window is dropped once passed.
//
// Size it to a MOOF, not to a chunk of media: a miss starts at the byte wanted, so
// each costs a full window, and with mdats larger than the window there is one
// miss per fragment. Everything past the moof is waste. On a modelled 10-min take
// (600 fragments, 0.9 MB of real metadata) 256 KB read 157 MB where 8 KB reads
// 4.9 MB. 8 KB still covers a moof plus the next mdat header in one read, so the
// one-read-per-fragment property holds while the over-read stays ~5×. A moof
// larger than the window is not a problem: copy() reads it at its exact size.
const SCAN_WINDOW = 8 * 1024;

class ScanWindow {
  constructor(source, windowSize = SCAN_WINDOW) {
    this.source = source;
    this.windowSize = windowSize;
    this.buf = null;
    this.start = 0;
    this.reads = 0;                          // round trips, for the stats line
    this.bytesRead = 0;                      // metadata actually pulled in
  }

  // A VIEW of [offset, offset+length), valid only until the next call. Short at
  // EOF. Never use it across an await.
  async view(offset, length) {
    const want = Math.min(length, this.source.size - offset);
    if (want <= 0) return EMPTY;
    if (want > this.windowSize) return this._direct(offset, want);
    if (!this.buf || offset < this.start || offset + want > this.start + this.buf.length) {
      this.buf = await this._direct(offset, Math.min(this.windowSize, this.source.size - offset));
      this.start = offset;
    }
    const rel = offset - this.start;
    return this.buf.subarray(rel, rel + want);
  }

  // A buffer safe to retain, or null if the range is short. Used for the
  // metadata boxes only — never for mdat.
  async copy(offset, length) {
    if (offset < 0 || offset + length > this.source.size) return null;
    // Bigger than the window: read it straight through, already its own buffer.
    if (length > this.windowSize) {
      const direct = await this._direct(offset, length);
      return direct.length === length ? direct : null;
    }
    const v = await this.view(offset, length);
    return v.length === length ? v.slice() : null;
  }

  async _direct(offset, length) {
    this.reads++;
    const got = await this.source.read(offset, length);
    this.bytesRead += got.length;
    return got;
  }
}

const EMPTY = new Uint8Array(0);

// Keep ftyp/moov/moof, seek past everything else. Skipping mdat rather than
// reading it is what keeps the recording out of memory.
async function readStructure(source, windowSize = SCAN_WINDOW) {
  const win = new ScanWindow(source, windowSize);
  let ftyp = null;
  let moov = null;
  const moofs = [];                          // { abs, bytes } — abs is needed for
  let p = 0;                                 // default-base-is-moof offsets
  while (p + 8 <= source.size) {
    const head = await win.view(p, 16);
    if (head.length < 8) break;
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    let size = dv.getUint32(0);
    const type = String.fromCharCode(head[4], head[5], head[6], head[7]);
    if (size === 1) {
      if (head.length < 16) break;
      size = dv.getUint32(8) * 4294967296 + dv.getUint32(12);
    } else if (size === 0) {
      size = source.size - p;                // box extends to end of file
    }
    if (size < 8 || p + size > source.size) break;
    if (type === 'ftyp') ftyp = await win.copy(p, size);
    else if (type === 'moov') moov = await win.copy(p, size);
    else if (type === 'moof') {
      const bytes = await win.copy(p, size);
      if (!bytes) break;
      moofs.push({ abs: p, bytes });
    }
    p += size;
  }
  return { ftyp, moov, moofs, reads: win.reads, bytesRead: win.bytesRead };
}

// ── writing ────────────────────────────────────────────────────────────────

class Writer {
  constructor() { this.parts = []; this.len = 0; }
  bytes(u8) { this.parts.push(u8); this.len += u8.length; return this; }
  u8(x) { return this.bytes(new Uint8Array([x & 0xFF])); }
  u16(x) { return this.bytes(new Uint8Array([(x >>> 8) & 0xFF, x & 0xFF])); }
  u32(x) {
    return this.bytes(new Uint8Array([(x >>> 24) & 0xFF, (x >>> 16) & 0xFF, (x >>> 8) & 0xFF, x & 0xFF]));
  }
  u64(x) {
    const hi = Math.floor(x / 4294967296), lo = x >>> 0;
    return this.u32(hi).u32(lo);
  }
  ascii(s) { return this.bytes(new Uint8Array([...s].map(c => c.charCodeAt(0)))); }
  concat() {
    const out = new Uint8Array(this.len);
    let p = 0;
    for (const part of this.parts) { out.set(part, p); p += part.length; }
    return out;
  }
}

// A box is size + type + payload; payload built by `fill`.
function box(type, fill) {
  const inner = new Writer();
  fill(inner);
  const w = new Writer();
  w.u32(inner.len + 8).ascii(type).bytes(inner.concat());
  return w.concat();
}

function fullBox(type, version, flags, fill) {
  return box(type, (w) => { w.u32(((version & 0xFF) << 24) | (flags & 0xFFFFFF)); fill(w); });
}

// ── parsing the init segment ───────────────────────────────────────────────

function parseInit(bytes, moov) {
  const mvhdBox = findBox(bytes, moov.bodyStart, moov.end, 'mvhd');
  if (!mvhdBox) return null;
  const r = new Reader(bytes);
  r.p = mvhdBox.bodyStart;
  const version = r.u8(); r.u24();
  if (version === 1) { r.u64(); r.u64(); } else { r.u32(); r.u32(); }
  const movieTimescale = r.u32();

  const tracks = new Map();
  for (const trak of boxes(bytes, moov.bodyStart, moov.end)) {
    if (trak.type !== 'trak') continue;
    const tkhd = findBox(bytes, trak.bodyStart, trak.end, 'tkhd');
    const mdia = findBox(bytes, trak.bodyStart, trak.end, 'mdia');
    if (!tkhd || !mdia) continue;
    const edts = findBox(bytes, trak.bodyStart, trak.end, 'edts');
    const mdhd = findBox(bytes, mdia.bodyStart, mdia.end, 'mdhd');
    const hdlr = findBox(bytes, mdia.bodyStart, mdia.end, 'hdlr');
    const minf = findBox(bytes, mdia.bodyStart, mdia.end, 'minf');
    if (!mdhd || !minf) continue;
    const stbl = findBox(bytes, minf.bodyStart, minf.end, 'stbl');
    const stsd = stbl && findBox(bytes, stbl.bodyStart, stbl.end, 'stsd');
    if (!stsd) continue;

    // track id + timescale
    const tr = new Reader(bytes); tr.p = tkhd.bodyStart;
    const tkVer = tr.u8(); tr.u24();
    if (tkVer === 1) { tr.u64(); tr.u64(); } else { tr.u32(); tr.u32(); }
    const trackId = tr.u32();

    const mr = new Reader(bytes); mr.p = mdhd.bodyStart;
    const mdVer = mr.u8(); mr.u24();
    if (mdVer === 1) { mr.u64(); mr.u64(); } else { mr.u32(); mr.u32(); }
    const mediaTimescale = mr.u32();

    let handler = '';
    if (hdlr) { const hr = new Reader(bytes); hr.p = hdlr.bodyStart + 8; handler = hr.type(); }

    tracks.set(trackId, {
      trackId, mediaTimescale, handler,
      tkhd: bytes.subarray(tkhd.start, tkhd.end),
      mdhdVersion: mdVer,
      // Safari writes an edit list to skip AAC encoder priming. Dropping it
      // would shift that track by the priming length (~46 ms) — the exact
      // class of error this module exists to remove — so it is preserved.
      edts: edts ? bytes.subarray(edts.start, edts.end) : null,
      mdhd: bytes.subarray(mdhd.start, mdhd.end),
      hdlr: hdlr ? bytes.subarray(hdlr.start, hdlr.end) : null,
      // Everything in minf except stbl is copied as-is (vmhd/smhd, dinf).
      minfExtras: [...boxes(bytes, minf.bodyStart, minf.end)]
        .filter(b => b.type !== 'stbl')
        .map(b => bytes.subarray(b.start, b.end)),
      stsd: bytes.subarray(stsd.start, stsd.end),
      chunks: [],          // { offset, size, samples: [{size, duration, sync}] }
    });
  }
  return { movieTimescale, tracks };
}

// ── parsing fragments ──────────────────────────────────────────────────────

// Sample flags (14496-12 §8.8.3.1): bit 16 of the low half is
// sample_is_non_sync_sample.
const isSync = (flags) => ((flags >>> 16) & 0x01) === 0;

// `moofs` are { abs, bytes }: each fragment's own buffer plus where it sat in the
// source. Box offsets below are therefore LOCAL to that buffer, while the sample
// offsets this produces (`run.offset`) stay ABSOLUTE in the source — they are
// what the output plan points at.
function parseFragments(init, moofs) {
  // First pass: per fragment, per track — sample sizes/durations + tfdt.
  const frags = [];
  for (const m of moofs) {
    const bytes = m.bytes;
    const moof = findBox(bytes, 0, bytes.length, 'moof');
    if (!moof) continue;
    const entry = { tracks: [] };
    for (const traf of boxes(bytes, moof.bodyStart, moof.end)) {
      if (traf.type !== 'traf') continue;
      const tfhd = findBox(bytes, traf.bodyStart, traf.end, 'tfhd');
      if (!tfhd) continue;
      const r = new Reader(bytes); r.p = tfhd.bodyStart;
      r.u8(); const tfFlags = r.u24();
      const trackId = r.u32();
      // default-base-is-moof: relative to where this moof STARTED in the source,
      // which is why `abs` is carried alongside the buffer.
      let baseDataOffset = m.abs;
      if (tfFlags & 0x000001) baseDataOffset = r.u64();
      if (tfFlags & 0x000002) r.u32();             // sample_description_index
      const defDuration = (tfFlags & 0x000008) ? r.u32() : 0;
      const defSize = (tfFlags & 0x000010) ? r.u32() : 0;
      const defFlags = (tfFlags & 0x000020) ? r.u32() : 0;

      let tfdt = null;
      const tfdtBox = findBox(bytes, traf.bodyStart, traf.end, 'tfdt');
      if (tfdtBox) {
        const tr = new Reader(bytes); tr.p = tfdtBox.bodyStart;
        const v = tr.u8(); tr.u24();
        tfdt = v === 1 ? tr.u64() : tr.u32();
      }

      // One run per trun: each carries its own data offset, so runs cannot be
      // assumed contiguous (Chrome emits a single trun per traf, Safari may not).
      const runs = [];
      let cursor = null;
      for (const trun of boxes(bytes, traf.bodyStart, traf.end)) {
        if (trun.type !== 'trun') continue;
        const tr = new Reader(bytes); tr.p = trun.bodyStart;
        const version = tr.u8(); const flags = tr.u24();
        const count = tr.u32();
        const dataOffset = (flags & 0x000001) ? tr.i32() : null;
        const firstFlags = (flags & 0x000004) ? tr.u32() : null;
        const offset = dataOffset !== null ? baseDataOffset + dataOffset
          : (cursor !== null ? cursor : baseDataOffset);
        const samples = [];
        for (let i = 0; i < count; i++) {
          const duration = (flags & 0x000100) ? tr.u32() : defDuration;
          const size = (flags & 0x000200) ? tr.u32() : defSize;
          const sflags = (flags & 0x000400) ? tr.u32()
            : (i === 0 && firstFlags !== null ? firstFlags : defFlags);
          // Composition offset: present whenever the encoder reorders frames
          // (B-frames). Version 1 makes it signed. Discarding these would play
          // reordered frames at their decode times — visible as stutter.
          const cto = (flags & 0x000800) ? (version === 1 ? tr.i32() : tr.u32()) : 0;
          samples.push({ size, duration, cto, sync: isSync(sflags) });
        }
        if (!samples.length) continue;
        const bytesInRun = samples.reduce((a, x) => a + x.size, 0);
        cursor = offset + bytesInRun;
        runs.push({ offset, samples });
      }
      if (!runs.length) continue;
      entry.tracks.push({ trackId, tfdt, runs });
    }
    if (entry.tracks.length) frags.push(entry);
  }

  // Second pass: recover the stalls. A fragment's true span is the next
  // fragment's tfdt minus its own; when the declared durations fall short, the
  // difference is time the capture did not deliver and belongs on the last
  // sample. Without this the video timeline comes out short and drifts against
  // the audio in any player that accumulates durations.
  let repaired = 0;
  const repairedByTrack = new Map();      // trackId → ticks, in that track's timescale
  const byTrack = new Map();
  for (const f of frags) {
    for (const t of f.tracks) {
      if (!byTrack.has(t.trackId)) byTrack.set(t.trackId, []);
      byTrack.get(t.trackId).push(t);
    }
  }
  for (const [, list] of byTrack) {
    for (let i = 0; i < list.length - 1; i++) {
      const cur = list[i], next = list[i + 1];
      if (cur.tfdt === null || next.tfdt === null) continue;
      const span = next.tfdt - cur.tfdt;
      const declared = cur.runs.reduce((a, r) => a + r.samples.reduce((x, s) => x + s.duration, 0), 0);
      const short = span - declared;
      if (short > 0 && span > 0) {
        const lastRun = cur.runs[cur.runs.length - 1];
        lastRun.samples[lastRun.samples.length - 1].duration += short;
        repaired++;
        repairedByTrack.set(cur.trackId, (repairedByTrack.get(cur.trackId) || 0) + short);
      }
    }
  }

  // Flatten into per-track chunk lists, one chunk per fragment (its samples are
  // contiguous in the source, so they stay contiguous in the output).
  for (const f of frags) {
    for (const t of f.tracks) {
      const track = init.tracks.get(t.trackId);
      if (!track) continue;
      for (const run of t.runs) {
        const size = run.samples.reduce((a, s) => a + s.size, 0);
        track.chunks.push({ offset: run.offset, size, samples: run.samples });
      }
    }
  }
  return { fragments: frags.length, repaired, repairedByTrack };
}

// ── building the output ────────────────────────────────────────────────────

function buildStbl(track) {
  const samples = track.chunks.flatMap(c => c.samples);

  // stts: run-length encoded (count, delta)
  const stts = [];
  for (const s of samples) {
    const last = stts[stts.length - 1];
    if (last && last[1] === s.duration) last[0]++;
    else stts.push([1, s.duration]);
  }

  // stsc: one entry per chunk, collapsed when consecutive chunks agree
  const stsc = [];
  track.chunks.forEach((c, i) => {
    const n = c.samples.length;
    const last = stsc[stsc.length - 1];
    if (last && last[1] === n) return;
    stsc.push([i + 1, n, 1]);
  });

  // ctts: only when the encoder reordered frames. Run-length encoded like stts.
  const ctts = [];
  let anyCto = false, anyNegative = false;
  for (const s of samples) {
    if (s.cto) anyCto = true;
    if (s.cto < 0) anyNegative = true;
    const last = ctts[ctts.length - 1];
    if (last && last[1] === s.cto) last[0]++;
    else ctts.push([1, s.cto]);
  }

  const syncs = [];
  samples.forEach((s, i) => { if (s.sync) syncs.push(i + 1); });
  const allSync = syncs.length === samples.length;

  return { samples, stts, stsc, syncs, allSync, ctts: anyCto ? ctts : null, anyNegative };
}

function trakBox(track, tables, chunkOffsets, use64, movieTimescale, trackDurationMovie) {
  const { samples, stts, stsc, syncs, allSync, ctts, anyNegative } = tables;
  const stbl = box('stbl', (w) => {
    w.bytes(track.stsd);
    w.bytes(fullBox('stts', 0, 0, (b) => {
      b.u32(stts.length);
      for (const [count, delta] of stts) b.u32(count).u32(delta);
    }));
    w.bytes(fullBox('stsc', 0, 0, (b) => {
      b.u32(stsc.length);
      for (const [first, per, desc] of stsc) b.u32(first).u32(per).u32(desc);
    }));
    w.bytes(fullBox('stsz', 0, 0, (b) => {
      b.u32(0).u32(samples.length);
      for (const s of samples) b.u32(s.size);
    }));
    if (use64) {
      w.bytes(fullBox('co64', 0, 0, (b) => {
        b.u32(chunkOffsets.length);
        for (const o of chunkOffsets) b.u64(o);
      }));
    } else {
      w.bytes(fullBox('stco', 0, 0, (b) => {
        b.u32(chunkOffsets.length);
        for (const o of chunkOffsets) b.u32(o);
      }));
    }
    // Composition offsets, when the source had them. Version 1 carries signed
    // offsets; emitting version 0 with a negative value would wrap.
    if (ctts) {
      w.bytes(fullBox('ctts', anyNegative ? 1 : 0, 0, (b) => {
        b.u32(ctts.length);
        for (const [count, off] of ctts) { b.u32(count); b.u32(off >>> 0); }
      }));
    }
    // A sync-sample table is only meaningful when some samples are not sync;
    // for audio every sample is, and the box is omitted (14496-12 §8.6.2).
    if (!allSync) {
      w.bytes(fullBox('stss', 0, 0, (b) => {
        b.u32(syncs.length);
        for (const n of syncs) b.u32(n);
      }));
    }
  });

  // tkhd / mdhd are copied with only their duration field patched, so track
  // geometry, language, matrix and flags survive untouched.
  const tkhd = patchDuration(track.tkhd, trackDurationMovie);
  const mdhd = patchDuration(track.mdhd, samples.reduce((a, s) => a + s.duration, 0));

  return box('trak', (w) => {
    w.bytes(tkhd);
    // Edit list preserved (Safari's AAC priming skip); its segment duration is
    // in movie timescale and has to follow the rebuilt track length.
    if (track.edts) w.bytes(patchElstDuration(track.edts, trackDurationMovie));
    w.bytes(box('mdia', (m) => {
      m.bytes(mdhd);
      if (track.hdlr) m.bytes(track.hdlr);
      m.bytes(box('minf', (mi) => {
        for (const extra of track.minfExtras) mi.bytes(extra);
        mi.bytes(stbl);
      }));
    }));
  });
}

// Patch only the duration field of a copied tkhd/mdhd, leaving geometry,
// language, matrix and flags exactly as the browser wrote them. Offsets are
// absolute within the box and differ per box type AND version
// (ISO/IEC 14496-12 §8.3.2, §8.4.2):
//
//   tkhd v0  size4 type4 verflags4 create4 modify4 trackID4 reserved4 → 28
//   tkhd v1  size4 type4 verflags4 create8 modify8 trackID4 reserved4 → 36
//   mdhd v0  size4 type4 verflags4 create4 modify4 timescale4         → 24
//   mdhd v1  size4 type4 verflags4 create8 modify8 timescale4         → 32
function patchDuration(src, duration) {
  const out = src.slice();
  const type = String.fromCharCode(out[4], out[5], out[6], out[7]);
  const version = out[8];
  const p = type === 'tkhd' ? (version === 1 ? 36 : 28) : (version === 1 ? 32 : 24);
  const width = version === 1 ? 8 : 4;
  if (p + width > out.length) return out;
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  if (version === 1) {
    dv.setUint32(p, Math.floor(duration / 4294967296));
    dv.setUint32(p + 4, duration >>> 0);
  } else {
    dv.setUint32(p, Math.min(duration, U32_MAX) >>> 0);
  }
  return out;
}

// elst entry 0's segment_duration, in movie timescale. Left alone when zero
// (some writers use 0 to mean "the whole track").
function patchElstDuration(edts, durationMovie) {
  const out = edts.slice();
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  // edts (8) → elst header (8) → version+flags (4) → entry_count (4)
  if (out.length < 32) return out;
  const elstType = String.fromCharCode(out[12], out[13], out[14], out[15]);
  if (elstType !== 'elst') return out;
  const version = out[16];
  const count = dv.getUint32(20);
  if (count < 1) return out;
  if (version === 1) {
    if (dv.getUint32(24) !== 0 || dv.getUint32(28) !== 0) {
      dv.setUint32(24, Math.floor(durationMovie / 4294967296));
      dv.setUint32(28, durationMovie >>> 0);
    }
  } else if (dv.getUint32(24) !== 0) {
    dv.setUint32(24, Math.min(durationMovie, U32_MAX) >>> 0);
  }
  return out;
}

/**
 * Remux a fragmented MP4 into a progressive, indexed one.
 *
 * `input` is a Blob, a Uint8Array/ArrayBuffer, or any
 * `{ size, read(offset, length) -> Promise<Uint8Array> }`.
 *
 * Returns `{ parts, stats }` — or null if the input is not fragmented MP4, in
 * which case callers should ship the original untouched. `parts` is the output
 * file as a list of Uint8Array (literal bytes) and `{ offset, size }` (ranges of
 * the input) in order; see `assembleRemuxPlan()` and the module header. The
 * recording is never read into memory, so this resolves without holding it.
 *
 * `windowSize` tunes how much the box-header scan pulls per read. The default
 * suits real recordings; tests set it small to force the multi-window path on a
 * fixture that would otherwise fit in one read.
 */
export async function remuxFragmentedMp4(input, { windowSize } = {}) {
  const source = toSource(input);
  const struct = await readStructure(source, windowSize || SCAN_WINDOW);
  if (!struct.moov || !struct.moofs.length) return null;   // progressive, or not MP4

  const moovBox = findBox(struct.moov, 0, struct.moov.length, 'moov');
  if (!moovBox) return null;
  const init = parseInit(struct.moov, moovBox);
  if (!init || !init.tracks.size) return null;
  const fragStats = parseFragments(init, struct.moofs);

  const tracks = [...init.tracks.values()].filter(t => t.chunks.length);
  if (!tracks.length) return null;

  // Movie duration = the longest track, in movie timescale.
  let movieDuration = 0;
  for (const t of tracks) {
    const ticks = t.chunks.reduce((a, c) => a + c.samples.reduce((x, s) => x + s.duration, 0), 0);
    movieDuration = Math.max(movieDuration, Math.round(ticks / t.mediaTimescale * init.movieTimescale));
  }

  const mdatSize = tracks.reduce((a, t) => a + t.chunks.reduce((x, c) => x + c.size, 0), 0);
  // Decide 64-bit offsets up front: the choice changes the moov's length, and
  // the offsets inside it depend on that length.
  const use64 = mdatSize + (1 << 22) > U32_MAX;

  // Output chunk order: fragment by fragment, tracks in their moov order, which
  // preserves the interleaving MediaRecorder produced.
  const order = [];
  const maxChunks = Math.max(...tracks.map(t => t.chunks.length));
  for (let i = 0; i < maxChunks; i++) {
    for (const t of tracks) if (t.chunks[i]) order.push({ track: t, chunk: t.chunks[i] });
  }

  const tables = new Map(tracks.map(t => [t, buildStbl(t)]));
  const relOffsets = new Map(tracks.map(t => [t, []]));
  let rel = 0;
  for (const { track, chunk } of order) { relOffsets.get(track).push(rel); rel += chunk.size; }

  // Two passes over the moov: the first only to learn its length, so the chunk
  // offsets it contains can point past it (faststart).
  const buildMoov = (base) => box('moov', (w) => {
    w.bytes(fullBox('mvhd', 0, 0, (b) => {
      // 14496-12 §8.2.2 mvhd v0: creation, modification, timescale, duration,
      // rate, volume, reserved(16) + reserved(32)x2, matrix, pre_defined(32)x6,
      // next_track_ID. Those two reserved words are easy to miss and shift
      // everything after them — ffmpeg tolerates the result, QuickTime rejects
      // the whole file.
      b.u32(0).u32(0).u32(init.movieTimescale).u32(movieDuration);
      b.u32(0x00010000).u16(0x0100).u16(0).u32(0).u32(0);
      // unity matrix
      const m = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
      for (const x of m) b.u32(x);
      for (let i = 0; i < 6; i++) b.u32(0);                 // pre_defined
      b.u32(Math.max(...tracks.map(t => t.trackId)) + 1);   // next_track_ID
    }));
    for (const t of tracks) {
      const ticks = tables.get(t).samples.reduce((a, s) => a + s.duration, 0);
      const durMovie = Math.round(ticks / t.mediaTimescale * init.movieTimescale);
      w.bytes(trakBox(t, tables.get(t), relOffsets.get(t).map(o => o + base), use64,
        init.movieTimescale, durMovie));
    }
  });

  const ftypBytes = struct.ftyp
    || box('ftyp', (w) => w.ascii('isom').u32(0x200).ascii('isom').ascii('iso2').ascii('avc1').ascii('mp41'));
  const probe = buildMoov(0);
  const mdatHeader = mdatSize + 8 > U32_MAX ? 16 : 8;
  const base = ftypBytes.length + probe.length + mdatHeader;
  const moovBytes = buildMoov(base);
  if (moovBytes.length !== probe.length) return null;   // length must not shift

  const mdatHeaderBytes = mdatHeader === 16
    ? box64Header(mdatSize + 16)
    : (() => { const w = new Writer(); w.u32(mdatSize + 8).ascii('mdat'); return w.concat(); })();

  // mdat as SOURCE RANGES, not bytes. Consecutive output chunks are usually
  // already adjacent in the input — MediaRecorder writes a fragment's tracks back
  // to back, and that is the order preserved here — so merging collapses
  // thousands of ranges into a handful. Same bytes, far fewer parts to stitch.
  const ranges = [];
  for (const { chunk } of order) {
    const last = ranges[ranges.length - 1];
    if (last && last.offset + last.size === chunk.offset) last.size += chunk.size;
    else ranges.push({ offset: chunk.offset, size: chunk.size });
  }

  return {
    parts: [ftypBytes, moovBytes, mdatHeaderBytes, ...ranges],
    stats: {
      fragments: fragStats.fragments,
      repairedFragments: fragStats.repaired,
      // Seconds of stall recovered per track, so a caller can log something
      // comparable across tracks with different timescales.
      repairedSeconds: [...fragStats.repairedByTrack].map(([id, ticks]) => {
        const t = init.tracks.get(id);
        return { trackId: id, seconds: t ? ticks / t.mediaTimescale : 0 };
      }),
      tracks: tracks.length,
      samples: tracks.reduce((a, t) => a + tables.get(t).samples.length, 0),
      bytesIn: source.size,
      bytesOut: base + mdatSize,
      // What the scan actually pulled in — the metadata, not the recording.
      // `ranges` vs `order.length` shows how well the merge did.
      metadataBytes: struct.bytesRead,
      sourceReads: struct.reads,
      ranges: ranges.length,
    },
  };
}

// A 64-bit mdat header: size 1, type, then the real size as a u64.
function box64Header(totalSize) {
  const w = new Writer();
  w.u32(1).ascii('mdat').u64(totalSize);
  return w.concat();
}

/**
 * Realize a plan in memory, given the source as one buffer. The browser path
 * does not use this — it maps the ranges to `blob.slice()` parts instead — but
 * it is the canonical reading of the plan format, and how tests assert bytes.
 */
export function assembleRemuxPlan(parts, input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let len = 0;
  for (const p of parts) len += (p instanceof Uint8Array) ? p.length : p.size;
  const out = new Uint8Array(len);
  let q = 0;
  for (const p of parts) {
    if (p instanceof Uint8Array) { out.set(p, q); q += p.length; }
    else { out.set(bytes.subarray(p.offset, p.offset + p.size), q); q += p.size; }
  }
  return out;
}
