# C64 READY. CLI — the command line for your cassettes, cartridges and disks

You have a stack of C64 cassettes recorded as WAV files, or a folder of `.tap`,
`.d64`, `.d71`, `.d81`, `.g64`, `.nbz`, `.crt` and `.prg` files, and you want to convert, inspect, repair and
run them in batches, without dragging each 285 MB recording through a browser.
`c64rdy` is the [C64 READY.](https://c64ready.com) tape and disk engine with a
terminal in front of it: the same decoder, the same repairs, the same listings,
scriptable and with no dependencies at all.

```
npx c64rdy dir tape.tap          # what's on it, where, and what state it's in
npx c64rdy wav2tap "*.wav"       # a shelf of recordings into .tap files at once
npx c64rdy run game.d64          # boot it headless, save a screenshot
```

A damaged tape is a result, not a crash. One quoted wildcard works on any
shell. Every conversion prints the directory it produced, so you always see
what you got.

## A whole tape, one picture

`run --all --collage` boots every program on a tape or disk and tiles them into
one sheet, each captioned from the C64's own character ROM. Add `--anim` and
every cell plays its own film. A real tape side, nineteen programs, one command:

```
npx c64rdy run side-a.tap --frames 2000 --roms roms --all --collage --anim --fps 25 --speed 2
```

![Every program on a tape side, tiled into one captioned sheet](https://raw.githubusercontent.com/mortyeriksen/c64ready/main/cli/docs/collage.webp)

## Who it's for

**The digitizer** has a shoebox of cassettes and a sound card. `wav2tap` turns
each recording into a `.tap`, mending the damage a worn tape leaves and saying
where it couldn't; `dir` and `loadtest` tell you what survived. One quoted
wildcard converts a whole shelf, and a damaged tape is a result, not a crash.

**The player** has a folder of downloaded games and wants to see one run.
`run` boots a `.prg`, `.tap`, `.d64`, `.d71`, `.d81`, `.g64`, `.crt` or `.t64` headless and saves a PNG
of the screen, or with `--all` a PNG for every program on a side at once, so
you can tell a working dump from a broken one without opening an emulator.

**The archivist** moves programs between the era's containers. `tap2d64`,
`t642d64`, `disk2prg` and the `prg2*` family convert in every direction that is
honest, each printing the directory it produced, so a tape becomes a disk
becomes a `.prg` and back with the bytes accounted for at every step.

**The tinkerer** builds tapes and disks from parts. `disk new`/`add` assemble a
`.d64` from loose `.prg` files, `prg2tap` and `prg2turbo` write real (and fast)
cassettes the machine's own SAVE produced, and `tapcat` joins sides: the
mixtape, made from the terminal.

## Install

Node 20.19 or newer, and nothing else. Run it without installing:

```
npx c64rdy dir tape.tap
```

Or keep it as a command:

```
npm install -g c64rdy
c64rdy --version
```

## What it can do

| | |
| --- | --- |
| **Recordings into tapes** | `wav2tap`, `dmp2tap`, `tapfix`, `tapcat` |
| **Tapes into anything** | `tap2wav`, `tap2d64`, `tap2prg`, `tap2t64` |
| **`.t64` archives** | `t642d64`, `t642prg`, `t642tap` out; `disk2t64` in |
| **D64/D71 into D81** | `disk2d81` |
| **Nibbler dumps into disks** | `nbz2g64` |
| **Programs into containers** | `prg2d64`, `prg2crt`, `prg2tap`, `prg2turbo` |
| **SID music into player or audio** | `sid2prg`, `sid2wav` |
| **Questions about a file** | `dir`, `info`, `loadtest`, `loader` |
| **Boot the machine** | `run` (a PNG of the screen, or an animated one) |
| **A disk's interior** | `disk new`, `disk add`, `disk rm`, `disk extract` |

`c64rdy --help` lists every command and flag.

Turn a SID tune into a runnable PRG with the same music player as the browser UI,
or render it as 16-bit WAV audio (mono for one SID, stereo for two):

```sh
c64rdy sid2prg tune.sid --song 2 -o player.prg
c64rdy sid2wav tune.sid --seconds 180 --roms roms
```

Both accept multiple inputs, quoted wildcards and `--out-dir`. `sid2wav` defaults
to three minutes at 44,100 Hz, with the SID model from the tune header (8580 when
unspecified). It supports `--sample-rate`, `--model 6581|8580` and `--song`.
Two-SID files use their header address and chip models, with SID 1 on the left
and SID 2 on the right. `--model` overrides both models. `sid2prg` reports the
second address required by the exported program.
Rendering is PAL, through the player's Safe view and the emulator's reSID engine.
The [CLI guide](https://github.com/mortyeriksen/c64ready/blob/main/docs/GUIDE-CLI.md#sid-music-player-programs-and-audio)
details the options and supported tunes.

## The ROMs

Commands that boot a machine need the C64's KERNAL, BASIC and character ROMs:
`run`, `loadtest`, `tap2d64`, `tap2prg --via-machine`, `prg2tap`, `t642tap` and
`loader`, plus `sid2wav`. `run` on a `.g64` also needs the 1541 ROM (`1541.bin`): a raw disk only boots through the emulated drive. `sid2prg` needs no ROMs. `prg2turbo` also needs them when using `--loader`, including the
`--drive` mode. The ROMs are copyrighted and are not bundled. Tell it once
where they are and it remembers:

```
c64rdy roms ~/c64/roms
```

Or put `kernal.bin`, `basic.bin` and `chargen.bin` in a `roms/` folder where
you run, or point `--roms <dir>` or `$C64_ROMS` at them. If VICE is installed,
its ROMs are found without any of that. Conversions that work directly on the
file formats, and inspections such as `dir` and `info`, need no ROMs.

## The full C64 in your browser

`c64rdy` is the terminal side of **C64 Ready**, the complete Commodore 64
running in your browser at **[c64ready.com](https://c64ready.com)**: the real
machine with its screen and SID sound, a datasette and disk drive you can watch
turn, and your library a drag away, with nothing to install. It is the same
engine under this CLI, so a tape you mend or a disk you build here loads there,
and a program you photograph with `run` is one you can sit down and play on the
site.

## More

The [full user guide](https://github.com/mortyeriksen/c64ready/blob/main/docs/GUIDE-CLI.md) walks every command with real captured
output, and the [specifications](https://github.com/mortyeriksen/c64ready/blob/main/docs/SPECIFICATIONS.md) credit the format references and
source material the tool is built on.

## License

GPL-3.0-or-later. © Morten Øien Eriksen. This package bundles part of the
C64 Ready emulator; the third-party materials it builds on (reSID and the
rest) are credited in
[NOTICE.txt](https://github.com/mortyeriksen/c64ready/blob/main/NOTICE.txt).

## Release notes

### Next version

- **Dumps restored like recordings.** `dmp2tap`, and `dir` on a `.dmp`, now
  rebuild damaged KERNAL copies from the copy that checks out, and rewrite
  sound Turbo Tape 64 blocks at clean widths, as `wav2tap` does. `--no-repair`
  and `--no-mend` leave either step out.
- **Repairs keep the next file in place.** A rebuilt KERNAL copy in `wav2tap`,
  `dmp2tap` or `tapfix` no longer overwrites the next file's lead-in or shifts
  the rest of the tape.

### 0.9.4

- **D64/D71 to D81.** `disk2d81` copies PRG, SEQ and USR files into a D81,
  preserving their bytes, names, types and lock flags.

- **Shared disk commands.** `disk2prg` and `disk2t64` detect D64, D71, D81
  and G64 input automatically, replacing the format-specific command names.
- **D71 disks.** List, run, create, edit and extract double-sided 1571 images.

- **G64 disk images.** `dir`, `info` and `disk extract` read `.g64` files,
  `disk2prg` and `disk2t64` pull files and archives out of one, and `run` boots
  one through the emulated 1541 (it needs the 1541 ROM). A `.g64` is read-only:
  `disk add` and `disk rm` refuse it.
- **Nibbler dumps.** `nbz2g64` turns a `.nbz` into a `.g64`, cut and aligned as
  nibtools' nibconv does it. `info` reads `.nib` and `.nbz`.
- **D81 disk images.** `dir`, `info`, `run` and the `disk` group take a
  1581's `.d81` (`disk new` formats one when the output name ends in `.d81`),
  and `disk2prg` and `disk2t64` pull files and archives out of one.

### 0.9.3

- Stereo PSID v2 files with separate chip flags are recognized as two-SID tunes.

- **Two-SID audio.** `sid2wav` exports two-chip tunes as stereo WAV, using the
  address and models in the tune header. `sid2prg` includes a player that keeps
  both chips audible and reports the required second-chip configuration.

### 0.9.2

- **SID tunes as programs and audio.** `sid2prg` includes the browser UI's C64
  music player in a runnable PRG. `sid2wav` records a selected song as 16-bit mono
  WAV, with duration, sample-rate and SID-model options.

- **`dir` stops warning about tapes that are fine.** A file that hands straight
  over to the game's own fast loader used to leave minutes of "carries a signal
  nothing here could read" under the listing, which reads as damage on a tape
  that has none. That line is now kept for signal no file on the tape accounts
  for.
- **PROCASS tapes list their files.** US Gold's own loader, the one under Out
  Run and Forgotten Worlds: `dir` now names every file on such a tape, and the
  converters explain its blocks as stages the game's own loader streams in.
- **A refused overwrite no longer stops a batch.** With `--jobs`, a `.d64`
  already on disk used to crash the whole run with a stack trace. It is now
  that one tape's failure line: the other tapes still get their disks, and
  `--force` still writes over.

### 0.9.1

Credits travel with the package: `NOTICE.txt` ships in the tarball, and the
README links the specifications and credits pages.

### 0.9.0 (first public release)

The full tape and disk toolchain from the terminal. `wav2tap` turns recordings
into `.tap` files, mending what it can and saying where it couldn't; `dir`,
`info`, `loadtest` and `loader` tell you what a file is and whether it loads.
Conversion runs in every honest direction between `.tap`, `.wav`, `.d64`,
`.t64`, `.prg` and `.crt`, and the `disk` group builds and edits a `.d64` from
loose programs. `prg2tap` and `prg2turbo` write real and fast cassettes with the
machine's own SAVE, `tapcat` joins sides, and `run` boots anything headless,
with `--all --collage` tiling a whole side into one sheet, animated if you like.
`c64rdy roms` remembers your ROM folder once. No dependencies; Node 20.19+.
