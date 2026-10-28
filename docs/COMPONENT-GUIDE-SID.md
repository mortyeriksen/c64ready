<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->
<!-- description: The story, connections and specifications of The SID, with practical Live Monitor exploration. -->

# The SID

SID settings describe a small synthesizer. A program changes pitch, waveform, envelope and filter controls to create music and effects.

## The story

The SID was designed with musical instruments in mind. Bob Yannes was an
electronic-music enthusiast before designing it, and wanted a synthesizer chip
that could interest instrument manufacturers. In his
[interview with Andreas Varga](https://trondal.com/c64sid/yannes.html), he explains
how development time and chip area constrained the design.

That musical approach is visible in the controls. A voice has an oscillator to
create a repeating waveform and an envelope to shape its level over time. The
voices can then be routed through a shared filter. Music software supplies the
sequence of settings, rather like a performer choosing notes and articulation.

A voice is not permanently assigned to one instrument. A player routine may
reuse it for bass, percussion or an effect, changing settings quickly enough to
suggest a richer arrangement. Learning to follow those changes is more useful
than assuming each of the three boxes represents one unchanging instrument.

## Follow a single note

A simple note gives you a path through the whole chip:

1. A frequency value sets the oscillator's pitch.
2. A waveform selection determines the basic shape and harmonic content.
3. Opening the gate starts the envelope's attack and decay behaviour.
4. While the gate remains open, the envelope approaches its sustain level.
5. Closing the gate starts the release, so the sound can continue afterwards.

Pulse width changes the shape of the pulse waveform. Filter cutoff changes
which frequency regions pass through the selected filter mode. Resonance
emphasizes the region around the cutoff. These controls can make a held note
change character even when its pitch stays still.

The filter belongs to the chip, not to each voice independently. Its routing
bits select which voices enter it. Read the three voice panels together with
the filter and volume controls to understand the complete sound path.

With two SIDs, there are two sets of these resources. Follow each chip's three
voices and filter separately, then consider how their outputs are mixed. A
second chip does not turn the first chip's shared filter into six independent
filters.

## Fun fact: the design reached beyond the C64

Yannes later co-founded Ensoniq. In the interview, he contrasts SID's separate
oscillators with later Ensoniq chips that shared oscillator hardware over time
to support many more voices. The C64's sound chip belongs to a broader story
of digital synthesizer design, not just game sound effects.

## How it connects

**Program writes → oscillators and envelopes → filter and mixer → sound**

| Specification | Meaning |
| --- | --- |
| Three voices per chip | Each has its own oscillator and envelope. |
| Triangle, saw, pulse, noise | Waveform selections shape the sound. |
| ADSR envelope | Attack, decay, sustain and release shape a voice over time. |
| Shared filter | Selected voices can pass through the chip's filter. |
| 6581 and 8580 | Variants with different analogue characteristics. |

The [SID model](SID-ARCHITECTURE.md) explains audio generation and the register shadow used for inspection.

## Try it in Monitor

1. Compare the three pitch lanes, or six with two SIDs.
2. Choose **Inspect Sound** to follow each voice through its envelope and filter or bypass path. Each voice box includes its explanation and register bytes. Choose the play icon to watch settings change.
3. Explore **Captured voice changes** while paused to connect SID writes with the program in the shared recording.

## What the readings can tell you

A bright trace means the voice's gate bit is set. It does not measure loudness. A voice can continue its release after the gate closes, and a selected waveform does not prove an audible output.

Dual-SID information is kept separate so each chip's voices and model remain identifiable.

## Continue exploring

Follow the music routine in [Code](COMPONENT-GUIDE-CPU.md), then explore [CIA timers](COMPONENT-GUIDE-CIA.md) as one way software can schedule updates.

Explore more in [Inside the C64](INSIDE-THE-C64.md), or open the
[Live Monitor guide](GUIDE-MONITOR.md) for controls and workflows.
