<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->
<!-- description: Explore the chips, connections and devices behind the C64, with hardware stories, clear specifications and things to try in Live Monitor. -->

# Inside the C64

**The chips, connections and devices behind the machine.**

Discover how a program becomes a picture, a sound or a response to your joystick.
Each chapter tells a component's story, explains its connections and key
specifications, and gives you something to explore in Live Monitor.

## One machine, several specialists

Imagine a character walking across a game screen. The CPU updates its position,
the VIC-II fetches its picture, and the SID plays the sound of its footsteps.
A joystick changes input signals through the control interfaces. Disk or tape
may supply the next part of the level. The visible result belongs to their
cooperation, even though Monitor gives each part its own page.

The chapters follow that cooperation from an accessible story to a concrete
example, key specifications and things to observe. Fun facts connect the
engineering to the people, physical hardware and programming tricks behind it.
Use the tables for a quick reference, then follow the component links when an
explanation leads somewhere else in the machine.

## Start exploring

- **Follow the picture:** start with memory, then the VIC-II.
- **Follow the music:** explore the SID's voices, envelopes and filter.
- **Follow the program:** start with the CPU, then controls and timing.
- **Follow the data:** explore disk, tape, cartridges and RAM expansion.

Open a chapter from the menu, or choose **About** on a Live Monitor card.
Clicking the rest of a card opens its inspection section.
Each About view uses the same chapter as this collection. **Inspect in Monitor**
opens the matching section. Pause retains the latest complete recording so you
can compare the chips' recorded activity across sections.

For the Monitor's controls and workflows, see the
[Live Monitor guide](GUIDE-MONITOR.md).

## Topics

| Chapter | What you will discover |
| --- | --- |
| [The 6510 CPU](COMPONENT-GUIDE-CPU.md) | How instructions control the machine. |
| [Memory and banking](COMPONENT-GUIDE-MEMORY.md) | Where bytes live and why one address can mean different things. |
| [The VIC-II](COMPONENT-GUIDE-VIC.md) | How memory becomes characters, sprites, borders and pixels. |
| [The SID](COMPONENT-GUIDE-SID.md) | How a small synthesizer creates music and sound effects. |
| [CIA and control interfaces](COMPONENT-GUIDE-CIA.md) | How keys, control ports, timers and interrupts connect. |
| [The 1541 disk drive](COMPONENT-GUIDE-DRIVE.md) | Why the disk drive is a computer of its own. |
| [The Datasette](COMPONENT-GUIDE-TAPE.md) | How cassette pulses carry programs and data. |
| [Cartridges](COMPONENT-GUIDE-CRT.md) | How plug-in hardware changes the memory map. |
| [RAM expansion](COMPONENT-GUIDE-REU.md) | How extra memory exchanges data with the C64. |

## Go deeper

The chapters link to original hardware references and this emulator's
architecture documentation. The hardware story explains what a component can
do. Live Monitor's readings and captures help you discover what the current
program actually does with it.
