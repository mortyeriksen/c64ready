// Spec tests for the Commando achievement set (server/sets/commando.json) under
// rcheevos, on synthesized RAM laid out as the game keeps it:
//   $04F8/$04F9  score in hundreds, BCD ($04F9 holds the high two digits; the
//                last two digits on screen are always 00)
//   $0500        men (lives), BCD: 5 at the start, +1 every 10,000 points
//   $04FF        grenades, BCD: 5 at the start, +3 per box, topped up to 5 on respawn
//   $0503        0 while the player is alive, nonzero while a man is dying
//   $04F3        area: 0, 1, 3 are the three areas, +4 per completed mission;
//                2 while the title or a between-areas screen shows
//   $0403        map rows left to scroll in the area: 0 at the gate
//   $E348/$E349  screen codes of "SC" in the status line's SCORE label, drawn
//                only on the play screen
// A game starts when the status line appears in the 1st area with five men and
// a zero score. Every achievement waits for that start: the game also draws its
// status line once over uninitialised RAM before the first title screen.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRcheevos, EVENT } from '../../src/achievements/rcheevos.js';
import { checkSet } from '../../server/games.mjs';
import { assetPath } from '../external-assets.js';

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/commando.json'), 'utf8')), 'commando.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const id = Object.fromEntries(set.achievements.map((a) => [a.title, a.id]));
const SCORE = 0x4f8, MEN = 0x500, GRENADES = 0x4ff, DYING = 0x503, AREA = 0x4f3, ROWS = 0x403, LABEL = 0xe348;
const AREA_1 = 0, AREA_2 = 1, AREA_3 = 3, BETWEEN = 2, MISSION = 4;

const bcd = (n) => ((Math.floor(n / 10) % 10) << 4) | (n % 10);
/** The score as the game keeps it: BCD hundreds over two bytes. */
function setScore(points) {
  const h = Math.floor(points / 100);
  ram[SCORE] = bcd(h % 100);
  ram[SCORE + 1] = bcd(Math.floor(h / 100));
}
const statusLine = (on) => { ram[LABEL] = on ? 0x6d : 0x20; ram[LABEL + 1] = on ? 0x5d : 0x20; };

const unlocked = new Set();
const lb = [];
function activateAll() {
  rc.clear(); unlocked.clear(); lb.length = 0;
  const codes = set.achievements.map((a) => rc.activateAchievement(a.id, a.memaddr));
  const boards = set.leaderboards.map((l) => rc.activateLeaderboard(l.id, l.definition));
  return { codes, boards };
}
function frame() {
  for (const e of rc.doFrame(ram)) {
    if (e.type === EVENT.ACHIEVEMENT_TRIGGERED) unlocked.add(e.id);
    else if (e.type >= EVENT.LBOARD_STARTED && e.type <= EVENT.LBOARD_TRIGGERED) lb.push({ ...e });
  }
}
const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
const has = (title) => unlocked.has(id[title]);
const lbOf = (type) => lb.filter((e) => e.type === type);

/** The title screen after power-on: uninitialised game bytes, no status line. */
function powerOn() {
  ram.fill(0);
  ram[MEN] = 0x63; ram[GRENADES] = 0x63; ram[SCORE] = 0xa0; ram[SCORE + 1] = 0xa0;
  ram[AREA] = BETWEEN; ram[ROWS] = 0x53; statusLine(false);
}
/** Fire on the title: the game sets men, grenades and score, then draws the play screen. */
function startGame() {
  ram[AREA] = AREA_1; ram[ROWS] = 0xaf; ram[DYING] = 0;
  setScore(0); ram[MEN] = 5; ram[GRENADES] = 5; frames(3);
  statusLine(true); frames(2);
}
/** An area's end: the between-areas screen, then the next area's play screen. */
function breakArea(next) {
  ram[ROWS] = 0; frames(2);
  ram[AREA] = BETWEEN; statusLine(false); frames(30);
  ram[AREA] = next; ram[ROWS] = 0xa6; frames(3);
  statusLine(true); frames(2);
}
/** A man lost: the dying state, then the respawn with grenades topped up to 5. */
function loseMan() {
  ram[DYING] = 1; frames(10);
  ram[MEN] = bcd(Number(ram[MEN].toString(16)) - 1); ram[DYING] = 0;
  if (Number(ram[GRENADES].toString(16)) < 5) ram[GRENADES] = 5;
  frames(2);
}

// 1. The set, its conditions and its file.
{
  const { codes, boards } = activateAll();
  codes.forEach((c, i) => expect(c === 0, `"${set.achievements[i].title}" parses (code ${c})`));
  expect(boards.every((c) => c === 0), 'the high-score leaderboard parses');
  expect(set.achievements.every((a) => [5, 10, 25].includes(a.points)), 'points are 5, 10 or 25');
  ok(`all ${codes.length} achievements and ${boards.length} leaderboard parse`);
}
{
  const file = assetPath('commando-crt');
  if (!file) console.log(`ok  - test ${++testNo}: the OneLoad64 cartridge hashes to the listed hash # SKIP asset commando-crt not found (test/external-assets.json)`);
  else {
    const hash = rc.hash(fs.readFileSync(file));
    expect(set.hashes.some((h) => h.hash === hash), `the cartridge's hash ${hash} is listed`);
    ok('the OneLoad64 cartridge hashes to the listed hash');
  }
}

// 2. Before the first game: junk bytes, the status line drawn once, the title's area cycle.
{
  activateAll(); powerOn(); frames(10);
  ram[AREA] = AREA_2; ram[ROWS] = 0; statusLine(true); frames(2);   // the draw before the title
  statusLine(false);
  for (const a of [BETWEEN, AREA_1, AREA_2, AREA_3, MISSION, 5, 8]) { ram[AREA] = a; frames(20); }
  expect(unlocked.size === 0, `nothing unlocks before a game (got ${[...unlocked]})`);
  expect(lb.length === 0, 'the high-score attempt does not start');
  ok('nothing unlocks or starts before the first game, whatever the junk bytes hold');
}

// 3. A game: the start, the gate, three areas, a box of grenades and the score tiers.
{
  activateAll(); powerOn(); frames(10);
  startGame();
  expect(lbOf(EVENT.LBOARD_STARTED).length === 1, 'the play screen with five men and no score starts the high-score attempt');
  expect(unlocked.size === 0, `nothing unlocks at the start (got ${[...unlocked]})`);
  setScore(9900); frames(2);
  expect(!has('Private'), '9,900 is not yet 10,000');
  setScore(10000); ram[MEN] = 6; frames(2);
  expect(has('Private'), 'Private at 10,000 points');
  ram[ROWS] = 1; frames(2);
  expect(!has('Knock Knock'), 'one row short of the gate');
  ram[ROWS] = 0; frames(2);
  expect(has('Knock Knock'), 'At the Gate when the 1st area\'s map has scrolled to its end');
  ram[GRENADES] = 8; frames(2);
  expect(has('Supply Drop'), 'Supply Drop when a box takes grenades from 5 to 8');
  breakArea(AREA_2);
  for (const t of ['Breakthrough', 'Not a Scratch', 'Guns Only']) expect(has(t), `${t} in the 2nd area, no man lost and no grenade thrown`);
  expect(!has('Pressing On'), 'not Broke the 2nd Area yet');
  setScore(24900); frames(2);
  expect(!has('Sergeant'), '24,900 is not yet 25,000');
  setScore(25000); frames(2);
  expect(has('Sergeant'), 'Sergeant at 25,000 points');
  breakArea(AREA_3);
  expect(has('Pressing On'), 'Broke the 2nd Area in the 3rd area');
  expect(!has('Mission Complete'), 'not Mission Complete yet');
  breakArea(MISSION);
  expect(has('Mission Complete') && has('Flawless Mission'), 'Mission Complete and Flawless Mission in the next mission, no man lost');
  expect(!has('Back for More'), 'the next mission\'s 1st area is not broken yet');
  setScore(50000); frames(2);
  expect(has('Lieutenant') && !has('Colonel'), 'Lieutenant at 50,000 points, not Colonel');
  breakArea(MISSION + AREA_2);
  expect(has('Back for More'), 'Back for More when the second mission\'s 1st area is broken');
  breakArea(MISSION + AREA_3);
  expect(!has('Second Tour'), 'the second mission is not complete in its 3rd area');
  breakArea(2 * MISSION);
  expect(has('Second Tour'), 'Second Tour when the second mission is complete');
  setScore(99900); frames(2);
  expect(!has('Colonel'), '99,900 is not yet 100,000');
  setScore(100000); frames(2);
  expect(has('Colonel'), 'Colonel at 100,000 points');
  expect(unlocked.size === set.achievements.length, `every achievement unlocked once (got ${unlocked.size})`);
  // Game over: the last man lost submits the score.
  setScore(123400); ram[MEN] = 1; frames(2);
  ram[MEN] = 0; frames(1);
  const sub = lbOf(EVENT.LBOARD_TRIGGERED);
  expect(sub.length === 1 && sub[0].value === 123400, `losing the last man submits the score (got ${sub.map((e) => e.value)})`);
  ok('a game: gate, areas, missions, Supply Drop, score tiers and the high score');
}

// 4. A man lost in the 1st area: the area still counts, the no-loss challenges do not.
{
  activateAll(); powerOn(); frames(10);
  startGame();
  loseMan();
  breakArea(AREA_2);
  expect(has('Breakthrough'), 'Broke the 1st Area with a man lost');
  expect(!has('Not a Scratch'), 'no Not a Scratch after a man was lost');
  expect(has('Guns Only'), 'Guns Only still counts: no grenade was thrown');
  breakArea(AREA_3); breakArea(MISSION);
  expect(has('Mission Complete') && !has('Flawless Mission'), 'Mission Complete, but no Flawless Mission');
  ok('losing a man fails Not a Scratch and Flawless Mission only');
}

// 5. A grenade thrown in the 1st area fails Guns Only; the next game can earn it.
{
  activateAll(); powerOn(); frames(10);
  startGame();
  ram[GRENADES] = 4; frames(2);
  breakArea(AREA_2);
  expect(has('Breakthrough') && has('Not a Scratch'), 'the area and Not a Scratch still count');
  expect(!has('Guns Only'), 'no Guns Only after a grenade was thrown');
  // Game over, the title, a new game.
  ram[MEN] = 1; frames(2); ram[MEN] = 0; frames(2);
  statusLine(false); ram[AREA] = BETWEEN; frames(30);
  startGame();
  breakArea(AREA_2);
  expect(has('Guns Only'), 'Guns Only in the next game, with no grenade thrown');
  ok('throwing a grenade fails Guns Only for that game only');
}

// 6. Grenades topped up to 5 on respawn are not a box.
{
  activateAll(); powerOn(); frames(10);
  startGame();
  ram[GRENADES] = 3; frames(2);
  loseMan();
  expect(ram[GRENADES] === 5 && !has('Supply Drop'), 'the respawn top-up from 3 to 5 is not Supply Drop');
  ram[GRENADES] = 0x08; frames(2);
  expect(has('Supply Drop'), 'a box from 5 to 8 is');
  ok('Supply Drop counts boxes, not the respawn top-up');
}

// 7. After a game over the title cycles through the areas: nothing more unlocks or starts.
{
  activateAll(); powerOn(); frames(10);
  startGame();
  ram[MEN] = 1; frames(2); ram[MEN] = 0; frames(2);
  unlocked.clear();
  ram[AREA] = AREA_2; statusLine(true); frames(2);                // drawn once before the title
  statusLine(false);
  for (const a of [BETWEEN, AREA_1, AREA_2, AREA_3, 0x53]) { ram[AREA] = a; ram[ROWS] = 0; frames(20); }
  setScore(150000); frames(10);
  expect(unlocked.size === 0, `nothing unlocks on the title after a game (got ${[...unlocked]})`);
  expect(lbOf(EVENT.LBOARD_STARTED).length === 1, 'the title does not start another high-score attempt');
  ok('the title after a game over unlocks and starts nothing');
}

// 8. A play screen without the start's five men and zero score is not a new game.
{
  activateAll(); powerOn(); frames(10);
  ram[AREA] = AREA_1; setScore(1200); ram[MEN] = 5; frames(2);
  statusLine(true); frames(2);
  ram[AREA] = AREA_2; frames(2);
  expect(unlocked.size === 0, `no unlock without a game start (got ${[...unlocked]})`);
  expect(lb.length === 0, 'no high-score attempt without a game start');
  ok('a game starts only with five men and a zero score');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - commando set: ${testNo} checks`);
