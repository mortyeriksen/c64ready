<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->

# The test suite

How to run the tests, what the suite covers, the diagnostic and trace tools, and the
VICE cross-checking workflow. Run the whole thing any time with `npm test`.

The document is in two parts: first the **test & VICE runbook** (running the
suite, the diagnostic tools, cross-checking against VICE, coverage, fixtures);
then, from "Debug console (DevTools)" on, the **DevTools debug and inspection
surface**: console helpers and live model toggles for triaging behaviour in
the browser.

The suite is around 390 spec files, registered in the `TESTS` array of
`test/all-test.js` and run by `npm test`. Between them they hold a few thousand
labelled tests, plus some unlabelled internal assertions.

## Running the suite

```bash
# Full default suite (around 390 files, 6-way parallel)
npm test                         # alias for: node test/all-test.js
node test/all-test.js

# Tune concurrency (keep it modest: saturating the machine skews any
# timing-sensitive run happening alongside)
node test/all-test.js --jobs=4
node test/all-test.js --jobs=1   # force sequential (isolated failure debugging)

# A single test file (fastest iteration during development)
node test/sid-spec-test.js
node test/vic2-sprite-render-spec-test.js
```

`all-test.js` spawns each spec file as its own Node subprocess, so failures are isolated. It prints `PASS / SKIP / FAIL (ms)` per file plus an overall summary, and on failure it echoes the last 15 lines of the offending file. The exit code is non-zero if any file fails; skips never fail the run.

Every file the tests use that is not part of the repository (the ROMs, hardware test programs, and demo fixtures) resolves through `test/external-assets.json`: edit the paths there, or set the per-entry environment variable, to match your machine. Spec tests that depend on such a file SKIP with a note when it is absent, so the suite passes without the optional fixtures. The ROMs are the exception: the runner checks for them up front.

A skipping test exits 0, which on its own is indistinguishable from a pass, so it announces the skip with a TAP-style directive that `all-test.js` picks up:

| Directive | Meaning | Reported as |
| --- | --- | --- |
| `# SKIP <reason>` at line start | the file did no real work | `SKIP`, listed under **Skipped files** |
| `ok  - <check> # SKIP <reason>` | the file ran; one check did not | `PASS`, listed under **Partially skipped** |

Both lists print the reason (from `missingNote(key)`, which names the manifest entry and its environment variable), so a green run still shows exactly which fixtures went missing. A test that skips without a directive is reported as a plain `PASS`: that is the bug the directive exists to prevent.

## Test categories

| Category | Representative files | What's locked in |
| --- | --- | --- |
| **CPU** | `cpu-test.js`, `cpu-page-cross-spec-test.js`, `klaus-test.js`, `illegal-opcode-cycle-audit-test.js`, `legal-opcode-cycle-audit-test.js`, `cycle-audit-test.js`, `branch-cycle-accounting-spec-test.js`, `rti-cycle-accounting-spec-test.js` | Every opcode and cycle count; legal and illegal cycle audits; Klaus Dormann's exhaustive 6502 functional test (binary resolves via `test/external-assets.json`, skips if absent; the suite's only external-asset test). |
| **VIC-II core / cycle timing** | `clock-cycle-spec-test.js`, `master-cycle-spec-test.js`, `ba-aec-matrix-spec-test.js`, `vic2-sprite-ba-cycles-test.js`, `bus-kind-audit-test.js` | Master-cycle ordering, BA/AEC handshake, bad-line and sprite DMA steals, per-cycle bus-kind accounting. |
| **VIC-II raster + IRQ** | `vic2-raster-irq-edge-trigger-spec-test.js`, `vic2-raster-irq-chain-spec-test.js`, `irq-pipeline-spec-test.js`, `irq-ba-stall-spec-test.js` | Bauer §3.12 mid-line $D011/$D012 fires, edge-triggered raster IRQ, IRQ pipeline and entry under BA/RDY. |
| **VIC-II stable raster** | `irq-d016-cycle-alignment-spec-test.js`, `stable-irq-sprite-ba-drift-spec-test.js`, `stable-raster-jitter-absorb-spec-test.js`, `ba-contour-3ad-spec-test.js`, `vic2-raster-time-spinner-spec-test.js` | Double-IRQ jitter absorption, stable-raster realignment, BA-contour timing, raster-time spinner and dejitter. |
| **VIC-II rendering** | `vic2-gaccess-shifter-spec-test.js`, `vic2-pixel-mode-rendering-spec-test.js`, `vic2-mode-flip-spec-test.js`, `vic2-midline-mode-flip-rendering-spec-test.js`, `vic2-csel-veto-window-spec-test.js`, `vic2-topborder-rendering-spec-test.js`, `vic2-color-bar-pixel-spec-test.js` | Pixel-accurate text and bitmap modes, g-access shifter, border-veto windows, mid-line mode flips, colour bars. |
| **VIC-II sprites** | `vic2-sprite-*` (about 50 specs) | Sprite crunch (cycle-15 latch + cycle-58 disable), multiplexer, BA, X/Y wrap, multicolor priority, mid-line data row, sub-pixel phase, idle-bus leak. |
| **VIC-II bad-line / FLI / FLD** | `vic2-badline-*` (12 specs), `vic2-fli-badline-every-line-spec-test.js`, `vic2-fli-full-band-spec-test.js`, `vic2-fld-fli-linecrunch-spec-test.js`, `vic2-badline-goodline-integration-test.js` | Full-line bad-line edge detection, good-line/bad-line transitions, FLI bad-line-every-line, FLD and linecrunch abort, RC-reset timing. |
| **SID synthesis** | `sid-spec-test.js` | Waveforms, ADSR, ADSR-bug timing, sync, ring mod, test bit, filter mode and cutoff curve, resonance Q, combined waveforms (non-flat byte spread per period), 6581 vs 8580 dim, NOISE+combined LFSR clobbering. |
| **SID digi / readback / shadow / paddle** | `sid-digi-spec-test.js`, `sid-shadow-spec-test.js`, `sid-paddle-spec-test.js`, `osc3-cycle-test.js` | `$D418` DC step, 1-bit PWM digi that survives voices playing underneath (correlation > 0.7), cycle-exact `$D41B`/`$D41C` against a synchronous reference, POTX/POTY 512-cycle sample-and-hold, cycle-sync-on-first-event hook. |
| **Audio lifecycle / recording** | `audio-lifecycle-spec-test.js`, `recorder-audio-bridge-spec-test.js`, `recording-support-spec-test.js`, `sid-worklet-backlog-spec-test.js` | Foreground/background mute policy; recorder audio uses an independent media clock and tears its bridge down cleanly; browser support is capability-detected; the event backlog is bounded so audio lateness cannot accumulate. |
| **CIA / 6526** | `cia-timer-spec-test.js`, `cia-timerb-modes-spec-test.js`, `cia-port-arbitration-spec-test.js`, `cia-force-load-edge-spec-test.js`, `cia-sdr-spec-test.js`, `cia2-vic-bank-spec-test.js` | Timer A/B modes, force-load edge, port arbitration, TOD, IRQ/NMI, SDR stub semantics, VIC bank switch via CIA2 PA. |
| **Input & UI logic** | `control-port-paddle-spec-test.js`, `control-port-mouse1351-spec-test.js`, `control-port-neos-spec-test.js`, `lightpen-spec-test.js`, `rom-cache-spec-test.js` | Paddle byte builder, 1351 button mapping and POT step of 2 per mouse unit (the real driver arithmetic recovers the delta), NEOS strobe/nibble protocol with right button on POTX and idle reset of the sequencer, light-pen latch, ROM-cache localStorage round trip. |
| **Shared bus / open-bus** | `open-bus-de00-spec-test.js`, `open-bus-color-ram-spec-test.js`, `open-bus-cpu-internal-spec-test.js`, `open-bus-port-zero-one-spec-test.js`, `open-bus-machine-integration-spec-test.js`, `vic2-sprite-idle-bus-leak-spec-test.js` | Open IO1/IO2 and Color-RAM upper-nybble latch reads, `$00/$01` quirk, CPU-internal-cycle bus drive, sprite idle-fetch leak. |
| **1541 / IEC / D64 / GCR** | `drive-test.js`, `drive-rom-test.js`, `iec-handshake-test.js`, `iec-2bit-transfer-spec-test.js`, `iec-edge-latency-spec-test.js`, `drive-cycle-ratio-spec-test.js`, `fastloader-test.js`, `gcr-readpath-format-spec-test.js`, `gcr-writeback-spec-test.js`, `drive-save-spec-test.js`, `nosdos-bootstrap-test.js`, `kernal-load-wildcard-spec-test.js`, `drive-soe-gating-spec-test.js` | 1541 boot, IEC wired-AND and edge-latency model, true drive-clock ratio (including save/restore phase continuity), 2-bit transfer, fast loaders, GCR read path, GCR write-back round trip with write head and write-protect polarity, end-to-end `SAVE` through the real DOS (drives 8 and 9), SOE gating, no-DOS bootstrap, wildcard LOAD. |
| **Cartridges** | `crt-test.js`, `cart-memory-test.js`, `generic-cart-test.js`, `action-replay-cart-test.js`, `final3-cart-test.js`, `magicdesk-cart-test.js`, `easyflash-test.js` | Device-registry loading; Generic / Action Replay / Final Cartridge III / Magic Desk / EasyFlash banking; Ultimax mapping; cartridge I/O, RAM, RESET/FREEZE, and NMI behaviour. |
| **RAM Expansion Unit** | `reu-registers-spec-test.js`, `reu-transfer-spec-test.js`, `reu-dma-timing-spec-test.js` | 8726 REC register map and readback, stash/fetch/swap/verify transfers, DMA bus arbitration (CPU halted, VIC DMA takes precedence) and the documented transfer rates. |
| **Datasette** | `datasette-test.js`, `tape-play-spec-test.js`, `tape-flag-cia-spec-test.js`, `tape-seek-spec-test.js`, `kernal-tape-load-test.js`, `kernal-tape-save-test.js`, `datasette-record-test.js`, `turbo-tape-record-test.js`, `tape-record-audio-spec-test.js`, `wav-decode-spec-test.js`, `wav-tape-*-spec-test.js`, `dmp-tape-spec-test.js` | `.tap` v0/v1/v2 playback, FLAG pulses into CIA1, seeking to a file's lead-in, KERNAL tape LOAD and SAVE, turbo-tape record and load round trip at cycle resolution, `.wav` cassette import (level tracking, edge polarity, sample rates, repair of damaged blocks) and export, DC2N `.dmp` import. |
| **Memory / PLA / banking** | `pla-test.js`, `pla-memory-spec-test.js`, `pla-memory-config-spec-test.js`, `memory-reset-spec-test.js`, `vic2-color-ram-spec-test.js` | PLA routing through the 6510 port, all 32 banking configurations, colour RAM, reset state. |
| **Integration / demo motifs** | `vic2-nine-*` (synthetic specs), `vic2-nine-demo-deps-spec-test.js`, `vic2-vertical-hyperscreen-spec-test.js`, `frame-trace-irq-state-spec-test.js`, `vic2-badline-late-caccess-line-local-spec-test.js`, `vic2-sprite-bg-collision-midline-d011-spec-test.js`, `vic2-openborder-idle-mcm-snapshot-spec-test.js` | Synthetic re-creations of demo tricks: Nine's multiplexer chain and startup collision probe, FPP's late-bad-line matrix rule, The Hat's open-border MCM rule, hyperscreen motifs. No demo binaries. |

## Diagnostic / trace tools (not gated)

Run these on demand to dump telemetry. Output is usually written to `/tmp/` or printed to stdout.

The **reference-demo screenshot pass** (`test/commit-screenshots.mjs`) runs the fixed `DEMOS` table headlessly and writes timestamped framebuffer PNGs to a git-ignored output directory, created on demand. It is a human visual check, not a spec test: the filename is plain `.mjs`, `all-test.js` does not gather it, and it makes no assertions. It never deletes old screenshots; successive runs accumulate, so a before/after pair can coexist. After each run it diffs every new shot against the previous run's matching shot and prints which demo seconds changed. Changed shots also get `diff-<demo>-sNN.png` overlays, with unchanged pixels dimmed and changed pixels tinted magenta. Run it only when explicitly requested, or as the before/after pair for a render or timing change.

```bash
node test/commit-screenshots.mjs
```

The **demo crash/hang status board** (`test/demo-status.mjs`) boots each tracked demo (disc 1) headless and classifies the outcome as `CRASH` (JAM/KIL opcode, PC and time), `runs clean`, or `DISPLAY FROZEN` (a possible silent hang; it is framebuffer-based, since PC sampling cannot tell a silent hang from a healthy interrupt-driven spin). Each outcome is compared to its expected status (`✓` / `✗ CHANGED`); most entries expect `RUNS`, so the board is first a regression detector over demos that must keep running clean. Each demo loads via the chunked keyboard buffer (the UI path) and runs its per-demo frame budget (around eight minutes of demo time), saving a screenshot **every 10 s** plus the end frame (`<demo>-<YYYYMMDD-HHMMSS>[-sNNN].png`, to a git-ignored output directory created on demand), so a demo's progression, and exactly where it visually breaks, is visible. The demo disk images resolve through the collection roots in `test/external-assets.json`. SID defaults to 8580 to match the UI. Multi-disc demos boot their crash disc directly (for example Mojo disc 4). It is a `*.mjs` tool, so the `all-test.js` runner skips it, like `commit-screenshots.mjs`.

```bash
# Crash/hang status board over the tracked demos (screenshots + ✓/✗ vs expected)
node test/demo-status.mjs                 # all tracked demos
node test/demo-status.mjs coma next       # filter by demo name
SID=6581 node test/demo-status.mjs        # force the original 6581 SID

# Convert raw Float32 audio to listenable WAV
node test/f32-to-wav.js /path/to/audio.f32 /tmp/out.wav

# Exercise the worklet's power-cycle / reset / cycle-sync paths
node test/sid-power-cycle-trace.js

# Run the cycle-exact $D41B OSC3 demo PRG headlessly + verify output variety
node test/osc3-cycle-test.js
```

## Cross-checking against VICE (reference oracle)

VICE (`x64sc`) is the ground-truth oracle for VIC-II, CPU, sprite and timing questions. Install it from your platform's package manager (for example `brew install vice`) or from the VICE project. When writing one-off capture scripts, reuse the existing connection boilerplate rather than re-deriving the monitor protocol.

**Always pass `-VICIImodel 0`.** `x64sc -pal` defaults to `VICIIModel=1`, the **8565** ("new" VIC), but this project models the **6569** ("old" VIC). The 8565 samples registers one cycle earlier, so an uncorrected compare shows a spurious 1-cycle / 8-pixel offset that is *not* a bug. Verify in the monitor with `resourceget "VICIIModel"` (`0` = 6569, `1` = 8565, `3` = 6567 NTSC).

**Always run scripted VICE launches headless.** Set `SDL_VIDEODRIVER=dummy` (and `SDL_AUDIODRIVER=dummy` when sound is irrelevant) in spawned VICE processes so no window appears on the desktop. Spawn the binary **inside** the app bundle: on macOS the `bin/x64sc` next to it is a launcher wrapper, so killing that reaps only the wrapper and orphans the real emulator, which then piles up across runs. Check with `pgrep -fl x64sc` afterwards, and kill strays before retrying if ports or monitor sockets conflict.

**Three conventions that bite every time:**

- VICE's monitor `CYC` column is **0-based (0–62)**; our `cycleInLine` and Bauer's spec are **1-based (1–63)**. So **VICE `CYC` = our `cycleInLine − 1`**: a write VICE reports at `CYC 12` lands at our `cycleInLine 13`, the *same* physical cycle. Don't mistake the off-by-one for a timing bug.
- Match the two runs by **demo state** (which scene, pose or digit is on screen), never by absolute frame or cycle count. Our boot timing differs from VICE's, so the runs drift apart in wall-clock time.
- VICE flag polarity is the reverse of common CLI intuition: `-NAME` enables a resource and `+NAME` disables it. For example, `-drive8truedrive` turns true drive on.

For testprogs suites that ship a `references/` directory of VICE screenshots, reach for the shared comparator first, instead of writing a new render-and-diff script:

```bash
node test/ref-compare.mjs <prg> <refPng> [boot=200] [run=80] [refPalette=pepto|colodore]
```

`test/ref-compare.mjs` boots the KERNAL, loads and runs the PRG, and compares in palette-independent colour-index space. It handles the two common false positives for these references:

- **Palette mismatch.** Testprogs VICE screenshots are usually Pepto, while the emulator default is Colodore. Raw RGB diffs are palette noise; the shared tool quantizes both sides to their own 16-colour palette. If you capture a raw PNG yourself for RGB diffing or eyeballing, set the emulator palette to Pepto first with `setVicPalette('pepto')`.
- **Crop offset.** VICE PNG row 0 is raster 16 while our framebuffer row 0 is raster 15. The comparator searches small `dx,dy` offsets; `PERFECT (1-line crop offset)` is a pass.

VICE's external Pepto palette still runs through its gamma and contrast curve. Tiny residual index diffs confined to 1px features, where position matches and only colour differs, are usually this curve rather than a rendering bug. For those cases, read the VIC registers over the monitor (`m d027 d02e`, masking colour-register reads with `& 0x0f`) before chasing pixels.

When the shared comparator does not fit (no reference PNG, or you need
breakpoints and traces rather than pixels), capture raw:

**Capture style A, headless one-shot screenshot** (fast, fully deterministic; best for pixel diffs):

```bash
x64sc -VICIImodel 0 -warp -autostart-warp +drive8truedrive -autostartprgmode 1 \
  -limitcycles <N> -exitscreenshot /tmp/vice.png -autostart "/path/to/demo.prg"
```

The PAL screenshot is 384×272, the same crop as our `frameBuffer`, so pixels align directly. `-limitcycles` + `-exitscreenshot` is reproducible; warp + a hand-driven monitor is not. Autostarted PRGs need enough budget to clear boot, injection, RUN, and settle: about 9M cycles for a 9 s run. Around 3M cycles often lands on bare `READY.` before the program has run.

**Capture style B, monitor** (breakpoints, register and memory watches, single-step): launch with a monitor socket and script it over TCP.

- **Remote text monitor** (`-remotemonitor -remotemonitoraddress ip4://127.0.0.1:PORT`): connect, wait for boot or a `-limitcycles` halt, send newline-terminated commands. `break exec $XXXX` sets a checkpoint; on each hit `r` dumps registers including **LIN/CYC** (raster and cycle-in-line), `m d011 d011` reads memory, `save "<file>" 0 <start> <end>` dumps memory while stopped, `x` resumes, `screenshot "out.png" 2` saves a PNG.
- **Binary monitor** (`-binarymonitor -binarymonitoraddress ip4://127.0.0.1:PORT`): a framed binary protocol. Set `exec`/`store`/`load` checkpoints, advance one instruction (then read registers for `LIN`/`CYC`), or store-watch a register. Lower-level, but scriptable to thousands of samples (per-instruction `(PC, LIN, CYC)` traces and per-line register store-watches).

**The workflow that works:**

1. Reach the scene in VICE: checkpoint the demo's inner-loop routine and advance N hits to a stable frame.
2. Capture VICE ground truth: a per-instruction `(PC, LIN, CYC)` trace, and/or per-line register stores with their `CYC`, and/or a screenshot.
3. Build the **same** trace headlessly from our emulator: drive `machine._runMasterCycle()` in a loop (19656 cycles = one PAL frame) and record `(cpu.pc, vic2.raster, vic2.cycleInLine − 1)` at each `cpu.atInstructionBoundary()`. Boot with about 200 warm-up frames before `loadPRG` + `injectRun`, or KERNAL init clobbers the injected RUN.
4. Diff by **PC**, not by time; the instruction stream is identical. A divergent `CYC` for the same PC points straight at the cycle where our timing differs. A `CYC` *gap* on one side is a CPU stall (bad-line or sprite-DMA BA) that the other side doesn't have.

### RAM Expansion (REU) testprogs

The VICE testprogs `REU/` directory is the oracle. Those programs are
hardware-derived, and several print their expected register dumps outright, so
no VICE run is needed.

```bash
node test/reu-testprog-run.mjs <prg> [--size=512] [--image=<file.reu>]
node test/reu-testprog-sweep.mjs                       # all of them
```

Paths come from `test/external-assets.json` (the suite itself, and BluREU's
`blu.reu`; `reudetect` checks for that data file, not just for the hardware,
and skips without it).

Both dump the border colour and the decoded text screen, which is how these tests
report. Run `QuickReuTest-1.1.1` (Wolfgang Moser) first: it prints
`TEST CLASSES WITH FAILURES: n` and cites the CSG8726R1 reference section for
each mismatch.

## SID testprog sweep (VICE `testprogs/SID`)

The SID testprogs are driven headlessly: boot, load, run, then read the border / `$d7ff` verdict. Each program's own captured register stream is also re-rendered through the shipping worklet, to check that the selected engine actually carried it. Anything that fails or looks odd is re-run under VICE 3.10 and compared.

A full sweep covers all 26 folders across both chip models. In outcome: every
folder with an automatic verdict passes, lands on the real-hardware value, or
fails exactly as VICE 3.10 does; the failures that remain (`noisewriteback` /
`wb_testsuite`'s combined-noise family) are a shared reSID limit, not a local
gap, and the trade-off went to `noiselfsrinit` matching hardware. The
bitmap-plot and analog-meter programs have no automatic verdict. The standing
summary lives in [Component status](COMPONENT-STATUS.md); what stays here is
how to drive the suite and what trips it up.

**Gotchas that make this suite look broken when it isn't:**

- **Cross-model failures are by design.** `detect`, `osc_topbit`, `waveforms-10/-20` and `oscsample0/1` ship as `-old`/`-new` or `-6581`/`-8580` pairs that each assert one specific chip, so running a variant on the other chip correctly goes red. VICE behaves the same. Judge each variant only on its own chip.
- **Some programs compare against reference data on their bundled `.d64`**, so with no disk attached they fail on the `LOAD` rather than on the SID. Their `-dump` counterparts pass without one.
- **`bitfade/delaynoise` is timing-dependent.** The same binary returns different values purely from a different frame budget (2.5M–4.4M cycles apart on the 8580), so a single-shot comparison measures sampling noise.
- **Readme reference values can predate your VICE by years.** `bitfade`'s are from VICE r32106 and list `delayenv3` as `$2c`, where both VICE 3.10 and this emulator give `1`. Re-measure before treating a mismatch as a gap.

**Comparing rendered audio against VICE.** Waveform correlation is the wrong tool: the two sides come from separate machine runs, so phase is unrelated, and short repeating test patterns give a lag search many near-equal maxima. Landmark fingerprinting (Shazam-style: keep spectral peaks, hash peak pairs, then recover the offset from a histogram of hash time-deltas) works instead. It is insensitive to level, and the alignment falls out of the match rather than having to be fitted first. Calibrate before reading any score: a file against itself scores 100 % at zero offset, two *unrelated* tunes score about 17 % at a scattered offset, and two correct implementations of the same audio land around 75 % at one sharp offset. On that scale the WASM engine against VICE reSID scores a **median 71 %** over the six PRG scenes on both models and **84 %** over the wrapped `csid-light-tests` tunes, each at a consistent offset: the signature of the same audio through two implementations.

Rendering `.sid` files for such a comparison is the unreliable part. A silent or near-silent render will still produce a plausible-looking score from coincidental hash collisions, so **always check that both sides actually contain audio before trusting a number**. Failure modes seen so far, none of which announce themselves:

- A PSID whose `init` runs before the KERNAL has booted stays nearly mute.
- A driver called as a plain subroutine instead of from an interrupt can sit in its stopped state, rewriting `$D418` to zero every frame. Drive `play` from a raster IRQ, and reinstall the vector after every `init`, since a driver's own init may restore the KERNAL default.
- Wrapping a tune that loads inside the PRG image (anything near `$1000`) overlaps the payload copy with its own source, so it must run descending. This silences VICE too, which is the fastest way to tell a broken wrapper from a broken engine.

**The `mouse/` testprogs are driven the same way.** `mouse/neos/` and `mouse/1351/` ship reference drivers extracted from real software, plus programs written specifically to break emulators: `arkanoid.prg` for strobe timeout handling, `krakout.prg` for a crack that never initialises DDR, `krakoutbug.prg` for a poll-independence bug VICE once had. Synthetic mouse deltas can be injected headlessly, and the drivers then print what they reassembled, so these verify a mouse end to end without a host pointer. Two caveats cost time: several of them select the control port with `mouseport = 0`, which is `$DC00` and therefore port **2**, and `arkanoid.prg` clobbers its own port index partway through a read, so it only works when the X delta happens to be 1. Per-device outcomes are in [Component status](COMPONENT-STATUS.md).

**Confirm the VICE reference really is reSID** before trusting a comparison: `-sidengine 1` selects it (`0` is FastSID). `-sidmodel` has an empty `-help` description, so prove it took effect by outcome: `sidcheck.prg` self-reports the chip, so `-sidmodel 0` must print `(6581)`. Audio comparisons also depend on `-residsamp`, where the difference between `fast` and `resampling` is wide enough to swamp a real finding.

## Coverage

There is no coverage tool in the dependencies; Node's own V8 coverage is enough.
Every test process writes a JSON file into the directory named by
`NODE_V8_COVERAGE`, and `tools/coverage.mjs` folds them into line coverage per
`src/` file (a code line counts when any of its characters ran in any process):

```bash
NODE_V8_COVERAGE=/tmp/cov node test/all-test.js
node tools/coverage.mjs /tmp/cov
```

The instrumented suite runs about eight times slower than plain `npm test`.

Read the number in two parts:

- **~97 % of the code lines in the `src/` files the tests import**, every
  imported file above 90 %. What is left uncovered is mostly defensive `catch`
  blocks and engine-specific branches.
- **About half of all of `src/`.** The rest has no Node entry point:
  `main.js`, `media.js`, `input.js`, the Retro Vibes scenes, the dialogs,
  tooltips and splash run only in a browser, and the suite does not drive one;
  the screenshot and demo tools cover them by hand. Two entries in that list
  are artefacts: `sid-filter.js` and `sid-worklet.js` are exercised, but
  through `sid-test-loader.js`, which evaluates them in a `vm` context, so V8
  credits the evaluated script rather than the file.

## Shared fixtures

Four underscore-prefixed files hold what several spec files build the same way:
`_vic2-helpers.js` (VIC construction, render-segment and master-cycle harnesses),
`_vic2-equivalence.js` (a full-frame render with the standard mid-line write
schedule and a byte-for-byte framebuffer compare, for the batch-render,
capture-dedup and sprite-idle-skip equivalence tests), `_tape-fixtures.js`
(a Turbo Tape 64 file as the format writes it, TAP byte and pulse conversions)
and `_mini-dom.js` (a stand-in document for the side-panel, VIBES-button and
Escape-key tests: elements, classes, a small selector engine, events with
bubbling, innerHTML both ways, rects the test assigns, and the browser globals
those modules reach for). The stub does no layout and does not pretend to be a
browser; what it does not model, the tests do not assert on.
They are not registered as tests.

## PRG-building helpers

A few specs need a tiny 6502 program injected into a fresh machine. The `build-*.mjs` scripts emit those PRGs on demand:

```bash
node test/build-osc3-cycle-test-prg.mjs       # → test/osc3-cycle-test.prg
node test/build-sid-feature-test-prg.mjs      # → test/sid-feature-test.prg
node test/build-raster-prgs.mjs               # → test/*-raster.prg
node test/build-vice-prgs.mjs                 # → test/vice-*.prg
```

## Test runner registration

Every new test must be listed in the `TESTS` array of `test/all-test.js`. The runner does not find files that are not explicitly registered.

---

The rest of this document is the **DevTools debug and inspection surface**: console
helpers and live model toggles for triaging behaviour in the browser.

## Debug console (DevTools)

The running machine is the `machine` global (`window.machine`); the trace and
inspection helpers below are `c64Trace` / `c64Vic` / `c64Bus`.

```js
// Machine lifecycle. softReset = a /RESET-line pulse: preserves RAM (the KERNAL
// re-inits screen + zero page). No UI button, and allowSoft:true is REQUIRED (a
// bare softReset() throws) so a soft reset never fires by accident.
machine.softReset({ allowSoft: true })
machine.reset()                          // cold boot / power cycle (regenerates RAM)
```

```js
// VIC frame trace: enrich the debug snapshot with whole-frame + per-raster
// data (see "VIC frame trace and state snapshots" below for workflow + perf).
c64Trace.enable() / .disable() / .status()

// Raster-scroller jitter capture: per-frame IRQ-accept / soft-vec entry / $F7
// / $D020 / $D021 / $D012 / BA-AEC-release cycles across N frames, with
// frame-to-frame variance analysis. Auto-downloads a JSON report on dump.
c64Trace.jitterStart(60)        // arm an N-frame capture, then let the demo run
c64Trace.jitterDump()           // print + download the report (also returns raw)

// SID write trace: capture every SID register write for inspection
c64Trace.sidStart(20000)       // capture next N writes
c64Trace.sidDump(0x18)          // pretty-print first 40 $D418 writes
c64Trace.sidStats()             // per-register count + Hz rate summary

// VIC-II model toggles (off by default: unstable / variant-specific)
c64Vic.bankDelay(true|false)    // NMOS: DDR-driven single-bit 0→1 that decreases
                                // VIC bank by 1 or 2 delays one cycle (VIC-Addendum
                                // "Video bank and C64C"). Unstable on real chips.
c64Vic.bankGlitch(true|false)   // C64C / 8565: VIC-bank 10↔01 transitions blip
                                // through bank 3 for one cycle. Only active when
                                // vicVariant='8565'.

// Render performance toggles (ON by default, byte-identical optimisations)
c64Vic.batchRender(true|false)  // _fixupColumns fast path: re-render ONLY the
                                // cycles whose mid-line mode (ECM/BMM/MCM) or bg
                                // ($D021-$D024) lookahead window changed, instead
                                // of re-rendering the whole line twice. Proven
                                // pixel-identical (orbit fb hash + spec suite +
                                // vic2-fixup-batch-equivalence-spec-test); biggest
                                // win on heavy mid-line-write demos like Orbit
                                // Untold (~54→65 fps). Flip OFF to A/B if a render
                                // regression is ever suspected.
c64Vic.captureDedup(true|false) // _captureCycleState fast path: alias the previous
                                // cycle's row + sprite + register snapshot buffers
                                // when the source is unchanged (version-counter
                                // tracked; the register snapshot's version bumps on
                                // every CPU $D0xx write) instead of re-copying ~10
                                // typed arrays every visible cycle. With batchRender,
                                // Orbit ~65→77 fps.
                                // c64Vic.captureDedupVerify(true) adds a per-cycle
                                // assert that the alias still matches the live source
                                // (catches a missed version bump). Flip OFF to A/B.
c64Vic.spriteSkipIdle(true|false) // _renderSpriteSegmentForSprite fast path: return
                                // early on cycles where a started sprite is steady
                                // and paints nothing (no segment overlap, no
                                // end-of-line wrap), plus a never-started loop-level
                                // skip. On sprite-heavy demos ~74% of per-cycle
                                // sprite calls paint nothing. Flip OFF to A/B.

// Shared external-data-bus model (see the next section for the full table)
c64Bus.status()                 // dump every flag + the live latch bytes
c64Bus.openBus('disabled')      // 'vice-compatible' (default) | 'disabled' | 'random'
c64Bus.colorRam(true|false)     // composed Color-RAM read re-drives the latch
c64Bus.portZeroOne(true|false)  // $00/$01 RAM-under-port quirk (default off)
c64Bus.refresh(true|false)      // VIC r-access drives the bus
c64Bus.spriteIdle(true|false)   // sprite idle fetch leaks vs all-$FF
c64Bus.cpuInternal(true|false)  // KIND_INTERNAL cycles fire a discarded read
c64Bus.traceStart(1024)         // enable per-cycle bus trace ring
c64Bus.traceStop()              // disable + free
c64Bus.traceDump(64)            // print + return last N entries (oldest first)
```

### A/V sync marker

Measures how far recorded audio trails the picture. Every 10 s it drops the SID
volume for 60 ms, then gates all three voices at 2.9 kHz on the same rAF tick as
a white full-screen flash. The notch matters: it manufactures silence, so the pip
is a clean onset even under a game's music.

```js
c64Trace.avMarkerOn()      // this session only; ?avmarker=1 also works
c64Trace.avMarkerOff()
c64Trace.audioLatency()    // baseLatency + outputLatency of the live path
```

The marker persists nothing (no localStorage, no cookie, no window flag), so a
reload clears it and you have to switch it back on. That is deliberate: a debug
tap that survives a reload comes back on a later visit as an unexplained flash
and pip. It also means `avMarkerOn()` is the only way in; assigning
`c64Trace.avMarker` does nothing. The rAF loop calls `avMarkerEnabled()` every
presented frame, so it reads one module-local boolean and nothing else. Do not
reintroduce a storage or URL lookup behind it.

Record with the marker on, then find the flashes and the pips in the file and
compare their times. A growing gap is the audio clock falling behind; a constant
one is pipeline and device latency:

```bash
# Flash times: white frames stand out in per-frame average luma
ffprobe -v error -f lavfi -i "movie=rec.mp4,signalstats" \
  -show_entries frame=pts_time:frame_tags=lavfi.signalstats.YAVG -of csv=p=0
```

Detect the pip in a bandpass around 2.9 kHz, not on broadband energy, which
inside music locks onto tune transients. Measure on the BASIC prompt for a
clean baseline, and note that the recorder taps upstream of the output device, so
device latency shows up live but never in the file.

### VIC frame trace and state snapshots (Cmd+Shift+S)

**`Cmd+Shift+S` on macOS, `Ctrl+Shift+S` elsewhere** (both work on either), downloads a debug snapshot of the machine: a `c64-snapshot-<timestamp>.json` state dump plus a sibling `c64-snapshot-<timestamp>.png` of the rendered frame. It is handled *before* the "is the machine running" gate, so a JAMmed or paused machine can still be inspected. The JSON embeds the same PNG as `framebufferPng`, so the one file is self-contained; the sibling `.png` is just for quick preview. (Bound in `input.js`; the download itself is `downloadSnapshot()` in `media.js`.)

The snapshot's `vicFrameDebug` block is where the VIC frame trace lands: per-pixel `borderBuffer` / `graphicsPriorityBuffer` / `spriteOwnerBuffer` maps plus per-line register and flag traces (`frameTraceHBorder`, `frameTraceVBorder`, `frameTraceLineD011`, `frameTraceLineD016`, `frameTraceLineD015`, …), indexed `raster * 64 + cycle`. Combined with `framebufferPng` this answers questions like "is this side-border garbage the border being *open* or *closed*?" pixel by pixel.

**Enable the trace first for a whole-frame map.** With the trace **off**, `vicFrameDebug` falls back to the VIC's *line-sized* live buffers, so only the last rendered line is meaningful, and the snapshot records `traceEnabled: false`. `c64Trace.enable()` switches the VIC to accumulating each rendered line into a full-frame map, so the snapshot then covers the entire frame. The intended loop:

```js
c64Trace.enable()    // start accumulating whole-frame trace data
// …run the demo to the exact moment of interest…
// press Cmd+Shift+S / Ctrl+Shift+S to download the snapshot (JSON + PNG)
c64Trace.disable()   // stop, restore the fast path
c64Trace.status()    // check whether it's currently capturing
```

**Performance.** Leaving the trace **off costs nothing measurable**. The off-path is a single boolean check per raster, and it is in fact the *optimized* path: the line-batch renderer, capture-state dedup, and sprite-idle skip (the `c64Vic.*` toggles above) are all active only while `frameTraceEnabled` is false. Turning the trace **on deliberately disables those optimizations** (the renderer then runs live per-cycle on every line and re-copies the capture snapshots every visible cycle) and adds about 5 extra per-cycle field computations plus whole-frame map accumulation. Expect a visible frame-rate drop on heavy demos while it is on, which is why it is a flip-on-then-off tool, not a default. `c64Trace.disable()` restores full speed immediately.

### Shared external-data-bus model

The emulator models a shared 8-bit external data bus (`memory.externalDataBus8`) that is updated by every CPU read/write and every VIC chip-bus fetch. Open-bus CPU reads (`$DE00–$DFFF` without a cartridge, plus the upper nybble of Color RAM at `$D800–$DBFF`) sample the latch instead of returning a fixed `$FF`. The VIC's `vicInternalBus` is a separate latch that feeds sprite idle fetch (VIC-Addendum §"Sprite idle fetch"); both latches are driven by `_vicBusRead` simultaneously.

Each behaviour is gated by a flag, so you can bisect a suspected regression or fall back to the legacy model:

| Field | Default | Behaviour when on (default) | When off |
| --- | --- | --- | --- |
| `machine.mem.openBusMode` | `'vice-compatible'` | Open IO1/IO2 and Color RAM upper nybble return the latch | `'disabled'` returns `$FF` (simplified model); `'random'` returns a fuzz byte |
| `machine.mem.colorRamReadDrivesComposedByte` | `true` | The composed Color-RAM read re-drives the latch | Latch is not updated by the compose step (the outer `Memory.read` epilogue still latches the returned byte) |
| `machine.mem.openBusWritesToZeroOneEnabled` | `false` | _Opt-in._ Writes to `$00/$01` leave the VIC phi1 byte in `ram[0]/ram[1]` (6510 tri-stated drivers) | Standard: `ram[$01]` mirrors the masked port |
| `machine.vic2.vicRefreshDrivesBus` | `true` | DRAM refresh cycles perform a real fetch, updating both latches | Refresh is address-only (simplified model) |
| `machine.vic2.spriteIdleFetchLeakEnabled` | `true` | Sprite idle fetch byte 2 samples `vicInternalBus` (Addendum behaviour) | All three idle-fetch bytes are `$FF` |
| `machine.vic2.vicInternalBusCpuScope` | `'vic-registers-only'` | Only CPU accesses to `$D000–$D3FF` feed `vicInternalBus`, matching the documented `sb_sprite_fetch` behaviour | `'all-cpu-bus'` (feed **every** CPU bus access) is **not implemented by design**: the VIC-Addendum and the `sb_sprite_fetch` testprog show the idle-fetch latch defaults to `$FF` and changes only on VIC-register / VIC-bus accesses, so a wider scope would diverge from silicon (and it is demo-neutral: 0 px change across the tracked demos) |
| `machine.cpu.cpuInternalCycleDrivesBus` | `true` | KIND_INTERNAL microops (reset settle, HALT spin) perform a discarded `read(pc)` so every cycle touches the bus | KIND_INTERNAL cycles are silent (simplified model) |

All of these can be set live from the DevTools console, for example `machine.mem.openBusMode = 'disabled'`. They take effect on the next master cycle; no restart needed.

#### Per-cycle bus trace

A debug-only ring buffer that records phi1/phi2 owner, BA/AEC/RDY, the current CPU microop kind, and both bus latches per master cycle. Off by default because it allocates one entry per cycle (about 985 kHz).

```js
machine.enableBusTrace(1024)     // start capturing into a 1024-entry ring
machine.busTraceSnapshot(64)     // return the most recent 64 entries (oldest first)
machine.disableBusTrace()        // stop + free the ring
```

Useful when you suspect an open-bus or BA/AEC timing issue. Each entry has `frame, raster, cycle, ba, aec, rdy, cpuBlocked, cpuOp, phi2Owner, externalDataBus8, vicInternalBus8`.
