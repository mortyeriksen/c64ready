// Spec tests for the Green Beret achievement set (server/sets/green-beret.json, Imagine 1986, on the
// OneLoad64 v5 cartridge and its crunched and uncrunched programs) under rcheevos, on synthesized RAM
// laid out as the game keeps it:
//   $039A the player: 0 alive, 1 dying and on the title, $3F (re)spawning, as a game starts too.
//   $03B3 the lives in reserve: 2 at the start, up to 9 with extra lives, 0 on the last, $FF at GAME
//         OVER. The title sets 2 again.
//   $03B1 the stage - 1: 4 as the captives are rescued, then 0 as the next mission starts.
//   $0264 the special weapon carried, 0 for none: cleared as each stage and game starts.
//   $03B4/$03B5/$03B6 the score in tens, BCD, zero at a game's start. $C433-$C439 its seven digit
//         characters on screen, the last always '0'. Before the status row is drawn they are $FF and 0.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/green-beret.json'), 'utf8')), 'green-beret.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const id = Object.fromEntries(set.achievements.map((a) => [a.title, a.id]));
const HASHES = { 'green-beret-crt': 'a3a897a0a9ccde307548c6132002e462', 'green-beret-prg-crunched': '3b4e279df48c704dda68b22bd7180302', 'green-beret-prg-uncrunched': 'dcf88d3490deeb4bee8ecaa7e28abd93' };
const PLAYER = 0x39a, LIVES = 0x3b3, STAGE = 0x3b1, WEAPON = 0x264, DIGITS = 0xc433;
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
let score = 0;
/** The score: the BCD bytes, then the screen's digits as the game draws them. */
function setScore(n) {
  score = n; const t = Math.floor(n / 10);
  ram[0x3b4] = bcd(t % 100); ram[0x3b5] = bcd(Math.floor(t / 100) % 100); ram[0x3b6] = bcd(Math.floor(t / 10000) % 100);
  const s = String(n).padStart(7, '0'); for (let i = 0; i < 7; i++) ram[DIGITS + i] = 48 + Number(s[i]);
}
function points(n) { setScore(score + n); frames(3); }
/** Power-on's loading picture: the digits not drawn ($FF and 0), a stray byte in the score's thousands. */
function loading() { ram.fill(0xff, DIGITS, DIGITS + 3); ram.fill(0, DIGITS + 3, DIGITS + 7); ram[0x3b5] = 0x29; frames(20); }
/** The title: two lives, stage 1, a zero score, the player byte at 1. */
function title() { ram[PLAYER] = 1; ram[LIVES] = 2; ram[STAGE] = 0; ram[WEAPON] = 0; setScore(0); frames(10); }
/** A game from the title: the player spawns ($3F), then is alive. */
function start() { ram[PLAYER] = 0x3f; frames(40); ram[PLAYER] = 0; frames(10); }
function clearStage() { ram[STAGE]++; ram[WEAPON] = 0; ram[PLAYER] = 1; frames(30); if (ram[STAGE] === 4) { ram[STAGE] = 0; frames(30); } ram[PLAYER] = 0x3f; frames(40); ram[PLAYER] = 0; frames(5); }
function loseLife() { ram[PLAYER] = 1; frames(20); ram[LIVES] = ram[LIVES] === 0 ? 0xff : ram[LIVES] - 1; frames(5); if (ram[LIVES] !== 0xff) { ram[PLAYER] = 0x3f; frames(40); ram[PLAYER] = 0; frames(5); } }
function gameOver() { while (ram[LIVES] !== 0xff) loseLife(); frames(60); }
function pickUp(k) { ram[WEAPON] = k; frames(5); }

// 1. Every condition parses, the set names the three files, and its trophies run in order.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  for (const h of Object.values(HASHES)) expect(set.hashes.some((x) => x.hash === h), `the set names ${h}`);
  expect(set.hashes.length === 3, 'the cartridge and its two programs');
  expect(set.achievements.every((a, i) => a.id === i + 1), 'achievement IDs follow display order');
  expect(set.leaderboards.length === 1 && set.leaderboards[0].format === 'SCORE' && !set.leaderboards[0].lowerIsBetter, 'one High Score board, higher is better');
  expect(set.url === 'https://www.lemon64.com/games/details.php?ID=1096', 'the set links the game on Lemon64');
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

// 3. The loading picture and the title count for nothing.
{
  activate(); loading();
  ram[LIVES] = 2; frames(5); ram[PLAYER] = 1; frames(5);
  title();
  expect(unlocked.size === 0 && !started().length && !overs, 'nothing before a game');
  ok('the loading picture and the title count for nothing');
}

// 4. The board starts at 0 as a game starts and posts the score at GAME OVER.
{
  activate(); title(); start();
  expect(started().length === 1 && started()[0].value === 0, `the board starts at 0 (${started().map((e) => e.value)})`);
  points(12340); loseLife();
  expect(started().length === 1, 'a respawn does not restart it');
  points(5000); gameOver();
  expect(overs === 1, 'GAME OVER is the set\'s game over');
  expect(posted().length === 1 && posted()[0] === 17340, `GAME OVER posts the score (${posted()})`);
  title(); start();
  expect(started().length === 2, 'a new game starts it again');
  ok('the High Score board');
}

// 5. The stages, the rescue and the second mission.
{
  activate(); title(); start();
  clearStage();
  expect(has('Missile Base Taken') && !has('Harbour Secured'), 'stage 1');
  clearStage();
  expect(has('Harbour Secured') && !has('Choppers Down'), 'stage 2');
  clearStage();
  expect(has('Choppers Down') && !has('Captives Rescued'), 'stage 3');
  expect(!has('Second Tour'), 'not on the first mission');
  clearStage();
  expect(has('Captives Rescued'), 'stage 4 rescues the captives');
  expect(!has('Second Tour'), 'not as the second mission starts');
  clearStage();
  expect(has('Second Tour'), 'stage 1 again, on the second mission');
  ok('stages and missions');

  activate(); title(); start();
  for (let i = 0; i < 4; i++) clearStage();
  gameOver(); title(); start(); clearStage();
  expect(!has('Second Tour'), 'a new game\'s stage 1 is no second mission');
  ok('Second Tour needs one game');
}

// 6. A weapon and an extra life, in a game only.
{
  activate(); title(); start();
  pickUp(2);
  expect(has('Armed'), 'a special weapon picked up');
  expect(!has('Reinforcements'), 'no extra life yet');
  points(30000); ram[LIVES]++; frames(3);
  expect(has('Reinforcements'), 'an extra life');
  ok('Armed and Reinforcements');

  activate(); loading(); ram[LIVES] = 2; frames(5);
  expect(!has('Reinforcements'), 'the lives set from 0 at power-on are no extra life');
  title(); ram[LIVES] = 0xff; frames(5); ram[LIVES] = 2; frames(5);
  expect(!has('Reinforcements'), 'the title\'s reset of the lives is no extra life');
  ok('extra lives only in a game');
}

// 7. The challenges: live from a game's start, out at a lost life (or a weapon), live again in the next.
{
  activate(); title();
  expect(!live('Clean Sweep') && !live('Cold Steel') && !live('Iron Beret'), 'not live on the title');
  start();
  expect(live('Clean Sweep') && live('Cold Steel') && live('Iron Beret'), 'all three live as a game starts');
  pickUp(4);
  expect(!live('Cold Steel') && live('Clean Sweep'), 'a weapon puts Cold Steel out');
  loseLife();
  expect(!live('Clean Sweep') && !live('Iron Beret'), 'a lost life puts the others out');
  clearStage();
  expect(!has('Clean Sweep') && !has('Cold Steel'), 'stage 1 cleared after both earns neither');
  gameOver(); title(); start();
  expect(live('Clean Sweep') && live('Cold Steel'), 'live again in the next game');
  points(30000); ram[LIVES]++; frames(3);
  clearStage();
  expect(has('Clean Sweep') && has('Cold Steel'), 'a clean stage 1 with the knife earns both, an extra life no matter');
  for (let i = 0; i < 3; i++) { pickUp(2); clearStage(); }
  expect(has('Iron Beret'), 'the captives rescued with no life lost, weapons or not');
  ok('Clean Sweep, Cold Steel and Iron Beret');
}

// 8. Score ranks read the screen's digits, never the loading picture's stray byte.
{
  activate(); loading(); ram[0xc439] = 0x30; frames(5);
  expect(!has('Private'), 'the loading picture\'s undrawn digits score nothing');
  ram.fill(0x30, DIGITS, DIGITS + 7); frames(5);
  expect(!has('Private'), 'the row drawn as 0000000, with the stray byte still in place, scores nothing');
  title(); start();
  for (const [t, n] of [['Private', 25000], ['Sergeant', 50000], ['Captain', 100000], ['Colonel', 200000]]) {
    setScore(n - 10); frames(2);
    expect(!has(t), `${n - 10} is short of ${t}`);
    setScore(n); frames(2);
    expect(has(t), `${t} at ${n}`);
  }
  ok('score ranks');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - green-beret set: ${testNo} checks`);
