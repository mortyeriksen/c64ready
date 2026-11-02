// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/achievements/toast-place.js — where the toasts show. On the C64's
// screen, one of six places in the top or bottom border (Options ▸ Other ▸
// TOAST), top center until changed. In the vibes view, any spot and size the
// player dragged one to, top center at its usual size until then. A place is x and y from 0 to 1 across the room a toast has,
// set as CSS variables (styles-achievements.css). Both kept in the browser.

export const TOAST_PLACE_KEY = 'c64emu.achToastPlace';
export const VIBES_TOAST_PLACE_KEY = 'c64emu.achToastVibesPlace';
export const VIBES_TOAST_SIZE_KEY = 'c64emu.achToastVibesSize';
/** How far the vibes toast scales from its usual size, down and up. */
export const VIBES_SIZE_MIN = 0.6, VIBES_SIZE_MAX = 2.5;

export const TOAST_PLACES = Object.freeze([
  { id: 'top-left', label: 'TOP LEFT', x: 0, y: 0 },
  { id: 'top-center', label: 'TOP CENTER', x: 0.5, y: 0 },
  { id: 'top-right', label: 'TOP RIGHT', x: 1, y: 0 },
  { id: 'bottom-left', label: 'BOTTOM LEFT', x: 0, y: 1 },
  { id: 'bottom-center', label: 'BOTTOM CENTER', x: 0.5, y: 1 },
  { id: 'bottom-right', label: 'BOTTOM RIGHT', x: 1, y: 1 },
]);
export const DEFAULT_TOAST_PLACE = TOAST_PLACES[1];
export const DEFAULT_VIBES_PLACE = Object.freeze({ x: 0.5, y: 0 });
/** The vibes toast's margin from the view's edges, in CSS pixels (as its buttons'). */
export const VIBES_MARGIN = 18;

const store = {
  get: (key) => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key, value) => { try { localStorage.setItem(key, value); } catch { /* kept for this visit only */ } },
};
const unit = (v) => Number.isFinite(v) && v >= 0 && v <= 1;

/** A stored place's id. Anything else is the default. */
export function parsePlace(value) {
  return TOAST_PLACES.find((p) => p.id === value) ?? DEFAULT_TOAST_PLACE;
}
export const readPlace = () => parsePlace(store.get(TOAST_PLACE_KEY));
export const savePlace = (place) => store.set(TOAST_PLACE_KEY, place.id);

/** The next of the six places, round to the first. */
export function nextPlace(place) {
  const i = TOAST_PLACES.findIndex((p) => p.id === place.id);
  return TOAST_PLACES[(i + 1) % TOAST_PLACES.length];
}

/** A stored vibes spot, "x,y". Anything else is the default. */
export function parseVibesPlace(value) {
  const m = /^(\d*\.?\d+),(\d*\.?\d+)$/.exec(value ?? '');
  return m && unit(+m[1]) && unit(+m[2]) ? { x: +m[1], y: +m[2] } : DEFAULT_VIBES_PLACE;
}
export const readVibesPlace = () => parseVibesPlace(store.get(VIBES_TOAST_PLACE_KEY));
export const saveVibesPlace = (place) => store.set(VIBES_TOAST_PLACE_KEY, `${place.x},${place.y}`);

/** A stored vibes size, a scale of the usual one. Anything else is 1. */
export function parseVibesSize(value) {
  const s = Number(value);
  return value != null && value !== '' && Number.isFinite(s) && s >= VIBES_SIZE_MIN && s <= VIBES_SIZE_MAX ? s : 1;
}
export const readVibesSize = () => parseVibesSize(store.get(VIBES_TOAST_SIZE_KEY));
export const saveVibesSize = (scale) => store.set(VIBES_TOAST_SIZE_KEY, String(scale));
export const applySize = (area, scale) => area.style.setProperty('--ach-scale', String(scale));

/**
 * Lets the player drag a toast's corner grip to make it larger or smaller.
 * @param {object} o
 * @param {HTMLElement} o.el                    the toast
 * @param {HTMLElement} o.grip                  its corner grip
 * @param {() => number} o.scale                the scale now
 * @param {(scale: number) => void} o.onMove    while it changes
 * @param {(scale: number) => void} o.onDone    where it was let go
 * @returns {() => void} stops listening
 */
export function dragSize({ el, grip, scale, onMove, onDone }) {
  let start = null;
  const at = (e) => {
    const grown = (start.w + e.clientX - start.px) / start.w;
    return Math.round(Math.min(VIBES_SIZE_MAX, Math.max(VIBES_SIZE_MIN, start.scale * grown)) * 100) / 100;
  };
  const down = (e) => {
    if (e.button !== 0) return;
    start = { px: e.clientX, w: el.getBoundingClientRect().width, scale: scale() };
    grip.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  };
  const move = (e) => { if (start && grip.hasPointerCapture(e.pointerId)) onMove(at(e)); };
  const up = (e) => {
    if (!start) return;
    const s = at(e);
    start = null;
    onMove(s);
    onDone(s);
  };
  const events = { pointerdown: down, pointermove: move, pointerup: up, pointercancel: up };
  for (const [type, fn] of Object.entries(events)) grip.addEventListener(type, fn);
  return () => { for (const [type, fn] of Object.entries(events)) grip.removeEventListener(type, fn); };
}

/** Shows toasts at a place in `area`: they slide in from the nearer edge, top or bottom. */
export function applyPlace(area, place) {
  area.style.setProperty('--ach-x', String(place.x));
  area.style.setProperty('--ach-y', String(place.y));
  area.style.setProperty('--ach-from', place.y > 0.5 ? '1' : '-1');
}

/**
 * Lets the player drag a toast to the spot they want in `area`.
 * @param {object} o
 * @param {HTMLElement} o.area                    what the toast is placed in
 * @param {HTMLElement} o.el                      the toast to drag
 * @param {number} o.margin                       the toast's margin from the area's edges, in pixels
 * @param {(place: object) => void} o.onMove      while it moves
 * @param {(place: object) => void} o.onDone      where it was let go
 * @returns {() => void} stops listening
 */
export function dragPlace({ area, el, margin, onMove, onDone }) {
  let start = null;
  const share = (pos, size, room) => {
    const free = room - 2 * margin - size;
    return free > 0 ? Math.round(Math.min(1, Math.max(0, (pos - margin) / free)) * 1e4) / 1e4 : 0.5;
  };
  const at = (e) => ({ x: share(start.left + e.clientX - start.px, start.w, start.W), y: share(start.top + e.clientY - start.py, start.h, start.H) });
  const down = (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    const a = area.getBoundingClientRect(), r = el.getBoundingClientRect();
    start = { px: e.clientX, py: e.clientY, left: r.left - a.left, top: r.top - a.top, w: r.width, h: r.height, W: a.width, H: a.height };
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const move = (e) => { if (start && el.hasPointerCapture(e.pointerId)) onMove(at(e)); };
  const up = (e) => {
    if (!start) return;
    const place = at(e);
    start = null;
    onMove(place);
    onDone(place);
  };
  const events = { pointerdown: down, pointermove: move, pointerup: up, pointercancel: up };
  for (const [type, fn] of Object.entries(events)) el.addEventListener(type, fn);
  return () => { for (const [type, fn] of Object.entries(events)) el.removeEventListener(type, fn); };
}
