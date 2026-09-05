<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->

# What's New

What changed in each release of C64 READY., in plain language, newest first.
The version you are running is shown at the bottom of the About dialog.

---

## Next release

*Not out yet: what is finished and waiting for the next version.*

- **C64 READY. gets a command line.** `npx c64rdy` puts a terminal in front of
  the same tape and disk engine: turn a shelf of cassette recordings into
  `.tap` files in one go, list what a tape, disk or cartridge holds, repair
  damage, and boot programs headless — down to every program on a tape side
  tiled into one captioned sheet. No install, no dependencies. The new
  [CLI guide](USER-GUIDE-CLI.md) covers it all.
- **Six commercial tape loaders can be read**: Novaload (the loader behind many
  boxed games, drawing a picture and playing music while the tape runs), Ocean /
  Imagine, Freeload, Wildload, Gremlin Type 2, and the US Gold / Datasoft one.
  Tapes that use them used to show one or two small files and minutes nothing
  could read. The deck now lists everything on them.
- **Shortcuts that stay out of the C64's way.** App shortcuts now take
  **Cmd+Shift** on a Mac and **Ctrl+Shift** on Windows and Linux, both working
  everywhere: **V** pastes, **F** cycles the CRT look, **Z** zooms the VIBES
  button. **Ctrl** on its own stays the machine's, and text boxes keep their own
  keys. The [KEY MAP](USER-GUIDE.md#key-map) dialog lists them.
- **Studio mode for Retro Vibes.** **Cmd+Shift+X** / **Ctrl+Shift+X** strips the
  [3D scene](USER-GUIDE.md#retro-vibes) to the machine and the C64 READY. logo
  (no buttons, no pointer) for screenshots and video. Remembered between visits.
- **A smoother welcome.** The **POWER ON** glow was redrawn on the processor
  every frame; it now runs on the graphics card. Same look, none of the cost.
  Thanks to the reader who
  [reported it](https://github.com/mortyeriksen/c64ready/issues/1), fix included.
- **The idle demo knows when to sit one out.** It steps aside for reduced-motion
  settings, or graphics that can't keep up, leaving the "press power to boot"
  hint. **ATTRACT MODE** in [Options](USER-GUIDE.md#options) still has the say.
- **Clearer documentation.** The docs pages got a readability and accuracy pass:
  shorter guides, corrected details, less repetition.

---

## 2026.8.6 — August 29, 2026

**First public release of source code.** C64 READY. is now open source under the
GNU General Public License v3 (or later). The complete source, its 2,400+
tests and these docs live on GitHub:
<https://github.com/mortyeriksen/c64ready>

- **Read it, build it, run it locally.** The README explains how to run the
  emulator and its test suite with your own C64 ROMs; the ROMs themselves are
  still Commodore's and are not included.
- **Report bugs and request features** on the
  [GitHub issue tracker](https://github.com/mortyeriksen/c64ready/issues);
  pull requests are welcome too (see CONTRIBUTING in the repository).
- **Privacy, in writing.** The [About](ABOUT.md) page now states what leaves
  your browser: nothing but a few anonymous page counts. ROMs, disks, tapes and
  save states stay in your browser.
- **Credits and licenses in one place.** Everything C64 READY. builds on, from
  reSID and VICE to the fonts and the 3D model, is listed in the repository's
  NOTICE file and on the [Specifications](SPECIFICATIONS.md) page.

---

## 2026.8.5 — August 29, 2026

A release about getting started. If you already run VICE, the ROMs are one
folder pick away.

- **ROMs straight from VICE.** The setup dialog now starts with **Get ROM files
  from VICE**: press **CHOOSE…**, pick the VICE folder, and the four ROM images
  are found inside it. Your browser may call that an upload, but nothing is sent
  anywhere. Loading each file yourself still works, below.
- **Dialogs stay where you put them.** The [Options](USER-GUIDE.md#options)
  header no longer scrolls away with the settings under it, and scrollbars sit
  beside the rows instead of over them.
- **One less sound setting.** The old LEGACY engine is gone. **ENGINE** now picks
  between reSID WASM and reSID JS.
- **Clearer instructions.** Getting Started and the [User Guide](USER-GUIDE.md)
  have been rewritten.

---

## 2026.8.4 — August 26, 2026

A release about cassettes. A recording of a worn tape is read for everything
that can still be recovered, and nothing is trusted until the tape itself has
proved it.

- **Your old cassettes may play again.** Record a worn tape to `.wav` and drop
  it on the screen. The [deck](USER-GUIDE.md#datasette) reads what is left and
  mends what it can prove. Nothing brings back a stretch the tape has lost. Of
  the programs on eight 1980s cassettes, 66 loaded before and 121 do now.
- **Every reading is used.** Both channels of a stereo transfer and their
  average are read. So are the two lined up: they sit a hair apart on every
  tape, and lining them up rescued whole sides. The reading that hands over the
  most files wins. A file it cannot prove is read again from all the others.
- **Repairs need agreement.** A checksum alone lets one wrong reading in 256
  through, so a file goes back only when two readings agree on its bytes. One
  that nobody else could confirm is still put back, and says so in the listing.
- **Proved files load like new.** Every file the tape can prove is rewritten at
  clean pulse widths. A loader from 1986 is never handed a marginal one. One
  game whose bytes checked out but whose loader tripped on two such pulses loads
  now.
- **A directory for the tape.** New: **🔍** on the deck lists what is on the
  tape. It is laid out like the Library: a row per file with its format, size
  and start time. A click winds the tape to that file. Every file is there,
  named or not. Damaged ones are struck through. A line under the list says
  what is wrong, how much is gone and what was mended.
- **DC2N dumps load.** A `.dmp` from a DC2N is a tape like any other.
- **See the signal.** A [scope](USER-GUIDE.md#datasette) beside the tape speaker
  draws the square wave passing under the head.
- **Lighter on a phone.** Tape recordings are read in pieces. That is about half
  the memory it took before, so a long side no longer risks the browser stopping
  it.
- Also:
  - **Run in background** is a new switch under
    [Options ▸ Other](USER-GUIDE.md#other). It keeps the machine running while
    another window has focus. Off by default.
  - Datasette: a reset lifts the PLAY key, and a SAVE plays out loud as it is
    written.
  - Drive 9 starts with True Drive Emulation on.
  - Tooltips wait two seconds before appearing, so they stay out of the way
    while you work.
  - [YouTube channel](https://www.youtube.com/@c64ready) link in the header.
    Subscribe for updates!

---

## 2026.8.3 — August 22, 2026

Tooltips that turn up where they belong, and fixes for using C64 READY. on a phone.

- **Tooltips stay with their control.** The explanation appears just under the
  button, in the app's own colours; no more arriving late and halfway across the
  page.
- **The touch joystick leaves your keyboard alone.** Pressing the
  [touch joystick](USER-GUIDE.md#touch-joystick) or a fire button no longer raises
  the on-screen keyboard.
- **Fire on K and L.** [Key Joystick 1](USER-GUIDE.md#key-joystick) starts with
  both fire buttons under your right hand. Keys you rebound yourself are
  untouched.
- **Room for the + on touch.** The **+** that brings a
  [hidden card](USER-GUIDE.md#adding-one-back) back moves to the bottom of the
  screen while the joystick is up, clear of the fire button.
- **Library files move between phone and desktop.** A library exported on Android
  [imports](USER-GUIDE.md#library-dialog) back again, and a wrong file now says so
  in the dialog.
- **A cleaner bedroom.** The lamp in the [80s Bedroom](USER-GUIDE.md#scenes) no
  longer hazes the room in Safari.

---

## 2026.8.2 — August 12, 2026

Expansion RAM for the software that wants it, disks that behave like the
originals, a side panel you can pare back to what you use, and 3D scenes worth
sitting in.

- **A RAM Expansion Unit.** Switch one on in the
  [RAM Expansion](USER-GUIDE.md#ram-expansion) card (a 1700, 1764, 1750, 1750 XL
  or a generic unit up to 16 MB), and the demos and programs that want expansion
  RAM will find it, working the way it does on real hardware. You can fill it from
  a `.reu` file, save it back out, or wipe it, and whatever is in it comes along
  inside a save state.
- **Disks that keep their quirks.** [40- and 42-track](USER-GUIDE.md#disk-drive-8)
  `.d64` images load, not just the usual 35; a 42-track image used to be read as
  an ordinary 35-track disk. If an image records the errors on the original
  floppy, those are honoured too, so a game protected by a sector that has to fail
  to read still loads the way it was meant to. GEOS disks show readable filenames.
- **Hide the cards you don't use.** Drag a side-panel card to the corner and drop
  it, and it is [gone from the panel](USER-GUIDE.md#hiding); a **+** appears in
  that corner to bring any of them back. Your arrangement is remembered either
  way.
- **Shortcuts that work on every platform.** App shortcuts now take **Cmd** on a
  Mac and **Alt** (or **Alt+Shift**) on Windows and Linux; all three work
  everywhere, and the [KEY MAP](USER-GUIDE.md#key-map) dialog lists them. Windows
  and Linux get a paste shortcut at last. **Ctrl** is left alone, because the C64
  needs it.
- **A bedroom you'd recognise.** The
  [80s Bedroom](USER-GUIDE.md#scenes) scene is properly furnished now: lit like a
  room at night, with something playing on the TV in the corner. The **IK+
  Sunset** courtyard has its stone, its shadows and the water catching the light,
  and **Synthwave** gets an arcade road running out to the sun.
- **Lit by the C64 itself.** In the **Spotlight** scene the light on the machine
  now comes from its own picture, so the colour in the room shifts with whatever
  is on screen. **Starry Plain** has a new sky, with the Milky Way sweeping across
  it.

---

## 2026.8.1 — August 6, 2026

Loading got simpler, the controls are yours to arrange, and the picture keeps its
shape whatever you do to the window.

- **One button for any file.** [LOAD ANY](USER-GUIDE.md#media-load) takes a
  `.prg`, `.d64`, `.crt`, `.tap` or `.wav` and works out what to do with it: the same
  thing dropping a file on the screen already did. No more picking the right
  button for the file in your hand.
- **A .prg arrives on a disk.** Load a program and it is
  [written onto a disk of its own](USER-GUIDE.md#loading-a-prg) instead of being
  dropped into memory. It shows up in the directory, you can load it again, and
  you can save it back out as a `.d64`. It also means loading a program no longer
  resets the machine; putting a disk in a real C64 doesn't either.
- **Hear the tape.** A speaker button on the
  [Datasette](USER-GUIDE.md#datasette) plays what the C64 is actually reading:
  the real screech, not an imitation.
- **Tapes as sound files.** Save a tape as a `.wav` (the actual cassette audio)
  and play it into a real C64 to load it there. It works the other way too: record
  a real cassette to a `.wav` and [load it here](USER-GUIDE.md#datasette).
- **Arrange the controls.** Every card in the side panel has a grip handle. Drag
  it to move it up or down, or across to the other column, and it stays where you
  put it next time you visit. Put everything in one column if you like. The
  handles work from the keyboard too, and
  [Options ▸ Display](USER-GUIDE.md#options) has a reset if you want the
  original layout back.
- **A demo in the VIBES button.** The [VIBES](USER-GUIDE.md#controls) button
  now has a small pixel demo running inside it. Press **Cmd+Z** to blow it up to
  ten times the size. Switch it off in Options if you'd rather have a plain button.
- **A picture that is never stretched.** Turning a phone on its side used to
  squash the C64 screen out of shape. It now always keeps the machine's own
  proportions (at any size, any window shape, and with any
  [CRT look](USER-GUIDE.md#options)), and the frame stays tight around it
  instead of running wider.
- **A new MAX size.** [SIZE](USER-GUIDE.md#controls) gains **MAX**, which fills
  the width available rather than stepping in whole multiples, useful where no
  multiple quite fits. Sizes too big for your window are left out of the cycle
  now, instead of being shown clamped to a size they are not, so the button
  always changes something. It is available on phones too, where it used to be
  hidden.
- **Fixes.** Game intros that read the loading messages back off the screen now
  start on their own. Opening Library or Save States on a phone no longer covers
  the list with the keyboard. The documentation pages get their icon back. And
  the installed app is a little smaller again.

---

## 2026.8.0 — August 4, 2026

Better sound, and a way to get your work out of the emulator.

- **A new SID engine.** The reSID transistor-level model now runs as compiled
  WebAssembly and is the default, so the sound is the same as before but far
  cheaper to produce. [Options ▸ Sound](USER-GUIDE.md#sound) still lets you
  pick reSID JS or the older Legacy engine, and all three play at the same volume.
- **Record what you see.** A new [RECORD](USER-GUIDE.md#recording) button
  captures the window with sound to an MP4 you can trim in QuickTime or drop
  straight into a video editor. Works in Chrome, Edge and desktop Safari, up to
  1080p.
- **Master volume.** A real [volume slider](USER-GUIDE.md#sound), with MUTE folded
  into it.
- **Disks you can write to.** [BLANK](USER-GUIDE.md#disk-drive-8) to insert a
  fresh disk, FORMAT to prepare it, then SAVE into it from BASIC. Deleting files
  works too, and a disk can be write-protected or exported back out as a .d64 file.
  It all runs through the real 1541 DOS, so a program cannot tell the difference.
- **Tapes you can record.** The [datasette](USER-GUIDE.md#datasette) now writes as
  well as reads. Insert a BLANK tape, press REC, and `SAVE"NAME",1` puts your
  program on it. Then download it as a .tap file. The full five keys are there
  (REC, PLAY, REW, FF, STOP) with a tape counter, and the write-protect tabs block
  recording the way a real cassette does. Turbo savers work too: the write line is
  timed to the cycle, so what lands on the tape is what a real C64 would have
  written.
- **Tidier save states.** Rename a state from the
  [Load State dialog](USER-GUIDE.md#save-states-dialog), and find it again in an
  alphabetical list.
- **A sharper picture.** The display is now
  [sized in whole multiples](USER-GUIDE.md#controls) of the C64's own framebuffer,
  so no scaling step softens a pixel. On a phone held upright it fills the width.
- **A new [Retro Vibes scene](USER-GUIDE.md#scenes).** An 80s bedroom, and a
  reworked IK+ Sunset built after the original game's backdrops.
- **A welcome screen.** First-time visitors get a short introduction with a
  teaser video instead of landing cold in the machine.
- **A much smaller install.** The installable app went from about 12 MB to 1.9 MB,
  and the documentation now works offline once installed.
- **Fixes.** Audio no longer lags after a keypress or when returning to the tab,
  gamepads work in the installed app, mouse and paddle inputs report correctly on
  an empty port, and the Android soft keyboard behaves.

---

## 2026.7.0 — July 19, 2026

The first public release.
