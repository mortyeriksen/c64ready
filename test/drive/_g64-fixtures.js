// test/drive/_g64-fixtures.js
//
// Builds G64 images from first principles, per the G64 layout (VICE manual,
// "G64 disk image format"): "GCR-1541", version 0, half-track count, u16 max
// track size, then u32 track offsets and u32 speed-zone entries per half-track,
// each track stored as a u16 length followed by its raw GCR bytes. Nothing here
// goes through src/media/g64.js, so the parser is checked against the format
// rather than against itself.

import { GCRDisk } from '../../src/gcr.js';

export const HALF_TRACKS = 84;
export const MAX_TRACK_SIZE = 7928;

/** Speed-zone value for whole track `t`, numbered as the format does (the VIA2
 *  PB5-6 density bits): 3 for tracks 1-17 down to 0 for 31 and beyond. */
export function speedZone(t) {
  return t <= 17 ? 3 : t <= 24 ? 2 : t <= 30 ? 1 : 0;
}

/**
 * @param {Map<number, Uint8Array>} tracks  half-track entry index → GCR bytes
 * @param {{ halfTracks?: number, maxTrackSize?: number,
 *   speeds?: Map<number, number>, speedMaps?: Map<number, Uint8Array> }} [opts]
 *   `speeds` overrides an entry's zone (default: that track's standard zone);
 *   `speedMaps` stores a per-byte zone map for an entry instead.
 */
export function buildG64(tracks, opts = {}) {
  const n = opts.halfTracks ?? HALF_TRACKS;
  const max = opts.maxTrackSize ?? MAX_TRACK_SIZE;
  const maps = opts.speedMaps ?? new Map();
  const tablesEnd = 12 + n * 8;
  let size = tablesEnd;
  for (const i of tracks.keys()) if (i < n) size += 2 + max;
  for (const [i, m] of maps) if (i < n) size += m.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set([...'GCR-1541'].map(c => c.charCodeAt(0)), 0);
  out[8] = 0;
  out[9] = n;
  view.setUint16(10, max, true);
  let at = tablesEnd;
  for (let i = 0; i < n; i++) {
    const data = tracks.get(i);
    if (!data) continue;
    view.setUint32(12 + i * 4, at, true);
    view.setUint16(at, data.length, true);
    out.set(data, at + 2);
    at += 2 + max;
    view.setUint32(12 + n * 4 + i * 4, opts.speeds?.get(i) ?? speedZone(1 + (i >> 1)), true);
  }
  for (const [i, m] of maps) {
    if (i >= n) continue;
    view.setUint32(12 + n * 4 + i * 4, at, true);
    out.set(m, at);
    at += m.length;
  }
  return out;
}

/** The whole tracks of `d64` as G64 entries (even indices), each optionally
 *  padded with $55 gap bytes to `padTo`, or by `padBy` more bytes than its
 *  standard length — a longer-than-standard track. Mastering drives ran a
 *  little slow, so real images carry tracks ~1% long (about 100 bytes). */
export function tracksFromD64(d64, { padTo = 0, padBy = 0 } = {}) {
  const g = new GCRDisk(d64);
  const tracks = new Map();
  for (let t = 1; t <= (d64.trackCount || 35); t++) {
    const s = g.getTrackStream(t);
    if (!s) continue;
    const len = Math.max(s.length + padBy, padTo);
    const data = new Uint8Array(len).fill(0x55);
    data.set(s);
    tracks.set((t - 1) * 2, data);
  }
  return tracks;
}
