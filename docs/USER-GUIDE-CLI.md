<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->

# User Guide CLI
<!-- Blocks under a `shot` marker are captured from real runs:
     node tools/cli-guide-shots.mjs  regenerates them all. -->

You have Commodore 64 tapes recorded as WAV files, or real `.tap`, `.d64`,
`.crt` and `.prg` files, and you want to convert, inspect and test them in
batches — without dragging each 285 MB recording through a browser dialog.
`c64rdy` is the C64 Ready tape and disk engine with a terminal in front of it:
the same decoder, the same repairs, the same listings.

| | |
| --- | --- |
| **Recordings → tapes** | `wav2tap`, `dmp2tap`, `tapfix`, `tapcat` |
| **Tapes → anything** | `tap2wav`, `tap2d64`, `tap2prg`, `tap2t64` |
| **.t64 archives** | `t642d64`, `t642prg` and `t642tap` out, `d642t64` in |
| **Programs → containers** | `prg2d64`, `prg2crt`, `prg2tap`, `prg2turbo` |
| **Questions** | `dir`, `info`, `loadtest`, `loader` |
| **The machine** | `run` |
| **A disk's interior** | `disk new`, `disk add`, `disk rm`, `disk extract` (= `d642prg`) |

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
cassettes the machine's own SAVE produced, and `tapcat` joins sides. The
mixtape, made from the terminal.

## Installing

Node 20.19 or newer, and nothing else: the tool has no npm dependencies at all.

Until the first release it lives in this repo, so run it in place or link it:

```
node cli/c64rdy.mjs dir tape.tap     # in place, from the repo root
cd cli && npm link                   # or make `c64rdy` a real command
c64rdy --version
npm rm -g c64rdy                     # …and take it off again
```

Once released, `npx c64rdy dir tape.tap` needs no install at all, and
`npm i -g c64rdy` keeps it.

**The ROMs.** Only the commands that boot a machine want them — `run`,
`loadtest`, `tap2d64`, `tap2prg --via-machine`, `prg2tap`, `loader` — and they are
copyrighted, so nothing is
bundled. Put `kernal.bin`, `basic.bin` and `chargen.bin` in a `roms/` folder
where you run, or point `--roms <dir>` or `$C64_ROMS` at them, or run
`c64rdy roms <dir>` once and it remembers the folder. If VICE is installed, its
own ROMs are found without any of that.

Most of what follows takes several inputs at once, and wildcards work two
ways: your shell expands `*.wav` before the tool sees it, and the tool expands
a **quoted** `"*.wav"` itself — so the same command line works on a Unix
shell, on Windows, and inside a script where the pattern is a variable. A
pattern matching nothing is a usage error rather than a silent no-op, and a
file that genuinely has a `*` in its name is still just a file. The wildcards
are a shell's: `*` any run of characters, `?` one, `[ab]` and `[a-z]` a set,
`[!ab]` anything but.

```
c64rdy wav2tap ~/tapes/*.wav       # the shell expands it
c64rdy wav2tap "tapes/*.wav"       # the tool expands it — same result

# Quotes stop the shell expanding `~` too, so spell the path out:
c64rdy wav2tap "$HOME/tapes/*.wav"
```

Two commands still take exactly one input, because each works *inside* one
container: `run` and `disk extract` (`d642prg`).

And a **damaged tape is a result, not an error**: the exit code is non-zero
only when an input failed outright (or usage was wrong, which exits 2).

## Turn recordings into tapes

```
c64rdy wav2tap ~/tapes/*.wav
```

Each recording becomes a `.tap` in the directory you run from (`--out-dir`
puts them elsewhere, `-o` names a single output) — never in the recording's own
folder, which a tool has no business writing into uninvited. While it works you get a progress bar; when it is
done, the tape's listing and an honest summary:

```
6 of 7 files readable. 1 mended from a second reading.
```

Damaged files are mended where the tape can prove the fix — a second reading
of the signal, or the KERNAL's own duplicate block — and flagged where it
cannot. Useful flags: `--channel <n|mix|aligned>` to force which reading of a
stereo transfer is used, `--pre-emphasis <n>` for a treble lift, `--no-mend` /
`--no-repair` to see the tape exactly as it came, and `--ntsc` (or
`--cpu-hz <hz>`) when the tape was written for an NTSC machine.

## Ask what is on something

<!-- shot lines=11: c64rdy dir "Tape 2 - Side B.tap" -->
```
$ c64rdy dir "Tape 2 - Side B.tap"
Tape 2 - Side B.tap
16:03  ·  KERNAL + Turbo Tape 64  ·  18 files, 16 readable
The deck that wrote this ran 3.1% fast

   #  WIND TO  STARTS  NAME              FORMAT  LOAD         SIZE  STATUS
   1     0:02    0:09  TURBO TAPE 64     KERNAL  $0801-$1000    2K  ok
   2     0:57    0:59  OLYMPIA           Turbo   $0801-$1000    2K  ok
   3     1:06    1:08  USA               Turbo   $0801-$1000    2K  ok
   4     1:15    1:18  GREMLINS II       Turbo   $0801-$8505   31K  ok
   5     2:29    2:32  PIT STOP          Turbo   $0801-$4906   16K  ok
   6     3:10    3:13  PHARAD'S CURSE    Turbo   $0801-$9E23   38K  ok
…
```

That is one real side, and it shows the shape of the thing: a KERNAL file at
the front that installs the turbo loader, and then the programs that loader
reads. Further down the side sit the files the transfer damaged, each row
saying what the damage was.

The two time columns are the point, and they are not interchangeable:
**WIND TO** is the head of the file's lead-in — where a deck must be wound
back to for the loader to find it — and **STARTS** is where the data itself
begins. Wind to the first, not the second.

The header tells you about the tape as a whole: how long it plays, which
loader formats it carries, how far off speed the recording deck ran (measured,
not guessed), and — when part of the tape holds a signal no known loader could
read — how much, so "it only found 3 files" becomes "…and twelve minutes
belong to a loader this does not know".

`dir` works on `.tap`, `.d64`, `.t64` archives, DC2N `.dmp` dumps, and
directly on a `.wav` recording (at the cost of the full decode). Flags: `--damaged` shows only the
broken rows, `--seconds` prints raw seconds instead of `m:ss`, `--pulses` adds
pulse indexes for diagnosis. Times are PAL; on an NTSC recording they read
about 1% long — fine for winding a deck.

Two companions:

- `c64rdy info <file…>` — one line per file: what is this?
  <!-- shot: c64rdy info hello.prg disk.d64 -->
  ```
  $ c64rdy info hello.prg disk.d64
  hello.prg — program file (.prg), loads $0801-$0819, 24 bytes
  disk.d64 — disk image (.d64, 35 tracks), "TEST DISK", 1 file, 663 blocks free
  ```
- `c64rdy loader tape.tap` — the tape holds a format nothing can read, and you
  want to know what reads it. A tape's loader is on the tape: the KERNAL block
  it boots from either is that loader or fetches it. This takes it out and shows
  it to you.

  <!-- shot lines=16: c64rdy loader BMX_Simulator.tap --seconds 10 -->
  ```
  $ c64rdy loader BMX_Simulator.tap --seconds 10
  BMX_Simulator.tap

  Stretches no format here accounts for

    0:22-5:53, 765753 pulses:
      CYCLES  PULSES
         296  434162
         584  331510
         376  80
         696  1

    Two symbols, then: 296 and 584 cycles, midpoint 440.
    What the loader below compares against is usually not that midpoint.

    0:00-0:02, 6195 pulses, one width around 376 cycles.
    Lead-in or pilot tone rather than a format: one width carries no bits.
  …
  ```

  Four things, which between them are what learning a format takes:

  - **the pulse widths of the stretch nothing could read**, which name the two
    symbols the unknown loader writes. Taken over that stretch and not the whole
    tape, because a loader's widths and the KERNAL's collide: The Goonies writes
    512 cycles and the KERNAL's medium pulse is 528.
  - **each KERNAL block disassembled where it landed**, loaded through the real
    ROM. This is the loader itself, or the code that fetches it.
  - **the machine let go afterwards**, and then which pages it runs from, which
    interrupt vector it moved, and a disassembly from there. A block that
    decrypts itself says nothing until it has run, so this is read out of memory
    and not off the tape.
  - **the CIA timer latches it left**, which is how a loader measures a pulse:
    arm a timer, and at the next tape edge ask how much is left. So the bit
    threshold is not the midpoint between the two symbols but wherever that
    comparison falls. Every commercial format read so far worked out this way —
    Novaload at 500 cycles, US Gold / Datasoft at 363, Gremlin Type 2 at 592,
    none of them a midpoint.

  `--dump mem.bin` writes all 64 KB out, address 0 at offset 0, for reading
  elsewhere. `--seconds N` is how long to let the loader run before looking; the
  default is 60, and a loader that has not started yet wants more.

  It concludes nothing. It puts in one place the things that were needed each
  time, so that reading the loader is the work rather than the digging.

- `c64rdy loadtest tape.tap` — don't just list the programs, **load** them:
  each file is wound to, LOADed through the real KERNAL (or the tape's own
  turbo loader, installed and driven the way a person would), and judged by
  whether the memory it names actually filled. A turbo file is offered each
  command its family answers to in turn — `←L` for the Turbo 250 tools, plain
  `LOAD` for Turbo Tape 64 itself, which patches the KERNAL's own, and `SYS300`
  for GRL-Supertape — so a loader that ignores the first is not written off.
  A file that starts *itself* counts as loaded too: a tape loader writes one of
  the KERNAL's jump vectors over with an address of its own, which is the only
  way to take the machine without a person typing RUN, and the listing says
  `and took over` when it happens. Without that rule such a file waits for a
  tape that never stops and is written off after three and a half minutes.
  Slow and thorough; `--file NAME` tests just one. The listing gains a LOADS
  column — here on a side whose loader reads the whole tape itself, so its
  files share the one verdict:
  <!-- shot lines=12 slow: c64rdy loadtest Bomb_Jack.tap -->
  ```
  $ c64rdy loadtest Bomb_Jack.tap
  Bomb_Jack.tap
  4:38  ·  KERNAL + Novaload  ·  3 files, 3 readable

    #  WIND TO  STARTS  NAME       FORMAT    LOAD          SIZE  STATUS  LOADS
    1     0:02    0:10  BOMBJACK   KERNAL    $CC49-$CCF9   176B  ok      loads (19s of tape)
    2     0:21    0:22  (no name)  Novaload  $0800-$10000   54K  ok      loads with the side (played 262s)
    3     4:01    4:02  (no name)  Novaload  $E000-$FFF0     8K  ok      loads with the side (played 262s)

  3 of 3 files load.
  ```

## Convert and repair

```
c64rdy tap2wav game.tap            # .tap → audio, e.g. to play into a real C64
c64rdy dmp2tap side-a.dmp          # DC2N datasette dump → .tap
c64rdy tapfix side-a.tap           # mend a .tap in place of guessing
c64rdy prg2d64 game.prg            # wrap a PRG in its own bootable disk
```

`tap2wav` always writes the whole tape, however long it plays; give
`--max-seconds` only if you want it cut, and it will say when it did.
`tapfix` writes `<name>-mended.tap` with every file the tape itself can prove
repaired, and names what stayed broken.

<!-- shot lines=12: c64rdy tapfix "Tape 3 - Side A.tap" -->
```
$ c64rdy tapfix "Tape 3 - Side A.tap"
Tape 3 - Side A.tap: nothing to mend
```

## Join tapes

```
c64rdy tapcat side-a.tap side-b.tap -o whole-tape.tap
```

Tapes join end to end, in the order given, onto one — a side rebuilt from the
halves it was transferred in, or a freshly saved program wound onto the end of
an existing side. Nothing is invented at a seam: each tape keeps its own
lead-in, the way a deck that was stopped and started again left it, and the
report says where on the joined tape each source begins. Without `-o` it
writes `<first>-joined.tap`.

The one rule is that the tapes must agree on what a byte means. A v0 tape
joining a v1 tape is respelled in v1's long form using the same 2048-cycle
value every reader here already gives a v0 zero byte — the same pulses, read
the same — and a half-wave v2 tape joins only its own kind, because its bytes
mean different tape.

<!-- shot lines=13: c64rdy tapcat BMX_Simulator.tap Bomb_Jack.tap -->
```
$ c64rdy tapcat BMX_Simulator.tap Bomb_Jack.tap
 0:00  BMX_Simulator.tap
 5:56  Bomb_Jack.tap

BMX_Simulator-joined.tap
10:34  ·  KERNAL + Novaload  ·  4 files, 4 readable
5:33 carries a signal nothing here could read

  #  WIND TO  STARTS  NAME           FORMAT    LOAD          SIZE  STATUS
  1     0:02    0:10  BMX SIMULATOR  KERNAL    $029F-$03C0   289B  ok
  2     5:58    6:06  BOMBJACK       KERNAL    $CC49-$CCF9   176B  ok
  3     6:17    6:18  (no name)      Novaload  $0800-$10000   54K  ok
  4     9:57    9:58  (no name)      Novaload  $E000-$FFF0     8K  ok
```

## From tape to disk

```
c64rdy tap2d64 side-a.tap
```

Every program on the tape is **actually loaded** — through the real KERNAL, or
through the tape's own turbo loader — and what provably arrived in memory is
written onto a disk image. Nothing is decoded on faith: a program lands on the
disk only if it loads, so the disk is exactly what a real C64 got from the
cassette. Files that fail say why, in the same LOADS column `loadtest` uses:

<!-- shot tail=12 slow: c64rdy tap2d64 "Tape 2 - Side B.tap" --file OLYMPIA -->
```
$ c64rdy tap2d64 "Tape 2 - Side B.tap" --file OLYMPIA
…
  15    11:56   11:59  JUNGLE HUNT       Turbo   $0801-$4852   16K  ok
  16    12:38   12:40  SPY HUNTER        Turbo   $0801-$7DB6   29K  ok
  17    13:49   13:51  BOOTY             Turbo   $0801-$7DB6   29K  1 drop, 2 bytes lost
  18    15:00   15:02  HOUSE OF THE OSH  Turbo   $0801-$6AA0   25K  ok

Tape 2 - Side B.d64
"TAPE 2 - SIDE B" 01 2A  ·  35 tracks  ·  655 blocks free

  BLOCKS  NAME       TYPE
       9  "OLYMPIA"  PRG

1 of 1 program written to 1 disk.
```

A tape side usually holds more than a D64's 664 blocks, so the set spills onto
`side-a-2.d64`, `side-a-3.d64`… as needed — `-o` names disk 1 and the rest
number from it — and duplicate tape names get a numbered suffix on disk.
`--file NAME` converts just one program, and several tapes can be named at
once (`c64rdy tap2d64 "tapes/*.tap"`) — each gets its own disk set. Like
`loadtest`, this drives the machine in real tape time — thorough, not fast —
and needs the ROMs (see below).

Two honest caveats. A multi-part game — one that keeps reading the tape after
its first file — gets its first program faithfully, but the disk cannot hold
the parts the loader would have streamed later. And a file that loads into
screen memory (`$0400`–`$07FF`) is **not judged at all**: the KERNAL prints
SEARCHING, FOUND and LOADING over those same bytes as it works, so what the
tape put there and what the screen editor put there cannot be told apart. Such
a file says `cannot be judged` rather than yes or no, and nothing is written
from it — it belongs to a loader that keeps quiet, not to `LOAD`.

## From tape to .prg

`tap2prg` takes a tape's programs off it as `.prg` files — `tap2d64` without the
disk in the way: no 16-character names, no directory to fill, no spilling onto a
second image.

```
c64rdy tap2prg "Tape 2 - Side B.tap" -d out/
c64rdy tap2prg tape.tap --file OLYMPIA        # just the one
```

**It decodes the tape rather than playing it.** No ROMs, no machine, no waiting,
and it reaches the formats whose loader fills the whole machine and leaves no one
file to keep — the five where `tap2d64` can only say "there is no one file to
keep". A block whose checksum failed is refused rather than written: its bytes
are partly invented, and a program minted out of a guess is worse than an honest
gap.

<!-- shot lines=14: c64rdy tap2prg Bomb_Jack.tap -d out -->
```
$ c64rdy tap2prg Bomb_Jack.tap -d out
Bomb_Jack.tap
4:38  ·  KERNAL + Novaload  ·  3 files, 3 readable

  #  WIND TO  STARTS  NAME       FORMAT    LOAD          SIZE  STATUS  LOADS
  1     0:02    0:10  BOMBJACK   KERNAL    $CC49-$CCF9   176B  ok      → BOMBJACK.prg (178 bytes), relocatable
  2     0:21    0:22  (no name)  Novaload  $0800-$10000   54K  ok      → 02-0800.prg (63490 bytes)
  3     4:01    4:02  (no name)  Novaload  $E000-$FFF0     8K  ok      → 03-e000.prg (8178 bytes)

This tape is read by its own loader, and the loader starts the game itself.
The blocks carry no entry point, so nothing taken off this tape starts on
its own. The tape is the game: c64rdy run plays it.

3 of 3 programs decoded to out.
1 file is relocatable: the address written is the one the
…
```

That closing paragraph is the tool being straight with you: a tape read by its
own loader yields its blocks, and blocks are not programs. The note names which
kind of loader tape this is — one that starts the game itself, or one that keeps
reading the tape as the game plays.

**`--via-machine` loads them instead**, the way `tap2d64` does, through the real
KERNAL or the tape's own turbo loader. It answers exactly one question decoding
cannot: **where a relocatable file really lands.** A type 1 file is relocatable
and a plain LOAD ignores the address in its header — Bomb Jack's boot block says
`$CC49` and lands at `$0801`. Decoding writes what the tape says and names which
files are relocatable; this writes where they landed, from the KERNAL's own
account.

```
c64rdy tap2prg tape.tap --via-machine --roms roms
```

Everything else about it is weaker. It is slow, a side taking minutes against a
fraction of a second. It cannot touch the self-driving formats at all. And for a
file that **starts itself** it is not reading the file: what it reads is memory,
and a block that has begun executing has had time to rework it. The Goonies'
boot block takes the machine at `$0318`, and by the time the load is done the
KERNAL has its own I/O vectors back over the block's own bytes from `$031A` up —
52 of its 168 bytes are no longer what the tape carries. Those files are called
out in the report as *ran on arrival*; decode them instead.

**Where both routes work, comparing them is worth doing.** Agreement byte for
byte confirms both — the Turbo Tape 64 file and Bomb Jack's boot block come out
identical. Disagreement is one of three things, and the report tells you which:
relocation, a block that ran on arrival, or a decoder bug.

Names come off the tape where there are any. Most turbo files and every
self-driving one are anonymous, and those are named by where they sit on the tape
and where they load, the way the listing identifies them: `03-0810.prg`. Two
files called the same thing stay two files, the second becoming `GAME-2.prg`.

## The .t64 archives

A `.t64` is not a tape, whatever the name says: it is an archive of decoded
files — name, load address, bytes — with no signal in it, so nothing can play
one. What it holds maps straight onto a disk:

<!-- shot: c64rdy t642d64 "Chopper Demo.t64" -->
```
$ c64rdy t642d64 "Chopper Demo.t64"
Chopper Demo.t64  ·  "->ZYRON'S PD<-"
  #  NAME                     LOAD  SIZE
  1  CHOPPER DEMO/TSW  $0801-$3674   12K  → Chopper Demo.d64 as CHOPPER DEMO/TSW

Chopper Demo.d64
"CHOPPER DEMO" 01 2A  ·  35 tracks  ·  617 blocks free

  BLOCKS  NAME                TYPE
      47  "CHOPPER DEMO/TSW"  PRG

1 of 1 file written to 1 disk.
```

Archives in the wild are sloppy in two well-known ways, and both are read
around rather than tripped over: a used-entries count of zero on an archive
that holds a file, and an end address the container cannot honour — a file's
length is measured against the bytes the archive actually holds, and the row
says so when the directory claimed more. Memory snapshots are skipped by name;
they are frozen machines, not files. Several archives convert at once, and
`-o` names the disk. `dir` lists an archive without converting anything, and
`t642prg <in.t64> -d out/` takes its files straight out as `.prg`, since an
archive is already a bag of programs: a direct unpack rather than a trip
through a disk.

An archive can also go back to being a tape. `t642tap` saves its files onto
one recording — the machine's own SAVE once per file, the same honest writer
`prg2tap` uses — which gives an archive the signal it never had: the result
plays in `run`, loads on a real datasette via `tap2wav`, and is a KERNAL tape
whatever loader wrote the files originally. What the KERNAL cannot reach it
does not pretend to: a file running past $D000 — into the I/O registers and
the KERNAL's own ROM — is left with the reason on its row, exactly as a real
machine's SAVE would have had to leave it. A file ending above BASIC's top
($A000) saves and loads whole, but its LOAD ends in ?OUT OF MEMORY and RUN
cannot start it — real hardware again — so the row names the SYS that does,
and `run` types that SYS itself.

<!-- shot: c64rdy t642tap "Chopper Demo.t64" -->
```
$ c64rdy t642tap "Chopper Demo.t64"
Chopper Demo.t64  ·  "->ZYRON'S PD<-"
  #  NAME                     LOAD  SIZE
  1  CHOPPER DEMO/TSW  $0801-$3674   12K  → "CHOPPER DEMO/TSW"

Chopper Demo.tap
4:04  ·  KERNAL  ·  1 file, 1 readable

  #  WIND TO  STARTS  NAME              FORMAT  LOAD         SIZE  STATUS
  1     0:03    0:11  CHOPPER DEMO/TSW  KERNAL  $0801-$3674   12K  ok

1 of 1 file saved onto 4:04 of tape.
```

The other direction packs one. `d642t64` puts a disk's programs into an
archive under their own names, labelled what the disk is labelled — and
`tap2t64` decodes a tape's programs into one, which is the instantly LOADable
form of a turbo tape, kept under the names and addresses the tape itself
claims:

<!-- shot: c64rdy d642t64 disk.d64 -->
```
$ c64rdy d642t64 disk.d64
disk.d64  ·  "TEST DISK"
  #  NAME          LOAD  SIZE
  1  HELLO  $0801-$0819   24B

1 of 1 file archived into disk.t64.
```

<!-- shot: c64rdy tap2t64 Bomb_Jack.tap -->
```
$ c64rdy tap2t64 Bomb_Jack.tap
Bomb_Jack.tap
4:38  ·  KERNAL + Novaload  ·  3 files, 3 readable

  #  WIND TO  STARTS  NAME       FORMAT    LOAD          SIZE  STATUS  LOADS
  1     0:02    0:10  BOMBJACK   KERNAL    $CC49-$CCF9   176B  ok      → "BOMBJACK"
  2     0:21    0:22  (no name)  Novaload  $0800-$10000   54K  ok      → "02-0800"
  3     4:01    4:02  (no name)  Novaload  $E000-$FFF0     8K  ok      → "03-E000"

This tape is read by its own loader, and the loader starts the game itself.
The blocks carry no entry point, so nothing taken off this tape starts on
its own. The tape is the game: c64rdy run plays it.

3 of 3 programs archived into Bomb_Jack.t64.
```

What cannot map says so instead of vanishing: a SEQ file is data with no load
address to give an entry, a damaged chain is refused rather than invented, and
a damaged tape file stays on the tape. The archive written is the documented
layout with none of the wild's sloppiness — its used-entries count counts and
its end addresses are real — so it reads back anywhere, including here.

The format is Miha Peternel's, made for the C64S emulator; the layout on both
directions is [Peter Schepers' T64 document](https://ist.uwaterloo.ca/~schepers/formats/T64.TXT),
quirks included on the way in.

## Disk images

The one command group, because a `.d64` is the one file you edit over its
lifetime:

```
c64rdy disk new mydisk.d64 game.prg tools.prg --name "MY DISK"
c64rdy disk add mydisk.d64 more.prg
c64rdy disk rm  mydisk.d64 "TOOLS"
c64rdy disk extract mydisk.d64 "GAME*" -d out/
```

`new` formats a blank 35-track disk (664 blocks free) and refuses to reformat
an existing file unless `--force` says so; name PRGs on the same line and they
go straight in, so a disk is built in one command. `add` writes more PRGs in
later, under DOS-shaped names. `rm` scratches files a pattern matches and gives
their blocks back. `extract` pulls files back out byte-identical, with DOS's
own pattern rules — `*` and `?`, `"AL"` does not match `ALPHA` but `"AL*"` does.

Extraction answers to a second name, since `prg2d64` invites its inverse:

```
c64rdy d642prg mydisk.d64                    # every file on the disk
c64rdy d642prg mydisk.d64 "GAME*" -d out/    # the same command, other door
c64rdy d642prg mydisk.d64 "?ELLO"            # ? is one character
```

**Quote the pattern.** A bare `*` never reaches the tool — the shell expands
it into your local filenames first, and the command sees a dozen arguments
instead of a pattern. It fails loudly rather than quietly, but the fix is
quotes, or simply leaving the pattern out: no pattern already means every
file. A pattern that matches nothing says so and exits 1.

## Wrap a program in a cartridge

```
c64rdy prg2crt game.prg                  # → game.crt
c64rdy prg2crt out/*.prg --out-dir carts/
```

A cartridge is ROM the machine maps over its own memory, so a program cannot
simply be laid inside one: at $8000 the ROM stands exactly where the program's
RAM has to be. The way out is a cartridge that can step aside — Magic Desk,
which takes a bank number at `$DE00` and leaves the map alone when bit 7 is
set. So `prg2crt` writes a Magic Desk image whose first bank holds a loader:
it initialises the machine the way a reset would, copies the program out of
the other banks into RAM, switches the cartridge out of the map, and starts
the program — `SYS` for a program with a BASIC stub, `RUN` for a BASIC one.

```
hello.prg → hello.crt
  Magic Desk, 2 banks · loads to $801 · starts with RUN
```

Sixty-three banks of 8K are available, so any `.prg` fits. Two conditions: the
program must be a single load — nothing that goes back to tape or disk for a
later part — and it must load at `$0200` or above, since the copier itself
runs at `$0100`. Check the result the way you would check anything else:
`c64rdy run game.crt`.

## Write a program back onto tape

```
c64rdy prg2tap game.prg                     # → game.tap
c64rdy prg2tap game.prg --name "MY GAME"    # the name the tape carries
c64rdy tap2wav game.tap                     # …and audio for a real datasette
```

Nothing here encodes a pulse by hand. The program is put in memory, RECORD is
pressed, and **the KERNAL's own SAVE writes the tape** through the emulated
datasette, exactly as it would on a desk — so what comes out is a tape a C64
wrote. It is saved non-relocatable, so the header carries the address the
program really loads at — and the SAVE is called the way a machine-language
saver called it, with BASIC ROM banked out, so a program living under that ROM
($A000 up) saves as its own bytes rather than BASIC's.

The listing of what was just written is printed as proof, read back by the
same decoder `dir` uses:

<!-- shot lines=10 slow: c64rdy prg2tap hello.prg -->
```
$ c64rdy prg2tap hello.prg
hello.prg → hello.tap
  "HELLO" · $0801-$0819 · 0:18 of tape

hello.tap
0:18  ·  KERNAL  ·  1 file, 1 readable

  #  WIND TO  STARTS  NAME   FORMAT  LOAD         SIZE  STATUS
  1     0:03    0:11  HELLO  KERNAL  $0801-$0819   24B  ok
```

The cost is honest: the KERNAL writes about a hundred bytes a second and
writes everything twice, so a 30K program is minutes of tape — emulated, but
every second of it. Pair it with `tap2wav` and the result plays into a real
datasette. `t642tap` uses the same writer to put a whole `.t64` archive onto
one recording, a SAVE per file.

## Fast turbo tapes

`prg2tap` writes at the KERNAL's honest hundred bytes a second. A turbo loader
does five to ten times better, and `prg2turbo` writes one — Turbo Tape 64, the
format nineteen tools of the era all wrote:

<!-- shot: c64rdy prg2turbo hello.prg -->
```
$ c64rdy prg2turbo hello.prg
hello.tap
  1  HELLO            $0801-$0819  24B

hello.tap
0:04  ·  Turbo Tape 64  ·  1 file, 1 readable

  #  WIND TO  STARTS  NAME   FORMAT  LOAD         SIZE  STATUS
  1     0:00    0:02  HELLO  Turbo   $0801-$0819   24B  ok

1 program written as Turbo Tape 64.
The tape carries no loader of its own — join it after one with tapcat, or add --loader.
```

The bytes are synthesized, no machine involved, so a 40K program is about eighty
seconds of tape rather than thirteen minutes. The tape it makes carries the
programs but no reader for itself; `--loader <installer.prg>` puts one at the
front — your own copy of Super Tape, Turbo 250, FCS or any of the family, saved
as an ordinary KERNAL file — so the tape loads itself: `LOAD`, `RUN`, then the
loader takes each turbo file. Point `loadtest` at the result and every file
loads.

The loader is checked, not trusted: with `--loader` the installer is run and
offered a synthesized file, and if it cannot read one the tape is refused
rather than written — so pointing a GRL-Supertape loader at Turbo-Tape-64 files
stops with a clear message instead of making a tape that will not load. Name a
known format with `--format <turbo-tape-64|grl-supertape>` to skip the probe,
or `--trust` to skip it outright.

A format this cannot synthesize (GRL-Supertape) is written by the tool's own
saver — `--format grl-supertape`, or `--drive --save-with 'SYS310"{NAME}"'` for
an unlisted tool. That is only as good as the tool underneath: a saver whose
loader sits where the program loads cannot save one that large, so the driven
tape is read back and refused if a program did not come off at its right size.
The machine paths (`--loader`, `--format`, `--drive`) want ROMs, the same
`--roms` / `$C64_ROMS` as everything that boots.

## Boot it and look

```
c64rdy run game.prg                # → game.png
c64rdy run game.prg --anim         # → game.png, moving
c64rdy run mydisk.d64 --frames 900
c64rdy run mydisk.d64 --file "GAME 2"
c64rdy run side-a.tap --file "BR TR CHINA"
c64rdy run side-a.tap --all --out-dir shots/
c64rdy run cart.crt -o shot.png
c64rdy run game.t64 --all
```

Boots the machine headless — a PRG through the BASIC stub's own SYS, a disk
through `LOAD"*",8,1` and RUN, a tape through the loader the tape itself
carries, a cartridge through its own reset — runs the requested frames, and
saves a PNG of the screen. A `.t64` holds no signal to boot, so it runs as the
disk its programs pack onto: `--file` and `--all` then work as they do for any
disk.

On a disk, `--file NAME` loads that program instead of the first one, typed
the way a person types it (`LOAD"NAME",8,1` then RUN), DOS wildcards included:
`--file "GAME*"` works — and a name the disk does not hold fails before
anything boots, listing what it does hold. `--all` runs **every** program on
the disk, each on a fresh machine, one PNG per program (`disk-NAME.png`) — the
quick way to see what a `tap2d64` set actually contains. There is no separate
"prg plus disk" mode — to run a specific program from a disk, name it; to run
a loose `.prg`, run the file itself.

`--collage` gathers that `--all` run into one sheet next to the individual
PNGs: `<name>-collage.png`, every program tiled and captioned from the C64's own
character ROM. With `--anim` the sheet animates, each cell playing its own film
and holding on its last frame once the shorter ones end. It runs on one thread,
since the pictures are composed here rather than in a worker.

```
c64rdy run side-a.tap --all --anim --collage --out-dir shots/
```

A `.tap` boots too, and it is the slow one: the program is loaded exactly as
`loadtest` loads it — through the KERNAL, or through the tape's own turbo
loader — which takes real tape time, a minute or two for a full-size program.
Then it is started the way the machine offers: most turbo loaders start it
themselves, and one that drops back to a BASIC prompt gets `RUN` typed, or
`SYS` for a program that did not load at the BASIC start. It is given thirty
seconds to show itself (`--frames` cuts that shorter), because a tape program
often decrunches or plays an intro first. Without `--file`, the tape runs its
first program — passing over the turbo loader at the front, which is on the
tape to serve the others rather than to be looked at.

`--all` works on a tape too, and it is the whole side as pictures: every
program loaded for real, started, and photographed, one PNG each. It is one
tape's worth of loading — twenty minutes of it for a full side — so it runs on
several threads at once, and a program that will not load says so
in its own line rather than stopping the rest:

```
TURBO 250         → side-a-TURBO-250.png  (33s of tape, RUN typed)
TRAILBLAZER       → does not load — ?LOAD ERROR
BR TR CHINA       → side-a-BR-TR-CHINA.png  (69s of tape, started by the loader)
```

For repeated runs of the same programs, `tap2d64` the tape once and run the
disk instead: the tape time is paid once and every program is then a moment
away.

**A screen that stops moving gets pressed past.** Half the games on a tape
stop at `PRESS ANY KEY TO CONTINUE` or `PRESS FIRE`, and a run that sits there
photographs a title screen instead of a game. So the screen is watched: when
it has not moved for three seconds, `run` does what a person would — the space
bar, then the fire button on port 2, alternating, up to three times — and says
so afterwards:

```
game.png  (1500 frames after start, pressed past 2 waits)
```

`--no-press` leaves it alone, for when the title screen is the picture you
wanted.

`--anim` keeps the whole run instead of its last frame: the screen is filmed
five times a second and written as an animated PNG. It is still a `.png` with
the same name — a viewer that knows nothing of APNG shows the final screen,
the very image a still run writes, byte for byte.

Two knobs shape the film, and naming either one is enough to ask for it:
`--fps <n>` is how often the screen is filmed, five times a second by default
and fifty at most, which is every frame the machine makes. `--speed <n>` is how
fast the film runs against the machine. Left alone it plays at the machine's own
50 frames a second, so the default `--fps 5` shows the run at **10× speed** —
the 200 frames of a `.prg` run become 20 frames playing in four tenths of a
second, on a loop — while `--fps 50` plays in real time. Say `--speed 1` for
real time whatever the filming rate, `--speed 10` for ten times over:

```
c64rdy run game.prg --anim                 # 5 fps, 10× speed
c64rdy run game.prg --anim --speed 1       # 5 fps, real time — a flip-book
c64rdy run game.prg --fps 50 --speed 1     # every frame, real time
c64rdy run mydisk.d64 --fps 2 --speed 12.5 # a 25× flick through a long load
```

A frame carries only the rectangle that changed, and a screen the machine
left alone holds the frame before it rather than repeating it — so a film of a
program that settles early is a handful of frames, not a hundred identical
ones. The length is the same either way, and the report says when it happened:
`20 filmed at 5 fps (1 distinct)` means nineteen of the twenty screens were
the one before them.

`run`, `loadtest`, `tap2d64` and `prg2tap` need the C64 ROMs, which are
copyrighted and never bundled. They are looked for in this order:
`--roms <dir>`, `$C64_ROMS`, `./roms` (as `kernal.bin`, `basic.bin`,
`chargen.bin`), then a VICE installation's own ROM folder — so if VICE is
installed, it just works.

## Threads

The commands that boot a machine per program run them side by side: `loadtest`
and `tap2d64` load each file on its own machine, and `run --all` boots each
program on its own. By default it uses **half your cores** — enough to be
worth threading, while leaving the machine answering the person who started
it. `--jobs <n>` sets it outright, and `--jobs 1` puts everything back on one
thread.

Where the threads go depends on what you named. **One tape** spreads them over
its files. **Several tapes** spreads them over the tapes, one each, since a
tape holding two files can only ever keep two threads busy while the rest
stand idle — and a thread that owns a whole tape installs that tape's turbo
loader once and works down the side with it:

```
c64rdy loadtest side-a.tap              # threads over the files of one tape
c64rdy loadtest "tapes/*.tap"           # a thread per tape
```

With several tapes, each one's listing appears — and each one's disks are
written — the moment that tape is done, in the order they finish rather than
the order you named them. A shelf of tapes is half an hour of work, and none
of it should be waiting on the slowest one.

```
c64rdy loadtest side-a.tap --jobs 4     # four tapes' worth of machine at once
c64rdy run mydisk.d64 --all --jobs 1    # one at a time, for a quiet machine
```

What comes out does not depend on how many threads wrote it: the answers are
collected in the order the files stand on the tape or the disk, and the
screenshots are byte-identical either way. One thing does differ, and it is
worth knowing: on a turbo tape, `--jobs 1` installs the tape's own loader once
and reuses it down the whole side, while several threads each install their
own copy.

## Recipes

A shoebox of cassettes, digitised and checked:

```
c64rdy wav2tap ~/recordings/*.wav --out-dir tapes/   # decode the lot
c64rdy dir tapes/*.tap --damaged                     # only what came out broken
c64rdy tapfix tapes/side-a.tap                # mend what the tape can prove
c64rdy loadtest tapes/side-a-mended.tap       # and does it actually load?
```

A contact sheet of a whole tape side, without converting anything:

```
c64rdy run side-a.tap --all --out-dir shots/   # every program, photographed
```

One tape side, turned into something that loads in a second:

```
c64rdy tap2d64 side-a.tap                    # → side-a.d64, side-a-2.d64 …
c64rdy run side-a.d64 --all --out-dir shots/ # a picture of every program on it
```

One game from a tape onto a cartridge, end to end:

```
c64rdy tap2d64 side-a.tap --file "BR TR CHINA"
c64rdy d642prg side-a.d64 "BR TR CHINA" -d out/
c64rdy prg2crt "out/BR TR CHINA.prg"
c64rdy run "out/BR TR CHINA.crt" --anim        # see it start, as a moving PNG
```

Back onto real hardware:

```
c64rdy tap2wav side-a.tap        # a .wav to play into a datasette
c64rdy prg2d64 game.prg          # a disk to write with your own tools
```

Watching a load happen:

```
c64rdy run side-a.tap --file "BR TR CHINA" --anim --speed 1
```

Checking a batch without reading a word — one command, every tape, and a
non-zero exit if any file on any of them failed to load:

```
c64rdy loadtest "tapes/*.tap" --quiet ; echo $?
```

## Every flag

**Everywhere.** `--help`, `--version`, `--quiet` (errors only), and `--force`.
Global flags may stand before the command — `c64rdy --quiet info x.prg` — and
`--` ends the flags: after it, a word like `--help` is a filename.

**Nothing is written over.** A tape, a disk or a cartridge that already exists
stops the command with `side-a.tap is already there — --force writes over it`.
These take minutes of machine to make and they are the things you keep. A
screenshot is not: `run` writes its PNGs over whatever is there, because a
picture is a view you can take again.

**Outputs, on every command that writes one.** `-o <file>` names a single
output and refuses several inputs; `--out-dir <dir>` puts outputs in a
directory and creates it. With neither, the output lands in the directory you
run from, named after the input with the extension swapped — the way an
unpacker unpacks, and never into the input's own folder.

| Command | Its own flags |
| --- | --- |
| `dir` | `--damaged` only broken rows · `--seconds` raw seconds, not `m:ss` · `--pulses` pulse indexes, for diagnosis |
| `info` | — |
| `wav2tap` | `--channel <n\|mix\|aligned>` which reading of a stereo transfer to use · `--pre-emphasis <n>` treble lift · `--no-mend` skip mending from a second reading · `--no-repair` skip the KERNAL's duplicate-block repair · `--ntsc` / `--cpu-hz <hz>` the machine the tape was written for |
| `tap2wav` | `--max-seconds <n>` cut it short (it says when it did) |
| `t642d64` | — |
| `t642prg` | `-d <dir>` where the files land (`--out-dir` too) |
| `t642tap` | `--roms <dir>` |
| `d642t64` | — |
| `dmp2tap` | — |
| `tapfix` | — (writes `<name>-mended.tap`) |
| `tapcat` | — (writes `<first>-joined.tap`) |
| `prg2d64` | — |
| `prg2crt` | — |
| `prg2tap` | `--name NAME` the name the tape carries · `--roms <dir>` |
| `prg2turbo` | `--name NAME` (one input) · `--loader <installer.prg>` a self-loading tape · `--drive [--save-with '<cmd>']` write via the tool's own saver · `--roms <dir>` (with `--loader`/`--drive`) |
| `tap2d64` | `--file NAME` one program only · `--jobs <n>` threads · `--roms <dir>` |
| `tap2prg` | `--file NAME` one program only · `-d <dir>` where the files land (`--out-dir` too) · `--via-machine` load them rather than decode, with `--jobs <n>` and `--roms <dir>` |
| `tap2t64` | `--file NAME` one program only |
| `loadtest` | `--file NAME` one program only · `--jobs <n>` threads · `--roms <dir>` |
| `loader` | `--dump <file>` write all 64 KB of memory · `--seconds <n>` how long to let it run (60) · `--roms <dir>` |
| `roms` | — (a folder to remember; run it bare at a terminal and it asks) |
| `run` | `--no-press` leave a screen that stopped moving alone · `--frames <n>` how long after the start · `--file NAME` a program off a `.d64` or `.tap` · `--all` every program on a `.d64` or `.tap` · `--collage` tile a `--all` run into one sheet (animated with `--anim`) · `--jobs <n>` threads, with `--all` · `--anim` film it · `--fps <n>` how often to film (5, at most 50) · `--speed <n>` how fast it plays against the machine · `--roms <dir>` |
| `disk new` | `--name NAME` the disk's header name · `--id ID` its two-character id · PRGs named on the line are written straight in · `--force` reformats an existing image |
| `disk add` | — |
| `disk rm` | — (takes a DOS `"GAME*"` pattern; scratches every match) |
| `disk extract` / `d642prg` | `-d <dir>` where the files land (`--out-dir` too). A quoted `"GAME*"` pattern narrows it; no pattern means every file |

## What it won't do (yet)

- Extract a *damaged* program's bytes. `tap2prg` decodes what a block holds,
  but refuses one whose checksum failed rather than write partly invented
  bytes. Recovering those is a harder problem, not attempted yet.
- Read a `.crt` beyond `run`/`info` — `prg2crt` writes them, nothing here takes
  one apart. A cartridge is ROM plus the hardware that banks it, so there is no
  honest `crt2d64`.
- Write anything back to a `.wav` besides `tap2wav`'s transcription.
- `--json`. This tool talks to people; the exit codes carry enough for batch
  use.
