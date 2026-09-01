// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/tap-directory.js — what is on a tape, read the way a C64 reads it.
//
// A .tap has no directory: it is a bare pulse stream, and the only way to know
// what it holds is to decode it as the KERNAL would and pick out the header
// blocks. So that is what this does — classify each pulse, assemble bit pairs
// into bytes, find a block's sync countdown, and read the 192-byte header that
// follows.
//
// The encoding, per the documented CBM tape format:
//   pulse widths      short $30, medium $42, long $56 units, thresholds $39/$4E
//   bit pairs         0 = short/medium, 1 = medium/short
//   byte marker       long/medium; end of data long/short
//   byte frame        marker, 8 bits LSB first, then an odd parity bit
//   block sync        $89…$81 counts down the first copy, $09…$01 the repeat
//   header block      192 bytes: type, start lo/hi, end lo/hi, 16-byte name
//   header type       1 relocatable, 3 absolute — which decides whether those
//                     addresses are where the file lands or only where it was
//                     saved from
//
// Turbo tapes are not this format — each loader invents its own — so those are
// described one by one in src/tap-turbo-formats.js and asked in turn. A tape can
// hold both kinds; the listing is whatever each recogniser finds, in tape order.

const UNIT = 8;                       // a TAP unit is 8 cycles
const PAL_CPU_HZ = 985248;
// A v0 `0` byte says only "longer than a byte can hold". The deck settles on one
// value and everything that reads a tape uses the same one, or the listing, the
// speaker and the head disagree about how long a tape is.
const V0_ZERO_GAP_CYCLES = 2048;
const SHORT_MAX = 0x39 * UNIT;        // 456
const MEDIUM_MAX = 0x4E * UNIT;       // 624
const S = 0, M = 1, L = 2;

const HEADER_BYTES = 192;
const NAME_AT = 5, NAME_LEN = 16;

// Where a file starts is not where its block starts: every block is preceded by
// a lead-in the loader needs to hear before it can read anything, and a KERNAL
// one is seconds of it. Measured here: starting two seconds before the block was
// not enough — the KERNAL searched past the file and never found it — while
// starting at the head of the lead-in reads it every time.
const GAP_CYCLES = 2000;              // longer than this is silence, not signal
const LEAD_MAX_CYCLES = 8 * PAL_CPU_HZ;   // never wind back further than this

// Header types. 2 is a data block rather than a header, and 5 marks the end of
// the tape; neither names a file.
//
// 1 and 3 are both programs and both list as PRG, but they do not load to the
// same place. A type 3 lands at the address in its header. A type 1 is
// relocatable: a plain LOAD puts it at the BASIC start and its header addresses
// say only where it was saved from. The two coincide for an ordinary BASIC
// program and part company for the ones worth knowing about — a loader stub
// saved out of high memory, which is where the tape loaders live. Measured on
// the real ROM: a type 1 saved from $CC49 loads to $0801 under LOAD and to
// $CC49 under LOAD"",1,1, while a type 3 goes to $CC49 either way.
//
// So `start` and `end` are the header's, as the tape states them, and
// `relocatable` is what a caller needs to know whether they are the whole story.
const TYPES = { 1: 'PRG', 3: 'PRG', 4: 'SEQ' };
const RELOCATABLE = 1;

import { TURBO_FORMATS, turboTape64Files, turboTape64Widths, TT_NOMINAL,
         novaloadWidths, NOVA_NOMINAL } from './tap-turbo-formats.js';

const classify = cycles => (cycles < SHORT_MAX ? S : cycles < MEDIUM_MAX ? M : L);

/** Pulse lengths in cycles, from the raw .tap data (no 20-byte file header). */
function pulseCycles(data, version, zeroGapCycles) {
  const out = [];
  for (let p = 0; p < data.length;) {
    const b = data[p++];
    if (b !== 0) { out.push(b * UNIT); continue; }
    if (version === 0) { out.push(zeroGapCycles); continue; }
    if (p + 2 >= data.length) break;
    out.push(data[p++] | (data[p++] << 8) | (data[p++] << 16));
  }
  return out;
}

/**
 * Read the tape as a stream of bytes, resyncing on every byte marker — which is
 * what makes this work across the leaders, gaps and repeats between blocks.
 * @returns {Array<number>} one entry per decoded byte
 */
function decodeBytes(pulses) {
  const out = [];
  out.pulseOf = [];      // where each byte started, for ordering against turbo finds
  out.endsAt = [];       // byte counts at which a block's framing closed
  let i = 0;
  while (i + 1 < pulses.length) {
    if (classify(pulses[i]) !== L || classify(pulses[i + 1]) !== M) { i++; continue; }
    i += 2;
    let value = 0, ones = 0, ok = true;
    for (let bit = 0; bit < 8; bit++) {
      if (i + 1 >= pulses.length) { ok = false; break; }
      const a = classify(pulses[i]), b = classify(pulses[i + 1]);
      if (a === S && b === M) { i += 2; }
      else if (a === M && b === S) { value |= 1 << bit; ones++; i += 2; }
      else { ok = false; break; }
    }
    if (!ok) continue;                       // not a byte after all — resync
    const startedAt = i;
    // Odd parity closes the frame. A wrong pair here means the frame was noise,
    // so drop it rather than trust the byte.
    if (i + 1 < pulses.length) {
      const a = classify(pulses[i]), b = classify(pulses[i + 1]);
      const parity = (a === M && b === S) ? 1 : (a === S && b === M) ? 0 : -1;
      if (parity < 0) continue;
      i += 2;
      if (((ones + parity) & 1) === 0) continue;
    }
    out.push(value);
    out.pulseOf.push(startedAt);
    // A long pulse followed by a short one closes a block. Knowing where that
    // falls is what lets a block be checked the way the KERNAL checks it —
    // against its own end, not against the length its header claims.
    if (i + 1 < pulses.length && classify(pulses[i]) === L && classify(pulses[i + 1]) === S) {
      out.endsAt.push(out.length);
    }
  }
  return out;
}

/** The 16-byte name as the rest of the UI expects it: PETSCII, trailing pad off. */
function headerName(block) {
  let end = NAME_LEN;
  while (end > 0) {
    const c = block[NAME_AT + end - 1];
    if (c !== 0x20 && c !== 0xA0 && c !== undefined) break;
    end--;
  }
  // Control codes are part of the name on the tape but not part of reading it:
  // they set a colour or clear the screen while LOAD prints. Dropped here so a
  // listing shows the name rather than the punctuation around it.
  let s = '';
  for (let i = 0; i < end; i++) {
    const c = block[NAME_AT + i] & 0xFF;
    if (c < 0x20 || c === 0x7F || (c >= 0x80 && c <= 0x9F)) continue;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

/**
 * The files on a tape, CBM and turbo alike.
 * @param {Uint8Array} tapData  pulse bytes, the 20-byte file header stripped
 * @param {object} opts  version / zeroGapCycles, as the datasette reports them
 * @returns {Array<{name, type, start, end, size, format, relocatable}>} in tape
 *   order. `start`/`end` are what the tape's header states; see TYPES on why
 *   `relocatable` decides whether they are also where the file lands.
 */
/**
 * What can be said about the tape itself rather than its files: which formats it
 * carries, and how far off speed the deck that wrote it was running.
 *
 * The speed is measured, not guessed: a turbo block's two widths are known
 * figures, so the ratio between what this tape holds and what the format
 * specifies is the deck's error. It matters because it is the difference between
 * a tape that reads and one that does not, and because a person looking at a
 * listing full of struck-through rows deserves to know whether the fault is the
 * oxide or the machine that recorded it.
 */
export function tapeFacts(tapData, { version = 1, zeroGapCycles = V0_ZERO_GAP_CYCLES } = {}) {
  if (!tapData || !tapData.length) return { formats: [], files: 0, sound: 0 };
  const pulses = pulseCycles(tapData, version, zeroGapCycles);
  const files = tapDirectoryOfPulses(pulses);
  const formats = [...new Set(files.map(f => f.format))];

  // Both symbols move together, so either ratio would do; the mean of the two is
  // steadier against one cluster being thinly populated. Measured on files that
  // add up, so a damaged one cannot drag the reading.
  const error = (w, nominal) => {
    const ratio = (w.zero / nominal.zero + w.one / nominal.one) / 2;
    return { ratio, percent: Math.round((ratio - 1) * 1000) / 10 };
  };
  let speed = null;
  const turbo = turboTape64Files(pulses);
  if (turbo.some(f => f.data && f.data.checksumOk)) {
    speed = error(turboTape64Widths(pulses, turbo), TT_NOMINAL);
  } else {
    const nova = files.filter(f => f.format === 'Novaload' && !f.damage);
    if (nova.length) speed = error(novaloadWidths(pulses, nova), NOVA_NOMINAL);
  }
  return {
    formats,
    files: files.length,
    sound: files.filter(f => !f.damaged).length,
    speed,
    unread: unreadSeconds(pulses, files),
  };
}

/**
 * How much of the tape carries a signal that nothing here could read. Programs
 * on a tape are separated by silence, so a stretch of unbroken signal holding no
 * listed file is a program written by a loader this does not know — and saying
 * so is the difference between a listing that looks finished and one that admits
 * what it missed. A tape whose middle is a loader nobody has taught this reads
 * as three files and twelve unaccounted minutes, and the second half of that is
 * the answer to "why does it stop finding them".
 */
function unreadSeconds(pulses, files) {
  // Each file claims from the head of its lead-in to the end of its last block,
  // the gaps inside it included — a turbo file's header and data are two blocks
  // with silence between them, and counting that silence as unread would put
  // minutes on every tape.
  const spans = files
    .map(f => [f.leadPulse ?? f.atPulse, Math.max(f.endPulse ?? f.atPulse, f.atPulse)])
    .sort((a, b) => a[0] - b[0]);
  let total = 0, next = 0, covered = -1;
  for (let p = 0; p < pulses.length; p++) {
    while (next < spans.length && spans[next][0] <= p) {
      if (spans[next][1] > covered) covered = spans[next][1];
      next++;
    }
    if (p <= covered) continue;
    if (pulses[p] < GAP_CYCLES) total += pulses[p];
  }
  return total / PAL_CPU_HZ;
}

export function tapDirectory(tapData, { version = 1, zeroGapCycles = V0_ZERO_GAP_CYCLES } = {}) {
  if (!tapData || !tapData.length) return [];
  return tapDirectoryOfPulses(pulseCycles(tapData, version, zeroGapCycles));
}

/**
 * The same listing, from pulse widths already recovered — no `.tap` in between.
 * @param {number[]} pulses  widths in cycles
 */
export function tapDirectoryOfPulses(pulses) {
  const files = scanCbm(pulses);
  for (const fmt of TURBO_FORMATS) {
    let found = [];
    try { found = fmt.scan(pulses) || []; } catch { found = []; }
    for (const f of found) files.push(f);
  }
  // In tape order, and never two names for the same stretch of tape: a format
  // that misreads another's blocks would otherwise double-list a file.
  files.sort((a, b) => a.atPulse - b.atPulse);
  const list = files.filter((f, i) => i === 0 || f.atPulse - files[i - 1].atPulse > 64);

  // Back up each one to the head of its lead-in, stopping at silence, at eight
  // seconds, or at the file before it — whichever comes first.
  for (let i = 0; i < list.length; i++) {
    const floor = i ? list[i - 1].atPulse : 0;
    let p = list[i].atPulse, back = 0;
    while (p > floor && pulses[p - 1] < GAP_CYCLES && back < LEAD_MAX_CYCLES) {
      back += pulses[--p];
    }
    list[i].leadPulse = p;
  }

  // Where each one sits on the tape. Walked once, in order, rather than keeping
  // a running total per pulse: a long tape is millions of them.
  const wanted = [];
  for (const f of list) wanted.push([f.leadPulse, f, 'leadCycles'], [f.atPulse, f, 'atCycles']);
  wanted.sort((a, b) => a[0] - b[0]);
  let cycles = 0, next = 0;
  for (let p = 0; p < pulses.length; p++) {
    while (next < wanted.length && wanted[next][0] === p) {
      wanted[next][1][wanted[next][2]] = cycles;
      next++;
    }
    cycles += pulses[p];
  }
  while (next < wanted.length) { wanted[next][1][wanted[next][2]] = cycles; next++; }
  for (const f of list) {
    f.damaged = !!f.damage;
    // Only the KERNAL's own format has anything to relocate: every turbo loader
    // here writes to the address its header names, so the field is answered for
    // all of them rather than left missing on most.
    f.relocatable = !!f.relocatable;
    if (f.damage) {
      f.damage.seconds = (f.damage.holeCycles || 0) / PAL_CPU_HZ;
      f.damage.bytes = Math.round((f.damage.bits || 0) / 8);
    }
    f.atSeconds = f.atCycles / PAL_CPU_HZ;
    // What a loader has to be wound back to, which is what the listing offers.
    f.startSeconds = f.leadCycles / PAL_CPU_HZ;
    f.atFraction = cycles ? f.atCycles / cycles : 0;
  }
  return list;
}

// A CBM byte is a marker, eight bit pairs and a parity pair: twenty pulses. Twice
// that is still the same block; more is a gap or another format's signal.
const CBM_BYTE_PULSES = 40;

/**
 * Where a data block actually stops on the tape. Not where its header's length
 * says: a loader stub often claims a range it means to fill itself, and the byte
 * stream runs on through whatever follows, so counting the claimed length off a
 * short block lands wherever the next format's pulses happen to decode. Here that
 * put three unread minutes of an unknown turbo loader inside a 3 KB KERNAL file.
 * The block ends where its bytes stop being consecutive.
 */
function cbmBlockEnd(bytes, at, size) {
  const stop = Math.min(at + size, bytes.pulseOf.length - 1);
  let e = at;
  while (e < stop && bytes.pulseOf[e + 1] - bytes.pulseOf[e] <= CBM_BYTE_PULSES) e++;
  return bytes.pulseOf[e];
}

/** The CBM format the KERNAL itself writes. */
function scanCbm(pulses) {
  const bytes = decodeBytes(pulses);
  const files = [];

  // Every block on the tape first: a block opens with its countdown, $89 leading
  // the first copy and $09 the repeat. Nine bytes of strictly descending run is
  // not something data stumbles into.
  const blocks = [];
  for (let i = 0; i + 9 < bytes.length; i++) {
    const first = bytes[i];
    if (first !== 0x89 && first !== 0x09) continue;
    let runs = true;
    for (let k = 1; k < 9; k++) if (bytes[i + k] !== first - k) { runs = false; break; }
    if (!runs) continue;
    blocks.push({ at: i + 9, pulse: bytes.pulseOf[i] ?? 0 });
    i += 9;
  }

  const sums = (at, size) => {
    if (at + size >= bytes.length) return false;
    let x = 0;
    for (let k = 0; k < size; k++) x ^= bytes[at + k];
    return x === bytes[at + size];
  };

  /**
   * Does this block add up, checked the way the machine checks it? The KERNAL
   * reads a data block until its end marker and sums what it read; it does not
   * count out as many bytes as the header's addresses imply. Those two disagree
   * on real tapes — Head Over Heels claims 713 bytes and its block carries 636,
   * loads on hardware, and failed here for 77 bytes that were never on the tape.
   * The header's length is tried first, since that is right when nothing is odd,
   * and the block's own end is the fallback.
   */
  const blockSums = (at, size) => {
    if (sums(at, size)) return true;
    const end = bytes.endsAt.find(e => e > at);
    if (end === undefined || end - at - 1 <= 0) return false;
    return sums(at, end - at - 1);
  };

  for (let b = 0; b < blocks.length; b++) {
    const block = bytes.slice(blocks[b].at, blocks[b].at + HEADER_BYTES);

    // The countdown alone does not mean a header: a data block has one too, and
    // its first bytes are whatever the program happens to hold. Only a header
    // has a type, an address pair that runs forwards, and a name field of
    // printable PETSCII — a data block full of $01 satisfies none of it.
    const type = block[0];
    if (!TYPES[type]) continue;
    const start = block[1] | (block[2] << 8);
    const end = block[3] | (block[4] << 8);
    if (end <= start || start < 0x0100) continue;
    // The name may hold control codes — a commercial tape often opens it with a
    // colour and a clear-screen so that LOAD prints something tidy, and BATMAN
    // begins $05 $93 before a single letter of its name. Demanding printable
    // bytes throughout threw such a tape away whole, which is why what is
    // required is only that a name is in there somewhere. The header's own
    // checksum below is the real proof that this is a header at all.
    let letters = 0;
    for (let k = 0; k < NAME_LEN; k++) {
      const c = block[NAME_AT + k];
      if (c >= 0x20 && c !== 0x7F && !(c >= 0x80 && c <= 0x9F)) letters++;
    }
    if (letters < 2) continue;
    // And it has to add up: a block closes with the XOR of its payload. Without
    // this a data block whose bytes happen to read as a plausible header — high
    // enough to look like a name, addresses that run forwards — lists as a file
    // of its own, which is exactly what a KERNAL-saved program does.
    if (!sums(blocks[b].at, HEADER_BYTES)) continue;

    const name = headerName(block);
    const size = end - start;
    // Each block is written twice; the repeat says nothing new.
    const last = files[files.length - 1];
    if (last && last.name === name && last.start === start && last.end === end) continue;

    // The data copies are the two blocks past this header and its repeat. The
    // file is sound if either of them adds up — that is what a mended tape looks
    // like, and what the KERNAL needs to get the file into memory.
    const copies = [blocks[b + 2], blocks[b + 3]].filter(Boolean);
    const sound = copies.some(c => blockSums(c.at, size));

    const tail = copies[copies.length - 1];
    files.push({ name, type: TYPES[type], start, end, size, format: 'CBM',
                 relocatable: type === RELOCATABLE,
                 atPulse: blocks[b].pulse,
                 endPulse: tail ? cbmBlockEnd(bytes, tail.at, size) : undefined,
                 damage: sound ? null : { kind: copies.length ? 'checksum' : 'short', at: 0 } });
  }
  return files;
}
