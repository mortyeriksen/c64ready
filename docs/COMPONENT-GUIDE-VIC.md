<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->
<!-- description: The story, connections and specifications of The VIC-II, with practical Live Monitor exploration. -->

# The VIC-II

The VIC-II turns memory and register settings into the C64 picture. It also decides when it needs the memory bus, affecting the time left for the CPU.

## The story

The VIC-II gives the C64 a graphics specialist. Character patterns, colours and
sprite data live in memory, while the chip repeatedly turns them into a video
signal. The CPU can concentrate on changing the scene instead of sending every
pixel to the display itself.

A television picture is produced in a sequence of raster lines. That sequence
creates opportunities: change a setting after the upper part of the picture
has been drawn, and the lower part can use something different. One frame can
contain several screen arrangements even though no single set of register
values describes the whole result.

Games and demos turn these timing opportunities into techniques. Sprite slots
can be reused farther down the picture, screen regions can scroll differently,
and carefully timed writes can change border behaviour. The interesting
question becomes “what did the chip see at that moment?” rather than simply
“what are its registers now?” The [VIC-II model](VIC2-ARCHITECTURE.md) explains
how this emulator follows the changing state.

## Follow one line of the picture

Think of the VIC-II as working through a schedule:

- It obtains the graphics information needed for the line.
- Sprite fetching supplies data for active sprite DMA.
- Internal counters and shift registers turn those bytes into candidate pixels.
- Priority, transparency and border state decide what reaches the final picture.

A **bad line** is a line on which the VIC-II fetches a row of screen information.
The extra memory access leaves less time for the CPU. “Bad” describes the CPU's
lost opportunity, not an error or damaged line on the display.

Sprites have their own fetching and display rules. Enabling a slot is not the
same as proving that it contributed visible pixels. It may be outside the
picture, covered by a border, transparent at a particular position or hidden by
higher-priority graphics. Video's captured coverage and pixel explanations help
separate these cases.

For the PAL timing used here, 312 lines × 63 cycles gives **19,656 cycles per
frame**. That is the frame's time budget, not 19,656 guaranteed CPU execution
cycles. The captured budget explains how access is shared.

## Fun fact: Nine mixes techniques to preserve the illusion

In Nine, a digit can be drawn with character graphics when the sprite arrangement
becomes difficult. Linus Åkesson also explains how sprite priority affects which
hardware slot can represent each moving digit. An object that looks like a sprite
need not always use one. His [Nine explanation](https://www.linusakesson.net/scene/nine/explanation.php)
is a useful companion to investigating your own captured frame.

## How it connects

**RAM / character ROM + registers → graphics, sprites and border → picture**

| Specification | Meaning |
| --- | --- |
| 40 × 25 character cells | A normal text screen. |
| 320 × 200 graphics area | The usual high-resolution picture area. |
| Eight sprite slots | Hardware slots can be reconfigured during a frame. |
| 16 colours | Colour values select entries in the palette. |
| PAL 6569 model | 312 raster lines with 63 cycles per line. |

The [VIC-II model](VIC2-ARCHITECTURE.md) documents how rendering, borders, sprites and bus arbitration work in this emulator.

## Try it in Monitor

1. Read the configured graphics mode on Live. Its diagram shows the screen window, sprite-enable slots, fine scroll and colours.
2. Pause on Live, then choose **Inspect Video** to explore the shared recording.
3. Select a pixel, then follow its explanation to recorded sources and timing rules.

## What the readings can tell you

The overview diagrams current settings. Open-border tricks, bad-line activity
and changes within the frame belong to the recorded evidence in Video.

**Ghost bytes** are another use of the graphics sequencer. While idle, it repeats
the byte at the end of its selected bank ($3FFF within the bank, or $39FF with
ECM, extended colour mode), with zero screen and colour data. Video's **Observed techniques** checks
recorded reads and links the source to captured Memory. A read alone does not
prove a visible effect. See §3.7.3.9 of [Christian Bauer’s VIC-II article](https://www.cebix.net/VIC-Article.txt).

Enabled sprite slots are not a count of visible objects across a whole frame.
Captured evidence reveals changes that a sampled overview can miss. Some
character bytes are labelled as renderer samples rather than timed bus fetches.
Output-stage samples follow graphics changes within the line. If their decoded
colour or foreground class disagrees with the captured picture, the explanation
reports insufficient evidence. Captures without per-pixel source data require
agreeing column samples and stable settings.

## Continue exploring

Explore [memory](COMPONENT-GUIDE-MEMORY.md) to understand the fetched bytes, then [the CPU](COMPONENT-GUIDE-CPU.md) to understand the timed writes.

Explore more in [Inside the C64](INSIDE-THE-C64.md), or open the
[Live Monitor guide](GUIDE-MONITOR.md) for controls and workflows.
