// Spec tests for the Turrican II: The Final Fight achievement set (server/sets/turrican-ii.json, Rainbow
// Arts 1991, on the OneLoad64 v5 MultiLoad64 EasyFlash cartridge) under rcheevos, on synthesized RAM laid
// out as the game keeps it:
//   $03EF the level, 0-10 for 1-1 1-2 2-1 2-2 3-1 3-2 3-3 4-1 4-2 5-1 5-2 (2-2, 3-1 and 3-2 are flown in
//         the ship), raised as a level ends: 11 is the final tally and the credits.
//   $03E4 the event: 0 play, 1 a respawn, 3 GAME OVER, 4 a level done, 5 a level loading, at a new
//         game (score 0) and at a continue. Ship levels respawn with no event.
//   $FFFC the lives, BCD: 3 at a start and on a continue, 0 after the tally and on the title.
//   $07FA-$07FD the score, BCD. $0737 the diamonds, BCD: a pickup with 50 shown trades them for a
//         continue, shown at $0778 as $AC + the count. The tally turns the lives, the continues, the time
//         ($080F-$0811) and the power lines ($0738) into points, through $07F6-$07F9.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/turrican-ii.json'), 'utf8')), 'turrican-ii.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const id = Object.fromEntries(set.achievements.map((a) => [a.title, a.id]));
const HASHES = { 'turrican-ii-crt': '14203a5f31fc13a9751f082de502508e' };
const LEVEL = 0x3ef, EVENT_AT = 0x3e4, LIVES = 0xfffc, SCORE = 0x7fa, PENDING = 0x7f6, DIAMONDS = 0x737, LINES = 0x738, TIME = 0x80f, CONT = 0x778;
const SHIP_LEVELS = [3, 4, 5];
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

const bcd = (n) => Math.floor(n / 10) * 16 + (n % 10);
const unbcd = (b) => (b >> 4) * 10 + (b & 15);
let score = 0;
function setScore(n) { score = n; for (let i = 0; i < 4; i++) ram[SCORE + 3 - i] = bcd(Math.floor(n / 100 ** i) % 100); }
function points(n) { setScore(score + n); frames(3); }
const lives = () => unbcd(ram[LIVES]);
const setLives = (n) => { ram[LIVES] = bcd(n); };
let continues = 1;
function setContinues(n) { continues = n; ram[CONT] = 0xac + n; }
/** Power-on's title: no lives, a stray level byte, event 1. */
function powerOn() { ram[LIVES] = 0; ram[LEVEL] = 0xa0; ram[EVENT_AT] = 1; frames(30); }
/** A new game from the title: level 0, event 5, then the lives, the load, and play. */
function newGame() {
  setScore(0); ram[DIAMONDS] = 0; ram[LINES] = 3; ram[LEVEL] = 0; ram[EVENT_AT] = 5; frames(2);
  setLives(3); setContinues(1); ram.set([0, 0, 8], TIME); frames(200); ram[EVENT_AT] = 0; frames(10);
}
/** The level ends (event 4), the level byte is raised, the next one loads and play resumes. */
function finishLevel() {
  ram[EVENT_AT] = 4; frames(20); ram[LEVEL]++; frames(60);
  if (ram[LEVEL] < 11) { ram[EVENT_AT] = 0; frames(10); } else tally();
}
function finishTo(level) { while (ram[LEVEL] < level) finishLevel(); }
/** The final tally: lives x 50,000, continues x 10,000, time x 100 and power lines x 5,000, step by step. */
function tally() {
  const pending = (n) => { for (let i = 0; i < 4; i++) ram[PENDING + 3 - i] = bcd(Math.floor(n / 100 ** i) % 100); };
  const step = (get, put, each) => { while (get() > 0) { put(get() - 1); pending(each); frames(1); setScore(score + each); pending(0); frames(2); } };
  step(lives, setLives, 50000);
  step(() => continues, setContinues, 10000);
  const time = () => ram[TIME] + ram[TIME + 1] * 10 + ram[TIME + 2] * 100;
  step(time, (t) => ram.set([t % 10, Math.floor(t / 10) % 10, Math.floor(t / 100)], TIME), 100);
  step(() => ram[LINES], (n) => { ram[LINES] = n; }, 5000);
  frames(200);
}
/** A death: on foot a respawn, in the ship none, or the CONTINUE? prompt on the last life. */
function die({ takeContinue = true } = {}) {
  setLives(lives() - 1); frames(60);
  if (lives() > 0) { if (!SHIP_LEVELS.includes(ram[LEVEL])) { ram[EVENT_AT] = 1; frames(2); ram[EVENT_AT] = 0; } frames(10); return; }
  frames(100);
  if (takeContinue && continues > 0) { setContinues(continues - 1); ram[EVENT_AT] = 5; frames(1); setLives(3); frames(300); ram[EVENT_AT] = 0; frames(10); }
  else { ram[EVENT_AT] = 3; frames(300); }
}
function pickDiamond() {
  if (ram[DIAMONDS] === 0x50) { ram[DIAMONDS] = 0; if (continues < 9) setContinues(continues + 1); }
  else ram[DIAMONDS] = bcd(unbcd(ram[DIAMONDS]) + 1);
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
  expect(set.url === 'https://www.lemon64.com/game/turrican-2', 'the set links the game on Lemon64');
  expect(GAME_ICONS.has(set.id), 'the game has its icon');
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

// 4. The boards: both start with a game, the speedrun posts at the end of 1-2, the score at GAME OVER.
{
  activate(); powerOn(); newGame();
  expect(started(1).length === 1 && started(1)[0].value === 0, 'the High Score board starts at 0');
  expect(started(2).length === 1, 'the speedrun starts');
  points(4000); finishTo(2);
  expect(posted(2).length === 1 && posted(2)[0] > 0, `the end of 1-2 posts a time (${posted(2)})`);
  points(6000); die(); die(); die();
  expect(started(1).length === 1, 'a respawn and a continue do not restart the board');
  die(); die(); die();
  expect(overs === 1, 'GAME OVER is the set\'s game over');
  expect(posted(1).length === 1 && posted(1)[0] === 10000, `GAME OVER posts the score (${posted(1)})`);
  powerOn(); newGame();
  expect(started(1).length === 2 && started(2).length === 2, 'a new game starts both again');
  ram[EVENT_AT] = 3; frames(30);
  expect(canceled(2).length === 1, 'GAME OVER before the end of 1-2 cancels the speedrun');
  ok('High Score and World 1 Speedrun');
}

// 5. Finishing the game posts the score once the tally has added everything.
{
  activate(); powerOn(); newGame();
  points(80000); finishTo(10);
  ram.set([1, 4, 0], TIME); setLives(2); setContinues(1); frames(3);
  finishLevel();
  const want = 80000 + 2 * 50000 + 10000 + 41 * 100 + 3 * 5000;
  expect(score === want, `the tally adds everything (${score})`);
  expect(posted(1).length === 1 && posted(1)[0] === want, `the board posts the tallied score (${posted(1)}, not ${want})`);
  frames(500);
  expect(overs === 0, `the end is no game over: its credits play (${overs})`);
  expect(posted(1).length === 1, 'posted once');
  ok('the final tally');
}

// 6. Levels, worlds and the end, each once as its level ends.
{
  activate(); powerOn(); newGame();
  const steps = [[1, 'Boots on the Ground'], [2, 'First World Down'], [4, 'Second World Down'], [7, 'Third World Down'], [9, 'Fourth World Down'], [11, 'The Final Fight']];
  for (const [to, title] of steps) {
    expect(!has(title), `${title} not before level ${to}`);
    finishTo(to);
    expect(has(title), `${title} as level index ${to - 1} ends`);
  }
  ok('levels and worlds');

  activate(); powerOn(); newGame(); finishTo(1);
  ram[EVENT_AT] = 3; frames(10); ram[LEVEL] = 1; frames(5); ram[LEVEL] = 2; frames(5);
  expect(!has('First World Down'), 'the level byte moving with no level ended earns nothing');
  ok('only a level\'s end counts');
}

// 7. Ace Pilot: the three ship levels without losing a ship.
{
  activate(); powerOn(); newGame();
  die(); finishTo(3);
  expect(live('Ace Pilot'), 'live from the start of 2-2, a life lost before no matter');
  finishTo(6);
  expect(has('Ace Pilot'), 'earned as 3-2 ends');
  ok('Ace Pilot');

  activate(); powerOn(); newGame(); finishTo(4);
  die();
  expect(!live('Ace Pilot'), 'a ship lost puts it out');
  finishTo(6);
  expect(!has('Ace Pilot'), 'not earned after a ship lost');
  ok('Ace Pilot out at a lost ship');
}

// 8. Diamonds: 50 shown, then the next one trades them for a continue.
{
  activate(); powerOn(); newGame();
  for (let i = 0; i < 49; i++) pickDiamond();
  expect(!has('Sparkle'), '49 is short of 50');
  pickDiamond();
  expect(has('Sparkle'), 'Sparkle at 50');
  expect(!has('Diamond Dividend'), 'not yet traded');
  pickDiamond();
  expect(has('Diamond Dividend') && continues === 2, 'the next diamond trades them for a continue');
  ok('Sparkle and Diamond Dividend');
}

// 9. An extra life, in play only.
{
  activate(); powerOn(); newGame(); points(1000);
  setLives(4); frames(3);
  expect(has('Spare Suit'), 'a fourth life');
  ok('Spare Suit');

  activate(); powerOn(); newGame(); points(1000); die(); die(); die();
  expect(!has('Spare Suit'), 'a continue refilling the lives is no extra life');
  powerOn(); newGame();
  expect(!has('Spare Suit'), 'a new game is no extra life');
  ok('no extra life from a continue or a new game');
}

// 10. The challenges: live from a new game, out at a lost life or a continue, live again in the next game.
{
  activate(); powerOn();
  expect(!live('Clean Landing') && !live('One Credit'), 'not live on the title');
  newGame();
  for (const t of ['Clean Landing', 'Flawless World', 'One Credit', 'Unbreakable']) expect(live(t), `${t} live as a game starts`);
  points(500); die();
  expect(!live('Clean Landing') && !live('Flawless World') && !live('Unbreakable'), 'a lost life puts the no-death ones out');
  expect(live('One Credit'), 'a lost life is no continue');
  die(); die();
  expect(!live('One Credit'), 'a continue puts One Credit out');
  finishTo(11);
  expect(!has('Clean Landing') && !has('Flawless World') && !has('One Credit') && !has('Unbreakable'), 'a run after both earns none');
  powerOn(); newGame();
  expect(live('Clean Landing') && live('Unbreakable'), 'live again in the next game');
  ok('challenges go out and come back');

  activate(); powerOn(); newGame();
  finishTo(1);
  expect(has('Clean Landing') && !has('Flawless World'), 'a clean 1-1');
  finishTo(2);
  expect(has('Flawless World'), 'a clean world 1');
  finishTo(4); die();
  finishTo(11);
  expect(has('One Credit') && !has('Unbreakable'), 'a ship lost but no continue');
  ok('Clean Landing, Flawless World and One Credit');

  activate(); powerOn(); newGame(); points(2000); setLives(4); frames(3); finishTo(11);
  expect(has('Unbreakable') && has('One Credit'), 'a whole game with no life lost, the tally emptying the lives no matter');
  ok('Unbreakable');
}

// 11. Score ranks read the BCD score, in a game only.
{
  activate(); powerOn();
  ram.fill(0x99, SCORE, SCORE + 4); frames(5);
  expect(!has('Rookie'), 'stray bytes on the title score nothing');
  newGame();
  for (const [t, n] of [['Rookie', 25000], ['Trooper', 50000], ['Top of the Table', 100000], ['Legend', 250000]]) {
    setScore(n - 50); frames(2);
    expect(!has(t), `${n - 50} is short of ${t}`);
    setScore(n); frames(2);
    expect(has(t), `${t} at ${n}`);
  }
  ok('score ranks');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - turrican-ii set: ${testNo} checks`);
