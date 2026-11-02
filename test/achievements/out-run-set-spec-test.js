// Spec tests for the Out Run achievement set (server/sets/out-run.json, US Gold's 1987 conversion on
// the OneLoad64 v5 route A-E cartridges and the MultiLoad64 build) under rcheevos, on
// synthesized RAM laid out as the game keeps it:
//   $AA50-$AA56 (A-C) or $AA47-$AA4D (D-E): score digits, units first.
//   $AA21/$AA22 (A-C) or $AA18/$AA19 (D-E): timer units and tens, 75 at the start;
//         a checkpoint adds time (tens capped at 9); 0 ends the game.
//   $9144 stage index 0-4 (stage 1-5), stepped at each checkpoint.
//   $80A9 the high byte of a JSR in the main loop: $83, rewritten to $93 by the goal routine at the
//         end of stage 5.
//   $A20D a route-specific byte, shared by standalone and MultiLoad64 builds.

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
  'out-run-d-crt': 'cf7b3cbc83fea9f38f466e04fe624d32', 'out-run-e-crt': '72b909481a6c20d19af7474b70a20991',
};
const ROUTES = [
  ['A', 'Vineyard', 0x08, 0xaa21, 0xaa22, 0xaa50],
  ['B', 'Death Valley', 0x0d, 0xaa21, 0xaa22, 0xaa50],
  ['C', 'Desolation Hill', 0x09, 0xaa21, 0xaa22, 0xaa50],
  ['D', 'Autobahn', 0x04, 0xaa18, 0xaa19, 0xaa47],
  ['E', 'Lakeside', 0x03, 0xaa18, 0xaa19, 0xaa47],
];
const STAGE = 0x9144, GOAL = 0x80a9, ROUTE = 0xa20d;
let route = ROUTES[0];
function choose(label) { route = ROUTES.find(r => r[0] === label); ram[ROUTE] = route[2]; }
function setScore(n) { const d = String(n).padStart(7, '0'); for (let i = 0; i < 7; i++) ram[route[5] + i] = Number(d[6 - i]); }
const scoreNow = () => Number(Array.from(ram.subarray(route[5], route[5] + 7)).reverse().join(''));
function setTime(t) { ram[route[4]] = Math.floor(t / 10); ram[route[3]] = t % 10; }
const timeNow = () => ram[route[4]] * 10 + ram[route[3]];
const unlocked = new Set();
const lb = [];
function activate() {
  rc.clear(); unlocked.clear(); lb.length = 0; ram.fill(0); ram[GOAL] = 0x83; choose('A');
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
function title(label = 'A') { choose(label); setTime(75); ram[STAGE] = 0; ram[GOAL] = 0x83; frames(20); }
/** A game: the score clears, then the timer ticks down from 75. */
function start() { setScore(0); ram[STAGE] = 0; setTime(75); frames(30); setTime(74); frames(50); setTime(73); frames(50); }
/** Driving: points and the timer. */
function drive(points, seconds = 5) { setScore(scoreNow() + points); setTime(timeNow() - seconds); frames(10); }
/** A checkpoint: the stage steps on and time is added. */
function checkpoint() { ram[STAGE]++; frames(1); setTime(Math.min(99, timeNow() + 50)); frames(10); }
function timeOut() { setTime(1); frames(10); setTime(0); frames(60); }

// Every condition and leaderboard parses, and the set names the cartridges.
{
  const { codes, boards } = activate();
  codes.forEach((c, i) => expect(c === 0, `"${set.achievements[i].title}" parses (code ${c})`));
  expect(boards.length === 5 && boards.every(c => c === 0), 'five course leaderboards parse');
  for (const h of Object.values(HASHES)) expect(set.hashes.some((x) => x.hash === h), `the set names ${h}`);
  expect(set.hashes.length === 6, 'routes A-E and the MultiLoad64 build');
  expect(set.achievements.every((a, i) => a.id === i + 1), 'achievement IDs follow display order');
  expect(set.leaderboards.every((l, i) => l.id === i + 1), 'leaderboard IDs follow route order');
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

// The music screen may retain score and stage bytes from a previous attempt.
for (const [label] of ROUTES) {
  activate(); title(label); setScore(3000000); ram[STAGE] = 4; frames(5); ram[GOAL] = 0x93; frames(5);
  expect(unlocked.size === 0 && started() === 0, `${label}: the music screen counts for nothing`);
  ok(`${label}: nothing before a game`);
}

// A player who accelerates immediately may have points before the first timer tick.
for (const [label] of ROUTES) {
  activate(); title(label); setScore(890); setTime(74); frames(50);
  expect(started() === 1 && lb.some(e => e.type === EVENT.LBOARD_STARTED && e.id === ROUTES.findIndex(r => r[0] === label) + 1),
    `${label}: the first tick starts only its course leaderboard`);
  drive(50000); checkpoint();
  expect(has('Checkpoint!'), `${label}: the checkpoint counts`);
  ok(`${label}: a start with the accelerator down`);
}

// All five courses have four checkpoints, a separate goal, and the same stage index.
for (const [label, destination] of ROUTES) {
  activate(); title(label); start();
  const names = { 2: 'Checkpoint!', 3: 'Open Road', 4: 'Long Drive', 5: 'Final Stretch' };
  for (let s = 2; s <= 5; s++) {
    drive(50000); expect(!has(names[s]), `${label}: ${names[s]} not before stage ${s}`);
    checkpoint(); expect(has(names[s]), `${label}: ${names[s]} at stage ${s}`);
  }
  expect(!has(destination), `${label}: no destination award before the goal`);
  drive(50000); ram[GOAL] = 0x93; frames(5);
  expect(has(destination), `${label}: the goal awards ${destination}`);
  expect(ROUTES.filter(r => r[0] !== label).every(r => !has(r[1])), `${label}: other destinations stay locked`);
  ok(`${label}: checkpoints and destination`);
}

// The time challenges read the active route's timer at the goal.
for (const label of ['A', 'D']) {
  for (const [left, expected] of [[9, []], [10, ['Time to Spare']], [19, ['Time to Spare']], [20, ['Time to Spare', 'Clock Beater']]]) {
    activate(); title(label); start(); setTime(left); frames(2); ram[GOAL] = 0x93; frames(2);
    expect(['Time to Spare', 'Clock Beater'].filter(has).join(',') === expected.join(','), `${label}: ${left} seconds awards ${expected.join(',') || 'neither clock trophy'}`);
    ok(`${label}: goal with ${left} seconds left`);
  }
}

// Score tiers must read the chosen route's digits, including D/E's relocated score.
for (const label of ['A', 'D']) {
  activate(); title(label); start();
  for (const [name, points] of [['Cruising', 500000], ['Fast Lane', 1000000], ['Magical Sound Shower', 2000000]]) {
    setScore(points - 10); frames(2); expect(!has(name), `${label}: ${points - 10} is short of ${name}`);
    setScore(points); frames(2); expect(has(name), `${label}: ${name} awards at ${points}`);
  }
  ok(`${label}: score tiers`);
}

// Each route has its own leaderboard; timeout and goal submit the active score.
for (const [label] of ROUTES) {
  activate(); title(label); start(); drive(116860, 10);
  expect(!submitted().length, `${label}: nothing while the clock runs`);
  checkpoint(); expect(!submitted().length, `${label}: a checkpoint submits nothing`);
  timeOut();
  const s = submitted();
  expect(s.length === 1 && s[0].value === 116860 && s[0].id === ROUTES.findIndex(r => r[0] === label) + 1,
    `${label}: timeout submits 116,860 only to its route`);
  ok(`${label}: leaderboard timeout`);

  activate(); title(label); start(); drive(2500000); ram[GOAL] = 0x93; frames(5);
  expect(submitted().length === 1 && submitted()[0].value === 2500000, `${label}: the goal submits 2,500,000`);
  ok(`${label}: leaderboard goal`);

  activate(); title(label); start(); timeOut();
  expect(started() === 1 && !submitted().length, `${label}: a pointless game submits nothing`);
  ok(`${label}: no pointless score`);
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - out-run set: ${testNo} checks`);
