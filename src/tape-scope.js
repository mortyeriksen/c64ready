// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/tape-scope.js — the tape signal on screen, drawn from the pulses themselves.
//
// A C64 tape stores its data in the WIDTH of square-wave pulses, so there is no
// visualisation to invent: the trace here IS the signal, built from the .tap
// entries under the head. It reads the same stream the speaker plays and is
// deliberately independent of it — the scope shows the waveform whether or not
// sound is switched on.
//
// While recording there is no tape to read ahead of the head, so the source
// swaps to the tail of what is being written (datasette.recordedSlice).
import { tapeScopeBtn, tapescopeModal, tapescopeCanvas, tapescopeClose,
         tapescopeState, tapescopeDetail } from './dom.js';
import { pushEscapeLayer, popEscapeLayer } from './escape-stack.js';
import { machine } from './state.js';

const CPU_HZ = 985248;
const WINDOW_CYCLES = 20000;    // ~20 ms of tape, a few dozen pulses
const TRACE = '#8fe985';        // C64 green, the phosphor this belongs to
const GRID  = 'rgba(112, 109, 235, 0.22)';

let raf = 0;

const isOpen = () => tapescopeModal && !tapescopeModal.hidden;

// The entries around the head, newest last. Playback reads the tape itself;
// recording reads what has just been laid down, since nothing is written ahead
// of the head yet.
function windowEntries(ds) {
  const version = ds.tapVersion ?? 1;
  const zeroGap = ds.zeroGapCycles ?? 20000;
  const pulses = [];
  let cycles = 0;

  const push = (data, from, to) => {
    // Walk backwards from `to`, which means walking forwards and keeping the
    // tail: a v1 entry is variable width, so it cannot be read in reverse.
    const all = [];
    for (let p = from; p < to;) {
      const b = data[p++];
      if (b !== 0) { all.push(b * 8); continue; }
      if (version === 0) { all.push(zeroGap); continue; }
      if (p + 2 >= to) break;
      all.push(data[p++] | (data[p++] << 8) | (data[p++] << 16));
    }
    for (let i = all.length - 1; i >= 0 && cycles < WINDOW_CYCLES; i--) {
      pulses.unshift(all[i]);
      cycles += all[i];
    }
  };

  if (ds.recording) {
    const len = ds.recordedLength;
    // A generous byte window: even all-minimum entries cannot outrun it.
    push(ds.recordedSlice(Math.max(0, len - 4096), len) || new Uint8Array(0), 0, Math.min(4096, len));
  } else if (ds.tapData) {
    const at = Math.min(ds.pos | 0, ds.tapData.length);
    push(ds.tapData, Math.max(0, at - 4096), at);
  }
  return { pulses, version };
}

function draw() {
  raf = 0;
  if (!isOpen()) return;
  raf = requestAnimationFrame(draw);

  const ctx = tapescopeCanvas?.getContext('2d');
  const ds = machine?.datasette;
  if (!ctx) return;
  const w = tapescopeCanvas.width, h = tapescopeCanvas.height;
  ctx.fillStyle = '#0b0e24';
  ctx.fillRect(0, 0, w, h);

  // Graticule: a scope has one, and it gives the eye a scale for pulse width.
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < 10; i++) { const x = Math.round((w * i) / 10) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, h); }
  for (let i = 1; i < 4; i++) { const y = Math.round((h * i) / 4) + 0.5; ctx.moveTo(0, y); ctx.lineTo(w, y); }
  ctx.stroke();

  const hasTape = !!(ds && (ds.tapData?.length || ds.recording));
  // Nothing is passing the head unless the tape is actually moving, and a scope
  // with no signal on it shows a flat line — not the last thing it saw.
  const moving = !!(ds && ds.motorOn && ds.hasMedia && (ds.playPressed || ds.recording));
  const { pulses, version } = hasTape && moving ? windowEntries(ds) : { pulses: [], version: 1 };

  if (!pulses.length) {
    ctx.strokeStyle = TRACE;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(h / 2));
    ctx.lineTo(w, Math.round(h / 2));
    ctx.stroke();
  } else {
    // One full-wave entry is low for its first half and high for its second; a
    // v2 entry is a half wave, so the level simply alternates.
    const total = pulses.reduce((a, b) => a + b, 0) || 1;
    const hi = Math.round(h * 0.25), lo = Math.round(h * 0.75);
    ctx.strokeStyle = TRACE;
    ctx.lineWidth = 2;
    ctx.beginPath();
    let x = 0, level = lo;
    ctx.moveTo(0, level);
    for (const cycles of pulses) {
      const span = (cycles / total) * w;
      if (version === 2) {
        ctx.lineTo(x + span, level);
        x += span;
        level = level === lo ? hi : lo;
        ctx.lineTo(x, level);
      } else {
        ctx.lineTo(x + span / 2, lo);
        x += span / 2;
        ctx.lineTo(x, hi);
        ctx.lineTo(x + span / 2, hi);
        x += span / 2;
        ctx.lineTo(x, lo);
        level = lo;
      }
    }
    ctx.stroke();
  }

  if (tapescopeState) {
    tapescopeState.textContent = !hasTape ? 'no tape'
      : ds.recording ? (moving ? 'recording' : 'record — motor off')
        : moving ? 'playing' : 'stopped';
  }
  if (tapescopeDetail) {
    if (!pulses.length) tapescopeDetail.textContent = hasTape ? 'no signal — the tape is not moving' : '';
    else {
      const shortest = Math.min(...pulses), longest = Math.max(...pulses);
      tapescopeDetail.textContent =
        `${pulses.length} pulses · ${(WINDOW_CYCLES / CPU_HZ * 1000).toFixed(0)} ms window · ` +
        `${shortest}–${longest} cycles`;
    }
  }
}

function open() {
  if (!tapescopeModal || isOpen()) return;
  tapescopeModal.hidden = false;
  tapeScopeBtn?.classList.add('is-open');
  pushEscapeLayer(escapeLayer);
  if (!raf) raf = requestAnimationFrame(draw);
}

function close() {
  if (!tapescopeModal) return;
  tapescopeModal.hidden = true;
  tapeScopeBtn?.classList.remove('is-open');
  popEscapeLayer(escapeLayer);
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
}

const escapeLayer = { close, isOpen };

if (tapeScopeBtn) {
  tapeScopeBtn.addEventListener('click', e => {
    e.stopPropagation();          // the card header toggles expand/collapse
    isOpen() ? close() : open();
  });
}
if (tapescopeClose) tapescopeClose.addEventListener('click', close);
if (tapescopeModal) {
  tapescopeModal.addEventListener('click', e => { if (e.target === tapescopeModal) close(); });
}
// Keystrokes belong to the dialog while it is up, not to the C64. Escape is
// escape-stack.js's.
document.addEventListener('keydown', e => {
  if (isOpen()) e.stopImmediatePropagation();
}, { capture: true });
