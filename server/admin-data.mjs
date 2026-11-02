// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// server/admin-data.mjs — the admin console's view of the players: an overview,
// every registered player, one player's details (account, passkeys, progress,
// activity, login history with addresses), the admin's actions on them, the
// results the fair-play checks flagged for review, and a copy of the whole
// database to download.
// It reads and writes the accounts and games database; the chat server serves
// it under /admin/api behind the admin's login (server/chat.mjs).

import { addressKey } from './address.mjs';

const ACTIVE_MS = 5 * 60_000;   // "active now": the app used within this long
const PLAYING_MS = 30 * 60_000;  // "playing X": an unlock or best in X within this long
const DAY = 24 * 3600_000;
const PAGE = 50;
const SORTS = { name: 'u.name_key', joined: 'u.created_at', seen: 'last_seen', points: 'points', unlocks: 'unlocks', games: 'games' };

/**
 * @param {object} o
 * @param {import('node:sqlite').DatabaseSync} o.db
 * @param {{ removePicture: (id: number) => void, logLogin?: Function }} o.accounts
 * @param {{ get: (key: string) => object|null }} [o.bans]  banned addresses, to flag
 * @param {() => number} [o.now]
 */
export function createAdminData({ db, accounts, bans = null, now = Date.now }) {
  const q = {
    // Results flagged by the fair-play checks (server/games.mjs), newest first.
    flagged: db.prepare(`SELECT * FROM (
        SELECT 'unlock' AS kind, x.user_id, u.name, x.game_id, g.title AS game, x.achievement_id AS ref, a.title AS item, a.points, NULL AS value, NULL AS format, x.flag, x.unlocked_at AS at
          FROM unlocks x JOIN users u ON u.id = x.user_id JOIN games g ON g.id = x.game_id LEFT JOIN achievements a ON a.game_id = x.game_id AND a.id = x.achievement_id WHERE x.flag IS NOT NULL
        UNION ALL
        SELECT 'score', e.user_id, u.name, e.game_id, g.title, e.leaderboard_id, l.title, NULL, e.value, l.format, e.flag, e.submitted_at
          FROM lb_entries e JOIN users u ON u.id = e.user_id JOIN games g ON g.id = e.game_id LEFT JOIN leaderboards l ON l.game_id = e.game_id AND l.id = e.leaderboard_id WHERE e.flag IS NOT NULL
      ) ORDER BY at DESC LIMIT 200`),
    flaggedCount: db.prepare('SELECT (SELECT COUNT(*) FROM unlocks WHERE flag IS NOT NULL) + (SELECT COUNT(*) FROM lb_entries WHERE flag IS NOT NULL) AS n'),
    flaggedUnlock: db.prepare('SELECT hardcore, unlocked_at AS at FROM unlocks WHERE user_id = ? AND game_id = ? AND achievement_id = ? AND flag IS NOT NULL'),
    flaggedScore: db.prepare('SELECT hardcore, value, submitted_at AS at FROM lb_entries WHERE user_id = ? AND game_id = ? AND leaderboard_id = ? AND flag IS NOT NULL'),
    passUnlock: db.prepare('UPDATE unlocks SET flag = NULL WHERE user_id = ? AND game_id = ? AND achievement_id = ?'),
    passScore: db.prepare('UPDATE lb_entries SET flag = NULL WHERE user_id = ? AND game_id = ? AND leaderboard_id = ?'),
    dropUnlock: db.prepare('DELETE FROM unlocks WHERE user_id = ? AND game_id = ? AND achievement_id = ?'),
    feed: db.prepare('INSERT INTO activity (at, user_id, game_id, kind, ref, value) VALUES (?, ?, ?, ?, ?, ?)'),
    count: db.prepare('SELECT COUNT(*) AS n FROM users'),
    newSince: db.prepare('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?'),
    activeSince: db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM sessions WHERE last_seen_at >= ?'),
    eventsSince: db.prepare('SELECT kind, COUNT(*) AS n FROM activity WHERE at >= ? GROUP BY kind'),
    active: db.prepare(`SELECT u.id, u.name, u.avatar_at, MAX(s.last_seen_at) AS seen,
        (SELECT g.title FROM activity a JOIN games g ON g.id = a.game_id WHERE a.user_id = u.id AND a.at >= ? ORDER BY a.id DESC LIMIT 1) AS game
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.last_seen_at >= ? GROUP BY u.id ORDER BY seen DESC LIMIT 100`),
    topGames: db.prepare(`SELECT g.id, g.title, COUNT(DISTINCT a.user_id) AS players, SUM(a.kind = 'unlock') AS unlocks
      FROM activity a JOIN games g ON g.id = a.game_id WHERE a.at >= ? GROUP BY g.id ORDER BY players DESC, unlocks DESC LIMIT 10`),
    latest: db.prepare('SELECT id, name, avatar_at, created_at FROM users ORDER BY created_at DESC LIMIT 10'),
    user: db.prepare('SELECT id, name, created_at, avatar_at, recovery_hash IS NOT NULL AS recovery FROM users WHERE id = ?'),
    sessions: db.prepare('SELECT COUNT(*) AS n, MAX(last_seen_at) AS seen FROM sessions WHERE user_id = ? AND expires_at > ?'),
    passkeys: db.prepare('SELECT id, created_at, last_used_at, transports FROM passkeys WHERE user_id = ? ORDER BY created_at'),
    progress: db.prepare(`SELECT g.id, g.title,
        (SELECT COUNT(*) FROM unlocks x JOIN achievements a ON a.game_id = x.game_id AND a.id = x.achievement_id WHERE x.user_id = ? AND x.game_id = g.id) AS unlocked,
        (SELECT COUNT(*) FROM achievements a WHERE a.game_id = g.id) AS total,
        (SELECT COALESCE(SUM(a.points), 0) FROM unlocks x JOIN achievements a ON a.game_id = x.game_id AND a.id = x.achievement_id WHERE x.user_id = ? AND x.game_id = g.id) AS points
      FROM games g WHERE g.id IN (SELECT game_id FROM unlocks WHERE user_id = ? UNION SELECT game_id FROM lb_entries WHERE user_id = ?) ORDER BY g.title`),
    scores: db.prepare('SELECT e.game_id, l.id, l.title, l.format, e.value, e.submitted_at FROM lb_entries e JOIN leaderboards l ON l.game_id = e.game_id AND l.id = e.leaderboard_id WHERE e.user_id = ? ORDER BY l.sort'),
    logins: db.prepare('SELECT id, at, kind, ok, ip, device FROM logins WHERE user_id = ? AND id < ? ORDER BY id DESC LIMIT ?'),
    lastIp: db.prepare('SELECT ip FROM logins WHERE user_id = ? AND ok = 1 ORDER BY id DESC LIMIT 1'),
    sameIp: db.prepare('SELECT DISTINCT u.id, u.name FROM logins l JOIN users u ON u.id = l.user_id WHERE l.ip = ? AND l.user_id != ? LIMIT 20'),
    activity: db.prepare(`SELECT a.id, a.at, a.kind, a.value, g.title AS game, ach.title AS achievement, ach.points, lb.title AS board, lb.format
      FROM activity a JOIN games g ON g.id = a.game_id
      LEFT JOIN achievements ach ON a.kind = 'unlock' AND ach.game_id = a.game_id AND ach.id = a.ref
      LEFT JOIN leaderboards lb ON a.kind = 'score' AND lb.game_id = a.game_id AND lb.id = a.ref
      WHERE a.user_id = ? AND a.id < ? ORDER BY a.id DESC LIMIT ?`),
    nameTaken: db.prepare('SELECT id FROM users WHERE name_key = ?'),
    rename: db.prepare('UPDATE users SET name = ?, name_key = ? WHERE id = ?'),
    signOut: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    dropScore: db.prepare('DELETE FROM lb_entries WHERE user_id = ? AND game_id = ? AND leaderboard_id = ?'),
    dropScoreActivity: db.prepare("DELETE FROM activity WHERE user_id = ? AND game_id = ? AND kind = 'score' AND ref = ?"),
    dropUnlocks: db.prepare('DELETE FROM unlocks WHERE user_id = ? AND game_id = ?'),
    dropEntries: db.prepare('DELETE FROM lb_entries WHERE user_id = ? AND game_id = ?'),
    dropActivity: db.prepare('DELETE FROM activity WHERE user_id = ? AND game_id = ?'),
    remove: db.prepare('DELETE FROM users WHERE id = ?'),
  };
  // The players list: each player with their numbers, sorted and searched as asked.
  const listSql = (sort, dir) => db.prepare(`SELECT u.id, u.name, u.created_at, u.avatar_at,
      (SELECT MAX(last_seen_at) FROM sessions WHERE user_id = u.id) AS last_seen,
      (SELECT COUNT(*) FROM passkeys WHERE user_id = u.id) AS passkeys,
      (SELECT COALESCE(SUM(a.points), 0) FROM unlocks x JOIN achievements a ON a.game_id = x.game_id AND a.id = x.achievement_id WHERE x.user_id = u.id) AS points,
      (SELECT COUNT(*) FROM unlocks WHERE user_id = u.id) AS unlocks,
      (SELECT COUNT(*) FROM (SELECT game_id FROM unlocks WHERE user_id = u.id UNION SELECT game_id FROM lb_entries WHERE user_id = u.id)) AS games,
      (SELECT ip FROM logins WHERE user_id = u.id AND ok = 1 ORDER BY id DESC LIMIT 1) AS last_ip
    FROM users u WHERE u.name_key LIKE ? ESCAPE '\\' ORDER BY ${SORTS[sort]} ${dir}, u.id LIMIT ? OFFSET ?`);
  const lists = new Map();
  const total = db.prepare("SELECT COUNT(*) AS n FROM users WHERE name_key LIKE ? ESCAPE '\\'");
  const like = (text) => `%${String(text || '').normalize('NFKC').toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const user = (id) => q.user.get(id) ?? (() => { throw Object.assign(new Error('no such player'), { status: 404 }); })();
  const isBanned = (ip) => !!(ip && bans?.get(addressKey(ip)));

  return {
    /** The front page: counts, who is active now, the week's top games and the latest sign-ups. */
    overview({ online = [] } = {}) {
      const t = now();
      const events = Object.fromEntries(q.eventsSince.all(t - DAY).map((r) => [r.kind, r.n]));
      const active = q.active.all(t - PLAYING_MS, t - ACTIVE_MS).map((r) => ({ id: r.id, name: r.name, avatar: r.avatar_at || 0, seen: r.seen, game: r.game, online: online.includes(r.id) }));
      return {
        players: q.count.get().n,
        newToday: q.newSince.get(t - DAY).n,
        newWeek: q.newSince.get(t - 7 * DAY).n,
        onlineNow: online.length,
        activeNow: q.activeSince.get(t - ACTIVE_MS).n,
        active24h: q.activeSince.get(t - DAY).n,
        active7d: q.activeSince.get(t - 7 * DAY).n,
        unlocksToday: events.unlock ?? 0,
        toReview: q.flaggedCount.get().n,
        bestsToday: events.score ?? 0,
        active,
        topGames: q.topGames.all(t - 7 * DAY).map((r) => ({ id: r.id, title: r.title, players: r.players, unlocks: r.unlocks })),
        latest: q.latest.all().map((r) => ({ id: r.id, name: r.name, avatar: r.avatar_at || 0, joined: r.created_at })),
      };
    },
    /** Every registered player, 50 a page: search by name, sort by any column. */
    players({ search = '', sort = 'joined', dir = 'desc', page = 0, online = [] } = {}) {
      if (!SORTS[sort]) sort = 'joined';
      dir = dir === 'asc' ? 'ASC' : 'DESC';
      const key = `${sort} ${dir}`;
      if (!lists.has(key)) lists.set(key, listSql(sort, dir));
      const pattern = like(search);
      const rows = lists.get(key).all(pattern, PAGE, Math.max(0, page | 0) * PAGE);
      return {
        total: total.get(pattern).n, page: Math.max(0, page | 0), pageSize: PAGE,
        players: rows.map((r) => ({ id: r.id, name: r.name, avatar: r.avatar_at || 0, joined: r.created_at, lastSeen: r.last_seen, passkeys: r.passkeys, points: r.points, unlocks: r.unlocks, games: r.games, lastIp: r.last_ip, banned: isBanned(r.last_ip), online: online.includes(r.id) })),
      };
    },
    /** One player: account, passkeys, progress, best scores, and the first page of logins and activity. */
    player(id) {
      const u = user(id), t = now();
      const s = q.sessions.get(id, t);
      const scores = q.scores.all(id);
      const lastIp = q.lastIp.get(id)?.ip ?? null;
      return {
        id: u.id, name: u.name, joined: u.created_at, avatar: u.avatar_at || 0, recoveryCode: !!u.recovery,
        sessions: s.n, lastSeen: s.seen,
        passkeys: q.passkeys.all(id).map((p) => ({ id: p.id, created: p.created_at, lastUsed: p.last_used_at, transports: JSON.parse(p.transports || '[]') })),
        games: q.progress.all(id, id, id, id).map((g) => ({ id: g.id, title: g.title, unlocked: g.unlocked, total: g.total, points: g.points,
          scores: scores.filter((x) => x.game_id === g.id).map((x) => ({ id: x.id, title: x.title, format: x.format, value: x.value, at: x.submitted_at })) })),
        lastIp,
        lastIpBanned: isBanned(lastIp),
        sameAddress: lastIp ? q.sameIp.all(lastIp, id).map((r) => ({ id: r.id, name: r.name })) : [],
        logins: this.logins(id),
        activity: this.activity(id),
      };
    },
    /** A player's login history, newest first, a page at a time (before: the last id seen). */
    logins(id, before = Number.MAX_SAFE_INTEGER) {
      const rows = q.logins.all(id, before, PAGE + 1);
      return { items: rows.slice(0, PAGE).map((r) => ({ id: r.id, at: r.at, kind: r.kind, ok: !!r.ok, ip: r.ip, device: r.device, banned: isBanned(r.ip) })), more: rows.length > PAGE };
    },
    /** A player's unlocks and bests, newest first, a page at a time. */
    activity(id, before = Number.MAX_SAFE_INTEGER) {
      const rows = q.activity.all(id, before, PAGE + 1);
      return { items: rows.slice(0, PAGE).map((r) => ({ id: r.id, at: r.at, kind: r.kind, game: r.game, ...(r.kind === 'unlock' ? { achievement: r.achievement, points: r.points } : { board: r.board, format: r.format, value: r.value }) })), more: rows.length > PAGE };
    },
    /**
     * The admin's actions. Each returns what to log: signout, rename (to
     * PlayerN, which the player can change by making a new account name… or
     * keep), picture, score (one board's best), results (a game's), delete.
     */
    /** A consistent copy of the whole database, written to `file` while the server runs (SQLite's VACUUM INTO). */
    snapshot(file) {
      db.prepare('VACUUM INTO ?').run(file);
    },
    /** Results the fair-play checks flagged, waiting for review: who, which game, what, why. */
    flags() {
      return { items: q.flagged.all().map((r) => ({ kind: r.kind, user: { id: r.user_id, name: r.name }, game: { id: r.game_id, title: r.game }, ref: r.ref, item: r.item, points: r.points, value: r.value, format: r.format, flag: r.flag, at: r.at })) };
    },
    /**
     * Decides a flagged result: 'approve' lets it count in public (and puts it in the activity, at
     * when it happened), 'clear' removes it. kind is 'unlock' or 'score', ref its achievement or board.
     */
    review({ kind, user, game, ref, decision }) {
      const bad = (m) => { throw Object.assign(new Error(m), { status: 400 }); };
      if (!['unlock', 'score'].includes(kind) || !['approve', 'clear'].includes(decision)) bad('which result, and approve or clear?');
      if (!Number.isSafeInteger(user) || typeof game !== 'string' || !Number.isSafeInteger(ref)) bad('which result?');
      const row = kind === 'unlock' ? q.flaggedUnlock.get(user, game, ref) : q.flaggedScore.get(user, game, ref);
      if (!row) throw Object.assign(new Error('nothing flagged there'), { status: 404 });
      if (decision === 'clear') {
        (kind === 'unlock' ? q.dropUnlock : q.dropScore).run(user, game, ref);
        return { did: `flagged ${kind} cleared (${game} ${ref})` };
      }
      (kind === 'unlock' ? q.passUnlock : q.passScore).run(user, game, ref);
      if (row.hardcore) q.feed.run(row.at, user, game, kind, ref, kind === 'score' ? row.value : null);
      return { did: `flagged ${kind} approved (${game} ${ref})` };
    },
    act(id, action, { game = null, board = null } = {}) {
      const u = user(id);
      switch (action) {
        case 'signout':
          q.signOut.run(id);
          return { did: 'signed out everywhere', name: u.name };
        case 'rename': {
          let name = `Player${id}`;
          for (let n = 2; q.nameTaken.get(name.toLowerCase()); n++) name = `Player${id}_${n}`;
          q.rename.run(name, name.toLowerCase(), id);
          return { did: `renamed to ${name}`, name: u.name };
        }
        case 'picture':
          accounts.removePicture(id);
          return { did: 'picture removed', name: u.name };
        case 'score':
          if (typeof game !== 'string' || !Number.isInteger(board)) throw Object.assign(new Error('which score?'), { status: 400 });
          q.dropScore.run(id, game, board);
          q.dropScoreActivity.run(id, game, board);
          return { did: `best score removed (${game} board ${board})`, name: u.name };
        case 'results':
          if (typeof game !== 'string') throw Object.assign(new Error('which game?'), { status: 400 });
          db.exec('BEGIN');
          try { q.dropUnlocks.run(id, game); q.dropEntries.run(id, game); q.dropActivity.run(id, game); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
          return { did: `results cleared (${game})`, name: u.name };
        case 'delete':
          q.remove.run(id);
          return { did: 'account deleted', name: u.name };
        default:
          throw Object.assign(new Error('no such action'), { status: 400 });
      }
    },
  };
}
