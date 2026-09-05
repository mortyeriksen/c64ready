# C64 READY. CLI — the command line for your cassettes, cartridges and disks

You have a stack of C64 cassettes recorded as WAV files, or a folder of `.tap`,
`.d64`, `.crt` and `.prg` files, and you want to convert, inspect, repair and
run them in batches, without dragging each 285 MB recording through a browser.
`c64rdy` is the [C64 Ready](https://c64ready.com) tape and disk engine with a
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
`run` boots a `.prg`, `.tap`, `.d64`, `.crt` or `.t64` headless and saves a PNG
of the screen, or with `--all` a PNG for every program on a side at once, so
you can tell a working dump from a broken one without opening an emulator.

**The archivist** moves programs between the era's containers. `tap2d64`,
`t642d64`, `d642prg` and the `prg2*` family convert in every direction that is
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
| **`.t64` archives** | `t642d64`, `t642prg`, `t642tap` out; `d642t64` in |
| **Programs into containers** | `prg2d64`, `prg2crt`, `prg2tap`, `prg2turbo` |
| **Questions about a file** | `dir`, `info`, `loadtest`, `loader` |
| **Boot the machine** | `run` (a PNG of the screen, or an animated one) |
| **A disk's interior** | `disk new`, `disk add`, `disk rm`, `disk extract` |

`c64rdy --help` lists every command and flag.

## The ROMs

Most commands need nothing. The ones that boot a real machine, `run`,
`loadtest`, `tap2d64`, `prg2tap` and `loader`, want the C64's KERNAL, BASIC and
character ROMs, which are copyrighted and so are not bundled. Tell it once
where they are and it remembers:

```
c64rdy roms ~/c64/roms
```

Or put `kernal.bin`, `basic.bin` and `chargen.bin` in a `roms/` folder where
you run, or point `--roms <dir>` or `$C64_ROMS` at them. If VICE is installed,
its ROMs are found without any of that. Conversion and inspection never need
them.

## The full C64 in your browser

`c64rdy` is the terminal side of **C64 Ready**, the complete Commodore 64
running in your browser at **[c64ready.com](https://c64ready.com)**: the real
machine with its screen and SID sound, a datasette and disk drive you can watch
turn, and your library a drag away, with nothing to install. It is the same
engine under this CLI, so a tape you mend or a disk you build here loads there,
and a program you photograph with `run` is one you can sit down and play on the
site.

## More

The [full user guide](https://github.com/mortyeriksen/c64ready/blob/main/docs/USER-GUIDE-CLI.md) walks every command with real captured
output, and the [specifications](https://github.com/mortyeriksen/c64ready/blob/main/docs/SPECIFICATIONS.md) credit the format references and
source material the tool is built on.

## License

GPL-3.0-or-later. © Morten Øien Eriksen. This package bundles part of the
C64 Ready emulator; the third-party materials it builds on (reSID and the
rest) are credited in
[NOTICE.txt](https://github.com/mortyeriksen/c64ready/blob/main/NOTICE.txt).

## Release notes

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
