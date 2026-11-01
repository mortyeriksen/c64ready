// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// server/bans.mjs — banned addresses, shared by the chat and the accounts: a
// banned address cannot chat, sign in, sign up, recover or post results. Kept
// by the address's key (server/address.mjs addressKey: an IPv4 address, or an
// IPv6 /64), until a time. With a database they survive restarts; without one
// they are kept in memory.

/** @param {{ db?: import('node:sqlite').DatabaseSync, now?: () => number }} o */
export function createBans({ db = null, now = Date.now } = {}) {
  if (!db) {
    const map = new Map();
    const live = (b) => (b && b.until > now() ? b : null);
    return {
      add({ key, ip = null, hours, reason = '' }) { map.set(key, { key, ip, until: now() + hours * 3600_000, reason, at: now() }); },
      remove: (key) => map.delete(key),
      get: (key) => live(map.get(key)),
      list: () => [...map.values()].filter((b) => b.until > now()),
      sweep() { let n = 0; for (const [k, b] of map) if (b.until <= now()) { map.delete(k); n++; } return n; },
    };
  }
  const q = {
    add: db.prepare('INSERT INTO bans (key, ip, until, reason, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET ip = excluded.ip, until = excluded.until, reason = excluded.reason, at = excluded.at'),
    remove: db.prepare('DELETE FROM bans WHERE key = ?'),
    get: db.prepare('SELECT key, ip, until, reason, at FROM bans WHERE key = ? AND until > ?'),
    list: db.prepare('SELECT key, ip, until, reason, at FROM bans WHERE until > ? ORDER BY at DESC'),
    sweep: db.prepare('DELETE FROM bans WHERE until <= ?'),
  };
  return {
    /** Bans an address key for `hours`, with the address as seen (for the console) and a reason. */
    add({ key, ip = null, hours, reason = '' }) { q.add.run(key, ip, now() + hours * 3600_000, reason, now()); },
    remove: (key) => q.remove.run(key).changes > 0,
    /** The ban on an address key, while it lasts; else null. */
    get: (key) => q.get.get(key, now()) ?? null,
    list: () => q.list.all(now()),
    /** Forgets bans that ran out; how many. */
    sweep: () => Number(q.sweep.run(now()).changes),
  };
}
