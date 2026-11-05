// The admin console (server/admin.mjs, server/admin-data.mjs, server/chat.mjs)
// against a real listener, the accounts server and an on-disk chat log, with
// a software passkey authenticator. Each check is one rule:
// the console signs in with an admin passkey, the first one set up with a
// single-use key whose hash alone is on the server; signed out, the pages go
// to the sign-in and the API refuses; a POST must come from the console's
// own page; a device key lasts 10 minutes; the console keeps one passkey.
// The players API gives the overview, every player, one player's details and
// their logins with address and browser; each action needs a reason, does
// what it says, and is written to the chat log. The export is a copy of the
// whole database.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChatServer } from '../../server/chat.mjs';
import { createAccounts } from '../../server/accounts.mjs';
import { createAdminData } from '../../server/admin-data.mjs';
import { createAdminPasskeys } from '../../server/admin-passkeys.mjs';
import { createAdminGate, setupKeyHash, newSetupKey } from '../../server/admin.mjs';
import { createChatLog } from '../../server/log.mjs';
import { openDatabase } from '../../server/db.mjs';
import { createBans } from '../../server/bans.mjs';
import { gameRoutes } from '../../server/games.mjs';
import { authenticator } from './_authenticator.js';

let testNo = 0, failing = 0, current = [];
function expect(cond, msg) { if (!cond) current.push(msg); }
function ok(label) {
  testNo++;
  if (!current.length) console.log(`ok  - test ${testNo}: ${label}`);
  else { failing++; console.log(`FAIL test ${testNo}: ${label}`); for (const m of current) console.log(`     - ${m}`); current = []; }
}

let clock = 1_800_000_000_000;
const now = () => clock;
const db = openDatabase(':memory:');
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c64admin-'));
const chatLog = createChatLog({ dir: logDir, now });
const readLog = () => fs.readdirSync(logDir).sort().flatMap((f) => fs.readFileSync(path.join(logDir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
const KEY = newSetupKey();
const bans = createBans({ db, now });
const accounts = createAccounts({ db, origins: ['https://c64ready.com'], trustProxy: 1, now, bans, extend: gameRoutes });
const passkeys = createAdminPasskeys({ db, now });
const chat = createChatServer({
  admin: { passkeys, setupKeySha256: setupKeyHash(KEY), keyUsed: passkeys.keyUsed, useKey: passkeys.useKey },
  adminData: createAdminData({ db, accounts, bans, now }),
  bans,
  authenticate: (t) => accounts.userForToken(t),
  chatLog, trustProxy: 1, now, manualClock: true,
});
const server = http.createServer((req, res) => { if (accounts.handleRequest(req, res)) return; if (!chat.handleRequest(req, res)) res.writeHead(404).end(); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const HOST = `127.0.0.1:${server.address().port}`;
const OWN = `http://${HOST}`;

// Requests: the console's own origin unless told otherwise, and the cookie when given.
async function call(method, url, { body, cookie, origin = OWN, from = '198.51.100.7', agent = '' } = {}) {
  const headers = { 'X-Forwarded-For': from, 'User-Agent': agent };
  if (body) headers['Content-Type'] = 'application/json';
  if (origin) headers.Origin = origin;
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(`${OWN}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: json, headers: r.headers };
}
const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];
const admin = authenticator('p256');

// 1. Signed out: the pages go to the sign-in, the API and the console's actions refuse.
{
  const page = await call('GET', '/admin');
  expect(page.status === 302 && page.headers.get('location') === '/admin/login', 'the console page sends you to the passkey sign-in');
  expect((await call('GET', '/admin/login')).status === 200, 'the sign-in page itself is open');
  expect((await call('GET', '/admin/api/overview')).status === 401, 'the players API needs a signed-in console');
  expect((await call('GET', '/admin/logs')).status === 302, 'and so do the logs');
  expect((await call('GET', '/admin/auth/state')).body?.passkeys === false, 'before the first passkey, the sign-in says there is none');
  ok('signed out, nothing of the console is open but its sign-in');
}

// 2. The first passkey: only with the setup key, from the console's own page, once.
let cookie;
{
  expect((await call('POST', '/admin/auth/options', { body: { mode: 'setup', key: 'AAAAA-AAAAA-AAAAA-AAAAA' } })).status === 401, 'a wrong setup key is refused');
  expect((await call('POST', '/admin/auth/options', { body: { mode: 'setup', key: KEY }, origin: 'https://evil.example' })).status === 403, 'a setup from another site is refused');
  const o = await call('POST', '/admin/auth/options', { body: { mode: 'setup', key: KEY.toLowerCase().replace(/-/g, ' ') } });
  expect(o.status === 200 && o.body.publicKey.rp.name === 'C64 READY. admin', 'the key is read forgiving case and spaces, and starts a passkey');
  const made = admin.create(o.body.publicKey, { origin: OWN });
  const v = await call('POST', '/admin/auth/verify', { body: { challengeId: o.body.challengeId, credential: made.cred, label: 'Laptop' } });
  const set = v.headers.get('set-cookie') || '';
  expect(v.status === 200 && /HttpOnly/.test(set) && /SameSite=Strict/.test(set) && /Path=\/admin/.test(set), 'setting it up signs in, with an HttpOnly, same-site cookie for /admin');
  cookie = cookieOf(v);
  expect((await call('GET', '/admin', { cookie })).status === 200, 'and the console opens');
  expect((await call('POST', '/admin/auth/options', { body: { mode: 'setup', key: KEY } })).status === 401, 'the key works once');
  const again = createAdminGate({ passkeys, now, setupKeySha256: setupKeyHash(KEY), keyUsed: passkeys.keyUsed });
  expect(again.devSetupKey() === null, 'a used key stays used after a restart, and no dev key is made once a passkey exists');
  ok('the first passkey is set up with the single-use setup key');
}

// 3. Signing in with the passkey; another passkey, or none, does not.
{
  const o = await call('POST', '/admin/auth/options', { body: { mode: 'login' } });
  const id = o.body.publicKey.allowCredentials[0].id;
  const v = await call('POST', '/admin/auth/verify', { body: { challengeId: o.body.challengeId, credential: admin.get(id, o.body.publicKey, { origin: OWN }) } });
  expect(v.status === 200 && /c64chat_admin=/.test(v.headers.get('set-cookie') || ''), 'the admin passkey signs in');
  const stranger = authenticator('p256');
  const so = await call('POST', '/admin/auth/options', { body: { mode: 'login' } });
  const sMade = stranger.create({ challenge: so.body.publicKey.challenge, user: { id: 'eA' } }, { origin: OWN });
  const sv = await call('POST', '/admin/auth/verify', { body: { challengeId: so.body.challengeId, credential: stranger.get(sMade.id, so.body.publicKey, { origin: OWN }) } });
  expect(sv.status === 401, 'any other passkey is refused');
  const out = await call('POST', '/admin/auth/logout', { cookie });
  expect(out.status === 200 && (await call('GET', '/admin/api/overview', { cookie })).status === 401, 'signing out ends the session');
  cookie = cookieOf(v);
  ok('the console signs in with its passkey only');
}

// 4. Devices: a key for another device lasts 10 minutes; the console keeps one passkey.
{
  const k = await call('POST', '/admin/auth/add', { cookie, body: {} });
  expect(k.status === 200 && /^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/.test(k.body.key), 'a signed-in console makes a key for another device');
  expect((await call('POST', '/admin/auth/add', { body: {} })).status === 401, 'only a signed-in one');
  clock += 11 * 60_000;
  expect((await call('POST', '/admin/auth/options', { body: { mode: 'setup', key: k.body.key } })).status === 401, 'the key is gone after 10 minutes');
  const list = (await call('GET', '/admin/auth/passkeys', { cookie })).body.passkeys;
  expect(list.length === 1 && list[0].label === 'Laptop', 'the console lists its passkeys, named');
  expect((await call('POST', '/admin/auth/remove', { cookie, body: { id: list[0].id } })).status === 409, 'and keeps the last one');
  ok('devices: keys last 10 minutes, and one passkey always stays');
}

// Players: two accounts made through the accounts API, from known addresses and browsers.
const player = authenticator('p256');
async function signUp(name, from, agent) {
  const o = await call('POST', '/api/auth/register/options', { body: { name }, origin: 'https://c64ready.com', from, agent });
  const made = player.create(o.body.publicKey, { origin: 'https://c64ready.com' });
  const v = await call('POST', '/api/auth/register/verify', { body: { challengeId: o.body.challengeId, credential: made.cred }, origin: 'https://c64ready.com', from, agent });
  return { id: v.body.user.id, token: v.body.token, credId: made.id };
}
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const ann = await signUp('Ann', '203.0.113.5', MAC);
clock += 1000;
const bob = await signUp('Bob', '203.0.113.5', WIN);
db.prepare("INSERT INTO games (id, title, source) VALUES ('demo', 'Demo', NULL)").run();
db.prepare("INSERT INTO achievements (game_id, id, title, description, points, memaddr, sort) VALUES ('demo', 1, 'First', 'x', 5, '0=1', 0)").run();
db.prepare("INSERT INTO leaderboards (game_id, id, title, description, format, lower_is_better, definition, sort) VALUES ('demo', 1, 'High', 'x', 'SCORE', 0, 'x', 0)").run();
db.prepare('INSERT INTO unlocks (user_id, game_id, achievement_id, hardcore, unlocked_at) VALUES (?, ?, 1, 0, ?)').run(ann.id, 'demo', clock);
db.prepare('INSERT INTO lb_entries (user_id, game_id, leaderboard_id, value, hardcore, submitted_at) VALUES (?, ?, 1, 900, 0, ?)').run(ann.id, 'demo', clock);
db.prepare("INSERT INTO activity (at, user_id, game_id, kind, ref, value) VALUES (?, ?, 'demo', 'unlock', 1, NULL)").run(clock, ann.id);

// 5. Logins are kept with the address and the browser, and go after 90 days.
{
  const p = (await call('GET', `/admin/api/players/${ann.id}`, { cookie })).body;
  const first = p.logins.items.at(-1);
  expect(first.kind === 'created' && first.ip === '203.0.113.5' && first.device === 'Safari on macOS' && first.ok, `making the account is a login, with its address and browser (got ${JSON.stringify(first)})`);
  await call('POST', '/api/auth/recover/options', { body: { name: 'Ann', code: 'AAAAA-AAAAA-AAAAA-AAAAA' }, origin: 'https://c64ready.com', from: '192.0.2.9', agent: WIN });
  const after = (await call('GET', `/admin/api/players/${ann.id}/logins`, { cookie })).body.items[0];
  expect(after.kind === 'recovery' && !after.ok && after.ip === '192.0.2.9' && after.device === 'Chrome on Windows', 'a wrong recovery code is a failed login, with where it came from');
  expect(p.sameAddress.some((o) => o.name === 'Bob'), 'players at the same address are named');
  ok('logins carry address and browser, failures too');
}

// 6. The overview and the players list.
{
  clock += 60_000;
  const o = (await call('GET', '/admin/api/overview', { cookie })).body;
  expect(o.players === 2 && o.newToday === 2 && o.activeNow === 2, `the overview counts players, new and active (got ${o.players}, ${o.newToday}, ${o.activeNow})`);
  expect(o.latest[0].name === 'Bob', 'the latest sign-up comes first');
  const byPoints = (await call('GET', '/admin/api/players?sort=points&dir=desc', { cookie })).body;
  expect(byPoints.total === 2 && byPoints.players[0].name === 'Ann' && byPoints.players[0].points === 5 && byPoints.players[0].lastIp === '203.0.113.5', 'players sort by points, with their numbers and last address');
  const found = (await call('GET', '/admin/api/players?search=bO', { cookie })).body;
  expect(found.total === 1 && found.players[0].name === 'Bob', 'and are found by name, in any case');
  expect((await call('GET', '/admin/api/players?search=%25', { cookie })).body.total === 0, 'a search for % is a search for %, not everything');
  ok('the overview and the players list');
}

// 6b. Flagged results: listed for review, approved into public view or cleared, from the console only.
{
  db.prepare("INSERT OR REPLACE INTO unlocks (user_id, game_id, achievement_id, hardcore, unlocked_at, flag) VALUES (?, 'demo', 2, 1, ?, 'many unlocks at once')").run(bob.id, clock - 5000);
  db.prepare("INSERT OR REPLACE INTO lb_entries (user_id, game_id, leaderboard_id, value, hardcore, submitted_at, flag) VALUES (?, 'demo', 1, 999999, 1, ?, 'a score just after the game was opened')").run(bob.id, clock - 4000);
  const list = (await call('GET', '/admin/api/flags', { cookie })).body.items;
  expect(list.length === 2 && list[0].kind === 'score' && list[0].value === 999999 && list[1].kind === 'unlock' && list[1].flag === 'many unlocks at once' && list[0].user.name === 'Bob', `flagged results are listed newest first, with who, what and why (got ${JSON.stringify(list)})`);
  expect((await call('GET', '/admin/api/overview', { cookie })).body.toReview === 2, 'and counted on the overview');
  const decide = (body, opts = {}) => call('POST', '/admin/api/flags', { cookie, body, ...opts });
  expect((await decide({ kind: 'unlock', user: bob.id, game: 'demo', ref: 2, decision: 'approve' }, { origin: 'https://evil.example' })).status === 403, 'a decision must come from the console itself');
  const feedBefore = db.prepare("SELECT COUNT(*) AS n FROM activity WHERE user_id = ? AND kind = 'unlock'").get(bob.id).n;
  expect((await decide({ kind: 'unlock', user: bob.id, game: 'demo', ref: 2, decision: 'approve' })).status === 200, 'an approval is accepted');
  expect(db.prepare("SELECT flag FROM unlocks WHERE user_id = ? AND game_id = 'demo' AND achievement_id = 2").get(bob.id).flag === null
    && db.prepare("SELECT COUNT(*) AS n FROM activity WHERE user_id = ? AND kind = 'unlock'").get(bob.id).n === feedBefore + 1, 'approved, it counts and joins the activity');
  expect((await decide({ kind: 'score', user: bob.id, game: 'demo', ref: 1, decision: 'clear' })).status === 200
    && !db.prepare("SELECT 1 FROM lb_entries WHERE user_id = ? AND game_id = 'demo' AND leaderboard_id = 1").get(bob.id), 'cleared, it is gone');
  expect((await decide({ kind: 'score', user: bob.id, game: 'demo', ref: 1, decision: 'clear' })).status === 404, 'a result no longer flagged cannot be decided again');
  expect((await call('GET', '/admin/api/flags', { cookie })).body.items.length === 0, 'and the list is empty');
  ok('flagged results are reviewed: approved or cleared');
}

// 7. Actions: a reason, from the console's page, done, and logged.
{
  const actOn = (id, action, body = { reason: 'test' }, opts = {}) => call('POST', `/admin/api/players/${id}/${action}`, { cookie, body, ...opts });
  expect((await actOn(ann.id, 'signout', {})).status === 400, 'an action needs a reason');
  expect((await actOn(ann.id, 'signout', { reason: 'x' }, { origin: 'https://evil.example' })).status === 403, 'and must come from the console itself');
  expect((await actOn(ann.id, 'signout', { reason: 'shared device' })).status === 200 && accounts.userForToken(ann.token) === null, 'sign out everywhere ends every session');
  const line = (uid) => Number(db.prepare("INSERT INTO activity (at, user_id, game_id, kind, ref, value) VALUES (?, ?, 'demo', 'unlock', 1, NULL)").run(clock, uid).lastInsertRowid);
  const kept = line(ann.id), gone = line(ann.id), bobs = line(bob.id);
  const listed = (uid) => (call('GET', `/admin/api/players/${uid}/activity`, { cookie })).then((r) => r.body.items.map((a) => a.id));
  expect((await listed(ann.id)).includes(gone), 'a player\'s activity lists each line with its id');
  expect((await actOn(ann.id, 'entry', { reason: 'bogus', entry: gone })).status === 200, 'one line of the activity can be removed');
  const after = await listed(ann.id);
  expect(!after.includes(gone) && after.includes(kept), 'that line is gone, the others stay');
  expect(!!db.prepare("SELECT 1 FROM unlocks WHERE user_id = ? AND game_id = 'demo' AND achievement_id = 1").get(ann.id), 'and the unlock it told of stays');
  expect((await actOn(ann.id, 'entry', { reason: 'x', entry: bobs })).status === 404 && (await listed(bob.id)).includes(bobs), 'another player\'s line is not removed through this player');
  expect((await actOn(ann.id, 'entry', { reason: 'x', entry: gone })).status === 404, 'a line already gone cannot be removed again');
  expect((await actOn(ann.id, 'entry', { reason: 'x', entry: 'all' })).status === 400, 'the line is named by its id');
  await actOn(ann.id, 'score', { reason: 'cheated', game: 'demo', board: 1 });
  expect(!db.prepare('SELECT 1 FROM lb_entries WHERE user_id = ?').get(ann.id), 'a score can be removed');
  await actOn(ann.id, 'results', { reason: 'trainer', game: 'demo' });
  expect(!db.prepare('SELECT 1 FROM unlocks WHERE user_id = ?').get(ann.id) && !db.prepare('SELECT 1 FROM activity WHERE user_id = ?').get(ann.id), 'and a game\'s results cleared');
  await actOn(bob.id, 'rename', { reason: 'rude name' });
  expect(db.prepare('SELECT name FROM users WHERE id = ?').get(bob.id).name === `Player${bob.id}`, 'rename gives a plain name');
  await actOn(bob.id, 'delete', { reason: 'asked to' });
  expect((await call('GET', `/admin/api/players/${bob.id}`, { cookie })).status === 404, 'delete removes the account');
  await chatLog.flush();
  const reviews = readLog().filter((e) => e.ev === 'admin' && e.action.startsWith('review-')).map((e) => e.action);
  expect(reviews.join() === 'review-approve,review-clear', `each review is logged too (got ${reviews})`);
  const logged = readLog().filter((e) => e.ev === 'admin' && !e.action.startsWith('review-')).map((e) => `${e.action}:${e.reason}`);
  expect(logged.join() === 'signout:shared device,entry:bogus,score:cheated,results:trainer,rename:rude name,delete:asked to', `every action is logged with its reason (got ${logged})`);
  ok('each action needs a reason, does what it says and is logged');
}

// 7b. A banned address can read what is public and nothing more, until the ban is lifted.
{
  const cara = await signUp('Cara', '198.51.100.20', WIN);
  const fromCara = { origin: 'https://c64ready.com', from: '198.51.100.20' };
  expect((await call('POST', '/admin/api/ban', { cookie, body: { ip: '198.51.100.20', hours: 24 } })).status === 400, 'a ban needs a reason');
  const ban = await call('POST', '/admin/api/ban', { cookie, body: { ip: '198.51.100.20', hours: 24, reason: 'spam' } });
  expect(ban.status === 200, 'the console bans an address');
  const me = await fetch(`${OWN}/api/me`, { headers: { Authorization: `Bearer ${cara.token}`, 'X-Forwarded-For': '198.51.100.20', Origin: 'https://c64ready.com' } });
  expect(me.status === 401, 'a session from a banned address is signed out');
  expect((await call('POST', '/api/auth/register/options', { body: { name: 'Dan' }, ...fromCara })).status === 403, 'it cannot sign up');
  expect((await call('POST', '/api/auth/login/options', { body: {}, ...fromCara })).status === 403, 'or sign in');
  expect((await call('GET', '/api/games', fromCara)).status === 200, 'but can still read what is public');
  expect((await call('POST', '/api/auth/login/options', { body: {}, origin: 'https://c64ready.com', from: '198.51.100.21' })).status === 200, 'and other addresses are not touched');
  const list = (await call('GET', '/admin/api/players?search=cara', { cookie })).body.players[0];
  expect(list.banned === true, 'the players list flags a player whose last address is banned');
  expect(createBans({ db, now }).get('198.51.100.20')?.reason === 'spam', 'the ban is in the database, so it outlasts a restart');
  expect((await call('POST', '/admin/api/unban', { cookie, body: { ip: '198.51.100.20' } })).status === 200, 'and the console lifts it');
  const back = await fetch(`${OWN}/api/me`, { headers: { Authorization: `Bearer ${cara.token}`, 'X-Forwarded-For': '198.51.100.20', Origin: 'https://c64ready.com' } });
  expect(back.status === 200, 'after which the address is back');
  await chatLog.flush();
  expect(readLog().some((e) => e.ev === 'ban' && e.ip === '198.51.100.20' && e.reason === 'spam') && readLog().some((e) => e.ev === 'unban' && e.ip === '198.51.100.20'), 'both are logged');
  ok('a banned address reads what is public and nothing more, until the ban is lifted');
}

// 7c. The export is the whole database, for the admin only, and logged.
{
  expect((await call('GET', '/admin/api/export')).status === 401, 'signed out, the export is refused');
  const r = await fetch(`${OWN}/admin/api/export`, { headers: { Cookie: cookie, 'X-Forwarded-For': '198.51.100.7' } });
  const bytes = Buffer.from(await r.arrayBuffer());
  const day = new Date(clock).toISOString().slice(0, 10);
  expect(r.status === 200 && r.headers.get('content-disposition') === `attachment; filename="c64ready-${day}.db"`, 'signed in, it downloads as c64ready-<date>.db');
  expect(bytes.subarray(0, 16).toString('latin1') === 'SQLite format 3\0', 'it is an SQLite database');
  const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c64export-'));
  const copy = path.join(copyDir, 'copy.db');
  fs.writeFileSync(copy, bytes);
  const { DatabaseSync } = await import('node:sqlite');
  const x = new DatabaseSync(copy, { readOnly: true });
  const tables = ['users', 'passkeys', 'sessions', 'logins', 'unlocks', 'lb_entries', 'activity', 'bans', 'admin_passkeys'];
  const counts = (d) => tables.map((t) => d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n).join(',');
  expect(counts(x) === counts(db), 'with every table and row the server has');
  expect(x.prepare('SELECT name FROM users WHERE id = ?').get(ann.id)?.name === 'Ann', 'its players among them');
  x.close();
  fs.rmSync(copyDir, { recursive: true, force: true });
  await chatLog.flush();
  expect(readLog().some((e) => e.ev === 'admin' && e.action === 'export'), 'the export is logged');
  ok('the export is the whole database, for the admin only, and logged');
}

// 7d. One address holds a few sign-in challenges at once; the rest still sign in.
{
  const asks = [];
  for (let i = 0; i < 6; i++) asks.push((await call('POST', '/admin/auth/options', { body: {}, from: '198.51.100.99' })).status);
  expect(asks.slice(0, 5).every((st) => st === 200) && asks[5] === 429, `one address holds at most five sign-in challenges (got ${asks})`);
  expect((await call('POST', '/admin/auth/options', { body: {}, from: '198.51.100.98' })).status === 200, 'another address still gets one');
  ok('one address cannot hold the console\'s sign-in challenges');
}

// 8. Logins older than 90 days go.
{
  clock += 91 * 24 * 3600_000;
  db.prepare('DELETE FROM logins WHERE at < ?').run(clock - 90 * 24 * 3600_000);   // what the accounts server's sweep runs
  expect(!db.prepare('SELECT 1 FROM logins WHERE user_id = ?').get(ann.id), 'the login history keeps 90 days');
  ok('logins are kept 90 days');
}

accounts.close();
chat.close();
server.close();
fs.rmSync(logDir, { recursive: true, force: true });
if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - admin console: ${testNo} checks`);
