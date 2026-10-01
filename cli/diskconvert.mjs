// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
import fs from 'node:fs';
import { parseArgs, inputFiles, UsageError } from './args.mjs';
import { openDisk } from './disk.mjs';
import { createBlankD81 } from './core.mjs';
import { outFileFor, oneOutputOnly, writeOut } from './tape.mjs';
import { say, fail } from './report.mjs';

// Conversion follows file chains; it cannot preserve physical sector loaders.
export function disk2d81(argv) {
  const { args, flags } = parseArgs(argv, { out: { value: true, alias: 'o' }, 'out-dir': { value: true } });
  if (!args.length) throw new UsageError('Usage: c64rdy disk2d81 <disk…> [-o out.d81]');
  const inputs = inputFiles(args);
  oneOutputOnly(flags, inputs.length);
  let failed = false;
  for (const input of inputs) {
    try {
      const source = openDisk(input, { write: false });
      if (!['d64', 'd71'].includes(source.kind)) throw new Error('this command requires a D64 or D71 image');
      const target = convertDisk(source);
      const out = outFileFor(input, '.d81', flags);
      if (fs.existsSync(out) && fs.statSync(out).ino === fs.statSync(input).ino &&
          fs.statSync(out).dev === fs.statSync(input).dev) throw new Error('output must not replace the input image');
      writeOut(out, target.img, flags);
      say(`${input} → ${out} (${target.entries.length} files)`);
    } catch (e) { fail(`${input}: ${e.message}`); failed = true; }
  }
  return failed ? 1 : 0;
}

function convertDisk(source) {
  const target = createBlankD81(source.diskName, source.diskId);
  const used = new Set();
  function sector(track, index) {
    const key = track * 256 + index;
    const bytes = source.readSector(track, index);
    if (!bytes || used.has(key)) throw new Error('invalid, looping or shared sector chain');
    if (source.errorForSector(track, index) !== 1) throw new Error('source sector has a disk error');
    used.add(key);
    return bytes;
  }
  // Retain PETSCII header bytes without text normalization.
  const header = sector(18, 0);
  const outHeader = target.readSector(40, 0);
  outHeader.set(header.subarray(0x90, 0xA0), 4);
  const id = header.subarray(0xA2, 0xA4);
  outHeader.set(id, 0x16);
  for (const bam of [1, 2]) target.readSector(40, bam).set(id, 4);
  let dt = 18, ds = 1;
  while (dt) {
    const dir = sector(dt, ds);
    for (let slot = 0; slot < 8; slot++) {
      const off = slot * 32, raw = dir[off + 2], type = raw & 7;
      if (!type) continue;
      if (![1, 2, 3].includes(type)) throw new Error('only PRG, SEQ and USR files can be converted');
      if (!(raw & 0x80)) throw new Error('unclosed files cannot be converted');
      const name = String.fromCharCode(...dir.subarray(off + 5, off + 21));
      let t = dir[off + 3], s = dir[off + 4];
      if (!t) throw new Error('file has no data chain');
      const parts = [];
      while (t) {
        const bytes = sector(t, s);
        if (!bytes[0] && !bytes[1]) throw new Error('invalid final-sector byte count');
        parts.push(bytes.subarray(2, bytes[0] ? 256 : bytes[1] + 1));
        [t, s] = bytes;
      }
      if (!target.writeFile(name, Buffer.concat(parts), type | (raw & 0x40))) {
        throw new Error('files do not fit in the D81');
      }
    }
    [dt, ds] = dir;
  }
  return target;
}
