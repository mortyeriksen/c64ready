<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->
<!-- description: Explore the running C64 with Live Monitor, from visual overviews to captured frames and technical evidence. -->

# Live Monitor

**See what’s happening → understand it in plain language → inspect the technical evidence.**

Open **MONITOR** in Controls while the C64 is on. The Monitor fills the browser
window, follows your theme and lets your game or demo keep playing.

## Start exploring

1. Open Monitor and start with **Live** to see the machine's parts working together.
2. Let a frame finish recording, then click the small live display when you want to pause and inspect.
3. Explore the captured frame in **Video**, or select a section for more detail.

| Control | What it does |
| --- | --- |
| **Pause / Resume icon** | Before Live in the menu. Stops or continues the actual C64. Pausing keeps the latest completed frame available across sections. The pause icon changes to a play icon while paused. |
| Click the live display | Pauses the C64 and opens Video with the latest completed shared recording. |
| **Back to C64** or **Escape** | Closes the Monitor, keeping the machine running or paused as you left it. |
| Keyboard and control ports | Remain connected to the C64 while its display has focus. |

Monitor records a complete detailed frame about once per second while the machine
runs. Pause keeps the most recent completed recording for Code, Video and the
captured evidence in Memory, Sound and Storage. Other sections hold that recording
until another capture replaces it. Its picture can be older than the paused live
display, and its recorded values are separate from the current live snapshot.

Capturing needs a running machine. It never resumes a paused C64 for you.
If you pause before the first recording finishes, resume briefly to record one.
Replay controls move through a recording, without seeking or advancing your demo.
Closing Monitor releases the recording. If you reopen while paused, resume
briefly to record a new frame. Resetting or restoring the machine allows automatic
recording to continue while it runs.

## Choose a section

Every section uses the same open workspace. Subtle surfaces group components,
while simple dividers separate observations from their explanations and evidence.

On phones, scroll within a section to reach its details. Video stacks the picture
above its inspector. Sound uses stacked voice cards, with **SID 1** and **SID 2**
buttons to switch chips. Compact tablets also show one SID at a time.

| Section | Start here to understand… | Go deeper with… |
| --- | --- | --- |
| **Live** | How the machine's parts work together | Choose Inspect or About. |
| **Code** | What the program changes during a frame | Register writes, cycle budgets, assembly and interrupts. |
| **Memory** | Where data is changing in RAM | Hex bytes, graphics interpretations and captured RAM. |
| **Video** | How the picture relates to raster timing | Replay, sprites, borders, pixel sources and rules. |
| **Sound** | How SID voices are configured | Waveforms, envelopes, filters and captured writes. |
| **Controls** | How input and timers reach the machine | Keyboard matrix, both ports, paddles and CIA interrupts. |
| **Storage** | Which devices are attached or active | Drives, tape, cartridges and REU transfers. |

## Live: the living machine

Every card places its component label and title at the top, with Inspect and
About at the bottom. The visualization fills the right third.

![Live Monitor showing connected component cards.](/guide/monitor-live.webp)

Six softly outlined cards sit directly on the open workspace, with visualizations
on their right. They connect current observations to a plain explanation. Click a
card or its **Inspect** action to open the corresponding readings. Voice buttons
and storage badges open their specific targets. Storage device badges fill two
rows at the top of its visual area. **About** opens the hardware story without changing
your current section or capturing a frame.

| Card | What to look for | Component guide |
| --- | --- | --- |
| **Code** | Plain-language instruction, sampled CPU locations and IRQ request/mask indicators. | [6510 CPU](COMPONENT-GUIDE-CPU.md) |
| **Memory** | Changed pages, distinct byte locations and configured video sources. | [Memory and banking](COMPONENT-GUIDE-MEMORY.md) |
| **Video** | Configured screen window, larger sprite-enable slots, fine scroll, colours. | [VIC-II](COMPONENT-GUIDE-VIC.md) |
| **Sound** | Three or six pitch lanes, gate settings, waveforms and voice filter routing. | [SID](COMPONENT-GUIDE-SID.md) |
| **Controls & timing** | Held keys, control-port signals and the four CIA timers. | [CIA and controls](COMPONENT-GUIDE-CIA.md) |
| **Storage** | Selected device, media and observed activity. Badges open a specific device. | [Disk](COMPONENT-GUIDE-DRIVE.md), [tape](COMPONENT-GUIDE-TAPE.md), [cartridges](COMPONENT-GUIDE-CRT.md), [REU](COMPONENT-GUIDE-REU.md) |

- One shared snapshot refreshes RAM, chip settings, controls and storage at the selected rate. Click the sampling button beside **The living machine** to cycle through **1 → 10 → 25 → 50 samples/s**. The default is 10.
- Code translates the sampled opcode, with its instruction address underneath. At an instruction boundary it labels the last instruction. Missing identity is shown explicitly.
- The Code trail plots sampled CPU positions from $0000 to $FFFF, oldest to newest. Clusters suggest repetition, not a proven loop or percentage of CPU time.
- **IRQ request** shows the sampled line. **IRQ allowed** means the CPU I flag is clear, not that an interrupt handler ran. Brief requests can occur between samples.
- Frame cycle budgets and detailed chip actions remain in Code and Video, tied to their captured frame.
- RAM counts show addresses whose values differ from the previous snapshot.
- Pitch settings are not audio-level meters. CPU positions are not CPU-usage measurements.
- Video fills its visual third with a proportioned screen diagram, eight sprite-enable slots, X/Y fine scroll and colour swatches. Textures illustrate character or bitmap mode, not actual program artwork.
- Sprite enable bits do not prove visible pixels. Border openings and bad-line activity belong to captured Video analysis.
- Solid lines show C64 connections. The dashed line shows external storage connections.
- The desktop overview fits one screen. Smaller windows can scroll the cards.

[Inside the C64](INSIDE-THE-C64.md) collects the component guides in one place.
Its chapters include history, connections, specification tables, things
to try, primary references and links to this emulator's architecture documents.
Close an About dialog with **×** or **Escape** to return to the same section.

The selected rate is saved in this browser and restored after reloads.
If browser storage is unavailable, the rate lasts until the page is reloaded.
Higher rates refresh the live observations more often. Detailed frame recording
keeps its separate schedule, and Pause still holds the captured frame. The button
sets a target rate, so a busy browser can deliver fewer samples. Monitor does not
collect samples while closed or hidden.

The top-right C64 display remains live. Detailed Video and Code recordings keep
their own frame identity and replay controls. They are separate from the shared
state snapshot, which does not record everything that happened between samples.

A lit sprite-slot marker means enabled, not moving or visible throughout the frame.

## Controls: inputs and timing

Open **Controls** in the header or **Inspect Controls** on Live.

| Reading | Meaning |
| --- | --- |
| Keyboard matrix | Highlighted keys close switches in the CIA's eight-by-eight matrix. |
| Control ports 1 and 2 | Highlighted direction and fire pins are low, the active state. |
| Paddle readings | SID POTX and POTY input values, without guessing the device type. |
| CIA timers | Current counts, reload values, start bits and clock selections. |
| Interrupts | Pending source bits and masks. CIA1 can request IRQ, CIA2 can request NMI. |

These readings share the selected live sampling rate. Brief presses can fall between samples.
Reading this page does not acknowledge interrupts or advance timers.

## Memory: find out what the bytes do

- Select a square in the **64 KB RAM map** to inspect its 256 bytes. Arrow keys also move the selection.
- Bright fills show sampled changes. Outlines mark currently configured video sources.
- Use **Screen codes**, **Character patterns** or **Bitmap pixels**, **CPU location** and **Sprite sources** to jump to the current program's configuration.
- The right pane explains the selected page and shows relevant graphics when the source is known.
- Unidentified RAM shows a byte-value map, with no guess that the bytes must be a picture.
- Choose a raw interpretation in **View** or open **Hexadecimal bytes** for technical inspection.
- Open **Captured memory** to inspect RAM at a selected cycle after a detailed capture.

| Selected area | What the right pane shows |
| --- | --- |
| Configured screen or bitmap | A reconstruction with outlines around cells supplied by the selected page. |
| Character patterns | The configured character set with this page's shapes outlined. |
| Enabled sprite source | The first matching sprite's shape, colours and pointer. |
| CPU stack | Its purpose and the address of the next push. |
| Current CPU location | The sampled address, its memory source and a link to Code. |
| Other RAM | Byte values, diversity and sampled changes. Its purpose remains unknown. |

The map shows underlying RAM, including RAM beneath ROM and I/O. It does not show
chip registers or colour RAM. When the VIC reads ROM at a configured source,
the right pane explains why underlying RAM does not produce that picture and
offers a link to the actual VIC-visible source.
Memory roles use the shared snapshot and describe its configuration, not proof
of every access. Graphics reconstructions omit raster changes, scrolling and
compositing. Use Video's captured frame for those details.

## Code: understand the program's actions

![Code explaining captured video-register writes, with a frame cycle budget and raster-line map.](/guide/monitor-code.webp)

**Code** uses the shared recording, which refreshes while running and stays fixed
while paused. **Explain actions** translates recorded
VIC-II writes into changes to colours, sprites, display settings and interrupts.

| Tool | How to use it |
| --- | --- |
| Shared frame timeline | One cursor aligns CPU availability, video writes and the explanation. The category and cursor stay selected across automatic frame updates. |
| **Previous / Next action** | Step through matching writes, including multiple actions at the same cycle. |
| **See in Video** | Open the same captured frame and cycle. |
| Frame cycle budget | Compare CPU-available cycles with video stalls, REU holds and halted time. |
| Raster-line map | Click a line to move the shared cursor. Its actions appear beside the explanation. |
| **Execution & interrupts** | A full-page Code mode for historical instruction bytes, dispatch groups, IRQ/NMI acceptance and RTI returns. Follow the same captured cycle into Video or Memory. |
| **Assembly & registers** | Decode current CPU-visible memory and inspect CPU registers. |

Cycles without a matching video write show an explicit empty state. This does not
mean the CPU is idle. **See in Video** preserves the exact frame and cursor,
including cycles without an action.

**Available cycles do not mean useful work:** wait loops count too. Dispatch
intervals include stalls and interrupt entry. The action list covers video writes,
not sound, storage, input or general computation.

Assembly uses current memory, which can differ from the recording. **Follow PC**
samples the current program counter, possibly partway through an instruction.
Enter a known code address when you want decoding to start there.

## Video: explore one captured frame

Hover over the captured picture for an 8× pixel lens centred on your pointer.
A single crosshair marks the centre pixel a click explains, including near the edges.
The normal pointer is hidden inside the lens. The lens uses the recording and does not capture
another frame. Move outside the picture to dismiss it.

![Video with one captured picture, replay timeline and a contextual inspector.](/guide/monitor-video.webp)

Video keeps the picture, timeline and explanation together. It uses the shared
recording, which refreshes automatically while the C64 runs. Pause to hold it.

### Click the picture

- Click a pixel to open **Why this pixel?** in the right-hand inspector.
- Focus the picture and use arrow keys, then **Enter**, for keyboard inspection.
- Choose **Sprites** in the inspector to highlight any of the eight slots.
- Expand **Technical evidence** inline for the recorded bytes and source limits.
- Follow **Inspect captured source in Memory** to keep the frame, cycle and address.

The pixel explanation highlights the source bit or pair and shows which colour
source it selects. Multicolour pairs paint two neighbouring pixels. Recorded
output-stage controls follow colour changes within the line. Missing or
conflicting source evidence stays unresolved.

### Control the recording

| Control | What it does |
| --- | --- |
| **Pause / Resume** | Holds the latest completed recording, or resumes the C64 and automatic recording. |
| **Play replay** | Pauses the C64 and plays the recording slowly. Replay never clocks the machine. |
| Timeline and arrows | Select a cycle or step through raster lines. |
| **Step & speed** | Step one cycle, jump to the next event or change replay speed. |
| Layer checkboxes above the picture | Right-aligned controls for border masks, sprite coverage, bad lines, events and Reveal scan. |
| **Live display (top right)** | Always shows the current C64 on every page. Click it to pause and inspect the latest completed frame. Pause / Resume is before Live in the menu. |

Selecting a topic, sprite, pixel or cycle keeps that selection when the next
recording arrives. It does not pause the C64. Use **Pause** or **Play replay**
to hold one frame. Leaving sprite details clears its selection and outline.

### Choose what to inspect

| Inspector topic | What you can explore |
| --- | --- |
| **This frame** | Plain-language questions, frame CPU budget and recorded observations. |
| **Why this pixel?** | Border coverage, visible sprite ownership or recorded graphics bytes. |
| **Sprites** | Recorded coverage and line-end pointers and banks for each slot. |
| **Border** | Pixels outside the normal screen, recorded gates and related writes. |
| **Timing & rules** | **Rules at this cycle**, with the indexed rule catalogue, expandable explanations, evidence requirements and references. |
| **Events on this line** | VIC writes, raster IRQ assertions and recorded instruction origins. |
| **Observed techniques** | Observations and possible techniques, labelled separately. Ghost bytes show recorded idle graphics sources, values and timing, with a link to captured Memory. |

The five timing rows have their labels on the left. Click a row label to open
its explanation, or click the timing chart to inspect a cycle. Rules and picture
use this same cursor, with no separate playback toolbar. Expanding a rule does
not change the selected cycle.

### Help and evidence limits

**How to use Video** and **Evidence & limits** open small dialogs. Close with
**×** or **Escape** to return to the workspace. Use **Memory** for current screen,
character and sprite sources. Video's inspector stays tied to the captured frame.

| Evidence | Limits |
| --- | --- |
| Timing rules | Fixed Bauer predicates check DEN latching, bus windows, graphics counters, sprite sequencing, raster IRQs and refresh addresses. No AI is used. |
| Border checks | Checks all six comparator rules and the cycle-17/56 CSEL cancellation conditions. Full mask comparison still requires stable controls. |
| Pixel source | Retains the source byte and output-stage controls through graphics-mode, charset, scroll and colour changes. All eight graphics modes have colour and foreground checks. Normal sprite source tracing remains separate. |
| Grouped sprite reads | Verify three-byte order and counter progression, without claiming individual half-cycle timing. |
| Transition checks | Sprite shifting, expansion, colour selection, priority, collision detection, collision reads, IRQ acknowledgement and lightpen edges use recorded inputs and outputs. |
| Missing stages | Grouped sprite reads do not prove half-cycle timing. The captured rendering-stage display flag cannot prove entry before cycle 14. Analog and unstable VMLI behaviour remain outside these checks. |
| Renderer-source sample | Labelled separately from a timed bus fetch. The selected paint and line-end correction determine the source. If its decoded colour or foreground class disagrees with the final capture, the explanation stays unresolved. |
| Technique finding | Repeated writes alone do not prove a technique or the program's intent. |
| Reveal scan | Reveals recorded final pixels, rather than simulating sub-cycle output. |

Click graphics before and after a raster effect to compare their recorded sources.
An empty graphics shifter is explained separately from a fetched byte. These
explanations use the captured frame, never current RAM as a replacement.

Sprite coverage can include pixels hidden behind foreground graphics. Related
writes and line-end samples do not prove which write caused every visible effect.
The timing chart covers all 312 PAL lines, including margins outside the picture.

### Ghost bytes

When the graphics sequencer is idle, it can repeat one byte instead of fetching
normal character or bitmap data. Video checks the recorded bank, ECM setting,
sequencer state and bus reads. The source is bank + $3FFF, or bank + $39FF with ECM.

- **Observed** confirms matching idle graphics reads.
- **Candidate** means nonzero text-mode data coincides with open border gates.
- Neither label proves which final pixels appeared or the programmer's intent.
- Ordinary discarded idle bus reads are excluded. Missing or conflicting
  evidence is identified explicitly.

## Sound: inspect the SID voices

![Sound displaying SID voice settings, waveforms, envelopes and filter controls.](/guide/monitor-sound.webp)

Sound supports one or two SID chips, with each chip's model and address shown.
On desktop, all voices are visible and SID 1 keeps the same width with one or two
chips. When SID 2 is off, faded cards preview its three extra voices and filter.
Enable it with **SID2** in **Options → Sound**. Each voice explains its settings
beside its readings. Follow its envelope, filter or bypass path, and output.

| Area | Details |
| --- | --- |
| Voices | Frequency, approximate note for simple tonal settings, pulse width percentage, waveform, gate, sync, ring and test. Each box includes register evidence. |
| Envelopes | A contained schematic labels attack, decay, sustain and release, with the exact four settings below it. |
| Filter and output | Routing, cutoff, resonance, modes, voice-3 suppression and volume. |
| Readbacks | POTX/POTY, OSC3 and ENV3 without read side effects. |
| **Captured voice changes** | Pitch-register and gate histories, plus filter and volume write counts. |

These are settings and shadow readbacks, not measured audio levels. Envelope
shapes are illustrations, not timed audio traces. Gate off can still sound
during release, while gate on does not prove an audible output. Captured
writes show how settings change, without reconstructing the sound waveform.

## Storage: follow the connected devices

Storage opens on an active device, or an attached device when idle. Your selection
then stays fixed while you inspect it. The rate readout shows kB/s, with separate
read and write values. The Live card shows the same rate below its device buttons.
One kB means 1,000 bytes. Rates use up to one second of wall time and fall to zero
when traffic stops, including while paused.

| Rate label | Bytes counted |
| --- | --- |
| GCR media bytes | Framed disk read-channel bytes and bytes written to the surface, including repeated reads. |
| File/channel bytes | Accelerated LOAD payload and virtual drive data channels. |
| TAP stream bytes | Encoded pulse bytes consumed during playback or produced while recording. |
| CPU ROM reads | CPU accesses to mapped cartridge ROM, excluding inspection. |
| REU DMA bus bytes | C64-side reads and writes, including verification and both sides of swaps. |

These streams measure different work. Disk and tape rates are not decoded
program-loading speeds. Counters run only while the Monitor is open and visible.

| Device | What you can inspect |
| --- | --- |
| **Drive 8 / Drive 9** | Media, hardware state, head position and accelerated loading mode. |
| **Tape** | Inserted tape, transport state and position. |
| **CRT cartridge** | Type, mapping and bank, with a link to CPU-visible code. |
| **REU** | Capacity, transfer settings and controller flags. |
| **Captured REU transfers** | Recorded C64-side accesses, expansion addresses and command types. |

The observation strip keeps up to 80 snapshots and shows their actual time span.
That is about eight seconds at the default 10 samples/s, or 1.6 seconds at 50 samples/s.
Drive activity does not prove a particular file was loaded. Tape position is not
program-loading progress. Cartridge mapping is not a count of ROM reads, and a
REU read alone does not prove a completed copy.

## Shared snapshots and recorded frames

| Kind of information | What it means |
| --- | --- |
| Live display | The C64 picture updates at browser refresh rate. |
| Sampled live values | Changes between samples can be missed. RAM, chip settings and device readings share the selected 1, 10, 25 or 50 samples/s rate. |
| Shared detailed frame | One recording supplies replay, rule analysis and historical memory, instruction, fetch, sound and REU evidence across sections. Detailed reports are calculated when opened. |
| Captured RAM | Reconstructed from the initial snapshot and recorded changes. Incomplete recording, host paste, PRG or command injection, or accelerated load/status writes make reconstruction unavailable for that frame. |

Recording has a temporary host CPU cost. Evidence labels and explanations do not
change emulated timing or how the C64 picture is generated. Missing or conflicting
evidence is reported rather than guessed.
