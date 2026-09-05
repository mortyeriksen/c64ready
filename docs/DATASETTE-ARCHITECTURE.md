<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->

# Datasette (1530 / C2N): Architecture

Source: `src/datasette.js` (the deck itself), wired into the machine in
`src/machine.js`; see the [master overview](ARCHITECTURE.md)
and the [machine orchestrator](MACHINE-ARCHITECTURE.md). The tape toolchain
around the deck (§10) lives in `src/tap-audio.js`, `wav-tape.js` /
`wav-import.js`, `dmp-tape.js`, `tap-repair.js`, `tap-directory.js` and
`tap-turbo-formats.js`, with `tape-sound.js` and `tape-scope.js` playing and
drawing the signal.

The Commodore 1530 Datasette plays back `.tap` recordings by replaying their
pulse train as edges on the CIA1 **FLAG** line (exactly the signal a real
datasette feeds the C64) and records in the other direction by timestamping the
edges the C64 puts on the cassette write line. The C64 has no tape *controller*:
software bit-bangs tape I/O in both directions, so the emulator's whole job is
getting edge *timing* right.

## 1. Signal path

```
  .tap pulses ──► Datasette.clock() ──► FLAG edge ──► CIA1 IRQ ──► KERNAL
                         ▲
       MOTOR ── CPU $01 bit 5 (low = run)
       SENSE ── CPU $01 bit 4 ◄── any key down

  .tap pulses ◄── Datasette.setWriteLine() ◄── CPU $01 bit 3 ◄── saver
```

Four lines connect the deck to the machine:

- **READ → CIA1 FLAG.** Each tape pulse is delivered as a falling edge through
  `flagCallback`, wired to `cia1.setFlag(level)` in `machine.js`. Every edge can
  raise a CIA1 FLAG interrupt; the timing between edges *is* the data.
- **MOTOR ← CPU port `$01` bit 5.** `memory.js` (`_syncCassetteLines`) calls
  `setMotor(!(cpuPort & 0x20))`: the motor runs when bit 5 is driven **low**
  (and only while DDR bit 5 is an output; a floating input leaves the motor
  untouched). Because the latch stores all eight bits whatever the DDR says, a
  write to `$00` re-evaluates the line too: handing pin 5 to an already-latched
  0 is itself a motor event, and that is the order the KERNAL uses.
- **SENSE → CPU port `$01` bit 4.** `getSenseLevel()` returns `0` when **any**
  key is down, `1` when no button / no tape is present. The machine cannot tell
  *which* key, so "PRESS PLAY ON TAPE" versus "PRESS RECORD & PLAY ON TAPE" is a
  message, not a check. The KERNAL's interrupt handler also spins the motor
  whenever it sees SENSE low with the `$C0` motor interlock clear, which is
  what makes the deck move at all. A completed tape operation leaves the
  interlock set, so the deck stays parked at `READY.` with PLAY still down;
  only releasing every key clears it again.
- **WRITE ← CPU port `$01` bit 3.** `setWriteLine(level)` receives every
  transition of the pin (idle high when DDR bit 3 makes it an input). While
  RECORD is engaged and the tape is moving, the interval between transitions
  *is* the recorded pulse.

## 2. TAP file format

A 20-byte header followed by a stream of pulse-length bytes:

```
  $00–$0B  "C64-TAPE-RAW" magic
  $0C      version (0, 1, or 2)
  $0D–$0F  reserved
  $10–$13  data size, little-endian
  $14…     pulse data
```

Each data byte encodes the cycles until the next edge:

- **Byte N ≠ 0** → `N × 8` cycles (so one byte covers up to 2040 cycles).
- **Byte 0**:
  - **v0** → a fixed long pulse of 2048 cycles.
  - **v1 / v2** → the next **three** bytes are an exact 24-bit little-endian
    cycle count (for pulses longer than a single byte can express).

`loadTap()` validates the magic and version (≤ 2), slices out the data by the
header size, and pre-computes an estimated duration.

What those pulses *mean* (the tape as audio in both directions, imported
recordings and their repair, and the listing of what a tape holds) is the
toolchain's business (§10). The deck itself only replays and records edges.

## 3. Playback engine

State is a cursor into the pulse stream plus a down-counter to the next edge:

- `pos`: byte offset into `tapData`.
- `cyclesUntilEdge`: cycles remaining before the next edge fires.
- `_loadNextPulse()`: decodes the next byte(s) into `cyclesUntilEdge`; sets
  `atEnd` when the stream is exhausted.

`clock(cycles)` runs each master cycle the motor turns with a key engaged;
PLAY replays pulses, while winding (§5) and recording (§6) ride the same clock:
it subtracts the elapsed cycles and, whenever the counter reaches zero, emits an
edge and loads the next pulse (a `while` loop, so several short pulses can fire
within one tick). Edge shape depends on the TAP version:

- **v0 / v1**: each pulse is a full wave: drive FLAG low then immediately high
  (a clean falling edge, which is what the KERNAL times).
- **v2**: each pulse is a **half-wave**: the FLAG level simply toggles on every
  pulse (used by half-wave recordings that capture both edges).

## 4. Motor & the 300 ms startup window

A real 1530 needs roughly 300 ms for the capstan to reach a stable speed; pulses
delivered before then would be mis-decoded. `MOTOR_STARTUP_CYCLES` (≈ 0.30 s ×
985248 Hz) models this. When the motor starts, or PLAY is pressed with the motor
already running, a stabilization window is armed and `clock()` withholds edges
until it elapses; the remainder of the tick that crosses the boundary is
consumed so no cycles are lost.

## 5. The transport: five keys, one motor

The mechanism holds one key at a time, so the state *is* one key. `_mode` is a
small int (`STOP` / `PLAY` / `REC` / `FF` / `REW`) indexing `KEYS`, with `key` as
its string view; `clock()` runs every master cycle the motor turns, so the hot
path compares numbers. `pressKey()` refuses only RECORD, and only with no tape or
its tabs gone: the key is blocked mechanically rather than erroring after the fact.

Tape motion is gated on `motorOn` for **every** key, winding included; one
capstan motor, switched by the computer. FF/REW still work because the KERNAL
energises it as soon as SENSE reads low with the `$C0` interlock clear (§1).

- `_tapeCycles` is the absolute position in tape cycles, and the only clock the
  recorder measures against. It advances solely while the tape moves.
- `_wind()` moves FF/REW at `WIND_SPEED` (≈ 25×) in chunks (nothing is being
  read, so per-cycle precision would be wasted) and releases the key at either
  end, since a latched key would hold SENSE low with nowhere left to wind.
- `seekToCycle()` positions by tape time, `seekToByte()` by offset (what the
  progress bar measures, so a click on it lands where aimed). A `.tap` decodes
  forwards only, so `_scanTape()` lays a checkpoint every `INDEX_STRIDE` pulses
  (flat `Int32Array` offsets + `Float64Array` times); a seek binary-searches those
  and walks on, and what remains of the straddled pulse becomes `cyclesUntilEdge`.
- `positionFraction` (by file offset) drives the progress bar, `elapsedSeconds`
  and the three-digit `counter` come from `_tapeCycles`, and `durationSeconds` is
  a getter so it can grow with the head while recording.
- `eject()` clears the media; `reset()` stops the motor but keeps the tape and
  the pressed key so the KERNAL can re-detect SENSE after a machine reset.

## 6. The recorder

Recording is edge timestamping. A session opens (`_maybeStartRecording`) once
RECORD is down and the motor turns, and stays open across the motor stops the
KERNAL makes between blocks; the tape simply stops accruing cycles, so the pulse
straddling a stop measures the distance actually travelled.

- **Splice.** Opening a session copies the tape up to `pos` into a growable
  buffer and drops the rest: a real head erases as it passes, and a spliced tail
  is undecodable anyway. `pos` is always a pulse boundary, so the cut never lands
  inside a long form. A v0 prefix is re-emitted as v1 first, since v0's bare `0`
  bytes would otherwise read as v1 escapes.
- **Measurement.** `setWriteLine()` closes a pulse on each rising edge (v1, full
  waves) or on every edge (v2, half-waves). A session's first reference is the
  cycle recording *began*, not its first edge, so the silence before that edge is
  a pulse of its own; that is what holds the position on the tape, and a
  recording opening with the write line already low would otherwise lose it. An
  edge landing on the very cycle the session opened (one `$01` write starts the
  motor and can move the write line together) is a reference point, not a
  zero-length pulse.
  The write pin can only move on a CPU write, and `clock()` runs after CPU phi2,
  so an edge is timestamped in the master cycle its store retired.
- **Encoding.** `_emitPulse()` quantizes to the container's 8-cycle unit and
  carries the remainder into the next pulse, so absolute timing holds over a
  whole recording instead of drifting. Over 2040 cycles it switches to the exact
  24-bit long form; a gap past that ceiling is split.
- **Commit.** Releasing RECORD (`_recStop`) folds the buffer back into `tapData`,
  rescans it, and parks the head at the end. `exportTapBytes()` writes a complete
  `.tap` from either state, so export and save-state work mid-recording.

## 7. Machine integration & clocking

The machine constructs one `Datasette`, wires `flagCallback` to CIA1, and clocks
it once per master cycle **after** the CPU step (so a pulse edge sets the CIA1
FLAG data for the *next* cycle, consistent with the phi1/phi2 ordering in the
[master cycle](ARCHITECTURE.md#3-the-master-cycle-timing-backbone)). `loadTap` /
`setTapeKey` / `newBlankTape` / `setTapeWriteProtected` / `hasUnsavedTapeWrites` /
`exportTapBytes` / `rewindTape` / `ejectTape` are exposed as machine methods
driven by the deck's buttons.

## 8. Save-state

`serialize()` / `deserialize()` capture the transport and the recorder's edge
clock (`pos`, `cyclesUntilEdge`, `motorOn`, `key`, `writeProtected`, `atEnd`,
`dirty`, FLAG and WRITE levels, `_tapeCycles`, `_lastEdgeCycle`, `_encCarry`).
Mid-recording the cursor still sits at the splice point, so `serialize()` reports
the head where the bundled bytes end instead. The TAP *bytes* are captured
separately as bundled media by the machine (from `exportTapBytes()`, so an
in-progress recording is included), and `flagCallback` is re-wired on restore, so
`deserialize()` must run **after** the data has been re-attached via `loadTap()`.
States written before the transport had keys carry only `playPressed`, and
restore falls back to it.

## 9. What is idealised

Motor speed is exact: wow, flutter and speed error are deliberately not modelled,
because unreproducible recordings would buy nothing but authentic failure. The
300 ms capstan spin-up is modelled on **playback** only; on the record side the
first pulses after motor-on are kept verbatim, since dropping them would corrupt
a turbo saver that starts writing immediately, and the KERNAL's ten-second leader
makes the question academic. On playback that window withholds FLAG *and* holds
the tape still, where a real 1530 is already moving and smearing the flux it
passes. Consuming those pulses would be closer to the machine, and is
deliberately not done: it can only lose loads that currently work, because the
head is wound to the start of a file's lead-in and the lead-in is precisely what
the first 300 ms contains. Head bandwidth is likewise unmodelled: a one-cycle
half-wave records faithfully even though no real head could write it. The counter
advances linearly with tape time, where a real reel-driven one does not.

## 10. The tape toolchain

The deck replays and records edges; everything else a tape needs (becoming
audio, coming back in off a recording, being listed and being mended) lives
in its own modules around it.

### Tape as audio (`tap-audio.js`, `wav-tape.js`)

A C64 tape's data *is* audio: the pulse width is the payload. Both directions
exist, and neither is an approximation:

- **`tapToPcm()`** emits one square-wave cycle per pulse, exactly its own length
  (v0/v1) or a level toggle (v2); `pcmToWav()` wraps it as 16-bit mono. Drives
  the speaker button and the `.WAV` download, and the output loads on hardware.
  The download renders up to 45 minutes (a C90 side) and says so if a tape runs
  past that.
- **`wavToTap()`** recovers pulses from a recording. Reads RIFF PCM (8/16/24/32),
  IEEE float and `WAVE_FORMAT_EXTENSIBLE`, and runs a Schmitt trigger thresholded
  at a fraction of the recording's level; a digitised cassette drifts and has
  hiss, so zero-crossing alone invents edges. Speed variation needs no handling:
  each pulse is measured on its own. Output is a v1 `.tap`, so a `.wav` becomes
  an ordinary tape, plus the names of any turbo files it mended on the way (see
  below).
- **The import never holds the recording whole.** `wav-import.js` runs it in a
  worker (`onProgress` reports each pass, the dialog draws a bar) and falls back
  to the main thread if a worker cannot start. The buffer is transferred rather
  than copied, and handed over only once the worker says it loaded. The detector
  then takes two streaming passes over a chunked source, one for the level model
  and one for the crossings. Measured in node on a 29-minute stereo side, that
  took the peak from 2.05 GB to 1.2 GB with the `.tap` byte-identical. The
  sampler is chosen once per file format (a typed view for 16-bit PCM), bit
  classes are a byte each, and a pulse's start sample is arithmetic on the
  crossings rather than a second array the size of the first.
- **`dmpToTap()`** (`src/dmp-tape.js`) reads a DC2N dump, the tape as the
  cassette port saw it, one 2 MHz tick count per pulse, so there is no audio to
  decode. It honours the overflow rule (a sample at the maximum carries into the
  next) and scales ticks to cycles at the PAL clock whatever machine the dump
  names, since a pulse's real duration is what must survive; the machine is
  reported. It writes a v1 `.tap`, or v2 where a version-1 dump kept both
  half-waves, and both containers go out through `tap-encode.js`. Measured on
  two dumps of a
  Mastertronic tape: the stub loads, its own turbo reads the rest, the game
  comes up. The copy-merge repair applies as to any tape; the turbo mend does
  not, there being no recording to read again.

Round-tripping is close, not byte-exact, and needn't be: a pulse is ~20 samples
at 48 kHz, so each edge quantises to ±1 sample (±20 cycles), while the pulse
classes a loader distinguishes sit 64+ cycles apart.

`tape-sound.js` builds the tape as one buffer, plays from the head position, and
re-seats it when audio and tape drift more than a third of a second apart. A
recording has no such buffer, since the tape is being written as it goes, so a
SAVE is transcribed the other way round. Each frame takes the pulses laid down
since the last one (`recordedLength` / `recordedSlice`) and queues them
back-to-back, capped so warp-speed emulation cannot run the audio minutes behind
the machine.

`tape-scope.js` draws the same signal instead of playing it, straight from the
pulses under the head, and is deliberately independent of the speaker: no audio
graph is involved, so the waveform is there to watch with the sound off. A deck
that is not moving draws a flat line rather than the last thing it saw.

### Reading a worn transfer, and mending it (`tap-repair.js`)

The copy-merge repair runs on `.wav` and `.dmp` import alike; the turbo mend
below is `.wav` only, since it works by reading the recording again and a dump
has none. Both report through the Status card and the foot of the listing, leave
the recording untouched, and leave any file they cannot prove alone, and mark it.

**Time widths between centre crossings.** Each crossing is interpolated between
the two samples that straddle it, and counted only once the swing past the gate
confirms it, so hiss cannot invent one. The head differentiates the signal and
azimuth skews it (one half of a wave ran 156 cycles against the other's 290),
and timing from the trigger folds that skew into the width.

**Pair crossings into pulses.** Of the two pairings, the one with fewest
distinct widths; each stretch between second-long silences chooses its own when
it holds 4000 crossings or more, since a home tape can hold recordings from
decks wired the other way up. Crossings alternate strictly; an index's parity
is its edge's polarity, and a dropout loses them in pairs, so it cannot turn
the pairing over: 111 of 111 windows across four tapes agree with the whole.

**Gate at 0.25 of the level.** `HYSTERESIS = 0.25` is the swing a crossing must
pass before it counts: at 0.30 and above one transfer loses the second copy of
a file, everything from 0.15 to 0.25 reads it, and a clean tape is unaffected
either way.

**Take level and centre locally.** Windows of about 3 ms (128 samples at
44.1 kHz, a 96 kHz transfer judged over the same stretch) smoothed across
neighbours, with a floor at 0.05 of the whole recording so silence cannot drag
the gate down to the hiss. A half-hour recording holds neither level nor centre
steady, and results sized the window: it took one tape's turbo blocks from 2 of
13 clean to 9 of 13, while a 1024-sample window recovered almost none.

**Mend a KERNAL file from its second copy.** Where the first copy checks out
and the repeat does not, the repeat is written again from the first, in place
and at the length a sound copy would have, so what follows keeps its position;
where neither adds up the two are merged, a byte failing parity or lost taken
from the other pass, both orders tried. The KERNAL writes every block twice and
reads both before it returns, so a transfer that lost the tail of the repeat
leaves the file in memory and then hangs or answers ?LOAD ERROR (three tapes
here fail exactly that way), and the block's checksum says whether a merge is
the file or thrown away.

**Line the copies up by edit alignment.** Banded at `ALIGN_BAND = 64`, rather
than by counting bytes or pulses: neither count says how many went missing.
Position for position, two copies of a 2052-byte block differed in 1658 places;
aligned they differed in none.

**Read a stereo transfer four ways.** Both channels, their average, and the
average with the second channel shifted onto the first, the azimuth delay
measured once a minute over the loudest ten seconds; `wavToTap()` works from
whichever reading proves the most files, no cheaper signal-quality score having
ordered these recordings reliably. A plain average cancels the signal where the
two head gaps read out of phase: it lists 1 file of 8 on one tape where the
lined-up reading lists 12 of 14. Each reading costs a pass; a mono file skips
it.

**Read a failed turbo block again.** Its own stretch of the recording is read
every way: the other channel and both averages as they are, every reading at
treble lifts of 1.5 to 5, and the difference of the channels, a lift with the
shared noise cancelled. A turbo file has no second copy, and a dropout is
spacing loss: the high end goes first and two symbols run into one, and lifting
the treble puts those edges back: on one file 674 unreadable pulses became 296
at a lift of 3.

**Make two readings agree.** A reading that checks out is held until a second
matches it byte for byte; one alone is still put back but reported unconfirmed,
and two that check out and disagree leave the file as it was. Eight bits let
one wrong reading in 256 through (one in 159, measured over 927 rereads of
proven files), so a checksum that adds up is a candidate, not proof.

**Splice where no whole reading checks out.** Each reading is trusted except
around pulses that are neither of the block's two widths; the walk takes
whichever stays clean longest and cuts a margin short of its next fault, 30 ms
then 10 then 1.5, each seam midway between two pulses, so a reading whose
crossings sit a fraction of a sample away neither repeats nor drops one. A
fault every reading shares is walked through; the checksum judges the result,
and a splice is always unconfirmed.

**Write every proved block back clean.** Proved bytes are re-rendered at the
two widths the tape uses elsewhere, on every tape whether or not anything
needed mending, with the pulses to replace decided in samples rather than pulse
numbers. A lifted or averaged signal shifts the widths (217/338 became 221/331
on one tape), and a 1986 loader's threshold is fixed where ours adapts, so
blocks with sound checksums have answered ?LOAD ERROR for exactly that. A
damaged block holds fewer pulses than it was written with, and the gap behind
it absorbs the difference, so nothing after the file moves.

Across the eight transfers, 66 of 129 files load without repair and 121 of 130
with it, every one checked by loading it through the real KERNAL or the tape's
own loader.

What is left is not something a reading can fix. Most of it is tape that carried
nothing, 923 ms gone from one file and 685 from another. The rest fails with no
faulty pulse at all: the block is complete and every pulse is a legal symbol, yet
the checksum is out by two or three bits, a pulse having landed inside the
tolerance of the wrong symbol. There is nothing to cut around.

### What is on the tape (`tap-directory.js`, `tap-turbo-formats.js`)

A `.tap` has no directory (it is a pulse train), so listing its contents means
decoding it the way a C64 would. This runs on demand, when the deck's magnifier
is opened, and costs 72 ms for a short tape up to 0.65 s for a two-hour one,
measured across 46 commercial tapes of 386k to 6.0M pulse bytes.

There is no format-sniffing step. The entries become an array of pulse lengths in
cycles **once**, and that array goes to every recogniser in turn: the CBM reader
first, then each entry in `TURBO_FORMATS`. Each reads the tape in its own terms
and returns what it finds; a format that is not present finds nothing, because
its signature never appears. Results merge by position, so a tape carrying
several formats lists them all, in the order they were recorded.

**Two claims on one stretch of tape collapse to one, and the overlap is
measured.** The recognisers read the same bits: Turbo Tape 64 splits at 272
cycles and GRL-Supertape at 300, so 216 and 328 mean the same to both, and a
descending run inside one format's data is the other's countdown. Files do not
overlap on a tape, one block ending before the next begins, so a claim covering
tape another claim already covers is a second reading of one file, and the first
in tape order is kept. Half of the shorter claim is the test: a block read twice
overlaps almost entirely, while two files recorded back to back do not overlap at
all. A claim with no extent to compare, a CBM header with no data block behind
it, is given 64 pulses.

Comparing only where two claims begin cannot see any of that: judged by starts
alone, one tape lists a nineteenth file (a GRL-Supertape claim named from four
bytes of a Turbo Tape 64 payload, 2,608 pulses into a real file), and with it a
format the tape does not carry.

| Format | `0` / `1` | Threshold | Bit order | A block | Also checked | Its own |
| --- | --- | --- | --- | --- | --- | --- |
| **CBM (KERNAL)** | Short/medium and medium/short pairs | The three pulse classes | LSB first, parity bit | `$89…$81`, repeated as `$09…$01`; a 192-byte header of type, addresses and a 16-byte name | XOR checksum after the block | Every block written twice, so one copy may fail |
| **Turbo Tape 64** | 216 / 328 cycles | 272, and the tape's own widths measured as well | MSB first, no parity | `9…1`, a data block `9…0`; type, addresses, spare, 16-byte name padded with spaces | XOR checksum after the data block; type 1–3, `end > start`, printable name | Clones retime it, so the threshold cannot be trusted to the format |
| **GRL-Supertape** | 170 / 445 cycles | 300 | MSB first, no parity | `32…1`; addresses, then a name | `end > start`, non-empty printable name | The name is unpadded and has to end itself |
| **Novaload** | 304 / 688 cycles | 500, CIA1 timer A bit 1 of the high byte | LSB first, no parity | A pilot of `0` bits, one `1` bit, `$AA`; then a name and six header bytes, or a bare page | A running 8-bit sum: one over the header, one after every block | Boots from a KERNAL header that *is* the reader; two layouts, a named file or pages |
| **US Gold / Datasoft** | 224 / 512 cycles | 363, CIA2 timer B from `$016B` | MSB first, no parity | `9…1`, then `$01 $96 $00`; load address, length negated, one spare | Nothing; the format has no checksum | The boot block decrypts itself, so the reader must be read out of memory |
| **Gremlin Type 2** | 424 / 840 cycles, the short one the `1` | 592, CIA1 timer A from `$0A50`, high byte 8 or more | MSB first, each byte complemented | A run of `0` bits, then `$FE`; two id characters, load address, length | Nothing; the format has no checksum | A directory: ids from a table at `$0403`, and the caller names the block it wants |
| **Ocean / Imagine** | 264–296 / 544–664 cycles | 480, CIA2 timer B from `$03E0`, high byte 2 or more | LSB first, no parity | A pilot of `0` bits, then one `1` bit; then `[flags, page, 256 bytes]` until a page of `$00` | No checksum; the page bytes must ascend | Keeps state by writing over a `JMP` target; pages, so the listing gives their span |
| **Freeload** | 264 / 544 cycles | 360, CIA1 timer A from `$0368`, high byte 2 or more | MSB first, no parity | The register reaching `$40`, then `$5A`; load address and end address | An XOR after the data, and a block is claimed only if it agrees | Boots at `$0326`, IBSOUT, so it takes the machine at the next print |
| **Wildload** | 384 / 576 cycles | 480, CIA1 timer A from `$03E0`, high byte 2 or more | LSB first, no parity | A run of `$A0` bytes, then `10…1`; top address, count, a flag | An XOR of the deciphered bytes, and a block is claimed only if it agrees | Fills downwards, and EORs each byte with the low byte of where it lands |

Each was read off the tapes that carry it, by disassembling the loader rather
than guessing at the pulses. Every commercial one measures a pulse the same way,
by arming a CIA timer and reading its high byte at the next tape edge, so a
threshold above is a band edge the loader itself fixes, not a midpoint between
two widths.

What separates the first two turbo formats is the countdown start, not the
widths: both bit-decode under either threshold, but each recogniser accepts only
its own range. Adding a format means adding one entry to `TURBO_FORMATS`, which
is a row of that table and nothing else.

**A header says where a file was saved from.** Whether that is also where it
loads depends on its type. Type 3 is absolute and lands there. Type 1 is
relocatable, and a plain LOAD puts it at the BASIC start instead. Both list as
PRG, so each entry carries `relocatable` beside its addresses.

**Whether a file will load.** Each entry is judged from the tape, not from what
an import happened to report, so a `.tap` opened directly is judged the same way
as a recording.

| Format | Judged sound when |
| --- | --- |
| **CBM (KERNAL)** | Either copy of its data block adds up, measured to the block's **end marker** the way the KERNAL reads it, not for as many bytes as the header's addresses imply: commercial stubs overstate that range because the loader fills the rest itself, and Head Over Heels claims 713 bytes where it writes 636. Two byte-identical copies are sound whatever the checksum says, which is what a tape mastered with a wrong one needs |
| **Turbo Tape 64** | Its data block's XOR agrees, and no stretch of dead tape sits inside the block, which outranks the checksum. Every block a real loader accepts checks out and every block it refuses does not, so the verdict is a proof rather than an estimate |
| **GRL-Supertape** | The format has no checksum, so the pulse widths alone |
| **Novaload** | Every block adds up. The resident layout can vouch for a whole file however badly it reads, its block count having come from a header that proved itself; the bootstrap layout has no such header, so two sound blocks are asked for before it is called a file at all, one agreeing by chance once in 256 |
| **US Gold / Datasoft** | The format has no checksum, so the pulse widths alone |
| **Gremlin Type 2** | The format has no checksum, so the pulse widths alone |
| **Ocean / Imagine** | The format has no checksum, so a pilot inside a band narrow enough to exclude a KERNAL lead-in, eight blocks at least, and three quarters of the steps between page bytes ascending. Length proves nothing: a stream of noise does not stop, it runs until a page byte of `$00` turns up by chance |
| **Freeload** | Its XOR agrees, or the block is not claimed at all. Two bytes of sync is one in 65536, which a tape's worth of bit positions supplies several times over, and the false candidates' addresses look as reasonable as the real ones |
| **Wildload** | The XOR of its deciphered bytes agrees, or the block is not claimed. Deciphering is part of reading here, so the sum only agrees if the descending address was tracked correctly |

Where a checksum fails, the pulse widths still say *what* went wrong, for the row
that has to explain itself: any pulse that is neither of the two widths that
stretch of tape was written with is a bit gained or lost. The widths are taken
from the block itself rather than from the format's nominal figures, so a slow
deck or a clone that retimed its symbols is judged against what it wrote. The
listing strikes such a file through. It is never removed; the head can still be
wound to it, and it is still what is on the tape.

Two faults are counted apart, because they do not mean the same thing. A pulse
far longer than either symbol is **silence**: the tape carried nothing there,
and its duration says how much of the file went with it. A pulse merely between
the two widths is **unreadable**: the signal is there, but two bits ran into
one. Both are fatal all the same: one pulse is one bit, so a handful shifts
everything after it. Measured on one tape: three of its four damaged files lost
only 1–5 bytes each, the fourth 163, and all four answer ?LOAD ERROR.

Two things do not follow the format. A **filename may contain control codes**:
Batman's begins `$05 $93`, white and clear-screen, so that LOAD prints tidily.
What proves a block is a header is its own checksum, so a name is only required
to have a name in it. And **Turbo Tape 64's threshold comes from the tape**: it
specifies 216 and 328 cycles with 272 between them, but the widths move with the
deck and the threshold does not, and 20% fast writes 173 and 262, both under 272,
which decodes to nothing. So its two busiest clusters are measured and the
midpoint tried as well, keeping whichever reading proves more files; one tape
here runs 3.1% fast and reading it at 264 recovers a file that plays. The other
formats need no such measurement, their boundaries being band edges their own
timers fix, far enough from both widths to survive a deck well off speed.

**Where a file starts.** Not where its block starts: every block is preceded by a
lead-in the loader must hear before it can read anything, and before a first
block that is seconds of it. Each entry therefore carries `startSeconds` as well
as `atSeconds`, the head of the run of signal before the block, found by walking
back to silence, to eight seconds, or to the file before it, whichever comes
first. That is the time the listing shows and the point a row winds the head to.

Two seconds before the block is too little. On one tape the first copy of a
header does not check out, so the listed position is the *repeat*; starting two
seconds before it drops the head into the middle of the first copy, and the
KERNAL searches past the whole file and never finds it. From the head of the
lead-in it loads every time.

### Turbo programs measured

Each was driven end to end: loaded from its disk, run, told to save a payload to
a blank tape, and the resulting `.tap` decoded. Widths are ranges because the
recorder's ÷8 carry lands a pulse either side of the true value.

| Program | How it saves | `0` / `1` (cycles) | Encoding |
| --- | --- | --- | --- |
| GRL-Supertape (1986) | `SYS310"NAME"`, loads `SYS300` | 168–176 / 440–448 | GRL-Supertape |
| GRL-Turbotape II (1985) | `SYS52592"NAME"`, loads `SYS52598` | 208–216 / 320–328 | Turbo Tape 64 |
| GRL-Turbotape V2 (1985) | `SYS53100"NAME"`, loads `SYS53110` | 208–216 / 320–328 | Turbo Tape 64 |
| GRL-Turbotape V.3 (1985) | `SYS53100"NAME"`, loads `SYS53110` | 208–216 / 320–328 | Turbo Tape 64 |
| M.J-Turbotape (1986) | `SYS53100"NAME"`, loads `SYS53110` | 208–216 / 320–328 | Turbo Tape 64 |
| Flash Turbo-Tape ABC | Patches `SAVE`; a plain `SAVE"NAME",1` goes out at turbo speed | 208–216 / 320–328 | Turbo Tape 64 |
| Super Tape Turbo (CCS) | `←S"NAME"`, loads `←L` | 208–216 / 320–328 | Turbo Tape 64 |
| GWC Turbo 2 | `←S"NAME"`, loads `←L` | 232–240 / 336–344 | Turbo Tape 64, retimed |
| FCS Turbo Tape | `←S"NAME"`, loads `←L` | 208–216 / 320–328 | Turbo Tape 64 |
| Turbo 250 (MR.Z) | `←S"NAME"`, loads `←L` | 208–216 / 320–328 | Turbo Tape 64 |
| 61K Turbo | `←S"NAME"`, loads `←L` | 208–216 / 320–328 | Turbo Tape 64 |
| Noddy's TT249 | `←S"NAME"`, loads `←L` | 208–216 / 320–328 | Turbo Tape 64 |
| Ultra Turbo Tape 61K | `←S"NAME"`, loads `←L` | 208–216 / 320–328 | Turbo Tape 64 |
| Turbo 2002 (CGC) | `←S"NAME"`, loads `←L` | 216–224 / 320–328 | Turbo Tape 64, retimed |
| ABC-Turbo V2.1 | patches `SAVE`; a plain `SAVE"NAME",1`, loads `LOAD"NAME",1` | 208–216 / 320–328 | Turbo Tape 64 |
| Shift Turbo 2 | patches `SAVE`; a plain `SAVE"NAME",1`, loads `LOAD"NAME",1` | 208–216 / 320–328 | Turbo Tape 64 |
| Turbo 202 | patches `SAVE`; a plain `SAVE"NAME",1`, loads `LOAD"NAME",1` | 208–216 / 320–328 | Turbo Tape 64 |
| ABC Turbo II | patches `SAVE`; a plain `SAVE"NAME",1`, loads `LOAD"NAME",1` | 216–224 / 328–336 | Turbo Tape 64, retimed |
| ABC III (KNS) | patches `SAVE`; a plain `SAVE"NAME",1`, loads `LOAD"NAME",1` | 216–224 / 328–336 | Turbo Tape 64, retimed |

Nineteen programs, still two encodings: Turbo Tape 64 is the one everybody
copied — GRL-Supertape is the only genuine rewrite in the lot. What varies among
the copies is not the format but how it is driven: the ←-wedge tools save `←S`
and load `←L`, the ABC/Shift/202 family patches the KERNAL's `SAVE`/`LOAD` so a
plain `SAVE"NAME",1` goes out at turbo speed, and the GRL-Turbotape family calls
its saver with a `SYS`. A tape written in Turbo Tape 64 is read by any of them;
only the command differs, and a few retime the widths (GWC, Turbo 2002, the ABC
II/III variants) without changing what the bits mean. Turbo 250 is the one seen
in the wild, heading digitised compilation tapes whose games list as Turbo Tape 64.

Six commercial loaders are covered besides, all read off the 6502 their own tapes
carry: Novaload, US Gold / Datasoft, Gremlin Type 2, Ocean / Imagine, Freeload
and Wildload. Cyberload, Burner and Visiload each still need an entry of their
own.
