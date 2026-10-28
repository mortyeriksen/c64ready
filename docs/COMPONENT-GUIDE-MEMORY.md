<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->
<!-- description: The story, connections and specifications of Memory and banking, with practical Live Monitor exploration. -->

# Memory and banking

Memory gives the program somewhere to keep instructions, pictures and working values. The meaning of a byte depends on who reads it and how the chips are configured.

## The story

The name C64 advertises its 64 KB of RAM. That memory has to hold a program's
instructions, variables, pictures, music data and temporary work. Saving space
in one place makes room for something else, so representation matters as much
as capacity.

RAM is writable working storage. ROM holds built-in contents and supplies things
the machine should already know when it starts: the BASIC
interpreter, KERNAL routines and character shapes. The CPU has only 65,536
addresses, so all that RAM, ROM and hardware cannot have separate permanent
places in its address space. Banking changes which device answers a read at
particular addresses. It does not move the bytes around.

The video chip has its own memory view. A CPU read and a VIC-II fetch with a
similar-looking address can therefore come from different sources. This is why
an unexplained hex dump can be misleading. First identify the reader and the
mapping, then interpret the bytes. The [memory model](MEMORY-ARCHITECTURE.md)
describes these overlapping views.

## How a byte becomes a character

A normal text screen separates the choice of character from its shape:

1. Screen memory supplies a character code for a cell.
2. That code selects a pattern in the current character set.
3. The current row of the pattern supplies eight bits of shape information.
4. Colour settings decide how those bits appear on the display.

Changing a screen code replaces one character. Changing a character pattern can
alter every cell using that pattern. This is a powerful way to animate repeated
details without rewriting every pixel separately. A custom character set can
contain bricks, leaves or parts of a logo just as easily as letters.

The same RAM can later be reused for something entirely different. A loader may
replace an old picture with music data, or a demo may reuse a workspace between
parts. Memory does not carry a permanent label saying “graphics” or “code”.
Monitor's configured-source outlines provide context, while captured fetches
show how particular bytes were actually used.

## Fun fact: eight sprite pointers hide beside the text screen

A screen matrix reserves 1,024 bytes, while 40 × 25 visible cells use only 1,000.
The final eight bytes of that matrix hold sprite pointers. Changing the selected
screen matrix can therefore change where the VIC-II obtains all eight pointers,
even if the text itself is unimportant. Commodore documents both areas in its
[Programmer’s Reference Guide, page 133](https://www.devili.iki.fi/Computers/Commodore/C64/Programmers_Reference/Chapter_3/page_133.html).

## How it connects

**CPU mapping → RAM / ROM / I/O**<br>
**VIC bank → screen, patterns, bitmap and sprites**

| Specification | Meaning |
| --- | --- |
| 64 KB underlying RAM | 256 pages of 256 bytes in Monitor. |
| CPU port at $0000 / $0001 | Direction and data control memory selection. |
| Colour RAM | A separate source of colour information. |
| VIC view | A selected 16 KB window with its own ROM visibility. |

The [memory model](MEMORY-ARCHITECTURE.md) explains address decoding and banking in the emulator.

## Try it in Monitor

1. Watch which squares change on Live.
2. Choose **Inspect Memory** to open the page with the most changed bytes in the latest nonempty observation.
3. Choose **Screen cells**, then select a byte to see its address, character source or bitmap colour nibbles.
4. Compare **Character shapes** or **Bitmap pixels** with those bytes. Bitmap previews show raw bits even when the graphics mode outputs black.
5. Follow the Video link to investigate the finished picture. **Static picture** applies only the sampled settings and can look scrambled during raster effects.

## What the readings can tell you

Bright squares show observed differences between samples. A byte that changes and returns before the next sample can be missed. Repeated changes to one address count once in the displayed interval.

Outlines identify configured video sources. They do not prove that the VIC fetched every outlined byte. Use a captured frame in Video to investigate actual recorded fetches.

## Continue exploring

Follow a graphics byte into [the VIC-II](COMPONENT-GUIDE-VIC.md), or compare CPU mapping with [cartridge banking](COMPONENT-GUIDE-CRT.md).

Explore more in [Inside the C64](INSIDE-THE-C64.md), or open the
[Live Monitor guide](GUIDE-MONITOR.md) for controls and workflows.
