// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/media/nib.js – nibbler dumps (.nib, and .nbz, the same LZ-compressed)
// turned into G64 images.
//
// A .nib holds 8 KB straight off the read head per half-track: more than one
// revolution, begun anywhere. A G64 wants exactly one, cut and aligned. The
// rules for finding it are nibconv's, at its default settings.
//
// Ported from nibtools by Pete Rittwage and contributors
// (https://github.com/rittwage/nibtools, GPL-3.0-or-later): fileio.c (NIB
// header, G64 writer), gcr.c (track cycle, alignment, sync reduction, bad
// GCR) and prot.c (fat tracks, auto gap). lzUncompress is a rewrite, so an
// altered version, of the LZ77 decoder in Marcus Geelnard's Basic Compression
// Library (lz.c in nibtools, zlib-style license). See NOTICE.txt.
//
// .nib layout: "MNIB-1541-RAW", version at 13, from $10 (half-track, density)
// byte pairs ended by a zero, from $100 one 8192-byte read per pair. Density
// bits 0-1 are the zone; the rest are flags nibconv discards.
// .nbz: one LZ77 stream. Byte 0 is the marker; marker+0 is a literal marker;
// marker + length + offset (7 bits a byte, most significant first, top bit =
// more) copies from the output so far.

const NIB_MAGIC = 'MNIB-1541-RAW';
const NIB_HEADER = 0x100;
const NIB_TRACK = 0x2000;
const HALF_TRACKS = 84;         // G64 slots: half-tracks 2 (track 1) to 85
const FIRST_HALF_TRACK = 2;
const GAP_MATCH = 7;            // bytes compared to call two positions the same
const CAP_ALLOWANCE = 0xFF;     // slack on the capacity range a cycle may fall in
const GCR_MIN_FORMATTED = 16;   // good GCR bytes in a row that make a formatted track
const GCR_BLOCK_LEN = 24 + 337;
const GCR_BLOCK_DATA_LEN = 337;
const SIGNIFICANT_GAPLEN_DIFF = 0x20;   // a gap this much longer than a block is the tail gap
const REDUCE_SYNC_TO = 4;       // sync bytes left when a track must shrink
const RPM_REAL = 295;           // a track is too long only if a real disk at 295 rpm could not hold it
// Bytes a minute per zone 0-3: 4 MHz over the zone divisor (16..13), 8 bits, 60 s.
const BYTES_PER_MINUTE = [1875000, 2000000, 2142857, 2307692];
const capacityAt = (zone, rpm) => Math.floor(BYTES_PER_MINUTE[zone & 3] / rpm);
const DEFAULT_G64_TRACK_MAX = 7928;

const ascii = (bytes, at, s) => {
  if (!bytes || bytes.length < at + s.length) return false;
  for (let i = 0; i < s.length; i++) if (bytes[at + i] !== s.charCodeAt(i)) return false;
  return true;
};

// ── .nbz ─────────────────────────────────────────────────────────────────────

/** Inflate a Basic Compression Library LZ77 stream. */
export function lzUncompress(input) {
  if (input.length < 1) return new Uint8Array(0);
  const marker = input[0];
  let out = new Uint8Array(Math.max(4096, input.length * 4));
  let outPos = 0, inPos = 1;
  const room = n => {
    if (outPos + n <= out.length) return;
    const bigger = new Uint8Array(Math.max(out.length * 2, outPos + n));
    bigger.set(out.subarray(0, outPos));
    out = bigger;
  };
  const readVarSize = () => {
    let value = 0, b;
    do {
      if (inPos >= input.length) throw new Error('the LZ stream ends inside a length or offset');
      b = input[inPos++];
      value = value * 128 + (b & 0x7F);
    } while (b & 0x80);
    return value;
  };
  while (inPos < input.length) {
    const symbol = input[inPos++];
    if (symbol !== marker) { room(1); out[outPos++] = symbol; continue; }
    if (inPos >= input.length) throw new Error('the LZ stream ends after a marker');
    if (input[inPos] === 0) { inPos++; room(1); out[outPos++] = marker; continue; }
    const length = readVarSize();
    const offset = readVarSize();
    if (offset === 0 || offset > outPos) throw new Error('an LZ copy reaches before the start of the output');
    room(length);
    for (let i = 0; i < length; i++) { out[outPos] = out[outPos - offset]; outPos++; }
  }
  return out.subarray(0, outPos);
}

// ── .nib ─────────────────────────────────────────────────────────────────────

export function isNib(bytes) { return ascii(bytes, 0, NIB_MAGIC); }
/** The marker byte comes first; the signature follows as literals. */
export function isNbz(bytes) { return ascii(bytes, 1, NIB_MAGIC); }

/**
 * Index a .nib. Throws when the table names more tracks than the file holds.
 * @returns {{ version: number, tracks: Map<number, { raw: Uint8Array, zone: number }> }}
 *   keyed by half-track in drive numbering (2 = track 1)
 */
export function parseNib(bytes) {
  if (!isNib(bytes)) throw new Error('not a NIB dump (no MNIB-1541-RAW signature)');
  const version = bytes[13];
  const tracks = new Map();
  let n = 0;
  for (let at = 0x10; at + 1 < NIB_HEADER && bytes[at]; at += 2, n++) {
    const halfTrack = bytes[at];
    const start = NIB_HEADER + n * NIB_TRACK;
    if (start + NIB_TRACK > bytes.length) {
      throw new Error(`the track table names ${n + 1} tracks but the file holds ${n} (${bytes.length} bytes)`);
    }
    // Slots past the head's reach cannot be read; skip them.
    if (halfTrack < FIRST_HALF_TRACK || halfTrack >= FIRST_HALF_TRACK + HALF_TRACKS) continue;
    tracks.set(halfTrack, { raw: bytes.subarray(start, start + NIB_TRACK), zone: bytes[at + 1] & 3 });
  }
  return { version, tracks };
}

// ── The raw stream ───────────────────────────────────────────────────────────

// Three zero bits in a row (counting the two bits before): no GCR code has that.
function isBadGcr(buf, len, pos) {
  const last = pos === 0 ? buf[len - 1] : buf[pos - 1];
  const data = ((last & 3) << 8) | buf[pos];
  for (let mask = 7 << 7; mask >= 7; mask >>= 1) if ((data & mask) === 0) return true;
  return false;
}

function hasFormattedRun(buf) {
  let run = 0;
  for (let i = 0; i < buf.length; i++) {
    run = isBadGcr(buf, buf.length, i) ? 0 : run + 1;
    if (run >= GCR_MIN_FORMATTED) return true;
  }
  return false;
}

// Nearly every byte ends a sync: a killer track.
function isKillerTrack(buf, len) {
  let syncs = 0;
  for (let i = 0; i + 1 < len; i++) if ((buf[i] & 0x7F) === 0x7F) syncs++;
  return len > 0 && syncs >= len - 3;
}

// First byte after the next sync run at or past `pos`, or -1. A sync is a byte
// ending in a one bit then $FF: ten ones wanted, reads sometimes lose one.
function findSync(buf, pos, end) {
  for (;;) {
    if (pos + 1 >= end) return -1;
    if ((buf[pos] & 1) === 1 && buf[pos + 1] === 0xFF) break;
    pos++;
  }
  pos++;
  while (pos < end && buf[pos] === 0xFF) pos++;
  return pos < end ? pos : -1;
}

// The $FF before the next sector header ($52) at or past `pos`, or -1.
function findHeader(buf, pos, end) {
  for (;;) {
    if (pos + 2 >= end) return -1;
    if ((buf[pos] & 1) === 1 && buf[pos + 1] === 0xFF && buf[pos + 2] === 0x52) break;
    pos++;
  }
  pos++;
  return pos < end ? pos : -1;
}

function sameBytes(buf, a, b, n) {
  for (let i = 0; i < n; i++) if (buf[a + i] !== buf[b + i]) return false;
  return true;
}

// Worth matching a cycle on: no sync, no byte or pair repeating, no gap filler.
function validData(buf, pos, n) {
  let redundant = 0;
  for (let i = pos; i < pos + n; i++) {
    if (buf[i] === 0xFF) return false;
    if (buf[i] === buf[i + 1] && buf[i + 1] === buf[i + 2]) redundant++;
    if (buf[i] === buf[i + 2] && buf[i + 1] === buf[i + 3]) redundant++;
    if (redundant > 2) return false;
    if (buf[i] === 0x55 && buf[i + 1] === 0xAA && buf[i + 2] === 0x55) return false;
    if (buf[i] === 0xAA && buf[i + 1] === 0x55 && buf[i + 2] === 0xAA) return false;
    if (buf[i] === 0x5A && buf[i + 1] === 0xA5 && buf[i + 2] === 0x5A) return false;
  }
  return true;
}

// The cycle by its syncs: a start and a point at least `capMin` on where what
// follows every sync matches. { start, stop } or null.
function cycleBySyncs(raw, capMin) {
  const stop = NIB_TRACK - GAP_MATCH;
  for (let start = 0; start >= 0; start = findSync(raw, start, stop)) {
    if (start + capMin >= stop) break;
    for (let data = findSync(raw, start + capMin, stop); data >= 0; data = findSync(raw, data, stop)) {
      let p1 = start, p2 = data, cycle = data;
      while (p2 < stop) {
        if (!sameBytes(raw, p1, p2, GAP_MATCH)) { cycle = -1; break; }
        p1 = findSync(raw, p1, stop);
        if (p1 < 0) break;
        p2 = findSync(raw, p2, stop);
        if (p2 < 0) break;
      }
      if (cycle >= 0 && validData(raw, data, GAP_MATCH)) return { start, stop: cycle };
    }
  }
  return null;
}

// The cycle without syncs: any point whose bytes come round again a capacity later.
function cycleRaw(raw, capMin) {
  const stop = NIB_TRACK - GAP_MATCH;
  for (let p1 = 0; p1 < stop; p1++) {
    for (let p2 = p1 + capMin + CAP_ALLOWANCE; p2 < stop; p2++) {
      if (sameBytes(raw, p1, p2, GAP_MATCH) && validData(raw, p2, GAP_MATCH)) return { start: p1, stop: p2 };
    }
  }
  return null;
}

// From just after a sync back to its first byte, folded into the first copy.
function backToSyncStart(work, len, pos) {
  do {
    pos -= 1;
    if (pos === 0) pos += len;
  } while (work[pos] === 0xFF);
  pos += 1;
  while (pos >= len) pos -= len;
  return pos;
}

// Sector 0's sync in a doubled track; `len` is a block length when found, else 0.
function findSector0(work, len) {
  const end = 2 * len - 10;
  let pos = findSync(work, 0, end);
  if (pos < 0) return null;
  let found = false;
  while (pos < end) {
    pos = findSync(work, pos, end);
    if (pos < 0) return null;
    // $52 then the GCR of $08 $xx $00: a header naming sector 0.
    if (work[pos] === 0x52 && (work[pos + 1] & 0xC0) === 0x40 &&
        (work[pos + 2] & 0x0F) === 0x05 && (work[pos + 3] & 0xFC) === 0x28) { found = true; break; }
  }
  return { pos: backToSyncStart(work, len, pos), len: found ? GCR_BLOCK_LEN : 0 };
}

// The sync after the longest header-to-header gap, with that gap's length.
function findSectorGap(work, len) {
  const end = 2 * len - 10;
  let pos = findSync(work, 0, end);
  if (pos < 0) return null;
  let last = pos, longestAt = pos, longest = 0;
  while (pos < end) {
    pos = findHeader(work, pos, end);
    if (pos < 0) break;
    const gap = pos - last;
    if (gap > longest) { longest = gap; longestAt = pos; }
    last = pos;
  }
  if (longest === 0) return null;
  return { pos: backToSyncStart(work, len, longestAt), len: longest };
}

// Five bytes before the end of the longest run of one byte, or -1.
function autoGap(work, len) {
  let run = 0, longest = 0, key = -1, keyTemp = -1;
  for (let pos = 0; pos < len - 1; pos++) {
    if (work[pos] === work[pos + 1]) { keyTemp = pos + 2; run++; }
    else {
      if (run > longest) { key = keyTemp; longest = run; }
      run = 0;
    }
  }
  if (key < 0) return -1;
  return key >= 5 ? key - 5 : key;
}

/**
 * One revolution out of an 8 KB read, started at the tail gap when there is a
 * clear one, else at sector 0, else at whatever gap or run there is.
 * @returns {{ data: Uint8Array, length: number, align: string }}  length 0
 *   when unformatted; a killer track comes back whole.
 */
export function extractTrackCycle(raw, zone) {
  const capMin = capacityAt(zone, 305) - CAP_ALLOWANCE;
  const capMax = capacityAt(zone, 295) + CAP_ALLOWANCE;
  if (!hasFormattedRun(raw)) return { data: new Uint8Array(0), length: 0, align: 'unformatted' };
  if (isKillerTrack(raw, NIB_TRACK)) return { data: raw.slice(), length: NIB_TRACK, align: 'killer' };

  let cycle = cycleBySyncs(raw, capMin);
  let len = cycle ? cycle.stop - cycle.start : NIB_TRACK;
  if (len > capMax || len < capMin) {
    cycle = cycleRaw(raw, capMin);
    len = cycle ? cycle.stop - cycle.start : NIB_TRACK;
  }
  const start = cycle ? cycle.start : 0;
  if (len <= capMin) len += (capMax - capMin) >> 1;   // too short for any disk: pad with what follows

  const work = new Uint8Array(len * 2);   // doubled, so any start copies straight
  for (let i = 0; i < len; i++) work[i] = raw[(start + i) % NIB_TRACK];
  work.set(work.subarray(0, len), len);

  const sector0 = findSector0(work, len);
  const gap = findSectorGap(work, len);
  let from, align;
  if (gap && gap.len > GCR_BLOCK_DATA_LEN + SIGNIFICANT_GAPLEN_DIFF) { from = gap.pos; align = 'gap'; }
  else if (sector0 && sector0.len) { from = sector0.pos; align = 'sector 0'; }
  else if (gap && gap.len) { from = gap.pos; align = 'gap'; }
  else {
    const at = autoGap(work, len);
    if (at >= 0) { from = at; align = 'auto gap'; }
    else { from = 0; align = 'none'; }
  }
  return { data: work.slice(from, from + len), length: len, align };
}

// ── Fat tracks ───────────────────────────────────────────────────────────────

// How much of two tracks agrees, syncs, pre-sync bytes, $55/$AA shifts and bad GCR forgiven.
function trackMatch(t1, l1, t2, l2) {
  let byteMatch = 0, syncDiff = 0, presyncDiff = 0, shiftDiff = 0, badDiff = 0;
  for (let j = 0, k = 0; j < l2 && k < l1; j++, k++) {
    const a = t1[j], b = t2[k];
    if (a === 0xFF && b === 0xFF) continue;
    if (a === 0xFF) { syncDiff++; k--; continue; }
    if (b === 0xFF) { j--; continue; }
    if (t1[j + 1] === 0xFF) { presyncDiff++; k--; continue; }
    if (t2[k + 1] === 0xFF) { j--; continue; }
    if ((a === 0x55 && b === 0xAA) || (a === 0xAA && b === 0x55)) { shiftDiff++; continue; }
    if (isBadGcr(t1, l1, j)) { badDiff++; k--; continue; }
    if (isBadGcr(t2, l2, k)) { j--; continue; }
    if (a === b) byteMatch++;
  }
  return byteMatch + syncDiff + presyncDiff + shiftDiff + badDiff;
}

// Two whole tracks that read alike were written wide: the half-track between
// gets the data too. Only the first pair counts; a second means the disk repeats.
function fillFatTracks(tracks) {
  let found = 0;
  for (let ht = FIRST_HALF_TRACK; ht <= HALF_TRACKS - 2; ht += 2) {
    const a = tracks.get(ht), b = tracks.get(ht + 2);
    if (!a || !b || !a.length || !b.length || a.length === NIB_TRACK || b.length === NIB_TRACK) continue;
    const diff = a.length - trackMatch(a.data, a.length, b.data, b.length);
    if (diff < 0 || !(diff <= 20 || (ht >= 70 && diff <= 40))) continue;
    if (found === 0) {
      tracks.set(ht + 1, { data: a.data.slice(), length: a.length, zone: a.zone, align: `fat track ${ht / 2}` });
    }
    found++;
  }
}

// ── Fitting ──────────────────────────────────────────────────────────────────

// Inside a run of three or more bad GCR bytes, all but the first two and the
// last become $00. Returns the bad-byte count.
function settleBadGcr(buf, len) {
  let total = 0, state = 0, lastPos = 0;
  for (let i = 0; i + 1 < len; i++) {
    const bad = isBadGcr(buf, len, i);
    if (state === 0) { if (bad) { total++; state = 1; } }
    else if (state === 1) { if (bad) { total++; state = 2; } else state = 0; }
    else if (bad) { total++; buf[lastPos] = 0; }
    else state = 0;
    lastPos = i;
  }
  return total;
}

// One byte off every run of `target` longer than `minRun`, while still at `lengthMax` or more.
function stripRuns(buf, len, lengthMax, minRun, target) {
  let run = 0, skipped = 0, w = 0;
  for (let r = 0; r < len; r++) {
    const v = buf[r];
    if (v === target && len - skipped >= lengthMax) {
      if (run === minRun) skipped++; else buf[w++] = target;
      run++;
    } else { run = 0; buf[w++] = v; }
  }
  return skipped;
}

function reduceRuns(buf, len, lengthMax, minRun, target) {
  while (len > lengthMax) {
    const skipped = stripRuns(buf, len, lengthMax, minRun, target);
    if (!skipped) break;
    len -= skipped;
  }
  return len;
}

// ── G64 ──────────────────────────────────────────────────────────────────────

/**
 * A G64 from a NIB's tracks: one revolution each, fat tracks spread, bad GCR
 * settled, and any track a real disk could not hold shortened, syncs first,
 * then its tail.
 * @returns {{ g64: Uint8Array, report: Array<{ halfTrack, zone, length, align, weak, syncCut, truncated }> }}
 */
export function nibToG64(nib) {
  const tracks = new Map();
  for (const [halfTrack, t] of nib.tracks) {
    const cut = extractTrackCycle(t.raw, t.zone);
    tracks.set(halfTrack, { data: cut.data, length: cut.length, zone: t.zone, align: cut.align });
  }
  fillFatTracks(tracks);

  // The image's track size is the longest revolution; a whole 8 KB read does not count.
  let trackMax = 0;
  for (const t of tracks.values()) if (t.length && t.length !== NIB_TRACK && t.length > trackMax) trackMax = t.length;
  if (!trackMax) trackMax = DEFAULT_G64_TRACK_MAX;

  const report = [];
  const written = [];
  for (const halfTrack of [...tracks.keys()].sort((a, b) => a - b)) {
    const t = tracks.get(halfTrack);
    const row = { halfTrack, zone: t.zone, length: t.length, align: t.align, weak: 0, syncCut: 0, truncated: 0 };
    report.push(row);
    if (!t.length) continue;
    const buf = new Uint8Array(NIB_TRACK).fill(t.data[t.length - 1]);
    buf.set(t.data.subarray(0, t.length));
    let len = t.length;
    row.weak = settleBadGcr(buf, len);
    const capacity = Math.min(capacityAt(t.zone, RPM_REAL), trackMax);
    if (len > capacity) {
      const before = len;
      len = reduceRuns(buf, len, capacity, REDUCE_SYNC_TO, 0xFF);
      row.syncCut = before - len;
      if (len > capacity) { row.truncated = len - capacity; len = capacity; }
    }
    row.length = len;
    written.push({ halfTrack, zone: t.zone, buf, len });
  }

  const tables = 12 + HALF_TRACKS * 8;
  const g64 = new Uint8Array(tables + written.length * (trackMax + 2));
  const view = new DataView(g64.buffer);
  for (let i = 0; i < 8; i++) g64[i] = 'GCR-1541'.charCodeAt(i);
  g64[8] = 0;
  g64[9] = HALF_TRACKS;
  view.setUint16(10, trackMax, true);
  let at = tables;
  for (const t of written) {
    const i = t.halfTrack - FIRST_HALF_TRACK;
    view.setUint32(12 + i * 4, at, true);
    view.setUint32(12 + HALF_TRACKS * 4 + i * 4, t.zone, true);
    view.setUint16(at, t.len, true);
    g64.fill(t.buf[t.len - 1], at + 2 + t.len, at + 2 + trackMax);   // slot padding, as nibconv leaves it
    g64.set(t.buf.subarray(0, t.len), at + 2);
    at += 2 + trackMax;
  }
  return { g64, report };
}

/** A .nbz or .nib file as a G64, with the report and the NIB version. */
export function nibFileToG64(bytes) {
  const nib = parseNib(isNbz(bytes) ? lzUncompress(bytes) : bytes);
  return { ...nibToG64(nib), version: nib.version };
}
