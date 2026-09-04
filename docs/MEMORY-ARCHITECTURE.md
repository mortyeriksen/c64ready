<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->

# Memory (`src/memory.js`): Architecture Overview

A high-level map of the C64's bank-switched memory subsystem: the per-page
dispatch tables that make reads/writes fast, the 6510 CPU port and PLA banking,
the four access functions (read/write/peek/peekForCpu), the `$D000-$DFFF` I/O
routing, color RAM, the shared open-bus latch, cartridges, and the reset model.

This document describes *the implementation* and points at the real method and
field names so it can be used as a guide into `memory.js`. `Memory`
is the address-space router: it owns C64 RAM and color RAM, caches the active
mapping supplied by an attached cartridge device, and decides, for every
address, whether an access hits RAM, a ROM, an I/O chip, color RAM, a
cartridge, or the open bus. The I/O chips and cartridge-specific state machines
live elsewhere; Memory just dispatches to them. See
the [machine orchestrator](MACHINE-ARCHITECTURE.md) for how Memory is wired into the system.

---

## 1. Big picture

Every CPU memory access goes through `read(addr)` / `write(addr, val)`. The C64's
banking (which of RAM / KERNAL / BASIC / CHAR-ROM / I/O / cartridge is visible at
a given address) changes at runtime via the 6510 CPU port (`$01`) and the
cartridge EXROM/GAME lines. Rather than re-decode the banking on every access,
Memory precomputes a **256-entry per-page dispatch table** and rebuilds it only
when banking state changes.

```
   CPU / VIC
      │ read(addr) / write(addr)
      ▼
   page = addr >> 8
      │
      ├─ _readPageArr[page] != null ?
      │     yes → typed-array load:  arr[addr - _readPageOffset[page]]   (FAST)
      │     no  → _readSlow(addr) → _readIO(addr)  → VIC/SID/CIA/colorRAM/cart   (SLOW)
      │
      └─ every access updates externalDataBus8  (the shared open-bus latch)
```

The common case (RAM, KERNAL, BASIC, CHAR-ROM, cartridge ROM, ultimax open-bus)
resolves to a **single typed-array indexed load**. Only I/O (`$D000-$DFFF` when
gated on) and the CPU port (`$00`/`$01`) take the slow path.

---

## 2. The per-page dispatch table

Four parallel arrays, indexed by page (`addr >> 8`, 0-255):

| Array | Meaning |
|-------|---------|
| `_readPageArr[page]` | the `Uint8Array` to read from, or `null` ⇒ slow path |
| `_readPageOffset[page]` | value subtracted from `addr` to index that array |
| `_writePageArr[page]` / `_writePageOffset[page]` | same, for writes (`null` ⇒ slow / dropped) |

So `read` is `arr[addr - offset]` and `write` is `arr[addr - offset] = val`. The
offset trick lets a page point into RAM (offset 0), KERNAL (offset `$E000`),
char-ROM (offset `$D000`), etc., all through one indexed load.

A reusable **`_openBus`** scratch buffer (256 bytes of `$FF`) serves ultimax
open-bus pages: each such page sets `offset = page << 8` so `arr[addr - offset]`
always lands at `_openBus[addr & 0xFF]`.

`_rebuildMemoryMap()` fills these tables from the current CPU port + cartridge
state. It is cheap (256 iterations) and fires only on **state changes**: a CPU
port write, a cartridge swap, or a ROM assignment (the `kernal`/`basic`/`charRom`
property setters call it), never per CPU cycle.

---

## 3. The 6510 CPU port ($00 / $01) & banking

Addresses `$00`/`$01` are the 6510's on-chip I/O port, **not** RAM, so they are
special-cased at the top of `read`/`write` before the table dispatch:

- **`$00` = DDR**, **`$01` = data latch**. Power-up is `DDR=$00` / latch=`$00`.
- **Reads return pins, not the latch**: output bits (DDR=1) read the latch; input
  bits (DDR=0) read the pin. Bits 0,1,2 (LORAM/HIRAM/CHAREN) have pull-ups → 1,
  and bit 4 is the **cassette sense** input (from the datasette). So a raw
  power-up `DDR=$00` reads back as `$17`, which still selects KERNAL+BASIC+I/O,
  so the `$FFFC` reset vector is reachable before the KERNAL writes `$2F`/`$37`.
- **Writes store all 8 bits in the latch regardless of DDR** (DDR only gates
  whether a bit *drives* its pin, applied at read time). The KERNAL relies on
  this: it writes `$01` before raising DDR to `$2F`.
- **Datasette MOTOR** (bit 5, output) is driven from the latch on write; the
  cassette **SENSE** (bit 4, input) feeds the `$01` read.
- A 6510-specific open-bus quirk (gated by `openBusWritesToZeroOneEnabled`): a
  write to `$00`/`$01` keeps the CPU's data drivers tri-stated, so the byte the
  VIC drove during phi1 can land in the underlying RAM. Off by default.

**Banking** (`_rebuildMemoryMap`) reads the port **pins** (`(cpuPort & cpuDDR) |
(0x07 & ~cpuDDR)`) to extract LORAM/HIRAM/CHAREN, then maps each page per the PLA
truth table:

| Region | Visible when |
|--------|--------------|
| KERNAL ROM (`$E000-$FFFF`) | HIRAM |
| BASIC ROM (`$A000-$BFFF`) | LORAM && HIRAM |
| CHAR ROM (`$D000-$DFFF`) | !CHAREN (and CHAREN ⇒ I/O instead) |
| I/O (`$D000-$DFFF`) | (LORAM \|\| HIRAM) && CHAREN |
| RAM | otherwise |

ROM is a **read shadow**: a page mapped to ROM still takes writes into the RAM
underneath (ultimax ROM pages drop them instead). Cartridge modes
(8k/16k/ultimax) override the table above; see §6.

---

## 4. The access functions

| Function | Side effects? | Drives bus latch? | Used by |
|----------|---------------|-------------------|---------|
| `read(addr)` | **yes** (device reads clear flags / advance state) | yes | normal CPU reads |
| `write(addr, val)` | yes | yes (except `$00`/`$01`) | normal CPU writes |
| `dmaRead(addr)` / `dmaWrite(addr, val)` | yes | yes | an external bus master (the REU); identical to `read`/`write` except the 6510 port at `$00`/`$01` does not answer |
| `peek(addr)` | **no**, never pokes a device; returns the bus latch for I/O pages | no | VIC sampling the byte a BA-stalled CPU drives (Bauer §3.14.6 invalid c-reads) |
| `peekForCpu(addr)` | **no** read side effects, but returns the value an I/O **register** read would place on the bus (`_peekIO`) | no | CPU opcode predecode (`peek(pc)`), so decoding doesn't ack a CIA ICR etc. |

The split matters: the CPU decodes the next opcode with `peekForCpu` so the
predecode doesn't trigger a real I/O side effect, then the cycle-1 micro-op does
the actual `read()`.

The DMA pair matters for a different reason. The `$00`/`$01` decode lives
*inside* the 6510, which is tri-stated while another master drives the bus, so
the DRAM underneath answers instead. Without that, a 64 KB fetch covering all of
RAM would write the banking latch partway through and re-bank itself mid-flight.
Banking, ROM and I/O visibility are otherwise identical to a CPU access, which
is what makes the `$FF00` trigger (§6) useful.

---

## 5. I/O region routing (`$D000-$DFFF`)

When the page table maps a `$Dx` page to the slow path (`null`), `_readSlow` /
`_writeSlow` route to `_readIO` / `_writeIO`:

| Range | Device |
|-------|--------|
| `$D000-$D3FF` | VIC-II (`addr & 0x3F`) |
| `$D400-$D7FF` | SID (`addr & 0x1F`) |
| `$D800-$DBFF` | Color RAM (low nibble; see §7) |
| `$DC00-$DCFF` | CIA1 (`addr & 0x0F`); joystick ports ANDed in (§8) |
| `$DD00-$DDFF` | CIA2 (`addr & 0x0F`) |
| `$DF00-$DF0A` | attached RAM Expansion, mirrored every 32 bytes to `$DFEA`; consulted **before** the cartridge |
| `$DE00-$DFFF` | attached cartridge device's `ioRead` / `ioWrite` / `ioPeek`, or open bus |

A missing device returns `_openBusRead()`. `_peekIO` mirrors `_readIO` without
side effects.

The expansion and the cartridge occupy separate slots (`reu` and `cartridge`),
so both can be attached at once; on real hardware that combination needs a
port expander. The expansion answers only its eleven registers and hands
everything else to the cartridge, which is conflict-free except for the three
cartridge types that use IO2 themselves (see KNOWN-ISSUES). The expansion
touches Memory at three points in all: this `$DF00` register window, the
`dmaRead`/`dmaWrite` access pair (§4), and the `$FF00` trigger snoop (§6).

---

## 6. Cartridges

`cartridges/registry.js` maps CRT hardware-type numbers to device classes.
`C64Machine.loadCartridge()` parses the container, creates the device, and calls
`Memory.installCartridge(device)`. Tests and older callers may use
`setCartridge(cfg)`, which constructs the same devices through a compatibility
factory.

Every device owns its ROM/RAM arrays, registers, I/O decoding, serialization,
and reset/freeze lifecycle. It publishes only a small mapping cache:
`mode`, active `romLo`/`romHi`, optional writable ROML target, and an optional
exceptional ROML read hook. `applyMapping()` copies these stable values into
Memory and rebuilds the page table. Normal reads therefore retain the direct
typed-array hot path; only I/O and exceptional electrical behavior call the
device.

Registered devices:

- **Generic** (type 0): fixed 8K, 16K, or Ultimax mapping.
- **Action Replay v4.x/v5/v6** (type 1): four 8 KB ROM banks, 8 KB RAM,
  IO1/IO2 control, cartridge kill, and latched RESET/FREEZE/NMI behavior.
- **Final Cartridge III** (type 3): four 16 KB banks, IO1/IO2 ROM mirror,
  `$DFFF` latch, and RESET/FREEZE/NMI behavior.
- **Magic Desk** (type 19): 64 possible 8 KB banks and mirrored IO1 control.
- **EasyFlash** (type 32): 64 ROML/ROMH banks, bank/control registers, and
  its 256-byte IO2 RAM.

Per-device electrical exceptions (Action Replay's IO1 bus-byte clocking and its
`$22` ROML read hook among them) live with the devices in `src/cartridges/*`.
ROM regions follow the read-shadow rule (§3); a device can explicitly publish a
writable ROML target for cartridge RAM.

### The RAM Expansion's `$FF00` snoop

The REU's deferred trigger has to notice a CPU write to `$FF00`, the mechanism
that lets software bank I/O out and *then* start a transfer, so the DMA reaches
the RAM underneath `$D000-$DFFF`. Watching for it on `write()`'s fast path would
tax every store in the machine, so the watch rides the page table instead:
while a transfer is armed, `_rebuildMemoryMap()` forces page `$FF`'s write entry
to `null` and parks the page's real write target in `_ff00WriteArr/_ff00WriteOff`.
`_writeSlow` then performs the store as it would have and calls
`reu.ff00Triggered()`. Arming and disarming each cost one table rebuild, and the
write fast path is untouched whenever no transfer is waiting.

---

## 7. Color RAM

Color RAM (`$D800-$DBFF`, 1 KB) is only **4 bits wide**; the upper nibble is
open bus. On read, `_readIO` composes `(externalDataBus8 & 0xF0) | (colorRam &
0x0F)` (the upper nibble is typically the byte the VIC fetched in phi1 of this
cycle), and, if `colorRamReadDrivesComposedByte`, re-drives the latch with that
composed value. Writes store only the low nibble. This is byte-faithful to how
demos read color RAM during open side borders.

---

## 8. Open bus & the shared data-bus latch

`externalDataBus8` models the C64 data bus (D0-D7) when no device is actively
driving it. It is updated by **every CPU read, every CPU write** (in `read`/
`write`), **and every VIC chip-bus fetch** (the VIC holds a `mem` back-reference
so its g-/c-/sprite-accesses re-drive the latch). An **open-bus read**
(`$DE00-$DFFF` with no cart device, or the high nibble of color RAM) samples this
latch instead of returning a fixed value. `_openBusRead` has three modes
(`openBusMode`):

- **`vice-compatible`** (default): return the latch (matches VICE / real
  hardware, Bauer §3.12 + VIC-Addendum).
- **`disabled`**: return `$FF` (simplified model, for bisecting).
- **`random`**: fuzz byte (to catch code assuming a fixed value).

The CIA1 joystick integration also lives here: `_readCIA1` ANDs `joyPort2` into
`$DC00` and `joyPort1` into `$DC01` (both ports also carry the keyboard matrix,
so joystick bits AND in).

---

## 9. Reset model

Two layers, matching the hardware:

- **`reset()`**: cold boot / power-up. Seeds DRAM with **VICE's characteristic
  init pattern** (`mem[addr] = $FF iff ((addr>>1) ^ (addr>>2)) & 1`) and color
  RAM with the 4-bit version; demos that read uninitialized RAM (e.g.
  OrbitUntold's depacker reading it as back-references) depend on this exact
  pattern. Then calls `softReset()`.
- **`softReset()`**: a `/RESET` line pulse. Resets the CPU port to its power-up
  default and the cartridge registers (EasyFlash: bank 0, ultimax, RAM cleared;
  Magic Desk and Action Replay: bank 0, 8k; FC3 latch and generic mapping
  preserved), then **rebuilds the dispatch table** so the CPU's first read after
  reset, the `$FFFC` vector, lands in KERNAL ROM. DRAM is **not** touched: real
  `/RESET` doesn't either, and the KERNAL boot does its own RAM init.

`loadROM(data, baseAddr)` is a simple bulk copy into RAM (used for raw ROM loads).

---

## 10. Profile flags (bisection knobs)

Defaults preserve current demo behaviour; each can be toggled at runtime to A/B a
regression:

| Flag | Default | Effect |
|------|---------|--------|
| `openBusMode` | `'vice-compatible'` | open-bus read source (latch / `$FF` / random) |
| `colorRamReadDrivesComposedByte` | `true` | a color-RAM read re-drives the latch with the composed byte |
| `openBusWritesToZeroOneEnabled` | `false` | the 6510 RAM-under-port quirk (VIC phi1 byte lands in RAM[$00/$01]) |

---

## 11. Key invariants & gotchas (quick reference)

- **The page table is the hot path; rebuild only on state change.** Banking is
  never re-decoded per access; `_rebuildMemoryMap` fires on CPU-port writes,
  cartridge swaps, and ROM assignment.
- **Banking reads port *pins*, not the latch**: input bits float to their
  pull-ups, which is why power-up `DDR=$00` still boots into KERNAL.
- **`$00`/`$01` are the CPU port, not RAM**: special-cased before the table;
  reads return pins (incl. cassette sense), writes latch all 8 bits.
- **`peek` vs `peekForCpu` vs `read`**: only `read` has device side effects and
  drives the bus; predecode/VIC-sampling use the peeks to avoid acking I/O.
- **ROM is a read shadow** (§3): writes fall through to the underlying RAM
  (except ultimax, which drops them).
- **Color RAM is 4-bit**; the upper nibble is open bus (the VIC phi1 byte).
- **`externalDataBus8` is shared with the VIC**: VIC fetches drive it too, which
  is how open-bus reads and the color-RAM upper nibble stay byte-faithful.
- **`reset()` seeds DRAM with the VICE XOR pattern; `softReset()` preserves RAM.**
- The memory map is the source of truth for **what is visible**; see
  the [machine orchestrator](MACHINE-ARCHITECTURE.md) for **who drives the bus when** (phi1/phi2).
