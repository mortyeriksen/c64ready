// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// cli/core.mjs — the one file that knows where the c64ready sources live.
//
// Every sibling import is funneled through here, so moving the CLI into the
// c64ready repo repoints a single file. The emulator is behind loadMachine()
// rather than a static export: it drags in the whole machine graph, and a
// listing has no business paying for that at startup.

export { wavToTap, wavReader } from '../src/wav-tape.js';
export { importProgress } from '../src/wav-import.js';
export { encodeTap } from '../src/tap-encode.js';
export { tapToPcm, pcmToWav, PAL_CPU_HZ } from '../src/tap-audio.js';
export { tapDirectory, tapeFacts } from '../src/tap-directory.js';
export { repairTape } from '../src/tap-repair.js';
export { dmpToTap } from '../src/dmp-tape.js';
export {
  D64, createBlankD64, createPRGDisk, d64Variant, diskNameFromFilename,
  prgOverflow,
} from '../src/d64.js';
export { parseCRT } from '../src/crt.js';
export { TURBO_FORMATS } from '../src/tap-turbo-formats.js';
export { pickViceRoms } from '../src/roms.js';

import { wavToTap } from '../src/wav-tape.js';
import { repairTape } from '../src/tap-repair.js';
import { tapDirectory } from '../src/tap-directory.js';

/** The machine, loaded only when a command actually boots one. */
export async function loadMachine() {
  const [{ C64Machine }, { CANVAS_W, CANVAS_H }] = await Promise.all([
    import('../src/machine.js'),
    import('../src/vic2.js'),
  ]);
  return { C64Machine, CANVAS_W, CANVAS_H };
}

export const NTSC_CPU_HZ = 1022727;

const TAP_HEADER_SIZE = 20;

/**
 * The one place a .tap is split into header and pulse data. repairTape takes
 * the whole file; tapDirectory, tapeFacts and tapToPcm take the data with the
 * version read from the header — mixing those up is the likeliest bug in the
 * tool, so nothing else slices a tap.
 * @param {Uint8Array} tap  a whole .tap file
 * @returns {{ data: Uint8Array, version: number }}
 */
export function splitTap(tap) {
  if (!tap || tap.length <= TAP_HEADER_SIZE) throw new Error('.tap file is empty');
  return { data: tap.subarray(TAP_HEADER_SIZE), version: tap[12] };
}

import { PAL_CPU_HZ, V0_ZERO_GAP_CYCLES } from '../src/tap-audio.js';

/** How long the tape plays, off its own pulse stream. */
export function tapSeconds(data, version) {
  let cycles = 0;
  for (let p = 0; p < data.length;) {
    const b = data[p++];
    if (b !== 0) { cycles += b * 8; continue; }
    if (version === 0) { cycles += 2048; continue; }
    if (p + 2 >= data.length) break;
    cycles += data[p++] | (data[p++] << 8) | (data[p++] << 16);
  }
  return cycles / PAL_CPU_HZ;
}

/**
 * Several tapes joined into one, the recordings back to back. No pulse is
 * invented at a seam: each tape keeps its own lead-in, the way a deck that was
 * stopped and started again left it.
 *
 * The versions must agree on what a byte means before their bytes can share a
 * file. One version throughout is copied verbatim. A v0 tape joining a v1 tape
 * is respelled: a v0 zero byte says only "longer than a byte can hold", every
 * reader here settles it at V0_ZERO_GAP_CYCLES, and writing that same value in
 * v1's long form reads back identically — by construction, not by luck. A v2
 * tape counts half waves where v0 and v1 count whole ones, so it joins only
 * its own kind.
 * @param {Array<{data: Uint8Array, version: number}>} taps  splitTap results,
 *   in the order they should play
 * @returns {{ tap: Uint8Array, version: number, respelled: number }}
 */
export function concatTaps(taps) {
  const versions = new Set(taps.map(t => t.version));
  if (versions.has(2) && versions.size > 1) {
    throw new Error('a v2 tape counts half waves where v0 and v1 count whole ones — they cannot share a file');
  }
  const version = versions.size === 1 ? taps[0].version : 1;
  let respelled = 0;
  const parts = taps.map(t => {
    if (t.version === version) return t.data;
    respelled++;
    const out = [];
    for (const b of t.data) {
      if (b !== 0) { out.push(b); continue; }
      out.push(0, V0_ZERO_GAP_CYCLES & 0xFF, (V0_ZERO_GAP_CYCLES >> 8) & 0xFF, (V0_ZERO_GAP_CYCLES >> 16) & 0xFF);
    }
    return Uint8Array.from(out);
  });
  const size = parts.reduce((n, d) => n + d.length, 0);
  const tap = new Uint8Array(TAP_HEADER_SIZE + size);
  const magic = 'C64-TAPE-RAW';
  for (let i = 0; i < magic.length; i++) tap[i] = magic.charCodeAt(i);
  tap[12] = version;
  tap[16] = size & 0xFF; tap[17] = (size >> 8) & 0xFF;
  tap[18] = (size >> 16) & 0xFF; tap[19] = (size >> 24) & 0xFF;
  let at = TAP_HEADER_SIZE;
  for (const d of parts) { tap.set(d, at); at += d.length; }
  return { tap, version, respelled };
}

/**
 * A recording turned into a repaired, listed tape — the same steps the app's
 * import takes (src/wav-import.js importInline), done here so the sibling
 * needs no export it does not already have.
 */
export function importWavSync(bytes, { onProgress = () => {}, ...opts } = {}) {
  const { tap, seconds, mended, unconfirmed } = wavToTap(bytes, { onProgress, ...opts });
  onProgress('directory', 0);
  const fixed = opts.repair === false ? { tap, repaired: [] } : repairTape(tap);
  const { data, version } = splitTap(fixed.tap);
  const files = tapDirectory(data, { version });
  return {
    tap: fixed.tap, seconds, files,
    repaired: [...mended, ...fixed.repaired], unconfirmed,
  };
}
