<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->

# Features

Everything the emulator supports, seen from the user's side, not the internals.
This is the checklist: the file formats it loads, the devices you can plug into
the control ports, the display and sound options, the save features, and how it
installs as an app. For a step-by-step walkthrough see the
[Getting Started](GETTING-STARTED.md) guide.

---

## App & platform (PWA)

- **First-visit welcome screen**: a one-time splash introduces the emulator;
  **POWER ON** boots straight into BASIC (and unlocks audio in the same
  click). Dismissing it either way means it never shows again in that
  browser; installed-app launches always skip it. Append `?SPLASH=1` to the
  URL to see it again (`?SPLASH=0` forces it off).
- **Works on a modern smart phone**: the full emulator runs in a mobile
  browser, sized to fit the screen.
- **Installable Progressive Web App**: "Add to Home Screen" from your browser
  to run it like a native app.
- **Works offline**: after the first load, the app (and its docs) run without a
  network connection.
- **Mobile touch keyboard**: tap the screen to summon your device's keyboard
  and type into the C64.
- **Mobile touch joystick**: an on-screen stick for touch devices; see
  **Control-port devices** below.
- **Background-safe**: switching apps pauses and mutes the machine; returning
  resumes cleanly with no audio blip or catch-up stutter. **RUN IN BACKGROUND**
  (Options ▸ Other, off by default) keeps the machine running instead.
- **Stay awake**: an optional screen wake-lock (Options ▸ Other ▸ **STAY AWAKE**, on
  by default) keeps your phone's display from sleeping mid-demo.
- **Persistent settings**: SID/VIC model, palette, CRT mode, autorun, cached
  ROMs, your media library, and save states all survive a reload.

## Loading & file formats

- **`.prg` programs**: single games and tools. A program is written onto a disk
  of its own in drive 8 and started for you, so it shows in the directory, loads
  again, and exports as a `.d64`. Loading one does not reset the machine.
- **`.d64` disk images**: 35-, 40- and 42-track floppies, with directory
  listing and wildcard loading, and **read/write**: programs can `SAVE` to them.
  An image's recorded error table is honoured, so a disk protected by a sector
  that must fail to read still behaves like the original. GEOS disks show
  readable filenames.
- **`.crt` cartridges**: the supported families are listed under
  **Cartridges & expansions** below.
- **`.tap` tapes**: datasette images (v0 / v1 / v2), played like real hardware.
- **`.wav` tape recordings**: a recording of a real cassette loads as an
  ordinary tape (and any tape downloads as one).
- **`.dmp` tape dumps**: a DC2N's record of a cassette, taken at the port,
  loads as an ordinary tape.
- **`.reu` expansion-RAM images**: load a RAM Expansion Unit's contents, and
  save them back out.
- **Drag-and-drop**: drop any supported file on the screen and it goes to the
  right slot automatically.
- **LOAD ANY and file pickers**: one button takes any supported file and works
  out what to do with it; each media card also has its own load button.
- **LOAD library**: everything you open is cached in the browser and
  re-loadable from a searchable list, with import/export of the whole library.
- **Auto-run**: programs start themselves after loading (toggleable); disk
  loads type the `LOAD`/`RUN` commands for you and wait until they finish.
- **Insert while powered off**: disks, tapes, and cartridges can be attached
  before power-on.

## Control-port devices

Each of the two ports is assignable independently, with a **SWAP PORTS** button:

- **Digital joystick** via a connected **gamepad** (per-port gamepad selection).
- **Touch Joystick**: touch-only eight-way stick with two overlay buttons;
  **A** is fire and **B** uses the standard second-button UP-line convention.
- **Key Joystick 1 & 2**: two independent keyboard-driven sticks (no gamepad
  needed), either assignable to either port so two people can share the
  keyboard. **Key Joystick 1** = arrow keys + **K** / **L** to fire; **Key
  Joystick 2** = **WASD** + **C** / **V** to fire. Every key is remappable:
  click "redefine" under the port.
- **Mouse (1351)**: proportional GEOS-style mouse (pointer-lock).
- **Mouse (NEOS)**: the NEOS nibble-strobe mouse.
- **Paddle**: mouse-driven paddle pair for paddle games.
- **None**: an empty port.
- **Light pen**: wired to the port so "stable raster via light pen" software
  works.

## Keyboard & input

- **Full C64 keyboard** mapped to your physical keyboard.
- **Host-friendly remaps** for the C64-only keys: `TAB` = INST/DEL,
  `F9` = RUN/STOP, `F10` = Commodore key, `F11` = CLR/HOME, `F12` = RESTORE.
- **On-screen key map**: a clickable keyboard for finding symbols.
- **Paste**: type clipboard text or a BASIC listing straight into the machine.
- **PETSCII directory listings**: disk directories render through the real
  character ROM, so custom cracker-art charsets display correctly.
- **App shortcuts**: **Cmd+Shift** on a Mac, **Ctrl+Shift** on Windows and Linux
  (both work everywhere) for paste, the CRT look, the VIBES zoom and Retro
  Vibes Studio mode; the **KEY MAP** dialog lists them. Only those letters are
  borrowed; **Ctrl** on its own is still the C64's.

## Disk drives

- **Two drives**: device **8** and device **9**.
- **Directory artwork viewer**: every inserted disk lists its files in the drive
  panel, and a **🔍** button reopens the listing enlarged in its own window,
  just the filenames, so the PETSCII artwork many demos hide in their directory
  reads clearly. The names are tinted as a **C64 raster rainbow**, a continuous
  colour sweep through the hues of your selected palette (see
  [Directory zoom](USER-GUIDE.md#directory-zoom)).
- **True Drive Emulation (TDE)**, on by default: a real emulated 1541 (its own
  CPU + DOS) for fastloaders, cracked intros, demos, and copy-protected disks.
- **Fast loading**: with TDE off, an instant built-in shortcut load for plain
  games.
- **Disk writing**: the drive writes back to the `.d64`: `SAVE`, scratch, and
  rename all run through the real 1541 DOS. Modified disks auto-save to your
  browser Library, and the directory listing updates itself as files change.
- **Blank & format**: insert a fresh blank (unformatted) disk, then format it
  from the panel or with BASIC `N:name,id`, ready to save to.
- **Export**: download the current disk, with your changes, as a `.d64` file
  (enabled once there's something to save).
- **Write-protect toggle**: lock a disk against writes (or unlock it) per drive;
  loaded disks start protected so nothing is changed by accident.
- **Eject** control per drive.
- **Drive sounds**: optional synthesized motor hum and head-stepper clicks.

## Datasette (tape)

- **`.tap` playback** driven cycle-accurately like a real 1530 Datasette, with
  the full five-key transport (**REC / PLAY / REW / FF / STOP**) plus a
  rewind-to-start shortcut, a three-digit counter, and hardware-true winding
  (the motor is switched by the C64, so the deck only moves when the machine
  asks it to).
- **Tape recording.** `SAVE` writes real pulses, measured off the CPU's cassette
  write pin at cycle resolution, so both the KERNAL's saver and cycle-timed
  turbo savers produce loadable tapes. Insert a **BLANK** tape, press **REC**,
  and download the result as a `.tap`; recordings are also kept in the Library.
- **Write-protect tabs** that block the RECORD key the way a real cassette does.
- **Listen to the tape.** A speaker button on the deck plays the signal the head
  is reading. A C64 tape's data is audible square-wave pulses, so what you hear
  is the loader itself, not an effect. A SAVE plays too, as it is written.
- **Watch the tape.** Beside it, a scope draws that same signal: the waveform
  under the head, pulse for pulse, whether or not the sound is on.
- **See what is on a tape.** A `.tap` carries no directory, so the tape is read
  the way a C64 reads it and the programs on it are listed: a row per file with
  its format, size and start time; a click winds the tape to that file. It reads
  KERNAL tapes and the turbo formats it knows: Turbo Tape 64 (which covers most
  of the home turbo programs), GRL-Supertape, and six commercial loaders.
  Damaged files are struck through, and a line under the list says what is
  wrong and what was mended.
- **`.wav` in and out.** Load a recording of a real cassette and the pulses are
  recovered into an ordinary tape; download any tape as a `.wav` that loads on
  real hardware. A DC2N `.dmp` loads the same way, with no recovering to do.
- **Tape preservation.** A recording of a worn cassette is recovered, not just
  played: several readings of the signal are compared, a file is mended only
  when the tape itself proves the fix, and every proved file is written back at
  clean pulse widths. Nothing is invented: a file that cannot be proved is left
  as it is and marked in the listing (the method is in the
  [user guide](USER-GUIDE.md#datasette)). On the eight worn cassettes this was
  built against, 121 of 130 programs load, up from 66. Recordings are read in
  pieces, so a long side fits in a phone's memory.

## Cartridges & expansions

- **`.crt` support** for generic (8K/16K/Ultimax), Action Replay v4.x/v5/v6,
  Final Cartridge III, Magic Desk / Domark / HES, and EasyFlash bank-switched
  carts, loadable even while powered off. Action Replay and Final Cartridge
  III expose their physical **RESET** and **FREEZE** buttons in the Cartridge
  card.
- **RAM Expansion Unit**: a switch in the RAM Expansion card fits a 1700
  (128 KB), 1764 (256 KB), 1750 (512 KB), 1750 XL (2 MB) or a generic 1, 4, 8
  or 16 MB unit, with an activity lamp beside it. Expansion RAM can be filled
  from a `.reu` image, saved back out to one, or wiped, and it travels with
  save states. Nothing is fitted until you switch it on.

## Video & display

- **CRT display modes**: a single button cycles: scanlines → phosphor-mask
  colour tube → black-and-white tube → bright arcade → tube with a rolling
  mains-hum bar → off.
- **Picture size**: 1X / 2X / 2.5X / 3X (each a whole multiple of the C64's
  own 384x272 screen so no scaling step softens a pixel), plus **MAX** to fill
  the width and **fullscreen**; sizes too big for the window are left out of
  the cycle. The picture is never stretched: it keeps the C64's own proportions
  at any size, window shape or CRT look.
- **VIC-II model**: switch between **6569** (original PAL) and **8565** (C64C).
- **Colour palette**: **Colodore** (modern, saturated) or **Pepto** (classic
  2001 measurements).
- **FPS and per-frame timer** readout in the header.

## Sound

- **SID model**: switch between **6581** (original) and **8580** (later C64C).
- **Three-voice SID** with filter and `$D418` digi playback (sampled sound).
- **reSID engine**: Dag Lem's transistor-level reSID model (oscillators,
  envelopes, analog filter and DACs), verified against VICE. It runs compiled to
  WebAssembly by default, with a reSID JS alternative that sounds identical.
- **Master volume**: a draggable output level on a perceptual (audio-taper)
  scale, defaulting to 70% for headroom. Combined with **mute** into one control
  (a pixel-art speaker toggle beside the slider); muting keeps playback running
  silently, and raising the level un-mutes.

## Save, resume & state

- **Pause / resume**: freeze and continue exactly where you were.
- **Hard reset**: clean power-cycle-equivalent restart.
- **Save states**: freeze the whole machine (RAM, every chip, and the inserted
  disk/tape/cartridge) into named, thumbnailed slots, rename them, and restore
  them later from an alphabetical list.
- **Export / import state files**: move a snapshot to another browser or
  machine.

## ROMs

- **Bring-your-own ROMs**: supply KERNAL, BASIC, CHARGEN (and an optional 1541
  ROM for TDE) by **fetching** them into the browser or **uploading** them.
- **Cached in the browser**: provide them once; they auto-restore on later
  visits. A **CLEAR** button wipes the cache.

## Extras & conveniences

- **Retro Vibes 3D viewer**: a full-screen 3D scene of the C64 whose on-screen
  TV mirrors the live emulator picture, with several switchable lighting/backdrop
  moods. Opened with the **VIBES** button in Controls; **Esc** / ✕ returns.
  **Cmd+Shift+X** / **Ctrl+Shift+X** is Studio mode, stripping the scene to the
  machine and the C64 READY. logo for screenshots and video (see
  [Retro Vibes](USER-GUIDE.md#retro-vibes)).
- **VR (WebXR), experimental**: on a device with a headset the 3D viewer offers
  an **🥽 Enter VR** mode: the scene in stereo with head tracking. Its limits
  are noted in [Known Issues](KNOWN-ISSUES.md#vr-webxr-experimental).
- **Record to MP4**: capture the whole browser window, with sound, from the
  **● RECORD** button in Controls: everything on screen, fullscreen and Retro
  Vibes included, with the emulator's own audio, saved as `c64ready-<date>.mp4`.
  Browser support and the resolution setting are in the
  [user guide](USER-GUIDE.md#recording).
- **Rearrangeable side panel**: drag the control cards into whatever order and
  columns suit you, hide the ones you never use, and the browser remembers the
  arrangement; the handles work from the keyboard too, and **Options ▸ Display**
  resets everything (see
  [Rearranging the interface](USER-GUIDE.md#rearranging-the-interface)).
- **VIBES button demo**: a small pixel demo runs inside the VIBES button itself;
  **Cmd+Shift+Z** / **Ctrl+Shift+Z** zooms it to ten times the size. Switch it off in
  Options ▸ Other.
- **Powered-off attract animation**: an animated idle screen (toggleable). It
  bows out by itself where it would cost more than it is worth: under
  `prefers-reduced-motion`, on software WebGL, and on any GPU that cannot hold
  the frame rate; the static boot hint takes over.
- **About**: a short in-app project note, with full specifications, source
  material, and credits in the docs.

## Command line (c64rdy)

The same tape and disk engine with a terminal in front of it. `npx c64rdy`
converts, inspects, repairs and runs cassettes, cartridges and disks in
batches: a shelf of `.wav` recordings into mended `.tap` files in one command,
formats converted in every honest direction, or every program on a tape side
booted headless and tiled into one captioned sheet. Node 20.19 or newer,
no dependencies; the [CLI guide](USER-GUIDE-CLI.md) walks every command.

---

New here? Start with the [Getting Started](GETTING-STARTED.md) guide, or dive
into the [Architecture](ARCHITECTURE.md) for how it all works. For what's out
of scope or still rough, see [Known Issues](KNOWN-ISSUES.md).
