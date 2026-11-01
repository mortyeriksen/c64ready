// Spec tests for the ported Mole Attack high-score board
// (server/sets/mole-attack.json, from c64-cheevos, MIT) under rcheevos, on
// synthesized RAM laid out as the set reads it: the BCD score with tens and
// units in $000A and thousands and hundreds in $000B, and the in-game flag
// $0050 (1 while the 100-second clock runs, 0 on the title and after time
// runs out). Before the first game the PRG release leaves $4C in $000B.

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/mole-attack.json'), 'utf8')), 'mole-attack.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const SCORE_LO = 0x0a, SCORE_HI = 0x0b, IN_GAME = 0x50;
const CRT_HASH = '9891c664b29204919a8f55f0b6f0b2c0';
const bcd = (n) => ((Math.floor(n / 10) % 10) << 4) | (n % 10);
function setScore(n) { ram[SCORE_HI] = bcd(Math.floor(n / 100)); ram[SCORE_LO] = bcd(n % 100); }

const events = [];
function activate() {
  rc.clear(); events.length = 0; ram.fill(0);
  return set.leaderboards.map((l) => rc.activateLeaderboard(l.id, l.definition));
}
function frame() {
  for (const e of rc.doFrame(ram)) if (e.type >= EVENT.LBOARD_STARTED && e.type <= EVENT.LBOARD_TRIGGERED) events.push({ ...e });
}
const frames = (n) => { for (let i = 0; i < n; i++) frame(); };
const started = () => events.filter((e) => e.type === EVENT.LBOARD_STARTED);
const submitted = () => events.filter((e) => e.type === EVENT.LBOARD_TRIGGERED);

// 1. The board parses and names both releases.
{
  const codes = activate();
  expect(codes.length === 1 && codes[0] === 0, `the high-score board parses (codes ${codes})`);
  expect(set.achievements.length === 0, 'the board only: c64-cheevos has no Mole Attack achievements');
  expect(set.hashes.some((h) => h.hash === '6453dda36850233f5d196968d15c56da'), 'the set names c64cade\'s PRG');
  expect(set.hashes.some((h) => h.hash === CRT_HASH), 'the set names the official cartridge');
  ok('the set parses');
}

// 2. The listed cartridge hash is the local cartridge's rcheevos hash.
{
  const file = assetPath('mole-attack-crt');
  if (!file) console.log(`ok  - test ${++testNo}: mole-attack-crt hashes to the listed hash # SKIP ${missingNote('mole-attack-crt')}`);
  else { expect(rc.hash(fs.readFileSync(file)) === CRT_HASH, 'the official Mole Attack cartridge hashes to the listed MD5'); ok('mole-attack-crt hashes to the listed hash'); }
}

// 3. The title screen, with the PRG's leftover $4C in the score, starts nothing.
{
  activate(); ram[SCORE_HI] = 0x4c; frames(30);
  setScore(0); frames(30);
  expect(events.length === 0, `nothing starts on the title (got ${events.map((e) => e.type)})`);
  ok('the title screen starts nothing');
}

// 4. A game: the clock starts, the score rises and falls, time out submits it.
{
  activate(); setScore(0); frames(5);
  ram[IN_GAME] = 1; frames(2);
  expect(started().length === 1, 'the in-game flag going to 1 starts the attempt');
  setScore(95); frames(3); setScore(88); frames(3); setScore(1234); frames(3);
  expect(submitted().length === 0, 'nothing is submitted while the clock runs');
  ram[IN_GAME] = 0; frames(1);
  const sub = submitted();
  expect(sub.length === 1 && sub[0].value === 1234, `time out submits the BCD score 1234 (got ${sub.map((e) => e.value)})`);
  frames(30);
  expect(submitted().length === 1, 'the title after the game submits nothing more');
  ok('a game is tracked from the clock starting to time running out');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - mole-attack set: ${testNo} checks`);
