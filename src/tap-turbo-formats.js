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

const byteLsbFirst = (bits, at) => {
  let v = 0;
  for (let k = 0; k < 8; k++) v |= (bits[at + k] || 0) << k;
  return v;
};

/**
 * `n` bytes from a bit position, read the way the format asking reads them.
 * Only built when a caller asked for the payload: a tape's worth of it is
 * megabytes, and a listing is usually opened to be read rather than extracted.
 */
const bytesFrom = (bits, at, n, byteAt) =>
  Uint8Array.from({ length: n }, (_, k) => byteAt(bits, at + 8 * k));

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

function scanGrl(pulses, { payload = false } = {}) {
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
    const bytes = payload && data
      ? bytesFrom(bits, data.dataBit, end - start, byteMsbFirst) : undefined;
    files.push({
      name, type: 'PRG', start, end, size: end - start, bytes,
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
// was: half the short one to twice the long one, give or take. Fewer pulses than
// `minPulses` inside that range says nothing about where the clusters are.
const TT_SYMBOL_RANGE = { min: 100, max: 800, minPulses: 1000 };
const TT_THRESHOLD_SLACK = 8;           // a .tap step; no point reading twice for that

/**
 * Every Turbo Tape 64 file on a stretch of tape, with its data block located and
 * its checksum tested. Exported because a reading that can be *proved* is worth
 * more than one judged by eye: src/wav-tape.js reads a failing file again from
 * the recording and keeps whatever checks out.
 *
 * A data block's countdown runs one byte further than a header's, down to $00,
 * and the payload begins after that zero and ends one byte before the end
 * address, with an XOR of both following it. So `bytes` here spans one more byte
 * than the file does, and the payload is the middle of it. Measured across the
 * tapes here: every block a real loader accepts checks out, and every block it
 * refuses does not.
 */
/**
 * Where this tape's two symbol widths actually sit, from the pulses themselves.
 * A deck running fast or slow moves both of them, and a threshold nailed to the
 * nominal figures then reads every bit the same way — the tape decodes to
 * nothing at all. Returns null when the pulses do not look like two clusters,
 * which is the answer for a tape that is not this format.
 */
function measuredThreshold(pulses, { min, max, minPulses }) {
  // A .tap step per bucket, counted in a typed array rather than a map: this
  // walks every pulse on the tape, and a tape is millions of them.
  const buckets = new Uint32Array(Math.round(max / 8) + 1);
  let inRange = 0;
  for (let i = 0; i < pulses.length; i++) {
    const c = pulses[i];
    if (c < min || c > max) continue;
    buckets[Math.round(c / 8)]++;
    inRange++;
  }
  if (inRange < minPulses) return null;
  const order = [...buckets.keys()].sort((a, b) => buckets[b] - buckets[a]);
  const first = order[0] * 8;
  // The other cluster has to be a different symbol, not the same one a bucket
  // over — a quarter apart is far less than 216 is from 328.
  const second = order.find(k => buckets[k] && Math.abs(k * 8 - first) > first * 0.25);
  if (second === undefined) return null;
  const zero = Math.min(first, second * 8), one = Math.max(first, second * 8);
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
  const measured = measuredThreshold(pulses, TT_SYMBOL_RANGE);
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
      const bytes = new Uint8Array(size + 2);          // the countdown's $00, the payload, the XOR
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

function scanTurboTape64(pulses, { payload = false } = {}) {
  return turboTape64Files(pulses).map(f => ({
    name: f.name, type: 'PRG', start: f.start, end: f.end, size: f.size,
    // A data block opens with a $00 the payload does not include: the loader
    // syncs by reading until a byte is not zero, so the byte this lands on is
    // the last of the pad and the program starts after it. Read off Turbo 250,
    // whose own transfer loop stores start..end-1 and whose files begin with a
    // BASIC link that only parses from the byte after the pad. It survives the
    // block's checksum either way, that $00 contributing nothing to an XOR.
    bytes: payload && f.data ? f.data.bytes.slice(1, f.size + 1) : undefined,
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

// ── Novaload (1984) ──────────────────────────────────────────────────────────
// The commercial one. It is the loader that draws a picture and plays music
// while the tape runs, and it says so itself: the KERNAL block that boots it
// ends in the screen codes for `NOVALOAD`.
//
// It is also the first format here that could be read rather than measured. A
// Novaload tape carries its own loader in the 192-byte tape-buffer header of
// that KERNAL block, so the format is whatever those 171 bytes do, and what
// follows is what they do. The resident loader the first block installs is read
// the same way, out of the memory image it loads.
//
// One bit per pulse, LSB first: 304 cycles for a 0 and 688 for a 1 ($26 and $56
// in .tap units). Nothing is counted down and no byte is framed. A block opens
// with a pilot of 0 bits, which the loader shifts through one register until it
// holds $80 — seven zeros and a one — and from that bit on the tape is whole
// bytes. The first of them is $AA or the loader goes back to listening.
//
// Two layouts follow that sync, and every tape carries both:
//
//   bootstrap   $AA, the value the KERNAL stub primed its checksum with, then
//               [page, 256 bytes, checksum] over and over until a page of $00 —
//               which the run-out of 0 bits after the last block provides for
//               free. The checksum is the page byte plus its 256. Pages are
//               written in whatever order the file wants, so this layout says
//               nothing about a start address and carries no name: it is the
//               block that loads the loader.
//   resident    $AA, a name length and that many bytes of name, then six bytes
//               — the destination less one page, the end address, the length of
//               the last block, and how many blocks — then a checksum. After it
//               the blocks, 256 bytes and a checksum each, the last one short.
//
// The resident layout runs a single sum across everything after the $AA, its own
// checksum bytes included, and each checksum is that total taken *before* the
// checksum byte itself joins it. Bomb Jack (Elite, 1986) is 215 bootstrap blocks
// and 32 resident ones, and every one of the 247 adds up.
const NOVA_ZERO = 304, NOVA_ONE = 688;
// Not a midpoint but the loader's own boundary. It restarts CIA1 timer A from
// $03F4 on every pulse and takes bit 1 of the previous count's *high byte*, so
// what decides the bit is which 256-cycle band the pulse fell in: 1012 − 500 is
// where the high byte crosses from 2 to 1, and that is the whole test.
//
// Fixed, therefore, where Turbo Tape 64 above has to measure its own. It holds
// from a deck 27% slow (688 down to 501) to one 64% fast (304 up to 500), which
// is far more drift than a deck has, so there is nothing to gain by reading the
// tape twice. Turbo Tape 64's 216 and 328 sit much closer together and 20% fast
// already puts both under its threshold.
const NOVA_THRESHOLD = 500;
/** What the format writes, for measuring a deck's speed error against. */
export const NOVA_NOMINAL = { zero: NOVA_ZERO, one: NOVA_ONE };
const NOVA_SYNC = 0xAA;
// Seven 0 bits and a 1 is all the loader waits for, and data runs into that
// constantly — but a real block is preceded by seconds of pilot (2064 bits of it
// on the tape measured), so a pilot is what is looked for here.
const NOVA_PILOT_BITS = 32;
const NOVA_NAME_MAX = 32;
// Bit sync does not come back once it is lost — one pulse is one bit, so a
// dropout shifts every bit behind it — and a run of failing blocks is therefore
// noise being read as a file, not a file with holes in it. Stop reading.
const NOVA_GIVE_UP = 4;

/** Where a Novaload block could begin: pilot, the bit the loader syncs on, $AA. */
function novaSyncBits(bits) {
  const out = [];
  let zeros = 0;
  for (let i = 0; i + 9 <= bits.length; i++) {
    if (!bits[i]) { zeros++; continue; }
    if (zeros >= NOVA_PILOT_BITS && byteLsbFirst(bits, i + 1) === NOVA_SYNC) out.push(i);
    zeros = 0;
  }
  return out;
}

/**
 * A file as the resident loader reads it: named, and with its own header saying
 * how much is coming. The header's checksum is what proves this is one — a name
 * that prints and six bytes that agree with a sum is not something a stretch of
 * program data falls into.
 */
function readNovaResident(bits, syncBit, payload) {
  let at = syncBit + 9;                 // past the sync bit and the $AA
  let sum = 0;                          // which the $AA cleared
  const room = n => at + 8 * n <= bits.length;
  const take = () => { const v = byteLsbFirst(bits, at); at += 8; sum = (sum + v) & 0xFF; return v; };

  if (!room(1)) return null;
  const nameLen = take();
  if (nameLen > NOVA_NAME_MAX || !room(nameLen + 7)) return null;
  let name = '';
  for (let i = 0; i < nameLen; i++) {
    const c = take();
    if (c < 0x20 || c === 0x7F || (c >= 0x80 && c <= 0x9F)) return null;
    name += String.fromCharCode(c);
  }
  // The destination is written one page low: the loader steps it on before each
  // block, this one included.
  const destLo = take(), destHi = take();
  take(); take();                       // the end address, which the block count gives again
  const tail = take(), count = take();
  const stated = sum;
  if (take() !== stated) return null;

  const start = ((destLo | (destHi << 8)) + 0x0100) & 0xFFFF;
  // Every block but the last is 256 bytes; the last is `tail`, and a tail of 0
  // means the file ended on the block before.
  const size = count ? (count - 1) * 256 + tail : 0;
  if (!size) return null;

  const dataBit = at;
  // A checksum byte follows every block, so the payload is not one run of bits:
  // it is the blocks with those bytes taken out.
  const bytes = payload ? new Uint8Array(size) : null;
  let bad = 0;
  for (let b = 0; b < count; b++) {
    const len = b === count - 1 ? tail : 256;
    if (!len) break;
    if (!room(len + 1)) return { name, start, end: start + size, size, dataBit, bytes,
                                 endBit: bits.length, damage: { kind: 'short', at: 0 } };
    for (let i = 0; i < len; i++) {
      const v = take();
      if (bytes) bytes[b * 256 + i] = v;
    }
    const want = sum;                   // the total before this byte joins it
    if (take() !== want) bad++;
  }
  return { name, start, end: start + size, size, dataBit, endBit: at, bad, bytes };
}

/**
 * The block that carries the loader itself: pages in whatever order it wants
 * them, ending on a page of $00. Two sound blocks are asked for before this is
 * called a file — one is a checksum byte agreeing by chance once in 256, which
 * over a tape's worth of candidate syncs is not rare enough to build a listing
 * on. A block damaged that early cannot be read past anyway.
 */
function readNovaBootstrap(bits, syncBit, payload) {
  let at = syncBit + 17;                // past the sync bit, the $AA and the seed
  const room = n => at + 8 * n <= bits.length;
  let low = 0x100, high = -1, good = 0, bad = 0, run = 0, short = false;
  const dataBit = at;
  // Which pages, in the order the tape gives them. The span they cover is not
  // known until the last one is read, so they are assembled at the end.
  const pages = payload ? [] : null;
  for (;;) {
    // A tape cut off after its last block has no run-out to end on, and one cut
    // inside a block has no checksum. What was read is still what is there, so
    // it is reported rather than thrown away.
    if (!room(1)) { short = true; break; }
    const page = byteLsbFirst(bits, at);
    if (page === 0) break;              // the run-out of 0 bits, or a page of them
    at += 8;
    if (!room(257)) { short = true; break; }
    let want = page;
    for (let i = 0; i < 256; i++) want = (want + byteLsbFirst(bits, at + 8 * i)) & 0xFF;
    if (pages) pages.push([page, bytesFrom(bits, at, 256, byteLsbFirst)]);
    at += 8 * 256;
    if (byteLsbFirst(bits, at) === want) { good++; run = 0; } else { bad++; if (++run >= NOVA_GIVE_UP) break; }
    at += 8;
    if (page < low) low = page;
    if (page > high) high = page;
  }
  if (good < 2) return null;
  const start = low << 8, end = (high << 8) + 256;
  let bytes;
  if (pages) {
    // The pages need not be contiguous and need not be in order, so the payload
    // is the whole span from the lowest to the highest, with any page the tape
    // never wrote left as zeros. That is why it is `end - start` long and not
    // `size`, which counts the blocks the tape does carry.
    bytes = new Uint8Array(end - start);
    for (const [page, data] of pages) bytes.set(data, (page << 8) - start);
  }
  return {
    name: '', start, end, size: (good + bad) * 256,
    dataBit, endBit: at, bad, bytes,
    damage: short ? { kind: 'short', at: 0 } : undefined,
  };
}

/**
 * Every Novaload file in a pulse stream. Each sync is offered to the resident
 * layout first, since a header that adds up settles the question in ten bytes,
 * and to the bootstrap layout only if that says no.
 */
function novaloadFilesAt(pulses, threshold, payload) {
  const bits = bitsByWidth(pulses, threshold);
  const files = [];
  let claimed = -1;
  for (const sync of novaSyncBits(bits)) {
    if (sync < claimed) continue;       // a sync inside a file already read
    const f = readNovaResident(bits, sync, payload) || readNovaBootstrap(bits, sync, payload);
    if (!f) continue;
    files.push({
      name: f.name, type: 'PRG', start: f.start, end: f.end, size: f.size,
      bytes: f.bytes ?? undefined,
      format: 'Novaload', atPulse: sync, endPulse: f.endBit,
      damage: f.damage || (f.bad
        ? blockDamage(pulses, f.dataBit, f.endBit - f.dataBit, threshold) || { kind: 'checksum', at: 0 }
        : null),
    });
    claimed = f.endBit;
  }
  return files;
}

/**
 * The two widths this tape actually writes, measured over the files that add up
 * — the deck's speed error is the ratio between them and what the format
 * specifies, and a person looking at a listing deserves to know whether the
 * fault is the oxide or the machine that recorded it.
 */
export function novaloadWidths(pulses, files) {
  const low = [], high = [];
  for (const f of files) {
    if (f.damage || f.damaged) continue;
    const to = Math.min(f.endPulse ?? 0, pulses.length);
    // A few hundred samples settle a median; a Novaload file is a quarter of a
    // million pulses. The stride is odd so it walks across bit positions rather
    // than sampling the same one in every byte.
    const stride = Math.max(1, Math.floor((to - f.atPulse) / 400)) | 1;
    for (let i = f.atPulse; i < to; i += stride) {
      (pulses[i] > NOVA_THRESHOLD ? high : low).push(pulses[i]);
    }
  }
  const mid = l => (l.length ? l.sort((a, b) => a - b)[l.length >> 1] : 0);
  return { zero: mid(low) || NOVA_ZERO, one: mid(high) || NOVA_ONE };
}

// ── US Gold / Datasoft ───────────────────────────────────────────────────────
// Read the same way Novaload was, out of the loader the tape carries, except
// that this one hides first: its KERNAL boot block decrypts itself at $02CA
// before running, so the bytes on the tape say nothing. What the machine
// decrypts is a reader in the tape buffer, and that is what this describes.
//
// It is Turbo Tape 64's lead-in and countdown at other widths, with a header of
// its own. A bit is one pulse, MSB first (`ROL $BD` eight times), 224 cycles for
// a 0 and 512 for a 1. The threshold is not a midpoint: the loader arms CIA2
// timer B with $016B and asks, at the next tape edge, whether it has run out, so
// what separates the symbols is 363 cycles.
//
// A block is a lead-in of $02 bytes and a countdown from $09 to $01, exactly as
// Turbo Tape 64 writes them, and then:
//
//   $01           one more byte, which the loader only checks is not $00
//   $96           its sync byte
//   $00
//   lo, hi        where the block loads
//   lo, hi        its length, negated: the loader counts up to zero
//   one spare
//
// Then the bytes, and nothing after them. There is no checksum anywhere in the
// format: the loader stores until its counter wraps and never adds anything up,
// so a file here is judged on its pulse widths alone, as GRL-Supertape is.
//
// Read off The Goonies (US Gold, 1986). Nothing in the stub names the loader, so
// it was read before it was named.
const USGOLD_ZERO = 224, USGOLD_ONE = 512;
const USGOLD_THRESHOLD = 363;          // CIA2 timer B, $016B, is the whole test
const USGOLD_SYNC = 0x96;
const USGOLD_HEADER = 8;               // bytes between the countdown and the data

function scanUsGold(pulses, { payload = false } = {}) {
  const bits = bitsByWidth(pulses, USGOLD_THRESHOLD);
  const files = [];
  for (const block of countdownBlocks(bits, byteMsbFirst, { from: [8, 16] })) {
    const byte = i => byteMsbFirst(bits, block.dataBit + 8 * i);
    if (byte(1) !== USGOLD_SYNC || byte(2) !== 0) continue;
    const start = byte(3) | (byte(4) << 8);
    const size = (0x10000 - (byte(5) | (byte(6) << 8))) & 0xFFFF;
    // A block that runs off the top of memory, or holds nothing, is a countdown
    // this format did not write.
    if (!size || start + size > 0x10000) continue;
    const dataBit = block.dataBit + 8 * USGOLD_HEADER;
    const endBit = dataBit + 8 * size;
    files.push({
      name: '', type: 'PRG', start, end: start + size, size,
      bytes: payload && endBit <= pulses.length
        ? bytesFrom(bits, dataBit, size, byteMsbFirst) : undefined,
      format: 'US Gold / Datasoft', atPulse: block.syncBit, endPulse: Math.min(endBit, pulses.length),
      damage: endBit > pulses.length ? { kind: 'short', at: 0 }
        : blockDamage(pulses, dataBit, 8 * size, USGOLD_THRESHOLD),
    });
  }
  return files;
}

// ── Gremlin Type 2 ───────────────────────────────────────────────────────────
// The third loader read out of the tape rather than described from outside, and
// the only one here that keeps a directory. Its KERNAL boot block is not
// encrypted: it is a dispatcher that pulls in a 512-byte loader at $0400 with
// the KERNAL's own tape LOAD, then calls it with A = 0, 1, 2. The loader turns
// that into a two-character id from a table at $0403 ("01", "02", "03", …) and
// reads past every block whose id does not match. So the caller names the block
// it wants, and the block says which it is.
//
// A bit is one pulse, MSB first, 424 cycles and 840. Which is which is the other
// way round from every format above: the loader arms CIA1 timer A with $0A50 and
// takes the bit from whether its high byte is still 8 or more at the next edge,
// so the *short* pulse is the 1 and the boundary is 592 cycles. It then
// complements each assembled byte. Both inversions are left alone here: bits
// read the usual way round are the loader's bits complemented, and reading a
// byte from them is its EOR $FF, so the two cancel and the bytes come out right.
//
// A block is a run of 0 bits and then:
//
//   $FE           read this way; the loader shifts until its own register is $01
//   "0", "1"…     the two id characters
//   lo, hi        where the block loads
//   lo, hi        how long it is, counted down to zero rather than negated
//
// Then the bytes. There is no checksum, so a block is judged on its pulse widths
// as GRL-Supertape and US Gold / Datasoft are.
//
// Read off Masters of the Universe: The Movie, whose two sides carry the same
// three blocks, and found again on Cybernoid, which carries the same $02A7 stub
// and the same $0400 loader. Gremlin Graphics published the first; the loader is
// theirs and outlived their own catalogue.
const GREMLIN2_ZERO = 840, GREMLIN2_ONE = 424;  // the short pulse is the 1 in this format
const GREMLIN2_THRESHOLD = 592;             // CIA1 timer A from $0A50, high byte 8 or more
const GREMLIN2_SYNC = 0xFE;
const GREMLIN2_HEADER = 6;                  // two id characters, the address, the length
const GREMLIN2_ID_MAX = 0x39;               // "9"; the table at $0403 never runs past it

function scanGremlin2(pulses, { payload = false } = {}) {
  const bits = bitsByWidth(pulses, GREMLIN2_THRESHOLD);
  const files = [];
  for (let i = 0; i + 8 * (GREMLIN2_HEADER + 2) <= bits.length; i++) {
    if (byteMsbFirst(bits, i) !== GREMLIN2_SYNC) continue;
    const byte = k => byteMsbFirst(bits, i + 8 * (1 + k));
    const tens = byte(0), units = byte(1);
    if (tens !== 0x30 || units < 0x31 || units > GREMLIN2_ID_MAX) continue;
    const start = byte(2) | (byte(3) << 8);
    const size = byte(4) | (byte(5) << 8);
    // A block that holds nothing, or would load past the top of memory, is a
    // coincidence rather than a header: three bytes of signature is not enough
    // on its own over a tape's worth of bit positions.
    if (!size || start + size > 0x10000) continue;
    const dataBit = i + 8 * (1 + GREMLIN2_HEADER);
    const endBit = dataBit + 8 * size;
    files.push({
      name: String.fromCharCode(tens, units), type: 'PRG', start, end: start + size, size,
      bytes: payload && endBit <= pulses.length
        ? bytesFrom(bits, dataBit, size, byteMsbFirst) : undefined,
      format: 'Gremlin Type 2', atPulse: i, endPulse: Math.min(endBit, pulses.length),
      damage: endBit > pulses.length ? { kind: 'short', at: 0 }
        : blockDamage(pulses, dataBit, 8 * size, GREMLIN2_THRESHOLD),
    });
    i = endBit;                          // its bytes are not another block's sync
  }
  return files;
}

// ── Ocean / Imagine ──────────────────────────────────────────────────────────
// Novaload's idiom in another house's hands, and the clearest sign yet that
// these loaders are a family rather than a set. Its reader measures a pulse the
// same way Novaload's does, to the instruction:
//
//   LDA $DD07 / LDY #$11 / STY $DD0F / EOR #$02 / LSR / LSR / ROR $02
//
// Read the timer's high byte, restart it, and shift the answer into a register.
// Novaload's is `ROR $A9`; this one's is `ROR $02`, in zero page, because the
// reader is copied there to run. It even keeps its state the same way, by
// writing over an address in its own code: Novaload patches a branch's operand,
// this patches the target of a `JMP` at $0037.
//
// CIA2 timer B is armed with $03E0, and the bit is whether its high byte still
// reads 2 or more, so the boundary is 992 − 512 = 480 cycles. The symbols are
// 296 and 640, one pulse each, LSB first.
//
// A block is a pilot of 0 bits and then the one 1 bit the register syncs on,
// and after that:
//
//   flags         bit 0 decides whether RAM is banked in under the ROM to
//                 store into; bit 3 stops the border flashing
//   page          where the 256 bytes go, and $00 ends the tape
//   256 bytes
//
// over and over. There is no checksum of any kind, so a block is judged on its
// pulse widths as GRL-Supertape, US Gold / Datasoft and Gremlin Type 2 are.
//
// The widths differ from tape to tape, as Turbo Tape 64's clones do: 296 and
// 640 on Green Beret, 288 and 648 on Arkanoid, 264 and 664 on Head Over Heels,
// 264 and 544 on Silkworm. The boundary does not have to move with them. All
// four sit either side of 480, which is what the loader compares against, so
// one threshold reads the family.
//
// The pilot has to be recognised by width, and by a width narrow enough to
// exclude a KERNAL lead-in. Both are short: this format's 0 measures 264 to 296
// across the tapes here, and a lead-in 352 to 384. Asking only for a 0 bit,
// which is anything under 480, syncs on almost any run of $00 bytes in a
// program and cost real files on four tapes. Asking for a pulse merely near 296
// still let Head Over Heels' 352 lead-in in, and the nonsense read out of it
// swallowed that tape's KERNAL file. So the pilot is a pulse inside the band the
// family actually writes.
//
// Then the pages, which are the only proof a format with no checksum has. Not
// the stream's length: a stream of noise does not stop, it runs until a page
// byte of $00 turns up by chance, which is 256 blocks on average, so length says
// nothing. Silkworm reads as 141 blocks this way and is a Freeload tape.
//
// What a page-based loader does and noise does not is count. It fills memory a
// page at a time, so its page bytes ascend: measured, 97% of the steps on Green
// Beret, 96% on Arkanoid, 98% on Head Over Heels, against 1% for the 141 blocks
// read out of Silkworm.
//
// Read off Green Beret (Imagine for Ocean, 1986).
const OCEAN_ZERO = 296, OCEAN_ONE = 640;
const OCEAN_THRESHOLD = 480;            // CIA2 timer B from $03E0, high byte 2 or more
// The band the family's own 0 falls in, measured: 264 on Head Over Heels and
// Silkworm, 288 on Arkanoid, 296 on Green Beret. A KERNAL lead-in starts at 352.
const OCEAN_PILOT_MIN = 240, OCEAN_PILOT_MAX = 330;
const OCEAN_PILOT_PULSES = 64;          // 4112 on Green Beret; 64 is a floor
const OCEAN_MIN_BLOCKS = 8;             // enough for the share below to mean anything
const OCEAN_ASCENDING = 0.75;           // of the steps between pages; 96% to 98% measured

/**
 * One stream: blocks until a page byte of $00, or until the tape runs out.
 * @returns {object|null} null when this is not one
 */
function readOceanStream(bits, pulses, syncBit, payload) {
  let at = syncBit + 1;
  const room = n => at + 8 * n <= bits.length;
  let low = 0x100, high = -1, blocks = 0, ascending = 0, was = -1;
  const dataBit = at;
  const pages = payload ? [] : null;
  for (;;) {
    if (!room(2)) return null;                     // no terminator, so no stream
    at += 8;                                       // the flags byte
    const page = byteLsbFirst(bits, at);
    if (page === 0) break;                         // $00 ends it
    at += 8;
    if (!room(256)) return null;
    if (pages) pages.push([page, bytesFrom(bits, at, 256, byteLsbFirst)]);
    at += 8 * 256;
    if (page === ((was + 1) & 0xFF)) ascending++;
    was = page;
    if (page < low) low = page;
    if (page > high) high = page;
    blocks++;
  }
  if (blocks < OCEAN_MIN_BLOCKS) return null;
  if (ascending < (blocks - 1) * OCEAN_ASCENDING) return null;
  const start = low << 8, end = (high << 8) + 256;
  let bytes;
  if (pages) {                                     // a span, for the reason above
    bytes = new Uint8Array(end - start);
    for (const [page, data] of pages) bytes.set(data, (page << 8) - start);
  }
  return { start, end, size: blocks * 256, dataBit, endBit: at + 8, bytes };
}

function scanOcean(pulses, { payload = false } = {}) {
  const bits = bitsByWidth(pulses, OCEAN_THRESHOLD);
  const files = [];
  let pilot = 0;
  for (let i = 0; i + 9 <= bits.length; i++) {
    const c = pulses[i];
    if (c >= OCEAN_PILOT_MIN && c <= OCEAN_PILOT_MAX) { pilot++; continue; }
    const synced = pilot >= OCEAN_PILOT_PULSES && bits[i];
    pilot = 0;
    if (!synced) continue;
    const f = readOceanStream(bits, pulses, i, payload);
    if (!f) continue;
    files.push({
      name: '', type: 'PRG', start: f.start, end: f.end, size: f.size, bytes: f.bytes,
      format: 'Ocean / Imagine', atPulse: i, endPulse: Math.min(f.endBit, pulses.length),
      damage: blockDamage(pulses, f.dataBit, f.endBit - f.dataBit, OCEAN_THRESHOLD),
    });
    i = f.endBit;                                  // its bytes are not another sync
  }
  return files;
}

// ── Freeload ─────────────────────────────────────────────────────────────────
// The family's fourth member, and the only one that can prove itself. Its
// reader measures a pulse the way Novaload and Ocean / Imagine do, and keeps its
// state the way Novaload does, by writing over a branch's operand:
//
//   LDA $DC05 / LDY #$19 / STY $DC0E / EOR #$02 / LSR / LSR / ROL $A9
//
// The last instruction is the difference. Novaload rotates right and reads its
// bytes LSB first; this rotates left, so Freeload is MSB first. CIA1 timer A is
// armed with $0368, and the bit is whether its high byte still reads 2 or more,
// so the boundary is 872 − 512 = 360 cycles.
//
// It also starts differently. The block it boots from loads at $0326, which is
// IBSOUT, so its first two bytes redirect the KERNAL's character output into the
// loader and it takes the machine the next time anything is printed.
//
// A block is the register reaching $40, then a $5A, then:
//
//   lo, hi        where it loads
//   lo, hi        where it ends, exclusive
//   the bytes
//   one byte      the XOR of them all, which the loader accumulates in $C1 and
//                 compares against what it puts in $C2
//
// That checksum is why this one is claimed only when it adds up. Two bytes of
// sync is one in 65536, which a tape's worth of bit positions supplies several
// times over: six of the eight candidates on Silkworm are coincidence, and
// their addresses look as reasonable as the real ones. Turbo Tape 64 can afford
// to list a block that fails, its nine byte countdown being proof enough that a
// block is there at all. Two bytes cannot, so a Freeload block that does not add
// up is not a Freeload block, and the tape's unread seconds say so instead.
//
// Read off Silkworm (Virgin Mastertronic, 1989).
const FREE_ZERO = 264, FREE_ONE = 544;
const FREE_THRESHOLD = 360;             // CIA1 timer A from $0368, high byte 2 or more
const FREE_SYNC = 0x40, FREE_AFTER_SYNC = 0x5A;
const FREE_HEADER = 6;                  // the two sync bytes and the two addresses

function scanFreeload(pulses, { payload = false } = {}) {
  const bits = bitsByWidth(pulses, FREE_THRESHOLD);
  const files = [];
  for (let i = 0; i + 8 * (FREE_HEADER + 1) <= bits.length; i++) {
    if (byteMsbFirst(bits, i) !== FREE_SYNC) continue;
    if (byteMsbFirst(bits, i + 8) !== FREE_AFTER_SYNC) continue;
    const byte = k => byteMsbFirst(bits, i + 8 * (2 + k));
    const start = byte(0) | (byte(1) << 8);
    const end = byte(2) | (byte(3) << 8);
    const size = end - start;
    if (size <= 0 || start < 0x0100) continue;
    const dataBit = i + 8 * FREE_HEADER;
    const endBit = dataBit + 8 * (size + 1);
    if (endBit > bits.length) continue;            // not all of it is on the tape
    let x = 0;
    for (let k = 0; k < size; k++) x ^= byteMsbFirst(bits, dataBit + 8 * k);
    if (x !== byteMsbFirst(bits, dataBit + 8 * size)) continue;
    files.push({
      name: '', type: 'PRG', start, end, size,
      bytes: payload ? bytesFrom(bits, dataBit, size, byteMsbFirst) : undefined,
      format: 'Freeload', atPulse: i, endPulse: endBit,
      damage: null,                                // it added up, or it is not here
    });
    i = endBit;                                    // its bytes are not another sync
  }
  return files;
}

// ── Wildload ─────────────────────────────────────────────────────────────────
// The family's fifth, and the one that does the most with a block. Its reader
// measures a pulse the way the rest of them do, and it is copied into the stack
// page to run, so its register is $AE:
//
//   LDA $DC05 / LDY #$11 / STY $DC0E / EOR #$02 / LSR / LSR / ROR $AE
//
// It rotates right, so bytes are LSB first, and it counts bits in $A9 rather
// than pushing a sentinel through the register. CIA1 timer A is armed with
// $03E0, and the bit is whether its high byte still reads 2 or more, so the
// boundary is 992 − 512 = 480 cycles.
//
// A block is a run of $A0 bytes, a countdown from $0A to $01, and then five
// bytes: where it loads, how many bytes, and a flag. Then the bytes, and one
// more holding their XOR.
//
// Two things are its own. The destination *descends*: `DCP $0C / DEC $0D` walks
// it backwards, so a block fills memory from its top address down and the file
// occupies the range below the address in its header. And each byte is EOR'd
// with the low byte of wherever it is going before being stored, which is a
// cipher whose key is the address, so the same byte is written differently
// eight times in a page.
//
// That makes a one byte block meaningful, and IK+ uses one: a block of a single
// byte aimed at $D011 is how the loader turns the screen off between loads.
//
// Its own tape is where the checksum is checked, and it is checked here too:
// with a signature this strong the XOR is not needed to tell a block from a
// coincidence, but a block that does not add up has not arrived, and saying it
// has would be worse than saying nothing.
//
// Read off International Karate + (System 3, 1987).
const WILD_ZERO = 384, WILD_ONE = 576;
const WILD_THRESHOLD = 480;             // CIA1 timer A from $03E0, high byte 2 or more
const WILD_PILOT = 0xA0;                // the byte its lead-in is made of
const WILD_PILOT_BYTES = 3;             // enough of them to be a lead-in and not data
const WILD_COUNTDOWN = 0x0A;            // down to 1, as Turbo Tape 64 counts from 9
const WILD_HEADER = 5;                  // address, count, and a flag

function scanWildload(pulses, { payload = false } = {}) {
  const bits = bitsByWidth(pulses, WILD_THRESHOLD);
  const byteAt = at => byteLsbFirst(bits, at);
  const files = [];
  const room = (at, n) => at + 8 * n <= bits.length;
  for (let i = 0; room(i, WILD_PILOT_BYTES + WILD_COUNTDOWN + WILD_HEADER + 1); i++) {
    let lead = 0;
    while (lead < WILD_PILOT_BYTES && byteAt(i + 8 * lead) === WILD_PILOT) lead++;
    if (lead < WILD_PILOT_BYTES) continue;
    // Past the rest of the lead-in, however long it runs.
    let at = i;
    while (byteAt(at) === WILD_PILOT && room(at, 1)) at += 8;
    // Then the countdown, which is what says a block rather than a quiet patch.
    let counts = true;
    for (let k = 0; k < WILD_COUNTDOWN; k++) {
      if (byteAt(at + 8 * k) !== WILD_COUNTDOWN - k) { counts = false; break; }
    }
    if (!counts) { i = at; continue; }
    const head = at + 8 * WILD_COUNTDOWN;
    if (!room(head, WILD_HEADER + 1)) break;
    const top = byteAt(head) | (byteAt(head + 8) << 8);
    const count = byteAt(head + 16) | (byteAt(head + 24) << 8);
    const dataBit = head + 8 * WILD_HEADER;
    if (!count || count > top + 1 || !room(dataBit, count + 1)) { i = at; continue; }
    // Each byte deciphered against the address it goes to, and the address
    // walking down. The XOR is of what was stored, not of what was on the tape.
    // Deciphered as it goes, and put where it goes: the address descends, so the
    // first byte on the tape is the file's last. A payload handed over in tape
    // order would be the program backwards.
    const bytes = payload ? new Uint8Array(count) : null;
    let sum = 0, to = top;
    for (let k = 0; k < count; k++) {
      const plain = (byteAt(dataBit + 8 * k) ^ (to & 0xFF)) & 0xFF;
      sum ^= plain;
      if (bytes) bytes[count - 1 - k] = plain;
      to = (to - 1) & 0xFFFF;
    }
    if (sum !== byteAt(dataBit + 8 * count)) { i = at; continue; }
    const endBit = dataBit + 8 * (count + 1);
    files.push({
      name: '', type: 'PRG', start: top - count + 1, end: top + 1, size: count,
      bytes: bytes ?? undefined,
      format: 'Wildload', atPulse: i, endPulse: endBit,
      damage: null,                                // it added up, or it is not here
    });
    i = endBit;
  }
  return files;
}

// ── The registry ─────────────────────────────────────────────────────────────
export const TURBO_FORMATS = [
  { id: 'turbo-tape-64', name: 'Turbo Tape 64', scan: scanTurboTape64 },
  { id: 'grl-supertape', name: 'GRL-Supertape', scan: scanGrl },
  { id: 'novaload', name: 'Novaload',
    scan: (pulses, o) => novaloadFilesAt(pulses, NOVA_THRESHOLD, o?.payload) },
  { id: 'us-gold-datasoft', name: 'US Gold / Datasoft', scan: scanUsGold },
  { id: 'gremlin-type-2', name: 'Gremlin Type 2', scan: scanGremlin2 },
  { id: 'ocean-imagine', name: 'Ocean / Imagine', scan: scanOcean },
  { id: 'freeload', name: 'Freeload', scan: scanFreeload },
  { id: 'wildload', name: 'Wildload', scan: scanWildload },
];
