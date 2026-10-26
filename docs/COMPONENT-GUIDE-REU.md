<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->
<!-- description: The story, connections and specifications of RAM expansion, with practical Live Monitor exploration. -->

# RAM expansion

A RAM Expansion Unit holds extra data outside the CPU's ordinary address space. A controller transfers data between that memory and the C64.

## The story

Adding memory does not automatically give an eight-bit computer a larger address
space. The 6510 still uses 16-bit addresses. Commodore's RAM Expansion Units solve
this by putting extra memory behind a transfer controller, which moves data
between the expansion and the C64's memory system.

A program can keep material in expansion RAM and bring a block into the C64 when
it needs it. That could be a picture, a working buffer or another part of a
larger data set. The program must know how to operate the REU. Plugging one in
does not automatically make every game use the extra capacity.

The 1764 supplied 256 KB for the C64. Commodore's
[1764 User's Guide](https://files.commodore.software/reference-material/manuals/commodore-64-manuals/hardware-manuals/1764-ram-expansion-module-users-guide.pdf)
introduces its uses and supplied software. Monitor separates the amount of RAM
attached from evidence that the current program has actually transferred data.

## Follow a block transfer

The program prepares a small set of controller registers:

1. A C64 address identifies one end of the operation.
2. An expansion address identifies the other end.
3. A length describes how much data the command should process.
4. The command chooses copy to REU, copy from REU, swap or compare.

The controller then uses direct memory access, or DMA. It performs the bus
accesses without a CPU instruction for each byte. The CPU loses access while
the controller owns the bus, and video fetching still has its own timing needs.
Extra memory therefore also creates a scheduling question.

A compare operation reads data to check it rather than copying it into the
other memory. A swap moves data both ways. A byte-rate meter can include these
bus accesses, so the number is not automatically the rate of newly loaded data.

The controller can update its address and length registers as it operates, and
auto-load behaviour can restore settings. Current registers are consequently
not a reliable progress bar or a saved description of the previous transfer.
Storage keeps those settings separate from the accesses recorded in a frame.
The [machine model](MACHINE-ARCHITECTURE.md) explains bus ownership, and the
[memory model](MEMORY-ARCHITECTURE.md) explains the C64-side address decoding.

## Fun fact: the 1764 came with a power supply

Commodore bundled a more powerful supply with the 1764 because the module drew
power through the C64. The original manual explains why owners were to replace
the old supply. Adding RAM was a physical power-budget decision as well as a
memory-budget decision. See page 2 of the User's Guide linked above.

## How it connects

**C64 memory ↔ transfer controller ↔ expansion RAM**

| Specification | Meaning |
| --- | --- |
| Separate expansion memory | Capacity is additional to the C64's 64 KB. |
| Address and length registers | Describe the source, destination and transfer size. |
| Direct memory access | The controller transfers bytes using the memory bus. |
| Transfer commands | Select operations such as copying between the two memories. |

The [memory model](MEMORY-ARCHITECTURE.md#the-ram-expansion-s-ff00-snoop) explains the REU’s deferred-start trigger. The [machine model](MACHINE-ARCHITECTURE.md) explains DMA bus ownership and inspection of its registers.

## Try it in Monitor

1. Open **Storage → REU** and check the attached capacity and current command settings.
2. Watch for REU accesses in the automatically recorded frame. Pause when you want to hold the evidence.
3. Select a recorded access in the diagram, then follow **Inspect cycle in Video** or **Inspect captured RAM**.
4. Compare its address and direction with the current registers. They may describe different moments.

## What the readings can tell you

An attached REU can be idle. The overview reports activity that its samples observed, without guessing what the transferred bytes mean. Detailed capture can provide evidence that a sampled visual misses.

Large expansion capacity does not enlarge the CPU's 16-bit address space.

## Continue exploring

Compare expansion transfers with [cartridge mapping](COMPONENT-GUIDE-CRT.md), then follow their effect on [CPU time](COMPONENT-GUIDE-CPU.md).

Explore more in [Inside the C64](INSIDE-THE-C64.md), or open the
[Live Monitor guide](GUIDE-MONITOR.md) for controls and workflows.
