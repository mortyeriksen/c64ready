// Spec tests for the games API (server/games.mjs on server/accounts.mjs): sets
// load from JSON, a game is found by its file hash, unlocks need an account and
// count once, a leaderboard keeps each account's best by its own order, ranks
// share ties, deleting an account takes its results with it, and reloading the
// sets keeps everyone's results. The public views: the list of games, the
// activity feeds (everyone's and one game's, newest first, in pages) and a
// player's profile. Accounts and sessions are made directly in the
// database here; passkey sign-in has its own test (accounts-spec-test.js).

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccounts } from '../../server/accounts.mjs';
import { openDatabase } from '../../server/db.mjs';
import { gameRoutes, loadSets, checkSet } from '../../server/games.mjs';

let testNo = 0, failing = 0, current = [];
function expect(cond, msg) { if (!cond) current.push(msg); }
function ok(label) {
  testNo++;
  if (!current.length) console.log(`ok  - test ${testNo}: ${label}`);
  else {
    failing++;
    console.log(`FAIL test ${testNo}: ${label}`);
    for (const m of current) console.log(`     - ${m}`);
    current = [];
  }
}

const HASH = 'aa'.repeat(16), HASH2 = 'bb'.repeat(16), OTHER = 'cc'.repeat(16);
const sets = fs.mkdtempSync(path.join(os.tmpdir(), 'c64sets-'));
const write = (name, set) => fs.writeFileSync(path.join(sets, name), JSON.stringify(set));
write('demo.json', {
  id: 'demo', title: 'Demo Game', hashes: [{ hash: HASH, label: 'disk' }, { hash: HASH2, label: 'cartridge' }],
  achievements: [
    { id: 1, title: 'First', description: 'Do the first thing.', points: 5, memaddr: '0xH0010=1' },
    { id: 2, title: 'Second', description: 'Do the second thing.', points: 10, memaddr: '0xH0010=2' },
  ],
  leaderboards: [
    { id: 1, title: 'High Score', description: 'Most points.', format: 'SCORE', lowerIsBetter: false, definition: 'STA:0=1::CAN:0=1::SUB:0=1::VAL:0xH0020' },
    { id: 2, title: 'Fastest', description: 'Least time.', format: 'FRAMES', lowerIsBetter: true, definition: 'STA:0=1::CAN:0=1::SUB:0=1::VAL:0xH0021' },
  ],
});

let clock = 1_700_000_000_000;
const db = openDatabase(':memory:');
loadSets(db, sets);
const accounts = createAccounts({ db, origins: ['https://c64ready.com'], now: () => clock, extend: gameRoutes });
const server = http.createServer((req, res) => { if (!accounts.handleRequest(req, res)) res.writeHead(404).end(); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

/** An account with a session, straight into the database. */
function account(name) {
  const id = Number(db.prepare('INSERT INTO users (name, name_key, handle, created_at) VALUES (?, ?, ?, ?)').run(name, name.toLowerCase(), crypto.randomBytes(16), clock).lastInsertRowid);
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
    .run(crypto.createHash('sha256').update(token).digest('hex'), id, clock, clock + 1e10, clock);
  return { id, token };
}
// The session as just confirmed by a passkey: deleting the account needs that.
const confirm = (who) => db.prepare('UPDATE sessions SET confirmed_at = ? WHERE user_id = ?').run(clock, who.id);
async function api(method, url, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json', Origin: 'https://c64ready.com' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}
const ann = account('Ann'), ben = account('Ben'), cat = account('Cat');

// 1. Set files are checked before they load.
{
  const bad = (patch) => { try { checkSet({ id: 'x', title: 'X', hashes: [{ hash: HASH }], ...patch }); return false; } catch { return true; } };
  expect(bad({ id: 'Not A Slug' }), 'an id must be a slug');
  expect(bad({ hashes: [{ hash: 'nothex' }] }), 'a hash must be 32 hex digits');
  expect(bad({ achievements: [{ id: 1, title: 'A', description: 'a', memaddr: '1=1' }, { id: 1, title: 'B', description: 'b', memaddr: '1=1' }] }), 'achievement ids are unique');
  expect(bad({ leaderboards: [{ id: 1, title: 'L', description: 'l', format: 'NOPE', definition: 'STA:1::CAN:1::SUB:1::VAL:1' }] }), 'a leaderboard format must be an rcheevos one');
  expect(bad({ leaderboards: [{ id: 1, title: 'L', description: 'l', format: 'SCORE', definition: 'VAL:1' }] }), 'a leaderboard needs STA, CAN, SUB and VAL');
  ok('set files are checked');
}

// 2. Finding a game by its file hash.
{
  const g = await api('GET', `/api/games/${HASH}`);
  expect(g.status === 200 && g.body.game.title === 'Demo Game', 'a known hash finds its game');
  expect(g.body.achievements.map((a) => a.title).join() === 'First,Second' && g.body.achievements[0].memaddr === '0xH0010=1', 'its achievements come in set order, with their conditions');
  expect(g.body.leaderboards.length === 2 && g.body.leaderboards[1].lowerIsBetter === true, 'and its leaderboards');
  expect(g.body.files.map((f) => `${f.hash === HASH ? 'A' : 'B'}:${f.label}`).join() === 'A:disk,B:cartridge', 'and the versions of the game the set is for, in set order');
  expect(JSON.stringify(g.body.unlocked) === '[]', 'signed out, nothing is unlocked');
  const g2 = await api('GET', `/api/games/${HASH2}`);
  expect(g2.status === 200 && g2.body.game.id === 'demo', 'every hash a set lists finds the same game');
  expect((await api('GET', `/api/games/${OTHER}`)).status === 404, 'an unknown hash is not a game');
  expect((await api('GET', '/api/games/nothex')).status === 400, 'a malformed hash is refused');
  ok('games are found by hash');
}

// 3. Unlocks.
{
  const anon = await api('POST', `/api/games/${HASH}/unlocks`, { body: { achievementId: 1 } });
  expect(anon.status === 401, 'unlocking needs an account');
  const first = await api('POST', `/api/games/${HASH}/unlocks`, { token: ann.token, body: { achievementId: 1, hardcore: false } });
  const again = await api('POST', `/api/games/${HASH2}/unlocks`, { token: ann.token, body: { achievementId: 1 } });
  expect(first.status === 200 && first.body.new === true, 'a first unlock is new');
  expect(again.status === 200 && again.body.new === false, 'unlocking again, from another of the game\'s files, is not new');
  expect((await api('POST', `/api/games/${HASH}/unlocks`, { token: ann.token, body: { achievementId: 99 } })).status === 404, 'an achievement the game does not have is refused');
  const mine = await api('GET', `/api/games/${HASH}`, { token: ann.token });
  expect(JSON.stringify(mine.body.unlocked) === '[1]', 'the game lists the account\'s unlocks');
  expect(mine.body.unlocks.length === 1 && mine.body.unlocks[0].id === 1 && mine.body.unlocks[0].at === clock, 'with when each was unlocked');
  const theirs = await api('GET', `/api/games/${HASH}`, { token: ben.token });
  expect(JSON.stringify(theirs.body.unlocked) === '[]', 'and only its own');
  ok('unlocks need an account and count once');
}

// 4. Leaderboards: best per account, by the board's own order, ranks with ties.
{
  // Minutes apart, so each best is its own entry in the activity.
  const post = (who, id, value) => { clock += 6 * 60_000; return api('POST', `/api/games/${HASH}/leaderboards/${id}/entries`, { token: who.token, body: { value } }); };
  expect((await api('POST', `/api/games/${HASH}/leaderboards/1/entries`, { body: { value: 5 } })).status === 401, 'posting needs an account');
  const a1 = await post(ann, 1, 500);
  const a2 = await post(ann, 1, 300);
  expect(a1.body.improved && !a2.body.improved && a2.body.best === 500, 'a higher-is-better board keeps the best (500 over 300)');
  await post(ben, 1, 800); await post(cat, 1, 500);
  const top = await api('GET', `/api/games/${HASH}/leaderboards/1`, { token: ann.token });
  expect(top.body.entries.map((e) => `${e.name}:${e.value}`).join() === 'Ben:800,Ann:500,Cat:500', 'entries are ordered best first, earlier first on a tie');
  expect(top.body.me.rank === 2, 'Ann and Cat tie for second');
  expect(top.body.entries.map((e) => e.rank).join() === '1,2,2', `the listed ranks share the tie too (got ${top.body.entries.map((e) => e.rank)})`);
  expect(top.body.players === 3, 'and the board counts its players');
  const f1 = await post(ann, 2, 900);
  const f2 = await post(ann, 2, 700);
  expect(f1.body.improved && f2.body.improved && f2.body.best === 700, 'a lower-is-better board keeps the lowest (700 over 900)');
  expect((await post(ann, 1, 1.5)).status === 400 && (await post(ann, 1, 2 ** 31)).status === 400, 'a value is a 32-bit integer');
  expect((await api('GET', `/api/games/${HASH}/leaderboards/9`)).status === 404, 'an unknown leaderboard is refused');
  ok('leaderboards keep each account\'s best and rank ties together');
}

// 5. Activity is recorded for new unlocks and better scores only.
{
  const rows = db.prepare('SELECT kind, ref, value FROM activity WHERE user_id = ? ORDER BY id').all(ann.id);
  expect(rows.map((r) => `${r.kind}:${r.ref}:${r.value ?? ''}`).join() === 'unlock:1:,score:1:500,score:2:900,score:2:700', `activity records firsts and improvements (got ${rows.map((r) => `${r.kind}:${r.ref}:${r.value ?? ''}`)})`);
  const feed = (await api('GET', '/api/activity')).body.items.filter((x) => x.user.name === 'Ann').reverse();
  expect(feed[0]?.game.title === 'Demo Game' && feed[0].game.hash === HASH && feed[0].achievement.title === 'First' && feed[0].achievement.points === 5, 'the feed names an unlock\'s game and achievement');
  expect(feed[1]?.leaderboard.title === 'High Score' && feed[1].leaderboard.format === 'SCORE' && feed[1].value === 500, 'and a new best\'s board, its format and the value');
  ok('activity');
}

// 6. Reloading the sets keeps results; deleting an account removes its own.
{
  loadSets(db, sets);
  const mine = await api('GET', `/api/games/${HASH}`, { token: ann.token });
  expect(JSON.stringify(mine.body.unlocked) === '[1]', 'reloading the sets keeps unlocks');
  confirm(ben);
  await api('DELETE', '/api/me', { token: ben.token });
  const top = await api('GET', `/api/games/${HASH}/leaderboards/1`);
  expect(!top.body.entries.some((e) => e.name === 'Ben'), 'a deleted account\'s entries go with it');
  ok('results survive set reloads; account deletion removes them');
}

// 7. The list of games.
{
  write('second.json', { id: 'second', title: 'Another Game', hashes: [{ hash: OTHER }],
    achievements: [{ id: 1, title: 'Only', description: 'The only one.', points: 3, memaddr: '0xH0010=9' }] });
  loadSets(db, sets);
  const { body } = await api('GET', '/api/games');
  const demo = body.games.find((g) => g.id === 'demo');
  expect(body.games.map((g) => g.title).join() === 'Another Game,Demo Game', 'games are listed by title');
  expect(demo.hash === HASH && demo.achievements === 2 && demo.points === 15 && demo.leaderboards === 2, 'with the first hash of the set, and the size of the set');
  expect(JSON.stringify(demo.hashes) === JSON.stringify([HASH, HASH2]), 'and every file hash it is for, so the app can match files itself');
  expect(demo.players === 2 && body.games[0].players === 0, `and how many have played (got ${demo.players})`);
  expect(body.games.every((g) => !('mine' in g)), 'signed out, it carries no progress of anyone\'s');
  const signed = (await api('GET', '/api/games', { token: ann.token })).body.games;
  const annDemo = signed.find((g) => g.id === 'demo');
  expect(annDemo.mine?.unlocked === 1 && annDemo.mine.points === 5 && signed.find((g) => g.id === 'second').mine?.unlocked === 0, 'signed in, each game carries the account\'s own unlocks and points');
  const annLast = db.prepare("SELECT MAX(at) AS at FROM activity WHERE user_id = ? AND game_id = 'demo'").get(ann.id).at;
  expect(annDemo.mine.last === annLast && !signed.find((g) => g.id === 'second').mine.last, `and when the account last played it (got ${annDemo.mine.last}, its last activity ${annLast})`);
  const dee = account('Dee');
  clock += 60_000;
  await api('POST', `/api/games/${HASH}/leaderboards/1/entries`, { token: dee.token, body: { value: 300 } });
  const deeDemo = (await api('GET', '/api/games', { token: dee.token })).body.games.find((g) => g.id === 'demo');
  expect(deeDemo.mine.unlocked === 0 && deeDemo.mine.last === clock, `a score alone counts as playing the game (got ${JSON.stringify(deeDemo.mine)})`);
  confirm(dee);
  await api('DELETE', '/api/me', { token: dee.token });
  ok('the list of games');
}

// 8. Activity feeds: newest first, everyone's or one game's, in pages.
{
  await api('POST', `/api/games/${OTHER}/unlocks`, { token: cat.token, body: { achievementId: 1 } });
  const all = (await api('GET', '/api/activity')).body;
  const newest = all.items[0];
  expect(newest.kind === 'unlock' && newest.user.name === 'Cat' && newest.game.title === 'Another Game' && newest.achievement.title === 'Only' && newest.achievement.points === 3, 'the newest unlock comes first, with who, which game and which achievement');
  expect(all.items.every((x, i) => !i || all.items[i - 1].id > x.id), 'the feed is newest first');
  const score = all.items.find((x) => x.kind === 'score');
  expect(score.leaderboard.title && score.leaderboard.format && Number.isInteger(score.value), 'a new best carries its leaderboard and value');
  const one = (await api('GET', `/api/games/${HASH2}/activity`)).body;
  expect(one.items.length && one.items.every((x) => x.game.id === 'demo'), 'a game\'s feed holds only that game (found by any of its hashes)');
  // Bests minutes apart: each is its own entry in the feed.
  for (let v = 1000; v < 1035; v++) { clock += 6 * 60_000; await api('POST', `/api/games/${HASH}/leaderboards/1/entries`, { token: cat.token, body: { value: v } }); }
  const p1 = (await api('GET', '/api/activity')).body;
  const p2 = (await api('GET', `/api/activity?before=${p1.items.at(-1).id}`)).body;
  expect(p1.items.length === 30 && p1.more, 'a page holds 30, and says there is more');
  expect(p2.items[0].id < p1.items.at(-1).id && !p2.items.some((x) => p1.items.some((y) => y.id === x.id)), 'the next page carries on where it ended');
  ok('activity feeds');
}

// 8b. Scores cannot flood the feed: a few at once, and a run of bests is one entry.
{
  clock += 6 * 60_000;
  const feedBefore = (await api('GET', '/api/activity')).body.items[0].id;
  const statuses = [];
  for (let v = 5000; v < 5011; v++) statuses.push((await api('POST', `/api/games/${HASH}/leaderboards/1/entries`, { token: cat.token, body: { value: v } })).status);
  expect(statuses.slice(0, 10).every((x) => x === 200) && statuses[10] === 429, `ten posts at once, then the player waits (got ${statuses})`);
  const fresh = (await api('GET', '/api/activity')).body.items.filter((x) => x.id > feedBefore);
  expect(fresh.length === 1 && fresh[0].value === 5009, `the run of bests is one entry in the feed, with the latest (got ${fresh.map((x) => x.value)})`);
  const mine = (await api('GET', `/api/games/${HASH}/leaderboards/1`, { token: cat.token })).body.me;
  expect(mine.value === 5009, 'while the leaderboard keeps the best');
  expect((await api('POST', `/api/games/${HASH}/unlocks`, { token: cat.token, body: { achievementId: 2 } })).status === 429, 'unlocks share the limit, so a whole set cannot pour into the feed at once');
  // A run of bests minutes apart: the entry keeps the run's first time, so a new
  // entry follows once that is five minutes ago, however often bests come.
  clock += 6 * 60_000;
  const runFrom = (await api('GET', '/api/activity')).body.items[0].id;
  for (const [v, step] of [[7000, 0], [7100, 4], [7200, 4]]) { clock += step * 60_000; await api('POST', `/api/games/${HASH}/leaderboards/1/entries`, { token: cat.token, body: { value: v } }); }
  const run = (await api('GET', '/api/activity')).body.items.filter((x) => x.id > runFrom);
  expect(run.map((x) => x.value).join() === '7200,7100', `bests 4 minutes apart: the second folds into the first, the third (8 minutes on) is new (got ${run.map((x) => x.value)})`);
  ok('posts cannot flood the feed');
}

// 8c. The Hall of Fame: players by achievement points, earlier first on equal points, which share a place.
{
  const hof = ['H1', 'H2', 'H3', 'H4'].map((n) => account(n));
  const unlock = async (who, id) => { clock += 60_000; await api('POST', `/api/games/${HASH}/unlocks`, { token: who.token, body: { achievementId: id } }); };
  await unlock(hof[0], 1); await unlock(hof[0], 2);   // 15, the whole set
  await unlock(hof[1], 2);                            // 10
  await unlock(hof[2], 2);                            // 10, later
  await unlock(hof[3], 1);                            // 5
  const top = (await api('GET', `/api/games/${HASH}/top?limit=100`)).body;
  const mine = hof.map((p) => top.entries.find((e) => e.user.id === p.id));
  expect(top.total === 2, 'it knows how many achievements the game has');
  expect(mine[0].rank === 1 && mine[0].points === 15 && mine[0].unlocked === 2 && mine[0].complete, `the whole set is first, and marked complete (got ${JSON.stringify(mine[0])})`);
  expect(mine[1].rank === mine[2].rank && top.entries.indexOf(mine[1]) < top.entries.indexOf(mine[2]), 'equal points share a place, the earlier first');
  expect(mine[3].rank > mine[2].rank && !mine[3].complete, 'fewer points come after');
  expect(top.complete >= 1 && top.players >= 4, 'and it counts the players and the finished sets');
  const short = (await api('GET', `/api/games/${HASH}/top?limit=1`, { token: hof[3].token })).body;
  expect(short.entries.length === 1 && short.me?.rank === mine[3].rank && short.me.points === 5, 'a player further down sees their own place');
  ok('the Hall of Fame');
}

// 9. A leaderboard can list more than ten, up to a hundred.
{
  for (let i = 0; i < 12; i++) { const p = account(`P${i}`); clock += 10; await api('POST', `/api/games/${HASH}/leaderboards/1/entries`, { token: p.token, body: { value: i } }); }
  expect((await api('GET', `/api/games/${HASH}/leaderboards/1`)).body.entries.length === 10, 'ten by default');
  expect((await api('GET', `/api/games/${HASH}/leaderboards/1?limit=50`)).body.entries.length === 14, 'more on request');
  expect((await api('GET', `/api/games/${HASH}/leaderboards/1?limit=5000`)).body.entries.length === 14, 'a limit over a hundred is held to a hundred');
  ok('longer leaderboards');
}

// 10. A player's profile.
{
  const { status, body } = await api('GET', `/api/users/${ann.id}`);
  const demo = body.games?.find((g) => g.id === 'demo');
  expect(status === 200 && body.user.name === 'Ann' && body.user.since, 'a profile names the player and when they joined');
  expect(demo && demo.unlocked === 1 && demo.total === 2 && demo.points === 5 && demo.totalPoints === 15 && body.points === 5, 'it counts unlocks and points per game, and in all');
  expect(demo.achievements.map((a) => a.title).join() === 'First', 'it lists what was unlocked');
  expect(JSON.stringify(demo.ids) === '[1,2]', 'and every achievement of the game in set order');
  expect(demo.scores.map((x) => `${x.title}:${x.value}`).join() === 'High Score:500,Fastest:700' && demo.scores[0].rank > 1, 'and the best scores with their rank');
  expect(body.recent.length && body.recent.every((x) => x.user.id === ann.id), 'and the player\'s own recent activity');
  expect((await api('GET', '/api/users/999999')).status === 404 && (await api('GET', '/api/users/abc')).status === 404, 'an unknown player is not found');
  ok('player profiles');
}

// 11. An achievement a set drops leaves the feeds, and a game whose set is gone is retired.
{
  write('second.json', { id: 'second', title: 'Another Game', hashes: [{ hash: OTHER }], achievements: [] });
  loadSets(db, sets);
  const all = (await api('GET', '/api/activity?before=999999')).body.items;
  expect(!all.some((x) => x.game.id === 'second'), 'unlocks of a dropped achievement are not shown');
  fs.rmSync(path.join(sets, 'second.json'));
  loadSets(db, sets);
  const list = (await api('GET', '/api/games')).body.games;
  expect(!list.some((g) => g.id === 'second') && (await api('GET', `/api/games/${OTHER}`)).status === 404, 'a game whose set file is gone leaves the list and is not found');
  expect(db.prepare("SELECT COUNT(*) AS n FROM unlocks WHERE game_id = 'second'").get().n === 1, 'while its players\' unlocks are kept, in case the set returns');
  ok('dropped achievements and games leave the views, not the results');
}

accounts.close();
server.close();
fs.rmSync(sets, { recursive: true, force: true });
if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - games API: ${testNo} checks`);
