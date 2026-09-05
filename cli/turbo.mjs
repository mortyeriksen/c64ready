// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// cli/turbo.mjs — synthesizing turbo tape. Writes Turbo Tape 64, the format
// nineteen tools share: a 192-byte header block and a data block per file, the
// loader installed separately at the front of the tape.
//
// GRL-Supertape is not synthesized here — its header block embeds a 708-byte
// resident loader and its data is chunked under a block count, so prg2turbo
// writes GRL by driving the tool's own SYS310 save. The five self-driving
// commercial formats are each a game's own boot block and cannot be written at
// all. Layout and widths follow src/tap-turbo-formats.js.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, inputFiles, UsageError } from './args.mjs';
import { say, fail, progress, progressDone } from './report.mjs';
import { sniff } from './formats.mjs';
import { outFileFor, writeOut } from './tape.mjs';
import {
  loadMachine, prgOverflow, splitTap, concatTaps, tapDirectory, tapeFacts, tapSeconds,
} from './core.mjs';
import { tapeListing } from './listing.mjs';
import { prgsToTap, tapeName, saveName } from './tapewrite.mjs';
import { resolveRoms } from './roms.mjs';
import { readTape, tapeEngine, type, screen, FRAMES_PER_SECOND } from './tapeload.mjs';

const TAP_HEADER_SIZE = 20;
const TAP_MAGIC = 'C64-TAPE-RAW';

/**
 * Each turbo format this writes, described as its reader in
 * src/tap-turbo-formats.js reads it. Widths are cycles; the encoder converts to
 * .tap units of eight.
 *  - zero/one       the two pulse widths
 *  - countdown      the byte a block's sync counts down from, to 1
 *  - lead/dataLead  pilot bytes before the header and data blocks; the loader
 *                   syncs on the countdown, so only that a run exists matters
 *  - header(file)       the bytes of a file's header block
 *  - dataBlock(payload) the bytes of its data block, checksum and pads included
 */
export const TURBO_WRITERS = {
  'turbo-tape-64': {
    name: 'Turbo Tape 64',
    zero: 216, one: 328, pilot: 0x02, countdown: 9, lead: 1270, dataLead: 503,
    // 192 bytes: type $01, start, end (exclusive), a spare, name at offset 6,
    // space-padded to 16.
    header({ start, end, name }) {
      const h = new Uint8Array(192).fill(0x20);
      h[0] = 0x01;
      h[1] = start & 0xFF; h[2] = (start >> 8) & 0xFF;
      h[3] = end & 0xFF;   h[4] = (end >> 8) & 0xFF;
      h[5] = 0x00;                                 // spare; the reader ignores it
      for (let i = 0; i < 16 && i < name.length; i++) h[6 + i] = name.charCodeAt(i) & 0xFF;
      return withXor(h);
    },
    // A $00 pad the payload excludes (the loader reads until a byte is not
    // zero), the program, then one XOR byte over the pad and the data.
    dataBlock(payload) {
      const b = new Uint8Array(1 + payload.length);
      b.set(payload, 1);
      return withXor(b);
    },
    headerCountdown: 9, dataCountdown: 9,
  },
};

// GRL-Supertape is absent by design: scanGrl reads enough to list a GRL tape,
// but a loadable one needs its 716-byte header (two addresses, the name, then a
// 708-byte resident-loader template) and a data block chunked under a count the
// loader reads. prg2turbo drives GRL's own SYS310 save instead.

/**
 * The turbo formats a --loader can be, and how prg2turbo makes a tape each one
 * reads: `encoder` keys TURBO_WRITERS where we can synthesize the format (no
 * machine), or is null where we cannot and must drive the tool's own `save`
 * command instead ({NAME} substituted per file). Naming a format with --format
 * skips the probe; an unlisted loader is driven only with an explicit
 * --save-with.
 */
export const TURBO_TOOLS = {
  'turbo-tape-64': { name: 'Turbo Tape 64', encoder: 'turbo-tape-64', save: '\x5FS"{NAME}"' },
  'grl-supertape': { name: 'GRL-Supertape', encoder: null, save: 'SYS310"{NAME}"' },
};

/** A block's own XOR check byte appended: the format's own (1 ⊕ b0 ⊕ … ). */
function withXor(bytes) {
  let x = 0;
  for (const b of bytes) x ^= b;
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes, 0);
  out[bytes.length] = x;
  return out;
}

// A .tap byte per pulse, in steps of eight cycles; the turbo widths sit well
// inside a single byte, so no long-form escape is ever needed here.
const unit = cycles => Math.max(1, Math.min(255, Math.round(cycles / 8)));

/**
 * One block: a run of pilot bytes, the countdown, then the payload — every byte
 * eight pulses, MSB first, at the format's two widths.
 */
function renderBlock(out, spec, payload, { countdown, lead }) {
  const zero = unit(spec.zero), one = unit(spec.one);
  const byte = v => { for (let k = 7; k >= 0; k--) out.push((v >> k) & 1 ? one : zero); };
  for (let i = 0; i < lead; i++) byte(spec.pilot);
  for (let v = countdown; v >= 1; v--) byte(v);
  for (const b of payload) byte(b);
}

/**
 * A .tap holding named programs in a turbo format — header block then data
 * block per file, a gap of silence between.
 * @param {Array<{name: string, start: number, payload: Uint8Array}>} files
 *   payload is the program's bytes without the load address `start` names
 * @param {string} [format]  a key of TURBO_WRITERS; Turbo Tape 64 by default
 * @returns {Uint8Array} a v1 .tap
 */
export function encodeTurboTape(files, format = 'turbo-tape-64') {
  const spec = TURBO_WRITERS[format];
  if (!spec) throw new Error(`no turbo writer for "${format}"`);
  const out = [];
  const SILENCE = [0, 0x00, 0x30, 0x00];           // ~12k cycles, v1 long form
  for (const f of files) {
    out.push(...SILENCE);
    const end = f.start + f.payload.length;        // exclusive
    renderBlock(out, spec, spec.header({ start: f.start, end, name: f.name }),
      { countdown: spec.headerCountdown, lead: spec.lead });
    renderBlock(out, spec, spec.dataBlock(f.payload),
      { countdown: spec.dataCountdown, lead: spec.dataLead });
  }
  const tap = new Uint8Array(TAP_HEADER_SIZE + out.length);
  for (let i = 0; i < TAP_MAGIC.length; i++) tap[i] = TAP_MAGIC.charCodeAt(i);
  tap[12] = 1;                                     // v1: exact cycle counts
  tap[16] = out.length & 0xFF; tap[17] = (out.length >> 8) & 0xFF;
  tap[18] = (out.length >> 16) & 0xFF; tap[19] = (out.length >> 24) & 0xFF;
  tap.set(out, TAP_HEADER_SIZE);
  return tap;
}

// ── the prg2turbo command ────────────────────────────────────────────────────

const hex = n => '$' + n.toString(16).toUpperCase().padStart(4, '0');
const sizeOf = n => (n < 1024 ? `${n}B` : `${Math.round(n / 1024)}K`);

/**
 * Programs onto one tape in a turbo format — the fast mixtape, from the
 * terminal. The route follows the loader: a format we can synthesize (Turbo
 * Tape 64) is written in code with no machine; --loader puts an installer at
 * the front and is probed so a loader that cannot read what we wrote is refused
 * rather than paired with it; a named format we cannot synthesize (--format
 * grl-supertape), or any loader under --drive, is written by the tool's own
 * saver instead.
 */
export async function prg2turbo(argv) {
  const { args, flags } = parseArgs(argv, {
    out: { value: true, alias: 'o' }, 'out-dir': { value: true },
    name: { value: true }, loader: { value: true }, roms: { value: true },
    format: { value: true }, drive: {}, 'save-with': { value: true }, trust: {},
  });
  if (!args.length) {
    throw new UsageError('Usage: c64rdy prg2turbo <in.prg…> [-o out.tap] [--name NAME] '
      + '[--loader <installer.prg>] [--format <turbo-tape-64|grl-supertape>] '
      + '[--drive [--save-with \'<cmd>\']] [--roms <dir>]');
  }
  if (flags.name && inputFiles(args).length > 1) throw new UsageError('--name names one program; several inputs take their filenames');
  if (flags.drive && !flags.loader) throw new UsageError('--drive needs --loader: it is the installer whose saver writes the tape');
  if (flags['save-with'] && !flags.drive) throw new UsageError('--save-with only means anything with --drive');
  if (flags.format && !TURBO_TOOLS[flags.format]) {
    throw new UsageError(`--format is one of: ${Object.keys(TURBO_TOOLS).join(', ')}`);
  }

  const files = readPrograms(inputFiles(args), flags);
  const out = outFileFor(args[0], '.tap', flags);
  try {
    const { bytes, driven } = await buildTurboTape(files, flags);
    if (driven) {
      // A driven save runs a third-party tool whose memory model we do not own,
      // so the tape is read back and each program checked before it is kept.
      const short = verifyDriven(bytes, files);
      if (short.length) {
        throw new Error(`${path.basename(flags.loader)} did not save ${short.join(', ')} at the expected size`
          + ` — its saver could not write ${short.length === 1 ? 'it' : 'them'} (a tool whose loader sits where the program loads`
          + ' cannot save one that large). Nothing was written.');
      }
    }
    writeOut(out, bytes, flags);
    reportTape(out, files, flags);
    return 0;
  } catch (e) {
    progressDone();
    fail(`${path.basename(out)}: ${e.message}`);
    return 1;
  }
}

/**
 * The tape, routed by the loader's format the way the registry describes it:
 * a format we can synthesize is written in code (fast, no machine); one we
 * cannot is driven by the tool's own saver; and a loader we cannot place is
 * refused rather than paired with a format it can't read. --drive forces the
 * driven route for an unlisted tool, --format names a listed one, and with
 * neither the loader is probed — installed, offered a synthesized file, and
 * believed only if it reads it.
 * @returns {Promise<{bytes: Uint8Array, driven: boolean}>}
 */
async function buildTurboTape(files, flags) {
  const tool = flags.format ? TURBO_TOOLS[flags.format] : null;

  // Explicitly driven, or a named format we cannot synthesize: the tool writes.
  if (flags.drive || (tool && !tool.encoder)) {
    const save = flags['save-with'] || tool?.save;
    if (!save) {
      throw new Error('this loader must be driven, so it needs its save command: '
        + `--format <${Object.keys(TURBO_TOOLS).join('|')}> for a known tool, or --drive --save-with '<cmd with {NAME}>'`);
    }
    return { bytes: await driveTurboTape(readLoader(flags.loader), files, { ...flags, save }), driven: true };
  }

  // Synthesized. Turbo Tape 64 unless a synthesizable format was named.
  const bytes = encodeTurboTape(files, tool?.encoder ?? 'turbo-tape-64');
  if (!flags.loader) return { bytes, driven: false };

  const loader = readLoader(flags.loader);
  const roms = resolveRoms({ dir: flags.roms });
  const front = await prgsToTap([{ prg: loader.bytes, name: loader.name }], roms);
  // Probe, unless a format was named or the caller vouches for the loader: a
  // loader that cannot read what we synthesized is a dead tape, so it is caught
  // here rather than written.
  if (!flags.format && !flags.trust && !(await loaderReadsSynth(front.tap, roms))) {
    throw new Error(`${path.basename(flags.loader)} did not read the Turbo Tape 64 file offered to it`
      + ` — name its format with --format <${Object.keys(TURBO_TOOLS).join('|')}> if it is one of those,`
      + ' or drive it with --drive --save-with \'<cmd>\'. Nothing was written.');
  }
  return { bytes: concatTaps([splitTap(front.tap), splitTap(bytes)]).tap, driven: false };
}

/**
 * Whether an installer reads what we synthesize. A probe tape of the installer
 * as a KERNAL block plus one tiny Turbo Tape 64 file is run through the load
 * engine: it loads the installer off tape and runs it exactly as a real tape
 * would, then drives the turbo file with ←L. The loader is believed only if
 * that file loads — a wedge that does not answer ←L (GRL waits on SYS300) reads
 * nothing, and the tape it was about to front is refused. Installing off tape,
 * not by poking, is what actually runs the tool: a poked program never installs.
 */
async function loaderReadsSynth(frontTap, roms) {
  const probe = encodeTurboTape([{ name: 'PROBE', start: 0x0801, payload: new Uint8Array(48) }]);
  const tapBytes = concatTaps([splitTap(frontTap), splitTap(probe)]).tap;
  const tmp = path.join(os.tmpdir(), `c64rdy-turbo-probe-${process.pid}-${Date.now()}.tap`);
  fs.writeFileSync(tmp, tapBytes);
  try {
    const tape = readTape(tmp);
    const engine = await tapeEngine({ tap: tape.tap, files: tape.files, roms });
    const pf = tape.files.find(f => f.format === 'Turbo Tape 64');
    return pf ? !!(await engine.loadFile(pf)).ok : false;
  } finally {
    try { fs.rmSync(tmp); } catch {}
  }
}

/** Which driven programs did not come back off the tape at their input size. */
function verifyDriven(tap, files) {
  const { data, version } = splitTap(tap);
  const listed = tapDirectory(data, { version });
  return files.filter(f => {
    const row = listed.find(l => l.name.trim() === f.name.trim() && l.format !== 'CBM');
    return !row || row.size !== f.payload.length;
  }).map(f => f.name);
}

/** The input .prg files as turbo entries: { name, start, payload }, names deduped. */
function readPrograms(paths, flags) {
  const taken = new Set();
  return paths.map(p => {
    const bytes = fs.readFileSync(p);
    if (sniff(bytes, p) !== 'prg') throw new Error(`${path.basename(p)}: not a .prg file`);
    const over = prgOverflow(bytes);
    if (over) {
      throw new Error(`${path.basename(p)}: ${over.short ? 'too short to be a .prg'
        : `loads past the top of memory (${hex(over.end)})`}`);
    }
    let name = saveName(flags.name ?? tapeName(path.basename(p)));
    for (let n = 2; taken.has(name); n++) name = saveName(name).slice(0, 14) + ` ${n}`;
    taken.add(name);
    return { name, start: bytes[0] | (bytes[1] << 8), payload: bytes.subarray(2) };
  });
}

function readLoader(p) {
  const bytes = fs.readFileSync(p);
  if (sniff(bytes, p) !== 'prg') throw new Error(`${path.basename(p)}: the loader must be a .prg`);
  return { name: tapeName(path.basename(p)), bytes };
}

/** The code path: Turbo Tape 64 files, an installer at the front if one was given. */
async function synthesizeTape(files, flags) {
  const turbo = encodeTurboTape(files, 'turbo-tape-64');
  if (!flags.loader) return turbo;
  const loader = readLoader(flags.loader);
  const roms = resolveRoms({ dir: flags.roms });
  const front = await prgsToTap([{ prg: loader.bytes, name: loader.name }], roms);
  return concatTaps([splitTap(front.tap), splitTap(turbo)]).tap;
}

const BOOT_FRAMES = 150;
const TXTTAB = 0x2B, VARTAB = 0x2D;
const SETTLE = 40;

/**
 * The drive path: the installer is loaded and run so its saver is resident,
 * then each program is poked into memory and written with that saver's own
 * command, all into one recording — the installer's KERNAL block first, its
 * turbo files behind. The command is --save-with (with {NAME} for each file) or
 * the back-arrow ←S"NAME" the Turbo 250 family answers to.
 */
async function driveTurboTape(loader, files, flags) {
  // A program that runs past the loader's own resident memory overwrites its
  // saver, so it cannot be driven at all — caught here, before minutes of
  // machine, rather than surfacing as a baffling "saver never started".
  const lStart = loader.bytes[0] | (loader.bytes[1] << 8);
  const lEnd = lStart + loader.bytes.length - 2;
  const tooBig = files.find(f => f.start <= lEnd && f.start + f.payload.length > lEnd);
  if (tooBig) {
    throw new Error(`${tooBig.name} (${hex(tooBig.start)}-${hex(tooBig.start + tooBig.payload.length)}) is too big to save `
      + `with ${path.basename(flags.loader)} — it loads over the tool's own memory (${hex(lStart)}-${hex(lEnd)}) `
      + `and overwrites its saver. Use a Turbo Tape 64 loader for a program this size.`);
  }

  const roms = resolveRoms({ dir: flags.roms });
  const { C64Machine } = await loadMachine();
  const m = new C64Machine();
  m.loadROMs(roms);
  for (let i = 0; i < BOOT_FRAMES; i++) m.runFrame();
  m.newBlankTape();
  if (!m.setTapeKey('REC')) throw new Error('the deck would not take RECORD');

  // The installer as a KERNAL file at the front, so a real machine can load it.
  const start = loader.bytes[0] | (loader.bytes[1] << 8);
  saveKernal(m, loader.bytes, loader.name);
  // Load and run it: its saver (and loader) are now resident.
  m.mem.ram.set(loader.bytes.subarray(2), start);
  setPointers(m, start, start + loader.bytes.length - 2);
  type(m, 'RUN\r', 400);
  type(m, '\r', 20);

  const tmpl = flags.save || flags['save-with'] || '\x5FS"{NAME}"';   // ←S"{NAME}" by default
  for (const f of files) {
    if (f.start < 0x0800) throw new Error(`${f.name}: loads at ${hex(f.start)}, too low to save`);
    m.mem.ram.set(f.payload, f.start);
    setPointers(m, f.start, f.start + f.payload.length);
    driveOneSave(m, tmpl.replace(/\{NAME\}/g, f.name), f.name);
  }
  m.setTapeKey('STOP');
  return m.exportTapBytes();
}

/** A KERNAL SAVE of bytes already carrying their load address, onto the open tape. */
function saveKernal(m, prg, name) {
  const start = prg[0] | (prg[1] << 8), end = start + prg.length - 2;
  m.mem.ram.set(prg.subarray(2), start);
  setPointers(m, start, end);
  type(m, `SAVE"${name}",1,1\r`);
  runUntilWritten(m, name);
}

const setPointers = (m, start, end) => {
  m.mem.ram[TXTTAB] = start & 0xFF; m.mem.ram[TXTTAB + 1] = (start >> 8) & 0xFF;
  m.mem.ram[VARTAB] = end & 0xFF;   m.mem.ram[VARTAB + 1] = (end >> 8) & 0xFF;
};

/** Type the tool's save command and let it write, watching for a BASIC error. */
function driveOneSave(m, command, label) {
  type(m, '\r', 20);
  type(m, command + '\r', SETTLE);
  runUntilWritten(m, label);
}

const MAX_SAVE_SECONDS = 400;

/** Run frames until the motor has run and stopped — one file written. */
function runUntilWritten(m, label) {
  let wrote = false;
  for (let s = 1; s <= MAX_SAVE_SECONDS; s++) {
    progress(label, Math.min(s / 120, 0.99));
    for (let k = 0; k < FRAMES_PER_SECOND; k++) m.runFrame();
    const tail = screen(m).split('\n').filter(Boolean).slice(-2).join('\n');
    if (/\?/.test(tail)) throw new Error(`${label}: the machine answered ${tail.split('\n').pop().trim()}`);
    if (m.datasette.motorOn) { wrote = true; continue; }
    if (wrote) return;
  }
  throw new Error(`${label}: ${wrote ? 'the save never finished' : 'the saver never started — is the command right? (--save-with)'}`);
}

/** The report: what was written, where each program sits, then the read-back listing. */
function reportTape(out, files, flags) {
  progressDone();
  const bytes = fs.readFileSync(out);
  const { data, version } = splitTap(bytes);
  say(`\n${path.basename(out)}`);
  say(columnsFor(files, flags));
  tapeListing({
    name: path.basename(out), files: tapDirectory(data, { version }),
    facts: tapeFacts(data, { version }), seconds: tapSeconds(data, version),
  });
  const format = flags.format ? TURBO_TOOLS[flags.format].name : 'Turbo Tape 64';
  const driven = flags.drive || (flags.format && !TURBO_TOOLS[flags.format].encoder);
  const how = driven ? `${format}, written by ${path.basename(flags.loader)}'s own saver`
    : flags.loader ? `${format}, loaded by ${path.basename(flags.loader)} at the front`
      : format;
  say(`\n${files.length} ${files.length === 1 ? 'program' : 'programs'} written as ${how}.`);
  if (!flags.loader && !flags.drive) {
    say('The tape carries no loader of its own — join it after one with tapcat, '
      + 'or add --loader.');
  }
}

function columnsFor(files, flags) {
  return files.map((f, i) =>
    `  ${i + 1}  ${f.name.padEnd(16)} ${hex(f.start)}-${hex(f.start + f.payload.length)}  ${sizeOf(f.payload.length)}`).join('\n');
}
