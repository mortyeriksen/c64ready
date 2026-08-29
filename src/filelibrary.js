// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/filelibrary.js – Browser-local "media library".
//
// Whenever the user loads a .prg / .d64 / .crt / .tap from disk (file picker
// or drag-drop), the raw bytes are cached so they can be re-loaded later from
// the Controls ▸ 📂 LOAD dialog without re-picking the file.
//
// Storage is IndexedDB. The previous implementation used localStorage, which
// holds strings only — every payload had to be base64-encoded (≈+33%) and then
// stored as UTF-16 (×2 bytes/char), all inside a ~5 MB origin quota shared with
// the ROM cache and preferences. That capped the library at a few small files.
// IndexedDB stores binary directly (no base64, no UTF-16 tax) under a far larger
// quota, so the library can now hold many full .d64/.crt/.tap images.
//
// Layout — two object stores keyed by `id`:
//   META_STORE   { id, type, name, size, savedAt }   small; listed in bulk
//   BLOB_STORE   <id> → ArrayBuffer                   the raw file bytes
// Splitting metadata from the (large) blobs keeps listing the directory cheap —
// libList() reads only META_STORE and never touches the payloads.
//
// The public API (libList/libLoad/libSave/libDelete/libClear) is asynchronous
// (IndexedDB is): every function returns a Promise.

const DB_NAME    = 'c64emu';
const DB_VERSION = 1;
const META_STORE = 'lib-meta';
const BLOB_STORE = 'lib-blobs';

const VALID_TYPES = new Set(['prg', 'd64', 'crt', 'tap']);

// Tag stamped into export files so libImport can reject unrelated JSON.
const EXPORT_FORMAT  = 'c64emu-library';
const EXPORT_VERSION = 1;

// Storage budget. IndexedDB quota is large (typically a sizeable fraction of
// free disk), so this is a self-imposed cap to keep the library tidy rather than
// a hard limit we expect to bump into. Real bytes — no base64/UTF-16 multiplier.
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;   // 512 MB across all blobs
const MAX_ENTRIES     = 500;                 // hard cap on cached file count

// ── Old localStorage layout (read once, for migration) ──────────────────────
const OLD_INDEX_KEY   = 'c64emu.lib.index';
const OLD_BLOB_PREFIX = 'c64emu.lib.blob.';
const MIGRATED_KEY    = 'c64emu.lib.migrated';

function _b64decode(b64) {
  const str = atob(b64);
  const u8 = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) u8[i] = str.charCodeAt(i);
  return u8;
}

// Base64-encode bytes for the (text) JSON export, chunked so a large blob
// doesn't blow the String.fromCharCode argument-count / call-stack limit.
function _b64encode(u8) {
  let str = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    str += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(str);
}

// A tight ArrayBuffer holding exactly the view's bytes (avoids retaining a large
// backing buffer when `u8` is a subarray view).
function _toArrayBuffer(u8) {
  if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) return u8.buffer;
  return u8.slice().buffer;
}

// ── IndexedDB plumbing ──────────────────────────────────────────────────────

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

/** Open (once) the library DB, running the localStorage→IDB migration the first
 *  time. Subsequent calls return the same promise. */
function _db() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = (async () => {
    const db = await _rawOpen();
    try { await _migrateFromLocalStorage(db); } catch {}
    return db;
  })();
  return _dbPromise;
}

/** Run `fn(tx)` inside a transaction and resolve when it commits. `fn` must
 *  issue its requests synchronously (no awaiting between them, or the tx may
 *  auto-commit early); collect results via each request's onsuccess. */
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

/** All metadata records (no payloads). */
async function _allMeta(db) {
  let metas = [];
  await _run(db, [META_STORE], 'readonly', tx => {
    const r = tx.objectStore(META_STORE).getAll();
    r.onsuccess = () => { metas = r.result || []; };
  });
  return metas;
}

// Real byte cost of all blobs described by `arr`.
const _totalBytes = arr => arr.reduce((s, e) => s + (e.size || 0), 0);

// ── One-time migration from the old localStorage library ────────────────────

async function _migrateFromLocalStorage(db) {
  let done;
  try { done = localStorage.getItem(MIGRATED_KEY); } catch { return; }   // no localStorage → nothing to migrate
  if (done) return;

  let oldIndex = [];
  try {
    const raw = localStorage.getItem(OLD_INDEX_KEY);
    if (raw) oldIndex = JSON.parse(raw);
  } catch { oldIndex = []; }
  if (!Array.isArray(oldIndex)) oldIndex = [];

  for (const e of oldIndex) {
    if (!e || !e.id || !VALID_TYPES.has(e.type)) continue;
    let b64;
    try { b64 = localStorage.getItem(OLD_BLOB_PREFIX + e.id); } catch { b64 = null; }
    if (!b64) continue;
    let data;
    try { data = _b64decode(b64); } catch { continue; }
    if (!data.length) continue;
    const meta = {
      id: e.id, type: e.type, name: e.name || `${e.type}-file`,
      size: e.size || data.length, savedAt: e.savedAt || Date.now(),
    };
    try {
      const buf = _toArrayBuffer(data);
      await _run(db, [META_STORE, BLOB_STORE], 'readwrite', tx => {
        tx.objectStore(META_STORE).put(meta);
        tx.objectStore(BLOB_STORE).put(buf, e.id);
      });
    } catch { /* skip this entry, keep going */ }
  }

  // Free the old localStorage keys (the whole point — it was full) and mark
  // migration complete so this never runs again.
  try {
    for (const e of oldIndex) { if (e && e.id) localStorage.removeItem(OLD_BLOB_PREFIX + e.id); }
    localStorage.removeItem(OLD_INDEX_KEY);
    localStorage.setItem(MIGRATED_KEY, '1');
  } catch {}
}

// ── Public API ──────────────────────────────────────────────────────────────

/** All cached entries, newest first. Metadata only — no payload bytes. */
export async function libList() {
  let db;
  try { db = await _db(); } catch { return []; }
  let metas;
  try { metas = await _allMeta(db); } catch { return []; }
  return metas
    .filter(e => e && e.id && VALID_TYPES.has(e.type))
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

/** Resolve a single entry to its bytes. Returns
 *  { id, type, name, size, savedAt, data: Uint8Array } or null if the entry
 *  (or its blob) is missing / corrupt. A dangling index row is pruned. */
export async function libLoad(id) {
  let db;
  try { db = await _db(); } catch { return null; }
  let meta = null, buf = null;
  try {
    await _run(db, [META_STORE, BLOB_STORE], 'readonly', tx => {
      const mr = tx.objectStore(META_STORE).get(id);
      mr.onsuccess = () => { meta = mr.result || null; };
      const br = tx.objectStore(BLOB_STORE).get(id);
      br.onsuccess = () => { buf = br.result || null; };
    });
  } catch { return null; }
  if (!meta) return null;
  let data = null;
  if (buf) data = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (!data || !data.length) { await libDelete(id); return null; }
  return { ...meta, data };
}

/** Remove one entry (metadata + blob). */
export async function libDelete(id) {
  let db;
  try { db = await _db(); } catch { return; }
  try {
    await _run(db, [META_STORE, BLOB_STORE], 'readwrite', tx => {
      tx.objectStore(META_STORE).delete(id);
      tx.objectStore(BLOB_STORE).delete(id);
    });
  } catch {}
}

/** Wipe the whole library. */
export async function libClear() {
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
 * Cache a freshly loaded file. Entries are de-duplicated by (type, name):
 * re-loading the same file overwrites its slot and bumps it to "most recent".
 * Best-effort — quota failures evict the oldest entries and retry, and a hard
 * failure returns false rather than throwing.
 *
 * @returns {Promise<boolean>} true if the file is now stored.
 */
export async function libSave(type, name, data) {
  type = String(type || '').toLowerCase();
  if (!VALID_TYPES.has(type) || !data || !data.length) return false;
  name = (name && String(name)) || `${type}-file`;

  // A single file too big to fit the whole budget must NOT be cached — storing
  // it would force eviction of the entire existing library to make room.
  if (data.length > MAX_TOTAL_BYTES) return false;

  let db;
  try { db = await _db(); } catch { return false; }

  let metas;
  try { metas = await _allMeta(db); } catch { metas = []; }

  const existing = metas.find(e => e.type === type && e.name === name);
  const id = existing ? existing.id : `f${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const meta = { id, type, name, size: data.length, savedAt: Date.now() };

  // Build the prospective index newest-first (oldest at the tail).
  let idx = metas.filter(e => e.id !== id);
  idx.unshift(meta);

  // Proactively evict oldest (other than the entry being saved) to stay under
  // both the count cap and the size budget — gently, before the quota is hit.
  const victims = [];
  while (idx.length > 1 && (idx.length > MAX_ENTRIES || _totalBytes(idx) > MAX_TOTAL_BYTES)) {
    const victim = idx[idx.length - 1];
    if (victim.id === id) break;
    idx.pop();
    victims.push(victim.id);
  }

  const buf = _toArrayBuffer(data);

  // Write blob + metadata atomically. On a quota error the transaction aborts
  // wholesale; drop the oldest remaining entry and retry.
  for (let attempt = 0; attempt < 64; attempt++) {
    try {
      await _run(db, [META_STORE, BLOB_STORE], 'readwrite', tx => {
        const m = tx.objectStore(META_STORE), b = tx.objectStore(BLOB_STORE);
        for (const vid of victims) { m.delete(vid); b.delete(vid); }
        m.put(meta);
        b.put(buf, id);
      });
      return true;
    } catch {
      if (idx.length <= 1) return false;
      const victim = idx[idx.length - 1];
      if (victim.id === id) return false;
      idx.pop();
      victims.push(victim.id);
    }
  }
  return false;
}

/**
 * Serialize the whole library to a plain, JSON-able object:
 *   { format, version, exportedAt, entries: [{ type, name, size, savedAt, data }] }
 * where `data` is the base64 of the raw file bytes. Heavier than libList() — it
 * reads every blob. Returns an object with an empty `entries` array on failure.
 */
export async function libExport() {
  const out = { format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: Date.now(), entries: [] };
  let metas;
  try { metas = await libList(); } catch { return out; }
  for (const m of metas) {
    let e;
    try { e = await libLoad(m.id); } catch { e = null; }
    if (!e || !e.data || !e.data.length) continue;
    out.entries.push({ type: e.type, name: e.name, size: e.size, savedAt: e.savedAt, data: _b64encode(e.data) });
  }
  return out;
}

/**
 * Import entries from a libExport() object (or its JSON string). Entries whose
 * (type, name) already exist in the library are SKIPPED — never overwritten —
 * so re-importing the same export is a no-op. Imported files get a fresh
 * savedAt (they sort as most-recent).
 *
 * @param {(p:{done,total,imported,skipped,invalid})=>void} [onProgress] called
 *   after each entry so the caller can show live progress.
 * @returns {Promise<{imported,skipped,invalid,total,error?}>}
 *   error: 'parse' (bad JSON) | 'format' (not a c64emu library export).
 */
export async function libImport(input, onProgress) {
  let obj = input;
  if (typeof input === 'string') {
    try { obj = JSON.parse(input); }
    catch { return { imported: 0, skipped: 0, invalid: 0, total: 0, error: 'parse' }; }
  }
  if (!obj || obj.format !== EXPORT_FORMAT || !Array.isArray(obj.entries)) {
    return { imported: 0, skipped: 0, invalid: 0, total: 0, error: 'format' };
  }

  let metas;
  try { metas = await libList(); } catch { metas = []; }
  // Present-set keyed exactly like libSave's dedup: (type, name).
  const present = new Set(metas.map(e => `${e.type} ${e.name}`));

  const total = obj.entries.length;
  let imported = 0, skipped = 0, invalid = 0;
  const report = done => {
    if (typeof onProgress === 'function') {
      try { onProgress({ done, total, imported, skipped, invalid }); } catch {}
    }
  };
  for (let i = 0; i < total; i++) {
    const e = obj.entries[i];
    const type = String((e && e.type) || '').toLowerCase();
    const name = e && e.name ? String(e.name) : '';
    if (!VALID_TYPES.has(type) || !name || typeof e.data !== 'string') { invalid++; report(i + 1); continue; }
    const key = `${type} ${name}`;
    if (present.has(key)) { skipped++; report(i + 1); continue; }     // already present → don't import
    let data;
    try { data = _b64decode(e.data); } catch { invalid++; report(i + 1); continue; }
    if (!data.length) { invalid++; report(i + 1); continue; }
    const ok = await libSave(type, name, data);
    if (ok) { imported++; present.add(key); } else { invalid++; }
    report(i + 1);
  }
  return { imported, skipped, invalid, total };
}
