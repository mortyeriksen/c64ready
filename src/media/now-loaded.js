// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/media/now-loaded.js — what is in each slot right now (drive 8, drive 9,
// the cartridge port and the datasette) and the best title for it, for
// anything that names what is running, such as the chat's rooms. Each change
// is announced as a `c64-media` window event.
//
// A slot entry is { ref, kind, fileName?, headerName?, embeddedTitle?, release? }.
// `ref` identifies the medium (the disk object, the tape's name): setting the
// same ref again keeps what was learned about it, so a power cycle that re-fires
// the load hooks does not forget where a disk came from.

const SLOTS = ['drive8', 'drive9', 'cart', 'tape'];
const slots = new Map();

const KIND = {
  d64: 'disk', d71: 'disk', d81: 'disk', g64: 'disk', nbz: 'disk',
  prg: 'program', crt: 'cart', sid: 'tune', tap: 'tape', t64: 'tape', wav: 'tape', dmp: 'tape',
};
const SLOT_LABEL = { drive8: 'drive 8', drive9: 'drive 9', cart: 'cartridge', tape: 'tape' };
// Disk header names that say nothing about what is on the disk.
const GENERIC = /^(?:disk|disc|side ?[ab12]|disk ?[12ab]|empty|blank|untitled|new ?disk|default|prg|program|\s*)$/i;

function announce() {
  try { globalThis.dispatchEvent?.(new CustomEvent('c64-media')); } catch { /* no window (tests) */ }
}

/** Put a medium in a slot, or empty it with null. */
export function setLoaded(slot, info) {
  const cur = slots.get(slot);
  if (!info) { if (!cur) return; slots.delete(slot); }
  else slots.set(slot, cur && info.ref != null && cur.ref === info.ref ? { ...cur, ...info } : { ...info });
  announce();
}

/**
 * Add what a loader knows beyond the device (the file's own name, a tune's
 * title, the Assembly64 release) to a slot. With `fileName`, only if the slot
 * still holds that file, so a load that went somewhere else labels nothing.
 */
export function enrichLoaded(slot, extra, fileName) {
  const cur = slots.get(slot);
  if (!cur || (fileName != null && cur.fileName != null && cur.fileName !== fileName)) return;
  slots.set(slot, { ...cur, ...extra });
  announce();
}

/** "Commando (1985)[a].d64" → "Commando"; a lower-case name gets capitals. */
export function titleFromFileName(name) {
  if (!name) return '';
  let s = String(name).replace(/\.(?:d64|d71|d81|g64|nbz|prg|crt|sid|tap|t64|wav|dmp|zip|reu)$/i, '')
    .replace(/\(\d{4}\)|\[[^\]]*\]|\{[^}]*\}|\([^)]*\)/g, ' ').replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (s && s === s.toLowerCase()) s = s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  return s;
}

function headerTitle(name) {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim();
  return s && !GENERIC.test(s) ? s : '';
}

/**
 * The name for an entry, best source first: the Assembly64 release, a title
 * stored in the file (SID, cartridge), the file name, then the disk header,
 * which cracked disks often fill with a group's name.
 */
export function describe(entry) {
  const title = entry.release?.title || entry.embeddedTitle || titleFromFileName(entry.fileName) || headerTitle(entry.headerName) || 'Untitled';
  const kind = KIND[entry.kind] || 'disk';
  return { title: title.slice(0, 48), kind, a64: entry.release?.a64 ?? null };
}

/** Everything loaded, in slot order: [{ slot, label, title, kind, a64 }]. */
export function loadedItems() {
  return SLOTS.filter((s) => slots.has(s)).map((s) => ({ slot: s, label: SLOT_LABEL[s], ...describe(slots.get(s)) }));
}

/** Test seam. */
export function _resetLoaded() { slots.clear(); }
