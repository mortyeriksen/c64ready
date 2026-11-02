// Spec tests for the achievement engine (src/achievements/engine.js) against
// the real games API (server/games.mjs on an in-memory database) and the real
// rcheevos: a loaded file is hashed and its game found, unlocks and leaderboard
// values reach the signed-in account, a signed-out player is told and nothing
// is saved, an unlocked achievement is not armed again, another file of the
// same game (a tape's second side) carries the game on, ejecting a disk or tape
// keeps it, ejecting its cartridge or a reset without its files ends it, and a
// different file without a set ends it. A file without a set never leaves the browser: only the list
// of games is fetched, and matched here. Results not saved yet belong to the
// account that earned them. RAM is synthesized frame by frame.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccounts } from '../../server/accounts.mjs';
import { openDatabase } from '../../server/db.mjs';
import { gameRoutes, loadSets } from '../../server/games.mjs';
import { createAchievementEngine } from '../../src/achievements/engine.js';
import { setLoaded, _resetLoaded } from '../../src/media/now-loaded.js';

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

// A made-up game file and its set: one achievement, one leaderboard.
const file = crypto.randomBytes(4096);
const hash = crypto.createHash('md5').update(file).digest('hex');
const side2 = crypto.randomBytes(4096);   // the same game's second tape side
const hash2 = crypto.createHash('md5').update(side2).digest('hex');
const sets = fs.mkdtempSync(path.join(os.tmpdir(), 'c64sets-'));
fs.writeFileSync(path.join(sets, 'demo.json'), JSON.stringify({
  id: 'demo', title: 'Demo Game', hashes: [{ hash }, { hash: hash2 }],
  achievements: [
    { id: 1, title: 'Level Two', description: 'Reach level 2.', points: 5, memaddr: '0xH0010=2_d0xH0010=1' },
    { id: 2, title: 'Big Score', description: 'Score 100.', points: 10, memaddr: '0xH0011>=100' },
    { id: 3, title: 'Next Step', description: 'Step from 1 to 2.', points: 5, memaddr: '0xH0013=2_d0xH0013=1' },
  ],
  notices: [{ id: 1, title: 'Cheat on', text: 'Nothing counts.', memaddr: '0xH0014=1' }],
  leaderboards: [{ id: 1, title: 'High Score', description: 'Most points.', format: 'VALUE', lowerIsBetter: false,
    definition: 'STA:0xH0012=1_d0xH0012=0::CAN:0=1::SUB:0xH0012=0_d0xH0012=1::VAL:0xH0011' }],
}));

// Another game, whose achievement shares the first's id 1.
const otherFile = crypto.randomBytes(4096);
fs.writeFileSync(path.join(sets, 'other.json'), JSON.stringify({
  id: 'other', title: 'Other Game', hashes: [{ hash: crypto.createHash('md5').update(otherFile).digest('hex') }],
  achievements: [{ id: 1, title: 'Other One', description: 'Something else.', points: 5, memaddr: '0xH0020=7' }],
}));

const db = openDatabase(':memory:');
loadSets(db, sets);
const accounts = createAccounts({ db, now: Date.now, extend: gameRoutes });
const server = http.createServer((req, res) => { if (!accounts.handleRequest(req, res)) res.writeHead(404).end(); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api`;

const userId = Number(db.prepare('INSERT INTO users (name, name_key, handle, created_at) VALUES (?, ?, ?, ?)').run('Ann', 'ann', crypto.randomBytes(16), Date.now()).lastInsertRowid);
const token = crypto.randomBytes(32).toString('base64url');
db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
  .run(crypto.createHash('sha256').update(token).digest('hex'), userId, Date.now(), Date.now() + 1e9, Date.now());

const account = { token, user: { id: userId, name: 'Ann' } };
const unlocks = [], boards = [], notices = [], softs = [];
const asked = [];   // every URL the engine fetched
const engine = createAchievementEngine({ account, base, fetchImpl: (url, o) => { asked.push(String(url)); return fetch(url, o); }, onUnlock: (e) => unlocks.push(e), onLeaderboard: (e) => boards.push(e), onNotice: (e) => notices.push(e), onSoftcore: (e) => softs.push(e.reason), log: () => {} });
const ram = new Uint8Array(0x10000);
const frames = (n) => { for (let i = 0; i < n; i++) engine.frame(ram); };
const settle = () => new Promise((r) => setTimeout(r, 50));

// 1. A loaded file with a set becomes the game.
{
  _resetLoaded();
  const unknown = crypto.randomBytes(100);
  const unknownHash = crypto.createHash('md5').update(unknown).digest('hex');
  setLoaded('drive8', { ref: 'other', kind: 'd64', bytes: unknown });   // no set
  setLoaded('cart', { ref: file, kind: 'crt', bytes: file });
  await engine.mediaChanged();
  const g = engine.game;
  expect(g?.title === 'Demo Game' && g.hash === hash, `the cartridge's hash finds its game (got ${g?.title})`);
  expect(g?.achievements.length === 3 && g.achievements.every((a) => !a.unlocked), 'its achievements, none unlocked');
  expect(!asked.some((u) => u.includes(unknownHash)), 'a file without a set is never sent to the server, not even its hash');
  expect(asked.filter((u) => u.endsWith('/games')).length === 1, 'the list of games is fetched once');
  ok('a loaded file with a set becomes the game');
}

// 2. Signed in: an unlock is saved, a finished attempt posts its value.
{
  frames(3);
  ram[0x10] = 1; frames(2);
  ram[0x10] = 2; frames(1);
  await settle();
  expect(unlocks.length === 1 && unlocks[0].achievement.title === 'Level Two' && unlocks[0].saved, 'reaching level 2 unlocks Level Two and saves it');
  expect(unlocks[0].complete === null, 'one of three is not the whole set');
  const row = db.prepare('SELECT achievement_id FROM unlocks WHERE user_id = ?').all(userId).map((r) => r.achievement_id);
  expect(JSON.stringify(row) === '[1]', 'the server has the unlock');
  ram[0x12] = 1; ram[0x11] = 40; frames(2);
  expect(boards.some((b) => b.type === 'started'), 'the leaderboard attempt starts');
  ram[0x11] = 60; frames(1);
  ram[0x12] = 0; frames(1);
  await settle();
  const sub = boards.find((b) => b.type === 'submitted');
  expect(sub?.value === 60 && sub.result?.best === 60 && sub.result.rank === 1, `the finished attempt posts 60 and ranks first (got ${JSON.stringify(sub?.result)})`);
  ok('signed in: unlocks and scores reach the account');
}

// 3. An achievement already unlocked is not armed again.
{
  await engine.accountChanged();
  unlocks.length = 0;
  ram[0x10] = 1; frames(2); ram[0x10] = 2; frames(2);
  await settle();
  expect(!unlocks.some((u) => u.achievement.id === 1), 'Level Two does not unlock twice');
  expect(engine.game.achievements.find((a) => a.id === 1).unlocked, 'and shows as unlocked');
  ok('unlocked achievements stay unlocked and are not armed');
}

// 4. Signed out: told, not saved.
{
  account.token = null; account.user = null;
  await engine.accountChanged();
  unlocks.length = 0;
  ram[0x11] = 0; frames(2); ram[0x11] = 120; frames(1);
  await settle();
  const u = unlocks.find((x) => x.achievement.title === 'Big Score');
  expect(u && !u.saved && !u.signedIn, 'signed out, an unlock is reported as not kept');
  expect(db.prepare('SELECT COUNT(*) AS n FROM unlocks WHERE achievement_id = 2').get().n === 0, 'and nothing is saved');
  ok('signed out: unlocks are shown, not saved');
}

// 4b. A set's notice: shown once when it comes true, cleared by a reset, shown again next time.
{
  unlocks.length = 0;
  ram[0x14] = 1; frames(3);
  expect(notices.length === 1 && notices[0].title === 'Cheat on' && notices[0].text === 'Nothing counts.' && engine.game.notice === 'Cheat on: Nothing counts.', 'a notice that comes true is told with its title, and shown on the game');
  frames(5);
  expect(notices.length === 1, 'once, while it stays true');
  expect(!unlocks.length, 'and it is no achievement');
  engine.reset();
  expect(engine.game.notice === null, 'a reset clears it');
  ram[0x14] = 0; frames(2); ram[0x14] = 1; frames(2);
  expect(notices.length === 2, 'and it is told again the next time it comes true');
  ram[0x14] = 0; frames(1);
  ok('notices');
}

// 4c. Hardcore: a notice or a loaded save state makes play softcore, said once, until a reset.
{
  engine.reset();
  softs.length = 0;
  expect(engine.softcore === null, 'a reset machine plays hardcore');
  engine.taint('a save state was loaded');
  engine.taint('a save state was loaded');
  expect(engine.softcore === 'a save state was loaded' && softs.length === 1 && engine.game.softcore === 'a save state was loaded', 'a loaded save state makes play softcore, said once, and the game shows why');
  engine.reset();
  expect(engine.softcore === null, 'a reset makes it hardcore again');
  frames(1);   // after a reset, a condition must be seen false before it can come true
  ram[0x14] = 1; frames(3);
  expect(engine.softcore === 'Cheat on', 'a notice that sees a trainer makes play softcore too');
  engine.reset(); ram[0x14] = 0; frames(1);
  ok('hardcore: softcore until a reset');
}

// 5. Another file of the same game carries it on; ejecting keeps it; a different file ends it.
{
  unlocks.length = 0;
  ram[0x13] = 1; frames(2);
  setLoaded('cart', null);
  setLoaded('tape', { ref: side2, kind: 'tap', bytes: side2 });
  await engine.mediaChanged();
  expect(engine.game?.title === 'Demo Game' && engine.game.hash === hash2, 'the second tape side is the same game');
  ram[0x13] = 2; frames(1);
  await settle();
  expect(unlocks.some((u) => u.achievement.title === 'Next Step'), 'and the game carries on: a step begun on side 1 completes on side 2');
  expect(unlocks.find((u) => u.achievement.title === 'Next Step')?.complete === null, 'two of three is not the whole set');
  ram[0x10] = 1; frames(2); ram[0x10] = 2; frames(1);
  await settle();
  const last = unlocks.find((u) => u.achievement.title === 'Level Two');
  expect(last?.complete?.id === 'demo' && last.complete.title === 'Demo Game' && last.complete.count === 3 && last.complete.points === 20,
    `the set's last unlock says the whole game is done, with its count and points (got ${JSON.stringify(last?.complete)})`);
  _resetLoaded();
  await engine.mediaChanged();
  expect(engine.game?.title === 'Demo Game', 'ejecting keeps the game: the program runs on in memory');
  setLoaded('drive8', { ref: 'another', kind: 'd64', bytes: crypto.randomBytes(200) });
  await engine.mediaChanged();
  expect(engine.game === null, 'a different file without a set ends it');
  ok('a game survives its own media changes, and ends with another game');
}

// 6. A cartridge's game ends when it leaves the port. A tape's game outlives its eject, but not a reset.
{
  _resetLoaded();
  setLoaded('cart', { ref: file, kind: 'crt', bytes: file });
  await engine.mediaChanged();
  expect(engine.game?.title === 'Demo Game', 'the cartridge is the game');
  setLoaded('cart', null);
  await engine.mediaChanged();
  expect(engine.game === null, 'ejecting the cartridge ends it');
  setLoaded('tape', { ref: side2, kind: 'tap', bytes: side2 });
  await engine.mediaChanged();
  engine.reset();
  expect(engine.game?.title === 'Demo Game', 'a reset with the tape still in keeps its game');
  setLoaded('tape', null);
  await engine.mediaChanged();
  expect(engine.game?.title === 'Demo Game', 'ejecting the tape keeps its game: it runs on in memory');
  engine.reset();
  expect(engine.game === null, 'a reset with none of its files left ends it');
  ok('ejecting a cartridge, or resetting without the game\'s files, ends the game');
}

// 8. Fragile networks and accounts.
{
  // A failed lookup is no answer: the set is armed once the server answers.
  let down = true, slow = null;
  const flaky = (url, o) => {
    if (down) return Promise.reject(new TypeError('network down'));
    if (slow && String(url).includes(slow)) return new Promise((r) => setTimeout(r, 300)).then(() => fetch(url, o));
    return fetch(url, o);
  };
  const acct = { token: null, user: null };
  const got = [];
  const e2 = createAchievementEngine({ account: acct, base, fetchImpl: flaky, onUnlock: (e) => got.push(e), log: () => {} });
  _resetLoaded();
  setLoaded('cart', { ref: file, kind: 'crt', bytes: file });
  await e2.mediaChanged();
  expect(e2.game === null, 'with the server out of reach, no game yet');
  down = false;
  await e2.mediaChanged();
  expect(e2.game?.title === 'Demo Game', 'a failed fetch is not taken for "no set": once the server answers, the set is armed');

  // Earned signed out, kept, and posted on signing in.
  const r2 = new Uint8Array(0x10000);
  r2[0x10] = 1; e2.frame(r2); r2[0x10] = 2; e2.frame(r2);
  await settle();
  expect(got.length === 1 && got[0].signedIn === false, 'an unlock signed out is shown');
  const fresh = Number(db.prepare('INSERT INTO users (name, name_key, handle, created_at) VALUES (?, ?, ?, ?)').run('Bea', 'bea', crypto.randomBytes(16), Date.now()).lastInsertRowid);
  const t2 = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run(crypto.createHash('sha256').update(t2).digest('hex'), fresh, Date.now(), Date.now() + 1e9, Date.now());
  acct.token = t2; acct.user = { id: fresh, name: 'Bea' };
  await e2.accountChanged();
  const saved = db.prepare("SELECT achievement_id FROM unlocks WHERE user_id = ? AND game_id = 'demo'").all(fresh).map((x) => x.achievement_id);
  expect(JSON.stringify(saved) === '[1]', `signing in posts what was earned signed out (got ${JSON.stringify(saved)})`);
  expect(e2.game.achievements.find((a) => a.id === 1)?.unlocked, 'and it stays unlocked');

  // A sign-in's answer applies only to the game it was asked for.
  slow = hash;
  const pending = e2.accountChanged();
  setLoaded('cart', { ref: otherFile, kind: 'crt', bytes: otherFile });
  await e2.mediaChanged();
  await pending;
  expect(e2.game?.title === 'Other Game' && !e2.game.achievements[0].unlocked, 'a sign-in finishing after another game loaded does not mark that game\'s achievements');
  ok('failed lookups, unlocks made signed out, and sign-ins during a load');
}

// 9. Results belong to the account that earned them; a lost session keeps them.
{
  const person = (name) => {
    const id = Number(db.prepare('INSERT INTO users (name, name_key, handle, created_at) VALUES (?, ?, ?, ?)').run(name, name.toLowerCase(), crypto.randomBytes(16), Date.now()).lastInsertRowid);
    const t = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run(crypto.createHash('sha256').update(t).digest('hex'), id, Date.now(), Date.now() + 1e9, Date.now());
    return { token: t, user: { id, name } };
  };
  const unlocksOf = (id) => db.prepare("SELECT achievement_id FROM unlocks WHERE user_id = ? AND game_id = 'demo' ORDER BY achievement_id").all(id).map((x) => x.achievement_id);
  const cal = person('Cal'), dee = person('Dee');
  let failPosts = false;
  const acct = { ...cal };
  const got = [];
  let lostCalls = 0;
  const e3 = createAchievementEngine({ account: acct, base, log: () => {}, onUnlock: (e) => got.push(e), onSessionLost: () => lostCalls++,
    fetchImpl: (url, o) => (failPosts && o?.method === 'POST' ? Promise.resolve(new Response('{"error":"down"}', { status: 503 })) : fetch(url, o)) });
  const r3 = new Uint8Array(0x10000);
  const step = async (addr) => { r3[addr] = 1; e3.frame(r3); e3.frame(r3); r3[addr] = 2; e3.frame(r3); await settle(); r3[addr] = 0; };
  _resetLoaded();
  setLoaded('cart', { ref: file, kind: 'crt', bytes: file });
  await e3.mediaChanged();
  e3.frame(r3);

  // A1: Cal's unlock fails to save; Dee signs in on the same page.
  failPosts = true;
  await step(0x10);
  failPosts = false;
  Object.assign(acct, { token: null, user: null }); await e3.accountChanged();
  Object.assign(acct, dee); await e3.accountChanged();
  expect(unlocksOf(dee.user.id).length === 0, 'an unlock Cal earned is never posted as Dee');
  expect(!e3.game.achievements.find((a) => a.id === 1).unlocked, 'and Dee does not see it as unlocked');
  Object.assign(acct, cal); await e3.accountChanged();
  expect(JSON.stringify(unlocksOf(cal.user.id)) === '[1]', 'it is posted when Cal signs in again');

  // A2: a cached answer is not shown to the next account.
  Object.assign(acct, dee); await e3.accountChanged();
  setLoaded('cart', { ref: otherFile, kind: 'crt', bytes: otherFile }); await e3.mediaChanged();
  setLoaded('cart', { ref: file, kind: 'crt', bytes: file }); await e3.mediaChanged();
  expect(!e3.game.achievements.find((a) => a.id === 1).unlocked, 'a game loaded again after a change of account shows that account\'s unlocks');
  e3.frame(r3);
  await step(0x13);
  setLoaded('cart', { ref: otherFile, kind: 'crt', bytes: otherFile }); await e3.mediaChanged();
  setLoaded('cart', { ref: file, kind: 'crt', bytes: file }); await e3.mediaChanged();
  expect(e3.game.achievements.find((a) => a.id === 3).unlocked, 'an unlock made here stays unlocked when its game is loaded again');

  // A3: the session ends on the server (signed out everywhere, or banned).
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(dee.user.id);
  got.length = 0;
  e3.frame(r3);
  await step(0x10);
  expect(got.length === 1 && got[0].signedIn === false && !got[0].saved, 'an unlock refused for a lost session is reported as signed out, so the toast asks to sign in');
  expect(lostCalls === 1, 'and the page is told to check the session');
  const dee2 = { token: person('Dee2').token, user: dee.user };
  db.prepare('UPDATE sessions SET user_id = ? WHERE token_hash = ?').run(dee.user.id, crypto.createHash('sha256').update(dee2.token).digest('hex'));
  Object.assign(acct, dee2); await e3.accountChanged();
  expect(unlocksOf(dee.user.id).includes(1), 'it is kept, and posted when Dee signs in again');
  ok('results belong to the account that earned them, and a lost session keeps them');
}

// 10. Saving queued results stops when the account changes, and keeps them on a 401.
{
  const person = (name) => {
    const id = Number(db.prepare('INSERT INTO users (name, name_key, handle, created_at) VALUES (?, ?, ?, ?)').run(name, name.toLowerCase(), crypto.randomBytes(16), Date.now()).lastInsertRowid);
    const t = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run(crypto.createHash('sha256').update(t).digest('hex'), id, Date.now(), Date.now() + 1e9, Date.now());
    return { token: t, user: { id, name } };
  };
  const unlocksOf = (id) => db.prepare("SELECT achievement_id FROM unlocks WHERE user_id = ? AND game_id = 'demo' ORDER BY achievement_id").all(id).map((x) => x.achievement_id);
  const eve = person('Eve'), fay = person('Fay');
  const acct = { ...eve };
  let failPosts = true, onFirstPost = null, lostCalls = 0;
  const e4 = createAchievementEngine({ account: acct, base, log: () => {}, onSessionLost: () => lostCalls++,
    fetchImpl: (url, o) => {
      if (o?.method !== 'POST') return fetch(url, o);
      if (failPosts) return Promise.resolve(new Response('{"error":"down"}', { status: 503 }));
      if (onFirstPost) { const f = onFirstPost; onFirstPost = null; f(); }
      return fetch(url, o);
    } });
  const r4 = new Uint8Array(0x10000);
  const step = async (addr) => { r4[addr] = 1; e4.frame(r4); e4.frame(r4); r4[addr] = 2; e4.frame(r4); await settle(); r4[addr] = 0; };
  _resetLoaded();
  setLoaded('cart', { ref: file, kind: 'crt', bytes: file });
  await e4.mediaChanged();
  e4.frame(r4);
  await step(0x10); await step(0x13);   // two unlocks for Eve, neither saved
  failPosts = false;
  onFirstPost = () => Object.assign(acct, fay);   // Fay signs in while the first is on its way
  await e4.accountChanged();
  expect(JSON.stringify(unlocksOf(eve.user.id)) === '[1]' && unlocksOf(fay.user.id).length === 0, `an account change while saving stops the rest going out as the new account (Eve ${unlocksOf(eve.user.id)}, Fay ${unlocksOf(fay.user.id)})`);
  Object.assign(acct, eve); await e4.accountChanged();
  expect(JSON.stringify(unlocksOf(eve.user.id)) === '[1,3]', 'the rest are saved when Eve signs in again');

  // A session that ends while results wait: kept, and the page is told.
  db.prepare("DELETE FROM unlocks WHERE user_id = ? AND game_id = 'demo'").run(eve.user.id);
  await e4.accountChanged();
  e4.frame(r4);
  failPosts = true; await step(0x10); failPosts = false;
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(eve.user.id);
  lostCalls = 0;
  await e4.accountChanged();
  expect(lostCalls === 1 && unlocksOf(eve.user.id).length === 0, 'a 401 while saving tells the page the session is gone');
  const again = person('Eve2');
  db.prepare('UPDATE sessions SET user_id = ? WHERE token_hash = ?').run(eve.user.id, crypto.createHash('sha256').update(again.token).digest('hex'));
  Object.assign(acct, { token: again.token, user: eve.user }); await e4.accountChanged();
  expect(JSON.stringify(unlocksOf(eve.user.id)) === '[1]', 'and keeps the result, saved when Eve signs in again');
  ok('saving queued results stops when the account changes, and keeps them on a 401');
}

// 11. A set corrected on the server reaches the next load of its game, without a reload of the page.
{
  const e5 = createAchievementEngine({ account: { token: null, user: null }, base, log: () => {} });
  _resetLoaded();
  setLoaded('cart', { ref: file, kind: 'crt', bytes: file });
  await e5.mediaChanged();
  const before = e5.game?.achievements.find((a) => a.id === 1)?.title;
  db.prepare("UPDATE achievements SET title = 'Level Two, corrected' WHERE game_id = 'demo' AND id = 1").run();
  await e5.mediaChanged();
  expect(e5.game?.achievements.find((a) => a.id === 1)?.title === before, 'while the game stays in, its set is kept');
  _resetLoaded(); await e5.mediaChanged();
  setLoaded('cart', { ref: file, kind: 'crt', bytes: file }); await e5.mediaChanged();
  expect(e5.game?.achievements.find((a) => a.id === 1)?.title === 'Level Two, corrected', 'loading the game again fetches the set as the server has it now');
  db.prepare("UPDATE achievements SET title = 'Level Two' WHERE game_id = 'demo' AND id = 1").run();
  ok('a corrected set reaches the next load of its game');
}

// 12. A result an admin has checked loses its mark when the player refreshes, without a reload of the page.
{
  const id = Number(db.prepare('INSERT INTO users (name, name_key, handle, created_at) VALUES (?, ?, ?, ?)').run('Gil', 'gil', crypto.randomBytes(16), Date.now()).lastInsertRowid);
  const t = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run(crypto.createHash('sha256').update(t).digest('hex'), id, Date.now(), Date.now() + 1e9, Date.now());
  db.prepare("INSERT INTO unlocks (user_id, game_id, achievement_id, hardcore, unlocked_at, flag) VALUES (?, 'demo', 1, 1, ?, 'burst')").run(id, Date.now());
  let changes = 0;
  const e6 = createAchievementEngine({ account: { token: t, user: { id, name: 'Gil' } }, base, log: () => {}, onChange: () => changes++ });
  _resetLoaded();
  setLoaded('cart', { ref: file, kind: 'crt', bytes: file });
  await e6.mediaChanged();
  expect(e6.game?.achievements.find((a) => a.id === 1)?.checking === true, 'a flagged unlock shows as being checked');
  db.prepare("UPDATE unlocks SET flag = NULL WHERE user_id = ? AND game_id = 'demo'").run(id);
  changes = 0;
  await e6.refreshChecks();
  expect(!e6.game?.achievements.find((a) => a.id === 1)?.checking && changes === 1, 'a refresh after the admin approved clears the mark');
  await e6.refreshChecks();
  expect(changes === 1, 'a refresh that changes nothing draws nothing');
  ok('a refresh picks up what an admin checked');
}

accounts.close();
server.close();
fs.rmSync(sets, { recursive: true, force: true });
if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - achievement engine: ${testNo} checks`);
