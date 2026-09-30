<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->

# Known Issues

What is missing, approximate or still rough in C64 READY. For what works, see
the [Features](FEATURES.md) overview; for how each chip stands against the real
hardware, see [Component status](COMPONENT-STATUS.md).

---

## Open demo bugs

- **None at the moment.**

## Demos & games in general

- **NTSC-only productions won't run**: the machine is PAL.
- **Multi-disk** demos: eject and load the next disk yourself when the program
  asks you to flip.
- On **slower phones and tablets**, the heaviest demos may drop visible frames
  or slow down.

Found something broken? Note the demo and where it breaks, and
[open an issue on GitHub](https://github.com/mortyeriksen/c64ready/issues).

## Hardware not emulated

- **NTSC machines**: only the PAL C64 is modelled. NTSC raster geometry and
  timing are out of scope, so NTSC-only software is too.
- **Three-SID tunes** are not supported. Two-SID tunes play in Safe view only;
  their Voices view is unavailable. Expansion addresses `$DE00-$DFFF` need an
  empty cartridge slot, and `$DF00-$DFFF` cannot share an attached REU.
- **Cartridge families beyond the five in the Features list, user-port
  devices, printers and modems** are not implemented.
- **A RAM Expansion Unit alongside an Action Replay, Final Cartridge III or
  EasyFlash cartridge**: all four decode `$DF00-$DFFF`, so the expansion answers
  where the cartridge expects to. Real hardware has the same conflict and needs
  a port expander to run both.

## Unmodelled hardware quirks

Deliberate simplifications inside otherwise-emulated chips, each a
model-specific glitch or corner case with negligible impact on practical
software:

- **6569 fetch-address glitch**: an obscure video-fetch artifact of the original
  6569 (not the 8565) is not reproduced. No known demo depends on it.
- **C64C glue-logic glitches**: two variant-specific banking glitches exist in
  the code but are off by default, because real chips are unstable about them.
- **CIA serial port, physical pins**: the serial register works as software uses
  it, but the physical SP/CNT pins carry no data. That only matters for
  user-port hardware, which is not emulated either.

## File formats

- **`.d71`, `.d81` and `.p00`** download from the Assembly64 browser but do not
  load.
- **`.nib`**, the uncompressed nibbler dump, does not load; only its
  compressed form, `.nbz`, does. The CLI's `info` reads either.

## G64 disk images

- **Formatting a `.g64`**: the panel's FORMAT replaces it with a standard blank
  `.d64`.
- **Writing where nothing was recorded**: a half-track the image never
  recorded has no bytes to write into, so what the DOS writes there is lost. A
  `N:` format of an image with gaps leaves the gaps empty. Every track of a
  normal image is recorded, so this only shows on partial dumps.

## D64 disk images

None of these affect ordinary loading:

1. **REL files** need True Drive Emulation, where the drive's own DOS handles
   them; the built-in loader only ever returns a file's data chain.
2. **GEOS disks**: filenames render as text, but the per-entry GEOS info bytes
   are ignored.
3. **40-track images**: tracks 36-40 count only for the three known
   BAM-extension layouts; an unrecognised one leaves those tracks alone rather
   than guessing.

## SID tunes

A `.sid` runs inside a program that carries a 6502 player, which sets these
limits (see [Playing a .sid tune](USER-GUIDE.md#playing-a-sid-tune)).

**Tunes that are refused.** The player needs somewhere to live and a screen to
draw on. Across a 264-file test collection about one in sixteen was refused,
for one of these reasons:

- **Over `$D000-$DFFF`**: the I/O registers, where the SID itself is.
- **Over screen memory** (`$0400-$07FF`), which the player draws on.
- **No room left**: the player needs about 3 KB clear of the tune, and a few
  very large tunes leave nowhere to go, even under the BASIC ROM.

**BASIC tunes stay silent.** A handful of `.sid` files are BASIC programs
rather than machine code (an `RSID` with the BASIC flag set, meant to be `RUN`).
The player banks BASIC out and drives a tune through `init` and `play`, so
those files load and produce nothing.

**The three-voice view (`F1`) costs accuracy.** SID registers are write-only,
so the view catches the driver's writes before they reach the chip. A driver
that plays digi samples gets its many `$D418` writes per frame collapsed into
one value, and a driver that reads `$D012` or the CIAs while playing loses its
timing. The default view is always exact. Switching into the three-voice view
restarts the song, because what the driver set up before the switch was never
seen.

**The oscilloscope shows voice 3 only**, in both views: it is the one voice a
program on real hardware can read back.

**Song lengths and STIL notes are not shown.** Both live in High Voltage SID
Collection data files rather than in the tune, so there is no total and no
scrubber.

**NTSC tunes run about 17% slow**, like any NTSC software here; the player says
so on screen.

## Display

- **CRT presets ripple.** The scanline and phosphor overlays are CSS gradients
  whose period is a fraction of the picture rather than a whole raster line, so
  at every picture size, and on high-density screens, they beat against the
  emulated lines and the device pixels: bands of uneven darkness that do not
  line up with the picture. TUBE, B&W and HUM also blur the whole picture
  rather than shaping the beam.

## Keyboard shortcuts

- **Most of the app's own controls have no keyboard shortcuts.** POWER, PAUSE,
  RESET, FULL, SIZE, RECORD, LOAD and the save-state library are mouse or touch
  only. The ones that exist are listed under **App shortcuts** in the **KEY
  MAP** dialog.
- **While the running machine owns keyboard input, it claims Tab** as the C64's
  INST/DEL, so Tab cannot move focus from the emulator to the side panel.
  Powering off releases the keys. Focused text fields keep their own keys, and
  the Assembly64 control and dialogs allow Tab navigation while the machine
  runs.
- **F9-F11 are C64 keys** (RUN/STOP, C=, CLR/HOME), so the browser's own F11
  fullscreen does not reach it while running; use the FULL button. F12 is
  RESTORE.

See the [key map and shortcut list](USER-GUIDE.md#keyboard-shortcuts).

## Audio

- On tab switch or phone standby the machine **pauses and mutes**; audio resumes
  when you return, and on some mobile browsers only on the first tap after
  returning.

## VR (WebXR), experimental

- **Enter VR** in the 3D viewer needs a real headset or the desktop WebXR
  emulator; phones and iOS have no WebXR. The neon post-processing (bloom and
  grade) is skipped in VR, so the look is flatter there.

## Performance

- On mobile and older machines the heaviest demos can dip below full frame
  rate. Phones are also less predictable than desktops (tighter memory, thermal
  throttling, background apps), so the same demo may be reliable on a desktop
  and intermittently slow on a phone.

---

Bug reports are welcome on [GitHub](https://github.com/mortyeriksen/c64ready/issues). See
also the [Getting Started](GETTING-STARTED.md) guide and the
[Features](FEATURES.md) overview.
