// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/switches.js — experimental / hardware-tuning switches, grouped in one
// place so the defaults are easy to read and change.
//
// Each switch has a plain-boolean DEFAULT that applies everywhere, including the
// Vite browser build (which has no `process`). In node — tests and one-off
// scripts — you can override any switch per run via its env
// var(s): `'1'` forces it on, `'0'` forces it off, anything else keeps the
// default. Resolution happens at call time (see `switchOn`), so a script may set
// `process.env.X` before constructing the machine and still have it take effect.
//
// This module has no imports (leaf), so both machine.js and cia.js can import it
// without an import cycle.

const SWITCHES = {
  // Clock the 1541 at the true PAL ratio — drive 1 MHz vs C64 985248 Hz,
  // ~1.5% fast — via a 16.16 fixed-point accumulator (factor 66517; see
  // the drive block in machine.js). OFF pins the
  // legacy 1:1 lockstep (factor 65536), bit-for-bit the pre-switch behavior.
  // 1:1 freezes the drive↔C64 phase at its load-start value, which made
  // marginal fastloader receptions all-or-nothing per boot and let
  // phase-dependent faults hide (Coma mole $390f JAM family); the true ratio
  // sweeps phase continuously like real hardware. The original float-ratio
  // accumulator was removed early on (pre-43b7902) because its quantization
  // broke NOSDOS-style 2-bit loaders against the then-rough CPU/CIA/VIC
  // timing — that surround is now cycle-audited, so the ratio returns as the
  // intended default. Toggle with DRIVE_TRUE_CLOCK_RATIO ('0' = 1:1 for A/B).
  driveTrueClockRatio: {
    default: true,
    env: ['DRIVE_TRUE_CLOCK_RATIO'],
  },

  // Model the IEC read-side propagation latency the instant-wire model
  // omits: drive output pins reach the C64's CIA one master cycle later
  // than the run order already gives — a $DD00 read at cycle S sees drive
  // writes from ≤ S−2. The C64→drive direction stays instant (delaying it
  // was tried and corrupts the NOSDOS install stage). Measured need:
  // NOSDOS F128's drive-release-to-4th-sample margin is exactly +1 C64
  // cycle at the legacy 1:1 drive clock and dips to −1 under the true
  // ratio's phase sweep — received bytes get bit 7/6 read HIGH when the
  // release lands one cycle before the sample (GnG/Commando CHECKING
  // corruption). Real hardware sweeps phase the same way and survives; the
  // asynchronous CIA input latching carries this margin. OFF = legacy
  // instant wiring, bit-exact.
  iecEdgeLatency: {
    default: true,
    env: ['IEC_EDGE_LATENCY'],
  },

  // Tier-3 line-batch rendering: defer a raster line's segment paints and
  // replay them in one burst through the SAME incremental machinery — at
  // line end (coalesced into maximal uniform spans, Phase 2), or
  // immediately when the CPU observes render-derived state mid-line
  // ($D019/$D01E/$D01F reads, $D01A collision-IRQ arming, fetch-config
  // changes, RAM writes into the line's g-access window — see
  // vic2._catchUpDeferredLine). Byte-identical at every CPU-observable
  // point: 339/339 both modes, fbhash + 195-shot + demo-status parity, and
  // the vic2-line-batch spec test locksteps the contract. Measured (clean
  // interleaved): orbit −14.5%, raster_time −25.8% ms/frame. Default ON
  // since 2026-07-03 (user visual pass); force the per-cycle live path
  // with ?LINE_BATCH=0 / LINE_BATCH=0 for A/B or triage.
  lineBatchRender: {
    default: true,
    env: ['LINE_BATCH'],
  },

  // Disk write support: let the 1541 write head mutate the raw GCR track buffer
  // and fold changes back into the D64 image, so SAVE / scratch / rename / format
  // (and a real DOS N) actually persist. OFF forces every inserted disk
  // write-protected — the legacy read-only behavior, bit-for-bit. Toggle with
  // DRIVE_WRITE ('0' = force read-only) for A/B or triage.
  driveWrite: {
    default: true,
    env: ['DRIVE_WRITE'],
  },

  // Record new blank tapes as TAP v2 (half-waves) instead of v1 (full waves).
  // v1 is what every tool and preserved tape uses, and the duty cycle inside a
  // pulse is invisible to the C64's read path, so it loses nothing functionally.
  // v2 keeps every edge — twice the entries, half the quantization error, and
  // asymmetric duty cycles survive — which is what you want when the recording
  // is an archival master rather than something to load back. Recording onto an
  // existing tape always follows that tape's own version, whatever this says.
  // Toggle with TAPE_RECORD_HALFWAVE ('1' = record v2).
  tapeRecordHalfwave: {
    default: false,
    env: ['TAPE_RECORD_HALFWAVE'],
  },

  // Present the framebuffer through a WebGL texture instead of
  // ctx.putImageData (src/webgl-presenter.js). Same 384×272 backing store,
  // NEAREST 1:1, opaque context — byte-exact output; CSS still does all
  // scaling, so nothing looks different. Saves the per-frame putImageData
  // convert+upload on the main thread (matters most on mobile GPUs). Falls
  // back to the 2D path automatically when WebGL is unavailable. Browser
  // A/B: append ?WEBGL_PRESENTER=0 to the URL to force the legacy 2D path.
  webglPresenter: {
    default: true,
    env: ['WEBGL_PRESENTER'],
  },
};

// Resolve a switch by name: env override ('1'/'0') if present, else — in the
// browser, which has no `process` — a URL query param with the same name
// (?WEBGL_PRESENTER=0), else the default. The query hook gives every switch
// a runtime A/B toggle in the browser without a rebuild.
export function switchOn(name) {
  const s = SWITCHES[name];
  if (!s) throw new Error(`unknown switch: ${name}`);
  if (typeof process !== 'undefined' && process?.env) {
    for (const e of s.env) {
      const v = process.env[e];
      if (v === '1') return true;
      if (v === '0') return false;
    }
  }
  if (typeof location !== 'undefined' && typeof URLSearchParams !== 'undefined' && location.search) {
    try {
      const q = new URLSearchParams(location.search);
      for (const e of s.env) {
        const v = q.get(e);
        if (v === '1') return true;
        if (v === '0') return false;
      }
    } catch { /* malformed query — fall through to the default */ }
  }
  return s.default;
}

export { SWITCHES };
