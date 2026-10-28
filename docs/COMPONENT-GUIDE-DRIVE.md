<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->
<!-- description: The story, connections and specifications of The 1541 disk drive, with practical Live Monitor exploration. -->

# The 1541 disk drive

The disk drive is a computer beside the computer. It can run its own program while the C64 waits for data or keeps an effect playing.

## The story

Commodore put a processor, working memory and disk operating system inside the
1541. The C64 sends commands over a serial connection, while the drive does the
mechanical and data-handling work. Its operating system is in the drive's ROM,
not a program that must occupy the C64's RAM before every disk operation.

The programmable drive opens another possibility. A loader can place code in
the drive and run a cooperating routine on the C64. The two machines can then
use a transfer method tailored to the program. Commodore's
[1541 User's Guide](https://retro-bobbel.de/zimmers/cbm/manuals/drives/1541_Users_Guide.pdf)
actually documents commands for writing and executing drive memory.

For a demo, loading and presentation become a coordination problem. Disk work,
serial communication, decompression, music and graphics must fit together.
Seeing the drive beside the C64 in Monitor is a reminder that a loader can
involve two programs and two memories, not just a file slowly appearing in RAM.

## Follow a disk read

A file read passes through several layers:

1. The head moves to a track, while the disk rotates beneath it.
2. The read electronics recover an encoded stream from the magnetic surface.
3. Drive-side code interprets that stream and finds the required data.
4. The serial protocol carries data to the C64.
5. The receiving program decides where to store it and whether to unpack it.

The physical encoding is called Group Coded Recording, or GCR. A media-byte rate counts activity at a
different layer from useful program bytes arriving in C64 RAM. Reading framing,
waiting for the desired sector to rotate past, or rereading a track can all
produce behaviour that a simple progress percentage would hide.

In **true drive** mode, Monitor shows sampled head positions and the drive CPU's
program counter. In **accelerated** mode, the file/channel rate is more useful
than a mechanical story. These are different execution paths, so their rates
should not be treated as measurements of exactly the same stream.

## Fun fact: the drive has a tiny workshop of its own

The 1541's 2 KB of RAM is just one thirty-second of the C64's 64 KB. Yet code can
run there. The manual's programming chapter includes `MEMORY-WRITE` and
`MEMORY-EXECUTE`, making the drive's ability to run uploaded routines an exposed
feature, rather than something added by an emulator.

## How it connects

**Disk surface ↔ drive processor and memory ↔ serial bus ↔ C64**

| Specification | Meaning |
| --- | --- |
| 6502 processor | Runs drive-side code. |
| 2 KB RAM | Working memory inside the drive. |
| 16 KB ROM | Contains the drive's operating system. |
| Two 6522 VIA chips | Connect processor, disk mechanism and bus. |
| Serial interface | Carries communication between C64 and peripherals. |

The [drive model](DRIVE-ARCHITECTURE.md) explains the emulator's disk mechanism, serial bus and execution paths.

## Try it in Monitor

1. Open **Storage** while a disk program is loading and select **Drive 8** or **Drive 9**.
2. Choose the play icon to continue loading. In true drive mode, compare the head-position trail with the drive CPU address, motor and LED readings.
3. In accelerated mode, follow the file/channel rate instead of expecting a mechanical trace.
4. Compare those observations with Memory changes, without assuming they identify a particular file or destination.

## What the readings can tell you

A motor or indicator sample is evidence of that signal. It does not prove a particular sector was read, identify the destination in RAM or measure loading progress.

Accelerated loading can bypass a cycle-level motor timeline. Monitor labels that mode rather than inventing mechanical activity.

## Continue exploring

Follow the serial connection through [CIA2](COMPONENT-GUIDE-CIA.md), then examine where received bytes land in [memory](COMPONENT-GUIDE-MEMORY.md).

Explore more in [Inside the C64](INSIDE-THE-C64.md), or open the
[Live Monitor guide](GUIDE-MONITOR.md) for controls and workflows.
