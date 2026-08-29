<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->

# C64 Machine (`src/machine.js`): Architecture Overview

A high-level map of the top-level orchestrator: how the chips are wired
together, the per-cycle master-cycle ordering that drives everything, bus
arbitration (BA/RDY/AEC), the interrupt delay pipeline, the IEC/1541 drive
coupling, SID audio, input, the load paths (ROM/PRG/cartridge/disk/tape), and the
reset model.

This document describes *the implementation* and points at the real method and
field names so it can be used as a guide into `machine.js` (~1.65k lines). The
machine owns no chip behaviour itself; it **wires** the `CPU`, `CIA` ×2, `VIC2`,
`Memory`, `Drive1541`, `Datasette`, and SID together and clocks them in the
correct order. For the chips' internals see the sibling docs
([6510 CPU](CPU-ARCHITECTURE.md), [VIC-II](VIC2-ARCHITECTURE.md)) and the per-chip source files.

---

## 1. Big picture

`C64Machine` is instantiated once. It builds every chip, wires their cross-
references and I/O callbacks, then runs the system **one PAL frame per
`runFrame()` call** (driven from the browser's `requestAnimationFrame` in
`main.js`). A frame is `CYCLES_PER_FRAME = 19656` master cycles; each master
cycle steps the whole machine in a fixed phase order.

```
   main.js  (requestAnimationFrame)
        │  machine.runFrame()
        ▼
   for 19656 cycles:  _runMasterCycle()
        │
        ├─ shadow SID voices  (OSC3/ENV3 readback)
        ├─ POT sample-and-hold (every 512 cy; reads gated, see step 2)
        ├─ _iecClock()       [if drive]  ← advance drive→C64 pin delay line
        ├─ _sampleCpuInterrupts()        ← apply PREV cycle's pending IRQ/NMI
        ├─ vic2.clock(1)        [phi1]   ← VIC acts first; sets BA/AEC
        ├─ cia1/cia2.clock(1)   [phi1]   ← timers count, IR latch
        ├─ cpu.clock()          [phi2]   ← unless RDY/AEC blocks it (or load trap)
        ├─ vic2.phi2()                    ← reconcile same-cycle CPU writes
        ├─ datasette.clock(1)
        └─ drive1541.clock(steps)        ← steps=1 or 2 (PAL ratio), or idle-skip
        ▼
   (after the loop)  cia1/cia2.tick50Hz()   ← TOD clock
        │
        ▼
   caller blits vic2 framebuffer to canvas
```

---

## 2. Component wiring (constructor)

The constructor builds the chips and connects them. The key cross-references and
callbacks:

| Wiring | Purpose |
|--------|---------|
| `mem.vic2 / cia1 / cia2 / sid / machine` | Memory routes `$D000-$DFFF` I/O reads/writes to the chips |
| `vic2.ram / colorRam / charRom / cia2 / cpu / memory` | VIC fetches from RAM/color-RAM/char-ROM, reads the VIC bank from CIA2, drives the shared open-bus latch in Memory |
| `cia2.writePortA / readPortA` | IEC bus serialization + VIC bank selection (see §6) |
| `cia1.writePortB` → `_updateLightpen` | CIA1 PB4 / joystick-1 fire drive the VIC light-pen pin |
| `cia1/cia2/vic2.irqHandler` | feed the per-source interrupt delay pipeline (see §5) |
| `cpu.onInterruptAccept` | diagnostic; forwards accept events to the VIC frame trace |
| `datasette.flagCallback` → `cia1.setFlag` | tape pulse edges raise the CIA1 FLAG line |
| `reu.busHoldHandler` / `irqHandler` | an attached RAM Expansion drives `_reuBusHold` (the arbitration boolean in §4) and `_reuIrqPending` (the /IRQ level in §5) |

`SIDProxy` (top of file) is the object Memory sees as "the SID": writes forward
to `_sidWrite` (worklet ring + shadow voices); reads serve POTX/POTY
(sample-and-held) and `$D41B/$D41C` (OSC3/ENV3 from the shadow voices), else the
register shadow.

---

## 3. The master cycle: ordering is everything

`_runMasterCycle()` is the heart of the emulator. The phase order models the real
chip's **phi1 (VIC/CIA) → phi2 (CPU)** split, and is the single most important
correctness invariant in the file. `_masterPhase` is set to a string label at
each step (read by the VIC IRQ handler's late-tag and the bus trace).

1. **Shadow SID voices** clock, for cycle-exact `$D41B/$D41C` (OSC3/ENV3)
   readback only. Voice 3 gets the full core clock; voices 1 & 2 (only the
   sync/ring source chain) advance **phase-accumulator only** (`clockPhaseOnly()`),
   skipping their unread envelope/LFSR/waveform. No filter or mixing; audio-only.
2. **POT sample-and-hold**: every 512 cycles, latch `paddleX/Y` into
   `potXSampled/Y` (the real SID's 8-bit SAR ADC cadence). Whether the latch is
   what `$D419/$D41A` actually return depends on two gates in front of it:
   `potConnected` and `potXOverride`; see SID-ARCHITECTURE.md.
3. **`_iecClock()`**: only when a drive is attached and `iecEdgeLatency` is on
   (the default). Advances the drive→C64 pin delay line so the C64's `$DD00`
   reads sample the drive's CLK/DATA pins one master cycle late; the drive-facing
   bus is untouched (the drive sees C64 edges instantly). See §6.
4. **`_sampleCpuInterrupts()`**: apply the *previous* cycle's pending IRQ/NMI to
   the CPU pins. Reading last cycle's pending is what gives interrupts their
   delay (see §5).
5. **`vic2.clock(1)`, phi1**. VIC runs first so it reads its own registers
   *before* a same-cycle CPU write ("VIC acts before CPU"); CPU writes land in
   the register file afterwards and are visible to the VIC next cycle. This sets
   BA/AEC for the cycle.
6. **`cia1/cia2.clock(1)`, phi1**. Timers count + the ICR data→IR latch advance
   before the CPU's phi2, so a CPU register read this cycle sees this cycle's
   underflow (the 6526 interrupt-acknowledge race). The timer *counter* read is
   separate: `beginMasterCycle()` snapshots `$DC04-$DC07` **before** this cycle's
   count, so it reads deliberately one behind the ICR/IR-latch read above.
7. **`reu.dmaCycle()`, phi2**, when a RAM Expansion transfer holds the bus and
   the VIC has not taken this cycle. One C64-bus access per call, under its own
   `_masterPhase = 'reu'` tag so a transfer's writes are not mistaken for CPU
   writes by the VIC IRQ late-tag. The CPU is skipped entirely on these cycles
   (see §4).
8. **`cpu.clock()`, phi2**, *unless* blocked (see §4), or the **KERNAL load
   trap** fires instead (see §8).
9. **`vic2.phi2()`**: VIC behaviour that depends on same-cycle CPU writes (the
   cycle-56 `$D017` reconciliation, the cycle-58 bad-line transition).
10. **`datasette.clock(1)`**: a tape edge sets the CIA1 FLAG bit, picked up by
    next cycle's phi1 CIA clock.
11. **`cia*.endMasterCycle()`** closes the per-cycle read window; optional bus
    trace record.
12. **`drive1541.clock(steps)`**: `steps` is 1 or 2, carried by the 16.16
    drive:C64 ratio accumulator (true PAL 66517/65536; 65536 = exact 1:1), or
    idle-skip (see §6). A second drive (device 9) clocks in lockstep here. The
    C64 CPU runs *before* the drive each cycle so a `STA $DD00` lands in the
    drive's input latches before its next `$1800` read.

After the 19656-cycle loop, `runFrame()` ticks the **TOD clocks**
(`cia*.tick50Hz()`, the PAL 50 Hz time-of-day) and returns so the caller can
blit.

---

## 4. Bus arbitration: BA / RDY / AEC / DMA

Two devices can take the bus away from the 6510: the VIC, for bad-line
character fetches and sprite DMA, and an attached RAM Expansion, for the length
of a transfer. The machine reads the VIC's `isBaLow()` and `isAecLowPhi2()`
each cycle, ORs in `_reuBusHold`, and decides whether the CPU may run, per
Bauer §3.5 / §3.6.1:

- **RDY (BA low)** halts any **non-write** CPU bus cycle (reads, opcode fetches,
  dummy reads, internal cycles, all of which do a real bus access). Writes
  proceed. The next CPU op's kind comes from `cpu.peekNextBusKind()`.
- **AEC low (phi2)** means the VIC owns the address bus: **every** CPU bus phase
  is blocked, write or not. `isAecLowPhi2()` is the canonical "BA low now AND BA
  low 3 cycles ago" formula.
- **REU DMA (`_reuBusHold`)** behaves like AEC low, not like RDY: the processor
  is halted outright, writes included, for every cycle of the transfer. The
  boolean lives on the machine (driven by the device's `busHoldHandler`) so the
  per-cycle test is one monomorphic load.
- `busBlocked = aecLowPhi2 || _reuBusHold`; `cpuBlocked = rdyBlocked ||
  busBlocked`. When blocked, `cpu.clock()` is skipped and **IRQ sampling is not
  refreshed** (interrupts are only recognized when RDY is high, so the CPU
  resumes sampling only when it resumes running).

Between the two bus masters the **VIC wins**: `reu.dmaCycle()` runs only when
`aecLowPhi2` is false, so bad lines and sprite DMA stretch a transfer instead
of overlapping it. The bus trace's `phi2Owner` reports `'vic'`, `'reu'`,
`'cpu'` or `'none'` accordingly.

This is what makes VSP / FLI / sprite-heavy demos cycle-correct: the CPU stalls
exactly the cycles the VIC takes.

---

## 5. Interrupt delay pipeline

Real interrupt latency is a few cycles, and IRQ vs NMI must reach the CPU with
*equal* total latency (the `irqdelay2` testprog). The machine implements a
**per-source staged pipeline** so each source's delay is independent and the net
CPU-visible latency matches the VICE oracle:

| Source | Stages | Notes |
|--------|--------|-------|
| VIC raster IRQ | 1 machine stage | deassertion held one extra cycle (symmetric with the 1-cycle assert latency) so an IRQ raised *and* acked by the same `ASL/INC $D019` RMW is still delivered (the Hat raster-wall case) |
| CIA1 IRQ | 1 machine stage | the in-CIA ICR data→IR latch supplies the other cycle, which is also what makes the 6526 ack bug behave |
| CIA2 / RESTORE / cartridge NMI | 1 machine stage | all sources are wired into one physical-line level before edge detection; NMI is recognised from its immediately-latched `nmiEdge` FF (it skips the IRQ line's `sampledIrq` cycle), so one stage already matches IRQ's net latency |

The chip `irqHandler` callbacks set per-source pending flags
(`_cpuVicIrqPending`, `_cpuCiaIrqPending`, `_nmiSources`); `_sampleCpuInterrupts`
(step 3 above) combines `cpu.setIrqLine(CIA || VIC, late)` and
`cpu.setNmiLine(staged)` each cycle. The CIA2, RESTORE, and cartridge levels
are ORed before edge detection, so asserting a second source while the line is
already active does not create a false NMI. NMI's 0→1 edge is latched **stickily**
(`_cpuNmiEdgeSeen`) so a brief `/NMI` pulse (e.g. a racing `$DD0D` read that
deasserts a cycle later) still reaches the CPU edge FF. `_updateC64Irq`
provides a synchronous force-update that bypasses staging for test/setup paths
(the NMI has no such helper; tests drive `cpu.setNmiLine`/`_cpuNmiEdgeSeen`
directly).

---

## 6. IEC bus & the 1541 drive

The serial bus is modelled as **open-collector wired-AND**. `_syncIecBus()` (a
constructor closure) is the single point of truth:

- Computes each C64 line (ATN/CLK/DATA) from CIA2 port A through the 7406
  inverter model: **DDR direction bits are part of the line state** (a pin
  switched to input floats high → inverter pulls the line low), which
  fastloaders like NOSDOS rely on.
- Wired-ANDs the C64 lines with the drive's `clkOut_pin` / `dataOut`; the bus is
  low if *any* device pulls it low.
- Pushes the resulting bus state back into the drive (`setIecLines`) so it sees
  the reflection, and wakes the drive from idle-skip on any bus change.

`cia2.writePortA` also re-derives the **VIC bank** (`noteBankChange`) on every
port-A write, with the opt-in NMOS DDRA-set delay quirk. `cia2.readPortA`
returns output-register bits for outputs and bus levels for the CLK/DATA input
pins, carefully *not* returning bus levels for output bits, so KERNAL
read-modify-write idioms (`$EE97`) don't accidentally re-pull DATA.

**Drive timing & idle-skip.** A missing 1541 ROM leaves `drive1541 === null`, so
device 8 has no per-cycle drive work. Once attached, drive 8 remains live in both
trap-load and TDE modes: TDE only decides whether `$FFD5` LOAD is intercepted or
left to the real IEC protocol. Enabling TDE first runs the drive forward (up to
3M cycles) until its DOS ROM reaches the idle scheduler, so the first LOAD
doesn't race the boot. The drive clock uses the true PAL 1 MHz / 985248 Hz ratio
by default via a 16.16 accumulator, with an exact 1:1 lockstep switch for
investigations. To save CPU, a safely idle drive is **skipped** (`canIdleSkip` →
`_skipDriveIdleCycle`) and the deferred cycles are settled (`settleIdleCycles`)
when a bus change or timed wake (`_driveIdleWakeInCycles`) arrives. See
the [1541 drive](DRIVE-ARCHITECTURE.md) for the deeper drive mechanics.

---

## 7. SID audio

SID has a **split architecture** because audio runs in a separate AudioWorklet
thread:

- **Writes** (`_sidWrite`) are pushed into a lock-free **`SharedArrayBuffer` ring
  buffer** (`sidShared` / `sidCtrl` / `sidRing32`), tagged with
  `sidCycleCounter`, for the worklet to consume and render at audio rate. (This
  is why the machine requires `SharedArrayBuffer` + COOP/COEP headers.)
- **Shadow voices** (`shadowV1/2/3`, the same `SIDVoice` code the worklet uses)
  are clocked in lockstep on the main thread (step 1 of the master cycle), but
  only the oscillator + envelope, no filter/mixing. Their sole purpose is
  **cycle-exact `$D41B` (OSC3) / `$D41C` (ENV3) readback** for demos that poll
  voice 3 in tight loops (NOISE-waveform RNG, model detection like lft's
  "Lunatico"). The worklet's ~ms latency can't serve these.
- **SID model** (`setSidModel`, 6581 vs 8580) is set on the shadow voices (and
  messaged to the worklet by `main.js`); the combined-waveform/pulse-zero
  difference is exactly how demos detect the chip.
- **POTX/POTY** use the 512-cycle sample-and-hold (step 2), read `$FF` when no
  device on either port reports a position, and `$D419` yields to
  `potXOverride` when a device drives it directly (the NEOS right button).

---

## 8. Loading & program injection

Several entry points get code into the machine:

| Method | What it does |
|--------|--------------|
| `loadROMs({kernal,basic,charRom})` | install system ROMs, `reset()`, mark `ready` |
| `loadPRG(data)` | copy a PRG into RAM and fake the zero-page/CPU state a KERNAL `LOAD",8,1` leaves (BASIC pointers $2D-$32, $AE/$AF, $90, $BA) so demos don't take an error path |
| `loadCartridge(crtBytes)` | parse a `.CRT`, construct its registered hardware device (types 0, 1, 3, 19, 32), attach it to Memory, and cold boot |
| `setD64` / `loadTap` / `attachDrive` | attach disk / tape image / 1541 drive |
| `injectSys` / `injectRun` / `injectLoadAndRun` / `bufferKeyboardText` | stuff the KERNAL keyboard buffer ($0277, count at $C6, max 10 bytes) to auto-type SYS/RUN/LOAD |

**KERNAL load trap** (`_trapLoad`): with TDE *off*, when the CPU reaches the
KERNAL LOAD entry `$FFD5` with device 8, the machine intercepts it. It reads the
file straight from the D64 (`buildDirectoryPRG` for `$`, `loadFile` for a name
or `*` wildcard), writes it into RAM, fixes up the KERNAL end-of-load pointers
and the carry/X/Y return state, then simulates the `RTS`. A deferred
`_pendingAutoRun`
(from `injectLoadAndRun`) types `RUN\r` once the load succeeds. With TDE on, the
trap is disabled and the real drive ROM + IEC protocol do the work.

---

## 9. Reset model

Three layers, mirroring real hardware:

- **`reset()`**: cold boot / power cycle: `mem.reset()` regenerates DRAM with the
  VICE-style power-up pattern, then `_resetChips()`.
- **`softReset({allowSoft:true})`**: a `/RESET` line pulse: `mem.softReset()`
  preserves RAM (real `/RESET` doesn't touch DRAM; the KERNAL boot re-inits
  screen + zero page), applies each cartridge's reset-line behavior (FC3 keeps
  its latch), then `_resetChips()`. The UI reset button uses the full `reset()`.
- **`resetCartridge()`**: asks the attached cartridge device to press its
  physical RESET control, pulses the chip reset path, and preserves DRAM.
  Action Replay and Final Cartridge III expose this capability.
- **`_resetChips()`**: resets CIA1/CIA2/VIC2/SID, clears all interrupt-pipeline
  flags + IEC line caches + joystick bytes, resets the datasette, resets any
  attached drive (a plain `/RESET`, not a boot-to-idle), brings the CPU out of reset (fetches `$FFFC`), and
  pre-copies the char ROM into the Bank-1 `$6800` shadow.

---

## 10. Input & memory map

**Input** is byte-level, active-low: `joyPort1` / `joyPort2` (refreshed per frame
by `input.js` from keyboard/gamepad/mouse), the light-pen node (`_updateLightpen`
combining CIA1 PB4 and joystick-1 fire), and the paddle X/Y feeding the POT
sample-hold.

**Memory map & banking live in `memory.js`**, not here. `_rebuildMemoryMap()`
builds per-page read/write tables from the 6510 port ($01) LORAM/HIRAM/CHAREN
bits + cartridge EXROM/GAME, and routes `$D000-$DFFF` to VIC/SID/CIA/color-RAM
(or the cartridge I/O at `$DE00-$DFFF`). The shared `externalDataBus8` open-bus
latch is updated by both CPU and VIC accesses; that coupling is why the VIC
holds a `mem` back-reference.

---

## 11. Debug facilities

- **Bus trace** (`enableBusTrace(depth)` / `busTraceSnapshot(n)`): a ring of
  per-master-cycle records (raster/cycle, BA/AEC/RDY, CPU op kind, phi2 bus
  owner, external + VIC internal bus latches). Off by default; used by spec
  tests to assert cycle-exact bus ownership.
- **SID trace** (`sidTraceStart` / `sidTraceDump`): capture the next N SID
  register writes with cycle stamps (for diagnosing digi / `$D418` sequences).
- **`snapshot()`**: a JSON-serializable dump of CPU/chip/RAM state (RAM base64-
  encoded) for debugging.

---

## 12. Key invariants & gotchas (quick reference)

- **Phase order in `_runMasterCycle` is load-bearing**: VIC phi1 → CIA phi1 →
  CPU phi2 → VIC phi2. A CPU write this cycle is visible to the VIC/CIA next
  cycle. Don't reorder.
- **Interrupts are applied from the *previous* cycle's pending state**; that lag
  *is* the interrupt delay. Sampling pauses while the CPU is RDY/AEC-blocked.
- **RDY halts reads (and internal/dummy cycles), never writes; AEC-low halts
  everything.**
- **The IEC bus is wired-AND and DDR-direction-aware**: `_syncIecBus()` is the
  only place that computes it; the drive sees the reflected bus, not its own
  output.
- **The load trap only runs with TDE off** at `$FFD5`/device-8; with TDE on the
  real drive handles loading.
- **SID needs `SharedArrayBuffer`** (COOP/COEP): the constructor throws without
  it. Voice-3 readback comes from the main-thread shadow voices, not the worklet.
- **`reset()` wipes RAM (cold boot); `softReset()` preserves it** (/RESET pulse).
- A frame is exactly **19656 cycles**; the TOD clocks tick once per `runFrame()`,
  not per cycle.
