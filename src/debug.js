// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/debug.js – DevTools console helpers (window.c64Trace / c64Vic / c64Bus).
//
// Pure debugging surface: per-raster frame trace, SID write capture, VIC state
// dumps, bus tracing. Installed as window globals at import time so they are
// callable from the browser console. Reads the live `machine` binding; has no
// other dependency on the app. Imported for side effects only by main.js.
// main.js also reads `window.c64Trace?.sidDiag` (in the SID cycle-sync path),
// and recorder.js `window.c64Trace?.recorderDiag` (remux/index statistics).

import { machine } from './state.js';

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
    if (!machine) { console.warn('machine not ready'); return; }
    machine.vic2.frameTraceEnabled = true;
    console.log('VIC frame-trace ENABLED — next snapshot will include per-raster data');
  },
  disable() {
    if (!machine) { console.warn('machine not ready'); return; }
    machine.vic2.frameTraceEnabled = false;
    console.log('VIC frame-trace DISABLED');
  },
  status() {
    if (!machine) { console.log('machine not ready'); return; }
    const on = !!machine.vic2.frameTraceEnabled;
    console.log(`VIC frame-trace is ${on ? 'ENABLED' : 'disabled'}`);
    return on;
  },
  sidStart(n = 20000) {
    if (!machine) { console.warn('machine not ready'); return; }
    machine.sidTraceStart(n);
  },
  sidDump(reg) {
    if (!machine) { console.warn('machine not ready'); return; }
    const rows = machine.sidTraceDump(reg);
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
    if (!machine) { console.warn('machine not ready'); return; }
    const all = machine.sidTraceBuf || [];
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

  // Per-frame "raster-scroller jitter" capture. Records, across the next
  // N frames, the cycle position of:
  //   - first IRQ accept (entry into $FF48 KERNAL or whatever $FFFE points at)
  //   - first entry into the soft-vec target ($0314/5 → handler PC)
  //   - value of $F7 zero-page at that entry (the demo's stable-raster fixup)
  //   - every STA $D020 / STA $D021 (color-split writes)
  //   - every STA $D012 (raster IRQ re-arm)
  //
  // Output: jitterDump() prints a one-line-per-frame table so you can
  // eyeball frame-to-frame variance. If the same column shows a varying
  // value across frames, that's the source of the jerk.
  //
  // Use:
  //   c64Trace.jitterStart(60)    // arm 60-frame capture
  //   // let the demo run / play the scroller for ~1 second
  //   c64Trace.jitterDump()       // print table; also returns the raw data
  jitterStart(n = 60) {
    if (!machine) { console.warn('machine not ready'); return; }
    if (window._jitterState?.active) {
      console.warn('jitter capture already active; call jitterDump first');
      return;
    }
    const cpu = machine.cpu;
    const v = machine.vic2;
    const mem = machine.mem;
    // Resolve the soft IRQ vector ($0314/5) at arm-time — the demo's
    // handler is whatever lives there now.
    const softIrqLo = mem.ram[0x0314];
    const softIrqHi = mem.ram[0x0315];
    const softIrq = softIrqLo | (softIrqHi << 8);
    // The KERNAL IRQ entry ($FFFE/F): read live, accounting for $01 banking.
    const hwIrqLo = mem.read(0xFFFE);
    const hwIrqHi = mem.read(0xFFFF);
    const hwIrq = hwIrqLo | (hwIrqHi << 8);

    // Busy-loop PC at arm time: the user-mode "wait for IRQ" loop. Used to
    // detect handler exit (PC transitions back into busy-loop range after
    // entering the IRQ handler). Range = the 16-byte aligned page slice
    // containing the entry PC.
    const busyLoopPc = cpu.pc;
    const busyLoopRangeLo = busyLoopPc & 0xFFF0;
    const busyLoopRangeHi = busyLoopRangeLo + 0x10;

    const state = {
      active: true,
      framesLeft: n,
      frames: [],
      cur: null,
      hwIrq, softIrq,
      busyLoopPc, busyLoopRangeLo, busyLoopRangeHi,
      origCpuClock: cpu.clock.bind(cpu),
      origVicClock: v.clock.bind(v),
      origVicWrite: v.write.bind(v),
      prevPc: cpu.pc,
      prevBaLow: !!v.isBaLow?.(),
      prevAecLow: !!(v.isAecLowPhi2 ? v.isAecLowPhi2() : v.isAecLow?.()),
      lastBaRelease: null,
      lastAecRelease: null,
      recentBaEdges: [],
      // Track whether PC was inside the busy-loop range last cycle, so we can
      // detect the OUT→IN transition (= handler just RTI'd back).
      prevInBusyLoop: (cpu.pc >= busyLoopRangeLo && cpu.pc < busyLoopRangeHi),
    };
    const newFrame = () => {
      const f = {
        frame: n - state.framesLeft,
        irqHw: null, irqSoft: null, f7: null,
        d012: [], d020: [], d021: [],
        baReleaseBeforeHw: null, aecReleaseBeforeHw: null,
        baEdgesNearHw: null,
        // Cycle position at which the CPU re-enters the busy-loop range
        // after the handler RTIs (i.e., handler exit cycle for THIS frame's IRQ).
        handlerExit: null,
      };
      state.frames.push(f);
      state.cur = f;
    };
    newFrame();

    // Hook VIC.clock — sample BA/AEC each master cycle and record edges.
    v.clock = function(arg) {
      const ret = state.origVicClock(arg);
      const baLow = !!v.isBaLow?.();
      const aecLow = !!(v.isAecLowPhi2 ? v.isAecLowPhi2() : v.isAecLow?.());
      if (baLow !== state.prevBaLow) {
        const edge = { r: v.raster, cy: v.cycleInLine, kind: baLow ? 'BA↓' : 'BA↑' };
        if (!baLow) state.lastBaRelease = { r: v.raster, cy: v.cycleInLine };
        state.recentBaEdges.push(edge);
        if (state.recentBaEdges.length > 40) state.recentBaEdges.shift();
        state.prevBaLow = baLow;
      }
      if (aecLow !== state.prevAecLow) {
        if (!aecLow) state.lastAecRelease = { r: v.raster, cy: v.cycleInLine };
        state.recentBaEdges.push({ r: v.raster, cy: v.cycleInLine, kind: aecLow ? 'AE↓' : 'AE↑' });
        if (state.recentBaEdges.length > 40) state.recentBaEdges.shift();
        state.prevAecLow = aecLow;
      }
      return ret;
    };

    // Hook VIC.write — log STAs into $D012/$D020/$D021.
    v.write = function(reg, val) {
      const r = reg & 0x3F;
      const cy = v.cycleInLine, ras = v.raster;
      if (r === 0x12) state.cur.d012.push({ r: ras, cy, val: val & 0xFF });
      else if (r === 0x20) state.cur.d020.push({ r: ras, cy, val: val & 0xFF });
      else if (r === 0x21) state.cur.d021.push({ r: ras, cy, val: val & 0xFF });
      return state.origVicWrite(reg, val);
    };

    // Hook CPU.clock — detect PC transitions to the IRQ entries + count frames.
    cpu.clock = function() {
      const ret = state.origCpuClock();
      const pc = cpu.pc;
      if (pc !== state.prevPc) {
        if (pc === state.hwIrq && state.cur.irqHw === null) {
          state.cur.irqHw = { r: v.raster, cy: v.cycleInLine };
          state.cur.baReleaseBeforeHw  = state.lastBaRelease  ? { ...state.lastBaRelease  } : null;
          state.cur.aecReleaseBeforeHw = state.lastAecRelease ? { ...state.lastAecRelease } : null;
          const hwAbs = v.raster * 63 + v.cycleInLine;
          state.cur.baEdgesNearHw = state.recentBaEdges
            .filter(e => Math.abs((e.r * 63 + e.cy) - hwAbs) <= 130)
            .map(e => ({ ...e }));
        }
        if (pc === state.softIrq && state.cur.irqSoft === null) {
          state.cur.irqSoft = { r: v.raster, cy: v.cycleInLine };
          state.cur.f7 = mem.ram[0xF7];
        }
        state.prevPc = pc;
      }
      // Handler-exit detection: was OUT of busy-loop range last cycle, is IN
      // this cycle → that's the cycle after RTI completed and PC re-entered
      // the busy-loop. Only counts AFTER we've recorded the soft-IRQ entry
      // (so we don't capture pre-IRQ states or count the busy-loop self-cycles).
      const inBusy = (pc >= state.busyLoopRangeLo && pc < state.busyLoopRangeHi);
      if (inBusy && !state.prevInBusyLoop && state.cur.irqSoft !== null && state.cur.handlerExit === null) {
        state.cur.handlerExit = { r: v.raster, cy: v.cycleInLine };
      }
      state.prevInBusyLoop = inBusy;
      // Frame boundary detection: raster wraps from LINES_PER_FRAME-1 to 0.
      if (v.raster === 0 && v.cycleInLine <= 1 && state.lastRaster > 1) {
        state.framesLeft--;
        if (state.framesLeft > 0) newFrame();
        else {
          state.active = false;
          cpu.clock = state.origCpuClock;
          v.clock  = state.origVicClock;
          v.write  = state.origVicWrite;
          console.log(`jitter capture complete — ${state.frames.length} frames in buffer. Call c64Trace.jitterDump()`);
        }
      }
      state.lastRaster = v.raster;
      return ret;
    };
    state.lastRaster = v.raster;
    window._jitterState = state;
    console.log(`jitter capture armed for ${n} frames. softIrq=$${softIrq.toString(16)} hwIrq=$${hwIrq.toString(16)}`);
  },

  jitterDump() {
    const state = window._jitterState;
    if (!state) { console.log('no jitter capture; call jitterStart(N) first'); return; }
    if (state.active) {
      console.log(`still capturing — ${state.framesLeft} frames remaining`);
      return;
    }
    const f = state.frames;
    if (!f.length) { console.log('no frames captured'); return state; }
    const fmtPos = p => p ? `r${String(p.r).padStart(3)}c${String(p.cy).padStart(2)}` : '   -    ';
    // Build the entire report as a single string and log once — avoids the
    // per-line "VM###:###" annotation DevTools attaches to each console.log.
    const out = [];
    out.push(`=== Per-frame raster-scroller jitter trace (${f.length} frames) ===`);
    out.push(`softIrq target=$${state.softIrq.toString(16)}  hwIrq target=$${state.hwIrq.toString(16)}`);
    out.push('frame  hwIrq@      softIrq@    $F7   ba↑@      aec↑@     hExit@      hExit%3   d012writes                     first-d020   d020#  d021#');
    for (const e of f) {
      const d012s = (e.d012.map(w => `${fmtPos(w)}=$${w.val.toString(16)}`).join(' ') || '-').padEnd(30);
      const firstD020 = e.d020[0] ? fmtPos(e.d020[0]) : '   -    ';
      const ba  = fmtPos(e.baReleaseBeforeHw);
      const aec = fmtPos(e.aecReleaseBeforeHw);
      const hExit = fmtPos(e.handlerExit);
      const hExitMod3 = e.handlerExit ? String((e.handlerExit.r * 63 + e.handlerExit.cy) % 3) : '-';
      out.push(
        `${String(e.frame).padStart(4)}   ${fmtPos(e.irqHw)}  ${fmtPos(e.irqSoft)}  ${e.f7 === null ? ' --' : String(e.f7).padStart(3)}   ${ba}  ${aec}  ${hExit}  ${hExitMod3.padStart(7)}   ${d012s}  ${firstD020}  ${String(e.d020.length).padStart(5)}  ${String(e.d021.length).padStart(5)}`
      );
    }
    // ── Variance summaries ─────────────────────────────────────────────
    const softCycles = f.map(x => x.irqSoft ? (x.irqSoft.r * 63 + x.irqSoft.cy) : null).filter(v => v !== null);
    if (softCycles.length > 1) {
      const uniq = new Set(softCycles.map(v => v % 63));
      out.push('');
      out.push(`softIrq within-line cycle: unique cycles=${[...uniq].sort((a,b)=>a-b).join(',')}`);
      out.push(uniq.size === 1
        ? '  ✓ CONSTANT — handler enters at the same cycle every frame'
        : '  ✗ VARIES — handler entry cycle jitters frame-to-frame');
    }
    const d020Cycles = f.map(x => x.d020[0] ? x.d020[0].cy : null).filter(v => v !== null);
    if (d020Cycles.length > 1) {
      const uniq = new Set(d020Cycles);
      out.push(`first $D020 within-line cycle: unique cycles=${[...uniq].sort((a,b)=>a-b).join(',')}`);
      out.push(uniq.size === 1
        ? '  ✓ CONSTANT — color split lands at same cycle every frame'
        : '  ✗ VARIES — first color split jitters');
    }
    const f7s = f.map(x => x.f7).filter(v => v !== null);
    if (f7s.length > 1) {
      const uniq = new Set(f7s);
      out.push(`$F7 across frames: unique values=${[...uniq].sort((a,b)=>a-b).join(',')}`);
      out.push(uniq.size === 1 ? '  ✓ CONSTANT $F7' : '  ↻ varies (often intentional — scroll counter)');
    }
    const baCy = f.map(x => x.baReleaseBeforeHw?.cy).filter(v => v !== undefined && v !== null);
    if (baCy.length > 1) {
      const uniq = new Set(baCy);
      out.push(`BA-release within-line cycle (before hwIrq): unique cycles=${[...uniq].sort((a,b)=>a-b).join(',')}`);
      out.push(uniq.size === 1 ? '  ✓ CONSTANT BA-release' : '  ✗ VARIES — sprite-DMA stall ends at different cycles → CPU resumes at different phase');
    }
    const aecCy = f.map(x => x.aecReleaseBeforeHw?.cy).filter(v => v !== undefined && v !== null);
    if (aecCy.length > 1) {
      const uniq = new Set(aecCy);
      out.push(`AEC-release within-line cycle (before hwIrq): unique cycles=${[...uniq].sort((a,b)=>a-b).join(',')}`);
      out.push(uniq.size === 1 ? '  ✓ CONSTANT AEC-release' : '  ✗ VARIES — CPU bus unblock cycle drifts');
    }
    // ── Same-$F7 variance check: are color writes constant when $F7 is the
    //    same? If not, the demo's stable-raster compensation isn't absorbing
    //    everything → the jerk comes from something other than $F7.
    const byF7 = new Map();
    for (const e of f) {
      if (e.f7 === null || !e.d020[0]) continue;
      if (!byF7.has(e.f7)) byF7.set(e.f7, []);
      byF7.get(e.f7).push(e.d020[0].cy);
    }
    out.push('');
    out.push('Same-$F7 first-$D020 variance:');
    let anyVaries = false;
    for (const [f7v, cys] of [...byF7.entries()].sort((a,b)=>a[0]-b[0])) {
      const uniq = new Set(cys);
      const mark = uniq.size === 1 ? '✓' : '✗';
      if (uniq.size !== 1) anyVaries = true;
      out.push(`  $F7=${f7v}: ${cys.length} frames, cycles={${[...uniq].sort((a,b)=>a-b).join(',')}}  ${mark}`);
    }
    if (anyVaries) out.push('  → SAME $F7 produces DIFFERENT $D020 cycles → fixup is not absorbing the full jitter (likely BA/AEC phase)');
    else out.push('  → $F7 fully determines $D020 cycle (good)');

    // Handler-exit cycle variance: is the cycle the CPU returns to the
    // busy-loop constant frame-to-frame? If not, that's what feeds varying
    // BVC-phase at the NEXT frame's IRQ accept.
    const exits = f.map(x => x.handlerExit).filter(Boolean);
    if (exits.length > 1) {
      const absExits = exits.map(e => e.r * 63 + e.cy);
      const mod3 = new Set(absExits.map(c => c % 3));
      const withinLine = new Set(exits.map(e => e.cy));
      out.push('');
      out.push(`Handler-exit cycle (mod 3): unique={${[...mod3].sort((a,b)=>a-b).join(',')}}  within-line cycles={${[...withinLine].sort((a,b)=>a-b).join(',')}}`);
      if (mod3.size === 1) out.push('  ✓ CONSTANT mod 3 — BVC re-enters at the same phase every frame → jitter is downstream of handler exit');
      else out.push('  ✗ VARIES — handler returns to busy-loop at a different cycle each frame → directly drives the IRQ-accept jitter');
    }

    const summaryText = out.join('\n');
    console.log(summaryText);

    // Auto-download a single JSON document that contains BOTH the human-readable
    // summary AND the full per-frame data, so the user can copy/share everything
    // without DevTools collapsing arrays of objects.
    const doc = {
      version: 1,
      timestamp: new Date().toISOString(),
      softIrq: state.softIrq,
      hwIrq: state.hwIrq,
      frameCount: state.frames.length,
      summary: summaryText,
      frames: state.frames,
    };
    try {
      const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      a.download = `c64-jitter-${ts}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      console.log(`(downloaded ${a.download} — full data + summary in one JSON file)`);
    } catch (e) {
      console.warn('auto-download failed:', e);
    }
    // Return undefined so DevTools doesn't auto-print the collapsed array.
  },

  jitterDownload() {
    // Kept for backwards compatibility — jitterDump() now auto-downloads,
    // but this still works if you want to re-download the last capture.
    const state = window._jitterState;
    if (!state || !state.frames.length) { console.log('nothing to download'); return; }
    const blob = new Blob([JSON.stringify(state.frames, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const ts = new Date().toISOString().replace(/[:.]/g,'-');
    a.download = `c64-jitter-${ts}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    console.log(`downloaded ${a.download}`);
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
    if (!machine) { console.warn('machine not ready'); return; }
    if (on === undefined) {
      const cur = !!machine.vic2.nmosBankDelay;
      console.log(`vic.nmosBankDelay = ${cur} (variant=${machine.vic2.vicVariant})`);
      return cur;
    }
    machine.vic2.nmosBankDelay = !!on;
    console.log(`vic.nmosBankDelay = ${machine.vic2.nmosBankDelay} (variant=${machine.vic2.vicVariant})`);
    return machine.vic2.nmosBankDelay;
  },
  // C64C / 8565 glue-logic glitch — bank 1 ↔ bank 2 transitions blip
  // through bank 3 for one cycle. Only active when vicVariant='8565'.
  bankGlitch(on) {
    if (!machine) { console.warn('machine not ready'); return; }
    if (on === undefined) {
      const cur = !!machine.vic2.c64cBankGlitch;
      console.log(`vic.c64cBankGlitch = ${cur} (variant=${machine.vic2.vicVariant})`);
      return cur;
    }
    machine.vic2.c64cBankGlitch = !!on;
    console.log(`vic.c64cBankGlitch = ${machine.vic2.c64cBankGlitch} (variant=${machine.vic2.vicVariant})`);
    return machine.vic2.c64cBankGlitch;
  },
  // Batch-render fast path for _fixupColumns — re-renders only the cycles whose
  // mode/bg lookahead window changed instead of the whole line twice. Meant to
  // be byte-identical to the default path (a perf optimisation); toggle here to
  // A/B compare. See vic2-render.js _fixupColumns.
  //   c64Vic.batchRender(true)   — enable
  //   c64Vic.batchRender(false)  — disable
  //   c64Vic.batchRender()       — read current state
  batchRender(on) {
    if (!machine) { console.warn('machine not ready'); return; }
    if (on === undefined) {
      const cur = !!machine.vic2.batchRender;
      console.log(`vic.batchRender = ${cur}`);
      return cur;
    }
    machine.vic2.batchRender = !!on;
    console.log(`vic.batchRender = ${machine.vic2.batchRender}`);
    return machine.vic2.batchRender;
  },
  // Capture-state snapshot dedup (ON by default) — aliases the previous cycle's
  // row/sprite snapshots when unchanged instead of re-copying 9 typed arrays per
  // visible cycle. Byte-identical; toggle to A/B. captureDedupVerify(true) adds a
  // per-cycle assertion that the alias still matches the live source.
  //   c64Vic.captureDedup(true|false)        — enable/disable
  //   c64Vic.captureDedup()                  — read current state
  captureDedup(on) {
    if (!machine) { console.warn('machine not ready'); return; }
    if (on === undefined) {
      const cur = !!machine.vic2.captureDedup;
      console.log(`vic.captureDedup = ${cur}`);
      return cur;
    }
    machine.vic2.captureDedup = !!on;
    console.log(`vic.captureDedup = ${machine.vic2.captureDedup}`);
    return machine.vic2.captureDedup;
  },
  captureDedupVerify(on) {
    if (!machine) { console.warn('machine not ready'); return; }
    if (on === undefined) return !!machine.vic2.captureDedupVerify;
    machine.vic2.captureDedupVerify = !!on;
    console.log(`vic.captureDedupVerify = ${machine.vic2.captureDedupVerify}`);
    return machine.vic2.captureDedupVerify;
  },
  // Sprite idle-cycle skip (ON by default) — _renderSpriteSegmentForSprite
  // returns early on cycles where a started sprite is steady and paints nothing
  // (no segment overlap / no end-of-line wrap), plus a never-started loop skip.
  // Byte-identical; toggle to A/B.
  //   c64Vic.spriteSkipIdle(true|false) / c64Vic.spriteSkipIdle()
  spriteSkipIdle(on) {
    if (!machine) { console.warn('machine not ready'); return; }
    if (on === undefined) { const cur = !!machine.vic2.spriteSkipIdle; console.log(`vic.spriteSkipIdle = ${cur}`); return cur; }
    machine.vic2.spriteSkipIdle = !!on;
    console.log(`vic.spriteSkipIdle = ${machine.vic2.spriteSkipIdle}`);
    return machine.vic2.spriteSkipIdle;
  },
};

// Shared external-data-bus model toggles + per-cycle bus trace. See README
// "Shared external-data-bus model" for the full description of each flag.
// Every getter/setter follows c64Vic's pattern: no arg reads, one arg sets.
//
//   c64Bus.status()                     dump all flags
//   c64Bus.openBus()                    read mode; c64Bus.openBus('disabled')
//   c64Bus.colorRam(true|false)         compose re-drive
//   c64Bus.portZeroOne(true|false)      $00/$01 RAM-under-port quirk
//   c64Bus.refresh(true|false)          VIC r-access drives bus
//   c64Bus.spriteIdle(true|false)       sprite-idle leak vs all-$FF
//   c64Bus.cpuInternal(true|false)      KIND_INTERNAL synth read
//   c64Bus.traceStart(1024)             enable per-cycle ring
//   c64Bus.traceStop()                  disable + free
//   c64Bus.traceDump(n)                 oldest-first slice
window.c64Bus = {
  status() {
    if (!machine) { console.warn('machine not ready'); return; }
    const s = {
      'mem.openBusMode':                       machine.mem.openBusMode,
      'mem.colorRamReadDrivesComposedByte':    !!machine.mem.colorRamReadDrivesComposedByte,
      'mem.openBusWritesToZeroOneEnabled':     !!machine.mem.openBusWritesToZeroOneEnabled,
      'vic2.vicRefreshDrivesBus':              !!machine.vic2.vicRefreshDrivesBus,
      'vic2.spriteIdleFetchLeakEnabled':       !!machine.vic2.spriteIdleFetchLeakEnabled,
      'vic2.vicInternalBusCpuScope':           machine.vic2.vicInternalBusCpuScope,
      'cpu.cpuInternalCycleDrivesBus':         !!machine.cpu.cpuInternalCycleDrivesBus,
      'machine.busTraceEnabled':               !!machine.busTraceEnabled,
      'machine.busTraceDepth':                 machine.busTraceDepth,
      'mem.externalDataBus8':                  '0x' + (machine.mem.externalDataBus8 & 0xFF).toString(16).padStart(2, '0'),
      'vic2.vicInternalBus':                   '0x' + (machine.vic2.vicInternalBus & 0xFF).toString(16).padStart(2, '0'),
    };
    console.table(s);
    return s;
  },
  openBus(mode) {
    if (!machine) { console.warn('machine not ready'); return; }
    if (mode === undefined) {
      console.log(`mem.openBusMode = '${machine.mem.openBusMode}'`);
      return machine.mem.openBusMode;
    }
    if (mode !== 'vice-compatible' && mode !== 'disabled' && mode !== 'random') {
      console.warn(`invalid openBus mode '${mode}' — expected 'vice-compatible' | 'disabled' | 'random'`);
      return machine.mem.openBusMode;
    }
    machine.mem.openBusMode = mode;
    console.log(`mem.openBusMode = '${mode}'`);
    return mode;
  },
  colorRam(on) {
    if (!machine) { console.warn('machine not ready'); return; }
    if (on === undefined) {
      const cur = !!machine.mem.colorRamReadDrivesComposedByte;
      console.log(`mem.colorRamReadDrivesComposedByte = ${cur}`);
      return cur;
    }
    machine.mem.colorRamReadDrivesComposedByte = !!on;
    console.log(`mem.colorRamReadDrivesComposedByte = ${!!on}`);
    return !!on;
  },
  portZeroOne(on) {
    if (!machine) { console.warn('machine not ready'); return; }
    if (on === undefined) {
      const cur = !!machine.mem.openBusWritesToZeroOneEnabled;
      console.log(`mem.openBusWritesToZeroOneEnabled = ${cur}`);
      return cur;
    }
    machine.mem.openBusWritesToZeroOneEnabled = !!on;
    console.log(`mem.openBusWritesToZeroOneEnabled = ${!!on}`);
    return !!on;
  },
  refresh(on) {
    if (!machine) { console.warn('machine not ready'); return; }
    if (on === undefined) {
      const cur = !!machine.vic2.vicRefreshDrivesBus;
      console.log(`vic2.vicRefreshDrivesBus = ${cur}`);
      return cur;
    }
    machine.vic2.vicRefreshDrivesBus = !!on;
    console.log(`vic2.vicRefreshDrivesBus = ${!!on}`);
    return !!on;
  },
  spriteIdle(on) {
    if (!machine) { console.warn('machine not ready'); return; }
    if (on === undefined) {
      const cur = !!machine.vic2.spriteIdleFetchLeakEnabled;
      console.log(`vic2.spriteIdleFetchLeakEnabled = ${cur}`);
      return cur;
    }
    machine.vic2.spriteIdleFetchLeakEnabled = !!on;
    console.log(`vic2.spriteIdleFetchLeakEnabled = ${!!on}`);
    return !!on;
  },
  cpuInternal(on) {
    if (!machine) { console.warn('machine not ready'); return; }
    if (on === undefined) {
      const cur = !!machine.cpu.cpuInternalCycleDrivesBus;
      console.log(`cpu.cpuInternalCycleDrivesBus = ${cur}`);
      return cur;
    }
    machine.cpu.cpuInternalCycleDrivesBus = !!on;
    console.log(`cpu.cpuInternalCycleDrivesBus = ${!!on}`);
    return !!on;
  },
  traceStart(depth = 1024) {
    if (!machine) { console.warn('machine not ready'); return; }
    machine.enableBusTrace(depth);
    console.log(`bus trace ON, depth=${machine.busTraceDepth}`);
    return machine.busTraceDepth;
  },
  traceStop() {
    if (!machine) { console.warn('machine not ready'); return; }
    machine.disableBusTrace();
    console.log('bus trace OFF');
  },
  traceDump(n) {
    if (!machine) { console.warn('machine not ready'); return; }
    const snap = machine.busTraceSnapshot(n);
    if (snap.length === 0) {
      console.log('bus trace is empty (enable with c64Bus.traceStart())');
      return snap;
    }
    console.table(snap);
    return snap;
  },
};
