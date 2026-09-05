// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// cli/formats.mjs — what kind of file is this, read off the bytes so a user
// never has to name a format. Magic strings first; a .d64 has none, so its
// exact byte length is the test (d64Variant); a .prg has nothing at all, so it
// is the fallback for anything small enough to fit a C64's memory.

import { d64Variant } from './core.mjs';

const ascii = (bytes, at, s) => {
  for (let i = 0; i < s.length; i++) if (bytes[at + i] !== s.charCodeAt(i)) return false;
  return true;
};

/**
 * @param {Uint8Array} bytes
 * @param {string} filename  only consulted for the extension, and only after
 *   every magic has failed — a renamed file should still be what it is
 * @returns {'tap'|'wav'|'dmp'|'crt'|'d64'|'t64'|'prg'|'unknown'}
 */
export function sniff(bytes, filename = '') {
  if (bytes.length >= 12 && ascii(bytes, 0, 'C64-TAPE-RAW')) return 'tap';
  if (bytes.length >= 12 && ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WAVE')) return 'wav';
  if (bytes.length >= 12 && ascii(bytes, 0, 'DC2N-TAP-RAW')) return 'dmp';
  if (bytes.length >= 16 && ascii(bytes, 0, 'C64 CARTRIDGE   ')) return 'crt';
  // A .t64 signs itself in prose ("C64 tape image file", "C64S tape file", …)
  // and the wordings vary, so the prefix plus a directory that could hold at
  // least one entry is the test. The .tap and .crt magics above go first: both
  // begin with the same three letters.
  if (bytes.length >= 96 && ascii(bytes, 0, 'C64') && (bytes[34] | (bytes[35] << 8)) > 0) return 't64';
  if (d64Variant(bytes.length)) return 'd64';
  if (/\.prg$/i.test(filename)) return 'prg';
  // A load address and data that fits below $10000 is all a .prg is.
  if (bytes.length >= 2 && bytes.length <= 65538) {
    const addr = bytes[0] | (bytes[1] << 8);
    if (addr + bytes.length - 2 <= 0x10000) return 'prg';
  }
  return 'unknown';
}

export const KIND_NAMES = {
  tap: 'tape image',
  wav: 'audio recording',
  dmp: 'DC2N tape dump',
  crt: 'cartridge image',
  d64: 'disk image',
  t64: 'tape archive',
  prg: 'program file',
  unknown: 'not a C64 file this tool knows',
};

/**
 * The SYS target in a BASIC stub, so any .prg entry works, not just SYS 2064 —
 * and so a cartridge knows where to jump.
 * @param {Uint8Array} prg  load address then data
 * @returns {number|null}   the address, or null for a program with no SYS
 */
export function sysTarget(prg) {
  for (let i = 2; i < Math.min(prg.length, 64); i++) {
    if (prg[i] !== 0x9E) continue;
    let j = i + 1;
    while (j < prg.length && prg[j] === 0x20) j++;
    let n = 0, any = false;
    while (j < prg.length && prg[j] >= 0x30 && prg[j] <= 0x39) {
      n = n * 10 + (prg[j] - 0x30); j++; any = true;
    }
    if (any) return n;
  }
  return null;
}
