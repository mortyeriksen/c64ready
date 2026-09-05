// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// cli/tape.mjs — the tape commands: dir, wav2tap, tap2wav, dmp2tap, tapfix,
// tapcat.
// Every one reads a file and writes another (or just answers); a tape has no
// interior to edit, which is why none of these is a command group.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, numberFlag, positiveFlag, inputFiles, UsageError } from './args.mjs';
import { sniff } from './formats.mjs';
import { say, fail, mss, progress, progressDone } from './report.mjs';
import { tapeListing, diskListing, archiveListing } from './listing.mjs';
import { t64Files } from './t64.mjs';
import {
  splitTap, concatTaps, tapSeconds, importWavSync, importProgress,
  tapDirectory, tapeFacts, tapToPcm, pcmToWav, repairTape, dmpToTap,
  D64, PAL_CPU_HZ, NTSC_CPU_HZ,
} from './core.mjs';

/**
 * Where a command's output goes: -o names it (one input only), --out-dir moves
 * it, and the default sits next to the input with its extension swapped — or,
 * where ext carries a suffix ('-mended.tap'), renamed by it.
 */
export function outFileFor(input, ext, flags, inputCount = 1) {
  if (flags.out) {
    if (inputCount > 1) throw new UsageError('-o names one file; use --out-dir for several inputs');
    return flags.out;
  }
  // The default is where the command is run, the way an unpacker unpacks: the
  // input often lives in a curated media folder that a tool has no business
  // writing into uninvited. --out-dir sends it elsewhere, -o names it outright.
  const base = path.basename(input).replace(/\.[^.]*$/, '') + ext;
  if (flags['out-dir']) fs.mkdirSync(flags['out-dir'], { recursive: true });
  return path.join(flags['out-dir'] ?? '.', base);
}

/**
 * -o names one file, so several inputs cannot share it. outFileFor refuses that
 * too, but only once a file is being written: asked here, before the loop, it
 * is what it is — wrong usage, answered before any work is done.
 */
export function oneOutputOnly(flags, inputCount) {
  if (flags.out && inputCount > 1) throw new UsageError('-o names one file; use --out-dir for several inputs');
}

/**
 * Write something the user asked for, refusing to stand on a file that is
 * already there unless --force says so. Tapes, disks and cartridges take
 * minutes of machine to make and are the things worth keeping; a screenshot is
 * a view you can take again, so `run` writes those without asking.
 * @returns {boolean} whether it was written
 */
export function writeOut(out, bytes, flags = {}) {
  if (!flags.force && fs.existsSync(out)) {
    throw new Error(`${path.basename(out)} is already there — --force writes over it`);
  }
  fs.writeFileSync(out, bytes);
  return true;
}

const showProgress = (stage, at) => {
  const { text, value } = importProgress(stage, at);
  progress(text, value);
};

/** The tape's cpuHz from the flags: --ntsc, --cpu-hz, or PAL. */
function cpuHzOf(flags) {
  if (flags.ntsc && flags['cpu-hz']) throw new UsageError('--ntsc and --cpu-hz name the same thing; pick one');
  if (flags.ntsc) return NTSC_CPU_HZ;
  return positiveFlag(flags, 'cpu-hz') ?? PAL_CPU_HZ;
}

function channelOf(flags) {
  const c = flags.channel;
  if (c === undefined) return null;
  if (c === 'mix' || c === 'aligned') return c;
  const n = Number(c);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`--channel takes a channel number, "mix" or "aligned"`);
  return n;
}

// ── dir ──────────────────────────────────────────────────────────────────────

export function dir(argv) {
  const { args, flags } = parseArgs(argv, {
    damaged: {}, seconds: {}, pulses: {},
  });
  if (!args.length) throw new UsageError('Usage: c64rdy dir <tap|wav|dmp|d64|t64>…');
  const files = inputFiles(args);
  let failed = false;
  for (const p of files) {
    try { dirOne(p, flags); } catch (e) { progressDone(); fail(`${p}: ${e.message}`); failed = true; }
  }
  return failed ? 1 : 0;
}

function dirOne(p, flags) {
  const bytes = fs.readFileSync(p);
  const kind = sniff(bytes, p);
  const name = path.basename(p);

  if (kind === 'd64') { diskListing(name, new D64(bytes)); return; }
  if (kind === 't64') { archiveListing(name, t64Files(bytes)); return; }

  let data, version, files;
  if (kind === 'tap') {
    ({ data, version } = splitTap(bytes));
    files = tapDirectory(data, { version });
  } else if (kind === 'wav') {
    // Straight off the recording, decoded and mended the way the app imports it.
    const got = importWavSync(bytes, { onProgress: showProgress });
    progressDone();
    ({ data, version } = splitTap(got.tap));
    files = got.files;
  } else if (kind === 'dmp') {
    ({ data, version } = splitTap(dmpToTap(bytes).tap));
    files = tapDirectory(data, { version });
  } else {
    throw new Error('not a tape, disk or archive this tool can list');
  }

  tapeListing({
    name, files, flags,
    facts: tapeFacts(data, { version }),
    seconds: tapSeconds(data, version),
  });
}

// ── wav2tap ──────────────────────────────────────────────────────────────────

export function wav2tap(argv) {
  const { args, flags } = parseArgs(argv, {
    'out': { value: true, alias: 'o' }, 'out-dir': { value: true },
    'no-mend': {}, 'no-repair': {},
    'channel': { value: true }, 'pre-emphasis': { value: true },
    'ntsc': {}, 'cpu-hz': { value: true },
  });
  if (!args.length) throw new UsageError('Usage: c64rdy wav2tap <in.wav…> [-o out.tap | --out-dir <dir>]');
  const files = inputFiles(args);
  oneOutputOnly(flags, files.length);
  const cpuHz = cpuHzOf(flags);
  const channel = channelOf(flags);
  const preEmphasis = numberFlag(flags, 'pre-emphasis') ?? 0;

  let failed = false;
  for (const p of files) {
    say(`\n${path.basename(p)}`);
    try {
      const got = importWavSync(fs.readFileSync(p), {
        onProgress: showProgress, cpuHz, channel, preEmphasis,
        mend: !flags['no-mend'], repair: !flags['no-repair'],
      });
      progressDone();
      const out = outFileFor(p, '.tap', flags, files.length);
      writeOut(out, got.tap, flags);
      say(`→ ${out}`);

      const { data, version } = splitTap(got.tap);
      tapeListing({
        name: path.basename(out), files: got.files,
        facts: tapeFacts(data, { version }), seconds: tapSeconds(data, version),
      });
      const sound = got.files.filter(f => !f.damaged).length;
      say(`\n${sound} of ${got.files.length} files readable.` +
        (got.repaired.length ? ` ${got.repaired.length} mended from a second reading.` : ''));
      if (got.unconfirmed.length) {
        say(`Only one reading vouches for: ${got.unconfirmed.join(', ')}`);
      }
    } catch (e) {
      progressDone();
      fail(`${p}: ${e.message}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

// ── tap2wav ──────────────────────────────────────────────────────────────────

export function tap2wav(argv) {
  const { args, flags } = parseArgs(argv, {
    'out': { value: true, alias: 'o' }, 'out-dir': { value: true },
    'max-seconds': { value: true },
  });
  if (!args.length) throw new UsageError('Usage: c64rdy tap2wav <in.tap…> [-o out.wav]');
  const files = inputFiles(args);
  oneOutputOnly(flags, files.length);
  const maxSeconds = positiveFlag(flags, 'max-seconds');
  let failed = false;
  for (const p of files) {
    try {
      const { data, version } = splitTap(fs.readFileSync(p));
      const length = tapSeconds(data, version);
      // The tape's own length rules; the 900 s default inside tapToPcm would
      // silently cut a long side in half.
      const cap = maxSeconds ?? Math.ceil(length) + 1;
      const { pcm, seconds, truncated } = tapToPcm(data, { version, maxSeconds: cap });
      const out = outFileFor(p, '.wav', flags, files.length);
      writeOut(out, pcmToWav(pcm), flags);
      say(`${path.basename(p)} → ${out}  (${mss(seconds)})`);
      if (truncated) say(`--max-seconds cut it: the tape plays ${mss(length)}, the .wav stops at ${mss(seconds)}`);
    } catch (e) {
      fail(`${p}: ${e.message}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

// ── dmp2tap ──────────────────────────────────────────────────────────────────

export function dmp2tap(argv) {
  const { args, flags } = parseArgs(argv, {
    'out': { value: true, alias: 'o' }, 'out-dir': { value: true },
  });
  if (!args.length) throw new UsageError('Usage: c64rdy dmp2tap <in.dmp…> [-o out.tap]');
  const files = inputFiles(args);
  oneOutputOnly(flags, files.length);
  let failed = false;
  for (const p of files) {
    try {
      const got = dmpToTap(fs.readFileSync(p));
      const out = outFileFor(p, '.tap', flags, files.length);
      writeOut(out, got.tap, flags);
      say(`${path.basename(p)} → ${out}  (${got.machine} ${got.video}, ${mss(got.seconds)})`);
      const { data, version } = splitTap(got.tap);
      tapeListing({
        name: path.basename(out), files: tapDirectory(data, { version }),
        facts: tapeFacts(data, { version }), seconds: tapSeconds(data, version),
      });
    } catch (e) {
      fail(`${p}: ${e.message}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

// ── tapcat ───────────────────────────────────────────────────────────────────

/**
 * Tapes joined end to end onto one, in the order given — a side rebuilt from
 * its halves, or a freshly saved program wound onto the end of a side. The
 * splicing itself is concatTaps' (and its honesty rules are told there); what
 * this adds is the wind-to mark where each source tape begins.
 */
export function tapcat(argv) {
  const { args, flags } = parseArgs(argv, {
    'out': { value: true, alias: 'o' }, 'out-dir': { value: true },
  });
  const files = args.length ? inputFiles(args) : [];
  if (files.length < 2) {
    throw new UsageError('Usage: c64rdy tapcat <a.tap> <b.tap…> [-o out.tap] — it takes two tapes at least');
  }
  const taps = [];
  for (const p of files) {
    try {
      const bytes = fs.readFileSync(p);
      if (sniff(bytes, p) !== 'tap') throw new Error('not a .tap file — wav2tap or dmp2tap makes one');
      taps.push(splitTap(bytes));
    } catch (e) {
      fail(`${p}: ${e.message}`);
      return 1;
    }
  }
  try {
    const { tap, respelled } = concatTaps(taps);
    const out = outFileFor(files[0], '-joined.tap', flags);
    writeOut(out, tap, flags);

    // Where each tape begins on the joined one: the numbers to wind to.
    let at = 0;
    for (let i = 0; i < files.length; i++) {
      say(`${mss(at).padStart(5)}  ${path.basename(files[i])}`);
      at += tapSeconds(taps[i].data, taps[i].version);
    }
    if (respelled) {
      say(`${respelled} v0 ${respelled === 1 ? 'tape' : 'tapes'} respelled in v1's long form — the same pulses, read the same`);
    }
    const { data, version } = splitTap(tap);
    tapeListing({
      name: path.basename(out), files: tapDirectory(data, { version }),
      facts: tapeFacts(data, { version }), seconds: tapSeconds(data, version),
    });
    return 0;
  } catch (e) {
    fail(e.message);
    return 1;
  }
}

// ── tapfix ───────────────────────────────────────────────────────────────────

export function tapfix(argv) {
  const { args, flags } = parseArgs(argv, {
    'out': { value: true, alias: 'o' }, 'out-dir': { value: true },
  });
  if (!args.length) throw new UsageError('Usage: c64rdy tapfix <in.tap…> [-o out.tap]');
  const files = inputFiles(args);
  oneOutputOnly(flags, files.length);
  let failed = false;
  for (const p of files) {
    try {
      const tap = fs.readFileSync(p);
      if (sniff(tap, p) !== 'tap') throw new Error('not a .tap file');
      const fixed = repairTape(tap);
      if (!fixed.repaired.length) {
        const broken = fixed.damaged.length;
        say(`${path.basename(p)}: nothing to mend` +
          (broken ? ` — ${broken} damaged ${broken === 1 ? 'file is' : 'files are'} beyond what the tape can prove` : ''));
        continue;
      }
      const out = outFileFor(p, '-mended.tap', flags, files.length);
      writeOut(out, fixed.tap, flags);
      say(`${path.basename(p)} → ${out}`);
      say(`Mended: ${fixed.repaired.join(', ')}`);
      if (fixed.damaged.length) say(`Still damaged: ${fixed.damaged.join(', ')}`);
    } catch (e) {
      fail(`${p}: ${e.message}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}
