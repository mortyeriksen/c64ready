// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/statelibrary.js – Browser-local "save-state" slots (IndexedDB).
//
// Stores full machine save-states (see machine.serializeState) as named slots,
// each with a timestamp + a small PNG thumbnail for the picker. This is a
// SEPARATE IndexedDB database from the media library (filelibrary.js) so save-
// states never show up in the media picker and the two evolve independently.
//
// Layout — two object stores keyed by `id`:
//   META  { id, name, savedAt, size, thumbnail }   small; listed in bulk
//   BLOB  <id> → the raw state object               (structured clone keeps
//                                                     the typed arrays native)
// Splitting metadata from the (large) state keeps listing the picker cheap.
//
// Export / Import round-trip a slot to a .c64state JSON file (mirroring the
// media library's libExport/libImport). IndexedDB stores the typed arrays
// natively, but a JSON file can't — so export base64-packs every typed array
// and import unpacks it back.

const DB_NAME    = 'c64emu-states';
const DB_VERSION = 1;
const META_STORE = 'state-meta';
const BLOB_STORE = 'state-blobs';

// Tag stamped into export files so import can reject unrelated JSON.
const EXPORT_FORMAT  = 'c64emu-state';    // one slot   → .c64state
const BUNDLE_FORMAT  = 'c64emu-states';   // all slots  → .c64states
const EXPORT_VERSION = 1;

const MAX_ENTRIES = 100;   // keep the slot list tidy; oldest evicted past this

// ── base64 helpers (chunked, for the JSON file export) ───────────────────────
function _b64encode(u8) {
  let str = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    str += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(str);
}
function _b64decode(b64) {
  const str = atob(b64);
  const u8 = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) u8[i] = str.charCodeAt(i);
  return u8;
}

// ── typed-array pack / unpack (only used for file export/import) ──────────────
const _TA = {
  Int8Array, Uint8Array, Uint8ClampedArray,
  Int16Array, Uint16Array, Int32Array, Uint32Array,
  Float32Array, Float64Array,
};

// Recursively convert typed arrays in a state object to { __ta, b64 } tags so
// the whole thing JSON-stringifies. Plain values pass through unchanged.
function _pack(v) {
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
    const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return { __ta: v.constructor.name, b64: _b64encode(bytes) };
  }
  if (Array.isArray(v)) return v.map(_pack);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k in v) o[k] = _pack(v[k]);
    return o;
  }
  return v;
}

// Inverse of _pack: { __ta, b64 } tags become the original typed arrays.
function _unpack(v) {
  if (v && typeof v === 'object' && typeof v.__ta === 'string' && typeof v.b64 === 'string') {
    const Ctor = _TA[v.__ta] || Uint8Array;
    const bytes = _b64decode(v.b64);
    if (Ctor === Uint8Array) return bytes;
    return new Ctor(bytes.buffer, 0, (bytes.byteLength / Ctor.BYTES_PER_ELEMENT) | 0);
  }
  if (Array.isArray(v)) return v.map(_unpack);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k in v) o[k] = _unpack(v[k]);
    return o;
  }
  return v;
}

// Rough byte cost of a state object — sum of all typed-array byteLengths
// (RAM + framebuffer + media dominate). Used only for the picker's size label.
function _approxBytes(v, seen = 0) {
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return seen + v.byteLength;
  if (Array.isArray(v)) { for (const x of v) seen = _approxBytes(x, seen); return seen; }
  if (v && typeof v === 'object') { for (const k in v) seen = _approxBytes(v[k], seen); return seen; }
  return seen;
}

// ── IndexedDB plumbing (mirrors filelibrary.js) ──────────────────────────────
let _dbPromise = null;

function _rawOpen() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function _db() {
  if (!_dbPromise) _dbPromise = _rawOpen();
  return _dbPromise;
}

// Run `fn(tx)` inside a transaction; resolve on commit. `fn` must issue its
// requests synchronously (no awaiting between them).
function _run(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(stores, mode); }
    catch (e) { reject(e); return; }
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
    tx.onabort    = () => reject(tx.error || new DOMException('aborted', 'AbortError'));
    try { fn(tx); }
    catch (e) { try { tx.abort(); } catch {} reject(e); }
  });
}

async function _allMeta(db) {
  let metas = [];
  await _run(db, [META_STORE], 'readonly', tx => {
    const r = tx.objectStore(META_STORE).getAll();
    r.onsuccess = () => { metas = r.result || []; };
  });
  return metas;
}

function _newId() {
  // Date.now()/Math.random() are fine here (browser runtime, not a workflow).
  return `s${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

// ── Public API ───────────────────────────────────────────────────────────────

/** All save-state slots, newest first. Metadata only (no state payload). */
export async function stateList() {
  let db;
  try { db = await _db(); } catch { return []; }
  let metas;
  try { metas = await _allMeta(db); } catch { return []; }
  return metas.filter(e => e && e.id).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

/**
 * Save a new slot. Each Save makes a fresh slot (no overwrite-by-name) so the
 * user keeps a history. Returns the new id, or null on failure. Best-effort:
 * evicts the oldest slots past MAX_ENTRIES and retries on a quota abort.
 */
export async function stateSave(name, stateObj, thumbnail = null, savedAt = Date.now()) {
  if (!stateObj) return null;
  name = (name && String(name).trim()) || 'Save state';
  let db;
  try { db = await _db(); } catch { return null; }

  const id = _newId();
  const when = Number.isFinite(savedAt) ? savedAt : Date.now();   // import keeps the original save time
  const meta = { id, name, savedAt: when, size: _approxBytes(stateObj), thumbnail: thumbnail || null };

  let metas;
  try { metas = await _allMeta(db); } catch { metas = []; }
  // Oldest-first list of victims to trim down to MAX_ENTRIES - 1 (room for new).
  const victims = metas
    .sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0))
    .slice(0, Math.max(0, metas.length - (MAX_ENTRIES - 1)))
    .map(e => e.id);

  for (let attempt = 0; attempt < 32; attempt++) {
    try {
      await _run(db, [META_STORE, BLOB_STORE], 'readwrite', tx => {
        const m = tx.objectStore(META_STORE), b = tx.objectStore(BLOB_STORE);
        for (const vid of victims) { m.delete(vid); b.delete(vid); }
        m.put(meta);
        b.put(stateObj, id);
      });
      return id;
    } catch {
      // Quota abort → drop the oldest remaining slot and retry.
      let left;
      try { left = await _allMeta(db); } catch { return null; }
      left.sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0));
      const next = left.find(e => e.id !== id && !victims.includes(e.id));
      if (!next) return null;
      victims.push(next.id);
    }
  }
  return null;
}

/** Resolve a slot to { id, name, savedAt, thumbnail, state } or null. */
export async function stateLoad(id) {
  let db;
  try { db = await _db(); } catch { return null; }
  let meta = null, state = null;
  try {
    await _run(db, [META_STORE, BLOB_STORE], 'readonly', tx => {
      const mr = tx.objectStore(META_STORE).get(id);
      mr.onsuccess = () => { meta = mr.result || null; };
      const br = tx.objectStore(BLOB_STORE).get(id);
      br.onsuccess = () => { state = br.result || null; };
    });
  } catch { return null; }
  if (!meta || !state) { if (meta) await stateDelete(id); return null; }
  return { ...meta, state };
}

/** Remove one slot (metadata + state blob). */
export async function stateDelete(id) {
  let db;
  try { db = await _db(); } catch { return; }
  try {
    await _run(db, [META_STORE, BLOB_STORE], 'readwrite', tx => {
      tx.objectStore(META_STORE).delete(id);
      tx.objectStore(BLOB_STORE).delete(id);
    });
  } catch {}
}

/**
 * Rename one slot in place (metadata only — the state blob carries no name).
 * `newName` is trimmed; a blank name is refused. Returns true on success, or
 * false if the name is blank, the slot is gone, or storage is unavailable.
 */
export async function stateRename(id, newName) {
  const name = newName && String(newName).trim();
  if (!name) return false;
  let db;
  try { db = await _db(); } catch { return false; }
  let ok = false;
  try {
    await _run(db, [META_STORE], 'readwrite', tx => {
      const store = tx.objectStore(META_STORE);
      const r = store.get(id);
      r.onsuccess = () => {
        const meta = r.result;
        if (!meta) return;          // slot deleted meanwhile → nothing to rename
        meta.name = name;
        store.put(meta);            // same transaction: read then write is atomic
        ok = true;
      };
    });
  } catch { return false; }
  return ok;
}

/** Wipe every save-state slot. */
export async function stateClear() {
  let db;
  try { db = await _db(); } catch { return; }
  try {
    await _run(db, [META_STORE, BLOB_STORE], 'readwrite', tx => {
      tx.objectStore(META_STORE).clear();
      tx.objectStore(BLOB_STORE).clear();
    });
  } catch {}
}

/**
 * Export one slot to a JSON-able object (for download as a .c64state file):
 *   { format, version, exportedAt, name, savedAt, thumbnail, state }
 * where every typed array inside `state` is base64-packed. Returns null if the
 * slot is missing.
 */
export async function stateExport(id) {
  const entry = await stateLoad(id);
  if (!entry) return null;
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: Date.now(),
    name: entry.name,
    savedAt: entry.savedAt,
    thumbnail: entry.thumbnail || null,
    state: _pack(entry.state),
  };
}

/**
 * Export EVERY slot to one JSON-able bundle (for download as a .c64states file):
 *   { format, version, exportedAt, count, states: [ <stateExport object>, … ] }
 * Newest-first; each element is identical to a single-slot stateExport(), so a
 * bundle is just a list of self-describing single exports.
 */
export async function stateExportAll() {
  const metas = await stateList();
  const states = [];
  for (const m of metas) {
    const e = await stateExport(m.id);
    if (e) states.push(e);
  }
  return { format: BUNDLE_FORMAT, version: EXPORT_VERSION, exportedAt: Date.now(), count: states.length, states };
}

// Import one already-parsed single-slot export object as a new slot. Returns
// { id, name } or { error: 'format' | 'store' }.
async function _importOne(obj) {
  if (!obj || obj.format !== EXPORT_FORMAT || !obj.state) return { error: 'format' };
  let state;
  try { state = _unpack(obj.state); }
  catch { return { error: 'format' }; }
  const name = (obj.name && String(obj.name)) || 'Imported state';
  const id = await stateSave(name, state, obj.thumbnail || null, obj.savedAt);
  if (!id) return { error: 'store' };
  return { id, name };
}

/**
 * Import a single stateExport() object (or its JSON string) as a new slot.
 * Returns { id, name } on success, or { error } ('parse' | 'format' | 'store').
 */
export async function stateImport(input) {
  let obj = input;
  if (typeof input === 'string') {
    try { obj = JSON.parse(input); }
    catch { return { error: 'parse' }; }
  }
  return _importOne(obj);
}

/**
 * Import a save-state file that is EITHER a single-slot export (.c64state,
 * format 'c64emu-state') OR a bundle of all slots (.c64states, format
 * 'c64emu-states') — each contained state becomes a new slot. `onProgress`
 * (optional) fires with { done, total, imported, invalid } during a bundle.
 * Returns { bundle, imported, invalid, total, names } on success, or
 * { error } ('parse' | 'format' | 'store').
 */
export async function stateImportFile(input, onProgress = null) {
  let obj = input;
  if (typeof input === 'string') {
    try { obj = JSON.parse(input); }
    catch { return { error: 'parse' }; }
  }
  if (!obj || typeof obj !== 'object') return { error: 'format' };

  // Bundle of many slots.
  if (obj.format === BUNDLE_FORMAT && Array.isArray(obj.states)) {
    const total = obj.states.length;
    let imported = 0, invalid = 0; const names = [];
    for (let i = 0; i < total; i++) {
      const r = await _importOne(obj.states[i]);
      if (r.id) { imported++; if (names.length < 6) names.push(r.name); } else invalid++;
      if (onProgress) onProgress({ done: i + 1, total, imported, invalid });
    }
    return { bundle: true, imported, invalid, total, names };
  }

  // Single slot (the existing .c64state).
  if (obj.format === EXPORT_FORMAT && obj.state) {
    const r = await _importOne(obj);
    if (r.error) return { error: r.error };
    return { bundle: false, imported: 1, invalid: 0, total: 1, names: [r.name] };
  }

  return { error: 'format' };
}
