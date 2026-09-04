<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
<!-- Copyright © 2026 Morten Øien Eriksen -->

# Performance

This is a cycle-accurate C64: every master cycle it clocks the VIC-II, the 6510,
two CIAs, the SID shadow voices and (when attached) the 1541's 6502. That
per-cycle fidelity, not demo content, is what sets the cost, so the
performance story is mostly about keeping the always-on per-cycle machinery
cheap and allocation-free. Runtime performance switches live in
`src/switches.js`; the rendering pipeline is summarised in the
[master overview](ARCHITECTURE.md) ("Rendering pipeline & performance
switches") and detailed in the [VIC-II](VIC2-ARCHITECTURE.md) §14.

## 1. Cost model

One PAL frame is 19 656 master cycles and must finish inside ~20 ms (50 Hz) to
hold realtime. Sampling ten full demo runs (2 600 CPU-seconds of real
workload) puts the budget here:

| VIC-II | 6510 | orchestrator | SID shadow | 1541 | CIA |
| --- | --- | --- | --- | --- | --- |
| 65% | 13% | 9% | 4% | 4% | 3% |

Structurally, that breaks down as:

- **VIC-II rendering dominates**: roughly two thirds of main-thread time. It
  splits into three always-running clusters: per-cycle state capture
  (register / border / fetch snapshots feeding the deferred renderer), the
  line-batch paint replay, and sprite shifting. The first two run for every
  cycle of every visible line regardless of content; sprite cost scales with
  visible sprite pixels. See the [VIC-II](VIC2-ARCHITECTURE.md) §8.
- **The fixed per-cycle tax is large.** Because the capture spine, both CPUs,
  the CIAs and the shadow voices all clock every cycle, and every visible line
  is repainted every frame, even a static READY screen costs most of what a
  heavy demo costs. Optimisations aimed only at "busy" demos have limited
  headroom; the real wins come from making the per-cycle path itself cheaper.
- **The 6510 (and the drive's 6502) is comparatively cheap**: a micro-op queue
  dispatched one step per cycle. See the [6510 CPU](CPU-ARCHITECTURE.md).
- **SID synthesis runs off the main thread**, on the `AudioWorklet`; the main
  thread keeps only lightweight shadow oscillators for cycle-exact `$D41B` /
  `$D41C` readback. See the [machine orchestrator](MACHINE-ARCHITECTURE.md) §7.
- **The 1541 only adds cost while it is actively working**: a serial load, the
  spindle turning. Idle waits are skipped (see §2).

## 2. Standing optimizations

All of these are in place and on by default. Those with runtime switches live
in `src/switches.js` and can be flipped for A/B without a
rebuild: append `?NAME=0` to the URL in the browser, or set `NAME=0` as an env
var for node harnesses.

- **Line-batch renderer** (`LINE_BATCH`, default on). Defers a raster line's
  pixel emission and replays it in one burst, coalescing runs of unchanged
  cycles into wide segments through the same segment renderer; any mid-line
  event the CPU could observe triggers an immediate catch-up, so the output is
  byte-identical to per-cycle rendering. `?LINE_BATCH=0` forces the per-cycle
  live path. See the [VIC-II](VIC2-ARCHITECTURE.md) §14.
- **WebGL presenter** (`WEBGL_PRESENTER`, default on). Uploads the finished
  framebuffer as a single texture per displayed frame instead of
  `putImageData`, saving a per-frame convert+upload on the main thread; most
  valuable on mobile GPUs. Output is byte-exact (CSS still does all scaling), and
  it falls back to the 2D path automatically when WebGL is unavailable;
  `?WEBGL_PRESENTER=0` forces the 2D path.
- **Prebuilt CPU opcode / micro-op table** (always on). Each opcode's micro-op
  program is built once at construction and aliased by reference at dispatch,
  instead of allocating a fresh set of per-cycle closures every instruction. This
  removes what would otherwise be the largest source of hot-loop allocation. See
  the [6510 CPU](CPU-ARCHITECTURE.md) §4.
- **Allocation-free hot paths.** The VIC per-cycle path reuses pooled scratch and
  flat typed arrays (pending border-FF transitions, sprite state, segment
  scratch) and aliases unchanged capture buffers rather than re-copying them
  (`captureDedup`, `spriteSkipIdle`, `batchRender`); the interrupt sequence and
  the JAM-halt program are prebuilt like opcodes. In steady state the hot loop
  allocates essentially nothing. See the [VIC-II](VIC2-ARCHITECTURE.md) §14 and
  the [6510 CPU](CPU-ARCHITECTURE.md) §4.
- **Cheap, monomorphic per-cycle work.** Beyond avoiding allocation, the always-on
  path avoids *dead* work and unstable object shapes, both nearly free on desktop
  V8 but real cost on a phone (§4):
  - the VIC segment renderer scopes its per-column span-buffer fills to the few
    columns actually painted rather than the full 384-slot width;
  - the CIA `read`/`peek` path computes a timer's visible value only for the
    timer registers, not on every keyboard scan or ICR poll;
  - the SID sync stage skips its three oscillator probes when no voice has
    hard-sync enabled;
  - the two CIAs null-initialise their port callbacks in the constructor so
    both instances share one hidden class, keeping the shared hot I/O methods
    monomorphic.
- **Lean audio-thread hot loop.** The default reSID engine keeps the worklet
  branch-light and monomorphic:
  - an all-integer per-cycle pipeline: no libm in the loop; the transistor
    filter/mixer/volume stages are pre-solved lookup tables;
  - model-dependent tables and DAC references cached on the voice/filter
    objects.

  The heavyweight lever is the selectable **WASM
  engine**: the same model compiled from the Rust translation in `rust/sid/`,
  with bit-identical output. It renders a whole 128-sample block per call at
  ≈100 ms CPU per emulated second against ≈660 ms for the JS engine, which takes
  worklet-deadline pressure off phones entirely. See the
  [SID](SID-ARCHITECTURE.md) §9.
- **Drive idle-skip** (automatic). When the IEC bus has been quiet long enough
  and the drive CPU is parked in a known ROM idle loop with the spindle stopped,
  the machine fast-forwards it to the next timer wake instead of clocking every
  cycle. Menus and load waits cost almost nothing; an actively streaming loader
  keeps the drive live. See the [1541 drive](DRIVE-ARCHITECTURE.md) §10.
- **Lazy three.js chunk.** The 3D "Retro Vibes" scene and the model viewer
  import three.js only on first open, so the library stays out of the initial
  bundle. See [Retro Vibes](RETROVIBES-ARCHITECTURE.md).

`src/switches.js` also carries hardware-accuracy switches, flipped the same
way, `DRIVE_TRUE_CLOCK_RATIO` and `IEC_EDGE_LATENCY` among them (both default
on).
These tune hardware fidelity, not performance; see the [1541 drive](DRIVE-ARCHITECTURE.md)
§3 and the [machine orchestrator](MACHINE-ARCHITECTURE.md) §3. Not every toggle
lives there: the drive's mechanical timing models are compile-time constants at
the top of `drive1541.js` ([1541 drive](DRIVE-ARCHITECTURE.md) §11), and the
`c64Vic.*` console toggles belong to the debug surface in [TESTING](TESTING.md).

## 3. Throughput & footprint

The figures below are approximate and machine-dependent; treat them as orders
of magnitude, not benchmarks.

- **Throughput.** Headless (`machine.runFrame()` with no presentation), the
  core runs comfortably above PAL realtime on an Apple M1-class machine; very
  roughly 1.5–3× depending on content, a near-static screen fastest and a
  sprite-heavy full-frame demo slowest. In the browser, presentation (the WebGL
  texture upload) and SID synthesis run on separate GPU/audio threads on top of
  this main-thread emulation cost.
- **Garbage is negligible, and the JIT settles.** A running demo allocates
  roughly 300 bytes per frame, a few kilobytes a second, costing well under a
  millisecond of collection per thousand frames. The optimiser's picture is
  equally quiet: it gives up on a handful of functions while warming up, then
  holds, with no recurring deoptimisation once a demo is underway.
- **Memory is small and flat.** All ArrayBuffers reachable from the machine
  total ~1.7 MB: the ~1 MB `SharedArrayBuffer` SID event ring (128k
  cycle-stamped entries), the ~408 KB framebuffer (384×272 RGBA), the 64 KB C64
  RAM, and the per-cycle capture arrays. There is no per-frame growth; retained
  heap stays flat across long runs, with no leaks. Process RSS is dominated by
  the JS engine itself, not by these buffers.
- **Bundle.** three.js (~700 kB) is code-split into the lazy chunk described in
  §2, keeping the initial page load lean.

## 4. Platform & mobile

Desktop V8 has generous heaps and an optimiser that erases most short-lived
allocation, so garbage collection is a non-issue there. Phones are less
forgiving:

- **Tighter heaps and GC.** JavaScriptCore (iOS Safari) does not eliminate
  short-lived allocation the way V8 does, and mobile nurseries are far smaller,
  so allocation that is effectively free on the desktop becomes real,
  main-thread GC pressure on a phone. This is exactly why the CPU dispatch, the
  VIC bookkeeping and the sprite paths are kept allocation-free (§2), a win
  that is nearly invisible in a desktop time profile but material on device.
- **Shape and dead work, not just allocation.** The same
  desktop-invisible, mobile-material asymmetry applies beyond GC: JavaScriptCore
  also pays for polymorphic property loads and per-cycle work that cannot affect
  the result, where V8's optimiser hides both. Keeping the always-on objects
  monomorphic (one stable hidden class per hot type) and their hot readers free
  of provably-dead work is therefore a mobile lever in its own right, one that,
  like allocation avoidance, barely registers in a desktop `time` profile.
- **Throttling and pressure.** Slower cores, thermal throttling and background
  memory pressure make mobile frame times less predictable; the heaviest
  full-frame demos may dip below realtime on a phone even where a laptop has
  ample headroom. The WebGL presenter (§2) is chosen partly to spare mobile GPUs
  the `putImageData` path.
- **UI-thread jank on the play path.** The on-screen touch joystick, the primary
  mobile input, does no synchronous layout, per-event allocation, or redundant
  control-port work while dragging: geometry is cached on `pointerdown`, the knob
  is a compositor-promoted transform coalesced to 60 Hz, and joystick-byte
  synchronization waits for the 50 Hz emulation-frame boundary. The base page is
  sized in `dvh` so iOS Safari's dynamic toolbar doesn't shift it, and the
  paint-driven CRT effects stop animating while the machine is paused.
- **Background pause.** When the tab or app loses focus or is backgrounded,
  emulation freezes and the audio context is suspended, then thaws on return,
  so a backgrounded tab neither burns CPU nor spikes when it comes back.

## 5. Requirements

The SID audio ring is a `SharedArrayBuffer`, so the page **must be cross-origin
isolated**. That requires two response headers on the document (and its assets):

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without them `SharedArrayBuffer` is unavailable and the machine constructor
throws. The Vite dev and preview servers set these headers automatically; a
production host must send the same. See
the [machine orchestrator](MACHINE-ARCHITECTURE.md) §7.

## 6. Measurement Harnesses

Never trust a performance comparison across a different thermal window. On an
M1-class laptop, a heavy build, test run, or screenshot pass can change the next
number enough to make a neutral change look like a large regression. Run a
same-thermal A/B, back-to-back:

1. Measure the candidate.
2. Stash only the files under test.
3. Measure the baseline.
4. Pop the stash and measure the candidate again.

Two traps are worth naming, because both produce confident nonsense:

- **A sampling heap profile measures what survived, not what was allocated.**
  Those profilers hold their samples weakly, so anything already collected is
  simply gone from the report; profile a longer run and the total can come out
  *smaller*. To measure how much garbage the machine makes, account for it at
  the collections themselves.
- **Separate warm-up from steady state by changing the run length.** A count
  that lands identically at three thousand frames and at twelve thousand is
  start-up cost, however alarming its size; only a figure that grows with the
  run is something the emulator pays for continuously.

The desktop V8 harness is `tools/perf-workloads.mjs`:

```bash
node --expose-gc tools/perf-workloads.mjs <workload> <mode> [frames]
```

The demo files the workloads load come from `test/external-assets.json`
(`orbit-untold-prg`, `raster-time-demo`, the `c64stuff` collection); edit the
paths there or set the per-entry environment variable.

Workloads are `idle`, `orbit`, `rastertime`, `comaload`, and `comarun`; modes
are `time`, `prof`, `alloc`, `allocsites`, `mem`, and `all`. `time` is useful
for throughput, but V8 can escape-analyze short-lived allocations away. Use
`allocsites` to see allocation a non-EA engine, such as JavaScriptCore on iOS,
would still pay for.

The Safari/JSC harness is `tools/jsc-perf.mjs` plus
`tools/jsc-perf-harness.html`:

```bash
npx playwright install webkit          # one-time
node tools/jsc-perf.mjs "label"
```

It starts a throwaway static server with the COOP/COEP headers required by the
SID `SharedArrayBuffer`, launches Playwright WebKit, boots to READY, and times
9×300-frame idle batches through the real unbundled modules. Treat desktop
WebKit time as only part of the story: allocation reductions can be neutral on a
desktop core with an ample nursery and still remove visible jank on a phone.
