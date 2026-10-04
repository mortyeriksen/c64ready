// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/debug.js – DevTools console helpers (window.c64Trace / c64Vic / c64Bus).
//
// Pure debugging surface: per-raster frame trace, SID write capture, VIC state
// dumps, bus tracing. Installed as window globals at import time so they are
// callable from the browser console. Reads the live `c64` facade (its `debug`
// namespace); has no other dependency on the app. Imported for side effects only by main.js.
// main.js also reads `window.c64Trace?.sidDiag` (in the SID cycle-sync path),
// and recorder.js `window.c64Trace?.recorderDiag` (remux/index statistics).

import { c64 } from './state.js';

// Frame-trace toggles. The per-raster trace capture in vic2.js is gated by
// vic.frameTraceEnabled (default off). Expose console-callable enable/disable
// so the user can flip it on, run the demo to a moment of interest, hit
// Cmd+Shift+S, then turn it off again — without paying the per-frame cost in
// normal use.
//
// Usage from DevTools console:
//   c64Trace.enable()         // start capturing per-raster state
//   c64Trace.disable()        // stop capturing
//   c64Trace.status()         // see current state
//   c64Trace.sidStart(20000)  // capture next N SID register writes
//   c64Trace.sidDump(0x18)    // print + return $D418 writes (omit reg for all)
//   c64Trace.sidStats()       // summarize last capture: per-reg counts + rates
//   c64Trace.avMarkerOn()     // A/V sync clapper: flash + SID blip every 10 s
import { setAvMarkerEnabled } from './av-marker.js';

// main.js hands over its AudioContext once created, so audioLatency() can read
// the output-side delay without the debug surface reaching into the app.
let _audioCtx = null;
export function registerAudioContext(ctx) { _audioCtx = ctx; }

window.c64Trace = {
  // A/V sync clapper (session only — not persisted). See docs/TESTING.md.
  avMarkerOn: () => setAvMarkerEnabled(true),
  avMarkerOff: () => setAvMarkerEnabled(false),

  // Output-side latency of the live audio path, in ms. baseLatency is the graph
  // quantum; outputLatency includes the device — Bluetooth shows up here as
  // 150 ms+, and only affects what you HEAR, never what the recorder taps.
  audioLatency() {
    if (!_audioCtx) return 'audio not started yet';
    const base = (_audioCtx.baseLatency ?? 0) * 1000;
    const out = (_audioCtx.outputLatency ?? 0) * 1000;
    const r = { sampleRate: _audioCtx.sampleRate, baseMs: +base.toFixed(1), outputMs: +out.toFixed(1) };
    console.log(`[audio] base ${r.baseMs} ms + output ${r.outputMs} ms @ ${r.sampleRate} Hz`);
    return r;
  },

  enable() {
    if (!c64) { console.warn('machine not ready'); return; }
    c64.debug.setVicFlag('frameTraceEnabled', true);
    console.log('VIC frame-trace ENABLED — next snapshot will include per-raster data');
  },
  disable() {
    if (!c64) { console.warn('machine not ready'); return; }
    c64.debug.setVicFlag('frameTraceEnabled', false);
    console.log('VIC frame-trace DISABLED');
  },
  status() {
    if (!c64) { console.log('machine not ready'); return; }
    const on = c64.debug.getVicFlag('frameTraceEnabled');
    console.log(`VIC frame-trace is ${on ? 'ENABLED' : 'disabled'}`);
    return on;
  },
  sidStart(n = 20000) {
    if (!c64) { console.warn('machine not ready'); return; }
    c64.debug.sidTraceStart(n);
  },
  sidDump(reg) {
    if (!c64) { console.warn('machine not ready'); return; }
    const rows = c64.debug.sidTraceDump(reg);
    if (rows.length === 0) return rows;
    // Pretty-print first 40 with per-write delta in cycles + microseconds.
    const head = rows.slice(0, 40);
    console.log('idx  cycle       Δcyc   Δµs    reg  val');
    let prev = head[0][0];
    head.forEach(([cy, r, v], i) => {
      const d = cy - prev; prev = cy;
      const dus = (d / 985248 * 1e6).toFixed(1);
      console.log(`${String(i).padStart(3)}  ${String(cy).padStart(10)}  ${String(d).padStart(5)}  ${dus.padStart(6)}  $${r.toString(16).padStart(2,'0')}  $${v.toString(16).padStart(2,'0')}`);
    });
    if (rows.length > 40) console.log(`… (${rows.length - 40} more)`);
    return rows;
  },
  sidStats() {
    if (!c64) { console.warn('machine not ready'); return; }
    const all = c64.debug.sidTraceBuffer();
    if (all.length === 0) { console.log('no captured writes'); return; }
    const span = (all[all.length - 1][0] - all[0][0]) / 985248 * 1000;
    const perReg = new Map();
    for (const [, r] of all) perReg.set(r, (perReg.get(r) || 0) + 1);
    console.log(`captured ${all.length} writes over ${span.toFixed(1)} ms`);
    console.log('reg   count   rate(Hz)');
    [...perReg.entries()].sort((a,b) => b[1] - a[1]).forEach(([r, c]) => {
      console.log(`$${r.toString(16).padStart(2,'0')}   ${String(c).padStart(5)}   ${(c / span * 1000).toFixed(0)}`);
    });
  },
};

// Opt-in NMOS DDRA-bit-0→1 1-cycle bank-change delay (VIC-Addendum.txt,
// "Video bank and C64C"). Default OFF. Toggle to A/B-test demos that
// rely on the delayed behavior (FppScroller is a suspect).
//
//   c64Vic.bankDelay(true)   — turn delay on
//   c64Vic.bankDelay(false)  — turn it off
//   c64Vic.bankDelay()       — read current state
window.c64Vic = {
  bankDelay(on) {
    if (!c64) { console.warn('machine not ready'); return; }
    if (on === undefined) {
      const cur = c64.debug.getVicFlag('nmosBankDelay');
      console.log(`vic.nmosBankDelay = ${cur} (variant=${c64.vicVariant})`);
      return cur;
    }
    c64.debug.setVicFlag('nmosBankDelay', on);
    console.log(`vic.nmosBankDelay = ${c64.debug.getVicFlag('nmosBankDelay')} (variant=${c64.vicVariant})`);
    return c64.debug.getVicFlag('nmosBankDelay');
  },
  // C64C / 8565 glue-logic glitch — bank 1 ↔ bank 2 transitions blip
  // through bank 3 for one cycle. Only active when vicVariant='8565'.
  bankGlitch(on) {
    if (!c64) { console.warn('machine not ready'); return; }
    if (on === undefined) {
      const cur = c64.debug.getVicFlag('c64cBankGlitch');
      console.log(`vic.c64cBankGlitch = ${cur} (variant=${c64.vicVariant})`);
      return cur;
    }
    c64.debug.setVicFlag('c64cBankGlitch', on);
    console.log(`vic.c64cBankGlitch = ${c64.debug.getVicFlag('c64cBankGlitch')} (variant=${c64.vicVariant})`);
    return c64.debug.getVicFlag('c64cBankGlitch');
  },
  captureDedupVerify(on) {
    if (!c64) { console.warn('machine not ready'); return; }
    if (on === undefined) return c64.debug.getVicFlag('captureDedupVerify');
    c64.debug.setVicFlag('captureDedupVerify', on);
    console.log(`vic.captureDedupVerify = ${c64.debug.getVicFlag('captureDedupVerify')}`);
    return c64.debug.getVicFlag('captureDedupVerify');
  },

};

// Shared-bus latch inspection and per-cycle tracing.
window.c64Bus = {
  status() {
    if (!c64) { console.warn('machine not ready'); return; }
    const bus = c64.debug.busLatches();
    const s = {
      'machine.busTraceEnabled':               c64.debug.busTraceEnabled,
      'machine.busTraceDepth':                 c64.debug.busTraceDepth,
      'mem.externalDataBus8':                  '0x' + bus.externalDataBus8.toString(16).padStart(2, '0'),
      'vic2.vicInternalBus':                   '0x' + bus.vicInternalBus.toString(16).padStart(2, '0'),
    };
    console.table(s);
    return s;
  },
  traceStart(depth = 1024) {
    if (!c64) { console.warn('machine not ready'); return; }
    c64.debug.enableBusTrace(depth);
    console.log(`bus trace ON, depth=${c64.debug.busTraceDepth}`);
    return c64.debug.busTraceDepth;
  },
  traceStop() {
    if (!c64) { console.warn('machine not ready'); return; }
    c64.debug.disableBusTrace();
    console.log('bus trace OFF');
  },
  traceDump(n) {
    if (!c64) { console.warn('machine not ready'); return; }
    const snap = c64.debug.busTraceSnapshot(n);
    if (snap.length === 0) {
      console.log('bus trace is empty (enable with c64Bus.traceStart())');
      return snap;
    }
    console.table(snap);
    return snap;
  },
};
