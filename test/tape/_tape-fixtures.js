// Shared Turbo Tape 64 fixtures for the tape spec tests: a file as the format
// writes it, and the TAP <-> pulse conversions the tests read results through.
import { renderTurboTape64Block } from '../../src/media/tap-turbo-formats.js';

export const ZERO = 216, ONE = 328;            // what Turbo Tape 64 writes

export const bitsOf = (out, v) => { for (let k = 7; k >= 0; k--) out.push((v >> k) & 1 ? ONE : ZERO); };
export const leadIn = n => { const out = []; for (let i = 0; i < n; i++) bitsOf(out, 0x02); return out; };
export const withSum = bytes => { let x = 0; for (const b of bytes) x ^= b; return [...bytes, x]; };
export const body = n => Array.from({ length: n }, (_, i) => (i * 37 + (i >> 3)) & 0xFF);

/**
 * One file as the format writes it: a header block, a gap, the data block, then
 * `tail` cycles of nothing before whatever comes next.
 * @returns {{ name: string, data: number[], pulses: number[] }} data = payload + checksum
 */
export function turboFile(name, start, payload, { tail = 500000 } = {}) {
  const end = start + payload.length - 1;          // the payload runs to it inclusive
  const padded = (name + '                ').slice(0, 16);
  const header = withSum([1, start & 255, start >> 8, end & 255, end >> 8, 0,
    ...[...padded].map(c => c.charCodeAt(0))]);
  return {
    name, data: withSum(payload),
    pulses: [
      ...leadIn(200), ...renderTurboTape64Block(header, { zero: ZERO, one: ONE }),
      40000,
      ...leadIn(200), ...renderTurboTape64Block(withSum(payload), { zero: ZERO, one: ONE }),
      tail,
    ],
  };
}

/** TAP v1 body bytes for pulse lengths in cycles (the `0` escape for long ones). */
export function tapBytesOf(cycles) {
  const out = [];
  for (const c of cycles) {
    const step = Math.round(c / 8);
    if (step >= 1 && step <= 255) out.push(step);
    else out.push(0, c & 255, (c >> 8) & 255, (c >> 16) & 255);
  }
  return new Uint8Array(out);
}

/** Pulse lengths in cycles of a .tap image with its 20-byte header. */
export function pulsesOf(tap) {
  const d = tap.subarray(20), out = [];
  for (let p = 0; p < d.length;) {
    const b = d[p++];
    out.push(b ? b * 8 : (d[p++] | (d[p++] << 8) | (d[p++] << 16)));
  }
  return out;
}

// The KERNAL's three pulses, in cycles: TAP values $30, $42 and $56.
export const KERNAL = { S: 0x30 * 8, M: 0x42 * 8, L: 0x56 * 8 };

/** One byte as the KERNAL writes it: a byte marker, eight bits LSB first, odd parity. */
function kernalByte(out, value) {
  out.push(KERNAL.L, KERNAL.M);
  let parity = 1;
  for (let bit = 0; bit < 8; bit++) {
    const one = (value >> bit) & 1;
    parity ^= one;
    out.push(...(one ? [KERNAL.M, KERNAL.S] : [KERNAL.S, KERNAL.M]));
  }
  out.push(...(parity ? [KERNAL.M, KERNAL.S] : [KERNAL.S, KERNAL.M]));
}

/** A block: pilot, countdown from `sync`, the bytes, their XOR, end marker, trailer. */
function kernalBlock(out, bytes, pilot, sync) {
  for (let i = 0; i < pilot; i++) out.push(KERNAL.S);
  for (let v = sync; v >= sync - 8; v--) kernalByte(out, v);
  let sum = 0;
  for (const b of bytes) { sum ^= b; kernalByte(out, b); }
  kernalByte(out, sum);
  out.push(KERNAL.L);
  for (let i = 0; i < 60; i++) out.push(KERNAL.S);
}

/**
 * A program as the KERNAL saves it: header and its repeat, data and its repeat.
 * `lose` cuts that many bytes, and the end marker, off the data's repeat — a
 * transfer that clips the tail of the last block.
 * @returns {number[]} pulse widths in cycles
 */
export function kernalFile(name, start, payload, { lose = 0, tail = 500000 } = {}) {
  const header = new Array(192).fill(0x20);
  const end = start + payload.length;
  header.splice(0, 5, 0x03, start & 255, start >> 8, end & 255, end >> 8);
  for (let i = 0; i < name.length; i++) header[5 + i] = name.charCodeAt(i);
  const out = [];
  kernalBlock(out, header, 600, 0x89);
  kernalBlock(out, header, 200, 0x09);
  kernalBlock(out, payload, 200, 0x89);
  const repeat = [];
  kernalBlock(repeat, lose ? payload.slice(0, payload.length - lose) : payload, 200, 0x09);
  if (lose) repeat.length -= 62;                 // its end marker and trailer go too
  out.push(...repeat, tail);
  return out;
}
