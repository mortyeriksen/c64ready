// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// server/admin-passkeys.mjs — the admin console's passkeys, kept in the
// database apart from the players' accounts. The console's gate
// (server/admin.mjs) signs in with them.

/** @param {{ db: import('node:sqlite').DatabaseSync, now?: () => number }} o */
export function createAdminPasskeys({ db, now = Date.now }) {
  const q = {
    count: db.prepare('SELECT COUNT(*) AS n FROM admin_passkeys'),
    list: db.prepare('SELECT id, label, transports, created_at, last_used_at FROM admin_passkeys ORDER BY created_at'),
    get: db.prepare('SELECT id, public_key, sign_count FROM admin_passkeys WHERE id = ?'),
    add: db.prepare('INSERT INTO admin_passkeys (id, public_key, sign_count, transports, label, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    use: db.prepare('UPDATE admin_passkeys SET sign_count = ?, last_used_at = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM admin_passkeys WHERE id = ?'),
    keyUsed: db.prepare('SELECT 1 AS used FROM admin_used_keys WHERE hash = ?'),
    useKey: db.prepare('INSERT OR IGNORE INTO admin_used_keys (hash, used_at) VALUES (?, ?)'),
  };
  return {
    count: () => q.count.get().n,
    list: () => q.list.all().map((p) => ({ id: p.id, label: p.label, transports: JSON.parse(p.transports || '[]'), created: p.created_at, lastUsed: p.last_used_at })),
    /** { id, jwk, signCount } or null */
    get(id) { const p = typeof id === 'string' ? q.get.get(id) : undefined; return p ? { id: p.id, jwk: JSON.parse(p.public_key), signCount: p.sign_count } : null; },
    add({ id, jwk, signCount, transports }, label) { q.add.run(id, JSON.stringify(jwk), signCount, JSON.stringify(transports || []), String(label || '').slice(0, 40) || null, now()); },
    use(id, signCount) { q.use.run(signCount, now(), id); },
    remove(id) { return q.remove.run(id).changes > 0; },
    /** A setup key, by its hash, works once: these remember which were used. */
    keyUsed: (hash) => !!q.keyUsed.get(hash),
    useKey: (hash) => { q.useKey.run(hash, now()); },
  };
}
