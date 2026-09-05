// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// cli/disk.mjs — the disk group, plus prg2d64. `disk` is the one command group
// in the tool because a .d64 is the one file with an interior you edit: you add
// to it and take from it over its lifetime.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, inputFiles, UsageError } from './args.mjs';
import { sniff } from './formats.mjs';
import { say, fail } from './report.mjs';
import { diskListing } from './listing.mjs';
import { outFileFor, oneOutputOnly, writeOut } from './tape.mjs';
import {
  D64, createBlankD64, createPRGDisk, d64Variant, diskNameFromFilename, prgOverflow,
} from './core.mjs';

export function disk(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === 'new') return diskNew(rest);
  if (sub === 'add') return diskAdd(rest);
  if (sub === 'extract') return diskExtract(rest, 'disk extract');
  if (sub === 'rm') return diskRm(rest);
  throw new UsageError('Usage: c64rdy disk <new|add|extract|rm> …');
}

// ── disk rm ──────────────────────────────────────────────────────────────────

function diskRm(argv) {
  const { args } = parseArgs(argv);
  if (args.length !== 2) throw new UsageError('Usage: c64rdy disk rm <disk.d64> <pattern>');
  const [diskPath, pattern] = args;
  const d = openDisk(diskPath);
  const { scratched, blocks } = d.scratch(pattern);
  if (!scratched.length) {
    say(`Nothing on the disk matches "${pattern}"`);
    return 1;
  }
  fs.writeFileSync(diskPath, d.img);
  say(`Scratched ${scratched.join(', ')} — ${blocks} ${blocks === 1 ? 'block' : 'blocks'} freed`);
  diskListing(path.basename(diskPath), d);
  return 0;
}

function openDisk(p) {
  const bytes = fs.readFileSync(p);
  if (!d64Variant(bytes.length)) throw new Error('not a .d64 disk image (no D64 variant has this byte length)');
  return new D64(bytes);
}

// ── disk new ─────────────────────────────────────────────────────────────────

function diskNew(argv) {
  const { args, flags } = parseArgs(argv, {
    name: { value: true }, id: { value: true },
  });
  if (args.length < 1) throw new UsageError('Usage: c64rdy disk new <out.d64> [file.prg…] [--name NAME] [--id ID]');
  const [out, ...prgArgs] = args;
  // `new` formats a blank disk; pointing it at an existing image would wipe it,
  // so it refuses one unless --force says to reformat.
  if (fs.existsSync(out) && !flags.force) {
    throw new Error(`${out} already exists — --force reformats it`);
  }
  const name = flags.name ?? diskNameFromFilename(path.basename(out));
  const d = createBlankD64(name, flags.id ?? '00');
  say(`${out}: formatted "${name}", ${d.freeBlocks} blocks free`);
  // Files named on the same line are written straight in, so a disk is built in
  // one command rather than a new-then-add pair.
  const failed = prgArgs.length ? addPRGs(d, inputFiles(prgArgs)) : false;
  fs.writeFileSync(out, d.img);
  if (prgArgs.length) diskListing(path.basename(out), d);
  return failed ? 1 : 0;
}

// ── disk add ─────────────────────────────────────────────────────────────────

function diskAdd(argv) {
  const { args } = parseArgs(argv);
  if (args.length < 2) throw new UsageError('Usage: c64rdy disk add <disk.d64> <file.prg…>');
  const [diskPath, ...rest] = args;
  const d = openDisk(diskPath);
  const failed = addPRGs(d, inputFiles(rest));
  fs.writeFileSync(diskPath, d.img);
  diskListing(path.basename(diskPath), d);
  return failed ? 1 : 0;
}

/** Write named .prg files into an open disk; returns whether any failed. */
function addPRGs(d, prgs) {
  let failed = false;
  for (const p of prgs) {
    try {
      const bytes = fs.readFileSync(p);
      const over = prgOverflow(bytes);
      if (over) {
        throw new Error(over.short ? 'too short to be a .prg'
          : `claims to load past the top of memory ($${over.end.toString(16).toUpperCase()})`);
      }
      const name = diskNameFromFilename(path.basename(p));
      if (d.entries.some(e => !e.deleted && e.name === name)) {
        throw new Error(`the disk already holds a file named ${name}`);
      }
      const blocks = d.writePRG(name, bytes);
      if (!blocks) throw new Error(`won't fit — the disk has ${d.freeBlocks} blocks free`);
      say(`${name}: ${blocks} ${blocks === 1 ? 'block' : 'blocks'}`);
    } catch (e) {
      fail(`${p}: ${e.message}`);
      failed = true;
    }
  }
  return failed;
}

// ── disk extract ─────────────────────────────────────────────────────────────

/**
 * Files off a disk, as .prg. Reachable two ways for one reason: it belongs to
 * the disk group by what it does, and to the flat transforms by what people
 * search for — `prg2d64` has an inverse and `d642prg` is what they type. One
 * implementation, two doors, and the usage line names whichever was used.
 */
function diskExtract(argv, as = 'd642prg') {
  const { args, flags } = parseArgs(argv, {
    'out-dir': { value: true, alias: 'd' },
  });
  if (args.length < 1 || args.length > 2) {
    throw new UsageError(`Usage: c64rdy ${as} <disk.d64> [pattern] [-d <dir>]`);
  }
  const d = openDisk(args[0]);
  const pattern = args[1];
  const dir = flags['out-dir'] ?? '.';
  fs.mkdirSync(dir, { recursive: true });

  const wanted = d.entries.filter(e => !e.deleted && (!pattern || dosMatch(e.name, pattern)));
  if (!wanted.length) {
    say(pattern ? `Nothing on the disk matches "${pattern}"` : 'Nothing on the disk to extract');
    return 1;
  }
  let failed = false, got = 0;
  for (const e of wanted) {
    if (e.type !== 'PRG' && e.type !== 'SEQ' && e.type !== 'USR') {
      say(`${e.name}: ${e.type} files are not extractable — skipped`);
      continue;
    }
    const bytes = d.loadFile(e.name);
    if (!bytes || !bytes.length) { fail(`${e.name}: chain is empty or damaged`); failed = true; continue; }
    const out = path.join(dir, hostName(e.name) + (e.type === 'SEQ' ? '.seq' : '.prg'));
    try {
      writeOut(out, bytes, flags);
    } catch (err) {
      fail(`${e.name}: ${err.message}`);
      failed = true;
      continue;
    }
    say(`${out}  (${bytes.length} bytes)`);
    got++;
  }
  say(`${got} ${got === 1 ? 'file' : 'files'} extracted`);
  return failed ? 1 : 0;
}

// DOS matching, as the drive does it: '*' takes the rest, '?' any one byte,
// only a-z folds case (PETSCII's shifted range is art, and art matches itself).
const fold = b => (b >= 0x61 && b <= 0x7A) ? b - 0x20 : b;

function dosMatch(name, pattern) {
  for (let i = 0; i < 16; i++) {
    const p = i < pattern.length ? pattern.charCodeAt(i) & 0xFF : 0xA0;
    if (p === 0x2A) return true;
    if (p === 0x3F) continue;
    const n = i < name.length ? name.charCodeAt(i) & 0xFF : 0xA0;
    if (fold(p) !== fold(n)) return false;
  }
  return true;
}

// A directory name can hold any PETSCII byte; a host file cannot.
export function hostName(name) {
  let out = '';
  for (const ch of name) out += /[A-Za-z0-9 +._-]/.test(ch) ? ch : '_';
  out = out.trim();
  return out || 'file';
}

// ── packing PRGs onto disks ──────────────────────────────────────────────────

// A tape name into the 16 characters a directory entry holds, trimmed of the
// padding and control codes a listing already dropped.
function diskFileName(name) {
  const out = String(name || '').trim().slice(0, 16).trim();
  return out || 'PROGRAM';
}

/**
 * Disk n of a set, named after the first one. The name is taken apart rather
 * than pattern-matched: `-o archive` must number as archive, archive-2.d64 …
 * and not write every disk of the set to the one path.
 * @param {string} first  where disk 1 goes @param {number} i  0-based
 */
export function diskSeriesPath(first, i) {
  if (i === 0) return first;
  const ext = path.extname(first);
  return `${first.slice(0, first.length - ext.length)}-${i + 1}${ext || '.d64'}`;
}

/**
 * Lay named PRGs onto as many fresh disks as they need — a tape side holds
 * more than a D64 does, so `tap2d64` spills onto a second disk rather than
 * stopping at the 664th block. Names are deduplicated across the whole set (a
 * tape may carry two SIDE A files), and a file too big for even an empty disk
 * comes back in `left` with the reason.
 * @param {Array<{name: string, bytes: Uint8Array}>} items
 * @param {string} diskName  header name for every disk in the set
 * @returns {{ disks: D64[], placed: Array<{item, disk: number, name: string}>,
 *             left: Array<{item, why: string}> }}
 */
export function packPRGs(items, diskName) {
  const disks = [];
  const placed = [], left = [];
  const taken = new Set();

  const dedupe = (name) => {
    if (!taken.has(name)) return name;
    for (let n = 2; ; n++) {
      const tail = ` ${n}`;
      const candidate = name.slice(0, 16 - tail.length).trimEnd() + tail;
      if (!taken.has(candidate)) return candidate;
    }
  };

  for (const item of items) {
    const name = dedupe(diskFileName(item.name));
    let at = disks.findIndex(d => d.writePRG(name, item.bytes) > 0);
    if (at < 0) {
      const fresh = createBlankD64(diskName, String(disks.length + 1).padStart(2, '0'));
      if (!fresh.writePRG(name, item.bytes)) {
        left.push({ item, why: 'too big for a disk of its own' });
        continue;
      }
      disks.push(fresh);
      at = disks.length - 1;
    }
    taken.add(name);
    placed.push({ item, disk: at, name });
  }
  return { disks, placed, left };
}

// ── prg2d64 ──────────────────────────────────────────────────────────────────

/** The same extraction, under the name that pairs with prg2d64. */
export function d642prg(argv) { return diskExtract(argv, 'd642prg'); }

export function prg2d64(argv) {
  const { args, flags } = parseArgs(argv, {
    'out': { value: true, alias: 'o' }, 'out-dir': { value: true },
  });
  if (!args.length) throw new UsageError('Usage: c64rdy prg2d64 <in.prg…> [-o out.d64]');
  const files = inputFiles(args);
  oneOutputOnly(flags, files.length);
  let failed = false;
  for (const p of files) {
    try {
      const bytes = fs.readFileSync(p);
      if (sniff(bytes, p) !== 'prg') throw new Error('not a .prg file');
      const over = prgOverflow(bytes);
      if (over) {
        throw new Error(over.short ? 'too short to be a .prg'
          : `claims to load past the top of memory ($${over.end.toString(16).toUpperCase()})`);
      }
      const d = createPRGDisk(path.basename(p), bytes);
      if (!d) throw new Error("won't fit on a disk — a D64 holds 664 blocks");
      const out = outFileFor(p, '.d64', flags, files.length);
      writeOut(out, d.img, flags);
      say(`${path.basename(p)} → ${out}`);
      diskListing(path.basename(out), d);
    } catch (e) {
      fail(`${p}: ${e.message}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}
