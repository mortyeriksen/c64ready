// Spec tests for the Beach-Head achievement set (server/sets/beach-head.json,
// Access 1983, the OneLoad64 v5 cartridge).
//
// $9608 is 2 on the skill menu and 0 once a round is running. The menu keeps a
// canned score of 12000, so every check requires the round byte. $9607 and
// $9606 are the BCD score. Points are the high byte times 10000 plus the low
// byte times 100. $972A is the flotilla, 10 at the start of a round. Leaving
// stores 2 in $9608. Losing the last ship stores 0 in $972A.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/beach-head.json'), 'utf8')), 'beach-head.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const HASH = 'af25726356f2063052dec7007039cad7';
const PHASE = 0x9608, LO = 0x9606, HI = 0x9607, SHIPS = 0x972a;
const BOARD = 1;

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
const fresh = () => { activate(); frames(2); };
const names = () => set.achievements.filter((a) => unlocked.has(a.id)).map((a) => a.title).sort();
function expectNames(label, want) {
  const got = names().join(', ');
  const exp = [...want].sort().join(', ');
  expect(got === exp, `${label}: got ${got || 'none'}, want ${exp || 'none'}`);
}
const of = (type) => boards.filter((e) => e.id === BOARD && e.type === type);
const submits = () => of(EVENT.LBOARD_TRIGGERED);
const cancels = () => of(EVENT.LBOARD_CANCELED);

/** A round that has just started: nothing scored, ten ships. */
function round() {
  ram[PHASE] = 0;
  ram[HI] = 0;
  ram[LO] = 0;
  ram[SHIPS] = 10;
}
/** The skill menu: the canned 12000 is sitting in the score bytes. */
function menu() {
  ram[PHASE] = 2;
  ram[HI] = 0x01;
  ram[LO] = 0x20;
  ram[SHIPS] = 10;
}
function score(n) {
  const body = Math.floor(n / 100);
  const hi = Math.floor(body / 100);
  const lo = body % 100;
  ram[HI] = ((Math.floor(hi / 10) % 10) << 4) | (hi % 10);
  ram[LO] = ((Math.floor(lo / 10) % 10) << 4) | (lo % 10);
}

// 1. Every condition parses, and the set names this cartridge.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  expect(set.hashes.length === 1 && set.hashes[0].hash === HASH, 'the set names the cartridge hash');
  expect(set.title === 'Beach-Head', 'the set uses the game title');
  expect(set.url === 'https://www.lemon64.com/game/beach-head', 'the set links the game on Lemon64');
  expect(set.achievements.length === 10, 'ten achievements');
  expect(set.achievements.reduce((n, a) => n + a.points, 0) === 165, 'the achievements add up to 165 points');
  expect(set.leaderboards?.length === 1, 'one board');
  const l = set.leaderboards[0];
  expect(l.format === 'SCORE' && l.lowerIsBetter === false, 'the board is a score, higher is better');
  expect(/STA:.*::CAN:.*::SUB:.*::VAL:/.test(l.definition), 'the board has start, cancel, submit and value');
  expect(l.description === 'Your score when the fleet sinks or you leave.', 'the board says when it posts');
  ok(`all ${set.achievements.length} achievements and the score parse`);
}

// 2. The listed hash is that cartridge file's rcheevos hash.
{
  const key = 'beach-head-crt';
  let file = null;
  try { file = assetPath(key); } catch { /* not registered yet */ }
  if (!file) {
    let note = `${key} is not registered in test/external-assets.json`;
    try { note = missingNote(key); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: ${key} hashes to the listed hash # SKIP ${note}`);
  } else {
    expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`);
    ok(`${key} hashes to the listed hash`);
  }
}

// 3. The skill menu unlocks nothing and posts nothing.
{
  fresh();
  menu();
  frames(4);
  expectNames('menu', []);
  expect(of(EVENT.LBOARD_STARTED).length === 0, 'the menu does not start the board');
  expect(submits().length === 0, 'the canned score posts nothing');
  expect(cancels().length === 0, 'the menu cancels nothing');
  ok('the skill menu unlocks nothing and posts nothing');
}

// 4. A condition that is already true on the first frame does not fire.
{
  activate();
  round();
  score(5000);
  frame();
  expectNames('true before it has been false', []);
  expect(of(EVENT.LBOARD_STARTED).length === 0, 'the board does not start on a first frame');
  frame();
  expectNames('still true on the next frame', []);
  ok('a condition already true on the first frame does not fire');
}

// 5. Starting a round scores nothing. The milestones follow the BCD score.
{
  fresh();
  round();
  frames(2);
  expectNames('just started', []);
  expect(of(EVENT.LBOARD_STARTED).length === 1, 'a new round starts the board');
  score(100);
  frames(2);
  expectNames('first points', ['Hit the Beach']);
  score(400);
  frames(2);
  expectNames('400', ['Hit the Beach', 'Four Hundred']);
  score(1000);
  frames(2);
  expectNames('1000', ['Hit the Beach', 'Four Hundred']);
  score(2000);
  frames(2);
  expectNames('2000', ['Hit the Beach', 'Four Hundred', 'Gaining Ground', 'Nobody Left Behind']);
  score(3000);
  frames(2);
  expectNames('3000', ['Hit the Beach', 'Four Hundred', 'Gaining Ground', 'Pushing Inland', 'Nobody Left Behind']);
  score(5000);
  frames(2);
  expectNames('5000', ['Hit the Beach', 'Four Hundred', 'Gaining Ground', 'Pushing Inland', 'Bridgehead', 'Nobody Left Behind']);
  score(10000);
  frames(2);
  expectNames('10000', ['Hit the Beach', 'Four Hundred', 'Gaining Ground', 'Pushing Inland', 'Bridgehead', 'Ten Grand', 'Nobody Left Behind']);
  score(20000);
  frames(2);
  expectNames('20000', ['Hit the Beach', 'Four Hundred', 'Gaining Ground', 'Pushing Inland', 'Bridgehead', 'Ten Grand', 'Twenty Grand', 'Nobody Left Behind']);
  score(50000);
  frames(2);
  expectNames('50000', ['Hit the Beach', 'Four Hundred', 'Gaining Ground', 'Pushing Inland', 'Bridgehead', 'Ten Grand', 'Twenty Grand', 'Fifty Grand', 'Nobody Left Behind']);
  score(100000);
  frames(2);
  expectNames('100000', ['Hit the Beach', 'Four Hundred', 'Gaining Ground', 'Pushing Inland', 'Bridgehead', 'Ten Grand', 'Twenty Grand', 'Fifty Grand', 'The Big Hundred', 'Nobody Left Behind']);
  expect(submits().length === 0, 'scoring does not post by itself');
  ok('the score milestones follow the round');
}

// 6. Nine ships at 2000 is not the full flotilla. The menu score still is not.
{
  fresh();
  round();
  frames(2);
  ram[SHIPS] = 9;
  score(2000);
  frames(2);
  expectNames('a ship down', ['Hit the Beach', 'Four Hundred', 'Gaining Ground']);
  menu();
  score(50000);
  frames(2);
  expectNames('back on the menu', ['Hit the Beach', 'Four Hundred', 'Gaining Ground']);
  ok('a short flotilla and the menu do not add milestones');
}

// 7. Leaving with a score posts it once. Leaving with nothing cancels.
{
  fresh();
  round();
  frames(2);
  score(3000);
  frames(2);
  ram[PHASE] = 2;
  frames(2);
  expect(submits().length === 1, 'leaving posts one score');
  expect(submits()[0]?.value === 3000, `the posted score is 3000, got ${submits()[0]?.value}`);
  expect(cancels().length === 0, 'a scored exit does not cancel');
  fresh();
  round();
  frames(2);
  ram[PHASE] = 2;
  frames(2);
  expect(submits().length === 0, 'leaving on nothing posts nothing');
  expect(cancels().length === 1, 'leaving on nothing cancels');
  ok('leaving posts the score, or cancels when it is still zero');
}

// 8. Losing the last ship posts the score. Losing it on zero cancels.
{
  fresh();
  round();
  frames(2);
  score(20000);
  frames(2);
  ram[SHIPS] = 0;
  frames(2);
  expect(submits().length === 1, 'the last ship posts one score');
  expect(submits()[0]?.value === 20000, `the posted score is 20000, got ${submits()[0]?.value}`);
  fresh();
  round();
  frames(2);
  ram[SHIPS] = 0;
  frames(2);
  expect(submits().length === 0, 'a scoreless loss posts nothing');
  expect(cancels().length === 1, 'a scoreless loss cancels');
  ok('the last ship posts the score, or cancels when it is still zero');
}

if (failing) {
  console.error(`\n${failing} test(s) failed`);
  process.exit(1);
}
console.log(`\nall ${testNo} tests passed`);
