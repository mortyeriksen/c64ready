// Spec tests for the Bubble Bobble achievement set (server/sets/bubble-bobble.json, Firebird's 1987
// game on the OneLoad64 v5 cartridge). In the running game, round 1 is the level byte at $10 holding 0
// (the round on screen is one higher). Clearing a round increments $10. Round 100 is $10 = 99, and
// finishing it makes $10 = 100, the game's ending. $10 = $FF is the title and the press-1-or-2 screen.
// Player 1's lives are $045A: 3 at the start of a game, counting down, and $FF when the game is over.
// Player 1's score is three BCD bytes at $0400-$0402, the highest byte first. $54 holds the item Bub
// is collecting, and $3F means the last EXTEND letter has just landed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRcheevos, EVENT } from '../../src/achievements/rcheevos.js';
import { checkSet } from '../../server/games.mjs';
import { assetPath, missingNote } from '../external-assets.js';

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/bubble-bobble.json'), 'utf8')), 'bubble-bobble.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const id = Object.fromEntries(set.achievements.map((a) => [a.title, a.id]));
const HASH = '0f5841ab63b80e7e8bb20e2c25f6d5cf';
const LEVEL = 0x10, LIVES = 0x45a, SCORE = 0x400, ITEM = 0x54;

const unlocked = new Set();
const boards = [];
function activate() {
  rc.clear(); unlocked.clear(); boards.length = 0; ram.fill(0);
  const codes = set.achievements.map((a) => rc.activateAchievement(a.id, a.memaddr));
  for (const l of set.leaderboards ?? []) codes.push(rc.activateLeaderboard(l.id, l.definition));
  return codes;
}
function frame() {
  for (const e of rc.doFrame(ram)) {
    if (e.type === EVENT.ACHIEVEMENT_TRIGGERED) unlocked.add(e.id);
    else if (e.type === EVENT.LBOARD_STARTED || e.type === EVENT.LBOARD_TRIGGERED || e.type === EVENT.LBOARD_CANCELED) boards.push(e);
  }
}
const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
const has = (title) => unlocked.has(id[title]);
const fresh = () => { activate(); frames(2); };
/** A new game, sitting on round 1 with three lives and no score. One frame so the start latches. */
function begin() { fresh(); ram[LEVEL] = 0; ram[LIVES] = 3; frames(2); }
/** The game's own clear: $10 advances past the round it held. */
function clear(internal, to = internal + 1) { ram[LEVEL] = internal; frames(2); ram[LEVEL] = to; frames(2); }
function setScore(n) {
  let x = n;
  for (let i = 2; i >= 0; i--) { const lo = x % 10, hi = Math.floor(x / 10) % 10; ram[SCORE + i] = (hi << 4) | lo; x = Math.floor(x / 100); }
}

// 1. Every condition parses, and the set names the cartridge and its one high score.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  expect(set.hashes.some((h) => h.hash === HASH), 'the set names the OneLoad64 cartridge');
  expect(set.leaderboards?.length === 1 && set.leaderboards[0].format === 'SCORE', 'one high-score board');
  ok(`all ${set.achievements.length} achievements and the high score parse`);
}

// 2. The listed hash is the cartridge file's rcheevos hash.
{
  let file = null;
  try { file = assetPath('bubble-bobble-crt'); } catch { /* not registered yet */ }
  if (!file) {
    let note = 'bubble-bobble-crt is not registered in test/external-assets.json';
    try { note = missingNote('bubble-bobble-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the cartridge hashes to the listed hash # SKIP ${note}`);
  } else { expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`); ok('the cartridge hashes to the listed hash'); }
}

// 3. Power-on junk, the title and the player select: nothing, and no score is posted.
{
  fresh();
  ram[LIVES] = 0x07; ram[SCORE] = 0x18; ram[SCORE + 1] = 0x90; ram[SCORE + 2] = 0x03; frames(5);
  ram[LEVEL] = 0xff; ram[LIVES] = 0; ram[SCORE] = ram[SCORE + 1] = ram[SCORE + 2] = 0; frames(10);
  expect(unlocked.size === 0, `the title unlocks nothing (got ${[...unlocked]})`);
  expect(!boards.some((e) => e.type === EVENT.LBOARD_TRIGGERED), 'the title posts no score');
  ok('power-on and the title');
}

// 4. Round clears. The round on screen is one more than $10, and a clear moves $10 on past it.
{
  begin();
  const rounds = [[1, 'Ready'], [5, 'Still Floating'], [10, 'Double Figures'], [20, 'Round Twenty'], [30, 'Thirty Rounds'], [50, 'Halfway There']];
  for (const [round, title] of rounds) {
    expect(!has(title), `${title} not before round ${round} is cleared`);
    clear(round - 1);
    expect(has(title), `${title} when round ${round} is cleared`);
  }
  expect(!has('The Last Round'), 'round 100 not among the earlier clears');
  clear(99, 100);
  expect(has('The Last Round'), 'The Last Round when round 100 is finished and $10 becomes 100');
  ok('clearing rounds');
}

// 5. A door that skips ahead still clears the round you were on. Leaving for the
// title stores $FF, which is not a clear of the round you were on.
{
  begin();
  clear(19, 21);
  expect(has('Round Twenty'), 'skipping from round 20 to round 22 still clears round 20');
  expect(!has('Thirty Rounds'), 'that skip is not round 30');
  begin();
  ram[LEVEL] = 0xff; frames(2);
  expect(!has('Ready') && !has('No Mistakes'), 'round 1 abandoned for the title is not a clear');
  begin();
  ram[LEVEL] = 4; frames(2); ram[LEVEL] = 0xff; frames(2);
  expect(!has('Still Floating'), 'round 5 abandoned for the title is not a clear');
  begin();
  ram[LEVEL] = 99; frames(2); ram[LEVEL] = 0xff; frames(2);
  expect(!has('The Last Round'), 'round 100 abandoned for the title is not a clear');
  ok('skips and an abandoned round');
}

// 6. An extra life is the lives counter going up during a round. The three you start with, and the
// game over value $FF, are not one.
{
  begin();
  expect(!has('One More Life'), 'the starting three lives are not an extra life');
  ram[LIVES] = 2; frames(2); ram[LIVES] = 3; frames(2);
  expect(has('One More Life'), 'an extra life when the counter goes back up');
  begin();
  ram[LIVES] = 0; frames(2); ram[LIVES] = 0xff; frames(2);
  expect(!has('One More Life'), 'game over is not an extra life');
  ok('an extra life');
}

// 7. EXTEND is $54 becoming $3F during a round, and nowhere else.
{
  fresh();
  ram[ITEM] = 0x3f; frames(3);
  expect(!has('Spelled Out'), 'the item value before a game has started is not EXTEND');
  begin();
  ram[ITEM] = 0x3f; frames(2);
  expect(has('Spelled Out'), 'EXTEND when the last letter lands');
  ok('EXTEND');
}

// 8. No Mistakes: round 1 cleared with the three starting lives still there. A lost life cancels it.
{
  begin(); clear(0);
  expect(has('No Mistakes'), 'round 1 with no life lost');
  begin(); ram[LIVES] = 2; frames(2); clear(0);
  expect(!has('No Mistakes'), 'not after a life is lost, even when round 1 is then cleared');
  ok('round 1 without losing a life');
}

// 9. Score thresholds, from the three BCD bytes, and only after a game has started.
{
  fresh();
  setScore(400000); ram[LEVEL] = 0; frames(5);
  expect(unlocked.size === 0, `a score before the game starts counts for nothing (got ${[...unlocked]})`);
  const goals = [[10000, 'Five Figures'], [30000, 'Bonus Score'], [100000, 'Six Figures'], [400000, 'Treasure Hoard']];
  begin();
  for (const [n, title] of goals) {
    expect(!has(title), `${title} not below ${n}`);
    setScore(n); frames(2);
    expect(has(title), `${title} at ${n}`);
  }
  ok('the score thresholds');
}

// 10. The high score starts with the game and is posted when the lives counter becomes $FF.
{
  begin();
  expect(boards.some((e) => e.type === EVENT.LBOARD_STARTED), 'the board starts when the game does');
  setScore(12340); frames(2);
  ram[LIVES] = 0xff; frames(2);
  const posted = boards.filter((e) => e.type === EVENT.LBOARD_TRIGGERED);
  expect(posted.length === 1 && posted[0].value === 12340, `the posted score is 12340 (got ${posted.map((e) => e.value)})`);
  ok('the high score');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - bubble-bobble set: ${testNo} checks`);
