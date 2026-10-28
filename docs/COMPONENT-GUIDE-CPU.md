<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->
<!-- description: The story, connections and specifications of The 6510 CPU, with practical Live Monitor exploration. -->

# The 6510 CPU

The CPU follows the program's instructions. A store instruction can change memory or a chip register, turning code into something visible or audible.

## The story

The C64's main processor comes from the 6502 family, which puts a small set of
registers and instructions at the centre of the machine. The 6510 adds an I/O
port of its own. That port helps choose the memory map and operates some of the
tape signals. Even the processor has a second job beyond executing instructions.

The CPU does not need to manufacture every pixel or sound sample. It prepares
memory and gives the VIC-II and SID their settings, then those chips continue
working. A game can update a sprite position, run its game logic and leave the
video hardware to draw the sprite again on the next frame.

This division of work makes timing part of programming. The CPU shares memory
access with the video chip, and an REU transfer can hold it off the bus too.
A routine that fits comfortably into one part of the picture may have less
execution time available in another. The [CPU model](CPU-ARCHITECTURE.md)
explains those interactions in this emulator.

## From an instruction to a visible change

Imagine a program changing the border colour:

1. It loads a colour number into the accumulator, the CPU's main working register.
2. A store instruction sends that byte to the VIC-II border register at `$D020`.
3. The VIC-II uses the setting as it continues drawing the picture.
4. A later store can change the colour again, producing a timed colour band.

In assembly, the first two operations might appear as `LDA #$06` and
`STA $D020`. In plain language: take colour number six, then give it to the
border control. The register write is the connection between the program and
the picture. A frame capture lets you inspect that connection without having
to understand the whole program at once.

An interrupt is another useful connection. Instead of constantly checking a
clock or raster position, a program can arrange for hardware to request its
attention. The CPU then enters an interrupt routine when the request is accepted.
The request, its acceptance and the handler's work are separate events.

## Fun fact: a processor that operates the tape motor

The 6510's built-in port means an ordinary write can help switch ROM visibility
or control the Datasette motor. The computer's first two addresses therefore
have hardware jobs rather than behaving like ordinary CPU RAM. See the
[6510 port and banking explanation](MEMORY-ARCHITECTURE.md).

## How it connects

**Memory → CPU instructions → memory and chip registers**

The video chip shares access to memory. Time unavailable to the CPU matters when a program tries to change the picture at a particular raster position.

| Specification | Meaning |
| --- | --- |
| 8-bit data | An ordinary transfer moves one byte. |
| 16-bit addresses | The CPU addresses 65,536 locations. |
| A, X and Y | Registers used for arithmetic, data and indexing. |
| Program counter | Address of the next byte to fetch in the instruction stream. |

See the [CPU model](CPU-ARCHITECTURE.md) for instruction execution, interrupts and bus ownership in this emulator.

## Try it in Monitor

1. Watch the Code card's plain-language instruction and sampled address trail. The opcode and its start address appear underneath.
2. Choose **Inspect Code** to capture and pause. Explore the shared recording without the program moving on.
3. Follow an explained register write to its assembly instruction.

## What the readings can tell you

**IRQ request** shows the line at the latest sample. **IRQ allowed** shows that
the CPU I flag is clear. Neither indicator proves that an interrupt handler ran,
and short requests can occur between samples.

A repeated location may be a useful loop or a wait loop. The Live trace cannot distinguish them. A captured cycle budget measures recorded bus availability, including cycles spent waiting in software. It is not a percentage of useful work.

## Continue exploring

Follow a register write into [Video](COMPONENT-GUIDE-VIC.md), or trace an input or timer request through [CIA and controls](COMPONENT-GUIDE-CIA.md).

Explore more in [Inside the C64](INSIDE-THE-C64.md), or open the
[Live Monitor guide](GUIDE-MONITOR.md) for controls and workflows.
