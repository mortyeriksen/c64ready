// Spec tests for the ported Munchy Worm high-score board
// (server/sets/munchy-worm.json, from c64-cheevos, MIT) under rcheevos, on
// synthesized RAM laid out as the set reads it: $2847 holds the character the
// worm's head moves onto ($20 an empty cell, so a game is running; $E2 the
// wall and $24-$31 the worm's own body, which end the game; others are food),
// and the eight-digit BCD score $284C (highest pair) down to $2849.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/munchy-worm.json'), 'utf8')), 'munchy-worm.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const CELL = 0x2847, SCORE = 0x2849;
const bcd = (n) => ((Math.floor(n / 10) % 10) << 4) | (n % 10);
function setScore(n) { for (let i = 0; i < 4; i++) { ram[SCORE + i] = bcd(n % 100); n = Math.floor(n / 100); } }

const events = [];
function activate() {
  rc.clear(); events.length = 0; ram.fill(0);
  return set.leaderboards.map((l) => rc.activateLeaderboard(l.id, l.definition));
}
function frame() {
  for (const e of rc.doFrame(ram)) if (e.type >= EVENT.LBOARD_STARTED && e.type <= EVENT.LBOARD_TRIGGERED) events.push({ ...e });
}
const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
const of = (type) => events.filter((e) => e.type === type);
/** A game: empty cells, a few meals, the score rising to `score`. */
function play(score) {
  ram[CELL] = 0x20; frames(5);
  for (const food of [0x22, 0x23, 0x22]) { ram[CELL] = food; frames(1); ram[CELL] = 0x20; frames(4); }
  setScore(score); frames(2);
}

// 1. The board parses and names c64cade's disk.
{
  const codes = activate();
  expect(codes.length === 1 && codes[0] === 0, `the high-score board parses (codes ${codes})`);
  expect(set.achievements.length === 0, 'the board only: c64-cheevos has no Munchy Worm achievements');
  expect(set.hashes.some((h) => h.hash === '1fe961b502abde7f580be7e7b67bf16e'), 'the set names c64cade\'s disk');
  ok('the set parses');
}

// 2. The title (nothing under the head yet) starts nothing.
{
  activate(); frames(60);
  expect(events.length === 0, 'nothing starts on the title');
  ok('the title starts nothing');
}

// 3. Hitting the wall ends the game and submits the score; meals do not restart it.
{
  activate(); frames(5);
  play(1234560);
  expect(of(EVENT.LBOARD_STARTED).length === 1, 'the first empty cell starts the attempt, and meals do not start another');
  ram[CELL] = 0xe2; frames(1);
  const sub = of(EVENT.LBOARD_TRIGGERED);
  expect(sub.length === 1 && sub[0].value === 1234560, `the wall submits the BCD score 1234560 (got ${sub.map((e) => e.value)})`);
  frames(100);
  expect(of(EVENT.LBOARD_TRIGGERED).length === 1, 'the game over screen submits nothing more');
  ok('a game that ends on the wall');
}

// 4. Biting the tail ends the next game the same way, for every body character.
{
  for (const body of [0x24, 0x2a, 0x31]) {
    activate(); ram[CELL] = 0xe2; frames(5);
    play(780);
    expect(of(EVENT.LBOARD_STARTED).length === 1, `after a wall, the next game starts (body $${body.toString(16)})`);
    ram[CELL] = body; frames(1);
    const sub = of(EVENT.LBOARD_TRIGGERED);
    expect(sub.length === 1 && sub[0].value === 780, `body character $${body.toString(16)} submits 780 (got ${sub.map((e) => e.value)})`);
  }
  ok('a game that ends on the worm\'s own body');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - munchy-worm set: ${testNo} checks`);
