// Spec tests for the Arkanoid achievement set (server/sets/arkanoid.json, Imagine 1987, on the
// OneLoad64 v5 cartridge and its crunched and uncrunched programs) under rcheevos, on synthesized
// RAM laid out as the game keeps it:
//   $0936 player 1's lives: 4 as a game starts (from the menu's 0, or $99 after a GAME OVER), 0 on
//         the last, $99 at GAME OVER. $0938 the player playing, 0 for player 1.
//   $093D player 1's round - 1: 32 is Doh's. Doh's ending puts it back to 0.
//   $0208 the last capsule caught: 1 S, 2 C, 3 E, 4 D, 5 L, 6 B, 7 P. 0 as a round starts.
//   $0455 Doh's hits left: from 0 to 255 on the hit that beats him.
//   $C187-$C18D the play screen's score as seven digit characters ($30-$39). The menu leaves $1C
//         there, and the screen is drawn a moment after the lives are set.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/arkanoid.json'), 'utf8')), 'arkanoid.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const id = Object.fromEntries(set.achievements.map((a) => [a.title, a.id]));
const HASHES = { 'arkanoid-crt': '9e6db649f3938ba9cc19f98a75320449', 'arkanoid-prg-crunched': 'c2834c16b0a85a6ec278ff3730542791', 'arkanoid-prg-uncrunched': '1854e9690965467d1ad9c33549387d9c' };
const LIVES = 0x936, PLAYER = 0x938, ROUND = 0x93d, CAPSULE = 0x208, DOH = 0x455, SCORE = 0xc187;
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

function setScore(n) { const s = String(n).padStart(7, '0'); for (let i = 0; i < 7; i++) ram[SCORE + i] = 48 + Number(s[i]); }
const scoreNow = () => Number(Array.from(ram.subarray(SCORE, SCORE + 7), (c) => c - 48).join(''));
/** The menu: no lives, the score cells holding the menu's $1C. */
function menu() { ram[LIVES] = 0; ram[ROUND] = 0; ram[PLAYER] = 0; ram.fill(0x1c, SCORE, SCORE + 7); frames(10); }
/** A game from the menu: the lives set to 4, then the play screen's score drawn a few frames on. */
function start() { ram[LIVES] = 4; ram[ROUND] = 0; ram[CAPSULE] = 0; frames(4); setScore(0); frames(10); }
function points(n) { setScore(scoreNow() + n); frames(3); }
function clearRound() { ram[ROUND]++; ram[CAPSULE] = 0; frames(5); }
function loseLife() { ram[LIVES]--; frames(5); }
function catchCapsule(k) { ram[CAPSULE] = k; frames(5); }
function gameOver() { while (ram[LIVES] > 0) loseLife(); ram[LIVES] = 0x99; frames(20); }

// 1. Every condition parses, the set names the three files, and its trophies run in order.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  for (const h of Object.values(HASHES)) expect(set.hashes.some((x) => x.hash === h), `the set names ${h}`);
  expect(set.hashes.length === 3, 'the cartridge and its two programs');
  expect(set.achievements.every((a, i) => a.id === i + 1), 'achievement IDs follow display order');
  expect(set.leaderboards.length === 1 && set.leaderboards[0].format === 'SCORE' && !set.leaderboards[0].lowerIsBetter, 'one High Score board, higher is better');
  expect(set.url === 'https://www.lemon64.com/game/arkanoid', 'the set links the game on Lemon64');
  const icon = GAME_ICONS[set.id];
  expect(icon?.length === 10 && icon.every((row) => /^[#+.]{10}$/.test(row)), 'its icon is 10 by 10 pixels');
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
  activate(); ram.fill(0xff, SCORE, SCORE + 7); ram[ROUND] = 0xff; frames(10);
  menu(); ram[CAPSULE] = 3; ram[ROUND] = 4; frames(5); ram[ROUND] = 5; frames(5);
  expect(unlocked.size === 0 && !started().length && !overs, 'nothing before a game');
  ok('the menu counts for nothing');
}

// 4. The board starts as the play screen's score is drawn, at 0, and posts at GAME OVER.
{
  activate(); menu(); start();
  expect(started().length === 1 && started()[0].value === 0, `the board starts at 0 once the score shows (${started().map((e) => e.value)})`);
  points(12340); clearRound(); points(5000); gameOver();
  expect(overs === 1, 'GAME OVER is the set\'s game over');
  expect(posted().length === 1 && posted()[0] === 17340, `GAME OVER posts the score (${posted()})`);
  menu(); start();
  expect(started().length === 2, 'a new game starts it again');
  ok('the High Score board');
}

// 5. Rounds: cleared and reached as the round counter steps.
{
  activate(); menu(); start();
  expect(!has('Round Two'), 'nothing in round 1');
  clearRound();
  expect(has('Round Two') && !has('Fifth Round'), 'clearing round 1 is Round Two');
  while (ram[ROUND] < 4) clearRound();
  expect(has('Fifth Round') && !has('Double Digits'), 'round 5');
  while (ram[ROUND] < 9) clearRound();
  expect(has('Double Digits'), 'round 10');
  while (ram[ROUND] < 16) clearRound();
  expect(has('Halfway There'), 'round 17');
  while (ram[ROUND] < 24) clearRound();
  expect(has('Deep Space') && !has('Face of Doh'), 'round 25');
  while (ram[ROUND] < 32) clearRound();
  expect(has('Face of Doh') && !has('Doh Destroyed'), 'round 33 is Doh\'s');
  ok('round milestones');
}

// 6. Doh falls on the hit that takes his counter from 0 to 255: the trophy, and the board posts
// then, as his ending clears the score before its GAME OVER.
{
  activate(); menu(); start(); points(250000);
  while (ram[ROUND] < 32) clearRound();
  ram[DOH] = 90; frames(5);
  for (let hp = 89; hp >= 0; hp--) { ram[DOH] = hp; frames(2); }
  expect(!has('Doh Destroyed'), 'not while Doh has hits left');
  ram[DOH] = 255; frames(1); ram[ROUND] = 0; frames(20);
  expect(has('Doh Destroyed'), 'the last hit defeats Doh');
  expect(posted().length === 1 && posted()[0] === 250000, `the board posts the final score as Doh falls (${posted()})`);
  ram.fill(0x20, SCORE, SCORE + 7); frames(20); ram[LIVES] = 0x99; frames(20);
  expect(posted().length === 1 && overs === 1, 'the ending\'s GAME OVER posts nothing more, and ends the game');

  activate(); menu(); start(); ram[ROUND] = 5; frames(3); ram[DOH] = 0; frames(2); ram[DOH] = 255; frames(2);
  expect(!has('Doh Destroyed'), '$0455 wrapping outside round 33 is no Doh');
  ok('Doh destroyed');
}

// 7. Capsules: each kind as it is caught, and all seven in one game.
{
  const kinds = ['Slow Motion', 'Sticky Fingers', 'Wide Load', 'Triple Trouble', 'Laser Show', 'Way Out', 'Spare Vaus'];
  activate(); menu(); start();
  kinds.forEach((t, i) => {
    expect(!has(t), `${t} not before its capsule`);
    catchCapsule(i + 1);
    expect(has(t), `${t} as capsule ${i + 1} is caught`);
    clearRound();
  });
  expect(has('Full House'), 'all seven in one game is Full House');
  ok('each capsule, and Full House');

  activate(); menu(); start();
  for (let k = 1; k <= 6; k++) { catchCapsule(k); clearRound(); }
  gameOver(); menu(); start(); catchCapsule(7);
  expect(!has('Full House'), 'six in one game and the seventh in the next is no Full House');
  ok('Full House needs one game');
}

// 8. The challenges: live from a game's start, out at a lost life, live again in the next game.
{
  activate(); menu();
  expect(!live("Beginner's Luck") && !live('Untouchable'), 'not live on the menu');
  start();
  expect(live("Beginner's Luck") && live('Untouchable'), 'both live as a game starts');
  loseLife();
  expect(!live("Beginner's Luck") && !live('Untouchable'), 'a lost life puts both out');
  clearRound();
  expect(!has("Beginner's Luck"), 'round 1 cleared after a lost life does not earn it');
  gameOver(); menu(); start();
  expect(live("Beginner's Luck"), 'live again in the next game');
  catchCapsule(7); ram[LIVES]++; frames(3);
  clearRound();
  expect(has("Beginner's Luck"), 'a clean round 1 earns it, an extra life no matter');
  while (ram[ROUND] < 5) clearRound();
  expect(has('Untouchable'), 'round 6 with no life lost earns Untouchable');
  ok("Beginner's Luck and Untouchable");
}

// 9. Score tiers read the play screen's seven digits.
{
  activate(); menu(); start();
  for (const [t, n] of [['Five Figures', 10000], ['Fifty Grand', 50000], ['Six Figures', 100000], ['Arkanoid Ace', 250000]]) {
    setScore(n - 10); frames(2);
    expect(!has(t), `${n - 10} is short of ${t}`);
    setScore(n); frames(2);
    expect(has(t), `${t} at ${n}`);
  }
  ok('score tiers');
}

// 10. Player 2's turn counts for nothing: the set is player 1's.
{
  activate(); menu(); start(); ram[PLAYER] = 1; frames(3);
  catchCapsule(3); setScore(60000); frames(3); clearRound();
  expect(!has('Wide Load') && !has('Fifty Grand') && !has('Round Two'), 'nothing on player 2\'s turn');
  ok('player 2\'s turn');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - arkanoid set: ${testNo} checks`);
