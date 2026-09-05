// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// cli/t64.mjs — the .t64 archive, read and written: t642d64 (its files onto
// disks), t642tap (its files onto a real tape, saved by the machine), d642t64
// (a disk's programs into an archive), tap2t64 (a tape's programs, decoded,
// into one). `dir` lists an archive through the same reader.
//
// A .t64 is not a tape: it is an archive of decoded files — name, load address,
// length, bytes — with no signal in it, which is why nothing here plays one.
// What it holds maps one to one onto a disk, so reading the directory and
// handing each file to the same packer tap2d64 uses is the whole job.
//
// The format is simple and the files in the wild are sloppy, in two well known
// ways this reads around rather than trips over. The used-entries count is
// often zero on an archive holding one file, so entries are believed over the
// count: every slot whose type says a file is there is a file. And the end
// address is often wrong — zero, or short — so a file's length is measured
// against the bytes the container actually holds, and the directory's claim is
// only taken where the container can honour it. When the two disagree, the row
// says so instead of writing a file the archive never held that much of.
//
// Writing is the same map walked backwards, minus the sloppiness: an archive
// made here counts its entries and means its end addresses.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, inputFiles, UsageError } from './args.mjs';
import { say, fail, mss, progressDone } from './report.mjs';
import { sniff, sysTarget } from './formats.mjs';
import { packPRGs, diskSeriesPath, hostName } from './disk.mjs';
import {
  D64, diskNameFromFilename, prgOverflow, splitTap, tapDirectory, tapSeconds, tapeFacts,
} from './core.mjs';
import { outFileFor, oneOutputOnly, writeOut } from './tape.mjs';
import { diskListing, tapeListing, archiveListing, printable } from './listing.mjs';
import { readTape, loaderTapeNote } from './tapeload.mjs';
import { pickWanted, whyNoBytes } from './run.mjs';
import { prgsToTap, saveName, unsaveable } from './tapewrite.mjs';
import { resolveRoms } from './roms.mjs';

const HEADER = 64, ENTRY = 32;
const word = (b, at) => b[at] | (b[at + 1] << 8);
const long = (b, at) => word(b, at) | (word(b, at + 2) << 16);
const text = (b, at, n) => {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[at + i]);
  return s.replace(/[\s\x00\xA0]+$/, '');
};

/**
 * The files in a .t64, each as { name, start, end, bytes, note } — bytes are a
 * ready .prg, load address first. Entries that are not files (a freed slot, a
 * memory snapshot) are returned under `skipped` with the reason.
 * @param {Uint8Array} b  the whole archive
 */
export function t64Files(b) {
  if (sniff(b) !== 't64') throw new Error('this command takes a .t64 archive');
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

export function t642d64(argv) {
  const { args, flags } = parseArgs(argv, { out: { value: true, alias: 'o' }, 'out-dir': { value: true } });
  if (!args.length) throw new UsageError('Usage: c64rdy t642d64 <in.t64…> [-o out.d64]');
  const archives = inputFiles(args);
  oneOutputOnly(flags, archives.length);
  let failed = false;
  for (const p of archives) {
    try {
      if (writeArchiveDisks(p, flags)) failed = true;
    } catch (e) {
      fail(`${p}: ${e.message}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

function writeArchiveDisks(p, flags) {
  const t = t64Files(fs.readFileSync(p));
  const { files } = t;
  if (!files.length) { archiveListing(path.basename(p), t); return 1; }

  const { disks, placed, left } = packPRGs(
    files.map(f => ({ name: f.name, bytes: f.bytes, from: f })),
    diskNameFromFilename(path.basename(p)));
  const first = outFileFor(p, '.d64', flags);
  const diskPath = i => diskSeriesPath(first, i);
  disks.forEach((d, i) => writeOut(diskPath(i), d.img, flags));

  const to = new Map(placed.map(({ item, disk, name: n }) => [item.from, `→ ${path.basename(diskPath(disk))} as ${n}`]));
  for (const { item, why } of left) to.set(item.from, why);
  archiveListing(path.basename(p), t, to);

  for (let i = 0; i < disks.length; i++) diskListing(path.basename(diskPath(i)), disks[i]);
  say(`\n${placed.length} of ${files.length} ${files.length === 1 ? 'file' : 'files'} written to ` +
    `${disks.length} ${disks.length === 1 ? 'disk' : 'disks'}.`);
  return placed.length < files.length ? 1 : 0;
}

// ── t642prg ──────────────────────────────────────────────────────────────────

/** A .t64's files straight out as .prg — the archive is already a bag of them. */
export function t642prg(argv) {
  const { args, flags } = parseArgs(argv, { 'out-dir': { value: true, alias: 'd' } });
  if (!args.length) throw new UsageError('Usage: c64rdy t642prg <in.t64…> [-d <dir>]');
  const archives = inputFiles(args);
  const dir = flags['out-dir'] ?? '.';
  fs.mkdirSync(dir, { recursive: true });
  let failed = false;
  for (const p of archives) {
    try {
      if (writeArchivePrgs(p, dir, flags)) failed = true;
    } catch (e) {
      fail(`${p}: ${e.message}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

function writeArchivePrgs(p, dir, flags) {
  const { name, files, skipped } = t64Files(fs.readFileSync(p));
  say(`\n${path.basename(p)}${name ? `  ·  "${printable(name)}"` : ''}`);
  if (!files.length) { say('No files in this archive.'); return 1; }
  const taken = new Set();
  let got = 0, failed = false;
  for (const f of files) {
    const base = hostName(f.name);
    let stem = base;
    for (let n = 2; taken.has(stem.toLowerCase()); n++) stem = `${base}-${n}`;
    taken.add(stem.toLowerCase());
    const out = path.join(dir, stem + '.prg');
    try {
      writeOut(out, f.bytes, flags);
      say(`${out}  (${f.bytes.length} bytes)${f.note ? `  (${f.note})` : ''}`);
      got++;
    } catch (e) {
      fail(`${printable(f.name)}: ${e.message}`);
      failed = true;
    }
  }
  for (const s of skipped) say(`${printable(s.name)}: skipped — ${s.why}`);
  say(`\n${got} of ${files.length} ${files.length === 1 ? 'file' : 'files'} extracted to ${dir}.`);
  return failed ? 1 : 0;
}

// ── t642tap ──────────────────────────────────────────────────────────────────

export async function t642tap(argv) {
  const { args, flags } = parseArgs(argv, {
    out: { value: true, alias: 'o' }, 'out-dir': { value: true }, roms: { value: true },
  });
  if (!args.length) throw new UsageError('Usage: c64rdy t642tap <in.t64…> [-o out.tap] [--roms <dir>]');
  const archives = inputFiles(args);
  oneOutputOnly(flags, archives.length);
  const roms = resolveRoms({ dir: flags.roms });
  let failed = false;
  for (const p of archives) {
    try {
      if (await writeArchiveTape(p, flags, roms)) failed = true;
    } catch (e) {
      progressDone();
      fail(`${p}: ${e.message}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

// What a row must say about a file that loads past the top of BASIC memory:
// on a stock machine the LOAD ends in ?OUT OF MEMORY with every byte present,
// RUN cannot reach it, and the stub's own SYS is how it starts. `run` makes
// that move itself (see startLoaded); a person at another machine needs the
// number.
const sysNote = (f) => {
  if (f.start !== 0x0801 || f.end <= 0xA000) return '';
  const target = sysTarget(f.bytes);
  return target != null ? `  (too big for RUN — SYS ${target} starts it)` : '';
};

/**
 * An archive's files onto one tape, saved by the machine itself — several
 * SAVEs into one recording, which is how a mixtape was always made (tapewrite
 * says what that honesty costs). What comes out is a KERNAL tape whatever
 * wrote the files originally: slow to load, and loadable everywhere.
 */
async function writeArchiveTape(p, flags, roms) {
  const t = t64Files(fs.readFileSync(p));
  if (!t.files.length) { archiveListing(path.basename(p), t); return 1; }

  const to = new Map();
  const items = [];
  for (const f of t.files) {
    const why = unsaveable(f.start, f.end);
    if (why) { to.set(f, `not saved — ${why}`); continue; }
    items.push({ prg: f.bytes, name: saveName(f.name), from: f });
  }
  if (!items.length) {
    archiveListing(path.basename(p), t, to);
    say('\nNothing here the KERNAL could save, so no tape was written.');
    return 1;
  }

  const written = await prgsToTap(items, roms);
  progressDone();
  const out = outFileFor(p, '.tap', flags);
  writeOut(out, written.tap, flags);
  items.forEach((it, i) => to.set(it.from, `→ "${written.files[i].name}"${sysNote(it.from)}`));
  archiveListing(path.basename(p), t, to);

  // Read back what was just written: the listing is the proof that a tape came
  // out of it, not a file of pulses.
  const { data, version } = splitTap(written.tap);
  const seconds = tapSeconds(data, version);
  tapeListing({
    name: path.basename(out), files: tapDirectory(data, { version }),
    facts: tapeFacts(data, { version }), seconds,
  });
  say(`\n${items.length} of ${t.files.length} ${t.files.length === 1 ? 'file' : 'files'} saved onto ${mss(seconds)} of tape.`);
  return items.length < t.files.length ? 1 : 0;
}

// ── writing a .t64 ───────────────────────────────────────────────────────────

// The signature in the wild is prose in several wordings; this is the one in
// Schepers' document, NUL-padded across its 32 bytes.
const T64_MAGIC = 'C64 tape image file';

const putText = (b, at, s, n, pad) => {
  for (let i = 0; i < n; i++) b[at + i] = i < s.length ? s.charCodeAt(i) & 0xFF : pad;
};

/**
 * A .t64 around named programs: the header, a directory entry each, then the
 * bytes back to back. What goes down is the documented layout with none of the
 * wild's sloppiness — the used-entries count counts, and every end address is
 * one the container honours — so an archive written here reads back anywhere,
 * including here.
 * @param {string} label  the archive's own name; 24 characters of it survive
 * @param {Array<{name: string, start: number, payload: Uint8Array}>} files
 *   payload is the file's bytes without the load address `start` already names
 */
export function buildT64(label, files) {
  const dataAt = HEADER + files.length * ENTRY;
  const out = new Uint8Array(dataAt + files.reduce((n, f) => n + f.payload.length, 0));
  putText(out, 0, T64_MAGIC, 32, 0x00);
  out[33] = 0x01;                                 // version $0100
  out[34] = files.length & 0xFF; out[35] = (files.length >> 8) & 0xFF;
  out[36] = out[34]; out[37] = out[35];           // every slot holds a file, and the count says so
  putText(out, 40, label, 24, 0x20);
  let at = dataAt;
  files.forEach((f, i) => {
    const e = HEADER + i * ENTRY;
    out[e] = 1;                                   // a file
    out[e + 1] = 0x82;                            // closed PRG, in 1541 terms
    out[e + 2] = f.start & 0xFF; out[e + 3] = (f.start >> 8) & 0xFF;
    const end = f.start + f.payload.length;
    out[e + 4] = end & 0xFF; out[e + 5] = (end >> 8) & 0xFF;
    out[e + 8] = at & 0xFF; out[e + 9] = (at >> 8) & 0xFF;
    out[e + 10] = (at >> 16) & 0xFF; out[e + 11] = (at >> 24) & 0xFF;
    putText(out, e + 16, f.name, 16, 0x20);
    out.set(f.payload, at);
    at += f.payload.length;
  });
  return out;
}

// A name into the 16 bytes an entry holds, kept unique the same way packPRGs
// keeps disk names unique: two files called the same thing must stay two files
// a LOAD can tell apart.
function entryName(name, taken) {
  const base = String(name || '').trim().slice(0, 16).trim() || 'PROGRAM';
  let out = base;
  for (let n = 2; taken.has(out); n++) {
    const tail = ` ${n}`;
    out = base.slice(0, 16 - tail.length).trimEnd() + tail;
  }
  taken.add(out);
  return out;
}

// ── d642t64 ──────────────────────────────────────────────────────────────────

/**
 * The programs on a disk, shaped for an archive entry: { name, start, payload }.
 * PRG files, and USR files too — a program stored as USR is a habit as old as
 * the disks (see D64.loadFile). What cannot map goes under `skipped` with the
 * reason, and `broken` marks the ones that are damage rather than nature: a SEQ
 * file is data no entry could hold, but an empty chain is a file the disk lost.
 * @param {D64} d
 */
export function diskPrograms(d) {
  const files = [], skipped = [];
  for (const e of d.entries) {
    if (e.deleted) continue;                       // a scratched entry is nothing
    if (e.type !== 'PRG' && e.type !== 'USR') {
      skipped.push({ name: e.name, why: `a ${e.type} file is data, not a program — no load address to give an entry` });
      continue;
    }
    const bytes = d.loadFile(e.name);
    if (!bytes || bytes.length < 2) {
      skipped.push({ name: e.name, why: 'its chain is empty or damaged', broken: true });
      continue;
    }
    const over = prgOverflow(bytes);
    if (over) {
      skipped.push({ name: e.name, why: `claims to load past the top of memory ($${over.end.toString(16).toUpperCase()})`, broken: true });
      continue;
    }
    files.push({ name: e.name, start: bytes[0] | (bytes[1] << 8), payload: bytes.subarray(2) });
  }
  return { files, skipped };
}

export function d642t64(argv) {
  const { args, flags } = parseArgs(argv, { out: { value: true, alias: 'o' }, 'out-dir': { value: true } });
  if (!args.length) throw new UsageError('Usage: c64rdy d642t64 <in.d64…> [-o out.t64]');
  const disks = inputFiles(args);
  oneOutputOnly(flags, disks.length);
  let failed = false;
  for (const p of disks) {
    try {
      if (writeDiskArchive(p, flags)) failed = true;
    } catch (e) {
      fail(`${p}: ${e.message}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

function writeDiskArchive(p, flags) {
  const bytes = fs.readFileSync(p);
  if (sniff(bytes, p) !== 'd64') throw new Error('this command takes a .d64 disk image');
  const d = new D64(bytes);
  const { files, skipped } = diskPrograms(d);
  // The archive is named what the disk is named; the filename only speaks for
  // a disk whose header holds no name at all.
  const label = d.diskName.trim() || diskNameFromFilename(path.basename(p));
  if (!files.length) {
    if (skipped.length) archiveListing(path.basename(p), { name: label, files: [], skipped });
    else say(`\n${path.basename(p)}  ·  "${printable(label)}"`);
    say('\nNo programs on this disk, so no archive was written.');
    return 1;
  }

  const taken = new Set();
  const named = files.map(f => ({ ...f, name: entryName(f.name, taken) }));
  const out = outFileFor(p, '.t64', flags);
  writeOut(out, buildT64(label, named), flags);

  archiveListing(path.basename(p), {
    name: label,
    files: named.map(f => ({ name: f.name, start: f.start, end: f.start + f.payload.length, note: null })),
    skipped,
  });
  const total = named.length + skipped.length;
  say(`\n${named.length} of ${total} ${total === 1 ? 'file' : 'files'} archived into ${out}.`);
  return skipped.some(s => s.broken) ? 1 : 0;
}

// ── tap2t64 ──────────────────────────────────────────────────────────────────

export function tap2t64(argv) {
  const { args, flags } = parseArgs(argv, {
    out: { value: true, alias: 'o' }, 'out-dir': { value: true }, file: { value: true },
  });
  if (!args.length) throw new UsageError('Usage: c64rdy tap2t64 <in.tap…> [-o out.t64] [--file NAME]');
  const tapes = inputFiles(args);
  oneOutputOnly(flags, tapes.length);
  let failed = false;
  for (const p of tapes) {
    try {
      if (writeTapeArchive(p, flags)) failed = true;
    } catch (e) {
      fail(`${p}: ${e.message}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

/**
 * A tape's programs, decoded, into one archive. Decoded and not loaded, and not
 * only because decoding is free: an archive entry is the tape's own claim —
 * name, address, bytes — and the decode is exactly that claim. It survives the
 * trip whole, too. An emulator LOADing from the .t64 relocates a file or
 * honours its address by the secondary address, the same choice the real tape
 * offered, so nothing needs saying here about where a relocatable file lands.
 */
function writeTapeArchive(p, flags) {
  const { data, version, files } = readTape(p, { payload: true });
  if (!files.length) { say(`\n${path.basename(p)}\nNo files found on this tape.`); return 1; }
  const wanted = pickWanted(files, flags);
  const loads = new Map();
  const taken = new Set();
  const packed = [];
  for (const f of wanted) {
    if (!f.bytes) { loads.set(f, whyNoBytes(f)); continue; }
    if (f.start + f.bytes.length > 0x10000) {
      loads.set(f, 'runs past the top of memory — no end address could say where it stops');
      continue;
    }
    // Its own name where it has one; otherwise its place on the tape and where
    // it loads, the way the listing identifies it.
    const name = entryName(
      (f.name ?? '').trim() ||
      `${String(files.indexOf(f) + 1).padStart(2, '0')}-${f.start.toString(16).toUpperCase().padStart(4, '0')}`,
      taken);
    packed.push({ name, start: f.start, payload: f.bytes });
    loads.set(f, `→ "${name}"`);
  }

  const listing = () => tapeListing({
    name: path.basename(p), files, loads,
    facts: tapeFacts(data, { version }), seconds: tapSeconds(data, version),
  });
  if (!packed.length) {
    listing();
    say('\nNothing could be decoded, so nothing was written.');
    return 1;
  }
  const out = outFileFor(p, '.t64', flags);
  writeOut(out, buildT64(diskNameFromFilename(path.basename(p)), packed), flags);
  listing();
  const note = loaderTapeNote(files);
  if (note) say(`\n${note}`);
  say(`\n${packed.length} of ${wanted.length} ${wanted.length === 1 ? 'program' : 'programs'} archived into ${out}.`);
  return packed.length < wanted.length ? 1 : 0;
}
