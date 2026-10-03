// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/ui/crt-panel.js — the CRT control panel: a small dialog floating over the
// picture with the preset row and one control per parameter in crt-params.js
// (a slider, or a select for a parameter with `options`). Built lazily from
// CRT_PARAMS, so a parameter added there appears here without a template
// change. Opened and closed by the app shortcut only; the CRT button keeps
// cycling. The panel owns no state: it reads through the callbacks and writes
// through them, and refresh() pulls the current numbers back into the controls.
import { CRT_PARAMS, CRT_MODES } from '../crt-params.js';
import { pushEscapeLayer, popEscapeLayer } from './escape-stack.js';
import { appAccel } from '../app-accel.js';

const MODE_LABELS = { on: 'ON', tube: 'TUBE', bw: 'B&W', arcade: 'ARCADE', hum: 'HUM', off: 'OFF' };

// A choice names itself in its select; only ranges get a readout.
const fmt = (spec, v) => spec.options ? '' : spec.step >= 1 ? String(Math.round(v)) : v.toFixed(2);

/**
 * @param {object} o
 * @param {Element} o.host        where the panel is appended (document.body: it floats
 *                                over the whole window, position: fixed)
 * @param {Element} o.anchor      the monitor frame; the first open lands in its top-right corner
 * @param {() => string} o.getMode
 * @param {(mode: string) => void} o.setMode
 * @param {() => object|null} o.getParams   resolved parameters for the mode, null when off
 * @param {(key: string, value: number) => void} o.setParam
 * @param {() => void} o.resetParams      drop the mode's overrides
 * @param {boolean} o.tunable             the shader path is on, so sliders take effect
 * @param {() => void} [o.onClose]
 * @param {{x: number, y: number}|null} [o.initialPos]   where it was left last time (viewport pixels)
 * @param {(pos: {x: number, y: number}) => void} [o.savePos]
 */
export function createCrtPanel({ host, anchor, getMode, setMode, getParams, setParam, resetParams, tunable, onClose, initialPos = null, savePos }) {
  const doc = host.ownerDocument;
  const el = doc.createElement('div');
  el.className = 'crt-panel';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'CRT settings');
  el.hidden = true;

  const presets = CRT_MODES.map(m =>
    `<button type="button" class="btn crt-panel-preset" data-mode="${m}" aria-pressed="false">${MODE_LABELS[m]}</button>`).join('');
  const controls = CRT_PARAMS.map(spec => {
    const input = spec.options
      ? `<select class="crt-panel-select" data-key="${spec.key}">${spec.options.map((o, i) => `<option value="${i}">${o}</option>`).join('')}</select>`
      : `<input type="range" class="volume-slider crt-panel-range" data-key="${spec.key}" min="${spec.min}" max="${spec.max}" step="${spec.step}">`;
    return `<label class="crt-panel-row"><span class="crt-panel-name">${spec.label}</span>${input}<output class="crt-panel-value" data-for="${spec.key}"></output></label>`;
  }).join('');
  el.innerHTML = `
    <div class="crt-panel-head"><span class="crt-panel-title">CRT</span>
      <button type="button" class="btn crt-panel-close" aria-label="Close">✕</button></div>
    <div class="crt-panel-presets">${presets}</div>
    <div class="crt-panel-controls">${controls}</div>
    <div class="crt-panel-foot">
      <button type="button" class="btn crt-panel-reset">Reset preset</button>
      <span class="crt-panel-note"></span></div>`;
  host.appendChild(el);

  const controlsEl = el.querySelector('.crt-panel-controls');
  const footEl = el.querySelector('.crt-panel-foot');
  const noteEl = el.querySelector('.crt-panel-note');
  const inputs = Object.fromEntries(CRT_PARAMS.map(spec => [spec.key, el.querySelector(`[data-key="${spec.key}"]`)]));
  const outputs = Object.fromEntries(CRT_PARAMS.map(spec => [spec.key, el.querySelector(`[data-for="${spec.key}"]`)]));

  // Dragged by its header, anywhere in the window: position is left/top in
  // viewport pixels (the panel is fixed), clamped so it stays fully on screen.
  // The panel's rect is read once on pointerdown so the move handler never
  // forces layout. The first open, with nothing remembered, lands in the top-
  // right corner of the monitor frame.
  const headEl = el.querySelector('.crt-panel-head');
  const win = host.ownerDocument.defaultView || window;
  let pos = initialPos;
  const clampPos = (x, y, panelRect) => ({
    x: Math.round(Math.min(Math.max(0, x), Math.max(0, win.innerWidth - panelRect.width))),
    y: Math.round(Math.min(Math.max(0, y), Math.max(0, win.innerHeight - panelRect.height))),
  });
  const place = (p) => {
    pos = p;
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    el.style.right = 'auto';
  };
  let drag = null;
  headEl.addEventListener('pointerdown', e => {
    if (e.target.closest && e.target.closest('button')) return;
    const r = el.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, panel: r };
    headEl.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });
  headEl.addEventListener('pointermove', e => {
    if (!drag) return;
    place(clampPos(e.clientX - drag.dx, e.clientY - drag.dy, drag.panel));
  });
  const endDrag = () => {
    if (!drag) return;
    drag = null;
    savePos?.(pos);
  };
  headEl.addEventListener('pointerup', endDrag);
  headEl.addEventListener('pointercancel', endDrag);

  const isOpen = () => !el.hidden;
  const refresh = () => {
    const mode = getMode();
    for (const b of el.querySelectorAll('.crt-panel-preset')) {
      b.setAttribute('aria-pressed', b.getAttribute('data-mode') === mode ? 'true' : 'false');
    }
    const p = getParams();
    const show = !!p && tunable;
    controlsEl.hidden = !show;
    footEl.hidden = !p;
    noteEl.textContent = !p ? '' : tunable ? '' : 'Tuning needs the WebGL shader; this browser draws the presets with CSS.';
    if (!show) return;
    for (const spec of CRT_PARAMS) {
      inputs[spec.key].value = String(p[spec.key]);
      outputs[spec.key].textContent = fmt(spec, p[spec.key]);
    }
  };

  const layer = { close: () => close(), isOpen };
  const open = () => {
    el.hidden = false;
    refresh();
    // A remembered spot is re-clamped: the window may be smaller than last time.
    const r = el.getBoundingClientRect();
    if (pos) place(clampPos(pos.x, pos.y, r));
    else if (anchor) {
      const a = anchor.getBoundingClientRect();
      place(clampPos(a.right - r.width - 12, a.top + 12, r));
    }
    pushEscapeLayer(layer);
  };
  const close = () => {
    if (el.hidden) return;
    el.hidden = true;
    popEscapeLayer(layer);
    onClose?.();
  };
  const toggle = () => (isOpen() ? close() : open());

  el.addEventListener('click', e => {
    const t = e.target.closest ? e.target.closest('button') : null;
    if (!t) return;
    if (t.classList.contains('crt-panel-preset')) { setMode(t.getAttribute('data-mode')); refresh(); }
    else if (t.classList.contains('crt-panel-reset')) { resetParams(); refresh(); }
    else if (t.classList.contains('crt-panel-close')) close();
  });
  const onValue = e => {
    const key = e.target.getAttribute && e.target.getAttribute('data-key');
    if (!key || !inputs[key]) return;
    const spec = CRT_PARAMS.find(s => s.key === key);
    const v = Number(e.target.value);
    if (!Number.isFinite(v)) return;
    setParam(key, v);
    outputs[key].textContent = fmt(spec, v);
  };
  el.addEventListener('input', onValue);
  el.addEventListener('change', onValue);
  // A focused slider makes input.js stand down on the app chord, so the panel
  // answers its own shortcut there: the same chord closes it.
  el.addEventListener('keydown', e => {
    if (e.code === 'KeyF' && appAccel(e, false)) { e.preventDefault(); e.stopPropagation(); close(); }
  });

  return { el, open, close, toggle, isOpen, refresh };
}
