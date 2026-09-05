#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// cli/c64rdy.mjs — the c64rdy command: dispatch, --help, --version. The shebang
// must be the first bytes of the file, which is why the header sits second.

import fs from 'node:fs';
import { UsageError } from './args.mjs';
import { setQuiet, fail } from './report.mjs';
import * as tape from './tape.mjs';
import * as diskCmd from './disk.mjs';
import * as info from './info.mjs';
import * as runCmd from './run.mjs';
import * as crt from './crt.mjs';
import * as tapewrite from './tapewrite.mjs';
import * as loader from './loader.mjs';
import { d642t64, t642d64, t642tap, t642prg, tap2t64 } from './t64.mjs';
import { prg2turbo } from './turbo.mjs';
import { roms as romsCmd } from './roms.mjs';

const VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url))).version;

const USAGE = `
C64 READY. CLI v${VERSION} — Commodore 64 tapes, cartridges, and disks from the terminal

Commands are flat except disk: a group exists only where a single file has an
interior you edit, and a .d64 is the one file that has. Most take several
inputs, and a quoted wildcard works on any shell: c64rdy wav2tap "tapes/*.wav"

  FILE → FILE TRANSFORMS
    c64rdy d642prg  <in.d64>   [pattern]      Pull files out as .prg
    c64rdy d642t64  <in.d64…>  [-o out.t64]   Pack a disk's programs into a .t64
    c64rdy dmp2tap  <in.dmp…>  [-o out.tap]   DC2N dump  → .tap
    c64rdy prg2crt  <in.prg…>  [-o out.crt]   Wrap a PRG in a cartridge
    c64rdy prg2d64  <in.prg…>  [-o out.d64]   Wrap a PRG in its own disk
    c64rdy prg2tap  <in.prg…>  [-o out.tap]   Save a PRG onto a tape, for real
    c64rdy t642d64  <in.t64…>  [-o out.d64]   Unpack a .t64 archive onto disks
    c64rdy t642prg  <in.t64…>  [-d <dir>]     Take a .t64's files off it as .prg
    c64rdy t642tap  <in.t64…>  [-o out.tap]   Save an archive's files onto a tape
    c64rdy tap2d64  <in.tap…>  [-o out.d64]   Load a tape's programs onto disks
    c64rdy tap2prg  <in.tap…>  [-d <dir>]     Take a tape's programs off it as .prg
    c64rdy tap2t64  <in.tap…>  [-o out.t64]   Decode a tape's programs into a .t64
    c64rdy tap2wav  <in.tap…>  [-o out.wav]   .tap       → .wav
    c64rdy tapcat   <in.tap…>  [-o out.tap]   Join tapes end to end, in order
    c64rdy tapfix   <in.tap…>  [-o out.tap]   Mend a .tap
    c64rdy wav2tap  <in.wav…>  [-o out.tap]   Recording  → .tap
    c64rdy prg2turbo <in.prg…> [-o out.tap]   Save PRGs onto a fast turbo tape

  INFO ABOUT A FILE
    c64rdy dir      <tap|wav|dmp|d64|t64>…    What is on it, where, what state
    c64rdy info     <file…>                   One line: what kind of file it is

  BOOT THE MACHINE
    c64rdy loadtest <in.tap…>                 Do the programs actually load?
    c64rdy loader   <in.tap>                  Take the tape's own loader out and read it
    c64rdy run      <prg|tap|d64|t64|crt>     Boot it headless, save a PNG
    c64rdy roms     [<dir>]                   Remember the C64 ROM folder

  EDITABLE CONTAINER
    c64rdy disk new     <out.d64> [f.prg…]    Format a blank disk (add PRGs too)
    c64rdy disk add     <d.d64> <f.prg…>      Write PRGs into it
    c64rdy disk extract <d.d64> [pattern]     Pull files out as .prg (= d642prg)
    c64rdy disk rm      <d.d64> <pattern>     Scratch matching files, free blocks

  FLAGS
    --out-dir <dir>        Put outputs here instead of the directory you run from
    (dmp2tap, tapfix, tapcat, prg2d64, prg2crt, d642t64, t642d64, info, disk add: no flags
     of their own)

    wav2tap:  --no-mend --no-repair --channel <n|mix|aligned>
              --pre-emphasis <n> --ntsc --cpu-hz <hz>
    tap2wav:  --max-seconds <n>
    tap2d64:  --file <NAME> --roms <dir>   (boots each; -o names disk 1)
    tap2prg:  --file <NAME> -d <dir>   --via-machine  load them rather than
              decode: slower, misses the self-driving formats, and unreliable
              for a file that starts itself — but it knows where a
              relocatable file really lands
    tap2t64:  --file <NAME>   decoded off the tape, the way tap2prg is
    prg2tap:  --name <NAME> --roms <dir>   (the machine's own SAVE)
    prg2turbo: --name <NAME>  --loader <installer.prg> puts a loader at the front
              (probed: refused if it can't read what's written)  --format
              <turbo-tape-64|grl-supertape> name the loader's format
              --drive [--save-with '<cmd>'] write via the loader's own saver
              --trust skip the probe  --roms <dir>
    t642tap:  --roms <dir>   (the same SAVE, once per file, onto one tape)
    d642prg:  -d <dir>   Pattern "GAME*" — quote it or the shell expands it

    dir:      --damaged --seconds --pulses
    loadtest: --file <NAME> --roms <dir>
    loader:   --dump <file> --seconds <n> --roms <dir>
    run:      --frames <n> --roms <dir> --file <NAME> (off a .d64 or .tap)
              --all  Every program on a .d64 or .tap, one PNG each
              --collage  Tile a --all run into one sheet (animated if --anim)
              --anim [--fps <n>] [--speed <n>]  Film the run: an animated PNG
              --no-press  Leave a waiting screen alone (SPACE, then fire)
    disk new: --name <NAME> --id <ID>

    threads:  --jobs <n>  run --all, loadtest, tap2d64, tap2prg --via-machine
    global:   --help --version --quiet --force (write over a file that exists)

  EXIT CODES
    0  Done — a damaged tape is a result, not an error
    1  An input failed outright
    2  Wrong usage

Try it without installing: npx c64rdy dir tape.tap`;

// The flags that mean the same whatever the command. They may stand before it
// — `c64rdy --quiet info x.prg` is one sentence — and, like every flag, they
// stop at a `--`: past that, `--help` is a filename.
const GLOBAL_FLAGS = new Set(['--quiet', '--help', '--version']);

const COMMANDS = {
  dir: tape.dir,
  wav2tap: tape.wav2tap,
  tap2wav: tape.tap2wav,
  dmp2tap: tape.dmp2tap,
  tapfix: tape.tapfix,
  tapcat: tape.tapcat,
  prg2d64: diskCmd.prg2d64,
  prg2crt: crt.prg2crt,
  prg2tap: tapewrite.prg2tap,
  prg2turbo,
  d642prg: diskCmd.d642prg,
  disk: diskCmd.disk,
  info: info.run,
  run: runCmd.run,
  loadtest: runCmd.loadtest,
  tap2d64: runCmd.tap2d64,
  tap2prg: runCmd.tap2prg,
  d642t64,
  t642d64,
  t642tap,
  t642prg,
  tap2t64,
  loader: loader.run,
  roms: romsCmd,
};

async function main() {
  const argv = process.argv.slice(2);
  const stop = argv.indexOf('--');
  const flagsEnd = stop < 0 ? argv.length : stop;
  const said = flag => argv.indexOf(flag) >= 0 && argv.indexOf(flag) < flagsEnd;

  if (said('--quiet')) setQuiet(true);

  // The command is the first word that is not one of those global flags.
  let at = 0;
  while (at < flagsEnd && GLOBAL_FLAGS.has(argv[at])) at++;
  const cmd = argv[at];

  if (cmd === 'help' || said('--help')) {
    console.log(USAGE);
    return 0;
  }
  if (said('--version')) {
    console.log(VERSION);
    return 0;
  }
  if (!cmd) {
    console.log(USAGE);
    return 0;
  }
  const handler = COMMANDS[cmd];
  if (!handler) throw new UsageError(`Unknown command "${cmd}"`);
  // What the command sees: everything but its own name, and but the --quiet
  // this level has already answered — a --quiet past the `--` is a filename.
  const rest = argv.slice(at + 1).filter((a, i) => a !== '--quiet' || at + 1 + i >= flagsEnd);
  return await handler(rest);
}

try {
  process.exitCode = await main();
} catch (e) {
  if (e instanceof UsageError) {
    fail(e.message);
    fail('Run c64rdy --help for the command list.');
    process.exitCode = 2;
  } else {
    fail(`c64rdy: ${e.message}`);
    process.exitCode = 1;
  }
}
