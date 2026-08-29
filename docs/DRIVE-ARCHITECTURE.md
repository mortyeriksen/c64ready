<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->

# 1541 Disk Drive (`src/drive1541.js` + `gcr.js` + `d64.js` + `6522.js`): Architecture Overview

A high-level map of the Commodore 1541 floppy-drive emulation: the drive as a
self-contained computer (6502 + two 6522 VIAs + DOS ROM), the spindle/GCR
read+write engine, the IEC serial bus, the stepper motor, the D64↔GCR encode/decode
pipeline, and the two ways the host talks to it (KERNAL load trap vs. True Drive
Emulation).

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
- **KERNAL load trap** (TDE off): the machine intercepts the KERNAL LOAD entry
  `$FFD5` and reads the file straight from the D64. Fast, but only handles standard
  LOADs (and `SAVE`/format are never trapped, so they still reach the real drive).
  The trap is not silent: it runs the ROM's own `SEARCHING FOR` (`$F5AF`) and
  `LOADING` (`$F5D2`) routines first, each returning to `$FFD5` so the third pass
  does the load. Intros that hand over by printing commands and stuffing RETURNs
  read those lines back off the screen, so skipping them leaves the cursor two
  rows out. Calling the ROM also gets the `MSGFLG` direct-mode test for free, a
  program-initiated LOAD still prints nothing. Guarded on the ROM actually
  holding those routines; a replacement KERNAL falls back to a silent load.
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
| `d64.js` | **`D64`**: parses the disk image: sectors, BAM, directory, file chains, `$`-directory PRG synthesis |
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

Peripherals tick first so a GCR byte-ready V-flag latch or a VIA timer IRQ that
occurred *this* cycle is visible to the CPU's micro-op when it samples them;
reversing the order made `BVS`/IRQ-poll loops miss events by a cycle (looks like
a read error → blinking LED). The machine clocks an attached drive through a
16.16 drive:C64 accumulator: default true PAL ratio is 1 MHz / 985248 Hz
(`driveTrueClockRatio`), while the lockstep switch pins it to exact 1:1.

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
   `CYCLES_PER_BYTE[speedZone] / 8` cycles. The four speed zones
   (`[32,30,28,26]` cycles/byte, indexed by the VIA2 PB5-6 density bits) model
   the constant-angular-velocity zones; outer tracks pack more bits.
2. **Track fetch**: on a head move (`trackDirty`), pull the GCR stream for the
   current track from `GCRDisk` and rescale the bit position so rotation phase is
   preserved across the step.
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
  half-written or garbage track can't corrupt already-good sectors.
- `markTrackDirty()` flags a track the write head mutated; `commitDirtyTracks()`
  decodes each dirty track and writes its sectors into the D64 via
  `d64.writeSector()`. The encode↔decode round-trip is lossless (683/683 sectors),
  so re-writing untouched sectors is idempotent; only genuinely changed data moves.

> Note the two opposite zone numberings: `zoneForTrack` (outer→inner 0..3, used
> for `TRACK_SIZE`/`TAIL_GAP`) vs. the VIA2 PB5-6 density bits (used for
> `CYCLES_PER_BYTE`). The drive's `speedZoneBitsForTrack` uses the latter.

---

## 9. The D64 image (`d64.js`)

`D64` parses a standard 35-track (683-sector) image or one of the extended
variants:

- **`d64Variant(byteLength)`**: the length is the only thing identifying the
  format, so it serves as both the variant lookup (35/40/42 tracks, ± error
  table) and the "is this a disk image at all" check callers run before
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
- **Directory** (`_parse`): reads the BAM (track 18 sector 0) for disk
  name/ID/DOS-type/free-blocks, then walks the directory chain (track 18 sector
  1) collecting file entries (name, type, start track/sector, block count).
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
  the BAM (outward from the directory track, 10-sector interleave, the way DOS
  fills a disk), chains them, and adds a closed PRG directory entry. Long files
  extend the directory chain with another track-18 sector when the first is full.
- **`createPRGDisk(filename, bytes)`**: a blank image with one program written
  into it, named after the file. This is how a `.prg` loads: it goes on a disk
  and the disk goes in the drive, so it arrives through the ordinary
  `LOAD"*",8,1` path instead of being poked into RAM. The disk is
  write-protected. `prgAutostart()` then decides what to type: `RUN` when the
  file really is BASIC (validated by its line header, not just a `$0801` load
  address), nothing for machine code, whose entry point the file never states.

---

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

All three default **off**; the DOS has its own delay loops and instant framing
is safe, so they exist mainly for A/B experiments. When spin-up / head-settle is
enabled its window keeps the disk turning (bit position advances) but suppresses
SYNC and byte framing until it elapses.

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

- **The drive is a real computer**: its 6502 runs the DOS ROM; the read protocol
  emerges from GCR bits + byte-ready, not from shortcuts. That's why fastloaders
  work.
- **Peripherals clock before the CPU** each cycle, and an attached drive uses the
  true PAL drive:C64 ratio by default, with an exact 1:1 lockstep switch for
  investigations.
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
- **The load trap (TDE off) bypasses DOS only at `$FFD5`**: it reads the D64
  directly for standard KERNAL LOADs, but an attached drive 8 still remains live
  on the IEC bus for lower-level protocol traffic and bit-banged loaders. LOAD is
  all it serves; SAVE, sequential files and the command channel need TDE on.
- **The trap still prints the KERNAL's load messages** via the ROM's own
  routines; a program reading its next command off the screen counts on them.
- **Idle 1541 cycles are skipped, not free-run forever**: only after the drive
  is in a recognized idle loop with bus/motor/LED/IRQ quiet; VIA timer time is
  batched and settled on wake.
- **Mechanical timing is opt-in**; spin-up, head-settle, and the SO delay all default off.
