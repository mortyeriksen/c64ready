// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/tap-encode.js – Pulse widths, in cycles, written out as a .tap.
//
// Shared by everything that arrives at a list of pulses rather than a tape — a
// recording read back, a DC2N dump — so the container is written one way.
// Follows Peter Schepers' TAP (Raw tape image) description: a byte per pulse
// in steps of 8 cycles, and the 0 + three-byte escape for anything longer, so a
// silence survives intact instead of being clipped.

const TAP_MAGIC = 'C64-TAPE-RAW';
const HEADER_SIZE = 20;

// Pulses outside this are not tape data — a lead-in silence, a dropout, or the
// end of the recording. They still have to be represented, as a long gap.
const MIN_PULSE_CYCLES = 32;
const MAX_LONG_CYCLES = 0xFFFFFF;      // all a long-form pulse can hold

/**
 * @param {number[]} pulses  widths in cycles; a full wave each for v1, a half
 *   wave each for v2
 * @param {object} opts
 * @param {number} opts.version  1 or 2
 * @returns {Uint8Array} the .tap, header included
 */
export function encodeTap(pulses, { version = 1 } = {}) {
  const out = [];
  for (let i = 0; i < pulses.length; i++) {
    let c = Math.max(MIN_PULSE_CYCLES, Math.round(pulses[i]));
    const step = Math.round(c / 8);
    if (step >= 1 && step <= 255) { out.push(step); continue; }
    // The escape carries 24 bits — 17 seconds — and a transfer can hold a longer
    // silence than that between one side's files. Written as several, the tape
    // keeps its length; wrapped, it would lose sixteen seconds a time.
    while (c > MAX_LONG_CYCLES) {
      out.push(0, 0xFF, 0xFF, 0xFF);
      c -= MAX_LONG_CYCLES;
    }
    out.push(0, c & 0xFF, (c >> 8) & 0xFF, (c >> 16) & 0xFF);
  }

  const tap = new Uint8Array(HEADER_SIZE + out.length);
  for (let i = 0; i < TAP_MAGIC.length; i++) tap[i] = TAP_MAGIC.charCodeAt(i);
  tap[12] = version;
  tap[13] = tap[14] = tap[15] = 0;               // reserved
  tap[16] = out.length & 0xFF;
  tap[17] = (out.length >> 8) & 0xFF;
  tap[18] = (out.length >> 16) & 0xFF;
  tap[19] = (out.length >> 24) & 0xFF;
  tap.set(out, HEADER_SIZE);
  return tap;
}
