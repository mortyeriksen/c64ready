<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->
<!-- description: The story, connections and specifications of Cartridges, with practical Live Monitor exploration. -->

# Cartridges

A cartridge can make ROM or other hardware visible directly in the C64 address space. Its presence can change what a memory address means.

## The story

A cartridge offers a different route to running a program. Instead of first
sending every byte over tape or disk, it can place ROM directly in the CPU's
address space. The processor can fetch instructions from that ROM where it is
mapped. A cartridge program may still copy data into RAM, but copying is not
required merely to read its ROM.

The expansion connector also lets cartridge hardware take part in memory
selection. Larger cartridges use bank switching to show different parts of
their stored contents through a smaller window. Utility and freezer cartridges
can add RAM, registers and ways to interrupt the running machine. The useful
idea is an attached piece of hardware, not simply another file container.

A CRT image describes the cartridge type as well as its chip data. Correct
behaviour therefore depends on knowing the hardware model, not just loading a
sequence of bytes. The [VICE format specification](https://vice-emu.sourceforge.io/vice_17.html)
documents this distinction.

## How a bank switch changes a program's view

Imagine a cartridge with an 8 KB window beginning at `$8000`:

1. One selected bank supplies the bytes at `$8000–$9FFF`.
2. The program changes a cartridge control register.
3. Another bank supplies bytes at those same addresses.
4. The CPU continues with whichever code and data the mapping now exposes.

The visible address has stayed the same, but the source has changed. To
understand a captured instruction, you need the bytes that were present at the
time. Reading the current bank afterwards may show different code.

Cartridge selection is only part of the picture. CPU banking and the cartridge's
mapping signals determine what is actually visible. Storage's map uses the
CPU-visible source information, while its bank trail shows sampled selections.
Underlying RAM in Memory can contain something different from the cartridge
bytes you inspect in Code.

## Fun fact: a freezer is more than a pause button

Freezer hardware can request an interrupt and expose its own memory so a utility
can take control of the machine. An emulator's Pause simply stops advancement.
Those are different operations, even when both appear to stop the action. The
supported cartridge models and their mapping behaviour are described in the
[cartridge architecture](MEMORY-ARCHITECTURE.md#6-cartridges).

CRT in this part of Monitor means a cartridge image. It has nothing to do with
the cathode-ray tube that originally displayed the C64 picture.

## How it connects

**Cartridge hardware + mapping signals → memory selection → CPU-visible bytes**

| Specification | Meaning |
| --- | --- |
| GAME and EXROM | Signals involved in cartridge memory mapping. |
| 8 KB / 16 KB / Ultimax modes | Different address-space arrangements. |
| Bank selection | Chooses which stored region is exposed. |
| CRT hardware type | Describes behaviour beyond a collection of ROM bytes. |

The [memory model](MEMORY-ARCHITECTURE.md) describes cartridge decoding and the supported banking paths. The [machine model](MACHINE-ARCHITECTURE.md) covers insertion and machine integration.

## Try it in Monitor

1. Open **Storage → CRT** and compare the cartridge's selected mode with its CPU-visible memory window.
2. Choose the play icon to resume the program and watch the sampled bank trail.
3. Click a mapped window to inspect CPU-visible Code there.
4. Compare that with underlying RAM in Memory. Different bytes can be correct because the two views have different sources.

## What the readings can tell you

An inserted or mapped cartridge is not evidence of data being copied. Its ROM can be read in place. The bank trail contains sampled settings, not a history of every switch.


## Continue exploring

Compare [CPU memory banking](COMPONENT-GUIDE-MEMORY.md) with [REU transfers](COMPONENT-GUIDE-REU.md), another use of the expansion connector.

Explore more in [Inside the C64](INSIDE-THE-C64.md), or open the
[Live Monitor guide](GUIDE-MONITOR.md) for controls and workflows.
