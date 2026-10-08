<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->
<!-- description: How C64 READY. and VICE differ in compatibility, portability and features, and which of the two suits what you want to do. -->

# C64 READY. and VICE

[VICE](https://vice-emu.sourceforge.io/), the Versatile Commodore Emulator,
has been around since 1993. A volunteer team has kept it going for more than
thirty years. It is free, open source and runs on Windows, macOS and Linux.
It emulates nearly the whole Commodore 8-bit family, not just the C64, and
its accurate C64 emulator, `x64sc`, is the reference other C64 emulators are
measured against.

C64 READY. is younger and narrower. It is one machine, the PAL Commodore 64
with a 1541 drive, running in a web browser on a desktop or a phone. Nothing
needs installing, it can be added to a home screen as an app, and it works
offline.

C64 READY. owes a lot to VICE. Its SID sound is reSID as VICE 3.10 ships it.
The VICE test programs are its test suite, and a headless `x64sc` is what it
is checked against whenever the two disagree. VICE is the yardstick here, not
the rival.

This page is meant to help you pick a tool for a task. Both are free, they
read the same files, and many people will want both.

![The same moment of the Raster Time demo by Genesis Project in both emulators: on the left C64 READY. in a browser with its control panels, on the right VICE's picture of the C64 screen beside its Tape menu, a yellow lightning bolt between them.](/guide/c64ready-and-vice.webp)

## In short

**Pick VICE** when you need NTSC, a C128, VIC-20, PET or Plus/4, a
machine-language monitor and debugger, warp speed, a printer, RS-232, IDE64
or network cartridge, a less common cartridge type, or three decades of proven
compatibility.

**Pick C64 READY.** when you want nothing to install, a C64 on a phone or
tablet, an app that runs offline, worn cassettes recovered from `.wav`
recordings, demos found and started from the Assembly64 catalog, or the five Retro
Vibes 3D scenes.

---

## Side by side

The VICE column describes VICE 3.10 (December 2025) from its manual and
release notes. The C64 READY. column comes from the
[Feature list](FEATURES.md), [Component status](COMPONENT-STATUS.md) and
[Known issues](KNOWN-ISSUES.md).

### Compatibility and accuracy

| | VICE | C64 READY. |
| --- | --- | --- |
| Machines | C64, C64 DTV, C128, VIC-20, nearly every PET, Plus/4, CBM-II, and a C64 with a SuperCPU | The C64 |
| C64 models | PAL, NTSC, old NTSC, Drean, SX-64, C64 GS, the Japanese C64, the MAX Machine and more | PAL breadbin or C64C, set by the VIC-II and SID choices |
| NTSC | Yes | No. NTSC-only software does not run |
| Timing | `x64sc` is cycle based, with a pixel-accurate VIC-II | Cycle by cycle on one master clock, VIC-II pixel by pixel |
| VIC-II chips | 6569, 8565, 6567, 6572 and other revisions | 6569 or 8565 |
| SID chips | 6581 or 8580 through reSID or FastSID, or a real SID chip over USB and other interfaces | 6581 or 8580 through reSID, the same code VICE 3.10 ships, compiled to WebAssembly |
| CIA chips | 6526 or 6526A, per CIA | One generic 6526 |
| 1541 drive | True drive emulation | True drive emulation |
| How it is checked | Thirty years of real-world use, and the VICE test programs, which are maintained alongside it | The VICE test programs, comparison with headless `x64sc`, and a suite of labelled unit tests. Remaining differences are listed in [Component status](COMPONENT-STATUS.md) |
| Known gaps for the C64 | Few, tracked in the VICE bug tracker | NTSC, user-port devices, printers, modems, and cartridge types beyond the families it supports, listed in [Known issues](KNOWN-ISSUES.md) |

### Portability and installation

| | VICE | C64 READY. |
| --- | --- | --- |
| Desktop | Windows and macOS downloads, and Linux and other Unix systems from source or a distribution's package, with a GTK3 or SDL2 interface | A modern browser on any desktop system |
| Phones and tablets | No official builds since VICE 3.0. Third-party apps such as C64.emu use parts of VICE | Runs in the phone's browser, with a touch keyboard and a touch joystick |
| Installing | Unpack a zip on Windows, open a disk image on macOS, and on Linux use your distribution's package or build from source | Nothing to install. It can be added to a home screen or desktop as an app |
| Offline | Yes, it is a desktop program | Yes, after the first visit |
| ROMs | Included in the official downloads | You supply them once and the browser keeps them. The setup can read them from a VICE folder |
| Updates | A new release about once a year, usually on December 24 | In place: the app offers a reload when a new version is ready |
| Licence and source | GPL 2 or later, source on SourceForge with a GitHub mirror | GPL 3 or later, source on GitHub |
| Your files | Stay on your computer | Stay in the browser's own storage, never uploaded |

### Disk drives and disk images

| | VICE | C64 READY. |
| --- | --- | --- |
| Drive models | 1541, 1541-II, 1570, 1571, 1581, CMD FD and HD, and IEEE-488 drives such as the 4040 and 8050 | The 1541. 1571 and 1581 disks are served at file level, without the drive's own computer |
| Drives at once | Four, units 8 to 11 | Two, units 8 and 9 |
| Disk images | D64, D67, D71, D81, D80, D82, D90, G64, G71, P64 and the CMD formats | D64 (35, 40 or 42 tracks), G64, D71, D81, and the Preservation Project's NBZ dumps |
| A folder on your computer as a drive | Yes, its files load and save as plain files | No |
| Writing to disks | Yes | Yes, with changes kept in the browser's library and exported as an image |
| Software that runs its own code in a 1571 or 1581 | Yes | No |

### Tape

| | VICE | C64 READY. |
| --- | --- | --- |
| TAP images | Read and write | Read and write (versions 0, 1 and 2) |
| T64 archives | Yes | Yes |
| Recordings of real cassettes | Not directly. Convert a `.wav` first with a tool such as Audiotap | Loads `.wav` recordings and DC2N `.dmp` dumps, and saves any tape as a `.wav` |
| Worn tapes | Played as they are | Several readings compared, files mended only where the tape proves the fix. See [Tape restoration](TAPE-RESTORATION.md) |

### Seeing what is in a file

| | VICE | C64 READY. |
| --- | --- | --- |
| Disks | A directory preview when you attach an image, and `c1541` to list, extract and write files | The directory in the drive panel, drawn in the C64's own characters, with a click to load a file and an enlarged view for PETSCII art. `c64rdy dir` lists it in a terminal |
| Tapes | The attach dialog previews the files on a `.tap` | The files on a `.tap`, `.wav` or `.dmp`, read in KERNAL and eight turbo formats, with damaged files marked and a click to wind to one. A speaker and a scope on the deck let you hear and watch the signal |
| T64 archives | Listed when you attach one | You pick which program loads |
| Cartridges | `cartconv` shows a CRT's type and banks | The cartridge's name on the Cartridge card |
| SID tunes | VSID shows the tune's name, author and release | The player screen shows the title, author and year, a scope and all three voices |

### Cartridges and expansions

| | VICE | C64 READY. |
| --- | --- | --- |
| Cartridge types | Close to ninety in its CRT format, from freezers and fast loaders to games and utilities | The main families: plain 8K, 16K and Ultimax cartridges, the Action Replay and Final Cartridge III freezers, Magic Desk, Domark and HES Australia, and EasyFlash |
| Freezer buttons | Yes | Yes, for Action Replay and Final Cartridge III |
| RAM expansions | REU, GeoRAM, RAMLink and others | REU, from 128 KB to 16 MB |
| Storage and network | IDE64, MMC64, MMC Replay, Lt. Kernal, RR-Net and other Ethernet cartridges | No |
| Sound and MIDI | SFX Sound Expander, DigiMAX, several MIDI interfaces | A second SID only |

### Input and peripherals

| | VICE | C64 READY. |
| --- | --- | --- |
| Keyboard | Symbolic or positional keymaps, for thirteen host layouts from American to Turkish | Follows your own layout with nothing to set: a symbol you type, such as `*`, `@` or `:`, comes out as that character on the C64 |
| Joystick and gamepad | Yes. Keyboard joysticks are remapped in the menus, gamepads by editing a mapping file in the GTK3 build | Yes, a gamepad per port and two keyboard sticks, all remappable |
| Touch screens | No | An on-screen stick and the device's own keyboard |
| Mice | 1351, NEOS, Amiga, Atari ST, CX22 trackball, SmartMouse, Micromys | 1351 and NEOS |
| Paddles, light pens and guns | Paddles, KoalaPad, several light pens and light guns | Paddles driven by the mouse. The light-pen line is wired, with no pointer device for it |
| User port | RS-232, joystick adapters, DigiMAX and more | No |
| Printers | MPS-801, 802 and 803, the 1520 plotter and others, to text or picture files | No |
| RS-232 and modems | RS-232 on the user port or an ACIA cartridge such as Swiftlink, linked to a serial port, a file or a network socket. A modem means a real one or the external tcpser tool | No |

### Display and sound

| | VICE | C64 READY. |
| --- | --- | --- |
| CRT look | CRT emulation with adjustable scanlines, blur and colour | Six shader looks, from scanlines to a mains-hum bar, each with its own sliders |
| Palettes | Many, plus colour adjustment | Colodore and Pepto |
| SID chips | Up to eight in total | Up to two in total, in stereo or mono |
| Recording | Screenshots, sound to WAV, MP3, FLAC and other formats, video as lossless ZMBV or through an external FFmpeg | The whole window with sound, as MP4 |
| Appearance | The system GTK theme on Linux, with no theme setting of its own | Six built-in themes or your own, in dark or light |

### Tools for power users and developers

| | VICE | C64 READY. |
| --- | --- | --- |
| Monitor and debugger | A built-in machine-language monitor, plus remote and binary monitors that IDEs and debuggers connect to | No |
| Warp speed | Yes | No |
| Snapshots | Yes, plus recording and replaying a session's input | Named save states with thumbnails, which export to a file |
| Launch options | Almost every setting is also a command-line option, with autostart and scripted runs | None. The `c64rdy` command line boots programs headless and takes screenshots |
| Playing over a network | Netplay, marked experimental | No |
| Companion tools | `c1541` for disk images, `petcat` for BASIC listings and `cartconv` for cartridges | [`c64rdy`](GUIDE-CLI.md): tape recovery and conversion, disk and cartridge conversion, SID tunes to PRG or WAV, batch runs with contact sheets |

### Extras

| | VICE | C64 READY. |
| --- | --- | --- |
| Finding software | You bring your own files | The Assembly64 catalog is built in: search, charts, load in one click |
| Opening any file | Smart attach works out what a file is, and dropping one on the window starts it | LOAD ANY works out what a file is, and dropping one on the screen puts it in the right slot |
| Library | Your own folders, plus a fliplist of disk images to swap between | Everything you open, kept in the browser and searchable |
| SID music | VSID, a dedicated player | A `.sid` plays on the emulated C64 in its own player screen |
| 3D and VR | No | Retro Vibes: the machine in five 3D scenes, from an 80s bedroom to a synthwave neon grid, with experimental VR |

### The projects

| | VICE | C64 READY. |
| --- | --- | --- |
| Started | 1993 | 2026 (first release in July) |
| Made by | A volunteer team, with many contributors over the years | One author |
| Documentation | A full reference manual | A [user guide](USER-GUIDE.md), plus architecture notes chip by chip |
| Reporting bugs | The VICE bug tracker on SourceForge | [GitHub issues](https://github.com/mortyeriksen/c64ready/issues) |

---

## Using them together

The two read and write the same formats. A `.d64`, `.g64` or `.tap` saved in
one loads in the other, and so does a tape that `c64rdy` has mended from a
recording. A VICE folder holds the ROMs C64 READY. needs, and the ROM setup
can read them from there.

Thank you to the VICE team. The people and references C64 READY. builds on
are credited in [Specifications](SPECIFICATIONS.md).
