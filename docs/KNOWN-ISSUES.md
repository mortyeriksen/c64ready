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

- **Fastloaders and copy-protected disks** need **True Drive Emulation (TDE)**
  turned on and a 1541 ROM loaded. With the fast built-in loader they may hang
  or refuse to load.
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

Deliberate simplifications inside otherwise-emulated chips. These are
model-specific glitches or corner cases with negligible impact on practical
software. [Component status](COMPONENT-STATUS.md) rates each subsystem in
full; what follows is the subset worth naming:

- **6569 fetch-address glitch**: on the original 6569 (not 8565), a c-access
  transitioning between RAM and CHAR-ROM fetches latches the address LSB from the
  previous cycle and the upper bits from the current cycle. No known demo depends
  on it.
- **C64C glue-logic bank glitch + NMOS DDR bank-change delay**: the code paths
  exist (`vic2.c64cBankGlitch`, `vic2.nmosBankDelay`) but are **off by default**
  because the behavior is variant-specific and unstable on real chips. Toggle via
  `c64Vic.bankGlitch(true)` / `c64Vic.bankDelay(true)` in DevTools to A/B a demo
  that relies on it (the 8565 glitch only activates when `vicVariant === '8565'`).
- **CIA serial shift register (SDR), physical pins and input mode**: output-mode
  shifting (SDR write → 16 Timer A underflows → SP IRQ on ICR bit 3) is modelled,
  but the physical SP/CNT pins carry no serial data and input-mode shifting isn't
  implemented. These only matter for user-port hardware; the IEC bus is bit-banged
  on CIA2 Port A and is unaffected.

## Unsupported file formats

The supported set is `.prg`, `.d64`, `.crt`, `.tap`, `.wav`, `.dmp` and `.reu` (see the
[Features](FEATURES.md) overview). Two adjacent formats are out of scope:

- **`.g64` / raw GCR disk images**: the true drive synthesizes its GCR stream
  from `.d64` images, so copy protections that depend on custom flux-level track
  layouts won't load.
- **`.t64` tape archives**: only real `.tap` images play; convert `.t64`
  programs to `.prg` first.

## D64 disk images

The `.d64` parser (`src/d64.js`) covers the standard directory, file types
(including DEL/scratched entries), BAM free-block totals, all six image-size
variants (35-, 40- and 42-track, each with or without an error table), and the
per-sector error codes, which the drive reproduces as real read failures.
Remaining gaps:

1. **REL files**: the side-sector track/sector (`+$15/$16`) and record length
   (`+$17`) aren't parsed. With TDE on the drive's own DOS handles relative
   files; the built-in loader only ever returns the data chain.
2. **GEOS files**: a GEOS disk is recognised (its ASCII names render as text,
   and its VLIR `USR` files aren't offered as loadable), but the per-entry GEOS
   info bytes (`+$18–$1D`) aren't parsed.
3. **40-track BAM extension**: tracks 36–40 count only when the image uses one
   of the three known layouts (DolphinDOS `$AC`, SpeedDOS `$C0`, PrologicDOS
   `$90`). An unrecognised one leaves those tracks alone rather than guessing.

## With True Drive Emulation off

TDE is on by default and the real 1541 ROM then answers everything. With it off
the built-in loader is **LOAD only**. No drive sits on the serial bus, so SAVE,
`OPEN`/`PRINT#`/`GET#` and the command channel (`N:`, `S:`, `R:`, block and
memory commands) report DEVICE NOT PRESENT. The directory and LOAD by name,
wildcards included, work as usual.

## Keyboard shortcuts

- **Most of the app's own controls have no keyboard shortcuts.** POWER, PAUSE,
  RESET, FULL, SIZE, RECORD, LOAD and the save-state library are mouse or touch
  only. The ones that do exist are listed under **App shortcuts** in the **KEY
  MAP** dialog.
- **While the machine is running it claims the keyboard, Tab included** (Tab is
  the C64's INST/DEL), so focus can't be moved to the side panel by keyboard and
  the controls can't be reached without a pointer. Powering off releases the keys,
  and the panel cards can then be rearranged from their grip handles with the
  arrow keys. A focused text field keeps its own keys, so the ROM URL boxes still
  work.
- **F9–F11 are C64 keys** (RUN/STOP, C=, CLR/HOME), so the browser's own F11
  fullscreen doesn't reach it while running; use the FULL button. F12 is
  RESTORE.

See the [key map and shortcut list](USER-GUIDE.md#keyboard-shortcuts).

## Audio

- The SID engine is the reSID transistor-level model, verified against VICE.
  Options ▸ Sound offers two engines: reSID WASM (default, falls back to reSID
  JS if WebAssembly can't start) and reSID JS (same sound, more CPU). If
  something sounds off, try switching engine and please report it.
- On tab switch or phone standby the machine **pauses and mutes**; audio resumes
  when you return (on some mobile browsers the first tap after returning is what
  actually restarts the sound).

## Performance

- Performance is still being improved. On mobile and older machines the heaviest
  demos can dip below full frame rate; simpler software runs at full speed.
- Mobile devices are inherently less predictable than desktops: they usually have
  tighter memory limits, smaller JavaScript heaps, more aggressive background
  process pressure, and thermal throttling. Other apps, browser tabs, or system
  services can take capacity away mid-run, so the same demo may be reliable on a
  desktop but intermittently slow or stutter on a phone.

---

Bug reports are welcome on [GitHub](https://github.com/mortyeriksen/c64ready/issues). See
also the [Getting Started](GETTING-STARTED.md) guide and the
[Features](FEATURES.md) overview.
