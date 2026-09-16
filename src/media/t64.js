// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/media/t64.js – The .t64 archive, read.
//
// A .t64 is not a tape. It is an archive of decoded files, each a name, a load
// address, a length and its bytes, with no signal in it at all: the format came
// out of an emulator, and only the word "tape" in its name came from cassettes.
// So an entry is already a .prg, which is what this hands back, and nothing
// here plays or encodes anything.
//
// The format is simple and the files in the wild are sloppy, in two well known
// ways this reads around rather than trips over. The used-entries count is
// often zero on an archive holding one file, so entries are believed over the
// count: every slot whose type says a file is there is a file. And the end
// address is often wrong, zero or short, so a file's length is measured against
// the bytes the container actually holds, and the directory's claim is only
// taken where the container can honour it. Where the two disagree the entry
// carries a note rather than a length the archive never held.

const HEADER = 64, ENTRY = 32;
const word = (b, at) => b[at] | (b[at + 1] << 8);
const long = (b, at) => word(b, at) | (word(b, at + 2) << 16);
const text = (b, at, n) => {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[at + i]);
  return s.replace(/[\s\x00\xA0]+$/, '');
};


const ascii = (b, at, s) => {
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
};

/**
 * Whether these bytes are a .t64. The archive signs itself in prose ("C64 tape
 * image file", "C64S tape file", and other wordings), so the test is that
 * prefix plus a directory with room for at least one entry. Two other formats
 * open with the same three letters and are ruled out first, or a cartridge
 * would read as an archive of nonsense.
 * @param {Uint8Array} b
 */
export function isT64(b) {
  if (!b || b.length < 96) return false;
  if (ascii(b, 0, 'C64-TAPE-RAW') || ascii(b, 0, 'C64 CARTRIDGE   ')) return false;
  return ascii(b, 0, 'C64') && (b[34] | (b[35] << 8)) > 0;
}

/**
 * The files in a .t64, each as { name, start, end, bytes, note } — bytes are a
 * ready .prg, load address first. Entries that are not files (a freed slot, a
 * memory snapshot) are returned under `skipped` with the reason.
 * @param {Uint8Array} b  the whole archive
 */
export function t64Files(b) {
  if (!isT64(b)) throw new Error('This is not a .t64 archive.');
  const max = word(b, 34);
  const files = [], skipped = [];
  // Data ends where the next entry's data begins, whatever the directory
  // claims: offsets are collected first so an out-of-order directory still
  // measures each file against the container.
  const offsets = [];
  for (let i = 0; i < max; i++) {
    const at = HEADER + i * ENTRY;
    if (b[at] === 1) offsets.push(long(b, at + 8));
  }
  offsets.sort((x, y) => x - y);

  for (let i = 0; i < max; i++) {
    const at = HEADER + i * ENTRY;
    const type = b[at];
    if (type === 0) continue;                       // a freed slot is nothing
    const name = text(b, at + 16, 16) || `(entry ${i + 1})`;
    if (type !== 1) {
      skipped.push({ name, why: type === 3 ? 'a memory snapshot, not a file' : `unknown entry type ${type}` });
      continue;
    }
    const start = word(b, at + 2);
    const offset = long(b, at + 8);
    if (offset >= b.length) { skipped.push({ name, why: 'its data lies past the end of the archive' }); continue; }
    const held = (offsets.find(o => o > offset) ?? b.length) - offset;
    // An end address at or below the start is the broken-in-the-wild case, not
    // a wrapped claim of nearly 64K: it claims nothing, and the container
    // decides alone.
    const claimed = Math.max(0, word(b, at + 4) - start);
    // The claim is taken where the container can honour it; the container
    // decides otherwise. A zero claim is the common broken case.
    const size = Math.min(claimed > 0 ? Math.min(claimed, held) : held, 0x10000 - start);
    const bytes = new Uint8Array(2 + size);
    bytes[0] = start & 0xFF;
    bytes[1] = (start >> 8) & 0xFF;
    bytes.set(b.subarray(offset, offset + size), 2);
    files.push({
      name, start, end: start + size, bytes,
      note: claimed > 0 && claimed !== size ? `directory claims ${claimed} bytes, the archive holds ${size}` : null,
    });
  }
  return { name: text(b, 40, 24), files, skipped };
}
