// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// cli/run.mjs — the commands that boot the machine: `run` (start a program
// headless, save a PNG of its screen, or with --anim an animated one of the
// whole run), `loadtest` (do the programs on a tape actually load?) and
// `tap2d64` (what loads gets written onto disks). The emulator is imported
// lazily; nothing else pays for it.
//
// The loading itself lives in cli/tapeload.mjs, so that one engine serves a
// machine in this thread or several across worker threads; tap2d64 keeps what
// loadtest only judges.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, countFlag, positiveFlag, inputFiles, UsageError } from './args.mjs';
import { sniff, sysTarget } from './formats.mjs';
import { say, fail, progress, progressDone } from './report.mjs';
import { tapeListing, diskListing } from './listing.mjs';
import { outFileFor, oneOutputOnly, writeOut } from './tape.mjs';
import { packPRGs, hostName, diskSeriesPath } from './disk.mjs';
import { t64Files } from './t64.mjs';
import { tapSeconds, tapeFacts, D64, diskNameFromFilename, loadMachine } from './core.mjs';
import { resolveRoms } from './roms.mjs';
import { writePng, Apng } from './png.mjs';
import { writeCollage } from './collage.mjs';
import {
  readTape, tapeEngine, prgFromLoad, startLoaded, selfDriving, programFiles, loaderTapeNote,
  type, screen,
  FRAMES_PER_SECOND,
} from './tapeload.mjs';
import { jobsFor, inParallel } from './jobs.mjs';
const BOOT_CAP = 400;                            // frames to give the KERNAL before giving up on it
const ANIM_FPS = 5;                              // screens a --anim film takes per second

// Left alone, a film plays at the machine's own rate whatever was filmed, so
// filming 5 of every 50 frames shows the run ten times over; --speed says
// otherwise.
const defaultSpeed = fps => FRAMES_PER_SECOND / fps;

/** What a run had to press to get past a screen that had stopped moving. */
const pressSaid = n => (n ? `, pressed past ${n} ${n === 1 ? 'wait' : 'waits'}` : '');

/**
 * What the film came to. A screen the machine left alone is held rather than
 * written again, so a program that settles early is fewer frames than it is
 * screens — the same length of film either way, and worth saying so rather
 * than handing over a one-frame file that was asked for as twenty.
 */
const filmSaid = (film, { fps, speed }) => {
  if (!film) return '';
  const held = film.frames.length < film.captured ? ` (${film.frames.length} distinct)` : '';
  return `, ${film.captured} filmed at ${fps} fps${held} — ${speedSaid(speed)}`;
};
const speedSaid = speed => (speed === 1 ? 'real time' : `${+speed.toFixed(2)}× speed`);

// ── run ──────────────────────────────────────────────────────────────────────

// Frames to run after the program is started. A PRG needs its raster tricks to
// settle; a disk needs its LOAD"*",8,1 to finish first; a tape program often
// decrunches or plays an intro before it shows anything, so it gets longest.
const RUN_FRAMES = { prg: 200, crt: 250, d64: 500, tap: 1500 };

export async function run(argv) {
  const { args, flags } = parseArgs(argv, {
    out: { value: true, alias: 'o' }, 'out-dir': { value: true },
    frames: { value: true }, roms: { value: true }, file: { value: true }, all: {},
    anim: {}, fps: { value: true }, speed: { value: true }, jobs: { value: true },
    'no-press': {}, collage: {},
  });
  if (args.length !== 1) throw new UsageError('Usage: c64rdy run <prg|tap|d64|t64|crt> [--file NAME | --all] [-o out.png] [--frames N] [--anim [--fps N] [--speed N]] [--jobs N] [--roms <dir>]');
  const p = args[0];
  let bytes = fs.readFileSync(p);
  let kind = sniff(bytes, p);
  // A .t64 holds no signal to boot, but it is a bag of programs — so it runs as
  // the disk those programs pack onto, and --file / --all then work as they do
  // for any disk.
  if (kind === 't64') {
    const { files } = t64Files(bytes);
    if (!files.length) throw new Error('no files in this .t64 archive to run');
    const { disks } = packPRGs(files.map(f => ({ name: f.name, bytes: f.bytes })), diskNameFromFilename(path.basename(p)));
    bytes = disks[0].img;
    kind = 'd64';
  }
  if (!RUN_FRAMES[kind]) throw new Error(`run boots a .prg, .tap, .d64, .t64 or .crt — this is a ${kind}`);
  if (flags.all && kind !== 'd64' && kind !== 'tap') throw new UsageError('--all runs every program on a .d64 or a .tap; this input boots as itself');
  if (flags.file && kind !== 'd64' && kind !== 'tap') throw new UsageError('--file picks a program off a .d64 or a .tap; this input boots as itself');
  if (flags.file && flags.all) throw new UsageError('--file names one program, --all runs every one; pick one');
  if (flags.all && flags.out) throw new UsageError('--all writes one PNG per program; use --out-dir, not -o');
  if (flags.collage && !flags.all) throw new UsageError('--collage gathers a --all run into one sheet; add --all');
  const frames = countFlag(flags, 'frames') ?? RUN_FRAMES[kind];
  // Both film knobs ask for a film by being named: --anim can stay unsaid.
  const anim = Boolean(flags.anim || flags.fps !== undefined || flags.speed !== undefined);
  const fps = positiveFlag(flags, 'fps') ?? ANIM_FPS;
  if (fps > FRAMES_PER_SECOND) {
    throw new UsageError(`--fps tops out at ${FRAMES_PER_SECOND}: the machine makes ${FRAMES_PER_SECOND} frames a second, and none can be filmed twice`);
  }
  const speed = positiveFlag(flags, 'speed') ?? defaultSpeed(fps);
  const press = !flags['no-press'];
  if (kind === 'tap') return await runTape(p, flags, { frames, anim, fps, speed, press });

  // A wrong --file name fails here, before a machine boots — not as a
  // photograph of ?FILE NOT FOUND ERROR. Resolved with DOS's own matching,
  // wildcards included, so what passes this check is what the KERNAL finds.
  let disk = null, loadName = null;
  if (kind === 'd64') {
    disk = new D64(bytes);
    if (flags.file) {
      loadName = flags.file.replace(/"/g, '');
      if (!disk.loadFile(loadName)) {
        const names = disk.entries.filter(e => !e.deleted).map(e => e.name.trim()).join(', ');
        throw new Error(`no file matching "${loadName}" on the disk — it holds: ${names}`);
      }
    }
  }

  const { C64Machine, CANVAS_W, CANVAS_H } = await loadMachine();
  const roms = resolveRoms({ dir: flags.roms });

  // Every program on the disk, each on a fresh machine, one PNG per program —
  // the quick way to see what a tap2d64 set actually contains.
  if (flags.all) {
    const entries = disk.entries.filter(e => !e.deleted && e.type === 'PRG' && e.startTrack);
    if (!entries.length) throw new Error('no PRG files on the disk');
    const stem = path.basename(p).replace(/\.[^.]*$/, '');
    const outDir = flags['out-dir'] ?? '.';
    fs.mkdirSync(outDir, { recursive: true });
    // A collage is composed here from the films the run makes, so it runs on one
    // thread — the pictures come back to this process rather than to a worker.
    const jobs = flags.collage ? 1 : jobsFor(flags, entries.length);
    const tiles = [];
    if (jobs > 1) {
      say(`Running ${entries.length} programs on ${jobs} threads.`);
      const shot = await inParallel({
        url: new URL('./workers/diskrun.mjs', import.meta.url),
        data: { bytes, roms, frames, anim, fps, speed, press, outDir, stem },
        items: entries.map(e => e.name),
        jobs,
        onDone: (n, total) => progress(`${n} of ${total} run`, n / total),
      });
      progressDone();
      for (const s of shot) say(`${s.name}  → ${s.out}`);
    } else {
      for (const e of entries) {
        const m = new C64Machine();
        m.loadROMs(roms);
        for (let i = 0; i < 150; i++) m.runFrame();
        m.setTrueDrive(false);
        m.setD64(disk);
        typeLoadAndRun(m, e.name);
        const film = anim ? new Apng(CANVAS_W, CANVAS_H, fps * speed) : null;
        runFrames(m, frames, film, fps, { label: e.name.trim(), press });
        progressDone();
        const out = path.join(outDir, `${stem}-${hostName(e.name.trim())}.png`);
        if (film) film.write(out); else writePng(out, m.vic2.fb32, CANVAS_W, CANVAS_H);
        if (flags.collage) tiles.push({ name: e.name.trim(), film, fb: film ? null : m.vic2.fb32.slice() });
        say(`${e.name.trim()}  → ${out}`);
      }
    }
    say(`${entries.length} ${entries.length === 1 ? 'program' : 'programs'}, ${frames} frames each` +
      (anim ? `, filmed at ${fps} fps — ${speedSaid(speed)}` : ''));
    if (tiles.length) {
      const cout = path.join(outDir, `${stem}-collage.png`);
      writeCollage(cout, tiles, { tileW: CANVAS_W, tileH: CANVAS_H, chargen: roms.charRom, anim, fps: fps * speed });
      say(`collage → ${cout}`);
    }
    return 0;
  }

  const m = new C64Machine();
  m.loadROMs(roms);

  if (kind === 'prg') {
    // Wait for the prompt, do not count frames at it: the KERNAL does not finish
    // its RAM test and clear the screen until about frame 110, so a .prg entered
    // on a fixed count is jumped into on a machine that has not finished starting.
    // What the machine owes us is a prompt, not a number of frames.
    bootToReady(m);
    const at = m.loadPRG(bytes);
    // A program with a BASIC stub is RUN, which is the stub's whole purpose: it
    // is a loader the program brought with it, and BASIC sets up the state it
    // expects on the way through. Only a program that has no stub is entered
    // with SYS at its load address, because then there is nothing to run.
    //
    // The test is whether a stub is there, not where the program loads. Both of
    // the rules this replaces got that wrong in opposite directions. Jumping
    // the program counter at a SYS token found in the BASIC text skips BASIC
    // altogether, and a stub that counts on having been RUN does not survive
    // it — Moon Patrol comes off a tape running and came out of a .prg at a
    // READY prompt. Keying on a $0801 load address instead only asks where the
    // program sits, which is a guess about the stub rather than a look at it.
    if (sysTarget(bytes) !== null) m.injectRun(); else m.injectSys(at);
  } else if (kind === 'd64') {
    bootToReady(m);
    m.setTrueDrive(false);                       // the KERNAL load trap serves the disk
    m.setD64(disk);
    if (loadName) {
      // A named program instead of the first one. LOAD"NAME",8,1 is longer than
      // the 10-byte keyboard buffer, so it is typed the way a person types —
      // fed in as the KERNAL drains it — with RUN queued behind the load.
      type(m, `LOAD"${loadName}",8,1\rRUN\r`);
    } else {
      m.injectLoadAndRun();
    }
  } else {
    m.loadCartridge(bytes);                      // resets; the cartridge boots the machine
  }

  // A film plays at fps × speed: one machine-second of screens, shown in one
  // second divided by the speed.
  const film = anim ? new Apng(CANVAS_W, CANVAS_H, fps * speed) : null;
  const { pressed } = runFrames(m, frames, film, fps, { press });
  const out = outFileFor(p, '.png', flags);
  if (film) film.write(out); else writePng(out, m.vic2.fb32, CANVAS_W, CANVAS_H);
  say(`${out}  (${frames} frames after start${filmSaid(film, { fps, speed })}${pressSaid(pressed)})`);
  return 0;
}

// ── run, on a tape ───────────────────────────────────────────────────────────

/**
 * `run` on a tape. The program is loaded exactly as loadtest loads it — through
 * the KERNAL, or through the loader the tape itself carries — and then started
 * the way the machine offers: most turbo loaders start it themselves, and one
 * that drops back to a BASIC prompt is answered with RUN, or with SYS for a
 * program that did not load at the BASIC start.
 */
async function runTape(p, flags, shot) {
  const { tap, files } = readTape(p);
  if (!files.length) throw new Error('no files on this tape — c64rdy dir says what it holds');
  const roms = resolveRoms({ dir: flags.roms });
  if (flags.all) return await runTapeAll(p, { tap, files, roms }, flags, shot);

  const engine = await tapeEngine({ tap, files, roms });
  const f = flags.file ? pickWanted(files, flags)[0] : firstProgram(files);
  const label = f.name.trim() || '(no name)';

  const loaded = engine.loadFile(f);
  progressDone();
  if (!loaded.ok) throw new Error(`${label} ${whyNot(loaded)}`);

  const dims = await loadMachine();
  const { out, how, film, pressed } = shoot(loaded.machine, f, { ...shot, out: outFileFor(p, '.png', flags) }, dims);
  say(`${label}  (${loaded.s}s of tape, ${how})`);
  say(`${out}  (${shot.frames} frames after start${filmSaid(film, shot)}${pressSaid(pressed)})`);
  return 0;
}

/**
 * Every program on the tape, each loaded for real and photographed: the whole
 * side as pictures, in one pass of the tape's worth of loading. The loads are
 * independent machines, so they run on as many threads as there are cores.
 */
async function runTapeAll(p, { tap, files, roms }, flags, shot) {
  const stem = path.basename(p).replace(/\.[^.]*$/, '');
  const outDir = flags['out-dir'] ?? '.';
  fs.mkdirSync(outDir, { recursive: true });
  const jobs = flags.collage ? 1 : jobsFor(flags, files.length);
  // A tape may carry the same name twice — two SIDE A files is an ordinary
  // thing — so the pictures are named before any of them is taken, and a
  // repeat is numbered rather than written over the first.
  const taken = new Set();
  const outs = files.map(f => {
    const base = hostName(f.name.trim() || 'PROGRAM');
    let name = `${stem}-${base}.png`;
    for (let n = 2; taken.has(name); n++) name = `${stem}-${base}-${n}.png`;
    taken.add(name);
    return path.join(outDir, name);
  });

  let answers;
  if (jobs === 1) {
    const engine = await tapeEngine({ tap, files, roms });
    const dims = await loadMachine();
    answers = [];
    for (const [i, f] of files.entries()) {
      const loaded = engine.loadFile(f);
      progressDone();
      if (loaded.ok) {
        answers.push({ ok: true, s: loaded.s, ...shoot(loaded.machine, f, { ...shot, out: outs[i] }, dims) });
        engine.discardLoader();                  // a game is running on it now
      } else {
        answers.push({ ok: false, why: loaded.why });
      }
    }
  } else {
    say(`Loading ${files.length} programs on ${jobs} threads.`);
    answers = await inParallel({
      url: new URL('./workers/tapeload.mjs', import.meta.url),
      data: { tap, files, roms, shoot: shot },
      items: files.map((_, i) => ({ file: i, out: outs[i] })),
      jobs,
      onDone: (n, total) => progress(`${n} of ${total} loaded`, n / total),
    });
    progressDone();
  }

  let ok = 0;
  files.forEach((f, i) => {
    const a = answers[i];
    const label = (f.name.trim() || '(no name)').padEnd(16);
    if (a.ok) { ok++; say(`${label}  → ${a.out}  (${a.s}s of tape, ${a.how}${pressSaid(a.pressed)})`); }
    else say(`${label}  → ${whyNot(a)}`);
  });
  say(`\n${ok} of ${files.length} ${files.length === 1 ? 'program' : 'programs'} loaded and photographed, ` +
    `${shot.frames} frames each` + (shot.anim ? `, filmed at ${shot.fps} fps — ${speedSaid(shot.speed)}` : ''));
  if (flags.collage) {
    const tiles = files
      .map((f, i) => (answers[i].ok ? { name: f.name.trim(), film: answers[i].film, fb: answers[i].fb } : null))
      .filter(Boolean);
    if (tiles.length) {
      const dims = await loadMachine();
      const cout = path.join(outDir, `${stem}-collage.png`);
      writeCollage(cout, tiles, { tileW: dims.CANVAS_W, tileH: dims.CANVAS_H, chargen: roms.charRom, anim: shot.anim, fps: shot.fps * shot.speed });
      say(`collage → ${cout}`);
    } else {
      say('nothing loaded, so no collage was made');
    }
  }
  return ok === files.length ? 0 : 1;
}

/**
 * A program that has arrived in memory: start it, run the frames, and write
 * its picture — the one place a tape load turns into a file on disk, so a
 * thread and this one do it identically.
 */
export function shoot(m, f, { frames, anim, fps, speed, press = true, outDir, stem, out }, { CANVAS_W, CANVAS_H }) {
  const how = startLoaded(m, f);
  const film = anim ? new Apng(CANVAS_W, CANVAS_H, fps * speed) : null;
  const { pressed } = runFrames(m, frames, film, fps, { press });
  const to = out ?? path.join(outDir, `${stem}-${hostName(f.name.trim() || 'PROGRAM')}.png`);
  if (film) film.write(to); else writePng(to, m.vic2.fb32, CANVAS_W, CANVAS_H);
  return { out: to, how, film, pressed, fb: film ? null : m.vic2.fb32.slice() };
}

/**
 * Which program a tape runs when no --file names one: the first that is not the
 * loader its turbo files need, since that loader is on the tape to serve them
 * and not to be looked at.
 */
export function firstProgram(files) {
  return programFiles(files)[0] ?? files[0];
}

/** The one way a program is started off a disk, typed as a person types it. */
export function typeLoadAndRun(m, name) {
  // LOAD"NAME",8,1 is longer than the 10-byte keyboard buffer, so it goes in
  // fed as the KERNAL drains it, with RUN queued behind the load.
  type(m, `LOAD"${name.replace(/"/g, '')}",8,1\rRUN\r`);
}

// A program that has stopped drawing is usually waiting to be told to go on —
// PRESS ANY KEY, PRESS FIRE — and a run that sits there photographs a title
// screen instead of a game. So the screen is watched, and when it has not
// moved for a few seconds it gets what a person would give it: the space bar,
// then the fire button, alternating.
const STILL_SECONDS = 3;
const PRESSES = 3;                               // and then it is left in peace
const SPACE = [7, 4];                            // the keyboard matrix, column 7 row 4
const HOLD_FRAMES = 12;                          // long enough for a polling loop to see it
const FIRE = 0x10;                               // joystick port 2, active low

/** A cheap fingerprint of the screen: enough to tell "moved" from "did not". */
function screenPrint(fb32) {
  let h = 0;
  for (let i = 0; i < fb32.length; i += 97) h = (h * 31 + fb32[i]) | 0;
  return h;
}

/**
 * The frames after the start, with the screen filmed along the way when there
 * is a film to fill: `fps` of every FRAMES_PER_SECOND, kept even across the
 * run. The last frame always closes the film, whatever the rate, so it ends on
 * the screen a still run would have saved. A screen that stops moving is
 * pressed past, unless press is false.
 * @returns {{ pressed: number }} how many times it had to be prodded
 */
/**
 * Run until the machine offers a prompt, which is what "booted" means. The
 * KERNAL's RAM test takes about 110 frames here, but that is an observation and
 * not a contract: a count that happens to clear it today is a count that breaks
 * when the test gets slower, and it breaks silently, into a screenshot of a
 * machine that never started. The cap only bounds a machine that will never
 * answer.
 * @returns {number} frames it took, or the cap
 */
function bootToReady(m, cap = BOOT_CAP) {
  for (let i = 1; i <= cap; i++) {
    m.runFrame();
    if (/READY\./.test(screen(m))) return i;
  }
  return cap;
}

export function runFrames(m, frames, film, fps, { label = null, press = true } = {}) {
  let shots = 0, filmed = -1;
  let mark = 0, still = 0, pressed = 0, hold = 0, holding = null;
  const release = () => {
    if (holding === 'key') m.cia1.setKey(SPACE[0], SPACE[1], false);
    else m.joyPort2 |= FIRE;
    holding = null;
  };
  for (let i = 0; i < frames; i++) {
    if (label) progress(label, i / frames);
    m.runFrame();

    if (hold > 0 && --hold === 0) {
      release();
    } else if (press && !holding && (i + 1) % FRAMES_PER_SECOND === 0) {
      const now = screenPrint(m.vic2.fb32);
      still = now === mark ? still + 1 : 0;
      mark = now;
      if (still >= STILL_SECONDS && pressed < PRESSES) {
        // The space bar first, since that is what most of them ask for; the
        // fire button next, for the ones that ask for that instead.
        holding = pressed % 2 === 0 ? 'key' : 'fire';
        if (holding === 'key') m.cia1.setKey(SPACE[0], SPACE[1], true);
        else m.joyPort2 &= ~FIRE;
        hold = HOLD_FRAMES;
        pressed++;
        still = 0;
      }
    }

    if (film && shots < Math.floor(((i + 1) * fps) / FRAMES_PER_SECOND)) {
      film.add(m.vic2.fb32);
      shots++;
      filmed = i;
    }
  }
  if (holding) release();                        // never leave a key held down
  if (film && filmed !== frames - 1) film.add(m.vic2.fb32);
  return { pressed };
}

/**
 * Load the files someone asked for and answer in the order they were asked
 * for, on one thread or on several. The threads are independent machines: with
 * --jobs 1 a turbo tape's loader is installed once and reused down the tape,
 * and with more, each thread installs its own copy of it.
 */
async function loadFiles({ tap, files, wanted, flags, keep = false }) {
  const roms = resolveRoms({ dir: flags.roms });
  // A tape whose loader drives itself is played once for all of its files, so
  // threads would only play it several times over.
  const jobs = wanted.some(selfDriving) ? 1 : jobsFor(flags, wanted.length);
  if (jobs === 1) {
    const engine = await tapeEngine({ tap, files, roms });
    const answers = [];
    for (const f of wanted) {
      const r = engine.loadFile(f, { clearRange: keep });
      progressDone();
      answers.push(keep && r.ok ? { ...r, prg: prgFromLoad(r.machine, f) } : r);
    }
    return answers;
  }
  say(`Loading ${wanted.length} ${wanted.length === 1 ? 'file' : 'files'} on ${jobs} threads.`);
  const running = new Map();
  const bar = (done, total) => {
    const part = [...running.values()].reduce((a, b) => a + b, 0);
    progress(`${done} of ${total} loaded`, Math.min(1, (done + part) / total));
  };
  let done = 0;
  const answers = await inParallel({
    url: new URL('./workers/tapeload.mjs', import.meta.url),
    data: { tap, files, roms, keep },
    items: wanted.map(f => files.indexOf(f)),
    jobs,
    onProgress: (index, fraction) => { running.set(index, fraction); bar(done, wanted.length); },
    onDone: (n, total, answer) => { done = n; running.delete(answer.index); bar(n, total); },
  });
  progressDone();
  return answers;
}

/**
 * The same loads, one after another on this thread: what a worker does when
 * the threads are spread over tapes, since a tape's own loader is installed
 * once and reused down the side. Its progress is the tape's, not one file's,
 * so a parent can add several tapes' worth into one bar.
 */
async function loadSerially({ tap, files, wanted, roms, keep, onProgress }) {
  const engine = await tapeEngine({
    tap, files, roms,
    onProgress: onProgress ? (label, part) => onProgress((done + part) / wanted.length) : null,
  });
  const answers = [];
  let done = 0;
  for (const f of wanted) {
    const { machine, ...verdict } = engine.loadFile(f, { clearRange: keep });
    answers.push(keep && verdict.ok ? { ...verdict, prg: prgFromLoad(machine, f) } : verdict);
    done++;
    if (onProgress) onProgress(done / wanted.length);
  }
  return answers;
}

/** The files a --file flag narrows to, or all of them. */
export function pickWanted(files, flags) {
  if (!flags.file) return files;
  const wanted = files.filter(f => f.name.trim().toUpperCase() === flags.file.trim().toUpperCase());
  if (!wanted.length) {
    throw new UsageError(`No file named "${flags.file}" — the tape holds: ${files.map(f => f.name.trim()).join(', ')}`);
  }
  return wanted;
}

// ── loadtest ─────────────────────────────────────────────────────────────────

/**
 * A tape read and its files loaded — everything that costs time, and nothing
 * that prints or writes. Shaped so a worker can do exactly this and post the
 * answer back: file objects survive the trip, references between them do not,
 * so what is wanted travels as indexes.
 */
export async function tapeWork(p, flags, { keep = false, serial = false, roms = null, onProgress = null } = {}) {
  const { tap, data, version, files } = readTape(p);
  if (!files.length) return { files, empty: true };
  const wantedFiles = pickWanted(files, flags);
  const results = serial
    ? await loadSerially({ tap, files, wanted: wantedFiles, roms, keep, onProgress })
    : await loadFiles({ tap, files, wanted: wantedFiles, flags, keep });
  return {
    files, wanted: wantedFiles.map(f => files.indexOf(f)), results,
    facts: tapeFacts(data, { version }), seconds: tapSeconds(data, version),
  };
}

/**
 * Why a file is not on the disk, or not marked as loading. A file the engine
 * declined to judge is not the same as one that failed, and the listing says
 * which — a verdict nobody can stand behind is worse than no verdict.
 */
const whyNot = r => (r.unjudged ? `cannot be judged — ${r.why}` : `does not load — ${r.why}`);

/** What loadtest says about a tape, from the work already done. */
function renderLoadtest(p, work) {
  if (work.empty) { say(`\n${path.basename(p)}\nNo files found on this tape.`); return 1; }
  const { files, wanted, results } = work;
  const loads = new Map();
  let ok = 0;
  wanted.forEach((at, i) => {
    const r = results[i];
    if (r.ok) {
      ok++;
      // A self-driving tape is played once for all of its files, so the seconds
      // belong to the side and not to this row: saying "263s of tape" in a
      // column where every other row means what that one file cost would be a
      // number that is not about the file it stands next to.
      loads.set(files[at], r.self
        ? `loads with the side (played ${r.s}s)`
        : `loads (${r.s}s of tape${r.via ? `, after ${r.via}` : ''}${r.took ? ', and took over' : ''})`);
    }
    else loads.set(files[at], whyNot(r));
  });
  tapeListing({ name: path.basename(p), files, loads, facts: work.facts, seconds: work.seconds });
  say(`\n${ok} of ${wanted.length} ${wanted.length === 1 ? 'file loads' : 'files load'}.`);
  return ok === wanted.length ? 0 : 1;
}

/** What tap2d64 keeps: the bytes that arrived, packed onto as many disks as they need. */
function writeTapeDisks(p, flags, work) {
  if (work.empty) { say(`\n${path.basename(p)}\nNo files found on this tape.`); return 1; }
  const { files, wanted, results } = work;
  const loads = new Map();
  const got = [];
  wanted.forEach((at, i) => {
    const r = results[i];
    if (!r.ok) { loads.set(files[at], whyNot(r)); return; }
    got.push({ name: files[at].name, bytes: r.prg, from: files[at] });
  });

  if (!got.length) {
    tapeListing({ name: path.basename(p), files, loads, facts: work.facts, seconds: work.seconds });
    say('\nNothing loaded, so nothing was written.');
    return 1;
  }

  // A tape side holds more than a D64 does; the set spills onto numbered disks.
  const { disks, placed, left } = packPRGs(got, diskNameFromFilename(path.basename(p)));
  const first = outFileFor(p, '.d64', flags);
  const diskPath = i => diskSeriesPath(first, i);
  disks.forEach((d, i) => writeOut(diskPath(i), d.img, flags));

  for (const { item, disk, name } of placed) {
    loads.set(item.from, `→ ${path.basename(diskPath(disk))} as ${name}`);
  }
  for (const { item, why } of left) loads.set(item.from, why);

  tapeListing({ name: path.basename(p), files, loads, facts: work.facts, seconds: work.seconds });
  for (let i = 0; i < disks.length; i++) diskListing(path.basename(diskPath(i)), disks[i]);
  say(`\n${placed.length} of ${wanted.length} ${wanted.length === 1 ? 'program' : 'programs'} written to ` +
    `${disks.length} ${disks.length === 1 ? 'disk' : 'disks'}.`);
  const note = loaderTapeNote(files);
  if (note) say(`\n${note}`);
  return placed.length === wanted.length ? 0 : 1;
}

/**
 * Several tapes, a thread each. One tape spreads its threads over its files;
 * a shelf of them spreads over the tapes, since a tape with two files can only
 * ever keep two threads busy and the other eight would stand idle.
 */
async function tapesInParallel(tapes, flags, keep, render) {
  const roms = resolveRoms({ dir: flags.roms });
  const jobs = jobsFor(flags, tapes.length);
  say(`${tapes.length} tapes on ${jobs} threads.`);
  const running = new Map();
  let done = 0, failed = false, usage = null;
  const bar = () => {
    const part = [...running.values()].reduce((a, b) => a + b, 0);
    progress(`${done} of ${tapes.length} tapes`, Math.min(1, (done + part) / tapes.length));
  };

  await inParallel({
    url: new URL('./workers/tape.mjs', import.meta.url),
    data: { roms, keep, file: flags.file ?? null },
    items: tapes,
    jobs,
    onProgress: (index, fraction) => { running.set(index, fraction); bar(); },
    // A tape is written and reported the moment it is done, in the order the
    // tapes finish rather than the order they were named: a batch of ten is
    // half an hour, and none of it should be waiting on the last one — least
    // of all the disks, which would be lost entirely to a Ctrl-C.
    onDone: (n, total, answer) => {
      done = n;
      running.delete(answer.index);
      progressDone();
      const p = tapes[answer.index];
      if (answer.usage) { usage ??= answer.error; failed = true; }
      else if (answer.error) { fail(`${p}: ${answer.error}`); failed = true; }
      else if (render(p, answer) !== 0) failed = true;
      bar();
    },
  });
  progressDone();
  if (usage) throw new UsageError(usage);
  return failed ? 1 : 0;
}

export async function loadtest(argv) {
  const { args, flags } = parseArgs(argv, {
    file: { value: true }, roms: { value: true }, jobs: { value: true },
  });
  if (!args.length) throw new UsageError('Usage: c64rdy loadtest <in.tap…> [--file NAME] [--jobs N] [--roms <dir>]');
  const tapes = inputFiles(args);
  if (tapes.length > 1 && jobsFor(flags, tapes.length) > 1) {
    return await tapesInParallel(tapes, flags, false, renderLoadtest);
  }
  return await eachTape(tapes, async p => {
    if (tapes.length > 1) say(`\nReading ${path.basename(p)}…`);
    return renderLoadtest(p, await tapeWork(p, flags));
  });
}

/**
 * A tape at a time, from however many were named. A tape that fails outright
 * is reported and the rest still run — the batch is worth more than the stop —
 * while a wrong invocation stops everything, since it is wrong for all of them.
 */
async function eachTape(tapes, work) {
  let failed = false;
  for (const p of tapes) {
    try {
      if (await work(p) !== 0) failed = true;
    } catch (e) {
      if (e instanceof UsageError) throw e;
      fail(`${p}: ${e.message}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

// ── tap2prg ──────────────────────────────────────────────────────────────────

/**
 * A tape's programs as .prg files, one per file that loads.
 *
 * The bytes come from a machine that loaded them, not from decoding the tape,
 * which is the same route tap2d64 takes and for the same reason: what a file
 * loads as is not always what its header claims. A type 1 boot block can name
 * $CC49 and be relocated to $0801 by a plain LOAD — a decode would write the
 * address the tape says and be wrong about where the program lives.
 *
 * The cost of that honesty is the tape's own running time, and that a file the
 * engine cannot judge yields nothing. A decode-only route would be faster and
 * would reach the five self-driving formats this cannot, but it needs the
 * payload bytes on a directory entry, which the decoder does not expose today.
 */
export async function tap2prg(argv) {
  const { args, flags } = parseArgs(argv, {
    'out-dir': { value: true, alias: 'd' },
    file: { value: true }, roms: { value: true }, jobs: { value: true },
    'via-machine': {},
  });
  if (!args.length) {
    throw new UsageError('Usage: c64rdy tap2prg <in.tap…> [-d <dir>] [--file NAME] [--via-machine] [--jobs N] [--roms <dir>]');
  }
  const tapes = inputFiles(args);
  // Decoded off the tape by default: it needs no ROMs, no machine and no
  // waiting, and it reaches the formats whose loader fills the machine and
  // leaves no one file to keep.
  if (!flags['via-machine']) {
    return await eachTape(tapes, async p => {
      if (tapes.length > 1) say(`\nReading ${path.basename(p)}…`);
      return decodeTapePrgs(p, flags);
    });
  }
  if (tapes.length > 1 && jobsFor(flags, tapes.length) > 1) {
    return await tapesInParallel(tapes, flags, true, (p, work) => writeTapePrgs(p, flags, work));
  }
  return await eachTape(tapes, async p => {
    if (tapes.length > 1) say(`\nReading ${path.basename(p)}…`);
    return writeTapePrgs(p, flags, await tapeWork(p, flags, { keep: true }));
  });
}

/**
 * Why a file yields no bytes. The decoder hands out a payload only where it has
 * one it can stand behind, and the reasons are not the same reason: a block
 * whose checksum failed has bytes that are partly invented, and a format that
 * builds no payload has none at all. Writing either as a program would be
 * minting a file out of a guess.
 */
export const whyNoBytes = f => (f.damaged
  ? `damaged, so its bytes cannot be trusted — ${f.damage?.kind ?? 'unreadable'}`
  : 'the decoder hands out no bytes for this format');

/**
 * A decoded file as a .prg: its load address, little end first, and then exactly
 * the bytes the decoder handed over.
 *
 * The length is the payload's own and is never recomputed from the file's start
 * and end. Those two say what the tape claims; the payload is what the tape
 * holds, and where a format's end address turns out to be inclusive rather than
 * exclusive the arithmetic is off by one while the bytes are still right.
 */
export function prgFromBytes(f) {
  const prg = new Uint8Array(2 + f.bytes.length);
  prg[0] = f.start & 0xFF;
  prg[1] = (f.start >> 8) & 0xFF;
  prg.set(f.bytes, 2);
  return prg;
}

/**
 * A tape's programs decoded straight off the pulses, no machine involved.
 *
 * What this writes is what the tape says: the address in the file's own header,
 * and the bytes that follow it. For a relocatable file that is not where the
 * program ends up — a plain LOAD ignores a type 1 address and puts it at the
 * BASIC start — so those are named in the report rather than quietly written
 * under an address they never load at. --via-machine answers the other
 * question, where the bytes actually landed.
 */
function decodeTapePrgs(p, flags) {
  const { data, version, files } = readTape(p, { payload: true });
  if (!files.length) { say(`\n${path.basename(p)}\nNo files found on this tape.`); return 1; }
  const wantedFiles = pickWanted(files, flags);
  const dir = flags['out-dir'] ?? '.';
  fs.mkdirSync(dir, { recursive: true });
  const loads = new Map();
  const taken = new Set();
  let got = 0, failed = false, moved = 0;

  for (const f of wantedFiles) {
    if (!f.bytes) { loads.set(f, whyNoBytes(f)); continue; }
    const out = path.join(dir, prgNameFor(f, files.indexOf(f), taken));
    const prg = prgFromBytes(f);
    try {
      writeOut(out, prg, flags);
    } catch (err) {
      loads.set(f, `not written — ${err.message}`);
      failed = true;
      continue;
    }
    if (f.relocatable) moved++;
    loads.set(f, `→ ${path.basename(out)} (${prg.length} bytes)${f.relocatable ? ', relocatable' : ''}`);
    got++;
  }

  tapeListing({
    name: path.basename(p), files, loads,
    facts: tapeFacts(data, { version }), seconds: tapSeconds(data, version),
  });
  const note = loaderTapeNote(files);
  if (note) say(`\n${note}`);
  if (!got) { say('\nNothing could be decoded, so nothing was written.'); return 1; }
  say(`\n${got} of ${wantedFiles.length} ${wantedFiles.length === 1 ? 'program' : 'programs'} decoded to ${dir}.`);
  if (moved) {
    say(`${moved} ${moved === 1 ? 'file is' : 'files are'} relocatable: the address written is the one the`
      + `\ntape carries, and a plain LOAD puts ${moved === 1 ? 'it' : 'them'} at $0801 instead.`
      + ' --via-machine writes\nwhere they land.');
  }
  return failed || got < wantedFiles.length ? 1 : 0;
}

/**
 * What a file is called on disk here. Its own name where it has one — most
 * turbo files and every self-driving one do not — and otherwise its place on
 * the tape and where it loads, which is what the listing identifies it by.
 * A name is not unique either: a side can carry the same program twice, and two
 * files called the same thing must not become one file.
 */
export function prgNameFor(f, at, taken) {
  const own = hostName(f.name ?? '').trim();
  const base = own && own !== 'file'
    ? own
    : `${String(at + 1).padStart(2, '0')}-${f.start.toString(16).padStart(4, '0')}`;
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base}-${n}`;
  taken.add(name.toLowerCase());
  return `${name}.prg`;
}

/**
 * What tap2prg keeps when it loads rather than decodes: the bytes that arrived,
 * one file each.
 *
 * A file that ran on arrival is called out, because for that file this is the
 * weaker of the two routes and quietly so. What is read here is memory, and a
 * block that has started executing has had time to rework it: a boot block that
 * takes the machine at $0318 has the KERNAL's own I/O vectors written back over
 * its bytes from $031A up by the time the load is done, so part of it is no
 * longer what the tape holds. Loading is the only route that knows where a
 * relocatable file really lands, and the wrong one for a file that starts itself.
 */
function writeTapePrgs(p, flags, work) {
  if (work.empty) { say(`\n${path.basename(p)}\nNo files found on this tape.`); return 1; }
  const { files, wanted, results } = work;
  const dir = flags['out-dir'] ?? '.';
  fs.mkdirSync(dir, { recursive: true });
  const loads = new Map();
  const taken = new Set();
  let got = 0, failed = false, ran = 0;

  wanted.forEach((at, i) => {
    const r = results[i];
    const f = files[at];
    if (!r.ok) { loads.set(f, whyNot(r)); return; }
    const out = path.join(dir, prgNameFor(f, at, taken));
    try {
      writeOut(out, r.prg, flags);
    } catch (err) {
      loads.set(f, `not written — ${err.message}`);
      failed = true;
      return;
    }
    if (r.took) ran++;
    loads.set(f, `→ ${path.basename(out)} (${r.prg.length} bytes)${r.took ? ', ran on arrival' : ''}`);
    got++;
  });

  tapeListing({ name: path.basename(p), files, loads, facts: work.facts, seconds: work.seconds });
  const note = loaderTapeNote(files);
  if (note) say(`\n${note}`);
  if (!got) { say('\nNothing loaded, so nothing was written.'); return 1; }
  say(`\n${got} of ${wanted.length} ${wanted.length === 1 ? 'program' : 'programs'} written to ${dir}.`);
  if (ran) {
    const one = ran === 1;
    say(`\n${ran} ${one ? 'file' : 'files'} ran on arrival, so what was read there is memory `
      + `after ${one ? 'it' : 'they'} had started,`
      + `\nnot the file the tape holds — a block that takes the machine reworks its own`
      + '\nbytes. Decode those instead: it is the default, and it reads the tape.');
  }
  return failed || got < wanted.length ? 1 : 0;
}

// ── tap2d64 ──────────────────────────────────────────────────────────────────

export async function tap2d64(argv) {
  const { args, flags } = parseArgs(argv, {
    out: { value: true, alias: 'o' }, 'out-dir': { value: true },
    file: { value: true }, roms: { value: true }, jobs: { value: true },
  });
  if (!args.length) throw new UsageError('Usage: c64rdy tap2d64 <in.tap…> [-o out.d64] [--file NAME] [--jobs N] [--roms <dir>]');
  const tapes = inputFiles(args);
  oneOutputOnly(flags, tapes.length);
  if (tapes.length > 1 && jobsFor(flags, tapes.length) > 1) {
    return await tapesInParallel(tapes, flags, true, (p, work) => writeTapeDisks(p, flags, work));
  }
  return await eachTape(tapes, async p => {
    if (tapes.length > 1) say(`\nReading ${path.basename(p)}…`);
    return writeTapeDisks(p, flags, await tapeWork(p, flags, { keep: true }));
  });
}
