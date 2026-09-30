// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/media/g64.js – G64 raw GCR disk images.
//
// A .g64 holds what the 1541's read head sees rather than the sectors DOS makes
// of it: one raw GCR bitstream per half-track, recorded at whatever length and
// layout the original disk had. That is what custom track layouts, extra
// sectors, long tracks and half-track copy protection need, and a .d64 cannot
// describe any of them.
//
// Layout (all multi-byte values little-endian):
//   $0000  "GCR-1541"                 signature
//   $0008  version                    0
//   $0009  half-track count  n        typically 84 (tracks 1-42.5)
//   $000A  maximum track size (u16)   bytes reserved per track, typically 7928
//   $000C  n × u32 track offsets      entry i = track 1 + i/2; 0 = nothing there
//   ...    n × u32 speed-zone entries 0-3 = one zone for the whole track,
//                                      else the offset of a per-byte zone map
//   track data at each offset: u16 length, then that many GCR bytes.
//
// The drive reads and writes the track bytes in place — they are views into the
// file — so the image this object exports is always the disk as it now stands.
// Directory listing, click-to-load and the drive-off KERNAL trap go through a
// sector view decoded from the whole tracks, rebuilt after head writes land.

import { D64, SPT } from './d64.js';
import { decodeTrackStream } from '../gcr.js';

const SIGNATURE = 'GCR-1541';
const HEADER_BYTES = 12;
// The half-track range the head covers: track 1 (half-track 2) to 42.5.
const MAX_HALF_TRACKS = 84;
// The largest D64 variant's track count; the sector view never needs more.
const MAX_WHOLE_TRACKS = 42;

/**
 * How far every whole track's headers sit from the slot the format gives it:
 * 0 on a well-formed image. Some dumps hold track 1 in the slot for track 2 and
 * every other track one slot further on, with the first slot empty. The DOS
 * finds a track by the number in its headers, so the drive reads such a dump as
 * it stands; the sector view goes by the headers too, once every recorded track
 * agrees on the same offset (a lone decoy header cannot move the view).
 * @param {Map<number, Array<{track: number}>>} blocksByEntry  decoded blocks per
 *   whole-track entry index
 */
function headerShift(blocksByEntry) {
  const deltas = new Set();
  let voters = 0;
  for (const [i, blocks] of blocksByEntry) {
    const votes = new Map();
    for (const blk of blocks) votes.set(blk.track, (votes.get(blk.track) || 0) + 1);
    let named = -1, n = 0;
    for (const [t, c] of votes) if (c > n) { named = t; n = c; }
    if (named < 0) continue;
    deltas.add(named - (1 + i / 2));
    voters++;
  }
  return deltas.size === 1 && voters >= 3 ? [...deltas][0] : 0;
}

/** Whether `bytes` starts with the G64 signature. */
export function isG64(bytes) {
  if (!bytes || bytes.length < SIGNATURE.length) return false;
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Check and index a G64 image. Throws on anything the header or tables get
 * wrong, since a track pointing past the end of the file would otherwise hand
 * the drive a stream made of whatever follows.
 * @param {Uint8Array} bytes
 * @returns {{ halfTrackCount: number, maxTrackSize: number,
 *   tracks: Array<Uint8Array|null>, speedZones: Uint8Array,
 *   speedMaps: Array<Uint8Array|null> }}
 *   `tracks[i]` is a view into `bytes` for half-track entry i; `speedZones[i]`
 *   is the zone the track was written in (the first byte's zone when the image
 *   carries a per-byte map, which `speedMaps[i]` then holds: four 2-bit zones
 *   a byte, first byte in the top bits).
 */
export function parseG64(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('A G64 image must be a byte array.');
  if (!isG64(bytes)) throw new Error('Not a G64 image (no GCR-1541 signature).');
  if (bytes.length < HEADER_BYTES) throw new Error('Truncated G64 header.');
  if (bytes[8] !== 0) throw new Error(`Unsupported G64 version ${bytes[8]}.`);
  const halfTrackCount = bytes[9];
  if (halfTrackCount < 1 || halfTrackCount > MAX_HALF_TRACKS) {
    throw new Error(`G64 half-track count ${halfTrackCount} is outside 1-${MAX_HALF_TRACKS}.`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const maxTrackSize = view.getUint16(10, true);
  if (maxTrackSize === 0) throw new Error('G64 maximum track size is zero.');
  const tablesEnd = HEADER_BYTES + halfTrackCount * 8;
  if (tablesEnd > bytes.length) throw new Error('Truncated G64 track tables.');

  const tracks = new Array(halfTrackCount).fill(null);
  const speedZones = new Uint8Array(halfTrackCount);
  const speedMaps = new Array(halfTrackCount).fill(null);
  for (let i = 0; i < halfTrackCount; i++) {
    const off = view.getUint32(HEADER_BYTES + i * 4, true);
    const speed = view.getUint32(HEADER_BYTES + halfTrackCount * 4 + i * 4, true);
    if (off === 0) continue;
    const where = `G64 half-track entry ${i} (track ${1 + i / 2})`;
    if (off < tablesEnd || off + 2 > bytes.length) throw new Error(`${where} points outside the file.`);
    const len = view.getUint16(off, true);
    if (len > maxTrackSize) throw new Error(`${where} is ${len} bytes, over the ${maxTrackSize}-byte maximum.`);
    if (off + 2 + len > bytes.length) throw new Error(`${where} runs past the end of the file.`);
    if (len === 0) continue;
    tracks[i] = bytes.subarray(off + 2, off + 2 + len);
    if (speed <= 3) {
      speedZones[i] = speed;
    } else {
      // Per-byte map: four 2-bit zones per byte, first byte in the top bits.
      if (speed < tablesEnd || speed + Math.ceil(len / 4) > bytes.length) {
        throw new Error(`${where} has a speed-zone map outside the file.`);
      }
      speedZones[i] = bytes[speed] >> 6;
      speedMaps[i] = bytes.subarray(speed, speed + Math.ceil(len / 4));
    }
  }
  return { halfTrackCount, maxTrackSize, tracks, speedZones, speedMaps };
}

/** A G64 image: the drive's GCR source and a D64-shaped directory view. */
export class G64 {
  /** @param {Uint8Array|ArrayBuffer} data */
  constructor(data) {
    this._bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const parsed = parseG64(this._bytes);
    this.isG64 = true;
    this.halfTrackCount = parsed.halfTrackCount;
    this.maxTrackSize = parsed.maxTrackSize;
    this._tracks = parsed.tracks;
    this.speedZones = parsed.speedZones;
    this._speedMaps = parsed.speedMaps;
    // Session attributes, as on a D64: `dirty` = changed since last persisted or
    // exported; `writeProtected` is the notch, which a .g64 doesn't record.
    this.dirty = false;
    this.writeProtected = true;
    // Whole tracks the write head has changed since the view was last rebuilt.
    this._dirtyTracks = new Set();
    // Slots the whole tracks sit away from where the format puts them (see
    // headerShift); the view reads through it, the drive never does.
    this._viewShift = 0;
    this._view = null;
    this._buildView();
  }

  /** The image as it now stands, head writes included. */
  get img() { return this._bytes; }

  // ── GCR source for the drive (the interface GCRDisk offers for a D64) ──────

  /**
   * The raw stream under the head, or null for an unrecorded half-track (the
   * head then finds no sync, as on an unformatted area of a real disk). The
   * drive passes both the whole track and the half-track its head is on; a
   * G64 records each half-track separately, so it goes by the half-track.
   * @param {number} track @param {number} [halfTrack] drive numbering, 2 = track 1
   */
  getTrackStream(track, halfTrack = track * 2) {
    const i = halfTrack - 2;
    return i >= 0 && i < this.halfTrackCount ? this._tracks[i] : null;
  }

  getSectorCount(track) { return SPT[track] || 0; }

  /** The zone half-track `halfTrack` was recorded in, numbered as the VIA2
   *  PB5-6 density bits are: 3 = the fastest bit rate (tracks 1-17), 0 = the
   *  slowest (31 on). It sets how fast the recorded flux transitions pass the
   *  head; what the drive makes of them depends on the density it selected
   *  (see the drive's read circuit). A track with a per-byte map reports its
   *  first byte's zone here and the map through `speedMapFor`. An unrecorded
   *  half-track reads at the zone of the whole track it sits on (it has no
   *  bits either way). */
  speedZoneFor(halfTrack) {
    const i = halfTrack - 2;
    if (i < 0 || i >= this.halfTrackCount) return 0;
    return (this._tracks[i] || (i & 1) === 0) ? this.speedZones[i] : this.speedZones[i - 1];
  }

  /** The per-byte zone map of half-track `halfTrack` (four 2-bit zones a
   *  byte, first byte in the top bits), or null when the whole track is one
   *  zone. */
  speedMapFor(halfTrack) {
    const i = halfTrack - 2;
    return i >= 0 && i < this.halfTrackCount ? this._speedMaps[i] : null;
  }

  /** The write head changed the stream under it. The bytes are already in the
   *  image; what's left is the sector view, so remember which track to re-read. */
  markTrackDirty(track, halfTrack = track * 2) {
    this.dirty = true;
    // The slot the head wrote, as the track its headers name.
    this._dirtyTracks.add((halfTrack >> 1) + this._viewShift);
  }

  hasDirtyTracks() { return this._dirtyTracks.size > 0; }

  /**
   * Bring the sector view up to date with what the head wrote. The GCR bytes
   * need no folding back — they are the image — so this re-decodes only the
   * tracks that changed. Returns the number of sectors decoded from them.
   */
  commitDirtyTracks() {
    if (this._dirtyTracks.size === 0) return 0;
    let decoded = 0;
    for (const track of this._dirtyTracks) decoded += this._decodeTrackInto(this._view, track);
    this._dirtyTracks.clear();
    this._view._parse();
    return decoded;
  }

  // ── Sector view ─────────────────────────────────────────────────────────────

  /** The entry index holding the whole track whose headers name `track`, or
   *  -1 when the image has no slot for it: the format's own slot, moved by
   *  `_viewShift` on a dump whose tracks all sit that far from it. */
  _entryFor(track) {
    const i = (track - this._viewShift - 1) * 2;
    return i >= 0 && i < this.halfTrackCount ? i : -1;
  }

  /** Highest whole track the view can show, capped at the D64 range. */
  get trackCount() {
    let last = 0;
    for (let t = 1; t <= MAX_WHOLE_TRACKS; t++) {
      const i = this._entryFor(t);
      if (i >= 0 && this._tracks[i]) last = t;
    }
    return last <= 35 ? 35 : last <= 40 ? 40 : 42;
  }

  _buildView() {
    // Every whole track decoded once: the header numbers settle where each
    // track sits, then its sectors fill the view.
    const blocksByEntry = new Map();
    for (let i = 0; i < this.halfTrackCount; i += 2) {
      if (this._tracks[i]) blocksByEntry.set(i, decodeTrackStream(this._tracks[i]));
    }
    this._viewShift = headerShift(blocksByEntry);
    const tracks = this.trackCount;
    let sectors = 0;
    for (let t = 1; t <= tracks; t++) sectors += SPT[t];
    const view = new D64(new Uint8Array(sectors * 256));
    for (let t = 1; t <= tracks; t++) {
      const blocks = blocksByEntry.get(this._entryFor(t));
      if (blocks) this._fillTrack(view, t, blocks);
    }
    view._parse();
    this._view = view;
  }

  /** Decode whole track `track` from its slot and write its sectors into `view`. */
  _decodeTrackInto(view, track) {
    const i = this._entryFor(track);
    const stream = i >= 0 ? this._tracks[i] : null;
    if (!stream || track < 1 || track > view.trackCount) return 0;
    return this._fillTrack(view, track, decodeTrackStream(stream));
  }

  /** Write the sectors among `blocks` that belong to `track` into `view`.
   *  Only blocks whose header names this track count — a protection's decoy
   *  header for another track would otherwise overwrite a real sector. The
   *  first readable copy of a sector wins. */
  _fillTrack(view, track, blocks) {
    const seen = new Set();
    let n = 0;
    for (const blk of blocks) {
      if (blk.track !== track || blk.sector >= (SPT[track] || 0) || seen.has(blk.sector)) continue;
      seen.add(blk.sector);
      view.writeSector(track, blk.sector, blk.data);
      n++;
    }
    return n;
  }

  readSector(track, sector) { return this._view.readSector(track, sector); }
  get entries() { return this._view.entries; }
  get diskName() { return this._view.diskName; }
  get diskId() { return this._view.diskId; }
  get dosType() { return this._view.dosType; }
  get freeBlocks() { return this._view.freeBlocks; }
  get isGEOS() { return this._view.isGEOS; }
  get hasReadableDirectoryNames() { return this._view.hasReadableDirectoryNames; }
  loadFile(name) { return this._view.loadFile(name); }
  buildDirectoryPRG(pattern = '') { return this._view.buildDirectoryPRG(pattern); }
  /** Re-read the directory (the view is already current once writes commit). */
  _parse() { this.commitDirtyTracks(); this._view._parse(); }
}
