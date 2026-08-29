// Shared Turbo Tape 64 fixtures for the tape spec tests: a file as the format
// writes it, and the TAP <-> pulse conversions the tests read results through.
import { renderTurboTape64Block } from '../src/tap-turbo-formats.js';

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
