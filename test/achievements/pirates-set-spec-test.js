// Spec tests for the Pirates! achievement set (server/sets/pirates.json, MicroProse 1987, Nostalgia's +10
// EasyFlash release in the OneLoad64 v5 extras) under rcheevos, on synthesized RAM laid out as the game's
// BASIC keeps it (PRS = $9400, the personal record):
//   $0801 the BASIC program in memory: 25 08 00 00 8F the intro (new career, saved games, expeditions),
//         1E 08 04 00 the main game, 07 08 00 00 8F 00 the retirement.
//   $9402/$9403 your own gold / 10, $9404 fame (signed), $9405 land / 50 acres, $9406 relatives rescued,
//   $940C 255 once a career is set up, $940D-$9410 the title from each nation (1 Ensign .. 9 Duke, one
//   step per promotion), $9414 the bride (1 shrewish .. 4 exciting and beautiful), $93FD difficulty.
//   $9300 the ship's log: a count, then 4-byte entries from $9301, the event at +2 (3 plundered a town,
//         4 captured a ship, 8 found buried treasure, 24 the treasure fleet, 25 the silver train). At 62
//         entries the older half is dropped.
//   $35EB the retirement program's PT, a BASIC float: PTY's address (37920) until the career is scored,
//         then the Pirate Points.
//   $02FF the +10 trainer's flag, 1 while any cheat is on.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/pirates.json'), 'utf8')), 'pirates.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const id = Object.fromEntries(set.achievements.map((a) => [a.title, a.id]));
const HASHES = { 'pirates-crt': 'a2b122448c4c4981e4f125f2aa15d957' };
const PRS = 0x9400, LOG = 0x9300, PT = 0x35eb, TRAINER = 0x2ff;
const GAME_OVER_ID = 999, NOTICE_ID = 998;

const unlocked = new Set();
const boards = [];
let overs = 0, notices = 0;
function activate() {
  rc.clear(); unlocked.clear(); boards.length = 0; overs = 0; notices = 0; ram.fill(0);
  const codes = set.achievements.map((a) => rc.activateAchievement(a.id, a.memaddr));
  codes.push(rc.activateAchievement(GAME_OVER_ID, set.gameOver));
  codes.push(rc.activateAchievement(NOTICE_ID, set.notices[0].memaddr));
  for (const l of set.leaderboards) codes.push(rc.activateLeaderboard(l.id, l.definition));
  return codes;
}
function frame() {
  for (const e of rc.doFrame(ram)) {
    if (e.type === EVENT.ACHIEVEMENT_TRIGGERED) {
      if (e.id === GAME_OVER_ID) { overs++; rc.deactivateAchievement(GAME_OVER_ID); rc.activateAchievement(GAME_OVER_ID, set.gameOver); }
      else if (e.id === NOTICE_ID) notices++;
      else unlocked.add(e.id);
    } else if (e.type === EVENT.LBOARD_STARTED || e.type === EVENT.LBOARD_TRIGGERED || e.type === EVENT.LBOARD_CANCELED) boards.push({ ...e });
  }
}
const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
const has = (title) => unlocked.has(id[title]);
const posted = () => boards.filter((e) => e.type === EVENT.LBOARD_TRIGGERED).map((e) => e.value);

const INTRO = [0x25, 0x08, 0x00, 0x00, 0x8f, 0x20], MAIN = [0x1e, 0x08, 0x04, 0x00, 0x97, 0x35], RETIRE = [0x07, 0x08, 0x00, 0x00, 0x8f, 0x00];
const program = (bytes) => ram.set(bytes, 0x801);
/** A C64 BASIC float (exponent, then the mantissa with the sign in its top bit). */
function setFloat(addr, v) {
  ram.fill(0, addr, addr + 5);
  if (!v) return;
  const e = Math.floor(Math.log2(Math.abs(v))) + 1;
  let m = Math.round(Math.abs(v) / 2 ** e * 2 ** 32);
  ram[addr] = e + 128;
  for (let i = 4; i >= 1; i--) { ram[addr + i] = m & 0xff; m = Math.floor(m / 256); }
  ram[addr + 1] = (ram[addr + 1] & 0x7f) | (v < 0 ? 0x80 : 0);
}
/** Power-on to the intro: the trainer menu's leftovers, then the intro program with no record yet. */
function intro() { ram.fill(0x4c, PRS - 8, PRS + 0x60); program(INTRO); frames(30); }
/** A new career, as the intro sets it up (titles and standing from the era's data), then the main game. */
function newCareer({ titles = [0, 0, 0, 0], difficulty = 0 } = {}) {
  intro();
  ram.fill(0, PRS - 8, PRS + 0x60); ram[PRS + 12] = 255; ram[PRS + 2] = 20; ram[PRS - 3] = difficulty;
  ram.set(titles, PRS + 13); ram.set([72, 79, 79, 75], PRS + 80);
  ram.fill(0, LOG, LOG + 1 + 62 * 4); logEvent(16); logEvent(15); frames(30);
  program(MAIN); frames(30);
}
function logEvent(event, detail = 0) {
  let n = ram[LOG];
  if (n >= 62) { ram.copyWithin(LOG + 1, LOG + 1 + 128, LOG + 1 + 256); n -= 32; }
  const a = LOG + 1 + n * 4; ram[a] = 1; ram[a + 1] = 0; ram[a + 2] = event; ram[a + 3] = detail; ram[LOG] = n + 1;
}
const promote = (nation) => { ram[PRS + 13 + nation]++; frames(5); };
function wealth(gold) { const v = gold / 10; ram[PRS + 2] = v & 0xff; ram[PRS + 3] = v >> 8; }
/** Retirement: the program is swapped in, PT holds PTY's address, then the score; the screens follow. */
function retire(points) {
  program(RETIRE); ram.fill(0x55, PT, PT + 7); frames(5);
  ram.set([0x50, 0x54], PT); setFloat(PT + 2, 37920); frames(30);
  setFloat(PT + 2, points); frames(300);
}

// 1. Every condition parses, the set names the cartridge, and its trophies run in order.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  for (const h of Object.values(HASHES)) expect(set.hashes.some((x) => x.hash === h), `the set names ${h}`);
  expect(set.achievements.every((a, i) => a.id === i + 1), 'achievement IDs follow display order');
  const [pp] = set.leaderboards;
  expect(set.leaderboards.length === 1 && pp.format === 'VALUE' && !pp.lowerIsBetter, 'one Pirate Points board, higher is better');
  expect(set.url === 'https://www.lemon64.com/game/pirates', 'the set links the game on Lemon64');
  const icon = GAME_ICONS[set.id];
  expect(icon?.length === 10 && icon.every((row) => /^[#+.]{10}$/.test(row)), 'its icon is 10 by 10 pixels');
  ok(`all ${set.achievements.length} achievements, the board, the notice and the game over parse`);
}

// 2. The listed hash is the cartridge's rcheevos hash.
for (const [key, hash] of Object.entries(HASHES)) {
  const file = assetPath(key);
  if (!file) { console.log(`ok  - test ${++testNo}: ${key} hashes to the listed hash # SKIP ${missingNote(key)}`); continue; }
  expect(rc.hash(fs.readFileSync(file)) === hash, `${path.basename(file)} hashes to ${hash}`);
  ok(`${key} hashes to the listed hash`);
}

// 3. The intro and the start of a career count for nothing, even a career that starts with a title.
{
  activate(); intro();
  expect(unlocked.size === 0 && !boards.length && !overs && !notices, 'nothing in the intro');
  newCareer({ titles: [0, 1, 0, 0] });
  expect(unlocked.size === 0, `nothing as the career starts (${[...unlocked]})`);
  ok('the intro and a new career count for nothing');
}

// 4. A saved game is loaded by the intro program, so its titles, land and wealth count for nothing.
{
  activate(); newCareer(); intro();
  ram.set([5, 9, 0, 0], PRS + 13); ram[PRS + 5] = 80; ram[PRS + 20] = 4; ram[PRS + 6] = 4; ram[PRS + 4] = 20; wealth(200000);
  logEvent(24); frames(10); program(MAIN); frames(30);
  expect(unlocked.size === 0, `nothing from a loaded game (${[...unlocked]})`);
  ok('a loaded saved game counts for nothing');
}

// 5. A promotion raises one nation's title a step: each title unlocks its trophy, from any nation.
{
  activate(); newCareer();
  promote(1); expect(has('Commissioned'), 'Ensign');
  promote(1); expect(has('Captain of the Crown'), 'Captain');
  promote(1); promote(1); expect(has('Colonel'), 'Colonel');
  expect(!has('Admiral of the Main'), 'no Admiral at Colonel');
  promote(2); promote(2); promote(2); promote(2); promote(2);
  expect(has('Admiral of the Main'), 'Admiral, from France');
  promote(1); promote(1); expect(has('Ennobled'), 'Baron');
  promote(1); promote(1); expect(!has('His Grace'), 'no Duke at Marquis');
  promote(1); expect(has('His Grace'), 'Duke');
  ok('each promotion unlocks its title');
}

// 6. A title that jumps, as no promotion does, counts for nothing.
{
  activate(); newCareer();
  ram[PRS + 14] = 9; frames(10);
  expect(unlocked.size === 0, `nothing from a jump to Duke (${[...unlocked]})`);
  ok('a title that jumps counts for nothing');
}

// 7. Land comes in 50-acre grants, and the record holds up to 255 of them.
{
  activate(); newCareer();
  ram[PRS + 5] = 3; frames(5); expect(has('Land Grant'), 'the first grant');
  ram[PRS + 5] = 49; frames(5); expect(!has('Great Estate'), 'no Great Estate at 2,450 acres');
  ram[PRS + 5] = 53; frames(5); expect(has('Great Estate'), 'Great Estate past 2,500 acres');
  ok('land grants');
}

// 8. A wedding sets the bride, 1 to 4: the fourth is the exciting and beautiful one.
{
  activate(); newCareer(); ram[PRS + 20] = 2; frames(5);
  expect(has('Wedding Bells') && !has('Fairest of Them All'), 'a friendly and attractive bride');
  activate(); newCareer(); ram[PRS + 20] = 4; frames(5);
  expect(has('Wedding Bells') && has('Fairest of Them All'), 'an exciting and beautiful bride');
  ok('marriage');
}

// 9. Each rescued relative adds one, up to the four.
{
  activate(); newCareer();
  for (let n = 1; n <= 3; n++) { ram[PRS + 6] = n; frames(5); }
  expect(has('Family Ties') && !has('Family Reunion'), 'three of four');
  ram[PRS + 6] = 4; frames(5); expect(has('Family Reunion'), 'all four');
  ok('the lost family');
}

// 10. The ship's log: a new entry unlocks for its event, and only a new one.
{
  activate(); newCareer();
  for (const e of [1, 2, 5, 6, 9, 16, 19, 20, 21]) { logEvent(e); frames(3); }
  expect(unlocked.size === 0, `other entries unlock nothing (${[...unlocked]})`);
  logEvent(4); frames(3); expect(has('Prize Taken'), 'a captured ship');
  logEvent(3); frames(3); expect(has('Sack and Pillage'), 'a plundered town');
  logEvent(8); frames(3); expect(has('X Marks the Spot'), 'buried treasure');
  logEvent(25); frames(3); expect(has('Silver Train'), 'the silver train');
  expect(!has('Treasure Fleet'), 'not the treasure fleet');
  logEvent(24); frames(3); expect(has('Treasure Fleet'), 'the treasure fleet');
  ok('log events');
}

// 11. When the log is full its older half is dropped: the entries that stay count for nothing.
{
  activate(); newCareer();
  logEvent(4); while (ram[LOG] < 62) logEvent(1); frames(3);
  activate(); program(MAIN); ram[PRS + 12] = 255; frames(5);
  logEvent(1); frames(3); logEvent(1); frames(3);
  expect(!has('Prize Taken'), 'an old capture does not count again');
  ok('a full log');
}

// 12. Fame is signed: a coward's fame (255) is not fame.
{
  activate(); newCareer();
  ram[PRS + 4] = 255; frames(5); expect(!has('Famous'), 'not famous as a coward');
  ram[PRS + 4] = 9; frames(5); expect(has('Famous') && !has('Infamous!'), 'famous');
  ram[PRS + 4] = 17; frames(5); expect(has('Infamous!'), 'infamous');
  ok('fame');
}

// 13. Your own gold, kept in tens.
{
  activate(); newCareer();
  wealth(9990); frames(5); expect(!has('Nest Egg'), 'not at 9,990');
  wealth(12000); frames(5); expect(has('Nest Egg') && !has('Fortune of the Main'), 'Nest Egg at 12,000');
  wealth(100000); frames(5); expect(has('Fortune of the Main'), 'Fortune of the Main at 100,000');
  ok('your own gold');
}

// 14. With a trainer cheat on, the notice shows and nothing counts.
{
  activate(); newCareer(); ram[TRAINER] = 1; frames(5);
  expect(notices === 1, 'the trainer notice shows');
  promote(1); ram[PRS + 20] = 4; logEvent(4); wealth(100000); frames(5);
  expect(unlocked.size === 0, `nothing with a cheat on (${[...unlocked]})`);
  retire(99);
  expect(unlocked.size === 0 && !posted().length && !overs, 'no retirement either');
  ok('a trainer cheat');
}

// 15. Retirement scores the career: the trophies by Pirate Points, the board and the game over.
{
  activate(); newCareer(); retire(42);
  expect(has('Ashore for Good') && !has('Comfortable Retirement'), 'retired, short of 50 points');
  expect(posted().length === 1 && posted()[0] === 42, `42 points posted (${posted()})`);
  expect(overs === 1, 'the game is over');
  activate(); newCareer(); retire(60);
  expect(has('Comfortable Retirement') && !has("King's Advisor"), '60 points');
  activate(); newCareer(); retire(97);
  expect(has("King's Advisor") && posted()[0] === 97, "97 points make the King's Advisor");
  ok('retirement');
}

// 16. A retirement in debt unlocks only the retirement, and posts no score.
{
  activate(); newCareer(); retire(-12);
  expect(has('Ashore for Good') && unlocked.size === 1, 'retired');
  expect(!posted().length, 'nothing posted');
  ok('a retirement in debt');
}

// 17. Retiring at the Swashbuckler level.
{
  activate(); newCareer({ difficulty: 2 }); retire(30);
  expect(!has("Swashbuckler's Rest"), 'not as an Adventurer');
  activate(); newCareer({ difficulty: 3 }); retire(30);
  expect(has("Swashbuckler's Rest"), 'as a Swashbuckler');
  ok('the Swashbuckler level');
}

// 18. Returning to the pirate life and retiring again scores again.
{
  activate(); newCareer(); retire(20); program(MAIN); frames(60); retire(35);
  expect(JSON.stringify(posted()) === '[20,35]', `both posted (${posted()})`);
  ok('a second retirement');
}

console.log(failing ? `\n${failing} of ${testNo} failed` : `\nall ${testNo} passed`);
process.exit(failing ? 1 : 0);
