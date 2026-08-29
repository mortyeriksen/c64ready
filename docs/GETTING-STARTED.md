<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->

# Getting Started

A Commodore 64 that boots in your browser. No install, no plugins, no login.
This guide takes you from a blank screen to a running game or demo in a few
minutes, then points out the settings worth knowing.

Want a checklist of what the machine can do? See [Features](FEATURES.md).
Curious how it works inside? Start at the [Architecture](ARCHITECTURE.md) map.

---

## 1. Set up ROMs

**The first time you open the emulator, a "Setup C64 READY." dialog appears.**
The C64 cannot boot without its ROM chips. Dismiss it and the screen reads
**PRESS TO START SETUP**; click the screen or **POWER** to bring it back.

![The Setup C64 READY. dialog: "Get ROM files from VICE" with a CHOOSE… button, above "Upload each ROM file" with a LOAD… and a "help me find it" search per ROM.](/guide/setup-dialog.webp)

> ⚠️ **The KERNAL, BASIC, CHARGEN and 1541 ROMs are Commodore's copyrighted
> property.** They are **not** bundled, and you must obtain them legally. The app
> never ships, hosts or downloads them.

**Have VICE installed?** Press **CHOOSE…** and pick VICE's top folder; all four
images are found inside it. Your browser may call that an upload, but nothing is
sent anywhere.

**Otherwise**, press **LOAD…** for each ROM. **🔍 help me find it** searches the
web for that exact filename; the emulator never fetches it. A licensed set is
sold at c64forever.com.

**KERNAL**, **BASIC** and **CHARGEN** are required; **1541 DOS** is optional, for
True Drive Emulation. Any compatible revision works. These are the names the
search looks for:

- **KERNAL**: `kernal.901227-03.bin` (8 KB)
- **BASIC**: `basic.901226-01.bin` (8 KB)
- **CHARGEN**: `characters.901225-01.bin` (4 KB)
- **1541 DOS**: `1541-II.251968-03.bin` (16 KB, optional)

The button reads **Done** once the three required ROMs are in. They are cached in
your browser, so this is a one-time step; **⚙ OPTIONS ▸ ROM Files** shows what is
loaded and can **CLEAR** it. See [Specifications](SPECIFICATIONS.md) on revisions.

---

## 2. Power on

Press **POWER**. After the RAM-test pause you land on the light-blue BASIC
screen with the blinking `READY.` cursor. This is a real cold boot, not a
picture of one.

- **POWER** turns the machine on and off. Powering off tears the machine down;
  powering on builds a fresh one.
- **↺ RESET** is a hard reset, the same as a power-cycle. Use it if a demo
  wedges.
- Black screen, or an "Awaiting ROM files…" note? The ROMs are missing; go back
  to [Set up ROMs](#1-set-up-roms).

---

## 3. Load a program

Drag any supported file onto the screen and it goes to the right place, or use
**▶ LOAD ANY** on the [Media load](USER-GUIDE.md#media-load) card.

| Format | What happens |
|--------|--------------|
| `.prg` | Written onto a disk of its own and [started in drive 8](USER-GUIDE.md#loading-a-prg). |
| `.d64` | The emulator types `LOAD"*",8,1` and `RUN`. See [Disk drive 8](USER-GUIDE.md#disk-drive-8). |
| `.crt` | The [cartridge](USER-GUIDE.md#cartridge) takes over at once, or on the next power-on if inserted while off. |
| `.tap` `.wav` `.dmp` | Becomes a tape in the [Datasette](USER-GUIDE.md#datasette): type `LOAD`, then press **▶ PLAY**. |
| `.reu` | Fills the [RAM Expansion](USER-GUIDE.md#ram-expansion). |

**AUTORUN**, on by default, types `RUN` or the right `SYS` for you. Turn it off in
**⚙ OPTIONS ▸ Media** to stay at `READY.` and start the program yourself.

The drive card lists the disk's directory: click any program to load just that
one, or press **🔍** to see the filename artwork many demos hide there.

Everything you open is remembered. **📂 LOAD LIB** relaunches it with one click,
and moves the whole [library](USER-GUIDE.md#library-dialog) between browsers.

---

## 4. Type and use the keyboard

Just start typing: your keyboard is wired straight into the C64 keyboard
matrix. A few keys are remapped so the C64-only ones are reachable:

| Host key | C64 key |
|----------|---------|
| `TAB` | INST/DEL |
| `F9` | RUN/STOP |
| `F10` | Commodore (⌂) key |
| `F11` | CLR / HOME |
| `F12` | RESTORE (RUN/STOP + RESTORE resets BASIC) |

Not sure where a symbol lives? **KEY MAP** shows a clickable on-screen keyboard.
Need to get a BASIC listing in quickly? **📋 PASTE** types your clipboard into
the machine.

---

## 5. Play with a joystick, mouse, or paddle

The C64 has two control ports. Assign each on the
[Control Ports](USER-GUIDE.md#control-ports) card:

- **Joystick**: a USB or Bluetooth gamepad. Browsers only reveal a pad once it
  sends input, so press a button first, then pick which pad drives which port.
- **[Touch Joystick](USER-GUIDE.md#touch-joystick)** (phones and tablets): a
  stick lower left, two buttons lower right.
- **[Key Joystick 1 / 2](USER-GUIDE.md#key-joystick)**: two keyboard sticks, so
  two people can share a keyboard. **1** is the arrow keys with **K** / **L** to
  fire, on Port 2 where most games expect it; **2** is WASD with **C** / **V**.
- **Mouse (1351)**: the proportional GEOS-style mouse. Click the screen to
  capture the pointer; left button fires, right is up.
- **Mouse (NEOS)** and **Paddle** for software that expects them. **None**
  leaves the port empty.

**SWAP PORTS** exchanges the two assignments in one click.

---

## 6. Pause, reset, and save your place

- **⏸ PAUSE** freezes and mutes the machine where it is; press again to resume.
- **↺ RESET** does a hard reset, the same as a power-cycle.
- **💾 SAVE STATE** freezes the whole machine (RAM, every chip, and whatever
  disk, tape or cartridge is inserted) into a named slot with a thumbnail. Pick
  it up later with **📂 LOAD STATE**. Save is available while a program runs.

Save states live in this browser, survive reloads, and can be **exported to a
file** and imported elsewhere, so you can hand a mid-game snapshot to someone on
another machine. A save state is a permanent bookmark; PAUSE is a temporary
freeze.

---

## 7. Make it look and sound right

On the [Controls](USER-GUIDE.md#controls) card, **SIZE** cycles
**1X / 2X / 2.5X / 3X / MAX** and **⛶ FULL** goes fullscreen, always keeping the
C64's own proportions. **VIBES** opens
[Retro Vibes](USER-GUIDE.md#retro-vibes) full-screen: a 3D C64 whose TV plays the
live picture, with **🎬** to cycle scenes and **🥽 Enter VR** if you have a
headset.

In [⚙ OPTIONS](USER-GUIDE.md#options):

- **Display**: **🖥 CRT** cycles the display looks, from scanlines to a rolling
  mains-hum bar. **ATTRACT MODE** toggles the powered-off animation.
- **Video**: the **VIC-II**, **6569** (original PAL) or **8565** (later C64C),
  and the palette, **Colodore** (modern) or **Pepto** (2001 measurements).
- **Sound**: the **SID**, **6581** (warmer filter) or **8580** (cleaner), volume
  with mute, and **DRIVE SOUND** for 1541 motor hum and head clicks.

All of these persist across reloads.

---

## 8. True 1541 drive (TDE)

**TDE** is on by default: a real emulated 1541, with its own CPU and DOS, runs
alongside the C64, so cracked intros, fastloaders, demos and copy-protection
tricks behave like the real thing. It needs the 1541 ROM from
[Set up ROMs](#1-set-up-roms); without one the toggle stays disabled.

Off, you get the fast built-in load: instant, fine for plain games, but no SAVE
and no fastloaders. The toggle is on
[Disk drive 8](USER-GUIDE.md#disk-drive-8).

---

## 9. On phones and tablets

The emulator is a Progressive Web App: choose **Add to Home Screen** in your
browser's menu to run it like a native app, offline included.

Tap the screen to bring up the device keyboard, assign
[Touch Joystick](USER-GUIDE.md#touch-joystick) on the Control Ports card to play,
and turn to landscape with **⛶ FULL** for the biggest picture. Switching away and
back is safe: the machine pauses and mutes, then resumes where it was with no
audio blip and no catch-up stutter.

---

## Where to next

- **[User Guide](USER-GUIDE.md)**: the full reference for every control, card
  and dialog.
- **[Features](FEATURES.md)**: everything the emulator supports, from the
  user's side.
- **[Architecture](ARCHITECTURE.md)**: how the machine is wired together, and
  the way into every chip's deep-dive.
