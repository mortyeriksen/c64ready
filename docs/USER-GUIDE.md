<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->

# User Guide

A tour of every panel, dialog and button in **C64 READY.** For a walkthrough
from blank screen to running demo, start with
[Getting Started](GETTING-STARTED.md); for what the machine can do, see
[Features](FEATURES.md).

![The C64 READY. interface: the CRT display on the left showing the blue BASIC boot screen, with the side panel of controls on the right.](/guide/overview.webp)

Three regions: the **header** (branding and links), the **display** (the
emulated CRT), and the **side panel** of control cards.

The panel is two columns at the default **2X**, narrows as the picture grows,
and is a single column at **MAX**. On a phone it moves below the screen. Most of
it stays greyed out until the ROMs load and you power on.

The same interface with a demo running:

![The interface running the raster_time demo: dense, colourful rasterbars beneath the scrolling logo, while a disk sits in drive 8.](/guide/overview-running.webp)

---

## Header

![The header: the C64 READY. wordmark on the left, and ABOUT, DOCS, GitHub, YouTube and Facebook buttons on the right.](/guide/header.webp)

| Control | What it does |
| --- | --- |
| **C64 READY.** wordmark | The logo. Purely decorative. |
| **ABOUT** | Opens the About panel: what the emulator is, how the project started, the current known-issues, and credits. |
| **DOCS** | Opens this documentation site. |
| **GitHub** | The full source, on GitHub. Desktop only; on a phone the same link is in the About panel. |
| **YouTube** | The C64 READY. channel. Desktop only, likewise. |
| **Facebook** | The C64 READY. page on Facebook. Desktop only, likewise. |

> **Install as an app.** On supported browsers a small *"Install C64 READY."*
> card appears at the top of the side panel. Installing gives you an offline,
> app-like launcher. Dismiss it with its **✕** and it won't return.

---

## Display

The screen is a live canvas showing the C64's video output, framed by a CRT
bezel (styled by the **CRT** effect in Options).

**The picture is never stretched.** It keeps the C64's own 384x272 proportions
at every size, window shape and CRT look. A narrower window makes it smaller,
never squashed, and the bezel shrinks with it. On a phone held sideways a large
size may be taller than the screen: scroll, or pick a smaller size. **⛶ FULL**
centres the picture on the whole screen with bars around it.

- **Click the screen** to give it keyboard focus, needed before typing or
  before a game that polls the keyboard will see your keys.
- **Drag & drop** a `.PRG`, `.D64`, `.CRT`, `.TAP`, `.WAV` or `.REU` file onto the
  screen to load it (pointer devices). The hint below the monitor reminds you.
- **On touch devices**, tap the screen to raise the on-screen keyboard; the hint
  changes to say so.

---

## Rearranging the interface

The side panel is yours to lay out: cards can be reordered, moved between the
columns, hidden, and brought back. Everything here is remembered in this browser.

### Rearranging

Drag a card by its grip handle (**⠿**) to move it within its column or across to
the other; a dashed outline shows where it will land. Put every card in one
column if you like; the other stays an outlined empty target. The handle is also
a button: tab to it and use ↑ / ↓, ← / → and **Home** / **End**.

### Hiding

While you drag, a square **Hide** target appears in the bottom-right corner. Drop
a card there and it leaves the panel, keeping its place in the saved layout.

![A side-panel card held over the Hide target in the bottom-right corner of the screen, the target lit up, with the dashed outline of the space the card came from still open in the column.](/guide/panel-hide.webp)

### Adding one back

While anything is hidden, a **+** sits in that corner. It opens a picker of the
hidden cards; choosing one puts it back at the bottom of its column.

![The "Show hidden panels" dialog listing Cartridge and Datasette, each a row you can click to bring that panel back.](/guide/panel-restore.webp)

**Options ▸ Display ▸ RESET PANELS** is the way back for everything at once; the
original order, and every hidden card with it.

---

## Status

![The Status card showing "50 fps · 7.4 ms · 13.6 MB" and a "Running" line.](/guide/status.webp)

A read-only card. The badge reports live performance: **frames per second**,
**frame time** in milliseconds, and the JavaScript **heap** in megabytes. The
line below is the current activity: `Running`, load progress, or an error.

---

## Controls

![The Controls card with POWER, RESET, PAUSE, SIZE, FULL, VIBES, KEY MAP, PASTE, OPTIONS and RECORD buttons.](/guide/controls.webp)

| Button | What it does |
| --- | --- |
| **⏻ POWER** | Cold-boots the machine (and powers it off). Enabled once the ROMs are loaded. |
| **↺ RESET** | Cold-resets the running machine, equivalent to a power-cycle, so it re-runs the boot sequence. |
| **⏸ PAUSE** | Freezes emulation; press again to resume. |
| **SIZE: 2X** | Cycles the picture size **1X → 2X → 2.5X → 3X → MAX**. The numbered sizes are whole multiples of the C64's 384x272 screen, so every C64 pixel is the same number of screen pixels; **MAX** fills the width instead. Nothing is stretched. A size too big for your window is skipped; on a landscape phone the cycle is 1X → 2X → MAX. The side panel narrows to make room for the larger sizes. |
| **⛶ FULL** | Enters fullscreen. Exit with **Esc** or the **✕** button. |
| **VIBES** | Opens [Retro Vibes](#retro-vibes), a full-screen 3D scene of the C64. |
| **KEY MAP** | Shows the full [keyboard mapping](#key-map). |
| **📋 PASTE** | Reads your system clipboard and types it into the C64 keyboard buffer, handy for pasting BASIC listings. |
| **⚙ OPTIONS** | Opens [Options](#options): VIC-II / SID / palette variants, display and sound toggles, and ROM files. |
| **● RECORD** | Records the whole window with sound to an `.mp4`; see [Recording](#recording). Requires browser screen capture and media recording support. |

---

## Retro Vibes

![The Retro Vibes 3D scene: a Commodore 64, 1541 drive and 1702 monitor on the desk of a darkened 1980s bedroom, lit by a desk lamp, with venetian blinds and a corkboard on the wall behind.](/guide/retro-vibes.webp)

A full-screen 3D scene of the machine, opened with **VIBES**.

When **Touch Joystick** is assigned to a control port, its stick and buttons remain
available over the 3D scene.

| Control | What it does |
| --- | --- |
| **Drag** | Rotate the view. |
| **Scroll / pinch** | Zoom. |
| **Double-click / double-tap** | Powers the C64 on when it's off, so you can boot the machine without leaving the 3D scene. |
| **🎬** | Change the scene. |
| **⛶** | Glides the camera to a head-on view that fills the frame with the monitor, a virtual fullscreen. Drag or scroll to break out of it. |
| **🥽 ENTER VR** | View in VR (shown when a headset or the WebXR emulator is available). |
| **ⓘ model credit** | Shows attribution for the 3D model. |
| **Cmd+Shift+P** / **Ctrl+Shift+P** | Promo mode: hides everything else in this table and leaves the scene alone with the C64 READY. logo, for screenshots and video. The same keys bring the controls back. It is remembered, so the scene reopens the way you left it. |
| **✕** or **Esc** | Close and return to the emulator. |

### Scenes

The **🎬** button cycles through five scenes. Each strip shows the scene from the
default view, up close, and from a low angle.

**Synthwave**
![Three views of the Synthwave scene: the C64 setup on a glowing neon grid under a banded Outrun sun and wireframe mountains.](/guide/retro-vibes-synthwave.webp)

**Starry Plain**
![Three views of the Starry Plain scene: the machine on a dark pulsing grid beneath a blue-violet Milky Way, deep star field and occasional meteor.](/guide/retro-vibes-starry-plain.webp)

**Spotlight**
![Three views of the Spotlight scene: the setup picked out of pitch darkness by a single warm overhead spotlight, grounded on a matte studio floor while the live CRT softly colours its surroundings.](/guide/retro-vibes-spotlight.webp)

**IK+ Sunset**
![Three views of the IK+ Sunset scene: a stone courtyard by a bay at dusk, a black torii gate rising from the water in front of the setting sun, an autumn maple and a fishing village on the shores.](/guide/retro-vibes-ikplus.webp)

**80s Bedroom**
![Three views of the 80s Bedroom scene: a messy 1980s teenager's bedroom at night: the C64 on a faux-wood desk under an amber lamp, a plaid-duvet bed, venetian blinds, taped-up posters and a corkboard, a wood-grain CRT, a boombox and scattered clutter.](/guide/retro-vibes-80s-bedroom.webp)

Which model loads is set by **3D MODEL** in [Options](#options).

---

## Recording

Capture the whole browser window, with sound, to an `.mp4` video using the
**● RECORD** button in [Controls](#controls), enabled once the machine is
powered on. Click it, pick the window (or screen) to share in the browser prompt,
and the button becomes **⏹ STOP RECORDING**. Press stop and the file downloads
as `c64ready-<date-and-time>.mp4`.

- **It records everything on screen**, [fullscreen](#controls) and
  [Retro Vibes](#retro-vibes) included. The button lives in the side panel, so
  start recording *before* you enter those modes; the capture keeps running. To
  stop from inside them, use the browser's "Stop sharing" control, or leave the
  mode and press **⏹ STOP RECORDING**.
- **To record fullscreen or Retro Vibes, share "Entire Screen"** in the
  browser's prompt. A window or tab share does not follow the picture into
  fullscreen; a screen share covers both.
- **The audio is the emulator's own output**, tapped directly, so it stays clean
  and in sync even while the machine is muted.
- **The video has a resolution ceiling**, set by **RECORDER** in
  [Options ▸ Other](#other), 1080p by default. Without it, a HiDPI display would
  record far more pixels than the C64 picture needs. A larger surface is scaled
  down to fit, aspect ratio intact; a smaller one is recorded as it is; **NATIVE**
  removes the ceiling. Browsers that ignore the request record at native size.
- **Desktop Chrome and Safari** (and other Chromium browsers such as Edge, Opera,
  Brave). Elsewhere the button explains why instead of recording.
- **Safari may end the capture when the page loses focus**, for example on a
  file dialog or an app switch. The recording so far is saved and the status
  line says what happened. For a long take, load what you need before pressing
  RECORD, or use Chrome.

---

## Media load

![The Media load card with LOAD STATE, SAVE STATE, LOAD LIB and LOAD ANY buttons.](/guide/media-load.webp)

| Button | What it does |
| --- | --- |
| **📂 LOAD STATE** | Opens the [Save states dialog](#save-states-dialog) to restore a frozen machine; also imports / exports state files. |
| **💾 SAVE STATE** | Freezes the *whole* machine (RAM, every chip register, and whatever disk / tape / cartridge is inserted) into a named slot stored in this browser (browse them later with LOAD STATE). |
| **📂 LOAD LIB** | Opens the [Library dialog](#library-dialog) of files you've loaded before, cached in this browser. |
| **▶ LOAD ANY** | Picks any C64 file (`.prg`, `.d64`, `.crt`, `.tap`, `.wav`, `.dmp` or `.reu`) and does the right thing with it. |

### Save states dialog

![The Save States dialog with a filter box and three saved states, each with a thumbnail of the frozen frame, its name and age, and a ✎ rename, ⤓ export and ✕ delete button, above the IMPORT, EXPORT and CLEAR ALL buttons.](/guide/save-states-loaded.webp)

Opened with **📂 LOAD STATE**. Frozen machine snapshots (full RAM, chip
registers and inserted media) saved in this browser. Each row carries a
thumbnail of the frozen frame, the state's name and how long ago it was saved.

Restoring makes the machine *become* the snapshot, so its media replaces
whatever is inserted now. A state saved without a cartridge therefore removes
the one you have in; the expansion port is part of the machine it froze, and
its ROM would land under a program that never ran with it there. Put the cart
back from the [Library](#library-dialog), or save the state with it already
inserted so it comes back too.

| Control | What it does |
| --- | --- |
| **Filter…** | Narrows the list by save-state name as you type. |
| *List item* | Click to restore that state. |
| **✎** (on a row) | Renames that save state. |
| **⤓** (on a row) | Downloads that single state as a `.c64state` file; bring it to another browser or machine and pull it back in with **📥 IMPORT**. |
| **✕** (on a row) | Deletes that save state. |
| **📥 IMPORT** | Imports state files (`.c64state`, `.c64states`, `.json`). |
| **📤 EXPORT** | Exports your saved states to a file. |
| **🗑 CLEAR ALL** | Deletes every save state (asks first). |

Create a state with **💾 SAVE STATE** while a program is running. Until then the
dialog is empty, with just an **IMPORT** button:

![The empty Save States dialog before any state has been saved, showing only the IMPORT button.](/guide/save-states.webp)

### Library dialog

![The Library dialog listing three cached disk images, each with a D64 type badge, its filename, size and load time and a ✕ remove button, with a filter box and the IMPORT / EXPORT / CLEAR ALL buttons.](/guide/library-loaded.webp)

Opened with **📂 LOAD LIB**. Every `.PRG` / `.D64` / `.CRT` / `.TAP` / `.WAV` you open is
cached here so you can reload it without picking it from disk again. Each row is
tagged with its file type and shows the name, size and when you loaded it.

A `.WAV` is the exception: cassette audio is around twenty times the size of the
tape it encodes (a six-minute side runs to some 17 MB against 700 KB), so the
recording itself is not kept. It is converted to a tape as it loads, and that
`.TAP` is what lands in the library.

| Control | What it does |
| --- | --- |
| **Filter…** | Filters the list by name. |
| *List item* | Click to load that file again. |
| **📥 IMPORT** | Imports a `.rdy` library archive. |
| **📤 EXPORT** | Exports your library to a `.rdy` file (to move it to another browser / device). |
| **🗑 CLEAR ALL** | Removes every cached file (asks first). |

Before you've loaded anything the list is empty, with just an **IMPORT** button:

![The empty Library dialog before any file has been cached.](/guide/library.webp)

---

## Control Ports

![The Control Ports card with a SWAP PORTS button and Port 1 / Port 2 device selectors; Port 2 is set to Key Joystick 1, showing its row of clickable key chips.](/guide/control-ports.webp)

Models the C64's two control ports.

| Control | What it does |
| --- | --- |
| **SWAP PORTS** | Swaps the devices assigned to Port 1 and Port 2, the quickest fix when a game expects the joystick in the other port. |
| **Port 1 / Port 2** selector | Chooses what's plugged into each port: **None**, **Joystick (gamepad)**, **Touch Joystick** (touch devices only), **Mouse (1351)**, **Mouse (NEOS)**, **Paddle**, **Key Joystick 1**, or **Key Joystick 2**. |

Choosing **Joystick (gamepad)** reveals a **Gamepad** row to bind a detected
physical gamepad to that port.

> **Default:** Port 2 is a **Key Joystick 1** (arrow keys to move, **K** / **L**
> to fire), so you can play straight away with no gamepad attached.

### Touch Joystick

Choosing **Touch Joystick** (touch devices only) shows a fixed overlay above the
screen and UI: an eight-way circular stick at the lower-left and **B** / **A**
buttons at the lower-right. **A** drives FIRE; **B** drives the UP line used by the
common C64 second-button convention. In landscape the controls move to the viewport
corners, and they stay available in fullscreen:

![The touch joystick in landscape fullscreen: the eight-way circular stick at the lower-left and the A / B fire buttons at the lower-right, over a game (Commando's title screen) filling the display.](/guide/touch-joystick.webp)

### Key Joystick

Choosing a **Key Joystick** shows a row of key chips in the port row, one per
direction and fire button. Each chip is **tappable** (and clickable): press and
hold to trigger that direction or fire, so a key joystick is fully playable by
touch on a keyboardless phone or tablet, and by mouse too. Its **redefine** link
opens this dialog:

![The Key Joystick dialog listing Up / Down / Left / Right / Fire A / Fire B bindings with REDEFINE ALL KEYS, RESET TO DEFAULTS and DONE buttons.](/guide/key-joystick.webp)

It maps six roles (up, down, left, right, fire A, fire B) to physical keys.

| Button | What it does |
| --- | --- |
| **REDEFINE ALL KEYS** | Walks through every control in turn, capturing the key you press for each. |
| **RESET TO DEFAULTS** | Restores the default bindings. |
| **DONE** | Closes the dialog. |

Click any single row to rebind just that one control. Defaults for Joy 1 are the
arrow keys with **K** (fire A) and **L** (fire B); each key joystick has its own
independent set.

---

## Disk drive 8

![Disk drive 8 with a disk inserted: LOAD, BLANK, EJECT, write-protect, FORMAT and EXPORT buttons over a TDE toggle, the disk name, and the directory listing with a magnifier button.](/guide/drive8-loaded.webp)

The primary 1541 floppy drive (IEC device 8).

| Control | What it does |
| --- | --- |
| **💾 LOAD** | Inserts a `.d64` disk image (or drop one on the screen). A `.prg` works too; see [Loading a .prg](#loading-a-prg). |
| **💾 BLANK** | Inserts a **blank, unformatted** disk (shows 0 blocks free). Format it (with **FORMAT**, or from BASIC with `N:name,id`) before you can save to it. |
| **⏏ EJECT** | Removes the disk. |
| **🔒 / 🔓** | Write-protect toggle. Loaded disks start **protected** (🔒); click to allow the drive to write (🔓). A freshly inserted blank disk starts writable. |
| **🧹 FORMAT** | Erases the inserted disk to an empty format (asks for a name). Disabled while the disk is write-protected (🔒). |
| **⤓ .D64** | Downloads the disk, with your changes, as a `.d64` file. **Enabled once the disk has changes** to save; disables again after you export. |
| **TDE: OFF / ON** | Toggles **True Drive Emulation**, which runs a real 1541 CPU on the IEC bus, needed for custom fastloaders. With it off, `LOAD` is served directly from the disk image (faster, but some loaders won't work). Remembered between sessions, like the other toggles. |
| **Drive LED** | Lights while the drive is active. |
| **▼ *n* files** | Expands the directory: disk name, blocks free, and the file list. It updates itself when the running program changes the disk. Click a **PRG** or **USR** row to load and run that file; SEQ and REL rows are data, so they stay dim. |
| **🔍** | Opens the [Directory zoom](#directory-zoom) viewer: enlarged, filenames only, so PETSCII directory art reads clearly. |

**Writing to disk.** The drive writes back to the `.d64`: `SAVE` a program, scratch
or rename a file, and the change lands on the disk. Writing needs the disk unlocked
(🔓); loaded disks are protected until you allow it. Modified disks **auto-save to
your browser Library** so they survive a reload, and the **⤓ .D64** button enables so
you can download a copy; it goes quiet again once you have.

Before a disk is inserted the card shows a hint and only **LOAD** and **BLANK** are active:

![Empty Disk drive 8 showing the LOAD and BLANK buttons active.](/guide/drive8-empty.webp)

---

### Loading a .prg

A `.prg` is written onto a disk of its own, and that disk goes into drive 8, so
it loads like anything else, shows up in the directory, and can be exported as a
`.d64`. Inserting a disk doesn't reboot a C64, so this doesn't either, and the
**TDE** setting applies as usual.

The disk arrives write-protected. Flip the tabs to `SAVE` onto it.

With **AUTORUN** on, BASIC programs are `RUN`. Machine code is left at `READY.`
instead; only a BASIC `SYS` stub says where a program starts, so the status line
gives you the address to `SYS` yourself.

## Disk drive 9

![Disk drive 9 powered on, showing its power switch and the same LOAD, BLANK, EJECT, write-protect, FORMAT, EXPORT and TDE controls as drive 8.](/guide/drive9.webp)

An optional second drive (IEC device 9), off by default and invisible to the C64
until you switch it on. It reads, writes, and formats just like drive 8.

| Control | What it does |
| --- | --- |
| **Power switch** | Connects / disconnects device 9. Turning it on opens a confirmation dialog first (see the warning below). |
| **💾 LOAD / 💾 BLANK / ⏏ EJECT** | Insert / insert-blank / remove a `.d64` as device 9. |
| **🔒 / 🧹 FORMAT / ⤓ .D64** | Write-protect toggle, format, and export, the same as [drive 8](#disk-drive-8). |
| **TDE: OFF / ON** | True Drive Emulation for device 9 (needs the 1541 ROM). |

> ⚠️ **A second drive on the bus can crash fastloader demos and games.** When
> you flip the power switch on, a confirmation dialog appears:
> *"Demos might not work when disk drive 9 is active"* (**Turn on** to proceed,
> or decline to revert). This is not a formality: many custom fastloaders drive
> the IEC bus with cycle-exact timing and assume they are the *only* device on
> it. A connected drive 9 changes the bus timing and can make such a loader
> hang, glitch, or crash outright, **even the disk running from drive 8.** Only
> turn drive 9 on when you specifically need two drives, and turn it back off
> before loading a fastloader-based title.

---

## Cartridge

![The Cartridge card with LOAD and EJECT buttons.](/guide/cartridge.webp)

| Button | What it does |
| --- | --- |
| **🎮 LOAD** | Inserts a `.crt` cartridge image (or drop one on the screen). |
| **⏏ EJECT** | Removes the cartridge. |
| **↻ RESET** | On cartridges that provide it: presses the cartridge's reset button while preserving C64 RAM. |
| **❄ FREEZE** | On freezer cartridges that provide it: presses and releases the physical freezer button. |

RESET and FREEZE are capability-driven: they are shown only for inserted
cartridges that provide those controls (Action Replay and Final Cartridge
III). They remain visible but disabled while the C64 is powered off.

![The Cartridge card with a freezer cartridge loaded: LOAD and EJECT on the first row, RESET and FREEZE on the second, and the cartridge name (ACTION REPLAY VI) below.](/guide/cartridge-freezer.webp)

---

## RAM Expansion

![The RAM Expansion card switched on, with a Generic 16 MB unit selected, LOAD, BLANK and .REU buttons, and a loaded blu.reu image.](/guide/ram-expansion.webp)

A Commodore RAM Expansion Unit, the box that plugs into the expansion port and
gives the C64 a bank of extra memory. The C64 cannot see that memory directly;
a controller inside the unit shifts blocks between it and normal C64 memory,
about a megabyte a second, with the processor stopped while it works. GEOS and
a good number of demos ask for one.

Nothing is fitted until you turn the switch in the card header on. Pick the
unit from the dropdown:

| Unit | RAM |
| --- | --- |
| **1700** | 128 KB, the smallest Commodore unit |
| **1764** | 256 KB, the one sold for the C64 |
| **1750** | 512 KB, the one most software expects |
| **1750 XL** | 2 MB, a later third-party expansion |
| **Generic** | 1, 4, 8 or 16 MB, for demos that ask for more |

Software can tell these apart, so a title that wants a 1750 may refuse a 1700.
If you don't know which to pick, leave it on the 1750.

The lamp beside the dropdown is the same one the disk drives use: it lights
whenever the expansion is moving data. Transfers are far too quick to see, so
it stays lit for a moment after each one.

| Button | What it does |
| --- | --- |
| **📥 LOAD** | Fills expansion RAM from a `.reu` image file. |
| **🧹 BLANK** | Wipes expansion RAM back to zeroes. |
| **⤓ .REU** | Downloads the current contents as a `.reu` image. |

You can also drop a `.reu` straight onto the screen, or pick one with **LOAD
ANY** in the Load card; both work like the card's own LOAD button. Unlike the
other file types, expansion images aren't kept in the Library: a 16 MB image
would crowd out everything else in it. If no expansion
is fitted, dropping an image fits one; if the image is bigger than the unit you
have, you get the smallest unit that holds it rather than a truncated load.

Changing the unit swaps the hardware, so whatever was in expansion RAM goes
with it. The contents are included in save states, so a snapshot taken partway
through a demo resumes properly.

A cartridge can stay inserted while an expansion is fitted; on real hardware
that combination needs a port expander. Action Replay, Final Cartridge III and
EasyFlash use the same corner of the expansion port as the RAM Expansion, so
those three don't get along with it; the other cartridges are fine. Switching
the expansion on says so, since it holds whichever you insert first.

---

## Datasette

![Animation of the Datasette card loading the Commando tape: PLAY latched, the motor dot lit green, the bar and timer climbing.](/guide/datasette-loading.webp)

A 1530 Datasette for `.tap` tape images: it reads them, records them, and can
play them out loud.

It also takes `.wav` recordings of real cassettes. A C64 tape stores its data as
audible pulses, so a recording of one still is the data: the pulses are recovered
and it becomes an ordinary tape.

It also takes `.dmp` dumps from a DC2N, which records a tape at the cassette
port. Those are pulses already, so there is nothing to recover.

**A loaded `.wav` or `.dmp` becomes a `.tap`**; that is what the deck holds and
what goes into your Library. Downloading it as `.WAV` again re-renders the audio from those
pulses, so you get the same data back as clean square edges, not your original
recording.

**This is a preservation tool, not just a way to play a recording.** Point it at
a transfer of a 1980s cassette and it recovers the tape, damage and all, then
mends what the tape can prove. On the eight worn cassettes it was built against
it went from 66 of 129 programs loading to 121 of 130. What it does, in order:

1. **Reads the recording**: every common WAV format, and both channels of a
   stereo transfer.
2. **Finds the pulses.** A C64 tape stores data in the *width* of each pulse, so
   the widths are measured between centre crossings, with the level and the
   centre line tracked locally: an old recording holds neither steady. The widths
   a tape was written at are measured too, so a deck that ran fast or slow still
   reads.
3. **Compares the readings.** The two channels of a stereo transfer, their
   average, and their average with the channels lined up (they sit a few
   samples apart on every tape) are four readings of the same tape, and they
   disagree. All four are read and the one that hands over the most files is kept.
4. **Mends what it can prove.** Where a file does not add up, its own stretch of
   the recording is read again (the other channel, the averages, the treble
   lifted) until two readings agree on its bytes and the checksum passes. A file
   only one reading vouches for is put back but said to be unconfirmed.
   Standard-format files are mended from the tape's second copy as well, or the
   two copies merged.
5. **Writes it back clean.** Every file whose bytes are proved is rewritten at the
   two pulse widths that tape uses, so the loader from 1986 gets a pristine block
   rather than a marginal one.

Nothing is invented: every repair has to pass a checksum that was written to the
tape in the first place, and a file that cannot be proved is left alone and
marked in the listing. What stays broken is mostly tape that no longer carries a
signal: a second of silence in the middle of a file is a second of the program
gone, and no reading brings it back.

It takes a while (a 30-minute side is a few hundred megabytes of audio, read
several times over), so a dialog says which pass it is on while it works, and the
emulator keeps running behind it.

The Status card reports what came out of the recording: how long it was, how
many files, and whether any needed mending. A C64 tape records every block
twice and the machine reads both, so a damaged second copy makes a load hang
even though the program arrived; the second copy is then rewritten from the
first, or the two are merged where neither is whole on its own. A turbo tape
has no second copy, so its files are read again with the treble lifted, which is
what a worn tape loses first. The listing says what was mended at its foot.

**🔊** beside the card title plays the tape out loud, the real signal the head
is reading, not a sound effect. A loader sounds like a loader.

**The scope** to its left draws that same signal instead of playing it. There is
no visualisation to invent here: a C64 tape *is* a square wave, and the data is
in the width of each pulse, so the trace is the signal itself, read from the
`.tap` entries passing under the head, pulse for pulse.

![The Tape signal dialog: a green square wave of varying pulse widths on a graticule, reading PLAYING at the bottom left and "43 pulses · 20 ms window · 384–688 cycles" at the right.](/guide/tape-scope.webp)

The window is about 20 ms of tape (a few dozen pulses), and the readout under it
says what the deck is doing and what has just gone past: how many pulses, and the
shortest and longest of them in C64 cycles. On a KERNAL tape those settle at 384,
528 and 688 cycles, the three widths the format is built from; a lead-in is one
width repeated, so the trace goes evenly striped, and data mixes all three as
above. A turbo tape uses two much shorter ones.

It is independent of the speaker, so you can watch with the sound off, and it
works while recording too; there the trace is what has just been written. A deck
that is not moving draws a flat line rather than the last thing it saw.

**🔍** at the end of the tape's info row lists what is on the tape. A `.tap`
carries no directory, so the tape is read the way the C64 reads it and the file
headers are picked out. It reads on the press, not on insert, and takes a few
milliseconds.

The listing is laid out like the Library: a row per file with the format it was
written in, its size, and the time it starts. **Click a row to wind the tape to
that file**: the head lands at the start of its lead-in, ready for the loader.

![The tape listing for a tape called 80S MIXTAPE: seven rows, each with a CBM or TURBO badge, a filename, its size and its start time. One filename is struck through in red, and a note under the list says one file is struck through because the tape lost part of it.](/guide/tape-listing.webp)

A filename **struck through** could not be read whole. Damaged tapes are normal,
and nothing is hidden: the file stays in the listing and the head can still be
wound to it, but it will not load. Hover it to see why, and the note under the
list says how many there are and what was mended on the way in.

Turbo tapes are read too, in the formats the emulator knows: the
[Datasette architecture](DATASETTE-ARCHITECTURE.md) page lists which loaders
those are. A tape written by one that isn't known yet says so rather than
listing anything.

In the order they sit on the deck:

| Button | What it does |
| --- | --- |
| **📼 LOAD** | Inserts a `.tap`, a `.wav` recording or a `.dmp` dump of a cassette (or drop one on the screen). |
| **⏏** | Removes the tape. |
| **🔒 / 🔓** | The write-protect tabs. Protected blocks the **REC** key, exactly like a cassette with its tabs broken out. A tape you load arrives protected; a blank one does not. |
| **⤓ .TAP** | Downloads the tape as a `.tap` file, recording and all. |
| **⤓ .WAV** | Downloads the tape as audio. Play it into a real C64 and it loads. |
| **📼 BLANK** | Inserts a fresh blank tape to record onto, after asking you to name it (up to 12 characters). |
| **⏹ STOP** | Releases whichever key is down. |
| **⏮ START** | Jumps straight back to the start of the tape, instantly and with no winding. The one button a real 1530 doesn't have. |
| **▶ PLAY** | Presses PLAY. In BASIC, type `LOAD` then press PLAY and the machine reads the tape. |
| **⏺ REC** | Presses RECORD. `SAVE"NAME",1` from the C64 then writes to the tape. RECORD engages PLAY with it, so both keys light up; that is the mechanism, not a glitch. |
| **⏪ REW** / **⏩ FF** | **Hold** to wind, let go to stop. They release themselves if the tape reaches an end. |

Click or drag the bar to move the tape. A tape under a pressed key is moving past
the head, so a key that is down comes up first; clicking while it plays means
stop here, and while it records it means stop, keep what was written, and move.

The bar shows tape position and turns red while recording; the dot beside it
lights when the motor is running; the three-digit counter and the timer track
the tape. As animated above: insert a tape (or press **▶ PLAY**) and, with
AUTORUN on, the motor dot turns green, the bar fills, and the counter climbs
from 0m00s.

**The bar is also a scrubber.** Click or tap anywhere on it to move the tape
there, or drag along it to hunt. Hovering first previews the spot: the timer
shows the tape time under your pointer without moving anything. With the bar
focused, ← and → step by 2 % (hold Shift for 10 %), and Home and End jump to the
ends. Scrubbing is refused while RECORD is engaged; a real deck can't move the
head mid-write either.

**To save to tape:** press **📼 BLANK**, then **⏺ REC**, then `SAVE"NAME",1` in
BASIC. Recording is instead of playing, so the tape is written from wherever the
head is and anything past that point is overwritten; a real head erases as it
goes. When you're done, **⏹ STOP** and **⤓ .TAP** to keep the file. A recorded
tape is also folded into the Library automatically, so a reload doesn't lose it.

**Winding needs the computer.** A real datasette's motor is switched by the C64,
not by the deck, so **REW** and **FF** only move tape while the machine has the
motor line on. The KERNAL turns it on as soon as a key goes down, so in practice
they simply work. That is why a real deck sits silent with PLAY held and starts
by itself at the `READY.` prompt. The one liberty taken: the wind keys run only
while held, where a real deck latches them until STOP.

---

## Options

Opened with **⚙ OPTIONS**. Hardware, display, sound and other settings, plus
ROM management. All choices persist in this browser.

![The Options dialog with Display, Video, Sound, Media, Other and ROM Files sections.](/guide/options.webp)

### Display

| Button | What it does |
| --- | --- |
| **🖥 CRT** | Cycles the CRT visual effect: **ON** (basic scanlines) → **TUBE** (phosphor mask + vignette + glow) → **B&W** (monochrome tube) → **ARCADE** (bright, sharp scanlines) → **HUM** (tube look with a slow rolling mains-hum bar) → **OFF** (flat, crisp pixels). |
| **ATTRACT MODE** | On by default: plays an animated attract-mode demo on the screen while the machine is powered off. Turn it off to show a simple "press power to boot" hint instead. |
| **3D MODEL** | Which model the VIBES viewer loads: **SMALL** (default, a light model that's easy on memory everywhere), **AUTO** (picks by device: lighter on phones/tablets, detailed 4K on desktop), or **LARGE** (force the 4K model). Takes effect next time you open VIBES. |
| **STAY AWAKE** | Keeps the screen awake while a demo runs, so the device doesn't dim or lock (which would pause the emulator). |
| **VIBES BUTTON FX** | On by default: runs a tiny demo inside the VIBES button itself: a field of dark pixels drifting through ten sine patterns in 3D. Turn it off for a plain button. |

### Video

| Button | What it does |
| --- | --- |
| **VIC** | Switches the VIC-II graphics chip: **6569** (original PAL, NMOS breadbin) ↔ **8565** (late PAL, HMOS C64C/C128; adds a 1-cycle pixel-pipeline delay some demos use). |
| **PAL** | Switches the colour palette: **Colodore** (the modern VICE default, sharper and more saturated) ↔ **Pepto** (the classic 2001 measurement-based palette). Applies within one frame. |

### Sound

The **master volume** control at the top of this section sets how loud everything (SID and drive sounds) plays. Drag the slider to set the level, or click the speaker icon on its left to mute. The scale is perceptual (mid-slider is roughly half as loud) and defaults to 70%, which leaves headroom so the emulator sits closer in loudness to other apps. Raising the volume from silent also un-mutes; while muted, the speaker shows a red ✕ and playback keeps running silently.

| Button | What it does |
| --- | --- |
| **SID** | Switches the SID sound chip model: **6581** (original) ↔ **8580** (later revision). |
| **ENGINE** | Selects the SID sound engine: **reSID WASM** (default) and **reSID JS** sound identical; the WASM build uses far less CPU, and switches to reSID JS automatically if WebAssembly can't start. |
| **DRIVE SOUND** | Plays synthesized 1541 sounds (motor hum, head-stepper clicks, fast-load chatter) while the drive is active. |

The two reSID engines are the same port of **VICE's reSID**, Dag Lem's
transistor-level model of the real chip's oscillators, envelopes, analog filter
and DACs, verified against VICE recordings, running as JavaScript or compiled
to WebAssembly. What you hear is the modelled chip, not a lookalike synthesizer.

Audio runs at **48 kHz**, the usual device rate on modern hardware. If sound
trails the picture (noticeably in **Safari on macOS**), set your output device
to **48 000 Hz** in **Audio MIDI Setup** (Applications ▸ Utilities). A mismatched
system rate makes the browser resample the SID stream, which adds a fixed lag.

### Media

| Button | What it does |
| --- | --- |
| **AUTORUN** | When on, `RUN` (BASIC) or `SYS <addr>` (machine code) is injected automatically after a PRG loads. When off, the machine stays at the `READY.` prompt so you can start it yourself. |

### Other

| Button | What it does |
| --- | --- |
| **RECORDER** | The ceiling for what **● RECORD** captures, cycling **720p → 1080p → 1440p → 4K → NATIVE**. 1080p is the default. A shared surface larger than the ceiling is scaled down to fit inside it, aspect ratio intact; anything smaller is recorded as it is. **NATIVE** applies no ceiling at all. The choice takes effect on the next take, not the one already running. |
| **RUN IN BACKGROUND** | **OFF** (default): the machine pauses the moment the app leaves the foreground (another window takes focus, the tab is hidden, the phone locks) and resumes when it comes back. **ON**: it keeps running and playing through all of that. A hidden tab is only allowed to run at full speed while it is audible, so keep the sound on; muted, the browser slows it to a crawl until you return. |

See [Recording](#recording) for what the ceiling is for.

### ROM Files

The C64 needs Commodore's KERNAL, BASIC and CHARGEN ROMs (plus an optional 1541
ROM for True Drive Emulation). A status line shows which are present. On first
run the [Setup dialog](#setup-c64-ready) walks you through loading them.

| Control | What it does |
| --- | --- |
| **LOAD…** (per ROM) | Loads a ROM file from your device for KERNAL, BASIC, CHARGEN or 1541 DOS. |
| **CLEAR** | Removes all cached ROM uploads from browser storage. |

> ⚠️ The KERNAL, BASIC, CHARGEN and 1541 ROMs are Commodore's copyrighted
> property and are **not** bundled; you must supply them legally. See
> [Getting Started](GETTING-STARTED.md#1-set-up-roms).

---

## Setup C64 READY.

![The Setup C64 READY. dialog: "Get ROM files from VICE" with a CHOOSE… button, above "Upload each ROM file" with a LOAD… and a "help me find it" search per ROM.](/guide/setup-dialog.webp)

Appears automatically on first run, when no ROMs are found; the C64 can't boot
without them. Two routes: **CHOOSE…** takes all four images out of an installed
VICE folder, or **LOAD…** takes one file at a time. **🔍 help me find it**
searches the web for a filename; the emulator never downloads anything itself.
The closing button reads **Find them later** until the three required ROMs are
in, then **Done**.

[Getting Started](GETTING-STARTED.md#1-set-up-roms) has the walkthrough, the
filenames and the licensing note.

---

## Key Map

![The Key Map dialog showing the PC-to-C64 key mapping for special keys, letters, digits and symbols.](/guide/keymap.webp)

A reference (opened with **KEY MAP**) for how your PC keyboard maps onto the C64.
The special keys are worth memorising:

| PC key | C64 key |
| --- | --- |
| **F9** | RUN/STOP |
| **F10** | C= (Commodore key) |
| **F11** | CLR/HOME |
| **F12** | RESTORE (NMI) |
| **Enter** | RETURN |
| **Backspace / Delete** | INST/DEL |
| **Arrows** | CRSR movement |
| **^** | ↑ · **_** produces ← |
| **Esc** | reserved (closes dialogs, exits fullscreen) |

Click the screen to capture keyboard focus before typing.

---

## Directory zoom

![The Directory zoom viewer showing a disk's directory enlarged: a rainbow PETSCII "Genesis Project" logo over "Raster Time", hidden in the filenames, reads as a full picture.](/guide/directory-zoom.webp)

Opened with the **🔍** button in a drive's directory panel. It shows the disk's
filenames large (filenames only, no block counts or type tags), so the PETSCII
artwork many demos hide inside their directory listing reads clearly (above,
the *Raster Time* disk by Genesis Project).

---

## Updates

![The "New version available." toast: the message, a Reload button, and a Later… button.](/guide/update-toast.webp)

C64 READY. is a Progressive Web App, so it refreshes itself in the background.
When a newer version has been downloaded and is ready to run, a toast appears at
the bottom of the screen:

| Button | What it does |
| --- | --- |
| **Reload** | Applies the update and reloads into the new version. |
| **Later…** | Dismisses the toast and keeps your current session running; the update applies automatically the next time you launch the app. |

Your running machine is never swapped out from under you; nothing changes until
you choose **Reload** (or relaunch later).

---

## Keyboard shortcuts

### App shortcuts

Hold **Cmd+Shift** on a Mac, or **Ctrl+Shift** on Windows and Linux. Both work
on every platform.

| With the modifier | Action |
| --- | --- |
| **V** | Pastes the clipboard into the C64 as keystrokes, same as **PASTE**. |
| **F** | Cycles the CRT look, same as the CRT button in [Options](#options). |
| **Z** | Zooms the VIBES button to 10x, so the little pixel demo running inside it can be watched properly: magnified, and running at your display's refresh rate. It stays a working button: clicking it opens [Retro Vibes](#retro-vibes). Press it again (or **Esc**) to send it back. |
| **P** | Opens [Retro Vibes](#retro-vibes) in promo mode — the 3D scene and the C64 READY. logo, nothing else. Press it again to bring the controls back. The mode is remembered between visits. |

Only those letters are borrowed. **Ctrl** on its own is a real C64 key and still
reaches the machine, and a text box keeps its own keys.

The same list is in the **KEY MAP** dialog under *App shortcuts*, which is
generated from the shortcuts themselves and so is always current. It adds
**S** — a debug snapshot, handy when reporting a bug.

### Reserved keys

| Key | Action |
| --- | --- |
| **Esc** | Closes the topmost dialog, or the 3D viewer. Also leaves fullscreen, which the browser does itself. |
| **F9–F12** | RUN/STOP · C= · CLR/HOME · RESTORE (see [Key Map](#key-map)). |

Everything else on the physical keyboard is passed straight through to the C64
per the [Key Map](#key-map) once the screen has focus.
