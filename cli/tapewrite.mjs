// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// cli/tapewrite.mjs — the machine's own SAVE: prg2tap, and the engine that
// t642tap borrows to write an archive's files onto one tape.
//
// Nothing here encodes a pulse. The program is put in memory, RECORD is
// pressed, and the KERNAL's own SAVE writes the tape through the datasette the
// same way it would on a desk — so what comes out is a tape a C64 wrote, not
// an imitation of one. It is saved non-relocatable, so the header carries the
// address the program actually loads at and a LOAD puts it back exactly there.
//
// The SAVE is called the way a machine-language saver called it — a SYS to a
// little stub that banks BASIC ROM out and JSRs the KERNAL — and not by typing
// SAVE at BASIC. Typing needs BASIC's own program pointers moved to the file's
// extent, and a file ending past $A000 moves them past the top of BASIC
// memory, which BASIC answers with ?OUT OF MEMORY before the SAVE ever runs.
// Banked out, the ROM also stops shadowing $A000-$BFFF, so a program living
// under it saves as its own bytes rather than two kilobytes of BASIC's.
//
// The cost is honest too: the KERNAL writes at about a hundred bytes a second,
// so a big program takes minutes of tape — emulated, but every second of it.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, inputFiles, UsageError } from './args.mjs';
import { sniff, sysTarget } from './formats.mjs';
import { say, fail, mss, progress, progressDone } from './report.mjs';
import { tapeListing } from './listing.mjs';
import { outFileFor, oneOutputOnly, writeOut } from './tape.mjs';
import { loadMachine, prgOverflow, splitTap, tapDirectory, tapeFacts, tapSeconds } from './core.mjs';
import { resolveRoms } from './roms.mjs';
import { type, screen, FRAMES_PER_SECOND } from './tapeload.mjs';

const BOOT_FRAMES = 150;
// The KERNAL writes about 100 bytes a second, twice over, and leads each block
// in with several seconds of tone.
const writeLimit = size => Math.max(120, Math.ceil((size / 100) * 3) + 60);

// Where the saver stub sits: the spare bytes above the KERNAL's file tables
// and below the vectors, the strip tape boot blocks used for the same reason.
const SAVER_AT = 0x02A7;

/**
 * Why this method cannot save a file, or null where it can. The floor is the
 * machine's own working space: below $0800 sit the zero page and stack, the
 * input buffer holding the typed SYS, the stub, the vectors, the cassette
 * buffer the SAVE builds its header in, and the screen the messages print to.
 * The ceiling is what the KERNAL can read: from $D000 up sit the I/O registers
 * and its own ROM, unreachable to a ROM SAVE on a real machine too.
 */
export function unsaveable(start, end) {
  if (start < 0x0800) {
    return `loads at $${start.toString(16).toUpperCase().padStart(4, '0')}, inside the working space the machine needs to save`;
  }
  if (end > 0xD000) {
    return `runs to $${end.toString(16).toUpperCase().padStart(4, '0')} — past $D000 sit the I/O registers and the KERNAL's own ROM, which its SAVE cannot read`;
  }
  return null;
}

/**
 * The saver, assembled: bank BASIC ROM out, SETNAM, SETLFS (device 1,
 * non-relocatable), SAVE from a zero-page pointer at $FB, bank back, RTS.
 * The name rides behind the code; SETNAM keeps a pointer, not a copy.
 */
function saverStub(name, start, end) {
  const bytes = [
    0xA9, 0x36, 0x85, 0x01,                     // LDA #$36, STA $01
    0xA9, name.length, 0xA2, 0, 0xA0, 0,        // LDA #len, LDX/LDY name (patched below)
    0x20, 0xBD, 0xFF,                           // JSR SETNAM
    0xA9, 0x01, 0xA2, 0x01, 0xA0, 0x01,         // file 1, device 1, secondary 1
    0x20, 0xBA, 0xFF,                           // JSR SETLFS
    0xA9, start & 0xFF, 0x85, 0xFB,             // start → $FB/$FC
    0xA9, (start >> 8) & 0xFF, 0x85, 0xFC,
    0xA9, 0xFB,                                 // A: where the start pointer lives
    0xA2, end & 0xFF, 0xA0, (end >> 8) & 0xFF,  // X/Y: end, exclusive
    0x20, 0xD8, 0xFF,                           // JSR SAVE
    0xA9, 0x37, 0x85, 0x01,                     // LDA #$37, STA $01 — banks back
    0x60,                                       // RTS, to READY
  ];
  const nameAt = SAVER_AT + bytes.length;
  bytes[7] = nameAt & 0xFF;
  bytes[9] = (nameAt >> 8) & 0xFF;
  for (const ch of name) bytes.push(ch.charCodeAt(0) & 0xFF);
  return Uint8Array.from(bytes);
}

// PETSCII the SAVE line can type: uppercased, and nothing outside the
// characters a header holds — which also keeps a quote from breaking out of
// the typed SAVE"NAME".
const petscii = s => s.toUpperCase().replace(/[^A-Z0-9 .,:;()/+-]/g, ' ').trim();

/** A tape name off a filename: extension shed, sixteen characters kept. */
export function tapeName(from) {
  return (petscii(from.replace(/\.[^.]*$/, '')) || 'PROGRAM').slice(0, 16);
}

/** A tape name that already is one — an archive entry's — with no extension to shed. */
export function saveName(name) {
  return (petscii(String(name)) || 'PROGRAM').slice(0, 16);
}

/**
 * Programs saved onto one fresh tape by the machine, back to back — one
 * recording, a SAVE per file, which is how a mixtape was always made. RECORD
 * stays pressed between files; releasing it at the end is what closes the
 * recording.
 * @param {Array<{prg: Uint8Array, name: string}>} items  prg is load address
 *   first; name is already tape-shaped (tapeName / saveName)
 * @param {object} roms  a resolved ROM set
 * @returns {Promise<{tap: Uint8Array, seconds: number,
 *   files: Array<{name: string, start: number, end: number, seconds: number}>}>}
 */
export async function prgsToTap(items, roms) {
  const { C64Machine } = await loadMachine();
  const m = new C64Machine();
  m.loadROMs(roms);
  for (let i = 0; i < BOOT_FRAMES; i++) m.runFrame();
  m.newBlankTape();
  if (!m.setTapeKey('REC')) throw new Error('the deck would not take RECORD');

  const files = [];
  let seconds = 0;
  for (const { prg, name } of items) {
    const start = prg[0] | (prg[1] << 8);
    const end = start + (prg.length - 2);
    const why = unsaveable(start, end);
    if (why) throw new Error(`${name}: ${why}`);
    // The bytes go straight into RAM, not through loadPRG: a load's side
    // effects are BASIC's pointers moved to the file's end, and past $A000
    // that is the ?OUT OF MEMORY the header of this file tells of.
    m.mem.ram.set(prg.subarray(2), start);
    m.mem.ram.set(saverStub(name, start, end), SAVER_AT);
    type(m, `SYS ${SAVER_AT}\r`);

    const limit = writeLimit(prg.length);
    let wrote = false, took = 0;
    for (let s = 1; s <= limit && !took; s++) {
      progress(name, s / limit);
      for (let k = 0; k < FRAMES_PER_SECOND; k++) m.runFrame();
      if (/\?/.test(screen(m).split('\n').filter(Boolean).slice(-2).join('\n'))) {
        throw new Error(`${name}: the machine answered ${screen(m).split('\n').filter(Boolean).slice(-2)[0].trim()}`);
      }
      if (m.datasette.motorOn) wrote = true;
      else if (wrote) took = s;
    }
    if (!took) throw new Error(`${name}: ${wrote ? 'the save never finished' : 'the machine never started writing'}`);
    seconds += took;
    files.push({ name, start, end, seconds: took });
  }
  m.setTapeKey('STOP');                          // releasing RECORD is what closes the recording
  return { tap: m.exportTapBytes(), seconds, files };
}

// ── the command ──────────────────────────────────────────────────────────────

const hex = n => '$' + n.toString(16).toUpperCase().padStart(4, '0');

export async function prg2tap(argv) {
  const { args, flags } = parseArgs(argv, {
    'out': { value: true, alias: 'o' }, 'out-dir': { value: true },
    'name': { value: true }, 'roms': { value: true },
  });
  if (!args.length) throw new UsageError('Usage: c64rdy prg2tap <in.prg…> [-o out.tap] [--name NAME] [--roms <dir>]');
  const files = inputFiles(args);
  oneOutputOnly(flags, files.length);
  const roms = resolveRoms({ dir: flags.roms });
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
      const name = tapeName(flags.name ?? path.basename(p));
      const written = await prgsToTap([{ prg: bytes, name }], roms);
      progressDone();
      const out = outFileFor(p, '.tap', flags, files.length);
      writeOut(out, written.tap, flags);
      const [saved] = written.files;
      say(`${path.basename(p)} → ${out}`);
      say(`  "${name}" · ${hex(saved.start)}-${hex(saved.end)} · ${mss(written.seconds)} of tape`);
      if (saved.start === 0x0801 && saved.end > 0xA000 && sysTarget(bytes) != null) {
        say(`  too big for RUN — its LOAD ends in ?OUT OF MEMORY with the bytes all there; SYS ${sysTarget(bytes)} starts it`);
      }
      // Read back what was just written: the listing is the proof that a tape
      // came out of it, not a file of pulses.
      const { data, version } = splitTap(written.tap);
      tapeListing({
        name: path.basename(out), files: tapDirectory(data, { version }),
        facts: tapeFacts(data, { version }), seconds: tapSeconds(data, version),
      });
    } catch (e) {
      progressDone();
      fail(`${p}: ${e.message}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}
