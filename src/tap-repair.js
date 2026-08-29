// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/tap-repair.js — using a tape's own redundancy to mend a bad transfer.
//
// The KERNAL writes every block twice, and the loader reads both before it
// returns. So a digitised tape whose second copy is damaged loads its data and
// then fails at the very end — the file is in memory, the machine hangs on
// LOADING or answers ?LOAD ERROR. Three tapes measured here fail exactly that
// way, all at the tail of the repeat block.
//
// Nothing needs inventing to fix it: the first copy carries a checksum, and a
// checksum that adds up is proof. Where the first copy checks out and the second
// does not, the second is written again from the first, in place, at the same
// length a good one would have been.
//
// Only the KERNAL's own format, which is the only one with a second copy on the
// tape. A turbo file writes itself once and is mended a step earlier instead —
// from a second reading of the recording, in src/wav-tape.js.

import { V0_ZERO_GAP_CYCLES } from './tap-audio.js';

const UNIT = 8;
const SHORT = 0x30, MEDIUM = 0x42, LONG = 0x56;      // TAP units the KERNAL writes
const SHORT_MAX = 0x39 * UNIT, MEDIUM_MAX = 0x4E * UNIT;
const S = 0, M = 1, L = 2;
const HEADER_BYTES = 192;
const COUNTDOWN = 9;
const ALIGN_BAND = 64;        // how far two copies of a block can drift apart
const TRAILER_PULSES = 60;
const HEADER_SIZE = 20;

const classify = c => (c < SHORT_MAX ? S : c < MEDIUM_MAX ? M : L);

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
 * Bytes, each remembering the pulse it started at, so a block can be located —
 * and whether its parity held. A byte that fails parity is kept in place and
 * marked: dropping it would shift everything after it, and the two copies of a
 * block can only be compared against each other position for position.
 */
function frameBytes(pulses) {
  const bytes = [], at = [], bad = [];
  let i = 0;
  while (i + 1 < pulses.length) {
    if (classify(pulses[i]) !== L || classify(pulses[i + 1]) !== M) { i++; continue; }
    const start = i;
    i += 2;
    let value = 0, ones = 0, ok = true;
    for (let bit = 0; bit < 8; bit++) {
      if (i + 1 >= pulses.length) { ok = false; break; }
      const a = classify(pulses[i]), b = classify(pulses[i + 1]);
      if (a === S && b === M) { i += 2; }
      else if (a === M && b === S) { value |= 1 << bit; ones++; i += 2; }
      else { ok = false; break; }
    }
    if (!ok) continue;
    if (i + 1 >= pulses.length) break;
    const a = classify(pulses[i]), b = classify(pulses[i + 1]);
    const parity = (a === M && b === S) ? 1 : (a === S && b === M) ? 0 : -1;
    if (parity < 0) continue;
    i += 2;
    bytes.push(value);
    at.push(start);
    bad.push(((ones + parity) & 1) === 0);
  }
  return { bytes, at, bad };
}

/** Blocks, in tape order: where each starts, and which copy it is. */
function findBlocks({ bytes, at }) {
  const out = [];
  for (let k = 0; k + COUNTDOWN < bytes.length; k++) {
    const first = bytes[k];
    if (first !== 0x89 && first !== 0x09) continue;
    let runs = true;
    for (let j = 1; j < COUNTDOWN; j++) if (bytes[k + j] !== first - j) { runs = false; break; }
    if (!runs) continue;
    out.push({ byte: k + COUNTDOWN, pulse: at[k], repeat: first === 0x09 });
    k += COUNTDOWN;
  }
  return out;
}

const xor = list => { let x = 0; for (const b of list) x ^= b; return x; };

/** One block's bytes in the order they were read, however many are missing. */
function blockRun({ bytes, at, bad }, block, want, until) {
  const out = [], flags = [];
  for (let k = block.byte; k < bytes.length && out.length < want; k++) {
    if (at[k] >= until) break;
    out.push(bytes[k]);
    flags.push(bad[k]);
  }
  return { bytes: out, bad: flags };
}

/** Does a copy stand on its own — long enough, and its checksum agreeing? */
function checksOut(run, size) {
  return run.bytes.length > size && xor(run.bytes.slice(0, size)) === run.bytes[size];
}

/**
 * How two readings of the same block line up. A dropout can swallow bytes and
 * the pulses they sat in together, so nothing in the stream itself says how many
 * went missing — but the other copy still holds them, and an alignment shows
 * where. Banded, because two copies of one block never drift far apart.
 * @returns {Array<[number, number]>} pairs of indices, -1 where a copy has nothing
 */
function alignRuns(a, b, band = ALIGN_BAND) {
  const n = a.length, m = b.length, width = 2 * band + 1, FAR = 0x7FFFFFFF;
  const cost = new Int32Array((n + 1) * width).fill(FAR);
  const step = new Int8Array((n + 1) * width);
  const cell = (i, j) => i * width + (j - i + band);
  const costAt = (i, j) => {
    const d = j - i + band;
    return (i < 0 || j < 0 || d < 0 || d >= width) ? FAR : cost[cell(i, j)];
  };
  cost[cell(0, 0)] = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = Math.max(0, i - band); j <= Math.min(m, i + band); j++) {
      if (!i && !j) continue;
      const same = i && j ? costAt(i - 1, j - 1) + (a[i - 1] === b[j - 1] ? 0 : 1) : FAR;
      const skipB = i ? costAt(i - 1, j) + 1 : FAR;       // a has a byte b lacks
      const skipA = j ? costAt(i, j - 1) + 1 : FAR;       // and the other way
      const best = Math.min(same, skipB, skipA);
      if (best >= FAR) continue;
      cost[cell(i, j)] = best;
      step[cell(i, j)] = best === same ? 0 : best === skipB ? 1 : 2;
    }
  }
  const path = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const took = costAt(i, j) >= FAR ? (i ? 1 : 2) : step[cell(i, j)];
    if (took === 0 && i && j) path.push([--i, --j]);
    else if (took === 1 && i) path.push([--i, -1]);
    else if (j) path.push([-1, --j]);
    else path.push([--i, -1]);
  }
  return path.reverse();
}

/**
 * One payload from two damaged readings of it. Where the copies agree there is
 * nothing to decide; where one has a byte the other lost, it supplies it; where
 * both have a byte and they differ, a byte that failed parity is the known-bad
 * one. The block's own checksum then says whether what came out is the file —
 * so a merge is either proved or thrown away. Both orders are tried, since
 * either copy may be the one holding the sounder bytes.
 */
function mergeCopies(a, b, size) {
  if (!a.bytes.length || !b.bytes.length) return null;
  const path = alignRuns(a.bytes, b.bytes);
  for (const [base, other, mine, theirs] of [[a, b, 0, 1], [b, a, 1, 0]]) {
    const out = [];
    for (const pair of path) {
      const x = pair[mine], y = pair[theirs];
      if (x < 0 && y < 0) continue;
      if (x < 0) out.push(other.bytes[y]);            // only this copy has it
      else if (y < 0) out.push(base.bytes[x]);
      else if (base.bad[x] && !other.bad[y]) out.push(other.bytes[y]);   // parity names the bad one
      else out.push(base.bytes[x]);
    }
    if (out.length > size && xor(out.slice(0, size)) === out[size]) return out.slice(0, size);
  }
  return null;
}

/** One byte as the KERNAL lays it down: marker, 8 bits LSB first, odd parity. */
function encodeByte(out, value) {
  out.push(LONG, MEDIUM);
  let parity = 1;
  for (let bit = 0; bit < 8; bit++) {
    const one = (value >> bit) & 1;
    parity ^= one;
    out.push(one ? MEDIUM : SHORT, one ? SHORT : MEDIUM);
  }
  out.push(parity ? MEDIUM : SHORT, parity ? SHORT : MEDIUM);
}

/** A whole block: countdown, payload, checksum, end marker, trailer. */
function encodeBlock(payload, sync = 0x09) {
  const out = [];
  for (let v = sync; v >= sync - 8; v--) encodeByte(out, v);
  for (const b of payload) encodeByte(out, b);
  encodeByte(out, xor(payload));
  out.push(LONG);
  for (let i = 0; i < TRAILER_PULSES; i++) out.push(SHORT);
  return out;                                   // TAP units, not cycles
}

/**
 * Mend what the tape can prove.
 * @param {Uint8Array} tap  a whole .tap, header and all
 * @returns {{ tap: Uint8Array, files: Array, repaired: string[], damaged: string[] }}
 */
export function repairTape(tap, { zeroGapCycles = V0_ZERO_GAP_CYCLES } = {}) {
  const result = { tap, files: [], repaired: [], damaged: [] };
  if (!tap || tap.length <= HEADER_SIZE) return result;
  const version = tap[12];
  const tapData = tap.subarray(HEADER_SIZE);
  if (!tapData.length || version === 2) return result;   // half-waves are not this format

  const pulses = pulseCycles(tapData, version, zeroGapCycles);
  const framed = frameBytes(pulses);
  const blocks = findBlocks(framed);
  const { bytes } = framed;

  // Header, its repeat, data, its repeat — the order the KERNAL writes them.
  const patches = [];
  for (let b = 0; b + 3 < blocks.length + 1; b++) {
    const head = bytes.slice(blocks[b].byte, blocks[b].byte + HEADER_BYTES);
    const type = head[0];
    if (type !== 1 && type !== 3 && type !== 4) continue;
    const start = head[1] | (head[2] << 8), end = head[3] | (head[4] << 8);
    if (end <= start || start < 0x0100) continue;
    if (xor(head) !== bytes[blocks[b].byte + HEADER_BYTES]) continue;
    let name = '';
    for (let i = 0; i < 16; i++) {
      const c = head[5 + i];
      if (c < 0x20) { name = ''; break; }
      name += String.fromCharCode(c);
    }
    name = name.replace(/ +$/, '');
    const size = end - start;

    // The data copies are the next two blocks along.
    const first = blocks[b + 2], repeat = blocks[b + 3];
    if (!first || !repeat) { result.files.push({ name, size, state: 'incomplete' }); continue; }
    const after = blocks[b + 4];
    const copy = blockRun(framed, first, size + 1, repeat.pulse);
    const echo = blockRun(framed, repeat, size + 1, after ? after.pulse : Infinity);
    const good = checksOut(copy, size), echoGood = checksOut(echo, size);

    if (good && !echoGood) {
      patches.push({ at: repeat.pulse, block: encodeBlock(copy.bytes.slice(0, size)), name });
      result.files.push({ name, size, state: 'repairable' });
      result.repaired.push(name);
      b += 3;
      continue;
    }
    if (good) { result.files.push({ name, size, state: 'good' }); b += 3; continue; }

    // Neither copy stands on its own. The KERNAL's own answer is that a byte
    // which fails parity is known bad and can be taken from the other pass, and
    // the block's checksum then says whether the result is right — so a merge
    // either adds up or is thrown away. Both directions are tried, since either
    // copy may be the one holding the sounder bytes.
    const merged = mergeCopies(copy, echo, size);
    if (merged) {
      // Both copies are written again, so the tape is sound from here on.
      patches.push({ at: first.pulse, block: encodeBlock(merged, 0x89), name });
      patches.push({ at: repeat.pulse, block: encodeBlock(merged), name });
      result.files.push({ name, size, state: 'merged' });
      result.repaired.push(name);
    } else {
      result.files.push({ name, size, state: 'damaged' });
      result.damaged.push(name);
    }
    b += 3;
  }
  if (!patches.length) return result;

  // Rewrite in place, one block for one block: the replacement is exactly as long
  // as a sound copy would have been, so whatever follows keeps its position. A
  // truncated copy leaves a little of the gap behind it overwritten, which is
  // silence either way.
  const bytesPerPulse = [];                     // pulse index → byte offset in tapData
  for (let p = 0, n = 0; p < tapData.length; n++) {
    bytesPerPulse[n] = p;
    p += tapData[p] !== 0 ? 1 : 4;
  }
  const out = [];
  let cursor = 0;                               // pulse index
  for (const patch of patches.sort((a, b) => a.at - b.at)) {
    if (patch.at < cursor) continue;
    for (let n = cursor; n < patch.at; n++) for (const b of tapBytesAt(tapData, bytesPerPulse[n])) out.push(b);
    for (const pulse of patch.block) out.push(pulse);   // spread would overflow the stack
    cursor = Math.min(patch.at + patch.block.length, bytesPerPulse.length);
  }
  for (let n = cursor; n < bytesPerPulse.length; n++) for (const b of tapBytesAt(tapData, bytesPerPulse[n])) out.push(b);

  const mended = new Uint8Array(HEADER_SIZE + out.length);
  mended.set(tap.subarray(0, HEADER_SIZE));
  mended[16] = out.length & 0xFF;
  mended[17] = (out.length >> 8) & 0xFF;
  mended[18] = (out.length >> 16) & 0xFF;
  mended[19] = (out.length >>> 24) & 0xFF;
  mended.set(out, HEADER_SIZE);
  result.tap = mended;
  return result;
}

/** The bytes of one entry, be it a plain step or a 24-bit long form. */
function tapBytesAt(data, off) {
  if (data[off] !== 0) return [data[off]];
  return [0, data[off + 1], data[off + 2], data[off + 3]];
}
