// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/d64.js – Commodore 1541 D64 disk image parser
// Standard 35-track format: 683 sectors × 256 bytes = 174 848 bytes. The
// 40-track (768 sectors) and 42-track (802 sectors) extensions are handled too,
// as is the variant of each that carries an appended error table.

// Sectors per track (1-indexed, index 0 unused)
export const SPT = [
  0,
  21,21,21,21,21,21,21,21,21,21,21,21,21,21,21,21,21, // tracks  1-17
  19,19,19,19,19,19,19,                                // tracks 18-24
  18,18,18,18,18,18,                                   // tracks 25-30
  17,17,17,17,17,                                      // tracks 31-35
  17,17,17,17,17,                                      // tracks 36-40 (extended)
  17,17,                                               // tracks 41-42 (extended)
];

// Image-size variants: a data area of (sectors × 256), optionally followed by an
// error table of one byte per sector. Nothing inside the file distinguishes them,
// so the byte length IS the variant — and the only way to tell a disk image from
// a file that merely ends in .d64.
const IMAGE_VARIANTS = [
  { bytes: 174848, tracks: 35, sectors: 683, errorInfo: false },
  { bytes: 175531, tracks: 35, sectors: 683, errorInfo: true  },
  { bytes: 196608, tracks: 40, sectors: 768, errorInfo: false },
  { bytes: 197376, tracks: 40, sectors: 768, errorInfo: true  },
  { bytes: 205312, tracks: 42, sectors: 802, errorInfo: false },
  { bytes: 206114, tracks: 42, sectors: 802, errorInfo: true  },
];

/**
 * The variant a byte length describes, or null when no D64 has that size. Callers
 * taking a file from the user check this first: a truncated download otherwise
 * parses into a directory full of nonsense instead of being turned away.
 * @param {number} byteLength
 */
export function d64Variant(byteLength) {
  return IMAGE_VARIANTS.find(v => v.bytes === byteLength) || null;
}

function sectorOffset(track, sector) {
  let offset = 0;
  for (let t = 1; t < track; t++) offset += (SPT[t] || 17);
  return (offset + sector) * 256;
}

/** Linear sector number (0-based, in image order) — indexes the error table. */
function sectorIndex(track, sector) {
  return sectorOffset(track, sector) / 256;
}

function readSec(img, track, sector) {
  const off = sectorOffset(track, sector);
  return img.subarray(off, off + 256);
}

// Read full data chain starting at (track, sector)
function readChain(img, track, sector, trackCount = 35) {
  const chunks = [];
  const seen = new Set();
  while (track !== 0) {
    // A link off the disk, or back into the chain already read, means a damaged
    // (or deliberately looping) file. Without the visited set a self-linking
    // sector comes back as a quarter-megabyte of the same block.
    if (track < 1 || track > trackCount) break;
    if (sector < 0 || sector >= (SPT[track] || 0)) break;
    const key = (track << 8) | sector;
    if (seen.has(key)) break;
    seen.add(key);
    const s = readSec(img, track, sector);
    const nxt = s[0], nxs = s[1];
    if (nxt === 0) {
      // Last sector: s[1] = index of last valid byte (1-based from data start)
      chunks.push(s.slice(2, nxs + 1));
    } else {
      chunks.push(s.slice(2, 256));
    }
    track = nxt; sector = nxs;
  }
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out;
}

// PETSCII name → JS string, preserving byte values so the string can be fed
// back to the C64 (e.g. in buildDirectoryPRG/loadFile) and render as the
// correct glyphs. Directory names are byte strings: demos sometimes use low
// and high control codes as visible LIST art or as exact load names.
// PETSCII $41–$5A are uppercase A–Z in uppercase/graphics mode — leave them be.
//
// Trailing shift-space ($A0) is DOS's padding and goes. One in the MIDDLE is a
// character like any other — art uses it as a blank a real space can't be — so
// cutting there would lose the rest of the name, in the listing and in matching.
function petName(bytes, start, len) {
  let end = len;
  while (end > 0 && bytes[start + end - 1] === 0xA0) end--;
  let s = '';
  for (let i = 0; i < end; i++) s += String.fromCharCode(bytes[start + i] & 0xFF);
  return s;
}

const FILE_TYPES = ['DEL','SEQ','PRG','USR','REL','???','???','???'];

// ── CBM DOS name matching ────────────────────────────────────────────────────
// Pattern vs the 16-byte name, both padded in shift-space: '*' matches
// everything from there on (the rest of the pattern is ignored), '?' any single
// byte. So "AL" doesn't find "ALPHA" but "AL*" does.
//
// Only a–z folds case: PETSCII's shifted range ($C1–$DA) is the graphics
// characters art is drawn with, and folding those would make two different
// pieces of art match each other.
const foldCase = (b) => (b >= 0x61 && b <= 0x7A) ? b - 0x20 : b;

function matchDirName(name, pattern) {
  for (let i = 0; i < 16; i++) {
    const p = i < pattern.length ? pattern.charCodeAt(i) & 0xFF : 0xA0;
    if (p === 0x2A) return true;                        // '*'
    if (p === 0x3F) continue;                           // '?'
    const n = i < name.length ? name.charCodeAt(i) & 0xFF : 0xA0;
    if (foldCase(p) !== foldCase(n)) return false;
  }
  return true;
}

// What DOS strips before matching: a leading drive number ("0:") and a trailing
// type/mode field (",P", ",S,R"). A comma elsewhere is left alone, so art names
// containing one still match themselves.
function dosPattern(name) {
  let s = String(name ?? '');
  const colon = s.indexOf(':');
  if (colon === 0 || (colon === 1 && s[0] >= '0' && s[0] <= '9')) s = s.slice(colon + 1);
  return s.replace(/,[PSURL](?:,[RWAM])?$/i, '').replace(/,[RWAM]$/i, '');
}

// Where each 40-track DOS variant keeps the BAM entries for tracks 36-40: the
// standard BAM stops at 35, so each picked a spot in the tail of 18/0 —
// PrologicDOS on top of the disk name.
const BAM_EXTENSIONS = [0xAC /* DolphinDOS */, 0xC0 /* SpeedDOS */, 0x90 /* PrologicDOS */];

const popcount = (b) => { let n = 0; while (b) { n += b & 1; b >>= 1; } return n; };

function hasReadableNameText(name) {
  let n = 0;
  for (let i = 0; i < name.length; i++) {
    const b = name.charCodeAt(i) & 0xFF;
    if ((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A)) n++;
  }
  return n >= 2;
}

export class D64 {
  /**
   * @param {Uint8Array|ArrayBuffer} data
   */
  constructor(data) {
    this.img     = data instanceof Uint8Array ? data : new Uint8Array(data);
    // Variant from the byte length (see IMAGE_VARIANTS); the error table, when
    // present, sits after the data region. An unknown length is taken for a
    // 35-track disk so synthetic buffers and test doubles still work — callers
    // handling a user's file check d64Variant() first.
    const variant     = d64Variant(this.img.length);
    this.trackCount   = variant ? variant.tracks : 35;
    this.hasErrorInfo = !!variant?.errorInfo;
    this._errorBase   = variant?.errorInfo ? variant.sectors * 256 : 0;
    this._bamExt      = 0; // offset of the tracks 36-40 BAM entries; 0 = none
    this.entries = [];     // directory entries
    this.diskName = '';
    this.diskId   = '';
    this.dosType  = '';
    this.freeBlocks = 0;
    // Write support. `dirty` = the image has unsaved changes vs its persisted
    // copy (drives the UI marker + Library auto-save). `writeProtected` is a
    // session attribute — it is NOT stored in the .d64 (real hardware senses a
    // physical notch on VIA2 PB4); mounted images default protected, freshly
    // created ones default write-enabled (see createBlankD64).
    this.dirty = false;
    this.writeProtected = true;
    // UI hint only: custom loader disks can have valid directory entries whose
    // names are all PETSCII controls/art rather than human-readable text.
    this.hasReadableDirectoryNames = false;
    this._parse();
  }

  _parse() {
    // BAM: track 18, sector 0
    const bam = readSec(this.img, 18, 0);

    // A GEOS disk says so at BAM $AD. Needed before anything is displayed: GEOS
    // writes names in ASCII (its own fonts draw them), not PETSCII, and its USR
    // files are VLIR record structures rather than programs.
    this.isGEOS = 'GEOS format'.split('').every((c, i) => bam[0xAD + i] === c.charCodeAt(0));

    // Disk name (bytes $90–$9F, 16 chars)
    this.diskName = petName(bam, 0x90, 16);
    // Disk ID ($A2–$A3), DOS type ($A5–$A6)
    this.diskId  = petName(bam, 0xA2, 2);
    this.dosType = petName(bam, 0xA5, 2);

    // Free block count from BAM entries (4 bytes each: free-count, bitmask×3).
    // Tracks past 35 count only when this image carries a BAM extension that
    // describes them — see _detectBamExtension.
    this._bamExt = this._detectBamExtension(bam);
    let free = 0;
    for (let t = 1; t <= this.trackCount; t++) {
      if (t === 18) continue;           // directory track not counted
      const off = this._bamOffset(t);
      if (off >= 0) free += bam[off];
    }
    this.freeBlocks = free;

    // Directory: chain from track 18, sector 1
    let dt = 18, ds = 1;
    let safety = 0;
    this.entries = [];
    while (dt !== 0 && safety++ < 100) {
      const sec = readSec(this.img, dt, ds);
      dt = sec[0]; ds = sec[1];
      for (let e = 0; e < 8; e++) {
        const b = e * 32;
        const raw = sec[b + 2];
        const typeCode = raw & 0x07;
        // A never-used slot is all-zero. A SCRATCHED file also has a $00
        // file-type byte (per the spec, "scratched" and "empty" are
        // indistinguishable by that byte alone) — but scratching zeroes only
        // the type byte, leaving the filename + start track/sector intact until
        // the slot is reused. Surface those as recoverable DEL entries; skip
        // only the truly empty slots (no filename, no start track).
        if (raw === 0 && sec[b + 5] === 0 && sec[b + 3] === 0) continue;
        this.entries.push({
          name:        petName(sec, b + 5, 16),
          type:        FILE_TYPES[typeCode],
          typeCode,
          deleted:     typeCode === 0,          // DEL: scratched, data not yet overwritten
          locked:      !!(raw & 0x40),
          closed:      !!(raw & 0x80),
          startTrack:  sec[b + 3],
          startSector: sec[b + 4],
          blocks:      sec[b + 30] | (sec[b + 31] << 8),
        });
      }
    }
    this.hasReadableDirectoryNames = this.entries.some((e) => hasReadableNameText(e.name));
  }

  /** Raw 256-byte sector for (track, sector); null if out of range. A track past
   *  the end of this image reads as nothing rather than as an empty sector — the
   *  head can step out to track 42 whatever the image holds, and a 35-track disk
   *  has no more recorded there than a real one does. */
  readSector(track, sector) {
    if (track < 1 || track > this.trackCount) return null;
    const count = SPT[track] || 0;
    if (sector < 0 || sector >= count) return null;
    return readSec(this.img, track, sector);
  }

  /**
   * The error table's code for (track, sector), in the format's own 1-based
   * numbering: 1 = none, 2 = DOS 20 (no header), 3 = 21 (no sync), 4 = 22 (no
   * data block), 5 = 23 (data checksum), 9 = 27 (header checksum), 11 = 29 (disk
   * ID). Images without a table read as 1 throughout.
   */
  errorForSector(track, sector) {
    if (!this._errorBase) return 1;
    if (track < 1 || track > this.trackCount) return 1;
    if (sector < 0 || sector >= (SPT[track] || 0)) return 1;
    // 0 isn't in the numbering; tools that leave the table zeroed mean "fine".
    return this.img[this._errorBase + sectorIndex(track, sector)] || 1;
  }

  /**
   * Overwrite a 256-byte sector in the image (the substrate for write support).
   * Copies into the live `img` view via the same offset machinery reads use, and
   * marks the image dirty. Returns false (no-op) if (track, sector) is out of
   * range for this image. Bytes shorter than 256 leave the tail untouched.
   * @param {number} track @param {number} sector @param {Uint8Array} bytes
   */
  writeSector(track, sector, bytes) {
    if (track < 1 || track > this.trackCount) return false;
    const count = SPT[track] || 0;
    if (sector < 0 || sector >= count) return false;
    readSec(this.img, track, sector).set(bytes.subarray(0, 256));
    // A just-written sector is readable by definition, so drop any error recorded
    // for it — left in place it would revive when the export is re-mounted.
    if (this._errorBase) this.img[this._errorBase + sectorIndex(track, sector)] = 1;
    this.dirty = true;
    return true;
  }

  /**
   * The BAM extension offset of a 40-track image, or 0 for none. Nothing says
   * which DOS wrote it, so go by shape: five 4-byte entries whose free count
   * matches their 17-sector bitmap, no bits above sector 16, at least one track
   * with room. A disk name fails that (a PETSCII byte is a count far above 17)
   * and so does a 35-track BAM's unused tail — leaving "not described", which is
   * what keeps writes off tracks nothing is recording allocation for.
   */
  _detectBamExtension(bam) {
    if (this.trackCount < 40) return 0;
    for (const base of BAM_EXTENSIONS) {
      let ok = true, anyFree = false;
      for (let t = 36; t <= 40 && ok; t++) {
        const e = base + (t - 36) * 4;
        const free = bam[e];
        const bits = popcount(bam[e + 1]) + popcount(bam[e + 2]) + popcount(bam[e + 3] & 0x01);
        if (free > 17 || free !== bits || (bam[e + 3] & 0xFE) !== 0) ok = false;
        if (free > 0) anyFree = true;
      }
      if (ok && anyFree) return base;
    }
    return 0;
  }

  /**
   * Offset of track `track`'s 4-byte BAM entry, or -1 when this BAM doesn't
   * describe it (the standard table covers 1-35; beyond that needs the extension).
   * The -1 is the point: the arithmetic for track 36 lands on $90, the disk name,
   * so a caller allocating there would rename the disk.
   */
  _bamOffset(track) {
    if (track >= 1 && track <= 35) return 4 + (track - 1) * 4;
    if (this._bamExt && track >= 36 && track <= 40) return this._bamExt + (track - 36) * 4;
    return -1;
  }

  /** Is (track, sector) still free in the BAM? `bam` is the live 18/0 view. */
  _bamIsFree(bam, track, sector) {
    const off = this._bamOffset(track);
    if (off < 0) return false;
    return !!(bam[off + 1 + (sector >> 3)] & (1 << (sector & 7)));
  }

  /** Mark (track, sector) allocated: clear its bit, drop the track's free count. */
  _bamTake(bam, track, sector) {
    const off = this._bamOffset(track);
    if (off < 0) return;
    bam[off + 1 + (sector >> 3)] &= ~(1 << (sector & 7));
    if (bam[off] > 0) bam[off]--;
  }

  /**
   * Hand (track, sector) back: set its bit, restore the track's free count. The
   * inverse of _bamTake, and idempotent — a block already free is left alone, so
   * the count can't drift above what the track holds.
   */
  _bamFree(bam, track, sector) {
    const off = this._bamOffset(track);
    if (off < 0) return;
    const byte = off + 1 + (sector >> 3), bit = 1 << (sector & 7);
    if (bam[byte] & bit) return;             // already free
    bam[byte] |= bit;
    bam[off]++;
  }

  /**
   * Claim `count` free blocks and return them as [track, sector] pairs in chain
   * order, or null if the disk hasn't room. Follows the DOS habit of filling
   * outwards from the directory track and stepping 10 sectors at a time, so the
   * layout looks like something a 1541 would have produced.
   */
  _allocateBlocks(count) {
    const bam = readSec(this.img, 18, 0);
    const tracks = [];
    for (let t = 17; t >= 1; t--) tracks.push(t);
    for (let t = 19; t <= this.trackCount; t++) tracks.push(t);
    // Only tracks the BAM actually describes (see _bamOffset).
    const usable = tracks.filter((t) => this._bamOffset(t) >= 0);

    const got = [];
    for (const t of usable) {
      const n = SPT[t] || 0;
      const seen = new Set();
      let s = 0;
      for (let k = 0; k < n && got.length < count; k++) {
        while (seen.has(s)) s = (s + 1) % n;
        seen.add(s);
        if (this._bamIsFree(bam, t, s)) { this._bamTake(bam, t, s); got.push([t, s]); }
        s = (s + 10) % n;
      }
      if (got.length >= count) break;
    }
    if (got.length === count) return got;
    // Not enough room. readSec hands out a live view of the image, so every block
    // found above is already marked allocated — return them, or a write that
    // reports "didn't fit" silently swallows whatever free space was left. The
    // caller's next attempt would then find a disk that looks full.
    for (const [t, s] of got) this._bamFree(bam, t, s);
    return null;
  }

  /**
   * Point a directory slot at a file. Reuses the first free slot in the chain
   * and extends the chain with a fresh track-18 sector when all are taken.
   */
  _addDirEntry(name, track, sector, blocks) {
    const nm = String(name).slice(0, 16);
    let dt = 18, ds = 1, guard = 0;
    for (;;) {
      const sec = readSec(this.img, dt, ds);
      for (let e = 0; e < 8; e++) {
        const b = e * 32;
        if (!(sec[b + 2] === 0 && sec[b + 3] === 0 && sec[b + 5] === 0)) continue;
        sec[b + 2] = 0x82;                       // closed PRG
        sec[b + 3] = track; sec[b + 4] = sector;
        for (let i = 0; i < 16; i++) sec[b + 5 + i] = 0xA0;
        for (let i = 0; i < nm.length; i++) sec[b + 5 + i] = nm.charCodeAt(i) & 0xFF;
        sec[b + 30] = blocks & 0xFF;
        sec[b + 31] = (blocks >> 8) & 0xFF;
        this.dirty = true;
        return true;
      }
      if (sec[0] !== 0) { dt = sec[0]; ds = sec[1]; if (guard++ > 40) return false; continue; }
      // Chain full — hang one more directory sector off track 18.
      const bam = readSec(this.img, 18, 0);
      let next = null;
      for (let s = 0; s < SPT[18]; s++) {
        if (this._bamIsFree(bam, 18, s)) { this._bamTake(bam, 18, s); next = s; break; }
      }
      if (next === null) return false;
      sec[0] = 18; sec[1] = next;
      const fresh = readSec(this.img, 18, next);
      fresh.fill(0);
      fresh[0] = 0; fresh[1] = 0xFF;
      dt = 18; ds = next;
      if (guard++ > 40) return false;
    }
  }

  /**
   * Write a PRG (2-byte load address followed by its data — a .prg file exactly
   * as it comes) into the image as a closed PRG file, allocating blocks and
   * adding the directory entry. Returns the block count, or 0 if it won't fit.
   * The result is an ordinary disk file: LOAD, the directory listing and export
   * all treat it like any other.
   */
  writePRG(name, bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (data.length < 2) return 0;
    const chain = this._allocateBlocks(Math.ceil(data.length / 254));
    if (!chain) return 0;

    for (let i = 0; i < chain.length; i++) {
      const sec = new Uint8Array(256);
      const chunk = data.subarray(i * 254, i * 254 + 254);
      sec.set(chunk, 2);
      if (i + 1 < chain.length) { sec[0] = chain[i + 1][0]; sec[1] = chain[i + 1][1]; }
      else { sec[0] = 0; sec[1] = chunk.length + 1; }   // last byte index, per readChain
      this.writeSector(chain[i][0], chain[i][1], sec);
    }
    if (!this._addDirEntry(name, chain[0][0], chain[0][1], chain.length)) {
      // Directory full — track 18 holds at most 18 directory sectors, so 144
      // files. The chain is allocated and written but now unreachable, so give the
      // blocks back and leave the disk as it was. Their contents stay behind,
      // which is harmless: a free block's bytes mean nothing until it is reused.
      const bam = readSec(this.img, 18, 0);
      for (const [t, s] of chain) this._bamFree(bam, t, s);
      return 0;
    }

    this._parse();          // refresh entries + free-block count
    this.dirty = true;
    return chain.length;
  }

  /**
   * Load file bytes by name, the way DOS resolves one: '*' and '?' wildcards, a
   * "0:" drive prefix and a ",P"/",S,R" type-and-mode suffix all understood (see
   * matchDirName / dosPattern). Returns raw chain bytes — for PRG files the
   * first 2 bytes are the load address. Any file type resolves; DOS reserves
   * LOAD for everything except REL, and a program stored as USR is a habit as
   * old as the disks themselves.
   * @param {string} name
   * @returns {Uint8Array|null}
   */
  loadFile(name) {
    const pattern = dosPattern(name);
    // Scratched/DEL entries aren't matched by LOAD.
    const entry = this.entries.find(e => !e.deleted && matchDirName(e.name, pattern));
    if (!entry || entry.startTrack === 0) return null;
    return readChain(this.img, entry.startTrack, entry.startSector, this.trackCount);
  }

  /**
   * Scratch every file matching `name`, the way the DOS `S0:name` command does:
   * clear each directory entry's file-type byte and give its blocks back to the
   * BAM. The name accepts the same '*'/'?' wildcards and "0:" prefix LOAD does.
   * @param {string} name
   * @returns {{ scratched: string[], blocks: number }}
   */
  scratch(name) {
    const pattern = dosPattern(name);
    const scratched = [];
    let blocks = 0;
    // Walk the directory sectors, matching entries and clearing them in place —
    // readSec hands back a view into the image, so the edits land in the file.
    let dt = 18, ds = 1, guard = 0;
    while (dt !== 0 && guard++ < 100) {
      const sec = readSec(this.img, dt, ds);
      for (let e = 0; e < 8; e++) {
        const b = e * 32;
        if ((sec[b + 2] & 0x07) === 0) continue;          // empty or already scratched
        const nm = petName(sec, b + 5, 16);
        if (!matchDirName(nm, pattern)) continue;
        // Give the file's chain back to the BAM, reading each link before it is
        // freed, and stopping on a link that leaves the disk or loops.
        const bam = readSec(this.img, 18, 0);
        let t = sec[b + 3], s = sec[b + 4];
        const seen = new Set();
        while (t >= 1 && t <= this.trackCount) {
          const key = (t << 8) | s;
          if (seen.has(key)) break;
          seen.add(key);
          const link = readSec(this.img, t, s);
          this._bamFree(bam, t, s);
          blocks++;
          t = link[0]; s = link[1];
        }
        sec[b + 2] = 0;                                    // scratched: type byte cleared
        scratched.push(nm.trim());
      }
      dt = sec[0]; ds = sec[1];
    }
    if (scratched.length) { this._parse(); this.dirty = true; }
    return { scratched, blocks };
  }

  /**
   * Synthesise the directory as a BASIC program (for LOAD "$",8).
   * Returns Uint8Array starting with the 2-byte PRG load address ($01 $08).
   * @param {string} [pattern] what followed the '$' — LOAD"$:A*" lists only the
   *   entries that match, exactly as DOS does. Empty lists everything.
   */
  buildDirectoryPRG(pattern = '') {
    const BASIC_START = 0x0801;
    const filter = dosPattern(pattern);
    // Build text lines
    const rawLines = [];

    // Header: reverse-video disk title
    const title = this.diskName.padEnd(16, '\xA0').slice(0, 16);
    rawLines.push({ num: 0,  text: `\x12"${title}" ${this.diskId} ${this.dosType}` });

    for (const e of this.entries) {
      if (e.deleted) continue;   // LOAD"$" omits scratched entries, matching real DOS
      if (filter && !matchDirName(e.name, filter)) continue;
      // LIST prints the line number (= block count) for us; the text just needs
      // leading pad to align filenames into a column, then the quoted name in a
      // 16-wide field, then the type. A file left open by an interrupted SAVE
      // takes a '*' in the column before its type — the splat that tells you to
      // validate the disk rather than trust the file.
      const pad    = e.blocks < 10 ? '   ' : e.blocks < 100 ? '  ' : e.blocks < 1000 ? ' ' : '';
      const gap    = ' '.repeat(Math.max(0, 16 - e.name.length));
      const splat  = e.closed ? ' ' : '*';
      const locked = e.locked ? '<' : ' ';
      rawLines.push({ num: e.blocks, text: `${pad}"${e.name}"${gap}${splat}${e.type}${locked}` });
    }
    rawLines.push({ num: this.freeBlocks, text: `BLOCKS FREE.` });

    // Encode as BASIC in-memory format
    // Each line: [next_lo, next_hi, num_lo, num_hi, ...text bytes..., 0x00]
    const lineBytes = rawLines.map(l => {
      const tb = [];
      for (let i = 0; i < l.text.length; i++) tb.push(l.text.charCodeAt(i) & 0xFF);
      tb.push(0x00);
      return { num: l.num, tb };
    });

    // Compute byte length: 2 (prg hdr) + lines + 2 (prog end)
    const lineLen = lineBytes.map(l => 4 + l.tb.length);
    const total   = 2 + lineLen.reduce((a, b) => a + b, 0) + 2;
    const out     = new Uint8Array(total);
    out[0] = BASIC_START & 0xFF;
    out[1] = (BASIC_START >> 8) & 0xFF;

    let addr = BASIC_START;
    let off  = 2;
    for (let i = 0; i < lineBytes.length; i++) {
      const nextAddr = addr + lineLen[i];
      out[off++] = nextAddr & 0xFF;
      out[off++] = (nextAddr >> 8) & 0xFF;
      out[off++] = lineBytes[i].num & 0xFF;
      out[off++] = (lineBytes[i].num >> 8) & 0xFF;
      for (const b of lineBytes[i].tb) out[off++] = b;
      addr = nextAddr;
    }
    out[off++] = 0x00;
    out[off++] = 0x00;
    return out;
  }
}

/**
 * Build a fresh, empty *formatted* 35-track disk image and return it as a D64.
 * Used by the UI "NEW" and "FORMAT" actions — no drive/DOS involvement, so it is
 * instant and reliable. Lays down a standard BAM (track 18/0) with every data
 * sector free except the two the directory itself uses, and an empty directory
 * (track 18/1). The result parses to an empty disk showing "664 BLOCKS FREE".
 * The returned disk is write-enabled and dirty (freshly created, never saved).
 * @param {string} name  disk header name (PETSCII, ≤16 chars)
 * @param {string} id    2-char disk ID
 * @returns {D64}
 */
export function createBlankD64(name = '', id = '00') {
  const img = new Uint8Array(174848);           // 683 sectors × 256, 35-track
  const bam = sectorOffset(18, 0);

  // BAM header: first directory sector link + DOS version byte.
  img[bam + 0x00] = 18;    // first directory track
  img[bam + 0x01] = 1;     // first directory sector
  img[bam + 0x02] = 0x41;  // DOS version 'A'
  img[bam + 0x03] = 0x00;

  // Per-track allocation: [free-count, 3-byte sector bitmap] (bit set = free).
  // All data sectors free; track 18 reserves sectors 0 (BAM) and 1 (dir).
  for (let t = 1; t <= 35; t++) {
    const n = SPT[t];
    const used = t === 18 ? [0, 1] : [];
    let free = 0, b0 = 0, b1 = 0, b2 = 0;
    for (let s = 0; s < n; s++) {
      if (used.includes(s)) continue;
      free++;
      if (s < 8) b0 |= 1 << s;
      else if (s < 16) b1 |= 1 << (s - 8);
      else b2 |= 1 << (s - 16);
    }
    const off = bam + 4 + (t - 1) * 4;
    img[off] = free; img[off + 1] = b0; img[off + 2] = b1; img[off + 3] = b2;
  }

  // Disk name ($90–$9F, shift-space padded), ID ($A2–$A3), DOS type "2A".
  for (let i = 0; i < 16; i++) img[bam + 0x90 + i] = 0xA0;
  const nm = String(name).slice(0, 16);
  for (let i = 0; i < nm.length; i++) img[bam + 0x90 + i] = nm.charCodeAt(i) & 0xFF;
  const idStr = String(id).padEnd(2, ' ').slice(0, 2);
  img[bam + 0xA0] = 0xA0; img[bam + 0xA1] = 0xA0;
  img[bam + 0xA2] = idStr.charCodeAt(0) & 0xFF;
  img[bam + 0xA3] = idStr.charCodeAt(1) & 0xFF;
  img[bam + 0xA4] = 0xA0;
  img[bam + 0xA5] = 0x32; img[bam + 0xA6] = 0x41;  // "2A"
  img[bam + 0xA7] = 0xA0; img[bam + 0xA8] = 0xA0;
  img[bam + 0xA9] = 0xA0; img[bam + 0xAA] = 0xA0;

  // Empty directory sector (track 18/1): no next sector, no entries.
  const dir = sectorOffset(18, 1);
  img[dir + 0x00] = 0x00;  // next dir track = 0 (end of chain)
  img[dir + 0x01] = 0xFF;  // last used byte in sector

  const disk = new D64(img);
  disk.writeProtected = false;  // a disk you just created is meant to be written
  disk.dirty = true;            // never persisted yet
  return disk;
}

/**
 * PETSCII-safe 1541 filename from a host filename. Drops the extension and the
 * release-year / group parentheticals that collections tend to carry, upper
 * cases the rest, folds anything the C64 can't type in a LOAD name to a dot,
 * and clamps to the 16 characters a directory entry holds.
 * @param {string} filename  e.g. "Commando (1985).prg"
 * @returns {string}         e.g. "COMMANDO"
 */
export function diskNameFromFilename(filename) {
  const base = String(filename || '')
    .replace(/\.[^.]*$/, '')          // extension
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ')  // (1985), [side a], {crack}
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  let out = '';
  for (const ch of base) {
    out += /[A-Z0-9 +\-]/.test(ch) ? ch : '.';
    if (out.length >= 16) break;
  }
  out = out.trim();
  // A name with nothing readable left in it (all punctuation folded to dots) is
  // no use to anyone reading it off the screen — give it a name they can type.
  return /[A-Z0-9]/.test(out) ? out : 'PROGRAM';
}

/**
 * How a .prg should be started once it is in memory — or whether we should even
 * try. A BASIC program begins with a line header: a two-byte pointer to the next
 * line, then the line number, then tokens ending in $00. That pointer has to
 * land inside the program itself, which machine code sitting at $0801 fails, and
 * anything loading elsewhere fails by definition.
 *
 * Returns 'RUN\r' when it is BASIC, and null when it is not. Null on purpose: a
 * .prg carries its entry point in exactly one place, the BASIC stub's own
 * SYS — and when that exists, RUN executes it with the author's address. For
 * stubless machine code nothing in the file says where to jump. The load address
 * is only a convention, so rather than guess and land in a data table, the
 * program is left in memory at READY for the user to SYS.
 * @param {Uint8Array} bytes  .prg content, load address first
 * @returns {string|null} the line to type, or null to start nothing
 */
export function prgAutostart(bytes) {
  const addr = bytes[0] | (bytes[1] << 8);
  if (addr !== 0x0801 || bytes.length < 8) return null;
  const link = bytes[2] | (bytes[3] << 8);
  const end = addr + bytes.length - 2;
  if (link <= addr + 4 || link > end) return null;     // pointer must reach a later line
  const lineNo = bytes[4] | (bytes[5] << 8);
  if (lineNo > 63999) return null;                     // BASIC's highest line number
  return 'RUN\r';
}

/**
 * Does a .prg claim to load past the top of memory? Returns null when it fits,
 * else { addr, end, short } describing why not — `short` for a file with no room
 * for a load address at all.
 *
 * A .prg is only NOMINALLY bounded by the 6502's address space; nothing stops a
 * renamed archive, or one with junk appended, from reaching a loader. Both onward
 * paths then half-succeed instead of failing: wrapping it needs more than the 664
 * blocks a D64 holds, and loading it into RAM has its writes past $FFFF silently
 * dropped by the Uint8Array while BASIC's pointers are still set from an address
 * that wrapped. Callers check first and refuse with a reason.
 * @param {Uint8Array} data .prg content (2-byte load address first)
 */
export function prgOverflow(data) {
  if (!data || data.length < 2) return { addr: 0, end: 0, short: true };
  const addr = data[0] | (data[1] << 8);
  const end = addr + (data.length - 2);
  return end > 0x10000 ? { addr, end, short: false } : null;
}

/**
 * Wrap a .prg in its own freshly formatted disk, so a PRG can be loaded through
 * exactly the same path as any other disk — a real LOAD by name, a real
 * directory, exportable. Returns null if the program won't fit.
 * @param {string} filename  host filename, used for the disk header + file name
 * @param {Uint8Array} bytes .prg content (2-byte load address first)
 */
export function createPRGDisk(filename, bytes) {
  const name = diskNameFromFilename(filename);
  const disk = createBlankD64(name, '01');
  if (!disk.writePRG(name, bytes)) return null;
  // Write-protected, like the original of anything worth keeping: the program is
  // the whole point of this disk and a running program has no business
  // overwriting it. Flip the notch in the drive UI to SAVE onto it. Clean, too —
  // it was built to match the .prg, so there is nothing unsaved about it.
  disk.writeProtected = true;
  disk.dirty = false;
  return disk;
}
