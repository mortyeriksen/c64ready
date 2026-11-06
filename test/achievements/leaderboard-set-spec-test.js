// Spec tests for the Leaderboard Golf achievement set (server/sets/leaderboard.json, Access 1986 on the
// OneLoad64 cartridge) under rcheevos, on synthesized RAM laid out as the game keeps it:
//   $C07A the hole (1-18), $C1A9 the course (0-3), $A544 the level (0 novice, 1 amateur, 2 professional).
//   $9FF0 the strokes on this hole. $9F68-$9F79 player 1's card: a hole's strokes, written when it is holed.
//   $B237 the par of every hole, 18 for each course in turn; every course is par 72.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/leaderboard.json'), 'utf8')), 'leaderboard.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const HASH = '111400355e2a6dcf341f26e0538ea52b';
// The par tables of the four courses as the game holds them.
const PARS = [
  [4, 5, 3, 4, 5, 3, 3, 4, 5, 4, 3, 4, 4, 4, 5, 3, 5, 4],
  [4, 3, 5, 4, 4, 3, 4, 5, 4, 4, 3, 4, 3, 4, 5, 4, 4, 5],
  [3, 4, 5, 4, 4, 3, 4, 4, 5, 4, 4, 3, 5, 4, 3, 4, 5, 4],
  [5, 3, 4, 4, 4, 5, 4, 4, 3, 4, 5, 3, 4, 4, 3, 4, 4, 5],
];

const unlocked = new Set();
const boards = [];
function activate() {
  rc.clear(); unlocked.clear(); boards.length = 0; ram.fill(0);
  const codes = set.achievements.map((a) => rc.activateAchievement(a.id, a.memaddr));
  for (const l of set.leaderboards) codes.push(rc.activateLeaderboard(l.id, l.definition));
  return codes;
}
function frame() {
  for (const e of rc.doFrame(ram)) {
    if (e.type === EVENT.ACHIEVEMENT_TRIGGERED) unlocked.add(e.id);
    else if (e.type === EVENT.LBOARD_STARTED || e.type === EVENT.LBOARD_TRIGGERED || e.type === EVENT.LBOARD_CANCELED) boards.push(e);
  }
}
const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
const names = () => set.achievements.filter((a) => unlocked.has(a.id)).map((a) => a.title).sort();
function expectNames(label, want) {
  const got = names().join(', '), exp = [...want].sort().join(', ');
  expect(got === exp, `${label}: got ${got || 'none'}, want ${exp || 'none'}`);
}

/** The first tee of a round on `course` (0-3) at `level`. */
function begin(course = 0, level = 0) {
  activate();
  PARS.forEach((p, c) => ram.set(p, 0xb237 + 18 * c));
  frames(2);
  ram[0xc1a9] = course; ram[0xa544] = level; ram[0xc07a] = 1; frames(2);
}
/** Plays the current hole in `strokes`, holes out, and walks to the next tee. */
function play(strokes) {
  const hole = ram[0xc07a];
  for (let s = 1; s <= strokes; s++) { ram[0x9ff0] = s; frames(2); }
  ram[0x9f67 + hole] = strokes; frames(2);
  if (hole < 18) { ram[0x9ff0] = 0; ram[0xc07a] = hole + 1; frames(2); }
}

// 1. Every condition parses, and the set names the cartridge.
{
  const codes = activate();
  codes.forEach((c, i) => expect(c === 0, `condition ${i} parses (code ${c})`));
  expect(set.hashes.some((h) => h.hash === HASH), 'the set names the cartridge');
  ok(`all ${set.achievements.length} achievements and ${set.leaderboards.length} boards parse`);
}

// 2. The listed hash is the cartridge's rcheevos hash.
{
  let file = null;
  try { file = assetPath('leaderboard-crt'); } catch { /* not registered */ }
  if (!file) {
    let note = 'leaderboard-crt is not registered in test/external-assets.json';
    try { note = missingNote('leaderboard-crt'); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: the cartridge hashes to the listed hash # SKIP ${note}`);
  } else {
    expect(rc.hash(fs.readFileSync(file)) === HASH, `${path.basename(file)} hashes to ${HASH}`);
    ok('the cartridge hashes to the listed hash');
  }
}

// 3. Holes against their par: par, birdie, eagle, a hole in one, on course 2 at the novice level.
{
  begin(1, 0);
  play(4);
  expectNames('par on a par 4', ['First Hole']);
  play(2);
  expectNames('birdie on a par 3', ['Birdie', 'First Hole']);
  play(3);
  expectNames('eagle on a par 5', ['Birdie', 'Eagle', 'First Hole']);
  play(1);
  expectNames('ace on a par 4', ['Birdie', 'Eagle', 'First Hole', 'Hole in One']);
  ok('holes against their par');
}

// 4. A full round at the professional level on course 1: 71 strokes is under par and goes on the board.
{
  begin(0, 2);
  expect(boards.filter((e) => e.type === EVENT.LBOARD_STARTED && e.id === 1).length === 1, 'the course 1 board starts');
  PARS[0].forEach((p, i) => play(i === 0 ? p - 1 : p));
  expectNames('a professional round of 71', ['Birdie', 'Eighteen Holes', 'First Hole', 'Professional', 'Professional Birdie', 'Tour Card', 'Under Par']);
  const sub = boards.filter((e) => e.type === EVENT.LBOARD_TRIGGERED);
  expect(sub.length === 1 && sub[0].id === 1 && sub[0].value === 71, `71 is posted to course 1 (got ${sub.map((e) => `${e.id}:${e.value}`).join(',') || 'nothing'})`);
  ok('a professional round');
}

// 5. A novice round of 72 is level par: a round, but not under par, and no board.
{
  begin(3, 0);
  PARS[3].forEach((p) => play(p));
  expectNames('a novice round of 72', ['Eighteen Holes', 'First Hole']);
  expect(boards.length === 0, 'no board below the professional level');
  ok('a level par novice round');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - Leaderboard Golf set: ${testNo} spec checks`);
