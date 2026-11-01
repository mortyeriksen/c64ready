// Spec tests for the ported Galaga (Arlasoft) high-score board
// (server/sets/galaga.json, from c64-cheevos, MIT) under rcheevos, on
// synthesized RAM laid out as the set reads it: ships $8A34 (3 when a game
// starts), the eight-digit BCD score $815B (highest pair) down to $8158, and the
// game state $D8 ($1F and $0C on the titles, $10 as each stage or ship starts,
// $13 at game over).

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
const set = checkSet(JSON.parse(fs.readFileSync(path.join(root, 'server/sets/galaga.json'), 'utf8')), 'galaga.json');
const rc = await loadRcheevos();
const ram = new Uint8Array(0x10000);
const SHIPS = 0x8a34, SCORE = 0x8158, STATE = 0xd8;
const CRT_HASH = '6a174d0b794b1c511ec1bbf76c6afb45';
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
function titles() { ram[SHIPS] = 3; for (const s of [0x1f, 0x0c, 0x1f, 0x0c]) { ram[STATE] = s; frames(10); } }

// 1. The board parses and names both releases.
{
  const codes = activate();
  expect(codes.length === 1 && codes[0] === 0, `the high-score board parses (codes ${codes})`);
  expect(set.achievements.length === 0, 'the board only: c64-cheevos has no Galaga achievements');
  expect(set.hashes.some((h) => h.hash === 'cfbe9e994ac06a9d3e3724c1f39b9b50'), 'the set names c64cade\'s v1.06 disk');
  expect(set.hashes.some((h) => h.hash === CRT_HASH), 'the set names the OneLoad64 cartridge');
  ok('the set parses');
}

// 2. The listed cartridge hash is the local cartridge's rcheevos hash.
{
  const file = assetPath('galaga-arlasoft-crt');
  if (!file) console.log(`ok  - test ${++testNo}: galaga-arlasoft-crt hashes to the listed hash # SKIP ${missingNote('galaga-arlasoft-crt')}`);
  else { expect(rc.hash(fs.readFileSync(file)) === CRT_HASH, 'the OneLoad64 Galaga hashes to the listed MD5'); ok('galaga-arlasoft-crt hashes to the listed hash'); }
}

// 3. The titles start nothing.
{
  activate(); frames(3); titles();
  expect(events.length === 0, `nothing starts on the titles (got ${events.map((e) => e.type)})`);
  ok('the titles start nothing');
}

// 4. A game: $10 with three ships starts it, later stage starts do not
//    restart it, $13 submits the score.
{
  activate(); frames(3); titles();
  ram[STATE] = 0x10; frames(2);
  expect(of(EVENT.LBOARD_STARTED).length === 1, '$10 with three ships starts the attempt');
  ram[STATE] = 0x23; ram[SHIPS] = 2; setScore(4630); frames(5);
  ram[STATE] = 0x10; frames(2); ram[STATE] = 0x23; setScore(12345670); frames(5);
  expect(of(EVENT.LBOARD_STARTED).length === 1, 'the next ship\'s $10 does not start another attempt');
  ram[SHIPS] = 0; frames(5);
  ram[STATE] = 0x13; frames(1);
  const sub = of(EVENT.LBOARD_TRIGGERED);
  expect(sub.length === 1 && sub[0].value === 12345670, `$13 submits the BCD score 12345670 (got ${sub.map((e) => e.value)})`);
  ram[STATE] = 0x22; frames(5); ram[STATE] = 0x23; frames(5); titles();
  expect(of(EVENT.LBOARD_TRIGGERED).length === 1 && of(EVENT.LBOARD_STARTED).length === 1, 'the game over screen and titles add nothing');
  ok('a game is tracked from the first $10 to $13');
}

if (failing) { console.log(`\n${failing} of ${testNo} failing`); process.exit(1); }
console.log(`\nok - galaga set: ${testNo} checks`);
