// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// cli/info.mjs — one line per file: what is this? The identity probe for a file
// you cannot place — cheap on purpose, so it never decodes more than it must.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, inputFiles, UsageError } from './args.mjs';
import { sniff, KIND_NAMES } from './formats.mjs';
import { t64Files } from './t64.mjs';
import { say, fail, mss } from './report.mjs';
import { splitTap, tapSeconds, wavReader, D64, d64Variant, parseCRT } from './core.mjs';

export function run(argv) {
  const { args } = parseArgs(argv);
  if (!args.length) throw new UsageError('Usage: c64rdy info <file…>');
  let failed = false;
  for (const p of inputFiles(args)) {
    try {
      say(`${p} — ${describe(fs.readFileSync(p), p)}`);
    } catch (e) {
      fail(`${p} — ${e.message}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

function describe(bytes, filename) {
  const kind = sniff(bytes, filename);
  const name = KIND_NAMES[kind];
  switch (kind) {
    case 't64': {
      const { name: label, files } = t64Files(bytes);
      return `${name} (.t64)${label ? `, "${label}"` : ''}, ` +
        `${files.length} ${files.length === 1 ? 'file' : 'files'}`;
    }
    case 'tap': {
      const { data, version } = splitTap(bytes);
      return `${name} (.tap v${version}), plays ${mss(tapSeconds(data, version))}`;
    }
    case 'wav': {
      const w = wavReader(bytes);
      return `${name} (.wav), ${w.channels === 1 ? 'mono' : `${w.channels}-channel`} ` +
        `${w.bits}-bit ${w.sampleRate} Hz, ${mss(w.frames / w.sampleRate)}`;
    }
    case 'dmp': {
      // Header only — the identity should not cost the conversion.
      const machine = ['C64', 'VIC 20', 'C16'][bytes[13] & 0x0F] || 'unknown machine';
      const video = bytes[14] === 1 ? 'NTSC' : 'PAL';
      return `${name} (.dmp v${bytes[12]}), ${machine} ${video}`;
    }
    case 'd64': {
      const v = d64Variant(bytes.length);
      const disk = new D64(bytes);
      const files = disk.entries.filter(e => !e.deleted).length;
      return `${name} (.d64, ${v.tracks} tracks${v.errorInfo ? ' + error table' : ''}), ` +
        `"${disk.diskName}", ${files} ${files === 1 ? 'file' : 'files'}, ${disk.freeBlocks} blocks free`;
    }
    case 'prg': {
      const addr = bytes[0] | (bytes[1] << 8);
      const end = addr + bytes.length - 2;
      return `${name} (.prg), loads $${h16(addr)}-$${h16(end)}, ${bytes.length - 2} bytes`;
    }
    case 'crt': {
      const crt = parseCRT(bytes);
      return `${name} (.crt), "${crt.name}", hardware type ${crt.hwType}, ` +
        `${crt.chips.length} ROM ${crt.chips.length === 1 ? 'chip' : 'chips'}`;
    }
    default:
      return `${name} (${bytes.length} bytes)`;
  }
}

const h16 = n => n.toString(16).toUpperCase().padStart(4, '0');
