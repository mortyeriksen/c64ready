// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// cli/tapeload.mjs — loading a tape's programs for real, the engine loadtest,
// tap2d64 and `run` all share, and the one a worker thread runs a copy of.
//
// The recipe is the one proven by the tape harnesses: a KERNAL file goes
// through LOAD; a turbo file goes through the loader the tape itself carries —
// install it, RUN it, drive it with ←L. Whether a file arrived is judged from
// the memory it was meant to fill: a sentinel is stamped over the tail of the
// load range and the load counts once the tape has stopped and the sentinel is
// gone.
//
// Nothing here reads a flag or prints a listing: it takes a tape and gives
// back loads, so the same code serves one machine in this thread or eight
// across as many.

import fs from 'node:fs';
import { sniff, sysTarget } from './formats.mjs';
import { progress } from './report.mjs';
import { splitTap, tapDirectory, tapSeconds, repairTape, loadMachine, TURBO_FORMATS } from './core.mjs';

export const FRAMES_PER_SECOND = 50;             // PAL
const SIDE_DONE_SECONDS = 5;                     // a stop that stays stopped ends a side
const SETTLE_FRAMES = 250;                       // ~5 s for the loader to hand over
// How long to let a boot block that took the machine start the tape again. It
// waits on BASIC's main loop coming round, which is a handful of frames.
const RESTART_FRAMES = 150;

/**
 * A .tap read, mended the way the app mounts it, and listed — what every tape
 * command starts from, and the one place that decides what "the tape" means.
 * The decoded bytes of each file are asked for, not assumed: a side's worth of
 * payload is megabytes, and a listing has no use for them. Only tap2prg wants
 * them, so only tap2prg pays.
 * @param {string} p  path to a .tap
 * @param {object} [o]
 * @param {boolean} [o.payload]  keep each file's decoded bytes
 */
export function readTape(p, { payload = false } = {}) {
  const raw = fs.readFileSync(p);
  if (sniff(raw, p) !== 'tap') {
    throw new Error('this command takes a .tap — run wav2tap on a recording first');
  }
  const tap = repairTape(raw).tap;
  const { data, version } = splitTap(tap);
  return { tap, data, version, files: tapDirectory(data, { version, payload }) };
}

const SENTINEL = 0xEE;
// The KERNAL reads about 100 bytes a second and every block twice; a flat
// limit cuts big files off mid-load and calls them broken.
const LOAD_LIMIT = 220;
const kernalLimit = size => Math.max(LOAD_LIMIT, Math.ceil((size / 100) * 2.4));
const TURBO_LIMIT = 260;                         // a 48K turbo file is ~115s of tape
const WEDGE_LOAD = '\x5fL\r';                    // ←L, what the turbo wedges answer

// What each loader answers to. The encoding names the format, not one command:
// the ←-wedge family (Super Tape, FCS, GWC, Turbo 250) takes ←L, Turbo Tape 64
// patches the KERNAL's LOAD and ignores the wedge, and GRL-Supertape starts with
// SYS300. Each is tried in turn, so a harness that only knew the wedge no longer
// reads a whole tape as unloadable.
const TURBO_COMMANDS = {
  'Turbo Tape 64': [WEDGE_LOAD, 'LOAD\r'],
  'GRL-Supertape': ['SYS300\r', WEDGE_LOAD],
};
export const commandsFor = f => TURBO_COMMANDS[f.format] ?? [WEDGE_LOAD];

// Some loaders do not take a command per file at all. A format read out of the
// loader the tape carries is this shape by construction: the reader is installed
// by the boot block and then reads the side itself, in tape order, so seeking
// back to a file breaks it and there is nothing to type. Novaload's block is RUN
// and reads on; US Gold / Datasoft decrypts a reader into the tape buffer;
// Gremlin Type 2 pulls a 512-byte loader in at $0400 and calls it with a block
// number. Such a tape is loaded once and judged as a tape: what it wrote is
// running when the tape runs out.
//
// Listing a file's address does not make it loadable on its own. All three of
// these name their blocks and where each one loads — Gremlin Type 2 keeps a
// directory — and not one of them answers to a command, so a tape is in this set
// by its format and not by whether its listing came out short. Offering such a
// file the wedge types Left-arrow L at a machine that has no wedge installed,
// and the file is then written off as never finished.
//
// A format says this itself: the flag rides with its scanner in the decoder's
// registry, so a new format cannot arrive without saying which kind it is. A
// takeover can also be watched for, which catches a tape whose loader no
// scanner here knows: see `tookOver` below and where the KERNAL branch of
// `loadFile` uses it.
const SELF_DRIVING = new Set(TURBO_FORMATS.filter(f => f.selfDriving).map(f => f.name));
export const selfDriving = f => SELF_DRIVING.has(f.format);

// Which of a tape's files are its loader and not its program, per format.
//
// It cannot be answered generically. A turbo tape carries one KERNAL installer
// and its turbo files are programs. A tape that carries its own reader may
// carry it in more than one file: Gremlin Type 2 boots from a stub at $02A7
// that pulls a reader in at $0400 with the KERNAL's own LOAD, so both KERNAL
// files are loader and neither is the game — take only the first KERNAL file
// and you pick the reader, run it, and photograph a black screen. Freeload keeps
// its reader resident instead, in a block at $E000; which block is the
// registry's, riding with each scanner.
const RESIDENT_READER = Object.fromEntries(
  TURBO_FORMATS.filter(f => f.resident != null).map(f => [f.name, f.resident]));

/**
 * The files on a tape that are its programs, in tape order.
 * @param {object[]} files  the listing
 */
export function programFiles(files) {
  const data = files.filter(f => f.format !== 'CBM');
  if (!data.length) return files;                  // a KERNAL tape: every file is a program
  if (data.some(selfDriving)) {
    // The tape brought its own reader, so every KERNAL file belongs to it.
    return data.filter(f => RESIDENT_READER[f.format] !== f.start);
  }
  const installer = files.find(f => f.format === 'CBM' && !f.damaged);
  return files.filter(f => f !== installer);
}

/**
 * What to tell someone who pulled the files off a tape the tape's own loader
 * reads. The extraction is honest — the bytes are the tape's — but the blocks
 * are not programs: the entry point lives in the loader, and a loader that
 * reads the tape as the game plays leaves nothing that can stand alone at all.
 * Silence here let a folder of .prg files imply a folder of games.
 * @returns {string|null}  a note for the report, or null for an ordinary tape
 */
export function loaderTapeNote(files) {
  const data = files.filter(f => f.format !== 'CBM' && !f.damaged);
  if (!data.some(selfDriving)) return null;
  const seen = new Set();
  let streams = false;
  for (const f of data) { if (seen.has(f.start)) { streams = true; break; } seen.add(f.start); }
  return streams
    ? 'This tape is read by its own loader as the game plays. Its blocks are stages\n'
      + 'the loader streams in, not programs, and none of them can run on its own.\n'
      + 'The tape is the game: c64rdy run plays it.'
    : 'This tape is read by its own loader, and the loader starts the game itself.\n'
      + 'The blocks carry no entry point, so nothing taken off this tape starts on\n'
      + 'its own. The tape is the game: c64rdy run plays it.';
}

// What to call each of them in a listing. A load that only happened after the
// second command is worth saying out loud: the first command is the one the
// tape's own tool answers to, so anything else is the engine's guess, and a
// KERNAL LOAD typed into a turbo tape could in principle find some other file.
const COMMAND_NAMES = { [WEDGE_LOAD]: '←L', 'LOAD\r': 'LOAD', 'SYS300\r': 'SYS300' };

// A KERNAL load needs no sentinel: the KERNAL keeps its own account. STATUS is
// clear when nothing went wrong, and the end pointer stands exactly a file's
// length past the start it used — wherever that is. A relocatable file lands at
// $0801 whatever its header claims, so the header's address is no place to look;
// the KERNAL's own start and end pointers are, and a sentinel stamped at the
// header's address cannot survive the move.
const STATUS = 0x90, LOAD_START = 0xC3, LOAD_END = 0xAE;
const word = (m, a) => m.mem.ram[a] | (m.mem.ram[a + 1] << 8);
const kernalLoaded = (m, size) =>
  m.mem.ram[STATUS] === 0 && word(m, LOAD_END) - word(m, LOAD_START) === size;

// Memory the machine writes for its own reasons, whatever the tape is doing:
// zero page, the stack, the KERNAL's workspace and vectors, the screen, and
// the page under the ROM where a loader parks its own. A sentinel whose tail
// lands in any of it proves nothing, since the tape's bytes and the machine's
// are the same bytes.
const WORKSPACE = [[0x0000, 0x0800], [0xFF00, 0x10000]];
export const tailIsBlind = f => {
  const tail = Math.max(f.start, f.end - 16);
  return WORKSPACE.some(([from, to]) => tail < to && f.end > from);
};

// The KERNAL's jump vectors in RAM, filled at reset and pointing into ROM
// ($0302 is BASIC's main loop, $A483). A file that means to start itself has
// to write one of them over with an address of its own, since that is the only
// way to take the machine without a person typing RUN. So a vector that has
// changed during a load, and now points inside the range the file claimed, is
// the file saying it has arrived and is in charge.
const VECTORS = [];
for (let a = 0x0300; a < 0x030C; a += 2) VECTORS.push(a);   // IERROR … IEVAL
for (let a = 0x0314; a < 0x0334; a += 2) VECTORS.push(a);   // CINV … ISAVE
VECTORS.push(0xFFFA, 0xFFFC, 0xFFFE);                       // NMI, RESET, IRQ under the ROM
const vectorsOf = m => VECTORS.map(a => word(m, a));

/**
 * Has the file taken the machine? A vector must have *moved*, not merely
 * happen to fall inside the range: a file loading under BASIC ROM has $A483
 * inside its own extent from the start, and would otherwise look like it had
 * taken over before it began.
 * @param {number[]} before  the vectors as the load began
 * @param {number[]} after   as they stand now
 * @param {object} f  the tape file, for its start and end
 */
export function tookOver(before, after, f) {
  return before.some((was, i) => after[i] !== was && after[i] >= f.start && after[i] < f.end);
}

/**
 * A way to load a tape's files for real. Shared by loadtest, tap2d64 and `run`
 * so "does it load" and "keep what loaded" can never disagree.
 * @param {object} tape  { tap, files } from readTape
 * @param {object} roms  a resolved ROM set
 */
export async function tapeEngine({ tap, files, roms, onProgress = null }) {
  const { data, version } = splitTap(tap);
  const tapeLimit = Math.ceil(tapSeconds(data, version)) + 60;   // the side, and a little
  const { C64Machine } = await loadMachine();

  const boot = () => {
    const m = new C64Machine();
    m.loadROMs(roms);
    for (let i = 0; i < 150; i++) m.runFrame();
    m.loadTap(tap);
    m.setTapeKey('PLAY');
    return m;
  };

  // A machine with the tape's own loader installed and its ←L live. Turbo Tape
  // 64 wants a RETURN before its commands work; the Turbo 250 family ignores it.
  const installLoader = () => {
    const installer = files.find(f => f.format === 'CBM' && !f.damaged);
    if (!installer) return null;
    const m = boot();
    const label = `loader ${installer.name.trim()}`;
    if (!attempt(m, installer, ['LOAD\r'], kernalLimit(installer.size), label, { onProgress }).ok) return null;
    type(m, 'RUN\r');
    for (let i = 0; i < 300; i++) m.runFrame();
    type(m, '\r');
    for (let i = 0; i < 120; i++) m.runFrame();
    return m;
  };

  // A self-driving tape is played once, whatever was asked for, and every file
  // on it shares that one verdict.
  let played = null;
  const playWholeTape = () => {
    if (played) return played;
    const installer = files.find(x => x.format === 'CBM' && !x.damaged);
    if (!installer) {
      return (played = { ok: false, why: 'no KERNAL boot block to start the tape\'s own loader' });
    }
    const m = boot();
    const label = installer.name.trim() || '(no name)';
    const start = attempt(m, installer, ['LOAD\r'], kernalLimit(installer.size), label,
      { kernal: true, onProgress });
    if (!start.ok) return (played = { ok: false, why: `its boot block does not load — ${start.why}` });

    type(m, 'RUN\r');
    const was = m.mem.ram.slice();
    let ran = false, off = 0;
    for (let s = 1; s <= tapeLimit; s++) {
      if (onProgress) onProgress(label, s / tapeLimit); else progress(label, s / tapeLimit);
      for (let k = 0; k < FRAMES_PER_SECOND; k++) m.runFrame();
      if (m.datasette.motorOn) { ran = true; off = 0; continue; }
      if (!ran) continue;
      // A loader stops the motor between blocks as well as at the end, so one
      // second of quiet is not the end of anything. A Freeload reader can pause
      // after its first block, seconds into a side, and judging it there calls
      // the side loaded with the game still to come. The end of a load is a stop
      // that stays stopped.
      if (++off < SIDE_DONE_SECONDS) continue;
      // The tape has stopped. The proof that it did its work is that the
      // machine is now running instructions that were not in memory before it
      // played: not a checksum, but the tape's own doing, observed.
      const page = m.cpu.pc & 0xFF00;
      let changed = 0;
      for (let a = page; a < page + 0x100; a++) if (m.mem.ram[a] !== was[a]) changed++;
      if (changed) return (played = { ok: true, s, self: true, machine: m });
    }
    return (played = { ok: false, why: 'the tape played out and nothing it wrote was running' });
  };

  let installed = null;
  const loadFile = (f, opts = {}) => {
    const label = f.name.trim() || '(no name)';
    if (f.format === 'CBM') {
      const m = boot();
      const before = vectorsOf(m);
      const r = attempt(m, f, ['LOAD\r'], kernalLimit(f.size), label, { ...opts, onProgress, kernal: true });
      // A boot block that has taken the machine is not a file that finished
      // loading. It is the tape's own loader, now running, with the rest of the
      // side still to come, and the KERNAL's account of it says only that the
      // stub arrived. Such a stub loads this way: 168 bytes at $02A7 that reach
      // over $0302, so BASIC's main loop returns into the loader and the tape
      // never stops. Judging the stub and stopping there calls a five-minute
      // tape done in seconds.
      //
      // Both halves are required. A vector that moved into the file's own range
      // is the file saying it is in charge, and a motor still running is the
      // tape saying there is more of it. Neither alone means this.
      if (r.ok && !opts.clearRange && tookOver(before, vectorsOf(m), f)) {
        // The takeover is visible the moment the bytes land, but the loader
        // does not start until BASIC's main loop next returns, and the KERNAL
        // has stopped the motor by then. So the tape saying there is more of it
        // arrives a beat after the file saying it is in charge: wait for the
        // motor to come back before believing it.
        let running = m.datasette.motorOn;
        for (let i = 0; i < RESTART_FRAMES && !running; i++) { m.runFrame(); running = m.datasette.motorOn; }
        if (running) {
          const whole = playWholeTape();
          return { ...whole, machine: whole.machine ?? null };
        }
      }
      return { ...r, machine: m };
    }
    if (selfDriving(f)) {
      // Its bytes cannot be lifted out one file at a time: what the loader put
      // in memory is a machine, not a program with an address and a length.
      if (opts.clearRange) {
        return {
          ok: false, unjudged: true, machine: null,
          why: 'the tape\'s own loader fills the machine; there is no one file to keep',
        };
      }
      const r = playWholeTape();
      return { ...r, machine: r.machine ?? null };
    }
    // A turbo file is judged from its own bytes, so it needs a tail the machine
    // will not write for other reasons.
    if (tailIsBlind(f)) {
      return {
        ok: false, unjudged: true, machine: null,
        why: 'ends in memory the machine writes for its own reasons, so nothing here can judge it',
      };
    }
    if (!installed) installed = installLoader();
    if (!installed) return { ok: false, why: 'no KERNAL loader on the tape to drive it', machine: null };
    const m = installed;
    const result = attempt(m, f, commandsFor(f), TURBO_LIMIT, label, { ...opts, onProgress });
    // A failed load leaves the loader's state in doubt; the next file gets a
    // freshly installed one.
    if (!result.ok) installed = null;
    return { ...result, machine: m };
  };

  // `run` starts the program it just loaded, on this very machine, so the
  // loader that was installed on it is no longer in charge of anything. The
  // next file gets a freshly installed one rather than a wedge underneath a
  // running game.
  const discardLoader = () => { installed = null; };

  return { files, loadFile, discardLoader };
}

// ── the machine, driven the way a person drives it ───────────────────────────

export function screen(m) {
  let text = '';
  for (let row = 0; row < 25; row++) {
    let line = '';
    for (let col = 0; col < 40; col++) {
      const c = m.mem.ram[0x0400 + row * 40 + col];
      line += c >= 1 && c <= 26 ? String.fromCharCode(64 + c)
        : c >= 32 && c <= 63 ? String.fromCharCode(c)
          : c >= 65 && c <= 90 ? String.fromCharCode(c) : ' ';
    }
    text += line.trimEnd() + '\n';
  }
  return text;
}

// Typing waits for the machine to take what it is given, and a machine that
// has stopped reading its keyboard buffer never will: a program that has taken
// over with the interrupts off is not going to change its mind. So the waiting
// is bounded, or the tool hangs on the one file in fourteen that leaves the
// machine like that.
const TYPE_FRAMES = 300;                         // six seconds of trying

/** @returns {boolean} whether all of it was taken */
export function type(m, text) {
  let left = text;
  for (let frames = 0; left && frames < TYPE_FRAMES; frames++) {
    left = left.slice(m.bufferKeyboardText(left));
    m.runFrame();
  }
  return !left;
}

// Some loaders stop at FOUND and poll the keyboard matrix rather than the
// KERNAL buffer — press the keys a person would. C= is the KERNAL's own "load
// it"; SPACE is what the STT wedge answers.
const GO_KEYS = [[7, 5], [7, 4]];
export function pressGo(m) {
  for (const [col, row] of GO_KEYS) {
    m.cia1.setKey(col, row, true);
    for (let i = 0; i < 12; i++) m.runFrame();
    m.cia1.setKey(col, row, false);
    for (let i = 0; i < 6; i++) m.runFrame();
    if (m.datasette.motorOn) return;
  }
}

/**
 * One load, driven until it happens or the tape runs out. `commands` is what
 * the loader might answer to, most likely first: the next is typed after a few
 * seconds of nothing, since a loader that ignores the first hears nothing at
 * all and would otherwise burn the whole limit in silence.
 */
function attempt(m, f, commands, limit, label, { clearRange = false, onProgress = null, kernal = false } = {}) {
  m.seekTapeSeconds(f.startSeconds);             // the head of the lead-in, as the listing says
  m.setTapeKey('PLAY');
  const tail = Math.max(f.start, f.end - 16);
  // Whether anything may be written into this file's range before the machine
  // is asked to load into it. Where the range is the machine's own workspace it
  // may not: a boot block ending at $0305 would take the mark over $0302, $AE
  // and $C3 — BASIC's main loop vector and the KERNAL's own load pointers — and
  // the load asked for could not happen. The file read as never finished and the
  // ones behind it as files with no loader, when nothing was wrong with the tape.
  //
  // Nothing is lost by not writing it. `written()` below already refuses to
  // believe a mark in such a range, so the only thing the write did was damage.
  const blind = tailIsBlind(f);
  // Taken here rather than at boot: a turbo file is loaded on a machine whose
  // vectors the tape's own loader has already changed, and what matters is
  // what changes during this load.
  const before = vectorsOf(m);
  if (!blind) {
    // When the loaded bytes are going to be kept (tap2d64), the whole range is
    // cleared first so a hole in the load cannot inherit the previous file's
    // bytes on a shared machine.
    if (clearRange) m.mem.ram.fill(0, f.start, f.end);
    m.mem.ram.fill(SENTINEL, tail, f.end);
  }
  const queue = [...commands];
  let used = queue.shift();
  type(m, used);
  const via = () => (used === commands[0] ? undefined : (COMMAND_NAMES[used] ?? used.trim()));
  // A mark in memory the machine writes for its own reasons proves nothing, and
  // a KERNAL file can land there: a 168-byte stub can end inside the tape buffer,
  // which the KERNAL fills with every header it reads while searching, so the
  // mark is gone with nothing loaded and the tape looks done. Turbo files never
  // reach here blind, the caller having judged them unjudgeable, so this is the
  // KERNAL's case alone: its own account and the takeover are the evidence, both
  // better than a mark ever was.
  const written = () => {
    if (blind) return false;
    for (let a = tail; a < f.end; a++) if (m.mem.ram[a] !== SENTINEL) return true;
    return false;
  };
  const taken = () => tookOver(before, vectorsOf(m), f);
  // The KERNAL's account, and whether it already read that way before the load
  // began: only a change during this attempt says anything.
  const size = f.end - f.start;
  const accounted = kernal && kernalLoaded(m, size);
  let ran = false, prods = 0;
  for (let s = 1; s <= limit; s++) {
    if (onProgress) onProgress(label, s / limit); else progress(label, s / limit);
    for (let k = 0; k < FRAMES_PER_SECOND; k++) m.runFrame();
    if (/\?LOAD\s+ERROR/.test(screen(m))) return { ok: false, why: '?LOAD ERROR', s };
    // The KERNAL says so itself, wherever it put the file. This is checked
    // before the motor, since a file that starts itself never lets it stop.
    // Its start and end pointers are filled from the header when the file is
    // FOUND, not when it has arrived, so on their own they date the search
    // rather than the load. What ends a load is the tape stopping, or the file
    // taking the machine and never letting it stop.
    if (kernal && !accounted && ran && kernalLoaded(m, size) && (!m.datasette.motorOn || taken())) {
      return { ok: true, s, via: via(), took: taken() || undefined };
    }
    // Or the file took the machine: a vector moved into its own range. Both
    // halves are required, so a loader that patches early cannot claim a file
    // that has not arrived.
    if (ran && taken() && (blind || written())) return { ok: true, s, via: via(), took: true };
    if (m.datasette.motorOn) { ran = true; continue; }
    if (ran && written()) return { ok: true, s, via: via() };
    // Nothing has moved: the loader may answer to something else.
    if (!ran && queue.length && s % 4 === 0) { used = queue.shift(); type(m, used); continue; }
    if (ran && prods < 4) { pressGo(m); prods++; }          // stalled at a prompt
  }
  return { ok: false, why: written() ? 'never finished (part of it arrived)' : 'never finished', s: limit };
}

/**
 * What a load put in memory, as a .prg: where the bytes actually landed, and
 * then the bytes.
 *
 * The address is the KERNAL's own, not the header's, wherever the KERNAL did the
 * loading. A type 1 file is relocatable and a plain LOAD ignores the address its
 * header carries — a boot block can claim $CC49 and land at $0801 — so reading
 * the header's range yields a page nobody wrote, handed out as a program and
 * reported a success. The KERNAL keeps where it put a file in $C3/$C4 and where
 * it ended in $AE/$AF; those two agreeing with the file's own length is what
 * makes them safe to believe, the same account `attempt` judges a KERNAL load by.
 *
 * A turbo loader stores where its own header says, and leaves the KERNAL's
 * pointers stale from whatever it last read, so only a CBM file is taken this
 * way.
 * @param {object} m  the machine that loaded it
 * @param {object} f  the tape file
 */
export function prgFromLoad(m, f) {
  const size = f.end - f.start;
  const at = f.format === 'CBM' && kernalLoaded(m, size) ? word(m, LOAD_START) : f.start;
  const prg = new Uint8Array(2 + size);
  prg[0] = at & 0xFF;
  prg[1] = (at >> 8) & 0xFF;
  prg.set(m.mem.ram.subarray(at, Math.min(at + size, m.mem.ram.length)), 2);
  return prg;
}

/**
 * A program that has just arrived, started the way the machine offers: most
 * turbo loaders start it themselves, and one that drops back to a BASIC prompt
 * is answered with RUN, or with SYS for a program that did not load at the
 * BASIC start.
 * @returns {string} what was done, for the report
 */
export function startLoaded(m, f) {
  for (let i = 0; i < SETTLE_FRAMES; i++) m.runFrame();
  const atPrompt = /READY\./.test(screen(m).split('\n').filter(Boolean).slice(-3).join('\n'));
  if (!atPrompt) return 'started by the loader';
  if (f.start === 0x0801) {
    // A file that loads past the top of BASIC memory ($A000) cannot be RUN:
    // the load leaves BASIC's variable pointer beyond its string space, and
    // RUN answers ?OUT OF MEMORY with every byte of the program present — on
    // real hardware too. The era's answer was LIST, then SYS what the stub
    // says; reading the stub where it landed is the same move.
    if (f.end > 0xA000) {
      const target = sysTarget(prgFromLoad(m, f));
      if (target != null) {
        m.injectSys(target);
        return `SYS ${target} typed — too big for RUN`;
      }
    }
    m.injectRun();
    return 'RUN typed';
  }
  m.injectSys(f.start);
  return `SYS ${f.start} typed`;
}
