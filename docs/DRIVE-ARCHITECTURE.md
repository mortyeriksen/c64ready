<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->

# 1541 Disk Drive (`src/drive1541.js` + `src/gcr.js` + `src/media/d64.js` + `src/media/g64.js` + `src/6522.js`): Architecture Overview

A high-level map of the Commodore 1541 floppy-drive emulation: the drive as a
self-contained computer (6502 + two 6522 VIAs + DOS ROM), the spindle/GCR
read+write engine, the IEC serial bus, the stepper motor, the D64↔GCR encode/decode
pipeline, the raw G64 track source, and the two ways the host talks to it (KERNAL
load trap vs. True Drive Emulation).

This document describes *the implementation* and points at the real method and
field names so it can be used as a guide into the four source files. The 1541 is
a full peripheral computer with its own CPU and firmware; the emulation runs that
firmware cycle-accurately so cycle-counted fastloaders work. See
the [machine orchestrator](MACHINE-ARCHITECTURE.md) (§6) for how the drive plugs into the C64.

> The drive's 6502 is the *same* `CPU` class the C64 uses; see
> the [6510 CPU](CPU-ARCHITECTURE.md). The 16 KB DOS ROM in use is the
> 1541-II (`1541-II.251968-03.bin`).

---

## 1. Big picture

A real 1541 is not a "dumb" drive: it is a microcomputer that receives commands
over the serial (IEC) bus, runs its DOS ROM to seek the head and read raw GCR
bits off the spinning disk, and shifts decoded bytes back to the C64. On a `SAVE`,
scratch, rename, or `N:` format it runs the same machinery in reverse, writing
fresh GCR onto the disk. This emulation reproduces the whole chain, both
directions, so copy-protection and fastloader tricks (which bypass the DOS and
bit-bang the bus / count cycles) behave correctly.

```
  READ:
  D64 image (sectors)
      │  GCRDisk.getTrackStream(track)         gcr.js
      ▼
  GCR bitstream  (4-to-5 encoded, sync marks, gaps; VICE-matched layout)
      │  _advanceSpindle()  shifts bits at the speed-zone rate
      ▼
  read head → SYNC detect → byte framing → lastGCRByte
      │  VIA2 Port A   +   byte-ready → CA1 / SO pin (gated by SOE)
      ▼
  Drive 6502 runs DOS ROM  ($C000-$FFFF)  →  decodes GCR, talks IEC
      │  VIA1 Port B   (ATN/CLK/DATA via 7406 inverters)
      ▼
  IEC bus  (wired-AND in machine._syncIecBus)  ⇄  C64 CIA2 Port A

  WRITE (SAVE / scratch / N: format):
  Drive 6502 in write mode  (VIA2 CB2 = manual-low, Port A = output)
      │  byte stored to VIA2 Port A  →  writePortA latches it
      ▼
  _advanceSpindle()  shifts the byte's bits ONTO the track buffer, pulsing byte-ready
      ▼
  mutated GCR track  →  gcr.js decodeTrackStream()  →  d64.writeSector()  →  D64 image
```

**Two host-integration modes** (chosen in `machine.js`):
- **Trap-served drive** (TDE off): the machine intercepts the KERNAL LOAD
  entry (`$FFD5`, or the routine behind the ILOAD vector) and reads the file
  straight from the disk image, a D64, D71 or D81, and answers the KERNAL's serial
  primitives with the [virtual drive](#the-virtual-drive-src-media-virtual-drive-js),
  so OPEN, CHKIN, CHRIN, CLOSE, SAVE and channel 15 reach the image too. Fast,
  and without the drive ROM, but loaders that bit-bang the bus still find the
  real 1541 or nothing. The load trap is not silent: it runs the ROM's own
  `SEARCHING FOR` and `LOADING` printing first, so the screen and cursor end
  up exactly where a real load leaves them (intros that read their next command
  back off the screen count on that), while a program-initiated LOAD still
  prints nothing. Both are guarded on the KERNAL's jump table and default LOAD
  vector pointing where the documentation says; a replacement KERNAL gets the
  bus and a silent load.
- **True Drive Emulation** (TDE on, the default): `$FFD5` is left to the real IEC
  protocol, so the full `Drive1541` services LOADs, fastloaders, protected disks,
  and all writes.

These modes do not decide whether device 8 exists. If no 1541 ROM is loaded,
`machine.drive1541` is `null` and device 8 consumes no per-cycle drive work. Once
a 1541 is attached, it remains a live bus device in both modes: trap-mode LOADs
still bypass DOS at `$FFD5`, but code that calls lower KERNAL IEC routines or
bit-bangs `$DD00` can talk to the drive CPU/VIA state.

---

## 2. Components

| File | Class / role |
|------|--------------|
| `drive1541.js` | **`Drive1541`**, the orchestrator: a 6502 CPU + VIA1 + VIA2 + ROM + RAM + the spindle/GCR read+write engine + IEC wiring + stepper |
| `6522.js` | **`VIA6522`** ×2: VIA1 (serial bus) and VIA2 (mechanics + read/write head); timers, ports, CA1/CA2, IRQ |
| `gcr.js` | **`GCRDisk`**: wraps a D64 and synthesizes a raw GCR track bitstream on demand (4-to-5 encode, sync, gaps) |
| `media/d64.js` | **`D64`**: parses a D64, D71 or D81 sector image by its layout: sectors, BAM, directory, file chains, `$`-directory PRG synthesis |
| `drive-sounds.js` | cosmetic head-step/motor sound effects (not part of the data path) |

---

## 3. The drive as a computer (`Drive1541`)

The constructor builds a complete machine:

- **CPU**: `new CPU(this)`, the drive 6502, with `Drive1541` itself as the
  memory object (it implements `read`/`write`/`peekForCpu`).
- **RAM**: 2 KB (`$0000-$07FF`, mirrored up to `$17FF`).
- **ROM**: 16 KB DOS at `$C000-$FFFF` (a 2-byte PRG header is stripped if the
  dump includes one).
- **VIA1** (`$1800-$1BFF`, mirrors every 16 bytes): the IEC serial bus.
- **VIA2** (`$1C00-$1FFF`, mirrors every 16 bytes): drive mechanics + read/write head.

```
  $0000-$07FF  2KB RAM   (+ mirrors to $17FF)
  $1800-$1BFF  VIA1  (IEC serial bus)
  $1C00-$1FFF  VIA2  (mechanics / read+write head)
  $C000-$FFFF  16KB DOS ROM
```

`_initCpu()` boots the 6502 from the ROM reset vector (`$FFFC/$FFFD`).
`_wireCallbacks()` connects the VIA port read/write callbacks (re-applied after
`reset()` recreates the VIAs).

### Clock loop
`clock(cycles)` steps the drive one cycle at a time, **peripherals before CPU**:

```
  for each cycle:
    via1.clock(1)
    via2.clock(1)
    if (motorOn) _advanceSpindle(1)     // GCR bit shift, byte framing, SO/CA1
    cpu.clock()                          // drive 6502 micro-op
```

Peripherals tick first so a GCR byte-ready V-flag latch or a VIA timer IRQ
raised *this* cycle is visible to the CPU's micro-op when it samples them; with
the order reversed, the DOS's `BVS`/IRQ-poll loops see events a cycle late and
reads fail. The machine clocks an attached drive through a
16.16 drive:C64 accumulator at the true PAL ratio of 1 MHz / 985248 Hz.

The attached drive is not always full-clocked. `machine._runMasterCycle()`
can enter idle-skip once the IEC bus has been quiet long enough and
`Drive1541.canIdleSkip()` proves that the drive CPU is parked at a known ROM or
fastloader idle loop, on an instruction boundary, with motor/LED/IRQ off and the
serial lines released. While skipped, the CPU loop is not run per cycle;
`deferIdleCycle()` accounts for elapsed drive time and `settleIdleCycles()` later
advances VIA timers when a bus edge or timer wake arrives. Bus changes wake the
drive immediately via `setIecLines()`.

---

## 4. VIA1: the IEC serial bus interface

VIA1 Port B is the serial bus. A **7406 open-collector inverter** sits between the
VIA pins and the bus lines, so a VIA register bit of 1 corresponds to the bus line
being pulled LOW (asserted). Bit layout:

| Bit | Function |
|-----|----------|
| 0 | DATA IN | 
| 1 | DATA OUT (0 = pull low) |
| 2 | CLOCK IN |
| 3 | CLOCK OUT |
| 4 | ATNA (ATN acknowledge) |
| 5,6 | device-# jumpers (device 8 → 00) |
| 7 | ATN IN |

- **`readPortB`** pulls the live bus state first (`busSyncCallback` →
  `machine._syncIecBus`); the drive can spin polling `$1800` without writing, so
  the inputs must reflect the current bus, not a cached value. It folds in the
  device-number jumpers and the inverter pull-ups for any output pin a fastloader
  flipped to input.
- **`writePortB`** recomputes the drive's output pins (`_manualDataOut_pin`,
  `clkOut_pin`, `_atna_pin`) from the output register masked by DDR, then
  `_refreshIecOutputs()`.
- **`_refreshIecOutputs`** implements the 1541's hardware DATA logic:
  `DATA is pulled low iff (PB1 == 0) OR (ATNA_pin XOR ATN_bus)`, the automatic
  ATN-acknowledge that lets the C64 detect the drive's presence. It notifies the
  bus (`busSyncCallback`) only when an output actually changed, to avoid infinite
  `setIecLines → _refreshIecOutputs → callback` recursion.
- **ATN falling edge** triggers VIA1 CA1 (`setIecLines` → `via1.triggerIrq(1)`),
  the interrupt the DOS uses to enter its command state.

The bus itself is **wired-AND** and arbitrated in `machine._syncIecBus()`; see
the [machine orchestrator](MACHINE-ARCHITECTURE.md) §6. The drive sees the
*reflected* composite bus (`setIecLines`), never just its own output: it must
re-sync on every VIA1-PB read or the wired-AND can deadlock.

---

## 5. VIA2: drive mechanics & read/write head

- **Port A** is the head's data byte. On a **read**, `readPortA` returns the GCR
  byte from the read head (`lastGCRByte`, whatever the spindle last framed). On a
  **write**, the DOS stores the outgoing GCR byte here and `writePortA` latches it
  (`_lastWrittenByte`) for the spindle to shift onto the track (§7).
- Read vs write is selected by **VIA2 CB2** (PCR bits 5-7): manual-output-**low**
  (`PCR & $E0 == $C0`) = write, high (`$E0`) = read. `_isWriteMode()` also guards on
  Port A DDR = `$FF` (all output), which the DOS sets only while writing.
- **Port B** is the mechanics:

| Bit | Function |
|-----|----------|
| 0-1 | stepper motor phases (low 2 bits of the 4-phase pattern) |
| 2 | spindle motor on (active high) |
| 3 | activity LED |
| 4 | write-protect sense (input, **active low**: 0 = protected, 1 = write enabled) |
| 5-6 | bit-rate / speed-zone select |
| 7 | SYNC detect (input, 0 = sync found) |

`writePortB` tracks motor on/off (starting the spin-up window), latches the speed
zone, and decodes the **stepper phase** from the *output register* (ORB), not the
masked pin value, so a DDR-only write doesn't synthesize a spurious step.

- **CA1 / CA2 = byte-ready / SOE.** When the spindle frames a byte, it pulses
  VIA2 CA1 (`triggerIrq(1)`, latches the IFR flag, readable at `$1C0D`,
  cleared by reading `$1C01`) **and**, if **SOE** is enabled, asserts the
  6502 SO pin. SOE is CA2: the DOS writes `PCR=$EE` (CA2 = 111) during sector
  reads so byte-ready reaches the CPU's V flag (the `BVC` read loop); seek/gap
  phases leave CA2 ≠ 111 to suppress it. The same byte-ready pulse paces a
  **write**: it fires every 8 bits shifted *onto* the track, so the DOS's write
  loop hands over the next byte in time.

### VIA6522 internals
The shared `VIA6522` models the two timers (T1 free-run/one-shot driving the DOS
controller scheduler IRQs; T2 one-shot), the IFR/IER interrupt logic
(`irqState`, `triggerIrq`, `clearIrq`), and the port/handshake registers. It is a
1541-focused subset, not a complete 6522. Both VIAs feed `_updateIrq()` →
`cpu.setIrqLine(via1.irqState || via2.irqState)`.

---

## 6. Stepper motor & head positioning

The head position is tracked as a **half-track** index (`currentHalfTrack`, 2..84
→ tracks 1..35+). The stepper is a 4-phase Gray-coded motor: each phase
transition moves the head one half-track, with direction encoded in the
transition (`_stepHeadByPhase`):

- step **in** (higher tracks): phase 0→1→2→3→0
- step **out** (lower tracks): phase 0→3→2→1→0
- a 2-step (illegal) transition doesn't move the head reliably.

Decoding from the phase pattern itself (rather than a DOS target-track shortcut)
is essential because fastloaders write phases directly, bypassing the DOS job
queue. The head rests on **track 18
(half-track 36)** at power-up, matching VICE's deterministic reset position. A
step optionally arms a head-settle window (§11).

---

## 7. The spindle / GCR read+write engine (`_advanceSpindle`)

This is the heart of the read path. Per cycle (while the motor is on):

1. **Bit clock**: `bitCycleAccum` accumulates cycles; one bit is shifted every
   `CYCLES_PER_BYTE[zone] / 8` cycles. The four speed zones (`[32,30,28,26]`
   cycles/byte) model the constant-angular-velocity zones; outer tracks pack
   more bits. Which zone applies depends on the disk source: a D64 track is
   synthesized for whatever the VIA2 PB5-6 density bits select
   (`currentSpeedZone`), while a G64 track is clocked at the zone it was
   recorded in (`_streamZone`, from the image's speed table): the disk turns at
   300 rpm whatever the drive selects, so recorded bits pass the head at the
   rate they were written. `_readCell` is the read circuit: its clock runs at
   the selected density and restarts at every transition, so a track read at
   another density yields a different count of zeros between ones (the elapsed
   time in selected cells, rounded, less one). 18 µs without a transition
   starts random ones every 2-25 µs, VICE's weak-bit rule (`drive/rotation.c`),
   until the next real one. A G64 per-byte speed map (`_streamMap`) moves `_streamZone` byte by
   byte.
2. **Track fetch**: on a head move (`trackDirty`), pull the GCR stream for the
   current position from the disk source, `getTrackStream(track, halfTrack)`,
   and rescale the bit position so rotation phase is preserved across the step.
   A D64 source (`GCRDisk`) has whole tracks only; a G64 records every
   half-track separately, so a head parked on an odd half-track reads that entry.
   A position with nothing recorded (an empty G64 entry, or past the last track
   of a D64) yields no stream: no SYNC, no bytes, the read side held reset, so
   the DOS's sync wait times out (error 21) rather than seeing the previous
   track's SYNC linger.
3. **Bit shift**: read the next bit from the track bitstream (which loops; the
   disk spins continuously), shift it into `_shiftReg`.
4. **SYNC detection**: a run of **10+ consecutive 1-bits** is a sync mark; drives
   the VIA2 SYNC bit low (`_syncBit = 0x00`), and there is no valid byte framing
   while in sync. The first 0-bit after sync re-establishes byte alignment.
5. **Byte framing**: every 8 shifted bits outside sync forms a byte →
   `lastGCRByte`, and fires **byte-ready** (VIA2 CA1 + SO pin if SOE on, §5).

So the C64↔drive read protocol emerges from the same primitives real hardware
uses: the DOS (or a fastloader) waits on SYNC, then reads bytes paced by the
byte-ready pulses, decodes the 4-to-5 GCR back to data, and verifies the
checksum.

**Writing** is the mirror image, taken while the DOS holds the head in write mode
(§5). Instead of framing bits *off* the track, the engine shifts the latched
`_lastWrittenByte` MSB-first *onto* the current track buffer at the head position,
and pulses byte-ready every 8 bits so the DOS feeds the next byte. Sync (`$FF`) and
the header/data blocks are simply the bytes the DOS emits, so no special-casing is
needed. The mutated per-track buffer is decoded back to the D64 image on demand
(`GCRDisk.commitDirtyTracks()`, §8). A disk is written only when it presents PB4
high (write enabled); the DOS refuses to write a protected disk (error 26).

---

## 8. GCR encoding & decoding (`gcr.js`)

`GCRDisk` turns D64 sectors into the raw bitstream the spindle reads, and folds
head writes back the other way. Encoding must match the standard on-disk layout
byte-for-byte or cycle-counted fastloaders reject headers. Per track
(`buildTrackStream`):

- **4-to-5 GCR**: every 4 data bits → 5 GCR bits via `GCR_ENCODE`, guaranteeing
  no long runs of 0s (which the read electronics couldn't clock) and reserving
  10+ 1-bit runs for sync marks.
- **Per sector**: 5 bytes of `$FF` header sync → header block
  (`08, checksum, sector, track, id2, id1, $0F, $0F`; the trailing `$0F $0F` are
  load-bearing for some decoders) → 9-byte header gap → 5 bytes data sync → data
  block (`07` + 256 data + checksum + 2 pad) → inter-sector tail gap.
- **Track sizing & gaps** are zone-indexed (`TRACK_SIZE`, `TAIL_GAP`) to the
  standard D64 layout; gap filler is `$55`.
- **Recorded errors are put back.** With an error table, each sector is encoded
  with its fault: 21 loses its two sync marks, 20/22 get an unrecognizable
  header/data block, 23/27 a checksum that doesn't match, 29 a wrong disk ID
  with a *valid* checksum (so the drive faults on the ID, not the checksum).
  Write-failure and drive-not-ready codes read normally.
- **A track the image doesn't reach produces no sectors**: tracks 36-40 of a
  35-track image are unformatted, not zero-filled; `getTrackStream` returns
  `null` past the last track.
- Streams are built **lazily and cached** per track (`_cache`).

**Decoding (write-back).** The inverse path folds the mutated track buffer back
into the image:

- `decodeTrackStream(stream)` walks the buffer as a circular bitstream, hunts sync
  (≥10 one-bits) exactly as the read head does, then reads 5-bit GCR groups through
  `GCR_DECODE` (the exact inverse of `GCR_ENCODE`). Each `$08` header supplies the
  (track, sector) for the `$07` data block that follows it; both checksums are
  verified and any bad/invalid block is **skipped, never written**, so a
  half-written or garbage track can't corrupt already-good sectors. The two off
  bytes after a data block's checksum are not decoded: the DOS discards them,
  and mastered disks (G64) carry non-GCR bit patterns there.
- `markTrackDirty()` flags a track the write head mutated; `commitDirtyTracks()`
  decodes each dirty track and writes its sectors into the D64 via
  `d64.writeSector()`. The encode↔decode round-trip is lossless (683/683 sectors),
  so re-writing untouched sectors is idempotent; only genuinely changed data moves.

> Note the two opposite zone numberings: `zoneForTrack` (outer→inner 0..3, used
> for `TRACK_SIZE`/`TAIL_GAP`) vs. the VIA2 PB5-6 density bits (used for
> `CYCLES_PER_BYTE`). The drive's `speedZoneBitsForTrack` uses the latter.

---

## 9. Sector images: D64, D71 and D81 (`media/d64.js`)

`D64` parses a 35-track (683-sector) image, an extended variant, or a 1581's
D81, or a 1571's 70-track D71. A **layout** per kind says where the DOS keeps things: the 1541's header
and BAM share 18/0 (4-byte entries) with the directory from 18/1; the 1581 has
its header at 40/0, forty tracks per BAM sector at 40/1 and 40/2 (6-byte
entries: count plus a 40-bit map) and its directory from 40/3, interleave 1.
`_bamEntry`, `_allocateBlocks` and `createBlankDisk(kind)` all go through
the layout. A D81 is `readableBy1541: false`: `Drive1541.setDisk()` treats it
as an empty drive, and only the load trap serves it.

D71 repeats the 35-track geometry on side two. Its header/directory remain
18/0 and 18/1. Tracks 36-70 store free counts in 18/0 at `$DD` and bitmaps
in 53/0, so `_bamEntry` supplies separate count and map locations. Allocation
reserves tracks 18 and 53; a blank disk has 1328 file blocks. D71 is virtual-only
(`readableBy1541: false`); mounting disables TDE for the selected device.

- **`d64Variant(byteLength)`**: the length is the only thing identifying the
  format, so it serves as both the variant lookup (35/40/42 tracks or an
  70-track D71 or 80-track D81, ± error table, with a `kind`) and the "is this a disk image at
  all" check callers run before
  mounting. `errorForSector()` reads the table; `writeSector()` clears an entry.
- **`SPT`**: sectors-per-track table (21 on tracks 1-17 down to 17 on 31-35 and
  the extended tracks), the CAV zone structure.
- **BAM extension**: the standard BAM stops at track 35. Tracks 36-40 count
  only when `_detectBamExtension` recognizes one of `$AC`/`$C0`/`$90` by shape
  (free counts matching their bitmaps). `_bamOffset` returns -1 for an
  undescribed track, which keeps allocation off the disk name; the standard
  arithmetic for track 36 lands on it.
- **`readSector(track, sector)`**: raw 256-byte sector access (what `gcr.js`
  encodes); **`writeSector(track, sector, bytes)`** is the write-back primitive
  (marks the image dirty), used by `gcr.js`'s decoder.
- **`createBlankD64(name, id)`**: synthesizes a fresh empty *formatted* image
  (empty BAM at 18/0 + directory at 18/1, 664 blocks free) for the FORMAT action.
  `createBlankD71` adds the second side and its split BAM.
  `createBlankD81` does the same for a 1581 disk (header at 40/0, BAM at 40/1
  and 40/2, directory at 40/3, 3160 blocks free); `createBlankDisk(kind)` picks.
- **Directory** (`_parse`): reads the header sector for name/ID/DOS type,
  sums the BAM's free counts (directory track left out), then walks the
  directory chain collecting entries (name, type, start track/sector, block
  count). Type 5 is a 1581 partition: listed as CBM, never loaded or scratched.
- **`loadFile(name)`**: resolves a name as DOS does (`*` matches from there on,
  `?` any one byte, `0:` prefix and `,P`/`,S,R` suffix stripped), then follows
  its chain with `readChain`, which stops on a link that loops or leaves the
  disk, and returns the raw bytes (PRG: first 2 = load address). Any type
  resolves; a
  program stored as USR loads like one stored as PRG. Used by the **load trap**.
- **`buildDirectoryPRG(pattern)`**: synthesizes the directory as an in-memory
  BASIC program so `LOAD "$",8` + `LIST` shows the catalog; a pattern
  (`LOAD"$:A*",8`) narrows it. Unclosed files get the `*` splat, locked ones `<`.
- **`writePRG(name, bytes)`**: the inverse of `loadFile`: allocates blocks from
  the BAM (outward from the directory track at the layout's interleave, 10 on a
  1541 and 1 on a 1581, the way DOS fills a disk), chains them, and adds a closed
  PRG directory entry. Long files extend the directory chain with another
  directory-track sector when the first is full.
- **`createPRGDisk(filename, bytes)`**: a blank write-protected image with the
  program written into it: how a `.prg` arrives through the ordinary
  `LOAD"*",8,1` path; the loading policy around it (`prgAutostart()`) belongs to
  the [machine orchestrator](MACHINE-ARCHITECTURE.md) (§8).

### The G64 image (`media/g64.js`)

A `.g64` stores what the read head sees rather than sectors: one raw GCR
bitstream per half-track, at its recorded length, plus the speed zone each was
written in. `Drive1541.setDisk()` takes either kind of image and keeps two
references: `disk` (the image, for `dirty` and `writeProtected`) and `gcrDisk`
(the GCR source: the `G64` itself, or a `GCRDisk` wrapping a `D64`). Both
sources offer the same interface: `getTrackStream(track, halfTrack)`,
`markTrackDirty(track, halfTrack)`, `hasDirtyTracks()`, `commitDirtyTracks()`
and, on a G64, `speedZoneFor(halfTrack)`.

- **`parseG64(bytes)`** checks the `GCR-1541` header, version 0, the half-track
  count (1-84) and maximum track size, and refuses any track offset, length or
  speed map that leaves the file. Track data are **views into the file bytes**,
  so the head's writes land in the image in place and `img` is always the disk
  as it now stands; nothing is re-serialized. A speed entry of 0-3 is the zone
  of the whole track; a larger value points at a per-byte map, of which the
  first byte's zone is used throughout.
- **Half-track addressing**: entry *i* is drive half-track *i + 2* (entry 0 =
  track 1), so `getTrackStream` ignores the whole-track argument and indexes by
  the half-track. An entry with offset 0 or length 0 is unrecorded (`null`).
- **Sector view**: everything that wants sectors (the directory panel,
  click-to-load, the TDE-off load trap, `buildDirectoryPRG`) reads a `D64` built
  by running `decodeTrackStream` over each whole track once at mount. A block
  whose header names a different track is dropped (a protection's decoy must not
  overwrite the real sector), and the first readable copy of a sector wins.
  After head writes, `commitDirtyTracks()` re-decodes only the written tracks
  into that view; the GCR bytes themselves need no folding back. Some dumps
  hold every track one slot late (track 1 in the slot for track 2, the first
  slot empty): when all recorded tracks' headers agree on one such offset,
  `headerShift()` records it and the view reads each track from the slot the
  headers point at (`_entryFor`). The drive keeps reading the slots as
  recorded; the DOS finds a track by its headers, so it lands on the right one
  anyway.
- **What the view cannot show** is exactly what the raw stream is for: custom
  sector layouts, extra sectors, half-track data and bad checksums are all
  invisible to the view and all read by the drive as recorded.

### Nibbler dumps (`media/nib.js`)

A `.nib` holds 8 KB straight off the read head per half-track, more than one
revolution, begun anywhere; a `.nbz` is the same file as one LZ77 stream.
`nibFileToG64()` inflates it and, per half-track, `extractTrackCycle()` finds
where the data comes round (matching what follows each sync, else any
repeating 7 bytes, within the zone's capacity range), starts the revolution at
the tail gap, else at sector 0, else at the longest run, and `nibToG64()`
spreads a fat track to the half-track between, zeroes the inside of bad-GCR
runs and shortens sync runs on any track a real disk could not hold. The
rules and constants are nibconv's at its defaults (see `NOTICE.txt`); the
output is an ordinary G64 for `G64` and the drive.

---

### The virtual drive (`src/media/virtual-drive.js`)

With true drive emulation off, the trap-served drive is a `VirtualDrive`: a
DOS over the mounted sector image (D64, D71 or D81), answering the KERNAL's
serial primitives instead of the IEC bus. The machine traps TALK and LISTEN
(`$ED09`, `$ED0C`) when A names a trap-served device, then SECOND, TKSA,
CIOUT, ACPTR, UNTALK and UNLISTEN until the drive is released, and returns
from each as the ROM would. A stock KERNAL is required.

| Area | Supported | Not supported |
| --- | --- | --- |
| Open | `[@][0:]name[,P\|S\|U][,R\|W\|A]`, wildcards, `$[0:][pattern]` as the LOAD"$" listing, `#` buffer; sa 0 reads and sa 1 writes a PRG | REL files (`,L`), partitions (64), more than one drive number |
| Read | the file with EOI on the last byte, then a timeout | |
| Write | collected and written at close as PRG, SEQ or USR; `@` replaces, `,A` appends | writes larger than the free space fail at close (72), not as they arrive |
| Channel 15 | `I`, `V`, `UI`/`UJ` (73), `S`, `R`, `N`, `U1`/`U2`, `B-R`/`B-W`, `B-P`, `M-R` (zero bytes), `M-W`/`M-E` (accepted, no effect) | `C`, `D`, `P`, REL positioning, drive code (31) |
| Status | `NN,MESSAGE,TT,SS`: 00, 01, 26, 31, 62, 63, 64, 66, 70, 72, 73 (1541 or 1581 wording by image kind), 74 | read errors from an error table |
| Hardware | | bus timing, LED on the bus, loaders that bit-bang `$DD00` (they still find the real 1541, or nothing) |

Hooks: `onOpen` drives the LED and drive sound, `onWrite` the app's directory
refresh and Library save. Channels are transient: a disk swap or reset closes
them, and a save state holds none.

## 10. Idle-skip optimisation

A drive spinning in its ROM idle loop (or a fastloader idle loop) with the
spindle stopped and all bus lines released does no useful work. `canIdleSkip()`
detects that state (PC in the idle loops, no IRQ pending, motor/LED off, bus
released), and the machine **skips the CPU** for those cycles
(`deferIdleCycle`/`_skipDriveIdleCycle`). The deferred VIA time is batched and
settled (`settleIdleCycles`) when a bus change arrives or a timed wake fires
(`idleSkipWakeCycles`, derived from the VIA timers). This keeps an idle
drive cheap without losing the next ATN edge. See the [machine orchestrator](MACHINE-ARCHITECTURE.md) §6.

---

## 11. Mechanical timing models (opt-in flags)

Physical delays that suppress valid byte framing while the drive is not
read-stable. The DOS tolerates instant behaviour (it has its own delay loops),
and these can slow loads / perturb cycle-counted fastloaders, so they are
feature-flagged:

| Flag | Default | Models |
|------|---------|--------|
| `DRIVE_MOTOR_SPINUP_ENABLED` | **off** | ~300 ms (300k cy) after motor-on before stable read speed |
| `DRIVE_HEAD_SETTLE_ENABLED` | **off** | ~10 ms (10k cy) after a half-track step before reads are stable |
| `DRIVE_SO_DELAY_ENABLED` | **off** | VICE's P1-aligned delay between the bit-8 boundary and the CPU's V-flag set (risky above ~18 cy) |

All three are compile-time constants at the top of `drive1541.js` (not
`switches.js` entries) and default **off**; the DOS has its own delay loops and
instant framing is safe, so they exist mainly for A/B experiments. When
spin-up / head-settle is enabled its window keeps the disk turning (bit
position advances) but suppresses SYNC and byte framing until it elapses.

---

## 12. Reset

`reset()` clears RAM, **recreates both VIAs** (and re-wires their callbacks),
restores the head to track 18, reseeds the speed zone and stepper phase to be
consistent with that track, clears all IEC line trackers and the read-engine
state, and re-boots the CPU from the ROM reset vector. `setTrueDrive` (in the
machine) additionally runs the drive forward until its ROM self-test reaches the
idle scheduler before the first LOAD, so the C64 doesn't time out racing the boot.

---

## 13. Key invariants & gotchas (quick reference)

- **Peripherals clock before the CPU** each cycle, and an attached drive uses the
  true PAL drive:C64 ratio.
- **VIA1 PB uses 7406 inverters**: register bit 1 ⇒ bus line LOW. The drive must
  re-sync the bus on every PB read or the wired-AND can deadlock.
- **Byte-ready drives both CA1 and the SO pin**; the SO path is gated by SOE
  (VIA2 CA2 / `PCR=$EE`). Seek/gap phases suppress it.
- **Stepping is decoded from the 4-phase Gray pattern**, not a DOS target-track;
  fastloaders bypass the job queue.
- **GCR layout must match VICE byte-for-byte** (sync lengths, `$0F $0F` header
  tail, per-zone gaps) or cycle-counted decoders reject it.
- **Two opposite zone numberings exist** (`zoneForTrack` vs. the VIA2 density
  bits); don't conflate them.
- **With TDE off, device 8 is the virtual drive's**: the load trap serves LOAD
  at `$FFD5` and `$F4A5`, and the serial traps serve everything else the
  KERNAL sends to the drive (OPEN, CHKIN, CHRIN, CLOSE, SAVE, channel 15). A
  bit-banged loader still finds the real 1541, or nothing, on the wires.
- **D71/D81 stay on the virtual-drive path**: `setDisk()` treats media it cannot read as
  an empty drive. With TDE on the DOS answers DRIVE NOT READY; the virtual
  drive (TDE off) serves D71 and D81 images.
- **The trap still prints the KERNAL's load messages** via the ROM's own
  routines; a program reading its next command off the screen counts on them.
- **`$FFD5`'s register arguments are banked before those routines run**: A picks
  LOAD or VERIFY, X/Y carry the address a secondary address of 0 loads at, and the
  message routines return with their own leftovers in the registers. The ROM banks
  all three into zero page before printing; the trap has to do the same.
- **Idle 1541 cycles are skipped, not free-run forever**: only after the drive
  is in a recognized idle loop with bus/motor/LED/IRQ quiet; VIA timer time is
  batched and settled on wake.
