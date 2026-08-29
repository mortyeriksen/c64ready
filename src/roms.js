// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/roms.js – ROM loading UI helpers
// Handles four ROM file inputs: KERNAL (8KB), BASIC (8KB), CHAR (4KB),
// 1541 (16KB, optionally with 2-byte header → 16386B).
//
// Loading priority for each ROM, in order:
//   1. localStorage cache — wins if present, so a user's chosen ROMs
//      survive page reloads and aren't blindly overridden by whatever
//      happens to sit in /roms/ on the server.
//   2. Server fetch from /roms/<name>.bin — fallback when cache misses.
//   3. User upload via <input type="file"> — when both are missing.
//
// User uploads are written through to the cache so subsequent page loads
// can skip the upload step. Each ROM type has exactly one localStorage
// slot, overwritten on each new upload, so the cache never grows.

const ROM_SPEC = {
  kernal:    { key: 'c64emu.rom.kernal',    sizes: [8192] },
  basic:     { key: 'c64emu.rom.basic',     sizes: [8192] },
  charRom:   { key: 'c64emu.rom.charRom',   sizes: [4096] },
  drive1541: { key: 'c64emu.rom.drive1541', sizes: [16384, 16386] },
};

function _b64encode(u8) {
  // Chunked btoa to avoid blowing the call-stack on the 16 KiB 1541 ROM.
  let s = '';
  const CHUNK = 0x4000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CHUNK, u8.length)));
  }
  return btoa(s);
}

function _b64decode(b64) {
  const str = atob(b64);
  const u8 = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) u8[i] = str.charCodeAt(i);
  return u8;
}

// ── Picking C64 ROMs out of a VICE installation ──────────────────────────────
// A VICE tree carries ROMs for every machine it emulates, and several collide
// with the C64's on both name and size (VIC20's basic-901486-01.bin is 8 KiB
// too). So candidates are scored: the exact filename VICE ships for the PAL C64
// wins outright, sitting in the machine's own subdirectory helps, and another
// machine's subdirectory counts against hard enough to disqualify a file that
// has nothing else going for it.
const VICE_ROM_MATCH = {
  kernal:    { dir: 'c64',    exact: 'kernal-901227-03',    name: /^kernal([-._]|$)/i },
  basic:     { dir: 'c64',    exact: 'basic-901226-01',     name: /^basic([-._]|$)/i },
  charRom:   { dir: 'c64',    exact: 'chargen-901225-01',   name: /^(chargen|characters)([-._]|$)/i },
  drive1541: { dir: 'drives', exact: 'dos1541ii-251968-03', name: /^(dos)?1541(-?ii)?([-._]|$)/i },
};

const OTHER_MACHINE_DIRS = new Set(
  ['c128', 'c64dtv', 'cbm-ii', 'pet', 'plus4', 'printer', 'scpu64', 'vic20']);

// The folder a picked file sits in: webkitRelativePath is "<root>/…/<dir>/<name>".
function _parentDir(file) {
  const parts = (file.webkitRelativePath || '').split('/');
  return parts.length > 1 ? parts[parts.length - 2].toLowerCase() : '';
}

/** Choose one file per ROM slot out of a picked directory listing (the FileList
 *  of an <input webkitdirectory>). Returns { [slot]: File } for what was found;
 *  a slot with no convincing candidate is simply absent. */
export function pickViceRoms(files) {
  const picked = {};
  for (const [key, m] of Object.entries(VICE_ROM_MATCH)) {
    let best = null, bestScore = 0;
    for (const file of files) {
      const name = (file.name || '').toLowerCase();
      if (!ROM_SPEC[key].sizes.includes(file.size)) continue;
      if (!m.name.test(name)) continue;
      const dir = _parentDir(file);
      let score = 1;
      if (name === m.exact || name === `${m.exact}.bin`) score += 4;
      if (dir === m.dir) score += 2;
      else if (OTHER_MACHINE_DIRS.has(dir)) score -= 3;
      if (score > bestScore) { bestScore = score; best = file; }
    }
    if (best) picked[key] = best;
  }
  return picked;
}

export class ROMLoader {
  constructor() {
    this.kernal      = null; // Uint8Array(8192)
    this.basic       = null; // Uint8Array(8192)
    this.charRom     = null; // Uint8Array(4096)
    this.drive1541   = null; // Uint8Array(16384)
    this._onReady    = null;
    // Original filename (or URL basename) per loaded ROM. Persisted in the
    // cache alongside the bytes so a reload can still show it.
    this.romNames = { kernal: null, basic: null, charRom: null, drive1541: null };
    // Optional callback — fires whenever this.romNames changes so the UI
    // can update the filename label on a ROM row.
    this.onNamesChanged = null;
    // Count of ROMs restored from localStorage cache on the last autoLoad().
    this.cachedCount = 0;
    // Optional callback (key, source) after a ROM the USER supplied is
    // installed: an upload or a picked VICE folder, never autoLoad's cache or
    // server fetch. main.js hangs the stats markers off it.
    this.onUserRom = null;
  }

  _emitNamesChanged() {
    if (this.onNamesChanged) this.onNamesChanged({ ...this.romNames });
  }

  /** Called when all three ROMs are loaded */
  onReady(fn) { this._onReady = fn; }

  /** Bind to four <input type="file"> elements (1541 is optional) */
  bindInputs(kernalEl, basicEl, charEl, drive1541El) {
    kernalEl.addEventListener('change', e => this._loadFile(e, 8192, 'kernal'));
    basicEl .addEventListener('change', e => this._loadFile(e, 8192, 'basic'));
    charEl  .addEventListener('change', e => this._loadFile(e, 4096, 'charRom'));
    if (drive1541El) {
      drive1541El.addEventListener('change', e => this._loadFile(e, 16384, 'drive1541'));
    }
  }

  /** Attempt to auto-load ROMs. localStorage cache wins first; anything
   * not in the cache is then fetched from /roms/<name>.bin on the
   * server. Returns the number of required ROMs (KERNAL + BASIC + CHAR)
   * that ended up loaded. `this.cachedCount` reports how many came from
   * the cache. */
  async autoLoad() {
    this.cachedCount = 0;

    const files = [
      { url: '/roms/kernal.bin',  size: 8192,  key: 'kernal',    required: true  },
      { url: '/roms/basic.bin',   size: 8192,  key: 'basic',     required: true  },
      { url: '/roms/chargen.bin', size: 4096,  key: 'charRom',   required: true  },
      { url: '/roms/1541.bin',    size: 16384, key: 'drive1541', required: false },
    ];

    // 1. Cache wins. Any ROM with a valid cached entry is taken from
    //    localStorage, the server fetch for that ROM is skipped.
    for (const f of files) {
      const cached = this._loadFromCache(f.key);
      if (cached) {
        this[f.key] = cached.data;
        this.romNames[f.key] = cached.name;
        this.cachedCount++;
      }
    }

    // 2. Server fetch for anything still missing.
    const serverTargets = files.filter(f => !this[f.key]);
    const results = await Promise.allSettled(
      serverTargets.map(async f => {
        const resp = await fetch(f.url);
        if (!resp.ok) {
          if (f.required) throw new Error(`${f.url}: ${resp.status}`);
          return { key: f.key, data: null, name: null };
        }
        const buf = await resp.arrayBuffer();
        const data = new Uint8Array(buf);
        if (f.key === 'drive1541' && (data.length === 16384 || data.length === 16386)) {
           // special case for drive ROMs which often have 2-byte headers
        } else if (data.length !== f.size) {
           throw new Error(`${f.key}: expected ${f.size}B, got ${data.length}B`);
        }
        // Derive the visible filename from the URL (e.g. "kernal.bin").
        const name = f.url.slice(f.url.lastIndexOf('/') + 1);
        return { key: f.key, data, name };
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.data) {
        this[r.value.key] = r.value.data;
        this.romNames[r.value.key] = r.value.name;
      }
    }

    this._emitNamesChanged();

    // Required-ROM count (drive1541 is optional and reported separately
    // via this.drive1541 / loader.allLoaded semantics).
    let loaded = 0;
    for (const key of ['kernal', 'basic', 'charRom']) {
      if (this[key]) loaded++;
    }

    if (loaded > 0) this._checkReady();
    return loaded;
  }

  /** Wipe every cached ROM from localStorage. Does NOT clear the loaded
   * ROMs on this instance — only the persistent cache, so the running
   * machine keeps working until the next reload. */
  clearCache() {
    for (const spec of Object.values(ROM_SPEC)) {
      try { localStorage.removeItem(spec.key); } catch {}
    }
  }

  /** Install a ROM from already-fetched bytes (e.g. the Fetch-ROMs dialog).
   *  Validates the size against the slot, caches it to localStorage, updates
   *  the displayed name, and fires onReady once the required trio is complete
   *  — i.e. the same path as a manual file upload. Throws on a wrong size so
   *  the caller can report which URL returned a bad payload. */
  setRomData(key, data, name, source = 'upload') {
    const spec = ROM_SPEC[key];
    if (!spec) throw new Error(`unknown ROM slot: ${key}`);
    if (!spec.sizes.includes(data.length)) {
      throw new Error(`expected ${spec.sizes.join(' or ')} bytes, got ${data.length}`);
    }
    this[key] = data;
    this._saveToCache(key, data, name);
    this._setName(key, name);   // also emits namesChanged
    this._checkReady();
    if (this.onUserRom) this.onUserRom(key, source);
  }

  /** Set the displayed filename for a ROM (no localStorage side effect). */
  _setName(key, name) {
    if (!(key in this.romNames)) return;
    this.romNames[key] = name || null;
    this._emitNamesChanged();
  }

  _loadFile(e, expectedSize, key) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const data = new Uint8Array(ev.target.result);
      if (key === 'drive1541' && (data.length === 16384 || data.length === 16386)) {
        // ok
      } else if (data.length !== expectedSize) {
        alert(`${key.toUpperCase()} ROM must be exactly ${expectedSize} bytes (got ${data.length}).`);
        return;
      }
      this[key] = data;
      this._saveToCache(key, data, file.name);
      this._setName(key, file.name);
      this._checkReady();
      if (this.onUserRom) this.onUserRom(key, 'upload');
    };
    reader.readAsArrayBuffer(file);
  }

  _checkReady() {
    if (this.kernal && this.basic && this.charRom) {
      if (this._onReady) this._onReady({
        kernal: this.kernal,
        basic: this.basic,
        charRom: this.charRom,
        drive1541: this.drive1541
      });
    }
  }

  /** Write a single ROM to its fixed cache slot. Best-effort — quota /
   * unavailable-localStorage failures are silently swallowed. The
   * original filename (the host's upload File.name) is stored alongside
   * the bytes so the UI can show it after a reload. */
  _saveToCache(key, data, name) {
    const spec = ROM_SPEC[key];
    if (!spec) return;
    try {
      const payload = JSON.stringify({
        data: _b64encode(data),
        name: name || null,
      });
      localStorage.setItem(spec.key, payload);
    } catch {}
  }

  /** Read a single ROM from its fixed cache slot. Returns
   * { data: Uint8Array, name: string|null } when the entry exists and
   * has a recognised size; otherwise returns null. Corrupt entries
   * (unparseable JSON, wrong size, etc.) are removed so the next call
   * returns cleanly. */
  _loadFromCache(key) {
    const spec = ROM_SPEC[key];
    if (!spec) return null;
    let raw;
    try { raw = localStorage.getItem(spec.key); } catch { return null; }
    if (!raw) return null;
    let payload;
    try { payload = JSON.parse(raw); }
    catch {
      try { localStorage.removeItem(spec.key); } catch {}
      return null;
    }
    if (!payload || typeof payload.data !== 'string') {
      try { localStorage.removeItem(spec.key); } catch {}
      return null;
    }
    let data;
    try { data = _b64decode(payload.data); }
    catch {
      try { localStorage.removeItem(spec.key); } catch {}
      return null;
    }
    if (!spec.sizes.includes(data.length)) {
      try { localStorage.removeItem(spec.key); } catch {}
      return null;
    }
    return { data, name: payload.name || null };
  }

  get allLoaded() {
    return !!(this.kernal && this.basic && this.charRom);
  }
}

// Exported for tests so the rom-cache-spec test can verify the slot keys
// match the implementation.
export const _ROM_SPEC = ROM_SPEC;
