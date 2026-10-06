<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->
<!-- description: How a worn C64 cassette becomes a tape that loads again: how a recording is read and mended, in the emulator and with the c64rdy command line. -->
<!-- share-image: /guide/tape-pipeline.webp -->

# Restoring C64 tapes: from a worn cassette to a .tap that loads

A Commodore 64 cassette from the 1980s has spent forty years losing its
treble, stretching and shedding. Play it into a sound card and you get a
recording of all that wear. This guide is about getting the programs back out
of it: what a tape actually holds, how C64 READY. reads a recording, how it
mends what the tape lost, and how you can tell what survived.

The same decoder sits behind both tools: the **Datasette** in the emulator,
for one tape at a time, and **`c64rdy`**, the command line, for a shoebox of
them. Everything described here happens in both.

![Every program on one restored tape side running at once: nineteen tiles, each a game's own screen, captioned with its name.](/guide/tape-collage.webp)

One cassette side, transferred from a worn original and restored: nineteen
programs, every one booted and playing. The CLI made this picture with
`c64rdy run side-a.tap --all --collage --anim`.

---

## What is on a tape

A C64 does not record sound on a cassette, and it does not record bytes
either. It records **timing**. The machine's tape port flips a signal, and the
Datasette writes each flip onto the tape. Reading it back, the machine measures
how long passes between one flip and the next. That length of time is the
data.

![A noisy tape waveform swinging about a dashed centre line, with a shaded gate band at a quarter of the level either side. Dots mark the centre crossings. Brackets under the wave measure each pulse, one full swing, and label it S 384, M 528 or L 688 cycles: the KERNAL format's short, medium and long pulses.](/guide/tape-pulses.svg)

One full swing of the signal, up and back down, is a **pulse**, and its width
is measured in the C64's own clock cycles (about a million a second). The
standard format the C64's built-in KERNAL writes uses three widths:

| Pulse | Width | Used for |
| --- | --- | --- |
| **S**hort | 384 cycles | half of every bit |
| **M**edium | 528 cycles | the other half |
| **L**ong | 688 cycles | the start of each byte |

A bit is a pair of pulses: short then medium is a 0, medium then short is
a 1, and long then medium marks the start of a byte. A whole program is
thousands of these pairs in a row.

**Turbo loaders**, which most commercial games use, do the same with two
shorter widths (Turbo Tape 64 uses 216 and 328 cycles), which is why they load
several times faster. The tape still carries a short KERNAL file at the front:
that is the loader itself, which then reads the rest.

### Seeing it for yourself

The Datasette has a scope that draws the signal under the tape head as it
plays. Load any tape, power on, press **▶ PLAY**, and open it from the
waveform button beside the card title:

![The Tape signal dialog: a green square wave of varying pulse widths on a graticule, reading PLAYING at the bottom left and "43 pulses · 20 ms window · 384–688 cycles" at the right.](/guide/tape-scope.webp)

The window shows about 20 ms of tape, and the readout under it counts the
pulses and gives the shortest and longest in cycles. On a KERNAL tape it
settles at **384–688**, the three widths above. Wind on into a turbo file and
the numbers drop to its two shorter widths.

The **🔊** button beside it plays the same signal out loud: not a sound
effect, but the tape rebuilt from its pulses. A turbo loader screeches higher
than the KERNAL's slow warble, because its pulses are shorter.

Both draw from the `.tap` in the deck, so what you see and hear is exactly
what the C64 reads. On a restored tape, that is the clean result, not the
worn recording.

### What a `.tap` file is

A `.tap` file is that list of pulse widths, one number per pulse, and nothing
else. It has no directory and no file names of its own; those are inside the
pulses, written the way the C64 wrote them. That is why it is the right
container for a cassette: it keeps everything the tape did, including the
parts no one has identified yet, and any loader on the tape can read it.

Restoration, then, means one thing: **turning a recording back into an
accurate list of pulse widths.**

---

## Making the recording

What you capture decides what can be recovered, so a few things are worth
knowing before you press record.

- **Record in stereo if you can.** The tape has one track, but a stereo head
  reads it twice, slightly differently. Two channels give the decoder two
  readings to compare, and that is where most mending comes from.
- **Any common sample rate works.** Nothing is resampled; widths are measured
  in the recording's own samples and converted to cycles. At 48 kHz an edge
  is placed to within about 20 cycles, while the widths a loader tells apart
  are 64 cycles or more apart, so 44.1 or 48 kHz is plenty. A higher rate
  places edges more finely.
- **Leave the recording as it comes off the deck.** Level and centre are
  measured every few milliseconds as the decoder goes, so there is no need to
  normalise. Filters and noise reduction reshape the very edges being timed.
- **Keep the whole side.** Silence between files is fine; it is how the
  decoder tells recordings apart.

`.wav` files of 8, 16, 24 or 32-bit PCM and 32 or 64-bit float are read, mono
or stereo. A **DC2N** `.dmp` dump also works: it captures the pulses directly
from a real Datasette, so it skips the reading stages and goes straight to
mending.

---

## How a recording becomes a tape

Load a `.wav` into the Datasette, or give it to `c64rdy wav2tap`, and it goes
through seven passes. The emulator's "Reading tape" dialog shows them by name.

![From a worn cassette to a tape that loads: seven stages in a row (read the recording, measure the signal, find the pulses, line up the channels, compare the readings, mend damaged files, read the directory), and below them a noisy recording with a dropout going in and clean square pulses coming out as a .tap. Every file gets a verdict: readable, mended, unconfirmed or damaged.](/guide/tape-pipeline.svg)

### Measuring the signal

A half-hour recording does not hold one level. The tape gets louder and
quieter, and its centre line drifts. So the decoder takes the level and
centre locally, over windows of about 3 ms, smoothed across their
neighbours. Each part of the tape is judged against its own surroundings, not
against the loudest moment of the side.

### Finding the pulses

Every place the wave crosses its centre is a candidate edge. Hiss crosses the
centre too, though, so a crossing only counts once the signal swings past a
**gate**, a quarter of the local level either side of the centre (the shaded
band in the pulse picture above). Noise inside the band is ignored; a real
swing goes through it.

Each crossing is placed between the two samples that straddle it, finer than
the sample rate, and crossings are then paired into pulses. Which pairing is
right depends on how the recording deck was wired, so the decoder picks the
one that gives the fewest distinct widths. A home tape can hold recordings
from decks wired either way up, so each stretch between silences chooses for
itself.

Each pulse is measured on its own, so a deck that ran a little fast or slow
does not need correcting: its pulses are all a little short or long, and the
loaders allow for that. The speed is measured and reported ("the deck that
wrote this ran 3.1% fast"), but not changed.

### Lining up the channels

![Four waveforms. The left and right channels of a stereo transfer show the same pulses, the right one a little late. Their plain average is shrunken and garbled where the two disagree. Averaging after lining the right channel up on the left gives a clean, strong wave.](/guide/tape-channels.svg)

A cassette head is rarely perfectly square to the tape, so in a stereo
recording one channel runs slightly behind the other. Simply averaging the
two then cancels the signal wherever they are out of step: on one tape here a
plain average listed 1 file of 8, where the lined-up average listed 12 of 14.

So the decoder measures that delay, lines the channels up, and reads the tape
four ways: each channel alone, the plain average and the lined-up average.

### Comparing the readings

Each reading is decoded completely, and the one that proves the most files
(complete, with checksums that add up) becomes the tape. Nothing is scored by
how clean the signal looks; the files themselves decide.

---

## Mending

A worn tape loses things in two ways: **dropouts**, where the oxide is gone
and the signal briefly vanishes, and **spacing loss**, where the treble fades
so two short pulses blur into one long one. Mending is about proving what a
damaged file said, from evidence the recording still holds. **Nothing is
invented:** a file that cannot be proved is left as it was and marked.

### A KERNAL file: the second copy

![Two cases drawn as rows of byte cells. First, a good first copy and a repeat with its last bytes lost: the repeat is written again from the first copy. Second, two copies each with different bytes lost: lined up and merged into one whole block whose checksum passes.](/guide/tape-kernal-copies.svg)

The KERNAL writes every block **twice**, one copy straight after the other.
On load, the C64 reads both, and a damaged repeat can still hang the machine
or end in `?LOAD ERROR` even when the first copy was fine.

- **If one copy is whole**, the damaged one is written again from it, at full
  length, so everything after it on the tape stays where it was.
- **If both are damaged**, but in different places, they are lined up and
  merged, each lost byte taken from the other copy. The block's own checksum
  decides whether the merge is the real file or is thrown away.

Lining the copies up is not as simple as counting bytes, because a dropout
does not say how many it swallowed. Two copies of one 2052-byte block differed
in 1658 positions when counted from the start, and in none once properly
aligned.

### A turbo file: reading again

![Six readings of one damaged turbo block, each a bar with red marks where its pulses could not be read: as recorded, the other channel, and treble lifts of 1.5, 2.5, 3.5 and 5. The lifts of 2.5 and 3.5 read cleanly and agree, so the block is proved and written back clean.](/guide/tape-turbo-mend.svg)

A turbo file is written only once, so there is no second copy. The second
chance is the recording itself: the damaged stretch is read again, in every
way available.

- **The other channel**, and both averages.
- **Treble lifts** from 1.5 to 5 times, which bring back the edges that
  spacing loss blurred. On one file, a lift of 3 took 674 unreadable pulses
  down to 296.

A single checksum that adds up is not proof: an 8-bit checksum lets one wrong
reading in 256 through. So a block is **proved** only when **two readings
agree byte for byte**. One reading alone is still put back, but reported as
*unconfirmed*. Two that check out but disagree leave the file untouched.

When no whole reading passes, the clean stretches of several readings can be
spliced together, each cut a safe margin short of its next fault. The
checksum judges the result, and a splice is always reported as unconfirmed.

Turbo mending applies to Turbo Tape 64 files, and needs a recording to read
again, so a `.dmp` dump gets the KERNAL repair only.

### Written back clean

Every proved block, mended or not, is rewritten at the exact widths the tape
uses elsewhere. A lifted or averaged reading shifts widths slightly, and a
1980s loader has a fixed threshold where the decoder adapts. Rewriting means
the tape's own loader reads the block as if it were new.

### What it achieves, and what it cannot

On the eight worn cassettes this was built against, **66 of 129** files loaded
before mending, and **121 of 130** after. Each was checked by actually loading
it, through the real KERNAL or the tape's own loader.

What is left is beyond any reading:

- **Tape that carried nothing.** One file has 923 ms missing, another 685 ms.
  There is no signal to recover.
- **A pulse that landed on the wrong side.** Sometimes every pulse is a
  legal width and the block is complete, yet the checksum is out by a bit or
  two: one pulse drifted into the range of the other symbol. There is nothing
  to cut around.

There is no correction for wow and flutter, and none for speed. The pulse
measurement above makes them unnecessary for almost every tape.

---

## In the emulator

![Animation of the Datasette card loading the Commando tape: PLAY latched, the motor dot lit green, the bar and timer climbing.](/guide/datasette-loading.webp)

1. **Load the recording.** Press **📼 LOAD** on the Datasette card (or **▶
   LOAD ANY**, or drop the file on the screen) and pick the `.wav` or `.dmp`.
2. **Watch it read.** The "Reading tape" dialog names each pass and shows its
   progress. A 30-minute side is a few hundred megabytes of audio read
   several times over, so it takes a while; the emulator keeps running
   behind it.
3. **Read the verdict.** The **Status** card reports what came out: how long
   the tape is, how many files, and whether any needed mending.
4. **See what is on it.** **🔍** in the tape's info row lists every file, with
   its format, size and start time.

![The tape listing for a tape called 80S MIXTAPE: seven rows, each with a CBM or TURBO badge, a filename, its size and its start time. One filename is struck through in red, and a note under the list says one file is struck through because the tape lost part of it.](/guide/tape-listing.webp)

A file **struck through** could not be read whole; hover it to see why, and
the note under the list counts them and says what was mended. **Click a row**
to wind the tape to that file's lead-in, then type `LOAD` and press **▶
PLAY**.

5. **Keep it.** The tape goes into your **Library** as a `.tap`; the recording
   itself is not stored. **⤓ .TAP** downloads it, and **⤓ .WAV** renders it
   back to clean audio you can play into a real C64.

The browser reads every recording as a PAL tape. For a tape written on an
NTSC machine, use the CLI's `--ntsc`.

The [Media guide](GUIDE-MEDIA.md#datasette) covers every button on the deck.

---

## With the CLI

`c64rdy` is for when you have more than one tape, or a recording too big to
drag into a browser. [The command line guide](GUIDE-CLI.md) shows how to
install it; it needs Node and nothing else.

### Turn recordings into tapes

```
c64rdy wav2tap ~/recordings/*.wav --out-dir tapes/
```

Each recording becomes a `.tap`, and each ends with its listing and a
summary:

```
6 of 7 files readable. 1 mended from a second reading.
```

If a block was put back on the word of a single reading, a further line names
it: `Only one reading vouches for: …`.

| Option | What it does |
| --- | --- |
| `--channel <n\|mix\|aligned>` | Use one particular reading of a stereo transfer, instead of the one that proves the most |
| `--pre-emphasis <n>` | Lift the treble of the whole recording before reading |
| `--no-mend` | Skip the turbo re-reading, to see the tape as it came |
| `--no-repair` | Skip the KERNAL second-copy repair |
| `--ntsc` / `--cpu-hz <hz>` | Measure widths for an NTSC machine, or any clock |

### See what survived

```
$ c64rdy dir "Tape 2 - Side B.tap"
Tape 2 - Side B.tap
16:03  ·  KERNAL + Turbo Tape 64  ·  18 files, 16 readable
The deck that wrote this ran 3.1% fast

   #  WIND TO  STARTS  NAME              FORMAT  LOAD         SIZE  STATUS
   1     0:02    0:09  TURBO TAPE 64     KERNAL  $0801-$1000    2K  ok
   2     0:57    0:59  OLYMPIA           Turbo   $0801-$1000    2K  ok
…
```

The header gives the whole side: how long it plays, which loader formats it
carries, how far off speed the recording deck ran, and how much of the tape
holds signal no known loader reads. **WIND TO** is where a real deck must be
wound back to for the loader to find the file; **STARTS** is where its data
begins.

`dir` takes a `.wav` directly too (decoding it on the way), `--damaged` shows
only the broken rows, and `--pulses` adds pulse positions for digging into a
particular stretch.

### Prove that it loads

```
c64rdy loadtest tapes/side-a.tap
```

A clean listing says the bytes are right. `loadtest` goes further: it winds to
each file, loads it through the real KERNAL or the tape's own turbo loader,
and checks the memory it names actually filled. The listing gains a **LOADS**
column. It is slow and thorough; `--file NAME` tests just one.

### Look at the pulses

```
c64rdy loader tape.tap
```

When part of a tape belongs to a loader nothing recognises, `loader` shows a
**histogram of the pulse widths** in that stretch, which names the two
symbols the unknown loader writes, and then the loader itself, taken out of
the tape and disassembled.

```
  0:22-5:53, 765753 pulses:
    CYCLES  PULSES
       296  434162
       584  331510
```

### Mend, join and convert

| Command | What it does |
| --- | --- |
| `tapfix side-a.tap` | Mends an existing `.tap` from what it holds (the KERNAL second copies), writing `side-a-mended.tap` |
| `tapcat side-a.tap side-b.tap -o tape.tap` | Joins tapes end to end, such as a side transferred in two halves |
| `tap2wav tape.tap` | Renders the tape back to clean audio, to play into a real C64 |
| `tap2prg`, `tap2d64`, `tap2t64` | Takes the programs out onto `.prg` files, a disk image or a `.t64` archive |
| `run side-a.tap --all --collage --anim` | Boots every program on the side and tiles them into one animated picture, like the one at the top of this page |

---

## A shoebox of cassettes, start to finish

1. **Record each side** in stereo, as a `.wav`, and name the files so you can
   tell the sides apart.
2. **Decode them all at once:**
   ```
   c64rdy wav2tap ~/recordings/*.wav --out-dir tapes/
   ```
3. **Find what came out damaged:**
   ```
   c64rdy dir tapes/*.tap --damaged
   ```
4. **Prove the rest loads:**
   ```
   c64rdy loadtest tapes/side-a.tap
   ```
5. **For a side that still fails,** try again from the recording:
   `--channel` to force the other reading, or `--pre-emphasis` for a stronger
   treble lift. If the listing shows silence where a file should be, the tape
   itself has lost it, and a second transfer on another deck is the only way
   to get it back.
6. **See them run:**
   ```
   c64rdy run tapes/side-a.tap --all --collage --anim
   ```

---

## Reading the results

| You see | It means |
| --- | --- |
| `ok` | The file decoded whole and its checksum passes |
| `N of M files readable.` | M files found, N of them whole |
| `K mended from a second reading.` | Turbo blocks proved by two agreeing readings, and rewritten |
| `Only one reading vouches for: …` | Put back on one reading's word: likely right, not proved |
| `1 drop, 120 bytes lost` | The signal vanished; a stretch of the file is gone |
| `40 bytes garbled` | The signal was there but unreadable: worth a lift or the other channel |
| `checksum fails` | Complete, but a bit is wrong somewhere |
| `cut short` | The file stops before its end: the recording or the tape ends early |
| *ran 3.1% fast* | The recording deck's speed, measured: fine for loading, and worth knowing |
| A name struck through (emulator) | Not readable whole; hover for the reason |

*Garbled* is the hopeful one: the signal is there, and a different reading
may recover it. A *drop* means the tape itself carried nothing, and only
another transfer of the same cassette can help.

---

## Reference

| | Emulator | CLI |
| --- | --- | --- |
| Reads | `.wav`, `.dmp`, `.tap` | `.wav`, `.dmp`, `.tap` |
| Writes | `.tap`, `.wav` | `.tap`, `.wav`, `.prg`, `.d64`, `.t64` |
| Machine | PAL | PAL, or NTSC with `--ntsc` |
| Mending | Always on | On, with `--no-mend` and `--no-repair` to see the tape as it came |
| Listen to the tape | 🔊 | `tap2wav`, then play the file |
| See the pulses | The Tape signal scope | `dir --pulses`, `loader` |

**Formats read:** the KERNAL's own, Turbo Tape 64, GRL-Supertape, Novaload,
US Gold / Datasoft, Gremlin Type 2, Ocean / Imagine, Freeload, Wildload and
PROCASS. A tape written by another loader still restores as pulses and still
loads; it just lists as signal no known format reads.

For the full method, with the measurements behind each choice, see the
[Datasette architecture](DATASETTE-ARCHITECTURE.md#10-the-tape-toolchain) page.
