// Spec tests for the ported Mario's Cement Factory set
// (server/sets/marios-cement-factory.json, from c64-cheevos, MIT) under
// rcheevos, on synthesized RAM laid out as the set reads it: game mode $20C9
// (0 Game A, 1 Game B), the BCD score with hundreds in $8122 and tens and units
// in $8121, misses $824C (three end the game), the 300-point flag $8126 (set
// once per game when the score reaches 300, which also clears the misses, as
// on the Game & Watch), the lift step counter $982C (zeroed when a game
// starts, then counting from 1), and Mario's column $8DA0 and row $8DA1.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRcheevos, EVENT } from '../../src/achievements/rcheevos.js';
import { checkSet } from '../../server/games.mjs';

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/marios-cement-factory.json'), 'utf8')), 'marios-cement-factory.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const byTitle = Object.fromEntries(set.achievements.map((a) => [a.title, a.id]));
const MODE = 0x20c9, SCORE_LO = 0x8121, SCORE_HI = 0x8122, MISSES = 0x824c, BONUS = 0x8126, STEP = 0x982c, COL = 0x8da0, ROW = 0x8da1;
const bcd = (n) => ((Math.floor(n / 10) % 10) << 4) | (n % 10);
function setScore(n) { ram[SCORE_HI] = bcd(Math.floor(n / 100)); ram[SCORE_LO] = bcd(n % 100); }

function activateAll() {
  rc.clear();
  const codes = set.achievements.map((a) => rc.activateAchievement(a.id, a.memaddr));
  const lb = set.leaderboards.map((l) => rc.activateLeaderboard(l.id, l.definition));
  return { codes, lb };
}
const unlocked = new Set();
const lbEvents = [];
function frame() {
  for (const e of rc.doFrame(ram)) {
    if (e.type === EVENT.ACHIEVEMENT_TRIGGERED) unlocked.add(e.id);
    else if (e.type >= EVENT.LBOARD_STARTED && e.type <= EVENT.LBOARD_TRIGGERED) lbEvents.push({ ...e });
  }
}
const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
/** Power-on to the title screen, then the game start: misses and step zeroed, the step counts on. */
function freshGame(mode = 0) {
  activateAll(); unlocked.clear(); lbEvents.length = 0; ram.fill(0);
  ram[MODE] = mode; ram[COL] = 0; ram[ROW] = 2;
  frames(5);
  ram[STEP] = 0; frames(1);
  ram[STEP] = 1; ram[COL] = 1; frames(2);
}

// 1. Every condition and both leaderboards parse.
{
  const { codes, lb } = activateAll();
  codes.forEach((c, i) => expect(c === 0, `"${set.achievements[i].title}" parses (code ${c})`));
  expect(lb.length === 2 && lb.every((c) => c === 0), 'the Game A and Game B leaderboards parse');
  expect(set.hashes.some((h) => h.hash === '0758056df7e4da9c1747cdafc78ed79a'), 'the set names c64cade\'s PRG');
  ok(`all ${codes.length} achievements and ${lb.length} leaderboards parse`);
}

// 2. Before any game starts (a crunched PRG unpacking, the title screen) the score
//    bytes can hold anything: nothing unlocks and no attempt starts.
{
  activateAll(); unlocked.clear(); lbEvents.length = 0; ram.fill(0);
  frames(3);
  ram[SCORE_HI] = 0xff; ram[SCORE_LO] = 0x00; ram[MODE] = 0x45; frames(30);
  ram[SCORE_HI] = 0; ram[MODE] = 0; ram[MISSES] = 1; frames(5); ram[MISSES] = 2; frames(5);
  ram[BONUS] = 1; frames(5);
  ram[MISSES] = 0; ram[BONUS] = 0; frames(60);
  expect(unlocked.size === 0, `nothing unlocks before a game starts (got ${[...unlocked]})`);
  expect(!lbEvents.some((e) => e.type === EVENT.LBOARD_STARTED), 'no leaderboard attempt starts on the title screen');
  ok('nothing unlocks or starts before a game, whatever the score bytes hold');
}

// 3. A Game A: the attempt starts with the game, score tiers unlock at their
//    thresholds, each miss has its achievement, game over submits the score.
{
  freshGame(0);
  const started = lbEvents.filter((e) => e.type === EVENT.LBOARD_STARTED).map((e) => e.id);
  expect(started.length === 1 && started[0] === 1, `a Game A start starts the Game A board only (started ${started})`);
  setScore(99); frames(2);
  expect(!unlocked.has(byTitle['Welcome to Your New Job']), '99 points is not yet 100');
  setScore(100); frames(2);
  expect(unlocked.has(byTitle['Welcome to Your New Job']), '100 points: Welcome to your new job');
  expect(!unlocked.has(byTitle['First Day Done']), 'not 200 at 100');
  ram[MISSES] = 1; frames(2);
  expect(unlocked.has(byTitle['Verbal Warning']), 'the first miss: Verbal Warning');
  expect(!unlocked.has(byTitle['Final Warning']), 'one miss is not the second');
  ram[MISSES] = 2; frames(2);
  expect(unlocked.has(byTitle['Final Warning']), 'the second miss: Final Warning');
  expect(!unlocked.has(byTitle['Gross Misconduct']), 'two misses are not fired');
  const tiers = [[200, 'First Day Done'], [300, 'Bonus Milestone'], [400, 'Promotion'], [500, 'Sucked into Overtime'],
    [600, 'Frantic Freddie'], [700, 'Impressing the Boss'], [800, 'There Are Easier Jobs'], [900, 'Smells Like Cement'], [1000, 'Cement King']];
  for (const [n, t] of tiers) {
    setScore(n - 1); frames(1);
    expect(!unlocked.has(byTitle[t]), `${t} not at ${n - 1}`);
    setScore(n); frames(1);
    expect(unlocked.has(byTitle[t]), `${t} at ${n} points`);
  }
  setScore(1234); ram[MISSES] = 3; frames(1);
  expect(unlocked.has(byTitle['Gross Misconduct']), 'the third miss: Gross Misconduct');
  const sub = lbEvents.find((e) => e.type === EVENT.LBOARD_TRIGGERED);
  expect(sub && sub.id === 1 && sub.value === 1234, `the third miss submits 1234 to Game A (got ${JSON.stringify(sub)})`);
  ok('a Game A: score tiers, misses and the submitted score');
}

// 4. Game B has its own board.
{
  freshGame(1);
  const started = lbEvents.filter((e) => e.type === EVENT.LBOARD_STARTED).map((e) => e.id);
  expect(started.length === 1 && started[0] === 2, `a Game B start starts the Game B board only (started ${started})`);
  setScore(456); frames(2); ram[MISSES] = 1; frames(2); ram[MISSES] = 2; frames(2); ram[MISSES] = 3; frames(1);
  const sub = lbEvents.find((e) => e.type === EVENT.LBOARD_TRIGGERED);
  expect(sub && sub.id === 2 && sub.value === 456, `Game B submits 456 to its board (got ${JSON.stringify(sub)})`);
  ok('a Game B goes to the Game B board');
}

// 5. Double Score Factory: the 300-point bonus with no miss before it. The
//    bonus clears the misses in the same frame, so a game with misses must not count.
{
  freshGame(0);
  setScore(299); frames(2);
  setScore(300); ram[BONUS] = 1; frames(1);
  expect(unlocked.has(byTitle['Double Shift']), '300 points without a miss: Double Score Factory');

  freshGame(0);
  setScore(150); ram[MISSES] = 1; frames(2);
  setScore(300); ram[BONUS] = 1; ram[MISSES] = 0; frames(2);
  expect(!unlocked.has(byTitle['Double Shift']), 'not when a miss came before the bonus cleared it');
  ok('Double Score Factory needs 300 points with no miss');
}

// 6. Escape Artist: the escape floor (row 4, column 1) and then a safe spot,
//    without losing a life in between.
{
  freshGame(0);
  ram[ROW] = 2; ram[COL] = 1; frames(2);
  expect(!unlocked.has(byTitle['Escape Artist']), 'a safe spot without the escape floor first does not count');
  ram[ROW] = 4; ram[COL] = 1; frames(2);
  ram[ROW] = 5; ram[COL] = 2; frames(2);
  ram[ROW] = 3; ram[COL] = 4; frames(1);
  expect(unlocked.has(byTitle['Escape Artist']), 'escape floor, then row 3 column 4: Escape Artist');

  freshGame(0);
  ram[ROW] = 4; ram[COL] = 1; frames(2);
  ram[ROW] = 5; ram[COL] = 2; ram[MISSES] = 1; frames(2);
  ram[ROW] = 2; ram[COL] = 4; frames(2);
  expect(!unlocked.has(byTitle['Escape Artist']), 'a miss after the escape floor cancels it');
  ok('Escape Artist needs the escape floor, then safety, on one life');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - marios-cement-factory set: ${testNo} checks`);
