<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->
<!-- description: Where the emulator stands against real Commodore 64 and 1541 hardware, subsystem by subsystem, with known gaps called out. -->

# Component status

Where the emulator stands against real Commodore 64 and 1541 hardware, subsystem
by subsystem. This is the deliberately conservative view: a component is rated
`Implemented` only when it behaves correctly for normal software, and known gaps
are called out rather than glossed over.

For *how* the pieces fit together, see the [master overview](ARCHITECTURE.md) (and the
per-subsystem deep-dives it links). For what the emulator can do from a user's
seat, see [Features](FEATURES.md).

**Status**

- `Implemented`: present and broadly aligned with expected hardware behavior for normal software.
- `Partial`: usable, but simplified or missing important edge cases versus the original hardware.
- `Missing`: not implemented at this time.

The rule for gaps: a component is `Partial` only when software running on the
emulated machine can reach the gap. A gap that needs hardware the emulator
doesn't model (user-port devices, say) leaves the component `Implemented`, with
the gap noted.

**Spec alignment** (`High` / `Medium-high` / `Medium` / `Low`) rates how close the
implementation is to documented hardware behavior for that component.

| Area | Component | Status | Spec alignment | Notes |
| --- | --- | --- | --- | --- |
| Main unit | C64 system integration | Implemented | High | `machine.js` clocks CPU, VIC-II, CIA1/2, SID, datasette and the optional 1541 on one PAL master timeline (50.125 Hz, 19656 cycles/frame). POWER and RESET both rebuild the machine (a true power-cycle); a soft `/RESET`-line reset also exists. See the [machine doc](MACHINE-ARCHITECTURE.md). |
| CPU | MOS 6510 core | Implemented | High | `cpu.js` includes official opcodes, common illegal opcodes, decimal mode, IRQ/NMI handling, page-cross penalties, and micro-op paths for timing-sensitive cases. Passes Klaus Dormann's 6502 functional test. |
| CPU | 6510 I/O port at `$0000/$0001` | Implemented | High | DDR/data-port behavior is modeled and drives memory banking plus datasette SENSE/MOTOR lines. |
| Memory | RAM / ROM / PLA-style banking | Implemented | High | `memory.js` handles BASIC, KERNAL, CHAR ROM visibility, I/O mapping, and Ultimax cartridge mode through the processor port bits. |
| Video | VIC-II raster timing | Implemented | Medium-high | PAL raster count, bad-line steals, BA/AEC, internal counters, raster IRQs (mid-line `$D011`/`$D012` included) and mid-line register changes, sequenced cycle-by-cycle. See the [VIC-II doc](VIC2-ARCHITECTURE.md). |
| Video | Character and bitmap display modes | Implemented | High | All eight ECM/BMM/MCM combinations plus the three **invalid** modes (black output, collisions still register); mode bits are sampled live per pixel, and the XSCROLL edge filler follows Bauer §3.7.3 (see [VIC-II §8](VIC2-ARCHITECTURE.md)). |
| Video | Sprites | Implemented | Medium-high | Eight sprites with expansion, multicolor, priority, DMA steals and multiplexing; sprite-crunch and deferred display-disable per the VICE addendum; idle-fetch leakage matches VICE's reference pixel-for-pixel. Remaining testprog deviations are tabulated in the [VIC-II doc](VIC2-ARCHITECTURE.md). |
| Video | Collision latches and IRQs | Implemented | High | Sprite-sprite and sprite-background collision flags/IRQs are implemented cycle-by-cycle via the incremental rendering pipeline, providing accurate mid-line register reads. |
| Video | Light pen | Implemented | High | `$D013`/`$D014` latch on the negative edge of the LP input. One-shot per frame, re-armed at raster=0. Line 311 negative edges silently ignored; LP held LOW across the frame boundary retriggers at L0 cycle 1 (per VICE addendum). |
| Video | VIC-II model selection | Implemented | High | Runtime toggle between 6569 (NMOS) and 8565 (HMOS / C64C); the 8565 grey-dot artifact and its 1-cycle register-pipeline delay switch with it. |
| Video | NTSC (6567) timing | Missing | Low | Everything targets the PAL machine (312 lines × 63 cycles, 50.125 Hz). The NTSC 6567's geometry, bad-line/sprite layout and per-variant quirks are not modeled; NTSC-only software is out of scope. |
| Audio | SID register write path | Implemented | High | Register writes are cycle-stamped on the main thread and consumed in an `AudioWorklet` through a shared ring buffer, allocation-free on the audio thread; a cycle-sync hook keeps digi timing across power-cycles. See [SID §1](SID-ARCHITECTURE.md). |
| Audio | SID synthesis (oscillator + envelope) | Implemented | High | One SIDVoice class serves the worklet and the main-thread shadow: phase accumulator, sync, ring mod, test bit, full ADSR with the ADSR-bug timing, and the 23-bit noise LFSR with combined-waveform clobbering. See the [SID doc](SID-ARCHITECTURE.md). |
| Audio | SID combined waveforms | Implemented | High | reSID's **measured chip tables** (OSC3 samplings of real 6581/8580) with reSID's selector composition. The full combined-waveform OSC3 sweep is byte-exact against headless VICE x64sc on both models. |
| Audio | SID filter | Implemented | High | reSID transistor-level model (`filter8580new` port): measured op-amp curves, model-specific integrators, real cutoff-DAC nonlinearity. Sweep knees track VICE across the FC range; EXT IN routing behaves like hardware with the pin grounded. See the [SID doc](SID-ARCHITECTURE.md). |
| Audio | `$D418` 4-bit digi | Implemented | High | Per-voice DC through the chip's nonlinear volume ladder produces the digi with no calibration constants; tracks VICE within ~0.1 dB. Galway 1-bit PWM and Mahoney-style 4-bit playback work; the 6581 is the hot digi chip, as on hardware. |
| Audio | SID register reads (`$D41B` / `$D41C`) | Implemented | High | Cycle-exact OSC3/ENV3 readback from a main-thread "shadow SID" clocked in lockstep, so tight polling loops see the byte the worklet would emit at that cycle, not an audio-block-stale snapshot. See [SID §7](SID-ARCHITECTURE.md). |
| Audio | SID paddle reads (`$D419` / `$D41A`) | Implemented | High | POTX/POTY sample-and-hold every 512 master cycles, modeling the RC-discharge ADC; with no pot device the pins read `$FF` (open), so detection routines correctly find nothing. Matches VICE on the `paddles` testprogs. |
| Audio | Analog output stage | Implemented | High | reSID's C64 external RC model, then the reference SINC resampler at VICE's runtime parameter defaults; absolute levels match VICE within 1.5 %. A brief fade-in on init/reset masks the RC settling transient. See the [SID doc](SID-ARCHITECTURE.md). |
| Audio | Second SID | Implemented | High | Optional 32-byte address window, independent 6581/8580 model and cycle-exact readback, stereo or mono output in both engines. Two-SID tune headers configure playback; snapshots restore both chips. Three-SID tunes are refused. |
| Audio | SID model selection | Implemented | High | UI toggle for 6581 vs 8580. Combined-waveform shapes, filter cutoff curves, resonance ramps, and DC bias all differ between models. |
| Audio | SID engine selection (reSID WASM / reSID JS) | Implemented | High | Two engines: reSID WASM (default; **bit-identical to reSID JS by test**, far less audio-thread CPU) and reSID JS. A live switch replays the full register file, and WASM failure falls back silently to JS, so audio never drops. |
| Audio | 1541 drive sounds | Implemented | Medium | Synthesized motor hum and stepper clicks via WebAudio; trap-mode loads produce a canned click train. Off by default (**DRIVE SOUND**, Options ▸ Sound). |
| I/O | CIA1 | Implemented | Medium-high | Timers (incl. CNT-count modes), TOD clock, keyboard matrix, joystick merge, and datasette FLAG IRQ. The serial register's **output** path is modeled (SDR write → 16 Timer A underflows → SP IRQ, with pending-byte chaining); only the physical SP/CNT pins and **input-mode** shifting, which need external user-port hardware, are unmodeled. |
| I/O | CIA2 | Implemented | Medium-high | Timers, TOD, NMI signaling, and VIC bank switching. Serial-register coverage matches CIA1 (physical SP/CNT pins + input-mode shifting absent). This does **not** affect the IEC bus, which the KERNAL bit-bangs on CIA2 Port A, not the shift register. |
| I/O | CIA chip model | Implemented | High | A single generic **MOS 6526** serves both CIAs; no old-vs-new (6526A / 8521) selector, behavior follows the common 6526 subset. A plain START holds the count for one clock before the first decrement, measured against VICE; cycle-exact stable rasters depend on it. |
| Input | Keyboard matrix | Implemented | High | Standard C64 key mappings plus host-friendly remaps: TAB = INST/DEL, F9 = RUN/STOP, F10 = Commodore key, F11 = CLR/HOME, F12 = RESTORE (NMI). |
| Input | Control-port routing | Implemented | High | Each of the two ports assigns independently (Joystick, Touch Joystick, Mouse 1351, Mouse NEOS, Paddle, Key Joystick 1/2, or None), with a swap. The byte builders and NEOS strobe machine are DOM-free (`control-port.js`), unit-tested without a browser. |
| Input | Digital joystick | Implemented | Medium-high | Joystick ports are merged into CIA1 reads and support gamepads (per-port selection), key-joystick mode, and a touch-only eight-way/two-button overlay. Both two-button inputs wire their second button to the UP line. Covers digital directions/fire, not analog. |
| Input | 1351 proportional mouse | Implemented | High | GEOS-convention 1351 through the SID's 512-cycle sample-and-hold; LMB→FIRE, RMB→UP, and the POT byte advances 2 per mouse unit as the hardware's 6-bit counter does. Tested against the 1351 programs in VICE's testprogs. |
| Input | NEOS mouse | Implemented | High | Nibble-multiplexed strobe protocol with an idle-reset timeout; right button on POTX. Tested against the NEOS programs in VICE's testprogs. **Known gap:** `arkanoid.prg` (which works only by chance on real hardware) still does not track motion. |
| Input | Paddle | Implemented | High | Paddle pair driven by the mouse through POTX/POTY's sample-and-hold; paddle-A fire on the joystick LEFT line, paddle-B fire on the FIRE line. Tested against the `paddles` testprogs, which read the same values as VICE. Still not a real pot's analog response. |
| Input | Light pen | Implemented | Medium-high | VIC-II light-pen latch implemented and wired: the LP input is driven by CIA1 Port B bit 4 (output-low) OR joystick-1 FIRE, so the "stable raster via light pen" trick works. No dedicated light-pen pointer device through the UI yet. |
| Tape | 1530 Datasette playback | Implemented | Medium-high | `.tap` v0/v1/v2 played cycle-by-cycle through CIA1 FLAG pulses with motor/SENSE handling; full five-key transport, counter, and motor-gated winding as on hardware. A tape's contents list without loading it (KERNAL plus the eight turbo formats named in [Features](FEATURES.md)), and the signal can be played or drawn on a scope. See the [datasette doc](DATASETTE-ARCHITECTURE.md). |
| Tape | Tape recording | Implemented | Medium-high | The cassette write line is timestamped at one master cycle and encoded to `.tap` v1 (or v2 half-waves), the ÷8 remainder carried so long recordings don't drift. RECORD overwrites from the head as a real deck does; verified by decoding a real KERNAL `SAVE` and a cycle-counted turbo saver. See [datasette §6](DATASETTE-ARCHITECTURE.md). |
| Serial bus | IEC bus (C64 ↔ 1541) | Implemented | High | Wired-AND signal reflection with correct open-collector polarity, driving real interrupts on the drive CPU. Drive→C64 edges land one master cycle later than the run order gives, modeling the input-latch margin of the two asynchronous clocks; that margin keeps 2-bit loaders' release-vs-sample race positive. See the [drive doc](DRIVE-ARCHITECTURE.md). |
| Disk | 1541 drive CPU + DOS ROM | Implemented | High | A separate 6502 drive computer runs whenever a 1541 ROM is loaded (251968-03); true-drive emulation decides whether LOAD is trap-served or runs the real IEC protocol. Idle wait loops are skipped, and the drive runs at the true PAL clock ratio so the drive↔C64 phase sweeps as on hardware. See the [drive doc](DRIVE-ARCHITECTURE.md). |
| Disk | 1541 VIA pair (6522) | Partial | Medium | The two 6522 VIAs cover the timer and port behavior the DOS ROM depends on. Tailored implementation rather than a generic 6522. |
| Disk | GCR read channel / spindle / sync | Partial | Medium | The head reads one raw GCR bitstream per half-track, synthesized from a sector image or taken as recorded from a raw one. Speed zones, sync marks and byte-ready signaling are modeled. The read clock restarts at every flux transition and counts cells at the density the DOS selects, so a track read at the wrong density garbles as on hardware; 18 µs without a transition reads as noise (weak bits); a raw image's per-byte speed map switches the bit rate byte by byte. A sector image's recorded errors are put back on the track: 20 (no header), 21 (no sync), 22 (no data block), 23/27 (checksum) and 29 (wrong disk ID) fail as on the original. Mechanics simplified: no head-settle or spin-up dynamics beyond the optional timers. |
| Disk | 1541 write head | Implemented | Medium | Modeled end to end: the DOS selects write mode, outgoing GCR shifts onto the track under the head, and the image takes the bytes (a raw image in place, a sector image through a decoder). `SAVE`, scratch, rename and `N:` format run through the real DOS; the write-protect sensor is honored. |
| Disk | 1571 disk images (`.d71`) | Implemented (file level) | High | Virtual-drive LOAD/SAVE, files, directory, block commands, format and export across both sides. No 1571 hardware or burst mode. |
| Disk | 1581 disk images (`.d81`) | Implemented (file level) | High | Served straight from the image by the virtual drive, since a 1541 cannot read 1581 media: `LOAD`, `SAVE`, files, directory, command channel and block commands. No 1581 drive computer, so no burst mode and no hardware-level loaders. |
| Disk | Virtual drive (TDE off) | Implemented | Medium | The KERNAL's serial primitives are answered by a DOS over the mounted image for a trap-served drive: OPEN, CHKIN, CHRIN, CLOSE, LOAD and SAVE, the directory as a channel, channel 15 status and the I, V, S, R, N, U1/U2, B-P and M-R commands. Instant, with no bus timing. See the [drive doc](DRIVE-ARCHITECTURE.md). |
| Expansion | Cartridges | Implemented | Medium-high | Hardware types, by CRT id: type 0 (generic 8K/16K/Ultimax), type 1 (Action Replay v4.x/v5/v6: ROM/RAM banking, IO1/IO2, RESET/FREEZE), type 3 (Final Cartridge III: four 16K banks, IO1/IO2 ROM mirror, `$DFFF` control, RESET/FREEZE), type 19 (Magic Desk / Domark / HES Australia), and type 32 (EasyFlash). Loadable while powered off. |
| Expansion | RAM Expansion Unit (8726 REC) | Implemented | Medium-high | 1700, 1764, 1750, 1750 XL and generic 1/4/8/16 MB units: full register file, all transfer types, autoload, fixed-address modes and the `$FF00` deferred trigger. Transfers run as a real second bus master (6510 halted, one bus access per byte, VIC DMA precedence). All 16 QuickReuTest programs pass, cycle-count checks included. |
| Expansion | Other cartridge types / user port / printer / modem | Missing | Low | Not implemented. |

## Unmodelled quirks, for the record

Deliberate simplifications behind the ratings above, with the switches that
exist for them:

- **6569 c-access fetch glitch**: on the original 6569 (not the 8565), a
  c-access transitioning between RAM and CHAR-ROM fetches latches the address
  LSB from the previous cycle and the upper bits from the current one. Not
  modeled; no known demo depends on it.
- **C64C glue-logic bank glitch and NMOS DDR bank-change delay**: the code
  paths exist (`vic2.c64cBankGlitch`, `vic2.nmosBankDelay`) but are **off by
  default**, the behavior being variant-specific and unstable on real chips.
  Toggle with `c64Vic.bankGlitch(true)` / `c64Vic.bankDelay(true)` in DevTools
  to A/B a demo that relies on one (the 8565 glitch only activates when
  `vicVariant === '8565'`).
