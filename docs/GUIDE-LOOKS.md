<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->
<!-- description: Themes and the theme file format, the Retro Vibes 3D viewer with its scenes, and recording video of what you play in C64 READY. -->

# Looks and Retro Vibes

Themes and their file format, the Retro Vibes 3D viewer, and recording what you
play. Part of the [User Guide](USER-GUIDE.md).

## Themes

A theme sets the interface's colours, and can lay a faint pattern on the page
behind the panels. **Classic** is the default, and five more are built in.
Each has a pattern of its own: Classic a large, subtle grid, GEOS a dither
like its desktop, Breadbin a woven crosshatch, Phosphor scanlines in dark
mode and green-bar paper in light, Out Run a finer grid and Commando dots. The gallery below shows each in dark mode on the left and
light mode on the right; step through it with **Previous** and **Next**. The screen, the CRT looks and Retro Vibes keep their
own colours whatever the theme, and you can import your own too. On a first
visit, the welcome screen wears one of the built-in themes at random, and the
app keeps that theme when you leave it.

<!-- gallery themes -->

**Classic**: The C64's own blue, from the boot screen.

![Classic: deep VIC blue in dark mode, white Paper panels with blue text in light mode.](/guide/theme-classic.webp)

**GEOS**: Black on white, like the C64's own desktop.

![GEOS: white on black in dark mode, black on white in light mode.](/guide/theme-geos.webp)

**Breadbin**: The machine itself: brown keys in dark mode, the beige case in light.

![Breadbin: brown keyboard with cream text and orange accents in dark mode, the beige case outlined in key brown with red and blue accents in light mode.](/guide/theme-breadbin.webp)

**Phosphor**: An amber monitor in dark mode, green-bar printer paper in light.

![Phosphor: amber on black in dark mode, black ink on white paper ruled in green over a green-bar page in light mode.](/guide/theme-phosphor.webp)

**Out Run**: The sunset over the road: neon night in dark mode, a pink and orange sky in light.

![Out Run: a magenta horizon glow over violet night with yellow and cyan accents in dark mode, a pink-to-orange sunset sky with lilac panels and magenta edges in light mode.](/guide/theme-outrun.webp)

**Commando**: Night road and muzzle flash in dark mode, khaki and olive drab in light.

![Commando: sand on dark brown with orange accents in dark mode, khaki outlined in olive drab with muzzle-flash orange accents in light mode.](/guide/theme-commando.webp)

<!-- /gallery -->

Pick one with **THEME** in [Options ▸ Theme](GUIDE-OPTIONS.md#theme). **IMPORT** loads a theme
file, which then stays in this browser; **REMOVE** takes an imported one
out again. **EXPORT** saves the current theme with every colour filled in,
so exporting Classic gives you a complete file to start your own from. The
one exception is the button colours (see **Buttons** below): a theme that
leaves them out exports without them, so they keep following its other
colours as you edit.

A theme file is JSON. Here is the start of one, with Classic's colours; the
`…` lines stand for the rest. A complete file has 155 colours per mode, 137
without the button colours and the pattern ink, but a theme only needs the
ones it changes.
Export Classic to get the whole file to edit.

```jsonc
{
  "format": "c64ready-theme/2",
  "name": "My theme",
  "author": "optional",
  "modes": {
    "dark": {
      "crt-bg": "#070a1c",
      "ui-bg": "#0b0e24",
      "panel-bg": "#11142e",
      "border": "#2c2f63",
      "control-bg": "#1a1a30",
      "text": "#ccd0ec",
      "dim": "#8e8eb7",
      "accent": "#7471ec",
      "green": "#8fe985",
      "amber": "#e6dd6b",
      "red": "#d76b70",
      …
    },
    "light": {
      "crt-bg": "#e8e9f3",
      "ui-bg": "#f4f5fb",
      "panel-bg": "#ffffff",
      "border": "#cfd2e7",
      "control-bg": "#eef0f8",
      "text": "#23264d",
      "dim": "#53567d",
      "accent": "#4c49c0",
      "green": "#2a7337",
      "amber": "#7a5d00",
      "red": "#b8323b",
      …
    }
  },
  "look": {
    "dark": { "pattern": "grid", "size": "medium" }
  }
}
```

- **Modes**: give `dark`, `light` or both. A theme with only one mode always
  shows that one, whatever the appearance setting.
- **Colours**: each key is one of the interface's colour names (an exported
  file lists them all), and each value a plain colour: `#rgb`, `#rrggbb`,
  `#rrggbbaa`, `rgb()` or `rgba()`. Any colour you leave out keeps its Classic
  value for that mode.
- **Buttons**: buttons have colours of their own, `button-bg` for the face and
  `button-text`, `button-dim`, `button-accent`, `button-accent2`,
  `button-green`, `button-amber` and `button-red` for the labels. Leave them
  out and buttons use the theme's `control-bg`, `text`, `dim` and accent
  colours, the same as the fields; set them to give buttons a look of their
  own. The main actions, **LOAD ANY**, drive 8's **LOAD** and Assembly64's
  **EXPLORE**, have a set of their own again, `primary-bg`, `primary-text`,
  `primary-dim`, `primary-accent`, `primary-accent2`, `primary-green`,
  `primary-amber`, `primary-red` and `primary-border`; left out, they are the
  button colours and the border.
- **Keys**: key labels, and the keys you can press in Control Ports and
  **KEY MAP**, are neutral tints of the theme's `text` colour. `kbd-bg`,
  `kbd-border`, `kbd-hover` and `kbd-ink` no longer change anything; a theme
  that sets them still imports.
- **Page pattern**: the optional `look` names a pattern for each mode, drawn
  on the page behind the panels: `dither`, `bars`, `scanlines`, `grid`,
  `dots`, `weave` or `none`, with a `size` of `small`, `medium` (the default)
  or `large`. It is drawn in `pattern-ink`, which has to be faint, an alpha of
  0.15 or less such as `rgba(0, 0, 0, 0.08)`, so the header text over it stays
  readable; left out, the pattern uses the theme's `text` colour at 0.07. On
  a system set to ask for more contrast the page stays plain. A file in the
  older `c64ready-theme/1` format still imports, with no pattern.
- **Checks**: a file with an unknown name, a value that is not a colour, a
  pattern or size that is not on the list, an ink stronger than 0.15, or a
  missing `name` or `modes` is refused, and the message says which. Importing a
  file with the same name as an imported theme replaces it.

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
| **Cmd+Shift+X** / **Ctrl+Shift+X** | **Studio mode**: hides everything else in this table (the mouse pointer included) and leaves the scene alone with the C64 READY. logo, for screenshots and video. The same keys bring the controls back. It is remembered, so the scene reopens the way you left it. |
| **✕** or **Esc** | Close and return to the emulator. |

### Scenes

The **🎬** button cycles through five scenes. Each strip in the gallery shows
the scene from the default view, up close, and from a low angle; step through
them with **Previous** and **Next**.

<!-- gallery scenes -->

**Synthwave**: A glowing neon grid under a banded sun and wireframe mountains.

![Three views of the Synthwave scene: the C64 setup on a glowing neon grid under a banded Outrun sun and wireframe mountains.](/guide/retro-vibes-synthwave.webp)

**Starry Plain**: A pulsing grid beneath the Milky Way and the occasional meteor.

![Three views of the Starry Plain scene: the machine on a dark pulsing grid beneath a blue-violet Milky Way, deep star field and occasional meteor.](/guide/retro-vibes-starry-plain.webp)

**Spotlight**: One warm spotlight in the dark, the live CRT colouring the floor.

![Three views of the Spotlight scene: the setup picked out of pitch darkness by a single warm overhead spotlight, grounded on a matte studio floor while the live CRT softly colours its surroundings.](/guide/retro-vibes-spotlight.webp)

**IK+ Sunset**: A courtyard by the bay at dusk, a torii gate before the setting sun.

![Three views of the IK+ Sunset scene: a stone courtyard by a bay at dusk, a black torii gate rising from the water in front of the setting sun, an autumn maple and a fishing village on the shores.](/guide/retro-vibes-ikplus.webp)

**80s Bedroom**: A teenager's bedroom at night, the C64 under an amber lamp.

![Three views of the 80s Bedroom scene: a 1980s teenager's bedroom at night, the C64 on a wooden desk under an amber lamp, a plaid-duvet bed, venetian blinds with stars beyond, posters and a corkboard on patterned wallpaper, a wood-grain TV beside the desk and clutter on the floor.](/guide/retro-vibes-80s-bedroom.webp)

<!-- /gallery -->

Which model loads is set by **3D MODEL** in [Options](GUIDE-OPTIONS.md#options).

---

## Recording

Capture the whole browser window, with sound, to an `.mp4` video using the
**● RECORD** button in [Controls](GUIDE-INTERFACE.md#controls), enabled once the machine is
powered on. Click it, pick the window (or screen) to share in the browser prompt,
and the button becomes **⏹ STOP RECORDING**. Press stop and the file downloads
as `c64ready-<date-and-time>.mp4`.

- **It records everything on screen**, [fullscreen](GUIDE-INTERFACE.md#controls) and
  [Retro Vibes](#retro-vibes) included: share **"Entire Screen"** in the
  browser's prompt for those, since a window or tab share does not follow the
  picture into fullscreen. The button lives in the side panel, so start
  recording *before* you enter those modes; to stop from inside them, use the
  browser's "Stop sharing" control, or leave the mode and press
  **⏹ STOP RECORDING**.
- **The audio is the emulator's own output**, tapped directly, so it stays clean
  and in sync even while the machine is muted.
- **The video has a resolution ceiling**, set by **RECORDER** in
  [Options ▸ Other](GUIDE-OPTIONS.md#other), 1080p by default. Without it, a HiDPI display would
  record far more pixels than the C64 picture needs. A larger surface is scaled
  down to fit, aspect ratio intact; a smaller one is recorded as it is; **NATIVE**
  removes the ceiling. Browsers that ignore the request record at native size.
- **Desktop Chrome and Safari** (and other Chromium browsers such as Edge, Opera,
  Brave). Elsewhere the button explains why instead of recording.
- **Safari may end the capture when the page loses focus**, for example on a
  file dialog or an app switch. The recording so far is saved and the status
  line says what happened. For a long take, load what you need before pressing
  RECORD, or use Chrome.
