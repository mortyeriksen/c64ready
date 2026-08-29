<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->

The emulator brings the whole breadbin to life: the 6510 CPU with every illegal opcode, VIC-II graphics down to the raster line, both SID sound chips (6581 & 8580), the CIA timers, PLA memory banking, and a true 1541 disk drive that handles the nastiest custom fastloaders. Every chip is held as close as possible to the real hardware, checked against hundreds of cycle-exact test programs alongside a growing unit-test suite of 2,400+ labeled tests.

It is written from scratch and is not a VICE source port, but I could not have completed it without all the work done by the VICE Team: VICE was leaned on heavily to compare behaviour and hunt down bugs, especially the tricky fastloaders and cycle-exact demos. Thank you.
