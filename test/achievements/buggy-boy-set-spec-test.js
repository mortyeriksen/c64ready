// Spec tests for the Buggy Boy achievement set (server/sets/buggy-boy.json, Elite's 1987
// game on the OneLoad64 v5 cartridge). A race shows leg 1 as the screen code at $44DB ($31).
// Each checkpoint increments that digit. The last leg clamps it at $35, so the digit moves
// 1, 2, 3, 4, 5 and stays on 5 when the course is finished. $0350 counts the same
// checkpoints in steps of two: 0, 2, 4, 6, 8, then 10 on the frame the finish is awarded.
// The course is $033A: 0 Offroad, 1 North, 2 East, 3 West, 4 South. The score is the five
// screen codes at $44DE-$44E2 ($30 is the digit 0). A carry leaves $3A there for a frame.
// The timer is the binary seconds at $9C4E. It is 70 when a race starts and 0 when the
// race ends, on a finish or when the time runs out. The title leaves $46 there.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/buggy-boy.json'), 'utf8')), 'buggy-boy.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const id = Object.fromEntries(set.achievements.map((a) => [a.title, a.id]));
const HASH = 'c44a8c4d2bd634ece5fba68f56626150';
const COURSE = 0x033a, PROG = 0x0350, LEG = 0x44db, SCORE = 0x44de, TIME = 0x9c4e;
const COURSES = ['Off the Beaten Track', 'Due North', 'East Bound', 'Go West', 'Southern Comfort'];

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
const names = () => set.achievements.filter((a) => unlocked.has(a.id)).map((a) => a.title).sort();
function expectNames(label, want) {
  const got = names().join(', ');
  const exp = [...want].sort().join(', ');
  expect(got === exp, `${label}: got ${got || 'none'}, want ${exp || 'none'}`);
}
/** A race that has just started: leg 1, score 00000, and the timer still at its initial 70. */
function begin() {
  fresh();
  ram[LEG] = 49;
  for (let i = 0; i < 5; i++) ram[SCORE + i] = 48;
  ram[TIME] = 0x46;
  frames(2);
}
/** The five score digits, as the screen shows them. */
function setScore(n) {
  const s = String(n).padStart(5, '0');
  for (let i = 0; i < 5; i++) ram[SCORE + i] = 0x30 + Number(s[i]);
}
/** $0350 steps from 8 to 10, which is the frame a course is finished. */
function finish(course) {
  ram[COURSE] = course;
  ram[PROG] = 8;
  frames(2);
  ram[PROG] = 10;
  frames(2);
}

// 1. Every condition parses, and the set names the cartridge and its one high score.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  expect(set.hashes.some((h) => h.hash === HASH), 'the set names the OneLoad64 cartridge');
  expect(set.leaderboards?.length === 1 && set.leaderboards[0].format === 'SCORE', 'one high-score board');
  expect(set.achievements.reduce((n, a) => n + a.points, 0) === 135, 'the achievements add up to 135 points');
  ok(`all ${set.achievements.length} achievements and the high score parse`);
}

// 2. The listed hash is the cartridge file's rcheevos hash.
{
  let file = null;
  try { file = assetPath('buggy-boy-crt'); } catch { /* not registered yet */ }
  if (!file) {
    let note = 'buggy-boy-crt is not registered in test/external-assets.json';
    try { note = missingNote('buggy-boy-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the cartridge hashes to the listed hash # SKIP ${note}`);
  } else { expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`); ok('the cartridge hashes to the listed hash'); }
}

// 3. The title and the course select, even with a finish-shaped progress byte or a huge
// score written over them: nothing, and no score is posted.
{
  fresh();
  ram[COURSE] = 0;
  ram[LEG] = 0xaa;
  ram[TIME] = 0x46;
  [0xc5, 0xd1, 0xd2, 0xda, 0xe8].forEach((b, i) => { ram[SCORE + i] = b; });
  frames(5);
  for (let i = 0; i < 5; i++) ram[SCORE + i] = 0x39;
  finish(0);
  expect(names().length === 0, `the title unlocks nothing (got ${names().join(', ')})`);
  expect(!boards.some((e) => e.type === EVENT.LBOARD_STARTED || e.type === EVENT.LBOARD_TRIGGERED), 'the title posts no score');

  fresh();
  ram[COURSE] = 1;
  ram[LEG] = 0x7c;
  ram[TIME] = 0x46;
  [0x94, 0x69, 0x6c, 0x6c, 0x69].forEach((b, i) => { ram[SCORE + i] = b; });
  frames(5);
  finish(1);
  expect(names().length === 0, `the course select unlocks nothing (got ${names().join(', ')})`);
  expect(!boards.some((e) => e.type === EVENT.LBOARD_TRIGGERED), 'the course select posts no score');
  ok('the title and the course select');
}

// 4. Starting a race opens the high score and unlocks nothing.
{
  begin();
  expect(boards.some((e) => e.type === EVENT.LBOARD_STARTED), 'the board starts when the race does');
  expect(!boards.some((e) => e.type === EVENT.LBOARD_TRIGGERED), 'the start does not post a score');
  expect(names().length === 0, `the start unlocks nothing (got ${names().join(', ')})`);
  ok('a race starting');
}

// 5. The leg digit. Leg 2, leg 3 and leg 5 each unlock only their own achievement.
{
  begin();
  ram[LEG] = 50; frames(2);
  expectNames('leg 2', ['Under Way']);
  ram[LEG] = 51; frames(2);
  expectNames('leg 3', ['Under Way', 'Making Time']);
  ram[LEG] = 52; frames(2);
  expectNames('leg 4', ['Under Way', 'Making Time']);
  ram[LEG] = 53; frames(2);
  expectNames('leg 5', ['Under Way', 'Making Time', 'Final Leg']);
  ok('reaching later legs');
}

// 6. Finishing is $0350 going from 8 to 10 on that course. Reaching the last leg
// (6 to 8) is not a finish, and the same edge before a race has started is nothing.
// The course is read when the finish happens, so a later course in the same race
// session still counts after the score has moved off zero.
{
  begin();
  ram[PROG] = 6; frames(2);
  ram[PROG] = 8; frames(2);
  expect(names().length === 0, `reaching the last leg is not a finish (got ${names().join(', ')})`);
  ram[PROG] = 10; frames(2);
  expectNames('offroad', ['Off the Beaten Track']);

  for (const [course, title] of COURSES.map((t, i) => [i, t])) {
    begin();
    finish(course);
    expectNames(title, [title]);
  }

  begin();
  finish(0);
  setScore(250); frames(2);
  ram[COURSE] = 4;
  ram[PROG] = 8; frames(2);
  ram[PROG] = 10; frames(2);
  expectNames('a second course', ['Off the Beaten Track', 'Southern Comfort']);

  fresh();
  finish(0);
  expect(names().length === 0, `a finish before the race starts unlocks nothing (got ${names().join(', ')})`);
  expect(!boards.some((e) => e.type === EVENT.LBOARD_STARTED), 'that edge does not start the board');
  ok('finishing a course');
}

// 7. Score thresholds, from the five digits, and only after a race has started.
// A digit sitting on $3A is a carry, and its low nibble is 10, so it is not a score.
{
  fresh();
  setScore(50000); ram[LEG] = 49; frames(5);
  expect(names().length === 0, `a score before the race starts counts for nothing (got ${names().join(', ')})`);

  begin();
  ram[SCORE] = 0x30; ram[SCORE + 1] = 0x34; ram[SCORE + 2] = 0x39; ram[SCORE + 3] = 0x39; ram[SCORE + 4] = 0x3a;
  frames(3);
  expect(!has('Points Ahead'), 'a carry digit is not 5,000');

  begin();
  setScore(4999); frames(2);
  expect(!has('Points Ahead'), '4,999 is under 5,000');
  const goals = [[5000, 'Points Ahead'], [10000, 'Five Figures'], [20000, 'Table Leader'], [50000, 'Long Haul']];
  for (const [n, title] of goals) {
    setScore(n); frames(2);
    expect(has(title), `${title} at ${n}`);
  }
  expectNames('the score thresholds', goals.map(([, title]) => title));
  ok('the score thresholds');
}

// 8. The high score starts with the race and is posted when the timer reaches 0.
// A timer of 0 before that start posts nothing.
{
  fresh();
  ram[TIME] = 0; frames(4);
  expect(!boards.some((e) => e.type === EVENT.LBOARD_TRIGGERED), 'time at 0 before a race posts nothing');

  begin();
  setScore(12340); frames(2);
  ram[TIME] = 0; frames(2);
  const posted = boards.filter((e) => e.type === EVENT.LBOARD_TRIGGERED);
  expect(posted.length === 1 && posted[0].value === 12340, `the posted score is 12340 (got ${posted.map((e) => e.value)})`);
  ok('the high score');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - buggy-boy set: ${testNo} checks`);
