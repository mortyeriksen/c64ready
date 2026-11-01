// Spec tests for the Out Run achievement set (server/sets/out-run.json, US Gold's 1987 conversion on
// the OneLoad64 v5 route A, B and C cartridges and the MultiLoad64 build) under rcheevos, on
// synthesized RAM laid out as the game keeps it:
//   $AA50-$AA56 the score, one decimal digit per byte, units first (seven digits).
//   $AA21/$AA22 the timer's units and tens: 75 on the music screen and at the start, counting down;
//         a checkpoint adds time (tens capped at 9); 0 ends the game.
//   $9144 stage index 0-4 (stage 1-5), stepped at each checkpoint.
//   $80A9 the high byte of a JSR in the main loop: $83, rewritten to $93 by the goal routine at the
//         end of stage 5.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/out-run.json'), 'utf8')), 'out-run.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const id = Object.fromEntries(set.achievements.map((a) => [a.title, a.id]));
const HASHES = {
  'out-run-a-crt': '4f60fefef0e0f906ef3f79849e9c8c22', 'out-run-b-crt': '8535cdd363b3bdf1699962c17bb2b732',
  'out-run-c-crt': 'c360a1e770ce6b3d4a529f6b66931c0b', 'out-run-multiload-crt': '87ae9de9671916c094ecb7902ad0e2c8',
};
const SCORE = 0xaa50, T1 = 0xaa21, T10 = 0xaa22, STAGE = 0x9144, GOAL = 0x80a9;

function setScore(n) { const d = String(n).padStart(7, '0'); for (let i = 0; i < 7; i++) ram[SCORE + i] = Number(d[6 - i]); }
const scoreNow = () => Number(Array.from(ram.subarray(SCORE, SCORE + 7)).reverse().join(''));
function setTime(t) { ram[T10] = Math.floor(t / 10); ram[T1] = t % 10; }
const unlocked = new Set();
const lb = [];
function activate() {
  rc.clear(); unlocked.clear(); lb.length = 0; ram.fill(0); ram[GOAL] = 0x83;
  return {
    codes: set.achievements.map((a) => rc.activateAchievement(a.id, a.memaddr)),
    boards: set.leaderboards.map((l) => rc.activateLeaderboard(l.id, l.definition)),
  };
}
function frame() {
  for (const e of rc.doFrame(ram)) {
    if (e.type === EVENT.ACHIEVEMENT_TRIGGERED) unlocked.add(e.id);
    else if (e.type >= EVENT.LBOARD_STARTED && e.type <= EVENT.LBOARD_TRIGGERED && e.type !== EVENT.LBOARD_UPDATED) lb.push({ ...e });
  }
}
const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
const started = () => lb.filter((e) => e.type === EVENT.LBOARD_STARTED).length;
const submitted = () => lb.filter((e) => e.type === EVENT.LBOARD_TRIGGERED);
const has = (title) => unlocked.has(id[title]);

/** The music screen: timer 75, stage 1, the last game's score left over. */
function title() { setTime(75); ram[STAGE] = 0; ram[GOAL] = 0x83; frames(20); }
/** A game: the score clears, then the timer ticks down from 75. */
function start() { setScore(0); ram[STAGE] = 0; setTime(75); frames(30); setTime(74); frames(50); setTime(73); frames(50); }
/** Driving: points and the timer. */
function drive(points, seconds = 5) { setScore(scoreNow() + points); setTime(ram[T10] * 10 + ram[T1] - seconds); frames(10); }
/** A checkpoint: the stage steps on and time is added. */
function checkpoint() { ram[STAGE]++; frames(1); setTime(Math.min(99, ram[T10] * 10 + ram[T1] + 50)); frames(10); }
function timeOut() { setTime(1); frames(10); setTime(0); frames(60); }

// 1. Every condition and the leaderboard parse, and the set names the cartridges.
{
  const { codes, boards } = activate();
  codes.forEach((c, i) => expect(c === 0, `"${set.achievements[i].title}" parses (code ${c})`));
  expect(boards.length === 1 && boards[0] === 0, 'the high-score leaderboard parses');
  for (const h of Object.values(HASHES)) expect(set.hashes.some((x) => x.hash === h), `the set names ${h}`);
  expect(set.hashes.length === 4, 'routes A, B, C and the MultiLoad64 build');
  ok(`all ${codes.length} achievements and ${boards.length} leaderboard parse`);
}

// 2. Each listed hash is its file's rcheevos hash.
for (const [key, hash] of Object.entries(HASHES)) {
  let file = null;
  try { file = assetPath(key); } catch { /* not registered yet */ }
  if (!file) {
    let note = `${key} is not registered in test/external-assets.json`;
    try { note = missingNote(key); } catch { /* keep the note */ }
    console.log(`ok  - test ${++testNo}: ${key} hashes to the listed hash # SKIP ${note}`);
  } else { expect(rc.hash(fs.readFileSync(file)) === hash, `${path.basename(file)} hashes to ${hash}`); ok(`${key} hashes to the listed hash`); }
}

// 3. The music screen, with junk in the score, the stage and the goal byte, unlocks nothing.
{
  activate(); title(); setScore(3000000); ram[STAGE] = 4; frames(5); ram[GOAL] = 0x93; frames(5); ram[STAGE] = 0; ram[GOAL] = 0x83; frames(5);
  expect(unlocked.size === 0 && started() === 0, `the music screen counts for nothing (got ${[...unlocked]})`);
  ok('nothing before a game');
}

// A player who accelerates at once has points before the timer's first tick: the game still counts.
{
  activate(); title(); setScore(0); ram[STAGE] = 0; setTime(75); frames(30); setScore(890); setTime(74); frames(50);
  expect(started() === 1, 'the first tick starts the attempt with points already on the clock');
  drive(50000); checkpoint();
  expect(has('Checkpoint'), 'and the checkpoint counts');
  ok('a start with the accelerator down');
}

// 4. Checkpoints and the goal.
{
  activate(); title(); start();
  expect(started() === 1, 'the first tick of the timer starts the attempt');
  const names = { 2: 'Checkpoint', 3: 'Halfway Down the Road', 4: 'Long Drive', 5: 'Final Stretch' };
  for (let s = 2; s <= 5; s++) { drive(50000); expect(!has(names[s]), `${names[s]} not before stage ${s}`); checkpoint(); expect(has(names[s]), `${names[s]} at stage ${s}`); }
  expect(!has('Goal!'), 'no goal yet');
  drive(50000); ram[GOAL] = 0x93; frames(5);
  expect(has('Goal!'), 'Goal! when the goal routine rewrites the main loop');
  ok('stages and the goal');
}

// 5. Score tiers.
{
  activate(); title(); start();
  for (const [t, pts] of [['Cruising', 500000], ['Fast Lane', 1000000], ['Magical Sound Shower', 2000000]]) {
    setScore(pts - 10); frames(2);
    expect(!has(t), `${t}: ${pts - 10} is short`);
    setScore(pts); frames(2);
    expect(has(t), `${t} at ${pts}`);
  }
  ok('score tiers');
}

// 6. High Score: submitted when the timer runs out, and at the goal.
{
  activate(); title(); start(); drive(116860, 10);
  expect(!submitted().length, 'nothing while the clock runs');
  checkpoint();
  expect(!submitted().length, 'a checkpoint submits nothing');
  timeOut();
  const s = submitted();
  expect(s.length === 1 && s[0].value === 116860, `time out submits 116,860 (got ${s.map((e) => e.value)})`);
  title(); start();
  expect(started() === 2, 'the next game starts a new attempt');
  drive(2500000); ram[GOAL] = 0x93; frames(5);
  expect(submitted().length === 2 && submitted()[1].value === 2500000, 'the goal submits the score');

  activate(); title(); start(); timeOut();
  expect(started() === 1 && !submitted().length, 'a pointless game submits nothing');
  ok('High Score start, submit and value');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - out-run set: ${testNo} checks`);
