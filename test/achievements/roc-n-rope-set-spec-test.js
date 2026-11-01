// Spec tests for the ported Roc'n Rope high-score board
// (server/sets/roc-n-rope.json, from c64-cheevos, MIT) under rcheevos, on
// synthesized RAM laid out as the set reads it: score $A980-$A982 (24-bit
// binary, low byte first), lives $A983 (3 at the start of a game, 0 = game
// over; $FF before the first game). The set targets c64cade's rocknrope.crt,
// which is not in the local collections, so there is no file check here.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/roc-n-rope.json'), 'utf8')), 'roc-n-rope.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const SCORE = 0xa980, LIVES = 0xa983;

function setScore(n) { ram[SCORE] = n & 0xff; ram[SCORE + 1] = (n >> 8) & 0xff; ram[SCORE + 2] = (n >> 16) & 0xff; }
const events = [];
function activate() {
  rc.clear(); events.length = 0; ram.fill(0);
  return set.leaderboards.map((l) => rc.activateLeaderboard(l.id, l.definition));
}
function frame() {
  for (const e of rc.doFrame(ram)) if (e.type >= EVENT.LBOARD_STARTED && e.type <= EVENT.LBOARD_TRIGGERED) events.push({ ...e });
}
const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
const kinds = () => events.filter((e) => e.type !== EVENT.LBOARD_UPDATED).map((e) => e.type);
const submitted = () => events.filter((e) => e.type === EVENT.LBOARD_TRIGGERED);

// 1. The board parses and names c64cade's cartridge.
{
  const codes = activate();
  expect(codes.length === 1 && codes[0] === 0, `the high-score board parses (codes ${codes})`);
  expect(set.achievements.length === 0, 'the board only: c64-cheevos has no Roc\'n Rope achievements');
  expect(set.hashes.some((h) => h.hash === 'ea5315209e83bdd1b0578cc5e5fc9230'), 'the set names c64cade\'s rocknrope.crt');
  ok('the set parses');
}

// 2. Before the first game ($FF lives) nothing starts.
{
  activate(); ram[LIVES] = 0xff; setScore(0xff0000); frames(20);
  expect(kinds().length === 0, `nothing starts before a game (got ${kinds()})`);
  ok('the title starts nothing');
}

// 3. A game: 3 lives, the score climbs, the last life submits it.
{
  activate(); ram[LIVES] = 0xff; frames(5);
  setScore(0); ram[LIVES] = 3; frames(2);
  expect(kinds()[0] === EVENT.LBOARD_STARTED, 'three lives start the attempt');
  setScore(400); ram[LIVES] = 2; frames(3);
  setScore(1200); ram[LIVES] = 1; frames(3);
  expect(!submitted().length, 'nothing is submitted while a life is left');
  ram[LIVES] = 0; frames(1);
  expect(submitted().length === 1 && submitted()[0].value === 1200, `the last life submits 1,200 (got ${submitted().map((e) => e.value)})`);
  // A second game, scoring past 16 bits.
  frames(10); setScore(0); ram[LIVES] = 3; frames(2);
  setScore(123456); frames(2); ram[LIVES] = 0; frames(1);
  expect(submitted().length === 2 && submitted()[1].value === 123456, `all 24 bits count (got ${submitted().map((e) => e.value)})`);
  ok('a game starts on three lives and submits at game over');
}

// 4. An extra life back to 3 in a game does not restart the attempt.
{
  activate(); ram[LIVES] = 0xff; frames(5);
  setScore(0); ram[LIVES] = 3; frames(2);
  setScore(500); ram[LIVES] = 2; frames(2); ram[LIVES] = 3; frames(2);
  setScore(900); ram[LIVES] = 0; frames(1);
  expect(kinds().filter((k) => k === EVENT.LBOARD_STARTED).length === 1, 'one attempt for the whole game');
  expect(submitted().length === 1 && submitted()[0].value === 900, `the game's 900 is submitted (got ${submitted().map((e) => e.value)})`);
  ok('regaining a life keeps the attempt');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - roc'n rope set: ${testNo} checks`);
