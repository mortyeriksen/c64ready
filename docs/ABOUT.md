<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->

# About C64 READY.

Switch it on and it's the 80s again: the blue boot screen, the blinking cursor, the 1541 chattering awake, a SID tune warming up as the demo kicks in. That feeling, pure <em class="nostalgia">nostalgia&nbsp;🕹️</em>, is what C64 READY. is really about.

It's a Commodore 64 rebuilt from the silicon up, running right in your browser. No plugins, nothing to install. Just open it and play.

### What it stands for

- **Easy, never bloated.** It should feel like flipping a switch, not flying a plane.
- **Faithful enough to run anything.** If a real breadbin runs it, so does this.
- **Runs anywhere.** Desktop or phone, online or offline, and it installs as its own app if you want.
- **Serious emulation, retro vibes.** Cycle-exact silicon underneath, built for the sheer joy of it.

### What it does

- **Runs the demos that stump other emulators.** The wildest custom fastloaders load and run, cycle for cycle. → [the 1541 drive](/docs/drive-architecture.html)
- **Backed by 2,400+ labeled tests**, covering the CPU, VIC-II, SID, CIA, PLA, drive, datasette, cartridges, input, save states, and integration edge cases. → [the test suite](/docs/testing.html)
- **Save state, resume anytime.** Snapshot the exact machine to a file and pick up right where you left off, mid-demo or mid-boss-fight. → [the user guide](/docs/user-guide.html)
- **Sounds the way it was written.** Both SID chips, 6581 and 8580, filters and all. → [the SID](/docs/sid-architecture.html)
- **Bring your own everything.** Disk, tape, cartridge or .prg; joystick, gamepad or keyboard. → [getting started](/docs/getting-started.html)

Curious how it all works? The [technical docs](/docs/) go chip by chip.

### Retro Vibes

Step into an 80s bedroom bathed in synthwave light, your C64 humming on the desk with the demo playing live on its 1702 monitor. It's the emulator, but make it a scene, and you can slip on a headset and pull up a chair, because it runs in VR, too. → [Retro Vibes](/docs/retrovibes-architecture.html)

### How it started

It began as a plan to drop a SID tune into my retro game, [Cosmic Bounce](https://www.cosmicbounce.xyz) (which already had a MOD player). The SID player came together fast, and then the obvious-in-hindsight question hit: *could I build the whole machine in a browser?* A breadbin's worth of tokens and late nights later, here we are.

And along the way it became the best kind of learning project: a deep dive into every corner of the C64's hardware and software, and where I learned to build something this complex by vibe coding.

I **love** this machine: the blocky charset, the PETSCII art, the rasterbar demos that still bend my brain forty years on, the chiptune scene that never stopped composing. To every demo coder, SID composer, cracker, doc author, emu hacker and glorious lunatic keeping the C64 alive: **thank you**. C64 READY. stands on your shoulders.

Full references and acknowledgements are in [Specifications, source material and credits](/docs/specifications.html).

### Known issues

It's a work in progress: a few small visual glitches remain, and there's more performance to squeeze out. Nearly everything runs faithfully, but now and then you may spot something off. The current list lives in the [known-issues doc](/docs/known-issues.html). The code lives on [GitHub](https://github.com/mortyeriksen/c64ready); please [file an issue](https://github.com/mortyeriksen/c64ready/issues) for anything you run into.

### Privacy

Everything runs in your browser. Your ROMs, disks, tapes, cartridges and save states stay in the browser's own storage and are never uploaded. There are no cookies and no third-party scripts. The only thing counted is a few anonymous page hits the app makes, once per launch or ROM setup. Those hits let the hosting service's server-side statistics show how many sessions run installed or with ROMs; they carry no data and no identifier.

### About the author

Hi, I'm Morten (RetroMorty). Back in the 90s I ran with the PC demo scene in the group **Twilight Zone**; under **Twilight Zone Software** we built the game [Interpose](https://www.facebook.com/interposegame), where I was project manager and programmer, years that left me fluent in x86 assembly and passingly dangerous in C64 assembly. In 2000 I founded [Enonic](https://www.enonic.com), where I'm still CEO today.

The love never left: three C64s, a Commodore 1084S monitor, and a good stash of games and joysticks are always within reach. C64 READY. is my love letter to the machine and the scene that started it all.

Follow C64 READY. on [Facebook](https://www.facebook.com/c64ready) and [YouTube](https://www.youtube.com/@c64ready), contact me on [LinkedIn](https://www.linkedin.com/in/morten/), or email [mortyeriksen@gmail.com](mailto:mortyeriksen@gmail.com).

### License and source

C64 READY. is free software under the [GNU General Public License, version 3 or later](/docs/license.html), distributed without warranty; see the GPL for copying and modification rights. The [full source](https://github.com/mortyeriksen/c64ready) lives on GitHub, and the third-party credits, licenses, and trademark disclaimer are collected in the [notice](/docs/notice.html).
