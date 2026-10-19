// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// server/log.mjs — the chat log: one JSON line per event (a message, a join, a
// kick, an admin action), with the time, the nickname, the session and the IP
// address, in one file per UTC day (chat-YYYY-MM-DD.jsonl). Files older than
// the retention period are deleted. The log exists so abuse and crime can be
// investigated; only the admin can download it.

import fs from 'node:fs';
import path from 'node:path';

const FILE_RE = /^chat-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY = 24 * 3600_000;

const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

/** True for a name the log itself writes, so a download can never reach another file. */
export const isLogFile = (name) => FILE_RE.test(name);

/**
 * @param {object} o
 * @param {string} o.dir      where the files go (created if missing)
 * @param {number} [o.days]   how long a file is kept
 * @param {() => number} [o.now]
 */
export function createChatLog({ dir, days = 90, now = Date.now, onError = () => {} }) {
  fs.mkdirSync(dir, { recursive: true });
  let day = '';
  let stream = null;

  function open(d) {
    stream?.end();
    day = d;
    stream = fs.createWriteStream(path.join(dir, `chat-${d}.jsonl`), { flags: 'a', mode: 0o600 });
    stream.on('error', (e) => onError(e));
  }

  /** Delete the files older than the retention period. */
  function sweep() {
    const oldest = dayOf(now() - days * DAY);
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { onError(e); return; }
    for (const name of names) {
      const m = FILE_RE.exec(name);
      if (m && m[1] < oldest) { try { fs.unlinkSync(path.join(dir, name)); } catch (e) { onError(e); } }
    }
  }
  sweep();

  return {
    dir,
    days,
    write(event) {
      const t = now();
      const d = dayOf(t);
      if (d !== day) { open(d); sweep(); }
      stream.write(`${JSON.stringify({ at: new Date(t).toISOString(), ...event })}\n`);
    },
    /** The log files, newest first: [{ name, size }]. */
    files() {
      let names = [];
      try { names = fs.readdirSync(dir).filter(isLogFile); } catch { return []; }
      return names.sort().reverse().map((name) => ({ name, size: fs.statSync(path.join(dir, name)).size }));
    },
    sweep,
    /** Resolves once everything written so far is on disk. */
    flush() { return new Promise((r) => { if (!stream) r(); else stream.write('', r); }); },
    close() { return new Promise((r) => { if (!stream) r(); else stream.end(r); stream = null; day = ''; }); },
  };
}
