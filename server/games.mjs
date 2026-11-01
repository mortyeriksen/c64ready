// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright © 2026 Morten Øien Eriksen
// server/games.mjs — games, their achievement sets and leaderboards, on the
// accounts API (server/accounts.mjs). A game is found by the rcheevos hash of
// its file (the MD5 of the whole file, for the C64). Sets are JSON files in
// server/sets/, loaded at start; conditions are rcheevos strings, evaluated by
// the app.
//
//   GET  /api/games/:hash                             → { game, files, achievements, leaderboards, unlocked, unlocks, notices }
//   POST /api/games/:hash/unlocks                     { achievementId, hardcore } → { ok, new }
//   POST /api/games/:hash/leaderboards/:id/entries    { value, hardcore }         → { best, rank, improved }
//   GET  /api/games/:hash/leaderboards/:id[?limit=N]  → { leaderboard, entries, players, me }
//   GET  /api/games                                   → { games }  every game with a set, its file hashes, how far players got,
//                                                        and with a session the account's own progress (`mine`)
//   GET  /api/activity[?before=ID]                    → { items, more }  everyone's unlocks and new bests, newest first
//   GET  /api/games/:hash/activity[?before=ID]        → { items, more }  one game's
//   GET  /api/users/:id                               → { user, points, games, recent }  a player's profile;
//                                                        each game lists its achievement `ids` in set order
//
// `unlocked` lists the signed-in account's unlocked achievement ids (empty when
// signed out), `unlocks` the same with when each was unlocked. `files` are the
// versions of the game the set is for. Unlocking and posting need an account; reading does not, and
// everything an account earns is public under its name.

import { Bucket } from './address.mjs';
import fs from 'node:fs';
import path from 'node:path';

/** Leaderboard formats, as rcheevos's rc_parse_format names them (format.c). */
export const LB_FORMATS = Object.freeze(['SCORE', 'POINTS', 'TIME', 'FRAMES', 'TIMESECS', 'MILLISECS', 'SECS', 'MINUTES', 'SECS_AS_MINS', 'VALUE', 'UNSIGNED', 'OTHER',
  'TENS', 'HUNDREDS', 'THOUSANDS', 'FIXED1', 'FIXED2', 'FIXED3', 'FLOAT1', 'FLOAT2', 'FLOAT3', 'FLOAT4', 'FLOAT5', 'FLOAT6']);
const HASH_RE = /^[0-9a-f]{32}$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const isId = (n) => Number.isInteger(n) && n > 0 && n < 2 ** 31;
const PAGE = 30;
// Unlocks and scores a player may post: ten at once, then one each 2 seconds,
// so no account can pour a whole set into the chat at once.
const POST_RATE = 0.5, POST_BURST = 10;
// New bests on one board within this long of the run's first are one entry in
// the activity (its value raised, its time kept), told to the chat once. The
// next best after that is a new entry, so the chat catches up.
const SCORE_QUIET_MS = 5 * 60_000;
/** A whole-number query parameter within [min, max], else `fallback`. */
function queryInt(req, name, fallback, min, max) {
  const v = new URLSearchParams(String(req.url || '').split('?')[1] || '').get(name);
  if (v == null || !/^\d{1,15}$/.test(v)) return fallback;
  return Math.min(Math.max(Number(v), min), max);
}
const text = (v, max) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);

/** A set file checked for shape; throws with the first problem found. */
export function checkSet(set, where = 'set') {
  const fail = (m) => { throw new Error(`${where}: ${m}`); };
  if (!set || typeof set !== 'object') fail('not an object');
  if (!ID_RE.test(set.id ?? '')) fail('id must be a lower-case slug');
  if (!text(set.title, 80)) fail('title is required');
  if (!Array.isArray(set.hashes) || !set.hashes.length) fail('hashes must list at least one file');
  for (const h of set.hashes) if (!HASH_RE.test(h?.hash ?? '')) fail(`bad hash ${JSON.stringify(h?.hash)}`);
  const seen = new Set();
  for (const a of set.achievements ?? []) {
    if (!isId(a.id) || seen.has(a.id)) fail(`achievement id ${a.id} is missing, repeated or out of range`);
    seen.add(a.id);
    if (!text(a.title, 64) || !text(a.description, 200)) fail(`achievement ${a.id} needs a title and a description`);
    if (!text(a.memaddr, 4096)) fail(`achievement ${a.id} needs a memaddr`);
    if (!Number.isInteger(a.points ?? 0) || (a.points ?? 0) < 0 || a.points > 100) fail(`achievement ${a.id} points out of range`);
  }
  const lbSeen = new Set();
  for (const l of set.leaderboards ?? []) {
    if (!isId(l.id) || lbSeen.has(l.id)) fail(`leaderboard id ${l.id} is missing, repeated or out of range`);
    lbSeen.add(l.id);
    if (!text(l.title, 64) || !text(l.description, 200)) fail(`leaderboard ${l.id} needs a title and a description`);
    if (!LB_FORMATS.includes(l.format)) fail(`leaderboard ${l.id} format ${l.format} is not an rcheevos format`);
    if (!text(l.definition, 4096) || !/STA:.*::CAN:.*::SUB:.*::VAL:/.test(l.definition)) fail(`leaderboard ${l.id} definition needs STA, CAN, SUB and VAL`);
  }
  // Notices: a state the player should know about, such as a trainer that
  // keeps the game from counting. Shown when the condition becomes true.
  const nSeen = new Set();
  for (const n of set.notices ?? []) {
    if (!isId(n.id) || nSeen.has(n.id)) fail(`notice id ${n.id} is missing, repeated or out of range`);
    nSeen.add(n.id);
    if (!text(n.text, 200) || !text(n.memaddr, 4096)) fail(`notice ${n.id} needs a text and a memaddr`);
  }
  return set;
}

/**
 * Loads every set in `dir` into the database, replacing what an earlier start
 * loaded for the same game. Unlocks and entries stay: they are keyed by the
 * game's id and each achievement's or leaderboard's id, which a set keeps. A
 * game whose set is gone is retired: its definitions go, and with them it
 * leaves the list and the feeds, while its players' results wait in case the
 * set returns.
 */
/** A game with a set, by its id: { id, title }, or null. The chat's mentions name these. */
export function gameById(db, id) {
  return db.prepare('SELECT id, title FROM games WHERE id = ?').get(id) ?? null;
}

export function loadSets(db, dir, log = () => {}) {
  if (!dir || !fs.existsSync(dir)) return [];
  const loaded = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const set = checkSet(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')), file);
    db.exec('BEGIN');
    try {
      const notices = set.notices?.length ? JSON.stringify(set.notices.map((n) => ({ id: n.id, text: n.text, memaddr: n.memaddr }))) : null;
      db.prepare('INSERT INTO games (id, title, source, notices) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, source = excluded.source, notices = excluded.notices')
        .run(set.id, set.title, set.source ?? null, notices);
      for (const t of ['game_hashes', 'achievements', 'leaderboards']) db.prepare(`DELETE FROM ${t} WHERE game_id = ?`).run(set.id);
      const addHash = db.prepare('INSERT INTO game_hashes (hash, game_id, label) VALUES (?, ?, ?)');
      for (const h of set.hashes) addHash.run(h.hash, set.id, h.label ?? null);
      const addAch = db.prepare('INSERT INTO achievements (game_id, id, title, description, points, memaddr, sort) VALUES (?, ?, ?, ?, ?, ?, ?)');
      (set.achievements ?? []).forEach((a, i) => addAch.run(set.id, a.id, a.title, a.description, a.points ?? 0, a.memaddr, i));
      const addLb = db.prepare('INSERT INTO leaderboards (game_id, id, title, description, format, lower_is_better, definition, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      (set.leaderboards ?? []).forEach((l, i) => addLb.run(set.id, l.id, l.title, l.description, l.format, l.lowerIsBetter ? 1 : 0, l.definition, i));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    loaded.push(set.id);
  }
  const retired = db.prepare('SELECT id FROM games').all().map((r) => r.id).filter((id) => !loaded.includes(id));
  for (const id of retired) db.prepare('DELETE FROM games WHERE id = ?').run(id);   // hashes, achievements and leaderboards cascade
  log(`achievement sets: ${loaded.join(', ') || 'none'}${retired.length ? ` (retired: ${retired.join(', ')})` : ''}`);
  return loaded;
}

/**
 * The game routes, for createAccounts({ extend }). `onActivity` hears each new
 * unlock and new best (the chat announces them): { kind, user, game, achievement | leaderboard, value }.
 */
export function gameRoutes({ db, now, HttpError, requireUser, optionalUser, onActivity = () => {} }) {
  const postBuckets = new Map();   // user id → Bucket
  // A game's players by achievement points: [{ user, name, avatar, unlocked, points, last }].
  const POINTS = `SELECT x.user_id, COUNT(*) AS unlocked, SUM(a.points) AS points, MAX(x.unlocked_at) AS last
    FROM unlocks x JOIN achievements a ON a.game_id = x.game_id AND a.id = x.achievement_id WHERE x.game_id = ? GROUP BY x.user_id`;
  function allowPost(user) {
    if (postBuckets.size > 10_000) postBuckets.clear();
    let bucket = postBuckets.get(user.id);
    if (!bucket) postBuckets.set(user.id, (bucket = new Bucket(POST_RATE, POST_BURST, now)));
    if (!bucket.take()) throw new HttpError(429, 'too many at once, slow down');
  }
  const q = {
    achievementCount: db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(points), 0) AS points FROM achievements WHERE game_id = ?'),
    top: db.prepare(`SELECT p.*, u.name, u.avatar_at FROM (${POINTS}) p JOIN users u ON u.id = p.user_id ORDER BY p.points DESC, p.last ASC, p.user_id LIMIT ?`),
    topOf: db.prepare(`SELECT * FROM (${POINTS}) WHERE user_id = ?`),
    topAbove: db.prepare(`SELECT COUNT(*) AS n FROM (${POINTS}) WHERE points > ?`),
    topPlayers: db.prepare(`SELECT COUNT(*) AS n FROM (${POINTS})`),
    topComplete: db.prepare(`SELECT COUNT(*) AS n FROM (${POINTS}) WHERE unlocked = ?`),
    lastScore: db.prepare("SELECT id, at FROM activity WHERE user_id = ? AND game_id = ? AND kind = 'score' AND ref = ? ORDER BY id DESC LIMIT 1"),
    raiseScore: db.prepare('UPDATE activity SET value = ? WHERE id = ?'),
    gameByHash: db.prepare('SELECT g.id, g.title, g.notices FROM game_hashes h JOIN games g ON g.id = h.game_id WHERE h.hash = ?'),
    achievements: db.prepare('SELECT id, title, description, points, memaddr FROM achievements WHERE game_id = ? ORDER BY sort'),
    achievement: db.prepare('SELECT id, title, points FROM achievements WHERE game_id = ? AND id = ?'),
    leaderboards: db.prepare('SELECT id, title, description, format, lower_is_better, definition FROM leaderboards WHERE game_id = ? ORDER BY sort'),
    leaderboard: db.prepare('SELECT id, title, description, format, lower_is_better FROM leaderboards WHERE game_id = ? AND id = ?'),
    unlocked: db.prepare('SELECT achievement_id, unlocked_at FROM unlocks WHERE user_id = ? AND game_id = ?'),
    files: db.prepare('SELECT hash, label FROM game_hashes WHERE game_id = ? ORDER BY rowid'),
    players: db.prepare('SELECT COUNT(*) AS n FROM lb_entries WHERE game_id = ? AND leaderboard_id = ?'),
    unlock: db.prepare('INSERT OR IGNORE INTO unlocks (user_id, game_id, achievement_id, hardcore, unlocked_at) VALUES (?, ?, ?, ?, ?)'),
    entry: db.prepare('SELECT value FROM lb_entries WHERE user_id = ? AND game_id = ? AND leaderboard_id = ?'),
    putEntry: db.prepare('INSERT INTO lb_entries (user_id, game_id, leaderboard_id, value, hardcore, submitted_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, game_id, leaderboard_id) DO UPDATE SET value = excluded.value, hardcore = excluded.hardcore, submitted_at = excluded.submitted_at'),
    activity: db.prepare('INSERT INTO activity (at, user_id, game_id, kind, ref, value) VALUES (?, ?, ?, ?, ?, ?)'),
  };
  const rankStmt = {
    high: db.prepare('SELECT COUNT(*) AS n FROM lb_entries WHERE game_id = ? AND leaderboard_id = ? AND value > ?'),
    low: db.prepare('SELECT COUNT(*) AS n FROM lb_entries WHERE game_id = ? AND leaderboard_id = ? AND value < ?'),
  };
  const topStmt = {
    high: db.prepare('SELECT u.id AS user_id, u.name, u.avatar_at, e.value, e.submitted_at FROM lb_entries e JOIN users u ON u.id = e.user_id WHERE e.game_id = ? AND e.leaderboard_id = ? ORDER BY e.value DESC, e.submitted_at ASC, e.rowid ASC LIMIT ?'),
    low: db.prepare('SELECT u.id AS user_id, u.name, u.avatar_at, e.value, e.submitted_at FROM lb_entries e JOIN users u ON u.id = e.user_id WHERE e.game_id = ? AND e.leaderboard_id = ? ORDER BY e.value ASC, e.submitted_at ASC, e.rowid ASC LIMIT ?'),
  };

  function game(hash) {
    if (!HASH_RE.test(hash)) throw new HttpError(400, 'not a game hash');
    const g = q.gameByHash.get(hash);
    if (!g) throw new HttpError(404, 'no achievements for this game');
    return g;
  }
  function board(g, id) {
    const lb = /^\d+$/.test(id) ? q.leaderboard.get(g.id, Number(id)) : undefined;
    if (!lb) throw new HttpError(404, 'no such leaderboard');
    return lb;
  }
  const order = (lb) => (lb.lower_is_better ? 'low' : 'high');
  const tell = (e) => { try { onActivity(e); } catch { /* the activity is saved either way */ } };
  // Best first; a tie shares the rank, and the next value skips past the tied ones.
  const rankEntries = (rows) => rows.map((e, i) => ({ rank: i && rows[i - 1].value === e.value ? 0 : i + 1, user: { id: e.user_id, name: e.name, avatar: e.avatar_at || 0 }, name: e.name, value: e.value, at: e.submitted_at }))
    .map((e, i, all) => { if (!e.rank) e.rank = all[i - 1].rank; return e; });
  const rankOf = (g, lb, value) => rankStmt[order(lb)].get(g.id, lb.id, value).n + 1;

  // Activity: one row per new unlock or new best, with what it was for. Rows
  // whose achievement or leaderboard a later set dropped are left out.
  const FIRST_HASH = '(SELECT hash FROM game_hashes WHERE game_id = g.id ORDER BY rowid LIMIT 1)';
  const activitySql = (where) => db.prepare(`SELECT a.id, a.at, a.kind, a.ref, a.value, u.id AS user_id, u.name, u.avatar_at, g.id AS game_id, g.title AS game_title, ${FIRST_HASH} AS hash,
      ach.title AS ach_title, ach.points AS ach_points, lb.title AS lb_title, lb.format AS lb_format
    FROM activity a JOIN users u ON u.id = a.user_id JOIN games g ON g.id = a.game_id
    LEFT JOIN achievements ach ON a.kind = 'unlock' AND ach.game_id = a.game_id AND ach.id = a.ref
    LEFT JOIN leaderboards lb ON a.kind = 'score' AND lb.game_id = a.game_id AND lb.id = a.ref
    WHERE a.id < ? ${where} AND (ach.id IS NOT NULL OR lb.id IS NOT NULL)
    ORDER BY a.id DESC LIMIT ?`);
  const feed = { all: activitySql(''), game: activitySql('AND a.game_id = ?'), user: activitySql('AND a.user_id = ?') };
  const item = (r) => ({
    id: r.id, at: r.at, kind: r.kind,
    user: { id: r.user_id, name: r.name, avatar: r.avatar_at || 0 },
    game: { id: r.game_id, title: r.game_title, hash: r.hash },
    ...(r.kind === 'unlock' ? { achievement: { id: r.ref, title: r.ach_title, points: r.ach_points } } : { leaderboard: { id: r.ref, title: r.lb_title, format: r.lb_format }, value: r.value }),
  });
  function page(stmt, req, ...args) {
    const before = queryInt(req, 'before', Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
    const rows = stmt.all(before, ...args, PAGE + 1);
    return { items: rows.slice(0, PAGE).map(item), more: rows.length > PAGE };
  }

  const games = {
    list: db.prepare(`SELECT g.id, g.title, ${FIRST_HASH} AS hash,
        (SELECT COUNT(*) FROM achievements WHERE game_id = g.id) AS achievements,
        (SELECT COALESCE(SUM(points), 0) FROM achievements WHERE game_id = g.id) AS points,
        (SELECT COUNT(*) FROM leaderboards WHERE game_id = g.id) AS leaderboards,
        (SELECT COUNT(DISTINCT user_id) FROM activity WHERE game_id = g.id) AS players,
        (SELECT MAX(at) FROM activity WHERE game_id = g.id) AS last
      FROM games g ORDER BY g.title COLLATE NOCASE`),
    mine: db.prepare(`SELECT un.game_id, COUNT(*) AS unlocked, COALESCE(SUM(ach.points), 0) AS points FROM unlocks un
      JOIN achievements ach ON ach.game_id = un.game_id AND ach.id = un.achievement_id
      WHERE un.user_id = ? GROUP BY un.game_id`),
  };
  const profile = {
    user: db.prepare('SELECT id, name, created_at, avatar_at FROM users WHERE id = ?'),
    games: db.prepare(`SELECT g.id, g.title, ${FIRST_HASH} AS hash,
        (SELECT COUNT(*) FROM achievements WHERE game_id = g.id) AS total,
        (SELECT COALESCE(SUM(points), 0) FROM achievements WHERE game_id = g.id) AS total_points,
        COUNT(ach.id) AS unlocked, COALESCE(SUM(ach.points), 0) AS points, MAX(un.unlocked_at) AS last
      FROM games g
      LEFT JOIN unlocks un ON un.game_id = g.id AND un.user_id = ?
      LEFT JOIN achievements ach ON ach.game_id = un.game_id AND ach.id = un.achievement_id
      WHERE un.user_id IS NOT NULL OR g.id IN (SELECT game_id FROM lb_entries WHERE user_id = ?)
      GROUP BY g.id ORDER BY last DESC NULLS LAST, g.title COLLATE NOCASE`),
    ids: db.prepare('SELECT id FROM achievements WHERE game_id = ? ORDER BY sort'),
    unlocks: db.prepare(`SELECT ach.id, ach.title, ach.description, ach.points, un.unlocked_at FROM unlocks un
      JOIN achievements ach ON ach.game_id = un.game_id AND ach.id = un.achievement_id
      WHERE un.user_id = ? AND un.game_id = ? ORDER BY un.unlocked_at DESC`),
    scores: db.prepare(`SELECT lb.id, lb.title, lb.format, lb.lower_is_better, e.value FROM lb_entries e
      JOIN leaderboards lb ON lb.game_id = e.game_id AND lb.id = e.leaderboard_id
      WHERE e.user_id = ? AND e.game_id = ? ORDER BY lb.sort`),
  };

  return {
    'GET /api/games/:hash'(body, req, { hash }) {
      const g = game(hash);
      const user = optionalUser(req);
      const mine = user ? q.unlocked.all(user.id, g.id) : [];
      return {
        game: { id: g.id, title: g.title },
        files: q.files.all(g.id).map((f) => ({ hash: f.hash, label: f.label })),
        achievements: q.achievements.all(g.id),
        leaderboards: q.leaderboards.all(g.id).map((l) => ({ id: l.id, title: l.title, description: l.description, format: l.format, lowerIsBetter: !!l.lower_is_better, definition: l.definition })),
        unlocked: mine.map((r) => r.achievement_id),
        unlocks: mine.map((r) => ({ id: r.achievement_id, at: r.unlocked_at })),
        notices: g.notices ? JSON.parse(g.notices) : [],
      };
    },
    'POST /api/games/:hash/unlocks'(body, req, { hash }) {
      const user = requireUser(req);
      allowPost(user);
      const g = game(hash);
      const id = body.achievementId;
      const a = isId(id) ? q.achievement.get(g.id, id) : undefined;
      if (!a) throw new HttpError(404, 'no such achievement');
      const t = now();
      const added = q.unlock.run(user.id, g.id, id, body.hardcore ? 1 : 0, t).changes > 0;
      if (added) {
        q.activity.run(t, user.id, g.id, 'unlock', id, null);
        tell({ kind: 'unlock', user, game: { title: g.title, hash }, achievement: { title: a.title, points: a.points } });
      }
      return { ok: true, new: added };
    },
    'POST /api/games/:hash/leaderboards/:id/entries'(body, req, { hash, id }) {
      const user = requireUser(req);
      allowPost(user);
      const g = game(hash);
      const lb = board(g, id);
      const value = body.value;
      if (!Number.isInteger(value) || value < -(2 ** 31) || value >= 2 ** 31) throw new HttpError(400, 'a value is a 32-bit integer');
      const prev = q.entry.get(user.id, g.id, lb.id);
      const better = !prev || (lb.lower_is_better ? value < prev.value : value > prev.value);
      const t = now();
      if (better) {
        q.putEntry.run(user.id, g.id, lb.id, value, body.hardcore ? 1 : 0, t);
        const last = q.lastScore.get(user.id, g.id, lb.id);
        if (last && t - last.at < SCORE_QUIET_MS) q.raiseScore.run(value, last.id);
        else {
          q.activity.run(t, user.id, g.id, 'score', lb.id, value);
          tell({ kind: 'score', user, game: { title: g.title, hash }, leaderboard: { title: lb.title, format: lb.format }, value });
        }
      }
      const best = better ? value : prev.value;
      return { best, rank: rankOf(g, lb, best), improved: better };
    },
    // The Hall of Fame: who has the most of a game's achievement points, earlier first on a tie
    // (equal points share a place), how many have played, and how many finished the set.
    'GET /api/games/:hash/top'(body, req, { hash }) {
      const g = game(hash);
      const { n: total, points: totalPoints } = q.achievementCount.get(g.id);
      const rows = q.top.all(g.id, queryInt(req, 'limit', 10, 1, 100));
      let rank = 0, prev = null;
      const entries = rows.map((r, i) => {
        if (r.points !== prev) { rank = i + 1; prev = r.points; }
        return { rank, user: { id: r.user_id, name: r.name, avatar: r.avatar_at || 0 }, unlocked: r.unlocked, points: r.points, complete: r.unlocked === total, at: r.last };
      });
      const user = optionalUser(req);
      const mine = user ? q.topOf.get(g.id, user.id) : undefined;
      return {
        total,
        totalPoints,
        players: q.topPlayers.get(g.id).n,
        complete: total ? q.topComplete.get(g.id, total).n : 0,
        entries,
        me: mine?.points ? { rank: q.topAbove.get(g.id, mine.points).n + 1, unlocked: mine.unlocked, points: mine.points, complete: mine.unlocked === total } : null,
      };
    },
    'GET /api/games/:hash/leaderboards/:id'(body, req, { hash, id }) {
      const g = game(hash);
      const lb = board(g, id);
      const user = optionalUser(req);
      const mine = user ? q.entry.get(user.id, g.id, lb.id) : undefined;
      return {
        leaderboard: { id: lb.id, title: lb.title, description: lb.description, format: lb.format, lowerIsBetter: !!lb.lower_is_better },
        entries: rankEntries(topStmt[order(lb)].all(g.id, lb.id, queryInt(req, 'limit', 10, 1, 100))),
        players: q.players.get(g.id, lb.id).n,
        me: mine ? { value: mine.value, rank: rankOf(g, lb, mine.value) } : null,
      };
    },
    'GET /api/games'(body, req) {
      const user = optionalUser(req);
      const mine = new Map(user ? games.mine.all(user.id).map((r) => [r.game_id, { unlocked: r.unlocked, points: r.points }]) : []);
      return { games: games.list.all().map((g) => ({
        id: g.id, title: g.title, hash: g.hash, hashes: q.files.all(g.id).map((f) => f.hash),
        achievements: g.achievements, points: g.points, leaderboards: g.leaderboards, players: g.players, last: g.last,
        ...(user ? { mine: mine.get(g.id) ?? { unlocked: 0, points: 0 } } : {}),
      })) };
    },
    'GET /api/activity'(body, req) {
      return page(feed.all, req);
    },
    'GET /api/games/:hash/activity'(body, req, { hash }) {
      return page(feed.game, req, game(hash).id);
    },
    'GET /api/users/:id'(body, req, { id }) {
      const u = /^\d{1,15}$/.test(id) ? profile.user.get(Number(id)) : undefined;
      if (!u) throw new HttpError(404, 'no such player');
      const played = profile.games.all(u.id, u.id).map((g) => ({
        id: g.id, title: g.title, hash: g.hash,
        unlocked: g.unlocked, total: g.total, points: g.points, totalPoints: g.total_points,
        ids: profile.ids.all(g.id).map((r) => r.id),
        achievements: profile.unlocks.all(u.id, g.id).map((a) => ({ id: a.id, title: a.title, description: a.description, points: a.points, at: a.unlocked_at })),
        scores: profile.scores.all(u.id, g.id).map((l) => ({ id: l.id, title: l.title, format: l.format, value: l.value, rank: rankOf({ id: g.id }, { id: l.id, lower_is_better: l.lower_is_better }, l.value) })),
      }));
      return {
        user: { id: u.id, name: u.name, since: u.created_at, avatar: u.avatar_at || 0 },
        points: played.reduce((n, g) => n + g.points, 0),
        games: played,
        recent: feed.user.all(Number.MAX_SAFE_INTEGER, u.id, 10).map(item),
      };
    },
  };
}
