<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->
<!-- description: The C64 READY. interface: the header, the display, the status and control cards, the key map, how to rearrange the side panel, and the chat. -->

# The interface

The header, the display and the cards that run the machine, how to arrange
them, and the chat. Part of the [User Guide](USER-GUIDE.md).

## Header

![The header: the C64 READY. wordmark on the left, and ABOUT, DOCS, GitHub, YouTube and Facebook buttons on the right.](/guide/header.webp)

| Control | What it does |
| --- | --- |
| **C64 READY.** wordmark | The logo. Purely decorative. |
| **Appearance** (moon, sun or screen) | Switches the interface between dark, light and following your system's setting. From following the system (the default), the first click shows the other mode, the second your system's own, the third goes back to following the system. The icon shows the current setting: a moon for dark, a sun for light, a screen for following the system (the default). The same setting is **APPEARANCE** in Options ▸ Theme. Shown on phones too. |
| **ABOUT** | Opens the About panel: what the emulator is, how the project started, the current known-issues, and credits. |
| **DOCS** | Opens this documentation site. |
| **CHAT** | Opens the [chat](#chat) with other C64 READY. users. A number on the button counts messages that arrived while the chat was closed. Shown on phones too. |
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
- **Drag & drop** a `.PRG`, `.D64`, `.CRT`, `.TAP`, `.T64`, `.SID` or `.REU` file
  onto the screen to load it (pointer devices). The hint below the monitor reminds you.
- **On touch devices**, tap the screen to raise the on-screen keyboard; the hint
  changes to say so.

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
| **VIBES** | Opens [Retro Vibes](GUIDE-LOOKS.md#retro-vibes), a full-screen 3D scene of the C64. |
| **KEY MAP** | Shows the full [keyboard mapping](#key-map). |
| **📋 PASTE** | Reads your system clipboard and types it into the C64 keyboard buffer, handy for pasting BASIC listings. |
| **⚙ OPTIONS** | Opens [Options](GUIDE-OPTIONS.md#options): VIC-II / SID / palette variants, display and sound toggles, and ROM files. |
| **● RECORD** | Records the whole window with sound to an `.mp4`; see [Recording](GUIDE-LOOKS.md#recording). Requires browser screen capture and media recording support. |

---

## Rearranging the interface

The side panel is yours to lay out: cards can be reordered, moved between the
columns, hidden, and brought back. Everything here is remembered in this browser.

### Rearranging

Drag a card by its grip handle (**⠿**) to move it within its column or across to
the other; a dashed outline shows where it will land. Put every card in one
column if you like; the other stays an outlined empty target.

From the keyboard, Tab to a card's handle, then use **↑** / **↓** to move the
card within its column, **←** / **→** to move it to the other column, and
**Home** / **End** to send it to the top or bottom.

### Hiding

While you drag, a square **Hide** target appears in the bottom-right corner. Drop
a card there and it leaves the panel, keeping its place in the saved layout.
From the keyboard, press **Delete** (or **Backspace**) on a card's handle.

![A side-panel card held over the Hide target in the bottom-right corner of the screen, the target lit up, with the dashed outline of the space the card came from still open in the column.](/guide/panel-hide.webp)

### Adding one back

While anything is hidden, a **+** sits in that corner. It opens a picker of the
hidden cards; choosing one puts it back at the bottom of its column. From the
keyboard, Tab to the **+** and press **Enter**, use **↑** / **↓** to pick a card in
the list, and **Enter** again.

![The "Show hidden panels" dialog listing Cartridge and Datasette, each a row you can click to bring that panel back.](/guide/panel-restore.webp)

**Options ▸ Display ▸ RESET PANELS** is the way back for everything at once; the
original order, and every hidden card with it.

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

## Chat

The **CHAT** button in the header opens a window where you can talk with other
C64 READY. users about what you are playing. It is optional: nothing about it
loads or connects until you open it.

![The chat window floating beside Commando's title screen: a room titled "Chat about Commando", marked as loaded, where three people trade tips about the game.](/guide/chat.webp)

### Joining

There is no sign-up. Pick a nickname (up to 16 characters) and you are in. The
nickname is remembered in this browser, and **change** in the lobby picks
another.

A room lives only while people are in it. It closes when everyone has left
(or has been gone for a minute), after four hours without messages, or after a
day at the most. Rooms are moderated: the host, the members and the C64 READY.
admin can remove people. The chat is logged, so abuse and crime can be
investigated (see [What is shared](#what-is-shared)).

### Starting a room

- **Start a room about…** offers a button for each thing that is loaded: the
  disk in drive 8 or 9, the cartridge, the tape. A room started from one is
  named after it and knows what it is about. The name comes from the
  Assembly64 release when the file came from the catalog, otherwise from a
  title stored in the file (a SID tune, a cartridge), the file name, or the
  disk's header, in that order.
- **CREATE** starts a room with a name of your own.

### Joining a room

Every room is open to everyone. **Rooms** in the lobby lists them all, with
how many people are in each, those about something you have loaded first.
**JOIN** takes you in.

### In a room

| Control | What it does |
| --- | --- |
| **PEOPLE** | Shows who is in the room. The host is marked, and so is anyone away: their connection dropped, and the room keeps their place for a minute. |
| **LEAVE** | Leaves the room. Closing the window does not: you stay in the room, and the **CHAT** button counts new messages. |
| **LOAD** | When the room is about an Assembly64 release you do not have loaded, loads it, so everyone plays the same thing. |
| **FIND ON ASSEMBLY64** | When the room is about something else you do not have loaded, searches the catalog for its title. |
| **🙂** (next to **SEND**) | Opens a choice of emojis, and puts the one you pick in your message where the cursor is. **Esc** or a click elsewhere closes it. |

Under **PEOPLE**, next to each member:

- **hide** hides their messages on your screen only, and **show** brings them
  back.
- **vote to remove** counts toward removing them. A majority of the others
  present removes anyone, the host included, and it always takes at least two
  people agreeing. Several connections from one place count as one vote.
- **report** sends them, with the room's recent messages, to the C64 READY.
  admin.
- The host also has **mute** (they can read but not write, even if they leave
  and come back) and **remove** (they cannot come back while the room is open).

When the host leaves, the member who has been there longest becomes the host.

### On a desktop and on a phone

On a desktop the chat floats over the app. Drag it by its title bar, resize it
from its sides and bottom corners, and it opens where you left it. The machine
keeps running underneath. Typing in the chat never reaches the C64, and
clicking the screen gives the keyboard back to it. **Esc** closes the window.

On a phone the chat fills the screen, and the phone's **Back** button closes
it. In fullscreen mode a chat button sits next to the close button.

### What is shared

Your nickname and messages go to the people in your room and to the C64 READY.
admin, who can see every room live. The admin's live view shows a short code
made from your IP address, not the address itself.

The chat server logs every message, and every join, leave and moderation step,
with your nickname and IP address. The log is kept for 90 days and then
deleted. Only the admin can read it, and it is shared only when the law
requires it.
