<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->

# Specifications, source material and credits

The emulator follows publicly-available hardware references. VICE (`x64sc`)
is also the runtime cross-check oracle; the diff workflow is documented in
[testing.html](TESTING.md#cross-checking-against-vice-reference-oracle).

With gratitude to the VICE team. The following was important to the success of
this project:

- **VICE**: the gold-standard C64 emulator, used as the runtime comparison
  oracle.
  <https://vice-emu.sourceforge.io/>
- **VICE test progs**: cycle-exact hardware test suite.
  <https://github.com/libsidplayfp/VICE-testprogs>

## General C64 references

- **_Commodore 64 Programmer's Reference Guide_** (Commodore, 1982): the
  register-level description of sprites (§3.5) and the `$01` port / banking
  (§3.3) several spec tests are written against.
- **_Mapping the Commodore 64_**: Sheldon Leemon (Compute!, 1984); the memory
  map the PLA tests check a few entries of.

## References by subsystem

### VIC-II video (6567/6569/8565)

- **Bauer**, _The MOS 6567/6569 video controller (VIC-II) and its application in
  the Commodore 64_: the primary reference.
  <https://www.cebix.net/VIC-Article.txt>
- **VICE addendum**: _VIC-II Addendum: Key Technical Differences from Bauer's
  Article_ (Kahlin / Nuotio / Lankila / Matthies, rev 0.3, 20100729): supplements
  Bauer where it was incomplete or wrong.
  <https://sourceforge.net/p/vice-emu/code/HEAD/tree/techdocs/VICII/VIC-Addendum.txt>
- **"Nine" by Linus Åkesson (lft)**: the author's explanation page is used
  directly as a spec for several VIC-II tricks. Thank you, Linus, for all your
  brilliant demos and inspiration.
  <https://www.linusakesson.net/scene/nine/explanation.php>
- **Pepto / Colodore palettes**: Philip "Pepto" Timmermann's measured PAL
  palette (2001) and his Colodore successor. Both ship as the emulator's
  selectable color palettes (`PALETTES` in `src/vic2-tables.js`); Colodore is the
  default.
  <https://www.pepto.de/projects/colorvic/>  ·  <https://www.colodore.com>
- **Bumbershoot Software**: VIC-II/CPU interaction timing articles ("VIC-II
  interrupt timing"; VIC-before-CPU same-cycle ordering, BA lead time),
  corroborating Bauer §3.6.1/§3.8.1.
  <https://bumbershootsoft.wordpress.com/2015/07/26/vic-ii-interrupt-timing-or-how-i-learned-to-stop-worrying-and-love-unstable-rasters/>

### 6510 / 6502 CPU

- **MOS 6502 datasheet**: cycle counts and microarchitecture (the MOS 6500-family
  MPU datasheet).
  <https://6502.org/documents/datasheets/mos/mos_6500_mpu_preliminary_may_1976.pdf>
- **Klaus Dormann's 6502 functional test**: exhaustive opcode/flag verification.
  <https://github.com/Klaus2m5/6502_65C02_functional_tests>
- **groepaz, _NMOS 6510 Unintended Opcodes_**: ground truth for the illegal
  opcodes: the SH* family's address-high instability and JAM/KIL behavior (as
  also presented in Michael Steil's c64ref).
  <https://www.pagetable.com/c64ref/6502/>
- **64doc**: John West & Marko Mäkelä's cycle-by-cycle 65xx reference; cited
  for illegal-opcode semantics (ARR's decimal-mode interaction).
  <https://www.atarihq.com/danb/files/64doc.txt>
- **Visual6502**: transistor-level 6502 simulation, cross-checked for the
  same illegal-opcode edge semantics.
  <http://www.visual6502.org>
- **Bruce Clark, _Decimal Mode_**: the definitive tutorial on 6502 BCD
  arithmetic; the ADC/SBC decimal-mode algorithm follows his analysis.
  <http://www.6502.org/tutorials/decimal_mode.html>
- **Adam Vardy, _Extra Instructions Of The 65XX Series CPU_** (1996): the
  illegal-opcode cycle-count table the opcode audit test compares against.
  <http://www.ffd2.com/fridge/docs/6502-NMOS.extra.opcodes>

### CIA / 6526

- **MOS 6526 (CIA) datasheet**: timers, TOD, and serial-register behavior
  (the CIA spec tests cite the re-typeset archive.org copy by sheet number).
  <https://6502.org/documents/datasheets/mos/mos_6526_cia_preliminary_nov_1981.pdf>  ·
  <https://archive.org/details/mos_6526_cia_recreated>
- **Wolfgang Lorenz, _A Software Model of the CIA6526_**: reverse-engineered cycle
  timing plus the CIA compatibility test suite this project validates against.
  <https://ist.uwaterloo.ca/~schepers/MJK/cia6526.html>

### SID 6581 / 8580 audio

- **MOS Technology 6581 Sound Interface Device**: original SID data sheet
  covering the register map, oscillator, envelope, filter, and external
  interface.
  <https://6502.org/documents/datasheets/mos/mos_6581_sid.pdf>
- **Bob Yannes**: the original SID designer's design rationale for the
  envelope model, its small ADSR-rate lookup table, and the 23-bit
  pseudo-random noise generator, from Andreas Varga's 1996 interview. The exact
  rate periods and noise-output taps used here come from reSID / resid-test.
  <https://trondal.com/c64sid/yannes.html>
- **reSID** by Dag Lem: the SID engine is substantially a JavaScript
  translation of reSID (GPL-2.0-or-later, conveyed within this
  GPL-3.0-or-later project): oscillator/waveform/noise timing, the pipelined
  ADSR envelope, the measured combined-waveform tables (OSC3 samplings of
  real chips, embedded verbatim), the R-2R DAC models with subthreshold
  leakage, the transistor-level filter / mixer / nonlinear volume stage
  (`filter8580new`), the C64 external RC filter, and the Kaiser-sinc audio
  resampler. The selectable WASM engine is the same model twice removed: a
  Rust translation of this project's JavaScript (`rust/sid/`, the
  corresponding source), compiled to WebAssembly and embedded; its output
  is bit-identical to the JavaScript engine by test.
  <https://github.com/daglem/reSID>
- **VICE (The VICE Team)**: the port is pinned to reSID **as distributed in
  VICE 3.10's modified `src/resid` tree**, because headless VICE x64sc is
  this project's byte-level regression oracle. Some ported behaviors exist
  only in VICE's tree (the measured gradual TEST-bit fade of the noise shift
  register; the improved 8580 filter model VICE's default build compiles),
  and the runtime parameter conventions of VICE's reSID wrapper (filter
  bias, resampler passband/gain, output amplification) are followed for
  oracle parity. The exact upstream pin (official VICE 3.10 source release,
  tarball sha256) is recorded in NOTICE.txt.
  <https://vice-emu.sourceforge.io/>
- **Combined-waveform sample lineage**: the embedded wave tables descend
  from OSC3 samplings of 6581 R1/R3/R4 and 8580 R5 chips provided to reSID
  by **Tibor Biczo, Andreas Boose, and André Fachat** (reSID THANKS).
- **reSIDfp / Antti Lankila**: 6581 filter/distortion research and SID
  measurement lineage preserved through reSID citations. No reSIDfp source
  is ported; the filter stage comes from reSID's `filter8580new` model.
  <https://github.com/libsidplayfp/libsidplayfp>

### Memory / PLA / banking

- **"The C64 PLA Dissected"** by Thomas 'skoe' Giesel: 82S100 PLA behaviour;
  the ground truth for the banking / `$01`-port / Ultimax mapping logic in
  `memory.js`. Table A.11 also defines the VIC-II's Ultimax view used by
  `vic2.js`: cartridge ROMH at local `$3000-$3FFF`, with DRAM rather than
  character ROM in the remaining VIC windows.
  <https://www.skoe.de/docs/c64-dissected/pla/c64_pla_dissected_a4ds.pdf>

### ROM images

The C64 and 1541 ROMs aren't bundled (they're copyrighted); you supply them
once. The emulator was developed and tested against these specific CBM ROM
revisions:

- **KERNAL**: `kernal.901227-03.bin` (8 KB)
- **BASIC**: `basic.901226-01.bin` (8 KB)
- **CHARGEN**: `characters.901225-01.bin` (4 KB)
- **1541 DOS**: `1541-II.251968-03.bin` (16 KB, optional, for True Drive Emulation)

### Cartridges

- **CRT cartridge image format**: from the CCS64 emulator (Per Håkan Sundell); the
  64-byte header + CHIP packets that `src/crt.js` parses.
  <https://ist.uwaterloo.ca/~schepers/formats/CRT.TXT>
- **Final Cartridge III hardware**: ReplayResources register description plus
  Thomas Giesel's hardware-derived errata define the four 16 KB banks, permanent
  IO1/IO2 ROM mirror, `$DFFF` EXROM/GAME/NMI/hidden-register latch, and physical
  RESET/FREEZE behavior used by the type-3 mapper.
  <https://rr.c64.org/wiki/Final_Cartridge>
  <https://rr.c64.org/wiki/Final_Cartridge_III_Internals_Errata.txt>
- **Action Replay v4.x/v5/v6 hardware**: the MK5/6 schematic and
  hardware-derived AR6 PLA dump define its 32 KB ROM, 8 KB RAM, mirrored
  `$DE00` latch, IO2 window, cartridge-kill and latched freezer behavior. In
  particular, the schematic's missing R/W qualification on IO1 is why a read
  clocks the current phi1 bus byte into the latch.
  <https://rr.c64.org/wiki/File:Action_Replay_MK5_6.gif>
  <https://rr.c64.org/wiki/File:Ar6pla.rar>
- **EasyFlash hardware**: Skoe's _EasyFlash Programmer's Reference_ defines
  the bank/control registers, EXROM/GAME truth table, and IO2 RAM.
  <https://skoe.de/easyflash/files/devdocs/EasyFlash-ProgRef.pdf>
- **Magic Desk-compatible hardware**: the Universal Cartridge hardware
  description documents the `$DE00` bank latch, 8 KB ROML mapping, and bit-7
  cartridge disable used by this model. Its expanded hardware offers seven
  bank bits; the emulator implements a six-bit, 64-bank subset.
  <https://github.com/msolajic/c64-uni-cart>

### RAM Expansion Unit (1700 / 1764 / 1750)

- **Wolfgang Moser**, _Technical Reference of the REU controller CSG8726R1_
  (rev 1.0, 2008): the authoritative description of the controller: the
  register file, transfer types, autoload and `$FF00` trigger, and the
  end-of-transfer register state.
  <https://zimmers.net/anonftp/pub/cbm/documents/chipdata/CSG8726TechRefDoc-1.0.zip>
- **Commodore 1700/1750 RAM Expansion Module User's Guide**: unit capacities,
  the status size bit, and the DMA rates: 1 MB/s for STASH and FETCH against
  500 KB/s for SWAP, the processor halted throughout, VIC DMA taking precedence.
  <https://www.zimmers.net/anonftp/pub/cbm/manuals/cmd/1750-CLONE-users-guide.txt>

### 1541 disk drive

- **D64 disk-image format**: Peter Schepers, _D64 (Electronic form of a physical
  1541 disk)_. `src/d64.js` follows it for image sizes, BAM layout and directory
  entries, reading and writing alike (`writeSector`, `createBlankD64`, `writePRG`),
  for the per-sector error table `src/gcr.js` turns back into read failures, and
  for the 40-track BAM extension locations.
  <https://ist.uwaterloo.ca/~schepers/formats/D64.TXT>
- **KERNAL load-message entry points**: the TDE-off load trap calls the ROM's own
  `SEARCHING FOR` (`$F5AF`) and `LOADING` (`$F5D2`) routines instead of imitating
  them. Both addresses were identified from the shipped `901227-03` image, not
  quoted from a disassembly; `machine.js` re-checks their opening bytes at run
  time and loads silently on a ROM that doesn't match.
- **_Inside Commodore DOS_** by Immers & Neufeld (Abacus): background
  reference for CBM DOS internals and the disk format. (The byte-ready and
  PA-latch specifics are cited to _Die Floppy_ and the schematics below.)
  <https://archive.org/details/Inside_Commodore_Dos>
- **1541 DOS ROM disassembly**: Michael Steil's buildable, annotated source for the
  251968-01/-02/-03 revisions; ground truth for the true-drive CPU timing.
  <https://github.com/mist64/dos1541>
- **Sparkle**: trackmo loader by Sparta / OMG; its source and Aloft's install
  stream informed validation of the drive's byte-ready/SO timing and IEC
  inter-block handshake.
  <https://github.com/spartaomg/Sparkle>
- **Spindle**: trackmo loader by lft / Linus Åkesson; a compatibility target
  whose command-stream cadence shaped the IEC idle-skip hysteresis.
  <https://www.linusakesson.net/software/spindle/v2.php>
- **Krill's Loader**: IRQ loader by Krill / Plush; its 2-bit IEC transfer
  protocol is a compatibility target the bus-coupling tests guard.
  <https://csdb.dk/release/?id=226124>
- **MOS 6522 (VIA) datasheet**: timers, ports, and handshake lines; the drive's
  two VIA chips (`src/6522.js`) follow it.
  <https://6502.org/documents/datasheets/mos/mos_6522_preliminary_nov_1977.pdf>
- **_Die Floppy 1541_ / _Die Floppy 1570/1571_**: Karsten Schramm (Markt &
  Technik); the GCR/sector framing and mechanics chapters of the 1541 book
  (the drive tests map them), and the VIA2 CA2/SOE gating and byte-ready
  wiring details of the 1570/1571 book (§8.2).
- **1541 schematics / service manual**: the SYNC 10-bit shift register, the
  byte-ready PA latch, the per-zone cycle counts, the **read/write head select**
  (VIA2 CB2), and the **write-protect sense line** (VIA2 PB4, **active low**:
  0 = protected, 1 = write enabled). These govern the write path's mode select and
  write-protect polarity; the latter is cross-checked against the real DOS ROM, which
  raises error 26 ("WRITE PROTECT ON") when PB4 reads low.
  <https://www.zimmers.net/anonftp/pub/cbm/schematics/drives/new/1541/>

### Datasette (1530 / C2N) and tape formats

- **_Analyzing C64 tape loaders_**: the SAVE-side convention `src/datasette.js`
  records by: a pulse is the distance between consecutive **low→high** transitions
  of the cassette write line. Also the polled-`$DC0D` idiom of turbo loaders.
  <https://github.com/binaryfields/zinc64/blob/master/doc/Analyzing%20C64%20tape%20loaders.txt>
- **Peter Schepers**: _TAP (Raw tape image)_: the container's header, the v0/v1
  `$00` escapes, and the reference clocks. Also the encoding `src/tap-audio.js`
  renders to audio and `src/wav-tape.js` writes back out.
  <https://ist.uwaterloo.ca/~schepers/formats/TAP.TXT>
- **Markus Brenner**: the TAP v2 half-wave extension, "starting with a `0`→`1`
  transition", which fixes the edge a recorded pulse is measured from, and which
  `src/tap-audio.js` reproduces as a level toggle per pulse.
  <https://vice-emu.sourceforge.io/vice_17.html>
- **Luigi Di Fraia**: the DC2N _DMP_ dump format: header, tick samples, the
  overflow rule and the v1 half-wave flag, which `src/dmp-tape.js` reads.
  <https://www.luigidifraia.com/technical-info/>
- **RIFF / WAVE** (Microsoft & IBM, _Multimedia Programming Interface and Data
  Specifications 1.0_): the container `src/wav-tape.js` reads and
  `src/tap-audio.js` writes, including `WAVE_FORMAT_EXTENSIBLE`.
  <https://www.mmsp.ece.mcgill.ca/Documents/AudioFormats/WAVE/Docs/riffmci.pdf>
- **Michael Steil (pagetable.com)**: _A Minimal C64 Datasette Program Loader_: the
  pulse trio in TAP units with the `$39`/`$4E` read thresholds, byte frame and
  countdown, which `test/kernal-tape-save-test.js` decodes a recording against.
  <https://www.pagetable.com/?p=964>
- **Turbo Tape 64** (Stephan Senz, 64'er / Markt & Technik, 1983): the format
  `src/tap-turbo-formats.js` reads: the 211/324 µs pulse pair, `$02` lead-in and
  `$09…$01` countdown as laid out in the Lemon64 thread _The turbo speed tape
  format explained?_; the block checksum and the clones' timings are this
  project's own measurements of tapes written by nineteen Turbo Tape 64 savers.
  <https://www.lemon64.com/forum/viewtopic.php?t=84032>

The KERNAL saver's Timer B timings are measured against the real `901227-03` ROM,
not quoted; published tables disagree in the low bits.

Four of the turbo formats have no source to cite at all. GRL-Supertape (Geir
Rune Ladehaug, 1986) was measured off tapes it wrote. Novaload, US Gold /
Datasoft and Gremlin Type 2 were each read out of the loader its own tapes
carry, by disassembling it. So there is nothing published behind any of the
four, and nothing here to credit. What they turned out to be is in
[datasette-architecture.html](DATASETTE-ARCHITECTURE.md).

### Recording container

- **ISO base media file format**: ISO/IEC 14496-12: the boxes `src/mp4-remux.js`
  walks (`moof`/`traf`/`tfhd`/`tfdt`/`trun`) and rebuilds (`stts`/`stsc`/`stsz`/
  `stco`/`stss`/`ctts`) to turn `MediaRecorder`'s fragmented MP4 into a
  progressive, indexed one that editors will trim. `tfdt` carries each fragment's
  true span, which is what lets the remux restore the duration capture stalls lose.
- **MP4 file format**: ISO/IEC 14496-14, for the emitted file's brand and
  structure; **AVC in ISO base media**, ISO/IEC 14496-15, only because the `avcC`
  sample entry is copied through byte for byte. The remux does no codec work.

## Credits

Thank you to every game and demo coder, and every SID composer, and to every
graphic artist, cracker, swapper, and everyone else in the scene, who pushed
the hardware further than anyone thought possible since 1982.

A special thanks goes to the following:

### Demo groups and crackers

**Fairlight** · **Genesis Project** · **Oxyron** · **Crest** · **Razor 1911** ·
**Booze Design** · **Censor Design** · **Triad** · **Performers** · **Reflex** ·
**Bonzai** · **Pretzel Logic** · **Elysium** · **Smash Designs**

### Game developers and publishers

**Sensible Software** · **System 3** · **Beam Software** · **Raffaele Cecco** ·
**Sega** · **Capcom** · **ZeroPaige** · **Nostalgia** · **Hewson** · **Psygnosis** ·
**Ocean** · **Elite** · **Simon Pick** · **Amazing Products**

### SID musicians

**Rob Hubbard** · **Martin Galway** · **Jeroen Tel** · **Chris Hülsbeck** ·
**Ben Daglish**

### Collections and archives

- **CSDb**: the C64 Scene Database.
  <https://csdb.dk>
- **Assembly 64**: C64 demo / music / game archive.
  <https://assembly64.hackerswithstyle.se/assembly/index.html>
- **OneLoad64**: one-file C64 games collection.
  <https://oneload64.github.io/>

### AI collaborators

- **Claude Code** (Anthropic): primary implementation collaborator.
- **Codex** (OpenAI): second opinion and advanced logic tasks.

### Fonts

- **Inter** by Rasmus Andersson, SIL OFL 1.1.
  <https://rsms.me/inter/>
- **Share Tech Mono** by Carrois Type Design, SIL OFL 1.1.
  <https://fonts.google.com/specimen/Share+Tech+Mono>
- **PetMe64**, **Giana**, and **Berkelium** (GEOS font) by Rebecca Bettencourt /
  Kreative Korporation, Kreative free-use license.
  <https://www.kreativekorp.com/software/fonts/c64.shtml>

### 3D model

- **Commodore 64 || Computer (Full Pack)** by dark_igorek,
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), used for the Retro
  Vibes 3D viewer.
  <https://skfb.ly/oUKFx>
