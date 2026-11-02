// The Ghosts 'n Goblins Arcade set uses the EasyFlash game's RAM:
// $078D is the level (0-5 in play), $07F3 the clock minutes (zero on the
// title), $07F2 the remaining lives, $07F0/$07F1 the BCD score in hundreds,
// $07EB a life-loss pulse, and $5BA5 the trainer-patched instruction byte.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/ghosts-n-goblins-arcade.json'), 'utf8')), 'ghosts-n-goblins-arcade.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const ids = Object.fromEntries(set.achievements.map((a) => [a.title, a.id]));
const HASH = '20f3b8dfce814ebba9c06fa7288a24a6';
const LEVEL = 0x78d, MINUTES = 0x7f3, LIVES = 0x7f2, SCORE = 0x7f0, LOST = 0x7eb, TRAINER = 0x5ba5;
const NOTICE_ID = 1_000_000_001;
const unlocked = new Set(), boards = [], notices = [];

function score(shown) {
  const digits = String(shown / 100).padStart(4, '0');
  ram[SCORE] = Number.parseInt(digits.slice(0, 2), 16);
  ram[SCORE + 1] = Number.parseInt(digits.slice(2), 16);
}
function activate() {
  rc.clear(); ram.fill(0); ram[TRAINER] = 205;
  unlocked.clear(); boards.length = 0; notices.length = 0;
  const achievements = set.achievements.map((a) => rc.activateAchievement(a.id, a.memaddr));
  const leaderboard = rc.activateLeaderboard(set.leaderboards[0].id, set.leaderboards[0].definition);
  const notice = rc.activateAchievement(NOTICE_ID, set.notices[0].memaddr);
  return { achievements, leaderboard, notice };
}
function frame() {
  for (const e of rc.doFrame(ram)) {
    if (e.type === EVENT.ACHIEVEMENT_TRIGGERED) {
      if (e.id === NOTICE_ID) notices.push({ ...e }); else unlocked.add(e.id);
    } else if ([EVENT.LBOARD_STARTED, EVENT.LBOARD_CANCELED, EVENT.LBOARD_TRIGGERED].includes(e.type)) boards.push({ ...e });
  }
}
function frames(n) { for (let i = 0; i < n; i++) frame(); }
function title() { ram[LEVEL] = 0; ram[MINUTES] = 0; ram[LIVES] = 5; frames(5); }
function start({ trainer = false } = {}) {
  ram[TRAINER] = trainer ? 76 : 205;
  ram[LEVEL] = 0; ram[LIVES] = 5; ram[LOST] = 0; score(0);
  ram[MINUTES] = 0; frame();
  ram[MINUTES] = 1; frames(3);
}
const has = (title) => unlocked.has(ids[title]);
const events = (type) => boards.filter((e) => e.type === type);

{
  const codes = activate();
  codes.achievements.forEach((code, i) => expect(code === 0, `${set.achievements[i].title} parses (code ${code})`));
  expect(codes.leaderboard === 0, 'the leaderboard parses');
  expect(codes.notice === 0, 'the trainer notice parses');
  expect(set.achievements.length === 10, 'ten achievements are listed');
  expect(set.hashes.some((h) => h.hash === HASH), 'the set names the Arcade cartridge');
  expect(set.leaderboards[0].format === 'SCORE' && !set.leaderboards[0].lowerIsBetter, 'the board ranks higher scores first');
  expect(set.notices[0].title === 'Trainer on', 'the trainer notice has its displayed title');
  ok('the Arcade definitions parse');
}

{
  const file = assetPath('ghosts-n-goblins-arcade-crt');
  if (!file) console.log(`ok  - test ${++testNo}: cartridge hash # SKIP ${missingNote('ghosts-n-goblins-arcade-crt')}`);
  else {
    expect(rc.hash(fs.readFileSync(file)) === HASH, 'the EasyFlash cartridge hashes to the set');
    ok('the EasyFlash cartridge hash');
  }
}

{
  activate(); title();
  for (const level of [6, 7, 0]) { ram[LEVEL] = level; score(100000); frames(3); }
  expect(unlocked.size === 0, 'title, credits and high-score screens unlock nothing');
  expect(events(EVENT.LBOARD_STARTED).length === 0, 'attract screens start no score attempt');
  start();
  expect(unlocked.size === 0, 'starting a clean game unlocks nothing');
  expect(events(EVENT.LBOARD_STARTED).length === 1, 'a clean game starts one score attempt');
  ok('attract screens and the game start');
}

{
  activate(); title(); start({ trainer: true });
  ram[LEVEL] = 1; score(100000); frames(3);
  expect(unlocked.size === 0, 'trainer play unlocks nothing');
  expect(events(EVENT.LBOARD_STARTED).length === 0, 'trainer play starts no score attempt');
  expect(notices.length === 1, 'trainer play shows its notice');
  activate(); title(); start(); frames(3);
  expect(notices.length === 0, 'plain play shows no trainer notice');
  ok('a trainer excludes achievements and scores');
}

{
  activate(); title(); start();
  for (const [level, title] of ['Graveyard Shift', 'Thin Ice', 'Cave Dweller', 'Deeper Down', 'At the Castle Gates'].entries()) {
    expect(!has(title), `${title} waits for its level clear`);
    ram[LEVEL] = level + 1; frames(2);
    expect(has(title), `${title} unlocks on its level clear`);
  }
  expect(has('Not a Scratch'), 'level one without a lost life unlocks Not a Scratch');
  ok('five level clears and a clean first level');
}

{
  activate(); title(); start();
  ram[LOST] = 1; ram[LIVES] = 4; frames(3);
  ram[LEVEL] = 1; frames(2);
  expect(has('Graveyard Shift'), 'a level clear still counts after losing a life');
  expect(!has('Not a Scratch'), 'a lost life rules out Not a Scratch');
  ok('a lost life rules out the clean clear');
}

{
  activate(); title(); start();
  for (const [title, threshold] of [['Knight Errant', 10000], ['Knight of the Realm', 25000], ['Champion Knight', 50000], ['Sir Arthur', 100000]]) {
    score(threshold - 100); frames(2);
    expect(!has(title), `${title} stays locked below ${threshold}`);
    score(threshold); frames(2);
    expect(has(title), `${title} unlocks at ${threshold}`);
  }
  ok('the four score thresholds');
}

{
  activate(); title(); start();
  score(12300); frames(2);
  ram[LIVES] = 1; frames(2);
  expect(events(EVENT.LBOARD_TRIGGERED).length === 0, 'the last life still in play posts no score');
  ram[LOST] = 1; frames(2);
  const posts = events(EVENT.LBOARD_TRIGGERED);
  expect(posts.length === 1 && posts[0].value === 12300, 'losing the last life posts the shown score once');
  ram[LEVEL] = 7; frames(4);
  expect(events(EVENT.LBOARD_TRIGGERED).length === 1, 'high-score screens post nothing more');
  ok('the last life submits one score');
}

{
  activate(); title(); start();
  score(5000); frames(2);
  ram[TRAINER] = 76; frames(2);
  expect(events(EVENT.LBOARD_CANCELED).length === 1, 'a trainer enabled mid-run cancels the score attempt');
  ram[LIVES] = 1; ram[LOST] = 1; frames(2);
  expect(events(EVENT.LBOARD_TRIGGERED).length === 0, 'a canceled run never submits');
  ok('trainer activation cancels a running score');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - ghosts-n-goblins-arcade set: ${testNo} checks`);
