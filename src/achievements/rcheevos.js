// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// src/achievements/rcheevos.js — rcheevos (RetroAchievements' achievement
// library, compiled to WebAssembly in native/rcheevos) for the app: the C64
// file hash that names a game, and the runtime that evaluates a game's
// achievement and leaderboard conditions once per emulated frame.

/** rc_runtime event types (rc_runtime.h), in its order. */
export const EVENT = Object.freeze({
  ACHIEVEMENT_ACTIVATED: 0, ACHIEVEMENT_PAUSED: 1, ACHIEVEMENT_RESET: 2, ACHIEVEMENT_TRIGGERED: 3,
  ACHIEVEMENT_PRIMED: 4, LBOARD_STARTED: 5, LBOARD_CANCELED: 6, LBOARD_UPDATED: 7,
  LBOARD_TRIGGERED: 8, ACHIEVEMENT_DISABLED: 9, LBOARD_DISABLED: 10, ACHIEVEMENT_UNPRIMED: 11,
  ACHIEVEMENT_PROGRESS_UPDATED: 12,
});

// rcheevos never touches files or clocks here (it hashes buffers and reads
// memory through the glue), so its WASI imports only have to exist. Reporting
// "bad descriptor" ends the C library's search for preopened directories.
const ENOSYS = 52, EBADF = 8;
function wasiStubs() {
  const fail = () => ENOSYS;
  return {
    wasi_snapshot_preview1: {
      clock_time_get: fail, fd_close: fail, fd_fdstat_get: fail, fd_fdstat_set_flags: fail,
      fd_prestat_get: () => EBADF, fd_prestat_dir_name: () => EBADF,
      fd_read: fail, fd_seek: fail, fd_write: fail, path_open: fail,
      proc_exit: (code) => { throw new Error(`rcheevos exited (${code})`); },
    },
  };
}

function decodeBase64(b64) {
  if (typeof atob === 'function') return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/**
 * Instantiates rcheevos. `bytes` defaults to the embedded module; tools pass a
 * freshly built one.
 */
export async function loadRcheevos(bytes) {
  if (!bytes) bytes = decodeBase64((await import('./rcheevos-wasm-blob.js')).RCHEEVOS_WASM_BASE64);
  const { instance } = await WebAssembly.instantiate(bytes, wasiStubs());
  const x = instance.exports;
  x._initialize();
  // One view of module memory, made again only when the memory grows: a frame allocates none.
  let heap = new Uint8Array(x.memory.buffer);
  const mem = () => (heap.buffer === x.memory.buffer ? heap : (heap = new Uint8Array(x.memory.buffer)));
  const enc = new TextEncoder(), dec = new TextDecoder();
  const ramPtr = x.cc_ram();

  /** A NUL-terminated copy of `s` in module memory, freed by `fn`'s return. */
  function withString(s, fn) {
    const b = enc.encode(String(s));
    const p = x.cc_alloc(b.length + 1);
    const m = mem(); m.set(b, p); m[p + b.length] = 0;
    try { return fn(p); } finally { x.cc_free(p); }
  }
  function readString(p, max) {
    const m = mem();
    let end = p; while (end < p + max && m[end]) end++;
    return dec.decode(m.subarray(p, end));
  }

  const v = x.cc_version();
  const versionString = `${Math.floor(v / 1000000)}.${Math.floor(v / 1000) % 1000}.${v % 1000}`;

  return {
    version: v,
    versionString,
    /** The rcheevos hash of a C64 file (32 hex digits), or null. */
    hash(bytes) {
      const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const p = x.cc_alloc(data.length), out = x.cc_alloc(33);
      try {
        mem().set(data, p);
        return x.cc_hash(p, data.length, out) ? readString(out, 32) : null;
      } finally { x.cc_free(p); x.cc_free(out); }
    },
    /** Drops every achievement and leaderboard. */
    clear() { x.cc_clear(); },
    /** Every achievement back to waiting, as after a machine reset. */
    reset() { x.cc_reset(); },
    /** 0 when `memaddr` parsed and is active, else an rcheevos error code. */
    activateAchievement(id, memaddr) { return withString(memaddr, (p) => x.cc_activate_achievement(id >>> 0, p)); },
    deactivateAchievement(id) { x.cc_deactivate_achievement(id >>> 0); },
    activateLeaderboard(id, definition) { return withString(definition, (p) => x.cc_activate_lboard(id >>> 0, p)); },
    deactivateLeaderboard(id) { x.cc_deactivate_lboard(id >>> 0); },
    /**
     * One frame against `ram` (the C64's 64 KB). Returns the events it raised,
     * [{ type, id, value }], in order; the array is reused, so copy what you keep.
     */
    doFrame: (() => {
      const events = [];
      return (ram) => {
        mem().set(ram.length === 0x10000 ? ram : ram.subarray(0, 0x10000), ramPtr);
        const n = x.cc_do_frame();
        events.length = 0;
        for (let i = 0; i < n; i++) events.push({ type: x.cc_event_type(i), id: x.cc_event_id(i), value: x.cc_event_value(i) });
        return events;
      };
    })(),
    /**
     * A value as text in an rcheevos format (a name such as "SCORE" or "TIME").
     * Each format is parsed once and the text buffer kept, so a running score
     * shown every frame allocates only its text.
     */
    formatValue: (() => {
      const codes = new Map();
      let out = 0;
      return (value, format = 'VALUE') => {
        let code = codes.get(format);
        if (code === undefined) { code = withString(format, (p) => x.cc_parse_format(p)); codes.set(format, code); }
        if (!out) out = x.cc_alloc(64);
        x.cc_format_value(out, 64, value | 0, code);
        return readString(out, 63);
      };
    })(),
  };
}
