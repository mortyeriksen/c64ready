<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->
<!-- description: The story, connections and specifications of CIA and control interfaces, with practical Live Monitor exploration. -->

# CIA and control interfaces

The two Complex Interface Adapter chips connect much of the C64's input, timing and communication. They help the program react to events while the CPU is busy doing something else.

## The story

The C64 needs more than a processor, picture and sound. It must find out which
keys are held, communicate with peripherals and arrange for events to happen
at useful times. Two 6526 Complex Interface Adapters supply much of that work.

The same chip design takes different roles depending on its wiring. CIA1 is
closely involved with the keyboard and control ports. CIA2 helps select the
VIC-II memory bank and connects to the serial bus and user port. A generic
interface chip becomes a keyboard interface, a video-bank selector or a
communication helper through the surrounding circuit and software.

Each CIA also has programmable timers. They can count while the CPU executes
other instructions and request attention when an event occurs. The original
[MOS 6526 data sheet](https://www.retrodocs.fr/wp-content/uploads/pdf/MOS-6526.pdf)
describes the ports, timers, interrupt control, serial register and time-of-day
clock that make this combination possible.

## How the machine notices a key

The keyboard is a matrix of switches. A key joins one row to one column instead
of having a dedicated wire all the way to the processor.

1. Software drives a pattern on one side of the matrix.
2. It reads the other side to find which connections are closed.
3. Repeating this with different patterns identifies the held keys.
4. The program decides what those keys mean in the current context.

The control ports share some of these connections. This helps explain why input
is best understood as pin states and wiring before interpreting it as a named
action. A low signal can mean a pressed switch. It does not mean the interface
is inactive.

Timers add a different kind of input: the passage of time. A timer's current
count, reload value, running flag, pending interrupt and interrupt mask answer
different questions. A pending event with its interrupt disabled does not have
the same effect as an enabled request reaching the CPU.

CIA1 and CIA2 also reach different CPU interrupt inputs. Follow the
[machine wiring](MACHINE-ARCHITECTURE.md) when investigating the source of an
IRQ or NMI, rather than treating all interrupt indicators as interchangeable.

## Fun fact: both interface chips contain a clock and alarm

The 6526 includes a time-of-day clock with tenths of a second and an alarm
comparison, in addition to its two interval timers. Those are different timing
facilities. A music routine using a countdown timer does not need to use the
clock-of-day registers at all. See the time-of-day section of the data sheet.

## How it connects

**Keys and port signals → CIA1 → program**<br>
**Timers and external events → interrupt requests → CPU**<br>
**CIA2 outputs → VIC bank and serial bus**

| Specification | Meaning |
| --- | --- |
| Two eight-bit ports per CIA | Pins can be configured for input or output. |
| Two 16-bit timers per CIA | Four timers across the C64's two chips. |
| Timer clock selection | Counts can come from system cycles or selected input events. |
| Interrupt status and mask | Pending events and enabled interrupt sources are distinct. |
| Time-of-day and serial functions | Additional timing and communication facilities. |

See the [machine model](MACHINE-ARCHITECTURE.md) for the wiring between CIAs, CPU, keyboard, control ports and tape.

## Try it in Monitor

1. Choose **Inspect Controls** to see the keyboard matrix, control-port pins and CIA timers.
2. Give the live C64 display focus, then press a key or use a controller and watch the input states.
3. Compare a timer's current count, reload value and running flag before interpreting an interrupt indicator.
4. Pause and use Code's interrupt evidence to investigate accepted interrupts in the shared frame.

## What the readings can tell you

Port pins do not identify the attached device. A joystick, mouse or other controller can share those connections. Likewise, a started timer is a control-bit observation, not a measured interrupt rate.

Keyboard and control-port input remain connected to the C64 while its live display has focus.

## Continue exploring

Follow a pulse into [tape loading](COMPONENT-GUIDE-TAPE.md), or follow the serial connection to [the 1541](COMPONENT-GUIDE-DRIVE.md).

Explore more in [Inside the C64](INSIDE-THE-C64.md), or open the
[Live Monitor guide](GUIDE-MONITOR.md) for controls and workflows.
