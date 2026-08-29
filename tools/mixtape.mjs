// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// A tape to photograph: "80s mixtape", built here rather than shipped.
//
// The User Guide needs a tape listing with something on it — several files, both
// formats, and one the tape lost part of — and no real cassette can be committed
// to this repo. So the pulses are written the way a C64 and a turbo loader write
// them, which also means the guide's screenshot is of the real reader reading a
// real tape rather than of a mock-up.
//
// KERNAL format per the documented CBM tape encoding; Turbo Tape 64 per its
// published description, at the widths measured off tapes it wrote. Both are
// described in docs/DATASETTE-ARCHITECTURE.md.

const UNIT = 8;
const CBM = { S: 0x30, M: 0x42, L: 0x56 };      // TAP units
const TURBO = { zero: 0x1B, one: 0x29 };        // 216 / 328 cycles
const PAL_CPU_HZ = 985248;

// ── The KERNAL's own format ──────────────────────────────────────────────────

function cbmByte(out, value) {
  out.push(CBM.L, CBM.M);
  let parity = 1;
  for (let bit = 0; bit < 8; bit++) {
    const one = (value >> bit) & 1;
    parity ^= one;
    out.push(one ? CBM.M : CBM.S, one ? CBM.S : CBM.M);
  }
  out.push(parity ? CBM.M : CBM.S, parity ? CBM.S : CBM.M);
}

function cbmBlock(out, payload, pilot, sync) {
  for (let i = 0; i < pilot; i++) out.push(CBM.S);
  for (let v = sync; v >= sync - 8; v--) cbmByte(out, v);
  let sum = 0;
  for (const b of payload) { sum ^= b; cbmByte(out, b); }
  cbmByte(out, sum);
  out.push(CBM.L);
  for (let i = 0; i < 60; i++) out.push(CBM.S);
}

function cbmFile(out, { name, start, body, pilot }) {
  const header = new Uint8Array(192).fill(0x20);
  const end = start + body.length;
  header[0] = 0x03;
  header[1] = start & 0xFF; header[2] = start >> 8;
  header[3] = end & 0xFF;   header[4] = end >> 8;
  for (let i = 0; i < Math.min(16, name.length); i++) header[5 + i] = name.charCodeAt(i);
  cbmBlock(out, header, pilot, 0x89);
  cbmBlock(out, header, 200, 0x09);
  cbmBlock(out, body, 1500, 0x89);
  cbmBlock(out, body, 200, 0x09);
}

// ── Turbo Tape 64 ────────────────────────────────────────────────────────────

const turboByte = (out, value) => {
  for (let bit = 7; bit >= 0; bit--) out.push((value >> bit) & 1 ? TURBO.one : TURBO.zero);
};

function turboBlock(out, payload, pilot) {
  for (let i = 0; i < pilot; i++) turboByte(out, 0x02);      // the lead-in it listens for
  for (let v = 9; v >= 1; v--) turboByte(out, v);
  let sum = 0;
  for (const b of payload) { sum ^= b; turboByte(out, b); }
  turboByte(out, sum);
}

function turboFile(out, { name, start, body, damage }) {
  const header = new Uint8Array(192).fill(0x20);
  const end = start + body.length - 1;      // the end address is inclusive
  header[0] = 0x01;
  header[1] = start & 0xFF; header[2] = start >> 8;
  header[3] = end & 0xFF;   header[4] = end >> 8;
  for (let i = 0; i < Math.min(16, name.length); i++) header[6 + i] = name.charCodeAt(i);
  turboBlock(out, header, 900);
  const at = out.length;
  turboBlock(out, body, 900);
  // A tape that lost a moment of signal: the pulses of some sixty bits gone, and
  // a hole where they were. A turbo file is written once, so this is the kind of
  // damage nothing can mend — which is the point of having one here.
  if (damage) {
    const hole = at + 900 * 8 + 72 + damage * 8;
    out.splice(hole, 60, 0, 0x40, 0x1F, 0x00);      // a v1 long pulse: ~8k cycles
  }
}

// ── The tape ─────────────────────────────────────────────────────────────────

const SILENCE = [0, 0x00, 0x30, 0x00];             // ~12k cycles between files

/** Plausible-looking program bytes — a tape listing shows sizes, not contents. */
function filler(size, seed) {
  const b = new Uint8Array(size);
  let x = seed;
  for (let i = 0; i < size; i++) { x = (x * 1103515245 + 12345) & 0x7FFFFFFF; b[i] = (x >> 16) & 0xFF; }
  return b;
}

const TAPE = [
  { kind: 'cbm',   name: 'BOULDER DASH',     start: 0x0801, size: 3600 },
  { kind: 'turbo', name: 'SUMMER GAMES',     start: 0x0801, size: 38000 },
  { kind: 'turbo', name: 'WIZBALL',          start: 0x0801, size: 42000 },
  { kind: 'turbo', name: 'GHOSTS N GOBLIN',  start: 0x0801, size: 36000, damage: 14200 },
  { kind: 'turbo', name: 'PARADROID',        start: 0x0801, size: 33000 },
  { kind: 'turbo', name: 'MONTY ON THE RUN', start: 0x0801, size: 31000 },
  { kind: 'cbm',   name: 'LAST NINJA',       start: 0x0801, size: 5200 },
];

/**
 * @returns {Uint8Array} a v1 .tap holding the mixtape
 */
export function buildMixtape() {
  const out = [];
  let seed = 7;
  for (const f of TAPE) {
    out.push(...SILENCE);
    const body = filler(f.size, seed += 101);
    if (f.kind === 'cbm') cbmFile(out, { ...f, body, pilot: 8000 });
    else turboFile(out, { ...f, body });
  }
  out.push(...SILENCE);

  const tap = new Uint8Array(20 + out.length);
  const magic = 'C64-TAPE-RAW';
  for (let i = 0; i < magic.length; i++) tap[i] = magic.charCodeAt(i);
  tap[12] = 1;
  tap[16] = out.length & 0xFF;
  tap[17] = (out.length >> 8) & 0xFF;
  tap[18] = (out.length >> 16) & 0xFF;
  tap[19] = (out.length >>> 24) & 0xFF;
  tap.set(out, 20);
  return tap;
}

/** Roughly how long it plays, for a sanity check when generating. */
export function mixtapeSeconds(tap) {
  let cycles = 0;
  const d = tap.subarray(20);
  for (let p = 0; p < d.length;) {
    const b = d[p++];
    if (b) cycles += b * UNIT;
    else { cycles += d[p] | (d[p + 1] << 8) | (d[p + 2] << 16); p += 3; }
  }
  return cycles / PAL_CPU_HZ;
}
