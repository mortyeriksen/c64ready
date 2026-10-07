// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/media/dmp-tape.js – A DC2N tape dump, read in as a tape.
//
// Luigi Di Fraia's DC2N sits on the cassette port and counts its own clock
// between the READ line's edges, so a .dmp is the tape as the port saw it: one
// integer per pulse in ticks of a 2 MHz counter, no audio to decode and nothing
// to guess. Turning it into a .tap is a change of clock and of container.
// Format per Di Fraia's DC2N documentation (see SPECIFICATIONS.md).
import { PAL_CPU_HZ } from './tap-audio.js';
import { encodeTap } from './tap-encode.js';
import { repairTape } from './tap-repair.js';
import { cleanTurboTape64 } from './wav-tape.js';

const MAGIC = 'DC2N-TAP-RAW';
const HEADER_SIZE = 20;
const MACHINES = ['C64', 'VIC 20', 'C16'];

/**
 * @param {Uint8Array} bytes  a DC2N dump, version 0 or 1
 * @returns {{ tap: Uint8Array, pulses: number, seconds: number, machine: string,
 *   video: string, sampleRate: number }}  the tape, and what the dump said it
 *   was taken from
 */
export function dmpToTap(bytes) {
  const { pulses, halfWaves, ...about } = dumpPulses(bytes);
  return { tap: encodeTap(pulses, { version: halfWaves ? 2 : 1 }), pulses: pulses.length, ...about };
}

/**
 * A dump made into the tape a loader is best handed, the way a recording is:
 * Turbo Tape 64 blocks whose checksums pass written back clean, then the
 * KERNAL's damaged copies rebuilt from the copy that checks out. There is no
 * recording to read again, so nothing is mended from a second reading. A dump
 * of half-waves is neither format's shape and comes through as it was.
 * @param {Uint8Array} bytes  a DC2N dump
 * @param {{ clean?: boolean, repair?: boolean }} opts  either step can be left out
 * @returns {{ tap: Uint8Array, pulses: number, seconds: number, machine: string,
 *   video: string, sampleRate: number, repaired: string[] }}  `repaired` names
 *   the KERNAL files rebuilt
 */
export function restoreDump(bytes, { clean = true, repair = true } = {}) {
  const { pulses, halfWaves, ...about } = dumpPulses(bytes);
  if (halfWaves) {
    return { tap: encodeTap(pulses, { version: 2 }), pulses: pulses.length, ...about, repaired: [] };
  }
  const widths = clean ? cleanTurboTape64(pulses).pulses : pulses;
  const tap = encodeTap(widths, { version: 1 });
  const fixed = repair ? repairTape(tap) : { tap, repaired: [] };
  return { tap: fixed.tap, pulses: pulses.length, ...about, repaired: fixed.repaired };
}

/** The pulses a dump holds, in cycles, and what its header says. */
function dumpPulses(bytes) {
  if (bytes.length < HEADER_SIZE) throw new Error('Not a DC2N dump');
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC.charCodeAt(i)) throw new Error('Not a DC2N dump');
  }
  const version = bytes[12];
  if (version > 1) throw new Error(`Unsupported DC2N dump version (${version})`);
  const machine = MACHINES[bytes[13] & 0x0F];
  if (!machine) throw new Error(`Unknown machine in DC2N dump (${bytes[13] & 0x0F})`);
  const video = bytes[14] === 1 ? 'NTSC' : 'PAL';
  // Version 1 puts flags in the top of the machine byte. Bit 5 says every half
  // wave was kept rather than every full one, which is the shape of a v2 .tap.
  const halfWaves = version === 1 && (bytes[13] & 0x20) !== 0;
  const bits = bytes[15];
  if (!bits || bits % 8 || bits > 32) throw new Error(`Unsupported DC2N sample size (${bits}-bit)`);
  const rate = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16, true);
  if (!rate) throw new Error('DC2N dump has no counter rate');

  // Ticks to cycles at the clock the deck here plays at: what has to survive is
  // the pulse's real duration, and a VIC 20's pulse lasts as long on a C64's
  // port as it did on its own. A sample at the maximum is an overflow — the
  // pulse goes on into the next sample, and the next, until one is below it.
  const perTick = PAL_CPU_HZ / rate;
  const width = bits >> 3, max = 2 ** bits - 1;
  const pulses = [];
  let acc = 0;
  for (let p = HEADER_SIZE; p + width <= bytes.length; p += width) {
    let v = 0;
    for (let k = width - 1; k >= 0; k--) v = v * 256 + bytes[p + k];
    acc += v;
    if (v === max) continue;
    pulses.push(acc * perTick);
    acc = 0;
  }
  if (acc) pulses.push(acc * perTick);

  let total = 0;
  for (const c of pulses) total += c;
  return { pulses, halfWaves, seconds: total / PAL_CPU_HZ, machine, video, sampleRate: rate };
}
