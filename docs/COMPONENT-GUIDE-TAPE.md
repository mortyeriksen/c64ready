<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->
<!-- description: The story, connections and specifications of The Datasette, with practical Live Monitor exploration. -->

# The Datasette

Tape stores programs as timed signals on a cassette. Loading involves both transport controls and decoding a sequence of pulses.

## The story

A cassette keeps data in a physical sequence. To reach something later, the
transport has to move the tape past the head. Position, winding and recognizing
the start of a recording are therefore part of using the medium, rather than
background details hidden behind a filename.

Commodore's Datasette connects the cassette mechanism to computer-oriented read,
write, sense and motor signals. The
[1530 User's Manual](https://retro-bobbel.de/zimmers/cbm/manuals/drives/1530_Datasette_Users_Manual.pdf)
introduces the controls and loading workflow. Inside the C64, software still
has to interpret the timing of the arriving pulses.

That leaves room for different recording schemes. A custom loader can use a
different way to recognize pulses, synchronize with a block or represent data.
The same cassette transport can therefore serve several kinds of software
loader. The pulse scope makes this underlying timing visible without assuming
that every program uses the same encoding.

## Follow the timing into the program

The useful information is the interval between pulse events:

1. Movement past the tape head produces a read signal.
2. The C64 receives those events through CIA1's FLAG input.
3. The loader measures timing and applies its decoding rules.
4. Decoded bytes are checked, stored or passed to another loading stage.

A repeated pattern of similar pulse lengths might be a synchronization region.
A varied pattern might contain encoded data. The waveform alone is not enough
to name a file or assign a bit value, because the interpretation belongs to the
loader. The [Datasette model](DATASETTE-ARCHITECTURE.md) follows the signal into
the machine's timing and recording paths.

TAP images preserve pulse lengths. For ordinary full-wave TAP entries, the scope
draws a representative square-wave shape from that duration. The width is useful
evidence, but the drawn duty cycle is not an oscilloscope measurement of a real
electrical pin. Recording uses the pulse data being written. See the
[VICE TAP specification](https://vice-emu.sourceforge.io/vice_17.html).

## Fun fact: PLAY can stay down while the tape stops

The transport key and the computer-controlled motor are separate. A program can
stop the motor while PLAY is still engaged. That is why Monitor shows both
states, and why a stationary tape need not mean that someone pressed STOP.
The motor, sense and read connections are described in the
[Datasette signal path](DATASETTE-ARCHITECTURE.md#1-signal-path).

## How it connects

**Tape pulses → read signal → CIA event → loader program**

| Signal or control | Meaning |
| --- | --- |
| Motor | Whether the transport is driven. |
| Sense | Reports the transport key state to the C64. |
| Read pulses | Carry the recorded data's timing. |
| Write signal | Supplies pulses while recording. |

The [Datasette model](DATASETTE-ARCHITECTURE.md) explains pulse playback, recording and the connection to machine timing.

## Try it in Monitor

1. Open **Storage → Tape** while a tape loader is running.
2. Compare the transport key, motor state and tape position with the pulse scope.
3. Use **Zoom ×2** to look at a shorter timing window. The scope shows pulse counts and timing ranges, without selecting individual pulses.
4. Pause to keep the displayed window, then compare the loader's Code and Controls evidence.

## What the readings can tell you

Tape percentage describes position in the available tape stream. It is not a promise that a particular program is that far through loading. A stream can contain pauses, several files or a loader that interprets data differently.

The Monitor observes transport state without moving the tape to another position.

## Continue exploring

Explore [CIA timing](COMPONENT-GUIDE-CIA.md) and the [CPU](COMPONENT-GUIDE-CPU.md) to connect pulse events with the loader that interprets them.

Explore more in [Inside the C64](INSIDE-THE-C64.md), or open the
[Live Monitor guide](GUIDE-MONITOR.md) for controls and workflows.
