// Spec tests for the ported Uridium achievement set (server/sets/uridium.json,
// from c64-cheevos, MIT) under rcheevos, on synthesized RAM laid out as the
// set reads it: lives $25, level $26, formations $87, level state $96 (23 is the
// dreadnought's end screen), destruct sequence $A9, and the score's six digit
// characters at $4853-$4858 ("0" is $30, the last digit is always $00).

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/uridium.json'), 'utf8')), 'uridium.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const byTitle = Object.fromEntries(set.achievements.map((a) => [a.title, a.id]));
const LIVES = 0x25, LEVEL = 0x26, FORMATIONS = 0x87, STATE = 0x96, DESTRUCT = 0xa9, SCORE = 0x4853;

/** The score as the game keeps it: five characters, then a constant 0. */
function setScore(n) {
  const digits = String(Math.floor(n / 10)).padStart(5, '0');
  for (let i = 0; i < 5; i++) ram[SCORE + i] = 0x30 + Number(digits[i]);
  ram[SCORE + 5] = 0;
}
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

// 1. Every condition and the leaderboard parse.
{
  const { codes, lb } = activateAll();
  codes.forEach((c, i) => expect(c === 0, `"${set.achievements[i].title}" parses (code ${c})`));
  expect(lb.every((c) => c === 0), 'the high-score leaderboard parses');
  expect(set.hashes[0].hash === '4255c6e2bd6ebe048dfef457a920d565', 'the set names the OneLoad64 cartridge');
  ok(`all ${codes.length} achievements and ${lb.length} leaderboard parse`);
}

// 2. Power-on: the score bytes hold $FF $FF $FF $00 $00 $00 before the first game.
{
  activateAll(); unlocked.clear(); ram.fill(0);
  ram.set([0xff, 0xff, 0xff, 0, 0, 0], SCORE);
  ram[FORMATIONS] = 0x38;          // the title screen's value
  frames(120);
  expect(unlocked.size === 0, `nothing unlocks on the title screen (got ${[...unlocked]})`);
  ok('nothing unlocks before a game, whatever the score bytes hold');
}

// 3. A game: three lives at level 1, score climbing, dreadnoughts cleared.
{
  activateAll(); unlocked.clear(); lbEvents.length = 0; ram.fill(0);
  setScore(0); frames(10);
  ram[LIVES] = 3; ram[LEVEL] = 1; frames(5);
  expect(lbEvents.some((e) => e.type === EVENT.LBOARD_STARTED), 'starting a game (lives 0 to 3) starts the high-score attempt');
  setScore(9995); frames(2);
  expect(!unlocked.has(byTitle['Novice Pilot']), '9,995 is not yet 10,000');
  setScore(10000); frames(2);
  expect(unlocked.has(byTitle['Novice Pilot']), 'Novice Pilot at 10,000 points');
  // The Zinc dreadnought's end screen, after its destruct sequence.
  ram[STATE] = 0x06; frames(5);
  ram[DESTRUCT] = 0; ram[STATE] = 23; frames(2);
  expect(unlocked.has(byTitle.Zinc), 'Zinc on level 1\'s end screen');
  expect(unlocked.has(byTitle.Meltdown), 'Meltdown when the destruct sequence has finished');
  expect(!unlocked.has(byTitle.Lead), 'not Lead: that is level 2');
  // Level 2: its end screen unlocks Lead, and only on the change to 23.
  ram[STATE] = 0; ram[LEVEL] = 2; frames(5);
  ram[STATE] = 23; frames(1);
  expect(unlocked.has(byTitle.Lead), 'Lead on level 2\'s end screen');
  // All six formations on a dreadnought.
  ram[FORMATIONS] = 5; frames(2); ram[FORMATIONS] = 6; frames(1);
  expect(unlocked.has(byTitle['Cleared Hot']), 'Cleared Hot at six formations');
  setScore(150000); frames(2);
  for (const t of ['Experienced Pilot', 'Veteran Pilot', 'Elite Pilot', 'Uridium Ace']) expect(unlocked.has(byTitle[t]), `${t} by 150,000 points`);
  // Game over: lives 1 to 0 submits the score.
  ram[LIVES] = 1; frames(2); ram[LIVES] = 0; frames(1);
  const sub = lbEvents.find((e) => e.type === EVENT.LBOARD_TRIGGERED);
  expect(sub && sub.value === 150000, `game over submits the score (got ${sub?.value})`);
  ok('a game: score tiers, dreadnoughts, Meltdown, Cleared Hot and the high score');
}

// 4. Levels 3 to 15 each unlock on their own end screen.
{
  activateAll(); unlocked.clear(); ram.fill(0); setScore(0);
  ram[LIVES] = 3; frames(3);
  for (let level = 1; level <= 15; level++) {
    ram[LEVEL] = level; ram[STATE] = 0; frames(2);
    ram[STATE] = 23; frames(1);
  }
  const levelIds = set.achievements.filter((a) => /^0xH0026=\d+_/.test(a.memaddr)).map((a) => a.id);
  expect(levelIds.length === 15, 'fifteen dreadnought achievements');
  expect(levelIds.every((id) => unlocked.has(id)), 'each dreadnought unlocks on its level\'s end screen');
  ok('all fifteen dreadnoughts');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - uridium set: ${testNo} checks`);
