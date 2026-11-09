// Demo players (server/demo-players.mjs, the admin console's "Add 50 demo players"): on a database
// with every set loaded, each batch adds 50 players with new names, five scores on every board,
// early and mid-game unlocks, and the unlocks each score implies; everything counts in public and
// sits in the last six weeks; removing them leaves the real players as they were.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../../server/db.mjs';
import { loadSets } from '../../server/games.mjs';
import { createDemoPlayers } from '../../server/demo-players.mjs';
import { createAdminData } from '../../server/admin-data.mjs';
import { imageInfo, ACCOUNT_DEFAULTS as LIMITS } from '../../server/accounts.mjs';

let testNo = 0, failing = 0, current = [];
function expect(cond, msg) { if (!cond) current.push(msg); }
function ok(label) {
  testNo++;
  if (!current.length) console.log(`ok  - test ${testNo}: ${label}`);
  else {
    failing++;
    console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of current.slice(0, 12)) console.log(`     - ${m}`);
    if (current.length > 12) console.log(`     - and ${current.length - 12} more`);
    current = [];
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = Date.UTC(2026, 10, 6, 12);
const DAY = 24 * 3600_000;
const db = openDatabase(':memory:');
loadSets(db, path.join(root, 'server/sets'));
let seed = 7;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const demo = createDemoPlayers({ db, now: () => NOW, random });
const all = (sql, ...a) => db.prepare(sql).all(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);

// A real player with an unlock and a score, who must come through it all untouched.
db.prepare("INSERT INTO users (name, name_key, handle, created_at) VALUES ('Real', 'real', x'01', ?)").run(NOW - 9 * DAY);
const real = one("SELECT id FROM users WHERE name_key = 'real'").id;
db.prepare("INSERT INTO unlocks (user_id, game_id, achievement_id, hardcore, unlocked_at) VALUES (?, 'arkanoid', 1, 1, ?)").run(real, NOW - DAY);
db.prepare("INSERT INTO lb_entries (user_id, game_id, leaderboard_id, value, hardcore, submitted_at) VALUES (?, 'arkanoid', 1, 4200, 1, ?)").run(real, NOW - DAY);

const boards = all('SELECT game_id, id, lower_is_better FROM leaderboards');

// 1. A batch: 50 players, five scores on every board, two where the result needs late-game trophies,
// nothing flagged, all of it hardcore.
{
  const r = demo.populate(50);
  expect(r.players === 50 && demo.count() === 50, `50 demo players (added ${r.players}, counted ${demo.count()})`);
  const counts = boards.map((b) => one('SELECT COUNT(*) AS n FROM lb_entries e JOIN demo_players d ON d.user_id = e.user_id WHERE e.game_id = ? AND e.leaderboard_id = ?', b.game_id, b.id).n);
  expect(r.scores === counts.reduce((a, n) => a + n, 0) && counts.every((n) => n === 5 || n === 2), `five or two scores on every board (got ${[...new Set(counts)]})`);
  // A late-game trophy: past the first 55% of its set, not a score milestone.
  const lateTrophies = (uid, game) => one(`SELECT COUNT(*) AS n FROM unlocks u JOIN achievements a ON a.game_id = u.game_id AND a.id = u.achievement_id
      WHERE u.user_id = ? AND u.game_id = ? AND a.score_at IS NULL AND a.sort >= (SELECT CAST(COUNT(*) * 0.55 + 0.999 AS INTEGER) FROM achievements x WHERE x.game_id = a.game_id)`, uid, game).n;
  const two = boards.filter((b, i) => counts[i] === 2);
  const notLate = two.filter((b) => all('SELECT e.user_id FROM lb_entries e JOIN demo_players d ON d.user_id = e.user_id WHERE e.game_id = ? AND e.leaderboard_id = ?', b.game_id, b.id)
    .some((e) => !lateTrophies(e.user_id, b.game_id)));
  expect(two.length >= 5 && !notLate.length, `the boards with two are those whose result needs late-game trophies (${two.length} boards, ${notLate.map((b) => `${b.game_id}/${b.id}`).join(', ') || 'each poster has one'})`);
  for (const [game, board, n] of [['ultima-iv', 1, 2], ['prince-of-persia', 1, 2], ['commando', 2, 5], ['exploding-fist', 1, 5]]) {
    const got = counts[boards.findIndex((b) => b.game_id === game && b.id === board)];
    expect(got === n, `${game} board ${board} has ${n} demo scores (got ${got})`);
  }
  const flagged = one('SELECT (SELECT COUNT(*) FROM unlocks WHERE flag IS NOT NULL OR hardcore = 0) + (SELECT COUNT(*) FROM lb_entries WHERE flag IS NOT NULL OR hardcore = 0) AS n').n;
  expect(flagged === 0, `nothing flagged or softcore (${flagged})`);
  const games = one('SELECT COUNT(DISTINCT game_id) AS n FROM achievements').n, played = one('SELECT COUNT(DISTINCT game_id) AS n FROM unlocks u JOIN demo_players d ON d.user_id = u.user_id').n;
  expect(played === games, `every game with a set has demo unlocks (${played} of ${games})`);
  // Each has a badge, as a player's picture is: a PNG, JPEG or WebP the server serves, within its size.
  const pics = all('SELECT u.avatar, u.avatar_type, u.avatar_at FROM users u JOIN demo_players d ON d.user_id = u.id');
  const bad = pics.filter((p) => { const i = p.avatar && imageInfo(Buffer.from(p.avatar)); return !i || i.type !== p.avatar_type || i.width > LIMITS.pictureSide || i.height > LIMITS.pictureSide || p.avatar.length > LIMITS.maxPictureBytes || !p.avatar_at; });
  expect(pics.length === 50 && bad.length === 0, `every demo player has a badge a player could have set (${bad.length} of ${pics.length} not)`);
  expect(new Set(pics.map((p) => Buffer.from(p.avatar).toString('base64'))).size >= 45, 'and the badges differ');
  ok('a batch of 50 players, five scores on every board');
}

// 2. Every high score in points comes with every score milestone at or below it, so it shows in public.
{
  const missing = all(`SELECT e.user_id, e.game_id, e.value, a.id AS ach FROM lb_entries e JOIN demo_players d ON d.user_id = e.user_id
      JOIN leaderboards l ON l.game_id = e.game_id AND l.id = e.leaderboard_id AND l.lower_is_better = 0 AND l.format = 'SCORE'
      JOIN achievements a ON a.game_id = e.game_id AND a.score_at IS NOT NULL AND a.score_at <= e.value
      WHERE NOT EXISTS (SELECT 1 FROM unlocks u WHERE u.user_id = e.user_id AND u.game_id = e.game_id AND u.achievement_id = a.id)`);
  expect(missing.length === 0, `scores past milestones not unlocked: ${missing.slice(0, 5).map((m) => `${m.game_id} ${m.value} needs #${m.ach}`).join(', ')}`);
  ok('scores come with their milestones');
}

// 2b. A high score fits the player's trophies: short of the game's second score milestone, which is
// past early and mid-game, and higher for a player further through the game.
{
  const over = all(`SELECT e.game_id, e.value, (SELECT score_at FROM achievements a WHERE a.game_id = e.game_id AND a.score_at IS NOT NULL ORDER BY score_at LIMIT 1 OFFSET 1) AS second
      FROM lb_entries e JOIN demo_players d ON d.user_id = e.user_id JOIN leaderboards l ON l.game_id = e.game_id AND l.id = e.leaderboard_id AND l.lower_is_better = 0 AND l.format = 'SCORE'`)
    .filter((r) => r.second != null && r.value >= r.second);
  expect(over.length === 0, `scores at or past the second score milestone: ${over.slice(0, 5).map((r) => `${r.game_id} ${r.value} (${r.second})`).join(', ')}`);
  const fist = one("SELECT MAX(e.value) AS hi FROM lb_entries e JOIN demo_players d ON d.user_id = e.user_id WHERE e.game_id = 'exploding-fist'").hi;
  expect(fist < 25000, `The Way of the Exploding Fist's demo scores stay under 25,000, its second score trophy (best ${fist})`);
  // A board that is not in points (a height, a count) is no score: the game's score trophies do not set it.
  const ll = (id) => one(`SELECT MAX(e.value) AS hi FROM lb_entries e JOIN demo_players d ON d.user_id = e.user_id WHERE e.game_id = 'last-light' AND e.leaderboard_id = ?`, id).hi;
  expect(ll(2) <= 400 && ll(3) <= 40, `Last Light's demo heights stay at most 400 and its bells at most 40, not its 10,000-point trophy (best ${ll(2)} and ${ll(3)})`);
  // Progress: the early and mid-game trophies (not score milestones) a player has in the game.
  const progress = (uid, game) => one(`SELECT COUNT(*) AS n FROM unlocks u JOIN achievements a ON a.game_id = u.game_id AND a.id = u.achievement_id
      WHERE u.user_id = ? AND u.game_id = ? AND a.score_at IS NULL`, uid, game).n;
  let higher = 0, lower = 0;
  for (const b of boards.filter((x) => !x.lower_is_better)) {
    const rows = all('SELECT e.user_id, e.value FROM lb_entries e JOIN demo_players d ON d.user_id = e.user_id WHERE e.game_id = ? AND e.leaderboard_id = ? ORDER BY e.value', b.game_id, b.id);
    if (rows.length < 2) continue;
    const top = progress(rows.at(-1).user_id, b.game_id), bottom = progress(rows[0].user_id, b.game_id);
    if (top > bottom) higher++; else if (top < bottom) lower++;
  }
  expect(higher >= 4 * lower, `on a board, the best demo score goes with more of the game's trophies than the lowest (${higher} boards so, ${lower} the other way)`);
  ok('high scores fit the trophies');
}

// 3. A result only a finished stage can post comes with that stage: the Codex, the princess, Sandy.
{
  for (const [game, board, title] of [['ultima-iv', 1, 'The Codex of Ultimate Wisdom'], ['prince-of-persia', 1, 'Happily Ever After'], ['maniac-mansion', 1, 'Sandy Rescued'],
    ['last-ninja', 1, 'Into the Wilderness'], ['leaderboard', 1, 'Eighteen Holes'], ['zork-i', 1, 'Master Adventurer']]) {
    const lacking = one(`SELECT COUNT(*) AS n FROM lb_entries e JOIN demo_players d ON d.user_id = e.user_id WHERE e.game_id = ? AND e.leaderboard_id = ?
        AND NOT EXISTS (SELECT 1 FROM unlocks u JOIN achievements a ON a.game_id = u.game_id AND a.id = u.achievement_id WHERE u.user_id = e.user_id AND u.game_id = e.game_id AND a.title = ?)`, game, board, title).n;
    expect(lacking === 0, `${game} board ${board}: every poster has ${title} (${lacking} without)`);
  }
  ok('finished stages come with their results');
}

// 4. Early and mid-game: an unlock past the first 55% of a set comes only with a score that needs it.
{
  const late = all(`SELECT u.user_id, u.game_id, a.title FROM unlocks u JOIN demo_players d ON d.user_id = u.user_id JOIN achievements a ON a.game_id = u.game_id AND a.id = u.achievement_id
      WHERE a.score_at IS NULL AND a.sort >= (SELECT CAST(COUNT(*) * 0.55 + 0.999 AS INTEGER) FROM achievements x WHERE x.game_id = u.game_id)
      AND NOT EXISTS (SELECT 1 FROM lb_entries e WHERE e.user_id = u.user_id AND e.game_id = u.game_id)`);
  expect(late.length === 0, `late unlocks without a score: ${late.slice(0, 5).map((l) => `${l.game_id} ${l.title}`).join(', ')}`);
  // Most players stop after the first few: in half the games played, a fifth of the set or less.
  const shares = all(`SELECT COUNT(*) * 1.0 / (SELECT COUNT(*) FROM achievements a WHERE a.game_id = u.game_id) AS s
      FROM unlocks u JOIN demo_players d ON d.user_id = u.user_id GROUP BY u.user_id, u.game_id`).map((r) => r.s).sort((a, b) => a - b);
  const median = shares[Math.floor(shares.length / 2)];
  expect(median <= 0.2, `half the games a demo player plays end at a fifth of the set or less (median ${median.toFixed(2)})`);
  const whole = one(`SELECT COUNT(*) AS n FROM (SELECT u.game_id, COUNT(*) AS c FROM unlocks u JOIN demo_players d ON d.user_id = u.user_id GROUP BY u.user_id, u.game_id) x
      WHERE x.c = (SELECT COUNT(*) FROM achievements a WHERE a.game_id = x.game_id)`).n;
  expect(whole <= 3, `hardly anyone has a whole set (${whole})`);
  ok('early and mid-game unlocks');
}

// 5. Times: all in the last six weeks, each player joining before they play, scores after unlocks,
//    and the activity written in time order.
{
  const t = one('SELECT MIN(at) AS lo, MAX(at) AS hi FROM activity a JOIN demo_players d ON d.user_id = a.user_id');
  expect(t.lo >= NOW - 42 * DAY && t.hi <= NOW, 'activity within the last six weeks');
  const early = one('SELECT COUNT(*) AS n FROM unlocks u JOIN users x ON x.id = u.user_id JOIN demo_players d ON d.user_id = u.user_id WHERE u.unlocked_at < x.created_at').n;
  expect(early === 0, `no unlock before its player joined (${early})`);
  const rows = all('SELECT a.at FROM activity a JOIN demo_players d ON d.user_id = a.user_id ORDER BY a.id');
  expect(rows.every((r, i) => !i || r.at >= rows[i - 1].at), 'activity rows in time order');
  const acts = one("SELECT COUNT(*) AS n FROM activity a JOIN demo_players d ON d.user_id = a.user_id WHERE kind IN ('unlock', 'score')").n;
  const results = one('SELECT (SELECT COUNT(*) FROM unlocks u JOIN demo_players d ON d.user_id = u.user_id) + (SELECT COUNT(*) FROM lb_entries e JOIN demo_players d ON d.user_id = e.user_id) AS n').n;
  expect(acts === results, `an activity row for each unlock and score (${acts} of ${results})`);
  ok('times');
}

// 6. A second batch adds 50 more with new names; removing them all leaves the real player whole.
{
  const before = new Set(all('SELECT name_key FROM users u JOIN demo_players d ON d.user_id = u.id').map((r) => r.name_key));
  demo.populate(50);
  const names = all('SELECT name_key FROM users u JOIN demo_players d ON d.user_id = u.id').map((r) => r.name_key);
  expect(names.length === 100 && new Set(names).size === 100, `100 demo players with 100 names (got ${names.length}, ${new Set(names).size} names)`);
  expect(names.filter((n) => !before.has(n)).length === 50, 'the second batch has new names');
  const b = boards[0];
  expect(one('SELECT COUNT(*) AS n FROM lb_entries e JOIN demo_players d ON d.user_id = e.user_id WHERE e.game_id = ? AND e.leaderboard_id = ?', b.game_id, b.id).n === 10, 'ten demo scores on a board');
  const ids = all('SELECT user_id FROM demo_players').map((x) => x.user_id);
  const r = demo.remove();
  expect(r.removed === 100 && demo.count() === 0, `all 100 removed (${r.removed})`);
  const left = one(`SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM unlocks) + (SELECT COUNT(*) FROM lb_entries) + (SELECT COUNT(*) FROM plays) AS n`).n;
  expect(left === 3, `only the real player, their unlock and score remain (${left} rows)`);
  const tables = all("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name).filter((t) => all(`PRAGMA table_info(${t})`).some((c) => c.name === 'user_id'));
  const stray = tables.filter((t) => ids.some((id) => one(`SELECT 1 AS x FROM ${t} WHERE user_id = ?`, id)));
  expect(stray.length === 0 && !ids.some((id) => one('SELECT 1 AS x FROM users WHERE id = ?', id)), `no row of a removed demo player is left, badges included (${stray.join(', ') || 'none'})`);
  expect(one('SELECT COUNT(*) AS n FROM activity').n === 0, 'no activity left');
  ok('batches add up, and remove takes them all');
}

// 7. The admin console's actions: the overview counts the demo players; add and remove them.
{
  const admin = createAdminData({ db, accounts: { removePicture() {} }, now: () => NOW });
  const added = admin.demo('add');
  expect(added.players === 50 && admin.overview().demoPlayers === 50, `the console adds 50 (${added.players}, counted ${admin.overview().demoPlayers})`);
  expect(admin.demo('remove').removed === 50 && admin.overview().demoPlayers === 0, 'the console removes them');
  let threw = null;
  try { admin.demo('both'); } catch (e) { threw = e.status; }
  expect(threw === 400, 'an unknown action is refused');
  ok('the admin console');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - demo players: ${testNo} spec checks`);
