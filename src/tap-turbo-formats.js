// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/tap-turbo-formats.js — reading the tapes the KERNAL cannot.
//
// Every turbo loader invents its own encoding, so there is no general rule to
// apply: a tape written by one can only be read by knowing that one. This is the
// place those go. Each entry describes a format well enough to list what is on
// the tape — the pulse widths, how bits become bytes, how a block announces
// itself, and where the name and addresses sit in its header — and
// src/tap-directory.js asks every one of them in turn.
//
// Adding a format means adding an entry here and nothing else.
//
// A note on what "supported" means: this reads a tape's *contents*. Loading such
// a tape still runs the loader's own code on the C64, exactly as it did in 1986.

// ── Shared helpers ───────────────────────────────────────────────────────────

/** Bits from pulses, one bit each, by a width threshold. A byte a bit: this is
 *  built for every scan of a tape, and a plain array of numbers costs several
 *  times the memory and a copy of the pulses' worth of garbage each time. */
function bitsByWidth(pulses, thresholdCycles) {
  const n = pulses.length, bits = new Uint8Array(n);
  for (let i = 0; i < n; i++) bits[i] = pulses[i] > thresholdCycles ? 1 : 0;
  return bits;
}

const byteMsbFirst = (bits, at) => {
  let v = 0;
  for (let k = 0; k < 8; k++) v = (v << 1) | (bits[at + k] || 0);
  return v;
};

/**
 * Blocks announced by a countdown — a run of bytes descending to 1, which is
 * how most of these formats mark "the data starts here" and how a loader
 * recovers bit alignment. Returns where each block's payload begins.
 */
function countdownBlocks(bits, byteAt, { from = [8, 48], minRun = 8 } = {}) {
  const out = [];
  for (let i = 0; i + 8 * minRun <= bits.length; i++) {
    const first = byteAt(bits, i);
    if (first < from[0] || first > from[1]) continue;
    let ok = true;
    for (let k = 1; k < minRun; k++) if (byteAt(bits, i + 8 * k) !== first - k) { ok = false; break; }
    if (!ok) continue;
    let at = i, v = first;
    while (v > 1 && at + 16 <= bits.length) { at += 8; v = byteAt(bits, at); }
    if (v !== 1) continue;
    out.push({ syncBit: i, dataBit: at + 8 });
    i = at + 8;
  }
  return out;
}

/**
 * What is wrong with a stretch of turbo tape, if anything. One pulse is one bit here and there
 * is no parity, so a pulse that is neither symbol is a bit gained or lost, and
 * every bit after it is shifted — the loader answers ?LOAD ERROR. Nothing can
 * mend it either: a turbo loader writes its file once, so there is no second
 * copy to take the missing bits from. The listing can still say so, and say how
 * much of the file went and where.
 *
 * The two widths are taken from the tape rather than from the format's nominal
 * figures, so a deck running slow or a clone that retimed the symbols is judged
 * against what it actually wrote.
 */
function blockDamage(pulses, from, count, threshold) {
  const to = Math.min(pulses.length, from + count);
  if (to <= from) return { kind: 'short', at: 0 };
  const low = [], high = [];
  const stride = Math.max(1, Math.floor((to - from) / 400));
  for (let i = from; i < to; i += stride) (pulses[i] > threshold ? high : low).push(pulses[i]);
  const mid = list => (list.length ? list.sort((a, b) => a - b)[list.length >> 1] : 0);
  const zero = mid(low) || threshold * 0.8, one = mid(high) || threshold * 1.2;
  // Two different things go wrong, and they do not mean the same to someone
  // looking at the listing: the tape can fall silent, taking a stretch of the
  // file with it, or it can keep going and come back unreadable — two pulses run
  // together where there should be two bits. Counted apart, and turned into how
  // much of the file it amounts to: one pulse is one bit here.
  const bit = (zero + one) / 2;
  let holes = 0, holeCycles = 0, garbled = 0, first = -1;
  for (let i = from; i < to; i++) {
    const c = pulses[i];
    if (c <= one * 1.45 && c >= zero * 0.55) continue;
    if (first < 0) first = i;
    if (c > one * 3) { holes++; holeCycles += c; } else garbled++;
  }
  if (!holes && !garbled) return null;
  const bits = Math.round(holeCycles / bit) + garbled;
  return {
    kind: 'lost',
    holes,
    holeCycles,
    garbled,
    bits,
    at: (first - from) / (to - from),
  };
}

/**
 * A name held as plain PETSCII with nothing padding it: it runs until a byte
 * that cannot be part of one. The control ranges are the tell — what follows a
 * GRL name is whatever the tape buffer happened to hold, and that starts $8B.
 */
function petsciiRun(bytes, at, max) {
  let s = '';
  for (let i = 0; i < max; i++) {
    const b = bytes(at + i);
    if (b < 0x20 || b === 0x7F || (b >= 0x80 && b <= 0x9F)) break;
    s += String.fromCharCode(b);
  }
  return s;
}

// ── GRL-Supertape (Geir Rune Ladehaug, 1986) ─────────────────────────────────
// Measured off tapes it wrote: one bit per pulse, ~170 cycles for a 0 and ~445
// for a 1, MSB first, each block introduced by a countdown from 32 to 1. A file
// is two blocks — a header of start/end addresses followed by the name, then the
// data — so a header is always followed by exactly one block to skip.
const GRL_THRESHOLD = 300;
const GRL_NAME_MAX = 16;

function scanGrl(pulses) {
  const bits = bitsByWidth(pulses, GRL_THRESHOLD);
  const blocks = countdownBlocks(bits, byteMsbFirst, { from: [16, 48] });
  const files = [];
  for (let b = 0; b < blocks.length; b++) {
    const at = blocks[b].dataBit;
    const byte = i => byteMsbFirst(bits, at + 8 * i);
    const start = byte(0) | (byte(1) << 8);
    const end = byte(2) | (byte(3) << 8);
    if (end <= start || start < 0x0100) continue;
    // A name, not merely a byte that prints. This format pads nothing, so the
    // start of another format's data block can pass as a name and list a file
    // that does not exist — a turbo data block on one tape here listed itself a
    // second time as `û`. What separates them is the character class, not the
    // length: a one-character name is legal, a name of pure graphics bytes is
    // somebody else's data.
    const name = petsciiRun(byte, 4, GRL_NAME_MAX);
    if (!name.trim() || !/[A-Za-z0-9]/.test(name)) continue;
    const data = blocks[b + 1];
    files.push({
      name, type: 'PRG', start, end, size: end - start,
      // One bit per pulse here, so the bit index is the pulse index — which is
      // what puts this file in the right place among CBM ones on the same tape.
      format: 'GRL-Supertape', atPulse: blocks[b].syncBit,
      endPulse: data ? data.dataBit + 8 * (end - start) : blocks[b].syncBit,
      damage: data ? blockDamage(pulses, data.dataBit, 8 * (end - start), GRL_THRESHOLD)
        : { kind: 'short', at: 0 },
    });
    b++;      // the data block belongs to this file, not to a name of its own
  }
  return files;
}

// ── Turbo Tape 64 ────────────────────────────────────────────────────────────
// The one everybody copied. Nineteen programs have been run here and every one
// of them writes it: GRL-Turbotape II, V2 and V.3, M.J-Turbotape, Flash
// Turbo-Tape ABC, ABC-Turbo v2.0, Super Tape Turbo (CCS), GWC Turbo 2, FCS Turbo
// Tape, Turbo 250, Turbo 250 LDP, turbo250g, Noddy's Turbo Tape 249, Shift Turbo
// 2, Turbo 202, Turbo 2002 (CGC and the PLA/GINO badge), and Ultra Turbo Tape
// 61K. That is the reason this one entry is worth so much — and several of them
// are the same tool rebadged, down to a byte-identical BASIC hook.
//
// Per its published description: no parity, a 0 of 211us and a 1 of 324us, a
// lead-in of $02 bytes and a countdown $09…$01 before each block. Measured off
// tapes these programs wrote, that is 216 and 328 cycles, matching the $1A/$28
// TAP units the format is specified in. The header is the CBM one with a spare
// byte inserted: type, addresses, spare, then a 16-byte name padded with spaces —
// where GRL's own Supertape a year later pads nothing at all.
//
// What differs between them, measured by saving the same 600 bytes with each
// program in turn, is only ever the timing and the padding:
//
//   widths     216/328 for most; GWC Turbo 2 writes 232/344, Turbo 2002 224/328
//   lead-in    1270 bytes before the header block for most; the Turbo 250 family
//              2550, the ABC/Shift/202 family 5110. 503 before the data block,
//              everywhere.
//   type byte  $01, except the Turbo 250 family, which writes $02
//
// So the threshold sits midway with room on either side, the type byte is taken
// as anything from 1 to 3, and nothing here is allowed to depend on how long a
// lead-in runs for.
const TT_THRESHOLD = 272;               // between the two widths
/** What the format specifies, for measuring a deck's speed error against. */
export const TT_NOMINAL = { zero: 216, one: 328 };
const TT_NAME_AT = 6, TT_NAME_LEN = 16;
// What could be a symbol of this format at all, however far off speed the deck
// was: half the short one to twice the long one, give or take.
const TT_SYMBOL_MIN = 100, TT_SYMBOL_MAX = 800;
const TT_SYMBOL_MIN_PULSES = 1000;      // fewer than this says nothing about clusters
const TT_THRESHOLD_SLACK = 8;           // a .tap step; no point reading twice for that

/**
 * Every Turbo Tape 64 file on a stretch of tape, with its data block located and
 * its checksum tested. Exported because a reading that can be *proved* is worth
 * more than one judged by eye: src/wav-tape.js reads a failing file again from
 * the recording and keeps whatever checks out.
 *
 * The payload runs to the end address inclusive and one XOR byte follows it.
 * Measured across the tapes here: every block a real loader accepts checks out,
 * and every block it refuses does not.
 */
/**
 * Where this tape's two symbol widths actually sit, from the pulses themselves.
 * A deck running fast or slow moves both of them, and a threshold nailed to the
 * nominal figures then reads every bit the same way — the tape decodes to
 * nothing at all. Returns null when the pulses do not look like two clusters,
 * which is the answer for a tape that is not this format.
 */
function measuredThreshold(pulses) {
  const buckets = new Map();
  let inRange = 0;
  for (let i = 0; i < pulses.length; i++) {
    const c = pulses[i];
    if (c < TT_SYMBOL_MIN || c > TT_SYMBOL_MAX) continue;
    const k = Math.round(c / 8);
    buckets.set(k, (buckets.get(k) || 0) + 1);
    inRange++;
  }
  if (inRange < TT_SYMBOL_MIN_PULSES) return null;
  const busiest = [...buckets.entries()].sort((a, b) => b[1] - a[1]);
  const first = busiest[0][0] * 8;
  // The other cluster has to be a different symbol, not the same one a bucket
  // over — a quarter apart is far less than 216 is from 328.
  const second = busiest.find(([k]) => Math.abs(k * 8 - first) > first * 0.25);
  if (!second) return null;
  const zero = Math.min(first, second[0] * 8), one = Math.max(first, second[0] * 8);
  return (zero + one) / 2;
}

/**
 * Every Turbo Tape 64 file in a pulse stream. Read at the nominal threshold
 * first, since that is what a tape at speed wants; if the tape's own widths put
 * the threshold somewhere else, read it that way too and keep whichever hands
 * over more files that check out. The checksum decides, so the second attempt
 * can only help.
 */
export function turboTape64Files(pulses) {
  const nominal = filesAt(pulses, TT_THRESHOLD);
  const measured = measuredThreshold(pulses);
  if (measured === null || Math.abs(measured - TT_THRESHOLD) < TT_THRESHOLD_SLACK) return nominal;
  const other = filesAt(pulses, measured);
  const sound = (list) => list.filter(f => f.data && f.data.checksumOk).length;
  return sound(other) > sound(nominal) ? other : nominal;
}

function filesAt(pulses, threshold) {
  const bits = bitsByWidth(pulses, threshold);
  const blocks = countdownBlocks(bits, byteMsbFirst, { from: [8, 16] });
  const files = [];
  for (let b = 0; b < blocks.length; b++) {
    const at = blocks[b].dataBit;
    const byte = i => byteMsbFirst(bits, at + 8 * i);
    if (byte(0) < 1 || byte(0) > 3) continue;          // the type byte
    const start = byte(1) | (byte(2) << 8);
    const end = byte(3) | (byte(4) << 8);
    if (end <= start || start < 0x0100) continue;
    // The field is 16 bytes and space-padded, and what sits after the padding is
    // whatever the saver left there. Take the name and stop: throwing the file
    // away because its *padding* is unreadable loses a sound program, and which
    // way that goes is a coin toss — DRUIDS on one tape here reads `DRUIDS␣␣␣␣␣.`
    // followed by 80 80 81 19 in one pass and 40 40 40 c8 in another, and only
    // the second survived a rule that rejected the byte range $80-$9F.
    let field = '';
    for (let i = 0; i < TT_NAME_LEN; i++) {
      const c = byte(TT_NAME_AT + i);
      if (c < 0x20 || c === 0x7F || (c >= 0x80 && c <= 0x9F)) break;
      field += String.fromCharCode(c);
    }
    // The padding is the proof. A name shorter than the field is followed by
    // spaces, so a field that runs straight from letters into an unreadable byte
    // is not a name at all — it is another format's block being read as one, and
    // rejecting it is what keeps a GRL header off a Turbo Tape 64 listing.
    // Anything after the padding is whatever the saver left behind: junk there
    // must not cost the file, which is how a sound program came to be invisible
    // (DRUIDS read `DRUIDS␣␣␣␣␣.` then 80 80 81 19 in one pass, 40 40 40 c8 in
    // another, and only the second survived).
    const padded = field.length === TT_NAME_LEN || / {2,}/.test(field) || field.endsWith(' ');
    if (!padded) continue;
    const name = field.trim().split(/ {2,}/)[0];
    const size = end - start;
    const block = blocks[b + 1];
    let data = null;
    if (block) {
      const dbyte = i => byteMsbFirst(bits, block.dataBit + 8 * i);
      const bytes = new Uint8Array(size + 2);          // payload, inclusive, then the checksum
      let x = 0;
      for (let i = 0; i <= size; i++) { bytes[i] = dbyte(i); x ^= bytes[i]; }
      bytes[size + 1] = dbyte(size + 1);
      data = {
        syncBit: block.syncBit,
        dataBit: block.dataBit,
        endBit: block.dataBit + 8 * (size + 2),
        countdownFrom: byteMsbFirst(bits, block.syncBit),
        checksumOk: x === bytes[size + 1],
        bytes,
      };
      // A hole in the middle of it outranks the checksum.
      if (data.checksumOk && turboBlockHasHole(pulses, data, threshold)) data.checksumOk = false;
    }
    // A tape may leave the name blank. The loader does not need one — it takes
    // whatever comes next — and a magazine tape that only ever loads from its own
    // menu has no use for names: every one of the twenty-one files on the
    // megatape here carries sixteen spaces, and demanding a name listed three.
    //
    // What stands in for the name is the shape: nine bytes counting down to one,
    // a type of 1 to 3, an address pair that runs forwards and a field of exactly
    // sixteen spaces, with a block behind it. Data does not stumble into that.
    // The block need not add up — a damaged file belongs in the listing, struck
    // through, rather than vanishing and leaving a minute of tape unexplained.
    if (!name && !data) continue;
    files.push({ name, start, end, size, headerSync: blocks[b].syncBit, data });
    b++;      // its data block follows
  }
  return files;
}

function scanTurboTape64(pulses) {
  return turboTape64Files(pulses).map(f => ({
    name: f.name, type: 'PRG', start: f.start, end: f.end, size: f.size,
    format: 'Turbo Tape 64', atPulse: f.headerSync,
    endPulse: f.data ? f.data.endBit : f.headerSync,
    // The checksum has the last word. Where it fails, the pulse widths still say
    // what went wrong and where, for the row that has to explain itself.
    damage: !f.data ? { kind: 'short', at: 0 }
      : f.data.checksumOk ? null
        : blockDamage(pulses, f.data.dataBit, 8 * f.size, TT_THRESHOLD) || { kind: 'checksum', at: 0 },
  }));
}

/**
 * A block with a stretch of dead tape inside it, whatever its checksum says. An
 * XOR of eight bits accepts one block in 256 by chance, so a block that is
 * visibly missing a piece must not be believed on the strength of it: bytes
 * cannot be recovered from tape that carries nothing, and a plausible file
 * minted out of a dropout is worse than an honest failure. Measured on the tapes
 * here, two files were being claimed exactly that way.
 */
export function turboBlockHasHole(pulses, block, threshold = TT_THRESHOLD) {
  const wide = threshold * 3;
  for (let i = block.dataBit; i < block.endBit && i < pulses.length; i++) {
    if (pulses[i] > wide) return true;
  }
  return false;
}

/**
 * The two widths this tape actually writes, measured on blocks that check out —
 * a clone retimes the format (GWC Turbo 2 writes 232/344), and a block put back
 * has to look like the ones around it.
 */
export function turboTape64Widths(pulses, files) {
  const low = [], high = [];
  for (const f of files) {
    if (!f.data || !f.data.checksumOk) continue;
    // A stride coprime with 8 walks across bit positions rather than sampling
    // the same one in every byte.
    for (let i = f.data.dataBit; i < f.data.endBit && i < pulses.length; i += 7) {
      (pulses[i] > TT_THRESHOLD ? high : low).push(pulses[i]);
    }
  }
  const mid = l => (l.length ? l.sort((a, b) => a - b)[l.length >> 1] : 0);
  return { zero: mid(low) || 216, one: mid(high) || 328 };
}

/**
 * A block written the way the format specifies it: countdown, then the bytes,
 * at the two widths the tape itself uses. Bytes proved by their checksum can be
 * put back on the tape this way, and what the loader then reads is a clean one.
 */
export function renderTurboTape64Block(bytes, { zero = 216, one = 328, countdownFrom = 9 } = {}) {
  const out = [];
  const push = v => { for (let k = 7; k >= 0; k--) out.push((v >> k) & 1 ? one : zero); };
  for (let v = countdownFrom; v >= 1; v--) push(v);
  for (const v of bytes) push(v);
  return out;
}

// ── The registry ─────────────────────────────────────────────────────────────
export const TURBO_FORMATS = [
  { id: 'turbo-tape-64', name: 'Turbo Tape 64', scan: scanTurboTape64 },
  { id: 'grl-supertape', name: 'GRL-Supertape', scan: scanGrl },
];
