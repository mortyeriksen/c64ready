<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->

# Datasette (1530 / C2N): Architecture

Source: `src/datasette.js`. Wired into the machine in
`src/machine.js`; see the [master overview](ARCHITECTURE.md)
and the [machine orchestrator](MACHINE-ARCHITECTURE.md).

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
  write to `$00` re-evaluates the line too, handing pin 5 to an already-latched
  0 is itself a motor event, and that is the order the KERNAL uses.
- **SENSE → CPU port `$01` bit 4.** `getSenseLevel()` returns `0` when **any**
  key is down, `1` when no button / no tape is present. The machine cannot tell
  *which* key, so "PRESS PLAY ON TAPE" versus "PRESS RECORD & PLAY ON TAPE" is a
  message, not a check. The KERNAL's interrupt handler also spins the motor
  whenever it sees SENSE low, which is what makes the deck move at all.
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
  below). `wav-import.js` runs the whole of it in a worker (`onProgress` reports
  each pass, the dialog draws a bar), and falls back to the main thread if a
  worker cannot start. The recording is transferred rather than copied, so the
  worker is handed the buffer only once it has said it loaded. It is read in
  pieces: the detector takes two streaming passes over a chunked source, one for
  the level model and one for the crossings, so no reading's samples are ever
  held whole. Measured in node on a 29-minute stereo side, that took the peak
  from 2.05 GB to 1.2 GB with the `.tap` byte-identical. The sampler is chosen
  once per file format (a typed view for 16-bit PCM), bit classes are a byte
  each, and a pulse's start sample is arithmetic on the crossings rather than a
  second array the size of the first.
- **`dmpToTap()`** (`src/dmp-tape.js`) reads a DC2N dump, the tape as the
  cassette port saw it, one 2 MHz tick count per pulse, so there is no audio to
  decode. It honours the overflow rule (a sample at the maximum carries into the
  next) and scales ticks to cycles at the PAL clock whatever machine the dump
  names, since a pulse's real duration is what must survive; the machine is
  reported. It writes a v1 `.tap`, or v2 where a version-1 dump kept both
  half-waves. Both
  containers go out through `tap-encode.js`. Measured on two dumps of a
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

**Widths are timed between centre crossings.** A played-back tape does not hold
its shape: the head differentiates the signal and azimuth skews it. On tapes
measured here one half of a wave ran 156 cycles against the other's 290. Timing
from the trigger folds that skew into the width. Timing from the crossings does
not. A crossing is interpolated between the two samples that straddle it and is
counted only once the swing past the gate confirms it, so hiss cannot invent one.

**A pulse spans two crossings.** Which of the two pairings is real is scored by
fewest distinct widths. The trigger records a
crossing only when the sign has changed. Crossings therefore alternate strictly
and an index's parity is its edge's polarity. A dropout loses crossings in pairs
and cannot turn the pairing over (111 of 111 windows across four tapes agree with
the whole). A home tape can hold recordings from decks wired the other way up. So
each stretch between silences of a second chooses its own pairing when it holds
4000 crossings or more and the two pairings are clearly apart. Otherwise it
follows the tape.

**The gate is 0.25 of the level.** At 0.30 and above one transfer loses the
second copy of a file. Everything from 0.15 to 0.25 reads it. A clean tape is
unaffected either way.

**Level and centre line are local.** Both are taken in windows of about 3 ms and
smoothed across neighbours. The window is a length of time (128 samples at
44.1 kHz), so a 96 kHz transfer is judged over the same stretch. A half-hour
recording holds neither steady:

- The **level** falls away in patches. One passage dropped to a quarter of the
  recording's level for 7 ms. A threshold set by the loud parts does not reach
  it and two pulses merge into one. In a turbo format that shifts every bit after
  it. A windowed gate took that tape's turbo blocks from 2 of 13 clean to 8 of
  13. A 1024-sample window recovered almost none, which is what sized the window.
- The **centre** wanders by a twentieth of full scale inside a few milliseconds.
  That is more than a weak wave's own swing, so it crossed nothing. Tracking it
  took the same tape to 9 of 13.

The floor under both is 0.05 of the whole recording's level. Silence between
files then cannot drag the threshold down to the hiss.

**A KERNAL file is mended from its second copy.** The KERNAL writes every block
twice and reads both before it returns. A transfer that lost the tail of the
repeat leaves the file in memory and then hangs or answers ?LOAD ERROR. Three
tapes here fail exactly that way. Where the first copy checks out and the repeat
does not, `repairTape()` writes the repeat again from the first. It is written in
place at the length a sound copy would have, so what follows keeps its position.

Where neither copy adds up the two are merged. A byte that fails parity is taken
from the other pass. A byte one copy lost is supplied by the other. The block's
checksum then says whether the result is the file, so a merge is proved or thrown
away. Both orders are tried.

Lining the copies up is the whole difficulty. A dropout swallows bytes and the
pulses they sat in. Neither counting bytes nor counting pulses says how many went
missing: one gap was two bytes wide but only 34 pulses long, where two bytes are
40. Compared position for position two copies of a 2052-byte block differed in
1658 places. Aligned with a banded edit alignment they differed in none. Three
files across two tapes came back whole that way and load.

Repair runs on `.wav` import only. It reports through the Status card and the
foot of the listing and leaves the recording untouched. A file that cannot be
proved is left alone and marked.

**A stereo transfer is four readings of the tape.** The two channels are
separate passes of the same head and their noise differs. Their average cancels
that noise where the channels are in phase and cancels the signal where they are
not. They are rarely in phase: two head gaps reading one track carry an azimuth
delay of one to four samples on every tape here, none inverted. So the fourth
reading is the average with the second channel shifted onto the first. The delay
steps between recording sessions and drifts within one. It is therefore measured
once a minute over the loudest ten seconds of each and drawn straight between the
measurements. On one tape the plain average lists 1 file of 8 and the lined-up
one 12 of 14. On another the lined-up one loses two the plain one has. So
`wavToTap()` reads all four and works from whichever proves the most files. That
costs a pass of the recording each. A mono file skips it.

Nothing cheaper ranks them. What separates two readings is a handful of pulses in
a ninety-second file. Pulse spread and cluster tightness measured over sampled
windows rank them at random, and on one tape exactly backwards.

**A turbo file has no second copy, but the recording can be read again.** A
dropout is spacing loss: the high end goes first and two symbols run into one.
Lifting the treble puts those edges back. On one file 674 unreadable pulses
became 296 at a lift of 3. Where a block's checksum fails its own stretch of the
recording is read again every way. The other channel and both averages are read
as they are. Every reading is read at lifts of 1.5 to 5. The difference of the
channels is read too, which is a lift with the shared noise cancelled. Cost
follows the damage.

**A checksum that adds up is a candidate, not proof.** Eight bits let one wrong
reading in 256 through. Measured over 927 rereads of proven files: one in 159. So
a reading that checks out is held until a second agrees with it byte for byte.
That is what mends the file. A file only one reading vouches for is still put
back but reported as unconfirmed. Two that check out and disagree cannot both be
right, and the file is then left as it was.

Where no whole reading checks out the readings are spliced. Each is trusted
except around pulses that are neither of the block's two widths. The walk takes
whichever reading stays clean longest and cuts a margin short of its next fault.
The margin is 30 ms first and then 10 and then 1.5. A fault every reading shares
is walked through. Each seam lands midway between two pulses, so a reading whose
crossings sit a fraction of a sample away neither repeats nor drops one. The
checksum judges the result and a splice is always unconfirmed.

**Every proved block is written back clean.** A lifted or averaged signal shifts
the widths (217/338 became 221/331 on one tape). A 1986 loader's threshold is
fixed where ours adapts, and blocks with sound checksums have answered ?LOAD
ERROR for exactly that. So proved bytes are re-rendered at the two widths the
tape uses elsewhere. This runs on every tape, whether or not anything on it
needed mending. Which pulses to replace is decided in samples rather than pulse
numbers: a damaged block holds fewer pulses than it was written with. The gap
behind it absorbs the difference in length, so nothing after the file moves.

Across the eight transfers: 66 of 129 files load without repair, 121 of 130
with it. Every one was loaded through the real KERNAL or the tape's own loader
to check.

What is left is not something a reading can fix. Most of it is tape that carried
nothing, 923 ms gone from one file and 685 from another. The rest fails with no
faulty pulse at all: the block is complete and every pulse is a legal symbol, yet
the checksum is out by two or three bits. A pulse landed inside the tolerance of
the wrong symbol. There is nothing to cut around.

### What is on the tape (`tap-directory.js`, `tap-turbo-formats.js`)

A `.tap` has no directory (it is a pulse train), so listing its contents means
decoding it the way a C64 would. This runs on demand, when the deck's magnifier
is opened, and costs 2.5 ms for a short tape up to 0.6 s for a two-hour one
(53k–4.0M pulse bytes measured, over a dozen commercial tapes).

There is no format-sniffing step. The entries become an array of pulse lengths in
cycles **once**, and that array goes to every recogniser in turn: the CBM reader
first, then each entry in `TURBO_FORMATS`. Each reads the tape in its own terms
and returns what it finds; a format that is not present finds nothing, because
its signature never appears. Results merge by position, and two claims within 64
pulses of each other collapse to one, so a tape carrying several formats lists
them all, in the order they were recorded.

| | CBM (KERNAL) | Turbo Tape 64 | GRL-Supertape | Novaload |
| --- | --- | --- | --- | --- |
| `0` / `1` | short/medium and medium/short pairs | 216 / 328 cycles | 170 / 445 cycles | 304 / 688 cycles |
| bit order | LSB first, parity bit | MSB first, no parity | MSB first, no parity | LSB first, no parity |
| block sync | `$89…$81`, repeat `$09…$01` | `9…1` | `32…1` | a pilot of `0` bits, one `1` bit, then `$AA` |
| header | 192 B: type, addresses, 16-byte name | type, addresses, spare, 16-byte name padded with spaces | addresses, then an unpadded name | name length and name, destination less one page, end, last block's length, block count |
| also checked | XOR checksum after the block | XOR checksum after the data block; type 1–3, `end > start`, printable name | `end > start`, non-empty printable name | a running 8-bit sum: one over the header, one after every block |

What separates the first two turbo formats is the **countdown start**, not the
widths: both bit-decode under either threshold, but each recogniser only accepts
its own range. For CBM it is the checksum that separates a header from a data
block whose bytes happen to read like one; without it a saved program can list
itself twice. Clones retime rather than redesign (GWC Turbo 2 writes 232/344
where the rest write 216/328), so each threshold sits midway with room on either
side.

Adding a format means adding one entry to `TURBO_FORMATS`: a pulse threshold, a
bit order, how blocks announce themselves, and where the header keeps its name
and addresses. Nothing else changes.

**Novaload is read out of its own loader.** A Novaload tape boots from an
ordinary KERNAL block whose 192-byte header *is* the turbo reader, and the block
that reader takes in installs a resident one for everything after. Disassembling
the two gives the format exactly, the threshold included: the loader tests bit 1
of CIA1 timer A's high byte, so the boundary is the 500-cycle band edge rather
than a midpoint, and 304 and 688 sit far enough either side of it that the tape's
own widths never need measuring.

Two block layouts follow the sync, and every tape carries both:

| | bootstrap | resident |
| --- | --- | --- |
| what it carries | the loader itself | every file the loader then loads |
| after `$AA` | the seed the KERNAL stub primed its checksum with | a name length, that many bytes of name, then six header bytes and their sum |
| a block | page, 256 bytes, checksum | 256 bytes and a checksum, the last block short |
| the checksum | the page byte plus its 256 | one running sum over everything since the `$AA`, its own checksum bytes included, each compared against the total *before* itself |
| ends on | a page byte of `$00`, which the run-out of `0` bits supplies | the block count in its header |

The bootstrap layout writes pages in any order, so it states no load address and
carries no name; the listing gives it the span they cover. Bomb Jack is 215
bootstrap blocks and 32 resident ones, and all 247 add up.

**A header says where a file was saved from.** Whether that is also where it
loads depends on its type. Type 3 is absolute and lands there. Type 1 is
relocatable, and a plain LOAD puts it at the BASIC start instead. Both list as
PRG, so each entry carries `relocatable` beside its addresses.

**Whether a file will load.** Each entry is judged from the tape, not from what
an import happened to report, so a `.tap` opened directly is judged the same way
as a recording:

- A **CBM** file is sound if either copy of its data block adds up, measured to
  the block's **end marker**, the way the KERNAL reads it, not for as many bytes
  as the header's addresses imply. Commercial stubs overstate that range because
  the loader fills the rest itself: Head Over Heels claims 713 bytes and writes
  636, and checking it against the header failed a tape that loads on hardware.
- A **filename may contain control codes**: Batman's begins $05 $93, white and
  clear-screen, so that LOAD prints tidily. What proves a block is a header is
  its own checksum, so the name is only required to have a name in it.
- The bit **threshold comes from the tape**, not from the format. Turbo Tape 64
  specifies 216 and 328 cycles with 272 between them, but the widths move with
  the deck and the threshold does not: 20% fast writes 173 and 262, both under
  272, and the tape decodes to nothing. So the two busiest clusters are measured
  and the midpoint tried as well, keeping whichever reading proves more files.
  One tape here runs 3.1% fast, and reading it at 264 recovers a file that plays.
- A **Turbo Tape 64** file is sound if its data block adds up. The payload runs
  to the end address inclusive and an XOR byte follows it, measured across these
  tapes, every block a real loader accepts checks out and every block it refuses
  does not, so the verdict is a proof rather than an estimate.
- A **Novaload** file is sound if every block adds up. The resident layout can
  say so for the whole file however badly it reads, its block count having come
  from a header that proved itself; the bootstrap layout has no such header, so
  it is asked for two sound blocks before it is called a file at all — one
  agrees by chance once in 256.
- Where that checksum fails, the pulse widths still say *what* went wrong, for
  the row that has to explain itself: any pulse that is neither of the two widths
  that stretch of tape was written with is a bit gained or lost. The widths are
  taken from the block itself rather than from the format's nominal figures, so a
  slow deck or a clone that retimed its symbols is judged against what it wrote.
  A format without a checksum (GRL-Supertape) is judged on the widths alone.

The listing strikes such a file through. It is never removed; the head can still
be wound to it, and it is still what is on the tape.

Two faults are counted apart, because they do not mean the same thing. A pulse
far longer than either symbol is **silence**: the tape carried nothing there,
and its duration says how much of the file went with it. A pulse merely between
the two widths is **unreadable**: the signal is there, but two bits ran into
one. Both are fatal all the same: one pulse is one bit, so a handful shifts
everything after it. Measured on one tape: three of its four damaged files lost
only 1–5 bytes each, the fourth 163, and all four answer ?LOAD ERROR.

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
| Flash Turbo-Tape ABC | patches `SAVE`; a plain `SAVE"NAME",1` goes out at turbo speed | 208–216 / 320–328 | Turbo Tape 64 |
| Super Tape Turbo (CCS) | `←S"NAME"`, loads `←L` | 208–216 / 320–328 | Turbo Tape 64 |
| GWC Turbo 2 | `←S"NAME"`, loads `←L` | 232–240 / 336–344 | Turbo Tape 64, retimed |
| FCS Turbo Tape | `←S"NAME"`, loads `←L` | 208–216 / 320–328 | Turbo Tape 64 |
| Turbo 250 (MR.Z) | `←S"NAME"`, loads `←L` | 208–216 / 320–328 | Turbo Tape 64 |

Ten programs, two encodings. Turbo Tape 64 is the one everybody copied, and the
last four are the same tool rebadged, down to a byte-identical `IGONE` hook
watching for `←`. GRL-Supertape is the only genuine rewrite among them.

Turbo 250 is the one seen in the wild rather than on a tools disk: it heads two
digitised compilation tapes from the period, with a dozen games behind it that
list as Turbo Tape 64, the loader and its tapes agreeing, from opposite
directions. Of the commercial loaders only Novaload is covered, read off the
6502 its own tapes carry; Freeload, Cyberload, Burner and Visiload each still
need an entry of their own.

## 3. Playback engine

State is a cursor into the pulse stream plus a down-counter to the next edge:

- `pos`: byte offset into `tapData`.
- `cyclesUntilEdge`: cycles remaining before the next edge fires.
- `_loadNextPulse()`: decodes the next byte(s) into `cyclesUntilEdge`; sets
  `atEnd` when the stream is exhausted.

`clock(cycles)` runs each master cycle (only while `motorOn && playPressed`):
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
energises it as soon as SENSE reads low.

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
passes. Consuming those pulses would be closer to the machine; it is deliberately
not done, because it can only lose loads that currently work; the head is wound
to the start of a file's lead-in, and the lead-in is precisely what the first
300 ms contains. Head bandwidth is likewise unmodelled: a one-cycle
half-wave records faithfully even though no real head could write it. The counter
advances linearly with tape time, where a real reel-driven one does not.
