// Spec tests for the ported Gribbly's Day Out high-score board
// (server/sets/gribblys-day-out.json, from c64-cheevos, MIT) under rcheevos, on
// synthesized RAM laid out as the set reads it: the eight-digit BCD score
// $21 (highest pair) to $24, Gribbly's psi energy $57 and the energy bank $59
// (a game starts by filling psi to 40 from the bank, leaving 80; when both run
// out the game is over), and the screen state $9D (2 in a game, 1 on the menu).

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/gribblys-day-out.json'), 'utf8')), 'gribblys-day-out.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const SCORE = 0x21, PSI = 0x57, BANK = 0x59, STATE = 0x9d;
const HASH = '5fa127d6b4b224a509cc29ad382a4ac6';
const bcd = (n) => ((Math.floor(n / 10) % 10) << 4) | (n % 10);
function setScore(n) { for (let i = 3; i >= 0; i--) { ram[SCORE + i] = bcd(n % 100); n = Math.floor(n / 100); } }

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
/** The menu, then fire: psi fills to 40 from a bank of 120, leaving 80. */
function startGame() {
  ram[STATE] = 1; frames(5);
  ram[STATE] = 2; ram[BANK] = 120; ram[PSI] = 0; frames(1);
  while (ram[PSI] < 40) { ram[PSI]++; ram[BANK]--; frames(1); }
  frames(2);
}
/** Psi drains, refills from the bank until both are empty, then the menu. */
function runOut() {
  while (ram[BANK] > 0 || ram[PSI] > 0) {
    if (ram[PSI] > 0) ram[PSI]--; else { ram[PSI] = Math.min(40, ram[BANK]); ram[BANK] -= ram[PSI]; }
    frames(1);
  }
  frames(2); ram[STATE] = 1; frames(1);
}

// 1. The board parses and names the cartridge.
{
  const codes = activate();
  expect(codes.length === 1 && codes[0] === 0, `the high-score board parses (codes ${codes})`);
  expect(set.achievements.length === 0, 'the board only: c64-cheevos has no Gribbly\'s Day Out achievements');
  expect(set.hashes.some((h) => h.hash === HASH), 'the set names the OneLoad64 cartridge');
  ok('the set parses');
}

// 2. The listed hash is the cartridge's rcheevos hash.
{
  const file = assetPath('gribblys-day-out-crt');
  if (!file) console.log(`ok  - test ${++testNo}: gribblys-day-out-crt hashes to the listed hash # SKIP ${missingNote('gribblys-day-out-crt')}`);
  else { expect(rc.hash(fs.readFileSync(file)) === HASH, 'the OneLoad64 Gribbly\'s Day Out hashes to the listed MD5'); ok('gribblys-day-out-crt hashes to the listed hash'); }
}

// 3. A game: the start fill starts it, refills from the bank do not restart it,
//    and running out of energy on the way back to the menu submits the score.
{
  activate(); frames(3);
  startGame();
  expect(of(EVENT.LBOARD_STARTED).length === 1, 'psi filled to 40 with 80 left in the bank starts the attempt');
  setScore(10086800); frames(2);
  runOut();
  const sub = of(EVENT.LBOARD_TRIGGERED);
  expect(sub.length === 1 && sub[0].value === 10086800, `out of energy submits the BCD score 10086800 (got ${sub.map((e) => e.value)})`);
  expect(of(EVENT.LBOARD_CANCELED).length === 0, 'a scoring game is not canceled');
  ok('a game is tracked from the start fill to running out of energy');
}

// 4. The menu with energy left is a quit, and an empty game is not submitted.
{
  activate(); frames(3);
  startGame(); setScore(1200); frames(2);
  ram[STATE] = 1; frames(1);
  expect(of(EVENT.LBOARD_TRIGGERED).length === 0, 'back to the menu with energy left submits nothing');
  expect(of(EVENT.LBOARD_CANCELED).length === 1, 'it cancels the attempt');

  activate(); frames(3);
  startGame(); runOut();
  expect(of(EVENT.LBOARD_TRIGGERED).length === 0, 'a game without a point submits nothing');
  ok('quitting and empty games are canceled');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - gribblys-day-out set: ${testNo} checks`);
