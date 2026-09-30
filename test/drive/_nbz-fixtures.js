// test/drive/_nbz-fixtures.js
//
// Nibbler dumps built from the NIB layout (nibtools fileio.c) and the .nbz
// LZ77 stream (Basic Compression Library), never through src/media/nib.js.

export const NIB_TRACK = 0x2000;

/** An 8 KB read of `revolution`, begun `offset` bytes in and going round. */
export function rawRead(revolution, offset = 0) {
  const raw = new Uint8Array(NIB_TRACK);
  for (let i = 0; i < NIB_TRACK; i++) raw[i] = revolution[(offset + i) % revolution.length];
  return raw;
}

/** @param {Array<{ halfTrack: number, zone: number, raw: Uint8Array }>} entries */
export function buildNib(entries, { version = 3 } = {}) {
  const out = new Uint8Array(0x100 + entries.length * NIB_TRACK);
  out.set([...'MNIB-1541-RAW'].map(c => c.charCodeAt(0)), 0);
  out[13] = version;
  entries.forEach((e, i) => {
    out[0x10 + i * 2] = e.halfTrack;
    out[0x10 + i * 2 + 1] = e.zone;
    out.set(e.raw, 0x100 + i * NIB_TRACK);
  });
  return out;
}

// 7 bits a byte, most significant group first, the top bit set on all but the last.
function varSize(value) {
  const groups = [];
  do { groups.unshift(value % 128); value = Math.floor(value / 128); } while (value > 0);
  return groups.map((g, i) => (i < groups.length - 1 ? 0x80 : 0) | g);
}

/** A run's first byte is a literal, the rest a copy from one byte back; all
 *  else is literal, the marker escaped. The marker is the least common value. */
export function lzCompress(bytes, { minRun = 8 } = {}) {
  const counts = new Array(256).fill(0);
  for (const b of bytes) counts[b]++;
  let marker = 0;
  for (let v = 1; v < 256; v++) if (counts[v] < counts[marker]) marker = v;
  const out = [marker];
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    let run = 1;
    while (i + run < bytes.length && bytes[i + run] === b) run++;
    if (b === marker) out.push(marker, 0); else out.push(b);
    if (run >= minRun) { out.push(marker, ...varSize(run - 1), ...varSize(1)); i += run; }
    else i++;
  }
  return Uint8Array.from(out);
}
