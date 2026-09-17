<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->

# Known Issues

The honest list of what's still rough, approximate, or out of scope in C64 READY.
Nearly everything else runs faithfully; this page covers the exceptions worth
knowing about. For what *does* work, see the [Features](FEATURES.md) overview,
and for where each chip stands against the real hardware, subsystem by
subsystem with the gaps called out, see [Component status](COMPONENT-STATUS.md).

---

## Open demo bugs

- **None at the moment.**

## Demos & games in general

Most demos and games run faithfully, but:

- **Fastloaders and copy-protected disks** need **True Drive Emulation**
  ([details below](#with-true-drive-emulation-off)).
- **NTSC-only productions won't run**: the machine is PAL (see below).
- **Multi-disk** demos: eject and load the next disk yourself when the program
  asks you to flip.
- On **slower phones and tablets**, the heaviest demos may drop visible frames
  or slow down if the device cannot keep up with the emulator core.

Found something broken? Please note the demo and where it breaks, and
[open an issue on GitHub](https://github.com/mortyeriksen/c64ready/issues).
Bug reports help push the emulation closer to real hardware.

## Hardware not emulated

- **NTSC machines**: C64 READY. targets the **PAL** C64 only. NTSC raster
  geometry and timing aren't modelled, so NTSC-only software is out of scope.
- **A second SID (stereo)**: single-SID machine only; 2SID / stereo tunes
  aren't supported.
- **Cartridge types other than the supported Generic, Action Replay, Final
  Cartridge III, Magic Desk, and EasyFlash families, user-port devices,
  printers, and modems** are not implemented.
- **A RAM Expansion Unit alongside an Action Replay, Final Cartridge III or
  EasyFlash cartridge**: all four decode addresses in `$DF00-$DFFF`, so the
  expansion answers where the cartridge expects to. Real hardware has the same
  conflict, and needs a port expander to run both at all. Every other
  cartridge type coexists with an expansion fine.

## Unmodelled hardware quirks

Deliberate simplifications inside otherwise-emulated chips, each a
model-specific glitch or corner case with negligible impact on practical
software. [Component status](COMPONENT-STATUS.md) records the specifics:

- **6569 fetch-address glitch**: an obscure video-fetch artifact of the original
  6569 (not the 8565) is not reproduced. No known demo depends on it.
- **C64C glue-logic glitches**: two variant-specific banking glitches exist in
  the code but are off by default, because real chips are unstable about them.
- **CIA serial port, physical pins**: the serial register works as software uses
  it, but the physical SP/CNT pins carry no data. That only matters for
  user-port hardware, which isn't emulated anyway.

## Unsupported file formats

The supported set is `.prg`, `.d64`, `.crt`, `.tap`, `.t64`, `.sid`, `.wav`, `.dmp`
and `.reu` (see the [Features](FEATURES.md) overview). One adjacent format is out
of scope:

- **`.g64` / raw GCR disk images**: the true drive synthesizes its GCR stream
  from `.d64` images, so copy protections that depend on custom flux-level track
  layouts won't load.

## D64 disk images

The `.d64` parser covers the standard directory, file types, BAM free-block
totals, all six image sizes and the per-sector error codes, which the drive
reproduces as real read failures. Remaining gaps, none of which affect ordinary
loading:

1. **REL files** need True Drive Emulation, where the drive's own DOS handles
   them; the built-in loader only ever returns a file's data chain.
2. **GEOS disks** are recognised and their filenames render as text, but the
   per-entry GEOS info bytes are ignored.
3. **40-track images**: tracks 36–40 count only for the three known BAM-extension
   layouts; an unrecognised one leaves those tracks alone rather than guessing.

The parser-level specifics are in [Component status](COMPONENT-STATUS.md).

## SID tunes

A `.sid` is wrapped in a program that carries a 6502 player, and the C64 runs the
tune's own driver (see [Playing a .sid tune](USER-GUIDE.md#playing-a-sid-tune)).
That puts a few limits on which tunes can run at all, and on what the player can
show while they do.

**Tunes that cannot be loaded.** The player needs somewhere to live and a screen
to draw on, so a tune is refused when it would land on top of either. Across a
264-file test collection about one in sixteen was refused, for one of these
reasons:

- **Over `$D000-$DFFF`**: the I/O registers, which is where the SID itself is.
  A tune cannot have that range without taking the chip it is playing through.
- **Over screen memory** (`$0400-$07FF`), which the player draws on.
- **No room left**: the player needs about 3 KB clear of the tune. It moves out
  of the tune's way wherever it can — including into the RAM under the BASIC
  ROM — but a few very large tunes leave nowhere to go.

A tune living at `$E000-$FFFF`, under the KERNAL ROM, does play: the driver — and
only the driver — runs with the ROM banked out for the length of each call. That
is a classic home for a game's music, so it covers a fair number of Rob Hubbard
and Martin Galway titles.

**BASIC tunes do not play.** A handful of `.sid` files are BASIC programs rather
than machine code — an `RSID` with the BASIC flag set, loading at `$0801` and
meant to be `RUN` rather than called. The player banks BASIC out for the whole
run, because it or the tune may be sitting in the RAM underneath the ROM, and it
drives a tune by calling `init` and `play` rather than handing the machine to
BASIC. Those files load and stay silent.

**The three-voice view (`F1`) is not free.** SID registers are write-only, so the
player can only show all three voices by catching the driver's writes before they
reach the chip. A driver that plays digi samples writes `$D418` many times per
frame and gets all of it collapsed into one value, and a driver that reads
`$D012` or the CIAs while playing loses its timing. Press `F1` again to go back;
the default view is always exact. Switching *into* the three-voice view starts
the song again, because what the driver set up before the switch was never seen.

**The oscilloscope is voice 3 only**, in both views — it is the one voice a
program on real hardware can read back. On a voice that arpeggiates, which is how
a SID chord is usually played, the trace legitimately changes every frame.

**Song lengths and STIL notes are not shown.** Both live in High Voltage SID
Collection data files rather than in the tune, so the player counts elapsed time
and has no total and no scrubber.

**NTSC tunes run about 17% slow**, like any NTSC software here; the player says
so on screen rather than leaving it a mystery.

## With True Drive Emulation off

TDE is on by default. Turning it off lets the built-in loader serve standard
`LOAD` requests directly from the disk image. Some fastloaders and protected
disks need the full loading sequence and may hang or refuse to load with TDE off.

With a 1541 ROM loaded, drive 8 remains on the serial bus in either mode.
`SAVE`, `OPEN`/`PRINT#`/`GET#` and the command channel still use the real drive;
the built-in loader only replaces `LOAD`. Without that ROM, these bus operations
have no drive to answer them. Drive 9 connects its real drive only when its
power and TDE switches are both on.

## Keyboard shortcuts

- **Most of the app's own controls have no keyboard shortcuts.** POWER, PAUSE,
  RESET, FULL, SIZE, RECORD, LOAD and the save-state library are mouse or touch
  only. The ones that do exist are listed under **App shortcuts** in the **KEY
  MAP** dialog.
- **While the running machine owns keyboard input, it claims Tab** as the C64's
  INST/DEL, so Tab cannot move focus from the emulator to the side panel.
  Powering off releases the keys, and the panel cards can then be rearranged
  from their grip handles with the arrow keys. Focused text fields keep their
  own keys, and the Assembly64 control and dialogs allow Tab navigation while
  the machine runs.
- **F9–F11 are C64 keys** (RUN/STOP, C=, CLR/HOME), so the browser's own F11
  fullscreen doesn't reach it while running; use the FULL button. F12 is
  RESTORE.

See the [key map and shortcut list](USER-GUIDE.md#keyboard-shortcuts).

## Audio

- On tab switch or phone standby the machine **pauses and mutes**; audio resumes
  when you return (on some mobile browsers the first tap after returning is what
  actually restarts the sound).

## VR (WebXR), experimental

- **Enter VR** in the 3D viewer needs a real headset or the desktop WebXR
  emulator; phones and iOS have no WebXR. The neon post-processing (bloom and
  grade) is skipped in VR, so the look is flatter there.

## Performance

- Performance is still being improved. On mobile and older machines the heaviest
  demos can dip below full frame rate; simpler software runs at full speed.
  Phones are also less predictable than desktops (tighter memory, thermal
  throttling, and background apps can take capacity away mid-run), so the same
  demo may be reliable on a desktop but intermittently slow on a phone.

---

Bug reports are welcome on [GitHub](https://github.com/mortyeriksen/c64ready/issues). See
also the [Getting Started](GETTING-STARTED.md) guide and the
[Features](FEATURES.md) overview.
