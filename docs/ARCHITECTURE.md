<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->

# C64 Emulator Architecture (Master Overview)

A schematic, top-down view of the whole emulator: the components, how they are
wired, the threading model, and the four data flows (video, audio, disk, input).
This is the index document; each subsystem has its own deep-dive:

| Subsystem | Source | Deep-dive |
|-----------|--------|-----------|
| 6510 CPU | `src/cpu.js` | [Deep-dive ▸](CPU-ARCHITECTURE.md) |
| VIC-II video | `src/vic2.js` + `vic2-{tables,line,sprites,render}.js` | [Deep-dive ▸](VIC2-ARCHITECTURE.md) |
| Memory / banking | `src/memory.js` | [Deep-dive ▸](MEMORY-ARCHITECTURE.md) |
| Machine orchestrator | `src/machine.js` | [Deep-dive ▸](MACHINE-ARCHITECTURE.md) |
| 1541 disk drive | `src/drive1541.js` + `gcr.js` + `d64.js` + `6522.js` | [Deep-dive ▸](DRIVE-ARCHITECTURE.md) |
| SID 6581/8580 audio | `src/sid-voice.js` + `src/sid-worklet.js` | [Deep-dive ▸](SID-ARCHITECTURE.md) |
| Datasette (1530 tape) | `src/datasette.js` | [Deep-dive ▸](DATASETTE-ARCHITECTURE.md) |

> Scope: a cycle-accurate **PAL** Commodore 64, running in the browser. The goal
> is demo/fastloader fidelity: cycle-exact CPU↔VIC↔CIA timing, open-bus
> behaviour, and a real 1541 drive, verified against VICE and a large registered
> spec-test suite.

> **New here?** To *use* the emulator rather than read its internals, start with
> the [Getting Started](GETTING-STARTED.md) guide, or see the
> [Features](FEATURES.md) overview for everything it supports.

---

## 1. The whole machine at a glance

```
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ BROWSER MAIN THREAD                                                         │
 │                                                                             │
 │   main.js  ── entry/orchestrator (UI: input/media/dialogs/dom/state/debug)  │
 │     │                                                                       │
 │     │ runFrame()  (once per rAF ≈ 50 Hz)                                    │
 │     ▼                                                                       │
 │   machine.js  ── orchestrator: clocks everything in phase                   │
 │     │                                                                       │
 │     │  per master cycle (×19656/frame):  VIC → CIA → CPU → VIC.phi2 → …     │
 │     ▼                                                                       │
 │   ┌─────────┐   ┌─────────┐   ┌────────┐   ┌────────┐                       │
 │   │  CPU    │   │  VIC-II │   │  CIA1  │   │  CIA2  │                       │
 │   │ (6510)  │   │ (video) │   │ kbd/joy│   │ NMI/   │                       │
 │   │         │   │         │   │ TODs   │   │ IEC/bank│                      │
 │   └────┬────┘   └────┬────┘   └───┬────┘   └───┬────┘                       │
 │        │   address/data bus       │            │                            │
 │        └──────────┬───────────────┴────────────┘                            │
 │                   ▼                                                         │
 │              Memory (memory.js) ── RAM, ROMs, banking, I/O routing, open    │
 │                   │                bus, color RAM, cartridge                │
 │                   │                                                         │
 │     ┌─────────────┼───────────────┬──────────────┐                          │
 │     ▼             ▼               ▼              ▼                          │
 │  SIDProxy     Datasette      Drive1541       (cartridge)                    │
 │     │         (.tap → FLAG)   (1541: 6502 +                                 │
 │     │ ring buffer              2×VIA + DOS ROM)                             │
 │     │ (SharedArrayBuffer)         │ IEC bus (wired-AND)                     │
 │     ▼                             ⇅ CIA2 Port A                             │
 │  ════════════════════════         │                                         │
 └──────────║════════════════════════│═════════════════════════════════════════┘
            ║ SAB ring               │ GCR ← D64
            ▼                        ▼
 ┌────────────────────────┐   ┌──────────────────┐
 │ AUDIO WORKLET THREAD   │   │  D64 / GCR layer │
 │ sid-worklet.js         │   │  (disk image)    │
 │ 3 voices + filter + mix│   └──────────────────┘
 │   → speakers           │
 └────────────────────────┘
```

Two threads only: the **main thread** runs the entire machine + UI; the **audio
worklet thread** does SID synthesis. They communicate through one lock-free
`SharedArrayBuffer` ring (which is why the page needs COOP/COEP headers).

---

## 2. Component reference

### Core chips (cycle-accurate, clocked every master cycle)

| Component | File | Role |
|-----------|------|------|
| **CPU** | `cpu.js` | MOS 6510. Micro-op engine: one bus access per cycle, full official + illegal opcode set, NMOS interrupt quirks. Also drives the 1541's 6502. |
| **VIC-II** | `vic2.js` + `vic2-{tables,line,sprites,render}.js` | MOS 6569 video. One class across five files (core/registers, tables, line & border state machine, sprites, rendering). Cycle-incremental renderer → 384×272 framebuffer; bad lines, sprites, collisions, borders, raster IRQ; steals bus cycles (BA/AEC). |
| **CIA1** | `cia.js` | MOS 6526. Timers A/B, keyboard matrix (Port A col / Port B row), datasette FLAG, **IRQ** source, 50 Hz TOD. (The joystick-port bits are AND-merged into the `$DC00/$DC01` reads by Memory, not `cia.js`; see §4.) |
| **CIA2** | `cia.js` | MOS 6526. Timers A/B, **NMI** source, VIC bank select (Port A bits 0-1), the IEC serial bus port. |
| **Memory** | `memory.js` | Address-space router: RAM, KERNAL/BASIC/CHAR ROMs, per-page banking, `$D000-$DFFF` I/O routing, open-bus latch, color RAM, cartridges. |

### Peripherals & audio

| Component | File | Role |
|-----------|------|------|
| **Drive1541** | `drive1541.js` | Full 1541: a 6502 + two 6522 VIAs + 16 KB DOS ROM + the spindle/GCR read+write engine + stepper + IEC wiring. Writes (SAVE/scratch/format) decode back into the `.d64`. |
| **VIA6522** | `6522.js` | The two VIAs inside the drive (serial bus + mechanics). |
| **GCRDisk / D64** | `gcr.js` / `d64.js` | D64 image parser + on-demand GCR bitstream encoder (VICE-matched layout). |
| **Datasette** | `datasette.js` | C2N tape: plays `.tap` pulses as CIA1 FLAG edges. |
| **SID worklet** | `sid-worklet.js` | 3 voices + filter + mixing in the audio thread; consumes the SAB ring. Two selectable engines (Options ▸ Sound): the reSID model compiled to WASM from `rust/sid/` (default) and the same reSID port in JS (bit-identical, ~6× more CPU). |
| **SID voice** | `sid-voice.js` | One oscillator+envelope; shared by the worklet and the main-thread "shadow" voices that serve cycle-exact `$D41B/$D41C` reads. |
| **drive-sounds** | `drive-sounds.js` | Cosmetic head-step / motor sound effects. |

### Host / UI / loaders (main thread, not part of the cycle loop)

`index.html` loads `main.js`, the entry point. The UI layer is a thin
orchestrator plus focused modules: `main.js`
imports and wires them, injecting the core hooks each needs through `initInput()`
/ `initMedia()` so the feature modules never import each other or `main.js`; the
module graph stays acyclic. Shared, reassigned singletons live in `state.js` as
ES-module live bindings (read directly, written through setters); every DOM
handle lives in `dom.js`.

| Component | File | Role |
|-----------|------|------|
| **main.js** | `main.js` | Entry point / orchestrator: machine lifecycle (power / reset / re-wire), audio init, the rAF frame loop + framebuffer → canvas blit, chip-variant & toggle prefs, the auto-load / boot-warp sequencer, ROM status, clipboard paste, PWA install, and wiring the UI modules below. |
| **dom.js** | `dom.js` | Single inventory of every top-level DOM element reference, imported by the UI modules. |
| **state.js** | `state.js` | Shared runtime singletons (`machine`, `loader`, `sidNode`, `running`, cold-boot gates) as live bindings + setters, so modules share mutable state without importing one another. |
| **input.js** | `input.js` | All user input: control ports (joystick / gamepad / NEOS / mouse / paddle), the on-screen Key Map keyboard, the joy-key redefine dialog, the physical keyboard → CIA1 matrix bridge, and the **app-shortcut registry** that the dispatcher and the KEY MAP dialog's *App shortcuts* section both read. Exports `updateJoyPorts` / `installNeosHook` / `_releaseAllLatched`. |
| **media.js** | `media.js` | Content & peripherals UI: file library, save / load state, PRG / CRT / D64 (drives 8 & 9) / TAP loading, the disk-directory renderer, drag-and-drop, and VICE-format snapshot export. Owns the "what media is inserted" caches. |
| **dialogs.js** | `dialogs.js` | Styled `confirmDialog` / `promptDialog`, replacing the native browser dialogs. |
| **escape-stack.js** | `escape-stack.js` | The single owner of the **Escape** key. Dialogs push a layer on open and pop it on close; Escape closes the topmost one, so priority follows what is on screen rather than module import order. |
| **debug.js** | `debug.js` | DevTools console helpers installed on `window`: `c64Trace` (per-raster + SID-write capture), `c64Vic`, `c64Bus`. |
| **roms.js** | `roms.js` | ROM loading (localStorage cache → bundled → file picker) for KERNAL/BASIC/CHAR/1541. |
| **crt.js** | `crt.js` | `.CRT` cartridge file parser (header + CHIP packets). |
| **cartridges/** | `cartridges/registry.js` + device modules | Hardware-type registry and cartridge-owned ROM/RAM banking, I/O, reset, freeze, and save-state behavior. |
| **control-port.js** | `control-port.js` | DOM-free joystick / NEOS-mouse byte builders (used by `input.js`). |
| **filelibrary.js** / **statelibrary.js** | `filelibrary.js` / `statelibrary.js` | Browser-local (IndexedDB) caches of loaded `.prg/.d64/.crt/.tap/.wav` and of save-states. |
| **pausedemo.js** / **retrovibes.js** | `pausedemo.js` / `retrovibes.js` | Lazy-loaded three.js: the attract-mode animation, and the Retro Vibes 3D model viewer ([deep-dive](RETROVIBES-ARCHITECTURE.md)). The attract demo refuses software WebGL and measures its own frame rate (`frame-rate-guard.js`), handing the powered-off screen back to main.js's static boot hint when a GPU can't keep up. |

---

## 3. The master cycle (timing backbone)

Everything is driven by `machine._runMasterCycle()`, called 19656 times per
frame (312 raster lines × 63 cycles; at the 985248 Hz PAL clock that is a
~19.95 ms frame, ≈50.125 Hz, close to but not exactly 1/50 s). The **phase order
models real hardware's phi1 (VIC/CIA) → phi2 (CPU)
split** and is the single most important correctness invariant in the codebase:

```
   per master cycle:
     1. shadow SID voices clock          (OSC3/ENV3 readback)
     2. POT sample-and-hold (÷512)
     3. apply PREVIOUS cycle's IRQ/NMI    ← the per-source interrupt delay
     4. vic2.clock(1)        [phi1]       ← VIC acts first; sets BA/AEC
     5. cia1/cia2.clock(1)   [phi1]       ← timers count, ICR→IR latch
     6. cpu.clock()          [phi2]       ← unless RDY/AEC blocks it, or load trap
     7. vic2.phi2()                        ← reconcile same-cycle CPU writes
     8. datasette.clock(1)                 ← tape edge → CIA1 FLAG
     9. drive1541.clock(steps)             ← steps=1 or 2 (true PAL ratio), or idle-skip
   ── after 19656 cycles: cia1/cia2.tick50Hz() (TOD), then blit ──
```

Key consequences (detailed in the [machine orchestrator](MACHINE-ARCHITECTURE.md)):
- **A CPU write this cycle is visible to VIC/CIA only next cycle.**
- **Bus stalling**: the VIC's BA/AEC lines stall the CPU on bad lines / sprite
  DMA: `RDY` halts reads (and internal cycles), `AEC` halts everything.
- **Interrupts are applied from the previous cycle's pending state**: that lag
  *is* the modelled IRQ/NMI latency, tuned per source (VIC 1 / CIA1 1 / CIA2-NMI
  1 machine stage) to match the VICE oracle.

---

## 4. The four data flows

### Video  (VIC-II → screen)
```
 RAM / color RAM / char ROM ──► VIC-II g/c/sprite accesses (per cycle)
   ──► cycle-incremental render ──► fb32 (384×272 RGBA framebuffer)
   ──► (end of frame) main.js blits ImageData to <canvas>
```
The VIC renders each cycle's ~8-pixel slice as the beam passes, so mid-line CPU
reads of the collision registers see cycle-accurate state. See
the [VIC-II](VIC2-ARCHITECTURE.md).

#### Rendering pipeline & performance switches

The VIC-II records the machine state it needs **every cycle** (register
snapshots, border flip-flops, fetch state, the correctness foundation), but
pixel emission is **line-batched by default**: a raster line's
paints are deferred and replayed in one burst at line end, coalescing runs of
unchanged cycles into wide segments through the same segment renderer. Any
mid-line event the CPU could observe (collision-register reads, arming
collision IRQs, fetch-config changes, a write into the RAM the line fetches
graphics from) triggers an immediate catch-up replay, so the result is
byte-identical to per-cycle rendering at every CPU-observable point (verified
by a lockstep equivalence suite, framebuffer hashes, 195 reference screenshots
and the demo status board; measured ~15% faster on sprite-heavy and ~26% on
graphics-heavy demos). The finished framebuffer reaches the canvas through a
WebGL presenter (one texture upload + one triangle per displayed frame, with an
automatic 2D `putImageData` fallback).

Both paths are switchable at runtime for A/B or triage via `src/switches.js`:
append `?LINE_BATCH=0` (per-cycle rendering) or `?WEBGL_PRESENTER=0` (2D
presenter) to the URL, or set the same names as env vars in node harnesses.
Details in the [VIC-II](VIC2-ARCHITECTURE.md) §14.

### Audio  (CPU → SID → speakers): crosses the thread boundary
```
 CPU writes $D400-$D41C ──► Memory ──► SIDProxy.write ──► machine._sidWrite
   ──► SharedArrayBuffer ring (cycle-stamped)   ──► [worklet thread]
   ──► sid-worklet: 3 voices + filter + mix     ──► AudioContext → speakers
                          └─► main-thread shadow voices serve $D41B/$D41C reads
```
The shadow voices duplicate just the oscillator+envelope on the main thread so
cycle-exact voice-3 readback (RNG loops, model detection) works without the
worklet's millisecond latency. Full sound-generation detail (waveforms, combined
waveforms, filter, ADSR, DAC, 6581-vs-8580 differences) is in
the [SID](SID-ARCHITECTURE.md); the thread/ring plumbing is in
the [machine orchestrator](MACHINE-ARCHITECTURE.md) §7.

### Disk  (D64 → drive → C64)
```
 D64 sectors ──► GCRDisk: 4-to-5 GCR bitstream (per track, VICE layout)
   ──► drive spindle shifts bits at the speed-zone rate
   ──► SYNC detect → byte framing → byte-ready (VIA2 CA1 / SO pin)
   ──► drive 6502 runs DOS ROM, decodes GCR, bit-bangs IEC
   ──► IEC bus (wired-AND in machine._syncIecBus) ⇄ C64 CIA2 Port A
```
Two modes: a fast **KERNAL load trap** ($FFD5, reads the D64 directly) or full
**True Drive Emulation** (the real hardware path, required for fastloaders). See
the [1541 drive](DRIVE-ARCHITECTURE.md).

### Input  (keyboard / joystick / paddle)
```
 DOM key / gamepad / mouse events (input.js)
   ──► CIA1 keyboard matrix  (Port A col select → Port B row read)
   ──► joyPort1/joyPort2 bytes  ANDed into CIA1 $DC01/$DC00 by Memory
   ──► paddle X/Y → SID POTX/POTY (512-cycle sample-and-hold)
   ──► CIA1 PB4 / joystick-1 fire → VIC light-pen pin
```

---

## 5. Memory map & banking (the bus)

The CPU's view of `$0000-$FFFF` is bank-switched by the 6510 port (`$01`) and the
cartridge lines. `Memory` precomputes a 256-entry per-page dispatch table so each
access is a single typed-array load; only I/O and the CPU port take a slow path.

```
  $0000-$0001  6510 I/O port (DDR / data)          ← banking control + datasette
  $0002-$9FFF  RAM
  $8000-$9FFF  cartridge ROML        (when present)
  $A000-$BFFF  BASIC ROM / RAM / cartridge ROMH
  $C000-$CFFF  RAM
  $D000-$DFFF  I/O  ┬ $D000 VIC-II   ($D000-$D3FF)   ← or CHAR ROM (CHAREN=0)
                    ├ $D400 SID       ($D400-$D7FF)
                    ├ $D800 color RAM ($D800-$DBFF, 4-bit + open-bus nibble)
                    ├ $DC00 CIA1      ($DC00-$DCFF)
                    ├ $DD00 CIA2      ($DD00-$DDFF)
                    └ $DE00 cartridge I/O ($DE00-$DFFF)
  $E000-$FFFF  KERNAL ROM / RAM / cartridge ROMH
```
A shared `externalDataBus8` latch, driven by both CPU and VIC accesses, models
open-bus reads (e.g. the color-RAM upper nibble, empty `$DE00`). See
the [memory & banking](MEMORY-ARCHITECTURE.md).

In Ultimax mode the VIC's own local `$3000-$3FFF` window reads the upper 4 KB
of cartridge ROMH in every CIA-selected VIC bank. This PLA path is separate
from the CPU's `$E000-$FFFF` ROMH mapping and is used directly by freezer
cartridges including Action Replay and Final Cartridge III.

---

## 6. Interrupt topology

```
  VIC raster/collision/lightpen ─► irqHandler ─┐
  CIA1 timers/FLAG ─────────────► irqHandler ─┼─► (per-source delay pipeline)
                                                │      ─► CPU IRQ pin  (maskable, I flag)
  CIA2 timers ──────────────────► irqHandler ──────► CPU NMI pin  (edge, non-maskable)
```
The machine stages each source independently so net latency is uniform; the CPU
then applies the NMOS recognition rules (I-flag shadow, branch-delay, the
acknowledge race). Details split across the
[machine orchestrator](MACHINE-ARCHITECTURE.md) §5 and the
[6510 CPU](CPU-ARCHITECTURE.md) §6.

---

## 7. Reset & startup

```
  main.js: load ROMs (cache→bundled→picker)
     └─► machine.loadROMs() ─► reset()
            ├─ mem.reset()        seed DRAM with VICE XOR pattern (cold boot)
            └─ _resetChips()      CIA/VIC/SID reset, CPU fetches $FFFC vector,
                                  reset drive + datasette, sync IEC bus
```
`reset()` is a cold power cycle (RAM regenerated); `softReset()` is a `/RESET`
pulse (RAM preserved). Program entry points: PRG injection (fakes the KERNAL
post-LOAD state), disk auto-LOAD, cartridge, or tape.

---

## 8. Fidelity strategy

Why the timing is this fussy, and how it is kept honest:

- **Cycle-exact, phi-aware ordering** is the foundation; demos rely on
  CPU↔VIC↔CIA interactions resolving on the right half-cycle.
- **Open-bus modelling** via the shared data-bus latch; torture-class programs
  read floating-bus values.
- **A real 1541** (not just a load trap): fastloaders bit-bang the IEC bus and
  count cycles.
- **Chip-variant toggles**: VIC 6569 / 8565, SID 6581 / 8580, because
  demos detect the chip and branch.
- **VICE as the oracle**: behaviour is cross-checked against VICE and pinned by a
  large registered spec-test suite (`test/*-test.js`, run via `npm test`); most
  reference demos are byte-identical frame-for-frame. Risky/unmodelled edge cases
  are documented rather than force-fixed (see [Known Issues](KNOWN-ISSUES.md)).

---

## 9. Where to look

- Adding/altering an **opcode or interrupt timing** → `cpu.js` +
  [6510 CPU](CPU-ARCHITECTURE.md).
- A **rendering / sprite / raster** bug → `vic2.js` and its siblings
  (`vic2-line/-sprites/-render.js`) + [VIC-II](VIC2-ARCHITECTURE.md).
- **Banking / open bus / cartridge** → `memory.js` +
  [memory & banking](MEMORY-ARCHITECTURE.md).
- **Cycle ordering, IRQ delay, IEC wiring, loading** → `machine.js` +
  [machine orchestrator](MACHINE-ARCHITECTURE.md).
- **Disk / fastloader / GCR** → `drive1541.js` & friends +
  [1541 drive](DRIVE-ARCHITECTURE.md).
- **Frame loop / audio init / machine lifecycle / prefs / PWA** → `main.js`;
  **keyboard / joystick / gamepad / mouse** → `input.js`; **file & state loading,
  snapshots, disk directory** → `media.js`; **confirm/prompt dialogs** →
  `dialogs.js`; **DOM refs** → `dom.js`; **shared runtime state** → `state.js`;
  **console debug tools** → `debug.js`.
- **CIA timers / keyboard / TOD** → `cia.js`. **SID synthesis** → `sid-worklet.js`
  / `sid-voice.js`. **Tape** → `datasette.js`.
```
