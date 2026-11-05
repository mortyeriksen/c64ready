// Spec tests for the Arkanoid: Revenge of Doh achievement set (server/sets/arkanoid-revenge-of-doh.json,
// Imagine 1988, on the OneLoad64 v5 cartridge and its crunched and uncrunched programs) under rcheevos,
// on synthesized RAM laid out as the game keeps it:
//   $21B7 the mode: 2 on the menu, 1 in a game and its name entry. As the menu returns after a name
//         entry it reads 1 for a single frame, with the last game's score still in place.
//   $0200 player 1's lives: 4 at the start, at most 6, 0 on the last, 4 again at the game over.
//   $0688 the player playing, 0 for player 1. $0682 the round shown, BCD: $33 is Doh's.
//   $03F5 the last capsule caught: 2 widens the Vaus, 3 splits it in two, 8 splits the ball, 11 B,
//         12 P, 13 the mystery capsule. 0 as a round starts, 4 after a lost life.
//   Round 33's own code area: $408C Doh's form (0 as a ball starts, 1 his face, 2 his core), $43C9 the
//         hits on it, $03EB the hits it takes (7, then 6). A lost ball zeroes the target for a moment,
//         then sends him back to his face with no hits. Other rounds keep other things there.
//   The score: $D9's low nibble the 100,000s, $D4 BCD the 1,000s, $CF BCD the 10s. A game's start
//   clears it in the frame the mode turns 1.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRcheevos, EVENT } from '../../src/achievements/rcheevos.js';
import { checkSet } from '../../server/games.mjs';
import { assetPath, missingNote } from '../external-assets.js';
import { GAME_ICONS } from '../../src/achievements/game-icons.js';

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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/arkanoid-revenge-of-doh.json'), 'utf8')), 'arkanoid-revenge-of-doh.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const id = Object.fromEntries(set.achievements.map((a) => [a.title, a.id]));
const HASHES = { 'arkanoid-revenge-of-doh-crt': '4ec2f031497b2fecbd1b68685577e332', 'arkanoid-revenge-of-doh-prg-crunched': 'e91260f2e2558f8bbc95e23f47784157', 'arkanoid-revenge-of-doh-prg-uncrunched': '054cb41539ab442d71b6821e21f27318' };
const MODE = 0x21b7, LIVES = 0x200, PLAYER = 0x688, ROUND = 0x682, CAPSULE = 0x3f5, FORM = 0x408c, HITS = 0x43c9, TARGET = 0x3eb;
const GAME_OVER_ID = 999;

const unlocked = new Set();
const primed = new Set();   // challenges that can still be earned (rcheevos PRIMED, until UNPRIMED)
const boards = [];
let overs = 0;
function activate() {
  rc.clear(); unlocked.clear(); primed.clear(); boards.length = 0; overs = 0; ram.fill(0);
  const codes = set.achievements.map((a) => rc.activateAchievement(a.id, a.memaddr));
  codes.push(rc.activateAchievement(GAME_OVER_ID, set.gameOver));
  for (const l of set.leaderboards) codes.push(rc.activateLeaderboard(l.id, l.definition));
  return codes;
}
function frame() {
  for (const e of rc.doFrame(ram)) {
    if (e.type === EVENT.ACHIEVEMENT_TRIGGERED) { if (e.id === GAME_OVER_ID) { overs++; rc.deactivateAchievement(GAME_OVER_ID); rc.activateAchievement(GAME_OVER_ID, set.gameOver); } else unlocked.add(e.id); }
    else if (e.type === EVENT.ACHIEVEMENT_PRIMED) primed.add(e.id);
    else if (e.type === EVENT.ACHIEVEMENT_UNPRIMED) primed.delete(e.id);
    else if (e.type === EVENT.LBOARD_STARTED || e.type === EVENT.LBOARD_TRIGGERED || e.type === EVENT.LBOARD_CANCELED) boards.push({ ...e });
  }
}
const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
const has = (title) => unlocked.has(id[title]);
const live = (title) => primed.has(id[title]);
const posted = () => boards.filter((e) => e.type === EVENT.LBOARD_TRIGGERED).map((e) => e.value);
const started = () => boards.filter((e) => e.type === EVENT.LBOARD_STARTED);

const bcd = (n) => Math.floor(n / 10) * 16 + (n % 10);
const unbcd = (b) => (b >> 4) * 10 + (b & 15);
/** The score, in the game's bytes; $D9's high nibble is not part of it. */
function setScore(n) { ram[0xd9] = 0x50 | (Math.floor(n / 100000) % 10); ram[0xd4] = bcd(Math.floor(n / 1000) % 100); ram[0xcf] = bcd(Math.floor(n / 10) % 100); }
const scoreNow = () => (ram[0xd9] & 15) * 100000 + unbcd(ram[0xd4]) * 1000 + unbcd(ram[0xcf]) * 10;
/** The menu, after power-on's loading picture: mode 2, four lives, round 1. */
function menu() { ram[MODE] = 2; ram[LIVES] = 4; ram[ROUND] = 1; ram[PLAYER] = 0; frames(10); }
/** A game from the menu: the mode turns 1 and the score clears in the same frame. */
function start() { ram[MODE] = 1; setScore(0); ram[ROUND] = 1; ram[CAPSULE] = 0; frames(10); }
function points(n) { setScore(scoreNow() + n); frames(3); }
function clearRound() { ram[ROUND] = bcd(unbcd(ram[ROUND]) + 1); ram[CAPSULE] = 0; frames(5); }
function loseLife() { ram[LIVES]--; ram[CAPSULE] = 4; frames(5); }
function catchCapsule(k) { ram[CAPSULE] = k; if (k === 12 && ram[LIVES] < 6) ram[LIVES]++; frames(5); }
/** The last life lost, the name entry (four lives again, still mode 1), then the menu's return blip,
 * with `inBlip` run in its frame. */
function gameOver(inBlip = () => {}) {
  while (ram[LIVES] > 0) loseLife();
  frames(20); ram[LIVES] = 4; frames(60);
  ram[MODE] = 2; frames(3); ram[MODE] = 1; frames(1); inBlip(); ram[MODE] = 2; frames(10);
}

// 1. Every condition parses, the set names the three files, and its trophies run in order.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  for (const h of Object.values(HASHES)) expect(set.hashes.some((x) => x.hash === h), `the set names ${h}`);
  expect(set.hashes.length === 3, 'the cartridge and its two programs');
  expect(set.achievements.every((a, i) => a.id === i + 1), 'achievement IDs follow display order');
  expect(set.leaderboards.length === 1 && set.leaderboards[0].format === 'SCORE' && !set.leaderboards[0].lowerIsBetter, 'one High Score board, higher is better');
  expect(set.url === 'https://www.lemon64.com/games/details.php?ID=146', 'the set links the game on Lemon64');
  expect(GAME_ICONS.has(set.id), 'the game has its icon');
  ok(`all ${set.achievements.length} achievements, the board and the game over parse`);
}

// 2. Each listed hash is its file's rcheevos hash.
for (const [key, hash] of Object.entries(HASHES)) {
  const file = assetPath(key);
  if (!file) { console.log(`ok  - test ${++testNo}: ${key} hashes to the listed hash # SKIP ${missingNote(key)}`); continue; }
  expect(rc.hash(fs.readFileSync(file)) === hash, `${path.basename(file)} hashes to ${hash}`);
  ok(`${key} hashes to the listed hash`);
}

// 3. Power-on, the loading picture and the menu count for nothing.
{
  activate(); ram[MODE] = 0; ram[LIVES] = 138; ram[ROUND] = 0xa2; ram[0xd9] = 0x04; frames(10);
  menu(); ram[CAPSULE] = 12; ram[ROUND] = 4; frames(5); ram[ROUND] = 5; frames(5);
  expect(unlocked.size === 0 && !started().length && !overs, 'nothing before a game');
  ok('the loading picture and the menu count for nothing');
}

// 4. The board starts at 0 as a game starts and posts at the game over. The menu's return blip,
// with the old score, starts nothing.
{
  activate(); menu(); start();
  expect(started().length === 1 && started()[0].value === 0, `the board starts at 0 (${started().map((e) => e.value)})`);
  points(12340); clearRound(); points(5000); gameOver();
  expect(overs === 1, 'the lives back at 4 after the last is the set\'s game over');
  expect(posted().length === 1 && posted()[0] === 17340, `the game over posts the score (${posted()})`);
  expect(started().length === 1, 'the menu\'s return blip starts no board');
  start();
  expect(started().length === 2, 'a new game starts it again');
  ok('the High Score board');
}

// 5. Rounds: reached as the round shown steps, in BCD.
{
  activate(); menu(); start();
  expect(!has('Back for More'), 'nothing in round 1');
  clearRound();
  expect(has('Back for More') && !has('Five Down'), 'clearing round 1');
  while (ram[ROUND] < bcd(5)) clearRound();
  expect(has('Five Down') && !has('Double Figures'), 'round 5');
  while (ram[ROUND] < bcd(10)) clearRound();
  expect(has('Double Figures'), 'round 10');
  while (ram[ROUND] < bcd(17)) clearRound();
  expect(has('Halfway to Doh'), 'round 17');
  while (ram[ROUND] < bcd(25)) clearRound();
  expect(has('Deep in Zarg') && !has('Doh Returns'), 'round 25');
  while (ram[ROUND] < bcd(33)) clearRound();
  expect(has('Doh Returns'), 'round 33 is Doh\'s');
  ok('round milestones');
}

// 6. The B and P capsules as they are caught, P even with six lives.
{
  activate(); menu(); start();
  catchCapsule(1); catchCapsule(5); catchCapsule(10);
  expect(!has('Escape Hatch') && !has('Backup Vaus'), 'other capsules earn neither');
  catchCapsule(11);
  expect(has('Escape Hatch'), 'a B capsule');
  clearRound(); ram[LIVES] = 6; frames(3); catchCapsule(12);
  expect(has('Backup Vaus'), 'a P capsule, with the lives already at six');
  ok('the B and P capsules');
}

// 7. Doh: his face broken, then his core, in one life; a lost ball starts him over.
{
  const hit = () => { ram[HITS]++; frames(3); };
  const form = (f, target) => { ram[FORM] = f; ram[HITS] = 0; ram[TARGET] = target; frames(3); };
  const lostBall = () => { ram[TARGET] = 0; ram[HITS] = 0; frames(2); form(0, 7); form(1, 7); };
  activate(); menu(); start();
  while (ram[ROUND] < bcd(33)) clearRound();
  form(0, 7); form(1, 7);
  for (let i = 0; i < 6; i++) hit();
  expect(!has('Face Off'), 'not before his face breaks');
  form(2, 6);
  expect(has('Face Off') && !has('Doh Destroyed'), 'his face broken');
  for (let i = 0; i < 5; i++) hit();
  lostBall();
  expect(!has('Doh Destroyed'), 'five hits on the core, then a lost ball');
  ram[FORM] = 2; ram[TARGET] = 0; ram[HITS] = 0; frames(3);
  expect(!has('Doh Destroyed'), 'the lost ball\'s zeroed count and target are no win');
  form(1, 7); form(2, 6);
  for (let i = 0; i < 5; i++) hit();
  expect(!has('Doh Destroyed'), 'one hit short');
  hit();
  expect(has('Doh Destroyed'), 'the sixth hit on the core destroys Doh');
  ok('Face Off and Doh Destroyed');

  activate(); menu(); start(); ram[ROUND] = bcd(12); frames(3);
  ram[FORM] = 1; ram[TARGET] = 3; frames(3); ram[FORM] = 2; ram[HITS] = 3; frames(3);
  expect(!has('Face Off') && !has('Doh Destroyed'), 'the same bytes outside round 33 are no Doh');
  ok('Doh only in round 33');
}

// 8. The capsules with a known effect.
{
  activate(); menu(); start();
  for (const [k, t] of [[2, 'Wide Body'], [3, 'Seeing Double'], [8, 'Ball Storm'], [13, 'Lucky Dip']]) {
    expect(!has(t), `${t} not before its capsule`);
    catchCapsule(k); clearRound();
    expect(has(t), `${t} as capsule ${k} is caught`);
  }
  ok('the capsules with a known effect');
}

// 9. Flawless Start: live from a game's start, out at a lost life, live again in the next game.
{
  activate(); menu();
  expect(!live('Flawless Start'), 'not live on the menu');
  start();
  expect(live('Flawless Start'), 'live as a game starts');
  loseLife();
  expect(!live('Flawless Start'), 'a lost life puts it out');
  clearRound();
  expect(!has('Flawless Start'), 'round 1 cleared after a lost life does not earn it');
  setScore(2790); gameOver(() => expect(!live('Flawless Start'), 'not live on the menu\'s return blip'));
  start();
  expect(live('Flawless Start'), 'live again in the next game');
  catchCapsule(12); clearRound();
  expect(has('Flawless Start'), 'a clean round 1 earns it, an extra life no matter');
  ok('Flawless Start');
}

// 10. Score tiers read the three score bytes.
{
  activate(); menu(); start();
  for (const [t, n] of [['Five Figures', 10000], ['Fifty Grand', 50000], ['Six Figures', 100000], ["Doh's Nemesis", 250000]]) {
    setScore(n - 10); frames(2);
    expect(!has(t), `${n - 10} is short of ${t}`);
    setScore(n); frames(2);
    expect(has(t), `${t} at ${n}`);
  }
  ok('score tiers');
}

// 11. Player 2's turn counts for nothing: the set is player 1's.
{
  activate(); menu(); start(); ram[PLAYER] = 1; frames(3);
  catchCapsule(11); setScore(60000); frames(3); clearRound();
  expect(!has('Escape Hatch') && !has('Fifty Grand') && !has('Back for More'), 'nothing on player 2\'s turn');
  ok('player 2\'s turn');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - arkanoid-revenge-of-doh set: ${testNo} checks`);
