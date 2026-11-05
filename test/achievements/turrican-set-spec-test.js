// Spec tests for the Turrican achievement set (server/sets/turrican.json, Rainbow Arts 1990, on the
// OneLoad64 v5 MultiLoad64 EasyFlash cartridge) under rcheevos, on synthesized RAM laid out as the game
// keeps it:
//   $03FC the level, 0-12 for 1-1 1-2 1-3 2-1 2-2 3-1 3-2 3-3 4-1 4-2 4-3 5-1 5-2, raised as a level
//         ends: 13 is the ending.
//   $03F1 the event: 0 play, 1 a respawn, 2 a message (TIME OUT, the CONTINUE? prompt), 3 GAME OVER,
//         4 a level done, 5 a continue taken. A new game clears it with the level and the score, then
//         sets the lives a frame or two later.
//   $FFFC/$FFFD the lives, tens and units digits, 03 at a start and on a continue. $FF before the first
//         game. The ending keeps them into the next game.
//   $0216-$021C the score, seven digits. $02AB-$02AD the diamonds, three digits: the 300th trades them
//         for a continue, shown at $0778 as $B1 + the count in the same frame.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/turrican.json'), 'utf8')), 'turrican.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const id = Object.fromEntries(set.achievements.map((a) => [a.title, a.id]));
const HASHES = { 'turrican-crt': '21548ddd14a398780035ccc9fa104257' };
const LEVEL = 0x3fc, EVENT_AT = 0x3f1, TENS = 0xfffc, UNITS = 0xfffd, SCORE = 0x216, DIAMONDS = 0x2ab, CONT = 0x778;
const GAME_OVER_ID = 999;

const unlocked = new Set();
const primed = new Set();
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
const posted = (lb) => boards.filter((e) => e.type === EVENT.LBOARD_TRIGGERED && e.id === lb).map((e) => e.value);
const started = (lb) => boards.filter((e) => e.type === EVENT.LBOARD_STARTED && e.id === lb);
const canceled = (lb) => boards.filter((e) => e.type === EVENT.LBOARD_CANCELED && e.id === lb);

let score = 0;
function setScore(n) { score = n; const s = String(n).padStart(7, '0'); for (let i = 0; i < 7; i++) ram[SCORE + i] = Number(s[i]); }
function points(n) { setScore(score + n); frames(3); }
const lives = () => ram[TENS] * 10 + ram[UNITS];
function setLives(n) { ram[TENS] = Math.floor(n / 10); ram[UNITS] = n % 10; }
let continues = 3;
function setContinues(n) { continues = n; ram[CONT] = 0xb1 + n; }
/** Power-on's title: the lives $FF, the level and event bytes left by the loader. */
function powerOn() { ram[TENS] = ram[UNITS] = 0xff; ram[LEVEL] = 0x18; ram[EVENT_AT] = 0xfa; frames(30); }
/** A new game: score, diamonds, level and event cleared, then the lives and continues two frames on. */
function newGame() {
  setScore(0); ram.fill(0, DIAMONDS, DIAMONDS + 3); ram[LEVEL] = 0; ram[EVENT_AT] = 0; frames(2);
  setLives(3); setContinues(3); frames(40);
}
/** The level ends (event 4), the level byte is raised, the next one loads and play resumes. */
function finishLevel() { ram[EVENT_AT] = 4; frames(20); ram[LEVEL]++; frames(60); if (ram[LEVEL] < 13) { ram[EVENT_AT] = 0; frames(10); } }
function finishTo(level) { while (ram[LEVEL] < level) finishLevel(); }
/** A death: the lives drop, then a respawn, or the CONTINUE? prompt on the last one. */
function die({ takeContinue = true } = {}) {
  ram[EVENT_AT] = 2; frames(2); ram[EVENT_AT] = 0; setLives(lives() - 1); frames(60);
  if (lives() > 0) { ram[EVENT_AT] = 1; frames(2); ram[EVENT_AT] = 0; frames(10); return; }
  for (let i = 0; i < 5; i++) { ram[EVENT_AT] = 2; frames(1); ram[EVENT_AT] = 0; frames(20); }
  if (takeContinue && continues > 0) { ram[EVENT_AT] = 5; frames(1); setLives(3); setContinues(continues - 1); frames(200); ram[EVENT_AT] = 0; frames(10); }
  else { ram[EVENT_AT] = 3; frames(300); }
}
function pickDiamond() {
  const d = ram[DIAMONDS] * 100 + ram[DIAMONDS + 1] * 10 + ram[DIAMONDS + 2] + 1;
  if (d === 300) { ram.fill(0, DIAMONDS, DIAMONDS + 3); setContinues(continues + 1); }
  else { ram[DIAMONDS] = Math.floor(d / 100); ram[DIAMONDS + 1] = Math.floor(d / 10) % 10; ram[DIAMONDS + 2] = d % 10; }
  setScore(score + 50); frames(2);
}

// 1. Every condition parses, the set names the cartridge, and its trophies run in order.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  for (const h of Object.values(HASHES)) expect(set.hashes.some((x) => x.hash === h), `the set names ${h}`);
  expect(set.achievements.every((a, i) => a.id === i + 1), 'achievement IDs follow display order');
  const [hs, run] = set.leaderboards;
  expect(set.leaderboards.length === 2, 'two boards');
  expect(hs.format === 'SCORE' && !hs.lowerIsBetter, 'a High Score board, higher is better');
  expect(run.format === 'MILLISECS' && run.lowerIsBetter, 'a World 1 Speedrun board, lower is better');
  expect(set.url === 'https://www.lemon64.com/game/turrican', 'the set links the game on Lemon64');
  const icon = GAME_ICONS[set.id];
  expect(icon?.length === 10 && icon.every((row) => /^[#+.]{10}$/.test(row)), 'its icon is 10 by 10 pixels');
  ok(`all ${set.achievements.length} achievements, the boards and the game over parse`);
}

// 2. The listed hash is the cartridge's rcheevos hash.
for (const [key, hash] of Object.entries(HASHES)) {
  const file = assetPath(key);
  if (!file) { console.log(`ok  - test ${++testNo}: ${key} hashes to the listed hash # SKIP ${missingNote(key)}`); continue; }
  expect(rc.hash(fs.readFileSync(file)) === hash, `${path.basename(file)} hashes to ${hash}`);
  ok(`${key} hashes to the listed hash`);
}

// 3. The title counts for nothing.
{
  activate(); powerOn();
  expect(unlocked.size === 0 && !boards.length && !overs, 'nothing on the title');
  ok('the title counts for nothing');
}

// 4. The boards: both start with a game, the speedrun posts at the end of 1-3, the score at GAME OVER.
{
  activate(); powerOn(); newGame();
  expect(started(1).length === 1 && started(1)[0].value === 0, 'the High Score board starts at 0');
  expect(started(2).length === 1, 'the speedrun starts');
  points(4000); finishTo(3);
  expect(posted(2).length === 1 && posted(2)[0] > 0, `the end of 1-3 posts a time (${posted(2)})`);
  points(6000); die(); die(); die();
  expect(started(1).length === 1, 'a respawn and a continue do not restart the board');
  setContinues(0); die(); die(); die({ takeContinue: false });
  expect(overs === 1, 'GAME OVER is the set\'s game over');
  expect(posted(1).length === 1 && posted(1)[0] === 10000, `GAME OVER posts the score (${posted(1)})`);
  newGame();
  expect(started(1).length === 2 && started(2).length === 2, 'a new game starts both again');
  ram[EVENT_AT] = 3; frames(30);
  expect(canceled(2).length === 1, 'GAME OVER before the end of 1-3 cancels the speedrun');
  ok('High Score and World 1 Speedrun');
}

// 5. Finishing the game posts the score, and the next game starts the boards though its lives read 03 already.
{
  activate(); powerOn(); newGame();
  points(150000); finishTo(13);
  expect(posted(1).at(-1) === 150000, `the ending posts the score (${posted(1)})`);
  frames(500);
  expect(overs === 0, 'the ending is no game over: its credits play');
  expect(posted(1).length === 1, 'posted once');
  newGame();
  expect(started(1).length === 2, 'a game after the ending with 3 lives left starts the board');
  ok('the ending');
}

// 6. Levels, worlds and the ending, each once as its level ends.
{
  activate(); powerOn(); newGame();
  const steps = [[1, 'Touchdown'], [3, 'First World Down'], [5, 'Second World Down'], [8, 'Third World Down'], [11, 'Fourth World Down'], [13, 'Light Returns']];
  for (const [to, title] of steps) {
    expect(!has(title), `${title} not before level ${to}`);
    finishTo(to);
    expect(has(title), `${title} as level index ${to - 1} ends`);
  }
  ok('levels and worlds');

  activate(); powerOn(); newGame(); finishTo(2);
  ram[EVENT_AT] = 3; frames(10); ram[LEVEL] = 0x2b; frames(5); ram[LEVEL] = 0x2c; frames(5);
  expect(!has('First World Down') && !has('Light Returns'), 'a loader rewriting the level with no level ended earns nothing');
  ok('only a level\'s end counts');
}

// 7. Diamonds: 100 shown, then the 300th traded for a continue.
{
  activate(); powerOn(); newGame();
  for (let i = 0; i < 99; i++) pickDiamond();
  expect(!has('Sparkle'), '99 is short of 100');
  pickDiamond();
  expect(has('Sparkle'), 'Sparkle at 100');
  for (let i = 0; i < 199; i++) pickDiamond();
  expect(!has('Diamond Dividend'), 'not at 299');
  pickDiamond();
  expect(has('Diamond Dividend') && continues === 4, 'the 300th diamond trades for a continue');
  ok('Sparkle and Diamond Dividend');

  activate(); powerOn(); newGame(); setScore(5000);
  ram[DIAMONDS] = 2; ram[DIAMONDS + 1] = 4; setContinues(2); frames(5);
  newGame();
  expect(!has('Diamond Dividend'), 'a new game clearing 2xx diamonds and resetting the continues is no trade');
  ok('Diamond Dividend only from the 300th diamond');
}

// 8. An extra life, in play only.
{
  activate(); powerOn(); newGame(); points(1000);
  setLives(4); frames(3);
  expect(has('Spare Suit'), 'a fourth life');
  ok('Spare Suit');

  activate(); powerOn(); newGame(); points(1000);
  const spare = set.achievements.find((a) => a.title === 'Spare Suit');
  rc.deactivateAchievement(spare.id); setLives(9); frames(2); rc.activateAchievement(spare.id, spare.memaddr); frames(2);
  expect(!has('Spare Suit'), 'nine lives held is nothing');
  setLives(10); frames(2);
  expect(has('Spare Suit'), 'from 09 to 10');
  ok('Spare Suit across the tens');

  activate(); powerOn(); newGame(); points(1000); die(); die(); die();
  expect(!has('Spare Suit'), 'a continue refilling the lives is no extra life');
  activate(); powerOn(); newGame(); points(1000); setLives(2); frames(2); finishTo(13); newGame();
  expect(!has('Spare Suit'), 'a new game after the ending with 2 lives is no extra life');
  ok('no extra life from a continue or a new game');
}

// 9. The challenges: live from a new game, out at a death (or a continue), live again in the next game.
{
  activate(); powerOn();
  expect(!live('Clean Landing') && !live('One Credit'), 'not live on the title');
  newGame();
  for (const t of ['Clean Landing', 'Flawless World', 'One Credit', 'Unbreakable']) expect(live(t), `${t} live as a game starts`);
  die();
  expect(!live('Clean Landing') && !live('Flawless World') && !live('Unbreakable'), 'a lost life puts the no-death ones out');
  expect(live('One Credit'), 'a lost life is no continue');
  die(); die();
  expect(!live('One Credit'), 'a continue puts One Credit out');
  finishTo(13);
  expect(!has('Clean Landing') && !has('Flawless World') && !has('One Credit') && !has('Unbreakable'), 'a run after both earns none');
  newGame();
  expect(live('Clean Landing') && live('Unbreakable'), 'live again in the next game');
  ok('challenges go out and come back');

  activate(); powerOn(); newGame();
  finishTo(1);
  expect(has('Clean Landing') && !has('Flawless World'), 'a clean 1-1');
  finishTo(3);
  expect(has('Flawless World'), 'a clean world 1');
  die();
  finishTo(13);
  expect(has('One Credit') && !has('Unbreakable'), 'a death but no continue');
  ok('Clean Landing, Flawless World and One Credit');

  activate(); powerOn(); newGame(); points(2000); setLives(4); frames(3); finishTo(13);
  expect(has('Unbreakable') && has('One Credit'), 'a whole game with no life lost, an extra life no matter');
  ok('Unbreakable');
}

// 10. Score ranks read the digits, in a game only.
{
  activate(); powerOn();
  ram.fill(0xff, SCORE, SCORE + 7); frames(5);
  expect(!has('Rookie'), 'stray bytes on the title score nothing');
  newGame();
  for (const [t, n] of [['Rookie', 25000], ['Trooper', 50000], ['Top of the Table', 100000], ['Legend', 150000]]) {
    setScore(n - 10); frames(2);
    expect(!has(t), `${n - 10} is short of ${t}`);
    setScore(n); frames(2);
    expect(has(t), `${t} at ${n}`);
  }
  ok('score ranks');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - turrican set: ${testNo} checks`);
